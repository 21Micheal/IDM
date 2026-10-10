"""
apps/workflows/views.py

Added actions on WorkflowTaskViewSet:
  POST .../tasks/{id}/return_for_review/  — return document for rework
  POST .../tasks/{id}/hold/               — put task on hold
  POST .../tasks/{id}/release_hold/       — manually release a hold
  GET  .../tasks/{id}/history/            — full action history for a task
"""
from django.db import models, transaction
from django.db.models import Count
from django.db.models.functions import TruncMonth
from django.utils import timezone
from rest_framework import viewsets, permissions, status
from rest_framework.decorators import action
from rest_framework.response import Response
from rest_framework.filters import SearchFilter, OrderingFilter
from rest_framework.views import APIView

from .models import (
    WorkflowTemplate, WorkflowStep, WorkflowRule,
    WorkflowInstance, WorkflowTask, WorkflowTaskAction,
)
from .serializers import (
    WorkflowTemplateSerializer, WorkflowTemplateWriteSerializer,
    WorkflowRuleSerializer,
    WorkflowInstanceSerializer, WorkflowTaskSerializer,
    WorkflowTaskActionSerializer,
)
from .services import WorkflowService, WorkflowError
from apps.accounts.delegation import (
    delegated_tasks_q,
    tasks_visible_to_user,
    user_can_action_task_via_delegation,
)
from apps.accounts.views import IsGroupAdmin
from apps.documents.analytics import IsAnalyticsViewer


# ── Templates ──────────────────────────────────────────────────────────────────

class WorkflowTemplateViewSet(viewsets.ModelViewSet):
    filter_backends = [SearchFilter, OrderingFilter]
    search_fields   = ["name", "description"]
    ordering_fields = ["name", "created_at"]
    ordering        = ["name"]

    def get_queryset(self):
        return (
            WorkflowTemplate.objects
            .select_related("document_type")
            .prefetch_related("steps__assignee_user", "steps__assignee_group")
            .filter(is_active=True)
            .annotate(step_count_annotation=Count("steps"))
        )

    def get_serializer_class(self):
        if self.action in ("create", "update", "partial_update"):
            return WorkflowTemplateWriteSerializer
        return WorkflowTemplateSerializer

    def get_permissions(self):
        if self.action in ("create", "update", "partial_update", "destroy",
                           "duplicate", "reorder_steps"):
            return [permissions.IsAuthenticated(), IsGroupAdmin()]
        return [permissions.IsAuthenticated()]

    def perform_create(self, serializer):
        serializer.save(created_by=self.request.user)

    def destroy(self, request, *args, **kwargs):
        """
        Permanently delete a workflow template, its steps and routing rules.

        Templates that have already been used to run a workflow on a document are
        referenced by WorkflowInstance with on_delete=PROTECT — deleting them would
        destroy that approval history, so those are refused with a clear message.
        """
        instance = self.get_object()
        used_by = WorkflowInstance.objects.filter(template=instance).count()
        if used_by:
            return Response(
                {
                    "detail": (
                        f"This workflow has already processed {used_by} "
                        f"document{'s' if used_by != 1 else ''} and cannot be "
                        "permanently deleted without destroying their approval "
                        "history."
                    )
                },
                status=status.HTTP_409_CONFLICT,
            )

        with transaction.atomic():
            # Routing rules reference the template with on_delete=PROTECT, so they
            # must be removed first. Steps cascade automatically, and any document
            # type pointing here as its primary template is detached (SET_NULL).
            instance.rules.all().delete()
            instance.delete()

        return Response(status=status.HTTP_204_NO_CONTENT)

    @action(detail=True, methods=["post"])
    def duplicate(self, request, pk=None):
        source   = self.get_object()
        new_name = request.data.get("name", f"{source.name} (copy)")
        if WorkflowTemplate.objects.filter(name=new_name).exists():
            return Response({"detail": f"A template named '{new_name}' already exists."}, status=400)
        with transaction.atomic():
            clone = WorkflowTemplate.objects.create(
                name=new_name, description=source.description,
                target_type=source.target_type,
                document_type=source.document_type,
                is_active=True, created_by=request.user,
                definition=source.definition,  # Preserve v2 workflow definition
            )
            for step in source.steps.order_by("order"):
                WorkflowStep.objects.create(
                    template=clone, order=step.order, name=step.name,
                    status_label=step.status_label, step_type=step.step_type,
                    assignee_type=step.assignee_type,
                    assignee_group=step.assignee_group, assignee_user=step.assignee_user,
                    assignee_user_auto=step.assignee_user_auto,
                    sla_hours=step.sla_hours, allow_resubmit=step.allow_resubmit,
                    allow_approve=step.allow_approve, allow_reject=step.allow_reject,
                    allow_return=step.allow_return,
                    requires_signature=step.requires_signature,
                    instructions=step.instructions,
                    approver_email_subject=step.approver_email_subject,
                    approver_email_body=step.approver_email_body,
                    notify_user=step.notify_user,
                    notify_email=step.notify_email,
                    notification_subject=step.notification_subject,
                    notification_message=step.notification_message,
                )
        return Response(
            WorkflowTemplateSerializer(clone, context={"request": request}).data,
            status=201,
        )

    @action(detail=True, methods=["post"], url_path="reorder_steps")
    def reorder_steps(self, request, pk=None):
        template = self.get_object()
        step_ids = request.data.get("step_ids", [])
        if not isinstance(step_ids, list) or not step_ids:
            return Response({"detail": "step_ids must be a non-empty list."}, status=400)
        steps    = list(template.steps.all())
        step_map = {str(s.id): s for s in steps}
        if set(step_map.keys()) != set(step_ids):
            return Response({"detail": "Step IDs do not match this template."}, status=400)
        with transaction.atomic():
            for new_order, step_id in enumerate(step_ids, start=1):
                s = step_map[step_id]
                if s.order != new_order:
                    s.order = new_order
                    s.save(update_fields=["order"])
        return Response(WorkflowTemplateSerializer(template, context={"request": request}).data)

    @staticmethod
    def _definition_step_phases(definition, default_phase):
        """Yield ``(phase, step_label)`` for approval steps in a v2 definition.

        V2 branched workflows nest blocks under ``switch`` cases whose ``label``
        is the phase. Blocks outside a switch belong to ``default_phase``."""
        out: list[tuple[str, str]] = []

        def walk(blocks, phase):
            for block in blocks or []:
                if not isinstance(block, dict):
                    continue
                kind = block.get("kind")
                if kind == "switch":
                    for case in block.get("cases") or []:
                        if not isinstance(case, dict):
                            continue
                        case_phase = str(case.get("label") or "").strip().lower() or phase
                        walk(case.get("blocks"), case_phase)
                    continue
                if kind == "approval":
                    step = block.get("step") or {}
                    label = step.get("name") or step.get("status_label")
                    if label:
                        out.append((phase, str(label)))
                    continue
                nested = block.get("blocks")
                if nested:
                    walk(nested, phase)

        walk((definition or {}).get("blocks"), default_phase)
        return out

    @action(detail=False, methods=["get"], url_path="process-steps")
    def process_steps(self, request):
        """List the process steps (statuses) a document of a given type can be in.

        Used by the form builder to populate "process step equals ..." conditions
        for section/field visibility.

        Every option carries the ``value`` a document's ``builder_process_step``
        actually returns at runtime. Procurement steps are STAGE-AWARE: each
        stage (Requisition -> RFQ -> LPO) exposes one generic option per outcome
        that covers EVERY approval step in that stage, regardless of the
        step's ``status_label``. Individual workflow-builder step labels are
        folded into their stage's generic "in progress" option and surfaced on
        ``covered`` (a document never carries a raw ``status_label``, so those
        were dead choices).

        Shape: ``{value, label, stage, generic, group, covered}``.

        Pass ``?document_type=<id>``; without it no workflow steps are folded.
        Pass ``?workflow_type=imprest|requisition`` to pick the lifecycle.
        """
        from apps.documents.models import DocumentStatus
        from apps.documents.builder_workflow import PROCUREMENT_WORKFLOW_STAGES

        doc_type = request.query_params.get("document_type")
        workflow_type = request.query_params.get("workflow_type", "imprest")
        steps: list[dict] = []
        seen: set = set()
        stage_group_names = {
            "requisition": "Requisition", "rfq": "RFQ", "lpo": "LPO",
            "request": "Request", "retirement": "Retirement",
        }

        def add(value, label, *, stage=None, generic=False, group=None):
            if not value or value in seen:
                return
            seen.add(value)
            steps.append({
                "value": value,
                "label": label,
                "stage": stage,
                "generic": generic,
                "group": group or (f"{stage_group_names.get(stage, stage.title())} stage" if stage else "Lifecycle"),
                "covered": [],
            })

        # Draft is the implicit starting state while a document is being created.
        add(DocumentStatus.DRAFT, DocumentStatus.DRAFT.label)

        stage_names = {"requisition": "Requisition", "rfq": "RFQ", "lpo": "LPO"}

        if workflow_type == "requisition":
            for stage in PROCUREMENT_WORKFLOW_STAGES:
                stage_label = stage_names.get(stage, stage.title())
                add(f"{stage}_pending", f"{stage_label} approval in progress",
                    stage=stage, generic=True)
                add(f"{stage}_approved", f"{stage_label} approved",
                    stage=stage, generic=True)
                add(f"{stage}_returned", f"{stage_label} returned for rework",
                    stage=stage, generic=True)
                add(f"{stage}_rejected", f"{stage_label} rejected",
                    stage=stage, generic=True)
            add("fully_approved", "Fully approved", stage="lpo", generic=True)
            add("retirement_ready", "Retirement ready for submission", stage="retirement", generic=True)
            add("retirement_pending", "Retirement approval in progress", stage="retirement", generic=True)
            add("retirement_approved", "Retirement approved", stage="retirement", generic=True)
            add("retirement_returned", "Retirement returned for rework", stage="retirement", generic=True)
            add("retirement_rejected", "Retirement rejected", stage="retirement", generic=True)
        else:
            # Imprest workflow stages (default for backward compatibility)
            add("request_pending", "Request approval in progress", stage="request", generic=True)
            add("request_approved", "Request approved (retirement open)", stage="request", generic=True)
            add("retirement_pending", "Retirement approval in progress", stage="retirement", generic=True)
            add("retirement_returned", "Retirement returned for rework", stage="retirement", generic=True)
            add("retirement_rejected", "Retirement rejected", stage="retirement", generic=True)
            add("fully_approved", "Fully approved", stage="retirement", generic=True)

        # Fold the workflow builder's per-step labels into their stage's generic
        # "in progress" option so the builder shows which named steps are covered
        # without offering values a document can never actually hold.
        if doc_type:
            covered: dict[str, list[str]] = {}

            def note(phase, label):
                value = f"{str(phase or '').strip().lower()}_pending"
                display = str(label or "").strip()
                if not display or not any(s["value"] == value for s in steps):
                    return
                bucket = covered.setdefault(value, [])
                if display not in bucket:
                    bucket.append(display)

            # Legacy routing rules carry the phase directly on the rule.
            try:
                rows = (
                    WorkflowStep.objects
                    .filter(template__rules__document_type_id=doc_type,
                            template__rules__is_active=True)
                    .exclude(step_type="notification")
                    .values_list("status_label", "name", "template__rules__phase")
                    .distinct()
                )
                for status_label, name, phase in rows:
                    if phase:
                        note(phase, name or status_label)
            except Exception:
                pass

            # V2 branched workflows nest approval steps under switch cases whose
            # labels are the procurement phases (requisition / rfq / lpo).
            default_phase = "requisition" if workflow_type == "requisition" else "request"
            try:
                for tpl in WorkflowTemplate.objects.filter(document_type_id=doc_type, is_active=True):
                    for phase, label in self._definition_step_phases(tpl.definition, default_phase):
                        note(phase, label)
            except Exception:
                pass

            for opt in steps:
                if opt["value"] in covered:
                    opt["covered"] = covered[opt["value"]]

        # Standard terminal / lifecycle statuses a document can also carry.
        for st in (
            DocumentStatus.PENDING_REVIEW, DocumentStatus.PENDING_APPROVAL,
            DocumentStatus.RETURNED, DocumentStatus.APPROVED,
            DocumentStatus.REJECTED, DocumentStatus.ARCHIVED, DocumentStatus.VOID,
        ):
            add(st, st.label)

        return Response(steps)
        return Response(steps)


# ── Rules ──────────────────────────────────────────────────────────────────────

class WorkflowRuleViewSet(viewsets.ModelViewSet):
    serializer_class = WorkflowRuleSerializer
    filter_backends  = [OrderingFilter]
    ordering         = ["document_type", "phase", "amount_min", "amount_max"]

    def get_queryset(self):
        qs = (
            WorkflowRule.objects
            .select_related("template", "template__document_type", "document_type")
            .filter(template__target_type=models.F("target_type"))
        )
        qs = qs.filter(
            models.Q(target_type="payment_run", document_type__isnull=True)
            | models.Q(target_type="document", template__document_type=models.F("document_type"))
        )
        if target_type := self.request.query_params.get("target_type"):
            qs = qs.filter(target_type=target_type)
        if dt := self.request.query_params.get("document_type"):
            qs = qs.filter(document_type__id=dt)
        if tmpl := self.request.query_params.get("template"):
            qs = qs.filter(template__id=tmpl)
        if phase := self.request.query_params.get("phase"):
            qs = qs.filter(phase=(phase or "").strip().lower())
        return qs

    def get_permissions(self):
        if self.action in ("create", "update", "partial_update", "destroy"):
            return [permissions.IsAuthenticated(), IsGroupAdmin()]
        return [permissions.IsAuthenticated()]


# ── Instances ──────────────────────────────────────────────────────────────────

class WorkflowInstanceViewSet(viewsets.ReadOnlyModelViewSet):
    serializer_class = WorkflowInstanceSerializer
    filter_backends  = [OrderingFilter]
    ordering         = ["-started_at"]

    def get_queryset(self):
        qs = (
            WorkflowInstance.objects
            .select_related("document", "template", "rule", "started_by")
            .select_related("payment_run")
            .prefetch_related("tasks__step__assignee_user", "tasks__assigned_to")
        )
        if document_id := self.request.query_params.get("document") or self.request.query_params.get("document_id"):
            qs = qs.filter(document_id=document_id)
        if payment_run_id := self.request.query_params.get("payment_run") or self.request.query_params.get("payment_run_id"):
            qs = qs.filter(payment_run_id=payment_run_id)

        user = self.request.user
        if not user.has_admin_access:
            qs = qs.filter(
                models.Q(started_by=user) |
                models.Q(document__uploaded_by=user) |
                models.Q(payment_run__submitted_by=user) |
                models.Q(tasks__assigned_to=user)
            ).distinct()

        return qs

    @action(detail=True, methods=["post"])
    def cancel(self, request, pk=None):
        instance = self.get_object()
        try:
            WorkflowService.cancel(instance, request.user)
        except WorkflowError as exc:
            return Response({"detail": str(exc)}, status=400)
        return Response({"detail": "Workflow cancelled."})


# ── Tasks ──────────────────────────────────────────────────────────────────────

class WorkflowTaskViewSet(viewsets.ReadOnlyModelViewSet):
    serializer_class = WorkflowTaskSerializer
    filter_backends  = [OrderingFilter]
    ordering         = ["step__order"]

    def get_queryset(self):
        user = self.request.user
        qs   = WorkflowTask.objects.select_related(
            "step", "assigned_to", "workflow_instance__document",
            "workflow_instance__payment_run",
            "workflow_instance__payment_run__submitted_by",
            "workflow_instance__document__document_type",
            "workflow_instance__document__department",
            "workflow_instance__document__uploaded_by",
            "workflow_instance__document__uploaded_by__department",
        )
        if document_id := self.request.query_params.get("document") or self.request.query_params.get("document_id"):
            qs = qs.filter(workflow_instance__document_id=document_id)
            if user.has_admin_access:
                return qs
            return qs.filter(
                models.Q(assigned_to=user) |
                models.Q(workflow_instance__started_by=user) |
                models.Q(workflow_instance__document__uploaded_by=user) |
                delegated_tasks_q(user),
            ).distinct()
        if payment_run_id := self.request.query_params.get("payment_run") or self.request.query_params.get("payment_run_id"):
            qs = qs.filter(workflow_instance__payment_run_id=payment_run_id)
            if user.has_admin_access:
                return qs
            return qs.filter(
                models.Q(assigned_to=user) |
                models.Q(workflow_instance__started_by=user) |
                models.Q(workflow_instance__payment_run__submitted_by=user) |
                delegated_tasks_q(user),
            ).distinct()

        if user.has_admin_access:
            if s := self.request.query_params.get("status"):
                qs = qs.filter(status=s)
            return qs
        visible = tasks_visible_to_user(user).filter(pk__in=qs.values("pk"))
        return qs.filter(pk__in=visible.values("pk")).distinct()

    @action(detail=False, methods=["get"], url_path="my_tasks")
    def my_tasks(self, request):
        tasks = (
            tasks_visible_to_user(request.user)
            .select_related(
                "step",
                "assigned_to",
                "workflow_instance__document",
                "workflow_instance__payment_run",
                "workflow_instance__payment_run__submitted_by",
                "workflow_instance__document__document_type",
                "workflow_instance__document__department",
                "workflow_instance__document__uploaded_by",
                "workflow_instance__document__uploaded_by__department",
            )
            .order_by("due_at")
        )
        return Response(
            WorkflowTaskSerializer(tasks, many=True, context={"request": request}).data
        )

    # ── Approve ────────────────────────────────────────────────────────────

    @action(detail=True, methods=["post"])
    def approve(self, request, pk=None):
        task = self.get_object()
        if not task.step.allow_approve:
            return Response({"detail": "Approve is not permitted for this step."}, status=403)
        self._check_permission(task, request.user)

        # Supplier quotations must be collected before finance can advance the
        # RFQ phase to LPO. The configured supplier notification step is sent
        # manually from the form; every selected supplier must reply or have a
        # response attached manually before approval succeeds.
        document = task.workflow_instance.document
        form = ((getattr(document, "metadata", None) or {}).get("form") or {}) if document else {}
        if str(form.get("workflow_phase") or "").strip().lower() == "rfq":
            supplier_step = task.workflow_instance.template.steps.filter(
                step_type="notification", notify_recipient_type="supplier",
            ).exclude(notify_supplier_field__isnull=True).exclude(notify_supplier_field="").exists()
            if supplier_step:
                from apps.documents.rfq import (
                    all_supplier_responses_received,
                    rfq_state,
                    supplier_codes_from_values,
                )

                response_state = rfq_state(form)
                if not response_state.get("suppliers"):
                    return Response({"detail": "Send the RFQ to suppliers before approving this stage."}, status=400)
                selected_codes = {code.casefold() for code in supplier_codes_from_values(
                    form.get("values") if isinstance(form.get("values"), dict) else {},
                    response_state.get("supplier_field") or "",
                )}
                tracked_codes = {
                    str(item.get("code") or "").casefold()
                    for item in response_state.get("suppliers", [])
                    if isinstance(item, dict)
                }
                if selected_codes != tracked_codes:
                    return Response({"detail": "The selected suppliers changed after the RFQ was sent. Send the RFQ again before approving."}, status=400)
                if not all_supplier_responses_received(response_state):
                    waiting = [
                        str(item.get("name") or item.get("code") or "Supplier")
                        for item in response_state.get("suppliers", [])
                        if isinstance(item, dict) and item.get("status") != "received"
                    ]
                    return Response({
                        "detail": "Waiting for supplier responses: " + ", ".join(waiting),
                    }, status=400)

        # Sejda-style multi-item signing (signature + optional name/date/text),
        # shared with the signature-request flow. `items` is a JSON array; an
        # ad-hoc drawn signature arrives as use_new_signature + signature_image.
        # A bare `signature_placement` is still accepted from older clients.
        import json as _json
        items = request.data.get("items")
        if isinstance(items, str):
            try:
                items = _json.loads(items) if items.strip() else None
            except _json.JSONDecodeError:
                items = None
        use_new_signature = str(request.data.get("use_new_signature", "")).lower() in ("1", "true", "yes", "on")
        signature_image = request.data.get("signature_image") if use_new_signature else None

        try:
            WorkflowService.approve(
                task,
                request.user,
                request.data.get("comment", ""),
                request=request,
                signature_placement=request.data.get("signature_placement"),
                items=items,
                use_new_signature=use_new_signature,
                signature_image=signature_image,
            )
        except WorkflowError as exc:
            return Response({"detail": str(exc)}, status=400)
        return Response({"status": "approved"})

    # ── Reject ─────────────────────────────────────────────────────────────

    @action(detail=True, methods=["post"])
    def reject(self, request, pk=None):
        task    = self.get_object()
        if not task.step.allow_reject:
            return Response({"detail": "Reject is not permitted for this step."}, status=403)
        comment = request.data.get("comment", "").strip()
        if not comment:
            return Response({"detail": "A rejection comment is required."}, status=400)
        self._check_permission(task, request.user)
        try:
            WorkflowService.reject(task, request.user, comment)
        except WorkflowError as exc:
            return Response({"detail": str(exc)}, status=400)
        return Response({"status": "rejected"})

    # ── Return for review ──────────────────────────────────────────────────

    @action(detail=True, methods=["post"], url_path="return_for_review")
    def return_for_review(self, request, pk=None):
        task      = self.get_object()
        comment   = request.data.get("comment", "").strip()
        return_to = (request.data.get("return_to") or "uploader").strip()

        if not comment:
            return Response(
                {"detail": "A comment explaining what needs to be fixed is required."},
                status=400,
            )
        if return_to not in ("previous_step", "uploader", "same_step"):
            return Response(
                {"detail": "return_to must be previous_step, uploader, or same_step."},
                status=400,
            )

        step = task.step
        if return_to == "previous_step":
            if not step.allow_return:
                return Response(
                    {"detail": "Return to previous step is not permitted for this step."},
                    status=403,
                )
            if task.step.order <= 1:
                return Response(
                    {"detail": "There is no previous step to return to."},
                    status=400,
                )
        elif return_to in ("uploader", "same_step"):
            # Legacy templates only had allow_return; treat that as submitter return.
            allow_submitter = getattr(step, "allow_return_submitter", False) or step.allow_return
            if not allow_submitter:
                return Response(
                    {"detail": "Return to submitter is not permitted for this step."},
                    status=403,
                )

        self._check_permission(task, request.user)
        try:
            WorkflowService.return_for_review(task, request.user, comment, return_to)
        except WorkflowError as exc:
            return Response({"detail": str(exc)}, status=400)
        return Response({"status": "returned", "return_to": return_to, "detail": "Document returned for review."})

    # ── Hold ───────────────────────────────────────────────────────────────

    @action(detail=True, methods=["post"])
    def hold(self, request, pk=None):
        task       = self.get_object()
        comment    = request.data.get("comment", "").strip()
        hold_hours = request.data.get("hold_hours", 24)

        if not comment:
            return Response({"detail": "A comment is required when placing on hold."}, status=400)

        try:
            hold_hours = int(hold_hours)
        except (TypeError, ValueError):
            return Response({"detail": "hold_hours must be a whole number."}, status=400)
        if hold_hours <= 0:
            return Response({"detail": "hold_hours must be greater than zero."}, status=400)

        self._check_permission(task, request.user)
        try:
            WorkflowService.hold(task, request.user, comment, hold_hours)
        except WorkflowError as exc:
            return Response({"detail": str(exc)}, status=400)

        return Response({
            "status": "held",
            "held_until": task.held_until,
            "detail": "Task placed on hold until the scheduled release time.",
        })

    # ── Release hold ───────────────────────────────────────────────────────

    @action(detail=True, methods=["post"], url_path="release_hold")
    def release_hold(self, request, pk=None):
        task = self.get_object()
        self._check_permission(task, request.user)
        try:
            WorkflowService.release_hold(task, actor=request.user)
        except WorkflowError as exc:
            return Response({"detail": str(exc)}, status=400)
        return Response({"status": "in_progress", "detail": "Hold released. Task is now active."})

    # ── Task action history ────────────────────────────────────────────────

    @action(detail=True, methods=["get"])
    def history(self, request, pk=None):
        task    = self.get_object()
        actions = task.actions.select_related("actor").all()
        return Response(WorkflowTaskActionSerializer(actions, many=True).data)

    # ── Helper ─────────────────────────────────────────────────────────────

    def _check_permission(self, task, user):
        if task.assigned_to == user or user.has_admin_access:
            return
        if user_can_action_task_via_delegation(user, task):
            return
        from rest_framework.exceptions import PermissionDenied
        raise PermissionDenied("You are not authorised to action this task.")


class ApprovalTurnaroundView(APIView):
    """
    Returns avg hours per WorkflowStep across tasks completed in the selected
    window (shared analytics filters apply).
    Response shape: List[{ step, avg_hours, sla_hours, completed }]
    """
    permission_classes = [permissions.IsAuthenticated, IsAnalyticsViewer]

    def get(self, request):
        from apps.documents.analytics import (
            parse_analytics_filters, org_tasks_qs, duration_hours_expr,
        )
        f = parse_analytics_filters(request)

        qs = (
            org_tasks_qs(f)
            .filter(status="approved", acted_at__gte=f.start)
            .annotate(duration_hours=duration_hours_expr())
            .values(step_name=models.F("step__name"), sla_hours=models.F("step__sla_hours"))
            .annotate(avg_hours=models.Avg("duration_hours"), completed=Count("id"))
            .order_by("step__order")
        )

        data = [
            {
                "step":       row["step_name"],
                "avg_hours":  round(row["avg_hours"] or 0, 1),
                "sla_hours":  row["sla_hours"] or 24,
                "completed":  row["completed"],
            }
            for row in qs
        ]
        return Response(data)


class SlaBreachRateView(APIView):
    """
    Groups completed WorkflowTask by calendar month within the selected window.
    A task is "breached" when (acted_at - created_at) > step.sla_hours.
    Months are year-safe ("Jan 2026") and zero-filled.
    Response shape: List[{ month, total, breached, breach_rate }]
    """
    permission_classes = [permissions.IsAuthenticated, IsAnalyticsViewer]

    def get(self, request):
        from apps.documents.analytics import (
            parse_analytics_filters, org_tasks_qs, duration_hours_expr,
            month_key, month_axis,
        )
        f = parse_analytics_filters(request)

        qs = (
            org_tasks_qs(f)
            .filter(acted_at__gte=f.start)
            .annotate(month=TruncMonth("acted_at"), duration_hours=duration_hours_expr())
            .values("month")
            .annotate(
                total=Count("id"),
                breached=Count(
                    "id",
                    filter=models.Q(duration_hours__gt=models.F("step__sla_hours")),
                ),
            )
            .order_by("month")
        )

        rows: dict[str, dict] = {
            label: {"month": label, "total": 0, "breached": 0, "breach_rate": 0}
            for label in month_axis(f)
        }
        for row in qs:
            key = month_key(row["month"])
            rows[key] = {
                "month":       key,
                "total":       row["total"],
                "breached":    row["breached"],
                "breach_rate": round(row["breached"] / row["total"] * 100, 1)
                               if row["total"] else 0,
            }
        return Response(list(rows.values()))
