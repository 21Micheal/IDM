import csv

from django.http import HttpResponse
from rest_framework import generics, permissions
from rest_framework.exceptions import PermissionDenied
from django.db.models import Q
from .models import AuditEvent, AuditLog, LOW_SIGNAL_AUDIT_EVENTS
from .serializers import AuditLogSerializer
from django.utils.dateparse import parse_date
from apps.documents.models import Document
from apps.workflows.models import WorkflowTask


class AuditLogListView(generics.ListAPIView):
    serializer_class = AuditLogSerializer
    permission_classes = [permissions.IsAuthenticated]

    def get_queryset(self):
        user = self.request.user
        if not user.has_admin_access:
            return AuditLog.objects.none()

        qs = AuditLog.objects.all().select_related('actor')

        # Advanced search (actor email, object_repr, event)
        search = self.request.query_params.get('search')
        if search:
            qs = qs.filter(
                Q(actor__email__icontains=search) |
                Q(object_repr__icontains=search) |
                Q(event__icontains=search)
            )

        # Event filter
        event = self.request.query_params.get('event')
        if event:
            qs = qs.filter(event=event)

        # Date range filters
        date_from = self.request.query_params.get('date_from')
        date_to = self.request.query_params.get('date_to')

        if date_from:
            parsed = parse_date(date_from)
            if parsed:
                qs = qs.filter(timestamp__date__gte=parsed)

        if date_to:
            parsed = parse_date(date_to)
            if parsed:
                qs = qs.filter(timestamp__date__lte=parsed)

        return qs.order_by('-timestamp')


class AuditLogExportView(AuditLogListView):
    pagination_class = None

    def get(self, request, *args, **kwargs):
        if not request.user.has_admin_access:
            raise PermissionDenied("Only administrators can export the audit log.")

        qs = self.filter_queryset(self.get_queryset())
        response = HttpResponse(content_type="text/csv")
        response["Content-Disposition"] = 'attachment; filename="audit-trail.csv"'
        writer = csv.writer(response)
        writer.writerow([
            "timestamp",
            "event",
            "actor_name",
            "actor_email",
            "object_type",
            "object_id",
            "object_repr",
            "ip_address",
            "changes",
        ])
        for log in qs.iterator():
            actor_name = log.actor.get_full_name() if log.actor else ""
            writer.writerow([
                log.timestamp.isoformat(),
                log.event,
                actor_name,
                log.actor.email if log.actor else "",
                log.object_type,
                log.object_id,
                log.object_repr,
                log.ip_address or "",
                log.changes,
            ])

        AuditLog.objects.create(
            event=AuditEvent.AUDIT_EXPORTED,
            actor=request.user,
            object_type="AuditLog",
            object_repr="Audit trail CSV",
            changes={
                "filters": {
                    key: request.query_params.get(key)
                    for key in ("search", "event", "date_from", "date_to")
                    if request.query_params.get(key)
                },
                "row_count": qs.count(),
            },
            ip_address=request.META.get("REMOTE_ADDR"),
            user_agent=request.META.get("HTTP_USER_AGENT", "")[:500],
        )
        return response


class MyActivityListView(generics.ListAPIView):
    serializer_class = AuditLogSerializer
    permission_classes = [permissions.IsAuthenticated]

    def get_queryset(self):
        user = self.request.user
        if user.has_admin_access:
            return AuditLog.objects.none()

        doc_ids = list(
            Document.objects.filter(Q(uploaded_by=user) | Q(owned_by=user))
            .values_list("id", flat=True)
        )
        task_doc_ids = list(
            WorkflowTask.objects.filter(assigned_to=user)
            .values_list("workflow_instance__document_id", flat=True)
        )

        tracked_doc_ids = [str(doc_id) for doc_id in set(doc_ids + task_doc_ids)]
        if not tracked_doc_ids:
            return AuditLog.objects.none()

        return (
            AuditLog.objects
            .filter(
                Q(object_type="Document", object_id__in=tracked_doc_ids)
            )
            .exclude(actor=user)
            .exclude(event__in=LOW_SIGNAL_AUDIT_EVENTS)
            .select_related("actor")
            .order_by("-timestamp")
        )
