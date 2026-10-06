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
    existing_ids = [
        item.get("id") for item in (form.get("lpo_documents") or [])
        if isinstance(item, dict) and item.get("id")
    ] or form.get("lpo_document_ids") or []
    if existing_ids:
        existing_docs = list(Document.objects.filter(pk__in=existing_ids).order_by("created_at"))
        if existing_docs:
            return existing_docs[0]

    template, doc_type = find_lpo_template()
    if template is None or doc_type is None:
        logger.warning("No LPO document template configured; skipping LPO generation for %s", document.pk)
        return None

    user = actor or getattr(document, "uploaded_by", None)

    from apps.documents.serializers import _generate_unique_reference
    from apps.templates_engine.tasks import generate_document_from_template_sync
    meta = dict(getattr(document, "metadata", None) or {})
    form = dict(meta.get("form") or {})
    sections = form.get("sections") or []
    values = dict(form.get("values") or {})
    tables = _requisition_tables(sections, values)
    if not tables:
        tables = [{"key": None, "label": "Requisition", "columns": []}]

    lpo_docs = []
    lpo_records = []
    for table in tables:
        lpo_reference = _generate_unique_reference(doc_type)
        merge_values = build_lpo_merge_values(
            document, lpo_reference, doc_type=doc_type, actor=user,
            table_key=table.get("key"),
        )
        title = f"Purchase Order {lpo_reference}"
        lpo_doc = generate_document_from_template_sync(
            template,
            merge_values,
            fmt="pdf",
            title=title,
            user=user,
            type_id=doc_type.id,
            reference_number=lpo_reference,
        )
        try:
            DocumentRelationship.objects.get_or_create(
                source_document=document,
                target_document=lpo_doc,
                relation_type=DocumentRelationship.RelationType.REFERENCES,
                defaults={"created_by": user, "note": "Generated on LPO approval"},
            )
        except Exception:
            logger.exception("Could not link LPO %s to requisition %s", lpo_doc.pk, document.pk)
        lpo_docs.append(lpo_doc)
        lpo_records.append({
            "id": str(lpo_doc.id),
            "reference": lpo_doc.reference_number,
            "table_key": table.get("key") or "",
            "table_label": table.get("label") or "Requisition",
        })

    now = _today_str()
    values["__lpo_number"] = lpo_docs[0].reference_number
    values["__lpo_date"] = now
    values["__requisition_number"] = document.reference_number or values.get("__requisition_number", "")
    form["values"] = values
    form["lpo_document_id"] = str(lpo_docs[0].id)
    form["lpo_reference"] = lpo_docs[0].reference_number
    form["lpo_documents"] = lpo_records
    meta["form"] = form
    document.metadata = meta
    document.save(update_fields=["metadata", "updated_at"])
    return lpo_docs[0]


def build_lpo_merge_values(document, lpo_reference, *, doc_type=None, actor=None, table_key=None) -> dict:
    """Build the flat designer merge-field values for the LPO document.

    Keys are dotted exactly as the designer emits them (``lpo.number``,
    ``supplier.name``, …), plus ``line_items`` as the bound data-table source.
    """
    from apps.documents.models import DMSSettings

    meta = dict(getattr(document, "metadata", None) or {})
    form = dict(meta.get("form") or {})
    values = dict(form.get("values") or {})
    sections = form.get("sections") or []

    lines = _build_line_items(values, sections, table_key=table_key)
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

    supplier_code, supplier_name, supplier_email, supplier_phone, supplier_address = _supplier_details(
        values, meta, sections, table_key=table_key,
    )

    today = _today_str()
    valid_until = _ticket_expiry_date(values, sections)
    currency = _first_currency(values, lines) or "KES"

    prepared_by = _requestor_name(values, sections) or _user_name(getattr(document, "uploaded_by", None))
    line_descriptions = list(dict.fromkeys(
        _as_text(line.get("description") or line.get("item")) for line in lines
        if _as_text(line.get("description") or line.get("item"))
    ))

    return {
        "line_items": lines,
        "lpo.number": lpo_reference,
        "lpo.date": today,
        "lpo.valid_until": valid_until,
        "lpo.description": "; ".join(line_descriptions),
        "lpo.currency": currency,
        "lpo.subtotal": _money(subtotal),
        "lpo.vat_total": _money(vat_total),
        "lpo.grand_total": _money(grand_total),
        "lpo.amount_words": amount_in_words(grand_total, currency=currency),
        "supplier.code": supplier_code,
        "supplier.name": supplier_name,
        "supplier.email": supplier_email,
        "supplier.phone": supplier_phone,
        "supplier.address": supplier_address,
        "company.name": org_name,
        "company.address": org_address,
        "company.email": "",
        "company.phone": "",
        "prepared_by.name": prepared_by,
        "prepared_by.role": _as_text(values.get("department_chk9")) or "Requestor",
        "prepared_by.date": today,
        "approved_by.name": _user_name(actor),
        "approved_by.role": "Approver",
        "approved_by.date": today,
    }


# ── line items ─────────────────────────────────────────────────────────────────
def _build_line_items(values: dict, sections: list, *, table_key=None) -> list[dict]:
    """Turn one requisition table's rows into the LPO template's columns."""
    items: list[dict] = []
    tables = _requisition_tables(sections, values)
    for table in tables:
        if table_key and table.get("key") != table_key:
            continue
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
            looks_like_lines = any(token in labels for token in ("cost", "price", "value", "item", "quantity", "qty")) or any(
                token in keys for token in ("gross", "price", "cost", "item", "quantity")
            )
            rows = values.get(key) or []
            has_data = any(isinstance(row, dict) and any(v not in (None, "", [], {}) for v in row.values()) for row in rows)
            if looks_like_lines and has_data:
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

    def pick_role(role: str) -> str | None:
        for column in columns:
            sunsystems = column.get("sunsystems") or {}
            if sunsystems.get("role") == role:
                return _as_text(row.get(column.get("key")))
        return None

    # A role mapping is the schema contract. Labels remain a fallback for
    # tables created before SunSystems role mapping was available.
    role_description = pick_role("description")
    description = role_description if role_description is not None else pick("description")
    role_item_code = pick_role("item_code")
    item_code = role_item_code if role_item_code is not None else pick("item")
    item_column = next((column for column in columns if (column.get("sunsystems") or {}).get("role") == "item_code"), None)
    if item_column is None:
        item_column = next((
            column for column in columns
            if "item" in str(column.get("label", "")).lower()
            and "description" not in str(column.get("label", "")).lower()
        ), {})
    external = item_column.get("external") if isinstance(item_column, dict) else {}
    is_sunsystems_item = isinstance(external, dict) and external.get("source") == "items"
    item_description = _query_item_description(item_code) if item_code and is_sunsystems_item else ""
    item = " — ".join(part for part in (item_code, item_description) if part)
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
    currency = pick("currency")
    # Some requisition templates persist calculated columns as zero before
    # their client-side formulas have run. Rebuild those amounts from the
    # entered quantity, price and VAT rate for the printed purchase order.
    if unit_price and _dec(net_price) == 0:
        net_price = _money(_dec(unit_price) * _dec(quantity or "1"))
    if vat_percent and _dec(vat) == 0 and _dec(net_price) != 0:
        vat = _money(_dec(net_price) * _dec(vat_percent) / Decimal("100"))
    if _dec(gross_value) == 0 and (_dec(net_price) != 0 or _dec(vat) != 0):
        gross_value = _money(_dec(net_price) + _dec(vat))
    if not quantity:
        quantity = "1"
    return {
        "number": 0,
        "item": item,
        # The line description is entered explicitly on the requisition. Keep
        # it separate from the SunSystems item's own description shown beside
        # its code in the Item column.
        "description": description,
        "uom": uom,
        "quantity": quantity,
        "unit_price": unit_price,
        "net_price": net_price,
        "vat_percent": vat_percent,
        "vat": vat,
        "gross_value": gross_value,
        "currency": currency,
    }


# ── misc helpers ────────────────────────────────────────────────────────────────
def _supplier_details(values: dict, meta: dict, sections: list, *, table_key=None) -> tuple[str, str, str, str, str]:
    raw = _form_supplier_value(values, sections, table_key=table_key)
    code, name, email, phone, address = _supplier_value_parts(raw)
    if code:
        resolved = _query_supplier_details(code)
        name = name or resolved.get("name", "")
        email = email or resolved.get("email", "")
        phone = phone or resolved.get("phone", "")
        address = address or resolved.get("address", "")
        return code, name, email, phone, address
    # Fall back to the configured constant so the printed LPO still names a
    # supplier when only the mapping knows it.
    po = ((meta.get("sunsystems") or {}).get("journal") or {}).get("purchase_order") or {}
    # Resolve configured header, table-row and default sources in the same
    # order as PurchaseOrder posting. In particular, a selected table supplier
    # must beat the configured default supplier.
    code = ""
    for configured in (po.get("supplier_code"), po.get("supplier_code_fallback"), po.get("supplier_code_default")):
        if isinstance(configured, dict) and isinstance(configured.get("sources"), list):
            candidates = configured["sources"]
            if table_key:
                candidates = [candidate for candidate in candidates if candidate.get("table") == table_key]
        else:
            candidates = [configured]
        for candidate in candidates:
            if isinstance(candidate, dict):
                code = _as_text(candidate.get("const"))
                if not code and candidate.get("field"):
                    code = _as_text(values.get(candidate["field"]))
                if not code and candidate.get("table") and candidate.get("row_field"):
                    if table_key and candidate.get("table") != table_key:
                        continue
                    rows = values.get(candidate["table"])
                    if isinstance(rows, list):
                        code = next((
                            _supplier_value_parts(row.get(candidate["row_field"]))[0]
                            for row in rows if isinstance(row, dict)
                            and row.get(candidate["row_field"]) not in (None, "", [], {})
                        ), "")
            else:
                code = _as_text(candidate)
            if code:
                break
        if code:
            break
    if code:
        resolved = _query_supplier_details(code)
        return code, resolved.get("name", ""), resolved.get("email", ""), resolved.get("phone", ""), resolved.get("address", "")
    return "", name, email, phone, address


def _query_item_description(code: str) -> str:
    """Resolve the SunSystems description for an item code used on an LPO."""
    if not code:
        return ""
    try:
        from django.core.cache import cache
        cached = cache.get(f"lpo-item-description:{code}")
        if cached is not None:
            return cached

        import xml.etree.ElementTree as ET
        from xml.sax.saxutils import escape
        from apps.sunsystems.client import SunSystemsClient, SunSystemsConfig
        from apps.sunsystems.models import effective_connection

        config = SunSystemsConfig.from_mapping(effective_connection())
        business_unit = escape(config.business_unit or "PK1")
        item_code = escape(code)
        payload = (
            "<SSC><ErrorContext/><User/>"
            f"<SunSystemsContext><BusinessUnit>{business_unit}</BusinessUnit></SunSystemsContext>"
            "<Payload><Filter>"
            f"<Item name=\"/Item/ItemCode\" operator=\"EQU\" value=\"{item_code}\"/>"
            "</Filter><Select><Item><ItemCode>.</ItemCode><Description>.</Description>"
            "</Item></Select></Payload></SSC>"
        )
        response = SunSystemsClient(config).execute("Item", "Query", payload)
        item = ET.fromstring(response or "<SSC/>").find(".//Item")
        description = (item.findtext("Description") or "").strip() if item is not None else ""
        cache.set(f"lpo-item-description:{code}", description, 3600)
        return description
    except Exception:
        logger.exception("Could not resolve SunSystems item %s for LPO", code)
        return ""


def _form_supplier_value(values: dict, sections: list, *, table_key=None):
    def is_supplier(field):
        return (
            field.get("type") == "sunsystems_account"
            or (field.get("sunsystems") or {}).get("role") == "supplier_code"
            or "supplier" in str(field.get("label") or "").lower()
        )

    for section in sections or []:
        for field in section.get("fields") or []:
            if field.get("type") == "table":
                if table_key and field.get("key") != table_key:
                    continue
                columns = [column for column in (field.get("columns") or []) if is_supplier(column)]
                rows = values.get(field.get("key")) or []
                for column in columns:
                    for row in rows:
                        if isinstance(row, dict) and row.get(column.get("key")) not in (None, "", [], {}):
                            return row[column.get("key")]
            elif is_supplier(field) and field.get("key") and values.get(field["key"]) not in (None, "", [], {}):
                return values[field["key"]]
    return values.get("supplier_wudn") or values.get("supplier") or ""


def _supplier_value_parts(raw) -> tuple[str, str, str, str, str]:
    if isinstance(raw, (list, tuple)):
        raw = next((item for item in raw if item not in (None, "", [], {})), "")
    if isinstance(raw, dict):
        return (
            _as_text(raw.get("account_code") or raw.get("accountCode") or raw.get("supplier_code") or raw.get("SupplierCode") or raw.get("code") or raw.get("id") or raw.get("value")),
            _as_text(raw.get("SupplierName") or raw.get("supplier_name") or raw.get("name") or raw.get("label") or raw.get("description")),
            _as_text(raw.get("EMailAddress") or raw.get("email")),
            _as_text(raw.get("PhoneNumber") or raw.get("phone") or raw.get("telephone")),
            _as_text(raw.get("Address") or raw.get("address")),
        )
    return _as_text(raw), "", "", "", ""


def _query_supplier_details(code: str) -> dict[str, str]:
    """Resolve selected supplier details from the same SunSystems Query used by the supplier directory."""
    try:
        import xml.etree.ElementTree as ET
        from xml.sax.saxutils import escape
        from apps.sunsystems.client import SunSystemsClient, SunSystemsConfig
        from apps.sunsystems.models import effective_connection

        config = SunSystemsConfig.from_mapping(effective_connection())
        bu = escape(config.business_unit or "PK1")
        code_xml = escape(code)
        payload = (
            "<SSC><ErrorContext/><User/>"
            f"<SunSystemsContext><BusinessUnit>{bu}</BusinessUnit></SunSystemsContext><Payload>"
            f"<Filter><Item name=\"/Supplier/SupplierCode\" operator=\"EQU\" value=\"{code_xml}\"/></Filter>"
            "<Select><Supplier><Description>.</Description><EMailAddress>.</EMailAddress>"
            "<SupplierCode>.</SupplierCode><SupplierName>.</SupplierName><SupplierAddress>"
            "<AddressLine1>.</AddressLine1><AddressLine2>.</AddressLine2>"
            "<AddressLine3>.</AddressLine3><AddressLine4>.</AddressLine4>"
            "<AddressLine5>.</AddressLine5><Country>.</Country><PostalCode>.</PostalCode>"
            "<TelephoneNumber>.</TelephoneNumber><TownCity>.</TownCity>"
            "</SupplierAddress></Supplier></Select>"
            "</Payload></SSC>"
        )
        response = SunSystemsClient(config).execute("Supplier", "Query", payload)
        supplier = ET.fromstring(response or "<SSC/>").find(".//Supplier")
        if supplier is None:
            return {}
        address_node = supplier.find("SupplierAddress")
        address = " ".join(filter(None, (
            (address_node.findtext(f"AddressLine{i}") or "").strip() for i in range(1, 6)
        ))) if address_node is not None else ""
        if address_node is not None:
            city = (address_node.findtext("TownCity") or "").strip()
            country = (address_node.findtext("Country") or "").strip()
            postal = (address_node.findtext("PostalCode") or "").strip()
            address = ", ".join(filter(None, (address, city, postal, country)))
        return {
            "name": (supplier.findtext("SupplierName") or supplier.findtext("Description") or "").strip(),
            "email": (supplier.findtext("EMailAddress") or "").strip(),
            "phone": (address_node.findtext("TelephoneNumber") or "").strip() if address_node is not None else "",
            "address": address,
        }
    except Exception:
        logger.exception("Could not resolve SunSystems supplier %s for LPO", code)
        return {}


def _first_currency(values: dict, lines: list[dict]) -> str:
    for line in lines:
        text = _as_text(line.get("currency"))
        if text:
            return text
    for field in ("currency_8ia7", "currency_poa7", "currency"):
        text = _as_text(values.get(field))
        if text:
            return text
    return ""


def _ticket_expiry_date(values: dict, sections: list) -> str:
    """Find the form value whose field label is Ticket expiry date."""
    for section in sections or []:
        for field in section.get("fields") or []:
            label = " ".join(str(field.get(k) or "") for k in ("label", "title")).strip().lower()
            if "ticket expiry date" in label:
                value = _as_text(values.get(field.get("key")))
                if value:
                    return value
    return ""


def _requestor_name(values: dict, sections: list) -> str:
    for known_key in ("requested_by_copy", "requestor", "requester", "requisitioner"):
        value = _as_text(values.get(known_key))
        if value:
            return value
    for section in sections or []:
        for field in section.get("fields") or []:
            label = " ".join(str(field.get(k) or "") for k in ("label", "title")).strip().lower()
            if any(token in label for token in ("requisitioner", "requestor", "requester", "requested by", "raised by")):
                value = _as_text(values.get(field.get("key")))
                if value:
                    return value
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
