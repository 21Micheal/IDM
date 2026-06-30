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
