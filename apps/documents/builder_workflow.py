"""Built-template (imprest) multi-phase workflow helpers."""
from __future__ import annotations

from apps.documents.models import Document, DocumentStatus


def is_built_form_document(document: Document) -> bool:
    form = (document.metadata or {}).get("form")
    return isinstance(form, dict) and bool(form.get("sections"))


def infer_builder_workflow_phase(document: Document) -> str | None:
    """Return ``request`` / ``retirement`` for builder forms, else ``None``."""
    if not is_built_form_document(document):
        return None

    phase = "request"
    try:
        from apps.sunsystems.models import JournalPosting, JournalPostingStatus

        if JournalPosting.objects.filter(
            document=document,
            stage=1,
            status=JournalPostingStatus.POSTED,
        ).exists():
            return "retirement"
    except Exception:
        pass

    # Fallback when stage-1 posting is absent/disabled but the request workflow
    # already completed and a retirement-phase rule exists.
    if (document.status or "").strip() == DocumentStatus.APPROVED:
        try:
            from apps.workflows.models import WorkflowInstance, WorkflowRule

            request_done = WorkflowInstance.objects.filter(
                document=document,
                status="approved",
            ).exists()
            has_retirement_rule = WorkflowRule.objects.filter(
                document_type=document.document_type,
                phase="retirement",
                is_active=True,
            ).exists()
            if request_done and has_retirement_rule:
                return "retirement"
        except Exception:
            pass

    return phase


def sync_builder_workflow_phase(document: Document) -> str | None:
    """Persist the inferred workflow phase on ``metadata.form`` when it changes."""
    if not is_built_form_document(document):
        return None

    phase = infer_builder_workflow_phase(document)
    meta = dict(document.metadata or {})
    form = dict(meta.get("form") or {})
    if form.get("workflow_phase") != phase:
        form["workflow_phase"] = phase
        meta["form"] = form
        document.metadata = meta
        document.save(update_fields=["metadata", "updated_at"])
    return phase


def sync_retirement_variance(document: Document) -> dict | None:
    """Persist two display-only numbers onto ``metadata.form``, each time
    this document is viewed/submitted/updated:

      - ``requested_amount`` — resolved unconditionally (whenever a
        retirement mapping names the field), from the REQUEST phase onward.
        This is what the Forms report's "Amount" column and description
        summary read; it doesn't depend on the retirement "spent" table
        having any rows.
      - ``retirement_variance`` — the issued-vs-spent classification, only
        computed once the document has actually reached the retirement
        phase. Computing this during the request phase would misclassify
        every such form as "underspent" (spent=0 < issued), because the
        retirement "spent" table is normally only fillable once the form
        reaches the retirement step — there's nothing to classify yet.

    Safe to call at any point in a form's lifecycle — a no-op (returns None,
    touches nothing) when the document isn't a form. Deliberately tolerant of
    a broken/misconfigured mapping (a template mid-edit, a stale field
    reference): any exception is swallowed so a display-only computation can
    never block a view/submit/update_form request. See
    apps.sunsystems.variance for the mapping warnings a bad config still
    produces (logged there, not raised here).
    """
    if not is_built_form_document(document):
        return None

    from apps.sunsystems.variance import compute_retirement_variance, get_requested_amount

    try:
        requested_amount = get_requested_amount(document)
    except Exception:
        requested_amount = None

    form_meta = (document.metadata or {}).get("form") or {}
    phase = (form_meta.get("workflow_phase") or infer_builder_workflow_phase(document) or "request").strip().lower()

    variance = None
    if phase == "retirement":
        try:
            variance = compute_retirement_variance(document)
        except Exception:
            variance = None

    meta = dict(document.metadata or {})
    form = dict(meta.get("form") or {})
    changed = False
    if form.get("requested_amount") != requested_amount:
        form["requested_amount"] = requested_amount
        changed = True
    if form.get("retirement_variance") != variance:
        form["retirement_variance"] = variance
        changed = True
    if changed:
        meta["form"] = form
        document.metadata = meta
        document.save(update_fields=["metadata", "updated_at"])
    return variance


def retirement_journal_posted(document: Document) -> bool:
    """True when a configured stage-2 SunSystems journal has been posted."""
    try:
        from apps.sunsystems.config import _get_stages, get_journal_config
        from apps.sunsystems.models import JournalPosting, JournalPostingStatus

        cfg = get_journal_config(document)
        if not cfg or not cfg.get("enabled"):
            return False
        stages = _get_stages(cfg)
        if len(stages) < 2:
            return False
        stage_nums = {int(s.get("stage", 1)) for s in stages}
        if 2 not in stage_nums:
            return False
        return JournalPosting.objects.filter(
            document=document,
            stage=2,
            status=JournalPostingStatus.POSTED,
        ).exists()
    except Exception:
        return False


def builder_workflow_in_progress(document: Document) -> bool:
    try:
        from apps.workflows.models import WorkflowInstance

        return WorkflowInstance.objects.filter(
            document=document,
            status="in_progress",
        ).exists()
    except Exception:
        return False


def retirement_workflow_completed(document: Document) -> bool:
    """True once the retirement approval cycle has completed successfully."""
    if not is_built_form_document(document):
        return False
    try:
        from apps.workflows.models import WorkflowInstance

        return WorkflowInstance.objects.filter(
            document=document,
            status="approved",
            rule__phase="retirement",
        ).exists()
    except Exception:
        return False


def builder_process_step(document: Document) -> str:
    """Phase-aware process step for built-form visibility/editability rules.

    ``Document.status`` is intentionally lifecycle/RBAC-oriented and therefore
    cannot distinguish "request approved, retirement now open" from "retirement
    fully approved". This derived value is the form engine's workflow vocabulary.
    """
    status = (document.status or DocumentStatus.DRAFT).strip().lower()
    if not is_built_form_document(document):
        return status

    form = (document.metadata or {}).get("form") or {}
    phase = (form.get("workflow_phase") or infer_builder_workflow_phase(document) or "request").strip().lower()

    if builder_workflow_in_progress(document):
        return "retirement_pending" if phase == "retirement" else "request_pending"

    if status == DocumentStatus.RETURNED:
        return "retirement_returned" if phase == "retirement" else "returned"

    if status == DocumentStatus.REJECTED:
        return "retirement_rejected" if phase == "retirement" else "rejected"

    if status == DocumentStatus.APPROVED:
        if phase == "retirement" and retirement_workflow_completed(document):
            return "fully_approved"
        if phase == "retirement" and retirement_journal_posted(document):
            return "fully_approved"
        return "request_approved"

    return status


def user_may_submit_document(user, document: Document) -> bool:
    if not user or not getattr(user, "is_authenticated", False):
        return False
    if getattr(user, "has_admin_access", False):
        return True
    if document.uploaded_by_id == user.id or getattr(document, "owned_by_id", None) == user.id:
        return True
    from apps.accounts.models import GroupAction
    from apps.documents.file_streaming import user_is_involved_with_document

    if not user_is_involved_with_document(user, document):
        return False
    perms = user.get_all_permissions_for_doctype(
        str(document.document_type_id),
        document=document,
    )
    return (
        GroupAction.SUBMIT.value in perms
        or GroupAction.APPROVE.value in perms
    )


def can_submit_retirement_workflow(document: Document, *, user=None) -> bool:
    """Whether the retirement (stage-2) approval cycle can be started."""
    if not is_built_form_document(document):
        return False

    form = (document.metadata or {}).get("form") or {}
    phase = (form.get("workflow_phase") or infer_builder_workflow_phase(document) or "request").strip().lower()
    if phase != "retirement":
        return False
    if (document.status or "").strip() != DocumentStatus.APPROVED:
        return False
    if builder_workflow_in_progress(document):
        return False
    if retirement_workflow_completed(document):
        return False
    if retirement_journal_posted(document):
        return False
    if user is not None and not user_may_submit_document(user, document):
        return False
    return True


def can_submit_request_workflow(document: Document, *, user=None) -> bool:
    """Whether the initial (request) approval cycle can be started or resumed."""
    status = (document.status or "").strip()
    if status not in (
        DocumentStatus.DRAFT,
        DocumentStatus.RETURNED,
        "Returned for Review",
    ):
        return False

    if is_built_form_document(document):
        form = (document.metadata or {}).get("form") or {}
        phase = (form.get("workflow_phase") or "request").strip().lower()
        # Retirement-phase documents only re-enter workflow after a return for rework.
        if phase == "retirement" and status not in (
            DocumentStatus.RETURNED,
            "Returned for Review",
        ):
            return False

    if user is not None and not user_may_submit_document(user, document):
        return False
    return True