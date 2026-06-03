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


def filter_permissions_for_document(user, document: Document, permissions: set[str]) -> set[str]:
    """Remove actions the user cannot perform on this document (policy + stage)."""
    from apps.accounts.models import GroupAction

    perms = set(permissions)
    if not document_allows_edit(document, user=user):
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
