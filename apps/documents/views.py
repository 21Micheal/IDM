import hashlib
import io
import logging
import mimetypes
import secrets
import zipfile
from urllib.parse import quote as urlquote, urlparse, urlunparse

from django.core.mail import EmailMessage
from django.core.files.base import ContentFile
from django.core.files.storage import default_storage
from django.core.exceptions import ValidationError
from django.http import HttpResponse
from django.utils import timezone
from django.db import transaction, models
from django.db.models import Count, Value
from django.db.models.functions import TruncMonth, Concat
from django.conf import settings

from django.core.cache import cache
from django.shortcuts import get_object_or_404
from django_filters.rest_framework import DjangoFilterBackend
from rest_framework import viewsets, status, permissions
from rest_framework.decorators import action
from rest_framework.filters import SearchFilter, OrderingFilter
from rest_framework.views import APIView
from rest_framework.pagination import PageNumberPagination
from rest_framework.parsers import MultiPartParser, FormParser, JSONParser
from rest_framework.response import Response
from rest_framework_simplejwt.tokens import AccessToken

from apps.accounts.views import IsGroupAdmin
from apps.documents.analytics import IsAnalyticsViewer

from .models import (
    Document,
    DocumentType,
    DocumentVersion,
    DocumentShare,
    DocumentRelationship,
    Mailbox,
    Tag,
    DocTypeColor,
    DMSSettings,
    DocumentStatus,
    PreviewStatus,
    SignatureRequestSigner,
)
from .serializers import (
    DocumentListSerializer, DocumentDetailSerializer,
    DocumentUploadSerializer, DocumentTypeSerializer, DocumentTypeWriteSerializer,
    DocumentVersionSerializer, DocumentCommentSerializer,
    DocumentMetadataEditSerializer, DocumentBulkActionSerializer,
    DocumentEmailSelectedSerializer, DocumentShareSelectedSerializer,
    DocumentRelationshipSerializer, DocumentRelationshipWriteSerializer,
    TagSerializer, DocTypeColorSerializer, DMSSettingsSerializer,
)
from apps.accounts.models import User
from apps.notifications.models import Notification
from .filters import DocumentFilter
from .permissions import HasDocumentPermission
from apps.audit.mixins import AuditMixin
from apps.audit.models import AuditEvent
from rest_framework_simplejwt.authentication import JWTAuthentication
from .authentication import DocumentFileSignatureAuthentication
from .file_streaming import (
    build_absolute_document_file_url,
    build_http_file_response,
    read_document_bytes,
    signed_file_urls_enabled,
    unsign_file_payload,
    user_can_download_document,
    user_can_edit_document,
    user_can_view_document,
    verify_file_query_matches_payload,
)

logger = logging.getLogger(__name__)

def _preview_error_cache_key(document_id: str) -> str:
    return f"document_preview_error:{document_id}"


def _preview_start_cache_key(document_id: str) -> str:
    """Cache key for the wall-clock time the preview task started processing.
    Stored by the task; read by trigger_preview for staleness detection.
    Using the cache (not updated_at) avoids the heartbeat defeating the check."""
    return f"document_preview_started_at:{document_id}"


def _version_preview_error_cache_key(version_id: str) -> str:
    return f"document_version_preview_error:{version_id}"


def _version_preview_start_cache_key(version_id: str) -> str:
    return f"document_version_preview_started_at:{version_id}"


def _version_preview_status_cache_key(version_id: str) -> str:
    return f"document_version_preview_status:{version_id}"


def _version_preview_processing_cache_key(version_id: str) -> str:
    return f"document_version_preview_processing:{version_id}"


def _version_preview_storage_name(version_id: str) -> str:
    return f"previews/versions/{version_id}_preview.pdf"


def _delete_storage_file(name: str) -> None:
    if not name:
        return
    try:
        from django.core.files.storage import default_storage
        if default_storage.exists(name):
            default_storage.delete(name)
    except Exception:
        logger.exception("_delete_storage_file: could not delete %s", name)


# ── Document Type ViewSet ─────────────────────────────────────────────────────

class DocumentTypeViewSet(AuditMixin, viewsets.ModelViewSet):
    queryset = DocumentType.objects.prefetch_related(
        "metadata_fields",
        "outgoing_relationship_rules",
        "outgoing_relationship_rules__target_document_type",
    ).filter(is_active=True).exclude(code__in=["PERSONAL", "UNCLASS"])

    def get_serializer_class(self):
        if self.action in ("create", "update", "partial_update"):
            return DocumentTypeWriteSerializer
        return DocumentTypeSerializer

    def get_permissions(self):
        if self.action in ("create", "update", "partial_update", "destroy"):
            return [permissions.IsAuthenticated(), IsGroupAdmin()]
        return [permissions.IsAuthenticated()]

    def perform_create(self, serializer):
        serializer.save(created_by=self.request.user)

    def create(self, request, *args, **kwargs):
        write_serializer = self.get_serializer(data=request.data)
        write_serializer.is_valid(raise_exception=True)
        instance = write_serializer.save(created_by=request.user)
        read_serializer = DocumentTypeSerializer(
            instance, context=self.get_serializer_context()
        )
        return Response(read_serializer.data, status=status.HTTP_201_CREATED)

    def update(self, request, *args, **kwargs):
        partial = kwargs.pop("partial", False)
        instance = self.get_object()
        write_serializer = self.get_serializer(instance, data=request.data, partial=partial)
        write_serializer.is_valid(raise_exception=True)
        instance = write_serializer.save()
        read_serializer = DocumentTypeSerializer(
            instance, context=self.get_serializer_context()
        )
        return Response(read_serializer.data)

    def perform_destroy(self, instance):
        instance.is_active = False
        instance.save(update_fields=["is_active"])

    @action(detail=True, methods=["post"], url_path="duplicate",
            permission_classes=[permissions.IsAuthenticated, IsGroupAdmin])
    def duplicate(self, request, pk=None):
        """
        Deep-clone a document type (metadata fields + relationship rules).

        Body (all optional):
            { "name": "…", "code": "…" }

        Returns the new DocumentType (HTTP 201).
        """
        import re

        source = self.get_object()

        # ── Derive defaults ──────────────────────────────────────────────────
        raw_name = (request.data.get("name") or "").strip()
        raw_code = (request.data.get("code") or "").strip().upper()

        new_name = raw_name or f"Copy of {source.name}"
        if not raw_code:
            base = re.sub(r"[^A-Z0-9]", "_", source.code.upper())
            new_code = (base + "_COPY")[:20]
        else:
            new_code = raw_code[:20]

        # ── Validate uniqueness ──────────────────────────────────────────────
        errors = {}
        if DocumentType.objects.filter(name=new_name, is_active=True).exists():
            errors["name"] = [f'A document type named "{new_name}" already exists.']
        if DocumentType.objects.filter(code=new_code, is_active=True).exists():
            errors["code"] = [f'The code "{new_code}" is already in use.']
        if errors:
            return Response(errors, status=status.HTTP_400_BAD_REQUEST)

        # ── Deep-clone inside a transaction ──────────────────────────────────
        from .models import MetadataField, DocumentRelationshipRule as RelRule

        with transaction.atomic():
            new_type = DocumentType.objects.create(
                name=new_name,
                code=new_code,
                description=source.description or "",
                reference_prefix=source.reference_prefix or new_code,
                reference_padding=source.reference_padding,
                title_field=source.title_field or "filename",
                is_personal_type=source.is_personal_type,
                metadata_mode=source.metadata_mode,
                is_active=True,
                created_by=request.user,
            )

            # Copy metadata fields
            src_fields = list(
                source.metadata_fields.all().order_by("order")
            )
            MetadataField.objects.bulk_create([
                MetadataField(
                    document_type=new_type,
                    label=f.label,
                    key=f.key,
                    field_type=f.field_type,
                    is_required=f.is_required,
                    help_text=f.help_text or "",
                    order=f.order,
                    select_options=list(f.select_options or []),
                )
                for f in src_fields
            ])

            # Copy relationship rules (keep the same target types)
            src_rules = list(
                source.outgoing_relationship_rules.all()
            )
            RelRule.objects.bulk_create([
                RelRule(
                    source_document_type=new_type,
                    target_document_type=r.target_document_type,
                    relation_type=r.relation_type,
                    source_field_key=r.source_field_key,
                    target_field_key=r.target_field_key,
                    match_operator=r.match_operator,
                    description=r.description or "",
                    is_active=r.is_active,
                    require_confirmation=r.require_confirmation,
                )
                for r in src_rules
            ])

        new_type.refresh_from_db()
        serializer = DocumentTypeSerializer(
            new_type, context=self.get_serializer_context()
        )
        return Response(serializer.data, status=status.HTTP_201_CREATED)


class DocumentVolumeView(APIView):
    """
    Groups Document uploads by month + document_type within the selected window.
    Months are year-safe ("Jan 2026") and zero-filled so the axis is continuous.
    Response shape: List[{ month, <DocType>: count, ... }]
    """
    permission_classes = [permissions.IsAuthenticated, IsAnalyticsViewer]

    def get(self, request):
        from apps.documents.analytics import (
            parse_analytics_filters, org_documents_qs, month_key, month_axis,
        )
        f = parse_analytics_filters(request)

        qs = (
            org_documents_qs(f)
            .filter(created_at__gte=f.start)
            .annotate(month=TruncMonth("created_at"))
            .values("month", type_name=models.F("document_type__name"))
            .annotate(count=Count("id"))
            .order_by("month", "type_name")
        )

        rows: dict[str, dict] = {label: {"month": label} for label in month_axis(f)}
        for row in qs:
            key = month_key(row["month"])
            rows.setdefault(key, {"month": key})
            rows[key][row["type_name"] or "Other"] = row["count"]

        return Response(list(rows.values()))


class TopUploadersView(APIView):
    """
    Ranks users by document upload count within the selected window.
    Response shape: List[{ name, department, count, approved, pending, rejected }]
    """
    permission_classes = [permissions.IsAuthenticated, IsAnalyticsViewer]

    def get(self, request):
        from apps.documents.analytics import parse_analytics_filters, org_documents_qs
        f = parse_analytics_filters(request)

        qs = (
            org_documents_qs(f)
            .filter(created_at__gte=f.start)
            .annotate(
                uploader_id=models.F("uploaded_by__id"),
                uploader_name=Concat(
                    models.F("uploaded_by__first_name"),
                    Value(" "),
                    models.F("uploaded_by__last_name"),
                ),
                department_name=models.F("uploaded_by__department__name"),
            )
            .values("uploader_id", "uploader_name", "department_name")
            .annotate(
                count=Count("id"),
                approved=Count("id", filter=models.Q(status="approved")),
                pending=Count("id", filter=models.Q(status="pending_approval")),
                rejected=Count("id", filter=models.Q(status="rejected")),
            )
            .order_by("-count")[:10]
        )

        data = [
            {
                "name":       (row.get("uploader_name") or "").strip() or "Unknown",
                "department": row.get("department_name") or "—",
                "count":      row.get("count"),
                "approved":   row.get("approved"),
                "pending":    row.get("pending"),
                "rejected":   row.get("rejected"),
            }
            for row in qs
        ]
        return Response(data)


class DocTypeColorView(APIView):
    """CRUD for persisted document-type colours.

    GET:  returns list of {doc_type, color}
    POST: accepts { mappings: [{doc_type, color}, ...] } to upsert mappings
    """
    permission_classes = [permissions.IsAuthenticated, IsGroupAdmin]

    def get(self, request):
        qs = DocTypeColor.objects.all().order_by("doc_type")
        serializer = DocTypeColorSerializer(qs, many=True)
        return Response(serializer.data)

    def post(self, request):
        mappings = request.data.get("mappings") or request.data
        if isinstance(mappings, dict):
            # convert dict {doc_type: color} -> list
            mappings = [{"doc_type": k, "color": v} for k, v in mappings.items()]

        created = []
        for item in mappings or []:
            doc_type = item.get("doc_type")
            color = item.get("color")
            if not doc_type or not color:
                continue
            obj, _ = DocTypeColor.objects.update_or_create(
                doc_type=doc_type,
                defaults={"color": color, "created_by": request.user},
            )
            created.append({"doc_type": obj.doc_type, "color": obj.color})

        return Response(created, status=status.HTTP_200_OK)


class DMSSettingsView(APIView):
    permission_classes = [permissions.IsAuthenticated]

    def get(self, request):
        settings_obj = DMSSettings.load()
        serializer = DMSSettingsSerializer(settings_obj)
        return Response(serializer.data)

    def patch(self, request):
        if not request.user.has_admin_access:
            return Response(
                {"detail": "Administrator access is required."},
                status=status.HTTP_403_FORBIDDEN,
            )
        settings_obj = DMSSettings.load()
        serializer = DMSSettingsSerializer(settings_obj, data=request.data, partial=True)
        serializer.is_valid(raise_exception=True)
        serializer.save(updated_by=request.user)
        return Response(serializer.data)


# ── Document ViewSet ──────────────────────────────────────────────────────────

class DocumentViewSet(AuditMixin, viewsets.ModelViewSet):
    permission_classes = [permissions.IsAuthenticated, HasDocumentPermission]
    filter_backends    = [DjangoFilterBackend, SearchFilter, OrderingFilter]
    filterset_class    = DocumentFilter
    search_fields      = ["title", "reference_number", "supplier", "extracted_text"]
    ordering_fields    = ["created_at", "updated_at", "document_date", "amount", "title", "reference_number"]
    ordering           = ["-created_at"]
    parser_classes     = [MultiPartParser, FormParser, JSONParser]

    def get_object(self):
        # Resolve a single document by id even when it is an UNCLASS draft that
        # listings hide. Object-level permission checks (and the involvement
        # scoping in get_queryset) still apply, so this only affects whether a
        # hidden-from-lists draft is reachable by direct id, not who may see it.
        self._include_unclassified = True
        try:
            return super().get_object()
        finally:
            self._include_unclassified = False

    def get_queryset(self):
        user = self.request.user
        qs   = (
            Document.objects
            .select_related(
                "document_type",
                "uploaded_by",
                "uploaded_by__department",
                "department",
                "edit_locked_by",
            )
            .prefetch_related("tags", "versions", "workflow_instance__tasks__step")
        )
        # UNCLASS placeholders are hidden from every listing, but single-object
        # lookups (retrieve/preview_url/file) opt in via get_object() so the
        # bulk-review screen can preview unreviewed email/scan drafts. Access is
        # still gated by the involvement filter below + object-level checks.
        if not getattr(self, "_include_unclassified", False):
            qs = qs.exclude(document_type__code="UNCLASS")
        # A "sees all documents" group (e.g. auditors) gets full visibility; what
        # they can DO is still governed by the object-level permission checks.
        if not user.has_admin_access and not user.sees_all_documents:
            active_shared_docs = DocumentShare.objects.filter(
                recipient=user,
                revoked_at__isnull=True,
            ).filter(
                models.Q(expires_at__isnull=True) | models.Q(expires_at__gt=timezone.now())
            ).values("document_id")

            # INVOLVEMENT: own docs, an ACTIVE workflow task (including delegated),
            # a PENDING signature assignment, or an active share. Both the task and
            # the signature assignment must be status-filtered — a WorkflowTask row
            # and a SignatureRequestSigner row both persist after being actioned,
            # they just change status, so an unfiltered join keeps granting visibility
            # forever after the action is complete.
            from apps.accounts.delegation import active_delegations_qs
            delegated_task_filter = models.Q()
            for delegation in active_delegations_qs(delegate=user):
                clause = models.Q(
                    workflow_instance__tasks__assigned_to_id=delegation.delegator_id,
                    workflow_instance__tasks__status__in=["in_progress", "held"],
                )
                if delegation.document_type_id:
                    clause &= models.Q(document_type_id=delegation.document_type_id)
                delegated_task_filter |= clause
            access_filter = (
                models.Q(uploaded_by=user) |
                models.Q(owned_by=user) |
                models.Q(
                    workflow_instance__tasks__assigned_to=user,
                    workflow_instance__tasks__status__in=["in_progress", "held"],
                ) |
                delegated_task_filter |
                models.Q(
                    signature_request__signers__signer=user,
                    signature_request__signers__status="pending",
                ) |
                models.Q(id__in=active_shared_docs)
            )

            # DEPARTMENT SCOPE: a department head (HOD) is involved with every
            # document in the department(s) they head.
            hod_department_ids = getattr(user, "hod_department_ids", set())
            if hod_department_ids:
                access_filter |= (
                    models.Q(department_id__in=hod_department_ids) |
                    models.Q(uploaded_by__department_id__in=hod_department_ids)
                )

            # Permanent view carve-out: someone who completed signing this
            # document keeps the ability to open it even after they otherwise drop
            # out of "involvement" — mirrors "you can always see what you signed".
            signed_document_ids = SignatureRequestSigner.objects.filter(
                signer=user,
                status=SignatureRequestSigner.Status.SIGNED,
            ).values("request__document_id")
            access_filter |= models.Q(id__in=signed_document_ids)

            # BATCH-REVIEWER CARVE-OUT: email-ingested documents are attributed to
            # the Email bot, not to the reviewing user, so a dedicated clause is
            # needed. Mirrors review_queue.reviewable_bulk_uploads_for() exactly:
            # explicit reviewer on the mailbox, fallback owner when no reviewers
            # are assigned, and admins see all email-ingested batches.
            from django.db.models import Count as _Count
            _unassigned_mailbox_ids = list(
                Mailbox.objects.annotate(_rc=_Count("reviewers"))
                .filter(_rc=0)
                .values_list("id", flat=True)
            )
            _batch_reviewer_filter = (
                models.Q(bulk_upload__ingested_emails__mailbox__reviewers=user)
                | (
                    models.Q(bulk_upload__ingested_emails__mailbox_id__in=_unassigned_mailbox_ids)
                    & models.Q(bulk_upload__ingested_emails__mailbox__created_by=user)
                )
            )
            if user.has_admin_access:
                # Admins already bypass this block entirely (outer if-branch),
                # but keep the guard symmetric for clarity.
                _batch_reviewer_filter |= models.Q(
                    bulk_upload__ingested_emails__isnull=False
                )
            access_filter |= _batch_reviewer_filter

            qs = qs.filter(access_filter).distinct()

        # Trash visibility: the list shows either live docs or Trash (?trash=true).
        # Detail/restore/purge actions can reach trashed docs so they remain operable.
        if self.action == "list":
            trash = str(self.request.query_params.get("trash", "")).lower() in ("true", "1", "yes")
            qs = qs.filter(deleted_at__isnull=not trash)
        return qs

    def get_serializer_class(self):
        if self.action == "list":
            return DocumentListSerializer
        if self.action == "create":
            return DocumentUploadSerializer
        return DocumentDetailSerializer

    def retrieve(self, request, *args, **kwargs):
        instance = self.get_object()
        self._prepare_builder_workflow_phase(instance)
        instance.refresh_from_db(fields=["metadata", "updated_at"])
        self.record_audit(AuditEvent.DOCUMENT_VIEWED, instance, {})
        serializer = self.get_serializer(instance)
        return Response(serializer.data)

    def _queue_office_preview(self, doc: Document) -> None:
        if not doc.is_office_doc():
            return
        try:
            from .tasks import generate_document_preview
            # PREVIEW-4 fix: use update()'s return value as the sole gate.
            # A return of 0 means another worker already claimed the row —
            # skip delay() entirely to prevent duplicate task delivery.
            updated = Document.objects.filter(
                id=doc.id,
                preview_status__in=["", PreviewStatus.FAILED],
            ).update(preview_status=PreviewStatus.PENDING)

            if updated:
                cache.delete(_preview_error_cache_key(str(doc.id)))
                cache.delete(_preview_start_cache_key(str(doc.id)))
                generate_document_preview.delay(str(doc.id))
        except Exception:
            logger.exception("_queue_office_preview: failed for doc=%s", doc.id)

    def _queue_office_version_preview(self, version: DocumentVersion) -> None:
        if not version.is_office_doc():
            return
        try:
            from .tasks import generate_document_version_preview
            version_id = str(version.id)
            status_key = _version_preview_status_cache_key(version_id)
            processing_key = _version_preview_processing_cache_key(version_id)
            start_key = _version_preview_start_cache_key(version_id)
            error_key = _version_preview_error_cache_key(version_id)
            preview_name = _version_preview_storage_name(version_id)
            current_status = cache.get(status_key)
            stale_after = int(getattr(settings, "PREVIEW_PROCESSING_STALE_SECONDS", 300))

            try:
                from django.core.files.storage import default_storage
                preview_exists = default_storage.exists(preview_name)
            except Exception:
                preview_exists = False

            if current_status == PreviewStatus.DONE and preview_exists:
                return

            if current_status == PreviewStatus.DONE and not preview_exists:
                cache.delete(status_key)
                current_status = None

            if current_status in (PreviewStatus.PENDING, PreviewStatus.PROCESSING):
                start_time = cache.get(start_key)
                if start_time is not None:
                    processing_age_s = max(0, int((timezone.now() - start_time).total_seconds()))
                else:
                    processing_age_s = stale_after + 1

                if processing_age_s < stale_after:
                    return

                cache.delete(processing_key)
                cache.delete(start_key)
                cache.delete(error_key)

            cache.set(status_key, PreviewStatus.PENDING, timeout=3600)
            generate_document_version_preview.delay(version_id)
        except Exception:
            logger.exception(
                "_queue_office_version_preview: failed for version=%s",
                version.id,
            )

    def create(self, request, *args, **kwargs):
        serializer = self.get_serializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        doc = serializer.save()
        self._queue_office_preview(doc)
        audit_changes = {}
        duplicate_source_id = getattr(doc, "_deduplicated_from_document_id", None)
        duplicate_source_reference = getattr(doc, "_deduplicated_from_reference", None)
        if duplicate_source_id:
            audit_changes["deduplicated"] = True
            audit_changes["linked_to_document_id"] = duplicate_source_id
            if duplicate_source_reference:
                audit_changes["linked_to_reference_number"] = duplicate_source_reference
        self.record_audit(AuditEvent.DOCUMENT_CREATED, doc, audit_changes)
        doc.refresh_from_db()
        return Response(
            DocumentDetailSerializer(doc, context=self.get_serializer_context()).data,
            status=status.HTTP_201_CREATED,
        )

    @action(detail=False, methods=["get"])
    def suppliers(self, request):
        """
        Distinct, non-empty supplier names across the (live) documents the user
        can see. Powers the supplier filter dropdown on the Documents page, which
        must list every supplier in the system — not just those on the page.
        """
        names = (
            self.get_queryset()
            .filter(deleted_at__isnull=True)
            .exclude(supplier__isnull=True)
            .exclude(supplier__exact="")
            .values_list("supplier", flat=True)
            .distinct()
        )
        # Collapse case/whitespace variants while keeping a clean display form.
        seen, result = set(), []
        for name in names:
            cleaned = (name or "").strip()
            key = cleaned.lower()
            if not key or key in seen:
                continue
            seen.add(key)
            result.append(cleaned)
        return Response(sorted(result, key=str.lower))

    @action(detail=False, methods=["get"], url_path="duplicate-check")
    def duplicate_check(self, request):
        dms_settings = DMSSettings.load()
        checksum = (request.query_params.get("checksum") or "").strip().lower()
        current_document_id = (request.query_params.get("document_id") or "").strip()
        if len(checksum) != 64 or any(c not in "0123456789abcdef" for c in checksum):
            return Response(
                {"detail": "A valid SHA-256 checksum is required."},
                status=status.HTTP_400_BAD_REQUEST,
            )

        identical_to_current = False
        if current_document_id:
            try:
                current_doc = self.get_queryset().only("id", "checksum").get(id=current_document_id)
                identical_to_current = current_doc.checksum == checksum
            except (Document.DoesNotExist, ValidationError, ValueError):
                identical_to_current = False

        if dms_settings.allow_duplicate_uploads:
            return Response({
                "exists": False,
                "identical_to_current": identical_to_current,
                "duplicates_allowed": True,
            })

        duplicate_doc = (
            Document.objects
            # Ignore trashed (soft-deleted) documents so a file in Trash does not
            # block re-uploading the same content.
            .filter(checksum=checksum, uploaded_by=request.user, deleted_at__isnull=True)
            .exclude(file="")
            .select_related("uploaded_by")
            .order_by("created_at")
            .first()
        )

        if not duplicate_doc:
            return Response({
                "exists": identical_to_current,
                "identical_to_current": identical_to_current,
            })

        return Response({
            "exists": True,
            "identical_to_current": identical_to_current,
            "document_id": str(duplicate_doc.id),
            "reference_number": duplicate_doc.reference_number,
            "uploaded_at": duplicate_doc.created_at,
            "uploaded_by": duplicate_doc.uploaded_by.get_full_name().strip() or duplicate_doc.uploaded_by.email,
        })

    # Statuses that a user may delete to Trash (pre-approval / creation stage).
    TRASHABLE_STATUSES = {
        DocumentStatus.DRAFT, DocumentStatus.RETURNED, DocumentStatus.REJECTED,
    }

    def _can_manage_trash(self, doc, user) -> bool:
        return bool(user.has_admin_access or doc.uploaded_by_id == user.id)

    def _prepare_builder_workflow_phase(self, doc) -> str | None:
        from apps.documents.builder_workflow import sync_builder_workflow_phase, sync_retirement_variance

        try:
            phase = sync_builder_workflow_phase(doc)
        except Exception:
            logger.exception("Could not infer workflow phase for builder document %s", doc.id)
            phase = None
        try:
            sync_retirement_variance(doc)
        except Exception:
            logger.exception("Could not sync retirement variance for builder document %s", doc.id)
        return phase

    def destroy(self, request, *args, **kwargs):
        """Move a document to Trash (soft delete) rather than removing it."""
        doc = self.get_object()
        if doc.deleted_at:
            return Response({"detail": "Document is already in Trash."}, status=400)
        if doc.status not in self.TRASHABLE_STATUSES:
            return Response(
                {"detail": "Only draft, returned, or rejected documents can be moved to Trash."},
                status=status.HTTP_400_BAD_REQUEST,
            )
        # Bare UPDATE avoids re-triggering the synchronous search-index signal.
        Document.objects.filter(id=doc.id).update(
            deleted_at=timezone.now(), deleted_by=request.user, updated_at=timezone.now()
        )
        # Pull it out of the search index so a trashed doc stops showing in results.
        from apps.search.indexing import queue_deindex_document
        queue_deindex_document(str(doc.id))
        self.record_audit("document.deleted", doc, {"trashed": True})
        return Response(status=status.HTTP_204_NO_CONTENT)

    @action(detail=True, methods=["post"], permission_classes=[permissions.IsAuthenticated])
    def restore(self, request, pk=None):
        """Restore a document from Trash."""
        doc = self.get_object()
        if not doc.deleted_at:
            return Response({"detail": "Document is not in Trash."}, status=400)
        if not self._can_manage_trash(doc, request.user):
            return Response({"detail": "Not permitted."}, status=status.HTTP_403_FORBIDDEN)
        Document.objects.filter(id=doc.id).update(
            deleted_at=None, deleted_by=None, updated_at=timezone.now()
        )
        # Put it back in the search index now that it's live again.
        from apps.search.indexing import queue_index_document
        queue_index_document(str(doc.id))
        self.record_audit("document.restored", doc)
        doc.refresh_from_db()
        return Response(DocumentDetailSerializer(doc, context={"request": request}).data)

    @action(detail=True, methods=["post"], permission_classes=[permissions.IsAuthenticated])
    def purge(self, request, pk=None):
        """Permanently delete a document that is in Trash."""
        doc = self.get_object()
        if not doc.deleted_at:
            return Response(
                {"detail": "Only documents in Trash can be permanently deleted."}, status=400
            )
        if not self._can_manage_trash(doc, request.user):
            return Response({"detail": "Not permitted."}, status=status.HTTP_403_FORBIDDEN)
        doc_id = str(doc.id)
        self.record_audit("document.purged", doc, {"reference": doc.reference_number})
        doc.hard_delete()
        # Remove the now-orphaned search-index entry so it can't 404 on open.
        from apps.search.indexing import queue_deindex_document
        queue_deindex_document(doc_id)
        return Response(status=status.HTTP_204_NO_CONTENT)

    @action(detail=True, methods=["post"])
    def submit(self, request, pk=None):
        doc = self.get_object()
        from apps.documents.builder_workflow import (
            can_submit_request_workflow,
            can_submit_retirement_workflow,
        )

        self._prepare_builder_workflow_phase(doc)
        doc.refresh_from_db(fields=["metadata", "updated_at"])

        can_submit_retirement = can_submit_retirement_workflow(doc, user=request.user)
        can_submit_request = can_submit_request_workflow(doc, user=request.user)

        # Rejection is terminal — it ends the workflow. Draft/returned documents
        # start (or resume) the request phase; fully-approved builder forms in
        # the retirement phase start the stage-2 approval cycle.
        if not can_submit_retirement and not can_submit_request:
            return Response(
                {"detail": "This document cannot be submitted in its current status."},
                status=status.HTTP_400_BAD_REQUEST,
            )
        from apps.workflows.services import WorkflowService, WorkflowError
        try:
            WorkflowService.start(doc, request.user)
        except WorkflowError as exc:
            return Response({"detail": str(exc)}, status=status.HTTP_400_BAD_REQUEST)
        self.record_audit("document.submitted", doc)
        doc.refresh_from_db()
        return Response(DocumentDetailSerializer(doc, context={"request": request}).data)

    @action(detail=True, methods=["post"])
    def archive(self, request, pk=None):
        from apps.documents.access import outcome_status_for

        doc = self.get_object()
        if doc.status != DocumentStatus.APPROVED:
            return Response(
                {"detail": "Only approved documents can be archived."},
                status=status.HTTP_400_BAD_REQUEST,
            )
        doc.status = outcome_status_for(doc.document_type, "archived")
        doc.save(update_fields=["status", "updated_at"])
        self.record_audit("document.archived", doc)
        return Response({"status": "archived"})

    @action(detail=True, methods=["patch"])
    def edit_metadata(self, request, pk=None):
        doc = self.get_object()
        from apps.documents.access import document_allows_edit
        from apps.documents.file_streaming import user_can_edit_document

        if not user_can_edit_document(request.user, doc):
            return Response(
                {"detail": "You do not have permission to edit this document."},
                status=status.HTTP_403_FORBIDDEN,
            )
        if not document_allows_edit(doc, user=request.user):
            return Response(
                {"detail": "This document cannot be edited in its current status."},
                status=status.HTTP_400_BAD_REQUEST,
            )
        # Editing details requires holding the checkout lock, so a save can't land
        # after the lock was released (admin force-release) or expired — which
        # would otherwise let a revoked editor keep writing. The one exception is
        # the uploader doing initial setup on their own still-unlocked document
        # (the post-upload "confirm details" flow takes no lock); once the doc is
        # locked, or anyone other than the uploader edits, the lock is required.
        holder = doc.edit_lock_holder
        lock_required = doc.is_edit_locked or doc.uploaded_by_id != request.user.id
        if lock_required and (holder is None or holder.id != request.user.id):
            detail = (
                f"This document is locked by {holder.get_full_name()}."
                if holder
                else "Your edit lock was released. Re-lock the document to edit its details."
            )
            return Response({"detail": detail}, status=status.HTTP_423_LOCKED)
        serializer = DocumentMetadataEditSerializer(
            doc, data=request.data, partial=True, context={"request": request}
        )
        serializer.is_valid(raise_exception=True)

        from apps.documents.metadata_audit import (
            diff_metadata_snapshots,
            snapshot_document_metadata,
        )

        doc = (
            Document.objects
            .select_related("document_type")
            .prefetch_related("tags", "document_type__metadata_fields")
            .get(pk=doc.pk)
        )
        before_snapshot = snapshot_document_metadata(doc)
        serializer.save()
        doc = (
            Document.objects
            .select_related("document_type")
            .prefetch_related("tags", "document_type__metadata_fields")
            .get(pk=doc.pk)
        )
        metadata_edits = diff_metadata_snapshots(before_snapshot, snapshot_document_metadata(doc))
        audit_changes = {"metadata_edits": metadata_edits} if metadata_edits else None
        self.record_audit("document.updated", doc, audit_changes)
        return Response(DocumentDetailSerializer(doc, context={"request": request}).data)

    def _require_edit_lock(self, doc, user):
        """Return a 423 Response if `user` does not hold the document's edit lock,
        else None. Version-mutating actions (new version, restore) require holding
        the lock — the same checkout that gates editing the details/file."""
        holder = doc.edit_lock_holder
        if holder is not None and holder.id == user.id:
            return None
        detail = (
            f"This document is locked by {holder.get_full_name()}."
            if holder
            else "Lock (check out) the document first."
        )
        return Response({"detail": detail}, status=status.HTTP_423_LOCKED)

    @action(detail=True, methods=["post"], parser_classes=[MultiPartParser])
    def upload_version(self, request, pk=None):
        doc  = self.get_object()
        lock_block = self._require_edit_lock(doc, request.user)
        if lock_block:
            return lock_block
        file = request.FILES.get("file")
        if not file:
            return Response({"detail": "No file provided."}, status=400)

        dt = doc.document_type
        if dt and file.size > dt.max_file_size_bytes:
            return Response(
                {"detail": f"File is too large. The limit for {dt.name} is {dt.max_file_size_mb} MB."},
                status=status.HTTP_400_BAD_REQUEST,
            )

        sha256 = hashlib.sha256()
        for chunk in file.chunks():
            sha256.update(chunk)
        file.seek(0)
        checksum = sha256.hexdigest()

        if checksum == doc.checksum:
            return Response(
                {"detail": "This file is identical to the current version."},
                status=status.HTTP_400_BAD_REQUEST,
            )

        new_version = doc.current_version + 1
        version     = DocumentVersion.objects.create(
            document=doc, version_number=new_version,
            file=file, file_name=file.name, file_size=file.size,
            checksum=checksum,
            change_summary=request.data.get("change_summary", ""),
            created_by=request.user,
        )
        guessed_mime, _ = mimetypes.guess_type(version.file_name)
        incoming_mime = getattr(file, "content_type", "") or guessed_mime or ""
        new_mime = doc.file_mime_type
        if incoming_mime and incoming_mime != "application/octet-stream":
            new_mime = incoming_mime

        # Point the document at the version's stored path. The raw UploadedFile
        # still carries the client filename (e.g. "report.pdf"), not the storage
        # key (e.g. "versions/report.pdf") — using it here made current-version
        # previews 404 while per-version tabs still worked.
        Document.objects.filter(id=doc.id).update(
            file=version.file.name,
            file_name=version.file_name,
            file_size=version.file_size,
            file_mime_type=new_mime,
            checksum=checksum,
            current_version=new_version,
            preview_pdf="",
            preview_status="",
            updated_at=timezone.now(),
        )
        cache.delete(_preview_error_cache_key(str(doc.id)))
        cache.delete(_preview_start_cache_key(str(doc.id)))

        doc.refresh_from_db()
        self._queue_office_preview(doc)
        self._queue_office_version_preview(version)
        self.record_audit("document.version_uploaded", doc, {"version": new_version})

        from apps.search.indexing import schedule_document_search_pipeline

        schedule_document_search_pipeline(
            str(doc.id),
            reextract_content=True,
            index_immediately=True,
        )

        return Response(DocumentVersionSerializer(version).data, status=201)

    @action(detail=True, methods=["post"], url_path="update_form")
    def update_form(self, request, pk=None):
        """
        Re-fill a built-template form document in-app and regenerate its PDF view.

        Built templates are interactive forms whose data lives on the document
        (metadata.form). This edits the values in place — no external editor — and
        regenerates the PDF as a new version.
        """
        from types import SimpleNamespace
        from django.core.files.base import ContentFile
        from apps.search.utils import SEARCH_INDEX_EXCEPTIONS
        from apps.documents.access import document_allows_form_edit, user_owns_document
        from apps.documents.file_streaming import user_can_edit_document
        from apps.templates_engine.tasks import generate_built_pdf

        doc = self.get_object()
        form = (doc.metadata or {}).get("form")
        if not form or not isinstance(form, dict):
            return Response({"detail": "This document is not an in-app form."}, status=400)
        if not user_can_edit_document(request.user, doc):
            return Response(
                {"detail": "You do not have permission to edit this document."},
                status=status.HTTP_403_FORBIDDEN,
            )
        if not document_allows_form_edit(doc, user=request.user):
            return Response(
                {"detail": "This document cannot be edited in its current status."},
                status=status.HTTP_400_BAD_REQUEST,
            )
        # Form documents are edited in-app (not via an external editor) and
        # manage concurrency through document_allows_form_edit() and per-field
        # editability conditions.  The file-level checkout lock is for external
        # editors (Office, WebDAV) and must NOT be required here.

        import json
        from apps.documents.form_attachments import (
            apply_form_attachments,
            default_reference_resolver,
            descriptors_to_names,
            is_attachment_descriptor,
            rebuild_attachments,
            reconcile_references,
        )

        values = request.data.get("values")
        if isinstance(values, str):
            # Multipart submissions (with attachments) carry values as JSON text.
            try:
                values = json.loads(values) if values.strip() else {}
            except json.JSONDecodeError:
                return Response({"detail": "values must be valid JSON."}, status=400)
        if not isinstance(values, dict):
            return Response({"detail": "values must be an object."}, status=400)

        meta = dict(doc.metadata or {})
        meta_form = dict(meta.get("form") or {})

        # Carry forward descriptors for attachment fields the client echoed back
        # as placeholders (it doesn't re-upload files it didn't change).
        prior_values = meta_form.get("values") if isinstance(meta_form.get("values"), dict) else {}
        prior_attachments = rebuild_attachments(prior_values)

        # Persist any newly uploaded files (simple fields + table cells) and
        # write their descriptors into values. These are form attachments stored
        # on metadata.form — NOT new document versions.
        values, attachments = apply_form_attachments(doc.id, values, request.FILES.items())

        # Re-anchor a prior simple-field descriptor the client replaced with a
        # placeholder. (Table cells round-trip in the submitted values, so the
        # rebuild above already preserves them.)
        for key, descriptor in prior_attachments.items():
            if "~" in key or key in attachments:
                continue
            if not is_attachment_descriptor(values.get(key)):
                values[key] = descriptor
                attachments[key] = descriptor

        sections = form.get("sections") or []

        # ── Editability enforcement (the "Security" axis) ──────────────────────
        # A field/section can be marked read-only or "editable only when <process
        # step / field> matches". At the document's current step, any locked field
        # must not change — the client disables it, but we re-assert it here so a
        # tampered request can't slip past. Locked fields are reverted to their
        # stored value; conditions are evaluated against the STORED values (a user
        # can't unlock a field within the same request that edits it).
        from apps.documents.builder_workflow import builder_process_step
        from apps.templates_engine.conditions import is_editable
        process_step = builder_process_step(doc)
        prior_render = descriptors_to_names(prior_values)
        owns_document = user_owns_document(request.user, doc) or getattr(request.user, "has_admin_access", False)
        owner_only_conditional_edit = process_step.strip().lower() != "returned"
        locked_keys = set()
        for section in sections:
            section_editable = is_editable(section, prior_render, process_step)
            if section.get("editableWhen") and owner_only_conditional_edit and not owns_document:
                section_editable = False
            for f in section.get("fields", []):
                key = f.get("key")
                if not key:
                    continue
                field_editable = is_editable(f, prior_render, process_step)
                if f.get("editableWhen") and owner_only_conditional_edit and not owns_document:
                    field_editable = False
                if not (section_editable and field_editable):
                    locked_keys.add(key)
        for key in locked_keys:
            if key in prior_values:
                values[key] = prior_values[key]
            else:
                values.pop(key, None)

        # Re-derive picked reference/user labels server-side from their ids.
        values = reconcile_references(values, sections, default_reference_resolver)

        # The regenerated PDF view shows display strings, not structured dicts.
        render_values = descriptors_to_names(values)
        shim = SimpleNamespace(name=doc.title, sections=sections)
        try:
            content = generate_built_pdf(shim, render_values)
        except Exception as exc:
            logger.exception("update_form: regeneration failed for %s", doc.id)
            return Response({"detail": f"Could not regenerate the form: {exc}"}, status=400)

        filename = doc.file_name if (doc.file_name or "").lower().endswith(".pdf") else f"{doc.title}.pdf"
        checksum = hashlib.sha256(content).hexdigest()
        new_version = doc.current_version + 1

        DocumentVersion.objects.create(
            document=doc, version_number=new_version,
            file=ContentFile(content, name=filename), file_name=filename,
            file_size=len(content), checksum=checksum,
            change_summary="Form updated", created_by=request.user,
        )

        meta_form["values"] = values
        if attachments:
            meta_form["attachments"] = attachments
        meta["form"] = meta_form

        doc.file = ContentFile(content, name=filename)
        doc.file_name = filename
        doc.file_size = len(content)
        doc.file_mime_type = "application/pdf"
        doc.checksum = checksum
        doc.current_version = new_version
        doc.metadata = meta
        doc.preview_status = ""
        doc.preview_pdf = ""
        try:
            doc.save()
        except SEARCH_INDEX_EXCEPTIONS:
            # ES read-only (disk flood-stage). The row is committed; indexing will
            # catch up. Don't fail the edit.
            logger.warning("Form document %s saved but realtime indexing failed.", doc.id)

        self.record_audit("document.updated", doc, {"version": new_version, "form": True})
        from apps.search.indexing import schedule_document_search_pipeline

        schedule_document_search_pipeline(str(doc.id), reextract_content=True, index_immediately=True)
        from apps.documents.builder_workflow import sync_retirement_variance
        try:
            sync_retirement_variance(doc)
        except Exception:
            logger.exception("Could not sync retirement variance after form update for %s", doc.id)
        return Response(DocumentDetailSerializer(doc, context={"request": request}).data)

    @action(detail=True, methods=["get"], url_path=r"form_attachment/(?P<field_key>[^/.]+)")
    def form_attachment(self, request, pk=None, field_key=None):
        doc = self.get_object()
        if not user_can_view_document(request.user, doc):
            return Response(
                {"detail": "You do not have permission to view this document."},
                status=status.HTTP_403_FORBIDDEN,
            )

        form = (doc.metadata or {}).get("form")
        if not isinstance(form, dict):
            return Response({"detail": "This document has no form attachments."}, status=404)

        attachments = form.get("attachments") if isinstance(form.get("attachments"), dict) else {}
        descriptor = attachments.get(field_key)
        if not descriptor:
            values = form.get("values") if isinstance(form.get("values"), dict) else {}
            candidate = values.get(field_key)
            descriptor = candidate if isinstance(candidate, dict) else None
        if not descriptor or not descriptor.get("storage_path"):
            return Response({"detail": "Attachment not found."}, status=404)

        storage_path = descriptor["storage_path"]
        if not default_storage.exists(storage_path):
            return Response({"detail": "Attachment file is missing."}, status=404)

        with default_storage.open(storage_path, "rb") as fh:
            raw = fh.read()
        return build_http_file_response(
            raw=raw,
            content_type=descriptor.get("content_type") or mimetypes.guess_type(descriptor.get("name") or "")[0] or "application/octet-stream",
            download_name=descriptor.get("name") or "attachment",
            disposition="attachment" if user_can_download_document(request.user, doc) else "inline",
        )

    @action(detail=True, methods=["post"])
    def restore_version(self, request, pk=None):
        doc = self.get_object()
        lock_block = self._require_edit_lock(doc, request.user)
        if lock_block:
            return lock_block
        version_id = request.data.get("version_id")
        version = get_object_or_404(DocumentVersion, id=version_id, document=doc)

        if version.version_number == doc.current_version:
            return Response({"detail": "Already the current version."}, status=400)

        try:
            version.file.open("rb")
            content = version.file.read()
        except Exception:
            return Response({"detail": "Version file could not be read."}, status=400)
        finally:
            try:
                version.file.close()
            except Exception:
                pass

        with transaction.atomic():
            later_versions = list(
                DocumentVersion.objects.filter(
                    document=doc,
                    version_number__gt=version.version_number,
                ).order_by("version_number")
            )

            restored_name = version.file_name or doc.file_name
            restored_size = version.file_size or len(content)

            doc.file.save(
                restored_name,
                ContentFile(content, name=restored_name),
                save=False,
            )
            doc.file_name = restored_name
            doc.file_size = restored_size
            guessed_mime, _ = mimetypes.guess_type(restored_name)
            restored_mime = getattr(version.file, "content_type", "") or guessed_mime or doc.file_mime_type
            if restored_mime and restored_mime != "application/octet-stream":
                doc.file_mime_type = restored_mime
            doc.checksum = version.checksum
            doc.current_version = version.version_number
            doc.preview_status = ""
            Document.objects.filter(id=doc.id).update(
                file=doc.file.name,
                file_name=doc.file_name,
                file_size=doc.file_size,
                file_mime_type=doc.file_mime_type,
                checksum=doc.checksum,
                current_version=doc.current_version,
                preview_pdf="",
                preview_status="",
                updated_at=timezone.now(),
            )

            DocumentVersion.objects.filter(
                document=doc,
                version_number__gt=version.version_number,
            ).delete()

            for removed_version in later_versions:
                removed_name = removed_version.file.name
                if removed_name:
                    transaction.on_commit(
                        lambda name=removed_name: _delete_storage_file(name)
                    )
                removed_preview_name = _version_preview_storage_name(str(removed_version.id))
                transaction.on_commit(
                    lambda name=removed_preview_name: _delete_storage_file(name)
                )
                cache.delete(_version_preview_status_cache_key(str(removed_version.id)))
                cache.delete(_version_preview_processing_cache_key(str(removed_version.id)))
                cache.delete(_version_preview_error_cache_key(str(removed_version.id)))
                cache.delete(_version_preview_start_cache_key(str(removed_version.id)))

        cache.delete(_preview_error_cache_key(str(doc.id)))
        cache.delete(_preview_start_cache_key(str(doc.id)))
        self._queue_office_preview(doc)
        self.record_audit(
            "document.version_restored",
            doc,
            {
                "restored_from": version.version_number,
                "version": version.version_number,
                "deleted_versions": [v.version_number for v in later_versions],
            },
        )

        from apps.search.indexing import schedule_document_search_pipeline

        schedule_document_search_pipeline(
            str(doc.id),
            reextract_content=True,
            index_immediately=True,
        )

        doc.refresh_from_db()
        return Response(DocumentVersionSerializer(version, context=self.get_serializer_context()).data, status=200)

    @action(detail=True, methods=["get"])
    def preview_url(self, request, pk=None):
        doc = self.get_object()
        can_dl = user_can_download_document(request.user, doc)
        signed_urls_enabled = signed_file_urls_enabled()
        version_id = request.query_params.get("version_id")
        version = None
        if version_id:
            version = get_object_or_404(DocumentVersion, id=version_id, document=doc)

        def inline_link(vid: str, use_preview: bool):
            return build_absolute_document_file_url(
                request, doc, version_id=vid, use_preview=use_preview, disposition="inline"
            )

        def raw_link(vid: str, use_preview: bool):
            if not can_dl:
                return None
            return build_absolute_document_file_url(
                request, doc, version_id=vid, use_preview=use_preview, disposition="attachment"
            )

        if version:
            if not version.file:
                return Response({"detail": "Version file is missing."}, status=400)

            mime = mimetypes.guess_type(version.file_name or "")[0] or ""
            vid = str(version.id)
            if mime == "application/pdf":
                return Response({
                    "viewer": "pdfjs",
                    "url": inline_link(vid, False),
                    "raw_url": raw_link(vid, False),
                    "signed_file_urls_enabled": signed_urls_enabled,
                    "preview_status": "done",
                })
            if mime.startswith("image/"):
                return Response({
                    "viewer": "image",
                    "url": inline_link(vid, False),
                    "raw_url": raw_link(vid, False),
                    "signed_file_urls_enabled": signed_urls_enabled,
                    "preview_status": "done",
                })
            if mime in (
                "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
                "application/msword",
                "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                "application/vnd.ms-excel",
                "application/vnd.openxmlformats-officedocument.presentationml.presentation",
                "application/vnd.ms-powerpoint",
            ) or version.is_office_doc():
                status_key = _version_preview_status_cache_key(str(version.id))
                preview_name = _version_preview_storage_name(str(version.id))
                preview_exists = False
                try:
                    from django.core.files.storage import default_storage
                    preview_exists = default_storage.exists(preview_name)
                except Exception:
                    preview_exists = False

                current_status = cache.get(status_key)
                if current_status == PreviewStatus.DONE and not preview_exists:
                    cache.delete(status_key)
                    current_status = None

                if current_status in (PreviewStatus.PENDING, PreviewStatus.PROCESSING):
                    preview_status = current_status
                elif preview_exists:
                    preview_status = PreviewStatus.DONE
                else:
                    self._queue_office_version_preview(version)
                    current_status = cache.get(status_key) or PreviewStatus.PENDING
                    preview_status = current_status
                preview_error = cache.get(_version_preview_error_cache_key(str(version.id)))

                if preview_status == PreviewStatus.DONE and preview_exists:
                    viewer = "pdfjs"
                    url = inline_link(vid, True)
                else:
                    viewer = "processing"
                    url = None

                return Response({
                    "viewer": viewer,
                    "url": url,
                    "raw_url": raw_link(vid, False),
                    "signed_file_urls_enabled": signed_urls_enabled,
                    "preview_status": preview_status,
                    "preview_error": preview_error,
                })

            return Response({
                "viewer": "download",
                "url": raw_link(vid, False),
                "raw_url": raw_link(vid, False),
                "signed_file_urls_enabled": signed_urls_enabled,
                "preview_status": "done",
            })

        if not doc.file:
            return Response({"detail": "No file attached."}, status=400)

        mime = doc.file_mime_type or ""

        if mime == "application/pdf":
            return Response({
                "viewer": "pdfjs",
                "url": inline_link("", False),
                "raw_url": raw_link("", False),
                "signed_file_urls_enabled": signed_urls_enabled,
                "preview_status": "done",
            })

        if mime.startswith("image/"):
            return Response({
                "viewer": "image",
                "url": inline_link("", False),
                "raw_url": raw_link("", False),
                "signed_file_urls_enabled": signed_urls_enabled,
                "preview_status": "done",
            })

        if doc.is_office_doc():
            if not doc.preview_status:
                self._queue_office_preview(doc)
            doc.refresh_from_db()
            preview_status = doc.preview_status or PreviewStatus.PENDING
            preview_error = cache.get(_preview_error_cache_key(str(doc.id)))

            if preview_status == PreviewStatus.DONE and doc.preview_pdf:
                viewer = "pdfjs"
                url = inline_link("", True)
            else:
                viewer = "processing"
                url = None

            return Response({
                "viewer": viewer,
                "url": url,
                "raw_url": raw_link("", False),
                "signed_file_urls_enabled": signed_urls_enabled,
                "preview_status": preview_status,
                "preview_error": preview_error,
            })

        return Response({
            "viewer": "download",
            "url": raw_link("", False),
            "raw_url": raw_link("", False),
            "signed_file_urls_enabled": signed_urls_enabled,
            "preview_status": "done",
        })

    @action(
        detail=True,
        methods=["get"],
        url_path="file",
        authentication_classes=[JWTAuthentication, DocumentFileSignatureAuthentication],
        permission_classes=[permissions.IsAuthenticated, HasDocumentPermission],
    )
    def file(self, request, pk=None):
        doc = self.get_object()
        sig = (request.query_params.get("sig") or "").strip()
        if sig:
            if not signed_file_urls_enabled():
                return Response({"detail": "Signed file links are disabled."}, status=403)
            try:
                payload = unsign_file_payload(sig)
            except Exception:
                return Response({"detail": "Invalid or expired file link."}, status=400)
            if payload.get("doc") != str(doc.id) or payload.get("sub") != str(request.user.id):
                return Response({"detail": "File link is not valid for this document."}, status=403)
            if not verify_file_query_matches_payload(request, payload):
                return Response({"detail": "File link parameters were altered."}, status=400)

        disposition = (request.query_params.get("disposition") or "inline").strip()
        if disposition not in ("inline", "attachment"):
            disposition = "inline"

        can_download = user_can_download_document(request.user, doc)

        if disposition == "attachment" and not can_download:
            return Response({"detail": "Download not permitted."}, status=403)

        if not user_can_view_document(request.user, doc):
            return Response({"detail": "Forbidden."}, status=403)

        version_id = (request.query_params.get("version_id") or "").strip()
        version = None
        if version_id:
            version = get_object_or_404(DocumentVersion, id=version_id, document=doc)

        use_preview = str(request.query_params.get("use_preview", "0")).lower() in ("1", "true", "yes")

        is_office = version.is_office_doc() if version else doc.is_office_doc()
        if use_preview and not is_office:
            return Response(
                {"detail": "Preview mode is only valid for Office documents."},
                status=400,
            )

        if disposition == "inline" and not use_preview and is_office:
            return Response(
                {"detail": "Inline Office originals are not served; use the PDF preview."},
                status=400,
            )

        try:
            raw, content_type, name = read_document_bytes(doc, version=version, use_preview=use_preview)
        except FileNotFoundError as exc:
            return Response({"detail": str(exc)}, status=404)

        inline_previewable = (
            content_type == "application/pdf"
            or content_type.startswith("image/")
        )
        if disposition == "inline" and not can_download and not inline_previewable:
            return Response(
                {"detail": "This file type cannot be previewed without download permission."},
                status=403,
            )

        if disposition == "attachment":
            self.record_audit(
                AuditEvent.DOCUMENT_DOWNLOADED,
                doc,
                {"version_id": version_id or None, "use_preview": use_preview},
            )
        else:
            self.record_audit(
                AuditEvent.DOCUMENT_PREVIEWED,
                doc,
                {"version_id": version_id or None, "use_preview": use_preview},
            )

        return build_http_file_response(
            raw=raw,
            content_type=content_type,
            download_name=name,
            disposition=disposition,
        )

    @action(detail=True, methods=["post"], url_path="file_print_event")
    def file_print_event(self, request, pk=None):
        doc = self.get_object()
        self.record_audit(AuditEvent.DOCUMENT_PRINTED, doc, {})
        return Response({"ok": True})

    @action(detail=True, methods=["post"])
    def trigger_preview(self, request, pk=None):
        doc = self.get_object()

        if not doc.is_office_doc():
            return Response(
                {"detail": "Preview generation is only supported for Office documents."},
                status=status.HTTP_400_BAD_REQUEST,
            )

        if doc.preview_status == PreviewStatus.PROCESSING:
            # Use the cache-stored start time, NOT updated_at.
            # updated_at is refreshed by the task's heartbeat() every 30 s,
            # which would make every in-progress job always look "fresh" and
            # block legitimate retries after the frontend times out.
            stale_after = int(getattr(settings, "PREVIEW_PROCESSING_STALE_SECONDS", 300))
            start_time = cache.get(_preview_start_cache_key(str(doc.id)))
            if start_time is not None:
                processing_age_s = max(0, int((timezone.now() - start_time).total_seconds()))
            else:
                # No start time in cache means the worker died without writing one,
                # or the cache was cleared. Treat as stale immediately.
                processing_age_s = stale_after + 1

            if processing_age_s < stale_after:
                return Response(
                    {"detail": "Preview generation is already in progress."},
                    status=status.HTTP_400_BAD_REQUEST,
                )

        Document.objects.filter(id=doc.id).update(preview_status="", preview_pdf=None)
        cache.delete(_preview_error_cache_key(str(doc.id)))
        cache.delete(_preview_start_cache_key(str(doc.id)))
        doc.refresh_from_db()
        self._queue_office_preview(doc)
        self.record_audit(AuditEvent.DOCUMENT_PREVIEW_QUEUED, doc)

        return Response({
            "detail": "Preview generation queued.",
            "preview_status": PreviewStatus.PENDING,
        })

    @action(detail=True, methods=["post"])
    def trigger_version_preview(self, request, pk=None):
        doc = self.get_object()
        version_id = request.data.get("version_id")
        version = get_object_or_404(DocumentVersion, id=version_id, document=doc)

        if not version.is_office_doc():
            return Response(
                {"detail": "Preview generation is only supported for Office versions."},
                status=status.HTTP_400_BAD_REQUEST,
            )

        status_key = _version_preview_status_cache_key(str(version.id))
        processing_key = _version_preview_processing_cache_key(str(version.id))
        preview_name = _version_preview_storage_name(str(version.id))
        current_status = cache.get(status_key)

        if current_status == PreviewStatus.PROCESSING:
            stale_after = int(getattr(settings, "PREVIEW_PROCESSING_STALE_SECONDS", 300))
            start_time = cache.get(_version_preview_start_cache_key(str(version.id)))
            if start_time is not None:
                processing_age_s = max(0, int((timezone.now() - start_time).total_seconds()))
            else:
                processing_age_s = stale_after + 1

            if processing_age_s < stale_after:
                return Response(
                    {"detail": "Version preview generation is already in progress."},
                    status=status.HTTP_400_BAD_REQUEST,
                )

        try:
            from django.core.files.storage import default_storage
            if default_storage.exists(preview_name):
                default_storage.delete(preview_name)
        except Exception:
            logger.exception("trigger_version_preview: could not remove preview %s", preview_name)

        cache.delete(processing_key)
        cache.delete(status_key)
        cache.delete(_version_preview_error_cache_key(str(version.id)))
        cache.delete(_version_preview_start_cache_key(str(version.id)))
        self._queue_office_version_preview(version)
        self.record_audit(AuditEvent.DOCUMENT_VERSION_PREVIEW_QUEUED, doc, {"version_id": str(version.id)})

        return Response({
            "detail": "Version preview generation queued.",
            "preview_status": PreviewStatus.PENDING,
        })

    @action(detail=True, methods=["post"])
    def edit_token(self, request, pk=None):
        doc = self.get_object()
        if not user_can_edit_document(request.user, doc):
            return Response({"detail": "Edit not permitted."}, status=403)

        try:
            locked = doc.acquire_lock(request.user)
        except Exception as exc:
            logger.exception("edit_token: failed to acquire lock for %s", doc.id)
            return Response(
                {"detail": "Could not acquire edit lock due to a server error."},
                status=status.HTTP_500_INTERNAL_SERVER_ERROR,
            )

        if not locked:
            holder = doc.edit_lock_holder
            holder_name = holder.get_full_name().strip() if holder else "another user"
            return Response(
                {"detail": f"Locked by {holder_name}", "locked_by": holder_name},
                status=423,
            )

        # Generate a short, opaque hex token to avoid URL mangling.
        # JWTs (500+ chars with dots) cannot be reliably embedded in URLs.
        jwt_token = str(AccessToken.for_user(request.user))
        webdav_token = secrets.token_hex(32)  # 64 hex chars = 256 bits
        cache.set(
            f"webdav_edit_token:{webdav_token}",
            {
                "user_id": str(request.user.id),
                "document_id": str(doc.id),
            },
            timeout=3600,
        )

        api_base = request.build_absolute_uri("/api/v1").rstrip("/")
        file_url = (
            build_absolute_document_file_url(
                request, doc, version_id="", use_preview=False, disposition="attachment"
            )
            if user_can_download_document(request.user, doc)
            else None
        )
        release_url = f"{api_base}/documents/{doc.id}/release_lock/"

        # Token MUST be a path segment — NOT a query string.
        # LibreOffice and MS Office strip ?token=... after the first request.
        # Every subsequent PROPFIND / LOCK / PUT arrives with no query string
        # → token="" in dispatch() → 401 → credential dialog appears.
        # Path segments survive verbatim through every layer of the stack.
        # URL: /api/v1/documents/webdav/<doc_id>/<token>/<filename>
        parsed = urlparse(api_base)
        webdav_path = (
            f"{parsed.path}/documents/webdav/{doc.id}"
            f"/{webdav_token}"
            f"/{urlquote(doc.file_name, safe='')}"
        )
        webdav_url = urlunparse(parsed._replace(
            path=webdav_path,
            query="",
            fragment="",
        ))

        self.record_audit(AuditEvent.DOCUMENT_EDIT_LOCK_ACQUIRED, doc)

        return Response({
            "token":       jwt_token,   # JWT is what DocumentViewer.tsx reads
            "jwt_token":   jwt_token,
            "username":    request.user.email,
            "webdav_url":  webdav_url,
            "file_url":    file_url,
            "release_url": release_url,
            "expires_in":  3600,
            "doc_id":      str(doc.id),
            "file_name":   doc.file_name,
            "mime_type":   doc.file_mime_type,
        })

    @action(detail=True, methods=["post"])
    def read_only_token(self, request, pk=None):
        """
        Issue a short-lived WebDAV token to open the document in a desktop editor
        READ-ONLY — no edit lock is taken. The WebDAV layer rejects writes
        (PUT/LOCK) for read-only tokens, so members without edit rights can open
        the live file in Word/LibreOffice to view it without changing it.
        """
        doc = self.get_object()  # get_queryset already enforces visibility
        # Opening read-only in a desktop editor is a view action — the WebDAV
        # layer issues this token with read_only=True and rejects every write
        # method (PUT/LOCK), so it must gate on VIEW, not DOWNLOAD. Requiring
        # download here 403'd members who can see a locked doc but lack download.
        if not user_can_view_document(request.user, doc):
            return Response({"detail": "View not permitted."}, status=403)

        webdav_token = secrets.token_hex(32)
        cache.set(
            f"webdav_edit_token:{webdav_token}",
            {
                "user_id": str(request.user.id),
                "document_id": str(doc.id),
                "read_only": True,
            },
            timeout=3600,
        )

        api_base = request.build_absolute_uri("/api/v1").rstrip("/")
        parsed = urlparse(api_base)
        webdav_path = (
            f"{parsed.path}/documents/webdav/{doc.id}"
            f"/{webdav_token}"
            f"/{urlquote(doc.file_name, safe='')}"
        )
        webdav_url = urlunparse(parsed._replace(path=webdav_path, query="", fragment=""))

        return Response({
            "webdav_url":  webdav_url,
            "read_only":   True,
            "doc_id":      str(doc.id),
            "file_name":   doc.file_name,
            "mime_type":   doc.file_mime_type,
        })

    def _get_open_script_content(self, filename, open_url):
        safe_filename = filename.replace("'", "\\'")
        return f"""#!/usr/bin/env bash
# DocVault — open "{filename}" in LibreOffice
set -euo pipefail

OPEN_URL='{open_url}'
FILE_NAME='{safe_filename}'

find_soffice() {{
  for cmd in soffice libreoffice /usr/bin/soffice /usr/lib/libreoffice/program/soffice \
             /usr/lib64/libreoffice/program/soffice /snap/bin/libreoffice; do
    if command -v "$cmd" &>/dev/null 2>&1 || [ -x "$cmd" ]; then
      echo "$cmd"; return 0
    fi
  done
}}

SOFFICE=$(find_soffice)
if [ -z "$SOFFICE" ]; then
  echo "ERROR: LibreOffice not found. Install it with: sudo apt install libreoffice"
  exit 1
fi

echo "Opening: $FILE_NAME"
nohup "$SOFFICE" "$OPEN_URL" >/dev/null 2>&1 &
"""

    @action(detail=True, methods=["get"])
    def open_script(self, request, pk=None):
        doc = self.get_object()
        if not user_can_edit_document(request.user, doc):
            return Response({"detail": "Edit not permitted."}, status=403)

        try:
            locked = doc.acquire_lock(request.user)
        except Exception as exc:
            logger.exception("open_script: failed to acquire lock for %s", doc.id)
            return Response(
                {"detail": "Could not acquire edit lock due to a server error."},
                status=status.HTTP_500_INTERNAL_SERVER_ERROR,
            )

        if not locked:
            return Response({"detail": "Locked by another user."}, status=423)

        # Generate a short, opaque hex token (not JWT) to avoid URL mangling.
        webdav_token = secrets.token_hex(32)  # 64 hex chars = 256 bits
        cache.set(
            f"webdav_edit_token:{webdav_token}", 
            {
                "user_id": str(request.user.id),
                "document_id": str(doc.id),
            }, 
            timeout=3600
        )

        api_base = request.build_absolute_uri("/api/v1").rstrip("/")
        parsed = urlparse(api_base)
        # Token in path — same reason as edit_token above.
        path = (
            f"{parsed.path}/documents/webdav/{doc.id}"
            f"/{webdav_token}"
            f"/{urlquote(doc.file_name, safe='')}"
        )
        webdav_url = urlunparse(parsed._replace(
            path=path,
            query="",
            fragment="",
        ))
        
        dav_prefix = "vnd.sun.star.webdavs://" if webdav_url.startswith("https://") else "vnd.sun.star.webdav://"
        open_url = webdav_url.replace(parsed.scheme + "://", dav_prefix, 1)
        
        script = self._get_open_script_content(doc.file_name, open_url)
        response = HttpResponse(script, content_type="text/x-shellscript; charset=utf-8")
        response["Content-Disposition"] = f'attachment; filename="open-{doc.id}.sh"'
        self.record_audit(AuditEvent.DOCUMENT_EDIT_LOCK_ACQUIRED, doc)
        return response

    def _get_install_script_content(self, app_origin):
        return f"""#!/usr/bin/env bash
# DocVault — one-time LibreOffice handler install
set -euo pipefail

SCHEME="docvault-open"
HANDLER_BIN="$HOME/.local/bin/docvault-open"
APP_ORIGIN="{app_origin}"

mkdir -p "$HOME/.local/bin"
cat > "$HANDLER_BIN" << 'HANDLER_EOF'
#!/usr/bin/env bash
URI="${{1:-}}"
ENCODED="${{URI#docvault-open://}}"
ENCODED="${{ENCODED%/}}"

# Robust bash base64 decode (handles missing padding)
REM=$((${{#ENCODED}} % 4))
PAD=""
if [ $REM -eq 2 ]; then PAD="=="; elif [ $REM -eq 3 ]; then PAD="="; fi
DAVS_URL=$(echo "${{ENCODED}}${{PAD}}" | tr '_-' '/+' | base64 --decode 2>/dev/null || true)

find_soffice() {{
  for cmd in soffice libreoffice /usr/bin/soffice; do
    if command -v "$cmd" &>/dev/null; then echo "$cmd"; return 0; fi
  done
}}

SOFFICE=$(find_soffice)
if [ -n "$SOFFICE" ] && [ -n "$DAVS_URL" ]; then
  nohup "$SOFFICE" "$DAVS_URL" >/dev/null 2>&1 &
fi
HANDLER_EOF

chmod +x "$HANDLER_BIN"

DESKTOP_DIR="$HOME/.local/share/applications"
mkdir -p "$DESKTOP_DIR"
cat > "$DESKTOP_DIR/docvault-open.desktop" << DESKTOP_EOF
[Desktop Entry]
Type=Application
Name=DocVault Opener
Exec=$HANDLER_BIN %u
MimeType=x-scheme-handler/$SCHEME;
NoDisplay=true
Terminal=false
DESKTOP_EOF

if command -v xdg-mime &>/dev/null; then
  xdg-mime default docvault-open.desktop "x-scheme-handler/$SCHEME"
  update-desktop-database "$DESKTOP_DIR" 2>/dev/null || true
fi
echo "✓ DocVault LibreOffice integration installed."
"""

    @action(detail=False, methods=["get"])
    def install_script(self, request):
        app_origin = request.build_absolute_uri("/").rstrip("/")
        script = self._get_install_script_content(app_origin)
        response = HttpResponse(script, content_type="text/x-shellscript; charset=utf-8")
        response["Content-Disposition"] = 'attachment; filename="docvault-install-opener.sh"'
        return response

    @action(detail=True, methods=["post"])
    def release_lock(self, request, pk=None):
        doc = self.get_object()
        raw_force = request.data.get("force")
        force = (
            str(raw_force).lower() in {"1", "true", "yes", "on"}
            if raw_force is not None
            else False
        ) and request.user.has_admin_access

        if not doc.release_lock(user=request.user, force=force):
            return Response({"detail": "Lock held by another user."}, status=423)

        # Also drop the in-process WebDAV protocol lock so the next editor can
        # LOCK immediately instead of waiting for the stale lock to expire —
        # important for admin force-release of an abandoned checkout.
        from .webdav import clear_protocol_lock
        clear_protocol_lock(doc.id)

        self.record_audit(AuditEvent.DOCUMENT_EDIT_LOCK_RELEASED, doc)
        return Response({"detail": "Lock released."})

    @action(detail=True, methods=["post"])
    def re_ocr(self, request, pk=None):
        from .models import OCRStatus
        from .tasks import ocr_document
        doc = self.get_object()
        is_ocr_candidate = (
            doc.is_scanned or (doc.file_mime_type and doc.file_mime_type.startswith("image/"))
            or doc.file_mime_type == "application/pdf"
        )
        if not is_ocr_candidate:
            return Response({"detail": "OCR not supported for this file type."}, status=400)

        if doc.ocr_status in (OCRStatus.PENDING, OCRStatus.PROCESSING):
            return Response({"detail": "OCR is already in progress."}, status=400)

        Document.objects.filter(id=doc.id).update(ocr_status=OCRStatus.PENDING, is_scanned=True)
        ocr_document.delay(str(doc.id))
        self.record_audit(AuditEvent.DOCUMENT_OCR_QUEUED, doc)
        return Response({"detail": "OCR queued.", "ocr_status": OCRStatus.PENDING})

    @action(detail=True, methods=["get"])
    def ocr_suggestions(self, request, pk=None):
        """
        Return the structured field suggestions extracted by the OCR pipeline.

        Response shape:
          {
            "ocr_status": "done" | "pending" | "processing" | "failed" | "",
            "suggestions": {
              "fields": { ... } | null,
              "quality": { ... } | null
            } | null
          }

        Suggestions are null until ocr_status == "done".
        The frontend polls this endpoint after upload until done, then
        pre-fills the details form for user review.
        """
        from .models import OCRStatus
        doc = self.get_object()

        # Auto-heal stale OCR states so frontend pollers don't spin forever.
        if doc.ocr_status in (OCRStatus.PENDING, OCRStatus.PROCESSING):
            stale_after = int(getattr(settings, "OCR_PROCESSING_STALE_SECONDS", 300))
            age_seconds = max(0, int((timezone.now() - doc.updated_at).total_seconds()))
            if age_seconds >= stale_after:
                Document.objects.filter(
                    id=doc.id,
                    ocr_status__in=[OCRStatus.PENDING, OCRStatus.PROCESSING],
                ).update(ocr_status=OCRStatus.FAILED, updated_at=timezone.now())
                doc.refresh_from_db(fields=["ocr_status", "updated_at"])

        meta = doc.metadata or {}
        suggestions = None
        if doc.ocr_status == OCRStatus.DONE:
            ocr_block = meta.get("ocr_suggestions")
            if isinstance(ocr_block, dict) and (
                "fields" in ocr_block or "quality" in ocr_block
            ):
                fields = ocr_block.get("fields")
                quality = ocr_block.get("quality") or meta.get("ocr_quality")
            else:
                fields = ocr_block
                quality = meta.get("ocr_quality")
            if fields or quality:
                suggestions = {
                    "fields": fields or None,
                    "quality": quality or None,
                }
        return Response({
            "ocr_status": doc.ocr_status,
            "suggestions": suggestions,
        })

    @action(detail=True, methods=["get", "post"])
    def comments(self, request, pk=None):
        doc = self.get_object()
        if request.method == "GET":
            qs = doc.comments.all()
            if not request.user.has_admin_access:
                qs = qs.filter(is_internal=False)
            return Response(DocumentCommentSerializer(qs, many=True).data)
        serializer = DocumentCommentSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        serializer.save(document=doc, author=request.user)
        return Response(serializer.data, status=201)

    @action(detail=True, methods=["get"])
    def audit_trail(self, request, pk=None):
        from apps.audit.serializers import AuditLogSerializer
        from apps.audit.models import AuditLog, LOW_SIGNAL_AUDIT_EVENTS
        doc = self.get_object()
        # Hide low-signal events (views, previews, transient queue/lock states)
        # that only clutter the per-document trail. The full immutable log is
        # still available to admins on the system audit page.
        logs = (
            AuditLog.objects
            .filter(object_type="Document", object_id=str(doc.id))
            .exclude(event__in=LOW_SIGNAL_AUDIT_EVENTS)
            .select_related("actor")
            .order_by("-timestamp")
        )
        if request.query_params.get("page") or request.query_params.get("page_size"):
            paginator = PageNumberPagination()
            page_size = request.query_params.get("page_size")
            if page_size:
                try:
                    paginator.page_size = int(page_size)
                except (TypeError, ValueError):
                    paginator.page_size = settings.REST_FRAMEWORK.get("PAGE_SIZE", 20)
            page = paginator.paginate_queryset(logs, request, view=self)
            serializer = AuditLogSerializer(page, many=True)
            return paginator.get_paginated_response(serializer.data)

        return Response(AuditLogSerializer(logs, many=True).data)
        
    @action(detail=False, methods=["post"])
    def bulk_action(self, request):
        serializer = DocumentBulkActionSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        doc_ids = serializer.validated_data["document_ids"]
        act     = serializer.validated_data["action"]
        comment = serializer.validated_data.get("comment", "")

        from apps.workflows.services import WorkflowService, WorkflowError

        results = []
        for doc_id in doc_ids:
            try:
                doc = Document.objects.select_related("document_type").prefetch_related(
                    "workflow_instance__tasks__step"
                ).get(id=doc_id)
            except Document.DoesNotExist:
                results.append({"id": str(doc_id), "success": False, "detail": "Not found"})
                continue

            try:
                if act in ("approve", "reject"):
                    task = (
                        doc.workflow_instance.tasks
                        .filter(status__in=["in_progress", "held"])
                        .select_related("step").first()
                    )
                    if not task:
                        raise WorkflowError("No active approval task.")
                    if task.assigned_to != request.user and not request.user.has_admin_access:
                        raise WorkflowError("Not authorised.")
                    
                    # Check step permissions
                    if act == "approve" and not task.step.allow_approve:
                        raise WorkflowError("Approve is not permitted for this step.")
                    if act == "reject" and not task.step.allow_reject:
                        raise WorkflowError("Reject is not permitted for this step.")
                    
                    if act == "approve":
                        WorkflowService.approve(task, request.user, comment)
                    else:
                        WorkflowService.reject(task, request.user, comment)
                elif act == "archive":
                    if doc.status != DocumentStatus.APPROVED:
                        raise ValueError("Only approved documents can be archived.")
                    doc.status = DocumentStatus.ARCHIVED
                    doc.save(update_fields=["status", "updated_at"])
                    self.record_audit(AuditEvent.DOCUMENT_ARCHIVED, doc, {"bulk_action": True, "comment": comment})
                elif act == "void":
                    doc.status = DocumentStatus.VOID
                    doc.save(update_fields=["status", "updated_at"])
                    self.record_audit(AuditEvent.DOCUMENT_DELETED, doc, {"bulk_action": True, "comment": comment})
                elif act == "trash":
                    if doc.deleted_at:
                        raise ValueError("Already in Trash.")
                    if doc.status not in self.TRASHABLE_STATUSES:
                        raise ValueError("Only draft, returned, or rejected documents can be moved to Trash.")
                    Document.objects.filter(id=doc.id).update(
                        deleted_at=timezone.now(), deleted_by=request.user, updated_at=timezone.now()
                    )
                    from apps.search.indexing import queue_deindex_document
                    queue_deindex_document(str(doc.id))
                    self.record_audit("document.deleted", doc, {"bulk_action": True, "trashed": True})
                elif act == "restore":
                    if not doc.deleted_at:
                        raise ValueError("Document is not in Trash.")
                    if not self._can_manage_trash(doc, request.user):
                        raise ValueError("Not permitted.")
                    Document.objects.filter(id=doc.id).update(
                        deleted_at=None, deleted_by=None, updated_at=timezone.now()
                    )
                    from apps.search.indexing import queue_index_document
                    queue_index_document(str(doc.id))
                    self.record_audit("document.restored", doc, {"bulk_action": True})
                elif act == "purge":
                    if not doc.deleted_at:
                        raise ValueError("Only documents in Trash can be permanently deleted.")
                    if not self._can_manage_trash(doc, request.user):
                        raise ValueError("Not permitted.")
                    purge_id = str(doc.id)
                    self.record_audit("document.purged", doc, {"bulk_action": True, "reference": doc.reference_number})
                    doc.hard_delete()
                    from apps.search.indexing import queue_deindex_document
                    queue_deindex_document(purge_id)
                results.append({"id": str(doc_id), "success": True})
            except (WorkflowError, ValueError, AttributeError) as exc:
                results.append({"id": str(doc_id), "success": False, "detail": str(exc)})

        succeeded = sum(1 for r in results if r["success"])
        return Response(
            {"succeeded": succeeded, "failed": len(results) - succeeded, "results": results},
            status=status.HTTP_200_OK if succeeded else status.HTTP_400_BAD_REQUEST,
        )

    @action(detail=False, methods=["post"], url_path="email_selected")
    def email_selected(self, request):
        serializer = DocumentEmailSelectedSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)

        doc_ids = serializer.validated_data["document_ids"]
        attachment_mode = serializer.validated_data["attachment_mode"]
        message = serializer.validated_data.get("message", "").strip()

        recipient_users = list(
            User.objects.filter(
                id__in=serializer.validated_data.get("recipient_user_ids", []),
                is_active=True,
            )
        )
        recipients = {user.email.strip().lower() for user in recipient_users if user.email}
        recipients.update(
            email.strip().lower()
            for email in serializer.validated_data.get("recipient_emails", [])
            if email
        )
        recipients.discard("")

        if not recipients:
            return Response({"detail": "No valid recipient email addresses found."}, status=400)

        documents = list(
            Document.objects
            .filter(id__in=doc_ids)
            .select_related("document_type", "uploaded_by")
        )
        # Preserve the caller's order — it controls stitching order.
        order = {str(doc_id): idx for idx, doc_id in enumerate(doc_ids)}
        documents.sort(key=lambda d: order.get(str(d.id), len(order)))
        found_ids = {doc.id for doc in documents}
        missing_ids = [str(doc_id) for doc_id in doc_ids if doc_id not in found_ids]

        from .bundling import collect_document_files, stitch_items_to_pdf
        attachments, skipped = collect_document_files(documents, request.user)

        if not attachments:
            return Response({
                "detail": "No selected documents could be attached.",
                "missing": missing_ids,
                "skipped": skipped,
            }, status=400)

        sender_name = request.user.get_full_name().strip() or request.user.email
        subject = (
            f"{sender_name} shared {attachments[0]['document'].title}"
            if len(attachments) == 1
            else f"{sender_name} shared {len(attachments)} documents"
        )
        attachment_lines = "\n".join(
            f"- {item['document'].title} ({item['document'].reference_number})"
            for item in attachments
        )
        body = (
            f"{sender_name} shared document file(s) with you from IDM.\n\n"
            f"{attachment_lines}\n"
        )
        if message:
            body = f"{body}\nMessage:\n{message}\n"

        email = EmailMessage(
            subject=subject,
            body=body,
            from_email=settings.DEFAULT_FROM_EMAIL,
            to=sorted(recipients),
        )

        # "combined" = stitch documents into ONE merged PDF (in the chosen order).
        if attachment_mode == "combined" and len(attachments) > 1:
            stitched_pdf, stitch_skipped = stitch_items_to_pdf(attachments)
            skipped.extend(stitch_skipped)
            if stitched_pdf:
                email.attach("documents.pdf", stitched_pdf, "application/pdf")
            else:
                # Nothing could be stitched — fall back to individual attachments.
                for item in attachments:
                    email.attach(item["filename"], item["raw"], item["content_type"])
        else:
            for item in attachments:
                email.attach(item["filename"], item["raw"], item["content_type"])

        email.send(fail_silently=False)

        for item in attachments:
            self.record_audit(
                "document.emailed",
                item["document"],
                {
                    "recipients": sorted(recipients),
                    "attachment_mode": attachment_mode,
                    "bulk_action": True,
                },
            )

        return Response({
            "sent_to": sorted(recipients),
            "attached": len(attachments),
            "missing": missing_ids,
            "skipped": skipped,
        })

    @action(detail=False, methods=["post"], url_path="download_selected")
    def download_selected(self, request):
        """
        Bulk-download selected documents.

        Body:
          document_ids: list[str]  — required
          format:       str        — "original" (default) | "pdf" | "merged_pdf"

        Formats:
          original    → ZIP of original files (existing behaviour)
          pdf         → ZIP where every file is converted to its PDF representation
          merged_pdf  → single merged PDF (stitched in selection order)
        """
        from django.http import HttpResponse
        from .bundling import collect_document_files, collect_document_files_as_pdf, zip_items, stitch_items_to_pdf

        doc_ids = request.data.get("document_ids") or []
        fmt = (request.data.get("format") or "original").strip().lower()
        if fmt not in ("original", "pdf", "merged_pdf"):
            fmt = "original"

        if not isinstance(doc_ids, list) or not doc_ids:
            return Response({"detail": "No documents selected."}, status=400)
        if len(doc_ids) > 100:
            return Response({"detail": "Select at most 100 documents."}, status=400)

        documents = list(
            Document.objects.filter(id__in=doc_ids).select_related("document_type", "uploaded_by")
        )
        order = {str(doc_id): idx for idx, doc_id in enumerate(doc_ids)}
        documents.sort(key=lambda d: order.get(str(d.id), len(order)))

        if fmt == "pdf":
            items, skipped = collect_document_files_as_pdf(documents, request.user)
        else:
            items, skipped = collect_document_files(documents, request.user)

        if not items:
            return Response(
                {"detail": "No selected documents could be downloaded.", "skipped": skipped},
                status=400,
            )

        if fmt == "merged_pdf":
            pdf_bytes, stitch_skipped = stitch_items_to_pdf(items)
            skipped.extend(stitch_skipped)
            if not pdf_bytes:
                return Response(
                    {"detail": "Could not produce a merged PDF. Ensure documents have PDF previews.", "skipped": skipped},
                    status=400,
                )
            for item in items:
                self.record_audit("document.downloaded", item["document"], {"bulk_action": True, "via": "merged_pdf"})
            response = HttpResponse(pdf_bytes, content_type="application/pdf")
            response["Content-Disposition"] = 'attachment; filename="documents-merged.pdf"'
            response["X-Skipped-Count"] = str(len(skipped))
            return response

        # ZIP download (original or pdf-converted)
        zip_bytes = zip_items(items)
        for item in items:
            via = "zip_pdf" if fmt == "pdf" else "zip"
            self.record_audit("document.downloaded", item["document"], {"bulk_action": True, "via": via})

        filename = "documents-pdf.zip" if fmt == "pdf" else "documents.zip"
        response = HttpResponse(zip_bytes, content_type="application/zip")
        response["Content-Disposition"] = f'attachment; filename="{filename}"'
        response["X-Skipped-Count"] = str(len(skipped))
        return response

    @action(detail=True, methods=["get"], url_path="download_as_pdf")
    def download_as_pdf(self, request, pk=None):
        """
        Download a single document as PDF.

        Strategy:
          - Already a PDF  → stream the original file.
          - Office doc     → stream the generated preview PDF (if available).
          - Image          → convert to single-page PDF via PIL.
          - Other formats  → 400 (no PDF representation).
        """
        from django.http import HttpResponse

        doc = self.get_object()
        if not user_can_download_document(request.user, doc):
            return Response({"detail": "Download not permitted."}, status=403)

        mime = (doc.file_mime_type or "").lower()
        filename = doc.file_name or "document"

        # PDFs served directly.
        if mime == "application/pdf" or filename.lower().endswith(".pdf"):
            try:
                from .file_streaming import read_document_bytes
                raw, content_type, name = read_document_bytes(doc, version=None, use_preview=False)
            except FileNotFoundError as exc:
                return Response({"detail": str(exc)}, status=404)
            stem = filename.rsplit(".", 1)[0] if "." in filename else filename
            self.record_audit(AuditEvent.DOCUMENT_DOWNLOADED, doc, {"format": "pdf"})
            response = HttpResponse(raw, content_type="application/pdf")
            response["Content-Disposition"] = f'attachment; filename="{stem}.pdf"'
            return response

        # Office documents: use the preview PDF.
        if doc.is_office_doc() and doc.preview_pdf:
            try:
                with doc.preview_pdf.open("rb") as fh:
                    pdf_bytes = fh.read()
                stem = filename.rsplit(".", 1)[0] if "." in filename else filename
                self.record_audit(AuditEvent.DOCUMENT_DOWNLOADED, doc, {"format": "pdf", "via": "preview"})
                response = HttpResponse(pdf_bytes, content_type="application/pdf")
                response["Content-Disposition"] = f'attachment; filename="{stem}.pdf"'
                return response
            except Exception:
                return Response(
                    {"detail": "PDF preview is not ready yet. Try again after preview generation completes."},
                    status=400,
                )

        # Images: convert via PIL.
        if mime.startswith("image/") or filename.lower().endswith((".png", ".jpg", ".jpeg", ".tif", ".tiff", ".bmp", ".gif")):
            try:
                import io as _io
                from PIL import Image
                from .file_streaming import read_document_bytes
                raw, _, _ = read_document_bytes(doc, version=None, use_preview=False)
                img = Image.open(_io.BytesIO(raw))
                if img.mode not in ("RGB", "L"):
                    img = img.convert("RGB")
                out = _io.BytesIO()
                img.save(out, "PDF")
                stem = filename.rsplit(".", 1)[0] if "." in filename else filename
                self.record_audit(AuditEvent.DOCUMENT_DOWNLOADED, doc, {"format": "pdf", "via": "pil"})
                response = HttpResponse(out.getvalue(), content_type="application/pdf")
                response["Content-Disposition"] = f'attachment; filename="{stem}.pdf"'
                return response
            except Exception:
                return Response({"detail": "Could not convert this image to PDF."}, status=400)

        # No PDF representation.
        return Response(
            {"detail": "This document format cannot be converted to PDF. "
                       "For Office documents, wait for the preview to finish generating."},
            status=400,
        )

    @action(detail=False, methods=["post"], url_path="share_selected")
    def share_selected(self, request):
        serializer = DocumentShareSelectedSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)

        doc_ids = serializer.validated_data["document_ids"]
        recipient_ids = serializer.validated_data["recipient_user_ids"]
        access_level = serializer.validated_data["access_level"]
        message = serializer.validated_data.get("message", "").strip()
        expires_at = serializer.validated_data.get("expires_at")
        notify_by_email = serializer.validated_data.get("notify_by_email", False)

        recipients = list(User.objects.filter(id__in=recipient_ids, is_active=True))
        recipients = [user for user in recipients if user.id != request.user.id]
        if not recipients:
            return Response({"detail": "Select at least one active recipient."}, status=400)

        documents = list(
            Document.objects
            .filter(id__in=doc_ids)
            .select_related("document_type", "uploaded_by")
        )
        found_ids = {doc.id for doc in documents}
        missing_ids = [str(doc_id) for doc_id in doc_ids if doc_id not in found_ids]

        shared = []
        skipped = []
        sender_name = request.user.get_full_name().strip() or request.user.email

        with transaction.atomic():
            for doc in documents:
                if not user_can_view_document(request.user, doc):
                    skipped.append({
                        "id": str(doc.id),
                        "title": doc.title,
                        "detail": "View permission is required before sharing.",
                    })
                    continue

                document_link = f"/documents/{doc.id}"
                for recipient in recipients:
                    share, created = DocumentShare.objects.update_or_create(
                        document=doc,
                        recipient=recipient,
                        defaults={
                            "shared_by": request.user,
                            "access_level": access_level,
                            "message": message,
                            "expires_at": expires_at,
                            "revoked_at": None,
                        },
                    )
                    Notification.objects.create(
                        recipient=recipient,
                        type="document_shared",
                        message=f"{sender_name} shared '{doc.title}' with you.",
                        link=document_link,
                    )
                    shared.append({
                        "document_id": str(doc.id),
                        "recipient_id": str(recipient.id),
                        "created": created,
                        "share_id": str(share.id),
                    })

                self.record_audit(
                    "document.shared",
                    doc,
                    {
                        "recipients": [str(user.id) for user in recipients],
                        "access_level": access_level,
                        "expires_at": expires_at.isoformat() if expires_at else None,
                        "bulk_action": True,
                    },
                )

        if notify_by_email:
            document_lines = "\n".join(
                f"- {doc.title} ({doc.reference_number}): /documents/{doc.id}"
                for doc in documents
                if user_can_view_document(request.user, doc)
            )
            body = f"{sender_name} shared document(s) with you in IDM.\n\n{document_lines}\n"
            if message:
                body = f"{body}\nMessage:\n{message}\n"
            for recipient in recipients:
                if recipient.email:
                    EmailMessage(
                        subject=f"{sender_name} shared document(s) with you in IDM",
                        body=body,
                        from_email=settings.DEFAULT_FROM_EMAIL,
                        to=[recipient.email],
                    ).send(fail_silently=True)

        return Response({
            "shared": len(shared),
            "recipients": len(recipients),
            "missing": missing_ids,
            "skipped": skipped,
            "results": shared,
        })

    @action(detail=True, methods=["get", "post"], url_path="relationships")
    def relationships(self, request, pk=None):
        doc = self.get_object()

        if request.method == "GET":
            relationships = (
                DocumentRelationship.objects
                .filter(models.Q(source_document=doc) | models.Q(target_document=doc))
                .select_related(
                    "source_document",
                    "source_document__document_type",
                    "target_document",
                    "target_document__document_type",
                    "created_by",
                )
            )
            visible_relationships = [
                relationship for relationship in relationships
                if user_can_view_document(request.user, relationship.source_document)
                and user_can_view_document(request.user, relationship.target_document)
                and (
                    request.user.has_admin_access
                    or (
                        relationship.source_document.uploaded_by_id == request.user.id
                        or getattr(relationship.source_document, "owned_by_id", None) == request.user.id
                    )
                    and (
                        relationship.target_document.uploaded_by_id == request.user.id
                        or getattr(relationship.target_document, "owned_by_id", None) == request.user.id
                    )
                )
            ]
            serializer = DocumentRelationshipSerializer(
                visible_relationships,
                many=True,
                context={**self.get_serializer_context(), "document_id": str(doc.id)},
            )
            return Response(serializer.data)

        if not user_can_edit_document(request.user, doc):
            return Response({"detail": "Edit permission is required to link documents."}, status=403)

        serializer = DocumentRelationshipWriteSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        target_id = serializer.validated_data["target_document_id"]
        if str(target_id) == str(doc.id):
            return Response({"detail": "A document cannot be related to itself."}, status=400)

        target = get_object_or_404(
            Document.objects.select_related("document_type", "uploaded_by"),
            id=target_id,
        )
        if not user_can_view_document(request.user, target):
            return Response({"detail": "You do not have access to the selected related document."}, status=403)
        if (
            not request.user.has_admin_access
            and target.uploaded_by_id != request.user.id
            and getattr(target, "owned_by_id", None) != request.user.id
        ):
            return Response(
                {"detail": "You can only link documents that belong to you."},
                status=403,
            )

        relationship, created = DocumentRelationship.objects.get_or_create(
            source_document=doc,
            target_document=target,
            relation_type=serializer.validated_data["relation_type"],
            defaults={
                "note": serializer.validated_data.get("note", "").strip(),
                "created_by": request.user,
            },
        )
        if not created:
            return Response({"detail": "This relationship already exists."}, status=400)

        self.record_audit(
            "document.relationship_added",
            doc,
            {
                "relationship_id": str(relationship.id),
                "relation_type": relationship.relation_type,
                "target_document_id": str(target.id),
                "target_reference_number": target.reference_number,
            },
        )
        response_serializer = DocumentRelationshipSerializer(
            relationship,
            context={**self.get_serializer_context(), "document_id": str(doc.id)},
        )
        return Response(response_serializer.data, status=status.HTTP_201_CREATED)

    @action(detail=True, methods=["delete"], url_path=r"relationships/(?P<relationship_id>[^/.]+)")
    def relationship_detail(self, request, pk=None, relationship_id=None):
        doc = self.get_object()
        if not user_can_edit_document(request.user, doc):
            return Response({"detail": "Edit permission is required to unlink documents."}, status=403)
        relationship = get_object_or_404(
            DocumentRelationship,
            models.Q(source_document=doc) | models.Q(target_document=doc),
            id=relationship_id,
        )
        changes = {
            "relationship_id": str(relationship.id),
            "relation_type": relationship.relation_type,
            "source_document_id": str(relationship.source_document_id),
            "target_document_id": str(relationship.target_document_id),
        }
        relationship.delete()
        self.record_audit("document.relationship_removed", doc, changes)
        return Response(status=status.HTTP_204_NO_CONTENT)


class TagViewSet(viewsets.ModelViewSet):
    queryset           = Tag.objects.all()
    serializer_class   = TagSerializer
    permission_classes = [permissions.IsAuthenticated]
