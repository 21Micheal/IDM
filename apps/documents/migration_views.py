"""
apps/documents/migration_views.py

Admin API for migrating documents from Infor IDM into this DMS.

Endpoints (all admin-only), mounted under ``/documents/migrations/``:

    GET    migrations/                     list jobs
    POST   migrations/                     create a job (draft)
    GET    migrations/{id}/                job detail (incl. log)
    GET    migrations/{id}/status/         lightweight poll (counters + status)
    DELETE migrations/{id}/                delete a job
    POST   migrations/{id}/run/            queue the job for background execution
    POST   migrations/test_connection/     validate ION credentials without saving
    GET    migrations/connection_defaults/ env-configured ION defaults (redacted)

The connection secrets (``client_secret``/``sask``) are write-only: they are
accepted on create/update but never returned. ``has_*`` booleans tell the UI
whether a secret is already stored so it can show "configured" without leaking
the value.
"""
from __future__ import annotations

import logging

from rest_framework import permissions, serializers, status, viewsets
from rest_framework.decorators import action
from rest_framework.response import Response

from .ion_client import (
    IONClient,
    IONConfig,
    IONError,
    default_connection_from_settings,
    merge_connection_with_defaults,
)
from .models import DocumentType, MigrationJob, MigrationJobStatus

logger = logging.getLogger(__name__)

# Connection keys whose values must never be sent back to the browser.
SECRET_CONNECTION_KEYS = ("client_secret", "sask", "password")


def _redact_connection(connection: dict | None) -> dict:
    """Return a copy of the connection with secret values stripped."""
    safe = dict(connection or {})
    for key in SECRET_CONNECTION_KEYS:
        safe.pop(key, None)
    return safe


class IsAdminAccess(permissions.BasePermission):
    """Allow only users with administrative access (mirrors RequireAdmin)."""

    def has_permission(self, request, view):
        return bool(
            request.user
            and request.user.is_authenticated
            and getattr(request.user, "has_admin_access", False)
        )


class MigrationConnectionTestSerializer(serializers.Serializer):
    """Validates an ad-hoc connection blob for the test-connection action."""

    connection = serializers.DictField(child=serializers.JSONField(), required=False)


class MigrationJobSerializer(serializers.ModelSerializer):
    target_document_type = serializers.PrimaryKeyRelatedField(
        queryset=DocumentType.objects.all(),
        required=False,
        allow_null=True,
    )
    target_document_type_name = serializers.CharField(
        source="target_document_type.name", read_only=True, default=None
    )
    created_by_name = serializers.CharField(
        source="created_by.get_full_name", read_only=True, default=None
    )
    has_client_secret = serializers.SerializerMethodField()
    has_sask = serializers.SerializerMethodField()

    class Meta:
        model = MigrationJob
        fields = [
            "id", "name", "connection", "source_query",
            "target_document_type", "target_document_type_name",
            "include_attributes", "max_documents",
            "status", "total_items", "processed_items", "succeeded_items",
            "failed_items", "skipped_items", "log", "error",
            "created_by", "created_by_name",
            "created_at", "updated_at", "started_at", "finished_at",
            "has_client_secret", "has_sask",
        ]
        read_only_fields = [
            "status", "total_items", "processed_items", "succeeded_items",
            "failed_items", "skipped_items", "log", "error",
            "created_by", "created_at", "updated_at", "started_at", "finished_at",
        ]

    def get_has_client_secret(self, obj) -> bool:
        return bool((obj.connection or {}).get("client_secret"))

    def get_has_sask(self, obj) -> bool:
        return bool((obj.connection or {}).get("sask"))

    def to_representation(self, instance):
        data = super().to_representation(instance)
        data["connection"] = _redact_connection(instance.connection)
        return data

    def _merge_secret_preserving(self, instance, connection: dict | None) -> dict:
        """When updating, keep stored secrets if the client omits them.

        The UI never receives secrets, so a plain PATCH would otherwise wipe
        them. Any secret key absent or blank in the incoming payload is
        back-filled from the stored connection.
        """
        incoming = dict(connection or {})
        stored = dict((instance.connection if instance else {}) or {})
        for key in SECRET_CONNECTION_KEYS:
            if not incoming.get(key) and stored.get(key):
                incoming[key] = stored[key]
        return incoming

    def create(self, validated_data):
        validated_data["created_by"] = self.context["request"].user
        return super().create(validated_data)

    def update(self, instance, validated_data):
        if "connection" in validated_data:
            validated_data["connection"] = self._merge_secret_preserving(
                instance, validated_data["connection"]
            )
        return super().update(instance, validated_data)


class MigrationJobListSerializer(serializers.ModelSerializer):
    """Lightweight list/poll payload — omits the (potentially large) log."""

    target_document_type_name = serializers.CharField(
        source="target_document_type.name", read_only=True, default=None
    )

    class Meta:
        model = MigrationJob
        fields = [
            "id", "name", "status", "source_query",
            "target_document_type", "target_document_type_name",
            "include_attributes", "max_documents",
            "total_items", "processed_items", "succeeded_items",
            "failed_items", "skipped_items",
            "created_at", "updated_at", "started_at", "finished_at",
        ]


class MigrationJobViewSet(viewsets.ModelViewSet):
    """CRUD + run/test for Infor IDM migration jobs."""

    permission_classes = [IsAdminAccess]
    queryset = MigrationJob.objects.select_related(
        "target_document_type", "created_by"
    ).all()

    def get_serializer_class(self):
        if self.action == "list":
            return MigrationJobListSerializer
        return MigrationJobSerializer

    @action(detail=False, methods=["get"], url_path="connection_defaults")
    def connection_defaults(self, request):
        """Return env-configured ION defaults (secrets redacted) for prefill."""
        defaults = default_connection_from_settings()
        return Response({
            "connection": _redact_connection(defaults),
            "has_client_secret": bool(defaults.get("client_secret")),
            "has_sask": bool(defaults.get("sask")),
        })

    @action(detail=False, methods=["post"], url_path="test_connection")
    def test_connection(self, request):
        """Validate ION credentials by acquiring a token. Saves nothing."""
        serializer = MigrationConnectionTestSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        connection = merge_connection_with_defaults(
            serializer.validated_data.get("connection")
        )
        try:
            client = IONClient(IONConfig.from_mapping(connection))
            result = client.test_connection()
        except IONError as exc:
            return Response(
                {"ok": False, "detail": str(exc)},
                status=status.HTTP_400_BAD_REQUEST,
            )
        return Response(result)

    @action(detail=True, methods=["post"])
    def run(self, request, pk=None):
        """Queue the job for background execution."""
        job = self.get_object()
        if job.status in (MigrationJobStatus.QUEUED, MigrationJobStatus.RUNNING):
            return Response(
                {"detail": f"Job is already {job.status}."},
                status=status.HTTP_400_BAD_REQUEST,
            )
        if job.target_document_type_id is None:
            return Response(
                {"detail": "Select a target document type before running."},
                status=status.HTTP_400_BAD_REQUEST,
            )

        job.status = MigrationJobStatus.QUEUED
        job.error = ""
        job.save(update_fields=["status", "error", "updated_at"])

        from .tasks import run_migration_job
        run_migration_job.delay(str(job.id))

        serializer = MigrationJobSerializer(job, context={"request": request})
        return Response(serializer.data, status=status.HTTP_202_ACCEPTED)

    @action(detail=True, methods=["get"])
    def status(self, request, pk=None):
        """Lightweight poll endpoint for progress."""
        job = self.get_object()
        serializer = MigrationJobListSerializer(job, context={"request": request})
        return Response(serializer.data)
