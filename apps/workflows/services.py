"""
apps/workflows/services.py

Changes from uploaded version
─────────────────────────────
_resolve_assignee: replaced order_by("workflow_tasks__status") with a
proper annotation-based load balancer.  The previous sort ordered users
alphabetically by the status string ("approved" < "in_progress" < …),
not by active task count — so the "least loaded" heuristic was broken.

The new query annotates each eligible user with their count of currently
in_progress tasks and picks whoever has the fewest.  Ties are broken by
pk (stable, deterministic).

Everything else is identical to the uploaded version.
"""
from django.db import transaction
from django.db.models import Count, Q
from django.utils import timezone
from datetime import timedelta

from .models import (
    WorkflowInstance, WorkflowTask,
    WorkflowTemplate, WorkflowStep, WorkflowRule,
)
from apps.documents.models import DocumentStatus


class WorkflowError(Exception):
    """Raised for domain rule violations; maps to HTTP 400 in views."""


class WorkflowService:

    # ── Rule resolution ────────────────────────────────────────────────────

    @staticmethod
    def resolve_rule(document) -> WorkflowRule:
        """
        Select the best WorkflowRule for a document.

        Rules for the document type are sorted highest-threshold-first.
        The first rule whose amount_threshold ≤ document.amount wins.
        A threshold=0 rule is the catch-all (always matches).

        Raises WorkflowError if no active rule exists.
        """
        amount = document.amount or 0
        rules = (
            WorkflowRule.objects
            .filter(document_type=document.document_type, is_active=True)
            .order_by("-amount_threshold")
            .select_related("template")
        )

        if not rules.exists():
            raise WorkflowError(
                f"No active workflow rules are configured for document type "
                f"'{document.document_type.name}'. "
                f"Ask an administrator to set up routing rules under Workflows → Rules."
            )

        for rule in rules:
            if amount >= rule.amount_threshold:
                return rule

        # All rules have thresholds above the document amount and none is 0.
        # Fall back to the lowest-threshold rule rather than refusing silently.
        return rules.last()

    # ── Lifecycle ──────────────────────────────────────────────────────────

    @staticmethod
    @transaction.atomic
    def start(document, actor) -> WorkflowInstance:
        """
        Start a workflow for `document` submitted by `actor`.
        Idempotent: returns the existing in-progress instance if one exists.
        """
        existing = WorkflowInstance.objects.filter(
            document=document, status="in_progress"
        ).first()
        if existing:
            return existing

        rule = WorkflowService.resolve_rule(document)

        instance = WorkflowInstance.objects.create(
            document=document,
            template=rule.template,
            rule=rule,
            started_by=actor,
            status="in_progress",
            current_step_order=1,
        )
        WorkflowService._activate_step(instance, order=1)
        return instance

    @staticmethod
    @transaction.atomic
    def approve(task: WorkflowTask, actor, comment: str = "") -> None:
        """Approve `task`. Advances to next step or completes the workflow."""
        WorkflowService._assert_actionable(task, actor)

        task.status   = "approved"
        task.comment  = comment
        task.acted_at = timezone.now()
        task.save(update_fields=["status", "comment", "acted_at", "updated_at"])

        instance   = task.workflow_instance
        next_order = task.step.order + 1

        if instance.template.steps.filter(order=next_order).exists():
            WorkflowService._activate_step(instance, order=next_order)
        else:
            WorkflowService._complete(instance, "approved")

    @staticmethod
    @transaction.atomic
    def reject(task: WorkflowTask, actor, comment: str = "") -> None:
        """
        Reject `task`, immediately terminating the workflow.
        A non-empty comment is enforced at the view layer.
        """
        WorkflowService._assert_actionable(task, actor)

        task.status   = "rejected"
        task.comment  = comment
        task.acted_at = timezone.now()
        task.save(update_fields=["status", "comment", "acted_at", "updated_at"])

        WorkflowService._complete(task.workflow_instance, "rejected")

    @staticmethod
    @transaction.atomic
    def cancel(instance: WorkflowInstance, actor) -> None:
        """Cancel an in-progress workflow. Document reverts to DRAFT."""
        if instance.status != "in_progress":
            raise WorkflowError("Only in-progress workflows can be cancelled.")

        # Mark any open tasks as skipped.
        # Note: bulk update() bypasses auto_now fields; acted_at is the
        # meaningful timestamp here so that's acceptable.
        instance.tasks.filter(status="in_progress").update(
            status="skipped", acted_at=timezone.now()
        )

        instance.status       = "cancelled"
        instance.completed_at = timezone.now()
        instance.save(update_fields=["status", "completed_at", "updated_at"])

        doc        = instance.document
        doc.status = DocumentStatus.DRAFT
        doc.save(update_fields=["status", "updated_at"])

    # ── Internal helpers ───────────────────────────────────────────────────

    @staticmethod
    def _activate_step(instance: WorkflowInstance, order: int) -> None:
        """
        Create and activate the WorkflowTask for the given step order.
        Updates document.status to the step's status_label.
        """
        try:
            step = instance.template.steps.get(order=order)
        except WorkflowStep.DoesNotExist:
            WorkflowService._complete(instance, "approved")
            return

        assigned = WorkflowService._resolve_assignee(step)
        due = (
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
        doc.status = step.status_label          # free-text label, CharField(max_length=100) ✓
        doc.save(update_fields=["status", "updated_at"])

        instance.current_step_order = order
        instance.save(update_fields=["current_step_order", "updated_at"])

        try:
            from apps.notifications.tasks import notify_task_assigned
            notify_task_assigned.delay(str(task.id))
        except Exception:
            pass  # Notification failure must never block document submission

    @staticmethod
    def _resolve_assignee(step: WorkflowStep):
        """
        Return the User who should receive the task, or None (open pool).

        Load balancing: pick the active user with the fewest currently
        in_progress workflow tasks.  Ties broken deterministically by pk.
        Previously used order_by("workflow_tasks__status") which sorted
        alphabetically by status string — not a meaningful load metric.
        """
        if step.assignee_type == "specific_user" and step.assignee_user_id:
            return step.assignee_user

        if step.assignee_type == "any_role" and step.assignee_role:
            from apps.accounts.models import User
            return (
                User.objects
                .filter(role=step.assignee_role, is_active=True)
                .annotate(
                    active_task_count=Count(
                        "workflow_tasks",
                        filter=Q(workflow_tasks__status="in_progress"),
                    )
                )
                .order_by("active_task_count", "pk")   # least loaded, stable tie-break
                .first()
            )

        return None

    @staticmethod
    def _assert_actionable(task: WorkflowTask, actor) -> None:
        """Raise WorkflowError if the task cannot be acted upon."""
        if task.status != "in_progress":
            raise WorkflowError(
                f"This task is already '{task.get_status_display()}' "
                f"and cannot be actioned again."
            )

    @staticmethod
    def _complete(instance: WorkflowInstance, outcome: str) -> None:
        """Mark the workflow instance and its document as finished."""
        instance.status       = outcome
        instance.completed_at = timezone.now()
        instance.save(update_fields=["status", "completed_at", "updated_at"])

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

    # ── Utility ────────────────────────────────────────────────────────────

    @staticmethod
    def get_overdue_tasks():
        """
        Return QuerySet of in-progress tasks that have passed their SLA.
        Used by the Celery beat escalation task.
        """
        return (
            WorkflowTask.objects
            .filter(status="in_progress", due_at__lt=timezone.now())
            .select_related(
                "workflow_instance__document",
                "step",
                "assigned_to",
            )
        )