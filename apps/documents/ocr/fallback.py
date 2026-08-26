"""Persist regex fallback extraction results onto a Document row."""
from __future__ import annotations

from decimal import Decimal, InvalidOperation

from django.utils.dateparse import parse_date

from apps.documents.models import OCRStatus
from apps.documents.ocr.idp_policy import should_promote_suggestions
from apps.documents.ocr.tasks_ocr import run_regex_fallback


def apply_document_regex_fallback(document, *, reason: str = "user_opt_in"):
    """Run pattern-matching extraction and update the document in place."""
    result = run_regex_fallback(document, reason=reason)
    current_metadata = document.metadata or {}
    updated_metadata = {**current_metadata, **result.metadata_updates}
    ocr_block = result.metadata_updates.get("ocr_suggestions") or {}
    suggested = ocr_block.get("fields", {}) if isinstance(ocr_block, dict) else {}
    quality = ocr_block.get("quality") if isinstance(ocr_block, dict) else {}

    update_kwargs = {
        "extracted_text": result.text[:1_000_000],
        "ocr_status": OCRStatus.DONE,
        "metadata": updated_metadata,
    }

    if should_promote_suggestions(quality):
        if not document.title and suggested.get("title"):
            update_kwargs["title"] = str(suggested.get("title"))[:255]
        if (not document.supplier or str(document.supplier).strip() == "") and suggested.get("supplier"):
            update_kwargs["supplier"] = str(suggested.get("supplier"))[:255]
        if (document.amount is None or document.amount == "") and suggested.get("amount") is not None:
            try:
                update_kwargs["amount"] = Decimal(str(suggested.get("amount")))
            except (InvalidOperation, TypeError, ValueError):
                pass
        if (not document.currency or str(document.currency).strip() == "") and suggested.get("currency"):
            update_kwargs["currency"] = str(suggested.get("currency"))[:3]
        if (not document.document_date) and suggested.get("document_date"):
            parsed = parse_date(str(suggested.get("document_date")))
            if parsed:
                update_kwargs["document_date"] = parsed
        if (not document.due_date) and suggested.get("due_date"):
            parsed = parse_date(str(suggested.get("due_date")))
            if parsed:
                update_kwargs["due_date"] = parsed
        if (
            (not document.reference_number or str(document.reference_number).strip() == "")
            and suggested.get("reference_number")
        ):
            update_kwargs["reference_number"] = str(suggested.get("reference_number"))[:60]

    type(document).objects.filter(id=document.id).update(**update_kwargs)
    document.refresh_from_db()
    return document
