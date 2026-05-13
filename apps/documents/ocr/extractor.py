"""
apps/documents/ocr/extractor.py  — v3

Structured field extraction from OCR text.

What changed from v2
────────────────────
AMBIGUOUS GRID DISAMBIGUATION (primary fix for misclassifications)
  The root cause of most misclassifications on real invoices is a single-row
  header grid like:

      SUPPLIER        ACCOUNT CODE    INVOICE DATE    AMOUNT
      ACME LTD        400-211         2025-01-15      45,000.00

  OCR reconstructs this as a single tab-separated line. The v2 extractor
  attempted to parse these grids but had three failure modes:

  1. _extract_supplier() priority-3 positional pass treated the entire
     tab-joined line as the supplier candidate, returning
     "ACME LTD\t400-211\t2025-01-15\t45,000.00" before truncation.
     Fixed: the positional pass now splits on tabs and takes only the
     FIRST cell, then validates it as a non-date, non-numeric string.

  2. _extract_account_code() header-grid function matched the value row
     correctly but then _clean_inline_value() on the extracted token
     stripped the trailing content using INLINE_SPLIT_RE — which included
     a pattern that consumed digits, so "400-211" was returned as "400".
     Fixed: _clean_inline_value() is NOT applied to header-grid values
     (they are already clean, single-cell tokens from _split_cells).

  3. _extract_reference() general-pattern fired on account codes (both
     match the [A-Z]{1,6}[-/]\w pattern).  Fixed by running the
     doc-type-specific pattern FIRST and only falling back to "general"
     when it finds no match; also added _REF_REJECT to filter codes that
     are purely numeric with fewer than 5 digits (these are GL codes).

HEADER-GRID FIRST-PASS
  New _extract_header_grid() function runs before all other extractors.
  It scans the first 20 lines for tab/pipe-separated rows, builds a
  header→value map, and populates fields with high precision.  Subsequent
  extractors only fill gaps that _extract_header_grid() missed.

DATE EXTRACTION
  _extract_dates(): the absolute fallback now skips any match whose
  position in the text is inside a number-heavy region (amount / ref
  number lines), which was the main cause of numeric ref IDs being
  classified as dates.

SUPPLIER EXTRACTION
  Added a "hard blocklist" of known non-supplier first-line patterns
  (dates, phone numbers, pure numbers, single-word country names) so
  the positional pass doesn't pick up header text that appears before
  the actual company name.

AMOUNT EXTRACTION
  _best_amount(): total-label regex now also accepts "TOTAL DUE",
  "BALANCE DUE", "AMOUNT PAYABLE" — common on East African receipts.
  Currency symbol disambiguation improved for KES vs KSH vs Kshs.

NEW: _extract_header_grid()
  Parses the canonical two-row invoice header:
      SUPPLIER  |  ACCOUNT CODE  |  INVOICE DATE  |  DUE DATE  |  AMOUNT
      ACME LTD  |  400-211       |  2025-01-15    |  2025-02-15|  45000
  and directly populates supplier, account_code, document_date,
  due_date, amount, reference_number, cost_centre, currency.

ALL V2 BUG FIXES CARRIED FORWARD (see v2 changelog for details).
"""
from __future__ import annotations

import logging
import re
from datetime import datetime
from dataclasses import dataclass
from typing import Optional, List, Dict, Any

logger = logging.getLogger(__name__)


# ═══════════════════════════════════════════════════════════════════════════════
# Document-type classification
# ═══════════════════════════════════════════════════════════════════════════════

_DOCTYPE_PATTERNS: list[tuple[re.Pattern, str, str]] = [
    (re.compile(r"\b(?:local\s+purchase\s+order|l\.?p\.?o\.?)\b",        re.I), "purchase_order",  "Local Purchase Order"),
    (re.compile(r"\bpurchase\s+order\b",                                   re.I), "purchase_order",  "Purchase Order"),
    (re.compile(r"\btax\s+invoice\b",                                      re.I), "invoice",         "Tax Invoice"),
    (re.compile(r"\binvoice\b",                                            re.I), "invoice",         "Invoice"),
    (re.compile(r"\b(?:service\s+agreement|service\s+contract)\b",         re.I), "contract",        "Service Agreement"),
    (re.compile(r"\bcontract\b",                                           re.I), "contract",        "Contract"),
    (re.compile(r"\bagreement\b",                                          re.I), "contract",        "Agreement"),
    (re.compile(r"\b(?:official\s+receipt|receipt)\b",                     re.I), "receipt",         "Receipt"),
    (re.compile(r"\b(?:delivery\s+note|goods\s+received\s+note|g\.?r\.?n\.?)\b", re.I), "delivery_note", "Delivery Note"),
    (re.compile(r"\bcredit\s+note\b",                                      re.I), "credit_note",     "Credit Note"),
    (re.compile(r"\bdebit\s+note\b",                                       re.I), "debit_note",      "Debit Note"),
    (re.compile(r"\b(?:quotation|quote|pro.?forma)\b",                     re.I), "quotation",       "Quotation"),
    (re.compile(r"\bexpense\s+(?:claim|report|form)\b",                    re.I), "expense_claim",   "Expense Claim"),
    (re.compile(r"\b(?:imprest|petty\s+cash)\b",                           re.I), "imprest",         "Imprest"),
    (re.compile(r"\bpayment\s+voucher\b",                                  re.I), "payment_voucher", "Payment Voucher"),
    (re.compile(r"\bvoucher\b",                                            re.I), "payment_voucher", "Voucher"),
    (re.compile(r"\b(?:electricity|water|utility)\s+bill\b",               re.I), "utility_bill",    "Utility Bill"),
    (re.compile(r"\bstatement\s+of\s+account\b",                           re.I), "statement",       "Statement of Account"),
    (re.compile(r"\bbill\b",                                               re.I), "invoice",         "Bill"),
]


# ═══════════════════════════════════════════════════════════════════════════════
# Shared regex building blocks
# ═══════════════════════════════════════════════════════════════════════════════

_SEP = r"\s*[:\-]?\s*"

_DATE_VALUE_PAT = (
    r"(\d{4}[-/]\d{1,2}[-/]\d{1,2}"
    r"|\d{1,2}[/.\-]\d{1,2}[/.\-]\d{2,4}"
    r"|(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?"
    r"|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)"
    r"\s+\d{1,2},?\s+\d{4}"
    r"|\d{1,2}\s+(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?"
    r"|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)"
    r"\s+\d{4})"
)

_ISO_CURRENCIES = (
    r"(?:USD|EUR|GBP|KES|KSH|UGX|TZS|RWF|ETB|NGN|GHS|ZAR|JPY|CAD|AUD|CHF|CNY|INR)"
)

_SYMBOL_TO_ISO: dict[str, str] = {
    "$": "USD", "€": "EUR", "£": "GBP",
    "Ksh": "KES", "KSh": "KES", "Kshs": "KES",
    "UShs": "UGX", "TSh": "TZS",
}

_CURRENCY_ALIASES: dict[str, str] = {
    "KSH": "KES", "KSHS": "KES", "KSH.": "KES",
    "KENYA SHILLING": "KES", "KENYA SHILLINGS": "KES",
    "USHS": "UGX", "UGANDA SHILLING": "UGX",
    "TSH": "TZS", "TANZANIA SHILLING": "TZS",
}

_AMOUNT_PAT = re.compile(
    rf"(?:({_ISO_CURRENCIES}|Ksh\.?|KSh\.?|Kshs\.?|UShs\.?|TSh\.?)\s*"
    rf"|[\$€£]\s*)"
    rf"(\d{{1,3}}(?:[,\s]\d{{3}})*(?:[.,]\d{{1,4}})?)"
    rf"|(\d{{1,3}}(?:[,\s]\d{{3}})*(?:[.,]\d{{1,4}})?)"
    rf"\s*({_ISO_CURRENCIES}|Ksh\.?|KSh\.?|Kshs\.?|UShs\.?|TSh\.?)",
    re.IGNORECASE,
)
_SYMBOL_PAT = re.compile(r"[\$€£]")


# ═══════════════════════════════════════════════════════════════════════════════
# Header-grid first pass  (NEW in v3 — primary fix for ambiguous layouts)
# ═══════════════════════════════════════════════════════════════════════════════

# Column header → canonical field name mapping
# Keys are lowercase normalised cell text; values are canonical field names.
_GRID_HEADER_MAP: dict[str, str] = {
    # Supplier / vendor
    "supplier":            "supplier",
    "vendor":              "supplier",
    "vendor name":         "supplier",
    "supplier name":       "supplier",
    "billed by":           "supplier",
    "issued by":           "supplier",
    "payee":               "supplier",
    "company":             "supplier",
    "company name":        "supplier",
    # Account / GL code
    "account code":        "account_code",
    "account no":          "account_code",
    "account number":      "account_code",
    "a/c":                 "account_code",
    "a/c no":              "account_code",
    "a/c code":            "account_code",
    "gl code":             "account_code",
    "g/l code":            "account_code",
    "ledger code":         "account_code",
    "project code":        "account_code",
    "billing code":        "account_code",
    "customer no":         "account_code",
    "client no":           "account_code",
    "meter no":            "account_code",
    "meter number":        "account_code",
    # Cost centre
    "cost centre":         "cost_centre",
    "cost center":         "cost_centre",
    "department":          "cost_centre",
    "dept":                "cost_centre",
    "department code":     "cost_centre",
    "budget code":         "cost_centre",
    # Reference number
    "invoice no":          "reference_number",
    "invoice number":      "reference_number",
    "invoice #":           "reference_number",
    "inv no":              "reference_number",
    "ref no":              "reference_number",
    "reference no":        "reference_number",
    "reference number":    "reference_number",
    "receipt no":          "reference_number",
    "po no":               "reference_number",
    "po number":           "reference_number",
    "lpo no":              "reference_number",
    "doc no":              "reference_number",
    "document no":         "reference_number",
    "voucher no":          "reference_number",
    # Dates
    "invoice date":        "document_date",
    "date":                "document_date",
    "document date":       "document_date",
    "bill date":           "document_date",
    "issue date":          "document_date",
    "order date":          "document_date",
    "receipt date":        "document_date",
    "due date":            "due_date",
    "payment due":         "due_date",
    "due":                 "due_date",
    "payment date":        "due_date",
    "effective date":      "effective_date",
    "start date":          "effective_date",
    "expiry date":         "expiry_date",
    "end date":            "expiry_date",
    "delivery date":       "delivery_date",
    # Amount
    "amount":              "amount",
    "total":               "amount",
    "total amount":        "amount",
    "invoice total":       "amount",
    "grand total":         "amount",
    "net amount":          "subtotal",
    "subtotal":            "subtotal",
    "sub total":           "subtotal",
    "vat":                 "tax_amount",
    "tax":                 "tax_amount",
    "vat amount":          "tax_amount",
    "tax amount":          "tax_amount",
    # Currency
    "currency":            "currency",
    # Vendor / supplier code
    "vendor code":         "vendor_code",
    "supplier code":       "vendor_code",
    # Payment
    "payment terms":       "payment_terms",
    "payment method":      "payment_method",
    "mode of payment":     "payment_method",
    # Approved by
    "approved by":         "approved_by",
    "authorised by":       "approved_by",
    "authorized by":       "approved_by",
    # PO reference
    "po ref":              "po_reference",
    "purchase order ref":  "po_reference",
    # Line items
    "qty":                 "quantity",
    "quantity":            "quantity",
    "description":         "description",
    "particulars":         "description",
    "uom":                 "uom",
    "unit":                "uom",
    "unit of measure":     "uom",
}

# Compiled once
_GRID_SEP_RE = re.compile(r"\t+|\|+|\s{3,}")

# Values that look like column headers, not data (reject as grid values)
_GRID_VALUE_REJECT_RE = re.compile(
    r"^(?:supplier|vendor|account\s*code|invoice\s*(?:no|date|number)|"
    r"due\s*date|amount|total|currency|qty|quantity|description|"
    r"reference|ref|date|po\s*number|unit|uom|price|rate|"
    r"cost\s*cent(?:re|er)|department|approved\s*by)$",
    re.I,
)

# Values that are clearly not the field type for supplier (dates, numbers)
_SUPPLIER_IMPLAUSIBLE_RE = re.compile(
    r"^\d{4}[-/]\d{1,2}[-/]\d{1,2}$"   # ISO date
    r"|^\d{1,2}[/.\-]\d{1,2}[/.\-]\d{2,4}$"  # other date
    r"|^\d+(?:[,.\s]\d+)*$"             # pure numeric
    r"|^[+]?\d[\d\s\-]{6,}$",           # phone number
    re.I,
)


def _normalise_header_cell(cell: str) -> str:
    """Normalise a header cell to a lookup key."""
    return re.sub(r"\s+", " ", re.sub(r"[^a-z0-9\s/]", " ", cell.lower())).strip()


def _extract_header_grid(lines: list[str]) -> dict[str, str]:
    """
    Scan the first 30 lines for a tab/pipe-separated header grid and extract
    field values from the corresponding value row.

    Handles both single-value grids (one header row + one value row) and
    multi-value grids (several header rows stacked above value rows).

    Returns a dict of {canonical_field: value}.
    """
    out: dict[str, str] = {}

    for i, line in enumerate(lines[:30]):
        # Must have at least one tab or pipe or 3+ spaces to be a grid row
        if not _GRID_SEP_RE.search(line):
            continue

        header_cells = [c.strip() for c in _GRID_SEP_RE.split(line) if c.strip()]
        if len(header_cells) < 2:
            continue

        # Check that at least half the cells are known header keywords
        norm_headers = [_normalise_header_cell(h) for h in header_cells]
        mapped = [(j, _GRID_HEADER_MAP.get(nh)) for j, nh in enumerate(norm_headers)]
        known_count = sum(1 for _, v in mapped if v is not None)

        if known_count < max(1, len(header_cells) // 2):
            continue  # Not a recognised header row

        # Look for the value row immediately below (skip blank lines)
        value_row_idx = None
        for k in range(i + 1, min(i + 4, len(lines))):
            candidate_line = lines[k].strip()
            if not candidate_line:
                continue
            value_cells = [c.strip() for c in _GRID_SEP_RE.split(candidate_line) if c.strip()]
            # Value row should have a similar cell count
            if len(value_cells) >= max(1, len(header_cells) - 1):
                value_row_idx = k
                value_cells_final = value_cells
                break

        if value_row_idx is None:
            continue

        # Map headers to values
        for (col_idx, canonical), value in zip(mapped, value_cells_final):
            if canonical is None:
                continue
            if _GRID_VALUE_REJECT_RE.match(value):
                logger.debug(
                    "_extract_header_grid: rejected header-lookalike '%s' for field '%s'",
                    value, canonical,
                )
                continue
            if canonical == "supplier" and _SUPPLIER_IMPLAUSIBLE_RE.match(value):
                logger.debug(
                    "_extract_header_grid: supplier value '%s' looks like a date/number — skip",
                    value,
                )
                continue
            # Only fill if not already set (first match wins — header grids
            # near the top of the document are more reliable)
            if canonical not in out and len(value) >= 2:
                out[canonical] = value
                logger.debug(
                    "_extract_header_grid: field='%s' value='%s' (header='%s')",
                    canonical, value, header_cells[col_idx],
                )

    return out


# ═══════════════════════════════════════════════════════════════════════════════
# Date parsing
# ═══════════════════════════════════════════════════════════════════════════════

_DATE_FORMATS = [
    "%Y-%m-%d", "%Y/%m/%d",
    "%d %B %Y", "%d %b %Y",
    "%B %d %Y", "%b %d %Y",
    "%B %d, %Y", "%b %d, %Y",
    "%d/%m/%Y", "%m/%d/%Y",
    "%d-%m-%Y", "%m-%d-%Y",
    "%d.%m.%Y", "%d/%m/%y",
]
_DAY_OF_WEEK_RE = re.compile(r"^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\w*,?\s*", re.I)


def _parse_date(s: str) -> Optional[str]:
    s = re.sub(r"\s+", " ", s.strip())
    s = _DAY_OF_WEEK_RE.sub("", s)
    for fmt in _DATE_FORMATS:
        try:
            return datetime.strptime(s, fmt).strftime("%Y-%m-%d")
        except ValueError:
            pass
    return None


def _find_first_date(text: str, label_pattern: str) -> Optional[str]:
    m = re.compile(label_pattern + r"\s*[:\-(]?\s*" + _DATE_VALUE_PAT, re.IGNORECASE).search(text)
    return _parse_date(m.group(1)) if m else None


# ═══════════════════════════════════════════════════════════════════════════════
# Amount / currency
# ═══════════════════════════════════════════════════════════════════════════════

def _normalise_currency(raw: str) -> str:
    if not raw:
        return ""
    upper = raw.upper().rstrip(".")
    return _CURRENCY_ALIASES.get(upper, upper)


def _extract_amounts(text: str) -> list[tuple[float, str]]:
    results: list[tuple[float, str]] = []
    for m in _AMOUNT_PAT.finditer(text):
        raw_cur_pre = m.group(1) or ""
        raw_val_pre = m.group(2) or ""
        raw_val_suf = m.group(3) or ""
        raw_cur_suf = m.group(4) or ""
        raw_val = (raw_val_pre or raw_val_suf).strip()
        raw_cur = (raw_cur_pre or raw_cur_suf).strip()
        if not raw_cur:
            sym = _SYMBOL_PAT.search(m.group(0))
            if sym:
                raw_cur = _SYMBOL_TO_ISO.get(sym.group(), "")
        currency = _normalise_currency(raw_cur)
        raw_val = re.sub(r"\s", "", raw_val)
        if re.search(r"\d{1,3}(?:\.\d{3})+,\d{2}$", raw_val):
            raw_val = raw_val.replace(".", "").replace(",", ".")
        else:
            raw_val = raw_val.replace(",", "")
        try:
            results.append((float(raw_val), currency))
        except ValueError:
            pass
    return results


# Extended total-label pattern — v3 adds BALANCE DUE, TOTAL DUE, AMOUNT PAYABLE
_TOTAL_LABEL_PAT = re.compile(
    r"(?:grand\s*total|total\s*amount|amount\s*due|net\s*amount|total\s*payable"
    r"|invoice\s*total|total\s*inc\.?\s*(?:tax|vat)?|total\s*sum"
    r"|balance\s*due|total\s*due|amount\s*payable|balance\s*payable)"
    r"\s*[:\-]?\s*"
    rf"(?:{_ISO_CURRENCIES}|Ksh\.?|KSh\.?|[\$€£])?\s*"
    r"(\d{1,3}(?:[,\s]\d{3})*(?:[.,]\d{1,4})?)",
    re.IGNORECASE,
)


def _best_amount(text: str) -> tuple[Optional[str], Optional[str]]:
    m = _TOTAL_LABEL_PAT.search(text)
    if m:
        amounts = _extract_amounts(m.group(0))
        if amounts:
            val, cur = amounts[0]
            return str(round(val, 2)), cur or None
    amounts = _extract_amounts(text)
    if not amounts:
        return None, None
    val, cur = max(amounts, key=lambda x: x[0])
    return str(round(val, 2)), cur or None


# ═══════════════════════════════════════════════════════════════════════════════
# Reference number extraction
# ═══════════════════════════════════════════════════════════════════════════════

_REF_REJECT: frozenset[str] = frozenset({
    "INVOICE", "INV", "REF", "PO", "DN", "LPO", "FORM",
    "RECEIPT", "CONTRACT", "ORDER", "DELIVERY", "REQUEST",
    "NO", "NUM", "NUMBER",
})

_REF_VALUE_PAT = (
    r"([A-Z]{1,6}[-/][A-Z0-9][A-Z0-9\-/]{1,29}"
    r"|[A-Z]{1,6}\d[A-Z0-9\-/]{1,29}"
    r"|\d{5,20}"  # v3: raised minimum from 4 to 5 digits to avoid GL code collision
    r")"
)

_REF_LABELS: dict[str, re.Pattern] = {
    "invoice": re.compile(
        r"(?:invoice\s*(?:no\.?|num(?:ber)?|#)|inv\.?\s*(?:no\.?|#)?)"
        + _SEP + _REF_VALUE_PAT, re.I | re.M,
    ),
    "purchase_order": re.compile(
        r"(?:(?:local\s+)?purchase\s+order\s*(?:no\.?|num(?:ber)?|#)?|p\.?o\.?\s*(?:no\.?|#)?|lpo\s*(?:no\.?|#)?)"
        + _SEP + _REF_VALUE_PAT, re.I | re.M,
    ),
    "receipt": re.compile(
        r"(?:receipt\s*(?:no\.?|#)|rcpt\.?\s*(?:no\.?|#)?)" + _SEP + _REF_VALUE_PAT,
        re.I | re.M,
    ),
    "delivery_note": re.compile(
        r"(?:delivery\s*(?:note\s*)?(?:no\.?|#)|d\.?n\.?\s*(?:no\.?|#)?)"
        + _SEP + _REF_VALUE_PAT, re.I | re.M,
    ),
    "contract": re.compile(
        r"(?:contract\s*(?:no\.?|num(?:ber)?|#)|agreement\s*(?:no\.?|#)?)"
        + _SEP + _REF_VALUE_PAT, re.I | re.M,
    ),
    "payment_voucher": re.compile(
        r"(?:voucher\s*(?:no\.?|#)|pv\s*(?:no\.?|#)?)" + _SEP + _REF_VALUE_PAT,
        re.I | re.M,
    ),
    "imprest": re.compile(
        r"(?:imprest\s*(?:no\.?|#)|request\s*(?:no\.?|#)?)" + _SEP + _REF_VALUE_PAT,
        re.I | re.M,
    ),
    "general": re.compile(
        r"(?:ref(?:erence)?\s*(?:no\.?|#)?|order\s*(?:no\.?|#)?)"
        + _SEP + r"#?" + _REF_VALUE_PAT, re.I | re.M,
    ),
}


def _extract_reference(text: str, doc_type: str) -> Optional[str]:
    """Run doc-type-specific pattern first, fall back to general only if needed."""
    # v3: doc-type-specific first, then general (not both simultaneously)
    specific = _REF_LABELS.get(doc_type)
    patterns = ([specific, _REF_LABELS["general"]] if specific and doc_type != "general"
                else [_REF_LABELS["general"]])
    for pat in patterns:
        if pat is None:
            continue
        for m in pat.finditer(text):
            val = m.group(1).strip()
            if val.upper() in _REF_REJECT or len(val) < 2:
                continue
            return val
    return None


# ═══════════════════════════════════════════════════════════════════════════════
# Supplier extraction
# ═══════════════════════════════════════════════════════════════════════════════

_SUPPLIER_INLINE_RE = re.compile(
    r"(?:vendor|supplier|service\s*provider|sold\s*by|issued\s*by"
    r"|vendor\s*name|supplier\s*name|company\s*name"
    r"|billed?\s*(?:from|by)|business\s*name"
    r"|payee(?:\s*name)?|pay(?:able)?\s*to|in\s*favour\s*of"
    r"|beneficiary(?:\s*name)?|sold\s*to|shipped?\s*(?:by|from)"
    r"|prepared\s*by|raised\s*by|party\s*(?:a|one|1)"
    r"|contractor|consultant)"
    r"\s*[:\-]\s*(.+)",
    re.I,
)

_SUPPLIER_HEADER_RE = re.compile(
    r"^(?:supplier|vendor|service\s*provider)\s*(?:details?|info(?:rmation)?|address)?$",
    re.I,
)

_SUPPLIER_REJECT_RE = re.compile(
    r"@"
    r"|\b(?:l\.?p\.?o|p\.?o\.?\s*box)\b"
    r"|\b(?:tel|phone|fax|mobile|cell)\b"
    r"|\bwww\."
    r"|\d{7,}"
    r"|\bno\.?\s*[:\-]\s*\d",
    re.I,
)

# v3: hard blocklist for positional pass — these patterns in a first line
# almost certainly mean the actual supplier is on the NEXT line
_SUPPLIER_FIRSTLINE_REJECT_RE = re.compile(
    r"^\d{4}[-/]\d{1,2}[-/]\d{1,2}$"                   # ISO date
    r"|^\d{1,2}[/.\-]\d{1,2}[/.\-]\d{2,4}$"            # other date
    r"|^\d+(?:[,.\s]\d+)*$"                             # pure numeric
    r"|^[+]?\d[\d\s\-]{6,}$"                            # phone number
    r"|^(?:Kenya|Uganda|Tanzania|Rwanda|Ghana|Nigeria|South Africa)$"  # country
    r"|^(?:invoice|receipt|delivery|contract|purchase\s*order|lpo|quotation|voucher|statement)$",  # doc type heading
    re.I,
)

_INLINE_SPLIT_RE = re.compile(
    r"\s{2,}|\t|\||\b(?:tel|phone|mobile|email|e-?mail|www\.|p\.?\s*o\.?\s*box|"
    r"invoice\s*(?:no|date)|account\s*(?:code|no)|due\s*date|date)\b",
    re.I,
)

_TRAILING_PAYMENT_RE = re.compile(
    r"\s+(?:payment\s+pending|pending\s+payment|payment\s+due|due|pending|payable)\s*$",
    re.I,
)

_ANOTHER_LABEL_RE  = re.compile(r"^[A-Za-z][A-Za-z0-9 /.\-]{1,40}:\s+\S")
_ENTITY_TRUNCATE_RE = re.compile(
    r"^(.{0,80}?\b(?:LLC|Ltd\.?|Limited|Inc\.?|Corp\.?|GmbH|PLC|LLP|S\.A\.?|Pty\.?))"
    r"(?:[\s,.]|$)",
    re.I,
)
_DOCTYPE_HEADING_RE_SUPPLIER = re.compile(
    r"\b(?:invoice|receipt|purchase\s*order|lpo|delivery\s*note|contract"
    r"|agreement|quotation|expense|imprest|voucher|statement)\b",
    re.I,
)
_BILL_TO_RE = re.compile(r"\bbill(?:ed)?\s*to\b|\bship(?:ped)?\s*to\b", re.I)


def _clean_inline_value(value: str, max_len: int = 120) -> str:
    value = re.sub(r"\s+", " ", value).strip(" \t:-|")
    value = _INLINE_SPLIT_RE.split(value, maxsplit=1)[0]
    value = _TRAILING_PAYMENT_RE.sub("", value)
    return value.strip(" \t:-,|")[:max_len]


def _extract_supplier(lines: list[str]) -> Optional[str]:
    def _is_valid(candidate: str) -> bool:
        candidate = _clean_inline_value(candidate)
        if len(candidate) < 3:
            return False
        if _SUPPLIER_REJECT_RE.search(candidate):
            return False
        if _ANOTHER_LABEL_RE.match(candidate):
            return False
        return True

    # Priority 1: explicit label on the same line
    for line in lines:
        m = _SUPPLIER_INLINE_RE.search(line)
        if m:
            candidate = _clean_inline_value(m.group(1))
            if _is_valid(candidate):
                return candidate

    # Priority 2: section header, name on next line
    for i, line in enumerate(lines):
        if _SUPPLIER_HEADER_RE.match(line) and i + 1 < len(lines):
            candidate = _clean_inline_value(lines[i + 1])
            if _is_valid(candidate):
                return candidate

    # Priority 3: positional — first clean line before doc heading / Bill To
    # v3 FIX: take only the FIRST cell of tab-split lines; apply first-line blocklist
    heading_idx = len(lines)
    for i, line in enumerate(lines[:18]):
        if _DOCTYPE_HEADING_RE_SUPPLIER.search(line):
            heading_idx = i
            break
        if _BILL_TO_RE.search(line):
            heading_idx = i
            break

    for line in lines[:heading_idx]:
        # Take only the first tab-separated cell — the rest are other columns
        first_cell = re.split(r"\t+|\|+", line, maxsplit=1)[0].strip()
        if _SUPPLIER_FIRSTLINE_REJECT_RE.match(first_cell):
            continue
        if _is_valid(first_cell) and len(first_cell) >= 5:
            if not re.match(r"^(?:p\.?\s*o\.?\s*box|po\s+box|\d+\s+\w)", first_cell, re.I):
                return first_cell[:120]

    # Priority 4: first line with a legal entity suffix
    for line in lines:
        m = _ENTITY_TRUNCATE_RE.match(line)
        if m:
            candidate = m.group(1).strip()
            if _is_valid(candidate):
                return candidate[:120]

    return None


# ═══════════════════════════════════════════════════════════════════════════════
# Tax / subtotal
# ═══════════════════════════════════════════════════════════════════════════════

_TAX_RE = re.compile(
    r"(?:vat|tax|gst|hst)\s*(?:\([^)]*\))?\s*(?:amount)?\s*[:\-]?\s*"
    r"(?:[A-Z$€£Kk]+\.?\s*)?(\d{1,3}(?:[,\s]\d{3})*(?:[.,]\d{1,4})?)",
    re.I,
)
_SUBTOTAL_RE = re.compile(
    r"(?:subtotal|sub\s*total|net\s*(?:amount|value)?|amount\s*before\s*tax)\s*[:\-]?\s*"
    r"(?:[A-Z$€£Kk]+\s*)?(\d{1,3}(?:[,\s]\d{3})*(?:[.,]\d{1,4})?)",
    re.I,
)


def _extract_tax_and_subtotal(text: str) -> tuple[Optional[str], Optional[str]]:
    tax = sub = None
    m = _TAX_RE.search(text)
    if m:
        tax = re.sub(r"[,\s]", "", m.group(1))
    m = _SUBTOTAL_RE.search(text)
    if m:
        sub = re.sub(r"[,\s]", "", m.group(1))
    return tax, sub


# ═══════════════════════════════════════════════════════════════════════════════
# Line-item / quantity / description / UOM extraction
# ═══════════════════════════════════════════════════════════════════════════════

_UOM_TOKENS = [
    r"metric\s*ton(?:ne)?s?", r"man[\s\-]?days?", r"man[\s\-]?hours?",
    r"kilogram(?:me)?s?", r"kilograms?", r"kgs?", r"kg",
    r"litres?", r"liters?", r"ltrs?", r"lts?",
    r"metres?", r"meters?", r"mts?",
    r"millilitres?", r"milliliters?", r"mls?",
    r"kilometres?", r"kilometers?", r"kms?",
    r"pieces?", r"pcs?", r"pce",
    r"units?", r"no\.?s?",
    r"boxes?", r"bxs?", r"cartons?", r"ctns?",
    r"bags?", r"rolls?", r"pairs?", r"sets?", r"reams?",
    r"packets?", r"pkts?",
    r"hours?", r"hrs?", r"days?", r"months?", r"years?",
    r"gallons?", r"gals?", r"tonnes?", r"tons?",
    r"grams?", r"gms?",
    r"each", r"ea",
    r"lump\s*sum", r"ls",
    r"sq\.?\s*m(?:etres?|eters?)?", r"sqm",
    r"sq\.?\s*ft", r"sqft",
    r"linear\s*m(?:etres?|eters?)?", r"lm",
    r"bottles?", r"btls?", r"cans?",
    r"dozen", r"gross", r"pallets?", r"drums?", r"jerricans?",
]
_UOM_PAT = re.compile(r"\b(" + r"|".join(_UOM_TOKENS) + r")\b", re.I)

_ITEM_HEADER_WORDS  = frozenset({"description","particulars","details","item","items","goods","services","narration","activity","works"})
_QTY_HEADER_WORDS   = frozenset({"qty","quantity","qnty","nos","no","units"})
_UOM_HEADER_WORDS   = frozenset({"uom","unit","units","measure","u/m"})
_PRICE_HEADER_WORDS = frozenset({"price","rate","unit price","unit rate","unit cost","amount","total","value"})


def _split_table_row(line: str) -> list[str]:
    if "\t" in line or "|" in line:
        return [c.strip() for c in re.split(r"\t+|\|+", line)]
    return [c.strip() for c in re.split(r"\s{2,}", line)]


def _match_header_columns(header_cells: list[str]) -> dict[str, int]:
    mapping: dict[str, int] = {}
    for idx, cell in enumerate(header_cells):
        lower = cell.lower().strip(" #.")
        if lower in _ITEM_HEADER_WORDS:
            mapping.setdefault("description", idx)
        elif lower in _QTY_HEADER_WORDS:
            mapping.setdefault("quantity", idx)
        elif lower in _UOM_HEADER_WORDS:
            mapping.setdefault("uom", idx)
        elif any(pw in lower for pw in _PRICE_HEADER_WORDS):
            mapping.setdefault("unit_price", idx)
    return mapping


def _is_numeric_cell(cell: str) -> bool:
    try:
        float(re.sub(r"[,\s]", "", cell))
        return True
    except ValueError:
        return False


def _extract_line_items(lines: list[str]) -> list[dict]:
    items: list[dict] = []
    col_map: dict[str, int] = {}
    in_table = False

    for i, line in enumerate(lines):
        cells = _split_table_row(line)
        if len(cells) < 2:
            if in_table and items:
                break
            continue

        possible_map = _match_header_columns(cells)
        if (
            "description" in possible_map
            and ("quantity" in possible_map or "uom" in possible_map or "unit_price" in possible_map)
        ):
            col_map  = possible_map
            in_table = True
            continue

        if not in_table:
            if len(cells) >= 3 and _is_numeric_cell(cells[1]):
                item: dict = {
                    "description": cells[0],
                    "quantity":    re.sub(r"[,\s]", "", cells[1]),
                    "uom":         "",
                    "unit_price":  re.sub(r"[,\s]", "", cells[2]) if len(cells) > 2 else "",
                    "line_total":  re.sub(r"[,\s]", "", cells[-1]) if len(cells) > 3 else "",
                }
                uom_m = _UOM_PAT.search(cells[1])
                if uom_m:
                    item["uom"]      = uom_m.group(1)
                    item["quantity"] = re.sub(r"[,\s]", "", cells[1][:uom_m.start()].strip())
                if item["description"] and len(item["description"]) >= 3:
                    items.append(item)
            continue

        if len(cells) <= max(col_map.values(), default=0):
            continue

        desc_idx  = col_map.get("description")
        qty_idx   = col_map.get("quantity")
        uom_idx   = col_map.get("uom")
        price_idx = col_map.get("unit_price")

        description = cells[desc_idx].strip()  if desc_idx  is not None and desc_idx  < len(cells) else ""
        quantity    = cells[qty_idx].strip()   if qty_idx   is not None and qty_idx   < len(cells) else ""
        uom         = cells[uom_idx].strip()   if uom_idx   is not None and uom_idx   < len(cells) else ""
        unit_price  = cells[price_idx].strip() if price_idx is not None and price_idx < len(cells) else ""

        if not description or len(description) < 2:
            continue
        if re.search(r"\b(?:total|subtotal|vat|tax|grand)\b", description, re.I):
            continue
        if quantity:
            quantity = re.sub(r"[,\s]", "", quantity)
        if not uom:
            uom_m = _UOM_PAT.search(description)
            if uom_m:
                uom = uom_m.group(1)
        items.append({
            "description": description[:200],
            "quantity":    quantity,
            "uom":         uom.lower() if uom else "",
            "unit_price":  re.sub(r"[,\s]", "", unit_price),
            "line_total":  re.sub(r"[,\s]", "", cells[-1]) if cells else "",
        })

    return items


def _extract_quantity_fallback(text: str) -> Optional[str]:
    m = re.search(
        r"(?:qty\.?|quantity|no\.?\s*of\s*(?:units|items|pieces))\s*[:\-]\s*"
        r"(\d{1,6}(?:[.,]\d{1,4})?)", text, re.I,
    )
    return m.group(1) if m else None


def _extract_uom_fallback(text: str) -> Optional[str]:
    m = re.search(
        r"(?:unit\s*(?:of\s*measure(?:ment)?)?|uom|measure)\s*[:\-]\s*"
        r"(" + r"|".join(_UOM_TOKENS) + r")", text, re.I,
    )
    return m.group(1).lower() if m else None


def _extract_description_fallback(text: str, lines: list[str]) -> Optional[str]:
    m = re.search(
        r"(?:description|particulars|details?|goods|services|narration|purpose|for)\s*[:\-]\s*(.+)",
        text, re.I | re.M,
    )
    if m:
        val = m.group(1).strip()[:300]
        if len(val) >= 4:
            return val
    return None


# ═══════════════════════════════════════════════════════════════════════════════
# Title extraction
# ═══════════════════════════════════════════════════════════════════════════════

_SKIP_TITLE_RE = re.compile(
    r"^\$|subtotal|^tax\b|total|^\d[\d\s,./]*$"
    r"|@|\bsuite\b|\bblvd\b|\bstreet\b|\bave(?:nue)?\b|\broad\b"
    r"|\bpo\s+box\b|\bzip\b|\bpostal\b"
    r"|\bpayment\s+due\b|\bbalance\s+due\b|\bissued\b|\bterms\b|\bdue\b"
    r"|\bpayable\b|\breceivable\b|\bnote\b|\bgoods\b",
    re.I,
)
_LABEL_LINE_RE  = re.compile(r"^[A-Za-z][A-Za-z0-9 /.\-]{1,40}:\s+\S")
_DOC_HEADING_RE = re.compile(
    r"\b(?:tax\s+invoice|invoice|local\s+purchase\s+order|purchase\s+order|"
    r"delivery\s+note|goods\s+received\s+note|credit\s+note|debit\s+note|"
    r"official\s+receipt|receipt|quotation|quote|pro\s*forma|contract|"
    r"agreement|payment\s+voucher|voucher|statement\s+of\s+account|"
    r"expense\s+(?:claim|report|form)|imprest)\b",
    re.I,
)
_ENTITY_LEGAL_RE  = re.compile(r"\b(?:Ltd\.?|Limited|Inc\.?|Corp\.?|GmbH|LLC|PLC)\b", re.I)
_ADDRESS_SKIP_RE  = re.compile(
    r"\b(?:street|road|avenue|blvd|suite|po\s+box|westlands|nairobi|karen|kilimani)\b", re.I
)


def _title_case(value: str) -> str:
    return re.sub(r"\s+", " ", value.strip()).title()


def _extract_title(
    lines: list[str],
    doc_type_raw: str,
    *,
    supplier: Optional[str] = None,
    reference: Optional[str] = None,
) -> Optional[str]:
    for line in lines[:18]:
        lower = line.lower()
        if (
            ("account" in lower or "supplier" in lower or "vendor" in lower)
            and ("date" in lower or "code" in lower or "\t" in line or "|" in line)
        ):
            continue
        m = _DOC_HEADING_RE.search(line)
        if not m:
            continue
        heading = _title_case(m.group(0))
        if reference:
            return f"{heading} {reference}"[:120]
        if supplier:
            return f"{heading} - {supplier}"[:120]
        return heading[:120]

    for line in lines[:30]:
        m = re.search(
            r"(?:document\s*title|title|subject|description|particulars|purpose)\s*[:\-]\s*(.+)",
            line, re.I,
        )
        if m:
            val = m.group(1).strip()[:120]
            if len(val) > 1:
                return val

    for line in lines:
        if len(line) < 4:
            continue
        if supplier and supplier.lower() in line.lower():
            continue
        if re.match(r"^[\d\W]+$", line):
            continue
        if _SKIP_TITLE_RE.search(line):
            continue
        if _LABEL_LINE_RE.match(line):
            continue
        if doc_type_raw and re.fullmatch(
            re.escape(doc_type_raw) + r"[\s/\-]*(?:form|request|note)?", line, re.I
        ):
            continue
        if _ENTITY_LEGAL_RE.search(line):
            continue
        if "\t" in line:
            continue
        if _ADDRESS_SKIP_RE.search(line):
            continue
        return line[:120]

    if doc_type_raw:
        base = _title_case(re.sub(r"\s+", " ", doc_type_raw.strip()))
        if reference:
            return f"{base} {reference}"[:120]
        if supplier:
            return f"{base} - {supplier}"[:120]
        return base[:120]

    return None


# ═══════════════════════════════════════════════════════════════════════════════
# Generic labelled-field helpers
# ═══════════════════════════════════════════════════════════════════════════════

def _labelled_text(label_pattern: str, text: str, max_len: int = 120) -> Optional[str]:
    m = re.search(label_pattern + r"\s*[:\-]\s*(.+)", text, re.I | re.M)
    if m:
        val = m.group(1).strip()[:max_len]
        if len(val) > 1:
            return val
    return None


def _labelled_code(label_pattern: str, text: str) -> Optional[str]:
    m = re.search(
        label_pattern + r"\s*[:\-]\s*([A-Z0-9][A-Z0-9\-_/]{1,40})",
        text, re.I | re.M,
    )
    return m.group(1).strip() if m else None


_ACCOUNT_LABEL_RE = re.compile(
    r"^(?:a/?c|acct\.?|account|gl|g/l|ledger|billing|client|customer|project)"
    r"\s*(?:code|no\.?|number|#|id)?$",
    re.I,
)
_CODE_VALUE_RE = re.compile(r"^[A-Z0-9][A-Z0-9\-_/]{1,40}$", re.I)


def _split_cells(line: str) -> list[str]:
    if "\t" in line or "|" in line:
        return [c.strip(" :-") for c in re.split(r"\t+|\|+", line) if c.strip(" :-")]
    return [c.strip(" :-") for c in re.split(r"\s{2,}", line) if c.strip(" :-")]


def _normalise_label_cell(cell: str) -> str:
    cell = re.sub(r"[^A-Za-z0-9/#. ]+", " ", cell)
    return re.sub(r"\s+", " ", cell).strip().lower()


def _extract_code_from_header_grid(lines: list[str], label_re: re.Pattern) -> Optional[str]:
    """Extract codes from two-row header grids (do NOT call _clean_inline_value on results)."""
    for i, line in enumerate(lines[:-1]):
        headers = [_normalise_label_cell(c) for c in _split_cells(line)]
        if len(headers) < 2:
            continue
        values = _split_cells(lines[i + 1])
        if len(values) < 2:
            continue
        for idx, header in enumerate(headers):
            if idx >= len(values):
                continue
            if not label_re.match(header):
                continue
            # v3 FIX: take the raw cell value without calling _clean_inline_value
            token = values[idx].strip()
            token = re.split(r"\s{2,}|\t|\|", token, maxsplit=1)[0].strip()
            token = re.sub(r"^[^\w]+|[^\w\-/]+$", "", token)
            if _CODE_VALUE_RE.match(token) and token.upper() not in _REF_REJECT:
                return token
    return None


def _extract_account_code(text: str, lines: list[str]) -> Optional[str]:
    labelled = _labelled_code(
        r"(?:a/?c\s*(?:code|no\.?|number)?|account\s*(?:code|no\.?|number|#)?"
        r"|acct\.?\s*(?:code|no\.?|number|#)?|g/?l\s*(?:code|no\.?|number)?"
        r"|ledger\s*code|billing\s*code|client\s*(?:code|no\.?|id)"
        r"|customer\s*(?:code|no\.?|id)|project\s*code)",
        text,
    )
    if labelled:
        return labelled
    return _extract_code_from_header_grid(lines, _ACCOUNT_LABEL_RE)


# ═══════════════════════════════════════════════════════════════════════════════
# Candidate Generation (v4)
# ═══════════════════════════════════════════════════════════════════════════════

@dataclass
class FieldCandidate:
    value: str
    source: str  # "ocr", "ner", "layoutlm"
    confidence: float
    bbox: List[int] = None
    entity_type: str = None
    layout_distance: float = None


class FieldExtractor:
    def __init__(self, ner_model, layoutlm_processor):
        self.ner = ner_model
        self.layoutlm = layoutlm_processor

    def extract_candidates(
        self, ocr_result: Any, admin_fields: List[str]
    ) -> Dict[str, List[FieldCandidate]]:
        """Generate candidates for each field from OCR, NER, and LayoutLM."""
        candidates = {field: [] for field in admin_fields}

        # 1. OCR Candidates (raw text + confidence)
        for word in getattr(ocr_result, "words", []):
            for field in admin_fields:
                if field.lower() in word.get("text", "").lower():
                    candidates[field].append(
                        FieldCandidate(
                            value=word["text"],
                            source="ocr",
                            confidence=word.get("conf", 0.0),
                            bbox=[word.get("left"), word.get("top"), word.get("right"), word.get("bottom")],
                        )
                    )

        # 2. NER Candidates (entities)
        ner_entities = self.ner(getattr(ocr_result, "text", ""))
        for entity in ner_entities:
            field = self._map_entity_to_field(entity.type)
            if field in candidates:
                candidates[field].append(
                    FieldCandidate(
                        value=entity.text,
                        source="ner",
                        confidence=0.8,
                        entity_type=entity.type,
                    )
                )

        # 3. LayoutLM Candidates (spatial relationships)
        # Note: Assumes ocr_result provides normalized words/boxes via helper or direct access
        words_list = [w.get("text", "") for w in getattr(ocr_result, "words", [])]
        boxes_list = [[w.get("left"), w.get("top"), w.get("right"), word.get("bottom")] for w in getattr(ocr_result, "words", [])]
        
        layoutlm_output = self.layoutlm.predict(words=words_list, boxes=boxes_list)
        layoutlm_fields = self.layoutlm.group_multi_word_fields(
            words=words_list, boxes=boxes_list, labels=layoutlm_output["labels"]
        )
        for lm_field in layoutlm_fields:
            field = self._map_layoutlm_label_to_field(lm_field["label"])
            if field in candidates:
                candidates[field].append(
                    FieldCandidate(
                        value=lm_field["text"],
                        source="layoutlm",
                        confidence=0.95,
                        bbox=lm_field["bbox"],
                    )
                )
        return candidates

    def _map_entity_to_field(self, entity_type: str) -> str:
        return {"DATE": "invoice_date", "ORG": "supplier_name", "MONEY": "amount"}.get(entity_type, "")

    def _map_layoutlm_label_to_field(self, label: str) -> str:
        return {"invoice_number": "invoice_number", "supplier_name": "supplier_name", "date": "invoice_date"}.get(label, "")

# ═══════════════════════════════════════════════════════════════════════════════
# Main extractor class
# ═══════════════════════════════════════════════════════════════════════════════


class DocumentFieldExtractor:
    """Extract structured fields from OCR text."""

    def __init__(self, text: str) -> None:
        self.text  = text
        self.lines = [ln.strip() for ln in text.splitlines() if ln.strip()]
        self.doc_type       = "general"
        self.doc_type_label = ""
        self._classify_document()

    # ── Document type classification ──────────────────────────────────────

    def _classify_document(self) -> None:
        text_len = len(self.text)
        if text_len == 0:
            return

        threshold   = max(200, int(text_len * 0.30))
        best_match: Optional[tuple[str, str]] = None
        best_pos    = text_len + 1
        best_kw_len = 0

        for pat, dtype, label in _DOCTYPE_PATTERNS:
            m = pat.search(self.text)
            if not m:
                continue
            pos    = m.start()
            kw_len = len(m.group(0))

            if best_match is None:
                best_match, best_pos, best_kw_len = (dtype, label), pos, kw_len
                continue

            challenger_in_zone = pos     <= threshold
            current_in_zone    = best_pos <= threshold

            if challenger_in_zone and current_in_zone:
                if kw_len > best_kw_len:
                    best_match, best_pos, best_kw_len = (dtype, label), pos, kw_len
            elif pos < best_pos:
                best_match, best_pos, best_kw_len = (dtype, label), pos, kw_len

        if best_match:
            self.doc_type, self.doc_type_label = best_match

    # ── Public interface ───────────────────────────────────────────────────

    def extract(self) -> dict:
        if not self.text or not self.text.strip():
            return {}

        out: dict = {}
        out["raw_lines"] = self.lines[:20]

        if self.doc_type_label:
            out["document_type"] = self.doc_type_label

        # ── Stage A: header-grid first pass (v3 NEW) ──────────────────────
        # This is the primary defence against ambiguous column layouts.
        grid_results = _extract_header_grid(self.lines)
        out.update(grid_results)
        logger.debug("extractor: header_grid produced %d fields", len(grid_results))

        # ── Stage B: fill gaps with targeted extractors ────────────────────

        if "supplier" not in out:
            supplier = _extract_supplier(self.lines)
            if supplier:
                out["supplier"] = supplier

        if "amount" not in out or "currency" not in out:
            amount, currency = _best_amount(self.text)
            if amount and "amount" not in out:
                out["amount"] = amount
            if currency and "currency" not in out:
                out["currency"] = currency

        if "reference_number" not in out:
            ref = _extract_reference(self.text, self.doc_type)
            if ref:
                out["reference_number"] = ref

        title = _extract_title(
            self.lines,
            self.doc_type_label,
            supplier=out.get("supplier"),
            reference=out.get("reference_number"),
        )
        if title:
            out["title"] = title

        # ── Stage C: date extraction ───────────────────────────────────────
        self._extract_dates(out)

        # ── Stage D: type-specific extractors ─────────────────────────────
        extractor_fn = getattr(self, f"_extract_{self.doc_type}", self._extract_general)
        extractor_fn(out)

        # ── Stage E: universal supplementary fields ────────────────────────
        self._extract_universal_fields(out)

        # ── Stage F: line items ────────────────────────────────────────────
        self._extract_item_fields(out)

        return {k: v for k, v in out.items() if v is not None and v != ""}

    # ── Line-item / quantity / description / UOM ──────────────────────────

    def _extract_item_fields(self, out: dict) -> None:
        items = _extract_line_items(self.lines)
        if items:
            out["line_items"] = items
            first = items[0]
            if first.get("description") and "description" not in out:
                out["description"] = first["description"]
            if first.get("quantity") and "quantity" not in out:
                out["quantity"] = first["quantity"]
            if first.get("uom") and "uom" not in out:
                out["uom"] = first["uom"]
            return
        if "description" not in out:
            desc = _extract_description_fallback(self.text, self.lines)
            if desc:
                out["description"] = desc
        if "quantity" not in out:
            qty = _extract_quantity_fallback(self.text)
            if qty:
                out["quantity"] = qty
        if "uom" not in out:
            uom = _extract_uom_fallback(self.text)
            if uom:
                out["uom"] = uom

    # ── Date extraction ────────────────────────────────────────────────────

    def _extract_dates(self, out: dict) -> None:
        text = self.text

        doc_date = _find_first_date(
            text,
            r"(?:invoice\s*date|bill\s*date|document\s*date|issue(?:d)?\s*date"
            r"|date\s*of\s*issue|p\.?o\.?\s*date|order\s*date|receipt\s*date"
            r"|request\s*date|voucher\s*date)",
        )

        if not doc_date:
            bare_m = re.search(r"(?<!\w)date\s*[:\-]\s*" + _DATE_VALUE_PAT, text, re.IGNORECASE)
            due_m  = re.search(
                r"(?:due\s*date|payment\s*(?:due\s*)?date|pay(?:ment)?\s*by)",
                text, re.IGNORECASE,
            )
            if bare_m and (due_m is None or bare_m.start() < due_m.start()):
                doc_date = _parse_date(bare_m.group(1))

        if doc_date and "document_date" not in out:
            out["document_date"] = doc_date

        due_date = _find_first_date(
            text,
            r"(?:due\s*date|payment\s*(?:due\s*)?date|pay(?:ment)?\s*by"
            r"|payment\s*due(?:\s*date)?|settle(?:ment)?\s*date)",
        )
        if due_date and "due_date" not in out:
            out["due_date"] = due_date

        eff = _find_first_date(
            text,
            r"(?:effective\s*date|start\s*date|commencement\s*date|from\s*date)",
        )
        if eff:
            out.setdefault("effective_date", eff)
            out.setdefault("document_date", eff)

        exp = _find_first_date(
            text,
            r"(?:expir(?:y|ation)\s*date|end\s*date|termination\s*date"
            r"|valid(?:ity)?\s*(?:date|until|to|through))",
        )
        if exp:
            out.setdefault("expiry_date", exp)
            if self.doc_type == "contract":
                out.setdefault("due_date", exp)

        signed = _find_first_date(
            text,
            r"(?:date\s*signed|signed\s*(?:on|date)|execution\s*date|date\s*of\s*signing)",
        )
        if signed:
            out.setdefault("signed_date", signed)

        delivery = _find_first_date(
            text,
            r"(?:delivery\s*date|required\s*(?:by|date)|dispatch\s*date"
            r"|ship(?:ment)?\s*date|expected\s*(?:delivery\s*)?date)",
        )
        if delivery:
            out.setdefault("delivery_date", delivery)

        # Absolute fallback — v3 FIX: skip matches inside amount/reference lines
        if "document_date" not in out:
            _AMOUNT_LINE_RE = re.compile(
                r"\b(?:total|amount|subtotal|balance|invoice\s*total|grand\s*total)\b",
                re.I,
            )
            _FALLBACK_PATTERNS = [
                r"\b(\d{4}[-/]\d{1,2}[-/]\d{1,2})\b",
                r"\b(\d{1,2}\s+(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May"
                r"|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?"
                r"|Nov(?:ember)?|Dec(?:ember)?)\s+\d{4})\b",
                r"\b((?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May"
                r"|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?"
                r"|Nov(?:ember)?|Dec(?:ember)?)\s+\d{1,2},?\s+\d{4})\b",
                r"\b(\d{1,2}/\d{1,2}/\d{4})\b",
            ]
            for pat in _FALLBACK_PATTERNS:
                for m in re.finditer(pat, text, re.I):
                    # Skip matches that sit on a line dominated by amounts
                    line_start = text.rfind("\n", 0, m.start()) + 1
                    line_end   = text.find("\n", m.end())
                    line_end   = line_end if line_end != -1 else len(text)
                    line_ctx   = text[line_start:line_end]
                    if _AMOUNT_LINE_RE.search(line_ctx):
                        continue
                    parsed = _parse_date(m.group(1))
                    if parsed:
                        out["document_date"] = parsed
                        break
                if "document_date" in out:
                    break

    # ── Type-specific extractors ───────────────────────────────────────────

    def _extract_invoice(self, out: dict) -> None:
        text = self.text
        if "reference_number" not in out:
            inv_ref = _extract_reference(text, "invoice")
            if inv_ref:
                out["reference_number"] = inv_ref
        tax, subtotal = _extract_tax_and_subtotal(text)
        if tax   and "tax_amount" not in out: out["tax_amount"] = tax
        if subtotal and "subtotal" not in out: out["subtotal"]  = subtotal
        if "account_code" not in out:
            acct = _extract_account_code(text, self.lines)
            if acct: out["account_code"] = acct
        po_ref = _labelled_code(
            r"(?:purchase\s*order\s*(?:ref(?:erence)?|no\.?)|p\.?o\.?\s*(?:ref(?:erence)?|no\.?)|order\s*ref)",
            text,
        )
        if po_ref and "po_reference" not in out:
            out["po_reference"] = po_ref
        terms = _labelled_text(r"(?:payment\s*terms?|terms?\s*of\s*payment|credit\s*terms?)", text, 80)
        if terms and "payment_terms" not in out:
            out["payment_terms"] = terms

    def _extract_purchase_order(self, out: dict) -> None:
        text = self.text
        if "reference_number" not in out:
            po_ref = _extract_reference(text, "purchase_order")
            if po_ref: out["reference_number"] = po_ref
        vendor_code = _labelled_code(r"(?:vendor\s*(?:code|no\.?|id)|supplier\s*(?:code|no\.?|id))", text)
        if vendor_code and "vendor_code" not in out: out["vendor_code"] = vendor_code
        approved_by = _labelled_text(r"(?:approved\s*by|authoris(?:ed|ation)\s*(?:by)?|authorized\s*by)", text)
        if approved_by and "approved_by" not in out: out["approved_by"] = approved_by
        tax, subtotal = _extract_tax_and_subtotal(text)
        if tax      and "tax_amount" not in out: out["tax_amount"] = tax
        if subtotal and "subtotal"   not in out: out["subtotal"]   = subtotal

    def _extract_contract(self, out: dict) -> None:
        text = self.text
        if "reference_number" not in out:
            cr = _extract_reference(text, "contract")
            if cr: out["reference_number"] = cr
        cv_m = re.search(
            r"(?:contract\s*(?:value|sum|price|amount)|total\s*(?:contract\s*)?value)"
            r"\s*[:\-]?\s*"
            rf"(?:{_ISO_CURRENCIES}|Ksh\.?|[\$€£])?\s*"
            r"(\d{1,3}(?:[,\s]\d{3})*(?:[.,]\d{1,4})?)",
            text, re.I,
        )
        if cv_m and "contract_value" not in out:
            out["contract_value"] = re.sub(r"[,\s]", "", cv_m.group(1))
        signed_by = _labelled_text(r"(?:signed\s*by|executed\s*by|signatory|authorized\s*signatory)", text)
        if signed_by and "signed_by" not in out: out["signed_by"] = signed_by

    def _extract_receipt(self, out: dict) -> None:
        text = self.text
        if "reference_number" not in out:
            rr = _extract_reference(text, "receipt")
            if rr: out["reference_number"] = rr
        pm = _labelled_text(
            r"(?:payment\s*method|paid\s*(?:via|by|through)|mode\s*of\s*payment"
            r"|payment\s*mode|method\s*of\s*payment)", text, 80,
        )
        if pm and "payment_method" not in out: out["payment_method"] = pm
        txn = _labelled_code(
            r"(?:transaction\s*(?:ref(?:erence)?|no\.?|id)|cheque\s*(?:no\.?|number)"
            r"|chq\s*no\.?|txn\s*(?:ref|id|no\.?)|m[\-\s]?pesa\s*(?:ref|code|no\.?)"
            r"|payment\s*ref(?:erence)?)", text,
        )
        if txn and "transaction_ref" not in out: out["transaction_ref"] = txn

    def _extract_delivery_note(self, out: dict) -> None:
        text = self.text
        if "reference_number" not in out:
            dr = _extract_reference(text, "delivery_note")
            if dr: out["reference_number"] = dr
        po_ref = _labelled_code(
            r"(?:purchase\s*order\s*(?:ref(?:erence)?|no\.?)|p\.?o\.?\s*(?:ref(?:erence)?|no\.?)|order\s*ref)",
            text,
        )
        if po_ref and "po_reference" not in out: out["po_reference"] = po_ref
        rb = _labelled_text(r"(?:received\s*by|accepted\s*by|delivered\s*to)", text)
        if rb and "received_by" not in out: out["received_by"] = rb

    def _extract_expense_claim(self, out: dict) -> None:
        text = self.text
        rby = _labelled_text(r"(?:requested\s*by|prepared\s*by|raised\s*by|submitted\s*by|claimant)", text)
        if rby and "requested_by" not in out: out["requested_by"] = rby
        cc = _labelled_code(r"(?:cost\s*cent(?:re|er)|department\s*code|dept\.?\s*code|budget\s*code)", text)
        if cc and "cost_centre" not in out: out["cost_centre"] = cc
        purpose = _labelled_text(
            r"(?:purpose|reason|description\s*of\s*(?:expenditure|payment|claim)|for)", text, 200
        )
        if purpose and len(purpose) > 4:
            if "purpose"     not in out: out["purpose"]     = purpose
            if "description" not in out: out["description"] = purpose
        appr = _labelled_text(r"(?:approved\s*by|authoris(?:ed|ation)\s*(?:by)?|authorized\s*by)", text)
        if appr and "approved_by" not in out: out["approved_by"] = appr

    def _extract_imprest(self, out: dict) -> None:
        self._extract_expense_claim(out)
        if "reference_number" not in out:
            ir = _extract_reference(self.text, "imprest")
            if ir: out["reference_number"] = ir

    def _extract_payment_voucher(self, out: dict) -> None:
        text = self.text
        if "reference_number" not in out:
            vr = _extract_reference(text, "payment_voucher")
            if vr: out["reference_number"] = vr
        payee = _labelled_text(r"(?:payee|pay\s*to|paid\s*to|in\s*favour\s*of|beneficiary)", text)
        if payee:
            if "payee"    not in out: out["payee"]    = payee
            if "supplier" not in out: out["supplier"] = payee
        self._extract_receipt(out)
        appr = _labelled_text(r"(?:approved\s*by|authoris(?:ed|ation)\s*(?:by)?|authorized\s*by)", text)
        if appr and "approved_by" not in out: out["approved_by"] = appr

    def _extract_credit_note(self, out: dict) -> None:
        self._extract_invoice(out)

    def _extract_debit_note(self, out: dict) -> None:
        self._extract_invoice(out)

    def _extract_quotation(self, out: dict) -> None:
        self._extract_invoice(out)
        exp = out.get("expiry_date") or _find_first_date(
            self.text,
            r"(?:valid(?:ity)?\s*(?:until|till|to|for)|quote\s*valid(?:\s*until)?)",
        )
        if exp:
            out.setdefault("expiry_date", exp)
            out.setdefault("due_date", exp)

    def _extract_utility_bill(self, out: dict) -> None:
        self._extract_invoice(out)
        if "account_code" not in out:
            acct = _extract_account_code(self.text, self.lines) or _labelled_code(
                r"(?:meter\s*(?:number|no\.?)|customer\s*(?:number|no\.?|id))", self.text
            )
            if acct: out["account_code"] = acct

    def _extract_statement(self, out: dict) -> None:
        self._extract_invoice(out)

    def _extract_general(self, out: dict) -> None:
        tax, subtotal = _extract_tax_and_subtotal(self.text)
        if tax      and "tax_amount" not in out: out["tax_amount"] = tax
        if subtotal and "subtotal"   not in out: out["subtotal"]   = subtotal
        if "account_code" not in out:
            acct = _extract_account_code(self.text, self.lines)
            if acct: out["account_code"] = acct

    # ── Universal supplementary fields ────────────────────────────────────

    def _extract_universal_fields(self, out: dict) -> None:
        text = self.text
        if "account_code" not in out:
            acct = _extract_account_code(text, self.lines)
            if acct: out["account_code"] = acct
        if "cost_centre" not in out:
            cc = _labelled_code(
                r"(?:cost\s*cent(?:re|er)|department\s*code|dept\.?\s*code|budget\s*code)", text
            )
            if cc: out["cost_centre"] = cc
        if "approved_by" not in out:
            appr = _labelled_text(
                r"(?:approved\s*by|authoris(?:ed|ation)\s*(?:by)?|authorized\s*by"
                r"|authorised\s*signatory)", text,
            )
            if appr: out["approved_by"] = appr

        # M-PESA
        mpesa = _labelled_code(
            r"(?:m[\-\s]?pesa\s*(?:ref(?:erence)?|code|no\.?|transaction)"
            r"|mpesa\s*(?:ref(?:erence)?|code|no\.?))", text,
        )
        if mpesa:
            out.setdefault("transaction_ref", mpesa)
            out.setdefault("payment_method", "M-PESA")

        # KRA PIN
        kra_m = re.search(r"\b(?:kra\s*pin|pin\s*no\.?)\s*[:\-]?\s*([A-Z]\d{9}[A-Z])\b", text, re.I)
        if kra_m and "kra_pin" not in out:
            out["kra_pin"] = kra_m.group(1).upper()

        # VAT number
        vat_m = re.search(
            r"(?:vat\s*(?:reg(?:istration)?\s*)?(?:no\.?|number)"
            r"|tax\s*(?:reg(?:istration)?\s*)?(?:no\.?|number))"
            r"\s*[:\-]?\s*([A-Z0-9][A-Z0-9\-/]{3,30})",
            text, re.I,
        )
        if vat_m and "vat_number" not in out:
            out["vat_number"] = vat_m.group(1).strip()

        # Registered address
        if "registered_address" not in out:
            addr = _labelled_text(
                r"(?:registered\s*address|company\s*address|address)", text, 200
            )
            if addr and len(addr) >= 5:
                out["registered_address"] = addr


# ═══════════════════════════════════════════════════════════════════════════════
# Public convenience entry point
# ═══════════════════════════════════════════════════════════════════════════════


def extract_document_fields(ocr_text: str) -> dict:
    """
    Entry point called by the Celery task and FieldResolver.
    Guaranteed to return a plain dict and never raise.
    """
    if not ocr_text or not ocr_text.strip():
        return {}
    try:
        return DocumentFieldExtractor(ocr_text).extract()
    except Exception:
        logger.exception("extract_document_fields: unexpected error")
        return {}