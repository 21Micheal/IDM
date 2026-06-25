"""
apps/workflows/models.py

Additions to existing model file:
  1. WorkflowTask gains:
       status choices: "held", "returned"
       held_until: DateTimeField (null) — auto-release timestamp
  2. WorkflowTaskAction — immutable record of every action taken on a task
     (approve, reject, hold, return). Replaces the single comment field for
     a full audit trail of task actions.
  3. WorkflowStep gains:
       step_type: "approval" (default) | "notification"
       notify_user: FK to User (optional, notification recipient)
       notify_email: EmailField (optional, external recipient)
       notification_subject: subject line for notification steps
       notification_message: body for notification steps
       approver_email_subject: custom subject for task-assignment emails
       approver_email_body: custom body for task-assignment emails

MIGRATION NOTE: run 0004_step_type_notification after applying this file.
"""
from django.core.exceptions import ValidationError
from django.db import models
from django.conf import settings
import uuid


class WorkflowTemplate(models.Model):
    id          = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    name        = models.CharField(max_length=120, unique=True)
    description = models.TextField(blank=True)
    document_type = models.ForeignKey(
        "documents.DocumentType",
        null=True,
        blank=True,
        on_delete=models.SET_NULL,
        related_name="workflow_templates",
        help_text="Document type this template belongs to.",
    )
    is_active   = models.BooleanField(default=True)
    notify_uploader_on_approval = models.BooleanField(
        default=True,
        help_text=(
            "When enabled, the document uploader receives an email and in-app "
            "notification each time an approval step is completed."
        ),
    )
    email_templates = models.JSONField(
        default=dict,
        blank=True,
        help_text=(
            "Optional per-event email overrides. Keys: workflow_complete, "
            "action_approved, action_rejected, action_returned, action_held, "
            "action_released, hold_ending, hold_expired, sla_warning, sla_overdue. "
            "Each value may contain 'subject' and 'body'. Leave blank to use defaults."
        ),
    )
    created_by  = models.ForeignKey(
        settings.AUTH_USER_MODEL, null=True, on_delete=models.SET_NULL,
        related_name="created_workflow_templates",
    )
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["name"]

    def __str__(self):
        return self.name

    @property
    def step_count(self):
        return self.steps.count()

    def clean(self):
        super().clean()
        if self.document_type_id is None and self.pk and self.rules.exists():
            raise ValidationError(
                {"document_type": "Templates with routing rules must remain assigned to a document type."}
            )

    def save(self, *args, **kwargs):
        previous_document_type_id = None
        if self.pk:
            previous_document_type_id = (
                WorkflowTemplate.objects
                .filter(pk=self.pk)
                .values_list("document_type_id", flat=True)
                .first()
            )

        self.full_clean()
        super().save(*args, **kwargs)

        if self.document_type_id and previous_document_type_id != self.document_type_id:
            self.rules.exclude(document_type_id=self.document_type_id).update(
                document_type_id=self.document_type_id
            )


class WorkflowStep(models.Model):
    ASSIGNEE_TYPES = [
        ("group_any",      "Any member of group"),
        ("group_all",      "All members of group"),
        ("group_specific", "Specific member of group"),
    ]

    STEP_TYPES = [
        ("approval",     "Approval"),
        ("notification", "Notification"),
    ]

    id            = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    template      = models.ForeignKey(
        WorkflowTemplate, on_delete=models.CASCADE, related_name="steps"
    )
    order         = models.PositiveSmallIntegerField(db_index=True)
    name          = models.CharField(max_length=120)
    status_label  = models.CharField(max_length=80, default="Pending Approval")

    # ── Step type ─────────────────────────────────────────────────────────────
    step_type = models.CharField(
        max_length=20,
        choices=STEP_TYPES,
        default="approval",
        help_text=(
            "'approval' requires a human to act; "
            "'notification' fires an email and auto-advances immediately."
        ),
    )

    # ── Approval-step fields ──────────────────────────────────────────────────
    assignee_type = models.CharField(max_length=20, choices=ASSIGNEE_TYPES, default="group_any")
    assignee_group = models.ForeignKey(
        "accounts.UserGroup",
        null=True,
        blank=True,
        on_delete=models.SET_NULL,
        related_name="workflow_steps",
    )
    assignee_user = models.ForeignKey(
        settings.AUTH_USER_MODEL, null=True, blank=True,
        on_delete=models.SET_NULL, related_name="assigned_steps",
    )
    # True when assignee_user was auto-filled from the group's designated approver
    # (head) rather than hand-picked. Such steps resolve the group's CURRENT head
    # at assignment time, so changing the group's approver propagates to them.
    assignee_user_auto = models.BooleanField(default=False)
    sla_hours      = models.PositiveSmallIntegerField(default=48)
    allow_resubmit = models.BooleanField(default=True)
    allow_approve  = models.BooleanField(default=True, help_text="Approver can approve at this step")
    allow_reject   = models.BooleanField(default=True, help_text="Approver can reject at this step")
    allow_return   = models.BooleanField(default=True, help_text="Approver can send back for review at this step")
    requires_signature = models.BooleanField(
        default=False,
        help_text="Approving this step must stamp the approver's saved e-signature onto the document.",
    )
    instructions   = models.TextField(blank=True)

    # ── Custom email for approvers (approval steps only) ──────────────────────
    # When set, these override the default hardcoded task-assignment email.
    approver_email_subject = models.CharField(
        max_length=255,
        blank=True,
        help_text="Custom subject for the task-assignment email sent to approvers. "
                  "Leave blank to use the system default.",
    )
    approver_email_body = models.TextField(
        blank=True,
        help_text=(
            "Custom body for the task-assignment email sent to approvers. "
            "Supports these placeholders: {approver_name}, {document_title}, "
            "{document_ref}, {step_name}, {instructions}, {document_url}. "
            "Leave blank to use the system default."
        ),
    )

    # ── Notification-step fields ───────────────────────────────────────────────
    # Exactly one of notify_user or notify_email must be set for notification steps.
    notify_user = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        null=True,
        blank=True,
        on_delete=models.SET_NULL,
        related_name="notification_steps",
        help_text="System user to notify (notification steps only).",
    )
    notify_email = models.EmailField(
        blank=True,
        help_text="External email address to notify (notification steps only).",
    )
    notification_subject = models.CharField(
        max_length=255,
        blank=True,
        help_text="Email subject for notification steps.",
    )
    notification_message = models.TextField(
        blank=True,
        help_text="Email body for notification steps.",
    )

    created_at     = models.DateTimeField(auto_now_add=True, null=True)
    updated_at     = models.DateTimeField(auto_now=True)

    class Meta:
        ordering        = ["order"]
        unique_together = [("template", "order")]

    def __str__(self):
        return f"{self.template.name} → {self.order}. {self.name}"

    def clean(self):
        super().clean()
        if self.step_type == "notification":
            if not self.notify_user_id and not self.notify_email:
                raise ValidationError(
                    "Notification steps require either a recipient user or an email address."
                )
            if not self.notification_subject:
                raise ValidationError(
                    {"notification_subject": "A subject is required for notification steps."}
                )
            if not self.notification_message:
                raise ValidationError(
                    {"notification_message": "A message body is required for notification steps."}
                )
        elif self.step_type == "approval":
            if not self.assignee_group_id:
                raise ValidationError(
                    {"assignee_group": "Approval steps require an assignee group."}
                )
            if not any([self.allow_approve, self.allow_reject, self.allow_return]):
                raise ValidationError(
                    "At least one approver action (approve, reject, or return) must be enabled."
                )


class WorkflowRule(models.Model):
    id               = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    document_type    = models.ForeignKey(
        "documents.DocumentType", on_delete=models.CASCADE, related_name="workflow_rules",
    )
    template         = models.ForeignKey(
        WorkflowTemplate, on_delete=models.PROTECT, related_name="rules"
    )
    amount_min       = models.DecimalField(max_digits=18, decimal_places=2, default=0)
    amount_max       = models.DecimalField(max_digits=18, decimal_places=2, null=True, blank=True)
    currency         = models.CharField(max_length=3, default="USD")
    label            = models.CharField(max_length=120, blank=True)
    is_active        = models.BooleanField(default=True)
    created_at       = models.DateTimeField(auto_now_add=True, null=True)
    updated_at       = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["document_type", "amount_min", "amount_max"]

    def __str__(self):
        upper = self.amount_max if self.amount_max is not None else "∞"
        return f"{self.document_type.name} [{self.amount_min} - {upper}] -> {self.template.name}"

    def clean(self):
        super().clean()
        if self.template_id and self.template.document_type_id is None:
            raise ValidationError(
                {"template": "Assign this template to a document type before adding routing rules."}
            )
        if (
            self.template_id
            and self.template.document_type_id
            and self.document_type_id
            and self.template.document_type_id != self.document_type_id
        ):
            raise ValidationError(
                {"document_type": "Routing rules must use the same document type as their template."}
            )

    def save(self, *args, **kwargs):
        if self.template_id and self.template.document_type_id:
            self.document_type_id = self.template.document_type_id
        self.full_clean()
        super().save(*args, **kwargs)


class WorkflowInstance(models.Model):
    STATUS_CHOICES = [
        ("in_progress", "In Progress"),
        ("approved",    "Approved"),
        ("rejected",    "Rejected"),
        ("cancelled",   "Cancelled"),
    ]

    id                 = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    document           = models.OneToOneField(
        "documents.Document", on_delete=models.CASCADE, related_name="workflow_instance",
    )
    template           = models.ForeignKey(WorkflowTemplate, on_delete=models.PROTECT)
    rule               = models.ForeignKey(
        WorkflowRule, null=True, on_delete=models.SET_NULL, related_name="instances"
    )
    status             = models.CharField(max_length=20, choices=STATUS_CHOICES, default="in_progress")
    current_step_order = models.PositiveSmallIntegerField(default=1)
    started_by         = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.PROTECT, related_name="started_workflows",
    )
    started_at   = models.DateTimeField(auto_now_add=True)
    updated_at   = models.DateTimeField(auto_now=True)
    completed_at = models.DateTimeField(null=True, blank=True)

    def __str__(self):
        return f"Workflow for {self.document.reference_number} [{self.status}]"


class WorkflowTask(models.Model):
    STATUS_CHOICES = [
        ("pending",     "Pending"),
        ("in_progress", "In Progress"),
        ("approved",    "Approved"),
        ("rejected",    "Rejected"),
        ("returned",    "Returned for Review"),
        ("held",        "On Hold"),
        ("skipped",     "Skipped"),
        # Notification steps are auto-completed; this status marks that.
        ("notified",    "Notification Sent"),
    ]

    RETURN_TO_CHOICES = [
        ("previous_step", "Previous Approver"),
        ("uploader",      "Document Uploader"),
        ("same_step",     "Same Approver"),
    ]

    id                = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    workflow_instance = models.ForeignKey(
        WorkflowInstance, on_delete=models.CASCADE, related_name="tasks"
    )
    step         = models.ForeignKey(WorkflowStep, on_delete=models.PROTECT)
    assigned_to  = models.ForeignKey(
        settings.AUTH_USER_MODEL, null=True, blank=True,
        on_delete=models.SET_NULL, related_name="workflow_tasks",
    )
    status   = models.CharField(max_length=20, choices=STATUS_CHOICES, default="pending")
    comment  = models.TextField(blank=True)
    due_at   = models.DateTimeField(null=True, blank=True)
    # ── Hold support ──────────────────────────────────────────────────────────
    held_until = models.DateTimeField(
        null=True, blank=True,
        help_text="Hold timestamp - when approver manually releases, this is cleared.",
    )
    # ── Return decision ──────────────────────────────────────────────────────
    return_to = models.CharField(
        max_length=20, choices=RETURN_TO_CHOICES, default="previous_step",
        help_text="Where to return the document if rejected/returned",
    )
    acted_at   = models.DateTimeField(null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True, null=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["step__order"]
        indexes = [
            # Backs the "my tasks" badge/list query (assigned_to + status filter),
            # which is polled frequently by the app shell.
            models.Index(fields=["assigned_to", "status"]),
        ]

    def __str__(self):
        return f"Task: {self.step.name} [{self.status}]"


class WorkflowTaskAction(models.Model):
    """
    Immutable audit log of every action taken on a WorkflowTask.
    Separate from WorkflowTask.comment (which stores the latest comment only)
    so the full action history is always preserved.
    """
    ACTION_CHOICES = [
        ("approved",   "Approved"),
        ("rejected",   "Rejected"),
        ("returned",   "Returned for Review"),
        ("held",       "Put on Hold"),
        ("released",   "Hold Released"),
        ("reassigned", "Reassigned"),
        ("notified",   "Notification Sent"),
    ]

    RETURN_TO_CHOICES = [
        ("previous_step", "Previous Approver"),
        ("uploader",      "Document Uploader"),
        ("same_step",     "Same Approver"),
    ]

    id         = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    task       = models.ForeignKey(WorkflowTask, on_delete=models.CASCADE, related_name="actions")
    actor      = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        null=True,   # null for system-generated actions (e.g. notification auto-advance)
        blank=True,
        on_delete=models.PROTECT,
        related_name="task_actions",
    )
    action     = models.CharField(max_length=20, choices=ACTION_CHOICES)
    comment    = models.TextField(blank=True)
    # For hold: how many hours the hold was set for
    hold_hours = models.PositiveSmallIntegerField(null=True, blank=True)
    # Where the document was returned to (only populated for return actions)
    return_to  = models.CharField(
        max_length=20, choices=RETURN_TO_CHOICES, blank=True,
        help_text="Where the document was returned to",
    )
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["created_at"]

    def __str__(self):
        actor_label = self.actor.email if self.actor_id else "system"
        return f"{self.task} → {self.action} by {actor_label}"


class DocumentSignature(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    document = models.ForeignKey(
        "documents.Document", on_delete=models.CASCADE, related_name="signatures"
    )
    task = models.OneToOneField(
        WorkflowTask, on_delete=models.PROTECT, related_name="document_signature"
    )
    action = models.OneToOneField(
        WorkflowTaskAction, on_delete=models.PROTECT, related_name="document_signature"
    )
    signer = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.PROTECT, related_name="document_signatures"
    )
    source_signature = models.ForeignKey(
        "accounts.UserSignature", null=True, on_delete=models.SET_NULL, related_name="document_signatures"
    )
    signed_version = models.ForeignKey(
        "documents.DocumentVersion", null=True, on_delete=models.SET_NULL, related_name="signatures"
    )
    page_number = models.PositiveIntegerField(default=1)
    x = models.FloatField(default=0)
    y = models.FloatField(default=0)
    width = models.FloatField(default=180)
    height = models.FloatField(default=72)
    ip_address = models.GenericIPAddressField(null=True, blank=True)
    user_agent = models.TextField(blank=True)
    checksum = models.CharField(max_length=64, blank=True)
    signed_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["signed_at"]
        indexes = [
            models.Index(fields=["document", "signed_at"]),
            models.Index(fields=["signer", "signed_at"]),
        ]

    def __str__(self):
        return f"{self.document_id} signed by {self.signer_id}"


class WorkflowTaskActionNotification(models.Model):
    """
    Track which users were notified of a workflow action.
    Enables notification history and prevents duplicate notifications.
    """
    action = models.ForeignKey(
        WorkflowTaskAction, on_delete=models.CASCADE, related_name="notifications"
    )
    user   = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.CASCADE,
        related_name="workflow_action_notifications",
    )

    class Meta:
        unique_together = [("action", "user")]

    def __str__(self):
        return f"{self.action.id} → {self.user.email}"