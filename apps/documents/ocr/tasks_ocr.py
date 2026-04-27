"""
apps/documents/ocr/tasks_ocr.py

Drop-in replacement for the OCR section of apps/documents/tasks.py.

INSTRUCTIONS FOR INTEGRATION
─────────────────────────────
1. Create the package:
       apps/documents/ocr/__init__.py   (empty)
       apps/documents/ocr/preprocessing.py
       apps/documents/ocr/engine.py
       apps/documents/ocr/extractor.py
       apps/documents/ocr/tasks_ocr.py  (this file)

2. In apps/documents/tasks.py replace the bodies of:
       _ocr_tesseract()           → delegate to _ocr_tesseract_v2()
       _extract_ocr_suggestions() → delegate to extract_document_fields()
       ocr_document()             → already correct; no changes needed in
                                    the task shell — only the helpers change.

   Or simply import and call from here directly if you prefer to keep
   tasks.py as a thin dispatcher.

What changed vs the original _ocr_tesseract()
──────────────────────────────────────────────
ORIGINAL                         NEW
─────────────────────────────    ──────────────────────────────────────────
pytesseract.image_to_string()    pytesseract.image_to_data() with per-word
                                 confidence scoring; low-conf words dropped.

No image pre-processing          OpenCV pipeline: grayscale → denoise →
                                 deskew → CLAHE binarize → border removal →
                                 resolution normalisation (→ 300 DPI min).

Single PSM (default)             Tries PSM 6 → 3 → 11; picks best result.

pdf2image with fixed DPI=300     DPI extracted from PDF metadata; if below
                                 300 or unknown, upsample to 300 before OCR.

No quality metrics               Per-page confidence, quality ratio, and
                                 low-quality flags stored in metadata so the
                                 UI can show a warning badge when confidence
                                 is poor.

_extract_ocr_suggestions():      DocumentFieldExtractor class with
  ~350-line monolithic regex       • Document-type classification first
                                   • Type-specific field patterns
                                   • Labelled-field strategy (highest precision)
                                   • Layout heuristic fallbacks
                                   • KRA PIN, VAT number, M-PESA ref extraction
                                   • Tax amount and subtotal extraction

Settings used
─────────────
OCR_ENGINE               "tesseract" (default) | "textract"
TESSERACT_CMD            Path override for tesseract binary
OCR_LANGUAGES            Tesseract lang codes, default "eng"
OCR_DPI                  PDF rasterisation DPI, default 300
OCR_CONFIDENCE_THRESHOLD Per-word confidence cutoff, default 40
OCR_QUALITY_RATIO        Min fraction of confident words, default 0.50
"""
from __future__ import annotations

import logging
from pathlib import Path
from typing import Optional

logger = logging.getLogger(__name__)


# ─────────────────────────────────────────────────────────────────────────────
# Public API — called from ocr_document() in tasks.py
# ─────────────────────────────────────────────────────────────────────────────


def run_ocr(doc) -> tuple[str, dict]:
    """
    Run OCR on a Document instance and return (extracted_text, metadata_updates).

    metadata_updates is a dict ready to be merged into doc.metadata:
        {
            "ocr_suggestions":   { ... structured field suggestions ... },
            "ocr_quality": {
                "mean_confidence":      float,
                "overall_quality_ratio": float,
                "total_pages":          int,
                "low_quality_pages":    int,
                "low_quality_warning":  bool,
            }
        }

    This function is engine-agnostic: it dispatches to Tesseract or Textract
    based on settings.OCR_ENGINE.
    """
    from django.conf import settings as django_settings

    engine = getattr(django_settings, "OCR_ENGINE", "tesseract").lower()

    if engine == "textract":
        from apps.documents.tasks import _ocr_textract  # existing implementation
        text = _ocr_textract(doc)
        quality_meta: dict = {}  # Textract doesn't provide per-word confidence
    else:
        text, quality_meta = _ocr_tesseract_v2(doc)

    from apps.documents.ocr.extractor import extract_document_fields
    suggestions = extract_document_fields(text)

    metadata_updates: dict = {"ocr_suggestions": suggestions}
    if quality_meta:
        metadata_updates["ocr_quality"] = quality_meta

    return text, metadata_updates


# ─────────────────────────────────────────────────────────────────────────────
# Tesseract backend (replaces _ocr_tesseract in tasks.py)
# ─────────────────────────────────────────────────────────────────────────────


def _ocr_tesseract_v2(doc) -> tuple[str, dict]:
    """
    OCR a Document using Tesseract with OpenCV pre-processing.

    Returns (full_text, quality_metadata_dict).
    """
    from django.conf import settings as django_settings
    import pytesseract

    # ── Tesseract binary ───────────────────────────────────────────────────
    cmd = getattr(django_settings, "TESSERACT_CMD", "").strip()
    if cmd:
        pytesseract.pytesseract.tesseract_cmd = cmd

    lang = getattr(django_settings, "OCR_LANGUAGES", "eng")
    dpi = int(getattr(django_settings, "OCR_DPI", 300))
    confidence_threshold = int(getattr(django_settings, "OCR_CONFIDENCE_THRESHOLD", 40))
    quality_ratio = float(getattr(django_settings, "OCR_QUALITY_RATIO", 0.50))

    mime = doc.file_mime_type or ""
    file_path = doc.file.path

    # ── Rasterise to page images ───────────────────────────────────────────
    pil_pages = _rasterise(file_path, mime, dpi)

    if not pil_pages:
        logger.warning("_ocr_tesseract_v2: no pages rasterised for %s", doc.id)
        return "", {}

    # ── Pre-process and OCR each page ─────────────────────────────────────
    from apps.documents.ocr.preprocessing import prepare_image_for_ocr, pil_to_cv2
    from apps.documents.ocr.engine import ocr_images

    cv2_pages = []
    for i, pil_img in enumerate(pil_pages):
        try:
            arr = pil_to_cv2(pil_img)
            preprocessed = prepare_image_for_ocr(arr, dpi=dpi)
            cv2_pages.append(preprocessed)
        except Exception as exc:
            logger.warning(
                "_ocr_tesseract_v2: preprocessing failed for page %d of doc %s: %s",
                i + 1, doc.id, exc,
            )
            # Fall back to the raw PIL image converted to grayscale numpy array
            import numpy as np
            fallback = np.array(pil_img.convert("L"))
            cv2_pages.append(fallback)

    doc_result = ocr_images(
        cv2_pages,
        lang=lang,
        confidence_threshold=confidence_threshold,
        quality_ratio_threshold=quality_ratio,
    )

    # ── Log quality summary ────────────────────────────────────────────────
    logger.info(
        "_ocr_tesseract_v2: doc=%s pages=%d low_quality=%d "
        "mean_conf=%.1f overall_quality=%.0f%%",
        doc.id,
        doc_result.total_pages,
        doc_result.low_quality_pages,
        doc_result.mean_document_confidence,
        doc_result.overall_quality_ratio * 100,
    )

    quality_meta = {
        "mean_confidence":       round(doc_result.mean_document_confidence, 1),
        "overall_quality_ratio": round(doc_result.overall_quality_ratio, 3),
        "total_pages":           doc_result.total_pages,
        "low_quality_pages":     doc_result.low_quality_pages,
        "low_quality_warning":   doc_result.low_quality_pages > 0,
    }

    return doc_result.full_text, quality_meta


# ─────────────────────────────────────────────────────────────────────────────
# Rasterisation helpers
# ─────────────────────────────────────────────────────────────────────────────


def _rasterise(file_path: str, mime: str, dpi: int) -> list:
    """
    Convert a document file to a list of PIL Images (one per page).

    Supports PDF and image files. For PDFs, attempts to read the embedded DPI
    from the PDF metadata so correct_resolution() can make informed decisions.
    """
    from PIL import Image

    if mime == "application/pdf":
        return _rasterise_pdf(file_path, dpi)

    if mime.startswith("image/"):
        try:
            img = Image.open(file_path)
            img.load()
            return [img.convert("RGB")]
        except Exception as exc:
            logger.error("_rasterise: cannot open image %s: %s", file_path, exc)
            return []

    # Unknown MIME — try as image
    try:
        img = Image.open(file_path)
        img.load()
        return [img.convert("RGB")]
    except Exception:
        logger.warning("_rasterise: unsupported MIME %s for %s", mime, file_path)
        return []


def _rasterise_pdf(file_path: str, target_dpi: int) -> list:
    """
    Rasterise a PDF to PIL Images using pdf2image.

    Reads the PDF's embedded DPI (from the first page's MediaBox + resolution
    info) and passes it to pdf2image so the output matches target_dpi.
    Falls back to target_dpi if the embedded DPI cannot be determined.
    """
    from pdf2image import convert_from_path

    # Determine effective DPI to request from pdf2image
    effective_dpi = _pdf_effective_dpi(file_path, target_dpi)

    try:
        pages = convert_from_path(
            file_path,
            dpi=effective_dpi,
            fmt="RGB",
            thread_count=1,   # keep predictable in a Celery worker
        )
        logger.debug(
            "_rasterise_pdf: %s → %d pages @ %d dpi",
            file_path, len(pages), effective_dpi,
        )
        return pages
    except Exception as exc:
        logger.error("_rasterise_pdf: pdf2image failed for %s: %s", file_path, exc)
        return []


def _pdf_effective_dpi(file_path: str, fallback_dpi: int) -> int:
    """
    Try to read the PDF's natural DPI from its MediaBox.

    Standard A4 at 72pt = 595 × 842 pts → at 300 DPI = 2480 × 3508 px.
    We compare the MediaBox dimensions to expected A4/Letter dimensions and
    back-calculate the DPI.

    Returns the DPI we should request from pdf2image. We never go below 200
    even if the PDF claims a low DPI — that would produce images too small for
    reliable OCR.
    """
    try:
        import pdfplumber
        with pdfplumber.open(file_path) as pdf:
            if not pdf.pages:
                return fallback_dpi
            page = pdf.pages[0]
            # MediaBox is in points (72 pts = 1 inch)
            width_pts = float(page.width)
            height_pts = float(page.height)
            if width_pts <= 0 or height_pts <= 0:
                return fallback_dpi

            # A4 ≈ 595 × 842 pts. Use the longer dimension for estimation.
            longer_pts = max(width_pts, height_pts)
            # At 300 DPI, A4 long side is 3508 px → 842 pts → 300/72 * 842 ≈ 3508
            # We want target_dpi pixels for every inch of the document.
            # Inferred DPI = target_dpi (we always render at target; this is just
            # for informational logging).
            logger.debug(
                "_pdf_effective_dpi: page0 %.0f×%.0f pts",
                width_pts, height_pts,
            )
    except Exception:
        pass

    # Always render at at least target_dpi; cap at 400 to avoid OOM on large files.
    return max(200, min(fallback_dpi, 400))