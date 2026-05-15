"""
Helpers for bulk scan upload batches.
"""
from __future__ import annotations

import os

from django.db import transaction

from .models import BulkUpload, BulkUploadStatus, Document, OCRStatus
from .serializers import DocumentUploadSerializer


def document_title_from_filename(filename: str) -> str:
    base = os.path.basename(filename or "Document")
    if "." in base:
        stem = base.rsplit(".", 1)[0]
        return stem or base
    return base


def serialize_bulk_document(doc: Document) -> dict:
    meta = dict(doc.metadata or {})
    suggestions = None
    if doc.ocr_status == OCRStatus.DONE:
        fields = meta.get("ocr_suggestions")
        quality = meta.get("ocr_quality")
        if fields or quality:
            suggestions = {
                "fields": fields or None,
                "quality": quality or None,
            }

    public_metadata = {
        key: value
        for key, value in meta.items()
        if key not in ("ocr_suggestions", "ocr_quality")
    }

    return {
        "document_id": str(doc.id),
        "reference_number": doc.reference_number,
        "title": doc.title,
        "file_name": doc.file_name,
        "ocr_status": doc.ocr_status or "",
        "ocr_suggestions": suggestions,
        "metadata": public_metadata,
        "supplier": doc.supplier or "",
        "amount": str(doc.amount) if doc.amount is not None else "",
        "currency": doc.currency or "",
        "document_date": (
            doc.document_date.isoformat() if doc.document_date else ""
        ),
        "due_date": doc.due_date.isoformat() if doc.due_date else "",
    }


def sync_bulk_upload_status(bulk_upload: BulkUpload) -> BulkUpload:
    """
    Advance batch status once uploads finish and OCR settles.
    """
    docs = bulk_upload.documents.all()
    if bulk_upload.status == BulkUploadStatus.UPLOADING:
        processed = bulk_upload.successful_uploads + bulk_upload.failed_uploads
        if processed >= bulk_upload.total_files:
            bulk_upload.status = BulkUploadStatus.PROCESSING
            bulk_upload.save(update_fields=["status", "updated_at"])

    if bulk_upload.status == BulkUploadStatus.PROCESSING:
        if not docs.exists():
            bulk_upload.status = BulkUploadStatus.FAILED
            bulk_upload.save(update_fields=["status", "updated_at"])
            return bulk_upload

        pending = docs.filter(
            ocr_status__in=[OCRStatus.PENDING, OCRStatus.PROCESSING, ""]
        ).exists()
        if not pending:
            bulk_upload.status = BulkUploadStatus.REVIEW
            bulk_upload.save(update_fields=["status", "updated_at"])

    return bulk_upload


@transaction.atomic
def create_bulk_upload_documents(
    *,
    bulk_upload: BulkUpload,
    files,
    request,
    is_scanned: bool = True,
) -> BulkUpload:
    """
    Upload each file as a draft document linked to the batch.
    """
    bulk_upload.status = BulkUploadStatus.UPLOADING
    bulk_upload.total_files = len(files)
    bulk_upload.save(update_fields=["status", "total_files", "updated_at"])

    for upload in files:
        title = document_title_from_filename(upload.name)
        payload = {
            "title": title,
            "document_type_id": str(bulk_upload.document_type_id),
            "file": upload,
            "is_scanned": is_scanned,
            "is_self_upload": False,
        }
        serializer = DocumentUploadSerializer(data=payload, context={"request": request})
        try:
            if not serializer.is_valid():
                bulk_upload.failed_uploads += 1
                bulk_upload.save(update_fields=["failed_uploads", "updated_at"])
                continue
            doc = serializer.save()
            doc.bulk_upload = bulk_upload
            doc.save(update_fields=["bulk_upload"])
            tag_ids = list(bulk_upload.common_tags.values_list("id", flat=True))
            if tag_ids:
                doc.tags.add(*tag_ids)
            bulk_upload.successful_uploads += 1
            bulk_upload.save(update_fields=["successful_uploads", "updated_at"])
        except Exception:
            bulk_upload.failed_uploads += 1
            bulk_upload.save(update_fields=["failed_uploads", "updated_at"])

    if bulk_upload.successful_uploads == 0:
        bulk_upload.status = BulkUploadStatus.FAILED
        bulk_upload.save(update_fields=["status", "updated_at"])
        return bulk_upload

    return sync_bulk_upload_status(bulk_upload)
