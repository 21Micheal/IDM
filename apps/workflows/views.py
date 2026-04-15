"""
apps/workflows/views.py

Key fix (addresses "saved templates do not display in UI"):
──────────────────────────────────────────────────────────
DRF ModelViewSet.create/update call get_serializer() for the *response*,
which returned WorkflowTemplateWriteSerializer (no `id` field).
The React onSuccess handler read `data.id` → undefined → the PATCH that
links the template to a DocumentType sent `workflow_template: undefined`
→ the doctype's workflow_template field was never updated → left panel
kept showing "No template."

Fix: override create() and update() to validate with the write serializer
but respond with the full read serializer (includes `id`, `steps`, `step_count`).
Everything else is identical to the previously uploaded version.
"""
from django.db import transaction
from django.db.models import Count
from rest_framework import viewsets, permissions, status
from rest_framework.decorators import action
from rest_framework.response import Response
from rest_framework.filters import SearchFilter, OrderingFilter

from .models import WorkflowTemplate, WorkflowStep, WorkflowRule, WorkflowInstance, WorkflowTask
from .serializers import (
    WorkflowTemplateSerializer, WorkflowTemplateWriteSerializer,
    WorkflowRuleSerializer,
    WorkflowInstanceSerializer, WorkflowTaskSerializer,
)
from .services import WorkflowService, WorkflowError
from apps.accounts.models import Role


class IsAdminRole(permissions.BasePermission):
    message = "Only administrators can perform this action."

    def has_permission(self, request, view):
        return (
            request.user
            and request.user.is_authenticated
            and request.user.role == Role.ADMIN
        )


class WorkflowTemplateViewSet(viewsets.ModelViewSet):
    filter_backends = [SearchFilter, OrderingFilter]
    search_fields   = ["name", "description"]
    ordering_fields = ["name", "created_at"]
    ordering        = ["name"]

    def get_queryset(self):
        return (
            WorkflowTemplate.objects
            .prefetch_related("steps__assignee_user")
            .filter(is_active=True)
            .annotate(step_count=Count("steps"))
        )

    def get_serializer_class(self):
        if self.action in ("create", "update", "partial_update"):
            return WorkflowTemplateWriteSerializer
        return WorkflowTemplateSerializer

    def get_permissions(self):
        if self.action in ("create", "update", "partial_update", "destroy",
                           "duplicate", "reorder_steps"):
            return [permissions.IsAuthenticated(), IsAdminRole()]
        return [permissions.IsAuthenticated()]

    # ── Overrides: always respond with the FULL read serializer ───────────

    def create(self, request, *args, **kwargs):
        """
        Validate with WorkflowTemplateWriteSerializer, save, then return
        WorkflowTemplateSerializer so the React client receives `id`, `steps`,
        `step_count`, `created_by`, etc. in the creation response.
        """
        write_ser = WorkflowTemplateWriteSerializer(
            data=request.data,
            context=self.get_serializer_context(),
        )
        write_ser.is_valid(raise_exception=True)
        instance = write_ser.save(created_by=request.user)

        read_ser = WorkflowTemplateSerializer(
            instance,
            context=self.get_serializer_context(),
        )
        headers = self.get_success_headers(read_ser.data)
        return Response(read_ser.data, status=status.HTTP_201_CREATED, headers=headers)

    def update(self, request, *args, **kwargs):
        """
        Same pattern as create: write serializer for validation/save,
        read serializer for the response body.
        """
        partial  = kwargs.pop("partial", False)
        instance = self.get_object()

        write_ser = WorkflowTemplateWriteSerializer(
            instance,
            data=request.data,
            partial=partial,
            context=self.get_serializer_context(),
        )
        write_ser.is_valid(raise_exception=True)
        instance = write_ser.save()

        read_ser = WorkflowTemplateSerializer(
            instance,
            context=self.get_serializer_context(),
        )
        return Response(read_ser.data)

    # ── Custom actions ─────────────────────────────────────────────────────

    def perform_destroy(self, instance):
        # Soft-delete: flip is_active so existing instances retain their template ref
        instance.is_active = False
        instance.save(update_fields=["is_active"])

    @action(detail=True, methods=["post"])
    def duplicate(self, request, pk=None):
        source   = self.get_object()
        new_name = request.data.get("name", f"{source.name} (copy)")

        if WorkflowTemplate.objects.filter(name=new_name).exists():
            return Response(
                {"detail": f"A template named '{new_name}' already exists."},
                status=status.HTTP_400_BAD_REQUEST,
            )

        with transaction.atomic():
            clone = WorkflowTemplate.objects.create(
                name=new_name,
                description=source.description,
                is_active=True,
                created_by=request.user,
            )
            for step in source.steps.order_by("order"):
                WorkflowStep.objects.create(
                    template=clone,
                    order=step.order,
                    name=step.name,
                    status_label=step.status_label,
                    assignee_type=step.assignee_type,
                    assignee_role=step.assignee_role,
                    assignee_user=step.assignee_user,
                    sla_hours=step.sla_hours,
                    allow_resubmit=step.allow_resubmit,
                    instructions=step.instructions,
                )

        return Response(
            WorkflowTemplateSerializer(clone, context={"request": request}).data,
            status=status.HTTP_201_CREATED,
        )

    @action(detail=True, methods=["post"], url_path="reorder_steps")
    def reorder_steps(self, request, pk=None):
        template = self.get_object()
        step_ids = request.data.get("step_ids", [])

        if not isinstance(step_ids, list) or not step_ids:
            return Response(
                {"detail": "step_ids must be a non-empty list of step UUIDs."},
                status=status.HTTP_400_BAD_REQUEST,
            )

        steps    = list(template.steps.all())
        step_map = {str(s.id): s for s in steps}

        if set(step_map.keys()) != set(step_ids):
            return Response(
                {"detail": "One or more step IDs do not belong to this template."},
                status=status.HTTP_400_BAD_REQUEST,
            )

        with transaction.atomic():
            for new_order, step_id in enumerate(step_ids, start=1):
                s = step_map[step_id]
                if s.order != new_order:
                    s.order = new_order
                    s.save(update_fields=["order"])

        return Response(
            WorkflowTemplateSerializer(template, context={"request": request}).data
        )


class WorkflowRuleViewSet(viewsets.ModelViewSet):
    serializer_class = WorkflowRuleSerializer
    filter_backends  = [OrderingFilter]
    ordering         = ["document_type", "-amount_threshold"]

    def get_queryset(self):
        qs     = WorkflowRule.objects.select_related("template", "document_type")
        params = self.request.query_params
        if dt := params.get("document_type"):
            qs = qs.filter(document_type__id=dt)
        if tmpl := params.get("template"):
            qs = qs.filter(template__id=tmpl)
        return qs

    def get_permissions(self):
        if self.action in ("create", "update", "partial_update", "destroy"):
            return [permissions.IsAuthenticated(), IsAdminRole()]
        return [permissions.IsAuthenticated()]


class WorkflowInstanceViewSet(viewsets.ReadOnlyModelViewSet):
    serializer_class = WorkflowInstanceSerializer
    filter_backends  = [OrderingFilter]
    ordering         = ["-started_at"]

    def get_queryset(self):
        return (
            WorkflowInstance.objects
            .select_related("document", "template", "rule", "started_by")
            .prefetch_related("tasks__step__assignee_user", "tasks__assigned_to")
        )

    @action(detail=True, methods=["post"])
    def cancel(self, request, pk=None):
        instance = self.get_object()
        try:
            WorkflowService.cancel(instance, request.user)
        except WorkflowError as exc:
            return Response({"detail": str(exc)}, status=status.HTTP_400_BAD_REQUEST)
        return Response({"detail": "Workflow cancelled."})


class WorkflowTaskViewSet(viewsets.ReadOnlyModelViewSet):
    serializer_class = WorkflowTaskSerializer
    filter_backends  = [OrderingFilter]
    ordering         = ["step__order"]

    def get_queryset(self):
        user = self.request.user
        qs   = WorkflowTask.objects.select_related(
            "step", "assigned_to", "workflow_instance__document"
        )
        if user.role in (Role.ADMIN, Role.AUDITOR):
            if task_status := self.request.query_params.get("status"):
                qs = qs.filter(status=task_status)
            return qs
        return qs.filter(assigned_to=user, status="in_progress")

    @action(detail=False, methods=["get"], url_path="my_tasks")
    def my_tasks(self, request):
        tasks = (
            WorkflowTask.objects
            .filter(assigned_to=request.user, status="in_progress")
            .select_related("step", "workflow_instance__document")
            .order_by("due_at")
        )
        return Response(WorkflowTaskSerializer(tasks, many=True).data)

    @action(detail=True, methods=["post"])
    def approve(self, request, pk=None):
        task = self.get_object()
        if task.assigned_to != request.user and request.user.role != Role.ADMIN:
            return Response(
                {"detail": "You are not authorised to action this task."},
                status=status.HTTP_403_FORBIDDEN,
            )
        try:
            WorkflowService.approve(task, request.user, request.data.get("comment", ""))
        except WorkflowError as exc:
            return Response({"detail": str(exc)}, status=status.HTTP_400_BAD_REQUEST)
        return Response({"status": "approved"})

    @action(detail=True, methods=["post"])
    def reject(self, request, pk=None):
        task = self.get_object()
        if task.assigned_to != request.user and request.user.role != Role.ADMIN:
            return Response(
                {"detail": "You are not authorised to action this task."},
                status=status.HTTP_403_FORBIDDEN,
            )
        comment = request.data.get("comment", "").strip()
        if not comment:
            return Response(
                {"detail": "A rejection comment is required."},
                status=status.HTTP_400_BAD_REQUEST,
            )
        try:
            WorkflowService.reject(task, request.user, comment)
        except WorkflowError as exc:
            return Response({"detail": str(exc)}, status=status.HTTP_400_BAD_REQUEST)
        return Response({"status": "rejected"})