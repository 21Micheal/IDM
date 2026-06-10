"""
Shared helpers for built-template *form* attachments.

Form attachments (file/image form fields, including file columns inside a table
field) are stored on the document's ``metadata.form`` — never as document
versions. Files live under ``documents/{id}/form_attachments/`` and are
referenced by descriptor dicts placed directly into ``form.values`` (top-level
or nested in a table cell). A flat ``form.attachments`` map mirrors every
descriptor so a single endpoint can stream any of them by key.

Multipart field-name scheme (set by the frontend):
  * ``attachment_<field_key>``                  — a simple file/image field
  * ``tableattachment_<table_key>~<row>~<col>`` — a file cell inside a table

The flat ``attachments`` key for a table cell is ``<table_key>~<row>~<col>``.
"""
from __future__ import annotations

import uuid

from django.core.exceptions import ValidationError
from django.core.files.storage import default_storage
from django.utils.text import get_valid_filename

SIMPLE_PREFIXES = ("attachment_", "attachments.")
TABLE_PREFIX = "tableattachment_"
TABLE_SEP = "~"


def _store(doc_id, file) -> dict:
    safe_name = get_valid_filename(file.name)
    storage_path = default_storage.save(
        f"documents/{doc_id}/form_attachments/{uuid.uuid4().hex}_{safe_name}",
        file,
    )
    return {
        "type": "file",
        "name": file.name,
        "size": getattr(file, "size", 0),
        "content_type": getattr(file, "content_type", "") or "",
        "storage_path": storage_path,
    }


def is_attachment_descriptor(value) -> bool:
    return isinstance(value, dict) and bool(value.get("storage_path"))


def is_reference_value(value) -> bool:
    """A picked reference/user value: ``{id, label, source}`` (no storage_path)."""
    return (
        isinstance(value, dict)
        and "label" in value
        and not value.get("storage_path")
    )


def _render_cell(value):
    """Flatten an attachment descriptor or reference value to its display string
    (file name / label); pass scalars through unchanged."""
    if is_attachment_descriptor(value):
        return value.get("name", "")
    if is_reference_value(value):
        return value.get("label", "")
    return value


def rebuild_attachments(values: dict) -> dict:
    """Mirror every descriptor in ``values`` (top-level + table cells) into a
    flat ``{key: descriptor}`` map keyed the same way the frontend downloads."""
    attachments: dict = {}
    for key, value in (values or {}).items():
        if is_attachment_descriptor(value):
            attachments[key] = value
        elif isinstance(value, list):
            for row_idx, row in enumerate(value):
                if not isinstance(row, dict):
                    continue
                for col_key, cell in row.items():
                    if is_attachment_descriptor(cell):
                        attachments[f"{key}{TABLE_SEP}{row_idx}{TABLE_SEP}{col_key}"] = cell
    return attachments


def apply_form_attachments(doc_id, values: dict, files) -> tuple[dict, dict]:
    """Persist uploaded ``files`` and write their descriptors into ``values``
    (a simple field or a nested table cell). Returns ``(values, attachments)``
    where ``attachments`` is the rebuilt flat mirror. Descriptors already
    present in ``values`` (re-saved without re-upload) are preserved.

    ``files`` is an iterable of ``(multipart_field_name, uploaded_file)``.
    """
    values = dict(values or {})

    for field_name, file in files:
        if field_name.startswith(TABLE_PREFIX):
            path_spec = field_name[len(TABLE_PREFIX):]
            parts = path_spec.split(TABLE_SEP)
            if len(parts) != 3:
                continue
            table_key, row_raw, col_key = parts
            try:
                row_idx = int(row_raw)
            except ValueError:
                continue
            rows = values.get(table_key)
            if not isinstance(rows, list) or not (0 <= row_idx < len(rows)):
                continue
            if not isinstance(rows[row_idx], dict):
                continue
            rows = [dict(r) if isinstance(r, dict) else r for r in rows]
            rows[row_idx][col_key] = _store(doc_id, file)
            values[table_key] = rows
        else:
            field_key = field_name
            for prefix in SIMPLE_PREFIXES:
                if field_key.startswith(prefix):
                    field_key = field_key[len(prefix):]
                    break
            values[field_key] = _store(doc_id, file)

    return values, rebuild_attachments(values)


def descriptors_to_names(values: dict) -> dict:
    """Return a copy of ``values`` with every attachment descriptor replaced by
    its file name and every reference value by its label, for rendering the PDF
    view (which shows display strings, not structured dicts). Walks table rows."""
    out: dict = {}
    for key, value in (values or {}).items():
        if isinstance(value, list):
            out[key] = [
                {col_key: _render_cell(cell) for col_key, cell in row.items()}
                if isinstance(row, dict)
                else row
                for row in value
            ]
        else:
            out[key] = _render_cell(value)
    return out


# ── Reference reconciliation ────────────────────────────────────────────────────

# Form field types that carry a picked reference/user value.
_REFERENCE_FIELD_TYPES = frozenset({"reference", "user"})


def default_reference_resolver(source, ref_id):
    """Re-derive a reference's display label from its id by querying the same
    models behind the list endpoints. Returns ``None`` if it no longer resolves.
    Models are imported lazily to avoid import cycles."""
    norm = (source or "").lower().replace(" ", "").replace("_", "").replace("-", "")
    try:
        if norm in ("users", "user"):
            from apps.accounts.models import User
            u = User.objects.filter(pk=ref_id).first()
            return (u.get_full_name() or u.email) if u else None
        if norm in ("groups", "group", "usergroup"):
            from apps.accounts.models import UserGroup
            g = UserGroup.objects.filter(pk=ref_id).first()
            return g.name if g else None
        if norm in ("departments", "department", "dept"):
            from apps.accounts.models import Department
            d = Department.objects.filter(pk=ref_id).first()
            return d.name if d else None
        if norm in ("documents", "document", "docs"):
            from apps.documents.models import Document
            doc = Document.objects.filter(pk=ref_id).first()
            if not doc:
                return None
            return f"{doc.title} ({doc.reference_number})" if doc.reference_number else doc.title
        if norm in ("documenttypes", "documenttype", "types", "type"):
            from apps.documents.models import DocumentType
            t = DocumentType.objects.filter(pk=ref_id).first()
            return t.name if t else None
    except (ValueError, TypeError, ValidationError):
        # Malformed id (e.g. not a UUID) — treat as unresolved.
        return None
    return None


def _iter_reference_paths(sections):
    """Yield (table_key|None, field_key, field_type) for every reference/user
    field defined in the template ``sections`` (top-level and table columns)."""
    for section in sections or []:
        for field in (section.get("fields") or []):
            ftype = field.get("type")
            fkey = field.get("key")
            if not fkey:
                continue
            if ftype in _REFERENCE_FIELD_TYPES:
                yield (None, fkey, ftype)
            elif ftype == "table":
                for col in (field.get("columns") or []):
                    ckey = col.get("key")
                    if ckey and col.get("type") in _REFERENCE_FIELD_TYPES:
                        yield (fkey, ckey, col.get("type"))


def reconcile_references(values: dict, sections, resolver) -> dict:
    """Re-derive the ``label`` of every picked reference/user value from its id,
    using ``resolver(source, id) -> label | None``. Keeps the structured
    ``{id, label, source}`` shape; drops a value whose id no longer resolves.
    A trusted server-side label means a stale/spoofed client label can't persist.
    """
    if not isinstance(values, dict):
        return values
    values = dict(values)

    def reconcile_one(cell, default_source):
        if not is_reference_value(cell):
            return cell
        ref_id = str(cell.get("id") or "")
        source = cell.get("source") or default_source
        if not ref_id:
            # Free-text fallback value (no id) — keep its label as-is.
            return {"id": "", "label": cell.get("label", ""), "source": source}
        label = resolver(source, ref_id)
        if not label:
            return None  # unresolved — drop it
        return {"id": ref_id, "label": label, "source": source}

    for table_key, field_key, ftype in _iter_reference_paths(sections):
        default_source = "users" if ftype == "user" else "documents"
        if table_key is None:
            if field_key in values:
                resolved = reconcile_one(values[field_key], default_source)
                if resolved is None:
                    values.pop(field_key, None)
                else:
                    values[field_key] = resolved
        else:
            rows = values.get(table_key)
            if not isinstance(rows, list):
                continue
            new_rows = []
            for row in rows:
                if isinstance(row, dict) and field_key in row:
                    row = dict(row)
                    resolved = reconcile_one(row[field_key], default_source)
                    if resolved is None:
                        row.pop(field_key, None)
                    else:
                        row[field_key] = resolved
                new_rows.append(row)
            values[table_key] = new_rows

    return values
