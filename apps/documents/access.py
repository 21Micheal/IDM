"""
Document lifecycle access: stage resolution and editability policies.
"""
from __future__ import annotations

from typing import Any

from apps.documents.models import DMSSettings, Document, DocumentStatus

ACCESS_STAGE_ANY = "any"
ACCESS_STAGE_CREATION = "creation"
ACCESS_STAGE_APPROVAL = "approval"
ACCESS_STAGE_AFTER_APPROVAL = "after_approval"

ACCESS_STAGE_KEYS = (
    ACCESS_STAGE_ANY,
    ACCESS_STAGE_CREATION,
    ACCESS_STAGE_APPROVAL,
    ACCESS_STAGE_AFTER_APPROVAL,
)

DEFAULT_ACCESS_STAGES = [
    {
        "key": ACCESS_STAGE_CREATION,
        "name": "Creation",
        "statuses": ["draft", "pending_review", "returned"],
    },
    {
        "key": ACCESS_STAGE_APPROVAL,
        "name": "For approval",
        "statuses": ["pending_approval"],
    },
    {
        "key": ACCESS_STAGE_AFTER_APPROVAL,
        "name": "After approval",
        "statuses": ["approved", "rejected", "archived"],
    },
]

DEFAULT_ACCESS_POLICY: dict[str, dict[str, Any]] = {
    "on_approved": {"set_status": DocumentStatus.APPROVED, "allow_edit": False},
    "on_rejected": {"set_status": DocumentStatus.REJECTED, "allow_edit": True},
    "on_archived": {"set_status": DocumentStatus.ARCHIVED, "allow_edit": False},
}

LEGACY_EDITABLE_STATUSES = frozenset({
    DocumentStatus.DRAFT,
    DocumentStatus.REJECTED,
    DocumentStatus.RETURNED,
    "Returned for Review",
})


def get_access_stages() -> list[dict[str, Any]]:
    settings = DMSSettings.load()
    stages = settings.access_stages or []
    return stages if stages else list(DEFAULT_ACCESS_STAGES)


def permission_stage_is_global() -> bool:
    """
    True when RBAC runs in single-stage mode — one permission configuration
    ("any") applies across the entire document lifecycle instead of per stage.
    """
    return bool(DMSSettings.load().rbac_single_stage)


def _status_to_stage_map() -> dict[str, str]:
    mapping: dict[str, str] = {}
    for stage_def in get_access_stages():
        key = stage_def.get("key")
        if not key:
            continue
        for status in stage_def.get("statuses") or []:
            mapping[str(status).lower()] = key
    return mapping


def _document_has_active_workflow(document: Document) -> bool:
    try:
        instance = document.workflow_instance
    except Exception:
        return False
    return getattr(instance, "status", None) == "in_progress"


def resolve_access_stage(document: Document) -> str:
    """
    Map a document to a lifecycle stage for permission checks.
    Strictly follows admin-configured access stage mappings, with a critical safety check:
    returned documents default to CREATION stage unless explicitly configured otherwise.
    This ensures returned documents can be edited by uploaders but NOT approvers.
    """
    status = (document.status or "").strip()
    status_lower = status.lower()

    # Use admin-configured mapping for this status
    stage = _status_to_stage_map().get(status_lower)
    if stage is not None:
        return stage

    # Safety check: returned documents should be CREATION (editable by uploader)
    # unless explicitly configured otherwise by admin.
    # This prevents approvers from being able to edit returned documents.
    if status_lower in ("returned",) or status in LEGACY_EDITABLE_STATUSES:
        return ACCESS_STAGE_CREATION

    # If no explicit mapping exists and document has active workflow, use approval stage
    if _document_has_active_workflow(document):
        return ACCESS_STAGE_APPROVAL

    # Default to creation stage for unmapped statuses
    return ACCESS_STAGE_CREATION


def get_merged_access_policy(document_type) -> dict[str, dict[str, Any]]:
    raw = getattr(document_type, "access_policy", None) or {}
    merged: dict[str, dict[str, Any]] = {}
    for key, default in DEFAULT_ACCESS_POLICY.items():
        entry = dict(default)
        if isinstance(raw.get(key), dict):
            entry.update(raw[key])
        merged[key] = entry
    return merged


def document_allows_edit(document: Document, *, user=None) -> bool:
    """
    Whether this document is in an editable lifecycle stage.

    Editability is deliberately stage-driven rather than document-type driven:
    groups grant EDIT for a concrete document type and lifecycle stage, and only
    the creation stage allows edits. This keeps metadata edits and Office editor
    saves on the same rule path.

    CRITICAL: If the document has an active workflow, the user must have an
    active task assigned to them. Once the workflow progresses past their step,
    they lose edit access even if they have creation-stage permissions. This
    ensures users cannot edit documents while the workflow is being actioned
    by someone else at a different step.
    """
    if user is not None and getattr(user, "has_admin_access", False):
        return True

    # Allow edits when the resolved access stage is creation. This covers
    # documents that are marked as "returned" and ensures uploaders can
    # modify and resubmit without cancelling the workflow instance.
    if resolve_access_stage(document) != ACCESS_STAGE_CREATION:
        return False

    # If document has an active workflow and a user is specified,
    # verify that the user has an active task assigned to them.
    # This prevents users from editing when the workflow has progressed
    # past their step.
    #
    # EXCEPTION: Returned documents are exempt. When a document is returned
    # to the uploader for rework, they should be able to edit it without
    # needing an active task. The workflow remains active so resubmission
    # resumes at the same step.
    if user is not None and _document_has_active_workflow(document):
        status_lower = (document.status or "").strip().lower()
        
        # Allow uploader to edit returned documents without active task
        if status_lower == "returned":
            return True

        from apps.workflows.models import WorkflowTask

        has_active_task = WorkflowTask.objects.filter(
            assigned_to=user,
            workflow_instance__document_id=document.id,
            status__in=["in_progress"],
        ).exists()

        if not has_active_task:
            return False

    return True


def is_built_form_document(document: Document) -> bool:
    """True when the document carries an in-app built-template form schema."""
    form = (document.metadata or {}).get("form")
    return isinstance(form, dict) and bool(form.get("sections"))


def viewer_for_user(user):
    """Build the ``user_group`` condition context (group ids/names + admin) for a
    request user. Returns ``None`` for an anonymous/missing user, which makes
    group rules non-restrictive (they are a convenience, not access control)."""
    if user is None or not getattr(user, "is_authenticated", False):
        return None
    from apps.templates_engine.conditions import build_viewer
    memberships = getattr(user, "group_memberships", None)
    ids, names = set(), set()
    if memberships is not None:
        ids = {str(v) for v in memberships.values_list("group_id", flat=True)}
        names = set(memberships.select_related("group").values_list("group__name", flat=True))
    return build_viewer(ids, names, bool(getattr(user, "has_admin_access", False)))


def form_has_editable_fields(document: Document, user=None) -> bool:
    """True when the built form exposes at least one visible, editable field at
    the document's current process step (``status``)."""
    form = (document.metadata or {}).get("form")
    if not isinstance(form, dict):
        return False
    from apps.documents.builder_workflow import builder_process_step
    from apps.documents.form_attachments import descriptors_to_names
    from apps.templates_engine.conditions import is_editable, is_visible

    sections = form.get("sections") or []
    values = form.get("values") if isinstance(form.get("values"), dict) else {}
    process_step = builder_process_step(document)
    render_values = descriptors_to_names(values)
    viewer = viewer_for_user(user)

    for section in sections:
        if not isinstance(section, dict):
            continue
        if not is_visible(section, render_values, process_step, viewer):
            continue
        section_editable = is_editable(section, render_values, process_step, viewer)
        for field in section.get("fields") or []:
            if not isinstance(field, dict):
                continue
            if not field.get("key"):
                continue
            if (
                is_visible(field, render_values, process_step, viewer)
                and section_editable
                and is_editable(field, render_values, process_step, viewer)
            ):
                return True
    return False


def retirement_editable_section_ids(document: Document, user=None) -> set[str]:
    """Return visible retirement-expense sections editable after LPO approval.

    The retirement expense table is a sub-process of a requisition and must stay
    locked while the LPO workflow is active. Once LPO is approved, its
    section-level group visibility rule is the access boundary for scoped edits.
    """
    if user is None or not getattr(user, "is_authenticated", False):
        return set()
    try:
        from apps.documents.builder_workflow import builder_process_step, completed_procurement_stages
        if "requisition" not in completed_procurement_stages(document):
            return set()
        if builder_process_step(document) != "lpo_approved":
            return set()
        form = (document.metadata or {}).get("form")
        if not isinstance(form, dict):
            return set()
        from apps.documents.form_attachments import descriptors_to_names
        from apps.templates_engine.conditions import is_editable, is_visible
        values = form.get("values") if isinstance(form.get("values"), dict) else {}
        rendered = descriptors_to_names(values)
        process_step = builder_process_step(document)
        viewer = viewer_for_user(user)
        result = set()
        for section in form.get("sections") or []:
            if not isinstance(section, dict) or section.get("hidden") or section.get("readonly"):
                continue
            fields = section.get("fields") or []
            if not any(isinstance(field, dict) and field.get("workflowRole") == "retirement_expenses" for field in fields):
                continue
            if not is_visible(section, rendered, process_step, viewer) or not is_editable(section, rendered, process_step, viewer):
                continue
            if not any(
                isinstance(field, dict)
                and field.get("key")
                and not field.get("hidden")
                and not field.get("readonly")
                and is_visible(field, rendered, process_step, viewer)
                and is_editable(field, rendered, process_step, viewer)
                for field in fields
            ):
                continue
            result.add(str(section.get("id") or section.get("key") or ""))
        return result
    except Exception:
        return set()


def user_owns_document(user, document: Document) -> bool:
    """True when ``user`` is the uploader or designated owner of ``document``."""
    if user is None:
        return False
    return (
        getattr(document, "uploaded_by_id", None) == getattr(user, "id", None)
        or getattr(document, "owned_by_id", None) == getattr(user, "id", None)
    )


def user_has_active_approval_task(user, document: Document) -> bool:
    """Whether the user can act on an active approval task for this document."""
    if user is None or not getattr(user, "is_authenticated", False):
        return False
    try:
        from apps.accounts.delegation import tasks_visible_to_user
        return tasks_visible_to_user(user).filter(
            workflow_instance__document_id=document.id,
            workflow_instance__status="in_progress",
            status="in_progress",
        ).exists()
    except Exception:
        return False


def document_allows_form_edit(document: Document, *, user=None) -> bool:
    """Whether an in-app built-template form may be edited (stage-aware).

    Creation-stage rules mirror ``document_allows_edit`` (workflow task gates).
    Later lifecycle stages allow owner edits when the form schema exposes
    editable fields at the current process step. During approval, only a user
    with an active assigned task may edit; section and field rules still control
    which inputs are enabled.
    """
    if not is_built_form_document(document):
        return False
    if user is not None and getattr(user, "has_admin_access", False):
        return True

    if retirement_editable_section_ids(document, user=user):
        return True

    stage = resolve_access_stage(document)

    if stage == ACCESS_STAGE_CREATION:
        return document_allows_edit(document, user=user)

    try:
        from apps.documents.builder_workflow import builder_process_step
        if builder_process_step(document) in {"retirement_approved", "fully_approved", "retirement_rejected"}:
            return False
    except Exception:
        pass

    if not form_has_editable_fields(document, user=user):
        return False

    if user_has_active_approval_task(user, document):
        return True

    if stage == ACCESS_STAGE_APPROVAL:
        return False

    if stage == ACCESS_STAGE_AFTER_APPROVAL:
        return user_owns_document(user, document)

    return False


def document_allows_editing_actions(document: Document, *, user=None) -> bool:
    """Whether EDIT/UPLOAD-class actions are permitted for this document."""
    if is_built_form_document(document):
        return document_allows_form_edit(document, user=user)
    return document_allows_edit(document, user=user)


def filter_permissions_for_document(user, document: Document, permissions: set[str]) -> set[str]:
    """Remove actions the user cannot perform on this document (policy + stage)."""
    from apps.accounts.models import GroupAction

    perms = set(permissions)
    if not document_allows_editing_actions(document, user=user):
        perms.discard(GroupAction.EDIT.value)
        perms.discard(GroupAction.UPLOAD.value)
    return perms


def effective_permissions_for_user(user, document: Document) -> list[str]:
    """Resolved permission action strings for API responses."""
    from apps.accounts.models import GroupAction

    if not user or not getattr(user, "is_authenticated", False):
        return []
    if user.has_admin_access:
        return [
            choice[0]
            for choice in GroupAction.choices
            if choice[0] != GroupAction.ADMIN.value
        ]
    if getattr(document, "is_self_upload", False) and document.uploaded_by_id == user.id:
        return [
            GroupAction.VIEW.value,
            GroupAction.EDIT.value,
            GroupAction.UPLOAD.value,
            GroupAction.DELETE.value,
            GroupAction.DOWNLOAD.value,
            GroupAction.COMMENT.value,
            GroupAction.ARCHIVE.value,
        ]
    
    # Access is scoped to involvement: a user with no involvement in this
    # document has no permissions on it, regardless of group grants on the type.
    from apps.documents.file_streaming import user_is_involved_with_document
    if not user_is_involved_with_document(user, document):
        return []

    # CRITICAL FIX: When a document is returned for review, only the uploader
    # should have creation-stage permissions. Approvers who returned it should
    # not retain creation rights even if their group grants them.
    status_lower = (document.status or "").strip().lower()
    if status_lower == "returned" and document.uploaded_by_id != user.id:
        # Non-uploaders only get VIEW permission on returned documents
        # They cannot edit, upload, submit, or delete
        return [GroupAction.VIEW.value]

    perms = user.get_all_permissions_for_doctype(
        str(document.document_type_id),
        document=document,
    )
    perms = filter_permissions_for_document(user, document, perms)
    if (
        is_built_form_document(document)
        and GroupAction.APPROVE.value in perms
        and user_has_active_approval_task(user, document)
    ):
        perms.add(GroupAction.EDIT.value)
    # Involvement implies the ability to view (the access gates allow it), even
    # if the group's action set doesn't explicitly include VIEW.
    perms = set(perms) | {GroupAction.VIEW.value}
    return sorted(perms)


def outcome_status_for(document_type, outcome: str) -> str:
    """Return target document status for workflow/archive outcome."""
    policy = get_merged_access_policy(document_type)
    key = {
        "approved": "on_approved",
        "rejected": "on_rejected",
        "archived": "on_archived",
    }.get(outcome)
    if not key:
        return outcome
    return str(policy[key].get("set_status") or outcome)
