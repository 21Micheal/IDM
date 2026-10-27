"""Helpers for recording human-readable metadata edit diffs in the audit log."""
from __future__ import annotations

from decimal import Decimal
import json
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


def diff_form_value_fields(
    before: dict[str, Any],
    after: dict[str, Any],
    sections: list[dict[str, Any]],
) -> list[str]:
    """Return user-facing labels for changed form values, without storing values.

    Table edits are reported at column level where possible so an LPO-related
    change can be distinguished from opening a form that happens to contain LPO
    details. Values are intentionally omitted from this audit summary.
    """
    before = before if isinstance(before, dict) else {}
    after = after if isinstance(after, dict) else {}
    labels: list[str] = []
    known_keys: set[str] = set()

    def differs(left: Any, right: Any) -> bool:
        return json.dumps(left, sort_keys=True, ensure_ascii=False, default=str) != json.dumps(
            right, sort_keys=True, ensure_ascii=False, default=str
        )

    for section in sections or []:
        if not isinstance(section, dict):
            continue
        for field in section.get("fields", []):
            if not isinstance(field, dict) or not field.get("key"):
                continue
            key = str(field["key"])
            known_keys.add(key)
            field_label = str(field.get("label") or key.replace("_", " ").title())
            if field.get("type") != "table":
                if differs(before.get(key), after.get(key)):
                    labels.append(field_label)
                continue

            old_rows = before.get(key) if isinstance(before.get(key), list) else []
            new_rows = after.get(key) if isinstance(after.get(key), list) else []
            if len(old_rows) != len(new_rows):
                labels.append(field_label)
                continue

            column_labels: list[str] = []
            for column in field.get("columns", []):
                if not isinstance(column, dict) or not column.get("key"):
                    continue
                column_key = str(column["key"])
                if any(
                    differs(
                        old.get(column_key) if isinstance(old, dict) else None,
                        new.get(column_key) if isinstance(new, dict) else None,
                    )
                    for old, new in zip(old_rows, new_rows)
                ):
                    column_label = str(column.get("label") or column_key.replace("_", " ").title())
                    column_labels.append(f"{field_label}: {column_label}")

            if column_labels:
                labels.extend(column_labels)
            elif differs(before.get(key), after.get(key)):
                # Unknown row-level data changed; identify the table without
                # implying which column changed.
                labels.append(field_label)

    for key in sorted((set(before) | set(after)) - known_keys):
        if key.startswith("__") or not differs(before.get(key), after.get(key)):
            continue
        labels.append(key.replace("_", " ").replace(".", " · ").title())

    return labels
