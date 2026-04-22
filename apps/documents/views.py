"""
apps/documents/views.py

DocumentTypeViewSet fix:
  Uses DocumentTypeWriteSerializer for POST/PUT/PATCH input validation
  and DocumentTypeSerializer for the response — standard DRF split
  input/output pattern.  Metadata fields are now saved correctly.
"""
import hashlib
import logging
import mimetypes
from urllib.parse import quote as urlquote

from django.core.files.base import ContentFile
from django.utils import timezone
from django.db import transaction
from django.conf import settings

from django.core.cache import cache
from django.shortcuts import get_object_or_404
from django_filters.rest_framework import DjangoFilterBackend
from rest_framework import viewsets, status, permissions
from rest_framework.decorators import action
from rest_framework.filters import SearchFilter, OrderingFilter
from rest_framework.parsers import MultiPartParser, FormParser, JSONParser
from rest_framework.response import Response
from rest_framework_simplejwt.tokens import AccessToken

from .models import (
    Document,
    DocumentType,
    DocumentVersion,
    Tag,
    DocumentStatus,
    PreviewStatus,
)
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

logger = logging.getLogger(__name__)

def _preview_error_cache_key(document_id: str) -> str:
    return f"document_preview_error:{document_id}"


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
            .select_related("document_type", "uploaded_by", "department", "edit_locked_by")
            .prefetch_related("tags", "versions")
        )
        # Admins, auditors, and finance roles see all documents.
        if user.is_admin or user.is_auditor or user.is_finance:
            return qs
        # Regular users see only documents they uploaded.
        return qs.filter(uploaded_by=user)

    def get_serializer_class(self):
        if self.action == "list":
            return DocumentListSerializer
        if self.action == "create":
            return DocumentUploadSerializer
        return DocumentDetailSerializer

    def _queue_office_preview(self, doc: Document) -> None:
        """
        Queue a LibreOffice → PDF conversion task if one is not already running.

        Eligible states for (re-)queuing:
          ""       — never queued (fresh upload or version replacement)
          FAILED   — previous attempt failed; allow retry
          PENDING  — intentionally NOT re-queued here to avoid duplicate task
                     deliveries from poll endpoints.

        PROCESSING is intentionally excluded — a worker is actively converting.
        DONE is excluded — preview already exists.
        """
        if not doc.is_office_doc():
            return
        try:
            from .tasks import generate_document_preview
            before_status = doc.preview_status or ""
            # Move to PENDING only for brand-new or previously failed previews.
            updated = Document.objects.filter(
                id=doc.id,
                preview_status__in=["", PreviewStatus.FAILED],
            ).exclude(
                preview_status=PreviewStatus.PROCESSING,
            ).update(preview_status=PreviewStatus.PENDING)

            # Always queue the task for eligible states; the task's atomic claim
            # (PENDING → PROCESSING) ensures only one worker proceeds.
            current = Document.objects.values_list(
                "preview_status", flat=True
            ).get(id=doc.id)

            logger.info(
                "_queue_office_preview: doc=%s before=%s updated=%s after=%s",
                doc.id,
                before_status,
                updated,
                current,
            )

            if current == PreviewStatus.PENDING:
                logger.info("_queue_office_preview: enqueue task for doc=%s", doc.id)
                generate_document_preview.delay(str(doc.id))
        except Exception:
            logger.exception("_queue_office_preview: failed for doc=%s", doc.id)

    def create(self, request, *args, **kwargs):
        """Return DocumentDetailSerializer after upload (not the write shape)."""
        serializer = self.get_serializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        doc = serializer.save()
        self._queue_office_preview(doc)
        doc.refresh_from_db()
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
        doc.file = file
        doc.file_name = file.name
        doc.file_size = file.size
        guessed_mime, _ = mimetypes.guess_type(file.name)
        incoming_mime = getattr(file, "content_type", "") or guessed_mime or ""
        if incoming_mime and incoming_mime != "application/octet-stream":
            doc.file_mime_type = incoming_mime
        doc.checksum = checksum
        doc.current_version = new_version
        if doc.file_mime_type in (
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            "application/vnd.openxmlformats-officedocument.presentationml.presentation",
            "application/msword",
            "application/vnd.ms-excel",
            "application/vnd.ms-powerpoint",
        ):
            if doc.preview_pdf:
                doc.preview_pdf.delete(save=False)
            doc.preview_pdf = None
            doc.preview_status = ""
        else:
            if doc.preview_pdf:
                doc.preview_pdf.delete(save=False)
            doc.preview_pdf = None
            doc.preview_status = ""
        doc.save()
        self._queue_office_preview(doc)
        self.record_audit("document.version_uploaded", doc, {"version": new_version})
        return Response(DocumentVersionSerializer(version).data, status=201)

    @action(detail=True, methods=["post"])
    def restore_version(self, request, pk=None):
        doc = self.get_object()
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

        new_version = doc.current_version + 1

        with transaction.atomic():
            restored_version = DocumentVersion(
                document=doc,
                version_number=new_version,
                file_name=version.file_name,
                file_size=version.file_size,
                checksum=version.checksum,
                change_summary=f"Restored from v{version.version_number}",
                created_by=request.user,
            )
            restored_version.file.save(
                version.file_name,
                ContentFile(content, name=version.file_name),
                save=False,
            )
            restored_version.save()

            if doc.preview_pdf:
                doc.preview_pdf.delete(save=False)

            doc.file.save(
                version.file_name,
                ContentFile(content, name=version.file_name),
                save=False,
            )
            doc.file_name = version.file_name
            doc.file_size = version.file_size
            doc.file_mime_type = doc.file_mime_type
            doc.checksum = version.checksum
            doc.current_version = new_version
            doc.preview_pdf = None
            doc.preview_status = ""
            doc.save(update_fields=[
                "file",
                "file_name",
                "file_size",
                "checksum",
                "current_version",
                "preview_pdf",
                "preview_status",
                "updated_at",
            ])

        self._queue_office_preview(doc)

        self.record_audit(
            "document.version_restored",
            doc,
            {"restored_from": version.version_number, "version": new_version},
        )
        return Response(DocumentVersionSerializer(restored_version).data, status=201)

    @action(detail=True, methods=["get"])
    def preview_url(self, request, pk=None):
        """
        Poll endpoint for preview status.

        IMPORTANT: This endpoint is polled every 2 seconds by the frontend
        while an Office document is converting.  It must NOT:
          - Re-queue the conversion task (that causes duplicate deliveries)
          - Record an audit log entry (that floods the audit trail)

        Queuing only happens in:
          - create()          — fresh upload
          - upload_version()  — new file version
          - restore_version() — restored version
          - trigger_preview() — explicit user retry
        """
        doc = self.get_object()
        # NOTE: record_audit intentionally omitted — this endpoint is polled
        # every 2 s during Office→PDF conversion; logging every poll floods
        # the audit trail with hundreds of "document.viewed" entries.

        try:
            absolute_file_url = request.build_absolute_uri(doc.file.url)
        except ValueError:
            return Response({"detail": "No file attached."}, status=400)

        mime = doc.file_mime_type or ""

        if mime == "application/pdf":
            return Response({
                "viewer": "pdfjs",
                "url": absolute_file_url,
                "raw_url": absolute_file_url,
                "preview_status": "done",
            })

        if mime.startswith("image/"):
            return Response({
                "viewer": "image",
                "url": absolute_file_url,
                "raw_url": absolute_file_url,
                "preview_status": "done",
            })

        if doc.is_office_doc():
            # Queue exactly once when status is blank (never queued).
            # Do NOT queue for pending/processing polls.
            if not doc.preview_status:
                logger.info("preview_url: doc=%s blank status -> queue once", doc.id)
                self._queue_office_preview(doc)

            doc.refresh_from_db()

            preview_status = doc.preview_status or ""

            # If status is blank (never queued), report as pending so the
            # frontend shows the converting state.  The actual queuing was
            # done at upload/version time; if it somehow wasn't, the user
            # can use trigger_preview to kick it off explicitly.
            if not preview_status:
                preview_status = PreviewStatus.PENDING

            logger.info(
                "preview_url: doc=%s status=%s has_preview_pdf=%s",
                doc.id,
                preview_status,
                bool(doc.preview_pdf),
            )
            preview_error = cache.get(_preview_error_cache_key(str(doc.id)))

            if preview_status == PreviewStatus.DONE and doc.preview_pdf:
                preview_url = request.build_absolute_uri(doc.preview_pdf.url)
                viewer = "pdfjs"
            else:
                preview_url = ""
                viewer = "processing"

            return Response({
                "viewer": viewer,
                "url": preview_url if preview_url else absolute_file_url,
                "raw_url": absolute_file_url,
                "preview_status": preview_status,
                "preview_error": preview_error,
            })

        return Response({
            "viewer": "download",
            "url": absolute_file_url,
            "raw_url": absolute_file_url,
        })

    @action(detail=True, methods=["post"])
    def trigger_preview(self, request, pk=None):
        """
        Explicitly (re-)trigger the Office→PDF preview conversion.

        Use cases:
          - User clicks "Retry" after a failed conversion.
          - Admin wants to force regeneration.

        Blocked when preview_status is PROCESSING (already in-flight).
        Resets status to "" so _queue_office_preview will re-queue.
        """
        doc = self.get_object()

        if not doc.is_office_doc():
            return Response(
                {"detail": "Preview generation is only supported for Office documents."},
                status=status.HTTP_400_BAD_REQUEST,
            )

        if doc.preview_status == PreviewStatus.PROCESSING:
            stale_after = int(getattr(settings, "PREVIEW_PROCESSING_STALE_SECONDS", 300))
            processing_age_s = max(
                0,
                int((timezone.now() - doc.updated_at).total_seconds()),
            )
            if processing_age_s < stale_after:
                return Response(
                    {"detail": "Preview generation is already in progress."},
                    status=status.HTTP_400_BAD_REQUEST,
                )
            logger.warning(
                "trigger_preview: doc=%s had stale processing state (%ss); resetting",
                doc.id,
                processing_age_s,
            )

        # Reset to blank so _queue_office_preview will pick it up.
        Document.objects.filter(id=doc.id).update(
            preview_status="",
            preview_pdf=None,
        )
        cache.delete(_preview_error_cache_key(str(doc.id)))
        doc.refresh_from_db()
        self._queue_office_preview(doc)
        self.record_audit("document.preview_triggered", doc)

        return Response({
            "detail": "Preview generation queued.",
            "preview_status": PreviewStatus.PENDING,
        })

    @action(detail=True, methods=["post"])
    def edit_token(self, request, pk=None):
        doc = self.get_object()

        if not doc.acquire_lock(request.user):
            holder = doc.edit_lock_holder
            holder_name = holder.get_full_name().strip() if holder else "another user"
            return Response(
                {"detail": f"Locked by {holder_name}", "locked_by": holder_name},
                status=423,
            )

        jwt_token = str(AccessToken.for_user(request.user))
        api_base = request.build_absolute_uri("/api/v1").rstrip("/")
        file_url = request.build_absolute_uri(doc.file.url)
        webdav_url = (
            f"{api_base}/documents/webdav/{doc.id}/{urlquote(doc.file_name)}"
            f"?token={jwt_token}"
        )
        release_url = f"{api_base}/documents/{doc.id}/release_lock/"

        cache.set(
            f"webdav_edit_token:{jwt_token}",
            {"user_id": str(request.user.id), "document_id": str(doc.id)},
            timeout=3600,
        )

        self.record_audit("document.edit_lock_acquired", doc)

        return Response({
            "token": jwt_token,
            "username": request.user.email,
            "webdav_url": webdav_url,
            "file_url": file_url,
            "release_url": release_url,
            "jwt_token": jwt_token,
            "expires_in": 3600,
            "doc_id": str(doc.id),
            "file_name": doc.file_name,
            "mime_type": doc.file_mime_type,
        })

    @action(detail=True, methods=["post"])
    def release_lock(self, request, pk=None):
        doc = self.get_object()
        raw_force = request.data.get("force")
        force = (
            str(raw_force).lower() in {"1", "true", "yes", "on"}
            if raw_force is not None
            else False
        ) and request.user.is_admin

        if not doc.release_lock(user=request.user, force=force):
            return Response({"detail": "Lock held by another user."}, status=423)

        self.record_audit("document.edit_lock_released", doc)
        return Response({"detail": "Lock released."})

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

    """ Returns:
    200  { "detail": "OCR queued.", "ocr_status": "pending" }
    400  if OCR is already in progress
    400  if the document type doesn't support OCR (Office docs, etc.)
    """ 
    @action(detail=True, methods=["post"])
    def re_ocr(self, request, pk=None):
        """
        Re-trigger OCR on a scanned document.
 
        Blocked when ocr_status is "pending" or "processing" (already in-flight).
        Sets status to PENDING atomically before queuing so the task's
        atomic claim (filter ocr_status=PENDING) succeeds.
        """
        from .models import OCRStatus
        from .tasks import ocr_document
 
        doc = self.get_object()
 
        is_ocr_candidate = (
            doc.is_scanned
            or (doc.file_mime_type and doc.file_mime_type.startswith("image/"))
            or doc.file_mime_type == "application/pdf"
        )
        if not is_ocr_candidate:
            return Response(
                {"detail": "OCR is only supported for scanned documents, images, and PDFs."},
                status=status.HTTP_400_BAD_REQUEST,
            )
 
        # Block if already in-flight (pending OR processing)
        if doc.ocr_status in (OCRStatus.PENDING, OCRStatus.PROCESSING):
            return Response(
                {"detail": f"OCR is already in progress (status: {doc.ocr_status})."},
                status=status.HTTP_400_BAD_REQUEST,
            )
 
        # Set PENDING atomically so the task's atomic claim works
        from .models import Document
        Document.objects.filter(id=doc.id).update(
            ocr_status=OCRStatus.PENDING,
            is_scanned=True,
        )
 
        ocr_document.delay(str(doc.id))
        self.record_audit("document.ocr_queued", doc)
 
        return Response({
            "detail": "OCR queued. Text will be updated shortly.",
            "ocr_status": OCRStatus.PENDING,
        })


class TagViewSet(viewsets.ModelViewSet):
    queryset           = Tag.objects.all()
    serializer_class   = TagSerializer
    permission_classes = [permissions.IsAuthenticated]