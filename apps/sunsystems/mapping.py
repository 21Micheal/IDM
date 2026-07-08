"""
apps/sunsystems/mapping.py

The declarative form → SunSystems translation layer.

A form template carries a small JSON *mapping* describing how its filled values
become a SunSystems ``<SSC>`` document. Our engine compiles that mapping into the
exact XML SunSystems Connect expects — there is **no hand-authored XML or JS** in
the product (contrast the UniFi reference connector, which hand-writes the SOAP
template and massages fields in JavaScript). Everything an integrator needs to
vary is data in the mapping.

Mapping shape (all value slots accept a *ValueSpec*; see :func:`resolve_value`)::

    {
      "enabled": true,
      "post_on": "approved",                 # workflow outcome that triggers posting
      "component": "Journal", "method": "Import",
      "context":    { "business_unit": {"const": "ZRD"}, "budget_code": {"const": "A"} },
      "parameters": { "JournalType": "PIINV", "PostingType": "2", ... },  # LedgerPostingParameters
      "currency":   { "const": "GBP" },       # default line CurrencyCode
      "reference":  { "field": "reference" }, # default line TransactionReference
      "date":       { "field": "travel_start_date", "format": "DDMMYYYY" },
      "analysis_defaults": { "1": {"const": "#"}, "2": {"const": "#"} },
      "validate_balance": true,
      "lines": [
        { "account": {"const": "CAND001"}, "dc": "C",
          "amount": {"field": "total_actual_expenditure"},
          "description": {"field": "purpose_of_travel"} },
        { "repeat_over": "table_1", "account": {"const": "37400"}, "dc": "D",
          "amount": {"row_field": "actual_amount"},
          "description": {"row_field": "category_description"},
          "analysis": { "6": {"field": "tax_code"} } }
      ]
    }

A *ValueSpec* is a bare literal, or a dict with one source — ``const`` / ``field``
(header scope) / ``row_field`` (only inside a ``repeat_over`` line) — plus optional
``default`` and ``format`` (date reformatting).
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field as dc_field
from decimal import Decimal, InvalidOperation
from typing import Any, Iterator
from xml.etree import ElementTree as ET

# Order of <Line> children, matching the SunSystems Connect Ledger Import shape.
_ANALYSIS_CODES = list(range(1, 11))  # AnalysisCode1 … AnalysisCode10


class MappingError(ValueError):
    """Raised when a mapping is malformed or produces an unpostable journal."""


@dataclass
class JournalBuild:
    """Result of compiling a mapping + form values into an SSC document."""

    component: str
    method: str
    ssc_xml: str
    line_count: int
    debit_total: Decimal
    credit_total: Decimal
    warnings: list[str] = dc_field(default_factory=list)

    @property
    def balanced(self) -> bool:
        return abs(self.debit_total - self.credit_total) < Decimal("0.01")


# ── value resolution ───────────────────────────────────────────────────────────
def resolve_value(spec: Any, values: dict, row: dict | None = None, *, default: str = "") -> str:
    """Resolve a ValueSpec to a string against header ``values`` (and a table
    ``row`` when inside a ``repeat_over`` line)."""
    if spec is None:
        return default
    if not isinstance(spec, dict):
        return _to_str(spec)

    if "const" in spec:
        raw = spec.get("const")
    elif "row_field" in spec:
        raw = (row or {}).get(spec["row_field"]) if row is not None else None
    elif "field" in spec:
        raw = (values or {}).get(spec["field"])
    else:
        raw = None

    if raw in (None, ""):
        raw = spec.get("default", default)

    fmt = spec.get("format")
    if fmt:
        raw = _apply_format(raw, fmt)
    return _to_str(raw)


def resolve_amount(spec: Any, values: dict, row: dict | None = None) -> Decimal:
    """Resolve a ValueSpec to a Decimal amount (0 when blank/unparseable)."""
    text = resolve_value(spec, values, row, default="0")
    text = re.sub(r"[,\s]", "", text)
    if text in ("", "-"):
        return Decimal("0")
    try:
        return Decimal(text)
    except InvalidOperation:
        return Decimal("0")


# ── journal build ──────────────────────────────────────────────────────────────
def build_sunsystems_ssc(
    mapping: dict,
    values: dict,
    *,
    business_unit_default: str = "",
    budget_code_default: str = "A",
    pretty: bool = False,
) -> JournalBuild:
    """Compile a mapping into the appropriate SSC payload for its component."""
    component = str((mapping or {}).get("component") or "Journal").strip().lower()
    if component == "purchaseorder":
        return build_purchase_order_ssc(
            mapping,
            values,
            business_unit_default=business_unit_default,
            budget_code_default=budget_code_default,
            pretty=pretty,
        )
    return build_journal_ssc(
        mapping,
        values,
        business_unit_default=business_unit_default,
        budget_code_default=budget_code_default,
        pretty=pretty,
    )


def build_journal_ssc(
    mapping: dict,
    values: dict,
    *,
    business_unit_default: str = "",
    budget_code_default: str = "A",
    pretty: bool = False,
) -> JournalBuild:
    """Compile a mapping + filled form values into the ``<SSC>`` journal XML.

    ``pretty`` indents the XML for human reading (e.g. the payload preview UI);
    SunSystems ignores the whitespace, so the posting path leaves it off.
    """
    if not isinstance(mapping, dict):
        raise MappingError("Journal mapping is missing or not an object.")

    component = (mapping.get("component") or "Journal").strip()
    method = (mapping.get("method") or "Import").strip()
    context = mapping.get("context") or {}
    warnings: list[str] = []

    ssc = ET.Element("SSC")

    ctx_el = ET.SubElement(ssc, "SunSystemsContext")
    ET.SubElement(ctx_el, "BusinessUnit").text = (
        resolve_value(context.get("business_unit"), values, default=business_unit_default)
        or business_unit_default
    )
    ET.SubElement(ctx_el, "BudgetCode").text = (
        resolve_value(context.get("budget_code"), values, default=budget_code_default)
        or budget_code_default
    )

    method_ctx = ET.SubElement(ssc, "MethodContext")
    params_el = ET.SubElement(method_ctx, "LedgerPostingParameters")
    for name, spec in (mapping.get("parameters") or {}).items():
        # Parameter keys are the literal SunSystems element names (e.g.
        # "JournalType"); their values resolve as ValueSpecs/literals.
        ET.SubElement(params_el, str(name)).text = resolve_value(spec, values)

    payload_el = ET.SubElement(ssc, "Payload")
    ledger_el = ET.SubElement(payload_el, "Ledger")

    debit_total = Decimal("0")
    credit_total = Decimal("0")
    line_count = 0

    for line_spec, row in _iter_lines(mapping, values, warnings):
        amount = resolve_amount(line_spec.get("amount"), values, row)
        dc = _resolve_dc(line_spec.get("dc"), values, row)
        _append_line(ledger_el, mapping, line_spec, values, row, amount, dc)
        line_count += 1
        if dc == "C":
            credit_total += amount
        else:
            debit_total += amount

    if line_count == 0:
        raise MappingError("Journal mapping produced no ledger lines.")

    if pretty:
        try:
            ET.indent(ssc, space="  ")
        except AttributeError:  # pragma: no cover - Python < 3.9
            pass

    build = JournalBuild(
        component=component,
        method=method,
        ssc_xml=_serialize(ssc),
        line_count=line_count,
        debit_total=debit_total,
        credit_total=credit_total,
        warnings=warnings,
    )

    if mapping.get("validate_balance", True) and not build.balanced:
        raise MappingError(
            f"Journal does not balance: debits {debit_total} ≠ credits {credit_total}."
        )
    return build


def build_purchase_order_ssc(
    mapping: dict,
    values: dict,
    *,
    business_unit_default: str = "",
    budget_code_default: str = "A",
    pretty: bool = False,
) -> JournalBuild:
    """Compile a minimal PurchaseOrder/CreateOrAmend SSC payload.

    This mirrors the proven LPO test payload while keeping the real business
    values mapped from the form. Constants can be promoted to builder controls
    later as SunSystems confirms which fields should vary by template.
    """
    if not isinstance(mapping, dict):
        raise MappingError("Purchase order mapping is missing or not an object.")

    po = mapping.get("purchase_order") or {}
    context = mapping.get("context") or {}
    component = (mapping.get("component") or "PurchaseOrder").strip()
    method = (mapping.get("method") or "CreateOrAmend").strip()

    reference = resolve_value(po.get("reference") or mapping.get("reference"), values)
    amount = resolve_amount(po.get("amount"), values)
    currency = resolve_value(po.get("currency") or mapping.get("currency"), values)
    description = resolve_value(po.get("description"), values)

    missing = []
    if not reference:
        missing.append("reference")
    if amount <= 0:
        missing.append("amount")
    if not currency:
        missing.append("currency")
    if missing:
        raise MappingError(f"Purchase order mapping produced missing/invalid fields: {', '.join(missing)}.")

    ssc = ET.Element("SSC")
    ctx_el = ET.SubElement(ssc, "SunSystemsContext")
    ET.SubElement(ctx_el, "BusinessUnit").text = (
        resolve_value(context.get("business_unit"), values, default=business_unit_default)
        or business_unit_default
    )
    # BudgetCode is a journal/ledger concept; purchase orders don't include it.

    payload_el = ET.SubElement(ssc, "Payload")
    order_el = ET.SubElement(payload_el, "PurchaseOrder")
    ET.SubElement(order_el, "Comment").text = description
    ET.SubElement(order_el, "InvoiceAddressCode").text = resolve_value(po.get("invoice_address_code"), values, default="0000000000")
    ET.SubElement(order_el, "PurchaseTransactionType").text = resolve_value(po.get("transaction_type"), values, default="ASSETS")
    ET.SubElement(order_el, "PurchaseOrderReference").text = reference
    ET.SubElement(order_el, "SecondReference").text = resolve_value(po.get("second_reference"), values)
    ET.SubElement(order_el, "SupplierCode").text = resolve_value(po.get("supplier_code"), values, default="81105")

    # Resolve order quantity — defaults to "1" for non-inventory / service LPOs.
    quantity_str = resolve_value(po.get("quantity"), values, default="1") or "1"

    line_el = ET.SubElement(order_el, "PurchaseOrderLine")
    ET.SubElement(line_el, "AccountCode").text = resolve_value(po.get("account_code"), values)
    ET.SubElement(line_el, "CurrencyCode").text = currency
    ET.SubElement(line_el, "ItemCode").text = resolve_value(po.get("item_code"), values, default="ITM29")
    ET.SubElement(line_el, "LineNumber").text = "1"
    ET.SubElement(line_el, "OrderDate").text = resolve_value(po.get("date") or mapping.get("date"), values)
    ET.SubElement(line_el, "UserLineNumber").text = "1"

    analysis_qty = ET.SubElement(line_el, "AnalysisQuantity")
    ET.SubElement(analysis_qty, "Quantity").text = quantity_str
    analysis = dict(po.get("analysis") or {})
    analysis.setdefault("10", {
        "category": po.get("analysis10_category", {"const": ""}),
        "code": po.get("analysis10_code", {"const": ""}),
    })
    for n in _ANALYSIS_CODES:
        spec = analysis.get(str(n)) or {}
        category = resolve_value(spec.get("category"), values)
        code = resolve_value(spec.get("code"), values)
        # Skip entries where both category and code are empty.
        if not category and not code:
            continue
        analysis_el = ET.SubElement(analysis_qty, f"Analysis{n}")
        ET.SubElement(analysis_el, "VPolCatAnalysis_AnlCatId").text = category
        ET.SubElement(analysis_el, "VPolCatAnalysis_AnlCode").text = code

    # VLAB7 Base = the per-unit quantity/rate value (matches the proven test
    # payload: VLAB7=1 for a single-unit order). VLAB9 Trans = total value.
    vlab7 = ET.SubElement(line_el, "VLAB7")
    base = ET.SubElement(vlab7, "Base")
    ET.SubElement(base, "VPolVlabEntry_Val").text = quantity_str

    vlab9 = ET.SubElement(line_el, "VLAB9")
    trans = ET.SubElement(vlab9, "Trans")
    ET.SubElement(trans, "VPolVlabEntry_Val").text = _amount_str(amount)

    if pretty:
        try:
            ET.indent(ssc, space="  ")
        except AttributeError:  # pragma: no cover - Python < 3.9
            pass

    return JournalBuild(
        component=component,
        method=method,
        ssc_xml=_serialize(ssc),
        line_count=1,
        debit_total=amount,
        credit_total=Decimal("0"),
        warnings=[],
    )


def _iter_lines(mapping: dict, values: dict, warnings: list[str]) -> Iterator[tuple[dict, dict | None]]:
    for line_spec in (mapping.get("lines") or []):
        if not isinstance(line_spec, dict):
            continue
        repeat = line_spec.get("repeat_over")
        if repeat:
            rows = values.get(repeat)
            if not isinstance(rows, list):
                warnings.append(f"Table '{repeat}' has no rows; its lines were skipped.")
                continue
            for row in rows:
                if isinstance(row, dict):
                    yield line_spec, row
        else:
            yield line_spec, None


def _append_line(
    ledger_el: ET.Element,
    mapping: dict,
    line_spec: dict,
    values: dict,
    row: dict | None,
    amount: Decimal,
    dc: str,
) -> None:
    line_el = ET.SubElement(ledger_el, "Line")
    ET.SubElement(line_el, "AccountCode").text = resolve_value(line_spec.get("account"), values, row)

    analysis = dict(mapping.get("analysis_defaults") or {})
    analysis.update(line_spec.get("analysis") or {})
    for n in _ANALYSIS_CODES:
        spec = analysis.get(str(n), analysis.get(n))
        if spec is None:
            continue
        ET.SubElement(line_el, f"AnalysisCode{n}").text = resolve_value(spec, values, row)

    ET.SubElement(line_el, "TransactionAmount").text = _amount_str(amount)
    ET.SubElement(line_el, "CurrencyCode").text = resolve_value(
        line_spec.get("currency") or mapping.get("currency"), values, row
    )
    ET.SubElement(line_el, "DebitCredit").text = dc
    ET.SubElement(line_el, "Description").text = resolve_value(line_spec.get("description"), values, row)
    ET.SubElement(line_el, "TransactionReference").text = resolve_value(
        line_spec.get("reference") or mapping.get("reference"), values, row
    )
    ET.SubElement(line_el, "TransactionDate").text = resolve_value(
        line_spec.get("date") or mapping.get("date"), values, row
    )

    detail = line_spec.get("detail") or mapping.get("detail")
    if detail:
        lad = ET.SubElement(line_el, "DetailLad")
        for i in (1, 2, 3):
            ET.SubElement(lad, f"GeneralDescription{i}").text = resolve_value(
                detail.get(f"general_description{i}"), values, row
            )


def _resolve_dc(spec: Any, values: dict, row: dict | None) -> str:
    raw = resolve_value(spec, values, row, default="D").strip().upper()
    return "C" if raw.startswith("C") else "D"


# ── response parsing ───────────────────────────────────────────────────────────
@dataclass
class JournalResult:
    ok: bool
    journal_number: str | None
    message: str
    raw: str


def parse_journal_response(xml: str) -> JournalResult:
    """Best-effort extraction of the journal number / messages from a Ledger
    Import response. Shapes vary by tenant, so match by local element name."""
    root = _parse(xml)
    if root is None:
        return JournalResult(False, None, "Unparseable SunSystems response.", xml or "")

    journal_number: str | None = None
    messages: list[str] = []
    has_error = False

    for el in root.iter():
        name = _localname(el.tag)
        text = (el.text or "").strip()
        if not text:
            continue
        if journal_number is None and name in {
            "journalnumber", "journalno", "vouchernumber", "voucher", "journal",
        }:
            journal_number = text
        elif name in {"message", "description", "errortext", "text", "messagetext"}:
            messages.append(text)
        elif name in {"errorlevel", "severity", "status"} and text.lower() in {
            "error", "fatal", "2", "3", "failed", "failure",
        }:
            has_error = True

    message = "; ".join(dict.fromkeys(messages))  # dedupe, preserve order
    ok = (not has_error) and journal_number is not None
    return JournalResult(ok=ok, journal_number=journal_number, message=message, raw=xml or "")


def parse_posting_response(component: str, xml: str) -> JournalResult:
    """Parse the response for the configured SunSystems component."""
    if str(component or "").lower() != "purchaseorder":
        return parse_journal_response(xml)

    root = _parse(xml)
    if root is None:
        return JournalResult(False, None, "Unparseable SunSystems response.", xml or "")

    reference: str | None = None
    messages: list[str] = []
    has_error = False

    for el in root.iter():
        name = _localname(el.tag)
        text = (el.text or "").strip()
        attrs = {str(k).lower(): str(v).lower() for k, v in getattr(el, "attrib", {}).items()}
        if attrs.get("status") in {"fail", "failed", "error"} or attrs.get("rejected") == "true":
            has_error = True
        if attrs.get("level") in {"error", "fatal"}:
            has_error = True
        if reference is None and not has_error and name == "purchaseorder":
            reference = el.attrib.get("Reference") or el.attrib.get("reference")
        if not text:
            continue
        if reference is None and not has_error and name in {
            "purchaseordernumber", "ordernumber",
        }:
            reference = text
        elif name in {"message", "description", "errortext", "text", "messagetext", "usertext"}:
            messages.append(text)
        elif name in {"errorlevel", "severity", "status"} and text.lower() in {
            "error", "fatal", "2", "3", "failed", "failure",
        }:
            has_error = True

    message = "; ".join(dict.fromkeys(messages))
    return JournalResult(ok=(not has_error) and bool(reference), journal_number=reference, message=message, raw=xml or "")


# ── helpers ────────────────────────────────────────────────────────────────────
def _to_str(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, dict):
        # Structured reference/user values store {id, label, source}; post the label.
        return str(value.get("label", "")) if "label" in value else ""
    return str(value)


def _amount_str(amount: Decimal) -> str:
    # Plain fixed-point string (no scientific notation), e.g. "6000" / "2000.50".
    return format(amount, "f")


def _apply_format(raw: Any, fmt: str) -> str:
    s = str(raw)
    m = re.match(r"(\d{4})-(\d{2})-(\d{2})", s)
    if not m:
        return s
    y, mo, d = m.groups()
    f = str(fmt).upper().replace("-", "").replace("/", "")
    return {
        "DDMMYYYY": f"{d}{mo}{y}",
        "YYYYMMDD": f"{y}{mo}{d}",
        "MMDDYYYY": f"{mo}{d}{y}",
    }.get(f, s)


def _localname(tag: str) -> str:
    return tag.rsplit("}", 1)[-1].lower()


def _parse(xml: str) -> ET.Element | None:
    if not xml:
        return None
    try:
        return ET.fromstring(xml.encode("utf-8") if isinstance(xml, str) else xml)
    except ET.ParseError:
        return None


def _serialize(el: ET.Element) -> str:
    return ET.tostring(el, encoding="unicode")
