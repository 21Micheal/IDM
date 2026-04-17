"""
apps/workflows/views.py

Added actions on WorkflowTaskViewSet:
  POST .../tasks/{id}/return_for_review/  — return document for rework
  POST .../tasks/{id}/hold/               — put task on hold
  POST .../tasks/{id}/release_hold/       — manually release a hold
  GET  .../tasks/{id}/history/            — full action history for a task
"""
from django.db import transaction
from django.db.models import Count
from rest_framework import viewsets, permissions, status
from rest_framework.decorators import action
from rest_framework.response import Response
from rest_framework.filters import SearchFilter, OrderingFilter

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
from apps.accounts.models import Role


class IsAdminRole(permissions.BasePermission):
    message = "Only administrators can perform this action."

    def has_permission(self, request, view):
        return (
            request.user
            and request.user.is_authenticated
            and request.user.role == Role.ADMIN
        )


# ── Templates ──────────────────────────────────────────────────────────────────

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
            .annotate(step_count_annotation=Count("steps"))
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

    def perform_create(self, serializer):
        serializer.save(created_by=self.request.user)

    def perform_destroy(self, instance):
        instance.is_active = False
        instance.save(update_fields=["is_active"])

    @action(detail=True, methods=["post"])
    def duplicate(self, request, pk=None):
        source   = self.get_object()
        new_name = request.data.get("name", f"{source.name} (copy)")
        if WorkflowTemplate.objects.filter(name=new_name).exists():
            return Response({"detail": f"A template named '{new_name}' already exists."}, status=400)
        with transaction.atomic():
            clone = WorkflowTemplate.objects.create(
                name=new_name, description=source.description,
                is_active=True, created_by=request.user,
            )
            for step in source.steps.order_by("order"):
                WorkflowStep.objects.create(
                    template=clone, order=step.order, name=step.name,
                    status_label=step.status_label, assignee_type=step.assignee_type,
                    assignee_role=step.assignee_role, assignee_user=step.assignee_user,
                    sla_hours=step.sla_hours, allow_resubmit=step.allow_resubmit,
                    instructions=step.instructions,
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


# ── Rules ──────────────────────────────────────────────────────────────────────

class WorkflowRuleViewSet(viewsets.ModelViewSet):
    serializer_class = WorkflowRuleSerializer
    filter_backends  = [OrderingFilter]
    ordering         = ["document_type", "-amount_threshold"]

    def get_queryset(self):
        qs = WorkflowRule.objects.select_related("template", "document_type")
        if dt := self.request.query_params.get("document_type"):
            qs = qs.filter(document_type__id=dt)
        if tmpl := self.request.query_params.get("template"):
            qs = qs.filter(template__id=tmpl)
        return qs

    def get_permissions(self):
        if self.action in ("create", "update", "partial_update", "destroy"):
            return [permissions.IsAuthenticated(), IsAdminRole()]
        return [permissions.IsAuthenticated()]


# ── Instances ──────────────────────────────────────────────────────────────────

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
            "step", "assigned_to", "workflow_instance__document"
        )
        if user.role in (Role.ADMIN, Role.AUDITOR):
            if s := self.request.query_params.get("status"):
                qs = qs.filter(status=s)
            return qs
        # Other users: tasks assigned to them that are active
        return qs.filter(
            assigned_to=user,
            status__in=["in_progress", "held"],
        )

    @action(detail=False, methods=["get"], url_path="my_tasks")
    def my_tasks(self, request):
        tasks = (
            WorkflowTask.objects
            .filter(assigned_to=request.user, status__in=["in_progress", "held"])
            .select_related("step", "workflow_instance__document")
            .order_by("due_at")
        )
        return Response(WorkflowTaskSerializer(tasks, many=True).data)

    # ── Approve ────────────────────────────────────────────────────────────

    @action(detail=True, methods=["post"])
    def approve(self, request, pk=None):
        task = self.get_object()
        self._check_permission(task, request.user)
        try:
            WorkflowService.approve(task, request.user, request.data.get("comment", ""))
        except WorkflowError as exc:
            return Response({"detail": str(exc)}, status=400)
        return Response({"status": "approved"})

    # ── Reject ─────────────────────────────────────────────────────────────

    @action(detail=True, methods=["post"])
    def reject(self, request, pk=None):
        task    = self.get_object()
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
        """
        POST {
            "comment": "Please correct the supplier name",
            "return_to": "previous_step"  // or "uploader", "same_step"
        }
        Returns the document for rework. Comment is mandatory.
        return_to controls where the document goes:
        - 'previous_step': Return to previous approver (default)
        - 'uploader': Return to document uploader  
        - 'same_step': Reassign within same step
        """
        task     = self.get_object()
        comment  = request.data.get("comment", "").strip()
        return_to = request.data.get("return_to", "previous_step")
        
        if not comment:
            return Response(
                {"detail": "A comment explaining what needs to be fixed is required."},
                status=400,
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
        """
        POST { "comment": "Awaiting supplier clarification" }
        Places the task on hold indefinitely until the approver manually releases it.
        No auto-release - the approver must decide when to release.
        """
        task       = self.get_object()
        comment    = request.data.get("comment", "").strip()

        if not comment:
            return Response({"detail": "A comment is required when placing on hold."}, status=400)

        self._check_permission(task, request.user)
        try:
            WorkflowService.hold(task, request.user, comment)
        except WorkflowError as exc:
            return Response({"detail": str(exc)}, status=400)

        return Response({
            "status": "held",
            "detail": "Task placed on hold. The approver must manually release when ready.",
        })

    # ── Release hold ───────────────────────────────────────────────────────

    @action(detail=True, methods=["post"], url_path="release_hold")
    def release_hold(self, request, pk=None):
        """
        POST {} — manually release a held task when ready to proceed.
        """
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
        """
        GET .../tasks/{id}/history/
        Returns the full chronological action log for this task.
        """
        task    = self.get_object()
        actions = task.actions.select_related("actor").all()
        return Response(WorkflowTaskActionSerializer(actions, many=True).data)

    # ── Helper ─────────────────────────────────────────────────────────────

    def _check_permission(self, task, user):
        if task.assigned_to != user and user.role != Role.ADMIN:
            from rest_framework.exceptions import PermissionDenied
            raise PermissionDenied("You are not authorised to action this task.")
