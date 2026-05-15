"""
apps/documents/ocr/extractor.py

Structured field extraction from OCR text.

Architecture
────────────
DocumentFieldExtractor runs three extraction strategies in priority order:

  1. LabelledFieldStrategy  — "Label: Value" patterns (highest precision)
  2. LayoutHeuristicStrategy — positional cues (top of document = supplier)
  3. FallbackPatternStrategy — broad regex sweeps when the above find nothing

The extractor is document-type-aware: it classifies the document type first,
then applies the appropriate field mapping.

Supported document types and their key fields
─────────────────────────────────────────────
  invoice         → invoice_number, supplier, amount, currency, document_date,
                    due_date, account_code, tax_amount, subtotal
  purchase_order  → po_number, supplier, delivery_date, vendor_code, approved_by
  contract        → contract_number, supplier, effective_date, expiry_date,
                    signed_by, signed_date, contract_value
  receipt         → receipt_number, supplier, amount, payment_method,
                    transaction_ref
  delivery_note   → delivery_number, po_reference, supplier, delivery_date
  expense_claim   → requested_by, purpose, cost_centre, amount
  payment_voucher → voucher_number, payee, amount, payment_method,
                    transaction_ref, approved_by
  imprest         → imprest_number, requested_by, purpose, cost_centre, amount
  general         → fallback for unrecognised types

All extractors populate these universal fields regardless of document type:
  document_type, reference_number, amount, currency,
  document_date, due_date, supplier, raw_lines

Bug-fixes in this revision
──────────────────────────
1.  Supplier / Bill-To confusion: header_cap raised to 15 (was 8) and the
    supplier search window is now bounded by the *Bill To* block, not a
    fixed line count.  A "Bill To / Ship To" prefix on the same line as a
    company name no longer contaminates the supplier field.

2.  _SUPPLIER_REJECT_RE now also rejects lines that contain "bill to" /
    "ship to" / "sold to" keywords to prevent customer-block leakage.

3.  _clean_inline_value now splits on "bill to", "ship to", "sold to".

4.  _REF_VALUE_PAT and _labelled_code extended to handle refs that start
    with a digit (e.g. "1234-XYZ-99") and refs longer than 40 chars
    (raised to 60).  Trailing whitespace / punctuation is trimmed correctly.

5.  _labelled_code now also accepts refs that begin with "#" or are
    purely alpha-numeric without a hyphen when they are ≥ 4 characters.

6.  Account-code / account-number confusion: the loose _ACCOUNT_LABEL_RE
    (which matched bare "account") is only used as a last resort after the
    strict _ACCOUNT_GRID_LABEL_RE and explicit labelled-code patterns.
    _is_plausible_gl_account_code now also rejects values that look like
    IBAN / bank account numbers (≥ 10 consecutive digits).

7.  _find_first_date now tolerates a newline between a label and its value
    (grid layouts where "Invoice Date" appears on one line and the date on
    the next).

8.  Bare "Date:" fallback in _extract_dates is now also excluded when the
    match position falls inside the "Bill To" block.

9.  _best_amount labelled-total fix: extract amounts from the full regex
    match string rather than re-running on just the group fragments.

10. Transaction ref: _extract_transaction_ref is a dedicated function that
    handles M-PESA, cheque, and generic refs with a wider character class
    (digits, upper/lower, hyphens, slashes — up to 60 chars).

11. _standard_invoice_grid_parse now also handles partial grids (3 of 4
    expected columns) so a missing "supplier id" column does not abort
    parsing of account_code and dates.

12. spaCy model is loaded via a module-level cache in tasks_ocr.py (see
    that file); no change needed here.
"""
from __future__ import annotations

import logging
import re
from datetime import datetime
from typing import Optional

logger = logging.getLogger(__name__)


# ── Document type classification ───────────────────────────────────────────────

# (keyword_regex, normalised_type, display_label)
_DOCTYPE_PATTERNS: list[tuple[re.Pattern, str, str]] = [
    (re.compile(r"\b(?:local\s+purchase\s+order|l\.?p\.?o\.?)\b", re.I), "purchase_order", "Local Purchase Order"),
    (re.compile(r"\bpurchase\s+order\b", re.I),                           "purchase_order", "Purchase Order"),
    (re.compile(r"\btax\s+invoice\b", re.I),                              "invoice",        "Tax Invoice"),
    (re.compile(r"\binvoice\b", re.I),                                    "invoice",        "Invoice"),
    (re.compile(r"\b(?:service\s+agreement|service\s+contract)\b", re.I), "contract",       "Service Agreement"),
    (re.compile(r"\bcontract\b", re.I),                                   "contract",       "Contract"),
    (re.compile(r"\bagreement\b", re.I),                                  "contract",       "Agreement"),
    (re.compile(r"\b(?:official\s+receipt|receipt)\b", re.I),             "receipt",        "Receipt"),
    (re.compile(r"\b(?:delivery\s+note|goods\s+received\s+note|g\.?r\.?n\.?)\b", re.I), "delivery_note", "Delivery Note"),
    (re.compile(r"\bcredit\s+note\b", re.I),                              "credit_note",    "Credit Note"),
    (re.compile(r"\bdebit\s+note\b", re.I),                               "debit_note",     "Debit Note"),
    (re.compile(r"\b(?:quotation|quote|pro.?forma)\b", re.I),             "quotation",      "Quotation"),
    (re.compile(r"\bexpense\s+(?:claim|report|form)\b", re.I),            "expense_claim",  "Expense Claim"),
    (re.compile(r"\b(?:imprest|petty\s+cash)\b", re.I),                   "imprest",        "Imprest"),
    (re.compile(r"\bpayment\s+voucher\b", re.I),                          "payment_voucher","Payment Voucher"),
    (re.compile(r"\bvoucher\b", re.I),                                    "payment_voucher","Voucher"),
    (re.compile(r"\b(?:electricity|water|utility)\s+bill\b", re.I),       "utility_bill",   "Utility Bill"),
    (re.compile(r"\bstatement\s+of\s+account\b", re.I),                   "statement",      "Statement of Account"),
    (re.compile(r"\bbill\b", re.I),                                       "invoice",        "Bill"),
]

# ── Shared regex building blocks ───────────────────────────────────────────────

# Separator between label and value: ":", "-", " " or nothing
_SEP = r"\s*[:\-]?\s*"

# Date value pattern — matches ISO, DMY, MDY, and spelled-out formats.
#
# The ISO branch uses a lookbehind (?<![A-Za-z0-9\-/]) that prevents the year
# from matching when it is embedded inside a reference number such as
# "INV-2024-07-15" or "PO-2024-11-30".  The lookbehind sits inside the outer
# capturing group so m.group(1) still returns only the date string itself,
# keeping the API identical for all callers (_find_first_date, _parse_date).
_DATE_VALUE_PAT = (
    r"((?<![A-Za-z0-9\-/])\d{4}[-/]\d{1,2}[-/]\d{1,2}\b"
    r"|\d{1,2}[/.\-]\d{1,2}[/.\-]\d{2,4}"
    r"|(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?"
    r"|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)"
    r"\s+\d{1,2},?\s+\d{4}"
    r"|\d{1,2}\s+(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?"
    r"|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)"
    r"\s+\d{4})"
)

# ISO currency codes recognised (extended for East Africa)
_ISO_CURRENCIES = (
    r"(?:USD|EUR|GBP|KES|KSH|UGX|TZS|RWF|ETB|NGN|GHS|ZAR|"
    r"JPY|CAD|AUD|CHF|CNY|INR)"
)

# Symbols mapped to currency codes for post-processing
_SYMBOL_TO_ISO = {
    "$": "USD",
    "€": "EUR",
    "£": "GBP",
    "Ksh": "KES",
    "KSh": "KES",
    "Kshs": "KES",
    "UShs": "UGX",
    "TSh": "TZS",
}

# Amount pattern: currency prefix/suffix with numeric value
_AMOUNT_PAT = re.compile(
    rf"(?:({_ISO_CURRENCIES}|Ksh\.?|KSh\.?|Kshs\.?|UShs\.?|TSh\.?)\s*"
    rf"|[\$€£]\s*)"
    rf"(\d{{1,3}}(?:[,\s]\d{{3}})*(?:[.,]\d{{1,4}})?)"
    rf"|(\d{{1,3}}(?:[,\s]\d{{3}})*(?:[.,]\d{{1,4}})?)"
    rf"\s*({_ISO_CURRENCIES}|Ksh\.?|KSh\.?|Kshs\.?|UShs\.?|TSh\.?)",
    re.IGNORECASE,
)

_SYMBOL_PAT = re.compile(r"[\$€£]")


# ── Date parsing ───────────────────────────────────────────────────────────────

_DATE_FORMATS = [
    "%Y-%m-%d", "%Y/%m/%d",
    "%d %B %Y", "%d %b %Y",
    "%B %d %Y", "%b %d %Y",
    "%B %d, %Y", "%b %d, %Y",
    "%d/%m/%Y", "%m/%d/%Y",
    "%d-%m-%Y", "%m-%d-%Y",
    "%d.%m.%Y", "%d/%m/%y",
]


def _parse_date(s: str) -> Optional[str]:
    """Normalise a fuzzy date string to YYYY-MM-DD, or None."""
    s = re.sub(r"\s+", " ", s.strip())
    # Remove day-of-week prefixes: "Monday, 12 Jan 2024" → "12 Jan 2024"
    s = re.sub(r"^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\w*,?\s*", "", s, flags=re.I)
    for fmt in _DATE_FORMATS:
        try:
            return datetime.strptime(s, fmt).strftime("%Y-%m-%d")
        except ValueError:
            pass
    return None


def _find_first_date(text: str, label_pattern: str) -> Optional[str]:
    """
    Search for a labelled date field and parse it.

    Handles both same-line and next-line layouts:
      "Invoice Date: 2024-07-06"   (colon separator, same line)
      "Invoice Date\n2024-07-06"   (grid layout, value on following line)
      "Due Date (May 12, 2026)"    (paren separator)
    """
    # Same-line: label followed by optional separator and date value
    m = re.search(
        label_pattern + r"\s*[:\-\(]?\s*" + _DATE_VALUE_PAT,
        text, re.IGNORECASE,
    )
    if m:
        parsed = _parse_date(m.group(1))
        if parsed:
            return parsed

    # Next-line: label on its own line, date on the following line
    # We search for label at end-of-line, then the date value at start of next line.
    m2 = re.search(
        label_pattern + r"\s*[:\-]?\s*\n\s*" + _DATE_VALUE_PAT,
        text, re.IGNORECASE,
    )
    if m2:
        return _parse_date(m2.group(1))

    return None


# ── Amount / currency extraction ───────────────────────────────────────────────

def _extract_amounts(text: str) -> list[tuple[float, str]]:
    """Return list of (value, currency_iso) from all monetary mentions in text."""
    results: list[tuple[float, str]] = []

    for m in _AMOUNT_PAT.finditer(text):
        raw_cur_pre = m.group(1) or ""
        raw_val_pre = m.group(2) or ""
        raw_val_suf = m.group(3) or ""
        raw_cur_suf = m.group(4) or ""

        raw_val = (raw_val_pre or raw_val_suf).strip()
        raw_cur = (raw_cur_pre or raw_cur_suf).strip()

        # Check for symbol in the original matched text
        if not raw_cur:
            symbol_m = _SYMBOL_PAT.search(m.group(0))
            if symbol_m:
                raw_cur = _SYMBOL_TO_ISO.get(symbol_m.group(), "")

        # Normalise currency aliases
        raw_cur_upper = raw_cur.upper().rstrip(".")
        if raw_cur_upper in ("KSH", "KSHS", "KENYA SHILLING"):
            raw_cur_upper = "KES"
        elif raw_cur_upper in ("USHS", "UGANDA SHILLING"):
            raw_cur_upper = "UGX"
        elif raw_cur_upper in ("TSH", "TANZANIA SHILLING"):
            raw_cur_upper = "TZS"

        # Normalise number: remove thousand separators, fix decimal
        raw_val = re.sub(r"[\s]", "", raw_val)
        # Handle European-style "1.234,56" → 1234.56
        if re.search(r"\d{1,3}(?:\.\d{3})+,\d{2}$", raw_val):
            raw_val = raw_val.replace(".", "").replace(",", ".")
        else:
            raw_val = raw_val.replace(",", "")

        try:
            value = float(raw_val)
            results.append((value, raw_cur_upper))
        except ValueError:
            pass

    return results


def _best_amount(text: str) -> tuple[Optional[str], Optional[str]]:
    """
    Return (amount_str, currency_iso) for the best total amount found.

    Preference order:
      1. Explicitly labelled grand total / amount due
      2. Largest amount anywhere in the document
    """
    total_pattern = re.compile(
        r"(?:grand\s*total|total\s*amount|amount\s*due|net\s*amount|total\s*payable"
        r"|invoice\s*total|total\s*inc\.?\s*(?:tax|vat)?|total\s*sum)"
        r"\s*[:\-]?\s*"
        rf"(?:{_ISO_CURRENCIES}|Ksh\.?|KSh\.?|Kshs\.?|[\$€£])?\s*"
        rf"(\d{{1,3}}(?:[,\s]\d{{3}})*(?:[.,]\d{{1,4}})?)",
        re.IGNORECASE,
    )
    for m in total_pattern.finditer(text):
        # Run amount extraction on the *full matched string* so the currency
        # prefix captured in the outer match is included.
        amounts = _extract_amounts(m.group(0))
        if amounts:
            val, cur = amounts[0]
            return str(round(val, 2)), cur or None

    # Fall back: largest amount in the document
    amounts = _extract_amounts(text)
    if not amounts:
        return None, None
    val, cur = max(amounts, key=lambda x: x[0])
    return str(round(val, 2)), cur or None


# ── Reference number extraction ────────────────────────────────────────────────

# Reject tokens that are just the label keyword itself
_REF_REJECT = frozenset({
    "INVOICE", "INV", "REF", "PO", "DN", "LPO", "FORM",
    "RECEIPT", "CONTRACT", "ORDER", "DELIVERY", "REQUEST",
    "NO", "NUM", "NUMBER",
})

# FIX: extended to 60 chars (was 29/40), added digit-first refs,
# and accepts mixed-case hyphenated tokens like "Mpesa-ABC123-XYZ".
_REF_VALUE_PAT = (
    r"(#?[A-Z]{1,6}[-/][A-Z0-9][A-Z0-9\-/]{1,59}"   # prefix-dash: INV-2024-001
    r"|#?[A-Z]{1,6}\d[A-Z0-9\-/]{1,59}"               # alpha-start: RCP88412
    r"|\d{1,6}[-/][A-Z0-9][A-Z0-9\-/]{1,59}"          # digit-start with separator: 1234-XYZ
    r"|\d{4,20}"                                        # pure numeric: 20240312
    r")"
)

_REF_LABELS: dict[str, re.Pattern] = {
    "invoice":        re.compile(
        r"(?:invoice\s*(?:no\.?|num(?:ber)?|#)|inv\.?\s*(?:no\.?|#)?)" + _SEP + _REF_VALUE_PAT,
        re.I | re.M,
    ),
    "purchase_order": re.compile(
        r"(?:(?:local\s+)?purchase\s+order\s*(?:no\.?|num(?:ber)?|#)?|p\.?o\.?\s*(?:no\.?|#)?|lpo\s*(?:no\.?|#)?)" + _SEP + _REF_VALUE_PAT,
        re.I | re.M,
    ),
    "receipt":        re.compile(
        r"(?:receipt\s*(?:no\.?|#)|rcpt\.?\s*(?:no\.?|#)?)" + _SEP + _REF_VALUE_PAT,
        re.I | re.M,
    ),
    "delivery_note":  re.compile(
        r"(?:delivery\s*(?:note\s*)?(?:no\.?|#)|d\.?n\.?\s*(?:no\.?|#)?|grn\s*(?:no\.?|#)?)" + _SEP + _REF_VALUE_PAT,
        re.I | re.M,
    ),
    "contract":       re.compile(
        r"(?:contract\s*(?:no\.?|num(?:ber)?|#)|agreement\s*(?:no\.?|#)?)" + _SEP + _REF_VALUE_PAT,
        re.I | re.M,
    ),
    "payment_voucher": re.compile(
        r"(?:voucher\s*(?:no\.?|#)|pv\s*(?:no\.?|#)?)" + _SEP + _REF_VALUE_PAT,
        re.I | re.M,
    ),
    "imprest":        re.compile(
        r"(?:imprest\s*(?:no\.?|#)|request\s*(?:no\.?|#)?)" + _SEP + _REF_VALUE_PAT,
        re.I | re.M,
    ),
    "general":        re.compile(
        r"(?:ref(?:erence)?\s*(?:no\.?|#)?|order\s*(?:no\.?|#)?)" + _SEP + r"#?"
        + _REF_VALUE_PAT,
        re.I | re.M,
    ),
}


def _extract_reference(text: str, doc_type: str) -> Optional[str]:
    """Extract the primary reference number for the given document type."""
    patterns = [_REF_LABELS.get(doc_type), _REF_LABELS.get("general")]
    for pat in patterns:
        if pat is None:
            continue
        for m in pat.finditer(text):
            val = m.group(1).strip().lstrip("#")
            if val.upper() in _REF_REJECT or len(val) < 2:
                continue
            return val
    return None


# ── Transaction reference extraction ──────────────────────────────────────────

# FIX: dedicated extractor with a wider character class.
# Handles M-PESA codes (e.g. "QK3XLZ1234"), cheque numbers, and arbitrary
# alphanumeric refs with hyphens/slashes up to 60 characters.
_TXN_REF_PAT = re.compile(
    r"(?:transaction\s*(?:ref(?:erence)?|no\.?|id|code)"
    r"|cheque\s*(?:no\.?|number)"
    r"|chq\.?\s*no\.?"
    r"|txn\s*(?:ref|id|no\.?)"
    r"|m[\-\s]?pesa\s*(?:ref(?:erence)?\s*(?:no\.?|code)?|code|no\.?|transaction(?:\s*id)?)"
    r"|mpesa\s*(?:ref(?:erence)?\s*(?:no\.?|code)?|code|no\.?)"
    r"|payment\s*ref(?:erence)?"
    r"|confirmation\s*(?:no\.?|code|ref(?:erence)?)"
    r")\s*[:\-]?\s*"
    r"([A-Z0-9][A-Z0-9\-/_]{2,59})",  # first char alphanumeric, rest flexible
    re.IGNORECASE,
)


def _extract_transaction_ref(text: str) -> Optional[str]:
    """Extract a payment / transaction reference from text."""
    for m in _TXN_REF_PAT.finditer(text):
        val = m.group(1).strip().rstrip(".,;:")
        if len(val) >= 3 and val.upper() not in _REF_REJECT:
            return val
    return None


# ── Supplier extraction ────────────────────────────────────────────────────────

_SUPPLIER_INLINE_RE = re.compile(
    r"(?:vendor|supplier|service\s*provider|sold\s*by|issued\s*by"
    r"|vendor\s*name|supplier\s*name|company\s*name|payee\s*name"
    r"|billed?\s*(?:from|by)|business\s*name)"
    r"\s*[:\-]\s*(.+)",
    re.I,
)
_SUPPLIER_HEADER_RE = re.compile(
    r"^(?:supplier|vendor|service\s*provider)\s*(?:details?|info(?:rmation)?|address)?$",
    re.I,
)

# FIX: added "bill to", "ship to", "sold to" to prevent customer-name leakage.
_SUPPLIER_REJECT_RE = re.compile(
    r"@"                                                        # email address
    r"|\b(?:lpo|p\.?o\.?\s*(?:box|no))\b"                    # P.O. Box or LPO reference in same line
    r"|\b(?:tel|phone|fax|mobile|cell)\b"                     # contact numbers
    r"|\bwww\."                                               # website URL
    r"|\d{6,}"                                               # long numeric strings (account/ref numbers)
    r"|\bno\.?\s*[:\-]"                                      # "No:" labels (invoice no, LPO no, etc.)
    r"|\b(?:bill(?:ed)?\s*to|ship(?:ped)?\s*to|sold\s*to)\b" # customer-block headers
    ,
    re.I,
)

_ENTITY_SUFFIX_RE = re.compile(
    r"\b(?:LLC|Ltd\.?|Limited|Inc\.?|Corp\.?|GmbH|PLC|LLP|S\.A\.?|Pty\.?)"
    r"(?:\.|,|\s|$)"
    r"|\bCo\.(?!\s*[a-z]{2,6}\b)",
    re.I,
)

# Pattern that marks the beginning of a Bill-To / Ship-To / Sold-To block.
_BILL_TO_BLOCK_RE = re.compile(
    r"\b(?:bill(?:ed)?\s*to|ship(?:ped)?\s*to|sold\s*to|deliver(?:y|ed)?\s*to)\b",
    re.I,
)


def _clean_inline_value(value: str, max_len: int = 120) -> str:
    """Trim common OCR bleed from labelled values on crowded invoice lines."""
    value = re.sub(r"\s+", " ", value).strip(" \t:-|")
    # FIX: added "bill to", "ship to", "sold to" as split markers.
    value = re.split(
        r"\s{2,}|\t|\|"
        r"|\b(?:tel|phone|mobile|email|e-?mail|www\.|p\.?\s*o\.?\s*box"
        r"|invoice\s*(?:no|date)|account\s*(?:code|no)|due\s*date|date"
        r"|bill(?:ed)?\s*to|ship(?:ped)?\s*to|sold\s*to)\b",
        value,
        maxsplit=1,
        flags=re.I,
    )[0]
    return value.strip(" \t:-,|")[:max_len]


def _first_bill_to_line_index(lines: list[str]) -> Optional[int]:
    """Index of the first BILL TO / SHIP TO / SOLD TO line, or None if absent."""
    for i, line in enumerate(lines):
        if _BILL_TO_BLOCK_RE.search(line):
            return i
    return None


def _looks_like_invoice_column_header_row(line: str) -> bool:
    """True when the line is mostly invoice grid labels (not a company name)."""
    lf = re.sub(r"[\t|]+", " ", line).lower()
    markers = (
        "account code", "supplier id", "supplier", "invoice date",
        "date issued", "due date", "payment due",
    )
    hits = sum(1 for m in markers if m in lf)
    return hits >= 2


def _extract_supplier(lines: list[str]) -> Optional[str]:
    """
    Return the issuing supplier / vendor name from document lines.

    Priority
    ────────
    1. Explicit "Supplier: <name>" / "Vendor: <name>" inline label.
    2. Section header ("SUPPLIER DETAILS") followed by the name on the next line.
    3. Positional: first non-junk line *before* the Bill-To block (capped at 15).
    4. Legal-entity suffix scan above the Bill-To block.
    """
    def _is_valid(candidate: str) -> bool:
        candidate = _clean_inline_value(candidate)
        if len(candidate) < 3:
            return False
        if _SUPPLIER_REJECT_RE.search(candidate):
            return False
        # Reject if it looks like a "Label: Value" line (another field bled through)
        if re.match(r"^[A-Za-z ]{1,30}:\s", candidate):
            return False
        return True

    # Priority 1: explicit supplier/vendor label on the same line
    for line in lines:
        m = _SUPPLIER_INLINE_RE.search(line)
        if m:
            candidate = _clean_inline_value(m.group(1))
            if _is_valid(candidate):
                return candidate

    # Priority 2: section header, name on the next line
    for i, line in enumerate(lines):
        if _SUPPLIER_HEADER_RE.match(line.strip()) and i + 1 < len(lines):
            candidate = _clean_inline_value(lines[i + 1])
            if _is_valid(candidate):
                return candidate

    # Priority 3: positional — issuer lines *before* BILL TO only.
    # FIX: raised cap from 8 to 15 lines; strictly bound by bill_to_idx.
    _DOCTYPE_HEADING_RE = re.compile(
        r"\b(?:invoice|receipt|purchase\s*order|lpo|delivery\s*note|contract"
        r"|agreement|quotation|expense|imprest|voucher|statement)\b",
        re.I,
    )

    bill_to_idx = _first_bill_to_line_index(lines)
    # Search up to 15 lines, but never past the Bill-To block.
    search_limit = bill_to_idx if bill_to_idx is not None else min(15, len(lines))
    search_limit = min(search_limit, 15)

    for line in lines[:search_limit]:
        stripped = line.strip()
        if not stripped:
            continue
        if _DOCTYPE_HEADING_RE.search(stripped):
            # If a doc-type keyword is in the line, the text BEFORE it might
            # be the issuer (e.g. "Acme Ltd — Invoice").
            m = _DOCTYPE_HEADING_RE.search(stripped)
            prefix = stripped[: m.start()].strip() if m else ""
            if len(prefix) >= 3 and _is_valid(prefix):
                return prefix[:120]
            continue
        # Tab- or pipe-separated rows are header grids or line items.
        if "\t" in stripped or "|" in stripped:
            continue
        if _looks_like_invoice_column_header_row(stripped):
            continue
        if _is_valid(stripped) and len(stripped) >= 5:
            if not re.match(r"^(?:p\.?\s*o\.?\s*box|po\s+box|\d+\s+\w)", stripped, re.I):
                return stripped[:120]

    # Priority 4: legal-entity suffix — only *above* BILL TO
    _ENTITY_TRUNCATE_RE = re.compile(
        r"^(.{0,80}?\b(?:LLC|Ltd\.?|Limited|Inc\.?|Corp\.?|GmbH|PLC|LLP|S\.A\.?|Pty\.?))"
        r"(?:[\s,.]|$)",
        re.I,
    )
    entity_limit = bill_to_idx if bill_to_idx is not None else len(lines)
    for line in lines[:entity_limit]:
        m = _ENTITY_TRUNCATE_RE.match(line.strip())
        if m:
            candidate = m.group(1).strip()
            if _is_valid(candidate):
                return candidate[:120]

    return None


# ── Tax / subtotal extraction ─────────────────────────────────────────────────

def _extract_tax_and_subtotal(text: str) -> tuple[Optional[str], Optional[str]]:
    """Return (tax_amount, subtotal) strings or None."""
    tax, subtotal = None, None

    tax_m = re.search(
        r"(?:vat|tax|gst|hst)\s*(?:\([^)]*\))?\s*(?:amount)?\s*[:\-]?\s*"
        r"(?:[A-Z$€£Kk]+\.?\s*)?"
        r"(\d{1,3}(?:[,\s]\d{3})*(?:[.,]\d{1,4})?)",
        text, re.I,
    )
    if tax_m:
        tax = re.sub(r"[,\s]", "", tax_m.group(1))

    sub_m = re.search(
        r"(?:subtotal|sub\s*total|net\s*(?:amount|value)?|amount\s*before\s*tax)\s*[:\-]?\s*"
        r"(?:[A-Z$€£Kk]+\s*)?"
        r"(\d{1,3}(?:[,\s]\d{3})*(?:[.,]\d{1,4})?)",
        text, re.I,
    )
    if sub_m:
        subtotal = re.sub(r"[,\s]", "", sub_m.group(1))

    return tax, subtotal


# ── Generic labelled-field extractor ──────────────────────────────────────────

def _first_match(text: str, pattern: str, group: int = 1) -> Optional[str]:
    m = re.search(pattern, text, re.I | re.M)
    return m.group(group).strip() if m else None


def _labelled_text(label_pattern: str, text: str, max_len: int = 120) -> Optional[str]:
    """Extract value after a label on the same line."""
    m = re.search(label_pattern + r"\s*[:\-]\s*(.+)", text, re.I | re.M)
    if m:
        val = m.group(1).strip()[:max_len]
        if len(val) > 1:
            return val
    return None


def _labelled_code(label_pattern: str, text: str) -> Optional[str]:
    """
    Extract an alphanumeric code (possibly hyphenated) after a label.

    FIX: wider character class — accepts digit-first tokens, mixed case,
    hyphens, slashes, underscores, up to 60 characters.  Also handles
    next-line layout (label on one line, code on the next).
    """
    # Same-line: "Account Code: NET-OPS-88"
    m = re.search(
        label_pattern + r"\s*[:\-]\s*([A-Z0-9#][A-Z0-9\-_/]{1,59})",
        text, re.I | re.M,
    )
    if m:
        val = m.group(1).strip().rstrip(".,;:")
        if val:
            return val

    # Next-line: label alone on one line, code on the following line
    m2 = re.search(
        label_pattern + r"\s*[:\-]?\s*\n\s*([A-Z0-9#][A-Z0-9\-_/]{1,59})",
        text, re.I,
    )
    if m2:
        val = m2.group(1).strip().rstrip(".,;:")
        if val:
            return val

    return None


# ── Account code helpers ───────────────────────────────────────────────────────

_ACCOUNT_LABEL_RE = re.compile(
    r"^(?:a/?c|acct\.?|account|gl|g/l|ledger|billing|client|customer|project)"
    r"\s*(?:code|no\.?|number|#|id)?$",
    re.I,
)
# Stricter: grid column must be clearly "code" / GL — not a generic "account"
# column that OCR maps to bank account numbers.
_ACCOUNT_GRID_LABEL_RE = re.compile(
    r"^(?:"
    r"(?:a/?c|acct\.?|account)\s+code"
    r"|account\s*#"
    r"|g/?l(?:\s*code)?"
    r"|ledger\s*code"
    r"|billing\s*code"
    r"|client\s*(?:code|id)"
    r"|customer\s*(?:code|id)"
    r"|project\s*code"
    r")$",
    re.I,
)
_CODE_VALUE_RE = re.compile(r"^[A-Z0-9][A-Z0-9\-_/]{1,59}$", re.I)


def _split_cells(line: str) -> list[str]:
    """Split OCR text into table-ish cells, preserving normal phrases."""
    if "\t" in line or "|" in line:
        return [cell.strip(" :-") for cell in re.split(r"\t+|\|+", line) if cell.strip(" :-")]
    return [cell.strip(" :-") for cell in re.split(r"\s{2,}", line) if cell.strip(" :-")]


def _normalise_label_cell(cell: str) -> str:
    cell = re.sub(r"[^A-Za-z0-9/#. ]+", " ", cell)
    return re.sub(r"\s+", " ", cell).strip().lower()


def _extract_code_from_header_grid(lines: list[str], label_re: re.Pattern) -> Optional[str]:
    """
    Extract codes from two-row header grids.

    Example:
        SUPPLIER        ACCOUNT CODE       INVOICE DATE
        ACME LTD        400-211            2026-05-01
    """
    for i, line in enumerate(lines[:-1]):
        headers = [_normalise_label_cell(cell) for cell in _split_cells(line)]
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

            candidate = values[idx].strip()
            # If OCR merged the value with a following cell, keep the first code-like token.
            token = re.split(r"\s{2,}|\t|\|", candidate, maxsplit=1)[0].strip()
            token = re.sub(r"^[^\w]+|[^\w\-/]+$", "", token)
            if _CODE_VALUE_RE.match(token) and token.upper() not in _REF_REJECT:
                return token
    return None


_SUPPLIER_GRID_HEADER_RE = re.compile(
    r"^(?:supplier|vendor)\s*(?:id|no\.?|#|number)(?:\s*)$|"
    r"^(?:supplier|vendor)\s+id$",
    re.I,
)


def _extract_supplier_from_header_grid(lines: list[str]) -> Optional[str]:
    """
    Supplier / vendor id from two-row header grids, e.g.:

        ACCOUNT CODE    SUPPLIER ID     DATE ISSUED
        NET-OPS-88      SUPP-CCS-99     Oct 25, 2024
    """
    for i, line in enumerate(lines[:-1]):
        headers = [_normalise_label_cell(cell) for cell in _split_cells(line)]
        if len(headers) < 2:
            continue

        values = _split_cells(lines[i + 1])
        if len(values) < 2:
            continue

        for idx, header in enumerate(headers):
            if idx >= len(values):
                continue
            if not _SUPPLIER_GRID_HEADER_RE.match(header):
                continue

            candidate = values[idx].strip()
            token = re.split(r"\s{2,}|\t|\|", candidate, maxsplit=1)[0].strip()
            token = re.sub(r"^[^\w]+|[^\w\-/]+$", "", token)
            if len(token) < 3:
                continue
            if token.upper() in _REF_REJECT:
                continue
            if _SUPPLIER_REJECT_RE.search(token):
                continue
            return token[:120]
    return None


_DOC_DATE_GRID_HDR = re.compile(
    r"^(?:date\s*issued|invoice\s*date|issue\s*date|document\s*date|bill\s*date)$",
    re.I,
)
_DUE_DATE_GRID_HDR = re.compile(
    r"^(?:due\s*date|payment\s*due|pay(?:ment)?\s*by|settle(?:ment)?\s*date)$",
    re.I,
)


def _extract_dates_from_header_grid(lines: list[str]) -> tuple[Optional[str], Optional[str]]:
    """Parse document_date and due_date cells from two-row header grids."""
    doc_date: Optional[str] = None
    due_date: Optional[str] = None
    for i, line in enumerate(lines[:-1]):
        headers = [_normalise_label_cell(cell) for cell in _split_cells(line)]
        if len(headers) < 2:
            continue
        values = _split_cells(lines[i + 1])
        if len(values) < 2:
            continue
        for idx, header in enumerate(headers):
            if idx >= len(values):
                continue
            raw_val = values[idx].strip()
            if not raw_val:
                continue
            parsed = _parse_date(raw_val)
            if not parsed:
                parsed = _parse_date(re.sub(r"\s+", " ", raw_val))
            if not parsed:
                continue
            if _DOC_DATE_GRID_HDR.match(header) and not doc_date:
                doc_date = parsed
            if _DUE_DATE_GRID_HDR.match(header) and not due_date:
                due_date = parsed
    return doc_date, due_date


_MONTH_RE = (
    r"(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*"
)


def _is_plausible_gl_account_code(value: str) -> bool:
    """
    Reject values that look like bank / customer account numbers rather than
    GL / cost codes.

    FIX: added IBAN-like check (≥ 10 consecutive digits).
    """
    s = (value or "").strip()
    # Long all-digit values: bank accounts, phone numbers, etc.
    if len(s) >= 10 and re.fullmatch(r"\d[\d\s,]*", s):
        return False
    # IBAN or 10+ consecutive digit strings embedded in otherwise alphanumeric codes
    if re.search(r"\d{10,}", s):
        return False
    return True


def _try_standard_invoice_grid_pair(header_line: str, value_line: str) -> Optional[dict[str, str]]:
    """
    Parse common space-separated invoice header grids, e.g.:

        ACCOUNT CODE SUPPLIER ID DATE ISSUED DUE DATE
        NET-OPS-88 SUPP-CCS-99 Oct 25, 2024 Nov 24, 2024

    FIX: now also handles partial grids (3 of 4 expected columns) so a
    missing "supplier id" or "due date" column does not abort parsing.
    """
    hdr = _normalise_label_cell(header_line)

    # Require at least one date column and "account code"
    has_doc_date = "date issued" in hdr or "invoice date" in hdr
    has_due_date = "due date" in hdr
    has_acct = "account code" in hdr
    has_vendor = "supplier id" in hdr

    # Need at minimum account code + one date column
    if not has_acct or not (has_doc_date or has_due_date):
        return None

    # Column order left-to-right in the header row
    header_flat = re.sub(r"[\t|]+", " ", header_line)
    col_keys: list[str] = []
    for m in re.finditer(
        r"(account\s+code|supplier\s+id|date\s+issued|invoice\s+date|due\s+date)",
        header_flat,
        re.I,
    ):
        key = m.group(1).lower().replace("  ", " ")
        if "account code" in key:
            col_keys.append("account_code")
        elif "supplier id" in key:
            col_keys.append("vendor_code")
        elif "date issued" in key or "invoice date" in key:
            col_keys.append("document_date")
        elif "due date" in key:
            col_keys.append("due_date")

    if len(col_keys) < 2 or len(set(col_keys)) != len(col_keys):
        return None

    # Parse dates from value line
    date_matches: list[re.Match] = list(re.finditer(
        rf"\b({_MONTH_RE}\s+\d{{1,2}},?\s*\d{{4}})\b"
        rf"|\b(\d{{4}}[-/]\d{{1,2}}[-/]\d{{1,2}})\b"
        rf"|\b(\d{{1,2}}[/\-]\d{{1,2}}[/\-]\d{{4}})\b",
        value_line, re.I,
    ))

    # Extract non-date prefix tokens as code values
    first_date_start = date_matches[0].start() if date_matches else len(value_line)
    prefix = value_line[:first_date_start].strip()
    code_tokens = re.findall(r"\S+", prefix)

    cells: dict[str, str] = {}

    # Assign code tokens to code columns in order
    code_col_keys = [k for k in col_keys if k in ("account_code", "vendor_code")]
    for i, ck in enumerate(code_col_keys):
        if i < len(code_tokens):
            cells[ck] = code_tokens[i]

    # Assign parsed dates to date columns in order
    date_col_keys = [k for k in col_keys if k in ("document_date", "due_date")]
    parsed_dates: list[str] = []
    for dm in date_matches:
        raw = dm.group(1) or dm.group(2) or dm.group(3) or ""
        parsed = _parse_date(raw)
        if parsed:
            parsed_dates.append(parsed)

    for i, dk in enumerate(date_col_keys):
        if i < len(parsed_dates):
            cells[dk] = parsed_dates[i]

    out: dict[str, str] = {}
    if cells.get("account_code") and _is_plausible_gl_account_code(cells["account_code"]):
        out["account_code"] = cells["account_code"]
    if cells.get("vendor_code"):
        out["vendor_code"] = cells["vendor_code"]
    if cells.get("document_date"):
        out["document_date"] = cells["document_date"]
    if cells.get("due_date"):
        out["due_date"] = cells["due_date"]

    return out if out else None


def _standard_invoice_grid_parse(lines: list[str]) -> dict[str, str]:
    """Return non-empty keys for account_code, vendor_code, document_date, due_date."""
    for i, line in enumerate(lines[:-1]):
        parsed = _try_standard_invoice_grid_pair(line, lines[i + 1])
        if parsed:
            return parsed
    return {}


def _extract_account_code(text: str, lines: list[str]) -> Optional[str]:
    """
    Extract GL / cost account code.

    Priority (highest first):
      1. Standard 4-column invoice grid (most structured)
      2. Strict "Account Code" / GL label in header grid
      3. Explicit "Account Code: <value>" labelled line
      4. Loose "Account" label in header grid (last resort — may match bank accts)
    """
    std = _standard_invoice_grid_parse(lines)
    if std.get("account_code") and _is_plausible_gl_account_code(std["account_code"]):
        return std["account_code"]

    grid = _extract_code_from_header_grid(lines, _ACCOUNT_GRID_LABEL_RE)
    if grid and _is_plausible_gl_account_code(grid):
        return grid

    labelled = _labelled_code(
        r"(?:a/?c\s*code|account\s+code|acct\.?\s*code|g/?l\s*(?:code|no\.?)"
        r"|ledger\s*code|billing\s*code|client\s*(?:code|id)|customer\s*(?:code|id)"
        r"|project\s*code)",
        text,
    )
    if labelled and _is_plausible_gl_account_code(labelled):
        return labelled

    # Last resort: loose label (higher false-positive risk)
    grid_loose = _extract_code_from_header_grid(lines, _ACCOUNT_LABEL_RE)
    if grid_loose and _is_plausible_gl_account_code(grid_loose):
        return grid_loose

    return None


# ── Main extractor class ───────────────────────────────────────────────────────


class DocumentFieldExtractor:
    """
    Extract structured fields from OCR text.

    Usage::

        extractor = DocumentFieldExtractor(ocr_text)
        suggestions = extractor.extract()
    """

    def __init__(self, text: str) -> None:
        self.text = text
        self.lines = [ln.strip() for ln in text.splitlines() if ln.strip()]
        self.doc_type: str = "general"
        self.doc_type_label: str = ""
        self._classify_document()

    # ── Document type classification ───────────────────────────────────────

    def _classify_document(self) -> None:
        """
        Identify document type with position + specificity scoring.

        Patterns are ordered from most-specific to least-specific in
        _DOCTYPE_PATTERNS (LPO before PO before invoice). When two matches
        are within the first 30% of the document, prefer the longer keyword
        (more specific). Beyond 30%, position wins.
        """
        best_match = None
        best_pos = len(self.text) + 1
        best_kw_len = 0
        threshold = max(200, int(len(self.text) * 0.30))

        for pat, dtype, label in _DOCTYPE_PATTERNS:
            m = pat.search(self.text)
            if not m:
                continue
            pos = m.start()
            kw_len = len(m.group(0))

            if best_match is None:
                best_match = (dtype, label)
                best_pos = pos
                best_kw_len = kw_len
                continue

            if pos <= threshold and best_pos <= threshold:
                if kw_len > best_kw_len:
                    best_match = (dtype, label)
                    best_pos = pos
                    best_kw_len = kw_len
            elif pos < best_pos:
                best_match = (dtype, label)
                best_pos = pos
                best_kw_len = kw_len

        if best_match:
            self.doc_type, self.doc_type_label = best_match
        else:
            self.doc_type, self.doc_type_label = "general", ""

    # ── Public interface ───────────────────────────────────────────────────

    def extract(self) -> dict:
        """Run all extractors and return the suggestions dict."""
        if not self.text or not self.text.strip():
            return {}

        suggestions: dict = {}

        # ── Always-present fields ──────────────────────────────────────────
        suggestions["raw_lines"] = self.lines[:20]

        if self.doc_type_label:
            suggestions["document_type"] = self.doc_type_label

        supplier = _extract_supplier(self.lines)
        if supplier:
            suggestions["supplier"] = supplier

        amount, currency = _best_amount(self.text)
        if amount:
            suggestions["amount"] = amount
        if currency:
            suggestions["currency"] = currency

        ref = _extract_reference(self.text, self.doc_type)
        if ref:
            suggestions["reference_number"] = ref

        # ── Dates ─────────────────────────────────────────────────────────
        self._extract_dates(suggestions)

        # ── Type-specific fields ───────────────────────────────────────────
        extractor = getattr(self, f"_extract_{self.doc_type}", self._extract_general)
        extractor(suggestions)

        # ── Universal supplementary fields ─────────────────────────────────
        self._extract_universal_fields(suggestions)

        # ── Standard invoice grid (wins over heuristics for these fields) ──
        std_grid = _standard_invoice_grid_parse(self.lines)
        for key in ("account_code", "vendor_code", "document_date", "due_date"):
            if std_grid.get(key):
                suggestions[key] = std_grid[key]
        if not std_grid.get("vendor_code"):
            tab_vid = _extract_supplier_from_header_grid(self.lines)
            if tab_vid:
                suggestions["vendor_code"] = tab_vid

        return {k: v for k, v in suggestions.items() if v is not None and v != ""}

    # ── Date extraction ────────────────────────────────────────────────────

    def _extract_dates(self, out: dict) -> None:
        text = self.text

        # Determine the character position where the Bill-To block starts so we
        # can avoid picking up customer dates as document dates.
        bill_to_idx = _first_bill_to_line_index(self.lines)
        bill_to_char = (
            sum(len(ln) + 1 for ln in self.lines[:bill_to_idx])
            if bill_to_idx is not None else len(text)
        )
        # Use only the text before the Bill-To block for date searches
        pre_bill_text = text[:bill_to_char]

        # ── Document / issue date ──────────────────────────────────────────
        doc_date = _find_first_date(
            text,
            r"(?:invoice\s*date|bill\s*date|document\s*date|issue(?:d)?\s*date"
            r"|date\s*of\s*issue|p\.?o\.?\s*date|order\s*date|receipt\s*date"
            r"|request\s*date|voucher\s*date)",
        )

        # FIX: bare "Date:" fallback uses pre_bill_text to avoid picking up
        # customer "Date of Birth" or signature dates.
        if not doc_date:
            bare_m = re.search(
                r"(?<!\w)date\s*[:\-]\s*" + _DATE_VALUE_PAT,
                pre_bill_text, re.IGNORECASE,
            )
            due_m = re.search(
                r"(?:due\s*date|payment\s*(?:due\s*)?date|pay(?:ment)?\s*by)",
                pre_bill_text, re.IGNORECASE,
            )
            if bare_m and (due_m is None or bare_m.start() < due_m.start()):
                doc_date = _parse_date(bare_m.group(1))

        if doc_date:
            out["document_date"] = doc_date

        # ── Due / payment date ─────────────────────────────────────────────
        due_date = _find_first_date(
            text,
            r"(?:due\s*date|payment\s*(?:due\s*)?date|pay(?:ment)?\s*by"
            r"|payment\s*due(?:\s*date)?|settle(?:ment)?\s*date)",
        )
        if due_date:
            out["due_date"] = due_date

        # ── Effective / start date (contracts) ────────────────────────────
        eff = _find_first_date(
            text,
            r"(?:effective\s*date|start\s*date|commencement\s*date|from\s*date)",
        )
        if eff:
            out["effective_date"] = eff
            if "document_date" not in out:
                out["document_date"] = eff

        # ── Expiry / end date ─────────────────────────────────────────────
        exp = _find_first_date(
            text,
            r"(?:expir(?:y|ation)\s*date|end\s*date|termination\s*date"
            r"|valid(?:ity)?\s*(?:date|until|to|through))",
        )
        if exp:
            out["expiry_date"] = exp
            if "due_date" not in out and self.doc_type == "contract":
                out["due_date"] = exp

        # ── Signed date ───────────────────────────────────────────────────
        signed = _find_first_date(
            text,
            r"(?:date\s*signed|signed\s*(?:on|date)|execution\s*date|date\s*of\s*signing)",
        )
        if signed:
            out["signed_date"] = signed

        # ── Delivery date ─────────────────────────────────────────────────
        delivery = _find_first_date(
            text,
            r"(?:delivery\s*date|required\s*(?:by|date)|dispatch\s*date"
            r"|ship(?:ment)?\s*date|expected\s*(?:delivery\s*)?date)",
        )
        if delivery:
            out["delivery_date"] = delivery

        # ── Absolute fallback: first plausible date if still nothing found ─
        if "document_date" not in out:
            fallback_patterns = [
                # ISO: negative lookbehind prevents matching years embedded inside
                # reference numbers such as "INV-2024-07-15" or "PO-2024-11-30".
                # Without the guard, \d{4}[-/]\d{1,2}[-/]\d{1,2} would match
                # "2024-07-15" starting at the digit run inside the ref string.
                r"(?<![A-Za-z0-9\-/])(\d{4}[-/]\d{1,2}[-/]\d{1,2})\b",
                r"\b(\d{1,2}\s+(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May"
                r"|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?"
                r"|Nov(?:ember)?|Dec(?:ember)?)\s+\d{4})\b",
                r"\b((?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May"
                r"|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?"
                r"|Nov(?:ember)?|Dec(?:ember)?)\s+\d{1,2},?\s+\d{4})\b",
                # Ambiguous DMY/MDY last — only accept if unambiguously separated
                # from a surrounding ref (same lookbehind guard).
                r"(?<![A-Za-z0-9\-/])(\d{1,2}/\d{1,2}/\d{4})\b",
            ]
            for pat in fallback_patterns:
                for m in re.finditer(pat, pre_bill_text, re.I):
                    parsed = _parse_date(m.group(1))
                    if parsed:
                        out["document_date"] = parsed
                        break
                if "document_date" in out:
                    break

        grid_doc, grid_due = _extract_dates_from_header_grid(self.lines)
        if grid_doc and "document_date" not in out:
            out["document_date"] = grid_doc
        if grid_due and "due_date" not in out:
            out["due_date"] = grid_due

    # ── Invoice extractor ──────────────────────────────────────────────────

    def _extract_invoice(self, out: dict) -> None:
        text = self.text

        inv_ref = _extract_reference(text, "invoice")
        if inv_ref:
            out["reference_number"] = inv_ref

        tax, subtotal = _extract_tax_and_subtotal(text)
        if tax:
            out["tax_amount"] = tax
        if subtotal:
            out["subtotal"] = subtotal

        acct = _extract_account_code(text, self.lines)
        if acct:
            out["account_code"] = acct

        po_ref = _labelled_code(
            r"(?:purchase\s*order\s*(?:ref(?:erence)?|no\.?)|p\.?o\.?\s*(?:ref(?:erence)?|no\.?)|order\s*ref)",
            text,
        )
        if po_ref:
            out["po_reference"] = po_ref

        terms = _labelled_text(
            r"(?:payment\s*terms?|terms?\s*of\s*payment|credit\s*terms?)", text, 80
        )
        if terms:
            out["payment_terms"] = terms

    # ── Purchase order extractor ───────────────────────────────────────────

    def _extract_purchase_order(self, out: dict) -> None:
        text = self.text

        po_ref = _extract_reference(text, "purchase_order")
        if po_ref:
            out["reference_number"] = po_ref

        vendor_code = _labelled_code(
            r"(?:vendor\s*(?:code|no\.?|id)|supplier\s*(?:code|no\.?|id))",
            text,
        )
        if vendor_code:
            out["vendor_code"] = vendor_code

        approved_by = _labelled_text(
            r"(?:approved\s*by|authoris(?:ed|ation)\s*(?:by)?|authorized\s*by)",
            text,
        )
        if approved_by:
            out["approved_by"] = approved_by

        auth_code = _labelled_code(
            r"(?:auth(?:orization|orisation)?\s*(?:code|no\.?|ref)?|approval\s*(?:code|no\.?|ref)?)",
            text,
        )
        if auth_code:
            out["auth_code"] = auth_code

        tax, subtotal = _extract_tax_and_subtotal(text)
        if tax:
            out["tax_amount"] = tax
        if subtotal:
            out["subtotal"] = subtotal

    # ── Contract extractor ─────────────────────────────────────────────────

    def _extract_contract(self, out: dict) -> None:
        text = self.text

        contract_ref = _extract_reference(text, "contract")
        if contract_ref:
            out["reference_number"] = contract_ref

        cv_m = re.search(
            r"(?:contract\s*(?:value|sum|price|amount)|total\s*(?:contract\s*)?value)"
            r"\s*[:\-]?\s*"
            rf"(?:{_ISO_CURRENCIES}|Ksh\.?|[\$€£])?\s*"
            r"(\d{1,3}(?:[,\s]\d{3})*(?:[.,]\d{1,4})?)",
            text, re.I,
        )
        if cv_m:
            out["contract_value"] = re.sub(r"[,\s]", "", cv_m.group(1))

        signed_by = _labelled_text(
            r"(?:signed\s*by|executed\s*by|signatory|authorized\s*signatory)",
            text,
        )
        if signed_by:
            out["signed_by"] = signed_by

    # ── Receipt extractor ──────────────────────────────────────────────────

    def _extract_receipt(self, out: dict) -> None:
        text = self.text

        rcpt_ref = _extract_reference(text, "receipt")
        if rcpt_ref:
            out["reference_number"] = rcpt_ref

        pay_method = _labelled_text(
            r"(?:payment\s*method|paid\s*(?:via|by|through)|mode\s*of\s*payment"
            r"|payment\s*mode|method\s*of\s*payment)",
            text, 80,
        )
        if pay_method:
            out["payment_method"] = pay_method

        # FIX: use dedicated transaction-ref extractor (wider pattern)
        txn_ref = _extract_transaction_ref(text)
        if txn_ref:
            out["transaction_ref"] = txn_ref

    # ── Delivery note extractor ────────────────────────────────────────────

    def _extract_delivery_note(self, out: dict) -> None:
        text = self.text

        dn_ref = _extract_reference(text, "delivery_note")
        if dn_ref:
            out["reference_number"] = dn_ref

        po_ref = _labelled_code(
            r"(?:purchase\s*order\s*(?:ref(?:erence)?|no\.?)|p\.?o\.?\s*(?:ref(?:erence)?|no\.?)|order\s*ref)",
            text,
        )
        if po_ref:
            out["po_reference"] = po_ref

        received_by = _labelled_text(
            r"(?:received\s*by|accepted\s*by|delivered\s*to)",
            text,
        )
        if received_by:
            out["received_by"] = received_by

    # ── Expense claim extractor ────────────────────────────────────────────

    def _extract_expense_claim(self, out: dict) -> None:
        text = self.text

        requested_by = _labelled_text(
            r"(?:requested\s*by|prepared\s*by|raised\s*by|submitted\s*by|claimant)",
            text,
        )
        if requested_by:
            out["requested_by"] = requested_by

        cost_centre = _labelled_code(
            r"(?:cost\s*cent(?:re|er)|department\s*code|dept\.?\s*code|budget\s*code)",
            text,
        )
        if cost_centre:
            out["cost_centre"] = cost_centre

        purpose = _labelled_text(
            r"(?:purpose|reason|description\s*of\s*(?:expenditure|payment|claim)|for)",
            text, 200,
        )
        if purpose and len(purpose) > 4:
            out["purpose"] = purpose

        approved_by = _labelled_text(
            r"(?:approved\s*by|authoris(?:ed|ation)\s*(?:by)?|authorized\s*by)",
            text,
        )
        if approved_by:
            out["approved_by"] = approved_by

    # ── Imprest extractor ──────────────────────────────────────────────────

    def _extract_imprest(self, out: dict) -> None:
        self._extract_expense_claim(out)
        imprest_ref = _extract_reference(self.text, "imprest")
        if imprest_ref:
            out["reference_number"] = imprest_ref

    # ── Payment voucher extractor ──────────────────────────────────────────

    def _extract_payment_voucher(self, out: dict) -> None:
        text = self.text

        vch_ref = _extract_reference(text, "payment_voucher")
        if vch_ref:
            out["reference_number"] = vch_ref

        payee = _labelled_text(
            r"(?:payee|pay\s*to|paid\s*to|in\s*favour\s*of|beneficiary)",
            text,
        )
        if payee:
            out["payee"] = payee
            if "supplier" not in out:
                out["supplier"] = payee

        self._extract_receipt(out)  # shares payment_method and transaction_ref

        approved_by = _labelled_text(
            r"(?:approved\s*by|authoris(?:ed|ation)\s*(?:by)?|authorized\s*by)",
            text,
        )
        if approved_by:
            out["approved_by"] = approved_by

    # ── Credit / debit note ────────────────────────────────────────────────

    def _extract_credit_note(self, out: dict) -> None:
        self._extract_invoice(out)

    def _extract_debit_note(self, out: dict) -> None:
        self._extract_invoice(out)

    # ── Quotation ─────────────────────────────────────────────────────────

    def _extract_quotation(self, out: dict) -> None:
        self._extract_invoice(out)
        exp = out.get("expiry_date") or _find_first_date(
            self.text, r"(?:valid(?:ity)?\s*(?:until|till|to|for)|quote\s*valid(?:\s*until)?)"
        )
        if exp:
            out["expiry_date"] = exp
            if "due_date" not in out:
                out["due_date"] = exp

    # ── Utility bill ──────────────────────────────────────────────────────

    def _extract_utility_bill(self, out: dict) -> None:
        self._extract_invoice(out)

        acct = _extract_account_code(self.text, self.lines) or _labelled_code(
            r"(?:meter\s*(?:number|no\.?)|customer\s*(?:number|no\.?|id))",
            self.text,
        )
        if acct:
            out["account_code"] = acct

    # ── Statement ─────────────────────────────────────────────────────────

    def _extract_statement(self, out: dict) -> None:
        self._extract_invoice(out)

    # ── General fallback ──────────────────────────────────────────────────

    def _extract_general(self, out: dict) -> None:
        tax, subtotal = _extract_tax_and_subtotal(self.text)
        if tax:
            out["tax_amount"] = tax
        if subtotal:
            out["subtotal"] = subtotal

        acct = _extract_account_code(self.text, self.lines)
        if acct:
            out["account_code"] = acct

    # ── Universal supplementary fields ────────────────────────────────────

    def _extract_universal_fields(self, out: dict) -> None:
        """Fields extracted for all document types (supplements type-specific)."""
        text = self.text

        if "account_code" not in out:
            acct = _extract_account_code(text, self.lines)
            if acct:
                out["account_code"] = acct

        if "cost_centre" not in out:
            cc = _labelled_code(
                r"(?:cost\s*cent(?:re|er)|department\s*code|dept\.?\s*code|budget\s*code)",
                text,
            )
            if cc:
                out["cost_centre"] = cc

        if "approved_by" not in out:
            appr = _labelled_text(
                r"(?:approved\s*by|authoris(?:ed|ation)\s*(?:by)?|authorized\s*by"
                r"|authorised\s*signatory)",
                text,
            )
            if appr:
                out["approved_by"] = appr

        # FIX: use dedicated transaction-ref extractor for M-PESA / mobile money
        if "transaction_ref" not in out:
            txn_ref = _extract_transaction_ref(text)
            if txn_ref:
                out["transaction_ref"] = txn_ref
                if "payment_method" not in out:
                    # If it looks like an M-PESA code, tag the method
                    if re.search(r"m[\-\s]?pesa|mpesa", text, re.I):
                        out["payment_method"] = "M-PESA"

        # KRA PIN (Kenya Revenue Authority)
        kra_m = re.search(r"\b(?:kra\s*pin|pin\s*no\.?)\s*[:\-]?\s*([A-Z]\d{9}[A-Z])\b", text, re.I)
        if kra_m:
            out["kra_pin"] = kra_m.group(1).upper()

        # VAT/Tax registration number
        vat_m = re.search(
            r"(?:vat\s*(?:reg(?:istration)?\s*)?(?:no\.?|number)|tax\s*(?:reg(?:istration)?\s*)?(?:no\.?|number))"
            r"\s*[:\-]?\s*([A-Z0-9][A-Z0-9\-/]{3,30})",
            text, re.I,
        )
        if vat_m:
            out["vat_number"] = vat_m.group(1).strip()


# ── Public convenience function ────────────────────────────────────────────────


def extract_document_fields(ocr_text: str) -> dict:
    """
    Entry point called by the Celery task.

    Returns the suggestions dict populated by DocumentFieldExtractor.
    """
    if not ocr_text or not ocr_text.strip():
        return {}
    try:
        extractor = DocumentFieldExtractor(ocr_text)
        return extractor.extract()
    except Exception:
        logger.exception("extract_document_fields: unexpected error")
        return {}