"""
workflows/services.py  — business logic for workflow state machine
workflows/views.py     — API endpoints
"""
# ── Service Layer ─────────────────────────────────────────────────────────────
from django.utils import timezone
from datetime import timedelta
from .models import WorkflowInstance, WorkflowTask, WorkflowTemplate, WorkflowStep
from apps.documents.models import DocumentStatus


class WorkflowService:
    @staticmethod
    def start(document, actor):
        """Create a WorkflowInstance and first task for a document."""
        template = document.document_type.workflow_template
        if not template:
            raise ValueError("Document type has no workflow template")

        instance = WorkflowInstance.objects.create(
            document=document,
            template=template,
            started_by=actor,
        )
        WorkflowService._create_task_for_step_order(instance, 1)
        return instance

    @staticmethod
    def _create_task_for_step_order(instance, order):
        try:
            step = instance.template.steps.get(order=order)
        except WorkflowStep.DoesNotExist:
            # No more steps — workflow complete
            WorkflowService._complete(instance, "approved")
            return

        assigned = None
        if step.approver_type == "user" and step.approver_user:
            assigned = step.approver_user
        elif step.approver_type == "role":
            from apps.accounts.models import User
            assigned = (
                User.objects.filter(role=step.approver_role, is_active=True).first()
            )

        due = timezone.now() + timedelta(hours=step.sla_hours) if step.sla_hours else None
        task = WorkflowTask.objects.create(
            workflow_instance=instance,
            step=step,
            assigned_to=assigned,
            status="in_progress",
            due_at=due,
        )
        instance.current_step_order = order
        instance.save(update_fields=["current_step_order"])

        # Notify assignee
        from apps.notifications.tasks import notify_task_assigned
        notify_task_assigned.delay(str(task.id))
        return task

    @staticmethod
    def approve(task, actor, comment=""):
        """Approve a workflow task and advance to next step."""
        if task.status != "in_progress":
            raise ValueError("Task is not in progress")

        task.status = "approved"
        task.comment = comment
        task.acted_at = timezone.now()
        task.save()

        instance = task.workflow_instance
        next_order = task.step.order + 1
        if not instance.template.steps.filter(order=next_order).exists():
            WorkflowService._complete(instance, "approved")
        else:
            WorkflowService._create_task_for_step_order(instance, next_order)

    @staticmethod
    def reject(task, actor, comment=""):
        """Reject a workflow task."""
        task.status = "rejected"
        task.comment = comment
        task.acted_at = timezone.now()
        task.save()
        WorkflowService._complete(task.workflow_instance, "rejected")

    @staticmethod
    def _complete(instance, outcome):
        instance.status = outcome
        instance.completed_at = timezone.now()
        instance.save()

        doc = instance.document
        doc.status = (
            DocumentStatus.APPROVED if outcome == "approved" else DocumentStatus.REJECTED
        )
        doc.save(update_fields=["status", "updated_at"])

        from apps.notifications.tasks import notify_workflow_complete
        notify_workflow_complete.delay(str(instance.id), outcome)


# ── Views ─────────────────────────────────────────────────────────────────────
from rest_framework import viewsets, status, permissions
from rest_framework.decorators import action
from rest_framework.response import Response
from .models import WorkflowTemplate, WorkflowInstance, WorkflowTask
from .serializers import (
    WorkflowTemplateSerializer, WorkflowInstanceSerializer, WorkflowTaskSerializer
)


class WorkflowTemplateViewSet(viewsets.ModelViewSet):
    queryset = WorkflowTemplate.objects.prefetch_related("steps").filter(is_active=True)
    serializer_class = WorkflowTemplateSerializer
    permission_classes = [permissions.IsAuthenticated]

    def perform_create(self, serializer):
        serializer.save(created_by=self.request.user)


class WorkflowInstanceViewSet(viewsets.ReadOnlyModelViewSet):
    serializer_class = WorkflowInstanceSerializer
    permission_classes = [permissions.IsAuthenticated]

    def get_queryset(self):
        return (
            WorkflowInstance.objects
            .select_related("document", "template", "started_by")
            .prefetch_related("tasks__step", "tasks__assigned_to")
        )


class WorkflowTaskViewSet(viewsets.ReadOnlyModelViewSet):
    serializer_class = WorkflowTaskSerializer
    permission_classes = [permissions.IsAuthenticated]

    def get_queryset(self):
        user = self.request.user
        if user.is_admin or user.is_auditor:
            return WorkflowTask.objects.select_related(
                "step", "assigned_to", "workflow_instance__document"
            )
        return WorkflowTask.objects.filter(assigned_to=user).select_related(
            "step", "assigned_to", "workflow_instance__document"
        )

    @action(detail=True, methods=["post"])
    def approve(self, request, pk=None):
        task = self.get_object()
        if task.assigned_to != request.user and not request.user.is_admin:
            return Response({"detail": "Not authorised."}, status=403)
        WorkflowService.approve(task, request.user, request.data.get("comment", ""))
        return Response({"status": "approved"})

    @action(detail=True, methods=["post"])
    def reject(self, request, pk=None):
        task = self.get_object()
        if task.assigned_to != request.user and not request.user.is_admin:
            return Response({"detail": "Not authorised."}, status=403)
        comment = request.data.get("comment", "")
        if not comment:
            return Response({"detail": "Rejection comment is required."}, status=400)
        WorkflowService.reject(task, request.user, comment)
        return Response({"status": "rejected"})
