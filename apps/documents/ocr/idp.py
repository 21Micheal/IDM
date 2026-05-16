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

import json
import logging
import time

logger = logging.getLogger(__name__)

# ── Field extraction prompt ────────────────────────────────────────────────────
# Versioned so we can A/B test prompt changes without code deploys.

_PROMPT_VERSION = "3"

_SYSTEM_PROMPT = """You are a precise document field extraction engine for an enterprise document management system. Your job is to extract structured data from business documents with high accuracy.

You will receive either:
- A document image (scanned or rendered PDF page)
- Extracted text from a PDF with layout information

Return ONLY a valid JSON object. No explanation, no markdown code fences, no preamble."""

_STANDARD_FIELDS: dict[str, str] = {
    "document_type": "Exact document type as it appears, e.g. Invoice, Tax Invoice, Purchase Order, Receipt, Contract, Delivery Note, Quotation, Credit Note, Debit Note, Utility Bill, or Statement.",
    "title": "A clean document title for a document management system. Combine supplier, document type, and reference when possible. Max 120 chars. Do not use address lines or column headers.",
    "supplier": "Company or person ISSUING the document: seller, vendor, supplier, or service provider. Not the bill-to party.",
    "reference_number": "Primary identifier belonging to this document: invoice number, PO number, order reference, contract number, receipt number, or delivery number. Strip leading #.",
    "account_code": "Supplier account code, GL code, cost centre code, customer code, or alphanumeric accounting reference assigned to this transaction.",
    "document_date": "Issue/invoice/document date in YYYY-MM-DD. If only month and year are present, use the first day of that month.",
    "due_date": "Payment due date, expiry date, or required-by date in YYYY-MM-DD.",
    "amount": "Final total amount due after tax as a plain decimal number. No currency symbols, commas, or spaces.",
    "currency": "ISO 4217 currency code: USD, EUR, GBP, KES, UGX, TZS, NGN, ZAR, etc. Infer from symbols or context.",
    "tax_amount": "VAT, GST, sales tax, or tax amount as a plain decimal number.",
    "subtotal": "Pre-tax subtotal/net amount as a plain decimal number.",
    "payment_terms": "Payment terms text, e.g. Net 30, Due on receipt.",
    "payment_method": "Payment method if specified: Cash, Cheque, Bank Transfer, M-PESA, Wire Transfer, Card, etc.",
    "transaction_ref": "Payment transaction reference, M-PESA code, cheque number, card/wire/reference number.",
    "po_reference": "Purchase order reference number if this document references a separate PO.",
    "vendor_code": "Vendor or supplier ID code assigned by the buyer.",
    "approved_by": "Name of the person who approved or authorized this document.",
    "kra_pin": "Kenya Revenue Authority PIN, e.g. P051234567A.",
    "vat_number": "VAT, tax registration, GST, or sales tax registration number.",
    "bank_details": "Bank name and account/payment remittance details if present.",
}


def _document_type_context(doc) -> dict:
    doc_type = getattr(doc, "document_type", None)
    if not doc_type:
        return {"name": "", "code": "", "metadata_fields": []}

    metadata_fields = []
    for field in doc_type.metadata_fields.all().order_by("order", "label"):
        metadata_fields.append({
            "key": field.key,
            "label": field.label,
            "type": field.field_type,
            "required": field.is_required,
            "help_text": field.help_text,
            "select_options": field.select_options or [],
        })

    return {
        "name": doc_type.name,
        "code": doc_type.code,
        "metadata_fields": metadata_fields,
    }


def _build_extraction_prompt(doc) -> str:
    context = _document_type_context(doc)
    standard_schema = {
        **{key: None for key in _STANDARD_FIELDS},
        "confidence": "high | medium | low",
        "low_quality_warning": False,
    }
    custom_schema = {
        field["key"]: None for field in context["metadata_fields"]
        if field.get("key")
    }
    custom_instructions = "\n".join(
        _format_custom_field_instruction(field)
        for field in context["metadata_fields"]
        if field.get("key")
    ) or "- No admin-defined custom metadata fields for this document type."

    return f"""Extract structured fields from this document. Return ONLY a valid JSON object.

DOCUMENT TYPE CONFIGURATION:
Name: {context["name"] or "Unknown"}
Code: {context["code"] or "Unknown"}

STANDARD FIELD DEFINITIONS:
{json.dumps(_STANDARD_FIELDS, indent=2)}

ADMIN-DEFINED METADATA FIELDS:
{custom_instructions}

RETURN SHAPE:
{json.dumps({
    "fields": standard_schema,
    "custom_fields": custom_schema,
}, indent=2)}

STRICT RULES:
1. Set any field to null if not clearly present. Never guess or invent values.
2. Also fill custom_fields using the exact admin field keys shown above.
3. If a custom field overlaps a standard field, return the same value in both places.
4. supplier = the ISSUING party, not the bill-to/customer/recipient.
5. amount = the FINAL total after tax. Do not use subtotal unless no total is present.
6. Numbers and currency amounts must be plain decimals only: no symbols, commas, or spaces.
7. Dates must be YYYY-MM-DD. Never return ambiguous formats like 10/25/2024.
8. For select fields, use one of the configured options when the document clearly supports it; otherwise null.
9. For blurry, skewed, cropped, or otherwise poor-quality scans, set low_quality_warning to true.
10. confidence must be "high", "medium", or "low".

Return ONLY the JSON object. Nothing else."""


def _format_custom_field_instruction(field: dict) -> str:
    instruction = (
        f'- "{field["key"]}" ({field["type"]}, label: "{field["label"]}")'
    )
    if field.get("help_text"):
        instruction += f' - {field["help_text"]}'
    if field.get("select_options"):
        instruction += f' Options: {field["select_options"]}'
    return instruction


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
        api_key = getattr(django_settings, "ANTHROPIC_API_KEY", "").strip()
        if not api_key:
            # Should not normally reach here (run_ocr guards this),
            # but handle defensively just in case.
            raise RuntimeError("ANTHROPIC_API_KEY not set")

        mime = doc.file_mime_type or ""
        file_path = doc.file.path

        # Determine effective engine
        if engine_setting == "auto":
            engine = _detect_engine(file_path, mime)
        elif engine_setting == "claude_vision":
            engine = "claude_vision"
        else:
            engine = "claude_text"

        extraction_prompt = _build_extraction_prompt(doc)
        if engine == "claude_vision":
            fields, raw_text = _extract_via_vision(
                file_path, mime, api_key, django_settings, extraction_prompt
            )
        else:
            fields, raw_text = _extract_via_text(
                file_path, mime, api_key, django_settings, extraction_prompt
            )

    except Exception as exc:
        logger.error("idp.run_idp: Claude extraction failed for %s: %s — delegating to local pipeline", doc.id, exc)
        from apps.documents.ocr.tasks_ocr import _run_local_pipeline
        return _run_local_pipeline(doc)

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
        "confidence":          fields.pop("confidence", None) or "medium",
        "low_quality_warning": _as_bool(fields.pop("low_quality_warning", False)),
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
        from apps.documents.ocr.tasks_ocr import is_sparse_pdf
        return "claude_vision" if is_sparse_pdf(file_path) else "claude_text"

    # Non-PDF, non-image (DOCX, XLSX) → text mode
    return "claude_text"


# ── Vision extraction path ─────────────────────────────────────────────────────

def _extract_via_vision(
    file_path: str,
    mime: str,
    api_key: str,
    settings,
    extraction_prompt: str,
) -> tuple[dict, str]:
    """
    Render document pages to images and send to Claude Vision.
    Returns (fields_dict, raw_text_for_storage).
    """
    import anthropic
    from apps.documents.ocr.tasks_ocr import render_doc_to_images

    model = getattr(settings, "OCR_IDP_MODEL", "claude-haiku-4-5")
    dpi = int(getattr(settings, "OCR_IDP_VISION_DPI", 150))
    timeout = int(getattr(settings, "OCR_IDP_TIMEOUT", 60))
    max_pages = int(getattr(settings, "OCR_IDP_MAX_PAGES", 3))

    pages_b64 = render_doc_to_images(file_path, mime, dpi=dpi, max_pages=max_pages)
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
    content.append({"type": "text", "text": extraction_prompt})

    client = anthropic.Anthropic(api_key=api_key, timeout=timeout)
    response = client.messages.create(
        model=model,
        max_tokens=2048,
        system=_SYSTEM_PROMPT,
        messages=[{"role": "user", "content": content}],
    )

    raw_json = response.content[0].text.strip()
    fields = _normalise_claude_fields(_parse_claude_json(raw_json))

    # Extract raw text for full-text search storage
    raw_text = _extract_raw_text(file_path, mime)

    return fields, raw_text


# ── Text extraction path ───────────────────────────────────────────────────────

def _extract_via_text(
    file_path: str,
    mime: str,
    api_key: str,
    settings,
    extraction_prompt: str,
) -> tuple[dict, str]:
    """
    Extract text from PDF with spatial augmentation and send to Claude as text.
    Returns (fields_dict, raw_text_for_storage).
    """
    import anthropic
    from apps.documents.ocr.tasks_ocr import _extract_pdf_tables_as_text

    model = getattr(settings, "OCR_IDP_MODEL", "claude-haiku-4-5")
    timeout = int(getattr(settings, "OCR_IDP_TIMEOUT", 60))

    raw_text = _extract_raw_text(file_path, mime)

    # Augment with table-derived labelled lines (same helper used by local pipeline)
    table_text = _extract_pdf_tables_as_text(file_path) if mime == "application/pdf" else ""
    augmented_text = raw_text + (("\n\n" + table_text) if table_text else "")

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
        max_tokens=2048,
        system=_SYSTEM_PROMPT,
        messages=[{
            "role": "user",
            "content": f"{document_context}\n\n{extraction_prompt}",
        }],
    )

    raw_json = response.content[0].text.strip()
    fields = _normalise_claude_fields(_parse_claude_json(raw_json))

    return fields, raw_text


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


def _as_bool(value) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        return value.strip().lower() in {"1", "true", "yes", "y"}
    return bool(value)


def _normalise_claude_fields(parsed: dict) -> dict:
    """
    Accept both prompt v3's nested response and older flat JSON responses.

    Prompt v3 asks Claude for:
        {"fields": {...}, "custom_fields": {...}}

    The rest of the OCR pipeline expects one flat suggestions dict, so custom
    metadata keys are merged into the same dict. Quality keys stay top-level
    for run_idp() to pop into the quality block.
    """
    if not isinstance(parsed, dict):
        return {}

    fields = parsed.get("fields")
    custom_fields = parsed.get("custom_fields")
    if isinstance(fields, dict) or isinstance(custom_fields, dict):
        merged: dict = {}
        if isinstance(fields, dict):
            merged.update(fields)
        if isinstance(custom_fields, dict):
            merged.update(custom_fields)

        for key in ("confidence", "low_quality_warning"):
            if key in parsed and key not in merged:
                merged[key] = parsed[key]
        return {
            key: value
            for key, value in merged.items()
            if value is not None and value != "" and value != "null"
        }

    return parsed
