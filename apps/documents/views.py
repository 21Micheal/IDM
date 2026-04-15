"""
documents/views.py
REST API endpoints for document management.
"""
from rest_framework import viewsets, status, permissions
from rest_framework.decorators import action
from django.db.models import Q
from rest_framework.response import Response
from rest_framework.parsers import MultiPartParser, FormParser, JSONParser
from django_filters.rest_framework import DjangoFilterBackend
from rest_framework.filters import SearchFilter, OrderingFilter
from django.shortcuts import get_object_or_404
from django.utils import timezone

from .models import Document, DocumentType, DocumentVersion, Tag, DocumentStatus
from .serializers import (
    DocumentListSerializer, DocumentDetailSerializer,
    DocumentUploadSerializer, DocumentTypeSerializer,
    DocumentVersionSerializer, DocumentCommentSerializer,
    TagSerializer,
)
from .filters import DocumentFilter
from .permissions import HasDocumentPermission
from apps.accounts.models import Role, GroupAction
from apps.audit.mixins import AuditMixin


class DocumentTypeViewSet(viewsets.ModelViewSet):
    """CRUD for document types. Admin only for write operations."""
    queryset = DocumentType.objects.prefetch_related("metadata_fields").filter(is_active=True)
    serializer_class = DocumentTypeSerializer
    filter_backends = [SearchFilter, OrderingFilter]
    search_fields = ["name", "code", "description"]
    ordering_fields = ["name", "code", "created_at"]

    def get_permissions(self):
        if self.action in ("create", "update", "partial_update", "destroy"):
            return [permissions.IsAuthenticated(), permissions.IsAdminUser()]
        return [permissions.IsAuthenticated()]

    def perform_create(self, serializer):
        serializer.save(created_by=self.request.user)


class DocumentViewSet(AuditMixin, viewsets.ModelViewSet):
    """
    Main document CRUD endpoint.

    GET    /documents/           → paginated list with filters
    POST   /documents/           → upload new document
    GET    /documents/{id}/      → full detail with versions & comments
    PATCH  /documents/{id}/      → update metadata / status
    DELETE /documents/{id}/      → soft-delete (set status=void)

    Extra actions:
    POST /documents/{id}/submit/         → submit for approval
    POST /documents/{id}/archive/        → archive
    POST /documents/{id}/upload_version/ → upload new file revision
    POST /documents/{id}/restore_version/→ restore to a prior version
    GET  /documents/{id}/preview_url/    → signed URL or viewer URL
    POST /documents/{id}/comments/       → add comment
    GET  /documents/{id}/audit_trail/    → audit events for this document
    """
    permission_classes = [permissions.IsAuthenticated, HasDocumentPermission]
    filter_backends = [DjangoFilterBackend, SearchFilter, OrderingFilter]
    filterset_class = DocumentFilter
    search_fields = ["title", "reference_number", "supplier", "extracted_text"]
    ordering_fields = ["created_at", "document_date", "amount", "title", "reference_number"]
    ordering = ["-created_at"]
    parser_classes = [MultiPartParser, FormParser, JSONParser]

    def get_queryset(self):
        user = self.request.user
        qs = (
            Document.objects
            .select_related("document_type", "uploaded_by", "department")
            .prefetch_related("tags", "versions")
        )

        if user.is_admin:
            return qs

        # Optional optimization: only return documents where user has VIEW permission
        # This is a soft filter — the permission class still does the hard enforcement
        visible_types = self._get_user_visible_document_types(user)
        if visible_types:
            qs = qs.filter(document_type_id__in=visible_types)

        return qs

    def _get_user_visible_document_types(self, user):
        """Helper to get document types the user can at least VIEW"""
        from apps.accounts.models import GroupPermission
        memberships = user.group_memberships.filter(
            Q(expires_at__isnull=True) | Q(expires_at__gt=timezone.now()),
            group__is_active=True
        ).values_list("group_id", flat=True)

        return GroupPermission.objects.filter(
            group_id__in=memberships,
            action=GroupAction.VIEW.value,
            document_type_id__isnull=False
        ).values_list("document_type_id", flat=True).distinct()

    def get_serializer_class(self):
        if self.action == "list":
            return DocumentListSerializer
        if self.action == "create":
            return DocumentUploadSerializer
        return DocumentDetailSerializer

    def create(self, request, *args, **kwargs):
        """
        Override create so the POST /documents/ response uses DocumentDetailSerializer
        (which includes `id`, `reference_number`, versions, comments, etc.) rather
        than the write-only DocumentUploadSerializer that has no `id` field.
        Without this the frontend receives `data.id === undefined` and navigates
        to /documents/undefined/.
        """
        upload_serializer = self.get_serializer(data=request.data)
        upload_serializer.is_valid(raise_exception=True)
        doc = upload_serializer.save()
        self.record_audit("document.uploaded", doc)
        # Re-serialise with the full detail serializer so `id` is present
        detail = DocumentDetailSerializer(doc, context={"request": request})
        headers = self.get_success_headers(detail.data)
        return Response(detail.data, status=status.HTTP_201_CREATED, headers=headers)

    def perform_destroy(self, instance):
        # Soft delete
        instance.status = DocumentStatus.VOID
        instance.save(update_fields=["status", "updated_at"])
        self.record_audit("document.deleted", instance)

    @action(detail=True, methods=["post"])
    def submit(self, request, pk=None):
        """Submit document for approval workflow."""
        doc = self.get_object()
        if doc.status not in (DocumentStatus.DRAFT, DocumentStatus.REJECTED):
            return Response(
                {"detail": "Only draft or rejected documents can be submitted."},
                status=status.HTTP_400_BAD_REQUEST,
            )
        if not doc.document_type.workflow_template:
            return Response(
                {"detail": "No workflow template assigned to this document type."},
                status=status.HTTP_400_BAD_REQUEST,
            )
        from apps.workflows.services import WorkflowService
        WorkflowService.start(doc, request.user)
        doc.status = DocumentStatus.PENDING_APPROVAL
        doc.save(update_fields=["status", "updated_at"])
        self.record_audit("document.submitted", doc)
        return Response(DocumentDetailSerializer(doc, context={"request": request}).data)

    @action(detail=True, methods=["post"])
    def archive(self, request, pk=None):
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

    @action(detail=True, methods=["post"], parser_classes=[MultiPartParser])
    def upload_version(self, request, pk=None):
        """Upload a new version of the file."""
        doc = self.get_object()
        file = request.FILES.get("file")
        if not file:
            return Response({"detail": "No file provided."}, status=400)

        import hashlib
        sha256 = hashlib.sha256()
        for chunk in file.chunks():
            sha256.update(chunk)
        file.seek(0)

        new_version = doc.current_version + 1
        version = DocumentVersion.objects.create(
            document=doc,
            version_number=new_version,
            file=file,
            file_name=file.name,
            file_size=file.size,
            checksum=sha256.hexdigest(),
            change_summary=request.data.get("change_summary", ""),
            created_by=request.user,
        )
        doc.file = file
        doc.file_name = file.name
        doc.file_size = file.size
        doc.checksum = sha256.hexdigest()
        doc.current_version = new_version
        doc.save()

        self.record_audit("document.version_uploaded", doc, {"version": new_version})
        return Response(DocumentVersionSerializer(version).data, status=status.HTTP_201_CREATED)

    @action(detail=True, methods=["post"])
    def restore_version(self, request, pk=None):
        """Restore document file to a previous version."""
        doc = self.get_object()
        version_id = request.data.get("version_id")
        version = get_object_or_404(DocumentVersion, id=version_id, document=doc)

        doc.file = version.file
        doc.file_name = version.file_name
        doc.file_size = version.file_size
        doc.checksum = version.checksum
        doc.current_version = version.version_number
        doc.save()

        self.record_audit("document.version_restored", doc, {"version": version.version_number})
        return Response({"detail": f"Restored to version {version.version_number}"})

    @action(detail=True, methods=["get"])
    def preview_url(self, request, pk=None):
        """Return viewer configuration for this document."""
        doc = self.get_object()
        self.record_audit("document.viewed", doc)

        if doc.is_pdf():
            viewer = "pdfjs"
            url = request.build_absolute_uri(doc.file.url)
        elif doc.is_office_doc():
            viewer = "google_docs"
            abs_url = request.build_absolute_uri(doc.file.url)
            url = f"https://docs.google.com/viewer?url={abs_url}&embedded=true"
        else:
            viewer = "download"
            url = request.build_absolute_uri(doc.file.url)

        return Response({"viewer": viewer, "url": url})

    @action(detail=True, methods=["get", "post"])
    def comments(self, request, pk=None):
        doc = self.get_object()
        if request.method == "GET":
            qs = doc.comments.all()
            if not (request.user.is_admin or request.user.is_auditor):
                qs = qs.filter(is_internal=False)
            return Response(DocumentCommentSerializer(qs, many=True).data)

        serializer = DocumentCommentSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        serializer.save(document=doc, author=request.user)
        return Response(serializer.data, status=status.HTTP_201_CREATED)

    @action(detail=True, methods=["get"])
    def audit_trail(self, request, pk=None):
        from apps.audit.serializers import AuditLogSerializer
        from apps.audit.models import AuditLog
        doc = self.get_object()
        logs = AuditLog.objects.filter(object_type="Document", object_id=str(doc.id))
        return Response(AuditLogSerializer(logs, many=True).data)


class TagViewSet(viewsets.ModelViewSet):
    queryset = Tag.objects.all()
    serializer_class = TagSerializer
    permission_classes = [permissions.IsAuthenticated]