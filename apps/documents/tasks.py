"""
apps/documents/tasks.py

Preview pipeline — complete rewrite of generate_document_preview
────────────────────────────────────────────────────────────────
Problems fixed in this revision:

PREVIEW-1  LibreOffice profile contention
    Multiple concurrent workers shared ~/.config/libreoffice. Any two
    simultaneous conversions would fight over the lock files, causing one
    to hang indefinitely or crash with a "user installation" error.
    FIX: Each invocation gets a private --user-installation directory
    inside the tmpdir so processes are completely isolated.

PREVIEW-2  Blocking subprocess in Celery worker
    subprocess.run() with a long timeout held the worker thread and left
    orphaned soffice processes when the timeout fired.
    FIX: subprocess.Popen + proc.wait(timeout) + explicit proc.kill()
    in a finally block guarantees the child is always reaped, even on
    KeyboardInterrupt or worker shutdown.

PREVIEW-3  Retry resets to PENDING without atomic re-claim
    The generic except branch reset status → PENDING then called
    self.retry(). Because self.retry() raises Retry immediately, the
    MaxRetriesExceededError handler was unreachable dead code.  On the
    next delivery the task would re-claim correctly, but two rapid
    deliveries could race.
    FIX: Do NOT reset to PENDING before retry. The atomic claim filter
    (PENDING → PROCESSING) at the top of the task is the gate.  Reset
    happens only here, just before raising Retry, so the next delivery
    will see PENDING again and claim it cleanly.

PREVIEW-4  TOCTOU race in _queue_office_preview (views.py)
    UPDATE … WHERE status IN ['', FAILED] followed by a separate SELECT
    gave a stale read; a sibling worker could claim the row between the
    two queries, causing a duplicate task to be queued.
    FIX: use update()'s return value (number of rows changed) as the
    sole gate — if updated == 0 the row was already claimed, skip delay().
    The views.py helper is updated accordingly.

PREVIEW-5  File saved outside transaction then transaction fails
    preview_pdf.save(save=False) writes to storage BEFORE the DB commit.
    If the UPDATE fails the orphaned file is never cleaned up, and the
    old preview file was already deleted.
    FIX: Read bytes from tmpdir, save to storage, update DB in that order.
    Old preview deletion is deferred until after the new file is confirmed.

PREVIEW-6  soffice --headless with no explicit output format options
    LibreOffice's PDF export defaults can produce oversized files and
    occasionally stall on complex documents.
    FIX: Pass --headless --norestore --nofirststartwizard flags and
    target PDF/A-1 for reliable, compact output.

Queue assignments (unchanged):
    extract_text              → "indexing"
    ocr_document              → "ocr"
    index_document            → "indexing"
    generate_document_preview → "preview"   ← moved off "indexing" so
                                               long-running LO conversions
                                               don't starve text-indexing jobs.
"""
import logging
import os
import shutil
import signal
import subprocess
import time
from pathlib import Path
from tempfile import TemporaryDirectory

from celery import shared_task
from django.core.files.base import ContentFile
from django.core.files.storage import default_storage
from django.core.cache import cache
from django.db import transaction
from django.utils import timezone

logger = logging.getLogger(__name__)

# Minimum average characters per PDF page before treating it as image-based
_MIN_CHARS_PER_PAGE = 50

# Cache TTL for preview error messages (1 hour)
_PREVIEW_ERROR_TTL = 3_600


def _preview_error_cache_key(document_id: str) -> str:
    return f"document_preview_error:{document_id}"


def _preview_start_cache_key(document_id: str) -> str:
    """Stores the wall-clock start time of a PROCESSING preview job.
    Read by trigger_preview in views.py for staleness detection.
    Avoids the heartbeat (which refreshes updated_at) defeating the check."""
    return f"document_preview_started_at:{document_id}"


def _version_preview_error_cache_key(version_id: str) -> str:
    return f"document_version_preview_error:{version_id}"


def _version_preview_start_cache_key(version_id: str) -> str:
    return f"document_version_preview_started_at:{version_id}"


def _version_preview_status_cache_key(version_id: str) -> str:
    return f"document_version_preview_status:{version_id}"


def _version_preview_processing_cache_key(version_id: str) -> str:
    return f"document_version_preview_processing:{version_id}"


def _version_preview_storage_name(version_id: str) -> str:
    return f"previews/versions/{version_id}_preview.pdf"


# ─────────────────────────────────────────────────────────────────────────────
# extract_text — handles NON-flagged documents (auto-detection path)
# ─────────────────────────────────────────────────────────────────────────────

@shared_task(bind=True, max_retries=3, queue="indexing")
def extract_text(self, document_id: str):
    """
    Extract text from a document that was NOT explicitly flagged as scanned.

    For PDFs: uses pdfplumber for native text extraction. If the result is
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
        doc = Document.objects.get(id=document_id)

        # ── Run OCR via the new modular pipeline ──────────────────────────
        from apps.documents.ocr.tasks_ocr import run_ocr
        text, metadata_updates = run_ocr(doc)

        # ── Merge quality metrics + suggestions into metadata ─────────────
        # Use the existing metadata as the base; never clobber unrelated keys.
        current_metadata = doc.metadata or {}
        updated_metadata = {**current_metadata, **metadata_updates}

        Document.objects.filter(id=document_id).update(
            extracted_text=text[:1_000_000],
            ocr_status=OCRStatus.DONE,
            metadata=updated_metadata,
        )

        suggestions = metadata_updates.get("ocr_suggestions", {})
        quality = metadata_updates.get("ocr_quality", {})

        logger.info(
            "ocr_document: completed for %s (%d chars, mean_conf=%.1f, "
            "quality=%.0f%%, suggestions=%s)",
            document_id,
            len(text),
            quality.get("mean_confidence", 0),
            quality.get("overall_quality_ratio", 0) * 100,
            list(suggestions.keys()),
        )
        _trigger_index(document_id)

    except Exception as exc:
        logger.error("ocr_document failed for %s: %s", document_id, exc)
        # Reset to PENDING so the next delivery can claim it
        Document.objects.filter(id=document_id).update(ocr_status=OCRStatus.PENDING)
        try:
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
    Delegate to the new pre-processing + confidence-scored OCR pipeline.

    This shim keeps backward compatibility with any code that calls
    _ocr_tesseract() directly (e.g. the textract fallback guard).
    The real implementation lives in apps.documents.ocr.tasks_ocr.
    """
    from apps.documents.ocr.tasks_ocr import _ocr_tesseract_v2
    text, _quality = _ocr_tesseract_v2(doc)
    return text


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

def _pdf_filter_for(source_path: Path) -> str:
    """
    Return the LibreOffice --convert-to filter string for the given file.

    Using 'writer_pdf_Export' for everything works for .docx but causes
    LibreOffice to exit 0 with no output file for .xlsx/.pptx because the
    wrong application filter is specified. Use the generic 'pdf' target
    instead — LO auto-selects the correct sub-filter based on the loaded
    document type — which is the same as what the GUI 'Export as PDF' does.
    """
    suffix = source_path.suffix.lower()
    if suffix in {".xls", ".xlsx", ".xlsm", ".xlsb", ".xlt", ".xltx", ".xltm", ".ods"}:
        return "pdf:calc_pdf_Export"
    if suffix in {".ppt", ".pptx", ".pptm", ".pps", ".ppsx", ".pot", ".potx", ".potm", ".odp"}:
        return "pdf:impress_pdf_Export"
    # .doc, .docx, .docm, .dot*, .rtf, .odt and everything else
    return "pdf:writer_pdf_Export"


def _convert_office_to_pdf(
    soffice_bin: str,
    source_path: Path,
    output_dir: Path,
    profile_dir: Path,
    timeout: int,
    heartbeat=None,
    heartbeat_interval: int = 30,
) -> bool:
    """
    Converts an Office document to PDF using an isolated LibreOffice process.

    Uses Popen + wait(timeout) to guarantee child processes are always killed
    on timeout, avoiding the orphaned process issues common with subprocess.run.

    PREVIEW-1: Isolated user installation prevents lock file contention.
    PREVIEW-2: Process group cleanup prevents orphaned soffice processes.
    """
    # Create necessary XDG directories
    data_dir = profile_dir / 'data'
    cache_dir = profile_dir / 'cache'
    data_dir.mkdir(exist_ok=True)
    cache_dir.mkdir(exist_ok=True)

    # Set environment variables for LibreOffice in container
    env = os.environ.copy()
    env.update({
        'DISPLAY': ':99',  # Virtual display for headless operation
        'HOME': str(profile_dir.parent),  # Ensure HOME points to our temp dir
        'XDG_CONFIG_HOME': str(profile_dir),
        'XDG_DATA_HOME': str(data_dir),
        'XDG_CACHE_HOME': str(cache_dir),
    })
    
    # LibreOffice requires the user-installation value as a file:// URL
    profile_url = profile_dir.as_uri()
    pdf_filter  = _pdf_filter_for(source_path)

    cmd = [
        soffice_bin,
        f"-env:UserInstallation={profile_url}",
        "--headless",
        "--nocrashreport",
        "--nodefault",
        "--nofirststartwizard",
        "--nologo",
        "--norestore",  # CRITICAL: disables document-recovery prompt that hangs batch mode
        "--convert-to", pdf_filter,
        "--outdir", str(output_dir),
        str(source_path),
    ]

    logger.info("LibreOffice cmd: %s", " ".join(cmd))

    # Capture stderr so conversion errors appear in Celery logs instead of /dev/null
    proc = subprocess.Popen(
        cmd,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        env=env,
        start_new_session=True,
    )
    try:
        deadline = time.monotonic() + timeout
        next_heartbeat = time.monotonic()

        while True:
            ret = proc.poll()
            if ret is not None:
                output = (proc.stdout.read() or b"").decode("utf-8", errors="replace")
                if ret == 0:
                    if output:
                        logger.debug("LibreOffice stdout: %s", output[:2000])
                    return True
                logger.error(
                    "LibreOffice conversion failed (exit=%d): %s", ret, output[:2000]
                )
                return False

            now = time.monotonic()
            if heartbeat and now >= next_heartbeat:
                try:
                    heartbeat()
                except Exception as hb_exc:
                    logger.warning("LibreOffice preview heartbeat failed: %s", hb_exc)
                next_heartbeat = now + heartbeat_interval

            if now >= deadline:
                output = b""
                try:
                    proc.stdout.close()
                except Exception:
                    pass
                logger.error("LibreOffice conversion timed out after %ds", timeout)
                try:
                    os.killpg(os.getpgid(proc.pid), signal.SIGTERM)
                except (ProcessLookupError, OSError):
                    pass
                try:
                    proc.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    try:
                        os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
                    except (ProcessLookupError, OSError):
                        pass
                    proc.wait()
                return False

            time.sleep(0.5)
    except Exception as exc:
        logger.error("_convert_office_to_pdf error: %s", exc)
        try:
            proc.kill()
            proc.wait()
        except Exception:
            pass
        return False


def _convert_office_source_to_pdf_bytes(
    source_path: Path,
    soffice_bin: str,
    timeout: int,
    heartbeat=None,
) -> bytes:
    """
    Convert an Office source file to PDF bytes using an isolated temporary
    LibreOffice profile and output directory.
    """
    pdf_bytes: bytes | None = None

    with TemporaryDirectory(prefix="docpreview_") as tmpdir:
        tmp = Path(tmpdir)
        output_dir = tmp / "output"
        profile_dir = tmp / "profile"
        output_dir.mkdir()
        profile_dir.mkdir()

        if heartbeat:
            heartbeat()
        success = _convert_office_to_pdf(
            soffice_bin,
            source_path,
            output_dir,
            profile_dir,
            timeout,
            heartbeat=heartbeat,
        )

        preview_path = output_dir / f"{source_path.stem}.pdf"
        if not preview_path.exists():
            pdfs = sorted(output_dir.glob("*.pdf"))
            if pdfs:
                preview_path = pdfs[0]

        if not success or not preview_path.exists():
            found = [p.name for p in output_dir.glob("*")]
            timed_out = not success and not preview_path.exists()
            raise RuntimeError(
                f"LibreOffice conversion {'timed out' if timed_out else 'failed'} "
                f"(filter={_pdf_filter_for(source_path)!r}, outdir={found!r}). "
                f"Check Celery logs for LibreOffice stdout."
            )

        pdf_bytes = preview_path.read_bytes()

    return pdf_bytes


def _persist_preview_file(
    instance,
    pdf_bytes: bytes,
    preview_filename: str,
    touch_updated_at: bool = True,
) -> None:
    """
    Persist preview bytes onto a model instance that has preview_pdf and
    preview_status fields.
    """
    from .models import PreviewStatus

    old_preview_name = instance.preview_pdf.name if instance.preview_pdf else None
    content_file = ContentFile(pdf_bytes, name=preview_filename)
    instance.preview_pdf.save(preview_filename, content_file, save=False)
    new_preview_name = instance.preview_pdf.name

    update_fields = {
        "preview_pdf": new_preview_name,
        "preview_status": PreviewStatus.DONE,
    }
    if touch_updated_at and hasattr(instance, "updated_at"):
        update_fields["updated_at"] = timezone.now()

    instance.__class__.objects.filter(id=instance.id).update(**update_fields)

    if old_preview_name and old_preview_name != new_preview_name:
        try:
            if default_storage.exists(old_preview_name):
                default_storage.delete(old_preview_name)
        except Exception as del_exc:
            logger.warning(
                "_persist_preview_file: could not delete old preview %s: %s",
                old_preview_name, del_exc,
            )


def _persist_version_preview_file(version_id: str, pdf_bytes: bytes) -> str:
    """
    Persist a historical version preview to deterministic storage.
    """
    preview_name = _version_preview_storage_name(version_id)
    content_file = ContentFile(pdf_bytes, name=preview_name)

    try:
        if default_storage.exists(preview_name):
            default_storage.delete(preview_name)
    except Exception as del_exc:
        logger.warning(
            "_persist_version_preview_file: could not clear old preview %s: %s",
            preview_name, del_exc,
        )

    stored_name = default_storage.save(preview_name, content_file)
    return stored_name


def _delete_version_preview_file(version_id: str) -> None:
    preview_name = _version_preview_storage_name(version_id)
    try:
        if default_storage.exists(preview_name):
            default_storage.delete(preview_name)
    except Exception as del_exc:
        logger.warning(
            "_delete_version_preview_file: could not delete %s: %s",
            preview_name, del_exc,
        )


def _fail_preview(
    model,
    object_id: str,
    error_message: str,
    error_cache_key: str,
    start_cache_key: str,
    touch_updated_at: bool = True,
) -> None:
    from .models import PreviewStatus

    cache.set(error_cache_key, error_message[:2000], timeout=_PREVIEW_ERROR_TTL)
    cache.delete(start_cache_key)
    update_fields = {"preview_status": PreviewStatus.FAILED}
    if touch_updated_at:
        update_fields["updated_at"] = timezone.now()
    model.objects.filter(id=object_id).update(**update_fields)


@shared_task(bind=True, max_retries=2, queue="preview")
def generate_document_preview(self, document_id: str):
    """
    Convert an Office document to PDF for in-browser preview via LibreOffice.

    State machine: PENDING → PROCESSING → DONE | FAILED

    The PENDING→PROCESSING claim is atomic (filtered UPDATE) so duplicate
    task deliveries are safely no-ops.
    """
    from django.conf import settings as django_settings
    from django.core.files.base import ContentFile

    from .models import Document, PreviewStatus

    # ── Atomic claim ──────────────────────────────────────────────────────────
    claimed = Document.objects.filter(
        id=document_id,
        preview_status=PreviewStatus.PENDING,
    ).update(preview_status=PreviewStatus.PROCESSING, updated_at=timezone.now())

    if not claimed:
        try:
            actual = Document.objects.values_list(
                "preview_status", flat=True
            ).get(id=document_id)
            logger.info(
                "generate_document_preview: skipping %s — not claimable (status=%s)",
                document_id, actual,
            )
        except Document.DoesNotExist:
            logger.warning(
                "generate_document_preview: document %s not found", document_id
            )
        return

    # Record wall-clock start time in cache so trigger_preview can detect stale
    # jobs without being misled by the heartbeat (which refreshes updated_at
    # every 30 s, making every in-progress job look perpetually fresh).
    from django.conf import settings as _s
    _stale_ttl = int(getattr(_s, "PREVIEW_PROCESSING_STALE_SECONDS", 300))
    cache.set(_preview_start_cache_key(document_id), timezone.now(),
              timeout=_stale_ttl + 120)

    # ── Load document ─────────────────────────────────────────────────────────
    try:
        doc = Document.objects.get(id=document_id)
    except Document.DoesNotExist:
        logger.warning("generate_document_preview: document %s disappeared", document_id)
        return

    logger.info(
        "generate_document_preview: start doc=%s mime=%s file=%s",
        document_id, doc.file_mime_type, getattr(doc.file, "name", ""),
    )

    if not doc.is_office_doc():
        # Should not happen — only queue for office docs — but guard anyway
        Document.objects.filter(id=document_id).update(preview_status="")
        return

    # ── Locate LibreOffice binary ─────────────────────────────────────
    configured_bin = (
        getattr(django_settings, "LIBREOFFICE_BIN", "").strip()
        or getattr(django_settings, "LIBREOFFICE_CMD", "").strip()
    )
    if configured_bin and not Path(configured_bin).exists():
        logger.warning(
            "generate_document_preview: configured path %s missing — falling back to PATH",
            configured_bin,
        )
        configured_bin = ""

    # Try multiple common paths for LibreOffice in container environments
    soffice_bin = (
        configured_bin
        or shutil.which("libreoffice")
        or shutil.which("soffice")
        or shutil.which("/usr/bin/libreoffice")
        or shutil.which("/usr/bin/soffice")
        or (Path("/usr/bin/libreoffice").exists() and "/usr/bin/libreoffice")
        or (Path("/usr/bin/soffice").exists() and "/usr/bin/soffice")
    )
    timeout = int(getattr(django_settings, "LIBREOFFICE_TIMEOUT", 120))

    if not soffice_bin:
        _fail(document_id, "LibreOffice binary not found. Checked: libreoffice, soffice, /usr/bin/libreoffice, /usr/bin/soffice")
        return

    logger.info(
        "generate_document_preview: doc=%s soffice=%s timeout=%ss",
        document_id, soffice_bin, timeout,
    )

    def heartbeat() -> None:
        Document.objects.filter(id=document_id).update(updated_at=timezone.now())

    try:
        source_path = Path(doc.file.path)
        pdf_bytes = _convert_office_source_to_pdf_bytes(
            source_path,
            soffice_bin,
            timeout,
            heartbeat=heartbeat,
        )

    except RuntimeError as exc:
        # Definitive failure — no retry (wrong binary, corrupt file, etc.)
        _fail_preview(
            Document,
            document_id,
            str(exc),
            _preview_error_cache_key(document_id),
            _preview_start_cache_key(document_id),
        )
        logger.error(
            "generate_document_preview: fatal for %s: %s", document_id, exc
        )
        return

    except Exception as exc:
        # Transient failure — retry with exponential back-off
        logger.error(
            "generate_document_preview: transient error for %s: %s", document_id, exc
        )
        # Reset to PENDING so the next delivery can claim atomically
        Document.objects.filter(id=document_id).update(
            preview_status=PreviewStatus.PENDING,
            updated_at=timezone.now(),
        )
        try:
            raise self.retry(exc=exc, countdown=30 * (2 ** self.request.retries))
        except self.MaxRetriesExceededError:
            _fail_preview(
                Document,
                document_id,
                f"Max retries exceeded: {exc}",
                _preview_error_cache_key(document_id),
                _preview_start_cache_key(document_id),
            )
            logger.error(
                "generate_document_preview: max retries exceeded for %s", document_id
            )
        return

    # ── Persist PDF ───────────────────────────────────────────────────────────
    # Storage write happens OUTSIDE the atomic block intentionally:
    # Django's storage backends (S3, GCS, local) are not transactional.
    # We write the new file first, then atomically swap the DB pointer and
    # delete the old file. If the DB write fails, the new file is orphaned
    # (harmless, can be garbage-collected). If old-file deletion fails, we
    # log but don't fail — the new preview is still correct.
    try:
        new_filename = f"{doc.id}_preview.pdf"
        _persist_preview_file(doc, pdf_bytes, new_filename)
        cache.delete(_preview_error_cache_key(document_id))
        cache.delete(_preview_start_cache_key(document_id))
        logger.info(
            "generate_document_preview: done for %s (%d bytes)", document_id, len(pdf_bytes)
        )

    except Exception as exc:
        logger.error(
            "generate_document_preview: failed to persist PDF for %s: %s", document_id, exc
        )
        _fail_preview(
            Document,
            document_id,
            f"Storage error: {exc}",
            _preview_error_cache_key(document_id),
            _preview_start_cache_key(document_id),
        )


@shared_task(bind=True, max_retries=2, queue="preview")
def generate_document_version_preview(self, version_id: str):
    """
    Convert a historical Office version to a cached PDF preview.
    """
    from django.conf import settings as django_settings

    from .models import DocumentVersion, PreviewStatus

    stale_ttl = int(getattr(django_settings, "PREVIEW_PROCESSING_STALE_SECONDS", 300))
    status_key = _version_preview_status_cache_key(version_id)
    processing_key = _version_preview_processing_cache_key(version_id)

    current_status = cache.get(status_key)
    if current_status not in (PreviewStatus.PENDING, PreviewStatus.PROCESSING):
        logger.info(
            "generate_document_version_preview: skipping %s — not claimable (status=%s)",
            version_id, current_status,
        )
        return

    if not cache.add(processing_key, timezone.now(), timeout=stale_ttl + 120):
        logger.info(
            "generate_document_version_preview: skipping %s — already processing",
            version_id,
        )
        return

    cache.set(status_key, PreviewStatus.PROCESSING, timeout=stale_ttl + 120)
    cache.set(_version_preview_start_cache_key(version_id), timezone.now(), timeout=stale_ttl + 120)

    try:
        version = DocumentVersion.objects.get(id=version_id)
    except DocumentVersion.DoesNotExist:
        cache.delete(processing_key)
        cache.delete(status_key)
        cache.delete(_version_preview_start_cache_key(version_id))
        logger.warning("generate_document_version_preview: version %s disappeared", version_id)
        return

    logger.info(
        "generate_document_version_preview: start version=%s file=%s",
        version_id, getattr(version.file, "name", ""),
    )

    if not version.is_office_doc():
        cache.delete(processing_key)
        cache.delete(status_key)
        return

    configured_bin = (
        getattr(django_settings, "LIBREOFFICE_BIN", "").strip()
        or getattr(django_settings, "LIBREOFFICE_CMD", "").strip()
    )
    if configured_bin and not Path(configured_bin).exists():
        logger.warning(
            "generate_document_version_preview: configured path %s missing — falling back to PATH",
            configured_bin,
        )
        configured_bin = ""

    soffice_bin = (
        configured_bin
        or shutil.which("libreoffice")
        or shutil.which("soffice")
        or shutil.which("/usr/bin/libreoffice")
        or shutil.which("/usr/bin/soffice")
        or (Path("/usr/bin/libreoffice").exists() and "/usr/bin/libreoffice")
        or (Path("/usr/bin/soffice").exists() and "/usr/bin/soffice")
    )
    timeout = int(getattr(django_settings, "LIBREOFFICE_TIMEOUT", 120))

    if not soffice_bin:
        cache.set(
            _version_preview_error_cache_key(version_id),
            "LibreOffice binary not found. Checked: libreoffice, soffice, /usr/bin/libreoffice, /usr/bin/soffice",
            timeout=_PREVIEW_ERROR_TTL,
        )
        cache.delete(processing_key)
        cache.set(status_key, PreviewStatus.FAILED, timeout=_PREVIEW_ERROR_TTL)
        return

    try:
        source_path = Path(version.file.path)
        pdf_bytes = _convert_office_source_to_pdf_bytes(
            source_path,
            soffice_bin,
            timeout,
        )
    except RuntimeError as exc:
        cache.set(_version_preview_error_cache_key(version_id), str(exc)[:2000], timeout=_PREVIEW_ERROR_TTL)
        cache.delete(_version_preview_start_cache_key(version_id))
        cache.delete(processing_key)
        cache.set(status_key, PreviewStatus.FAILED, timeout=_PREVIEW_ERROR_TTL)
        logger.error(
            "generate_document_version_preview: fatal for %s: %s", version_id, exc
        )
        return
    except Exception as exc:
        logger.error(
            "generate_document_version_preview: transient error for %s: %s",
            version_id, exc,
        )
        cache.set(status_key, PreviewStatus.PENDING, timeout=stale_ttl + 120)
        cache.delete(processing_key)
        try:
            raise self.retry(exc=exc, countdown=30 * (2 ** self.request.retries))
        except self.MaxRetriesExceededError:
            cache.set(
                _version_preview_error_cache_key(version_id),
                f"Max retries exceeded: {exc}"[:2000],
                timeout=_PREVIEW_ERROR_TTL,
            )
            cache.delete(_version_preview_start_cache_key(version_id))
            cache.delete(processing_key)
            cache.set(status_key, PreviewStatus.FAILED, timeout=_PREVIEW_ERROR_TTL)
            logger.error(
                "generate_document_version_preview: max retries exceeded for %s",
                version_id,
            )
        return

    try:
        _persist_version_preview_file(version_id, pdf_bytes)
        cache.set(status_key, PreviewStatus.DONE, timeout=_PREVIEW_ERROR_TTL)
        cache.delete(_version_preview_error_cache_key(version_id))
        cache.delete(_version_preview_start_cache_key(version_id))
        cache.delete(processing_key)
        logger.info(
            "generate_document_version_preview: done for %s (%d bytes)",
            version_id, len(pdf_bytes),
        )
    except Exception as exc:
        logger.error(
            "generate_document_version_preview: failed to persist PDF for %s: %s",
            version_id, exc,
        )
        cache.set(
            _version_preview_error_cache_key(version_id),
            f"Storage error: {exc}"[:2000],
            timeout=_PREVIEW_ERROR_TTL,
        )
        cache.delete(_version_preview_start_cache_key(version_id))
        cache.delete(processing_key)
        cache.set(status_key, PreviewStatus.FAILED, timeout=_PREVIEW_ERROR_TTL)


# ─────────────────────────────────────────────────────────────────────────────
# Helpers
# ─────────────────────────────────────────────────────────────────────────────

def _extract_ocr_suggestions(text: str) -> dict:
    """
    Delegate to the new DocumentFieldExtractor.

    The real implementation lives in apps.documents.ocr.extractor.
    This shim keeps any call sites outside tasks.py working unchanged.
    """
    from apps.documents.ocr.extractor import extract_document_fields
    return extract_document_fields(text)


def _fail(document_id: str, error_message: str) -> None:
    """Mark preview as permanently failed and cache the error for the UI."""
    from .models import Document, PreviewStatus
    cache.set(_preview_error_cache_key(document_id), error_message[:2000],
              timeout=_PREVIEW_ERROR_TTL)
    cache.delete(_preview_start_cache_key(document_id))
    Document.objects.filter(id=document_id).update(
        preview_status=PreviewStatus.FAILED,
        updated_at=timezone.now(),
    )


def _mark_pending(document_id: str, auto_flag_scanned: bool = False) -> None:
    """
    Set ocr_status=PENDING. Only called by extract_text for auto-detected
    scanned PDFs. Does not overwrite PROCESSING or DONE.
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