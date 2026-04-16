"""
apps/documents/views.py

Changes from uploaded version
──────────────────────────────
1. DocumentViewSet.get_queryset() — the original GROUP-based filter used a
   deeply nested JOIN that ORM couldn't resolve cleanly for documents whose
   document_type has wildcard permissions (document_type=None).  Replaced
   with a clean two-branch filter that also handles the NULL wildcard case.

2. Removed inline permission re-checks from submit(), archive(),
   edit_metadata(), comments(), upload_version().  Those checks duplicated
   logic already enforced by HasDocumentPermission.has_object_permission()
   and were the secondary cause of 403 errors: a user with correct group
   permissions still hit the inline guard because get_all_permissions_for_doctype
   was queried twice (once in has_object_permission, once inline) but the
   second call used a slightly different path that could return an empty set.

   The single authoritative gate is now HasDocumentPermission.  Any action
   that genuinely needs a DIFFERENT permission from what the class already
   enforces (e.g., submit needing APPROVE rather than EDIT) is handled
   correctly via _get_required_action() in permissions.py.

3. restore_version and bulk_action are fully implemented (were "# ... keep
   as-is" stubs in the uploaded version).

4. AuditMixin.record_audit() calls retained; no functional change there.
"""
import hashlib

from rest_framework import viewsets, status, permissions
from rest_framework.decorators import action
from rest_framework.response import Response
from rest_framework.parsers import MultiPartParser, FormParser, JSONParser
from django_filters.rest_framework import DjangoFilterBackend
from rest_framework.filters import SearchFilter, OrderingFilter
from django.db import transaction
from django.db.models import Q

from .models import Document, DocumentType, DocumentVersion, Tag, DocumentStatus
from .serializers import (
    DocumentListSerializer, DocumentDetailSerializer,
    DocumentUploadSerializer, DocumentTypeSerializer,
    DocumentVersionSerializer, DocumentCommentSerializer,
    DocumentMetadataEditSerializer, DocumentBulkActionSerializer,
    TagSerializer,
)
from .filters import DocumentFilter
from .permissions import HasDocumentPermission
from apps.audit.mixins import AuditMixin
from apps.accounts.models import GroupAction


# ── Document Types ─────────────────────────────────────────────────────────────

class DocumentTypeViewSet(AuditMixin, viewsets.ModelViewSet):
    """CRUD for document types. Admin-only for write operations."""
    queryset         = DocumentType.objects.prefetch_related("metadata_fields").filter(is_active=True)
    serializer_class = DocumentTypeSerializer

    def get_permissions(self):
        if self.action in ("create", "update", "partial_update", "destroy"):
            return [permissions.IsAuthenticated(), permissions.IsAdminUser()]
        return [permissions.IsAuthenticated()]

    def perform_create(self, serializer):
        serializer.save(created_by=self.request.user)

    def perform_destroy(self, instance):
        # Soft-delete to preserve FK integrity
        instance.is_active = False
        instance.save(update_fields=["is_active", "updated_at"])


# ── Documents ──────────────────────────────────────────────────────────────────

class DocumentViewSet(AuditMixin, viewsets.ModelViewSet):
    """
    Main document CRUD with group-based permissions.

    Permission model
    ────────────────
    HasDocumentPermission is the single gate.  Views do NOT re-check
    permissions inline — the permission class already handles action-level
    mapping via _get_required_action().
    """
    permission_classes = [permissions.IsAuthenticated, HasDocumentPermission]
    filter_backends    = [DjangoFilterBackend, SearchFilter, OrderingFilter]
    filterset_class    = DocumentFilter
    search_fields      = ["title", "reference_number", "supplier", "extracted_text"]
    ordering_fields    = ["created_at", "document_date", "amount", "title", "reference_number"]
    ordering           = ["-created_at"]
    parser_classes     = [MultiPartParser, FormParser, JSONParser]

    def get_queryset(self):
        user = self.request.user
        base_qs = (
            Document.objects
            .select_related("document_type", "uploaded_by", "department")
            .prefetch_related("tags", "versions")
        )

        # Admins and auditors see everything
        if user.is_admin or user.is_auditor:
            return base_qs

        # Regular users: own uploads OR documents where their group membership
        # grants VIEW permission (including wildcard groups where document_type IS NULL).
        from apps.accounts.models import GroupPermission
        from django.utils import timezone

        now = timezone.now()

        # Subquery: document_type IDs the user can view via explicit group permissions
        permitted_type_ids = (
            GroupPermission.objects
            .filter(
                group__memberships__user=user,
                group__is_active=True,
                action=GroupAction.VIEW.value,
                document_type__isnull=False,          # explicit doc-type permissions
            )
            .filter(
                Q(group__memberships__expires_at__isnull=True)
                | Q(group__memberships__expires_at__gt=now)
            )
            .values_list("document_type_id", flat=True)
        )

        # Wildcard: any group the user is in with NULL document_type + VIEW
        has_wildcard = (
            GroupPermission.objects
            .filter(
                group__memberships__user=user,
                group__is_active=True,
                action=GroupAction.VIEW.value,
                document_type__isnull=True,           # wildcard
            )
            .filter(
                Q(group__memberships__expires_at__isnull=True)
                | Q(group__memberships__expires_at__gt=now)
            )
            .exists()
        )

        if has_wildcard:
            # Wildcard group — user can see all documents
            return base_qs

        return base_qs.filter(
            Q(uploaded_by=user)
            | Q(document_type_id__in=permitted_type_ids)
        ).distinct()

    def get_serializer_class(self):
        if self.action == "list":
            return DocumentListSerializer
        if self.action == "create":
            return DocumentUploadSerializer
        return DocumentDetailSerializer

    def perform_destroy(self, instance):
        # Soft-delete: mark as VOID rather than deleting the row
        instance.status = DocumentStatus.VOID
        instance.save(update_fields=["status", "updated_at"])
        self.record_audit("document.deleted", instance)

    # ── Submit for approval ────────────────────────────────────────────────

    @action(detail=True, methods=["post"])
    def submit(self, request, pk=None):
        """
        Transition document from DRAFT/REJECTED → workflow in-progress.
        Permission gate: HasDocumentPermission maps "submit" → APPROVE.
        No inline permission re-check needed here.
        """
        doc = self.get_object()   # triggers has_object_permission

        if doc.status not in (DocumentStatus.DRAFT, DocumentStatus.REJECTED):
            return Response(
                {"detail": "Only draft or rejected documents can be submitted."},
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

    # ── Archive ────────────────────────────────────────────────────────────

    @action(detail=True, methods=["post"])
    def archive(self, request, pk=None):
        """
        Permission gate: HasDocumentPermission maps "archive" → ARCHIVE.
        """
        doc = self.get_object()

        if doc.status != DocumentStatus.APPROVED:
            return Response(
                {"detail": "Only approved documents can be archived."},
                status=status.HTTP_400_BAD_REQUEST,
            )

        doc.status = DocumentStatus.ARCHIVED
        doc.save(update_fields=["status", "updated_at"])
        self.record_audit("document.archived", doc)
        return Response({"status": "archived"})

    # ── Edit metadata ──────────────────────────────────────────────────────

    @action(detail=True, methods=["patch"])
    def edit_metadata(self, request, pk=None):
        """
        Permission gate: HasDocumentPermission maps "edit_metadata" → EDIT.
        """
        doc = self.get_object()

        if doc.status not in (DocumentStatus.DRAFT, DocumentStatus.REJECTED):
            return Response(
                {"detail": "Metadata can only be edited on draft or rejected documents."},
                status=status.HTTP_400_BAD_REQUEST,
            )

        serializer = DocumentMetadataEditSerializer(
            doc, data=request.data, partial=True, context={"request": request}
        )
        serializer.is_valid(raise_exception=True)
        serializer.save()
        self.record_audit("document.updated", doc)
        return Response(DocumentDetailSerializer(doc, context={"request": request}).data)

    # ── Comments ───────────────────────────────────────────────────────────

    @action(detail=True, methods=["get", "post"])
    def comments(self, request, pk=None):
        """
        GET  → VIEW permission (mapped by permissions.py).
        POST → COMMENT permission (mapped by permissions.py).
        Both checked via has_object_permission before this runs.
        """
        doc = self.get_object()

        if request.method == "GET":
            qs = doc.comments.all()
            # Non-admin/auditor users cannot see internal notes
            if not (request.user.is_admin or request.user.is_auditor):
                qs = qs.filter(is_internal=False)
            return Response(DocumentCommentSerializer(qs, many=True).data)

        serializer = DocumentCommentSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        serializer.save(document=doc, author=request.user)
        self.record_audit("document.commented", doc)
        return Response(serializer.data, status=status.HTTP_201_CREATED)

    # ── Version upload ─────────────────────────────────────────────────────

    @action(detail=True, methods=["post"], parser_classes=[MultiPartParser])
    def upload_version(self, request, pk=None):
        """
        Permission gate: HasDocumentPermission maps "upload_version" → UPLOAD.
        """
        doc  = self.get_object()
        file = request.FILES.get("file")

        if not file:
            return Response({"detail": "No file provided."}, status=status.HTTP_400_BAD_REQUEST)

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
        version = DocumentVersion.objects.create(
            document       = doc,
            version_number = new_version,
            file           = file,
            file_name      = file.name,
            file_size      = file.size,
            checksum       = checksum,
            change_summary = request.data.get("change_summary", ""),
            created_by     = request.user,
        )

        doc.file            = file
        doc.file_name       = file.name
        doc.file_size       = file.size
        doc.checksum        = checksum
        doc.current_version = new_version
        doc.save()

        self.record_audit("document.version_uploaded", doc, {"version": new_version})
        return Response(DocumentVersionSerializer(version).data, status=status.HTTP_201_CREATED)

    # ── Version restore ────────────────────────────────────────────────────

    @action(detail=True, methods=["post"])
    def restore_version(self, request, pk=None):
        """
        Restore a previous version as the current file.
        Permission gate: "restore_version" → UPLOAD (same as upload_version).
        """
        doc        = self.get_object()
        version_id = request.data.get("version_id")

        if not version_id:
            return Response(
                {"detail": "version_id is required."},
                status=status.HTTP_400_BAD_REQUEST,
            )

        try:
            version = doc.versions.get(id=version_id)
        except DocumentVersion.DoesNotExist:
            return Response(
                {"detail": "Version not found."},
                status=status.HTTP_404_NOT_FOUND,
            )

        new_version_number = doc.current_version + 1

        with transaction.atomic():
            # Create a new version entry that mirrors the restored one
            DocumentVersion.objects.create(
                document       = doc,
                version_number = new_version_number,
                file           = version.file,
                file_name      = version.file_name,
                file_size      = version.file_size,
                checksum       = version.checksum,
                change_summary = f"Restored from version {version.version_number}",
                created_by     = request.user,
            )

            doc.file            = version.file
            doc.file_name       = version.file_name
            doc.file_size       = version.file_size
            doc.checksum        = version.checksum
            doc.current_version = new_version_number
            doc.save()

        self.record_audit(
            "document.version_restored",
            doc,
            {"restored_from": version.version_number, "new_version": new_version_number},
        )
        return Response(
            DocumentDetailSerializer(doc, context={"request": request}).data
        )

    # ── Preview URL ────────────────────────────────────────────────────────

    @action(detail=True, methods=["get"])
    def preview_url(self, request, pk=None):
        doc = self.get_object()
        self.record_audit("document.viewed", doc)

        try:
            file_url = request.build_absolute_uri(doc.file.url)
        except ValueError:
            return Response({"detail": "No file attached."}, status=status.HTTP_400_BAD_REQUEST)

        mime = doc.file_mime_type or ""

        if mime == "application/pdf":
            viewer   = "pdfjs"
        elif mime in (
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            "application/msword",
            "application/vnd.ms-excel",
        ):
            viewer   = "google_docs"
            file_url = f"https://docs.google.com/viewer?url={file_url}&embedded=true"
        else:
            viewer   = "download"

        return Response({"viewer": viewer, "url": file_url})

    # ── Audit trail ────────────────────────────────────────────────────────

    @action(detail=True, methods=["get"])
    def audit_trail(self, request, pk=None):
        from apps.audit.serializers import AuditLogSerializer
        from apps.audit.models import AuditLog
        doc  = self.get_object()
        logs = AuditLog.objects.filter(
            object_type="Document",
            object_id=str(doc.id),
        ).order_by("-created_at")
        return Response(AuditLogSerializer(logs, many=True).data)

    # ── Bulk actions ───────────────────────────────────────────────────────

    @action(detail=False, methods=["post"])
    def bulk_action(self, request):
        """
        Approve / reject / archive / void multiple documents in one call.

        Permission model: each document is checked individually using the
        same group-permission logic as single-document actions, so a user
        cannot bulk-action documents they couldn't action individually.
        Results are returned per-document so the client can show partial success.
        """
        serializer = DocumentBulkActionSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)

        doc_ids = serializer.validated_data["document_ids"]
        act     = serializer.validated_data["action"]
        comment = serializer.validated_data.get("comment", "")

        # Map bulk action to the required GroupAction
        _required: dict[str, str] = {
            "approve": GroupAction.APPROVE.value,
            "reject":  GroupAction.APPROVE.value,
            "archive": GroupAction.ARCHIVE.value,
            "void":    GroupAction.DELETE.value,
        }
        required_perm = _required.get(act, GroupAction.APPROVE.value)

        results: list[dict] = []

        for doc_id in doc_ids:
            try:
                doc = Document.objects.select_related("document_type").get(
                    id=doc_id
                )
            except Document.DoesNotExist:
                results.append({"id": str(doc_id), "status": "error", "detail": "Not found."})
                continue

            # Per-document permission check (same logic as has_object_permission)
            if not request.user.is_admin:
                user_perms = request.user.get_all_permissions_for_doctype(
                    str(doc.document_type_id)
                )
                if required_perm not in user_perms:
                    results.append({
                        "id": str(doc_id),
                        "status": "error",
                        "detail": "Permission denied.",
                    })
                    continue

            try:
                with transaction.atomic():
                    if act == "approve":
                        from apps.workflows.services import WorkflowService
                        # Find the in-progress task for this doc and approve it
                        task = (
                            doc.workflow_instance.tasks
                            .filter(
                                assigned_to=request.user,
                                status="in_progress",
                            )
                            .select_related("step")
                            .first()
                        )
                        if task:
                            WorkflowService.approve(task, request.user, comment)
                        else:
                            results.append({
                                "id": str(doc_id),
                                "status": "error",
                                "detail": "No actionable task found.",
                            })
                            continue

                    elif act == "reject":
                        from apps.workflows.services import WorkflowService
                        task = (
                            doc.workflow_instance.tasks
                            .filter(
                                assigned_to=request.user,
                                status="in_progress",
                            )
                            .select_related("step")
                            .first()
                        )
                        if task:
                            WorkflowService.reject(task, request.user, comment)
                        else:
                            results.append({
                                "id": str(doc_id),
                                "status": "error",
                                "detail": "No actionable task found.",
                            })
                            continue

                    elif act == "archive":
                        if doc.status != DocumentStatus.APPROVED:
                            results.append({
                                "id": str(doc_id),
                                "status": "error",
                                "detail": "Only approved documents can be archived.",
                            })
                            continue
                        doc.status = DocumentStatus.ARCHIVED
                        doc.save(update_fields=["status", "updated_at"])

                    elif act == "void":
                        doc.status = DocumentStatus.VOID
                        doc.save(update_fields=["status", "updated_at"])

                    self.record_audit(f"document.bulk_{act}", doc)
                    results.append({"id": str(doc_id), "status": "ok"})

            except Exception as exc:
                results.append({"id": str(doc_id), "status": "error", "detail": str(exc)})

        return Response({"results": results})


# ── Tags ───────────────────────────────────────────────────────────────────────

class TagViewSet(viewsets.ModelViewSet):
    queryset         = Tag.objects.all()
    serializer_class = TagSerializer
    permission_classes = [permissions.IsAuthenticated]