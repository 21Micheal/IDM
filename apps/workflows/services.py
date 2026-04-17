"""
apps/workflows/services.py

New methods:
  WorkflowService.return_for_review(task, actor, comment)
    - Marks task as "returned"
    - If step.order > 1 → creates a new task for the previous step
    - If step.order == 1 → cancels the instance, document goes back to "draft"
      and the uploader must resubmit (which starts fresh from step 1)
    - Fires notify_document_returned

  WorkflowService.hold(task, actor, comment, hold_hours)
    - Marks task as "held", stores held_until datetime
    - Document status → "On Hold"
    - Schedules release_hold Celery task at held_until
    - Fires notify_document_held

  WorkflowService.release_hold(task, actor, *, auto=False)
    - Restores task to "in_progress"
    - Document status → step.status_label
    - Fires notify_hold_released (unless auto=True, which is silent)
"""
from django.db import transaction
from django.utils import timezone
from datetime import timedelta

from .models import (
    WorkflowInstance, WorkflowTask, WorkflowTaskAction,
    WorkflowTemplate, WorkflowStep, WorkflowRule,
)
from apps.documents.models import DocumentStatus


class WorkflowError(Exception):
    """Domain rule violation — maps to HTTP 400 in views."""


class WorkflowService:

    # ── Rule / template resolution ─────────────────────────────────────────

    @staticmethod
    def resolve_template(document) -> WorkflowTemplate:
        doc_type = document.document_type
        amount   = document.amount or 0

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
            return rules.last().template

        if doc_type.workflow_template and doc_type.workflow_template.is_active:
            return doc_type.workflow_template

        raise WorkflowError(
            f"No workflow template is configured for document type "
            f"'{doc_type.name}'. "
            f"Go to Admin → Workflow Builder and assign a template."
        )

    # ── Start ──────────────────────────────────────────────────────────────

    @staticmethod
    @transaction.atomic
    def start(document, actor) -> WorkflowInstance:
        existing = WorkflowInstance.objects.filter(
            document=document, status="in_progress"
        ).first()
        if existing:
            return existing

        template = WorkflowService.resolve_template(document)
        rule     = (
            WorkflowRule.objects
            .filter(document_type=document.document_type, is_active=True)
            .order_by("-amount_threshold")
            .filter(amount_threshold__lte=document.amount or 0)
            .first()
        )

        instance = WorkflowInstance.objects.create(
            document=document,
            template=template,
            rule=rule,
            started_by=actor,
            status="in_progress",
            current_step_order=1,
        )
        WorkflowService._activate_step(instance, order=1)
        return instance

    # ── Approve ────────────────────────────────────────────────────────────

    @staticmethod
    @transaction.atomic
    def approve(task: WorkflowTask, actor, comment: str = "") -> None:
        WorkflowService._assert_actionable(task)

        task.status   = "approved"
        task.comment  = comment
        task.acted_at = timezone.now()
        task.save(update_fields=["status", "comment", "acted_at"])

        WorkflowTaskAction.objects.create(task=task, actor=actor, action="approved", comment=comment)

        instance   = task.workflow_instance
        next_order = task.step.order + 1

        if instance.template.steps.filter(order=next_order).exists():
            WorkflowService._activate_step(instance, order=next_order)
        else:
            WorkflowService._complete(instance, "approved")

    # ── Reject ─────────────────────────────────────────────────────────────

    @staticmethod
    @transaction.atomic
    def reject(task: WorkflowTask, actor, comment: str = "") -> None:
        WorkflowService._assert_actionable(task)

        task.status   = "rejected"
        task.comment  = comment
        task.acted_at = timezone.now()
        task.save(update_fields=["status", "comment", "acted_at"])

        WorkflowTaskAction.objects.create(task=task, actor=actor, action="rejected", comment=comment)
        WorkflowService._complete(task.workflow_instance, "rejected")

    # ── Return for review ──────────────────────────────────────────────────

    @staticmethod
    @transaction.atomic
    def return_for_review(
        task: WorkflowTask, actor, comment: str, return_to: str = "previous_step"
    ) -> None:
        """
        Return the document for review with choice of destination.
        
        return_to choices:
        - 'previous_step': Return to the previous approver (default)
        - 'uploader': Return to document uploader to resubmit
        - 'same_step': Reassign to another user in the same step
        
        If current step order > 1 AND return_to='previous_step' → step back.
        If step order == 1 OR return_to='uploader' → cancel workflow; document returns to DRAFT.
        """
        WorkflowService._assert_actionable(task)
        if not comment.strip():
            raise WorkflowError("A comment explaining what needs fixing is required.")

        if return_to not in ["previous_step", "uploader", "same_step"]:
            raise WorkflowError(f"Invalid return_to value: {return_to}")

        task.status     = "returned"
        task.comment    = comment
        task.return_to  = return_to
        task.acted_at   = timezone.now()
        task.save(update_fields=["status", "comment", "return_to", "acted_at"])

        action = WorkflowTaskAction.objects.create(
            task=task, actor=actor, action="returned", comment=comment, return_to=return_to
        )

        instance       = task.workflow_instance
        current_order  = task.step.order
        doc            = instance.document

        if return_to == "previous_step" and current_order > 1:
            # Step back to previous approver
            prev_order = current_order - 1
            doc.status = f"Returned to Step {prev_order}"
            doc.save(update_fields=["status", "updated_at"])

            instance.current_step_order = prev_order
            instance.save(update_fields=["current_step_order"])

            # Create a fresh task for the previous step
            WorkflowService._activate_step(instance, order=prev_order)

        else:
            # Return to uploader OR at step 1 with previous_step option
            # Either way, cancel the workflow so uploader can fix and resubmit
            instance.status       = "cancelled"
            instance.completed_at = timezone.now()
            instance.save(update_fields=["status", "completed_at"])

            doc.status = "Returned for Review"
            doc.save(update_fields=["status", "updated_at"])

        # Notify uploader and document owner of the return
        WorkflowService._notify_action(action, doc)

    # ── Hold ───────────────────────────────────────────────────────────────

    @staticmethod
    @transaction.atomic
    def hold(task: WorkflowTask, actor, comment: str, hold_hours: int = None) -> None:
        """
        Place the task on hold indefinitely.
        Approver must manually release it when ready.
        hold_hours parameter is ignored (kept for API compatibility).
        """
        WorkflowService._assert_actionable(task)

        # Note: No auto-release. Approver decides when to release.
        task.status     = "held"
        task.comment    = comment
        task.held_until = timezone.now()  # Mark when it was put on hold
        task.acted_at   = timezone.now()
        task.save(update_fields=["status", "comment", "held_until", "acted_at"])

        action = WorkflowTaskAction.objects.create(
            task=task, actor=actor, action="held",
            comment=comment, hold_hours=hold_hours,
        )

        doc        = task.workflow_instance.document
        doc.status = "On Hold"
        doc.save(update_fields=["status", "updated_at"])

        # Notify uploader
        WorkflowService._notify_action(action, doc)

    # ── Release hold ───────────────────────────────────────────────────────

    @staticmethod
    @transaction.atomic
    def release_hold(task: WorkflowTask, actor) -> None:
        """
        Release a held task back to in_progress.
        Approver must explicitly release when ready.
        """
        if task.status != "held":
            raise WorkflowError("This task is not currently on hold.")

        task.status     = "in_progress"
        task.held_until = None
        task.save(update_fields=["status", "held_until"])

        action = WorkflowTaskAction.objects.create(
            task=task, actor=actor, action="released",
            comment="Manually released from hold",
        )

        # Restore document status to the step's label
        step = task.step
        doc  = task.workflow_instance.document
        doc.status = step.status_label
        doc.save(update_fields=["status", "updated_at"])

        # Notify uploader
        WorkflowService._notify_action(action, doc)

    # ── Cancel ─────────────────────────────────────────────────────────────

    @staticmethod
    @transaction.atomic
    def cancel(instance: WorkflowInstance, actor) -> None:
        if instance.status != "in_progress":
            raise WorkflowError("Only in-progress workflows can be cancelled.")

        instance.tasks.filter(status__in=["in_progress", "held"]).update(
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
        doc.status = step.status_label
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
                .order_by("?")
                .first()
            )
        return None

    @staticmethod
    def _assert_actionable(task: WorkflowTask) -> None:
        if task.status not in ("in_progress", "held"):
            raise WorkflowError(
                f"This task is '{task.get_status_display()}' and cannot be actioned."
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

    # ── Notifications ──────────────────────────────────────────────────────

    @staticmethod
    def _notify_action(action: WorkflowTaskAction, document) -> None:
        """
        Notify the uploader and document owner of a workflow action.
        Tracks notifications to avoid duplicates.
        """
        from apps.workflows.models import WorkflowTaskActionNotification
        from django.contrib.auth import get_user_model

        User = get_user_model()

        # Get the uploader and create a set of users to notify
        uploader = document.created_by if hasattr(document, 'created_by') else None
        notify_users = set()

        if uploader:
            notify_users.add(uploader)

        # Also notify the approver if the action is not from them
        if action.actor and action.actor != uploader:
            # Could add notification back to actor for confirmation, optional
            pass

        # Create notification records for each user
        for user in notify_users:
            try:
                WorkflowTaskActionNotification.objects.get_or_create(
                    action=action, user=user
                )
            except Exception:
                pass

        # Trigger async notification task
        try:
            from apps.notifications.tasks import notify_workflow_action
            notify_workflow_action.delay(str(action.id), [str(u.id) for u in notify_users])
        except Exception:
            pass
