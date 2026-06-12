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


class WorkflowService:

    # ── Rule / template resolution ─────────────────────────────────────────

    @staticmethod
    def _resolve_routing(document):
        """Pick the (rule, template) for a document by amount threshold.

        Currency handling: amounts in different currencies aren't comparable, so
        currency only acts as a discriminator when a document type actually has
        rules in more than one currency. For the common single-currency setup
        (every rule shares one currency), routing is purely amount-based — so a
        rule's currency that doesn't happen to match the document's (e.g. rules
        left at the default USD while documents are KES) no longer silently
        defeats threshold routing and forces the primary fallback.
        """
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
        # Only enforce currency when the type genuinely mixes currencies AND the
        # document declares one; otherwise match on amount alone.
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
            f"No workflow template is configured for document type "
            f"'{doc_type.name}'. "
            f"Go to Admin → Workflow Builder and assign a template."
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
    def approve(task: WorkflowTask, actor, comment: str = "", request=None, signature_placement=None) -> None:
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
            )

        AuditLog.objects.create(
            event=AuditEvent.WORKFLOW_APPROVED,
            actor=actor,
            object_type=doc.__class__.__name__,
            object_id=str(doc.pk),
            object_repr=str(doc)[:255],
            changes={"task_id": str(task.id), "action": action.action, "comment": action.comment},
        )

        # Notify stakeholders of approval
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

        # Notify stakeholders of rejection
        WorkflowService._notify_action(action, doc)
        
        WorkflowService._complete(instance, "rejected")

    # ── Return for review ──────────────────────────────────────────────────

    @staticmethod
    @transaction.atomic
    def return_for_review(
        task: WorkflowTask, actor, comment: str, return_to: str = "uploader"
    ) -> None:
        """
        Return the document for review with choice of destination.
        
        return_to choices:
        - 'previous_step': Return to the previous approver
        - 'uploader': Return to document uploader to resubmit (default)
        - 'same_step': Reassign to another user in the same step
        
        If current step order > 1 AND return_to='previous_step' → step back.
        Otherwise, keep the workflow active so resubmission resumes the current step.
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
            # Step back to previous approver
            prev_order = current_order - 1
            doc.status = f"Returned to Step {prev_order}"
            WorkflowService._save_document(doc, update_fields=["status", "updated_at"])

            instance.current_step_order = prev_order
            instance.save(update_fields=["current_step_order"])

            # Create a fresh task for the previous step
            WorkflowService._activate_step(instance, order=prev_order)

        else:
            # Return to uploader OR step 1 / uploader preference
            # Keep the workflow active so the uploader can resubmit at the current step.
            doc.status = DocumentStatus.RETURNED
            WorkflowService._save_document(doc, update_fields=["status", "updated_at"])

        # Notify uploader and document owner of the return
        WorkflowService._notify_action(action, doc)

    # ── Hold ───────────────────────────────────────────────────────────────

    @staticmethod
    @transaction.atomic
    def hold(task: WorkflowTask, actor, comment: str, hold_hours: int = None) -> None:
        """
        Place the task on hold until a scheduled expiry time.
        A warning and an automatic release are scheduled from held_until.
        """
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

        # Notify uploader
        WorkflowService._notify_action(action, doc)
        WorkflowService._schedule_hold_notifications(task)

    # ── Release hold ───────────────────────────────────────────────────────

    @staticmethod
    @transaction.atomic
    def release_hold(task: WorkflowTask, actor=None, *, auto: bool = False) -> None:
        """
        Release a held task back to in_progress.
        Approver must explicitly release when ready.
        """
        if task.status != "held":
            raise WorkflowError("This task is not currently on hold.")

        task.status     = "in_progress"
        task.held_until = None
        task.save(update_fields=["status", "held_until"])

        action = None
        if actor is not None:
            action = WorkflowTaskAction.objects.create(
                task=task, actor=actor, action="released",
                comment="Manually released from hold",
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

        # Restore document status to the step's label
        step = task.step
        doc  = task.workflow_instance.document
        WorkflowService._save_document(doc, update_fields=["status", "updated_at"])

        if action is not None:
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
                notify_task_assigned.delay(str(task.id))
                WorkflowService._schedule_task_sla_notifications(task)
        except Exception:
            pass

    @staticmethod
    def _resolve_assignees(step: WorkflowStep, document=None):
        if step.assignee_type == "specific_user":
            if not step.assignee_user_id:
                raise WorkflowError(f"Step '{step.name}' is missing its assigned user.")
            return [step.assignee_user]

        if step.assignee_type == "group_specific":
            if not step.assignee_group_id or not step.assignee_user_id:
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
        # A peer in a group step actioned it — clear the skipped members' stale
        # task notifications so they disappear from those members' trays too.
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
            if warning_at > timezone.now():
                notify_task_sla_warning.apply_async(args=[str(task.id)], eta=warning_at)
            notify_task_overdue.apply_async(args=[str(task.id)], eta=task.due_at)
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
            if warning_at > timezone.now():
                notify_hold_ending.apply_async(args=[str(task.id)], eta=warning_at)
            auto_release_hold.apply_async(args=[str(task.id)], eta=task.held_until)
        except Exception:
            pass

    @staticmethod
    def _embed_signature(document: Document, task: WorkflowTask, action: WorkflowTaskAction, actor, request=None, placement=None) -> None:
        from apps.documents.signing import embed_signature_into_document, SignatureError

        try:
            version, info = embed_signature_into_document(document, actor, placement)
        except SignatureError as exc:
            raise WorkflowError(str(exc)) from exc

        ip_address = request.META.get("REMOTE_ADDR") if request else None
        user_agent = request.META.get("HTTP_USER_AGENT", "")[:1000] if request else ""
        DocumentSignature.objects.create(
            document=document,
            task=task,
            action=action,
            signer=actor,
            source_signature=info["signature"],
            signed_version=version,
            page_number=info["page_number"],
            x=info["x"],
            y=info["y"],
            width=info["width"],
            height=info["height"],
            ip_address=ip_address,
            user_agent=user_agent,
            checksum=info["checksum"],
        )

        AuditLog.objects.create(
            event=AuditEvent.DOCUMENT_VERSION_UPLOADED,
            actor=actor,
            object_type=document.__class__.__name__,
            object_id=str(document.pk),
            object_repr=str(document)[:255],
            changes={
                "task_id": str(task.id),
                "signature_id": str(info["signature"].id),
                "version": version.version_number,
                "checksum": info["checksum"],
            },
            ip_address=ip_address,
            user_agent=user_agent,
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

        # Once a task is resolved (approved/rejected/returned), drop the actor's
        # now-stale "action required"/SLA notifications for this document so they
        # disappear from the tray. Done synchronously so the client's immediate
        # post-action refetch already reflects it.
        if action.action in ("approved", "rejected", "returned"):
            try:
                from apps.notifications.tasks import clear_resolved_task_notifications_now
                clear_resolved_task_notifications_now(str(action.task_id))
            except Exception:
                pass
