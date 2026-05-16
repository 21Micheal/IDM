"""
apps/documents/ocr/idp.py

Intelligent Document Processing (IDP) using Claude Vision.

This module replaces the regex-based _extract_ocr_suggestions() / extractor.py
with a vision-language model that understands document structure semantically.

Architecture
────────────
                        ┌─────────────────────────────┐
  PDF (native text) ───►│ pdfplumber → structured text │
                        │ + table augmentation          │──► Claude (text mode)
                        └─────────────────────────────┘         │
                                                                 ▼
  PDF (scanned) ────────► pypdfium2 render → PNG ──────► Claude (vision mode)
                                                                 │
  Image upload ─────────────────────────────────────────►        │
                                                                 ▼
                                                    Structured JSON fields
                                                                 │
                                                                 ▼
                                              Merge into Document.metadata
                                              + update top-level model fields

Why Claude Vision instead of local models (LayoutLM, PaddleNLP, etc.)
──────────────────────────────────────────────────────────────────────
• Local transformer models require GPU for acceptable inference speed.
  On CPU, LayoutLMv3 takes 30–60 s per page — unacceptable for a Celery task.
• Local models require fine-tuning per document type to reach production accuracy.
• Claude Vision understands document semantics natively: it knows that
  "Velocity Logistics Solutions" is the supplier because it sits under the
  SUPPLIER column header — not because it matched a regex pattern.
• claude-haiku-4-5 is ~$0.0004/page. At 500 docs/day = ~$6/day.
• Graceful fallback: if Claude is unavailable, the regex extractor still runs.

Engine selection
────────────────
OCR_IDP_ENGINE setting controls the extraction path:

  "claude_vision"  → Render PDF to PNG, send to Claude Vision
                     Best for: scanned docs, complex layouts, mixed content
                     Model: claude-haiku-4-5 (fast+cheap) or claude-sonnet-4-6

  "claude_text"    → Extract text with pdfplumber (spatially augmented),
                     send to Claude as text prompt
                     Best for: native digital PDFs
                     Model: claude-haiku-4-5

  "auto"           → Detect: sparse text → vision mode, dense text → text mode
                     Recommended default

  "regex"          → Original regex extractor (fallback, no API cost)

Django settings
───────────────
ANTHROPIC_API_KEY        Required. Set in environment or settings.
OCR_IDP_ENGINE           "auto" | "claude_vision" | "claude_text" | "regex"
                         Default: "auto"
OCR_IDP_MODEL            Claude model to use. Default: "claude-haiku-4-5"
OCR_IDP_VISION_DPI       DPI for PDF→PNG rendering. Default: 150
                         (150 DPI is sufficient for Claude Vision; higher wastes tokens)
OCR_IDP_TIMEOUT          API request timeout in seconds. Default: 60
OCR_IDP_MAX_PAGES        Max pages to send to Vision. Default: 3
                         (Most business docs are 1–2 pages; cap prevents runaway cost)
"""
from __future__ import annotations

import base64
import json
import logging
import time
from pathlib import Path
from typing import Optional

logger = logging.getLogger(__name__)

# ── Field extraction prompt ────────────────────────────────────────────────────
# Versioned so we can A/B test prompt changes without code deploys.

_PROMPT_VERSION = "2"

_SYSTEM_PROMPT = """You are a precise document field extraction engine for an enterprise document management system. Your job is to extract structured data from business documents with high accuracy.

You will receive either:
- A document image (scanned or rendered PDF page)
- Extracted text from a PDF with layout information

Return ONLY a valid JSON object. No explanation, no markdown code fences, no preamble."""

_EXTRACTION_PROMPT = """Extract the following fields from this document. Return ONLY a valid JSON object.

FIELDS:
{
  "document_type": "Exact document type: Invoice, Tax Invoice, Purchase Order, Local Purchase Order, Receipt, Contract, Service Agreement, Delivery Note, Expense Claim, Imprest, Payment Voucher, Quotation, Credit Note, Debit Note, Utility Bill, or Statement. Use the term as it appears in the document.",
  "title": "A clean, useful document title. Example: 'Velocity Logistics Invoice SHIP-8890-X' or 'Acme Supplies Tax Invoice Oct 2024'. Max 120 chars. Do NOT use address lines or column headers as the title.",
  "supplier": "Name of the company or person ISSUING the document (the seller/vendor/service provider). NOT the bill-to party. Extract the legal name, not address.",
  "reference_number": "Primary document identifier: invoice number, PO number, order ref, contract number, receipt number. Strip any leading # symbol.",
  "account_code": "Supplier account code, GL code, cost centre code, or any alphanumeric accounting reference code assigned to this transaction.",
  "document_date": "Issue/invoice date in YYYY-MM-DD. If only month+year, use first of month.",
  "due_date": "Payment due date or expiry date in YYYY-MM-DD.",
  "amount": "TOTAL amount due (after tax) as a plain decimal number. No currency symbols, no commas. Use the final total, NOT the subtotal.",
  "currency": "ISO 4217 code: USD, EUR, GBP, KES, UGX, TZS, etc. Infer from context or symbols ($=USD, £=GBP, €=EUR, KES/Ksh=KES).",
  "tax_amount": "VAT, GST, or tax amount as a plain decimal number.",
  "subtotal": "Pre-tax subtotal as a plain decimal number.",
  "payment_terms": "Payment terms text, e.g. 'Net 30', 'Due on receipt'.",
  "payment_method": "Payment method if specified: Cash, Cheque, Bank Transfer, M-PESA, Wire Transfer, etc.",
  "transaction_ref": "Payment transaction reference, M-PESA code, cheque number, or wire reference.",
  "po_reference": "Purchase order reference number if this document references a PO.",
  "vendor_code": "Vendor or supplier ID code assigned by the buyer.",
  "approved_by": "Name of the person who approved or authorized this document.",
  "kra_pin": "Kenya Revenue Authority PIN (format: one letter + 9 digits + one letter, e.g. P051234567A).",
  "vat_number": "VAT or tax registration number.",
  "bank_details": "Bank name and account details if present for payment remittance.",
  "confidence": "Your extraction confidence: 'high' if document is clear and all key fields are present, 'medium' if some fields are uncertain, 'low' if document is unclear or incomplete.",
  "low_quality_warning": false
}

STRICT RULES:
1. Set any field to null if not clearly present — never guess or invent values.
2. supplier = the ISSUING party (top of invoice, letterhead). Bill-to is the RECIPIENT. They are different.
3. amount = the FINAL total (labeled TOTAL, TOTAL AMOUNT, AMOUNT DUE, etc.) — never the subtotal.
4. reference_number = the document's OWN identifier, not a PO reference on an invoice.
5. title should be useful for a document management system — combine supplier + doc type + ref number.
6. For scanned or blurry documents: set low_quality_warning to true.
7. Numbers: plain decimals only — no commas, no currency symbols, no spaces.
8. Dates: YYYY-MM-DD only. Never return ambiguous formats like 10/25/2024.

Return ONLY the JSON object. Nothing else."""


# ── Main entry point ───────────────────────────────────────────────────────────

def run_idp(doc) -> tuple[str, dict]:
    """
    Run IDP on a Document instance.

    Returns (extracted_text, metadata_updates) — same interface as run_ocr()
    in tasks_ocr.py so the Celery task doesn't need to change.

    metadata_updates shape:
        {
            "ocr_suggestions": {
                "fields": { ...all extracted fields... },
                "quality": {
                    "engine": "claude_vision" | "claude_text" | "regex",
                    "model": "claude-haiku-4-5",
                    "confidence": "high" | "medium" | "low",
                    "low_quality_warning": bool,
                    "processing_time_s": float,
                }
            }
        }
    """
    from django.conf import settings as django_settings

    engine_setting = getattr(django_settings, "OCR_IDP_ENGINE", "auto").lower()
    start = time.monotonic()

    # ── Route to correct engine ────────────────────────────────────────────────
    try:
        if engine_setting == "regex":
            return _run_regex_fallback(doc, start)

        api_key = getattr(django_settings, "ANTHROPIC_API_KEY", "").strip()
        if not api_key:
            logger.warning(
                "idp.run_idp: ANTHROPIC_API_KEY not set — falling back to regex"
            )
            return _run_regex_fallback(doc, start)

        mime = doc.file_mime_type or ""
        file_path = doc.file.path

        # Determine effective engine
        if engine_setting == "auto":
            engine = _detect_engine(file_path, mime)
        elif engine_setting == "claude_vision":
            engine = "claude_vision"
        else:
            engine = "claude_text"

        if engine == "claude_vision":
            fields, raw_text = _extract_via_vision(file_path, mime, api_key, django_settings)
        else:
            fields, raw_text = _extract_via_text(file_path, mime, api_key, django_settings)

    except Exception as exc:
        logger.error("idp.run_idp: Claude extraction failed for %s: %s", doc.id, exc)
        logger.info("idp.run_idp: falling back to regex extractor")
        return _run_regex_fallback(doc, start)

    elapsed = round(time.monotonic() - start, 2)

    # ── Build metadata updates ────────────────────────────────────────────────
    model = getattr(
        __import__("django.conf", fromlist=["settings"]).settings,
        "OCR_IDP_MODEL",
        "claude-haiku-4-5",
    )

    quality = {
        "engine":              engine,
        "model":               model,
        "confidence":          fields.pop("confidence", "medium"),
        "low_quality_warning": bool(fields.pop("low_quality_warning", False)),
        "processing_time_s":   elapsed,
        "prompt_version":      _PROMPT_VERSION,
    }

    metadata_updates = {
        "ocr_suggestions": {
            "fields":  fields,
            "quality": quality,
        }
    }

    logger.info(
        "idp.run_idp: doc=%s engine=%s confidence=%s time=%.2fs fields=%s",
        doc.id, engine, quality["confidence"], elapsed,
        [k for k, v in fields.items() if v is not None and k != "raw_lines"],
    )

    return raw_text, metadata_updates


# ── Engine detection ───────────────────────────────────────────────────────────

def _detect_engine(file_path: str, mime: str) -> str:
    """
    Choose extraction engine based on document content.

    Vision mode for:
      - Image files (always)
      - PDFs with sparse native text (scanned/image-based)

    Text mode for:
      - PDFs with dense native text (digital invoices, contracts)
    """
    if mime.startswith("image/"):
        return "claude_vision"

    if mime == "application/pdf":
        try:
            import pdfplumber
            with pdfplumber.open(file_path) as pdf:
                if not pdf.pages:
                    return "claude_vision"
                # Sample first page
                text = pdf.pages[0].extract_text() or ""
                chars_per_page = len(text.strip())
                # Fewer than 100 chars → likely scanned → use vision
                return "claude_vision" if chars_per_page < 100 else "claude_text"
        except Exception:
            return "claude_vision"

    # Non-PDF, non-image (DOCX, XLSX) → text mode
    return "claude_text"


# ── Vision extraction path ─────────────────────────────────────────────────────

def _extract_via_vision(
    file_path: str,
    mime: str,
    api_key: str,
    settings,
) -> tuple[dict, str]:
    """
    Render document pages to images and send to Claude Vision.
    Returns (fields_dict, raw_text_for_storage).
    """
    import anthropic

    model = getattr(settings, "OCR_IDP_MODEL", "claude-haiku-4-5")
    dpi = int(getattr(settings, "OCR_IDP_VISION_DPI", 150))
    timeout = int(getattr(settings, "OCR_IDP_TIMEOUT", 60))
    max_pages = int(getattr(settings, "OCR_IDP_MAX_PAGES", 3))

    pages_b64 = _render_to_images(file_path, mime, dpi, max_pages)
    if not pages_b64:
        raise RuntimeError("Could not render any pages from document")

    content = []
    for i, (img_b64, img_mime) in enumerate(pages_b64):
        if i > 0:
            content.append({"type": "text", "text": f"--- Page {i + 1} ---"})
        content.append({
            "type": "image",
            "source": {
                "type":       "base64",
                "media_type": img_mime,
                "data":       img_b64,
            },
        })
    content.append({"type": "text", "text": _EXTRACTION_PROMPT})

    client = anthropic.Anthropic(api_key=api_key, timeout=timeout)
    response = client.messages.create(
        model=model,
        max_tokens=1024,
        system=_SYSTEM_PROMPT,
        messages=[{"role": "user", "content": content}],
    )

    raw_json = response.content[0].text.strip()
    fields = _parse_claude_json(raw_json)

    # Also extract raw text for full-text search (don't depend on Claude for this)
    raw_text = _extract_raw_text(file_path, mime)

    return fields, raw_text


# ── Text extraction path ───────────────────────────────────────────────────────

def _extract_via_text(
    file_path: str,
    mime: str,
    api_key: str,
    settings,
) -> tuple[dict, str]:
    """
    Extract text from PDF with spatial augmentation and send to Claude as text.
    Returns (fields_dict, raw_text_for_storage).
    """
    import anthropic

    model = getattr(settings, "OCR_IDP_MODEL", "claude-haiku-4-5")
    timeout = int(getattr(settings, "OCR_IDP_TIMEOUT", 60))

    raw_text = _extract_raw_text(file_path, mime)
    augmented_text = _augment_with_tables(file_path, mime, raw_text)

    if not augmented_text.strip():
        raise RuntimeError("No text could be extracted from document")

    document_context = (
        f"DOCUMENT TEXT (extracted from PDF with layout information):\n"
        f"{'─' * 60}\n"
        f"{augmented_text}\n"
        f"{'─' * 60}"
    )

    client = anthropic.Anthropic(api_key=api_key, timeout=timeout)
    response = client.messages.create(
        model=model,
        max_tokens=1024,
        system=_SYSTEM_PROMPT,
        messages=[{
            "role": "user",
            "content": f"{document_context}\n\n{_EXTRACTION_PROMPT}",
        }],
    )

    raw_json = response.content[0].text.strip()
    fields = _parse_claude_json(raw_json)

    return fields, raw_text


# ── Rendering helpers ──────────────────────────────────────────────────────────

def _render_to_images(
    file_path: str,
    mime: str,
    dpi: int,
    max_pages: int,
) -> list[tuple[str, str]]:
    """
    Render document pages to base64-encoded PNG images.
    Returns list of (base64_string, media_type) tuples.
    """
    results: list[tuple[str, str]] = []

    if mime.startswith("image/"):
        with open(file_path, "rb") as f:
            data = f.read()
        b64 = base64.standard_b64encode(data).decode()
        # Normalise to JPEG for smaller payloads if large
        results.append((b64, mime))
        return results

    if mime == "application/pdf":
        try:
            import pypdfium2 as pdfium
            doc = pdfium.PdfDocument(file_path)
            n = min(len(doc), max_pages)
            scale = dpi / 72.0  # pdfium renders at 72 DPI by default

            for i in range(n):
                page = doc[i]
                bitmap = page.render(scale=scale, optimise_mode=pdfium.OptimiseMode.NONE)
                pil_img = bitmap.to_pil()

                import io
                buf = io.BytesIO()
                pil_img.save(buf, format="JPEG", quality=85, optimize=True)
                buf.seek(0)
                b64 = base64.standard_b64encode(buf.read()).decode()
                results.append((b64, "image/jpeg"))

            return results
        except Exception as exc:
            logger.error("_render_to_images: pypdfium2 failed: %s", exc)
            # Fallback to pdf2image
            try:
                from pdf2image import convert_from_path
                import io
                pages = convert_from_path(file_path, dpi=dpi)
                for pil_img in pages[:max_pages]:
                    buf = io.BytesIO()
                    pil_img.save(buf, format="JPEG", quality=85)
                    buf.seek(0)
                    b64 = base64.standard_b64encode(buf.read()).decode()
                    results.append((b64, "image/jpeg"))
                return results
            except Exception as exc2:
                logger.error("_render_to_images: pdf2image fallback failed: %s", exc2)
                return []

    # Non-PDF, non-image: can't render
    return []


# ── Text extraction helpers ────────────────────────────────────────────────────

def _extract_raw_text(file_path: str, mime: str) -> str:
    """Extract raw text for full-text search storage (not for field extraction)."""
    if mime == "application/pdf":
        try:
            import pdfplumber
            with pdfplumber.open(file_path) as pdf:
                return "\n".join(p.extract_text() or "" for p in pdf.pages)
        except Exception:
            return ""

    if mime in (
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "application/msword",
    ):
        try:
            from docx import Document as DocxDocument
            d = DocxDocument(file_path)
            return "\n".join(p.text for p in d.paragraphs)
        except Exception:
            return ""

    return ""


def _augment_with_tables(file_path: str, mime: str, raw_text: str) -> str:
    """
    Append table-derived "Label: Value" lines to raw text.
    Preserves column header → cell value relationships that extract_text() collapses.
    """
    if mime != "application/pdf":
        return raw_text

    try:
        import pdfplumber
        augmented: list[str] = []
        with pdfplumber.open(file_path) as pdf:
            for page in pdf.pages:
                tables = page.extract_tables() or []
                for table in tables:
                    if not table or len(table[0]) > 6 or len(table) > 10:
                        continue
                    header_row = table[0]
                    data_rows = table[1:]
                    if not data_rows:
                        for cell in header_row:
                            if cell and "\n" in str(cell):
                                parts = str(cell).split("\n", 1)
                                label, value = parts[0].strip(), parts[1].strip()
                                if label and value:
                                    augmented.append(f"{label}: {value}")
                    else:
                        for data_row in data_rows:
                            for header, value in zip(header_row, data_row):
                                h = str(header or "").strip()
                                v = str(value or "").strip()
                                if h and v and h.upper() != v.upper():
                                    augmented.append(f"{h}: {v}")

        if augmented:
            return raw_text + "\n\n" + "\n".join(augmented)
    except Exception as exc:
        logger.debug("_augment_with_tables: %s", exc)

    return raw_text


# ── JSON parsing ───────────────────────────────────────────────────────────────

def _parse_claude_json(raw: str) -> dict:
    """
    Parse Claude's JSON response robustly.

    Claude occasionally wraps JSON in markdown code fences despite instructions.
    This strips them before parsing.
    """
    text = raw.strip()

    # Strip markdown code fences
    if text.startswith("```"):
        lines = text.splitlines()
        # Remove first line (```json or ```) and last line (```)
        inner_lines = []
        started = False
        for line in lines:
            if not started and line.startswith("```"):
                started = True
                continue
            if started and line.strip() == "```":
                break
            if started:
                inner_lines.append(line)
        text = "\n".join(inner_lines).strip()

    try:
        fields = json.loads(text)
    except json.JSONDecodeError:
        # Last resort: find the first { ... } block
        import re
        m = re.search(r'\{.*\}', text, re.DOTALL)
        if m:
            try:
                fields = json.loads(m.group(0))
            except json.JSONDecodeError:
                logger.error("_parse_claude_json: could not parse response: %s", raw[:200])
                return {}
        else:
            logger.error("_parse_claude_json: no JSON found in response: %s", raw[:200])
            return {}

    # Normalise null / empty string values
    cleaned: dict = {}
    for k, v in fields.items():
        if v is None or v == "" or v == "null":
            cleaned[k] = None
        else:
            cleaned[k] = v

    return cleaned


# ── Regex fallback ────────────────────────────────────────────────────────────

def _run_regex_fallback(doc, start: float) -> tuple[str, dict]:
    """Fall back to the original regex-based extractor."""
    from apps.documents.ocr.tasks_ocr import _ocr_tesseract_v2, _extract_raw_text as _raw
    from apps.documents.ocr.extractor import extract_document_fields

    mime = doc.file_mime_type or ""
    file_path = doc.file.path

    if doc.is_scanned or mime.startswith("image/"):
        text, quality_meta = _ocr_tesseract_v2(doc)
    else:
        text = _extract_raw_text(file_path, mime)
        quality_meta = {}

    from apps.documents.ocr.tasks_ocr import _extract_pdf_tables_as_text
    if mime == "application/pdf" and not doc.is_scanned:
        table_text = _extract_pdf_tables_as_text(file_path)
        if table_text:
            text = text + "\n\n" + table_text

    fields = extract_document_fields(text)
    elapsed = round(time.monotonic() - start, 2)

    quality = {
        "engine":              "regex",
        "model":               None,
        "confidence":          "medium",
        "low_quality_warning": quality_meta.get("low_quality_warning", False),
        "processing_time_s":   elapsed,
        "prompt_version":      None,
        **({"mean_confidence": quality_meta["mean_confidence"]} if quality_meta.get("mean_confidence") else {}),
        **({"overall_quality_ratio": quality_meta["overall_quality_ratio"]} if quality_meta.get("overall_quality_ratio") else {}),
    }

    return text, {
        "ocr_suggestions": {
            "fields":  fields,
            "quality": quality,
        }
    }