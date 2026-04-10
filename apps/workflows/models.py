"""
workflows/models.py
Approval workflow engine. Each DocumentType has a WorkflowTemplate
composed of ordered WorkflowSteps. When a document is submitted,
a WorkflowInstance is created with one WorkflowTask per step.
"""
from django.db import models
from django.conf import settings
import uuid


class WorkflowTemplate(models.Model):
    """Reusable workflow blueprint assigned to document types."""
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    name = models.CharField(max_length=120, unique=True)
    description = models.TextField(blank=True)
    is_active = models.BooleanField(default=True)
    created_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, null=True, on_delete=models.SET_NULL
    )
    created_at = models.DateTimeField(auto_now_add=True)

    def __str__(self):
        return self.name


class WorkflowStep(models.Model):
    """A single approval step within a workflow template."""

    APPROVER_TYPE_CHOICES = [
        ("user", "Specific User"),
        ("role", "Any User with Role"),
        ("department_head", "Department Head"),
    ]

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    template = models.ForeignKey(
        WorkflowTemplate, on_delete=models.CASCADE, related_name="steps"
    )
    name = models.CharField(max_length=120)
    order = models.PositiveSmallIntegerField()
    approver_type = models.CharField(max_length=30, choices=APPROVER_TYPE_CHOICES, default="role")
    approver_role = models.CharField(max_length=20, blank=True)    # Role.FINANCE etc.
    approver_user = models.ForeignKey(
        settings.AUTH_USER_MODEL, null=True, blank=True,
        on_delete=models.SET_NULL, related_name="assigned_workflow_steps"
    )
    # SLA hours until escalation
    sla_hours = models.PositiveSmallIntegerField(default=48)
    # If rejected at this step, can sender resubmit?
    allow_resubmit = models.BooleanField(default=True)

    class Meta:
        ordering = ["order"]
        unique_together = [("template", "order")]

    def __str__(self):
        return f"{self.template.name} → Step {self.order}: {self.name}"


class WorkflowInstance(models.Model):
    """A live workflow run tied to a specific document."""

    STATUS_CHOICES = [
        ("in_progress", "In Progress"),
        ("approved", "Approved"),
        ("rejected", "Rejected"),
        ("cancelled", "Cancelled"),
    ]

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    document = models.OneToOneField(
        "documents.Document", on_delete=models.CASCADE, related_name="workflow_instance"
    )
    template = models.ForeignKey(WorkflowTemplate, on_delete=models.PROTECT)
    status = models.CharField(max_length=20, choices=STATUS_CHOICES, default="in_progress")
    current_step_order = models.PositiveSmallIntegerField(default=1)
    started_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.PROTECT, related_name="started_workflows"
    )
    started_at = models.DateTimeField(auto_now_add=True)
    completed_at = models.DateTimeField(null=True, blank=True)

    def __str__(self):
        return f"Workflow for {self.document.reference_number} [{self.status}]"


class WorkflowTask(models.Model):
    """An individual approval task within a workflow run."""

    STATUS_CHOICES = [
        ("pending", "Pending"),
        ("in_progress", "In Progress"),
        ("approved", "Approved"),
        ("rejected", "Rejected"),
        ("skipped", "Skipped"),
    ]

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    workflow_instance = models.ForeignKey(
        WorkflowInstance, on_delete=models.CASCADE, related_name="tasks"
    )
    step = models.ForeignKey(WorkflowStep, on_delete=models.PROTECT)
    assigned_to = models.ForeignKey(
        settings.AUTH_USER_MODEL, null=True, blank=True,
        on_delete=models.SET_NULL, related_name="workflow_tasks"
    )
    status = models.CharField(max_length=20, choices=STATUS_CHOICES, default="pending")
    comment = models.TextField(blank=True)
    due_at = models.DateTimeField(null=True, blank=True)
    acted_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        ordering = ["step__order"]

    def __str__(self):
        return f"Task: {self.step.name} [{self.status}]"
