"""
apps/documents/ocr/engine.py

Tesseract OCR engine wrapper with per-word confidence scoring.

Key improvements over the original _ocr_tesseract()
────────────────────────────────────────────────────
1. Uses image_to_data() (hOCR-like output) instead of image_to_string(),
   which gives per-word confidence scores (0-100).

2. Words below a confidence threshold are dropped rather than kept as noise.
   The threshold is configurable via settings.OCR_CONFIDENCE_THRESHOLD (default 40).

3. Layout-aware text reconstruction: words are grouped by block and line
   (Tesseract's block_num / line_num / word_num columns), so the output
   preserves the reading order of the original document.

4. Per-page quality metrics are returned alongside the text so the caller
   can decide whether to store or discard the result.

5. OEM 1 (LSTM neural net) + PSM 6 (uniform block of text) are the defaults.
   PSM 6 is best for business documents — single-column or multi-column with
   consistent alignment. PSM 3 (fully automatic) is used as a fallback if
   PSM 6 yields very little text.

Tesseract configuration reference
──────────────────────────────────
--oem 0  Legacy engine
--oem 1  LSTM (neural) — best accuracy, default in Tesseract 4+
--oem 3  Both, use best available

--psm 3  Fully automatic page segmentation (no OSD)
--psm 6  Assume uniform block of text (good for business documents)
--psm 11 Sparse text — finds text anywhere (useful for forms/tables)
--psm 12 Sparse text with OSD
"""
from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import Optional

import numpy as np

logger = logging.getLogger(__name__)

# ── Configuration ──────────────────────────────────────────────────────────────

# Words with Tesseract confidence below this value are dropped.
_DEFAULT_CONFIDENCE_THRESHOLD = 40  # 0–100; Tesseract uses -1 for non-word cells

# Minimum fraction of words that must clear the threshold for a page to be
# considered "good quality". Pages below this are flagged as low-quality
# in the returned metrics but the text is still stored.
_DEFAULT_QUALITY_RATIO = 0.50

# PSM configs to attempt, in order, until sufficient text is found.
_PSM_SEQUENCE = [6, 3, 11]

# Minimum character count to accept a PSM result without trying the next.
_MIN_CHARS_ACCEPTABLE = 100


# ── Data classes ───────────────────────────────────────────────────────────────


@dataclass
class PageOCRResult:
    """OCR result for a single page."""

    page_number: int
    text: str
    char_count: int
    word_count: int
    confident_word_count: int
    quality_ratio: float          # confident_words / total_words (0–1)
    mean_confidence: float        # average confidence of confident words
    low_quality: bool             # True when quality_ratio < threshold
    psm_used: int                 # page segmentation mode that produced this result


@dataclass
class DocumentOCRResult:
    """Aggregated OCR result for a full document."""

    full_text: str
    page_results: list[PageOCRResult] = field(default_factory=list)
    total_pages: int = 0
    low_quality_pages: int = 0
    mean_document_confidence: float = 0.0
    overall_quality_ratio: float = 0.0


# ── Public entry point ─────────────────────────────────────────────────────────


def ocr_image(
    image: np.ndarray,
    page_number: int = 1,
    lang: str = "eng",
    confidence_threshold: int = _DEFAULT_CONFIDENCE_THRESHOLD,
    quality_ratio_threshold: float = _DEFAULT_QUALITY_RATIO,
    extra_config: str = "",
) -> PageOCRResult:
    """
    Run Tesseract on a pre-processed grayscale image and return structured results.

    Parameters
    ──────────
    image                   : Grayscale uint8 numpy array (output of preprocessing).
    page_number             : 1-based page index, used in logging.
    lang                    : Tesseract language code(s), e.g. "eng" or "eng+swa".
    confidence_threshold    : Drop words with confidence below this value.
    quality_ratio_threshold : Flag page as low-quality below this word-acceptance ratio.
    extra_config            : Additional Tesseract config flags.

    Returns a PageOCRResult with the cleaned text and quality metrics.
    """
    import pytesseract

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
                "ocr_image: Tesseract failed on page %d (psm=%d): %s",
                page_number, psm, exc,
            )
            continue

        if best_result is None or result.char_count > best_result.char_count:
            best_result = result

        if result.char_count >= _MIN_CHARS_ACCEPTABLE:
            break  # good enough, no need to try the next PSM

    if best_result is None:
        logger.warning("ocr_image: all PSM modes failed for page %d", page_number)
        return PageOCRResult(
            page_number=page_number,
            text="",
            char_count=0,
            word_count=0,
            confident_word_count=0,
            quality_ratio=0.0,
            mean_confidence=0.0,
            low_quality=True,
            psm_used=-1,
        )

    logger.debug(
        "ocr_image: page %d — %d chars, %.0f%% words confident, mean_conf=%.1f, psm=%d",
        page_number,
        best_result.char_count,
        best_result.quality_ratio * 100,
        best_result.mean_confidence,
        best_result.psm_used,
    )
    return best_result


def ocr_images(
    images: list[np.ndarray],
    lang: str = "eng",
    confidence_threshold: int = _DEFAULT_CONFIDENCE_THRESHOLD,
    quality_ratio_threshold: float = _DEFAULT_QUALITY_RATIO,
) -> DocumentOCRResult:
    """
    OCR a list of page images and aggregate into a DocumentOCRResult.
    """
    page_results: list[PageOCRResult] = []

    for i, img in enumerate(images, start=1):
        page_result = ocr_image(
            img,
            page_number=i,
            lang=lang,
            confidence_threshold=confidence_threshold,
            quality_ratio_threshold=quality_ratio_threshold,
        )
        page_results.append(page_result)

    full_text = "\n\n".join(r.text for r in page_results if r.text)
    total_pages = len(page_results)
    low_quality_pages = sum(1 for r in page_results if r.low_quality)

    confident_words = sum(r.confident_word_count for r in page_results)
    total_words = sum(r.word_count for r in page_results)
    overall_quality_ratio = confident_words / total_words if total_words > 0 else 0.0

    confidences = [r.mean_confidence for r in page_results if r.confident_word_count > 0]
    mean_doc_confidence = float(np.mean(confidences)) if confidences else 0.0

    return DocumentOCRResult(
        full_text=full_text,
        page_results=page_results,
        total_pages=total_pages,
        low_quality_pages=low_quality_pages,
        mean_document_confidence=mean_doc_confidence,
        overall_quality_ratio=overall_quality_ratio,
    )


# ── Internal helpers ───────────────────────────────────────────────────────────


def _run_tesseract(
    image: np.ndarray,
    page_number: int,
    lang: str,
    config: str,
    confidence_threshold: int,
    quality_ratio_threshold: float,
    psm: int,
) -> PageOCRResult:
    """
    Call pytesseract.image_to_data() and reconstruct layout-aware text.

    image_to_data() returns a TSV-like structure with columns:
        level, page_num, block_num, par_num, line_num, word_num,
        left, top, width, height, conf, text

    We group by (block_num, par_num, line_num) and join words within each
    line with a space, then join lines with newlines. This preserves the
    visual reading order better than the flat string from image_to_string().
    """
    import pytesseract
    from PIL import Image as PILImage

    # pytesseract accepts PIL images or numpy arrays
    pil_img = PILImage.fromarray(image) if isinstance(image, np.ndarray) else image

    df = pytesseract.image_to_data(
        pil_img,
        lang=lang,
        config=config,
        output_type=pytesseract.Output.DICT,
    )

    # Reconstruct text from the data dict
    # df keys: level, page_num, block_num, par_num, line_num, word_num, conf, text
    n_items = len(df["text"])

    # Track layout position for grouping
    lines: dict[tuple, list[str]] = {}   # (block_num, par_num, line_num) → [word, ...]
    line_order: list[tuple] = []

    total_words = 0
    confident_words = 0
    confidence_sum = 0.0

    for i in range(n_items):
        word = str(df["text"][i]).strip()
        if not word:
            continue

        try:
            conf = int(df["conf"][i])
        except (ValueError, TypeError):
            conf = -1

        # conf == -1 means Tesseract didn't assign a confidence (e.g. layout cells)
        if conf == -1:
            # Still include if the word looks valid (non-whitespace, non-empty)
            if len(word) > 0:
                key = (df["block_num"][i], df["par_num"][i], df["line_num"][i])
                if key not in lines:
                    lines[key] = []
                    line_order.append(key)
                lines[key].append(word)
            continue

        total_words += 1

        if conf >= confidence_threshold:
            confident_words += 1
            confidence_sum += conf
            key = (df["block_num"][i], df["par_num"][i], df["line_num"][i])
            if key not in lines:
                lines[key] = []
                line_order.append(key)
            lines[key].append(word)
        else:
            logger.debug(
                "ocr_image: page %d dropping low-conf word %r (conf=%d)",
                page_number, word, conf,
            )

    # Reconstruct text preserving line and block structure
    text_lines = []
    prev_block = None
    for key in line_order:
        block_num = key[0]
        if prev_block is not None and block_num != prev_block:
            text_lines.append("")  # blank line between blocks
        prev_block = block_num
        text_lines.append(" ".join(lines[key]))

    text = "\n".join(text_lines).strip()

    quality_ratio = confident_words / total_words if total_words > 0 else 0.0
    mean_confidence = confidence_sum / confident_words if confident_words > 0 else 0.0
    low_quality = quality_ratio < quality_ratio_threshold and total_words > 10

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
    )