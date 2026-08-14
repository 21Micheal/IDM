"""
apps/documents/ocr/idp.py

Intelligent Document Processing (IDP) using Anthropic Claude.

This module replaces the regex-based _extract_ocr_suggestions() / extractor.py
with a vision-language model that understands document structure semantically.

Architecture
────────────
                        ┌─────────────────────────────┐
  PDF (native text) ───►│ pdfplumber → structured text │
                        │ + table augmentation          │──► LLM text mode
                        └─────────────────────────────┘         │
                                                                 ▼
  PDF (scanned) ────────► pypdfium2 render → JPEG ─────► LLM vision mode
                                                                 │
  Image upload ─────────────────────────────────────────►        │
                                                                 ▼
                                                    Structured JSON fields
                                                                 │
                                                                 ▼
                                              Merge into Document.metadata
                                              + update top-level model fields

Why LLM/VLM extraction instead of local-only heuristics
──────────────────────────────────────────────────────────────────────
• Local transformer models require GPU for acceptable inference speed.
  On CPU, LayoutLMv3 takes 30–60 s per page — unacceptable for a Celery task.
• Local models require fine-tuning per document type to reach production accuracy.
• Vision-language models understand document semantics: they can infer that
  "Velocity Logistics Solutions" is the supplier because it sits under the
  SUPPLIER column header — not because it matched a regex pattern.
• claude-haiku-4-5 is ~$0.0004/page. At 500 docs/day = ~$6/day.
• Graceful fallback: if Claude is unavailable, the PDF text extractor still runs.

Engine selection
────────────────
IDP_PROVIDER selects Anthropic or the non-LLM fallback, while OCR_IDP_ENGINE
controls the extraction path:

  "vision"         → Render PDF/images and send images to the configured model
                     Best for: scanned docs, complex layouts, mixed content
                     Model: claude-haiku-4-5 (fast+cheap) or claude-sonnet-4-6

  "text"           → Extract text with pdfplumber (spatially augmented),
                     send text to the configured model
                     Best for: native digital PDFs
                     Model: claude-haiku-4-5

  "auto"           → Detect: sparse text → vision mode, dense text → text mode
                     Recommended default

  "regex"          → Local OCR/regex pipeline (fallback, no API cost)

Django settings
───────────────
IDP_PROVIDER             "anthropic" | "regex"
ANTHROPIC_API_KEY        Required for IDP_PROVIDER=anthropic.
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
import re
import time

logger = logging.getLogger(__name__)

# ── Field extraction prompt ────────────────────────────────────────────────────
# Versioned so we can A/B test prompt changes without code deploys.

_PROMPT_VERSION = "6"

_SYSTEM_PROMPT = """You are a precise document field extraction engine for an enterprise document management system. Your job is to extract structured data from business documents with high accuracy.

You will receive either:
- A document image (scanned or rendered PDF page)
- Extracted text from a PDF with layout information

Return ONLY a valid JSON object. No explanation, no markdown code fences, no preamble."""

_STANDARD_FIELDS: dict[str, str] = {
    "document_type": "Exact document type as it appears, e.g. Invoice, Tax Invoice, Purchase Order, Receipt, Contract, Delivery Note, Quotation, Credit Note, Debit Note, Utility Bill, or Statement.",
    "title": "A clean document title for a document management system. Combine supplier, document type, and reference when possible. Max 120 chars. Do not use address lines or column headers.",
    "supplier": "Company or person ISSUING the document: seller, vendor, supplier, or service provider. Not the bill-to party.",
    "reference_number": "Primary identifier belonging to this document itself: invoice number for an invoice, GRN/goods receipt number for a goods receipt, PO/order number for a purchase order, contract number for a contract, receipt number for a receipt, or delivery number for a delivery note. Strip leading #.",
    "account_code": "Only an explicit account/customer/GL/cost-centre code labelled on the document. Return null unless a nearby label such as Account Code, Account No, Customer Code, GL Code, Cost Centre, or Supplier Account clearly identifies it. Do not infer this from invoice numbers, PO numbers, vendor names, addresses, tax IDs, phone numbers, bank accounts, or arbitrary alphanumeric strings.",
    "document_date": "Issue/invoice/document date in YYYY-MM-DD. If only month and year are present, use the first day of that month.",
    "due_date": "Payment due date, expiry date, or required-by date in YYYY-MM-DD.",
    "amount": "Final total amount due after tax as a plain decimal number. No currency symbols, commas, or spaces.",
    "currency": "ISO 4217 currency code: USD, EUR, GBP, KES, UGX, TZS, NGN, ZAR, etc. Infer from symbols or context.",
    "tax_amount": "VAT, GST, sales tax, or tax amount as a plain decimal number.",
    "subtotal": "Pre-tax subtotal/net amount as a plain decimal number.",
    "payment_terms": "Payment terms text, e.g. Net 30, Due on receipt.",
    "payment_method": "Payment method if specified: Cash, Cheque, Bank Transfer, M-PESA, Wire Transfer, Card, etc.",
    "transaction_ref": "Payment transaction reference only: M-PESA code, cheque number, card/wire/payment/confirmation number. Do not use invoice numbers, GRN numbers, or PO numbers here unless the nearby label explicitly says transaction/payment/confirmation.",
    "po_reference": "Purchase order reference number when this document references a PO. On invoices, GRNs, delivery notes, and receipts, a visible label like PO Number or PO Ref belongs here, not in reference_number.",
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
1. Extract every visible labelled field that is present on the document, even if overall scan quality is only medium.
2. Set a field to null only when it is not visible, not labelled/identifiable, or truly unreadable. Do not omit visible labels such as PO Number, Supplier, Transaction Reference, Invoice Date, Delivery Date, or GRN Date.
3. Do not guess hidden values, but do return a visible candidate value when the nearby label identifies the field. Use low_quality_warning/confidence to flag uncertainty instead of dropping visible fields.
4. account_code requires an explicit nearby account/customer/GL/cost-centre label. If the document lacks that label, account_code must be null.
5. Do not reuse reference_number, po_reference, vendor_code, vat_number, kra_pin, bank_details, phone numbers, addresses, or line-item codes as account_code.
6. Populate every admin-defined custom_fields key when the document shows a labelled value that matches that field's label or purpose. Example: label "Goods Receipt note number" → custom_fields.goods_receipt_note_number with the GRN number from the document.
7. Admin-defined metadata fields take priority over generic standard fields when both could apply. You may duplicate the same visible value in custom_fields and a standard field when both are configured.
8. If a custom field overlaps a standard field, return the same value in both places, but only when the value is clearly present.
9. supplier = the ISSUING party, not the bill-to/customer/recipient.
10. amount = the FINAL total after tax. Do not use subtotal unless no total is present.
11. Numbers and currency amounts must be plain decimals only: no symbols, commas, or spaces.
12. Dates must be YYYY-MM-DD. Never return ambiguous formats like 10/25/2024.
13. For select fields, use one of the configured options when the document clearly supports it; otherwise null.
14. For blurry, skewed, cropped, or otherwise poor-quality scans, set low_quality_warning to true.
15. confidence must be "high", "medium", or "low".
16. For invoices and GRNs, keep the document's own number in reference_number AND in any admin field whose label describes that same number (e.g. GRN number, goods receipt note number). Put PO Number/PO Ref in po_reference. Do not swap them.
17. transaction_ref is only for payment/transaction identifiers. A PO Number is not a transaction_ref.

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


def _claude_model(settings) -> str:
    return getattr(settings, "OCR_IDP_MODEL", "claude-haiku-4-5")


def _engine_mode(engine_setting: str, file_path: str, mime: str) -> str:
    engine_setting = (engine_setting or "auto").lower()
    if engine_setting in {"vision", "claude_vision"}:
        return "vision"
    if engine_setting in {"text", "claude_text"}:
        return "text"
    if mime.startswith("image/"):
        return "vision"
    if mime == "application/pdf":
        from apps.documents.ocr.tasks_ocr import is_sparse_pdf
        return "vision" if is_sparse_pdf(file_path) else "text"
    return "text"


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
    provider = "anthropic"
    start = time.monotonic()

    mime = doc.file_mime_type or ""
    file_path = doc.file.path
    mode = _engine_mode(engine_setting, file_path, mime)
    engine = f"claude_{mode}"
    extraction_prompt = _build_extraction_prompt(doc)

    if mode == "vision":
        fields, raw_text = _extract_via_vision(
            file_path, mime, django_settings, extraction_prompt
        )
    else:
        fields, raw_text = _extract_via_text(
            file_path, mime, django_settings, extraction_prompt
        )

    elapsed = round(time.monotonic() - start, 2)

    # ── Build metadata updates ────────────────────────────────────────────────
    model = _claude_model(django_settings)

    fields = _clean_extracted_fields(fields)
    fields = _fill_admin_metadata_fields(doc, fields)

    quality = {
        "engine":              engine,
        "provider":            provider,
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
        "idp.run_idp: doc=%s provider=%s engine=%s model=%s confidence=%s time=%.2fs fields=%s",
        doc.id, provider, engine, model, quality["confidence"], elapsed,
        [k for k, v in fields.items() if v is not None and k != "raw_lines"],
    )

    return raw_text, metadata_updates

# ── Vision extraction path ─────────────────────────────────────────────────────


def _call_anthropic_vision(settings, model: str, pages_b64: list[tuple[str, str]], prompt: str) -> str:
    import anthropic

    api_key = getattr(settings, "ANTHROPIC_API_KEY", "").strip()
    if not api_key:
        raise RuntimeError("ANTHROPIC_API_KEY is not set")

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
    content.append({"type": "text", "text": prompt})

    client = anthropic.Anthropic(
        api_key=api_key,
        timeout=int(getattr(settings, "OCR_IDP_TIMEOUT", 60)),
    )
    response = client.messages.create(
        model=model,
        max_tokens=2048,
        system=_SYSTEM_PROMPT,
        messages=[{"role": "user", "content": content}],
    )
    return response.content[0].text.strip()


def classify_document_type(content: bytes, mime: str, filename: str, candidates, *, settings=None):
    """Infer which of ``candidates`` (DocumentType objects) a file best matches.

    Used by email ingestion when a mailbox opts into auto-classification. Returns
    the chosen ``DocumentType`` or ``None`` (unsure / unavailable / non-scannable),
    in which case the caller falls back to the mailbox default or UNCLASS.

    Only PDFs and images are classified — Office formats are filled manually, so
    there is nothing to gain from an LLM round-trip on them.
    """
    import os
    import tempfile

    from django.conf import settings as dj_settings

    settings = settings or dj_settings

    if getattr(settings, "IDP_PROVIDER", "") != "anthropic":
        return None
    if not getattr(settings, "ANTHROPIC_API_KEY", "").strip():
        return None
    if not candidates:
        return None
    scannable = mime == "application/pdf" or mime.startswith("image/")
    if not scannable:
        return None

    catalog = "\n".join(
        f"- {c.code}: {c.name}" + (f" — {c.description}" if c.description else "")
        for c in candidates
    )
    prompt = (
        "Classify this business document into exactly one of the known document "
        "types below, based on its content.\n\n"
        f"DOCUMENT TYPES:\n{catalog}\n\n"
        'Respond with strict JSON only: {"code": "<matching type code, or NONE if unsure>"}.'
    )
    model = _claude_model(settings)

    ext = os.path.splitext(filename)[1] or (".pdf" if mime == "application/pdf" else ".bin")
    path = None
    try:
        with tempfile.NamedTemporaryFile(suffix=ext, delete=False) as tmp:
            tmp.write(content)
            path = tmp.name

        raw = None
        if mime == "application/pdf":
            text = _extract_raw_text(path, mime)
            if text.strip():
                raw = _call_anthropic_text(
                    settings, model, f"DOCUMENT TEXT:\n{text[:8000]}", prompt
                )
        if raw is None:
            # Image, or an image-based PDF with no text layer → vision.
            from apps.documents.ocr.tasks_ocr import render_doc_to_images

            pages = render_doc_to_images(path, mime, dpi=120, max_pages=2)
            if pages:
                raw = _call_anthropic_vision(settings, model, pages, prompt)
        if not raw:
            return None

        code = str(_parse_claude_json(raw).get("code", "")).strip().upper()
        if not code or code == "NONE":
            return None
        for c in candidates:
            if c.code.upper() == code:
                logger.info("classify_document_type: %r -> %s", filename, c.code)
                return c
        return None
    except Exception:  # noqa: BLE001 - classification is best-effort
        logger.exception("classify_document_type failed for %r", filename)
        return None
    finally:
        if path:
            try:
                os.unlink(path)
            except OSError:
                pass


def _call_anthropic_text(settings, model: str, document_context: str, prompt: str) -> str:
    import anthropic

    api_key = getattr(settings, "ANTHROPIC_API_KEY", "").strip()
    if not api_key:
        raise RuntimeError("ANTHROPIC_API_KEY is not set")

    client = anthropic.Anthropic(
        api_key=api_key,
        timeout=int(getattr(settings, "OCR_IDP_TIMEOUT", 60)),
    )
    response = client.messages.create(
        model=model,
        max_tokens=2048,
        system=_SYSTEM_PROMPT,
        messages=[{
            "role": "user",
            "content": f"{document_context}\n\n{prompt}",
        }],
    )
    return response.content[0].text.strip()


def _extract_via_vision(
    file_path: str,
    mime: str,
    settings,
    extraction_prompt: str,
) -> tuple[dict, str]:
    """
    Render document pages to images and send to Claude Vision.
    Returns (fields_dict, raw_text_for_storage).
    """
    from apps.documents.ocr.tasks_ocr import render_doc_to_images

    model = _claude_model(settings)
    dpi = int(getattr(settings, "OCR_IDP_VISION_DPI", 150))
    max_pages = int(getattr(settings, "OCR_IDP_MAX_PAGES", 3))

    pages_b64 = render_doc_to_images(file_path, mime, dpi=dpi, max_pages=max_pages)
    if not pages_b64:
        raise RuntimeError("Could not render any pages from document")

    raw_json = _call_anthropic_vision(settings, model, pages_b64, extraction_prompt)
    fields = _normalise_claude_fields(_parse_claude_json(raw_json))

    # Extract raw text for full-text search storage
    raw_text = _extract_raw_text(file_path, mime)

    return fields, raw_text


# ── Text extraction path ───────────────────────────────────────────────────────

def _extract_via_text(
    file_path: str,
    mime: str,
    settings,
    extraction_prompt: str,
) -> tuple[dict, str]:
    """
    Extract text from PDF with spatial augmentation and send to Claude as text.
    Returns (fields_dict, raw_text_for_storage).
    """
    from apps.documents.ocr.tasks_ocr import _extract_pdf_tables_as_text

    model = _claude_model(settings)

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

    raw_json = _call_anthropic_text(settings, model, document_context, extraction_prompt)
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


def _fill_admin_metadata_fields(doc, fields: dict) -> dict:
    """
    Back-fill admin-defined metadata keys when Claude populated the matching
    standard field but omitted the custom_fields entry.
    """
    filled = dict(fields or {})
    context = _document_type_context(doc)
    label_routes = (
        (("goods receipt", "grn", "gr note", "receipt note", "delivery note number"), "reference_number"),
        (("invoice number", "invoice no", "tax invoice"), "reference_number"),
        (("po number", "purchase order", "lpo", "po ref"), "po_reference"),
        (("transaction ref", "payment ref", "mpesa", "cheque"), "transaction_ref"),
        (("due date", "payment due"), "due_date"),
        (("document date", "invoice date", "issue date", "grn date"), "document_date"),
    )

    for meta_field in context["metadata_fields"]:
        key = meta_field.get("key")
        if not key or filled.get(key):
            continue
        label = (meta_field.get("label") or "").lower()
        for patterns, standard_key in label_routes:
            if any(pattern in label for pattern in patterns):
                value = filled.get(standard_key)
                if value not in (None, "", "null"):
                    filled[key] = value
                break
    return filled


def _clean_extracted_fields(fields: dict) -> dict:
    cleaned = dict(fields or {})
    account_code = cleaned.get("account_code")
    if account_code and not _is_plausible_account_code(str(account_code), cleaned):
        logger.info(
            "idp.run_idp: dropping implausible account_code=%r",
            str(account_code)[:80],
        )
        cleaned.pop("account_code", None)
    return cleaned


def _is_plausible_account_code(value: str, fields: dict) -> bool:
    value_norm = " ".join(str(value or "").split()).strip()
    if not value_norm:
        return False

    comparisons = (
        "supplier",
        "title",
        "reference_number",
        "transaction_ref",
        "po_reference",
        "vendor_code",
        "vat_number",
        "kra_pin",
        "bank_details",
    )
    folded = value_norm.casefold()
    for key in comparisons:
        other = fields.get(key)
        if other and folded == " ".join(str(other).split()).casefold():
            return False

    if re.search(r"\d{10,}", value_norm):
        return False
    if re.search(r"\b(?:ltd|limited|inc|llc|plc|corp|company|partners|enterprises)\b", value_norm, re.I):
        return False
    if re.search(r"[A-Za-z]{2,}\s+[A-Za-z]{2,}", value_norm) and not re.search(r"[\d#/_-]", value_norm):
        return False

    return bool(re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9#/_\-. ]{1,59}", value_norm))
