"""
apps/workflows/services.py

Changes in this version:
  - _activate_step now detects step_type == "notification":
      • Resolves the recipient (notify_user or notify_email).
      • Fires the configured notification email immediately via
        _send_notification_step_email() — a thin wrapper you wire into your
        existing email/notification infrastructure.
      • Creates a WorkflowTask with status="notified" (no human action needed).
      • Records a WorkflowTaskAction(action="notified", actor=None).
      • Auto-advances to the next step without waiting for any human.
  - _activate_step for approval steps now passes the step's custom email
    fields (approver_email_subject / approver_email_body) through to the
    notify_task_assigned Celery task so the notifications app can render them.

New methods:
  WorkflowService.return_for_review(task, actor, comment)
  WorkflowService.hold(task, actor, comment, hold_hours)
  WorkflowService.release_hold(task, actor, *, auto=False)
"""
import logging

from django.db import transaction
from django.db.models import Q
from django.utils import timezone
from django.conf import settings
from django.core.files.base import ContentFile
from datetime import timedelta
from random import choice
import hashlib
import mimetypes
import os

from .models import (
    WorkflowInstance, WorkflowTask, WorkflowTaskAction, DocumentSignature,
    WorkflowTemplate, WorkflowStep, WorkflowRule,
)
from apps.documents.models import Document, DocumentStatus, DocumentVersion
from apps.accounts.models import User
from apps.audit.models import AuditEvent, AuditLog
from apps.search.indexing import schedule_document_search_pipeline
from apps.search.utils import summarize_bulk_index_error
from elasticsearch.helpers import BulkIndexError

logger = logging.getLogger(__name__)


class WorkflowError(Exception):
    """Domain rule violation — maps to HTTP 400 in views."""


def _queue_after_commit(fn) -> None:
    """Run *fn* only after the current DB transaction commits (safe for Celery .delay)."""
    transaction.on_commit(fn)


class WorkflowService:

    # ── Rule / template resolution ─────────────────────────────────────────

    @staticmethod
    def _resolve_routing(document):
        """Pick the (rule, template) for a document by amount threshold."""
        doc_type = document.document_type
        amount   = document.amount or 0
        currency = (document.currency or "").upper()

        type_rules = WorkflowRule.objects.filter(
            document_type=doc_type,
            template__document_type=doc_type,
            is_active=True,
        )

        amount_q = Q(amount_min__lte=amount) & (
            Q(amount_max__isnull=True) | Q(amount_max__gte=amount)
        )

        rule_currencies = {
            (c or "").upper() for c in type_rules.values_list("currency", flat=True)
        }
        candidates = type_rules.filter(amount_q)
        if len(rule_currencies) > 1 and currency:
            candidates = candidates.filter(currency=currency)

        rule = (
            candidates
            .order_by("-amount_min", "amount_max")
            .select_related("template")
            .first()
        )
        if rule:
            return rule, rule.template

        primary = doc_type.workflow_template
        if (
            primary
            and primary.is_active
            and primary.document_type_id == doc_type.id
        ):
            return None, primary

        raise WorkflowError(
            f"This document can't be submitted yet — no approval workflow is set "
            f"up for the '{doc_type.name}' document type (no matching amount rule "
            f"and no fallback template). Ask an administrator to configure it in "
            f"the Workflow Builder."
        )

    @staticmethod
    def resolve_template(document) -> WorkflowTemplate:
        return WorkflowService._resolve_routing(document)[1]

    # ── Start ──────────────────────────────────────────────────────────────

    @staticmethod
    @transaction.atomic
    def start(document, actor) -> WorkflowInstance:
        existing = WorkflowInstance.objects.filter(
            document=document, status="in_progress"
        ).first()
        if existing:
            if not WorkflowService._has_active_step_tasks(existing, existing.current_step_order):
                WorkflowService._activate_step(existing, order=existing.current_step_order)
            return existing

        rule, template = WorkflowService._resolve_routing(document)

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
    def approve(task: WorkflowTask, actor, comment: str = "", request=None, signature_placement=None,
                items=None, use_new_signature: bool = False, signature_image=None) -> None:
        WorkflowService._assert_actionable(task)

        task.status   = "approved"
        task.comment  = comment
        task.acted_at = timezone.now()
        task.save(update_fields=["status", "comment", "acted_at"])

        action = WorkflowTaskAction.objects.create(task=task, actor=actor, action="approved", comment=comment)

        instance   = task.workflow_instance
        step       = task.step
        doc        = instance.document

        if step.requires_signature:
            WorkflowService._embed_signature(
                doc,
                task,
                action,
                actor,
                request=request,
                placement=signature_placement,
                items=items,
                use_new_signature=use_new_signature,
                signature_image=signature_image,
            )

        AuditLog.objects.create(
            event=AuditEvent.WORKFLOW_APPROVED,
            actor=actor,
            object_type=doc.__class__.__name__,
            object_id=str(doc.pk),
            object_repr=str(doc)[:255],
            changes={"task_id": str(task.id), "action": action.action, "comment": action.comment},
        )

        WorkflowService._notify_action(action, doc)

        if step.assignee_type == "group_all" and WorkflowService._has_active_step_tasks(instance, step.order):
            return

        WorkflowService._advance_step(instance, step.order)

    # ── Reject ─────────────────────────────────────────────────────────────

    @staticmethod
    @transaction.atomic
    def reject(task: WorkflowTask, actor, comment: str = "") -> None:
        WorkflowService._assert_actionable(task)

        task.status   = "rejected"
        task.comment  = comment
        task.acted_at = timezone.now()
        task.save(update_fields=["status", "comment", "acted_at"])

        action = WorkflowTaskAction.objects.create(task=task, actor=actor, action="rejected", comment=comment)

        instance = task.workflow_instance
        doc      = instance.document

        AuditLog.objects.create(
            event=AuditEvent.WORKFLOW_REJECTED,
            actor=actor,
            object_type=doc.__class__.__name__,
            object_id=str(doc.pk),
            object_repr=str(doc)[:255],
            changes={"task_id": str(task.id), "action": action.action, "comment": action.comment},
        )

        WorkflowService._notify_action(action, doc)
        WorkflowService._complete(instance, "rejected")

    # ── Return for review ──────────────────────────────────────────────────

    @staticmethod
    @transaction.atomic
    def return_for_review(
        task: WorkflowTask, actor, comment: str, return_to: str = "uploader"
    ) -> None:
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

        AuditLog.objects.create(
            event=AuditEvent.WORKFLOW_RETURNED,
            actor=actor,
            object_type=doc.__class__.__name__,
            object_id=str(doc.pk),
            object_repr=str(doc)[:255],
            changes={"task_id": str(task.id), "action": action.action, "comment": action.comment, "return_to": return_to},
        )

        WorkflowService._skip_active_tasks(instance, step_order=current_order)

        if return_to == "previous_step" and current_order > 1:
            prev_order = current_order - 1
            doc.status = f"Returned to Step {prev_order}"
            WorkflowService._save_document(doc, update_fields=["status", "updated_at"])

            instance.current_step_order = prev_order
            instance.save(update_fields=["current_step_order"])

            WorkflowService._activate_step(instance, order=prev_order)

        else:
            doc.status = DocumentStatus.RETURNED
            WorkflowService._save_document(doc, update_fields=["status", "updated_at"])

        WorkflowService._notify_action(action, doc)

    # ── Hold ───────────────────────────────────────────────────────────────

    @staticmethod
    @transaction.atomic
    def hold(task: WorkflowTask, actor, comment: str, hold_hours: int = None) -> None:
        WorkflowService._assert_actionable(task)

        held_until = timezone.now() + timedelta(hours=hold_hours or 24)

        task.status     = "held"
        task.comment    = comment
        task.held_until = held_until
        task.acted_at   = timezone.now()
        task.save(update_fields=["status", "comment", "held_until", "acted_at"])

        action = WorkflowTaskAction.objects.create(
            task=task, actor=actor, action="held",
            comment=comment, hold_hours=hold_hours,
        )

        doc        = task.workflow_instance.document
        doc.status = "On Hold"
        WorkflowService._save_document(doc, update_fields=["status", "updated_at"])

        AuditLog.objects.create(
            event=AuditEvent.WORKFLOW_HELD,
            actor=actor,
            object_type=doc.__class__.__name__,
            object_id=str(doc.pk),
            object_repr=str(doc)[:255],
            changes={"task_id": str(task.id), "action": action.action, "comment": action.comment, "hold_hours": hold_hours},
        )

        WorkflowService._notify_action(action, doc)
        WorkflowService._schedule_hold_notifications(task)

    # ── Release hold ───────────────────────────────────────────────────────

    @staticmethod
    @transaction.atomic
    def release_hold(task: WorkflowTask, actor=None, *, auto: bool = False) -> None:
        if task.status != "held":
            raise WorkflowError("This task is not currently on hold.")

        task.status     = "in_progress"
        task.held_until = None
        task.save(update_fields=["status", "held_until"])

        action = WorkflowTaskAction.objects.create(
            task=task,
            actor=actor,
            action="released",
            comment="Automatically released from hold" if auto else "Manually released from hold",
        )

        AuditLog.objects.create(
            event=AuditEvent.WORKFLOW_RELEASED,
            actor=actor,
            object_type=task.workflow_instance.document.__class__.__name__,
            object_id=str(task.workflow_instance.document.pk),
            object_repr=str(task.workflow_instance.document)[:255],
            changes={
                "task_id": str(task.id),
                "action": "released",
                "comment": "Automatically released from hold" if auto else "Manually released from hold",
            },
        )

        step = task.step
        doc  = task.workflow_instance.document
        WorkflowService._save_document(doc, update_fields=["status", "updated_at"])

        WorkflowService._notify_action(action, doc)

    # ── Cancel ─────────────────────────────────────────────────────────────

    @staticmethod
    @transaction.atomic
    def cancel(instance: WorkflowInstance, actor) -> None:
        if instance.status != "in_progress":
            raise WorkflowError("Only in-progress workflows can be cancelled.")

        WorkflowService._skip_active_tasks(instance)
        instance.status       = "cancelled"
        instance.completed_at = timezone.now()
        instance.save(update_fields=["status", "completed_at"])

        doc        = instance.document
        doc.status = DocumentStatus.DRAFT
        WorkflowService._save_document(doc, update_fields=["status", "updated_at"])
        AuditLog.objects.create(
            event=AuditEvent.WORKFLOW_CANCELLED,
            actor=actor,
            object_type=doc.__class__.__name__,
            object_id=str(doc.pk),
            object_repr=str(doc)[:255],
            changes={"workflow_instance_id": str(instance.id)},
        )

    # ── Internals ──────────────────────────────────────────────────────────

    @staticmethod
    def _activate_step(instance: WorkflowInstance, order: int) -> None:
        try:
            step = instance.template.steps.get(order=order)
        except WorkflowStep.DoesNotExist:
            WorkflowService._complete(instance, "approved")
            return

        # ── Notification step: fire-and-forget, then immediately advance ──────
        if step.step_type == "notification":
            WorkflowService._execute_notification_step(instance, step, order)
            return

        # ── Approval step: create tasks and wait for human action ─────────────
        due      = (
            timezone.now() + timedelta(hours=step.sla_hours)
            if step.sla_hours else None
        )

        assignees = WorkflowService._resolve_assignees(step, instance.document)
        tasks = []
        for assigned in assignees:
            tasks.append(
                WorkflowTask.objects.create(
                    workflow_instance=instance,
                    step=step,
                    assigned_to=assigned,
                    status="in_progress",
                    due_at=due,
                )
            )

        doc        = instance.document
        doc.status = step.status_label
        WorkflowService._save_document(doc, update_fields=["status", "updated_at"])

        instance.current_step_order = order
        instance.save(update_fields=["current_step_order"])

        try:
            from apps.notifications.tasks import notify_task_assigned
            for task in tasks:
                task_id = str(task.id)
                custom_subject = step.approver_email_subject or None
                custom_body = step.approver_email_body or None
                _queue_after_commit(
                    lambda tid=task_id, cs=custom_subject, cb=custom_body: notify_task_assigned.delay(
                        tid, custom_subject=cs, custom_body=cb,
                    )
                )
                WorkflowService._schedule_task_sla_notifications(task)
        except Exception:
            pass

    @staticmethod
    @transaction.atomic
    def _execute_notification_step(instance: WorkflowInstance, step: WorkflowStep, order: int) -> None:
        """
        Handle a notification step:
          1. Update document status to step.status_label.
          2. Create a WorkflowTask with status="notified" (no human needed).
          3. Log a WorkflowTaskAction(action="notified", actor=None).
          4. Send the configured email to the recipient.
          5. Auto-advance to the next step.
        """
        doc        = instance.document
        doc.status = step.status_label
        WorkflowService._save_document(doc, update_fields=["status", "updated_at"])

        instance.current_step_order = order
        instance.save(update_fields=["current_step_order"])

        # Create a task record for auditability
        task = WorkflowTask.objects.create(
            workflow_instance=instance,
            step=step,
            assigned_to=None,
            status="notified",
            acted_at=timezone.now(),
        )

        WorkflowTaskAction.objects.create(
            task=task,
            actor=None,
            action="notified",
            comment="Notification step auto-executed by workflow engine.",
        )

        AuditLog.objects.create(
            event=AuditEvent.WORKFLOW_APPROVED,   # reuse closest event; no dedicated NOTIFIED event yet
            actor=None,
            object_type=doc.__class__.__name__,
            object_id=str(doc.pk),
            object_repr=str(doc)[:255],
            changes={
                "step": step.name,
                "step_type": "notification",
                "recipient_user": str(step.notify_user_id) if step.notify_user_id else None,
                "recipient_email": step.notify_email or None,
            },
        )

        # Fire the notification email asynchronously
        WorkflowService._send_notification_step_email(step, doc)

        # Immediately advance — notification steps never block
        WorkflowService._advance_step(instance, order)

    @staticmethod
    def _send_notification_step_email(step: WorkflowStep, document) -> None:
        """
        Dispatch the notification-step email via Celery.

        The notifications app receives:
          - recipient_user_id (str|None)
          - recipient_email   (str|None)
          - subject           (str)
          - message           (str)
          - document_id       (str)

        Wire this to your existing email/notification infrastructure.
        The notification task should resolve the recipient's email from the user
        if recipient_user_id is set, otherwise use recipient_email directly.
        """
        try:
            from apps.notifications.tasks import send_workflow_notification_step_email
            recipient_user_id = str(step.notify_user_id) if step.notify_user_id else None
            recipient_email = step.notify_email or None
            subject = step.notification_subject
            message = step.notification_message
            document_id = str(document.pk)
            step_name = step.name
            _queue_after_commit(
                lambda: send_workflow_notification_step_email.delay(
                    recipient_user_id=recipient_user_id,
                    recipient_email=recipient_email,
                    subject=subject,
                    message=message,
                    document_id=document_id,
                    step_name=step_name,
                )
            )
        except Exception:
            logger.exception(
                "Failed to dispatch notification-step email for step '%s' on document %s",
                step.name,
                document.pk,
            )

    @staticmethod
    def _resolve_assignees(step: WorkflowStep, document=None):
        if step.assignee_type == "specific_user":
            if not step.assignee_user_id:
                raise WorkflowError(f"Step '{step.name}' is missing its assigned user.")
            return [step.assignee_user]

        if step.assignee_type == "group_specific":
            if not step.assignee_group_id:
                raise WorkflowError(f"Step '{step.name}' is missing its assigned group.")
            if step.assignee_user_auto:
                head = step.assignee_group.head
                if not head:
                    raise WorkflowError(
                        f"Group '{step.assignee_group.name}' has no designated approver set."
                    )
                if not head.is_active:
                    raise WorkflowError(
                        f"Designated approver for group '{step.assignee_group.name}' is not active."
                    )
                if not WorkflowService._is_active_group_member(step.assignee_group, head):
                    raise WorkflowError(
                        f"Designated approver is not an active member of group '{step.assignee_group.name}'."
                    )
                return [head]
            if not step.assignee_user_id:
                raise WorkflowError(f"Step '{step.name}' is missing its assigned group member.")
            if not WorkflowService._is_active_group_member(step.assignee_group, step.assignee_user):
                raise WorkflowError(
                    f"Selected user is not an active member of group '{step.assignee_group.name}'."
                )
            return [step.assignee_user]

        if step.assignee_group and step.assignee_group.is_hod_group:
            department = (
                getattr(document, "department", None)
                or getattr(getattr(document, "uploaded_by", None), "department", None)
            )
            if not department:
                raise WorkflowError(
                    f"Step '{step.name}' requires a department head, but no department was found."
                )
            if not department.head_id:
                raise WorkflowError(
                    f"Department '{department.name}' has no head configured."
                )
            if not department.head.is_active:
                raise WorkflowError(
                    f"Department '{department.name}' head is not active."
                )
            if not WorkflowService._is_active_group_member(
                step.assignee_group,
                department.head,
            ):
                raise WorkflowError(
                    f"Department '{department.name}' head is not an active member of the HOD group."
                )
            return [department.head]

        if step.assignee_type == "group_any":
            members = WorkflowService._active_group_members(step.assignee_group)
            if not members:
                raise WorkflowError(
                    f"Group '{step.assignee_group.name if step.assignee_group else step.name}' has no active members."
                )
            return [choice(members)]

        if step.assignee_type == "group_all":
            members = WorkflowService._active_group_members(step.assignee_group)
            if not members:
                raise WorkflowError(
                    f"Group '{step.assignee_group.name if step.assignee_group else step.name}' has no active members."
                )
            return members

        raise WorkflowError(f"Unsupported assignee type: {step.assignee_type}")

    @staticmethod
    def _assert_actionable(task: WorkflowTask) -> None:
        if task.status not in ("in_progress", "held"):
            raise WorkflowError(
                f"This task is '{task.get_status_display()}' and cannot be actioned."
            )

    @staticmethod
    def _save_document(document: Document, update_fields=None) -> None:
        try:
            document.save(update_fields=update_fields)
        except BulkIndexError as exc:
            logger.warning(
                "Workflow document save succeeded but realtime indexing failed for %s: %s",
                document.id,
                summarize_bulk_index_error(exc),
            )
            try:
                schedule_document_search_pipeline(
                    str(document.id),
                    reextract_content=False,
                    index_immediately=True,
                )
            except Exception:
                logger.exception(
                    "Failed to queue async reindex for document %s after workflow save error",
                    document.id,
                )

    @staticmethod
    def _has_active_step_tasks(instance: WorkflowInstance, order: int) -> bool:
        return instance.tasks.filter(
            step__order=order,
            status__in=["in_progress", "held"],
        ).exists()

    @staticmethod
    def _skip_active_tasks(instance: WorkflowInstance, step_order: int | None = None) -> None:
        qs = instance.tasks.filter(status__in=["in_progress", "held"])
        if step_order is not None:
            qs = qs.filter(step__order=step_order)
        skipped_ids = list(qs.values_list("id", flat=True))
        qs.update(status="skipped", acted_at=timezone.now())
        if skipped_ids:
            try:
                from apps.notifications.tasks import clear_resolved_task_notifications_now
                for tid in skipped_ids:
                    clear_resolved_task_notifications_now(str(tid))
            except Exception:
                pass

    @staticmethod
    def _advance_step(instance: WorkflowInstance, order: int) -> None:
        WorkflowService._skip_active_tasks(instance, step_order=order)
        next_order = order + 1
        if instance.template.steps.filter(order=next_order).exists():
            WorkflowService._activate_step(instance, order=next_order)
        else:
            WorkflowService._complete(instance, "approved")

    @staticmethod
    def _active_group_members(group):
        if not group:
            return []

        now = timezone.now()
        return list(
            User.objects.filter(
                is_active=True,
                group_memberships__group=group,
            ).filter(
                Q(group_memberships__expires_at__isnull=True)
                | Q(group_memberships__expires_at__gt=now)
            ).distinct().order_by("email")
        )

    @staticmethod
    def _is_active_group_member(group, user):
        if not group or not user:
            return False
        now = timezone.now()
        return User.objects.filter(
            id=user.id,
            is_active=True,
            group_memberships__group=group,
        ).filter(
            Q(group_memberships__expires_at__isnull=True) |
            Q(group_memberships__expires_at__gt=now)
        ).exists()

    @staticmethod
    def _complete(instance: WorkflowInstance, outcome: str) -> None:
        WorkflowService._skip_active_tasks(instance)
        instance.status       = outcome
        instance.completed_at = timezone.now()
        instance.save(update_fields=["status", "completed_at"])

        from apps.documents.access import outcome_status_for

        doc = instance.document
        doc.status = outcome_status_for(doc.document_type, outcome)
        WorkflowService._save_document(doc, update_fields=["status", "updated_at"])

        try:
            from apps.notifications.tasks import notify_workflow_complete
            instance_id = str(instance.id)
            _queue_after_commit(
                lambda iid=instance_id, oc=outcome: notify_workflow_complete.delay(iid, oc)
            )
        except Exception:
            pass

        WorkflowService._maybe_post_sunsystems_journal(doc, outcome)

    @staticmethod
    def _maybe_post_sunsystems_journal(document, outcome: str) -> None:
        """Post the form's journal to SunSystems when an approval lands.

        Only fires for documents whose snapshotted mapping enables journal
        posting and whose configured trigger matches this outcome (default
        "approved"). The post runs after commit and is idempotent — the
        JournalPosting row guards against double-posting if completion is ever
        re-entered.
        """
        try:
            from apps.sunsystems.config import journal_posting_enabled, post_trigger
            if not journal_posting_enabled(document):
                return
            if post_trigger(document) != outcome:
                return
            from apps.sunsystems.tasks import post_journal_for_document
            doc_id = str(document.pk)
            _queue_after_commit(lambda did=doc_id: post_journal_for_document.delay(did))
        except Exception:
            logger.exception("Failed to enqueue SunSystems journal posting for %s", getattr(document, "pk", "?"))

    @staticmethod
    def get_overdue_tasks():
        return (
            WorkflowTask.objects
            .filter(status="in_progress", due_at__lt=timezone.now())
            .select_related("workflow_instance__document", "step", "assigned_to")
        )

    @staticmethod
    def get_sla_warning_tasks():
        warning_hours = getattr(settings, "WORKFLOW_SLA_WARNING_HOURS", 4)
        window_end = timezone.now() + timedelta(hours=warning_hours)
        return (
            WorkflowTask.objects
            .filter(status="in_progress", due_at__gt=timezone.now(), due_at__lte=window_end)
            .select_related("workflow_instance__document", "step", "assigned_to")
        )

    @staticmethod
    def get_hold_ending_tasks():
        warning_hours = getattr(settings, "WORKFLOW_HOLD_WARNING_HOURS", 2)
        window_end = timezone.now() + timedelta(hours=warning_hours)
        return (
            WorkflowTask.objects
            .filter(status="held", held_until__gt=timezone.now(), held_until__lte=window_end)
            .select_related("workflow_instance__document", "step", "assigned_to")
        )

    @staticmethod
    def _schedule_task_sla_notifications(task: WorkflowTask) -> None:
        if not task.due_at:
            return
        try:
            from apps.notifications.tasks import notify_task_sla_warning, notify_task_overdue

            warning_hours = getattr(settings, "WORKFLOW_SLA_WARNING_HOURS", 4)
            warning_at = task.due_at - timedelta(hours=warning_hours)
            task_id = str(task.id)
            if warning_at > timezone.now():
                _queue_after_commit(
                    lambda tid=task_id, eta=warning_at: notify_task_sla_warning.apply_async(
                        args=[tid], eta=eta,
                    )
                )
            _queue_after_commit(
                lambda tid=task_id, eta=task.due_at: notify_task_overdue.apply_async(
                    args=[tid], eta=eta,
                )
            )
        except Exception:
            pass

    @staticmethod
    def _schedule_hold_notifications(task: WorkflowTask) -> None:
        if not task.held_until:
            return
        try:
            from apps.notifications.tasks import notify_hold_ending
            from apps.workflows.tasks import auto_release_hold

            warning_hours = getattr(settings, "WORKFLOW_HOLD_WARNING_HOURS", 2)
            warning_at = task.held_until - timedelta(hours=warning_hours)
            task_id = str(task.id)
            if warning_at > timezone.now():
                _queue_after_commit(
                    lambda tid=task_id, eta=warning_at: notify_hold_ending.apply_async(
                        args=[tid], eta=eta,
                    )
                )
            _queue_after_commit(
                lambda tid=task_id, eta=task.held_until: auto_release_hold.apply_async(
                    args=[tid], eta=eta,
                )
            )
        except Exception:
            pass

    @staticmethod
    def _embed_signature(document: Document, task: WorkflowTask, action: WorkflowTaskAction, actor, request=None,
                         placement=None, items=None, use_new_signature: bool = False, signature_image=None) -> None:
        from apps.documents.signing import (
            embed_signature_into_document,
            embed_signing_items_into_document,
            SignatureError,
        )

        try:
            if items:
                # Sejda-style multi-item signing (shared with signature requests).
                version, info = embed_signing_items_into_document(
                    document, actor, items,
                    use_new_signature=use_new_signature,
                    signature_image=signature_image,
                )
                # Audit row keeps the primary signature item's placement; the
                # signed PDF itself carries every stamped item.
                placed = info.get("items") or []
                primary = next((i for i in placed if i.get("kind") == "signature"), placed[0] if placed else {})
                page_number = int(primary.get("page_number", 1) or 1)
                x = float(primary.get("x_percent", 0) or 0)
                y = float(primary.get("y_percent", 0) or 0)
                width = float(primary.get("width_percent", 0) or 0)
                height = float(primary.get("height_percent", 0) or 0)
                source_signature = info.get("signature")
                checksum = info.get("checksum", "")
            else:
                # Legacy single saved-signature placement.
                version, info = embed_signature_into_document(document, actor, placement)
                page_number = info["page_number"]
                x, y = info["x"], info["y"]
                width, height = info["width"], info["height"]
                source_signature = info["signature"]
                checksum = info["checksum"]
        except SignatureError as exc:
            raise WorkflowError(str(exc)) from exc

        ip_address = request.META.get("REMOTE_ADDR") if request else None
        user_agent = request.META.get("HTTP_USER_AGENT", "")[:1000] if request else ""
        DocumentSignature.objects.create(
            document=document,
            task=task,
            action=action,
            signer=actor,
            source_signature=source_signature,
            signed_version=version,
            page_number=page_number,
            x=x,
            y=y,
            width=width,
            height=height,
            ip_address=ip_address,
            user_agent=user_agent,
            checksum=checksum,
        )

        AuditLog.objects.create(
            event=AuditEvent.DOCUMENT_VERSION_UPLOADED,
            actor=actor,
            object_type=document.__class__.__name__,
            object_id=str(document.pk),
            object_repr=str(document)[:255],
            changes={
                "task_id": str(task.id),
                "signature_id": str(source_signature.id) if source_signature else None,
                "version": version.version_number,
                "checksum": checksum,
            },
            ip_address=ip_address,
            user_agent=user_agent,
        )

    # ── Notifications ──────────────────────────────────────────────────────

    @staticmethod
    def _notify_action(action: WorkflowTaskAction, document) -> None:
        from apps.workflows.models import WorkflowTaskActionNotification
        from django.contrib.auth import get_user_model

        User = get_user_model()

        template = action.task.workflow_instance.template
        if action.action == "approved" and not template.notify_uploader_on_approval:
            try:
                from apps.notifications.tasks import clear_resolved_task_notifications_now
                clear_resolved_task_notifications_now(str(action.task_id))
            except Exception:
                pass
            return

        uploader = document.uploaded_by if hasattr(document, "uploaded_by") else None
        notify_users = set()

        if uploader:
            notify_users.add(uploader)

        for user in notify_users:
            try:
                WorkflowTaskActionNotification.objects.get_or_create(
                    action=action, user=user
                )
            except Exception:
                pass

        try:
            from apps.notifications.tasks import notify_workflow_action
            action_id = str(action.id)
            user_id_list = [str(u.id) for u in notify_users]
            _queue_after_commit(
                lambda aid=action_id, uids=user_id_list: notify_workflow_action.delay(aid, uids)
            )
        except Exception:
            pass

        if action.action in ("approved", "rejected", "returned"):
            try:
                from apps.notifications.tasks import clear_resolved_task_notifications_now
                clear_resolved_task_notifications_now(str(action.task_id))
            except Exception:
                pass