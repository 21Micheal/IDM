"""
apps/workflows/services.py

Rule resolution strategy (updated):
  1. Check DocumentType.workflow_template FK (set by the builder UI).
     If the document has no amount OR no WorkflowRule rows exist for
     the type, use this template directly as the catch-all.
  2. If WorkflowRule rows DO exist for this document type, apply
     amount-threshold routing on top: pick the highest matching threshold.
     This lets admins add "Board approval for invoices > $50k" without
     re-assigning the base template.

This reconciles the two architectures:
  - Builder sets DocumentType.workflow_template (one-to-one)
  - Rules table adds amount-tier escalation on top (optional)
"""
from django.db import transaction
from django.utils import timezone
from datetime import timedelta

from .models import (
    WorkflowInstance, WorkflowTask,
    WorkflowTemplate, WorkflowStep, WorkflowRule,
)
from apps.documents.models import DocumentStatus


class WorkflowError(Exception):
    """Domain rule violation — maps to HTTP 400 in views."""


class WorkflowService:

    # ── Rule resolution ────────────────────────────────────────────────────

    @staticmethod
    def resolve_template(document) -> WorkflowTemplate:
        """
        Return the WorkflowTemplate to use for this document.

        Priority:
          1. Amount-based WorkflowRule rows (if any exist for this type)
             → highest threshold whose amount <= document.amount wins
          2. DocumentType.workflow_template FK (set by builder UI)
          3. WorkflowError if neither is configured
        """
        doc_type = document.document_type
        amount   = document.amount or 0

        # Check for amount-tier rules first
        rules = (
            WorkflowRule.objects
            .filter(document_type=doc_type, is_active=True)
            .order_by("-amount_threshold")
            .select_related("template")
        )

        if rules.exists():
            for rule in rules:
                if amount >= rule.amount_threshold:
                    return rule.template
            # All thresholds above document amount — fall back to lowest
            return rules.last().template

        # No rules — use the direct FK set by the builder
        if doc_type.workflow_template and doc_type.workflow_template.is_active:
            return doc_type.workflow_template

        raise WorkflowError(
            f"No workflow template is configured for document type "
            f"'{doc_type.name}'. "
            f"Go to Admin → Workflow Builder and assign a template to this document type."
        )

    # ── Lifecycle ──────────────────────────────────────────────────────────

    @staticmethod
    @transaction.atomic
    def start(document, actor) -> WorkflowInstance:
        """Start a workflow. Idempotent — returns existing instance if already running."""
        existing = WorkflowInstance.objects.filter(
            document=document, status="in_progress"
        ).first()
        if existing:
            return existing

        template = WorkflowService.resolve_template(document)

        # Resolve matching rule (for record-keeping) if one exists
        rule = (
            WorkflowRule.objects
            .filter(document_type=document.document_type, is_active=True)
            .order_by("-amount_threshold")
            .filter(amount_threshold__lte=document.amount or 0)
            .first()
        )

        instance = WorkflowInstance.objects.create(
            document=document,
            template=template,
            rule=rule,          # may be None — that's fine
            started_by=actor,
            status="in_progress",
            current_step_order=1,
        )
        WorkflowService._activate_step(instance, order=1)
        return instance

    @staticmethod
    @transaction.atomic
    def approve(task: WorkflowTask, actor, comment: str = "") -> None:
        WorkflowService._assert_actionable(task, actor)

        task.status   = "approved"
        task.comment  = comment
        task.acted_at = timezone.now()
        task.save(update_fields=["status", "comment", "acted_at"])

        instance   = task.workflow_instance
        next_order = task.step.order + 1

        if instance.template.steps.filter(order=next_order).exists():
            WorkflowService._activate_step(instance, order=next_order)
        else:
            WorkflowService._complete(instance, "approved")

    @staticmethod
    @transaction.atomic
    def reject(task: WorkflowTask, actor, comment: str = "") -> None:
        WorkflowService._assert_actionable(task, actor)

        task.status   = "rejected"
        task.comment  = comment
        task.acted_at = timezone.now()
        task.save(update_fields=["status", "comment", "acted_at"])

        WorkflowService._complete(task.workflow_instance, "rejected")

    @staticmethod
    @transaction.atomic
    def cancel(instance: WorkflowInstance, actor) -> None:
        if instance.status != "in_progress":
            raise WorkflowError("Only in-progress workflows can be cancelled.")

        instance.tasks.filter(status="in_progress").update(
            status="skipped", acted_at=timezone.now()
        )
        instance.status       = "cancelled"
        instance.completed_at = timezone.now()
        instance.save(update_fields=["status", "completed_at"])

        doc        = instance.document
        doc.status = DocumentStatus.DRAFT
        doc.save(update_fields=["status", "updated_at"])

    # ── Internals ──────────────────────────────────────────────────────────

    @staticmethod
    def _activate_step(instance: WorkflowInstance, order: int) -> None:
        try:
            step = instance.template.steps.get(order=order)
        except WorkflowStep.DoesNotExist:
            WorkflowService._complete(instance, "approved")
            return

        assigned = WorkflowService._resolve_assignee(step)
        due      = (
            timezone.now() + timedelta(hours=step.sla_hours)
            if step.sla_hours else None
        )

        task = WorkflowTask.objects.create(
            workflow_instance=instance,
            step=step,
            assigned_to=assigned,
            status="in_progress",
            due_at=due,
        )

        doc        = instance.document
        doc.status = step.status_label   # e.g. "Pending Finance Review"
        doc.save(update_fields=["status", "updated_at"])

        instance.current_step_order = order
        instance.save(update_fields=["current_step_order"])

        try:
            from apps.notifications.tasks import notify_task_assigned
            notify_task_assigned.delay(str(task.id))
        except Exception:
            pass

    @staticmethod
    def _resolve_assignee(step: WorkflowStep):
        if step.assignee_type == "specific_user" and step.assignee_user_id:
            return step.assignee_user

        if step.assignee_type == "any_role" and step.assignee_role:
            from apps.accounts.models import User
            return (
                User.objects
                .filter(role=step.assignee_role, is_active=True)
                .order_by("?")   # random selection from pool
                .first()
            )
        return None

    @staticmethod
    def _assert_actionable(task: WorkflowTask, actor) -> None:
        if task.status != "in_progress":
            raise WorkflowError(
                f"This task is already '{task.get_status_display()}' "
                f"and cannot be actioned again."
            )

    @staticmethod
    def _complete(instance: WorkflowInstance, outcome: str) -> None:
        instance.status       = outcome
        instance.completed_at = timezone.now()
        instance.save(update_fields=["status", "completed_at"])

        doc        = instance.document
        doc.status = (
            DocumentStatus.APPROVED if outcome == "approved"
            else DocumentStatus.REJECTED
        )
        doc.save(update_fields=["status", "updated_at"])

        try:
            from apps.notifications.tasks import notify_workflow_complete
            notify_workflow_complete.delay(str(instance.id), outcome)
        except Exception:
            pass

    @staticmethod
    def get_overdue_tasks():
        return (
            WorkflowTask.objects
            .filter(status="in_progress", due_at__lt=timezone.now())
            .select_related("workflow_instance__document", "step", "assigned_to")
        )
