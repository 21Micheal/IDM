"""Built-template workflow helpers."""
from __future__ import annotations

from datetime import date, timedelta

from django.db.models import Q
from django.utils import timezone

from apps.documents.models import Document, DocumentStatus


PROCUREMENT_WORKFLOW_STAGES = ("requisition", "rfq", "lpo")


def is_procurement_document(document: Document) -> bool:
    """Whether a built form belongs to the requisition procurement lifecycle."""
    form = (document.metadata or {}).get("form") or {}
    workflow_type = str(form.get("workflow_type") or "").strip().lower()
    if workflow_type:
        return workflow_type == "requisition"

    document_type = getattr(document, "document_type", None)
    if not document_type:
        return False
    haystack = " ".join(
        str(value or "")
        for value in (
            getattr(document_type, "name", ""),
            getattr(document_type, "code", ""),
            getattr(document_type, "description", ""),
        )
    ).lower()
    return "requisition" in haystack


def is_built_form_document(document: Document) -> bool:
    form = (document.metadata or {}).get("form")
    return isinstance(form, dict) and bool(form.get("sections"))


def travel_retirement_config(document: Document) -> dict:
    form = ((document.metadata or {}).get("form") or {})
    config = form.get("travel_retirement")
    return config if isinstance(config, dict) and config.get("enabled") else {}


def travel_retirement_due_date(document: Document) -> date | None:
    """Return the configured retirement due date, or None if not resolvable."""
    config = travel_retirement_config(document)
    returned = travel_return_date(document)
    if returned is None:
        return None
    try:
        days = max(0, int(config.get("deadlineDays", config.get("deadline_days", 7))))
    except (TypeError, ValueError):
        return None
    return returned + timedelta(days=days)


def travel_return_date(document: Document) -> date | None:
    config = travel_retirement_config(document)
    field_key = str(config.get("returnDateField") or config.get("return_date_field") or "").strip()
    values = ((document.metadata or {}).get("form") or {}).get("values") or {}
    if not field_key or not isinstance(values, dict):
        return None
    raw = values.get(field_key)
    if not raw:
        return None
    try:
        return date.fromisoformat(str(raw)[:10])
    except (TypeError, ValueError):
        return None


def _retirement_workflow_statuses(document_ids):
    if not document_ids:
        return {}
    try:
        from apps.workflows.models import WorkflowInstance

        rows = WorkflowInstance.objects.filter(
                document_id__in=document_ids,
                rule__phase="retirement",
            ).order_by("document_id", "-created_at").values_list("document_id", "status")
        result = {}
        for document_id, status in rows:
            result.setdefault(document_id, status)
        return result
    except Exception:
        return {}


def retirement_status(document: Document, *, workflow_status=None) -> dict | None:
    """Mapping-driven status summary used by requisition registers."""
    config = travel_retirement_config(document)
    if not config or not is_travel_requisition(document):
        return None
    due = travel_retirement_due_date(document)
    phase = str((((document.metadata or {}).get("form") or {}).get("workflow_phase") or "")).lower()
    status = workflow_status
    if status is None:
        status = _retirement_workflow_statuses([document.id]).get(document.id)

    if phase != "retirement":
        label = "LPO pending"
        kind = "not_started"
    elif status == "in_progress":
        label, kind = "Awaiting Finance", "awaiting_finance"
    elif status == "returned":
        label, kind = "Returned for revision", "returned"
    elif status == "rejected":
        label, kind = "Retirement rejected", "rejected"
    elif status == "approved":
        variance = None
        try:
            from apps.sunsystems.variance import compute_retirement_variance
            variance = compute_retirement_variance(document)
        except Exception:
            pass
        scenario = (variance or {}).get("scenario")
        labels = {
            "exact": ("Exact", "exact"),
            "under": ("Refund due", "refund_due"),
            "over": ("Top-up due", "top_up_due"),
        }
        label, kind = labels.get(scenario, ("Retired", "retired"))
    elif not travel_return_date(document):
        label, kind = "Return date missing", "return_date_missing"
    elif due and timezone.localdate() > due:
        label, kind = "Retirement overdue", "overdue"
    elif travel_return_date(document) and timezone.localdate() < travel_return_date(document):
        label, kind = "Not yet returned", "not_due"
    else:
        label, kind = "Retirement due", "due"

    return {
        "status": kind,
        "label": label,
        "due_date": due.isoformat() if due else None,
        "variance": ((document.metadata or {}).get("form") or {}).get("retirement_variance"),
    }


def overdue_travel_retirement_for_user(user, *, exclude_document_id=None) -> Document | None:
    """Find a user's travel requisition with an overdue, unsubmitted retirement."""
    if not user or not getattr(user, "is_authenticated", False):
        return None
    docs = Document.objects.filter(
        Q(uploaded_by=user) | Q(owned_by=user),
        metadata__form__workflow_type="requisition",
        metadata__form__workflow_phase="retirement",
    ).exclude(deleted_at__isnull=False).only("id", "metadata", "reference_number", "document_type_id")
    if exclude_document_id:
        docs = docs.exclude(pk=exclude_document_id)
    docs = list(docs.distinct())
    submitted = _retirement_workflow_statuses([doc.id for doc in docs])
    today = timezone.localdate()
    for doc in docs:
        if submitted.get(doc.id):
            continue
        if not is_travel_requisition(doc):
            continue
        due = travel_retirement_due_date(doc)
        if due and today > due:
            return doc
    return None


def infer_builder_workflow_phase(document: Document) -> str | None:
    """Return ``request`` / ``retirement`` for builder forms, else ``None``."""
    if not is_built_form_document(document):
        return None

    if is_procurement_document(document):
        form = (document.metadata or {}).get("form") or {}
        stage = str(form.get("workflow_phase") or "requisition").strip().lower()
        if (
            stage == "retirement"
            and travel_retirement_config(document)
            and is_travel_requisition(document)
            and "lpo" in completed_procurement_stages(document)
        ):
            return "retirement"
        return stage if stage in PROCUREMENT_WORKFLOW_STAGES else "requisition"

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

    if is_procurement_document(document):
        phase = infer_builder_workflow_phase(document)
        meta = dict(document.metadata or {})
        form = dict(meta.get("form") or {})
        if form.get("workflow_phase") != phase:
            form["workflow_phase"] = phase
            meta["form"] = form
            document.metadata = meta
            document.save(update_fields=["metadata", "updated_at"])
        return phase

    phase = infer_builder_workflow_phase(document)
    meta = dict(document.metadata or {})
    form = dict(meta.get("form") or {})
    if form.get("workflow_phase") != phase:
        form["workflow_phase"] = phase
        meta["form"] = form
        document.metadata = meta
        document.save(update_fields=["metadata", "updated_at"])
    return phase


def set_procurement_workflow_stage(document: Document, stage: str) -> None:
    """Persist the explicit stage selected for a requisition approval cycle."""
    normalized = (stage or "").strip().lower()
    if not is_procurement_document(document) or normalized not in PROCUREMENT_WORKFLOW_STAGES:
        raise ValueError("Invalid procurement workflow stage.")
    meta = dict(document.metadata or {})
    form = dict(meta.get("form") or {})
    form["workflow_phase"] = normalized
    meta["form"] = form
    document.metadata = meta
    document.save(update_fields=["metadata", "updated_at"])


def open_travel_retirement_phase(document: Document) -> bool:
    """Open the retirement phase after the requisition's LPO is approved."""
    if (
        not is_procurement_document(document)
        or not is_travel_requisition(document)
        or not travel_retirement_config(document)
        or "lpo" not in completed_procurement_stages(document)
    ):
        return False
    meta = dict(document.metadata or {})
    form = dict(meta.get("form") or {})
    if form.get("workflow_phase") == "retirement":
        return False
    form["workflow_phase"] = "retirement"
    meta["form"] = form
    document.metadata = meta
    document.save(update_fields=["metadata", "updated_at"])
    return True


def completed_procurement_stages(document: Document) -> list[str]:
    form = ((document.metadata or {}).get("form") or {})
    stages = form.get("completed_workflow_stages")
    if not isinstance(stages, list):
        return []
    return [
        str(stage).strip().lower()
        for stage in stages
        if str(stage).strip().lower() in PROCUREMENT_WORKFLOW_STAGES
    ]


def requisition_type_config(document: Document) -> tuple[str, str]:
    """``(field_key, travel_value)`` for the requisition-type dropdown. Prefers
    the snapshot on ``metadata.form``; falls back to the source template."""
    form = ((document.metadata or {}).get("form") or {})
    field = str(form.get("requisition_type_field") or "").strip()
    value = str(form.get("travel_type_value") or "").strip() or "Travel"
    if field:
        return field, value
    template_id = form.get("template_id")
    if template_id:
        try:
            from apps.templates_engine.models import DocumentTemplate

            tpl = DocumentTemplate.objects.filter(pk=template_id).first()
            if tpl and tpl.requisition_type_field:
                return tpl.requisition_type_field, (tpl.travel_type_value or "Travel")
        except Exception:
            pass
    return "", value


def is_travel_requisition(document: Document) -> bool:
    """True when the requisition-type field holds the configured Travel value.
    Travel requisitions skip the RFQ stage (Requisition → LPO)."""
    if not is_procurement_document(document):
        return False
    field, travel_value = requisition_type_config(document)
    if not field:
        return False
    form = ((document.metadata or {}).get("form") or {})
    values = form.get("values")
    if not isinstance(values, dict):
        return False
    raw = values.get(field)
    if raw is None:
        return False
    return str(raw).strip().lower() == travel_value.strip().lower()


def next_procurement_stage(document: Document) -> str | None:
    """The stage the document is ready to start next, or ``None``.

    Mirrors ``can_start_procurement_workflow_stage``: the previous stage must be
    complete and the document approved, with no workflow still running. Travel
    requisitions skip RFQ and go straight from Requisition to LPO."""
    if not is_procurement_document(document):
        return None
    if (document.status or "").strip() != DocumentStatus.APPROVED:
        return None
    if builder_workflow_in_progress(document):
        return None
    form = ((document.metadata or {}).get("form") or {})
    phase = str(form.get("workflow_phase") or "").strip().lower()
    completed = completed_procurement_stages(document)
    if phase not in PROCUREMENT_WORKFLOW_STAGES or phase not in completed:
        return None
    if phase == "requisition":
        return "lpo" if is_travel_requisition(document) else "rfq"
    index = PROCUREMENT_WORKFLOW_STAGES.index(phase)
    if index + 1 < len(PROCUREMENT_WORKFLOW_STAGES):
        return PROCUREMENT_WORKFLOW_STAGES[index + 1]
    return None


def can_start_procurement_workflow_stage(document: Document, stage: str, *, user=None) -> bool:
    """Only allow the initial stage or the next completed procurement stage."""
    normalized = (stage or "").strip().lower()
    if not is_procurement_document(document) or normalized not in PROCUREMENT_WORKFLOW_STAGES:
        return False
    if user is not None and not user_may_submit_document(user, document):
        return False

    if normalized == "requisition":
        return (document.status or "").strip() in {
            DocumentStatus.DRAFT, DocumentStatus.RETURNED, "Returned for Review",
        }

    # Travel requisitions skip RFQ: LPO follows Requisition directly.
    travel = is_travel_requisition(document)
    if normalized == "rfq" and travel:
        return False
    if normalized == "lpo" and travel:
        previous = "requisition"
    else:
        previous = PROCUREMENT_WORKFLOW_STAGES[PROCUREMENT_WORKFLOW_STAGES.index(normalized) - 1]
    if previous not in completed_procurement_stages(document):
        return False
    if (document.status or "").strip() != DocumentStatus.APPROVED:
        return False

    try:
        from apps.workflows.models import WorkflowInstance
        return not WorkflowInstance.objects.filter(document=document, status="in_progress").exists()
    except Exception:
        return False


def record_procurement_stage_completion(document: Document, outcome: str) -> bool:
    """Add a successful requisition stage to the document progression."""
    if outcome != "approved" or not is_procurement_document(document):
        return False
    form = ((document.metadata or {}).get("form") or {})
    stage = str(form.get("workflow_phase") or "").strip().lower()
    if stage not in PROCUREMENT_WORKFLOW_STAGES:
        return False
    completed = completed_procurement_stages(document)
    if stage in completed:
        return False
    meta = dict(document.metadata or {})
    next_form = dict(form)
    next_form["completed_workflow_stages"] = [*completed, stage]
    meta["form"] = next_form
    document.metadata = meta
    return True


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
    """Return the lifecycle value used by form visibility/editability rules."""
    status = (document.status or DocumentStatus.DRAFT).strip().lower()
    if not is_built_form_document(document):
        return status

    form = (document.metadata or {}).get("form") or {}
    phase = (form.get("workflow_phase") or infer_builder_workflow_phase(document) or "request").strip().lower()

    if is_procurement_document(document):
        if builder_workflow_in_progress(document):
            return f"{phase}_pending"
        if status == DocumentStatus.RETURNED:
            return f"{phase}_returned"
        if status == DocumentStatus.REJECTED:
            return f"{phase}_rejected"
        if status == DocumentStatus.APPROVED:
            if phase == "retirement":
                return "fully_approved" if retirement_workflow_completed(document) or retirement_journal_posted(document) else "retirement_approved"
            if phase == "lpo" and travel_retirement_config(document) and is_travel_requisition(document) and "lpo" in completed_procurement_stages(document):
                return "lpo_approved"
            return "fully_approved" if phase == "lpo" and phase in completed_procurement_stages(document) else f"{phase}_approved"
        return status

    if builder_workflow_in_progress(document):
        return "retirement_pending" if phase == "retirement" else "request_pending"
    if status == DocumentStatus.RETURNED:
        return "retirement_returned" if phase == "retirement" else "returned"
    if status == DocumentStatus.REJECTED:
        return "retirement_rejected" if phase == "retirement" else "rejected"
    if status == DocumentStatus.APPROVED:
        if phase == "retirement" and (retirement_workflow_completed(document) or retirement_journal_posted(document)):
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

    # Explicitly check that this document type has a retirement workflow rule configured
    try:
        from apps.workflows.models import WorkflowRule
        has_retirement_rule = WorkflowRule.objects.filter(
            document_type=document.document_type,
            phase="retirement",
            is_active=True,
        ).exists()
        if not has_retirement_rule:
            return False
    except Exception:
        return False

    form = (document.metadata or {}).get("form") or {}
    if is_procurement_document(document):
        if not travel_retirement_config(document) or not is_travel_requisition(document) or "lpo" not in completed_procurement_stages(document):
            return False
    phase = (form.get("workflow_phase") or infer_builder_workflow_phase(document) or "request").strip().lower()
    if phase != "retirement":
        return False
    if (document.status or "").strip() != DocumentStatus.APPROVED:
        return False

    if is_procurement_document(document):
        returned = travel_return_date(document)
        if returned is not None and timezone.localdate() < returned:
            return False

    # Check if retirement workflow is already in progress or completed
    try:
        from apps.workflows.models import WorkflowInstance
        retirement_workflow = WorkflowInstance.objects.filter(
            document=document,
            rule__phase="retirement",
        ).first()
        if retirement_workflow:
            # If retirement workflow exists and is in progress, not ready
            if retirement_workflow.status == "in_progress":
                return False
            # If retirement workflow is approved, it's completed
            if retirement_workflow.status == "approved":
                return False
    except Exception:
        pass

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

        if user is not None and is_travel_requisition(document):
            if overdue_travel_retirement_for_user(user, exclude_document_id=document.id):
                return False

    if user is not None and not user_may_submit_document(user, document):
        return False
    return True
