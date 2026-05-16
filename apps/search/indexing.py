"""
Central helpers for keeping Elasticsearch in sync with Document rows.

Uploads, metadata edits, tag changes, and new file versions should call
`schedule_document_search_pipeline` so extracted text and index fields stay aligned.
"""
from __future__ import annotations

import logging

logger = logging.getLogger(__name__)


def document_queryset_for_index():
    from apps.documents.models import Document

    return Document.objects.select_related(
        "document_type",
        "uploaded_by",
        "department",
    ).prefetch_related("tags")


def queue_index_document(document_id: str) -> None:
    try:
        from apps.search.tasks import index_document

        index_document.delay(str(document_id))
    except Exception as exc:
        logger.warning(
            "queue_index_document: could not queue indexing for %s: %s",
            document_id,
            exc,
        )


def queue_content_extraction(document_id: str, *, force: bool = False) -> None:
    """
    Route the document through OCR or native text extraction (same rules as upload).
    """
    from apps.documents.models import Document, OCRStatus

    try:
        doc = Document.objects.get(id=document_id)
    except Document.DoesNotExist:
        logger.warning("queue_content_extraction: document %s not found", document_id)
        return

    mime = doc.file_mime_type or ""
    is_scanned = bool(doc.is_scanned or mime.startswith("image/"))

    if force:
        Document.objects.filter(id=document_id).update(extracted_text="")

    if is_scanned:
        Document.objects.filter(id=document_id).update(ocr_status=OCRStatus.PENDING)
        from apps.documents.tasks import ocr_document

        ocr_document.delay(document_id)
        return

    if force:
        Document.objects.filter(id=document_id).update(ocr_status="")

    from apps.documents.tasks import extract_text

    extract_text.delay(document_id, force=force)


def schedule_document_search_pipeline(
    document_id: str,
    *,
    reextract_content: bool = False,
    index_immediately: bool = True,
) -> None:
    """
    Keep search index current for a document.

    - index_immediately: queue ES update now (metadata, tags, file fields).
    - reextract_content: clear stale body text and re-run OCR / extract_text
      (required after upload_version, restore_version, WebDAV save).
    """
    if index_immediately:
        queue_index_document(document_id)

    if reextract_content:
        queue_content_extraction(document_id, force=True)
