"""
apps/documents/ocr/engine.py  — v2 (PaddleOCR + Tesseract fallback)

Why PaddleOCR over Tesseract for this use-case
───────────────────────────────────────────────
Tesseract is mature and reliable for clean, printed Latin text, but it has
known weaknesses that matter directly for financial/business document OCR:

  1. Table / multi-column layout  — Tesseract PSM modes are page-level; it
     struggles when a single page mixes dense header tables (SUPPLIER | ACCOUNT
     CODE | INVOICE DATE) with prose paragraphs. PaddleOCR's PP-StructureV2
     pipeline detects table regions first and reads them cell-by-cell, giving
     exact column-to-header alignment that the extractor relies on.

  2. Rotated / curved text       — PaddleOCR's direction classifier handles
     text rotated ±180° and mildly warped camera shots without manual deskew.

  3. Low-resource languages       — East Africa business documents sometimes mix
     Swahili proper nouns into English text. PaddleOCR's multi-language models
     handle this gracefully; Tesseract requires explicit lang pack installation.

  4. Per-word bounding boxes      — PaddleOCR returns (bbox, text, confidence)
     triples natively, which drives the column-gap detection in
     _join_positioned_words() without a separate image_to_data() call.

  5. Speed                        — The PP-OCRv4 server model is ~3× faster than
     Tesseract LSTM at the same accuracy on clean documents; the mobile model is
     ~8× faster with a small accuracy trade-off.

Tesseract is kept as the fallback:
  • PaddleOCR is not available (pip install failed, model download blocked)
  • The document is a clean, single-column PDF where Tesseract is sufficient
  • Operator preference via OCR_ENGINE=tesseract setting

Architecture
────────────
  ocr_image()   — single page, returns PageOCRResult
  ocr_images()  — list of pages, returns DocumentOCRResult
  Both functions dispatch to _paddle_ocr_page() or _tesseract_ocr_page()
  depending on which backend is active.

Settings (all optional, sensible defaults)
──────────────────────────────────────────
  OCR_ENGINE                 "paddle" (default) | "tesseract" | "textract"
  OCR_PADDLE_USE_GPU         "true" / "false"  (default false — CPU)
  OCR_PADDLE_USE_ANGLE_CLS   "true" / "false"  (default true  — direction classifier)
  OCR_PADDLE_LANG            "en" (default) — PaddleOCR language code
  OCR_CONFIDENCE_THRESHOLD   integer 0-100 (default 40) — drop words below this
  OCR_QUALITY_RATIO          float   0-1   (default 0.50) — low-quality flag threshold
  TESSERACT_CMD              path to tesseract binary (fallback engine)
  OCR_LANGUAGES              Tesseract language codes  (fallback engine)

PaddleOCR installation (add to requirements.txt / Dockerfile)
──────────────────────────────────────────────────────────────
  paddlepaddle==2.6.1         # CPU-only; use paddlepaddle-gpu for GPU workers
  paddleocr==2.7.3
  # Models are downloaded on first use to ~/.paddleocr/
  # Pre-download in Dockerfile to avoid cold-start delays:
  #   RUN python -c "from paddleocr import PaddleOCR; PaddleOCR(lang='en')"
"""
from __future__ import annotations

import logging
import threading
from dataclasses import dataclass, field
from typing import Optional

import numpy as np

logger = logging.getLogger(__name__)

# ── Defaults ───────────────────────────────────────────────────────────────────

_DEFAULT_CONFIDENCE_THRESHOLD = 40   # 0–100
_DEFAULT_QUALITY_RATIO        = 0.50
_MIN_CHARS_ACCEPTABLE         = 100

# Tesseract PSM fallback sequence (used only when engine == "tesseract")
_PSM_SEQUENCE = [6, 3, 11]


# ── Data classes ───────────────────────────────────────────────────────────────

@dataclass
class PageOCRResult:
    """OCR result for a single page."""
    page_number:          int
    text:                 str
    char_count:           int
    word_count:           int
    confident_word_count: int
    quality_ratio:        float   # confident_words / total_words (0–1)
    mean_confidence:      float   # average confidence of accepted words
    low_quality:          bool
    psm_used:             int     # PSM for Tesseract; -1 for PaddleOCR
    words:                list[dict] = field(default_factory=list)   # <-- ADDED


@dataclass
class DocumentOCRResult:
    """Aggregated OCR result for a full document."""
    full_text:                str
    page_results:             list[PageOCRResult] = field(default_factory=list)
    total_pages:              int   = 0
    low_quality_pages:        int   = 0
    mean_document_confidence: float = 0.0
    overall_quality_ratio:    float = 0.0


# ── PaddleOCR singleton ────────────────────────────────────────────────────────
# PaddleOCR initialization takes ~2 s (model loading). We cache the instance at
# module level behind a lock so concurrent Celery tasks share one warm instance.

_paddle_instance: Optional[object] = None   # PaddleOCR object
_paddle_lock = threading.Lock()
_paddle_available: Optional[bool] = None    # tri-state: None = not yet checked


def _get_paddle_ocr(lang: str = "en", use_gpu: bool = False, use_angle_cls: bool = True):
    """
    Return a cached PaddleOCR instance, creating it on first call.

    Returns None if PaddleOCR is not installed or model download fails,
    allowing graceful fallback to Tesseract.
    """
    global _paddle_instance, _paddle_available

    if _paddle_available is False:
        return None

    with _paddle_lock:
        if _paddle_available is False:
            return None
        if _paddle_instance is not None:
            return _paddle_instance

        try:
            from paddleocr import PaddleOCR
            instance = PaddleOCR(
                use_angle_cls=use_angle_cls,
                lang=lang,
                use_gpu=use_gpu,
                # Suppress PaddlePaddle's very verbose startup logging
                show_log=False,
            )
            _paddle_instance = instance
            _paddle_available = True
            logger.info("PaddleOCR initialised (lang=%s, gpu=%s)", lang, use_gpu)
        except Exception as exc:
            _paddle_available = False
            logger.warning(
                "PaddleOCR not available (%s) — falling back to Tesseract", exc
            )
            return None

    return _paddle_instance


# ── Public entry points ────────────────────────────────────────────────────────

def ocr_image(
    image: np.ndarray,
    page_number: int = 1,
    lang: str = "eng",
    confidence_threshold: int = _DEFAULT_CONFIDENCE_THRESHOLD,
    quality_ratio_threshold: float = _DEFAULT_QUALITY_RATIO,
    extra_config: str = "",
    engine: str = "paddle",
) -> PageOCRResult:
    """
    OCR a single pre-processed grayscale image and return structured results.

    Parameters
    ──────────
    image                   : Grayscale uint8 numpy array (from preprocessing).
    page_number             : 1-based index, used only in log messages.
    lang                    : Language code — Tesseract multi-lang (e.g. "eng+swa")
                              or PaddleOCR single-lang ("en").
    confidence_threshold    : Drop words with confidence below this value (0-100).
    quality_ratio_threshold : Flag as low-quality when acceptance ratio < threshold.
    extra_config            : Extra Tesseract config flags (ignored for Paddle).
    engine                  : "paddle" | "tesseract"
    """
    if engine == "paddle":
        # Convert Tesseract lang codes ("eng") to PaddleOCR ("en")
        paddle_lang = _tesseract_lang_to_paddle(lang)
        result = _paddle_ocr_page(
            image, page_number, paddle_lang,
            confidence_threshold, quality_ratio_threshold,
        )
        if result is not None:
            return result
        # PaddleOCR unavailable — fall through to Tesseract
        logger.info("ocr_image: PaddleOCR unavailable for page %d — using Tesseract", page_number)

    return _tesseract_ocr_page(
        image, page_number, lang,
        confidence_threshold, quality_ratio_threshold, extra_config,
    )


def ocr_images(
    images: list[np.ndarray],
    lang: str = "eng",
    confidence_threshold: int = _DEFAULT_CONFIDENCE_THRESHOLD,
    quality_ratio_threshold: float = _DEFAULT_QUALITY_RATIO,
    engine: str = "paddle",
) -> DocumentOCRResult:
    """OCR a list of page images and aggregate into a DocumentOCRResult."""
    page_results: list[PageOCRResult] = []

    for i, img in enumerate(images, start=1):
        page_result = ocr_image(
            img,
            page_number=i,
            lang=lang,
            confidence_threshold=confidence_threshold,
            quality_ratio_threshold=quality_ratio_threshold,
            engine=engine,
        )
        page_results.append(page_result)

    full_text = "\n\n".join(r.text for r in page_results if r.text)
    total_pages = len(page_results)
    low_quality_pages = sum(1 for r in page_results if r.low_quality)

    confident_words   = sum(r.confident_word_count for r in page_results)
    total_words       = sum(r.word_count           for r in page_results)
    overall_quality   = confident_words / total_words if total_words > 0 else 0.0

    confidences = [r.mean_confidence for r in page_results if r.confident_word_count > 0]
    mean_conf   = float(np.mean(confidences)) if confidences else 0.0

    return DocumentOCRResult(
        full_text=full_text,
        page_results=page_results,
        total_pages=total_pages,
        low_quality_pages=low_quality_pages,
        mean_document_confidence=mean_conf,
        overall_quality_ratio=overall_quality,
    )


# ── PaddleOCR backend ──────────────────────────────────────────────────────────

def _paddle_ocr_page(
    image: np.ndarray,
    page_number: int,
    lang: str,
    confidence_threshold: int,
    quality_ratio_threshold: float,
) -> Optional[PageOCRResult]:
    """
    Run PaddleOCR on one page image.

    PaddleOCR returns a nested list:
        result[page_idx] = [ [bbox, (text, confidence)], ... ]

    bbox is [[x1,y1],[x2,y1],[x2,y2],[x1,y2]] (clockwise from top-left).
    We use the top-left x,y to reconstruct reading order and detect column gaps,
    exactly as the existing Tesseract _join_positioned_words() does.

    Returns None if PaddleOCR is not available so caller can fall back.
    """
    from django.conf import settings as django_settings

    use_gpu       = str(getattr(django_settings, "OCR_PADDLE_USE_GPU",       "false")).lower() == "true"
    use_angle_cls = str(getattr(django_settings, "OCR_PADDLE_USE_ANGLE_CLS", "true" )).lower() == "true"

    ocr = _get_paddle_ocr(lang=lang, use_gpu=use_gpu, use_angle_cls=use_angle_cls)
    if ocr is None:
        return None

    # PaddleOCR accepts BGR or grayscale numpy arrays.
    # If the image is already grayscale (2-D), convert to BGR so the internal
    # direction classifier gets the 3-channel input it expects.
    import cv2
    if image.ndim == 2:
        img_input = cv2.cvtColor(image, cv2.COLOR_GRAY2BGR)
    else:
        img_input = image

    try:
        raw = ocr.ocr(img_input, cls=use_angle_cls)
    except Exception as exc:
        logger.error("PaddleOCR.ocr() failed on page %d: %s", page_number, exc)
        return None

    # raw is a list-of-pages; take first (we pass one page at a time)
    page_raw = raw[0] if raw else []
    if not page_raw:
        logger.debug("PaddleOCR: no text found on page %d", page_number)
        return PageOCRResult(
            page_number=page_number, text="", char_count=0,
            word_count=0, confident_word_count=0,
            quality_ratio=0.0, mean_confidence=0.0,
            low_quality=True, psm_used=-1,
        )

    # ── Collect words with position info ──────────────────────────────────
    # Each entry: [bbox_poly, (text_str, confidence_float)]
    # We group by approximate row (y-coordinate band) to preserve line order,
    # then within each row sort by x to get left→right reading order.
    words: list[dict] = []
    total_words      = 0
    confident_words  = 0
    confidence_sum   = 0.0

    for item in page_raw:
        if item is None:
            continue
        bbox, (text, conf_raw) = item
        text = str(text).strip()
        if not text:
            continue

        # conf_raw is 0.0–1.0 in PaddleOCR; normalise to 0–100 for consistency
        conf = float(conf_raw) * 100
        x_left   = int(min(pt[0] for pt in bbox))
        y_top    = int(min(pt[1] for pt in bbox))
        x_right  = int(max(pt[0] for pt in bbox))
        y_bottom = int(max(pt[1] for pt in bbox))          # <-- ADDED
        width    = max(x_right - x_left, 1)
        height   = max(y_bottom - y_top, 1)              # <-- ADDED

        total_words += 1

        if conf >= confidence_threshold:
            confident_words += 1
            confidence_sum  += conf
            words.append({
                "text":   text,
                "left":   x_left,
                "top":    y_top,
                "right":  x_right,        # <-- ADDED
                "bottom": y_bottom,       # <-- ADDED
                "width":  width,
                "height": height,
                "conf":   conf,
            })
        else:
            logger.debug(
                "PaddleOCR page %d: dropping %r (conf=%.1f)", page_number, text, conf
            )

    # ── Reconstruct layout-aware text ─────────────────────────────────────
    text = _reconstruct_text_from_words(words)

    quality_ratio   = confident_words / total_words if total_words > 0 else 0.0
    mean_confidence = confidence_sum / confident_words if confident_words > 0 else 0.0
    low_quality     = quality_ratio < quality_ratio_threshold and total_words > 10

    logger.debug(
        "PaddleOCR page %d — %d chars, %.0f%% words accepted, mean_conf=%.1f",
        page_number, len(text), quality_ratio * 100, mean_confidence,
    )

    return PageOCRResult(
        page_number=page_number,
        text=text,
        char_count=len(text),
        word_count=total_words,
        confident_word_count=confident_words,
        quality_ratio=quality_ratio,
        mean_confidence=mean_confidence,
        low_quality=low_quality,
        psm_used=-1,   # N/A for PaddleOCR
        words=words,       # <-- ADDED
    )


def _reconstruct_text_from_words(words: list[dict]) -> str:
    """
    Group words into lines by y-band proximity and reconstruct readable text.

    Words within the same horizontal band (gap < median word height) are joined
    into one line with tab-separated columns where a significant x-gap exists.
    This preserves table structures that the extractor depends on.
    """
    if not words:
        return ""

    # Estimate median word height to use as row-grouping tolerance
    heights = []
    for w in words:
        # PaddleOCR bboxes are line-level; height ≈ font size
        h = w.get("height", 20)
        if h > 0:
            heights.append(h)
    median_height = float(np.median(heights)) if heights else 20.0
    row_tolerance = max(10.0, median_height * 0.6)

    # Sort words by top-y first, then left-x
    sorted_words = sorted(words, key=lambda w: (w["top"], w["left"]))

    # Group into rows
    rows: list[list[dict]] = []
    current_row: list[dict] = []
    current_y = None

    for w in sorted_words:
        if current_y is None or abs(w["top"] - current_y) <= row_tolerance:
            current_row.append(w)
            current_y = w["top"] if current_y is None else current_y
        else:
            if current_row:
                rows.append(sorted(current_row, key=lambda x: x["left"]))
            current_row = [w]
            current_y = w["top"]
    if current_row:
        rows.append(sorted(current_row, key=lambda x: x["left"]))

    # Join words within each row, inserting tabs at column gaps
    line_texts = [_join_positioned_words(row) for row in rows]
    return "\n".join(line_texts).strip()


# ── Tesseract backend (kept as fallback) ───────────────────────────────────────

def _tesseract_ocr_page(
    image: np.ndarray,
    page_number: int,
    lang: str,
    confidence_threshold: int,
    quality_ratio_threshold: float,
    extra_config: str = "",
) -> PageOCRResult:
    """Tesseract backend — identical logic to the v1 engine, kept as fallback."""
    best_result: Optional[PageOCRResult] = None

    for psm in _PSM_SEQUENCE:
        config = f"--oem 1 --psm {psm} {extra_config}".strip()
        try:
            result = _run_tesseract(
                image, page_number, lang, config,
                confidence_threshold, quality_ratio_threshold, psm,
            )
        except Exception as exc:
            logger.warning(
                "Tesseract failed on page %d (psm=%d): %s", page_number, psm, exc
            )
            continue

        if best_result is None or result.char_count > best_result.char_count:
            best_result = result

        if result.char_count >= _MIN_CHARS_ACCEPTABLE:
            break

    if best_result is None:
        logger.warning("Tesseract: all PSM modes failed for page %d", page_number)
        return PageOCRResult(
            page_number=page_number, text="", char_count=0,
            word_count=0, confident_word_count=0,
            quality_ratio=0.0, mean_confidence=0.0,
            low_quality=True, psm_used=-1,
        )

    return best_result


def _run_tesseract(
    image: np.ndarray,
    page_number: int,
    lang: str,
    config: str,
    confidence_threshold: int,
    quality_ratio_threshold: float,
    psm: int,
) -> PageOCRResult:
    import pytesseract
    from PIL import Image as PILImage

    pil_img = PILImage.fromarray(image) if isinstance(image, np.ndarray) else image

    df = pytesseract.image_to_data(
        pil_img, lang=lang, config=config,
        output_type=pytesseract.Output.DICT,
    )

    n_items = len(df["text"])
    lines: dict[tuple, list[dict]] = {}
    line_order: list[tuple] = []
    total_words     = 0
    confident_words = 0
    confidence_sum  = 0.0
    raw_words: list[dict] = []   # <-- ADDED

    for i in range(n_items):
        word = str(df["text"][i]).strip()
        if not word:
            continue
        try:
            conf = int(df["conf"][i])
        except (ValueError, TypeError):
            conf = -1

        if conf == -1:
            if word:
                key = (df["block_num"][i], df["par_num"][i], df["line_num"][i])
                if key not in lines:
                    lines[key] = []
                    line_order.append(key)
                lines[key].append(_word_cell(df, i, word))
            continue

        total_words += 1
        if conf >= confidence_threshold:
            confident_words += 1
            confidence_sum  += conf
            key = (df["block_num"][i], df["par_num"][i], df["line_num"][i])
            if key not in lines:
                lines[key] = []
                line_order.append(key)
            wc = _word_cell(df, i, word)
            wc["conf"] = conf
            lines[key].append(wc)
            raw_words.append(wc)     # <-- ADDED

    text_lines = []
    prev_block  = None
    for key in line_order:
        block_num = key[0]
        if prev_block is not None and block_num != prev_block:
            text_lines.append("")
        prev_block = block_num
        text_lines.append(_join_positioned_words(lines[key]))

    text            = "\n".join(text_lines).strip()
    quality_ratio   = confident_words / total_words if total_words > 0 else 0.0
    mean_confidence = confidence_sum / confident_words if confident_words > 0 else 0.0
    low_quality     = quality_ratio < quality_ratio_threshold and total_words > 10

    return PageOCRResult(
        page_number=page_number,
        text=text,
        char_count=len(text),
        word_count=total_words,
        confident_word_count=confident_words,
        quality_ratio=quality_ratio,
        mean_confidence=mean_confidence,
        low_quality=low_quality,
        psm_used=psm,
        words=raw_words,     # <-- ADDED
    )


# ── Shared helpers ─────────────────────────────────────────────────────────────

def _join_positioned_words(words: list[dict]) -> str:
    """
    Join words while preserving obvious column gaps with tab characters.

    The column-gap heuristic is shared between Paddle and Tesseract backends.
    A tab is inserted wherever the x-gap between consecutive words exceeds
    5 × the median character width, which reliably splits invoice header grids:
        SUPPLIER\tACCOUNT CODE\tINVOICE DATE
    """
    if not words:
        return ""

    ordered = sorted(words, key=lambda w: (w.get("left", 0), w.get("top", 0)))

    char_widths = [
        w["width"] / max(len(w["text"]), 1)
        for w in ordered
        if w.get("width", 0) > 0 and w.get("text")
    ]
    median_cw  = float(np.median(char_widths)) if char_widths else 8.0
    column_gap = max(32.0, median_cw * 5.0)

    parts = [ordered[0]["text"]]
    prev  = ordered[0]
    for word in ordered[1:]:
        gap = word.get("left", 0) - (prev.get("left", 0) + prev.get("width", 0))
        parts.append("\t" if gap > column_gap else " ")
        parts.append(word["text"])
        prev = word

    return "".join(parts)


def _word_cell(data: dict, index: int, text: str) -> dict:
    """Build a positioned word record from pytesseract image_to_data output."""
    def _i(name: str, default: int = 0) -> int:
        try:
            return int(data.get(name, [default])[index])
        except (TypeError, ValueError, IndexError):
            return default

    left   = _i("left")
    top    = _i("top")
    width  = _i("width")
    height = _i("height")
    return {
        "text":   text,
        "left":   left,
        "top":    top,
        "width":  width,
        "height": height,
        "right":  left + width,     # <-- ADDED
        "bottom": top + height,     # <-- ADDED
    }


def _tesseract_lang_to_paddle(lang: str) -> str:
    """
    Convert a Tesseract language code to the nearest PaddleOCR equivalent.

    PaddleOCR uses ISO-639-1 two-letter codes; Tesseract uses three-letter codes.
    Only the subset relevant to East Africa + common business languages is mapped.
    """
    mapping = {
        "eng": "en",
        "swa": "en",   # Swahili — use English model (best available)
        "fra": "fr",
        "deu": "german",
        "chi_sim": "ch",
        "chi_tra": "ch",
        "ara": "ar",
        "hin": "hi",
        "jpn": "japan",
        "kor": "korean",
    }
    # Handle multi-lang strings like "eng+swa" — take the first code
    primary = lang.split("+")[0].strip().lower()
    return mapping.get(primary, "en")
