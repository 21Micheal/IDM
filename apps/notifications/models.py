from django.db import models
from django.conf import settings
import uuid

class Notification(models.Model):
    NOTIFICATION_TYPES = [
        ("task_assigned", "Task Assigned"),
        ("workflow_complete", "Workflow Complete"),
        ("document_returned", "Document Returned"),
        ("document_held", "Document Held"),
        ("hold_released", "Hold Released"),
        ("hold_ending", "Hold Ending Soon"),
        ("hold_expired", "Hold Expired"),
        ("task_sla_warning", "Task SLA Warning"),
        ("task_overdue", "Task Overdue"),
        ("workflow_action", "Workflow Action"),
        ("delegation", "Delegation"),
        ("document_shared", "Document Shared"),
        ("signature_requested", "Signature Requested"),
        ("signature_signed", "Signature Added"),
        ("signature_declined", "Signature Declined"),
        ("signature_completed", "Signatures Complete"),
        ("mailbox_poll_failed", "Mailbox Poll Failed"),
        ("mailbox_ingested", "Mailbox Documents Ingested"),
    ]

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    recipient = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="notifications")
    type = models.CharField(max_length=20, choices=NOTIFICATION_TYPES, default="task_assigned")
    message = models.TextField()
    link = models.CharField(max_length=500, blank=True)
    is_read = models.BooleanField(default=False)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["-created_at", "-id"]
        indexes = [
            models.Index(fields=["recipient", "is_read", "-created_at"]),
            models.Index(fields=["recipient", "-created_at"]),
            models.Index(fields=["type", "-created_at"]),
        ]
