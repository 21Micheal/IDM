from __future__ import annotations

import logging
import re
from typing import Any

from django.db.models import Q

from .models import Document, DocumentRelationship

logger = logging.getLogger(__name__)

PO_REFERENCE_KEYS = {
    "po_reference",
    "po_ref",
    "purchase_order_reference",
    "purchase_order_ref",
    "purchase_order_number",
    "po_number",
    "po_no",
    "lpo_number",
    "lpo_no",
}

OWN_REFERENCE_KEYS = {
    "reference_number",
    "document_number",
    "po_number",
    "po_no",
    "purchase_order_number",
    "purchase_order_reference",
    "purchase_order_ref",
    "lpo_number",
    "lpo_no",
}

SUGGESTION_METADATA_KEY = "relationship_suggestions"
AUTO_MATCH_NOTE_PREFIX = "Matched PO reference"


def normalize_business_reference(value: Any) -> str:
    if value in (None, ""):
        return ""
    return re.sub(r"[^A-Z0-9]", "", str(value).upper())


def _metadata_fields(metadata: dict[str, Any]) -> dict[str, Any]:
    ocr_block = metadata.get("ocr_suggestions")
    if isinstance(ocr_block, dict):
        fields = ocr_block.get("fields")
        if isinstance(fields, dict):
            return fields
        return ocr_block
    return {}


def _normalize_metadata_key(key: Any) -> str:
    return re.sub(r"[^a-z0-9]+", "_", str(key).lower()).strip("_")


def _collect_values(doc: Document, keys: set[str], *, include_system_reference: bool = False) -> list[str]:
    metadata = doc.metadata or {}
    sources = [metadata, _metadata_fields(metadata)]
    values: list[str] = []

    for source in sources:
        normalized_source = {
            _normalize_metadata_key(key): value
            for key, value in source.items()
        }
        for key in keys:
            value = normalized_source.get(key)
            if value in (None, ""):
                continue
            if isinstance(value, (list, tuple, set)):
                values.extend(str(item).strip() for item in value if str(item).strip())
            else:
                values.append(str(value).strip())

    if include_system_reference and doc.reference_number:
        values.append(str(doc.reference_number).strip())

    seen: set[str] = set()
    deduped: list[str] = []
    for value in values:
        normalized = normalize_business_reference(value)
        if normalized and normalized not in seen:
            seen.add(normalized)
            deduped.append(value)
    return deduped


def _document_text(doc: Document) -> str:
    document_type_name = getattr(getattr(doc, "document_type", None), "name", "") or ""
    return " ".join(
        part.lower()
        for part in (document_type_name, doc.title or "", doc.file_name or "")
        if part
    )


def is_purchase_order_document(doc: Document) -> bool:
    text = _document_text(doc)
    return (
        "purchase order" in text
        or "local purchase order" in text
        or re.search(r"\blpo\b", text) is not None
        or re.search(r"\bpo\b", text) is not None
    )


def is_po_referencing_document(doc: Document) -> bool:
    text = _document_text(doc)
    if any(term in text for term in ("invoice", "grn", "goods received", "goods receipt", "delivery note")):
        return True
    return bool(get_document_po_references(doc))


def get_document_po_references(doc: Document) -> list[str]:
    return _collect_values(doc, PO_REFERENCE_KEYS)


def get_purchase_order_numbers(doc: Document) -> list[str]:
    return _collect_values(doc, OWN_REFERENCE_KEYS, include_system_reference=True)


def _candidate_purchase_orders(doc: Document):
    candidates: list[Document] = []
    if doc.bulk_upload_id:
        candidates = list(
            Document.objects
            .select_related("document_type", "uploaded_by")
            .filter(bulk_upload_id=doc.bulk_upload_id)
            .exclude(id=doc.id)
            .exclude(status="void")
            .exclude(document_type__code="UNCLASS")
        )

    qs = (
        Document.objects
        .select_related("document_type", "uploaded_by")
        .exclude(id=doc.id)
        .exclude(status="void")
        .exclude(document_type__code="UNCLASS")
        .filter(is_self_upload=False)
        .filter(
            Q(document_type__name__icontains="purchase")
            | Q(document_type__name__icontains="order")
            | Q(document_type__name__icontains="lpo")
            | Q(title__icontains="purchase order")
            | Q(title__icontains="lpo")
            | Q(file_name__icontains="purchase order")
            | Q(file_name__icontains="lpo")
        )
        .order_by("-created_at")[:500]
    )
    known_ids = {candidate.id for candidate in candidates}
    candidates.extend(candidate for candidate in qs if candidate.id not in known_ids)

    return [candidate for candidate in candidates if is_purchase_order_document(candidate)]


def _suggestions_for_referencing_document(doc: Document) -> list[dict[str, Any]]:
    references = get_document_po_references(doc)
    normalized_references = {
        normalize_business_reference(reference): reference
        for reference in references
        if normalize_business_reference(reference)
    }
    if not normalized_references:
        return []

    suggestions: list[dict[str, Any]] = []
    seen_targets: set[str] = set()
    seen_matched_references: set[str] = set()
    for candidate in _candidate_purchase_orders(doc):
        candidate_refs = get_purchase_order_numbers(candidate)
        for candidate_ref in candidate_refs:
            normalized = normalize_business_reference(candidate_ref)
            if not normalized or normalized not in normalized_references:
                continue
            if normalized in seen_matched_references:
                continue
            target_id = str(candidate.id)
            if target_id in seen_targets:
                continue
            seen_targets.add(target_id)
            seen_matched_references.add(normalized)
            suggestions.append(
                {
                    "target_document_id": target_id,
                    "target_title": candidate.title,
                    "target_reference_number": candidate.reference_number,
                    "target_document_type": getattr(candidate.document_type, "name", "") or "Document",
                    "relation_type": DocumentRelationship.RelationType.REFERENCES,
                    "matched_reference": normalized_references[normalized],
                    "matched_purchase_order_number": candidate_ref,
                    "reason": "PO reference matched a purchase order number.",
                    "auto_created": False,
                    "relationship_id": None,
                }
            )
            break

    return suggestions


def _create_relationship_from_suggestion(
    *,
    source: Document,
    suggestion: dict[str, Any],
    created_by,
    auto_create: bool,
) -> dict[str, Any]:
    if not auto_create:
        return suggestion
    try:
        target = Document.objects.get(id=suggestion["target_document_id"])
    except Document.DoesNotExist:
        return suggestion

    relationship, _ = DocumentRelationship.objects.get_or_create(
        source_document=source,
        target_document=target,
        relation_type=DocumentRelationship.RelationType.REFERENCES,
        defaults={
            "note": f"{AUTO_MATCH_NOTE_PREFIX} {suggestion.get('matched_reference')}.",
            "created_by": created_by or source.uploaded_by,
        },
    )
    suggestion["auto_created"] = True
    suggestion["relationship_id"] = str(relationship.id)
    return suggestion


def cleanup_unclassified_relationships(*, bulk_upload_id=None) -> int:
    """
    Remove relationship records created while related-batch documents still had
    the temporary UNCLASS type.

    These are system-generated PO-reference matches, so the cleanup is scoped to
    auto-match notes and relationships where either side is still UNCLASS.
    """
    qs = DocumentRelationship.objects.filter(
        Q(source_document__document_type__code="UNCLASS")
        | Q(target_document__document_type__code="UNCLASS")
    )
    if bulk_upload_id:
        qs = qs.filter(
            Q(source_document__bulk_upload_id=bulk_upload_id)
            | Q(target_document__bulk_upload_id=bulk_upload_id)
        )
    qs = qs.filter(note__startswith=AUTO_MATCH_NOTE_PREFIX)
    count, _ = qs.delete()
    return count


def _relationship_matched_reference(relationship: DocumentRelationship) -> str:
    note = relationship.note or ""
    if note.startswith(AUTO_MATCH_NOTE_PREFIX):
        return normalize_business_reference(note.removeprefix(AUTO_MATCH_NOTE_PREFIX).strip(" .:-"))
    refs = get_purchase_order_numbers(relationship.target_document)
    return normalize_business_reference(refs[0]) if refs else ""


def cleanup_duplicate_auto_po_relationships(*, bulk_upload_id=None) -> int:
    """
    If duplicate PO documents share the same business PO number, keep one
    auto-created link per source document and PO reference.
    """
    qs = (
        DocumentRelationship.objects
        .filter(
            relation_type=DocumentRelationship.RelationType.REFERENCES,
            note__startswith=AUTO_MATCH_NOTE_PREFIX,
        )
        .select_related(
            "source_document",
            "target_document",
            "target_document__document_type",
        )
        .order_by("created_at")
    )
    if bulk_upload_id:
        qs = qs.filter(
            Q(source_document__bulk_upload_id=bulk_upload_id)
            | Q(target_document__bulk_upload_id=bulk_upload_id)
        )

    grouped: dict[tuple[str, str], list[DocumentRelationship]] = {}
    for relationship in qs:
        matched_reference = _relationship_matched_reference(relationship)
        if not matched_reference:
            continue
        grouped.setdefault((str(relationship.source_document_id), matched_reference), []).append(relationship)

    delete_ids: list[str] = []
    for relationships in grouped.values():
        if len(relationships) <= 1:
            continue
        source_bulk_id = relationships[0].source_document.bulk_upload_id
        relationships.sort(
            key=lambda relationship: (
                relationship.target_document.bulk_upload_id != source_bulk_id,
                relationship.target_document.document_type.code == "UNCLASS",
                relationship.created_at,
            )
        )
        delete_ids.extend(str(relationship.id) for relationship in relationships[1:])

    if not delete_ids:
        return 0
    count, _ = DocumentRelationship.objects.filter(id__in=delete_ids).delete()
    return count


def refresh_po_relationship_suggestions(
    doc: Document,
    *,
    actor=None,
    auto_create_same_batch: bool = False,
) -> list[dict[str, Any]]:
    """
    Refresh assisted PO link suggestions for invoices/GRNs.

    Exact same-batch matches can be auto-linked, which covers bulk uploads where
    a PO, invoice, and GRN arrive together. Cross-batch matches remain
    suggestions so users can confirm the relationship in the detail page.
    """
    try:
        doc = Document.objects.select_related("document_type", "uploaded_by").get(id=doc.id)
    except Document.DoesNotExist:
        return []

    if getattr(doc.document_type, "code", "") == "UNCLASS":
        cleanup_unclassified_relationships(bulk_upload_id=doc.bulk_upload_id)
        metadata = dict(doc.metadata or {})
        if metadata.get(SUGGESTION_METADATA_KEY):
            metadata[SUGGESTION_METADATA_KEY] = []
            Document.objects.filter(id=doc.id).update(metadata=metadata)
        return []

    if not is_po_referencing_document(doc):
        metadata = dict(doc.metadata or {})
        if metadata.get(SUGGESTION_METADATA_KEY):
            metadata[SUGGESTION_METADATA_KEY] = []
            Document.objects.filter(id=doc.id).update(metadata=metadata)
        return []

    suggestions = _suggestions_for_referencing_document(doc)
    refreshed: list[dict[str, Any]] = []
    for suggestion in suggestions:
        should_auto_create = (
            auto_create_same_batch
            and doc.bulk_upload_id
            and Document.objects.filter(
                id=suggestion["target_document_id"],
                bulk_upload_id=doc.bulk_upload_id,
            ).exists()
        )
        refreshed.append(
            _create_relationship_from_suggestion(
                source=doc,
                suggestion=suggestion,
                created_by=actor,
                auto_create=should_auto_create,
            )
        )

    metadata = dict(doc.metadata or {})
    metadata[SUGGESTION_METADATA_KEY] = refreshed
    Document.objects.filter(id=doc.id).update(metadata=metadata)
    return refreshed
