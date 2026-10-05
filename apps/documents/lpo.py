"""Automatic LPO (purchase order) document generation.

When a requisition's LPO approval phase completes, the platform should produce
the printable "Purchase Order" document and post the matching PurchaseOrder to
SunSystems. This module owns the first half: rendering the LPO document from the
built document template and linking it back to the requisition.

It deliberately does *not* talk to SunSystems; :mod:`apps.sunsystems.journal`
does that. The generated LPO reference is injected into the requisition's form
values (``__lpo_number`` / ``__lpo_date``) so the posting mapping can reference
it without either side reaching into the other.
"""
from __future__ import annotations

import logging
from datetime import timedelta
from decimal import Decimal, InvalidOperation

logger = logging.getLogger(__name__)

LPO_DOC_TYPE_CODE = "LPO"
LPO_TEMPLATE_NAME_HINT = "purchase order"

# Business-unit-independent amount wording units.
_ONES = [
    "", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine",
    "Ten", "Eleven", "Twelve", "Thirteen", "Fourteen", "Fifteen", "Sixteen",
    "Seventeen", "Eighteen", "Nineteen",
]
_TENS = ["", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety"]
_SCALES = ["", "Thousand", "Million", "Billion", "Trillion"]


def find_lpo_template():
    """Return ``(template, document_type)`` for the built LPO document template.

    Prefers a built, ``kind="document"`` template bound to the ``LPO`` document
    type; falls back to any built document template whose name mentions
    "purchase order". Returns ``(None, None)`` when the deployment has no LPO
    template, so callers can skip generation without failing the workflow.
    """
    from apps.templates_engine.models import DocumentTemplate
    from apps.documents.models import DocumentType

    qs = DocumentTemplate.objects.filter(type="built", kind="document")
    doc_type = DocumentType.objects.filter(code=LPO_DOC_TYPE_CODE).first()
    if doc_type is not None:
        template = qs.filter(document_type=doc_type).order_by("-updated_at").first()
        if template:
            return template, doc_type
    template = (
        qs.filter(name__icontains=LPO_TEMPLATE_NAME_HINT).order_by("-updated_at").first()
    )
    if template is None:
        return None, doc_type
    return template, (template.document_type or doc_type)


def generate_lpo_for_document(document, actor=None):
    """Generate (once) the LPO document for an approved requisition.

    Idempotent: a second call returns the previously generated document. Returns
    the :class:`Document` or ``None`` when no LPO template is configured.
    """
    from apps.documents.models import Document, DocumentRelationship

    meta = dict(getattr(document, "metadata", None) or {})
    form = dict(meta.get("form") or {})
    existing_id = form.get("lpo_document_id")
    if existing_id:
        existing = Document.objects.filter(pk=existing_id).first()
        if existing:
            return existing

    template, doc_type = find_lpo_template()
    if template is None or doc_type is None:
        logger.warning("No LPO document template configured; skipping LPO generation for %s", document.pk)
        return None

    values = dict(form.get("values") or {})
    user = actor or getattr(document, "uploaded_by", None)

    from apps.documents.serializers import _generate_unique_reference
    lpo_reference = _generate_unique_reference(doc_type)
    merge_values = build_lpo_merge_values(document, lpo_reference, doc_type=doc_type)

    from apps.templates_engine.tasks import generate_document_from_template_sync

    title = f"Purchase Order {lpo_reference}"
    lpo_doc = generate_document_from_template_sync(
        template,
        merge_values,
        fmt="docx",
        title=title,
        user=user,
        type_id=doc_type.id,
        reference_number=lpo_reference,
    )

    # Link back to the requisition (both on the relationship graph and on the
    # requisition snapshot the UI reads).
    try:
        DocumentRelationship.objects.get_or_create(
            source_document=document,
            target_document=lpo_doc,
            relation_type=DocumentRelationship.RelationType.REFERENCES,
            defaults={"created_by": user, "note": "Generated on LPO approval"},
        )
    except Exception:
        logger.exception("Could not link LPO %s to requisition %s", lpo_doc.pk, document.pk)

    now = _today_str()
    values["__lpo_number"] = lpo_doc.reference_number
    values["__lpo_date"] = now
    values["__requisition_number"] = document.reference_number or values.get("__requisition_number", "")
    form["values"] = values
    form["lpo_document_id"] = str(lpo_doc.id)
    form["lpo_reference"] = lpo_doc.reference_number
    meta["form"] = form
    document.metadata = meta
    document.save(update_fields=["metadata", "updated_at"])
    return lpo_doc


def build_lpo_merge_values(document, lpo_reference, *, doc_type=None) -> dict:
    """Build the flat designer merge-field values for the LPO document.

    Keys are dotted exactly as the designer emits them (``lpo.number``,
    ``supplier.name``, …), plus ``line_items`` as the bound data-table source.
    """
    from apps.documents.models import DMSSettings

    meta = dict(getattr(document, "metadata", None) or {})
    form = dict(meta.get("form") or {})
    values = dict(form.get("values") or {})
    sections = form.get("sections") or []

    lines = _build_line_items(values, sections)
    subtotal = sum((_dec(line.get("net_price")) for line in lines), Decimal("0"))
    vat_total = sum((_dec(line.get("vat")) for line in lines), Decimal("0"))
    grand_total = sum((_dec(line.get("gross_value")) for line in lines), Decimal("0"))
    if grand_total == 0:
        grand_total = subtotal + vat_total

    org_name = org_address = ""
    try:
        settings_row = DMSSettings.objects.first()
        if settings_row:
            org_name = settings_row.organization_name or ""
            org_address = settings_row.organization_address or ""
    except Exception:
        pass

    supplier_code, supplier_name = _supplier_details(values, meta)

    today = _today_str()
    valid_until = (_today() + timedelta(days=30)).strftime("%d %b %Y")
    currency = _first_currency(values, lines) or "KES"

    prepared_by = (
        _as_text(values.get("requested_by_copy"))
        or _user_name(getattr(document, "uploaded_by", None))
    )

    return {
        "line_items": lines,
        "lpo.number": lpo_reference,
        "lpo.date": today,
        "lpo.valid_until": valid_until,
        "lpo.description": f"Supply of the underlisted goods/services for {document.reference_number or 'requisition'}",
        "lpo.currency": currency,
        "lpo.subtotal": _money(subtotal),
        "lpo.vat_total": _money(vat_total),
        "lpo.grand_total": _money(grand_total),
        "lpo.amount_words": amount_in_words(grand_total, currency=currency),
        "supplier.code": supplier_code,
        "supplier.name": supplier_name,
        "supplier.email": "",
        "supplier.phone": "",
        "supplier.address": "",
        "company.name": org_name,
        "company.address": org_address,
        "company.email": "",
        "company.phone": "",
        "prepared_by.name": prepared_by,
        "prepared_by.role": _as_text(values.get("department_chk9")) or "Requestor",
        "prepared_by.date": today,
        "approved_by.name": "",
        "approved_by.role": "Procurement",
        "approved_by.date": today,
    }


# ── line items ─────────────────────────────────────────────────────────────────
def _build_line_items(values: dict, sections: list) -> list[dict]:
    """Turn every requisition table's rows into the LPO template's columns."""
    items: list[dict] = []
    tables = _requisition_tables(sections, values)
    for table in tables:
        columns = table.get("columns") or []
        rows = values.get(table.get("key"))
        if not isinstance(rows, list):
            continue
        for row in rows:
            if not isinstance(row, dict):
                continue
            if not any(v not in (None, "", [], {}) for v in row.values()):
                continue
            item = _row_line_item(row, columns)
            if not any(item.get(k) for k in ("item", "gross_value", "net_price")):
                continue
            items.append(item)

    for index, item in enumerate(items, start=1):
        item["number"] = index
    return items


def _requisition_tables(sections: list, values: dict) -> list[dict]:
    """Table fields on the form that look like requisition line grids.

    A table qualifies when it has rows in ``values`` and at least one money or
    item-like column. This keeps the LPO honest when a template carries both a
    Travel grid and an on-demand General grid — only the one the user filled
    contributes lines.
    """
    tables: list[dict] = []
    for section in sections or []:
        for field in section.get("fields") or []:
            if field.get("type") != "table":
                continue
            key = field.get("key")
            if not key or not isinstance(values.get(key), list):
                continue
            labels = " ".join(str(c.get("label", "")).lower() for c in (field.get("columns") or []))
            keys = " ".join(str(c.get("key", "")) for c in (field.get("columns") or []))
            if any(token in labels for token in ("cost", "price", "value", "item", "quantity", "qty")) or any(
                token in keys for token in ("gross", "price", "cost", "item", "quantity")
            ):
                tables.append(field)
    return tables


def _row_line_item(row: dict, columns: list) -> dict:
    """Map one requisition row onto the LPO table's nine columns using labels."""
    def pick(*needles: str) -> str:
        for column in columns:
            label = str(column.get("label", "")).lower()
            if any(needle in label for needle in needles):
                raw = row.get(column.get("key"))
                if raw not in (None, ""):
                    return _as_text(raw)
        return ""

    description = pick("description")
    item_code = pick("item")
    item = description or item_code
    if not item:
        item = " — ".join(
            part for part in (pick("purpose"), pick("destination")) if part
        )
    uom = pick("uom", "unit of measure")
    quantity = pick("qty", "quantity")
    unit_price = pick("unit price")
    net_price = pick("net")
    vat_percent = pick("%vat", "vat%", "vat %")
    vat = ""
    gross_value = pick("gross")
    # A bare "VAT" column (not "VAT%"/"VAT ") is the tax amount.
    for column in columns:
        label = str(column.get("label", "")).strip().lower()
        if label in ("vat", "tax") and row.get(column.get("key")) not in (None, ""):
            vat = _as_text(row.get(column.get("key")))
            break
    estimated = pick("estimated", "actual")

    if not unit_price and estimated:
        unit_price = estimated
    if not net_price:
        net_price = _mul(quantity or "1", unit_price) if unit_price else (estimated or "")
    if not gross_value:
        gross_value = _add(net_price, vat) if (net_price or vat) else estimated
    if not quantity:
        quantity = "1"
    return {
        "number": 0,
        "item": item,
        "uom": uom,
        "quantity": quantity,
        "unit_price": unit_price,
        "net_price": net_price,
        "vat_percent": vat_percent,
        "vat": vat,
        "gross_value": gross_value,
    }


# ── misc helpers ────────────────────────────────────────────────────────────────
def _supplier_details(values: dict, meta: dict) -> tuple[str, str]:
    raw = values.get("supplier_wudn") or values.get("supplier") or ""
    if isinstance(raw, (list, tuple)):
        raw = raw[0] if raw else ""
    if isinstance(raw, dict):
        code = _as_text(raw.get("code") or raw.get("id") or raw.get("value"))
        name = _as_text(raw.get("name") or raw.get("label") or raw.get("description"))
        return code, name
    code = _as_text(raw)
    if code:
        return code, ""
    # Fall back to the configured constant so the printed LPO still names a
    # supplier when only the mapping knows it.
    po = ((meta.get("sunsystems") or {}).get("journal") or {}).get("purchase_order") or {}
    const = po.get("supplier_code")
    if isinstance(const, dict):
        return _as_text(const.get("const")), ""
    return _as_text(const), ""


def _first_currency(values: dict, lines: list[dict]) -> str:
    for field in ("currency_8ia7", "currency_poa7", "currency"):
        text = _as_text(values.get(field))
        if text:
            return text
    for line in lines:
        text = _as_text(line.get("currency"))
        if text:
            return text
    return ""


def _today():
    from django.utils import timezone
    return timezone.localdate()


def _today_str() -> str:
    return _today().strftime("%d %b %Y")


def _dec(value) -> Decimal:
    try:
        return Decimal(str(value).replace(",", "").strip() or "0")
    except (InvalidOperation, ValueError):
        return Decimal("0")


def _mul(a, b) -> str:
    return _money(_dec(a) * _dec(b))


def _add(a, b) -> str:
    return _money(_dec(a) + _dec(b))


def _money(value: Decimal) -> str:
    return format(value.quantize(Decimal("0.01")), "f")


def _as_text(value) -> str:
    if value is None:
        return ""
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, dict):
        return _as_text(value.get("label") or value.get("name") or value.get("value") or value.get("id"))
    if isinstance(value, (list, tuple)):
        return ", ".join(filter(None, (_as_text(v) for v in value)))
    return str(value).strip()


def _user_name(user) -> str:
    if not user:
        return ""
    return (user.get_full_name() or user.email or "").strip()


def amount_in_words(amount, currency: str = "") -> str:
    """Render a money amount as words, e.g. ``One Thousand Two Hundred And 50/100``."""
    value = _dec(amount)
    negative = value < 0
    value = abs(value)
    whole = int(value)
    cents = int((value - whole) * 100 + Decimal("0.5"))
    words = _int_to_words(whole) or "Zero"
    text = words
    if cents:
        text = f"{text} And {cents:02d}/100"
    else:
        text = f"{text} Only"
    if currency:
        text = f"{text} {currency}"
    if negative:
        text = f"Minus {text}"
    return text


def _int_to_words(number: int) -> str:
    if number == 0:
        return ""
    parts: list[str] = []
    scale_index = 0
    while number > 0:
        chunk = number % 1000
        if chunk:
            chunk_words = _chunk_to_words(chunk)
            if _SCALES[scale_index]:
                chunk_words = f"{chunk_words} {_SCALES[scale_index]}"
            parts.insert(0, chunk_words)
        number //= 1000
        scale_index += 1
    return " ".join(parts)


def _chunk_to_words(chunk: int) -> str:
    words: list[str] = []
    if chunk >= 100:
        words.append(f"{_ONES[chunk // 100]} Hundred")
        chunk %= 100
        if chunk:
            words.append("And")
    if chunk >= 20:
        tens, ones = divmod(chunk, 10)
        words.append(_TENS[tens] if not ones else f"{_TENS[tens]}-{_ONES[ones]}")
    elif chunk:
        words.append(_ONES[chunk])
    return " ".join(words)
