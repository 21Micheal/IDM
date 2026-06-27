"""
apps/documents/mailbox_views.py

Admin API for ingesting documents from an IMAP mailbox into this DMS.

Endpoints (all admin-only), mounted under ``/documents/mailboxes/``:

    GET    mailboxes/                      list mailboxes
    POST   mailboxes/                      create a mailbox
    GET    mailboxes/{id}/                 mailbox detail (incl. recent emails)
    PATCH  mailboxes/{id}/                 update a mailbox
    DELETE mailboxes/{id}/                 delete a mailbox
    GET    mailboxes/{id}/status/          lightweight poll (counters + status)
    POST   mailboxes/{id}/poll/            queue an immediate poll
    POST   mailboxes/test_connection/      validate IMAP credentials without saving
    GET    mailboxes/connection_defaults/  env-configured IMAP defaults (redacted)

The connection secret (``password``) is write-only: it is accepted on
create/update but never returned. ``has_password`` tells the UI whether a
secret is already stored so it can show "configured" without leaking the value.
This mirrors :mod:`apps.documents.migration_views`.
"""
from __future__ import annotations

import logging

from rest_framework import permissions, serializers, status, viewsets
from rest_framework.decorators import action
from rest_framework.response import Response

from .imap_client import (
    IMAPClient,
    IMAPConfig,
    IMAPError,
    default_connection_from_settings,
    merge_connection_with_defaults,
)
from .graph_client import (
    GraphClient,
    GraphConfig,
    GraphError,
    default_connection_from_settings as graph_default_connection,
    merge_connection_with_defaults as graph_merge_connection,
)
from .models import DocumentType, IngestedEmail, Mailbox, MailboxPollStatus

logger = logging.getLogger(__name__)

# Connection keys whose values must never be sent back to the browser
# (IMAP password + Graph client secret).
SECRET_CONNECTION_KEYS = ("password", "client_secret")


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


class MailboxConnectionTestSerializer(serializers.Serializer):
    """Validates an ad-hoc connection blob for the test-connection action."""

    connection = serializers.DictField(child=serializers.JSONField(), required=False)
    protocol = serializers.ChoiceField(
        choices=Mailbox.Protocol.choices, required=False, default=Mailbox.Protocol.IMAP
    )


class IngestedEmailSerializer(serializers.ModelSerializer):
    class Meta:
        model = IngestedEmail
        fields = [
            "id", "message_id", "imap_uid", "sender", "subject", "received_at",
            "status", "attachment_count", "documents_created", "detail",
            "bulk_upload", "created_at",
        ]


class MailboxSerializer(serializers.ModelSerializer):
    default_document_type = serializers.PrimaryKeyRelatedField(
        queryset=DocumentType.objects.all(),
        required=False,
        allow_null=True,
    )
    default_document_type_name = serializers.CharField(
        source="default_document_type.name", read_only=True, default=None
    )
    created_by_name = serializers.CharField(
        source="created_by.get_full_name", read_only=True, default=None
    )
    has_password = serializers.SerializerMethodField()
    recent_emails = serializers.SerializerMethodField()
    email_counts = serializers.SerializerMethodField()

    class Meta:
        model = Mailbox
        fields = [
            "id", "name", "protocol", "connection",
            "default_document_type", "default_document_type_name",
            "auto_classify", "sender_supplier_map", "sender_allowlist",
            "allowed_attachment_extensions",
            "related_set_attachments", "ingest_history", "ingest_since",
            "max_messages_per_poll", "is_active",
            "poll_status", "last_polled_at", "last_error", "consecutive_failures",
            "last_seen_uid", "last_seen_cursor",
            "last_imported_count", "last_skipped_count", "last_failed_count",
            "created_by", "created_by_name", "created_at", "updated_at",
            "has_password", "recent_emails", "email_counts",
        ]
        read_only_fields = [
            "poll_status", "last_polled_at", "last_error", "consecutive_failures",
            "last_seen_uid", "last_seen_cursor",
            "last_imported_count", "last_skipped_count", "last_failed_count",
            "created_by", "created_at", "updated_at",
        ]

    def _is_list(self) -> bool:
        view = self.context.get("view")
        return bool(view and getattr(view, "action", None) == "list")

    def get_email_counts(self, obj):
        # Detail view only — keep list payloads light.
        if self._is_list():
            return None
        from django.db.models import Count

        rows = obj.ingested_emails.values("status").annotate(n=Count("id"))
        counts = {r["status"]: r["n"] for r in rows}
        return {
            "imported": counts.get("imported", 0),
            "partial": counts.get("partial", 0),
            "skipped": counts.get("skipped", 0),
            "failed": counts.get("failed", 0),
            "total": sum(counts.values()),
        }

    def get_has_password(self, obj) -> bool:
        # The stored secret is the IMAP password or the Graph client secret.
        conn = obj.connection or {}
        return bool(conn.get("password") or conn.get("client_secret"))

    def get_recent_emails(self, obj):
        # Detail view only — keep list payloads light.
        if self.context.get("view") and getattr(self.context["view"], "action", None) == "list":
            return None
        emails = obj.ingested_emails.all()[:25]
        return IngestedEmailSerializer(emails, many=True).data

    def to_representation(self, instance):
        data = super().to_representation(instance)
        data["connection"] = _redact_connection(instance.connection)
        return data

    def _merge_secret_preserving(self, instance, connection: dict | None) -> dict:
        """When updating, keep stored secrets if the client omits them.

        The UI never receives the password, so a plain PATCH would otherwise
        wipe it. Any secret key absent or blank in the incoming payload is
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


class MailboxListSerializer(serializers.ModelSerializer):
    """Lightweight list/poll payload."""

    default_document_type_name = serializers.CharField(
        source="default_document_type.name", read_only=True, default=None
    )

    class Meta:
        model = Mailbox
        fields = [
            "id", "name", "protocol", "is_active", "auto_classify", "related_set_attachments",
            "default_document_type", "default_document_type_name",
            "poll_status", "last_polled_at", "last_error",
            "last_imported_count", "last_skipped_count", "last_failed_count",
            "created_at", "updated_at",
        ]


class MailboxViewSet(viewsets.ModelViewSet):
    """CRUD + poll/test for IMAP ingestion mailboxes."""

    permission_classes = [IsAdminAccess]
    queryset = Mailbox.objects.select_related(
        "default_document_type", "created_by"
    ).all()

    def get_serializer_class(self):
        if self.action == "list":
            return MailboxListSerializer
        return MailboxSerializer

    @action(detail=False, methods=["get"], url_path="connection_defaults")
    def connection_defaults(self, request):
        """Return env-configured connection defaults (secrets redacted) for prefill.

        Protocol-aware via ``?protocol=graph`` (defaults to IMAP).
        """
        protocol = request.query_params.get("protocol", Mailbox.Protocol.IMAP)
        if protocol == Mailbox.Protocol.GRAPH:
            defaults = graph_default_connection()
            has_secret = bool(defaults.get("client_secret"))
        else:
            defaults = default_connection_from_settings()
            has_secret = bool(defaults.get("password"))
        return Response({
            "connection": _redact_connection(defaults),
            "has_password": has_secret,
        })

    @action(detail=False, methods=["post"], url_path="test_connection")
    def test_connection(self, request):
        """Validate mailbox credentials without saving (IMAP login / Graph token)."""
        serializer = MailboxConnectionTestSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        raw_connection = serializer.validated_data.get("connection")
        protocol = serializer.validated_data.get("protocol", Mailbox.Protocol.IMAP)
        try:
            if protocol == Mailbox.Protocol.GRAPH:
                client = GraphClient(
                    GraphConfig.from_mapping(graph_merge_connection(raw_connection))
                )
                result = client.test_connection()
            else:
                client = IMAPClient(
                    IMAPConfig.from_mapping(merge_connection_with_defaults(raw_connection))
                )
                result = client.test_connection()
        except (IMAPError, GraphError) as exc:
            return Response(
                {"ok": False, "detail": str(exc)},
                status=status.HTTP_400_BAD_REQUEST,
            )
        return Response(result)

    @action(detail=True, methods=["post"])
    def poll(self, request, pk=None):
        """Queue an immediate poll of this mailbox."""
        mailbox = self.get_object()
        if mailbox.poll_status == MailboxPollStatus.POLLING:
            return Response(
                {"detail": "Mailbox is already polling."},
                status=status.HTTP_400_BAD_REQUEST,
            )

        mailbox.poll_status = MailboxPollStatus.POLLING
        mailbox.last_error = ""
        mailbox.save(update_fields=["poll_status", "last_error", "updated_at"])

        from .tasks import poll_mailbox
        poll_mailbox.delay(str(mailbox.id))

        serializer = MailboxSerializer(mailbox, context={"request": request, "view": self})
        return Response(serializer.data, status=status.HTTP_202_ACCEPTED)

    @action(detail=True, methods=["get"])
    def status(self, request, pk=None):
        """Lightweight poll endpoint for progress."""
        mailbox = self.get_object()
        serializer = MailboxListSerializer(mailbox, context={"request": request})
        return Response(serializer.data)

    @action(detail=False, methods=["get"])
    def stats(self, request):
        """Operational dashboard data: ingestion volume over time + per-mailbox.

        ``?days=N`` (default 30, capped 365) sets the window for the daily series.
        """
        from datetime import timedelta

        from django.db.models import Count, Q, Sum
        from django.db.models.functions import TruncDate
        from django.utils import timezone

        try:
            days = min(max(int(request.query_params.get("days", 30)), 1), 365)
        except (TypeError, ValueError):
            days = 30
        since = timezone.now() - timedelta(days=days)

        emails = IngestedEmail.objects.filter(created_at__gte=since)

        # ── daily series (imported = imported+partial) ───────────────────────
        rows = (
            emails.annotate(day=TruncDate("created_at"))
            .values("day", "status")
            .annotate(n=Count("id"))
        )
        by_day: dict = {}
        for r in rows:
            bucket = by_day.setdefault(r["day"], {"imported": 0, "skipped": 0, "failed": 0})
            status_key = r["status"]
            if status_key in ("imported", "partial"):
                bucket["imported"] += r["n"]
            elif status_key == "skipped":
                bucket["skipped"] += r["n"]
            else:
                bucket["failed"] += r["n"]

        today = timezone.now().date()
        daily = []
        for i in range(days):
            d = today - timedelta(days=days - 1 - i)
            b = by_day.get(d, {"imported": 0, "skipped": 0, "failed": 0})
            daily.append({"date": d.isoformat(), **b})

        # ── totals ───────────────────────────────────────────────────────────
        documents = emails.aggregate(n=Sum("documents_created"))["n"] or 0
        totals = {
            "imported": sum(x["imported"] for x in daily),
            "skipped": sum(x["skipped"] for x in daily),
            "failed": sum(x["failed"] for x in daily),
            "documents": documents,
        }
        totals["total"] = totals["imported"] + totals["skipped"] + totals["failed"]

        # ── per-mailbox summary ──────────────────────────────────────────────
        per = (
            emails.values("mailbox_id")
            .annotate(
                imported=Count("id", filter=Q(status__in=["imported", "partial"])),
                skipped=Count("id", filter=Q(status="skipped")),
                failed=Count("id", filter=Q(status="failed")),
                documents=Sum("documents_created"),
            )
        )
        per_map = {row["mailbox_id"]: row for row in per}
        mailboxes = []
        for mb in Mailbox.objects.all().order_by("name"):
            row = per_map.get(mb.id, {})
            mailboxes.append({
                "id": str(mb.id),
                "name": mb.name,
                "protocol": mb.protocol,
                "poll_status": mb.poll_status,
                "is_active": mb.is_active,
                "consecutive_failures": mb.consecutive_failures,
                "last_polled_at": mb.last_polled_at.isoformat() if mb.last_polled_at else None,
                "imported": row.get("imported", 0),
                "skipped": row.get("skipped", 0),
                "failed": row.get("failed", 0),
                "documents": row.get("documents") or 0,
            })

        return Response({"days": days, "daily": daily, "totals": totals, "mailboxes": mailboxes})
