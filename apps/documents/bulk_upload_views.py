"""
ViewSet for bulk scan upload batches.
"""
import logging

from django.shortcuts import get_object_or_404
from rest_framework import permissions, status, viewsets
from rest_framework.decorators import action
from rest_framework.parsers import FormParser, JSONParser, MultiPartParser
from rest_framework.response import Response

from apps.accounts.models import GroupAction
from apps.audit.models import AuditEvent
from apps.audit.utils import record_audit_event

from .bulk_upload import create_bulk_upload_documents, sync_bulk_upload_status
from .models import BulkUpload, BulkUploadStatus, DocumentType

logger = logging.getLogger(__name__)
from .serializers import (
    BulkUploadCreateSerializer,
    BulkUploadDetailSerializer,
    BulkUploadReviewSerializer,
    BulkUploadSerializer,
)


class BulkUploadViewSet(viewsets.GenericViewSet):
    """
    Bulk scan upload: upload many files of one type, OCR each, review per-document metadata.
    """

    permission_classes = [permissions.IsAuthenticated]
    parser_classes = [MultiPartParser, FormParser, JSONParser]
    lookup_field = "pk"

    def get_queryset(self):
        return (
            BulkUpload.objects.filter(uploaded_by=self.request.user)
            .select_related("document_type")
            .prefetch_related("documents", "common_tags")
        )

    def get_serializer_class(self):
        if self.action in ("retrieve", "status"):
            return BulkUploadDetailSerializer
        if self.action == "create":
            return BulkUploadCreateSerializer
        return BulkUploadSerializer

    def _user_can_upload_type(self, document_type: DocumentType) -> bool:
        user = self.request.user
        if user.has_admin_access:
            return True
        perms = user.get_all_permissions_for_doctype(document_type.id)
        return GroupAction.UPLOAD.value in perms

    def create(self, request, *args, **kwargs):
        files = request.FILES.getlist("files") or request.FILES.getlist("files[]")
        if not files:
            for key in request.FILES.keys():
                normalized = key.lower()
                if normalized.startswith("files") or normalized.startswith("file"):
                    files = request.FILES.getlist(key)
                    if files:
                        break

        data = {
            "document_type_id": request.data.get("document_type_id"),
            "is_scanned": request.data.get("is_scanned", "true"),
            "files": files,
        }
        if not files:
            logger.warning(
                "Bulk upload create request contained no files. request.FILES keys=%s, content_type=%s, data_keys=%s, content_length=%s",
                list(request.FILES.keys()),
                request.content_type,
                list(getattr(request.data, 'keys', lambda: [])()),
                request.META.get('CONTENT_LENGTH'),
            )

        def _get_list(value):
            if hasattr(value, "getlist"):
                return value.getlist("common_tag_ids") or value.getlist("common_tag_ids[]")
            if isinstance(value, dict):
                result = value.get("common_tag_ids") or value.get("common_tag_ids[]")
                if result is None:
                    return []
                if isinstance(result, (list, tuple)):
                    return list(result)
                return [result]
            return []

        tag_ids = _get_list(request.data)
        if not tag_ids:
            for key in getattr(request.data, "keys", lambda: [])():
                normalized = key.lower()
                if normalized.startswith("common_tag_ids"):
                    raw = request.data.get(key)
                    if raw is None:
                        continue
                    if isinstance(raw, (list, tuple)):
                        tag_ids = list(raw)
                    else:
                        tag_ids = [raw]
                    if tag_ids:
                        break
        if tag_ids:
            data["common_tag_ids"] = tag_ids

        serializer = BulkUploadCreateSerializer(data=data)
        serializer.is_valid(raise_exception=True)
        files = serializer.validated_data["files"]
        document_type = serializer.validated_data["document_type"]
        if not self._user_can_upload_type(document_type):
            return Response(
                {"detail": "You do not have upload permission for this document type."},
                status=status.HTTP_403_FORBIDDEN,
            )

        is_scanned = serializer.validated_data.get("is_scanned", True)
        bulk_upload = BulkUpload.objects.create(
            document_type=document_type,
            uploaded_by=request.user,
            status=BulkUploadStatus.PENDING,
            total_files=len(files),
        )
        common_tags = serializer.validated_data.get("common_tag_ids") or []
        if common_tags:
            bulk_upload.common_tags.set(common_tags)

        bulk_upload = create_bulk_upload_documents(
            bulk_upload=bulk_upload,
            files=files,
            request=request,
            is_scanned=is_scanned,
        )

        out = BulkUploadDetailSerializer(bulk_upload, context={"request": request})
        return Response(out.data, status=status.HTTP_201_CREATED)

    def retrieve(self, request, *args, **kwargs):
        bulk_upload = sync_bulk_upload_status(self.get_object())
        serializer = BulkUploadDetailSerializer(bulk_upload, context={"request": request})
        return Response(serializer.data)

    @action(detail=True, methods=["get"])
    def status(self, request, pk=None):
        """Lightweight poll endpoint — same payload as retrieve."""
        return self.retrieve(request, pk=pk)

    @action(detail=True, methods=["post"], parser_classes=[JSONParser])
    def review(self, request, pk=None):
        bulk_upload = get_object_or_404(self.get_queryset(), pk=pk)
        bulk_upload = sync_bulk_upload_status(bulk_upload)
        if bulk_upload.status != BulkUploadStatus.REVIEW:
            return Response(
                {
                    "detail": (
                        "This batch is not ready for review. "
                        f"Current status: {bulk_upload.status}."
                    )
                },
                status=status.HTTP_400_BAD_REQUEST,
            )

        serializer = BulkUploadReviewSerializer(
            data=request.data,
            context={"request": request, "bulk_upload": bulk_upload},
        )
        serializer.is_valid(raise_exception=True)
        bulk_upload = serializer.save()
        for doc in bulk_upload.documents.all():
            record_audit_event(
                AuditEvent.DOCUMENT_BULK_REVIEWED,
                actor=request.user,
                obj=doc,
                request=request,
                changes={"bulk_upload_id": str(bulk_upload.id)},
            )
        out = BulkUploadDetailSerializer(bulk_upload, context={"request": request})
        return Response(out.data)
