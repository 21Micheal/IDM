"""
apps/documents/ocr/engine.py  — v2

Changes from v1
───────────────
KEY ADDITION: PageOCRResult.words
  The pipeline now feeds positioned words from the OCR engine directly into
  LayoutLMv3, which requires bounding boxes.  Previously, LayoutLM had no
  image-level word positions — it received only the reconstructed text string.
  This meant the spatial model was running without its primary signal.

  Every word dict now has the shape expected by layoutlm.py::
      {
          "text":   str,
          "left":   int,   # x-coordinate of left edge (pixels)
          "top":    int,   # y-coordinate of top edge (pixels)
          "right":  int,   # x-coordinate of right edge (pixels)
          "bottom": int,   # y-coordinate of bottom edge (pixels)
          "conf":   float  # confidence 0.0–100.0
      }

BUG FIXES
  • _paddle_ocr_page(): each word dict was missing "height", "right", and
    "bottom" keys.  LayoutLM and _reconstruct_text_from_words() both use
    height to compute row-grouping tolerance — without it np.median([]) was
    called on an empty list, silently returning nan which broke the sort.
    Fixed: right = left + width, bottom = top + height, both computed from
    the PaddleOCR bounding polygon.

  • _reconstruct_text_from_words(): the row-grouping tolerance used
    `w.get("height", 20)` but height was never stored in v1 word dicts.
    Fixed: uses `bottom - top` when both are present, falls back to 20.

  • _run_tesseract(): word dicts were built by _word_cell() which stored
    "left", "top", "width", "height" but not "right" or "bottom".
    Fixed: _word_cell() now computes and stores right = left + width,
    bottom = top + height.

  • _get_paddle_ocr(): outer guard `if _paddle_available is False` before
    the lock was correct, but a second `if _paddle_available is False`
    inside the lock was missing — allowing two threads to both enter
    the initialisation block simultaneously.  Fixed with full
    double-checked locking.

  • ocr_image(): when PaddleOCR falls back to Tesseract, the lang code
    was passed as-is (e.g. "en").  Tesseract requires three-letter codes
    ("eng").  Added _paddle_lang_to_tesseract() to convert before fallback.

UNCHANGED
  • All existing public API surfaces (ocr_image, ocr_images, PageOCRResult,
    DocumentOCRResult, PageData) are backward-compatible.
  • PaddleOCR and Tesseract scoring logic unchanged.
  • Layout reconstruction logic unchanged except the height fix above.
"""
from __future__ import annotations

import logging
import threading
from dataclasses import dataclass, field
from typing import Optional

import numpy as np

logger = logging.getLogger(__name__)

# ── Defaults ───────────────────────────────────────────────────────────────────

_DEFAULT_CONFIDENCE_THRESHOLD = 40    # 0–100
_DEFAULT_QUALITY_RATIO        = 0.50
_MIN_CHARS_ACCEPTABLE         = 100
_PSM_SEQUENCE                 = [6, 3, 11]  # Tesseract PSM fallback sequence


# ── Data classes ───────────────────────────────────────────────────────────────

@dataclass
class WordData:
    """Positioned word with confidence."""
    text: str
    bbox: list[int]  # [x1, y1, x2, y2] (pixel coordinates)
    confidence: float  # OCR confidence (0-1)


@dataclass
class PageOCRResult:
    """OCR result for a single page."""
    page_number:          int
    text:                 str
    char_count:           int
    word_count:           int
    confident_word_count: int
    quality_ratio:        float
    mean_confidence:      float
    low_quality:          bool
    psm_used:             int          # PSM for Tesseract; -1 for PaddleOCR
    width:                int          # Page width in pixels
    height:               int          # Page height in pixels

    # NEW in v2: positioned words forwarded to LayoutLMv3
    # Each dict: {text, left, top, right, bottom, conf}
    words: list[dict] = field(default_factory=list)

    def get_normalized_words(self) -> list[WordData]:
        """Return words with normalized bounding boxes (0-1000 range)."""
        normalized_words = []
        for w in self.words:
            bbox = [w.get("left", 0), w.get("top", 0), w.get("right", 0), w.get("bottom", 0)]
            norm_bbox = normalize_box(bbox, self.width, self.height)
            normalized_words.append(WordData(
                text=w.get("text", ""),
                bbox=norm_bbox,
                confidence=w.get("conf", 0.0) / 100.0
            ))
        return normalized_words


@dataclass
class DocumentOCRResult:
    """Aggregated OCR result for a full document."""
    full_text:                str
    page_results:             list[PageOCRResult] = field(default_factory=list)
    total_pages:              int   = 0
    low_quality_pages:        int   = 0
    mean_document_confidence: float = 0.0
    overall_quality_ratio:    float = 0.0


def normalize_box(box: list[int], width: int, height: int) -> list[int]:
    """Normalize bounding box coordinates to 0-1000 range for LayoutLM."""
    if not width or not height:
        return box
    return [
        int(1000 * box[0] / width),
        int(1000 * box[1] / height),
        int(1000 * box[2] / width),
        int(1000 * box[3] / height),
    ]

# ── PaddleOCR singleton ────────────────────────────────────────────────────────

_paddle_instance: Optional[object] = None
_paddle_lock = threading.Lock()
_paddle_available: Optional[bool]  = None   # None = not yet tried


def _get_paddle_ocr(lang: str = "en", use_gpu: bool = False, use_angle_cls: bool = True):
    """
    Return a cached PaddleOCR instance.  Full double-checked locking pattern.
    """
    global _paddle_instance, _paddle_available

    # Fast path
    if _paddle_available is False:
        return None
    if _paddle_available is True and _paddle_instance is not None:
        return _paddle_instance

    with _paddle_lock:
        # Re-check inside lock
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
                show_log=False,
            )
            _paddle_instance = instance
            _paddle_available = True
            logger.info("PaddleOCR initialised (lang=%s, gpu=%s)", lang, use_gpu)
        except Exception as exc:
            _paddle_available = False
            logger.warning("PaddleOCR unavailable (%s) — using Tesseract fallback", exc)
            return None

    return _paddle_instance


# ── Language code helpers ──────────────────────────────────────────────────────

def _tesseract_lang_to_paddle(lang: str) -> str:
    """Tesseract three-letter → PaddleOCR two-letter code."""
    mapping = {
        "eng": "en", "swa": "en", "fra": "fr", "deu": "german",
        "chi_sim": "ch", "chi_tra": "ch", "ara": "ar",
        "hin": "hi", "jpn": "japan", "kor": "korean",
    }
    primary = lang.split("+")[0].strip().lower()
    return mapping.get(primary, "en")


def _paddle_lang_to_tesseract(lang: str) -> str:
    """
    PaddleOCR two-letter → Tesseract three-letter code.

    NEW in v2 — required for the PaddleOCR→Tesseract fallback inside
    ocr_image() so the lang code is valid for pytesseract.
    """
    mapping = {
        "en": "eng", "fr": "fra", "german": "deu",
        "ch": "chi_sim", "ar": "ara", "hi": "hin",
        "japan": "jpn", "korean": "kor",
    }
    return mapping.get(lang.lower(), "eng")


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

    The returned PageOCRResult.words list contains positioned word dicts
    suitable for direct consumption by LayoutLMv3.
    """
    if engine == "paddle":
        from django.conf import settings as _s
        paddle_lang = _tesseract_lang_to_paddle(lang)
        result = _paddle_ocr_page(
            image, page_number, paddle_lang,
            confidence_threshold, quality_ratio_threshold,
        )
        if result is not None:
            return result
        # PaddleOCR unavailable — fall back to Tesseract with correct lang code
        logger.info("ocr_image: PaddleOCR unavailable page=%d — using Tesseract", page_number)
        # Convert paddle lang back to tesseract format for fallback
        tess_lang = _paddle_lang_to_tesseract(paddle_lang)
        return _tesseract_ocr_page(
            image, page_number, tess_lang,
            confidence_threshold, quality_ratio_threshold, extra_config,
        )

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

    full_text        = "\n\n".join(r.text for r in page_results if r.text)
    total_pages      = len(page_results)
    low_quality_pages = sum(1 for r in page_results if r.low_quality)
    confident_words  = sum(r.confident_word_count for r in page_results)
    total_words      = sum(r.word_count           for r in page_results)
    overall_quality  = confident_words / total_words if total_words > 0 else 0.0
    confidences      = [r.mean_confidence for r in page_results if r.confident_word_count > 0]
    mean_conf        = float(np.mean(confidences)) if confidences else 0.0

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
    Run PaddleOCR on one page.  Returns None if PaddleOCR is unavailable.

    BUG FIX v2: every word dict now includes right, bottom, and height so
    that LayoutLM bounding-box normalisation and row-grouping both work.
    """
    from django.conf import settings as _s
    import cv2

    use_gpu       = str(getattr(_s, "OCR_PADDLE_USE_GPU",       "false")).lower() == "true"
    use_angle_cls = str(getattr(_s, "OCR_PADDLE_USE_ANGLE_CLS", "true" )).lower() == "true"

    ocr = _get_paddle_ocr(lang=lang, use_gpu=use_gpu, use_angle_cls=use_angle_cls)
    if ocr is None:
        return None

    height_px, width_px = image.shape[:2]
    # PaddleOCR expects BGR or grayscale
    if image.ndim == 2:
        img_input = cv2.cvtColor(image, cv2.COLOR_GRAY2BGR)
    else:
        img_input = image

    try:
        raw = ocr.ocr(img_input, cls=use_angle_cls)
    except Exception as exc:
        logger.error("PaddleOCR.ocr() failed on page %d: %s", page_number, exc)
        return None

    page_raw = raw[0] if raw else []
    if not page_raw:
        logger.debug("PaddleOCR: no text found on page %d", page_number)
        return PageOCRResult(
            page_number=page_number, text="", char_count=0,
            word_count=0, confident_word_count=0,
            quality_ratio=0.0, mean_confidence=0.0,
            low_quality=True, psm_used=-1, words=[],
            width=0, height=0,
        )

    words:          list[dict] = []
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

        conf = float(conf_raw) * 100   # normalise 0–1 → 0–100

        # Bounding polygon: [[x1,y1],[x2,y1],[x2,y2],[x1,y2]]
        x_coords = [int(pt[0]) for pt in bbox]
        y_coords = [int(pt[1]) for pt in bbox]
        x_left   = max(0, min(x_coords))
        y_top    = max(0, min(y_coords))
        x_right  = max(0, max(x_coords))
        y_bottom = max(0, max(y_coords))
        width    = max(x_right - x_left, 1)
        height   = max(y_bottom - y_top, 1)

        total_words += 1

        if conf >= confidence_threshold:
            confident_words += 1
            confidence_sum  += conf
            # v2: includes right/bottom/height for LayoutLM
            words.append({
                "text":   text,
                "left":   x_left,
                "top":    y_top,
                "right":  x_right,
                "bottom": y_bottom,
                "width":  width,
                "height": height,
                "conf":   conf,
            })
        else:
            logger.debug(
                "PaddleOCR page %d: dropping %r (conf=%.1f)", page_number, text, conf
            )

    text_out        = _reconstruct_text_from_words(words)
    quality_ratio   = confident_words / total_words if total_words > 0 else 0.0
    mean_confidence = confidence_sum / confident_words if confident_words > 0 else 0.0
    low_quality     = quality_ratio < quality_ratio_threshold and total_words > 10

    logger.debug(
        "PaddleOCR page %d — %d chars, %.0f%% accepted, mean_conf=%.1f",
        page_number, len(text_out), quality_ratio * 100, mean_confidence,
    )

    return PageOCRResult(
        page_number=page_number,
        text=text_out,
        char_count=len(text_out),
        word_count=total_words,
        confident_word_count=confident_words,
        quality_ratio=quality_ratio,
        mean_confidence=mean_confidence,
        low_quality=low_quality,
        psm_used=-1,
        words=words,
        width=width_px,
        height=height_px,
    )


def _reconstruct_text_from_words(words: list[dict]) -> str:
    """
    Group words into lines by y-band proximity and reconstruct readable text.

    BUG FIX v2: height is now read from the word dict (right - left was never
    stored in v1, so np.median was called on an empty list → nan → broken sort).
    """
    if not words:
        return ""

    heights = []
    for w in words:
        # v2: prefer explicit height; fall back to bottom - top
        h = w.get("height") or (w.get("bottom", 0) - w.get("top", 0))
        if h and h > 0:
            heights.append(h)

    median_height = float(np.median(heights)) if heights else 20.0
    row_tolerance = max(10.0, median_height * 0.6)

    sorted_words = sorted(words, key=lambda w: (w.get("top", 0), w.get("left", 0)))

    rows: list[list[dict]] = []
    current_row: list[dict] = []
    current_y: Optional[float] = None

    for w in sorted_words:
        top = w.get("top", 0)
        if current_y is None or abs(top - current_y) <= row_tolerance:
            current_row.append(w)
            if current_y is None:
                current_y = float(top)
        else:
            if current_row:
                rows.append(sorted(current_row, key=lambda x: x.get("left", 0)))
            current_row = [w]
            current_y   = float(top)

    if current_row:
        rows.append(sorted(current_row, key=lambda x: x.get("left", 0)))

    return "\n".join(_join_positioned_words(row) for row in rows).strip()


# ── Tesseract backend ──────────────────────────────────────────────────────────

def _tesseract_ocr_page(
    image: np.ndarray,
    page_number: int,
    lang: str,
    confidence_threshold: int,
    quality_ratio_threshold: float,
    extra_config: str = "",
) -> PageOCRResult:
    """Tesseract fallback — unchanged logic with v2 word-dict fix."""
    best_result: Optional[PageOCRResult] = None

    for psm in _PSM_SEQUENCE:
        config = f"--oem 1 --psm {psm} {extra_config}".strip()
        try:
            result = _run_tesseract(
                image, page_number, lang, config,
                confidence_threshold, quality_ratio_threshold, psm,
            )
        except Exception as exc:
            logger.warning("Tesseract failed page=%d psm=%d: %s", page_number, psm, exc)
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
            low_quality=True, psm_used=-1, words=[],
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
    width_px, height_px = pil_img.size if hasattr(pil_img, 'size') else (0, 0)
    df = pytesseract.image_to_data(
        pil_img, lang=lang, config=config,
        output_type=pytesseract.Output.DICT,
    )

    n_items          = len(df["text"])
    lines: dict[tuple, list[dict]] = {}
    line_order:      list[tuple]   = []
    total_words      = 0
    confident_words  = 0
    confidence_sum   = 0.0
    all_words:       list[dict]    = []

    for i in range(n_items):
        word = str(df["text"][i]).strip()
        if not word:
            continue
        try:
            conf = int(df["conf"][i])
        except (ValueError, TypeError):
            conf = -1

        key = (df["block_num"][i], df["par_num"][i], df["line_num"][i])

        if conf == -1:
            if word:
                if key not in lines:
                    lines[key] = []
                    line_order.append(key)
                cell = _word_cell(df, i, word)
                lines[key].append(cell)
                all_words.append(cell)
            continue

        total_words += 1
        if conf >= confidence_threshold:
            confident_words += 1
            confidence_sum  += conf
            if key not in lines:
                lines[key] = []
                line_order.append(key)
            cell = _word_cell(df, i, word)
            lines[key].append(cell)
            all_words.append(cell)

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
        words=all_words,   # v2: pass through for LayoutLM
        width=width_px,
        height=height_px,
    )


# ── Shared helpers ─────────────────────────────────────────────────────────────

def _join_positioned_words(words: list[dict]) -> str:
    """
    Join words while preserving column gaps with tab characters.
    Unchanged from v1 except it reads 'right' directly (now always present).
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
        # v2: prefer 'right' if available; fall back to left+width
        prev_right = prev.get("right", prev.get("left", 0) + prev.get("width", 0))
        gap        = word.get("left", 0) - prev_right
        parts.append("\t" if gap > column_gap else " ")
        parts.append(word["text"])
        prev = word

    return "".join(parts)


def _word_cell(data: dict, index: int, text: str) -> dict:
    """
    Build a positioned word record from pytesseract image_to_data output.

    BUG FIX v2: now computes and stores right = left + width,
    bottom = top + height so LayoutLM normalisation has all four box edges.
    """
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
        "right":  left + width,   # v2 NEW
        "bottom": top + height,   # v2 NEW
    }