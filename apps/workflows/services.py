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
  - Added support for v2 branched workflow definitions:
      • is_v2_workflow() checks if a template uses the new branched workflow format
      • build_evaluation_context() builds the context for evaluating workflow conditions
      • When definition is present, the workflow engine will follow it instead of legacy rules

New methods:
  WorkflowService.return_for_review(task, actor, comment)
  WorkflowService.hold(task, actor, comment, hold_hours)
  WorkflowService.release_hold(task, actor, *, auto=False)
  WorkflowService.is_v2_workflow(template)
  WorkflowService.build_evaluation_context(document, payment_run)
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
    def _document_workflow_phase(document):
        # Delegate to the canonical phase-inference helper which handles
        # procurement forms (defaults to "requisition" when no explicit phase
        # is written into metadata), retirement detection, and the general
        # "request" case.  Using this avoids the previous gap where a plain
        # metadata.form.workflow_phase read fell back to DEFAULT_PHASE="request"
        # even for procurement documents, causing routing rules stored under
        # phase="requisition" to be skipped.
        try:
            from apps.documents.builder_workflow import (
                infer_builder_workflow_phase,
                is_built_form_document,
            )
            if is_built_form_document(document):
                inferred = infer_builder_workflow_phase(document)
                if inferred:
                    return inferred
        except Exception:
            pass
        # Fallback for non-builder documents: read from metadata directly
        metadata = document.metadata if isinstance(document.metadata, dict) else {}
        form = metadata.get("form") if isinstance(metadata.get("form"), dict) else None
        if form:
            phase = form.get("workflow_phase") or metadata.get("workflow_phase")
            if phase:
                return str(phase).strip().lower()
        return WorkflowRule.DEFAULT_PHASE

    @staticmethod
    def _resolve_routing(document):
        """Pick the (rule, template) for a document by builder phase and amount threshold."""
        doc_type = document.document_type
        currency = (document.currency or "").upper()
        phase = WorkflowService._document_workflow_phase(document)

        # Check if the primary template uses v2 branched workflow
        # If so, skip legacy rule-based routing entirely
        primary = doc_type.workflow_template
        if (
            primary
            and primary.is_active
            and primary.target_type == "document"
            and primary.document_type_id == doc_type.id
            and WorkflowService.is_v2_workflow(primary)
        ):
            # V2 workflow: routing is inside the definition, no legacy rules needed
            return None, primary

        # Use document.amount when set; otherwise try to derive it from form values.
        # Builder-form requisitions never populate document.amount directly — the
        # total lives inside metadata.form.values as computed fields (e.g.
        # "total_gross_copy", "total_net_price_*").  Scan those fields and take the
        # largest numeric value whose key contains a common total-related keyword.
        amount = document.amount
        if not amount:
            try:
                form_values = (
                    ((document.metadata or {}).get("form") or {}).get("values") or {}
                )
                AMOUNT_KEYWORDS = ("total", "amount", "gross", "net", "cost", "price", "sum")
                candidates = []
                for key, val in form_values.items():
                    key_lower = key.lower()
                    if any(kw in key_lower for kw in AMOUNT_KEYWORDS):
                        try:
                            candidates.append(float(val))
                        except (TypeError, ValueError):
                            pass
                if candidates:
                    amount = max(candidates)
            except Exception:
                pass
        amount = amount or 0

        base_rules = WorkflowRule.objects.filter(
            target_type="document",
            document_type=doc_type,
            template__target_type="document",
            template__document_type=doc_type,
            is_active=True,
        )
        phase_rules = base_rules.filter(phase=phase)
        if phase != WorkflowRule.DEFAULT_PHASE and not phase_rules.exists():
            phase_rules = base_rules.filter(phase=WorkflowRule.DEFAULT_PHASE)

        amount_q = Q(amount_min__lte=amount) & (
            Q(amount_max__isnull=True) | Q(amount_max__gte=amount)
        )

        rule_currencies = {
            (c or "").upper() for c in phase_rules.values_list("currency", flat=True)
        }
        candidates = phase_rules.filter(amount_q)
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

        if (
            primary
            and primary.is_active
            and primary.target_type == "document"
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
    def _resolve_payment_run_routing(payment_run):
        amount = payment_run.total_amount or 0
        currencies = payment_run.currency_codes if isinstance(payment_run.currency_codes, list) else []
        currency = (currencies[0] if len(currencies) == 1 else "").upper()
        phase = "payment_run"

        # Check if there's a v2 workflow template for payment runs
        template = (
            WorkflowTemplate.objects
            .filter(target_type="payment_run", is_active=True)
            .order_by("name")
            .first()
        )
        
        if template and WorkflowService.is_v2_workflow(template):
            # V2 workflow: routing is inside the definition
            return None, template

        base_rules = WorkflowRule.objects.filter(
            target_type="payment_run",
            document_type__isnull=True,
            template__target_type="payment_run",
            is_active=True,
        )
        phase_rules = base_rules.filter(phase=phase)
        if not phase_rules.exists():
            phase_rules = base_rules.filter(phase=WorkflowRule.DEFAULT_PHASE)

        amount_q = Q(amount_min__lte=amount) & (
            Q(amount_max__isnull=True) | Q(amount_max__gte=amount)
        )

        rule_currencies = {
            (c or "").upper() for c in phase_rules.values_list("currency", flat=True)
        }
        candidates = phase_rules.filter(amount_q)
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

        if template:
            return None, template

        raise WorkflowError(
            "This payment run can't be submitted yet because no payment-run "
            "approval workflow is configured in the Workflow Builder."
        )

    @staticmethod
    def resolve_template(document) -> WorkflowTemplate:
        return WorkflowService._resolve_routing(document)[1]

    # ── V2 Workflow Support ──────────────────────────────────────────────────

    @staticmethod
    def is_v2_workflow(template: WorkflowTemplate) -> bool:
        """Check if a template uses the v2 branched workflow definition."""
        return bool(template.definition and template.definition.get("version") == 2)

    @staticmethod
    def build_evaluation_context(document=None, payment_run=None) -> dict:
        """
        Build the evaluation context for workflow conditions.
        
        This context provides all the fields that conditions can reference:
        - Document metadata (title, amount, currency, etc.)
        - System fields (phase, uploader info, etc.)
        - Form field values (extracted from document metadata)
        
        Args:
            document: Optional Document instance
            payment_run: Optional PaymentRun instance
        
        Returns:
            Dict with field_id -> value mappings
        """
        context = {}
        
        if document:
            # Document-level fields
            context["document.title"] = document.title or ""
            context["document.created_at"] = document.created_at.isoformat() if document.created_at else ""
            
            # Amount with currency
            if document.amount:
                context["amount"] = {
                    "amount": float(document.amount),
                    "currency": document.currency or "USD",
                }
            else:
                context["amount"] = None
            
            # Uploader information
            if document.uploaded_by:
                uploader = document.uploaded_by
                context["uploader.department"] = (
                    uploader.department.name if uploader.department else ""
                )
                now = timezone.now()
                context["uploader.groups"] = list(
                    uploader.group_memberships.filter(
                        group__is_active=True,
                    ).filter(
                        Q(expires_at__isnull=True) | Q(expires_at__gt=now)
                    ).values_list("group_id", flat=True)
                )
            else:
                context["uploader.department"] = ""
                context["uploader.groups"] = []
            
            # Workflow phase
            try:
                from apps.documents.builder_workflow import infer_builder_workflow_phase, is_built_form_document
                if is_built_form_document(document):
                    phase = infer_builder_workflow_phase(document)
                    if phase:
                        context["context.phase"] = phase
            except Exception:
                pass
            
            # Fallback to metadata for phase
            if "context.phase" not in context:
                metadata = document.metadata if isinstance(document.metadata, dict) else {}
                form = metadata.get("form") if isinstance(metadata.get("form"), dict) else None
                if form:
                    phase = form.get("workflow_phase") or metadata.get("workflow_phase")
                    if phase:
                        context["context.phase"] = str(phase).strip().lower()
            
            # Extract form field values
            metadata = document.metadata if isinstance(document.metadata, dict) else {}
            form_values = metadata.get("form", {}).get("values") or {}
            if isinstance(form_values, dict):
                for field_id, value in form_values.items():
                    context[field_id] = value
        
        elif payment_run:
            # Payment run fields
            context["payment_run.line_count"] = len(payment_run.lines) if payment_run.lines else 0
            context["payment_run.total"] = {
                "amount": float(payment_run.total_amount) if payment_run.total_amount else 0,
                "currency": payment_run.currency_codes[0] if payment_run.currency_codes else "USD",
            }
            context["context.phase"] = "payment_run"
            
            if payment_run.submitted_by:
                uploader = payment_run.submitted_by
                context["uploader.department"] = (
                    uploader.department.name if uploader.department else ""
                )
                now = timezone.now()
                context["uploader.groups"] = list(
                    uploader.group_memberships.filter(
                        group__is_active=True,
                    ).filter(
                        Q(expires_at__isnull=True) | Q(expires_at__gt=now)
                    ).values_list("group_id", flat=True)
                )
            else:
                context["uploader.department"] = ""
                context["uploader.groups"] = []
        
        return context

    # ── Start ──────────────────────────────────────────────────────────────

    @staticmethod
    @transaction.atomic
    def start(document, actor) -> WorkflowInstance:
        existing = WorkflowInstance.objects.filter(
            document=document, status="in_progress"
        ).first()
        if existing:
            if not WorkflowService._has_active_step_tasks(existing, existing.current_step_order):
                # Use v2 activation if applicable
                if WorkflowService.is_v2_workflow(existing.template):
                    WorkflowService._activate_v2_step(existing)
                else:
                    WorkflowService._activate_step(existing, order=existing.current_step_order)
            return existing

        rule, template = WorkflowService._resolve_routing(document)
        phase = WorkflowService._document_workflow_phase(document)
        reusable = None
        if phase != WorkflowRule.DEFAULT_PHASE:
            reusable = (
                WorkflowInstance.objects
                .filter(document=document)
                .exclude(status="in_progress")
                .order_by("-started_at")
                .first()
            )
        if reusable:
            reusable.template = template
            reusable.rule = rule
            reusable.started_by = actor
            reusable.status = "in_progress"
            reusable.current_step_order = 1
            reusable.completed_at = None
            reusable.save(update_fields=[
                "template", "rule", "started_by", "status",
                "current_step_order", "completed_at", "updated_at",
            ])
            # Use v2 activation if applicable
            if WorkflowService.is_v2_workflow(reusable.template):
                WorkflowService._activate_v2_step(reusable)
            else:
                WorkflowService._activate_step(reusable, order=1)
            return reusable

        instance = WorkflowInstance.objects.create(
            document=document,
            target_type="document",
            template=template,
            rule=rule,
            started_by=actor,
            status="in_progress",
            current_step_order=1,
        )
        # Use v2 activation if applicable
        if WorkflowService.is_v2_workflow(instance.template):
            WorkflowService._activate_v2_step(instance)
        else:
            WorkflowService._activate_step(instance, order=1)
        return instance

    @staticmethod
    @transaction.atomic
    def start_payment_run(payment_run, actor) -> WorkflowInstance:
        existing = WorkflowInstance.objects.filter(
            payment_run=payment_run, status="in_progress"
        ).first()
        if existing:
            if not WorkflowService._has_active_step_tasks(existing, existing.current_step_order):
                # Use v2 activation if applicable
                if WorkflowService.is_v2_workflow(existing.template):
                    WorkflowService._activate_v2_step(existing)
                else:
                    WorkflowService._activate_step(existing, order=existing.current_step_order)
            return existing

        rule, template = WorkflowService._resolve_payment_run_routing(payment_run)
        instance = WorkflowInstance.objects.create(
            target_type="payment_run",
            payment_run=payment_run,
            template=template,
            rule=rule,
            started_by=actor,
            status="in_progress",
            current_step_order=1,
        )
        # Use v2 activation if applicable
        if WorkflowService.is_v2_workflow(instance.template):
            WorkflowService._activate_v2_step(instance)
        else:
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

        if step.requires_signature and doc is None:
            raise WorkflowError("Payment run workflow steps cannot require document signatures.")

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

        # Handle audit log and notifications for both documents and payment runs
        if doc is not None:
            AuditLog.objects.create(
                event=AuditEvent.WORKFLOW_APPROVED,
                actor=actor,
                object_type=doc.__class__.__name__,
                object_id=str(doc.pk),
                object_repr=str(doc)[:255],
                changes={"task_id": str(task.id), "action": action.action, "comment": action.comment},
            )
            WorkflowService._notify_action(action, doc)
        elif instance.payment_run:
            AuditLog.objects.create(
                event=AuditEvent.WORKFLOW_APPROVED,
                actor=actor,
                object_type="PaymentRun",
                object_id=str(instance.payment_run.pk),
                object_repr=str(instance.payment_run.payment_reference)[:255],
                changes={"task_id": str(task.id), "action": action.action, "comment": action.comment},
            )
            # Payment runs also need action notifications
            WorkflowService._notify_action(action, None)

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

        # Handle audit log and notifications for both documents and payment runs
        if doc is not None:
            AuditLog.objects.create(
                event=AuditEvent.WORKFLOW_REJECTED,
                actor=actor,
                object_type=doc.__class__.__name__,
                object_id=str(doc.pk),
                object_repr=str(doc)[:255],
                changes={"task_id": str(task.id), "action": action.action, "comment": action.comment},
            )
            WorkflowService._notify_action(action, doc)
        elif instance.payment_run:
            AuditLog.objects.create(
                event=AuditEvent.WORKFLOW_REJECTED,
                actor=actor,
                object_type="PaymentRun",
                object_id=str(instance.payment_run.pk),
                object_repr=str(instance.payment_run.payment_reference)[:255],
                changes={"task_id": str(task.id), "action": action.action, "comment": action.comment},
            )
            WorkflowService._notify_action(action, None)

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

        if return_to == "previous_step" and task.step.order <= 1:
            raise WorkflowError("There is no previous step to return to.")

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

        # Payment runs cannot be returned - treat as rejection
        if doc is None:
            if instance.payment_run:
                AuditLog.objects.create(
                    event=AuditEvent.WORKFLOW_REJECTED,
                    actor=actor,
                    object_type="PaymentRun",
                    object_id=str(instance.payment_run.pk),
                    object_repr=str(instance.payment_run.payment_reference)[:255],
                    changes={"task_id": str(task.id), "action": action.action, "comment": action.comment, "return_to": return_to},
                )
                WorkflowService._notify_action(action, None)
            WorkflowService._complete(instance, "rejected")
            return

        AuditLog.objects.create(
            event=AuditEvent.WORKFLOW_RETURNED,
            actor=actor,
            object_type=doc.__class__.__name__,
            object_id=str(doc.pk),
            object_repr=str(doc)[:255],
            changes={"task_id": str(task.id), "action": action.action, "comment": action.comment, "return_to": return_to},
        )

        WorkflowService._skip_active_tasks(instance, step_order=current_order)

        # Both destinations pause the instance and keep current_step_order so
        # resubmission resumes THIS step instead of restarting from step 1.
        # return_to only controls who is notified / recorded on the action.
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
        if doc is not None:
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
        elif task.workflow_instance.payment_run:
            AuditLog.objects.create(
                event=AuditEvent.WORKFLOW_HELD,
                actor=actor,
                object_type="PaymentRun",
                object_id=str(task.workflow_instance.payment_run.pk),
                object_repr=str(task.workflow_instance.payment_run.payment_reference)[:255],
                changes={"task_id": str(task.id), "action": action.action, "comment": action.comment, "hold_hours": hold_hours},
            )
            WorkflowService._notify_action(action, None)

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
            object_type=task.workflow_instance.document.__class__.__name__ if task.workflow_instance.document else "PaymentRun",
            object_id=str(task.workflow_instance.document.pk) if task.workflow_instance.document else str(task.workflow_instance.payment_run_id),
            object_repr=str(task.workflow_instance.document)[:255] if task.workflow_instance.document else str(task.workflow_instance.payment_run),
            changes={
                "task_id": str(task.id),
                "action": "released",
                "comment": "Automatically released from hold" if auto else "Manually released from hold",
            },
        )

        doc  = task.workflow_instance.document
        if doc is not None:
            WorkflowService._save_document(doc, update_fields=["status", "updated_at"])
            WorkflowService._notify_action(action, doc)
        elif task.workflow_instance.payment_run:
            WorkflowService._notify_action(action, None)

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
        if doc is None:
            if instance.payment_run_id:
                from apps.sunsystems.models import PaymentRunStatus
                run = instance.payment_run
                run.status = PaymentRunStatus.FAILED
                run.error = "Payment run approval workflow was cancelled."
                run.save(update_fields=["status", "error", "updated_at"])
            return
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
    def _v2_active_step_orders(instance: WorkflowInstance):
        """Return ``(orders, end_outcome)`` for the v2 branch this instance is on.

        ``orders`` are ``WorkflowStep.order`` values (1-based positions in the
        flat mirror) for the approval/notification steps on the branch selected
        by the evaluation context — e.g. the ``requisition`` case of a switch on
        ``context.phase``.  Non-matching branches are skipped, so a fresh
        requisition no longer starts at whatever case happened to be flattened
        first (the bug that made new requisitions jump into LPO).
        """
        from apps.workflows.engine import (
            build_field_map_from_document_type,
            resolve_active_path,
        )

        definition = instance.template.definition or {}
        document = instance.document
        payment_run = instance.payment_run
        context = WorkflowService.build_evaluation_context(
            document=document, payment_run=payment_run
        )
        document_type = document.document_type if document is not None else None
        field_map = (
            build_field_map_from_document_type(document_type)
            if document_type is not None else {}
        )
        return resolve_active_path(definition, field_map, context)

    @staticmethod
    def _activate_v2_step(instance: WorkflowInstance) -> None:
        """Activate the first/next step on the branch of a v2 definition.

        The definition decides which branch is live (switch on ``context.phase``
        for procurement, if/else for other forms).  The flat ``WorkflowStep``
        mirror just supplies the task/step rows, so activation resolves the
        branch once and picks the matching order instead of trusting
        ``current_step_order`` blindly.
        """
        orders, end_outcome = WorkflowService._v2_active_step_orders(instance)
        if not orders:
            WorkflowService._complete(instance, end_outcome or "approved")
            return

        order = instance.current_step_order
        if order not in orders:
            order = orders[0]
            instance.current_step_order = order
            instance.save(update_fields=["current_step_order"])
        WorkflowService._activate_step(instance, order)

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

        doc = instance.document
        if doc is not None:
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
                # Schedule SLA notifications for both documents and payment runs
                WorkflowService._schedule_task_sla_notifications(task)
        except Exception:
            pass

    @staticmethod
    def _execute_notification_step(instance: WorkflowInstance, step: WorkflowStep, order: int) -> None:
        """
        Handle a notification step (informational blast to people outside the
        approval chain). Does not replace per-stage action/completion notifies:
          1. Update document status to step.status_label (if document exists).
          2. Create a WorkflowTask with status="notified" (no human needed).
          3. Log a WorkflowTaskAction(action="notified", actor=None).
          4. Send the configured email body only (no login/document links).
          5. Auto-advance to the next step.
        """
        doc = instance.document
        if doc is not None:
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

        # Handle audit log for both documents and payment runs
        if doc is not None:
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
        elif instance.payment_run:
            AuditLog.objects.create(
                event=AuditEvent.WORKFLOW_APPROVED,   # reuse closest event; no dedicated NOTIFIED event yet
                actor=None,
                object_type="PaymentRun",
                object_id=str(instance.payment_run.pk),
                object_repr=str(instance.payment_run.payment_reference)[:255],
                changes={
                    "step": step.name,
                    "step_type": "notification",
                    "recipient_user": str(step.notify_user_id) if step.notify_user_id else None,
                    "recipient_email": step.notify_email or None,
                },
            )

        # Fire the notification email asynchronously for both documents and payment runs
        if doc is not None:
            WorkflowService._send_notification_step_email(step, document=doc)
        elif instance.payment_run:
            WorkflowService._send_notification_step_email(step, payment_run=instance.payment_run)

        # Immediately advance — notification steps never block
        WorkflowService._advance_step(instance, order)

    @staticmethod
    def _send_notification_step_email(step: WorkflowStep, document=None, payment_run=None) -> None:
        """
        Dispatch the notification-step email via Celery for documents or payment runs.
        Uses the step's configured subject/body; optional template overrides are applied
        in the notifications task.
        """
        target = document if document is not None else payment_run
        if target is None:
            return

        try:
            from apps.notifications.tasks import send_workflow_notification_step_email
            recipient_user_id = str(step.notify_user_id) if step.notify_user_id else None
            recipient_email = step.notify_email or None
            recipient_emails = step.notify_emails or []
            subject = step.notification_subject
            message = step.notification_message
            step_name = step.name
            document_id = str(document.pk) if document is not None else None
            payment_run_id = str(payment_run.pk) if payment_run is not None else None
            template_id = str(step.template_id) if step.template_id else None
            include_items_table = bool(getattr(step, "notify_include_items_table", False))
            table_field_key = (getattr(step, "notify_table_field", None) or "").strip() or None

            # Resolve supplier emails if recipient type is "supplier"
            recipient_type = getattr(step, "notify_recipient_type", "email") or "email"
            if recipient_type == "supplier" and document and step.notify_supplier_field:
                supplier_emails = WorkflowService._resolve_supplier_emails(document, step.notify_supplier_field)
                if supplier_emails:
                    recipient_emails = supplier_emails
                    recipient_email = None  # Use the email list instead
                    recipient_user_id = None

            _queue_after_commit(
                lambda: send_workflow_notification_step_email.delay(
                    recipient_user_id=recipient_user_id,
                    recipient_email=recipient_email,
                    recipient_emails=recipient_emails,
                    subject=subject,
                    message=message,
                    document_id=document_id,
                    payment_run_id=payment_run_id,
                    step_name=step_name,
                    template_id=template_id,
                    include_items_table=include_items_table,
                    table_field_key=table_field_key,
                )
            )
        except Exception:
            logger.exception(
                "Failed to dispatch notification-step email for step '%s' on %s %s",
                step.name,
                "document" if document is not None else "payment run",
                getattr(target, "pk", target),
            )

    @staticmethod
    def _resolve_supplier_emails(document, supplier_field_key: str) -> list[str]:
        """
        Resolve supplier emails from form data + SunSystems Supplier/Query.
        Returns unique email addresses for the selected supplier codes.
        """
        try:
            metadata = document.metadata if isinstance(document.metadata, dict) else {}
            form = metadata.get("form") if isinstance(metadata.get("form"), dict) else {}
            form_values = form.get("values") if isinstance(form.get("values"), dict) else {}
            raw = form_values.get(supplier_field_key)

            # Normalize stored value → list of supplier codes.
            # AccountMultiSelect stores string[] (or a single string when multi=false).
            codes: list[str] = []
            if isinstance(raw, str) and raw.strip():
                codes = [raw.strip()]
            elif isinstance(raw, list):
                for item in raw:
                    if isinstance(item, str) and item.strip():
                        codes.append(item.strip())
                    elif isinstance(item, dict):
                        code = (
                            item.get("account_code")
                            or item.get("SupplierCode")
                            or item.get("code")
                            or item.get("value")
                        )
                        if code:
                            codes.append(str(code).strip())

            codes = [c for c in codes if c]
            if not codes:
                logger.info(
                    "No supplier codes on document %s for field %s",
                    getattr(document, "pk", None),
                    supplier_field_key,
                )
                return []

            from apps.sunsystems.client import SunSystemsClient, SunSystemsConfig
            from apps.sunsystems.models import effective_connection
            import xml.etree.ElementTree as ET
            from xml.sax.saxutils import escape

            conn = effective_connection()
            config = SunSystemsConfig.from_mapping(conn)
            business_unit = config.business_unit or "PK1"

            filter_parts = [
                f'<Item name="/Supplier/SupplierCode" operator="EQU" value="{escape(code)}"/>'
                for code in codes
            ]
            # OR semantics: SSC Filter items at the same level are typically OR'd
            # for EQU on the same path across vendors; if the connector ANDs them,
            # fall back to unfiltered query + local filter below.
            filter_xml = f"<Filter>{''.join(filter_parts)}</Filter>"

            ssc_payload = (
                "<SSC>\n"
                "  <ErrorContext/>\n"
                "  <User/>\n"
                f"  <SunSystemsContext>\n"
                f"    <BusinessUnit>{escape(business_unit)}</BusinessUnit>\n"
                "  </SunSystemsContext>\n"
                "  <Payload>\n"
                f"    {filter_xml}\n"
                "    <Select>\n"
                "      <Supplier>\n"
                "        <Description>.</Description>\n"
                "        <EMailAddress>.</EMailAddress>\n"
                "        <SupplierCode>.</SupplierCode>\n"
                "        <SupplierName>.</SupplierName>\n"
                "      </Supplier>\n"
                "    </Select>\n"
                "  </Payload>\n"
                "</SSC>"
            )

            client = SunSystemsClient(config)
            response_xml = client.execute("Supplier", "Query", ssc_payload)

            wanted = {c.upper() for c in codes}
            emails: list[str] = []
            seen: set[str] = set()
            root = ET.fromstring(response_xml or "<SSC/>")
            for supplier in root.findall(".//Supplier"):
                code = (supplier.findtext("SupplierCode") or "").strip()
                if wanted and code.upper() not in wanted:
                    continue
                email = (supplier.findtext("EMailAddress") or "").strip()
                if email and email.lower() not in seen:
                    seen.add(email.lower())
                    emails.append(email)

            if not emails:
                logger.warning(
                    "SunSystems returned no emails for suppliers %s on document %s",
                    codes,
                    getattr(document, "pk", None),
                )
            return emails
        except Exception:
            logger.exception("Failed to resolve supplier emails for field %s", supplier_field_key)
            return []

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
        if WorkflowService.is_v2_workflow(instance.template):
            # Stay within the active branch: the next order is the smallest
            # active order greater than this step, not necessarily order + 1.
            orders, end_outcome = WorkflowService._v2_active_step_orders(instance)
            later = [candidate for candidate in orders if candidate > order]
            if later:
                WorkflowService._activate_step(instance, order=later[0])
            else:
                WorkflowService._complete(instance, end_outcome or "approved")
            return
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
        if doc is not None:
            doc.status = outcome_status_for(doc.document_type, outcome)
            update_fields = ["status", "updated_at"]
            try:
                from apps.documents.builder_workflow import record_procurement_stage_completion
                if record_procurement_stage_completion(doc, outcome):
                    update_fields.append("metadata")
            except Exception:
                logger.exception("Could not record procurement workflow completion for %s", doc.id)
            WorkflowService._save_document(doc, update_fields=update_fields)

            # Does an intermediate procurement stage follow this approval?
            advances = False
            if outcome == "approved":
                try:
                    from apps.documents.builder_workflow import next_procurement_stage
                    advances = bool(next_procurement_stage(doc))
                except Exception:
                    advances = False

            # Only the final procurement stage (or a non-procurement form)
            # announces "document approved". Intermediate stages continue into
            # the next stage below, so a "workflow complete" email here would be
            # premature and would repeat at every stage.
            if not advances:
                try:
                    from apps.notifications.tasks import notify_workflow_complete
                    instance_id = str(instance.id)
                    _queue_after_commit(
                        lambda iid=instance_id, oc=outcome: notify_workflow_complete.delay(iid, oc)
                    )
                except Exception:
                    pass

            # Generate the printable LPO document first: it reserves the LPO
            # number that the SunSystems PurchaseOrder posting then references.
            WorkflowService._maybe_generate_lpo_document(doc, outcome=outcome, actor=instance.started_by)

            WorkflowService._maybe_post_sunsystems_journal(doc, outcome)

            # A fully-approved procurement stage opens the next stage on its
            # own (Requisition -> RFQ -> LPO; Travel skips RFQ). The requestor
            # no longer has to click "Submit RFQ"/"Submit LPO". Starting the new
            # stage also emails its first approver via notify_task_assigned.
            if advances:
                try:
                    WorkflowService._maybe_advance_procurement_stage(
                        doc, actor=instance.started_by
                    )
                except Exception:
                    logger.exception(
                        "Could not auto-advance procurement stage for %s", doc.id
                    )
            return

        if instance.payment_run_id:
            try:
                from apps.notifications.tasks import notify_workflow_complete
                instance_id = str(instance.id)
                _queue_after_commit(
                    lambda iid=instance_id, oc=outcome: notify_workflow_complete.delay(iid, oc)
                )
            except Exception:
                pass
            WorkflowService._complete_payment_run(instance, outcome)

    @staticmethod
    def _maybe_advance_procurement_stage(document, actor=None) -> bool:
        """Open the next procurement stage automatically after full approval.

        Called when a stage's workflow completes as approved. Uses the same
        ``next_procurement_stage`` gate as the manual submit button, so a stage
        can only open once the previous one is complete and the document has no
        live workflow. Travel requisitions jump straight from Requisition to LPO.
        Emails for the new stage's first approver go out via the normal
        ``_activate_step`` -> ``notify_task_assigned`` path.
        """
        from apps.documents.builder_workflow import (
            is_procurement_document,
            next_procurement_stage,
            set_procurement_workflow_stage,
        )

        if not is_procurement_document(document):
            return False
        next_stage = next_procurement_stage(document)
        if not next_stage:
            return False

        set_procurement_workflow_stage(document, next_stage)
        WorkflowService.start(document, actor or document.uploaded_by)
        return True

    @staticmethod
    def _complete_payment_run(instance: WorkflowInstance, outcome: str) -> None:
        from apps.sunsystems.models import PaymentRunStatus

        run = instance.payment_run
        if not run:
            return
        if outcome == "approved":
            run.status = PaymentRunStatus.APPROVED
            run.error = ""
            run.save(update_fields=["status", "error", "updated_at"])

            try:
                from apps.sunsystems.tasks import process_payment_run
                run_id = str(run.id)
                actor_id = str(instance.started_by_id) if instance.started_by_id else None
                _queue_after_commit(lambda rid=run_id, aid=actor_id: process_payment_run.delay(rid, aid))
            except Exception:
                logger.exception("Failed to queue payment run processing for %s", run.id)
        else:
            # Set to REJECTED for any non-approved outcome
            run.status = PaymentRunStatus.REJECTED
            run.error = f"Payment run workflow completed with outcome '{outcome}'."
            run.save(update_fields=["status", "error", "updated_at"])

    @staticmethod
    def _maybe_generate_lpo_document(document, *, outcome: str = "approved", actor=None):
        """Generate the printable LPO document when the LPO phase completes.

        Only procurement requisitions whose LPO stage was just fully approved
        qualify. Idempotent — the relation is stored on the requisition, and a
        second call returns the already-generated document. Generation failure
        must never block the workflow (or the SunSystems posting), so it is
        caught and logged.
        """
        try:
            from apps.documents.builder_workflow import (
                completed_procurement_stages,
                is_procurement_document,
            )

            if outcome != "approved" or not is_procurement_document(document):
                return None
            phase = WorkflowService._document_workflow_phase(document)
            if phase != "lpo" or "lpo" not in completed_procurement_stages(document):
                return None

            from apps.documents.lpo import generate_lpo_for_document

            return generate_lpo_for_document(document, actor=actor)
        except Exception:
            logger.exception("Could not generate LPO document for %s", document.id)
            return None

    @staticmethod
    def _maybe_post_sunsystems_journal(document, outcome: str) -> None:
        """Post any journal stages whose ``post_on`` trigger matches this outcome.

        Supports multi-stage imprest flows: stage 1 fires on "approved", stage 2
        fires on "retirement_approved" (or whatever the template configures).
        Each matching stage is enqueued independently after commit. The
        JournalPosting row's unique_together constraint makes each stage
        idempotent — a stage that is already POSTED is never re-posted.
        """
        try:
            from apps.sunsystems.config import find_stage_to_post, get_journal_mapping, journal_posting_enabled
            if not journal_posting_enabled(document):
                return

            phase = WorkflowService._document_workflow_phase(document)
            outcomes = [outcome]
            from apps.documents.builder_workflow import completed_procurement_stages, is_procurement_document
            if is_procurement_document(document):
                # Intermediate approvals never post. LPO completion emits the
                # only procurement posting trigger.
                outcomes = ["fully_approved"] if outcome == "approved" and phase == "lpo" and "lpo" in completed_procurement_stages(document) else []
            elif phase == "retirement" and outcome == "approved":
                outcomes = ["retirement_approved", "approved"]

            for trigger in outcomes:
                stage = find_stage_to_post(document, trigger)
                if stage is None:
                    continue
                from apps.sunsystems.models import JournalPosting, JournalPostingStatus

                posting, created = JournalPosting.objects.get_or_create(document=document, stage=stage)
                if not created:
                    return
                mapping = get_journal_mapping(document, stage=stage) or {}
                posting.status = JournalPostingStatus.PENDING
                posting.stage_label = str(mapping.get("label") or posting.stage_label or "").strip()
                posting.message = "Queued for SunSystems posting."
                posting.error = ""
                posting.save(update_fields=["status", "stage_label", "message", "error", "updated_at"])
                from apps.sunsystems.tasks import post_journal_for_document

                doc_id = str(document.id)
                _queue_after_commit(
                    lambda did=doc_id, s=stage: post_journal_for_document.delay(did, s)
                )
                return
        except Exception:
            logger.exception(
                "Failed to enqueue SunSystems journal for document %s (outcome=%s)",
                document.id,
                outcome,
            )

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

        template = action.task.workflow_instance.template
        if action.action == "approved" and not template.notify_uploader_on_approval:
            try:
                from apps.notifications.tasks import clear_resolved_task_notifications_now
                clear_resolved_task_notifications_now(str(action.task_id))
            except Exception:
                pass
            return

        try:
            from apps.notifications.tasks import _workflow_stakeholder_recipients
            notify_users = set(
                _workflow_stakeholder_recipients(
                    action.task.workflow_instance,
                    document=document,
                )
            )
        except Exception:
            notify_users = set()

        if not notify_users:
            if action.action in ("approved", "rejected", "returned"):
                try:
                    from apps.notifications.tasks import clear_resolved_task_notifications_now
                    clear_resolved_task_notifications_now(str(action.task_id))
                except Exception:
                    pass
            return

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
