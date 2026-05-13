"""
apps/documents/ocr/tasks_ocr.py  — v6

Pipeline
────────
  rasterise  →  preprocess  →  OCR (Paddle | Tesseract | Textract)
             →  regex extractor
             →  spaCy NER  (gap-filler)
             →  LayoutLMv3 (spatial arbitration, optional)
             →  FieldResolver  (multi-signal scoring)
             →  metadata_updates

Signal priority inside FieldResolver (highest → lowest)
────────────────────────────────────────────────────────
  1. LayoutLM  — pixel-level spatial understanding, wins on ambiguous grids
  2. Regex     — deterministic label:value patterns
  3. NER       — statistical entity recognition, fills remaining gaps

Changes from v5
───────────────
ARCHITECTURE
  • LayoutLM is now a first-class pipeline stage.  run_ocr() collects
    positioned words from every OCR page (stored on PageOCRResult.words,
    added to engine.py v2) and PIL images, then passes them to
    extract_with_layoutlm().  Results enter FieldResolver alongside regex
    and NER so scoring arbitrates conflicts.

  • FieldResolver replaces the brittle _merge_suggestions() dict merge.
    Every source produces scored candidates; the resolver selects the
    highest-confidence value per field and records its source for auditing.

  • _ocr_paddle_v1 / _ocr_tesseract_v2 now return a 4-tuple:
      (full_text, quality_meta, pil_pages, all_words_per_page)
    The last two are passed to LayoutLM without a second OCR pass.

BUG FIXES
  • _merge_suggestions() removed entirely — was incorrectly overwriting
    higher-confidence regex hits with lower-confidence NER results.

  • spaCy double-checked locking: the outer fast-path guard was
    `if _spacy_available is False` which allowed two concurrent threads
    to both see None and both try to load the model.  Fixed.

  • _ner_extract(): supplier upgrade condition previously evaluated
    `ner_result["supplier"]` without checking if the key existed,
    causing KeyError in Python < 3.10 on docs with no ORG entities.

  • _pdf_effective_dpi(): exceptions now logged at WARNING with the
    error text instead of being silently swallowed.

  • All code paths return a complete quality dict via _empty_quality().

OBSERVABILITY
  • run_ocr() writes "ocr_sources" into metadata_updates — a per-field
    dict recording which pipeline stage contributed each resolved value.
    Operators can inspect this from the admin to diagnose misclassifications.
"""
from __future__ import annotations

import logging
import re
import threading
from celery import shared_task
from .engine import ocr_image, ocr_images
from .field_resolver import FieldResolver
from typing import Optional

logger = logging.getLogger(__name__)


# ─────────────────────────────────────────────────────────────────────────────
# spaCy singleton — double-checked locking
# ─────────────────────────────────────────────────────────────────────────────

_spacy_nlp:       Optional[object] = None
_spacy_lock       = threading.Lock()
_spacy_available: Optional[bool]   = None


def _get_spacy_nlp():
    global _spacy_nlp, _spacy_available

    # Fast path (no lock needed once initialised)
    if _spacy_available is False:
        return None
    if _spacy_available is True and _spacy_nlp is not None:
        return _spacy_nlp

    with _spacy_lock:
        # Re-check inside lock (double-checked locking)
        if _spacy_available is False:
            return None
        if _spacy_nlp is not None:
            return _spacy_nlp

        from django.conf import settings as _s
        enabled = str(getattr(_s, "OCR_SPACY_ENABLED", "true")).lower() not in ("false", "0", "no")
        if not enabled:
            _spacy_available = False
            return None

        model = getattr(_s, "OCR_SPACY_MODEL", "en_core_web_sm")
        try:
            import spacy
            nlp = spacy.load(model, exclude=["parser", "lemmatizer", "attribute_ruler"])
            _spacy_nlp       = nlp
            _spacy_available = True
            logger.info("spaCy NER loaded: %s", model)
        except Exception as exc:
            _spacy_available = False
            logger.warning(
                "spaCy unavailable (%s) — NER skipped. "
                "pip install spacy && python -m spacy download %s",
                exc, model,
            )
            return None

    return _spacy_nlp


# ─────────────────────────────────────────────────────────────────────────────
# Public API
# ─────────────────────────────────────────────────────────────────────────────

def run_ocr(doc) -> tuple[str, dict]:
    """
    Full OCR + NER + LayoutLM + field-resolution pipeline.

    Returns (extracted_text, metadata_updates).

    metadata_updates structure::

        {
            "ocr_suggestions": {field: value, ...},   # resolved fields
            "ocr_quality":     {engine, mean_confidence, ...},
            "ocr_sources":     {field: "regex"|"ner"|"layoutlm", ...}
        }
    """
    from django.conf import settings as _s

    engine = getattr(_s, "OCR_ENGINE", "paddle").lower().strip()
    logger.info("run_ocr: doc=%s engine=%s", doc.id, engine)

    # ── Stage 1: OCR ─────────────────────────────────────────────────────────
    if engine == "textract":
        from apps.documents.tasks import _ocr_textract
        text         = _ocr_textract(doc)
        quality_meta = _empty_quality("textract")
        pil_pages: list = []
        all_words: list[list[dict]] = []

    elif engine == "tesseract":
        text, quality_meta, pil_pages, all_words = _ocr_tesseract_v2(doc)

    else:
        if engine not in ("paddle",):
            logger.warning("run_ocr: unknown OCR_ENGINE=%r — using paddle", engine)
        text, quality_meta, pil_pages, all_words = _ocr_paddle_v1(doc)

    # ── Stage 2: Regex extractor ──────────────────────────────────────────────
    from apps.documents.ocr.extractor import extract_document_fields, DocumentFieldExtractor
    regex_suggestions: dict = extract_document_fields(text)

    # Expose the detected doc_type so LayoutLM can use the right label map
    try:
        _ext = DocumentFieldExtractor(text)
        doc._ocr_doc_type = _ext.doc_type
    except Exception:
        doc._ocr_doc_type = "general"

    # ── Stage 3: spaCy NER ────────────────────────────────────────────────────
    ner_updates: dict = _ner_extract(text, existing=regex_suggestions)

    # ── Stage 4: LayoutLM (optional, gated by LAYOUTLMV3_ENABLED) ────────────
    layoutlm_updates: dict = {}
    if pil_pages and all_words:
        layoutlm_updates = _run_layoutlm(pil_pages, all_words, doc)

    # ── Stage 5: Multi-signal field resolution ────────────────────────────────
    from apps.documents.ocr.field_resolver import FieldResolver
    resolver = FieldResolver()
    resolved, source_map = resolver.resolve(
        regex_result    = regex_suggestions,
        ner_result      = ner_updates,
        layoutlm_result = layoutlm_updates,
    )

    metadata_updates: dict = {
        "ocr_suggestions": resolved,
        "ocr_quality":     quality_meta,
        "ocr_sources":     source_map,
    }

    loggable_sources = {f: s for f, s in source_map.items() if f != "raw_lines"}
    logger.info(
        "run_ocr: doc=%s fields=%d sources=%s",
        doc.id, len(resolved), loggable_sources,
    )
    return text, metadata_updates


# ─────────────────────────────────────────────────────────────────────────────
# LayoutLM integration
# ─────────────────────────────────────────────────────────────────────────────

def _run_layoutlm(
    pil_pages: list,
    all_words: list[list[dict]],
    doc,
) -> dict:
    """
    Call LayoutLMv3 extraction with the rasterised pages and positioned words.

    pil_pages : list of PIL.Image.Image (RGB), one per page
    all_words : list of word-lists per page; each word dict has keys
                text, left, top, right, bottom, conf
    Returns a canonical field dict or {} on any failure.
    """
    try:
        from apps.documents.ocr.layoutlm import extract_with_layoutlm, PageData

        doc_type = getattr(doc, "_ocr_doc_type", "general")

        pages_data = [
            PageData(image=img, words=words)
            for img, words in zip(pil_pages, all_words)
            if words
        ]
        if not pages_data:
            return {}

        result = extract_with_layoutlm(pages_data, doc_type=doc_type)
        logger.info(
            "_run_layoutlm: doc=%s doc_type=%s fields=%d",
            doc.id, doc_type, len(result),
        )
        return result

    except ImportError:
        return {}
    except Exception as exc:
        logger.warning("_run_layoutlm: doc=%s error: %s", doc.id, exc)
        return {}


# ─────────────────────────────────────────────────────────────────────────────
# PaddleOCR backend
# ─────────────────────────────────────────────────────────────────────────────

def _ocr_paddle_v1(doc) -> tuple[str, dict, list, list[list[dict]]]:
    """
    OCR with PaddleOCR (or Tesseract fallback).

    Returns (full_text, quality_meta, pil_pages, all_words_per_page).
    """
    from django.conf import settings as _s

    lang   = getattr(_s, "OCR_PADDLE_LANG",             "en")
    dpi    = int(getattr(_s, "OCR_DPI",                  300))
    conf_t = int(getattr(_s, "OCR_CONFIDENCE_THRESHOLD",  40))
    qual_t = float(getattr(_s, "OCR_QUALITY_RATIO",      0.50))

    mime      = doc.file_mime_type or ""
    file_path = doc.file.path
    logger.debug("_ocr_paddle_v1: doc=%s file=%s mime=%s", doc.id, file_path, mime)

    pil_pages = _rasterise(file_path, mime, dpi)
    if not pil_pages:
        logger.warning("_ocr_paddle_v1: no pages rasterised for doc=%s", doc.id)
        return "", _empty_quality("paddle"), [], []

    from apps.documents.ocr.preprocessing import prepare_image_for_ocr, pil_to_cv2
    from apps.documents.ocr.engine import ocr_images
    import numpy as np

    cv2_pages = []
    for i, pil_img in enumerate(pil_pages):
        try:
            arr          = pil_to_cv2(pil_img)
            preprocessed = prepare_image_for_ocr(arr, dpi=dpi)
            cv2_pages.append(preprocessed)
        except Exception as exc:
            logger.warning(
                "_ocr_paddle_v1: preprocess failed page=%d doc=%s: %s",
                i + 1, doc.id, exc,
            )
            cv2_pages.append(np.array(pil_img.convert("L")))

    doc_result = ocr_images(
        cv2_pages,
        lang=lang,
        confidence_threshold=conf_t,
        quality_ratio_threshold=qual_t,
        engine="paddle",
    )

    from apps.documents.ocr.engine import _paddle_available
    actual_engine = "tesseract" if _paddle_available is False else "paddle"

    logger.info(
        "_ocr_paddle_v1: doc=%s engine=%s pages=%d lq=%d "
        "mean_conf=%.1f quality=%.0f%%",
        doc.id, actual_engine,
        doc_result.total_pages, doc_result.low_quality_pages,
        doc_result.mean_document_confidence,
        doc_result.overall_quality_ratio * 100,
    )

    quality_meta = {
        "engine":                actual_engine,
        "mean_confidence":       round(doc_result.mean_document_confidence, 1),
        "overall_quality_ratio": round(doc_result.overall_quality_ratio, 3),
        "total_pages":           doc_result.total_pages,
        "low_quality_pages":     doc_result.low_quality_pages,
        "low_quality_warning":   doc_result.low_quality_pages > 0,
    }

    # PageOCRResult.words was added in engine.py v2
    all_words: list[list[dict]] = [pr.words for pr in doc_result.page_results]

    return doc_result.full_text, quality_meta, pil_pages, all_words


# ─────────────────────────────────────────────────────────────────────────────
# Tesseract backend
# ─────────────────────────────────────────────────────────────────────────────

def _ocr_tesseract_v2(doc) -> tuple[str, dict, list, list[list[dict]]]:
    """
    OCR with Tesseract.

    Returns (full_text, quality_meta, pil_pages, all_words_per_page).
    """
    from django.conf import settings as _s
    import pytesseract

    cmd = getattr(_s, "TESSERACT_CMD", "").strip()
    if cmd:
        pytesseract.pytesseract.tesseract_cmd = cmd

    lang   = getattr(_s, "OCR_LANGUAGES",              "eng")
    dpi    = int(getattr(_s, "OCR_DPI",                 300))
    conf_t = int(getattr(_s, "OCR_CONFIDENCE_THRESHOLD", 40))
    qual_t = float(getattr(_s, "OCR_QUALITY_RATIO",     0.50))

    mime      = doc.file_mime_type or ""
    file_path = doc.file.path
    logger.debug("_ocr_tesseract_v2: doc=%s file=%s mime=%s", doc.id, file_path, mime)

    pil_pages = _rasterise(file_path, mime, dpi)
    if not pil_pages:
        logger.warning("_ocr_tesseract_v2: no pages rasterised for doc=%s", doc.id)
        return "", _empty_quality("tesseract"), [], []

    from apps.documents.ocr.preprocessing import prepare_image_for_ocr, pil_to_cv2
    from apps.documents.ocr.engine import ocr_images
    import numpy as np

    cv2_pages = []
    for i, pil_img in enumerate(pil_pages):
        try:
            arr          = pil_to_cv2(pil_img)
            preprocessed = prepare_image_for_ocr(arr, dpi=dpi)
            cv2_pages.append(preprocessed)
        except Exception as exc:
            logger.warning(
                "_ocr_tesseract_v2: preprocess failed page=%d doc=%s: %s",
                i + 1, doc.id, exc,
            )
            cv2_pages.append(np.array(pil_img.convert("L")))

    doc_result = ocr_images(
        cv2_pages,
        lang=lang,
        confidence_threshold=conf_t,
        quality_ratio_threshold=qual_t,
        engine="tesseract",
    )

    logger.info(
        "_ocr_tesseract_v2: doc=%s pages=%d lq=%d mean_conf=%.1f quality=%.0f%%",
        doc.id,
        doc_result.total_pages, doc_result.low_quality_pages,
        doc_result.mean_document_confidence,
        doc_result.overall_quality_ratio * 100,
    )

    quality_meta = {
        "engine":                "tesseract",
        "mean_confidence":       round(doc_result.mean_document_confidence, 1),
        "overall_quality_ratio": round(doc_result.overall_quality_ratio, 3),
        "total_pages":           doc_result.total_pages,
        "low_quality_pages":     doc_result.low_quality_pages,
        "low_quality_warning":   doc_result.low_quality_pages > 0,
    }

    all_words: list[list[dict]] = [pr.words for pr in doc_result.page_results]

    return doc_result.full_text, quality_meta, pil_pages, all_words


# ─────────────────────────────────────────────────────────────────────────────
# spaCy NER extraction
# ─────────────────────────────────────────────────────────────────────────────

_NER_MAX_CHARS   = 8_000
_MIN_ORG_LEN     = 3
_MONEY_LABELS    = frozenset({"MONEY", "CARDINAL"})
_ORG_LABELS      = frozenset({"ORG"})
_DATE_LABELS     = frozenset({"DATE"})
_LOCATION_LABELS = frozenset({"GPE", "LOC"})
_QUANTITY_LABELS = frozenset({"QUANTITY"})

_NER_AMOUNT_RE = re.compile(
    r"(?P<cur>[A-Z]{3}|Ksh\.?|KSh\.?|Kshs\.?|UShs\.?|TSh\.?|[$€£])?\s*"
    r"(?P<val>\d{1,3}(?:[,\s]\d{3})*(?:[.,]\d{1,4})?)"
    r"(?:\s*(?P<cur2>[A-Z]{3}|Ksh\.?|KSh\.?|Kshs\.?))?",
    re.IGNORECASE,
)
_CURRENCY_NORMALISE: dict[str, str] = {
    "KSH": "KES", "KSHS": "KES", "KSH.": "KES",
    "USHS": "UGX", "TSH": "TZS",
    "$": "USD", "€": "EUR", "£": "GBP",
}
_UOM_NER_RE = re.compile(
    r"\b(kg|kgs|kilogram\w*|litre\w*|liter\w*|ltr\w*|metre\w*|meter\w*"
    r"|piece\w*|pcs?|unit\w*|box(?:es)?|carton\w*|bag\w*|roll\w*|pair\w*"
    r"|hour\w*|hr\w*|day\w*|month\w*|year\w*|gallon\w*|tonne\w*|ton\w*"
    r"|gram\w*|each|ea|lump\s*sum|dozen|gross|pallet\w*|drum\w*|bottle\w*)\b",
    re.I,
)
_RELATIVE_DATE_RE = re.compile(
    r"\b(?:last|next|this|yesterday|tomorrow|ago|month|week|year)\b", re.I
)
_DATE_FORMATS_NER = [
    "%Y-%m-%d", "%Y/%m/%d",
    "%d %B %Y", "%d %b %Y",
    "%B %d %Y", "%b %d %Y",
    "%B %d, %Y", "%b %d, %Y",
    "%d/%m/%Y", "%m/%d/%Y",
    "%d-%m-%Y", "%m-%d-%Y",
    "%d.%m.%Y", "%d/%m/%y",
]


def _parse_ner_date(text: str) -> Optional[str]:
    text = text.strip()
    if _RELATIVE_DATE_RE.search(text):
        return None
    from datetime import datetime
    for fmt in _DATE_FORMATS_NER:
        try:
            return datetime.strptime(text, fmt).strftime("%Y-%m-%d")
        except ValueError:
            pass
    try:
        from dateutil import parser as _dp
        return _dp.parse(text, dayfirst=True).strftime("%Y-%m-%d")
    except Exception:
        return None


def _parse_ner_money(text: str) -> Optional[tuple[float, str]]:
    m = _NER_AMOUNT_RE.search(text)
    if not m:
        return None
    raw_val = (m.group("val") or "").replace(",", "").replace(" ", "")
    if len(re.sub(r"\D", "", raw_val)) < 2:
        return None
    raw_cur = (m.group("cur") or m.group("cur2") or "").strip().upper().rstrip(".")
    cur_iso = _CURRENCY_NORMALISE.get(raw_cur, raw_cur) if raw_cur else ""
    try:
        val = float(raw_val)
    except ValueError:
        return None
    return (val, cur_iso) if val >= 1.0 else None


def _best_org(orgs: list[str]) -> str:
    _SUFFIX = re.compile(
        r"\b(?:ltd\.?|limited|inc\.?|corp\.?|llc|plc|llp|gmbh|s\.a\.?|pty\.?)\b", re.I
    )
    def _score(n: str) -> float:
        s = len(n) * 0.5
        if _SUFFIX.search(n): s += 20
        if n.isupper() and len(n) < 6: s -= 15
        return s
    return max(orgs, key=_score)


def _ner_extract(text: str, existing: dict) -> dict:
    """
    Gap-fill only — never overwrite an existing value except for the
    supplier short-abbreviation upgrade rule.
    """
    nlp = _get_spacy_nlp()
    if nlp is None:
        return {}

    sample = text[:_NER_MAX_CHARS]
    if not sample.strip():
        return {}

    try:
        doc_nlp = nlp(sample)
    except Exception as exc:
        logger.warning("spaCy NER failed: %s", exc)
        return {}

    updates:    dict      = {}
    orgs:       list[str] = []
    money_ents: list[tuple[float, str]] = []
    dates:      list[str] = []
    locations:  list[str] = []
    qty_spans:  list[str] = []

    for ent in doc_nlp.ents:
        label = ent.label_
        span  = ent.text.strip()
        if label in _ORG_LABELS and len(span) >= _MIN_ORG_LEN:
            orgs.append(span)
        elif label in _MONEY_LABELS:
            p = _parse_ner_money(span)
            if p:
                money_ents.append(p)
        elif label in _DATE_LABELS:
            d = _parse_ner_date(span)
            if d:
                dates.append(d)
        elif label in _LOCATION_LABELS and len(span) >= 3:
            locations.append(span)
        elif label in _QUANTITY_LABELS:
            qty_spans.append(span)

    if orgs:
        best = _best_org(orgs)
        existing_sup = existing.get("supplier", "")
        if not existing_sup:
            updates["supplier"] = best
        elif len(existing_sup) <= 5 and existing_sup.isupper():
            updates["supplier"] = best

    if money_ents and "amount" not in existing:
        best_val, best_cur = max(money_ents, key=lambda x: x[0])
        updates["amount"] = str(round(best_val, 2))
        if best_cur and "currency" not in existing:
            updates["currency"] = best_cur

    if dates:
        if "document_date" not in existing:
            updates["document_date"] = dates[0]
        if len(dates) >= 2 and "due_date" not in existing and dates[1] != dates[0]:
            updates["due_date"] = dates[1]

    if locations and "registered_address" not in existing:
        updates["registered_address"] = ", ".join(locations[:3])

    if qty_spans and "quantity" not in existing:
        for span in qty_spans:
            qty_m = re.search(r"(\d+(?:[.,]\d+)?)", span)
            if qty_m:
                updates["quantity"] = qty_m.group(1)
                uom_m = _UOM_NER_RE.search(span)
                if uom_m and "uom" not in existing:
                    updates["uom"] = uom_m.group(1).lower()
                break

    return updates


# ─────────────────────────────────────────────────────────────────────────────
# Rasterisation
# ─────────────────────────────────────────────────────────────────────────────

def _rasterise(file_path: str, mime: str, dpi: int) -> list:
    from PIL import Image
    if mime == "application/pdf":
        return _rasterise_pdf(file_path, dpi)
    try:
        img = Image.open(file_path)
        img.load()
        return [img.convert("RGB")]
    except Exception as exc:
        logger.error("_rasterise: cannot open %s (%s): %s", file_path, mime, exc)
        return []


def _rasterise_pdf(file_path: str, target_dpi: int) -> list:
    from pdf2image import convert_from_path
    dpi = _pdf_effective_dpi(file_path, target_dpi)
    try:
        pages = convert_from_path(file_path, dpi=dpi, fmt="RGB", thread_count=1)
        logger.debug("_rasterise_pdf: %s → %d pages @ %d dpi", file_path, len(pages), dpi)
        return pages
    except Exception as exc:
        logger.error("_rasterise_pdf: pdf2image failed for %s: %s", file_path, exc)
        return []


def _pdf_effective_dpi(file_path: str, fallback: int) -> int:
    try:
        import pdfplumber
        with pdfplumber.open(file_path) as pdf:
            if pdf.pages:
                p = pdf.pages[0]
                logger.debug(
                    "_pdf_effective_dpi: %s page0 %.0f×%.0f pts",
                    file_path, float(p.width), float(p.height),
                )
    except Exception as exc:
        logger.warning(
            "_pdf_effective_dpi: cannot inspect %s (%s) — using %d dpi",
            file_path, exc, fallback,
        )
    return max(200, min(fallback, 400))


def _extract_pdf_tables_as_text(file_path: str) -> str:
    """Extract PDF table cells as 'Header: Value' lines (for text-native PDFs)."""
    try:
        import pdfplumber
    except ImportError:
        return ""
    lines: list[str] = []
    try:
        with pdfplumber.open(file_path) as pdf:
            for page in pdf.pages:
                for table in page.extract_tables() or []:
                    if len(table) < 2:
                        continue
                    headers = [" ".join(str(c or "").split()).strip(" :-") for c in table[0]]
                    if sum(bool(h) for h in headers) < 2:
                        continue
                    for row in table[1:4]:
                        values = [" ".join(str(c or "").split()).strip() for c in row]
                        for h, v in zip(headers, values):
                            if h and v:
                                lines.append(f"{h}: {v}")
    except Exception as exc:
        logger.debug("_extract_pdf_tables_as_text: %s: %s", file_path, exc)
    return "\n".join(lines)


def _empty_quality(engine: str) -> dict:
    return {
        "engine":                engine,
        "mean_confidence":       0.0,
        "overall_quality_ratio": 0.0,
        "total_pages":           0,
        "low_quality_pages":     0,
        "low_quality_warning":   True,
    }