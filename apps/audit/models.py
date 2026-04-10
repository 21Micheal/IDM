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
    DOCUMENT_DOWNLOADED = "document.downloaded", "Document Downloaded"
    DOCUMENT_UPDATED = "document.updated", "Document Updated"
    DOCUMENT_DELETED = "document.deleted", "Document Deleted"
    DOCUMENT_SUBMITTED = "document.submitted", "Submitted for Approval"
    WORKFLOW_APPROVED = "workflow.approved", "Workflow Step Approved"
    WORKFLOW_REJECTED = "workflow.rejected", "Workflow Step Rejected"
    DOCUMENT_ARCHIVED = "document.archived", "Document Archived"
    DOCUMENT_VERSION_UPLOADED = "document.version_uploaded", "New Version Uploaded"
    DOCUMENT_VERSION_RESTORED = "document.version_restored", "Version Restored"
    USER_LOGIN = "user.login", "User Login"
    USER_LOGIN_FAILED = "user.login_failed", "Login Failed"
    USER_MFA_ENABLED = "user.mfa_enabled", "MFA Enabled"
    PERMISSION_CHANGED = "permission.changed", "Permission Changed"


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
