"""
audit/models.py
Immutable audit log. All document actions are recorded here.
The django-auditlog library covers model-level changes automatically;
this model captures business-level events (view, download, workflow actions).
"""
from django.db import models
from django.conf import settings
import uuid


class AuditEvent(models.TextChoices):
    DOCUMENT_CREATED = "document.created", "Document Created"
    DOCUMENT_VIEWED = "document.viewed", "Document Viewed"
    DOCUMENT_PREVIEWED = "document.previewed", "Document File Previewed (inline)"
    DOCUMENT_DOWNLOADED = "document.downloaded", "Document File Downloaded (attachment)"
    DOCUMENT_PRINTED = "document.printed", "Document Print Requested"
    DOCUMENT_UPDATED = "document.updated", "Document Updated"
    DOCUMENT_DELETED = "document.deleted", "Document Deleted"
    DOCUMENT_RESTORED = "document.restored", "Document Restored from Trash"
    DOCUMENT_PURGED = "document.purged", "Document Permanently Deleted"
    DOCUMENT_SUBMITTED = "document.submitted", "Submitted for Approval"
    DOCUMENT_BULK_UPLOADED = "document.bulk_uploaded", "Document Bulk Uploaded"
    DOCUMENT_BULK_REVIEWED = "document.bulk_reviewed", "Bulk Upload Reviewed"
    DOCUMENT_PREVIEW_QUEUED = "document.preview_queued", "Document Preview Queued"
    DOCUMENT_OCR_QUEUED = "document.ocr_queued", "Document OCR Queued"
    DOCUMENT_OCR_COMPLETED = "document.ocr_completed", "Document OCR Completed"
    DOCUMENT_OCR_FAILED = "document.ocr_failed", "Document OCR Failed"
    DOCUMENT_EDIT_LOCK_ACQUIRED = "document.edit_lock_acquired", "Document Edit Lock Acquired"
    DOCUMENT_EDIT_LOCK_RELEASED = "document.edit_lock_released", "Document Edit Lock Released"
    WORKFLOW_APPROVED = "workflow.approved", "Workflow Step Approved"
    WORKFLOW_REJECTED = "workflow.rejected", "Workflow Step Rejected"
    WORKFLOW_RETURNED = "workflow.returned", "Workflow Step Returned"
    WORKFLOW_HELD = "workflow.held", "Workflow Step Held"
    WORKFLOW_RELEASED = "workflow.released", "Workflow Step Released"
    WORKFLOW_CANCELLED = "workflow.cancelled", "Workflow Cancelled"
    WORKFLOW_DELEGATED = "workflow.delegated", "Workflow Tasks Delegated"
    WORKFLOW_REASSIGNED = "workflow.reassigned", "Workflow Tasks Reassigned"
    DOCUMENT_ARCHIVED = "document.archived", "Document Archived"
    DOCUMENT_VERSION_UPLOADED = "document.version_uploaded", "New Version Uploaded"
    DOCUMENT_VERSION_RESTORED = "document.version_restored", "Version Restored"
    DOCUMENT_VERSION_PREVIEW_QUEUED = "document.version_preview_queued", "Document Version Preview Queued"
    USER_LOGIN = "user.login", "User Login"
    USER_LOGIN_FAILED = "user.login_failed", "Login Failed"
    USER_MFA_ENABLED = "user.mfa_enabled", "MFA Enabled"
    USER_CREATED = "user.created", "User Created"
    USER_DELETED = "user.deleted", "User Deleted"
    USER_PASSWORD_RESET = "user.password_reset", "User Password Reset"
    USER_ACTIVATED = "user.activated", "User Activated"
    USER_DEACTIVATED = "user.deactivated", "User Deactivated"
    PERMISSION_CHANGED = "permission.changed", "Permission Changed"
    GROUP_PERMISSION_GRANTED = "group.permission_granted", "Group Permission Granted"
    GROUP_PERMISSION_REVOKED = "group.permission_revoked", "Group Permission Revoked"
    GROUP_PERMISSION_UPDATED = "group.permission_updated", "Group Permissions Updated"
    AUDIT_EXPORTED = "audit.exported", "Audit Log Exported"


# Low-signal, high-volume events (views, inline previews, transient queue/lock
# states). They stay in the immutable log and the admin system audit, but are
# hidden from the curated, user-facing trails (per-document Audit tab and the
# non-admin activity feed) where they only add noise.
LOW_SIGNAL_AUDIT_EVENTS = frozenset({
    AuditEvent.DOCUMENT_VIEWED,
    AuditEvent.DOCUMENT_PREVIEWED,
    AuditEvent.DOCUMENT_PREVIEW_QUEUED,
    AuditEvent.DOCUMENT_VERSION_PREVIEW_QUEUED,
    AuditEvent.DOCUMENT_OCR_QUEUED,
    AuditEvent.DOCUMENT_EDIT_LOCK_ACQUIRED,
    AuditEvent.DOCUMENT_EDIT_LOCK_RELEASED,
})


class AuditLog(models.Model):
    """Append-only audit log. Never update or delete rows."""
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    event = models.CharField(max_length=60, choices=AuditEvent.choices, db_index=True)
    actor = models.ForeignKey(
        settings.AUTH_USER_MODEL, null=True, on_delete=models.SET_NULL,
        related_name="audit_logs"
    )
    # Generic FK to any object
    object_type = models.CharField(max_length=60, blank=True)
    object_id = models.CharField(max_length=40, blank=True, db_index=True)
    object_repr = models.CharField(max_length=255, blank=True)
    # Structured diff / context
    changes = models.JSONField(default=dict, blank=True)
    # Request metadata
    ip_address = models.GenericIPAddressField(null=True, blank=True)
    user_agent = models.TextField(blank=True)
    timestamp = models.DateTimeField(auto_now_add=True, db_index=True)

    class Meta:
        ordering = ["-timestamp"]
        # Prevent accidental updates
        default_permissions = ("view",)

    def __str__(self):
        return f"{self.timestamp.isoformat()} | {self.event} | {self.actor}"

    def save(self, *args, **kwargs):
        if self.pk and AuditLog.objects.filter(pk=self.pk).exists():
            raise ValueError("Audit log entries are immutable")
        super().save(*args, **kwargs)
