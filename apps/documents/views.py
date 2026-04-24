import hashlib
import logging
import mimetypes
import secrets
from urllib.parse import quote as urlquote, urlencode, urlparse, urlunparse

from django.core.files.base import ContentFile
from django.http import HttpResponse
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


def _preview_start_cache_key(document_id: str) -> str:
    """Cache key for the wall-clock time the preview task started processing.
    Stored by the task; read by trigger_preview for staleness detection.
    Using the cache (not updated_at) avoids the heartbeat defeating the check."""
    return f"document_preview_started_at:{document_id}"


# ── Document Type ViewSet ─────────────────────────────────────────────────────

class DocumentTypeViewSet(AuditMixin, viewsets.ModelViewSet):
    queryset = DocumentType.objects.prefetch_related(
        "metadata_fields"
    ).filter(is_active=True).exclude(code="PERSONAL")

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
        if user.has_admin_access:
            return qs
        return qs.filter(uploaded_by=user)

    def get_serializer_class(self):
        if self.action == "list":
            return DocumentListSerializer
        if self.action == "create":
            return DocumentUploadSerializer
        return DocumentDetailSerializer

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
                generate_document_preview.delay(str(doc.id))
        except Exception:
            logger.exception("_queue_office_preview: failed for doc=%s", doc.id)

    def create(self, request, *args, **kwargs):
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
                "file", "file_name", "file_size", "checksum",
                "current_version", "preview_pdf", "preview_status", "updated_at",
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
        doc = self.get_object()
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
            if not doc.preview_status:
                self._queue_office_preview(doc)
            doc.refresh_from_db()
            preview_status = doc.preview_status or PreviewStatus.PENDING
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
        self.record_audit("document.preview_triggered", doc)

        return Response({
            "detail": "Preview generation queued.",
            "preview_status": PreviewStatus.PENDING,
        })

    @action(detail=True, methods=["post"])
    def edit_token(self, request, pk=None):
        doc = self.get_object()

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

        # FIX: Use hex to avoid special character truncations, and use actual email
        jwt_token = str(AccessToken.for_user(request.user))
        webdav_token = jwt_token  # Use JWT as the WebDAV token for seamless auth
        basic_username = request.user.email
        cache.set(
            f"webdav_edit_token:{webdav_token}",
            {
                "user_id": str(request.user.id),
                "document_id": str(doc.id),
            },
            timeout=3600,
        )

        api_base = request.build_absolute_uri("/api/v1").rstrip("/")
        file_url = request.build_absolute_uri(doc.file.url)
        release_url = f"{api_base}/documents/{doc.id}/release_lock/"

        parsed = urlparse(api_base)
        netloc_with_creds = f"{urlquote(basic_username, safe='')}:{webdav_token}@{parsed.netloc}"
        webdav_path = f"{parsed.path}/documents/webdav/{doc.id}/{urlquote(doc.file_name, safe='')}"
        webdav_url = urlunparse(parsed._replace(
            netloc=netloc_with_creds,
            path=webdav_path,
            query="",
            fragment="",
        ))

        self.record_audit("document.edit_lock_acquired", doc)

        return Response({
            "token":       jwt_token,
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

    def _get_open_script_content(self, filename, open_url):
        safe_filename = filename.replace("'", "\\'")
        return f"""#!/usr/bin/env bash
# DocVault — open "{filename}" in LibreOffice
set -euo pipefail

OPEN_URL='{open_url}'
FILE_NAME='{safe_filename}'

find_soffice() {{
  for cmd in soffice libreoffice /usr/bin/soffice /usr/lib/libreoffice/program/soffice; do
    if command -v "$cmd" &>/dev/null; then
      echo "$cmd"; return 0
    fi
  done
}}

SOFFICE=$(find_soffice)
if [ -z "$SOFFICE" ]; then
  echo "ERROR: LibreOffice not found."
  exit 1
fi

echo "Opening: $FILE_NAME"
nohup "$SOFFICE" "$OPEN_URL" >/dev/null 2>&1 &
disown
"""

    @action(detail=True, methods=["get"])
    def open_script(self, request, pk=None):
        doc = self.get_object()
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

        # FIX: Align with hex tokens and actual email
        jwt_token = str(AccessToken.for_user(request.user))
        webdav_token = jwt_token  # Use JWT as the WebDAV token for seamless auth
        basic_username = request.user.email
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
        netloc = f"{urlquote(basic_username, safe='')}:{webdav_token}@{parsed.netloc}"
        path = f"{parsed.path}/documents/webdav/{doc.id}/{urlquote(doc.file_name, safe='')}"
        webdav_url = urlunparse(parsed._replace(netloc=netloc, path=path, query="", fragment=""))
        
        dav_prefix = "vnd.sun.star.webdavs://" if webdav_url.startswith("https://") else "vnd.sun.star.webdav://"
        open_url = webdav_url.replace(parsed.scheme + "://", dav_prefix, 1)
        
        script = self._get_open_script_content(doc.file_name, open_url)
        response = HttpResponse(script, content_type="text/x-shellscript; charset=utf-8")
        response["Content-Disposition"] = f'attachment; filename="open-{doc.id}.sh"'
        self.record_audit("document.edit_lock_acquired", doc)
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
  disown
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

        self.record_audit("document.edit_lock_released", doc)
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
        self.record_audit("document.ocr_queued", doc)
        return Response({"detail": "OCR queued.", "ocr_status": OCRStatus.PENDING})

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
        from apps.audit.models import AuditLog
        doc = self.get_object()
        logs = (
            AuditLog.objects
            .filter(object_type="Document", object_id=str(doc.id))
            .select_related("actor")
        )
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
                    if task.assigned_to != request.user and not request.user.has_admin_access:
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
