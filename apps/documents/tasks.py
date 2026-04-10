"""
documents/tasks.py + search/tasks.py combined reference.
Text extraction runs after upload; indexing runs after extraction.
"""
from celery import shared_task
import logging

logger = logging.getLogger(__name__)


@shared_task(bind=True, max_retries=3, queue="indexing")
def extract_text(self, document_id: str):
    """Extract text content from uploaded file for full-text search."""
    from .models import Document
    try:
        doc = Document.objects.get(id=document_id)
    except Document.DoesNotExist:
        logger.warning("extract_text: document %s not found", document_id)
        return

    text = ""
    try:
        mime = doc.file_mime_type
        file_path = doc.file.path

        if mime == "application/pdf":
            import pdfplumber
            with pdfplumber.open(file_path) as pdf:
                text = "\n".join(page.extract_text() or "" for page in pdf.pages)

        elif mime in (
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            "application/msword",
        ):
            from docx import Document as DocxDocument
            d = DocxDocument(file_path)
            text = "\n".join(p.text for p in d.paragraphs)

        elif mime in (
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            "application/vnd.ms-excel",
        ):
            import openpyxl
            wb = openpyxl.load_workbook(file_path, read_only=True, data_only=True)
            parts = []
            for ws in wb.worksheets:
                for row in ws.iter_rows(values_only=True):
                    parts.append(" ".join(str(c) for c in row if c is not None))
            text = "\n".join(parts)

    except Exception as exc:
        logger.error("Text extraction failed for %s: %s", document_id, exc)
        raise self.retry(exc=exc, countdown=60)

    Document.objects.filter(id=document_id).update(extracted_text=text[:1_000_000])

    # Trigger search indexing now that text is available
    from apps.search.tasks import index_document
    index_document.delay(document_id)
