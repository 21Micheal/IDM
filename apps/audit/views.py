from rest_framework import generics, permissions
from .models import AuditLog
from .serializers import AuditLogSerializer
from apps.accounts.models import Role

class AuditLogListView(generics.ListAPIView):
    serializer_class = AuditLogSerializer
    permission_classes = [permissions.IsAuthenticated]

    def get_queryset(self):
        user = self.request.user
        if user.role not in (Role.ADMIN, Role.AUDITOR):
            return AuditLog.objects.none()
        qs = AuditLog.objects.all()
        event = self.request.query_params.get("event")
        if event:
            qs = qs.filter(event=event)
        return qs
