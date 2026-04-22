"""
apps/documents/tasks.py

Bug fixes in this revision
──────────────────────────
BUG 1 — extract_text was on queue="ocr" instead of queue="indexing".
BUG 2 — Serializer pre-set ocr_status="pending" before any task ran,
         causing extract_text to bail, freezing status at "pending".
BUG 3 — ocr_document did not claim atomically, allowing duplicate workers.
BUG 4 (NEW) — generate_document_preview used `transaction.atomic()` but
         `transaction` was never imported → NameError at runtime.
         FIX: Added `from django.db import transaction`.

Architecture after all fixes
────────────────────────────────
  Confirmed scan upload (is_scanned=True OR image/* MIME):
    serializer.create()
      └─ ocr_document.delay()  [queue="ocr"]
           ├─ atomic claim: PENDING → PROCESSING
           ├─ _ocr_tesseract() or _ocr_textract()
           ├─ update extracted_text, ocr_status=DONE
           └─ index_document.delay()  [queue="indexing"]

  Normal upload (PDF/DOCX/XLSX without is_scanned):
    serializer.create()
      └─ extract_text.delay()  [queue="indexing"]
           ├─ PDF → pdfplumber (native text)
           │    └─ if sparse → _mark_pending() → ocr_document.delay()
           ├─ DOCX/XLSX → python-docx/openpyxl
           └─ update extracted_text → index_document.delay()

  Queue assignments:
    extract_text            → "indexing"
    ocr_document            → "ocr"
    index_document          → "indexing"
    generate_document_preview → "indexing"
"""
import logging
import shutil
import subprocess
from pathlib import Path
from tempfile import TemporaryDirectory

from celery import shared_task
from django.db import transaction  # ← FIX: was missing, caused NameError

logger = logging.getLogger(__name__)

# Minimum average characters per PDF page before treating it as image-based
_MIN_CHARS_PER_PAGE = 50


# ─────────────────────────────────────────────────────────────────────────────
# extract_text — handles NON-flagged documents (auto-detection path)
# ─────────────────────────────────────────────────────────────────────────────

@shared_task(bind=True, max_retries=3, queue="indexing")
def extract_text(self, document_id: str):
    """
    Extract text from a document that was NOT explicitly flagged as scanned.

    For PDFs: uses pdfplumber for native text extraction.  If the result is
    sparse (image-based PDF), routes to ocr_document.

    For DOCX/XLSX: uses python-docx / openpyxl.

    NOTE: Not called for confirmed scans (is_scanned=True at upload time) —
    the serializer calls ocr_document.delay() directly for those.
    """
    from .models import Document, OCRStatus

    try:
        doc = Document.objects.get(id=document_id)
    except Document.DoesNotExist:
        logger.warning("extract_text: document %s not found", document_id)
        return

    # Skip only if OCR is already running or complete — NOT on "pending".
    if doc.ocr_status in (OCRStatus.PROCESSING, OCRStatus.DONE):
        logger.info(
            "extract_text: skipping %s — OCR already %s",
            document_id, doc.ocr_status,
        )
        _trigger_index(document_id)
        return

    mime      = doc.file_mime_type or ""
    file_path = doc.file.path
    text      = ""

    try:
        if mime.startswith("image/"):
            # Images should have gone straight to ocr_document — handle defensively
            _mark_pending(document_id, auto_flag_scanned=True)
            ocr_document.delay(document_id)
            return

        if mime == "application/pdf":
            import pdfplumber
            pages_text = []
            with pdfplumber.open(file_path) as pdf:
                num_pages = len(pdf.pages)
                for page in pdf.pages:
                    pages_text.append(page.extract_text() or "")
            text = "\n".join(pages_text)

            chars_per_page = len(text.strip()) / max(num_pages, 1)
            if chars_per_page < _MIN_CHARS_PER_PAGE:
                logger.info(
                    "extract_text: PDF %s is sparse (%.1f chars/page) — routing to OCR",
                    document_id, chars_per_page,
                )
                _mark_pending(document_id, auto_flag_scanned=True)
                ocr_document.delay(document_id)
                return

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

        Document.objects.filter(id=document_id).update(
            extracted_text=text[:1_000_000]
        )
        _trigger_index(document_id)

    except Exception as exc:
        logger.error("extract_text failed for %s: %s", document_id, exc)
        raise self.retry(exc=exc, countdown=60)


# ─────────────────────────────────────────────────────────────────────────────
# ocr_document — OCR worker
# ─────────────────────────────────────────────────────────────────────────────

@shared_task(bind=True, max_retries=2, queue="ocr")
def ocr_document(self, document_id: str):
    """
    Run OCR on a confirmed scanned document and store the extracted text.

    State machine:  PENDING → PROCESSING → DONE | FAILED

    The PENDING→PROCESSING transition is performed atomically via a filtered
    UPDATE so that duplicate Celery deliveries are safely no-ops.
    """
    from .models import Document, OCRStatus
    from django.conf import settings as django_settings

    # Atomic claim — only one worker proceeds
    claimed = Document.objects.filter(
        id=document_id,
        ocr_status=OCRStatus.PENDING,
    ).update(ocr_status=OCRStatus.PROCESSING)

    if not claimed:
        try:
            actual_status = Document.objects.values_list(
                "ocr_status", flat=True
            ).get(id=document_id)
            logger.info(
                "ocr_document: skipping %s — not claimable (status=%s)",
                document_id, actual_status,
            )
        except Document.DoesNotExist:
            logger.warning("ocr_document: document %s not found", document_id)
        return

    engine = getattr(django_settings, "OCR_ENGINE", "tesseract").lower()

    try:
        doc  = Document.objects.get(id=document_id)
        text = _ocr_textract(doc) if engine == "textract" else _ocr_tesseract(doc)

        Document.objects.filter(id=document_id).update(
            extracted_text=text[:1_000_000],
            ocr_status=OCRStatus.DONE,
        )
        logger.info(
            "ocr_document: completed for %s (%d chars extracted)",
            document_id, len(text),
        )
        _trigger_index(document_id)

    except Exception as exc:
        logger.error("ocr_document failed for %s: %s", document_id, exc)
        try:
            Document.objects.filter(id=document_id).update(
                ocr_status=OCRStatus.PENDING
            )
            raise self.retry(exc=exc, countdown=120)
        except self.MaxRetriesExceededError:
            Document.objects.filter(id=document_id).update(
                ocr_status=OCRStatus.FAILED
            )
            logger.error(
                "ocr_document: max retries exceeded for %s — marked as failed",
                document_id,
            )


# ─────────────────────────────────────────────────────────────────────────────
# OCR backends
# ─────────────────────────────────────────────────────────────────────────────

def _ocr_tesseract(doc) -> str:
    """
    Local Tesseract OCR.

    System deps:  apt-get install tesseract-ocr tesseract-ocr-eng poppler-utils
    Python deps:  pytesseract>=0.3.10  pdf2image>=1.17.0  Pillow>=10.0.0

    Django settings:
      TESSERACT_CMD  — binary path override (blank = use PATH)
      OCR_LANGUAGES  — Tesseract lang codes, e.g. "eng swa" (default "eng")
      OCR_DPI        — PDF rasterisation DPI (default 300)
    """
    import pytesseract
    from PIL import Image
    from django.conf import settings as django_settings

    cmd = getattr(django_settings, "TESSERACT_CMD", "").strip()
    if cmd:
        pytesseract.pytesseract.tesseract_cmd = cmd

    languages = getattr(django_settings, "OCR_LANGUAGES", "eng")
    dpi       = getattr(django_settings, "OCR_DPI", 300)
    file_path = doc.file.path
    mime      = doc.file_mime_type or ""

    pages: list[Image.Image] = []

    if mime == "application/pdf":
        from pdf2image import convert_from_path
        pages = convert_from_path(file_path, dpi=dpi)
    elif mime.startswith("image/"):
        pages = [Image.open(file_path)]
    else:
        try:
            pages = [Image.open(file_path)]
        except Exception:
            logger.warning(
                "_ocr_tesseract: cannot open %s (%s) as image", file_path, mime
            )
            return ""

    parts = []
    for i, img in enumerate(pages, start=1):
        try:
            parts.append(pytesseract.image_to_string(img, lang=languages))
        except Exception as exc:
            logger.warning("_ocr_tesseract: page %d of %s failed: %s", i, doc.id, exc)

    return "\n\n".join(parts)


def _ocr_textract(doc) -> str:
    """
    AWS Textract OCR.

    Files ≤ 5 MB  → synchronous DetectDocumentText
    Files  > 5 MB → async StartDocumentTextDetection via S3 staging

    Settings:
      AWS_TEXTRACT_REGION     (default "us-east-1")
      AWS_TEXTRACT_S3_BUCKET  (required for files > 5 MB)
    """
    import boto3
    from django.conf import settings as django_settings

    region    = getattr(django_settings, "AWS_TEXTRACT_REGION", "us-east-1")
    s3_bucket = getattr(django_settings, "AWS_TEXTRACT_S3_BUCKET", "")
    file_path = doc.file.path

    textract = boto3.client("textract", region_name=region)

    if doc.file_size <= 5 * 1024 * 1024:
        with open(file_path, "rb") as f:
            resp = textract.detect_document_text(Document={"Bytes": f.read()})
        return _parse_textract_response(resp)

    if not s3_bucket:
        raise RuntimeError(
            f"AWS_TEXTRACT_S3_BUCKET required for files > 5 MB "
            f"(document {doc.id} is {doc.file_size / (1024*1024):.1f} MB)"
        )

    s3_key = f"ocr-staging/{doc.id}/{doc.file_name}"
    s3 = boto3.client("s3", region_name=region)
    s3.upload_file(file_path, s3_bucket, s3_key)

    start  = textract.start_document_text_detection(
        DocumentLocation={"S3Object": {"Bucket": s3_bucket, "Name": s3_key}}
    )
    job_id = start["JobId"]

    import time
    deadline = time.time() + 600
    while time.time() < deadline:
        status_resp = textract.get_document_text_detection(JobId=job_id)
        job_status  = status_resp["JobStatus"]

        if job_status == "SUCCEEDED":
            pages = [status_resp]
            token = status_resp.get("NextToken")
            while token:
                pr = textract.get_document_text_detection(JobId=job_id, NextToken=token)
                pages.append(pr)
                token = pr.get("NextToken")
            try:
                s3.delete_object(Bucket=s3_bucket, Key=s3_key)
            except Exception:
                pass
            return "\n".join(_parse_textract_response(p) for p in pages)

        if job_status == "FAILED":
            raise RuntimeError(f"Textract job {job_id} failed")

        time.sleep(10)

    raise TimeoutError(f"Textract job {job_id} timed out after 10 minutes")


def _parse_textract_response(response: dict) -> str:
    return "\n".join(
        b["Text"]
        for b in response.get("Blocks", [])
        if b.get("BlockType") == "LINE" and b.get("Text")
    )


# ─────────────────────────────────────────────────────────────────────────────
# generate_document_preview — Office → PDF preview worker
# ─────────────────────────────────────────────────────────────────────────────

@shared_task(bind=True, max_retries=2, queue="indexing")
def generate_document_preview(self, document_id: str):
    """
    Convert an Office document to PDF for in-browser preview via LibreOffice.

    State machine: PENDING → PROCESSING → DONE | FAILED

    The PENDING→PROCESSING claim is atomic so duplicate task deliveries are
    safely ignored.
    """
    from django.conf import settings as django_settings
    from django.core.files.base import ContentFile

    from .models import Document, PreviewStatus

    claimed = Document.objects.filter(
        id=document_id,
        preview_status=PreviewStatus.PENDING,
    ).update(preview_status=PreviewStatus.PROCESSING)

    if not claimed:
        try:
            actual_status = Document.objects.values_list(
                "preview_status", flat=True
            ).get(id=document_id)
            logger.info(
                "generate_document_preview: skipping %s — not claimable (status=%s)",
                document_id, actual_status,
            )
        except Document.DoesNotExist:
            logger.warning(
                "generate_document_preview: document %s not found", document_id
            )
        return

    try:
        doc = Document.objects.get(id=document_id)
    except Document.DoesNotExist:
        logger.warning("generate_document_preview: document %s not found", document_id)
        return

    if not doc.is_office_doc():
        Document.objects.filter(id=document_id).update(preview_status="")
        return

    soffice_bin = (
        getattr(django_settings, "LIBREOFFICE_BIN", "").strip()
        or shutil.which("libreoffice")
        or shutil.which("soffice")
    )
    timeout = int(getattr(django_settings, "LIBREOFFICE_TIMEOUT", 120))

    if not soffice_bin:
        Document.objects.filter(id=document_id).update(
            preview_status=PreviewStatus.FAILED
        )
        logger.error(
            "generate_document_preview: LibreOffice binary not found for %s",
            document_id,
        )
        return

    try:
        source_path = Path(doc.file.path)
        with TemporaryDirectory(prefix="doc_preview_") as tmpdir:
            output_dir = Path(tmpdir)
            cmd = [
                soffice_bin,
                "--headless",
                "--convert-to", "pdf",
                "--outdir", str(output_dir),
                str(source_path),
            ]
            result = subprocess.run(
                cmd,
                capture_output=True,
                text=True,
                timeout=timeout,
                check=False,
            )

            preview_path = output_dir / f"{source_path.stem}.pdf"
            if not preview_path.exists():
                pdfs = sorted(output_dir.glob("*.pdf"))
                if pdfs:
                    preview_path = pdfs[0]

            if result.returncode != 0 or not preview_path.exists():
                raise RuntimeError(
                    f"LibreOffice conversion failed"
                    f" (code={result.returncode}, stderr={result.stderr!r})"
                )

            pdf_bytes = preview_path.read_bytes()

        with transaction.atomic():
            if doc.preview_pdf:
                doc.preview_pdf.delete(save=False)
            doc.preview_pdf.save(
                f"{doc.id}_preview.pdf",
                ContentFile(pdf_bytes),
                save=False,
            )
            doc.preview_status = PreviewStatus.DONE
            doc.save(update_fields=["preview_pdf", "preview_status", "updated_at"])

        logger.info(
            "generate_document_preview: completed for %s (%d bytes)",
            document_id, len(pdf_bytes),
        )

    except (RuntimeError, subprocess.SubprocessError) as exc:
        logger.error(
            "generate_document_preview: fatal error for %s: %s", document_id, exc
        )
        Document.objects.filter(id=document_id).update(
            preview_status=PreviewStatus.FAILED
        )

    except Exception as exc:
        logger.error("generate_document_preview failed for %s: %s", document_id, exc)
        try:
            Document.objects.filter(id=document_id).update(
                preview_status=PreviewStatus.PENDING
            )
            raise self.retry(exc=exc, countdown=60)
        except self.MaxRetriesExceededError:
            Document.objects.filter(id=document_id).update(
                preview_status=PreviewStatus.FAILED
            )
            logger.error(
                "generate_document_preview: max retries exceeded for %s",
                document_id,
            )


# ─────────────────────────────────────────────────────────────────────────────
# Helpers
# ─────────────────────────────────────────────────────────────────────────────

def _mark_pending(document_id: str, auto_flag_scanned: bool = False) -> None:
    """
    Set ocr_status=PENDING.  Only called by extract_text for auto-detected
    scanned PDFs.  Does not overwrite PROCESSING or DONE.
    """
    from .models import Document, OCRStatus
    fields: dict = {"ocr_status": OCRStatus.PENDING}
    if auto_flag_scanned:
        fields["is_scanned"] = True
    Document.objects.filter(
        id=document_id,
        ocr_status__in=["", OCRStatus.FAILED],
    ).update(**fields)


def _trigger_index(document_id: str) -> None:
    try:
        from apps.search.tasks import index_document
        index_document.delay(document_id)
    except Exception as exc:
        logger.warning(
            "_trigger_index: could not queue indexing for %s: %s",
            document_id, exc,
        )