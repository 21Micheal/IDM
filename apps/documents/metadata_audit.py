"""Helpers for recording human-readable metadata edit diffs in the audit log."""
from __future__ import annotations

from decimal import Decimal
from typing import Any

from apps.documents.serializers import _normalize_personal_tags

DOCUMENT_FIELD_LABELS: dict[str, str] = {
    "title": "Title",
    "supplier": "Supplier",
    "amount": "Amount",
    "currency": "Currency",
    "document_date": "Document date",
    "due_date": "Due date",
}

DOCUMENT_COLUMN_KEYS = frozenset(DOCUMENT_FIELD_LABELS)

# Internal / system metadata keys — not user-facing document details.
SKIP_METADATA_KEYS = frozenset({
    "personal_tags",
    "ocr_suggestions",
    "ocr_quality",
    "relationship_suggestions",
    "form",
    "sunsystems",
})


def _format_scalar(value: Any, *, field_type: str | None = None) -> str:
    if value is None or value == "":
        return ""
    if field_type == "boolean":
        if isinstance(value, str):
            return "Yes" if value.lower() in ("true", "1", "yes") else "No"
        return "Yes" if bool(value) else "No"
    if field_type == "date":
        return str(value)[:10] if value else ""
    if field_type == "currency":
        try:
            amount = Decimal(str(value))
            return f"{amount:.2f}"
        except Exception:
            return str(value)
    if isinstance(value, (list, tuple, set)):
        return ", ".join(str(item) for item in value if str(item).strip())
    if isinstance(value, dict):
        return ""
    return str(value).strip()


def _document_column_value(doc, key: str) -> str:
    raw = getattr(doc, key, None)
    if key == "amount" and raw is not None:
        return _format_scalar(raw, field_type="currency")
    if key in ("document_date", "due_date"):
        return _format_scalar(raw, field_type="date")
    return _format_scalar(raw)


def _metadata_field_defs(doc) -> dict[str, Any]:
    doc_type = getattr(doc, "document_type", None)
    if not doc_type:
        return {}
    fields = getattr(doc_type, "metadata_fields", None)
    if fields is None:
        return {}
    if hasattr(fields, "all"):
        return {mf.key: mf for mf in fields.all()}
    return {mf.key: mf for mf in fields}


def snapshot_document_metadata(doc) -> dict[str, dict[str, str]]:
    """Return {field_key: {label, value}} for every user-editable detail."""
    snapshot: dict[str, dict[str, str]] = {}
    field_defs = _metadata_field_defs(doc)

    for key, label in DOCUMENT_FIELD_LABELS.items():
        snapshot[key] = {
            "label": label,
            "value": _document_column_value(doc, key),
        }

    meta = doc.metadata if isinstance(doc.metadata, dict) else {}
    for key, raw in meta.items():
        if key in SKIP_METADATA_KEYS or key in DOCUMENT_COLUMN_KEYS:
            continue
        field_def = field_defs.get(key)
        label = field_def.label if field_def else key.replace("_", " ").title()
        field_type = field_def.field_type if field_def else None
        snapshot[f"metadata.{key}"] = {
            "label": label,
            "value": _format_scalar(raw, field_type=field_type),
        }

    if getattr(doc, "is_self_upload", False):
        tags = _normalize_personal_tags(meta.get("personal_tags"))
        snapshot["personal_tags"] = {
            "label": "Personal tags",
            "value": ", ".join(tags),
        }
    else:
        tag_names = list(doc.tags.order_by("name").values_list("name", flat=True))
        snapshot["tags"] = {
            "label": "Tags",
            "value": ", ".join(tag_names),
        }

    return snapshot


def diff_metadata_snapshots(
    before: dict[str, dict[str, str]],
    after: dict[str, dict[str, str]],
) -> list[dict[str, str]]:
    edits: list[dict[str, str]] = []
    for key in sorted(set(before) | set(after)):
        old = before.get(key, {}).get("value", "")
        new = after.get(key, {}).get("value", "")
        if old == new:
            continue
        label = (
            after.get(key, {}).get("label")
            or before.get(key, {}).get("label")
            or key
        )
        edits.append({
            "key": key,
            "field": label,
            "old": old,
            "new": new,
        })
    return edits
