"""
apps/workflows/models.py

WorkflowTemplate  — reusable blueprint
WorkflowStep      — ordered steps, each with assignee config + status label
WorkflowRule      — amount-based routing: ties DocumentType + threshold to template
WorkflowInstance  — live run for a specific document
WorkflowTask      — individual approval task per step per instance
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
        ("any_role",      "Any user with role"),
        ("specific_user", "Specific user"),
    ]
    ROLE_CHOICES = [
        ("admin",   "Administrator"),
        ("finance", "Finance Staff"),
        ("auditor", "Auditor"),
        ("viewer",  "Viewer"),
    ]

    id            = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    template      = models.ForeignKey(
        WorkflowTemplate, on_delete=models.CASCADE, related_name="steps"
    )
    order         = models.PositiveSmallIntegerField(db_index=True)
    name          = models.CharField(max_length=120)
    # Document status while waiting for this step
    status_label  = models.CharField(max_length=80, default="Pending Approval")
    assignee_type = models.CharField(max_length=20, choices=ASSIGNEE_TYPES, default="any_role")
    assignee_role = models.CharField(max_length=20, blank=True)
    assignee_user = models.ForeignKey(
        settings.AUTH_USER_MODEL, null=True, blank=True,
        on_delete=models.SET_NULL, related_name="assigned_steps",
    )
    sla_hours      = models.PositiveSmallIntegerField(default=48)
    allow_resubmit = models.BooleanField(default=True)
    instructions   = models.TextField(blank=True)
    created_at     = models.DateTimeField(auto_now_add=True, null=True)
    updated_at     = models.DateTimeField(auto_now=True)

    class Meta:
        ordering        = ["order"]
        unique_together = [("template", "order")]

    def __str__(self):
        return f"{self.template.name} → {self.order}. {self.name}"


class WorkflowRule(models.Model):
    """
    Amount-based routing rule.
    The engine selects the rule with the HIGHEST amount_threshold
    that is <= the document's amount. threshold=0 is the catch-all.

    Example — Supplier Invoice:
      threshold=0     → Standard Approval (always matches)
      threshold=10000 → Senior Approval   (matches when amount >= 10000)
      threshold=50000 → Board Approval    (matches when amount >= 50000)
    """
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
        # Highest threshold first so first match wins in the engine
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
        ("skipped",     "Skipped"),
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
    acted_at = models.DateTimeField(null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True, null=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["step__order"]

    def __str__(self):
        return f"Task: {self.step.name} [{self.status}]"
