"""
apps/workflows/models.py

Additions to existing model file:
  1. WorkflowTask gains:
       status choices: "held", "returned"
       held_until: DateTimeField (null) — auto-release timestamp
  2. WorkflowTaskAction — immutable record of every action taken on a task
     (approve, reject, hold, return). Replaces the single comment field for
     a full audit trail of task actions.

MIGRATION NOTE: run 0003_task_hold_return after applying this file.
"""
from django.db import models
from django.conf import settings
import uuid


class WorkflowTemplate(models.Model):
    id          = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    name        = models.CharField(max_length=120, unique=True)
    description = models.TextField(blank=True)
    is_active   = models.BooleanField(default=True)
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


class WorkflowStep(models.Model):
    ASSIGNEE_TYPES = [
        ("group_any",      "Any member of group"),
        ("group_all",      "All members of group"),
        ("group_specific", "Specific member of group"),
    ]

    id            = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    template      = models.ForeignKey(
        WorkflowTemplate, on_delete=models.CASCADE, related_name="steps"
    )
    order         = models.PositiveSmallIntegerField(db_index=True)
    name          = models.CharField(max_length=120)
    status_label  = models.CharField(max_length=80, default="Pending Approval")
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
    sla_hours      = models.PositiveSmallIntegerField(default=48)
    allow_resubmit = models.BooleanField(default=True)
    allow_approve  = models.BooleanField(default=True, help_text="Approver can approve at this step")
    allow_reject   = models.BooleanField(default=True, help_text="Approver can reject at this step")
    allow_return   = models.BooleanField(default=True, help_text="Approver can send back for review at this step")
    instructions   = models.TextField(blank=True)
    created_at     = models.DateTimeField(auto_now_add=True, null=True)
    updated_at     = models.DateTimeField(auto_now=True)

    class Meta:
        ordering        = ["order"]
        unique_together = [("template", "order")]

    def __str__(self):
        return f"{self.template.name} → {self.order}. {self.name}"


class WorkflowRule(models.Model):
    id               = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    document_type    = models.ForeignKey(
        "documents.DocumentType", on_delete=models.CASCADE, related_name="workflow_rules",
    )
    template         = models.ForeignKey(
        WorkflowTemplate, on_delete=models.PROTECT, related_name="rules"
    )
    amount_threshold = models.DecimalField(max_digits=18, decimal_places=2, default=0)
    currency         = models.CharField(max_length=3, default="USD")
    label            = models.CharField(max_length=120, blank=True)
    is_active        = models.BooleanField(default=True)
    created_at       = models.DateTimeField(auto_now_add=True, null=True)
    updated_at       = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["document_type", "-amount_threshold"]

    def __str__(self):
        return f"{self.document_type.name} >= {self.amount_threshold} -> {self.template.name}"


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
        ("returned",    "Returned for Review"),   # ← new
        ("held",        "On Hold"),               # ← new
        ("skipped",     "Skipped"),
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

    def __str__(self):
        return f"Task: {self.step.name} [{self.status}]"


class WorkflowTaskAction(models.Model):
    """
    Immutable audit log of every action taken on a WorkflowTask.
    Separate from WorkflowTask.comment (which stores the latest comment only)
    so the full action history is always preserved.
    """
    ACTION_CHOICES = [
        ("approved",  "Approved"),
        ("rejected",  "Rejected"),
        ("returned",  "Returned for Review"),
        ("held",      "Put on Hold"),
        ("released",  "Hold Released"),
        ("reassigned","Reassigned"),
    ]
    
    RETURN_TO_CHOICES = [
        ("previous_step", "Previous Approver"),
        ("uploader",      "Document Uploader"),
        ("same_step",     "Same Approver"),
    ]

    id         = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    task       = models.ForeignKey(WorkflowTask, on_delete=models.CASCADE, related_name="actions")
    actor      = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.PROTECT, related_name="task_actions"
    )
    action     = models.CharField(max_length=20, choices=ACTION_CHOICES)
    comment    = models.TextField(blank=True)
    # For hold: how many hours the hold was set for (removed auto-release)
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
        return f"{self.task} → {self.action} by {self.actor.email}"


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