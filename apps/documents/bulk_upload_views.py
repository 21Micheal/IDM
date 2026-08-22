"""
ViewSet for bulk scan upload batches.
"""
import logging
import json

from django.db import transaction
from django.shortcuts import get_object_or_404
from rest_framework import permissions, status, viewsets
from rest_framework.decorators import action
from rest_framework.parsers import FormParser, JSONParser, MultiPartParser
from rest_framework.response import Response

from apps.accounts.models import GroupAction
from apps.audit.models import AuditEvent
from apps.audit.utils import record_audit_event

from .bulk_upload import (
    create_bulk_upload_documents,
    get_unclassified_bulk_document_type,
    sync_bulk_upload_status,
)
from .models import BulkUpload, BulkUploadStatus, DocumentType, DocumentStatus
from .review_queue import reviewable_bulk_uploads_for

logger = logging.getLogger(__name__)
from .serializers import (
    BulkUploadCreateSerializer,
    BulkUploadDetailSerializer,
    BulkUploadReviewSerializer,
    BulkUploadSerializer,
    BulkUploadSummarySerializer,
)


class BulkUploadViewSet(viewsets.GenericViewSet):
    """
    Bulk scan upload: upload many files of one type, OCR each, review per-document metadata.
    """

    permission_classes = [permissions.IsAuthenticated]
    parser_classes = [MultiPartParser, FormParser, JSONParser]
    lookup_field = "pk"

    def get_queryset(self):
        return reviewable_bulk_uploads_for(self.request.user).prefetch_related(
            "documents", "common_tags"
        )

    def get_serializer_class(self):
        if self.action in ("retrieve", "status"):
            return BulkUploadDetailSerializer
        if self.action == "create":
            return BulkUploadCreateSerializer
        if self.action == "list":
            return BulkUploadSummarySerializer
        return BulkUploadSerializer

    def list(self, request, *args, **kwargs):
        """List batches for the pending-review queue.

        Defaults to the batches that still need attention (processing/review);
        pass ``?status=...`` (comma-separated) to widen or narrow that.
        Includes the caller's own bulk scans plus email-ingested batches they
        are allowed to review (mailbox reviewers / owner / admins).
        """
        qs = self.get_queryset().order_by("-created_at")
        status_param = request.query_params.get("status")
        statuses = (
            [s.strip() for s in status_param.split(",") if s.strip()]
            if status_param
            else [BulkUploadStatus.PROCESSING, BulkUploadStatus.REVIEW]
        )
        qs = qs.filter(status__in=statuses)
        batches = list(qs)
        # Advance any batch whose OCR has finished since it was created. Email
        # batches have no live poller of their own (the bulk-scan UI polls the
        # batches it creates), so without this they'd sit in "processing"
        # forever even after extraction completes.
        for batch in batches:
            if batch.status == BulkUploadStatus.PROCESSING:
                sync_bulk_upload_status(batch)
        data = BulkUploadSummarySerializer(batches, many=True, context={"request": request}).data
        return Response(data)

    def _user_can_upload_type(self, document_type: DocumentType) -> bool:
        user = self.request.user
        if user.has_admin_access:
            return True
        from apps.documents.access import ACCESS_STAGE_CREATION
        perms = user.get_all_permissions_for_doctype(
            str(document_type.id),
            stage=ACCESS_STAGE_CREATION,
        )
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

        shared_metadata = request.data.get("shared_metadata") or {}
        if isinstance(shared_metadata, str):
            try:
                shared_metadata = json.loads(shared_metadata) if shared_metadata.strip() else {}
            except json.JSONDecodeError:
                shared_metadata = {}

        data = {
            "related_set": request.data.get("related_set", "false"),
            "auto_classify": request.data.get("auto_classify", "false"),
            "shared_metadata": shared_metadata,
            "is_scanned": request.data.get("is_scanned", "true"),
            "files": files,
        }
        document_type_id = request.data.get("document_type_id")
        if document_type_id not in (None, ""):
            data["document_type_id"] = document_type_id
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
        is_related_set = serializer.validated_data.get("related_set", False)
        auto_classify = serializer.validated_data.get("auto_classify", False)
        document_type = (
            get_unclassified_bulk_document_type()
            if is_related_set or auto_classify
            else serializer.validated_data["document_type"]
        )
        if not is_related_set and not auto_classify and not self._user_can_upload_type(document_type):
            return Response(
                {"detail": "You do not have upload permission for this document type."},
                status=status.HTTP_403_FORBIDDEN,
            )

        is_scanned = serializer.validated_data.get("is_scanned", True)
        shared_metadata = serializer.validated_data.get("shared_metadata") or {}
        bulk_upload = BulkUpload.objects.create(
            document_type=document_type,
            uploaded_by=request.user,
            mode=(
                BulkUpload.Mode.RELATED_SET
                if is_related_set or auto_classify
                else BulkUpload.Mode.SAME_TYPE
            ),
            shared_metadata=shared_metadata,
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
            shared_metadata=shared_metadata,
            auto_classify=auto_classify,
            allowed_document_type_ids=None if request.user.has_admin_access else {
                str(doc_type.id)
                for doc_type in DocumentType.objects.filter(is_active=True)
                if self._user_can_upload_type(doc_type)
            },
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

    @action(detail=True, methods=["post"], parser_classes=[JSONParser])
    def ocr_fallback(self, request, pk=None):
        """Run pattern matching on every needs_manual document in the batch."""
        from apps.documents.models import DMSSettings, OCRStatus
        from apps.documents.ocr.fallback import apply_document_regex_fallback

        bulk_upload = sync_bulk_upload_status(self.get_object())
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

        dms = DMSSettings.load()
        if not dms.idp_allow_regex_fallback:
            return Response(
                {"detail": "Pattern matching fallback is not enabled for this organization."},
                status=status.HTTP_403_FORBIDDEN,
            )

        docs = list(bulk_upload.documents.filter(ocr_status=OCRStatus.NEEDS_MANUAL))
        if not docs:
            return Response(
                {"detail": "No documents in this batch require pattern matching."},
                status=status.HTTP_400_BAD_REQUEST,
            )

        for doc in docs:
            apply_document_regex_fallback(doc, reason="user_opt_in_batch")
            record_audit_event(
                AuditEvent.DOCUMENT_OCR_COMPLETED,
                actor=request.user,
                obj=doc,
                request=request,
                changes={"bulk_upload_id": str(bulk_upload.id), "fallback": "regex_batch"},
            )

        bulk_upload.refresh_from_db()
        out = BulkUploadDetailSerializer(bulk_upload, context={"request": request})
        return Response(out.data)

    @action(detail=True, methods=["post"], parser_classes=[JSONParser])
    def cancel(self, request, pk=None):
        bulk_upload = get_object_or_404(self.get_queryset(), pk=pk)
        if bulk_upload.status not in (
            BulkUploadStatus.UPLOADING,
            BulkUploadStatus.PROCESSING,
            BulkUploadStatus.REVIEW,
        ):
            return Response(
                {
                    "detail": (
                        "This batch cannot be canceled in its current state. "
                        f"Current status: {bulk_upload.status}."
                    )
                },
                status=status.HTTP_400_BAD_REQUEST,
            )

        with transaction.atomic():
            documents = list(bulk_upload.documents.all())
            for doc in documents:
                doc.delete()
            bulk_upload.delete()

        return Response(status=status.HTTP_204_NO_CONTENT)
