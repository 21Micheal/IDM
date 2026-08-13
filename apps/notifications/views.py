from django.db.models import QuerySet
from rest_framework import mixins, permissions, serializers, status, viewsets
from rest_framework.decorators import action
from rest_framework.response import Response

from .models import Notification

# Notification types that represent workflow tasks. These are surfaced under the
# task badge rather than the general "notices" bell count.
TASK_NOTIFICATION_TYPES = ("task_assigned", "task_sla_warning", "task_overdue")


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

    @action(detail=False, methods=["get"])
    def summary(self, request):
        """Consolidated badge counts for the app shell — one cheap request that
        replaces separate polls for unread notifications, workflow tasks and
        incoming signature requests. Every value is an indexed COUNT, so this is
        far lighter than fetching and serializing the rows just to size a badge
        (and, unlike the old client-side count, it is not capped at one page).
        """
        # Local imports keep this cross-app action free of import-time cycles.
        from apps.documents.models import SignatureRequest, SignatureRequestSigner
        from apps.documents.review_queue import pending_review_count_for
        from apps.accounts.delegation import tasks_visible_to_user

        user = request.user
        base = Notification.objects.filter(recipient=user, is_read=False)
        # Task-type notifications surface under the task badge, not the bell's
        # "notices" count — mirror the split the client used to do by hand.
        unread_task_alerts = base.filter(type__in=TASK_NOTIFICATION_TYPES).count()
        unread_notifications = base.count() - unread_task_alerts

        pending_tasks = tasks_visible_to_user(user).count()
        pending_reviews = pending_review_count_for(user)

        incoming_signatures = (
            SignatureRequest.objects.filter(
                signers__signer=user,
                signers__status=SignatureRequestSigner.Status.PENDING,
                status=SignatureRequest.Status.PENDING,
            )
            .distinct()
            .count()
        )

        return Response(
            {
                "unread_notifications": unread_notifications,
                "unread_task_alerts": unread_task_alerts,
                "pending_tasks": pending_tasks,
                "pending_reviews": pending_reviews,
                "incoming_signatures": incoming_signatures,
            }
        )


def _parse_bool(value: str) -> bool | None:
    normalized = str(value).strip().lower()
    if normalized in {"true", "1", "yes", "y", "on"}:
        return True
    if normalized in {"false", "0", "no", "n", "off"}:
        return False
    return None
