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


class RetirementReportSchedule(models.Model):
    class Frequency(models.TextChoices):
        DAILY = "daily", "Daily"
        WEEKLY = "weekly", "Weekly"
        MONTHLY = "monthly", "Monthly"

    class Audience(models.TextChoices):
        HODS_FINANCE = "hods_finance", "Department Heads and Finance Approvers"
        ALL_MANAGEMENT = "all_mgmt", "Executive Leadership and Audit Committee"

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    key = models.CharField(max_length=40, unique=True, default="outstanding_retirements")
    updated_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        null=True,
        blank=True,
        on_delete=models.SET_NULL,
        related_name="updated_retirement_report_schedules",
    )
    frequency = models.CharField(max_length=12, choices=Frequency.choices, default=Frequency.WEEKLY)
    audience = models.CharField(max_length=20, choices=Audience.choices, default=Audience.HODS_FINANCE)
    enabled = models.BooleanField(default=False)
    last_sent_on = models.DateField(null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        indexes = [models.Index(fields=["enabled", "frequency"], name="notif_ret_rpt_en_freq_idx")]

    def __str__(self):
        return f"{self.get_frequency_display()} outstanding-retirements report"
