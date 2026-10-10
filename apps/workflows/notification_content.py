"""
Render workflow notification email content from form values.

Supports `{placeholder}` tokens for:
  - system fields: document_title, document_ref, uploader_name, step_name, today, items_table
  - any scalar form field key (dates, text, selects, calcs, …)
  - `{items_table}` → HTML table built from a form table field

Unknown placeholders are left unchanged so admins can spot typos.
"""
from __future__ import annotations

import html
import logging
import re
from datetime import date, datetime
from typing import Any

logger = logging.getLogger(__name__)

_PLACEHOLDER_RE = re.compile(r"\{([a-zA-Z0-9_.-]+)\}")


def _form_parts(document) -> tuple[dict, list[dict]]:
    metadata = document.metadata if isinstance(getattr(document, "metadata", None), dict) else {}
    form = metadata.get("form") if isinstance(metadata.get("form"), dict) else {}
    values = form.get("values") if isinstance(form.get("values"), dict) else {}
    sections = form.get("sections") if isinstance(form.get("sections"), list) else []
    fields: list[dict] = []
    for section in sections:
        if not isinstance(section, dict):
            continue
        for field in section.get("fields") or []:
            if isinstance(field, dict):
                fields.append(field)
    return values, fields


def _format_scalar(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, bool):
        return "Yes" if value else "No"
    if isinstance(value, (int, float)):
        if isinstance(value, float) and value == int(value):
            return str(int(value))
        return f"{value:,.2f}" if isinstance(value, float) else str(value)
    if isinstance(value, (date, datetime)):
        return value.strftime("%d/%m/%Y") if isinstance(value, date) and not isinstance(value, datetime) else value.strftime("%d/%m/%Y %H:%M")
    if isinstance(value, list):
        parts = [_format_scalar(v) for v in value]
        return ", ".join(p for p in parts if p)
    if isinstance(value, dict):
        # Money-ish or select option objects
        if "amount" in value:
            amount = _format_scalar(value.get("amount"))
            currency = value.get("currency") or ""
            return f"{currency} {amount}".strip()
        for key in ("label", "name", "description", "value", "account_code", "code"):
            if value.get(key):
                return str(value[key])
        return ""
    text = str(value).strip()
    # ISO date → DD/MM/YYYY for readability in supplier emails
    if re.fullmatch(r"\d{4}-\d{2}-\d{2}", text):
        try:
            return datetime.strptime(text, "%Y-%m-%d").strftime("%d/%m/%Y")
        except ValueError:
            return text
    if re.fullmatch(r"\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2})?", text):
        try:
            return datetime.fromisoformat(text.replace(" ", "T")).strftime("%d/%m/%Y %H:%M")
        except ValueError:
            return text
    return text


def list_form_table_fields(document) -> list[dict[str, Any]]:
    """Return [{key, label, columns:[{key,label}]}] for table fields on the document."""
    _, fields = _form_parts(document)
    tables = []
    for field in fields:
        if field.get("type") != "table":
            continue
        key = field.get("key") or field.get("id")
        if not key:
            continue
        columns = []
        for col in field.get("columns") or []:
            if not isinstance(col, dict):
                continue
            ckey = col.get("key") or col.get("id")
            if not ckey:
                continue
            # Skip file / action columns in emails
            if str(col.get("type") or "").lower() in ("file", "multi_file", "button", "signature"):
                continue
            columns.append({
                "key": str(ckey),
                "label": str(col.get("label") or ckey),
                "type": str(col.get("type") or "text"),
            })
        tables.append({
            "key": str(key),
            "label": str(field.get("label") or key),
            "columns": columns,
        })
    return tables


def build_items_table_html(
    document,
    table_field_key: str | None = None,
    table_column_keys: list[str] | None = None,
) -> str:
    """
    Build a styled HTML table from a form table field.
    If table_field_key is omitted, uses the first table with rows.
    """
    values, _ = _form_parts(document)
    tables = list_form_table_fields(document)
    if not tables:
        return ""

    chosen = None
    if table_field_key:
        chosen = next((t for t in tables if t["key"] == table_field_key), None)
    if chosen is None:
        # Prefer a table that actually has row data
        for table in tables:
            rows = values.get(table["key"])
            if isinstance(rows, list) and rows:
                chosen = table
                break
        chosen = chosen or tables[0]

    rows = values.get(chosen["key"])
    if not isinstance(rows, list) or not rows:
        return (
            f'<p style="font-family:Arial,sans-serif;font-size:13px;color:#5E6870;">'
            f'No items recorded in “{html.escape(chosen["label"])}”.</p>'
        )

    columns = chosen["columns"]
    if not columns:
        # Infer columns from first row keys
        first = rows[0] if isinstance(rows[0], dict) else {}
        columns = [{"key": k, "label": k, "type": "text"} for k in first.keys() if not str(k).startswith("_")]
    selected_columns = [str(key) for key in (table_column_keys or []) if str(key)]
    if table_column_keys is not None:
        columns = [column for column in columns if str(column.get("key")) in selected_columns]
    if not columns:
        return ""

    thead = "".join(
        f'<th style="border:1px solid #C8CDD2;background:#F0F4F7;padding:8px 10px;'
        f'text-align:left;font-family:Arial,sans-serif;font-size:12px;color:#1F2933;">'
        f'{html.escape(col["label"])}</th>'
        for col in columns
    )
    body_rows = []
    for row in rows:
        if not isinstance(row, dict):
            continue
        cells = "".join(
            f'<td style="border:1px solid #C8CDD2;padding:8px 10px;'
            f'font-family:Arial,sans-serif;font-size:12px;color:#1F2933;vertical-align:top;">'
            f'{html.escape(_format_scalar(row.get(col["key"])))}</td>'
            for col in columns
        )
        body_rows.append(f"<tr>{cells}</tr>")

    if not body_rows:
        return ""

    caption = html.escape(chosen["label"])
    return (
        f'<table role="presentation" cellpadding="0" cellspacing="0" '
        f'style="border-collapse:collapse;width:100%;max-width:720px;margin:16px 0;">'
        f'<caption style="caption-side:top;text-align:left;font-family:Arial,sans-serif;'
        f'font-size:13px;font-weight:600;color:#1F2933;padding:0 0 8px 0;">{caption}</caption>'
        f"<thead><tr>{thead}</tr></thead>"
        f"<tbody>{''.join(body_rows)}</tbody>"
        f"</table>"
    )


def build_notification_context(
    *,
    document=None,
    payment_run=None,
    step_name: str = "",
    include_items_table: bool = False,
    table_field_key: str | None = None,
    table_column_keys: list[str] | None = None,
) -> dict[str, str]:
    """Flatten document / payment-run / form values into string placeholders."""
    ctx: dict[str, str] = {
        "step_name": step_name or "",
        "today": date.today().strftime("%d/%m/%Y"),
        "document_title": "",
        "document_ref": "",
        "uploader_name": "",
        "items_table": "",
    }

    if payment_run is not None:
        ctx["document_title"] = f"Payment Run {getattr(payment_run, 'payment_reference', '')}"
        ctx["document_ref"] = str(getattr(payment_run, "payment_reference", "") or "")
        ctx["payment_reference"] = ctx["document_ref"]
        ctx["total_amount"] = str(getattr(payment_run, "total_amount", "") or "")
        submitter = getattr(payment_run, "submitted_by", None)
        if submitter:
            ctx["uploader_name"] = submitter.get_full_name() or submitter.email or ""

    if document is not None:
        ctx["document_title"] = str(getattr(document, "title", "") or "")
        ctx["document_ref"] = str(getattr(document, "reference_number", "") or "")
        uploader = getattr(document, "uploaded_by", None) or getattr(document, "owned_by", None)
        if uploader:
            ctx["uploader_name"] = uploader.get_full_name() or uploader.email or ""

        values, fields = _form_parts(document)
        # Prefer human labels as aliases too: {Date of Travel} is awkward;
        # we expose field keys, and also a sanitized label slug when unique.
        for field in fields:
            ftype = str(field.get("type") or "")
            if ftype in ("table", "button", "signature", "multi_file", "file", "budget"):
                continue
            key = field.get("key") or field.get("id")
            if not key:
                continue
            ctx[str(key)] = _format_scalar(values.get(key))

        # Also expose any leftover scalar values not covered by schema
        for key, value in values.items():
            if key in ctx:
                continue
            if isinstance(value, list):
                continue
            ctx[str(key)] = _format_scalar(value)

        if include_items_table:
            ctx["items_table"] = build_items_table_html(document, table_field_key, table_column_keys)

    return ctx


def render_placeholders(template: str, ctx: dict[str, str]) -> str:
    """Replace `{name}` tokens; leave unknown tokens intact."""
    if not template:
        return template or ""

    def repl(match: re.Match) -> str:
        key = match.group(1)
        if key in ctx:
            return str(ctx[key])
        return match.group(0)

    return _PLACEHOLDER_RE.sub(repl, template)


def text_to_html_body(text: str) -> str:
    """Turn a plain-text body (possibly containing an HTML table) into an HTML email."""
    if not text:
        return ""
    # Split around an existing HTML table so we don't escape it.
    parts = re.split(r"(<table\b.*?</table>)", text, flags=re.IGNORECASE | re.DOTALL)
    rendered: list[str] = []
    for part in parts:
        if part.lower().startswith("<table"):
            rendered.append(part)
        else:
            escaped = html.escape(part)
            escaped = escaped.replace("\r\n", "\n").replace("\r", "\n")
            escaped = escaped.replace("\n", "<br>\n")
            rendered.append(escaped)
    return (
        '<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;'
        'line-height:1.5;color:#1F2933;">'
        + "".join(rendered)
        + "</div>"
    )


def plain_text_from_htmlish(text: str) -> str:
    """Rough plain-text fallback when the body contains an HTML table."""
    if not text:
        return ""
    without_tags = re.sub(r"<br\s*/?>", "\n", text, flags=re.IGNORECASE)
    without_tags = re.sub(r"</p\s*>", "\n\n", without_tags, flags=re.IGNORECASE)
    without_tags = re.sub(r"</tr\s*>", "\n", without_tags, flags=re.IGNORECASE)
    without_tags = re.sub(r"</t[dh]\s*>", "\t", without_tags, flags=re.IGNORECASE)
    without_tags = re.sub(r"<[^>]+>", "", without_tags)
    return html.unescape(without_tags).strip()
