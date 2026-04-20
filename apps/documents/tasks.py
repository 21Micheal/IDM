"""
apps/documents/tasks.py

Bug fixes in this revision
──────────────────────────
BUG 1 — extract_text was on queue="ocr" instead of queue="indexing".
        Any deployment where the Celery worker only consumes "indexing"
        would leave all OCR tasks perpetually queued, appearing as an
        infinite pending/processing state.
        FIX: extract_text is back on queue="indexing" where it always was.

BUG 2 — The serializer pre-set ocr_status="pending" before any task ran,
        and the attempted fix made extract_text bail on "pending" status.
        Combined effect: extract_text saw "pending" and exited without ever
        calling ocr_document.delay() → status frozen at "pending" forever.
        FIX: The serializer no longer pre-sets ocr_status. For confirmed
        scans (is_scanned=True at upload time), the serializer now calls
        ocr_document.delay() directly — skipping extract_text entirely.
        extract_text only handles auto-detection from non-flagged PDFs.
        extract_text skips ONLY on PROCESSING or DONE, never on PENDING.

BUG 3 — ocr_document unconditionally set ocr_status="processing", allowing
        duplicate Celery tasks (from retries or re-queuing) to run in
        parallel and stomp on each other's state transitions.
        FIX: Atomic DB-level claim — filter(ocr_status=PENDING).update(
        ocr_status=PROCESSING) returns the number of rows updated. If 0,
        the task has already been claimed by another worker and exits early.

Architecture after these fixes
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
    extract_text   → "indexing"  (unchanged from original)
    ocr_document   → "ocr"
    index_document → "indexing"

  Worker commands needed:
    celery -A IDM worker -Q indexing -c 4 --loglevel=info
    celery -A IDM worker -Q ocr      -c 2 --loglevel=info
    (or combine: celery -A IDM worker -Q indexing,ocr -c 4 --loglevel=info)
"""
from celery import shared_task
import logging

logger = logging.getLogger(__name__)

# Minimum average characters per PDF page before we treat it as image-based
_MIN_CHARS_PER_PAGE = 50


# ─────────────────────────────────────────────────────────────────────────────
# extract_text — handles NON-flagged documents only (auto-detection path)
# ─────────────────────────────────────────────────────────────────────────────

@shared_task(bind=True, max_retries=3, queue="indexing")   # ← back to "indexing"
def extract_text(self, document_id: str):
    """
    Extract text from a document that was NOT explicitly flagged as scanned.

    Called after upload for PDFs, DOCX, and XLSX files.
    If a PDF turns out to be image-based (sparse native text), this task
    routes it to ocr_document instead of saving empty text.

    NOTE: This task is NOT called for confirmed scans (is_scanned=True) or
    image files — the serializer calls ocr_document.delay() directly for those.
    """
    from .models import Document, OCRStatus

    try:
        doc = Document.objects.get(id=document_id)
    except Document.DoesNotExist:
        logger.warning("extract_text: document %s not found", document_id)
        return

    # Skip only if OCR is already running or complete — NOT on "pending".
    # "pending" means the job is waiting to start; we should proceed.
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
        # Images that somehow reach this task (shouldn't happen with the new
        # serializer flow, but handle defensively)
        if mime.startswith("image/"):
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
# ocr_document — the actual OCR worker task
# ─────────────────────────────────────────────────────────────────────────────

@shared_task(bind=True, max_retries=2, queue="ocr")
def ocr_document(self, document_id: str):
    """
    Run OCR on a confirmed scanned document and store the extracted text.

    State machine:  PENDING → PROCESSING → DONE | FAILED

    The PENDING→PROCESSING transition is performed atomically via a filtered
    UPDATE.  If 0 rows are updated the document has already been claimed by
    another worker instance (retry or race condition) and this task exits
    without doing any work.
    """
    from .models import Document, OCRStatus
    from django.conf import settings as django_settings

    # ── Atomic claim: only one worker proceeds per document ──────────────────
    # filter(ocr_status=PENDING) means the UPDATE is a no-op if another worker
    # already claimed it. This is safe against duplicate Celery deliveries.
    claimed = Document.objects.filter(
        id=document_id,
        ocr_status=OCRStatus.PENDING,
    ).update(ocr_status=OCRStatus.PROCESSING)

    if not claimed:
        # Either already processing, done, failed, or document doesn't exist.
        # Fetch once to log the actual state; then exit cleanly.
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
        if engine == "textract":
            # Re-fetch doc inside the try so we have the latest file path
            doc = Document.objects.get(id=document_id)
            text = _ocr_textract(doc)
        else:
            doc = Document.objects.get(id=document_id)
            text = _ocr_tesseract(doc)

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
            # Reset to PENDING before retry so the atomic claim works again
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
    Tesseract local OCR.

    System requirements:
      apt-get install -y tesseract-ocr tesseract-ocr-eng poppler-utils

    Python requirements:
      pytesseract>=0.3.10  pdf2image>=1.17.0  Pillow>=10.0.0

    Settings:
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
            logger.warning(
                "_ocr_tesseract: page %d of %s failed: %s", i, doc.id, exc
            )

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

    start = textract.start_document_text_detection(
        DocumentLocation={"S3Object": {"Bucket": s3_bucket, "Name": s3_key}}
    )
    job_id = start["JobId"]

    import time
    deadline = time.time() + 600  # 10-minute wall-clock timeout
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
    # Only transition from empty/failed — never overwrite in-flight state
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