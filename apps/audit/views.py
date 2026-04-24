from rest_framework import generics, permissions
from django.db.models import Q
from .models import AuditLog
from .serializers import AuditLogSerializer
from django.utils.dateparse import parse_date
from apps.documents.models import Document


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


class MyActivityListView(generics.ListAPIView):
    serializer_class = AuditLogSerializer
    permission_classes = [permissions.IsAuthenticated]

    def get_queryset(self):
        user = self.request.user
        if user.has_admin_access:
            return AuditLog.objects.none()

        doc_ids = (
            Document.objects.filter(Q(uploaded_by=user) | Q(owned_by=user))
            .values_list("id", flat=True)
        )

        return (
            AuditLog.objects
            .filter(object_type="Document", object_id__in=doc_ids)
            .select_related("actor")
            .order_by("-timestamp")
        )
