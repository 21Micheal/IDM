"""
apps/documents/ocr/tasks_ocr.py  — v4

What changed in this revision
──────────────────────────────
CRITICAL FIX: run_ocr() now correctly dispatches to _ocr_paddle_v1 when
OCR_ENGINE=paddle (the default). Previously the function only had branches
for "textract" and "tesseract", so paddle silently fell through to Tesseract.

Other fixes:
  • _ocr_paddle_v1 actual_engine detection uses the module-level
    _paddle_available flag (already imported correctly).
  • Quality meta "engine" key is always set regardless of branch taken.
  • NER merge order documented more clearly.
"""
from __future__ import annotations

import logging
import threading
from pathlib import Path
from typing import Optional

logger = logging.getLogger(__name__)


# ─────────────────────────────────────────────────────────────────────────────
# spaCy singleton
# ─────────────────────────────────────────────────────────────────────────────

_spacy_nlp = None
_spacy_lock = threading.Lock()
_spacy_available: Optional[bool] = None


def _get_spacy_nlp():
    global _spacy_nlp, _spacy_available

    if _spacy_available is False:
        return None

    with _spacy_lock:
        if _spacy_available is False:
            return None
        if _spacy_nlp is not None:
            return _spacy_nlp

        from django.conf import settings as django_settings
        spacy_enabled = str(
            getattr(django_settings, "OCR_SPACY_ENABLED", "true")
        ).lower() != "false"

        if not spacy_enabled:
            _spacy_available = False
            return None

        model_name = getattr(django_settings, "OCR_SPACY_MODEL", "en_core_web_sm")
        try:
            import spacy
            nlp = spacy.load(model_name, exclude=["parser", "lemmatizer", "attribute_ruler"])
            _spacy_nlp = nlp
            _spacy_available = True
            logger.info("spaCy NER loaded: %s", model_name)
        except Exception as exc:
            _spacy_available = False
            logger.warning(
                "spaCy not available (%s) — NER step will be skipped. "
                "Install with: pip install spacy && python -m spacy download %s",
                exc, model_name,
            )
            return None

    return _spacy_nlp


# ─────────────────────────────────────────────────────────────────────────────
# Public API
# ─────────────────────────────────────────────────────────────────────────────

def run_ocr(doc) -> tuple[str, dict]:
    """
    Run the full OCR + NER extraction pipeline on a Document instance.

    Dispatch order (OCR_ENGINE setting):
      "paddle"   → _ocr_paddle_v1()   [default; falls back to Tesseract internally]
      "tesseract"→ _ocr_tesseract_v2()
      "textract" → _ocr_textract()

    Returns (extracted_text, metadata_updates) where metadata_updates is:
        {
            "ocr_suggestions": { ...structured field suggestions... },
            "ocr_quality": {
                "mean_confidence":       float,
                "overall_quality_ratio": float,
                "total_pages":           int,
                "low_quality_pages":     int,
                "low_quality_warning":   bool,
                "engine":                str,
            }
        }
    """
    from django.conf import settings as django_settings

    engine = getattr(django_settings, "OCR_ENGINE", "paddle").lower().strip()
    logger.info("run_ocr: doc=%s engine=%s", doc.id, engine)

    # ── Engine dispatch ──────────────────────────────────────────────────
    if engine == "textract":
        from apps.documents.tasks import _ocr_textract
        text = _ocr_textract(doc)
        quality_meta = {"engine": "textract"}
        page_results = []

    elif engine == "tesseract":
        doc_result, quality_meta = _ocr_tesseract_v2(doc)
        quality_meta["engine"] = "tesseract"
        text = doc_result.full_text
        page_results = doc_result.page_results

    else:
        if engine not in ("paddle",):
            logger.warning("run_ocr: unrecognised OCR_ENGINE=%r — using paddle", engine)
        doc_result, quality_meta = _ocr_paddle_v1(doc)
        text = doc_result.full_text
        page_results = doc_result.page_results

    # ── Build pages_data for LayoutLMv3 (image + positioned words) ─────────
    pages_data = []
    if getattr(django_settings, "LAYOUTLMV3_ENABLED", True) and page_results:
        try:
            from apps.documents.ocr.layoutlm import PageData
            dpi = int(getattr(django_settings, "OCR_DPI", 300))
            mime = doc.file_mime_type or ""
            file_path = doc.file.path
            pil_pages = _rasterise(file_path, mime, dpi)
            for pil_img, page in zip(pil_pages, page_results):
                if page.words:
                    pages_data.append(PageData(image=pil_img.convert("RGB"), words=page.words))
        except Exception:
            logger.exception("run_ocr: LayoutLMv3 page data preparation failed")

    # ── Field extraction / resolution ─────────────────────────────────────
    # Tier 1: deterministic text extractors. Tier 2: LayoutLM fills gaps from
    # positioned words. Tier 3: spaCy fills remaining common entities only.
    try:
        from apps.documents.ocr.extractor import extract_document_fields
        suggestions = extract_document_fields(text, pages_data=pages_data)
    except Exception:
        logger.exception("run_ocr: structured field extraction failed")
        suggestions = {}

    if getattr(django_settings, "OCR_SPACY_ENABLED", True):
        try:
            ner_updates = _ner_extract(text, suggestions)
            suggestions = _merge_suggestions(suggestions, ner_updates)
        except Exception:
            logger.exception("run_ocr: spaCy fallback merge failed")

    if text:
        suggestions.setdefault(
            "raw_lines",
            [line.strip() for line in text.splitlines() if line.strip()][:80],
        )

    metadata_updates = {
        "ocr_suggestions": suggestions,
    }
    if quality_meta:
        metadata_updates["ocr_quality"] = quality_meta

    return text, metadata_updates


# ─────────────────────────────────────────────────────────────────────────────
# PaddleOCR backend (default)
# ─────────────────────────────────────────────────────────────────────────────

def _ocr_paddle_v1(doc):
    """
    OCR a Document using PaddleOCR with OpenCV pre-processing.

    Falls back to Tesseract automatically if PaddleOCR is not installed
    or model loading fails (handled inside engine.py _get_paddle_ocr).

    Returns (full_text, quality_metadata_dict).
    """
    from django.conf import settings as django_settings

    lang   = getattr(django_settings, "OCR_PADDLE_LANG",            "en")
    dpi    = int(getattr(django_settings, "OCR_DPI",                 300))
    conf_t = int(getattr(django_settings, "OCR_CONFIDENCE_THRESHOLD", 40))
    qual_t = float(getattr(django_settings, "OCR_QUALITY_RATIO",     0.50))

    mime      = doc.file_mime_type or ""
    file_path = doc.file.path

    pil_pages = _rasterise(file_path, mime, dpi)
    if not pil_pages:
        logger.warning("_ocr_paddle_v1: no pages rasterised for %s", doc.id)
        return "", {"engine": "paddle"}

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
                "_ocr_paddle_v1: preprocessing failed for page %d of doc %s: %s",
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

    # Detect which engine actually ran (Paddle may have fallen back to Tesseract)
    from apps.documents.ocr.engine import _paddle_available
    actual_engine = "tesseract" if _paddle_available is False else "paddle"

    logger.info(
        "_ocr_paddle_v1: doc=%s actual_engine=%s pages=%d low_quality=%d "
        "mean_conf=%.1f overall_quality=%.0f%%",
        doc.id, actual_engine,
        doc_result.total_pages, doc_result.low_quality_pages,
        doc_result.mean_document_confidence,
        doc_result.overall_quality_ratio * 100,
    )

    quality_meta = {
        "mean_confidence":       round(doc_result.mean_document_confidence, 1),
        "overall_quality_ratio": round(doc_result.overall_quality_ratio, 3),
        "total_pages":           doc_result.total_pages,
        "low_quality_pages":     doc_result.low_quality_pages,
        "low_quality_warning":   doc_result.low_quality_pages > 0,
        "engine":                actual_engine,
    }
    return doc_result, quality_meta


# ─────────────────────────────────────────────────────────────────────────────
# Tesseract backend (explicit opt-in via OCR_ENGINE=tesseract)
# ─────────────────────────────────────────────────────────────────────────────

def _ocr_tesseract_v2(doc):
    """
    OCR a Document using Tesseract with OpenCV pre-processing.
    Used when OCR_ENGINE=tesseract, or as the internal fallback inside
    engine.py when PaddleOCR is unavailable.
    """
    from django.conf import settings as django_settings
    import pytesseract

    cmd = getattr(django_settings, "TESSERACT_CMD", "").strip()
    if cmd:
        pytesseract.pytesseract.tesseract_cmd = cmd

    lang   = getattr(django_settings, "OCR_LANGUAGES",             "eng")
    dpi    = int(getattr(django_settings, "OCR_DPI",                300))
    conf_t = int(getattr(django_settings, "OCR_CONFIDENCE_THRESHOLD", 40))
    qual_t = float(getattr(django_settings, "OCR_QUALITY_RATIO",    0.50))

    mime      = doc.file_mime_type or ""
    file_path = doc.file.path
    pil_pages = _rasterise(file_path, mime, dpi)

    if not pil_pages:
        logger.warning("_ocr_tesseract_v2: no pages rasterised for %s", doc.id)
        return "", {"engine": "tesseract"}

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
                "_ocr_tesseract_v2: preprocessing failed for page %d of doc %s: %s",
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
        "_ocr_tesseract_v2: doc=%s pages=%d low_quality=%d "
        "mean_conf=%.1f overall_quality=%.0f%%",
        doc.id,
        doc_result.total_pages, doc_result.low_quality_pages,
        doc_result.mean_document_confidence,
        doc_result.overall_quality_ratio * 100,
    )

    quality_meta = {
        "mean_confidence":       round(doc_result.mean_document_confidence, 1),
        "overall_quality_ratio": round(doc_result.overall_quality_ratio, 3),
        "total_pages":           doc_result.total_pages,
        "low_quality_pages":     doc_result.low_quality_pages,
        "low_quality_warning":   doc_result.low_quality_pages > 0,
        "engine":                "tesseract",
    }
    return doc_result, quality_meta




# ─────────────────────────────────────────────────────────────────────────────
# spaCy NER extraction
# ─────────────────────────────────────────────────────────────────────────────

_NER_MAX_CHARS   = 8_000
_MIN_ORG_LEN     = 3
_MONEY_LABELS    = {"MONEY", "CARDINAL"}
_ORG_LABELS      = {"ORG"}
_DATE_LABELS     = {"DATE"}
_LOCATION_LABELS = {"GPE", "LOC"}
_PERSON_LABELS   = {"PERSON"}
_GPE_LABELS      = {"GPE"}

import re as _re
_NER_AMOUNT_RE = _re.compile(
    r"(?P<cur>[A-Z]{3}|Ksh\.?|KSh\.?|Kshs\.?|UShs\.?|TSh\.?|[$€£])?\s*"
    r"(?P<val>\d{1,3}(?:[,\s]\d{3})*(?:[.,]\d{1,4})?)"
    r"(?:\s*(?P<cur2>[A-Z]{3}|Ksh\.?|KSh\.?|Kshs\.?))?",
    _re.IGNORECASE,
)
_CUR_NORMALISE = {
    "KSH": "KES", "KSHS": "KES", "KSH.": "KES",
    "USHS": "UGX", "TSH": "TZS",
    "$": "USD", "€": "EUR", "£": "GBP",
}


def _ner_extract_entities(text: str) -> dict:
    """Extract NER entities and return them by type (not field suggestions)."""
    nlp = _get_spacy_nlp()
    if nlp is None:
        return {}

    text_sample = text[:_NER_MAX_CHARS]
    if not text_sample.strip():
        return {}

    try:
        doc = nlp(text_sample)
    except Exception as exc:
        logger.warning("spaCy NER failed: %s", exc)
        return {}

    entities: dict = {
        'ORG': [],
        'MONEY': [],
        'DATE': [],
        'PERSON': [],
        'GPE': [],  # Geopolitical Entity (countries, cities, states)
        'LOCATION': []
    }

    for ent in doc.ents:
        label = ent.label_
        span = ent.text.strip()
        
        if label in _ORG_LABELS and len(span) >= _MIN_ORG_LEN:
            entities['ORG'].append(span)
        elif label in _MONEY_LABELS:
            parsed = _parse_ner_money(span)
            if parsed:
                entities['MONEY'].append(span)
        elif label in _DATE_LABELS:
            parsed_date = _parse_ner_date(span)
            if parsed_date:
                entities['DATE'].append(parsed_date)
        elif label in _PERSON_LABELS:
            entities['PERSON'].append(span)
        elif label in _GPE_LABELS:
            entities['GPE'].append(span)
        elif label in _LOCATION_LABELS and len(span) >= 3:
            entities['LOCATION'].append(span)

    return entities


def _ner_extract(text: str, existing: dict) -> dict:
    """Legacy NER function for backward compatibility."""
    entities = _ner_extract_entities(text)
    
    # Convert entities to field suggestions (legacy format)
    updates: dict = {}
    
    if entities.get('ORG'):
        best_org = _best_org(entities['ORG'])
        existing_supplier = existing.get("supplier", "")
        if not existing_supplier:
            updates["supplier"] = best_org
        elif (
            len(existing_supplier) <= 5
            and existing_supplier.isupper()
            and len(best_org) > len(existing_supplier)
        ):
            updates["supplier"] = best_org

    if entities.get('MONEY') and "amount" not in existing:
        money_ents = []
        for money_text in entities['MONEY']:
            parsed = _parse_ner_money(money_text)
            if parsed:
                money_ents.append(parsed)
        
        if money_ents:
            best_val, best_cur = max(money_ents, key=lambda x: x[0])
            updates["amount"] = str(round(best_val, 2))
            if best_cur and "currency" not in existing:
                updates["currency"] = best_cur

    if entities.get('DATE'):
        dates = entities['DATE']
        if "document_date" not in existing:
            updates["document_date"] = dates[0]
        if len(dates) >= 2 and "due_date" not in existing and dates[1] != dates[0]:
            updates["due_date"] = dates[1]

    if entities.get('LOCATION') and "registered_address" not in existing:
        updates["registered_address"] = ", ".join(entities['LOCATION'][:3])

    return updates


def _best_org(orgs: list[str]) -> str:
    import re
    _SUFFIX_RE = re.compile(
        r"\b(?:ltd\.?|limited|inc\.?|corp\.?|llc|plc|llp|gmbh|s\.a\.?|pty\.?)\b",
        re.I,
    )
    def _score(name: str) -> float:
        score = len(name) * 0.5
        if _SUFFIX_RE.search(name):
            score += 20
        if name.isupper() and len(name) < 6:
            score -= 15
        return score
    return max(orgs, key=_score)


def _parse_ner_money(text: str) -> Optional[tuple[float, str]]:
    m = _NER_AMOUNT_RE.search(text)
    if not m:
        return None
    raw_val = (m.group("val") or "").replace(",", "").replace(" ", "")
    raw_cur = (m.group("cur") or m.group("cur2") or "").strip().upper().rstrip(".")
    cur_iso = _CUR_NORMALISE.get(raw_cur, raw_cur) if raw_cur else ""
    try:
        return float(raw_val), cur_iso
    except ValueError:
        return None


def _parse_ner_date(text: str) -> Optional[str]:
    text = text.strip()
    if _re.search(r"\b(?:last|next|this|yesterday|tomorrow|ago|month|week|year)\b", text, _re.I):
        return None
    try:
        from dateutil import parser as dateutil_parser
        dt = dateutil_parser.parse(text, dayfirst=True)
        return dt.strftime("%Y-%m-%d")
    except Exception:
        return None


# ─────────────────────────────────────────────────────────────────────────────
# Suggestion merging
# ─────────────────────────────────────────────────────────────────────────────

def _merge_suggestions(regex_result: dict, ner_result: dict) -> dict:
    merged = dict(regex_result)
    for key, value in ner_result.items():
        if key not in merged or not merged.get(key):
            merged[key] = value
        elif key == "supplier":
            existing = str(merged.get(key, "")).strip()
            incoming = str(value).strip()
            # Keep regex supplier unless it looks weak/noisy; NER can overfit to line items.
            weak_existing = (
                len(existing) < 4
                or existing.isupper()
                or existing.lower() in {"n/a", "na", "none"}
            )
            if weak_existing and len(incoming) > len(existing):
                merged[key] = incoming
    return merged


# ─────────────────────────────────────────────────────────────────────────────
# Rasterisation helpers
# ─────────────────────────────────────────────────────────────────────────────

def _rasterise(file_path: str, mime: str, dpi: int) -> list:
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
    from pdf2image import convert_from_path
    effective_dpi = _pdf_effective_dpi(file_path, target_dpi)
    try:
        pages = convert_from_path(
            file_path, dpi=effective_dpi, fmt="RGB", thread_count=1,
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
    try:
        import pdfplumber
        with pdfplumber.open(file_path) as pdf:
            if not pdf.pages:
                return fallback_dpi
            page = pdf.pages[0]
            logger.debug(
                "_pdf_effective_dpi: page0 %.0f×%.0f pts",
                float(page.width), float(page.height),
            )
    except Exception:
        pass
    return max(200, min(fallback_dpi, 400))


def _extract_pdf_tables_as_text(file_path: str) -> str:
    """
    Extract simple PDF tables as labelled lines for searchable PDFs.
    Used by extract_text() in tasks.py.
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
                    if sum(bool(h) for h in headers) < 2:
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
