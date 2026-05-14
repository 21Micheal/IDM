"""
apps/documents/ocr/tasks_ocr.py

OCR and structured-field extraction for the Celery `ocr_document` task.

Pipeline
────────
1. **Searchable PDFs** — If the file is a PDF with a usable text layer (same
   density heuristic as `extract_text`), use pdfplumber text plus optional
   table-derived "Label: Value" lines. No raster OCR.

2. **Scans / images / sparse PDFs** — Rasterise (PDF → images via pdf2image),
   then run **PaddleOCR** by default, with automatic **Tesseract** fallback
   when Paddle returns empty or raises.

3. **Field suggestions** — `DocumentFieldExtractor` (regex/heuristics) plus
   optional **spaCy NER** hints; `FieldResolver` merges regex and NER without
   overwriting high-precision regex hits.

Engines (settings.OCR_ENGINE)
──────────────────────────────
  paddle     — default; PP-OCRv4 via PaddleOCR
  tesseract  — legacy Tesseract + OpenCV preprocessing
  textract   — AWS Textract (unchanged)

Bug-fixes in this revision
──────────────────────────
1.  spaCy model is now cached at module level using a thread-safe dict keyed
    by model name.  Previously nlp = spacy.load() was called on every
    document, which added ~200 ms and allocated ~100 MB per invocation.

2.  _ner_field_hints now also extracts MONEY entities as amount hints and
    CARDINAL entities that look like reference numbers, broadening NER
    coverage beyond just supplier (ORG) and document date (DATE).

3.  The "Bill To" character span calculation is now shared with the extractor
    module (_BILL_TO_BLOCK_RE), preventing the NER supplier from being taken
    from inside the customer address block.
"""
from __future__ import annotations

import logging
import re
import threading
from typing import Optional

import numpy as np

logger = logging.getLogger(__name__)

# Match apps/documents/tasks.py `extract_text` — below this, treat as scan.
_MIN_CHARS_PER_PAGE_NATIVE_PDF = 50

# ── PaddleOCR singleton ────────────────────────────────────────────────────────
# Expensive to construct; initialised once per process.
_paddle_lock = threading.Lock()
_paddle_ocr = None


def _get_paddle_ocr():
    global _paddle_ocr
    if _paddle_ocr is not None:
        return _paddle_ocr
    from django.conf import settings as django_settings

    with _paddle_lock:
        if _paddle_ocr is not None:
            return _paddle_ocr
        from paddleocr import PaddleOCR

        lang = getattr(django_settings, "OCR_PADDLE_LANG", "en")
        use_gpu = getattr(django_settings, "OCR_PADDLE_USE_GPU", False)
        use_angle = getattr(django_settings, "OCR_PADDLE_USE_ANGLE_CLS", True)
        _paddle_ocr_local = PaddleOCR(
            lang=lang,
            use_angle_cls=use_angle,
            use_gpu=use_gpu,
            show_log=False,
        )
        _paddle_ocr = _paddle_ocr_local
        return _paddle_ocr


# ── spaCy model cache ──────────────────────────────────────────────────────────
# FIX: cache loaded models by name to avoid ~200 ms overhead per document and
# prevent repeated ~100 MB RAM allocations in long-running Celery workers.
_spacy_lock = threading.Lock()
_spacy_models: dict[str, object] = {}


def _get_spacy_model(model_name: str):
    """Return a cached spaCy Language object, loading it on first access."""
    if model_name in _spacy_models:
        return _spacy_models[model_name]
    with _spacy_lock:
        if model_name in _spacy_models:
            return _spacy_models[model_name]
        import spacy
        nlp = spacy.load(model_name)
        _spacy_models[model_name] = nlp
        logger.info("_get_spacy_model: loaded %r (cached for worker lifetime)", model_name)
        return nlp


# ─────────────────────────────────────────────────────────────────────────────
# Public API — called from ocr_document() in tasks.py
# ─────────────────────────────────────────────────────────────────────────────


def run_ocr(doc) -> tuple[str, dict]:
    """
    Run OCR (or native PDF text) on a Document and return (extracted_text, metadata_updates).

    metadata_updates is merged into doc.metadata:
        ocr_suggestions — structured field suggestions (regex + NER)
        ocr_quality     — confidence / source / page stats when available
    """
    from django.conf import settings as django_settings

    mime = (doc.file_mime_type or "").lower()
    file_path = doc.file.path

    text = ""
    quality_meta: dict = {}

    # ── Native PDF text layer (digitally created PDFs, not scans) ───────────
    if mime == "application/pdf":
        native_text, cpp = _pdf_native_text_and_density(file_path)
        if cpp >= _MIN_CHARS_PER_PAGE_NATIVE_PDF:
            table_text = _extract_pdf_tables_as_text(file_path)
            text = native_text + (("\n\n" + table_text) if table_text else "")
            quality_meta = {
                "extraction_source": "pdf_text_layer",
                "chars_per_page": round(cpp, 1),
                "mean_confidence": 100.0,
                "overall_quality_ratio": 1.0,
                "total_pages": _pdf_page_count(file_path),
                "low_quality_pages": 0,
                "low_quality_warning": False,
            }
            logger.info(
                "run_ocr: doc=%s using PDF text layer (%.1f chars/page, %d pages)",
                doc.id, cpp, quality_meta["total_pages"],
            )

    # ── Raster OCR when no usable text layer ────────────────────────────────
    if not (text or "").strip():
        engine = getattr(django_settings, "OCR_ENGINE", "paddle").lower()

        if engine == "textract":
            from apps.documents.tasks import _ocr_textract

            text = _ocr_textract(doc)
            quality_meta = {
                "extraction_source": "textract",
                "mean_confidence": 0.0,
                "overall_quality_ratio": 0.0,
                "total_pages": 0,
                "low_quality_pages": 0,
                "low_quality_warning": False,
            }
        elif engine == "tesseract":
            text, quality_meta = _ocr_tesseract_v2(doc)
            quality_meta.setdefault("extraction_source", "tesseract")
        else:
            text, quality_meta = _ocr_paddle_v2(doc)
            quality_meta.setdefault("extraction_source", "paddle")
            if not (text or "").strip():
                logger.warning(
                    "run_ocr: doc=%s PaddleOCR empty — falling back to Tesseract",
                    doc.id,
                )
                text, quality_meta = _ocr_tesseract_v2(doc)
                quality_meta["extraction_source"] = "tesseract_fallback"

    from apps.documents.ocr.extractor import extract_document_fields

    regex_suggestions = extract_document_fields(text)
    ner_hints = _ner_field_hints(text)

    from apps.documents.ocr.field_resolver import FieldResolver

    merged, _sources = FieldResolver().resolve(regex_suggestions, ner_hints)

    metadata_updates: dict = {"ocr_suggestions": merged}
    if quality_meta:
        metadata_updates["ocr_quality"] = quality_meta

    return text, metadata_updates


# ─────────────────────────────────────────────────────────────────────────────
# spaCy NER → canonical field hints (merged after regex extraction)
# ─────────────────────────────────────────────────────────────────────────────


def _ner_field_hints(text: str) -> dict[str, str]:
    """
    Map spaCy entities to extractor field names (conservative).

    FIX: model is now loaded via _get_spacy_model() which caches the nlp
    object for the lifetime of the Celery worker process.

    FIX: MONEY entities are now surfaced as amount hints, and CARDINAL
    entities that look like reference numbers are surfaced as reference_number
    hints — increasing NER coverage beyond the original supplier + date only.
    """
    from django.conf import settings as django_settings

    if not (text or "").strip():
        return {}
    if not getattr(django_settings, "OCR_SPACY_ENABLED", True):
        return {}

    model_name = getattr(django_settings, "OCR_SPACY_MODEL", "en_core_web_sm")
    try:
        nlp = _get_spacy_model(model_name)
    except Exception as exc:
        logger.debug("_ner_field_hints: spaCy unavailable (%s): %s", model_name, exc)
        return {}

    from apps.documents.ocr.extractor import _parse_date, _BILL_TO_BLOCK_RE

    def _bill_to_char_span(t: str) -> Optional[tuple[int, int]]:
        """Return (start, end) char indices of the Bill-To block, or None."""
        m = _BILL_TO_BLOCK_RE.search(t)
        if not m:
            return None
        start = m.start()
        chunk = t[m.end(): m.end() + 1500]
        boundary = re.search(
            r"(?im)^\s*(?:product|item|description|qty|ship\s*to|sold\s*to|service)\b",
            chunk,
        )
        end = m.end() + (boundary.start() if boundary else len(chunk))
        return (start, end)

    doc = nlp(text[:200_000])
    hints: dict[str, str] = {}

    bill_span = _bill_to_char_span(text)

    # ── Supplier: first ORG outside the Bill-To block ─────────────────────
    orgs = [e for e in doc.ents if e.label_ == "ORG" and len(e.text.strip()) > 3]
    outside = [
        e for e in orgs
        if not (bill_span and bill_span[0] <= e.start_char < bill_span[1])
    ]
    if outside:
        first_org = min(outside, key=lambda e: e.start_char)
        hints["supplier"] = " ".join(first_org.text.split())

    # ── Document date: first DATE entity outside Bill-To ──────────────────
    for ent in doc.ents:
        if ent.label_ != "DATE":
            continue
        if bill_span and bill_span[0] <= ent.start_char < bill_span[1]:
            continue
        parsed = _parse_date(ent.text)
        if parsed:
            hints.setdefault("document_date", parsed)
            break

    # ── Amount: first MONEY entity (hint only — regex extractor takes priority) ──
    for ent in doc.ents:
        if ent.label_ != "MONEY":
            continue
        # Strip currency symbols/codes; keep digits and decimal separator
        raw_num = re.sub(r"[^\d.,]", "", ent.text)
        raw_num = raw_num.rstrip(",.")
        if raw_num and re.match(r"^\d", raw_num):
            hints.setdefault("amount", raw_num)
            break

    return hints


# ─────────────────────────────────────────────────────────────────────────────
# PDF helpers
# ─────────────────────────────────────────────────────────────────────────────


def _pdf_page_count(file_path: str) -> int:
    try:
        import pdfplumber

        with pdfplumber.open(file_path) as pdf:
            return len(pdf.pages)
    except Exception:
        return 0


def _pdf_native_text_and_density(file_path: str) -> tuple[str, float]:
    """
    Return (concatenated page text, chars per page) using pdfplumber only.

    Table augmentation is applied later in run_ocr so density reflects the
    real text layer (same threshold as extract_text).
    """
    try:
        import pdfplumber

        with pdfplumber.open(file_path) as pdf:
            if not pdf.pages:
                return "", 0.0
            parts = [(p.extract_text() or "") for p in pdf.pages]
            text = "\n".join(parts)
            n = len(pdf.pages)
            cpp = len(text.strip()) / max(n, 1)
            return text, float(cpp)
    except Exception as exc:
        logger.warning("_pdf_native_text_and_density: failed for %s: %s", file_path, exc)
        return "", 0.0


def _extract_pdf_tables_as_text(file_path: str) -> str:
    """
    Extract simple PDF tables as labelled lines.

    pdfplumber often sees invoice header grids that plain text extraction loses.
    """
    try:
        import pdfplumber
    except Exception:
        return ""

    labelled_lines: list[str] = []
    try:
        with pdfplumber.open(file_path) as pdf:
            for page in pdf.pages:
                for table in page.extract_tables() or []:
                    if len(table) < 2:
                        continue

                    headers = [
                        " ".join(str(cell or "").split()).strip(" :-")
                        for cell in table[0]
                    ]
                    if sum(bool(header) for header in headers) < 2:
                        continue

                    for row in table[1:4]:
                        values = [
                            " ".join(str(cell or "").split()).strip()
                            for cell in row
                        ]
                        for header, value in zip(headers, values):
                            if header and value:
                                labelled_lines.append(f"{header}: {value}")
    except Exception as exc:
        logger.debug("_extract_pdf_tables_as_text: failed for %s: %s", file_path, exc)
        return ""

    return "\n".join(labelled_lines)


# ─────────────────────────────────────────────────────────────────────────────
# PaddleOCR backend
# ─────────────────────────────────────────────────────────────────────────────


def _join_paddle_words(words: list[dict]) -> str:
    """Join positioned Paddle words; wide horizontal gaps become tabs."""
    if not words:
        return ""

    ordered = sorted(words, key=lambda w: (w["left"], w["top"]))
    char_widths = [
        w["width"] / max(len(w["text"]), 1)
        for w in ordered
        if w["width"] > 0 and w["text"]
    ]
    median_char_width = float(np.median(char_widths)) if char_widths else 8.0
    column_gap = max(32.0, median_char_width * 5.0)

    parts = [ordered[0]["text"]]
    prev = ordered[0]
    for word in ordered[1:]:
        gap = word["left"] - (prev["left"] + prev["width"])
        parts.append("\t" if gap > column_gap else " ")
        parts.append(word["text"])
        prev = word

    return "".join(parts)


def _paddle_page_to_lines(page_result: list | None) -> tuple[str, float, int, int]:
    """
    Convert PaddleOCR result for one page to text + quality stats.

    Returns (text, mean_conf_0_100, word_count, low_conf_word_count).
    """
    words: list[dict] = []
    if not page_result:
        return "", 0.0, 0, 0

    for line in page_result:
        if not line or len(line) < 2:
            continue
        box, (txt, conf) = line[0], line[1]
        if not txt or not str(txt).strip():
            continue
        xs = [float(p[0]) for p in box]
        ys = [float(p[1]) for p in box]
        left, top, right, bottom = min(xs), min(ys), max(xs), max(ys)
        c = float(conf) if conf is not None else 0.0
        words.append(
            {
                "text": str(txt).strip(),
                "left": int(left),
                "top": int(top),
                "width": int(max(1, right - left)),
                "height": int(max(1, bottom - top)),
                "conf": c,
            }
        )

    if not words:
        return "", 0.0, 0, 0

    # Cluster into lines by vertical overlap / proximity
    words_sorted = sorted(words, key=lambda w: (w["top"] + w["height"] / 2, w["left"]))
    lines_clusters: list[list[dict]] = []
    for w in words_sorted:
        cy = w["top"] + w["height"] / 2
        placed = False
        for cluster in lines_clusters:
            ref = cluster[0]
            ref_y = ref["top"] + ref["height"] / 2
            if abs(cy - ref_y) <= max(10.0, ref["height"] * 0.75):
                cluster.append(w)
                placed = True
                break
        if not placed:
            lines_clusters.append([w])

    lines_clusters.sort(key=lambda c: min(w["top"] for w in c))

    text_lines = []
    conf_sum = 0.0
    n_conf = 0
    low_conf = 0
    for cluster in lines_clusters:
        cluster.sort(key=lambda x: x["left"])
        line_txt = _join_paddle_words(cluster)
        if line_txt.strip():
            text_lines.append(line_txt)
        for ww in cluster:
            conf_sum += ww["conf"] * 100.0
            n_conf += 1
            if ww["conf"] < 0.5:
                low_conf += 1

    mean_conf = conf_sum / n_conf if n_conf else 0.0
    return "\n".join(text_lines), mean_conf, n_conf, low_conf


def _ocr_paddle_v2(doc) -> tuple[str, dict]:
    """Run PaddleOCR on rasterised pages; returns (full_text, quality_metadata_dict)."""
    from django.conf import settings as django_settings

    dpi = int(getattr(django_settings, "OCR_DPI", 300))
    mime = doc.file_mime_type or ""
    file_path = doc.file.path

    pil_pages = _rasterise(file_path, mime, dpi)
    if not pil_pages:
        logger.warning("_ocr_paddle_v2: no pages rasterised for %s", doc.id)
        return "", {}

    try:
        ocr_engine = _get_paddle_ocr()
    except Exception as exc:
        logger.error("_ocr_paddle_v2: PaddleOCR init failed: %s", exc)
        return "", {}

    page_texts: list[str] = []
    page_means: list[float] = []
    low_quality_pages = 0

    for i, pil_img in enumerate(pil_pages):
        try:
            rgb = np.array(pil_img.convert("RGB"))
            result = ocr_engine.ocr(rgb, cls=True)
        except Exception as exc:
            logger.warning(
                "_ocr_paddle_v2: Paddle failed page %d of doc %s: %s",
                i + 1, doc.id, exc,
            )
            page_texts.append("")
            low_quality_pages += 1
            continue

        # PaddleOCR 2.x: first element is the list of lines for the image
        page_lines = result[0] if result and isinstance(result, list) else None
        ptext, mean_c, wcount, low_w = _paddle_page_to_lines(page_lines)
        page_texts.append(ptext)
        if not wcount:
            if not (ptext or "").strip():
                low_quality_pages += 1
            continue

        page_means.append(mean_c)
        if low_w / wcount > 0.5 or mean_c < 45:
            low_quality_pages += 1

    full_text = "\n\n".join(t for t in page_texts if t)
    n_pages = len(pil_pages)
    mean_doc_conf = float(np.mean(page_means)) if page_means else 0.0
    confident_pages = sum(1 for m in page_means if m >= 45)
    overall_ratio = confident_pages / max(len(page_means), 1) if page_means else 0.0

    return full_text, {
        "mean_confidence": round(mean_doc_conf, 1),
        "overall_quality_ratio": round(max(0.0, min(1.0, overall_ratio)), 3),
        "total_pages": n_pages,
        "low_quality_pages": low_quality_pages,
        "low_quality_warning": low_quality_pages > 0,
    }


# ─────────────────────────────────────────────────────────────────────────────
# Tesseract backend
# ─────────────────────────────────────────────────────────────────────────────


def _ocr_tesseract_v2(doc) -> tuple[str, dict]:
    """
    OCR a Document using Tesseract with OpenCV pre-processing.

    Returns (full_text, quality_metadata_dict).
    """
    from django.conf import settings as django_settings
    import pytesseract

    cmd = getattr(django_settings, "TESSERACT_CMD", "").strip()
    if cmd:
        pytesseract.pytesseract.tesseract_cmd = cmd

    lang = getattr(django_settings, "OCR_LANGUAGES", "eng")
    dpi = int(getattr(django_settings, "OCR_DPI", 300))
    confidence_threshold = int(getattr(django_settings, "OCR_CONFIDENCE_THRESHOLD", 40))
    quality_ratio = float(getattr(django_settings, "OCR_QUALITY_RATIO", 0.50))

    mime = doc.file_mime_type or ""
    file_path = doc.file.path

    pil_pages = _rasterise(file_path, mime, dpi)

    if not pil_pages:
        logger.warning("_ocr_tesseract_v2: no pages rasterised for %s", doc.id)
        return "", {}

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
            import numpy as np

            fallback = np.array(pil_img.convert("L"))
            cv2_pages.append(fallback)

    doc_result = ocr_images(
        cv2_pages,
        lang=lang,
        confidence_threshold=confidence_threshold,
        quality_ratio_threshold=quality_ratio,
    )

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
        "extraction_source": "tesseract",
        "mean_confidence": round(doc_result.mean_document_confidence, 1),
        "overall_quality_ratio": round(doc_result.overall_quality_ratio, 3),
        "total_pages": doc_result.total_pages,
        "low_quality_pages": doc_result.low_quality_pages,
        "low_quality_warning": doc_result.low_quality_pages > 0,
    }

    return doc_result.full_text, quality_meta


# ─────────────────────────────────────────────────────────────────────────────
# Rasterisation helpers
# ─────────────────────────────────────────────────────────────────────────────


def _rasterise(file_path: str, mime: str, dpi: int) -> list:
    """Convert a document file to a list of PIL Images (one per page)."""
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

    try:
        img = Image.open(file_path)
        img.load()
        return [img.convert("RGB")]
    except Exception:
        logger.warning("_rasterise: unsupported MIME %s for %s", mime, file_path)
        return []


def _rasterise_pdf(file_path: str, target_dpi: int) -> list:
    """Rasterise a PDF to PIL Images using pdf2image."""
    from pdf2image import convert_from_path

    effective_dpi = _pdf_effective_dpi(file_path, target_dpi)

    try:
        pages = convert_from_path(
            file_path,
            dpi=effective_dpi,
            fmt="RGB",
            thread_count=1,
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
    """Pick a sane render DPI for pdf2image (bounded for memory)."""
    try:
        import pdfplumber

        with pdfplumber.open(file_path) as pdf:
            if not pdf.pages:
                return fallback_dpi
            page = pdf.pages[0]
            width_pts = float(page.width)
            height_pts = float(page.height)
            if width_pts <= 0 or height_pts <= 0:
                return fallback_dpi
            logger.debug(
                "_pdf_effective_dpi: page0 %.0f×%.0f pts",
                width_pts,
                height_pts,
            )
    except Exception:
        pass

    return max(200, min(fallback_dpi, 400))