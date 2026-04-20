"""
apps/documents/views.py

DocumentTypeViewSet fix:
  Uses DocumentTypeWriteSerializer for POST/PUT/PATCH input validation
  and DocumentTypeSerializer for the response — standard DRF split
  input/output pattern.  Metadata fields are now saved correctly.
"""
import hashlib

from rest_framework import viewsets, status, permissions
from rest_framework.decorators import action
from rest_framework.response import Response
from rest_framework.parsers import MultiPartParser, FormParser, JSONParser
from django_filters.rest_framework import DjangoFilterBackend
from rest_framework.filters import SearchFilter, OrderingFilter
from django.shortcuts import get_object_or_404

from .models import Document, DocumentType, DocumentVersion, Tag, DocumentStatus
from .serializers import (
    DocumentListSerializer, DocumentDetailSerializer,
    DocumentUploadSerializer, DocumentTypeSerializer, DocumentTypeWriteSerializer,
    DocumentVersionSerializer, DocumentCommentSerializer,
    DocumentMetadataEditSerializer, DocumentBulkActionSerializer,
    TagSerializer,
)
from .filters import DocumentFilter
from .permissions import HasDocumentPermission
from apps.audit.mixins import AuditMixin


# ── Document Type ViewSet ─────────────────────────────────────────────────────

class DocumentTypeViewSet(AuditMixin, viewsets.ModelViewSet):
    """
    GET    /documents/types/         → list (read serializer)
    GET    /documents/types/{id}/    → detail (read serializer)
    POST   /documents/types/         → create (write serializer in, read serializer out)
    PATCH  /documents/types/{id}/    → partial update (write serializer in, read serializer out)
    DELETE /documents/types/{id}/    → soft-delete (is_active=False)
    """
    queryset = DocumentType.objects.prefetch_related(
        "metadata_fields"
    ).filter(is_active=True)

    def get_serializer_class(self):
        if self.action in ("create", "update", "partial_update"):
            return DocumentTypeWriteSerializer
        return DocumentTypeSerializer

    def get_permissions(self):
        if self.action in ("create", "update", "partial_update", "destroy"):
            return [permissions.IsAuthenticated(), permissions.IsAdminUser()]
        return [permissions.IsAuthenticated()]

    def perform_create(self, serializer):
        serializer.save(created_by=self.request.user)

    def create(self, request, *args, **kwargs):
        """Override to return the full read serializer after creation."""
        write_serializer = self.get_serializer(data=request.data)
        write_serializer.is_valid(raise_exception=True)
        instance = write_serializer.save(created_by=request.user)
        # Re-serialize with read serializer so metadata_fields are returned
        read_serializer = DocumentTypeSerializer(
            instance, context=self.get_serializer_context()
        )
        return Response(read_serializer.data, status=status.HTTP_201_CREATED)

    def update(self, request, *args, **kwargs):
        """Override to return the full read serializer after update."""
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
        """Soft-delete — keeps historical references intact."""
        instance.is_active = False
        instance.save(update_fields=["is_active"])


# ── Document ViewSet ──────────────────────────────────────────────────────────

class DocumentViewSet(AuditMixin, viewsets.ModelViewSet):
    permission_classes = [permissions.IsAuthenticated, HasDocumentPermission]
    filter_backends    = [DjangoFilterBackend, SearchFilter, OrderingFilter]
    filterset_class    = DocumentFilter
    search_fields      = ["title", "reference_number", "supplier", "extracted_text"]
    ordering_fields    = ["created_at", "document_date", "amount", "title", "reference_number"]
    ordering           = ["-created_at"]
    parser_classes     = [MultiPartParser, FormParser, JSONParser]

    def get_queryset(self):
        user = self.request.user
        qs   = (
            Document.objects
            .select_related("document_type", "uploaded_by", "department")
            .prefetch_related("tags", "versions")
        )
        if user.is_auditor or user.is_finance:
            return qs
        return qs.filter(uploaded_by=user)

    def get_serializer_class(self):
        if self.action == "list":
            return DocumentListSerializer
        if self.action == "create":
            return DocumentUploadSerializer
        return DocumentDetailSerializer

    def create(self, request, *args, **kwargs):
        """Return DocumentDetailSerializer after upload (not the write shape)."""
        serializer = self.get_serializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        doc = serializer.save()
        return Response(
            DocumentDetailSerializer(doc, context=self.get_serializer_context()).data,
            status=status.HTTP_201_CREATED,
        )

    def perform_destroy(self, instance):
        instance.status = DocumentStatus.VOID
        instance.save(update_fields=["status", "updated_at"])
        self.record_audit("document.deleted", instance)

    @action(detail=True, methods=["post"])
    def submit(self, request, pk=None):
        doc = self.get_object()
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

    @action(detail=True, methods=["patch"])
    def edit_metadata(self, request, pk=None):
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

    @action(detail=True, methods=["post"], parser_classes=[MultiPartParser])
    def upload_version(self, request, pk=None):
        doc  = self.get_object()
        file = request.FILES.get("file")
        if not file:
            return Response({"detail": "No file provided."}, status=400)

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
        file.seek(0)
        doc.file            = file
        doc.file_name       = file.name
        doc.file_size       = file.size
        doc.checksum        = checksum
        doc.current_version = new_version
        doc.save()
        self.record_audit("document.version_uploaded", doc, {"version": new_version})
        return Response(DocumentVersionSerializer(version).data, status=201)

    @action(detail=True, methods=["post"])
    def restore_version(self, request, pk=None):
        doc        = self.get_object()
        version_id = request.data.get("version_id")
        version    = get_object_or_404(DocumentVersion, id=version_id, document=doc)
        if version.version_number == doc.current_version:
            return Response({"detail": "Already the current version."}, status=400)
        doc.file            = version.file
        doc.file_name       = version.file_name
        doc.file_size       = version.file_size
        doc.checksum        = version.checksum
        doc.current_version = version.version_number
        doc.save()
        self.record_audit("document.version_restored", doc, {"version": version.version_number})
        return Response({"detail": f"Restored to version {version.version_number}"})

    @action(detail=True, methods=["get"])
    def preview_url(self, request, pk=None):
        doc = self.get_object()
        self.record_audit("document.viewed", doc)
        try:
            relative_url = doc.file.url
        except ValueError:
            return Response({"detail": "No file attached."}, status=400)
        mime = doc.file_mime_type or ""
        if mime == "application/pdf":
            viewer = "pdfjs"
        elif mime in (
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            "application/msword", "application/vnd.ms-excel",
        ):
            viewer = "google_docs"
        else:
            viewer = "download"
        return Response({"viewer": viewer, "url": relative_url})

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
        return Response(serializer.data, status=201)

    @action(detail=True, methods=["get"])
    def audit_trail(self, request, pk=None):
        from apps.audit.serializers import AuditLogSerializer
        from apps.audit.models import AuditLog
        doc  = self.get_object()
        logs = AuditLog.objects.filter(object_type="Document", object_id=str(doc.id))
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
                        .filter(status="in_progress")
                        .select_related("step").first()
                    )
                    if not task:
                        raise WorkflowError("No active approval task.")
                    if task.assigned_to != request.user and request.user.role != "admin":
                        raise WorkflowError("Not authorised.")
                    if act == "approve":
                        WorkflowService.approve(task, request.user, comment)
                    else:
                        WorkflowService.reject(task, request.user, comment)
                elif act == "archive":
                    if doc.status != DocumentStatus.APPROVED:
                        raise ValueError("Only approved documents can be archived.")
                    doc.status = DocumentStatus.ARCHIVED
                    doc.save(update_fields=["status", "updated_at"])
                elif act == "void":
                    doc.status = DocumentStatus.VOID
                    doc.save(update_fields=["status", "updated_at"])
                results.append({"id": str(doc_id), "success": True})
            except (WorkflowError, ValueError, AttributeError) as exc:
                results.append({"id": str(doc_id), "success": False, "detail": str(exc)})

        succeeded = sum(1 for r in results if r["success"])
        return Response(
            {"succeeded": succeeded, "failed": len(results) - succeeded, "results": results},
            status=status.HTTP_200_OK if succeeded else status.HTTP_400_BAD_REQUEST,
        )


class TagViewSet(viewsets.ModelViewSet):
    queryset           = Tag.objects.all()
    serializer_class   = TagSerializer
    permission_classes = [permissions.IsAuthenticated]
