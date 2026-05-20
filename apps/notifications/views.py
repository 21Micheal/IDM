from django.db.models import QuerySet
from rest_framework import mixins, permissions, serializers, status, viewsets
from rest_framework.decorators import action
from rest_framework.response import Response

from .models import Notification

class NotificationSerializer(serializers.ModelSerializer):
    class Meta:
        model = Notification
        fields = ["id", "type", "message", "link", "is_read", "created_at"]
        read_only_fields = ["id", "type", "message", "link", "created_at"]


class NotificationViewSet(
    mixins.ListModelMixin,
    mixins.RetrieveModelMixin,
    mixins.UpdateModelMixin,
    viewsets.GenericViewSet,
):
    serializer_class = NotificationSerializer
    permission_classes = [permissions.IsAuthenticated]
    http_method_names = ["get", "patch", "post", "head", "options"]

    def get_queryset(self) -> QuerySet[Notification]:
        qs = Notification.objects.filter(recipient=self.request.user)
        is_read = self.request.query_params.get("is_read")
        if is_read is not None:
            parsed = _parse_bool(is_read)
            if parsed is not None:
                qs = qs.filter(is_read=parsed)
        return qs

    def partial_update(self, request, *args, **kwargs):
        unknown_fields = set(request.data) - {"is_read"}
        if unknown_fields:
            return Response(
                {"detail": "Only is_read can be updated."},
                status=status.HTTP_400_BAD_REQUEST,
            )
        return super().partial_update(request, *args, **kwargs)

    def create(self, request, *args, **kwargs):
        return Response(
            {"detail": "Notifications are created by the system."},
            status=status.HTTP_405_METHOD_NOT_ALLOWED,
        )

    @action(detail=False, methods=["post"])
    def mark_all_read(self, request):
        updated = self.get_queryset().filter(is_read=False).update(is_read=True)
        return Response({
            "detail": "All notifications marked read.",
            "updated": updated,
        })

    @action(detail=False, methods=["get"])
    def unread_count(self, request):
        return Response({"unread_count": self.get_queryset().filter(is_read=False).count()})


def _parse_bool(value: str) -> bool | None:
    normalized = str(value).strip().lower()
    if normalized in {"true", "1", "yes", "y", "on"}:
        return True
    if normalized in {"false", "0", "no", "n", "off"}:
        return False
    return None
