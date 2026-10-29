import csv
import json
from io import BytesIO

from django.http import HttpResponse
from django.db.models import Q
from rest_framework import generics, permissions
from rest_framework.exceptions import PermissionDenied
from rest_framework.response import Response
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
        if not user.can_view_system_audit:
            return AuditLog.objects.none()

        qs = AuditLog.objects.all().select_related('actor')

        # Advanced search (actor email, object_repr, event)
        search = self.request.query_params.get('search')
        if search:
            qs = qs.filter(
                Q(actor__email__icontains=search) |
                Q(actor__first_name__icontains=search) |
                Q(actor__last_name__icontains=search) |
                Q(object_repr__icontains=search) |
                Q(event__icontains=search)
            )

        actor = self.request.query_params.get("actor")
        if actor:
            qs = qs.filter(
                Q(actor__email__icontains=actor)
                | Q(actor__first_name__icontains=actor)
                | Q(actor__last_name__icontains=actor)
            )

        # Filter to one requisition by its user-facing reference. The detail
        # page's Audit tab uses the same document-linked, curated event set.
        form_reference = (self.request.query_params.get("form_reference") or "").strip()
        if form_reference:
            document = Document.objects.filter(
                reference_number__iexact=form_reference,
                metadata__form__workflow_type__iexact="requisition",
            ).only("id").first()
            if document:
                qs = qs.filter(
                    object_type="Document",
                    object_id=str(document.pk),
                ).exclude(event__in=LOW_SIGNAL_AUDIT_EVENTS)
            else:
                qs = qs.none()

        object_type = self.request.query_params.get("object_type")
        if object_type:
            qs = qs.filter(object_type=object_type)

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

    def list(self, request, *args, **kwargs):
        response = super().list(request, *args, **kwargs)
        if request.user.can_view_system_audit and isinstance(response.data, dict):
            qs = self.filter_queryset(self.get_queryset())
            requisition_ids = Document.objects.filter(
                metadata__form__workflow_type__iexact="requisition",
            ).values_list("id", flat=True)
            form_events = qs.filter(
                object_type="Document",
                object_id__in=[str(document_id) for document_id in requisition_ids],
            )
            response.data["summary"] = {
                "forms_affected": form_events
                .values("object_id").distinct().count(),
                "submissions": form_events.filter(event=AuditEvent.DOCUMENT_SUBMITTED).count(),
                "approvals": form_events.filter(event=AuditEvent.WORKFLOW_APPROVED).count(),
                "returns": form_events.filter(event=AuditEvent.WORKFLOW_RETURNED).count(),
                "rejections": form_events.filter(event=AuditEvent.WORKFLOW_REJECTED).count(),
            }
        return response


class AuditLogExportView(AuditLogListView):
    pagination_class = None

    def get(self, request, *args, **kwargs):
        if not request.user.can_view_system_audit:
            raise PermissionDenied("You do not have permission to export the system audit log.")

        qs = self.filter_queryset(self.get_queryset())
        headers = [
            "timestamp",
            "event",
            "summary",
            "actor_name",
            "actor_email",
            "actor_job_description",
            "object_type",
            "object_id",
            "object_repr",
            "ip_address",
            "changes",
        ]
        # `format` is reserved by Django REST Framework for renderer
        # negotiation; an unsupported renderer such as `xlsx` yields a 404
        # before this view runs. Use a distinct query parameter instead.
        export_format = request.query_params.get("file_format", "csv").lower()
        if export_format not in {"csv", "xlsx"}:
            return Response({"detail": "format must be csv or xlsx."}, status=400)

        if export_format == "xlsx":
            from openpyxl import Workbook

            workbook = Workbook(write_only=True)
            sheet = workbook.create_sheet("Audit Trail")
            sheet.append(headers)
            for log in qs.iterator():
                actor_name = log.actor.get_full_name() if log.actor else "System"
                sheet.append([
                    log.timestamp.isoformat(), log.event,
                    AuditLogSerializer(log).data.get("summary", ""),
                    actor_name, log.actor.email if log.actor else "",
                    log.actor.job_description if log.actor else "",
                    log.object_type, log.object_id, log.object_repr,
                    log.ip_address or "",
                    json.dumps(log.changes, ensure_ascii=False, default=str),
                ])
            output = BytesIO()
            workbook.save(output)
            response = HttpResponse(
                output.getvalue(),
                content_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            )
            response["Content-Disposition"] = 'attachment; filename="audit-trail.xlsx"'
        else:
            response = HttpResponse(content_type="text/csv; charset=utf-8")
            response["Content-Disposition"] = 'attachment; filename="audit-trail.csv"'
            writer = csv.writer(response)
            writer.writerow(headers)
            for log in qs.iterator():
                actor_name = log.actor.get_full_name() if log.actor else "System"
                writer.writerow([
                    log.timestamp.isoformat(),
                    log.event,
                    AuditLogSerializer(log).data.get("summary", ""),
                    actor_name,
                    log.actor.email if log.actor else "",
                    log.actor.job_description if log.actor else "",
                    log.object_type,
                    log.object_id,
                    log.object_repr,
                    log.ip_address or "",
                    json.dumps(log.changes, ensure_ascii=False, default=str),
                ])

        AuditLog.objects.create(
            event=AuditEvent.AUDIT_EXPORTED,
            actor=request.user,
            object_type="AuditLog",
            object_repr=f"Audit trail report ({export_format.upper()})",
            changes={
                "format": export_format,
                "filters": {
                    key: request.query_params.get(key)
                    for key in ("search", "actor", "event", "form_reference", "date_from", "date_to")
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
        if user.can_view_system_audit:
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
