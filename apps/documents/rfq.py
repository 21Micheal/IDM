"""Helpers for collecting supplier responses during a requisition's RFQ phase."""
from __future__ import annotations

from django.utils import timezone


def supplier_codes_from_values(values: dict, supplier_field: str) -> list[str]:
    """Read selected supplier codes from a top-level control or table column.

    Table paths use ``table_key.column_key`` and follow the same convention as
    notification-step table selections.
    """
    raw = None
    if "." in str(supplier_field or ""):
        table_key, column_key = str(supplier_field).split(".", 1)
        rows = values.get(table_key)
        if isinstance(rows, list):
            raw = [row.get(column_key) for row in rows if isinstance(row, dict)]
    else:
        raw = values.get(supplier_field)

    if not isinstance(raw, list):
        raw = [raw]

    codes: list[str] = []
    for item in raw:
        if isinstance(item, dict):
            item = (
                item.get("account_code") or item.get("SupplierCode")
                or item.get("code") or item.get("value") or item.get("label")
            )
        if item is not None:
            code = str(item).strip()
            if code and code not in codes:
                codes.append(code)
    return codes


def multi_attachment_field(form: dict) -> str:
    """Return the configured RFQ multi-file field key, preferring an explicit role."""
    fields = [
        field
        for section in (form.get("sections") or [])
        if isinstance(section, dict)
        for field in (section.get("fields") or [])
        if isinstance(field, dict) and field.get("key") and field.get("type") == "multi_file"
    ]
    explicit = next(
        (field for field in fields if field.get("workflowRole") == "rfq_supplier_attachments"),
        None,
    )
    if explicit:
        return str(explicit["key"])
    named = next(
        (field for field in fields if any(word in str(field.get("label") or "").lower()
                                           for word in ("supplier", "invoice", "quotation", "quote"))),
        None,
    )
    return str((named or (fields[0] if fields else {})).get("key") or "")


def rfq_state(form: dict) -> dict:
    state = form.get("rfq_response")
    return state if isinstance(state, dict) else {}


def all_supplier_responses_received(state: dict) -> bool:
    suppliers = state.get("suppliers") if isinstance(state, dict) else None
    return bool(suppliers) and all(
        isinstance(item, dict) and item.get("status") == "received"
        for item in suppliers
    )


def mark_supplier_response(state: dict, supplier_code: str, *, source: str, files: list[dict] | None = None) -> bool:
    """Record a response against an invited supplier; return False if unmatched."""
    code = str(supplier_code or "").strip().casefold()
    for supplier in state.get("suppliers") or []:
        if not isinstance(supplier, dict) or str(supplier.get("code") or "").strip().casefold() != code:
            continue
        supplier["status"] = "received"
        supplier["response_source"] = source
        supplier["received_at"] = timezone.now().isoformat()
        if files:
            supplier["files"] = [*(supplier.get("files") or []), *files]
        return True
    return False
