"""
apps/documents/ocr/extractor.py

Structured field extraction from OCR text.

This module replaces the monolithic _extract_ocr_suggestions() function in
tasks.py with a maintainable, multi-strategy extractor.

Architecture
────────────
DocumentFieldExtractor is the entry point. It runs three extraction strategies
in priority order for each field:

  1. LabelledFieldStrategy  — "Label: Value" patterns (highest precision)
  2. LayoutHeuristicStrategy — positional cues (top of document = title/supplier)
  3. FallbackPatternStrategy — broad regex sweeps when the above find nothing

Each strategy returns a dict of field → value. Results are merged with earlier
strategies taking precedence.

The extractor is document-type-aware: it first classifies the document type
(invoice, PO, contract, etc.) and then applies the appropriate field mapping.

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
  title, document_type, reference_number, amount, currency,
  document_date, due_date, supplier, raw_lines
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

# Date value pattern — matches ISO, DMY, MDY, and spelled-out formats
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
    """Search for a labelled date field and parse it."""
    # The separator between a label and its value is typically ": " or "-  " or
    # just whitespace. We must consume the colon (and surrounding whitespace)
    # explicitly, otherwise "Due Date:   15 Nov 2024" won't match because
    # \s* does not consume ':'.
    m = re.search(label_pattern + r"\s*[:\-]?\s*" + _DATE_VALUE_PAT, text, re.IGNORECASE)
    return _parse_date(m.group(1)) if m else None


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
        if raw_cur_upper in ("KSH", "KSH", "KSHS", "KENYA SHILLING"):
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
    """Return (amount_str, currency_iso) for the largest amount found, or (None, None)."""
    # Prefer labelled totals over all amounts
    total_patterns = [
        r"(?:grand\s*total|total\s*amount|amount\s*due|net\s*amount|total\s*payable"
        r"|invoice\s*total|total\s*inc\.?\s*(?:tax|vat)?|total\s*sum)",
    ]
    for pat in total_patterns:
        m = re.search(
            pat + r"\s*[:\-]?\s*" + rf"({_ISO_CURRENCIES}|Ksh\.?|KSh\.?|[\$€£])?\s*"
            rf"(\d{{1,3}}(?:[,\s]\d{{3}})*(?:[.,]\d{{1,4}})?)",
            text, re.IGNORECASE,
        )
        if m:
            amounts = _extract_amounts(m.group(0) + " " + (m.group(1) or "") + (m.group(2) or ""))
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

_REF_VALUE_PAT = (
    r"([A-Z]{1,6}[-/][A-Z0-9][A-Z0-9\-/]{1,29}"   # prefix-dash: INV-2024-001
    r"|[A-Z]{1,6}\d[A-Z0-9\-/]{1,29}"               # alpha-start: RCP88412
    r"|\d{4,20}"                                      # pure numeric: 20240312
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
        r"(?:delivery\s*(?:note\s*)?(?:no\.?|#)|d\.?n\.?\s*(?:no\.?|#)?)" + _SEP + _REF_VALUE_PAT,
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
        r"(?:ref(?:erence)?\s*(?:no\.?|#)?|order\s*(?:no\.?|#)?)" + _SEP + _REF_VALUE_PAT,
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
            val = m.group(1).strip()
            if val.upper() in _REF_REJECT or len(val) < 2:
                continue
            return val
    return None


# ── Supplier extraction ────────────────────────────────────────────────────────

_SUPPLIER_INLINE_RE = re.compile(
    r"(?:vendor|supplier|service\s*provider|sold\s*by|issued\s*by"
    r"|billed?\s*(?:from|by)|business\s*name)"   # "from", "company", "firm" removed — too generic
    r"\s*[:\-]\s*(.+)",
    re.I,
)
_SUPPLIER_HEADER_RE = re.compile(
    r"^(?:supplier|vendor|service\s*provider)\s*(?:details?|info(?:rmation)?|address)?$",
    re.I,
)

# Lines to reject as supplier candidates regardless of which strategy matched them
_SUPPLIER_REJECT_RE = re.compile(
    r"@"                                      # email address
    r"|\b(?:lpo|p\.?o\.?\s*(?:box|no))\b"   # P.O. Box or LPO reference in same line
    r"|\b(?:tel|phone|fax|mobile|cell)\b"    # contact numbers
    r"|\bwww\."                              # website URL
    r"|\d{6,}"                              # long numeric strings (account/ref numbers)
    r"|\bno\.?\s*[:\-]"                     # "No:" labels (invoice no, LPO no, etc.)
    ,
    re.I,
)

_ENTITY_SUFFIX_RE = re.compile(
    # Match legal entity suffixes. Require that "Co." is NOT followed by a
    # lowercase TLD segment (stops ".co.ke" domain names from matching).
    r"\b(?:LLC|Ltd\.?|Limited|Inc\.?|Corp\.?|GmbH|PLC|LLP|S\.A\.?|Pty\.?)"
    r"(?:\.|,|\s|$)"
    r"|\bCo\.(?!\s*[a-z]{2,6}\b)",
    re.I,
)


def _extract_supplier(lines: list[str]) -> Optional[str]:
    def _is_valid(candidate: str) -> bool:
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
            candidate = m.group(1).strip()[:120]
            if _is_valid(candidate):
                return candidate

    # Priority 2: section header, name on the next line
    for i, line in enumerate(lines):
        if _SUPPLIER_HEADER_RE.match(line) and i + 1 < len(lines):
            candidate = lines[i + 1].strip()[:120]
            if _is_valid(candidate):
                return candidate

    # Priority 3: positional — first valid line at the top of the document,
    # before the "Bill To / Billed To" boundary and before the document-type heading.
    # On most invoices/receipts the issuer's name is the very first line.
    _DOCTYPE_HEADING_RE = re.compile(
        r"\b(?:invoice|receipt|purchase\s*order|lpo|delivery\s*note|contract"
        r"|agreement|quotation|expense|imprest|voucher|statement)\b",
        re.I,
    )
    _BILL_TO_RE = re.compile(r"\bbill(?:ed)?\s*to\b|\bship(?:ped)?\s*to\b", re.I)

    for line in lines[:8]:  # only consider the first 8 lines as "header zone"
        if _DOCTYPE_HEADING_RE.search(line):
            break  # stop at the document-type heading (e.g. "TAX INVOICE")
        if _BILL_TO_RE.search(line):
            break  # stop at "Bill To"
        if _is_valid(line) and len(line) >= 5:
            # Prefer lines that look like company names: not pure address lines
            if not re.match(r"^(?:p\.?\s*o\.?\s*box|po\s+box|\d+\s+\w)", line, re.I):
                return line.strip()[:120]

    # Priority 4: first line with a legal entity suffix that passes rejection checks
    for line in lines:
        if _ENTITY_SUFFIX_RE.search(line) and _is_valid(line):
            return line.strip()[:120]

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


# ── Title extraction ───────────────────────────────────────────────────────────

_SKIP_TITLE_RE = re.compile(
    r"^\$|subtotal|^tax\b|total|^\d[\d\s,./]*$"
    r"|@|\bsuite\b|\bblvd\b|\bstreet\b|\bave(?:nue)?\b|\broad\b"
    r"|\bpo\s+box\b|\bzip\b|\bpostal\b",
    re.I,
)
_LABEL_LINE_RE = re.compile(r"^[A-Za-z][A-Za-z0-9 /.\-]{1,40}:\s+\S")


def _extract_title(lines: list[str], doc_type_raw: str) -> Optional[str]:
    for line in lines:
        if len(line) < 4:
            continue
        if re.match(r"^[\d\W]+$", line):
            continue
        if _SKIP_TITLE_RE.search(line):
            continue
        if _LABEL_LINE_RE.match(line):
            continue
        if doc_type_raw and re.fullmatch(
            re.escape(doc_type_raw) + r"[\s/\-]*(?:form|request|note)?",
            line, re.I,
        ):
            continue
        return line[:120]
    return None


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
    """Extract an alphanumeric code after a label."""
    m = re.search(
        label_pattern + r"\s*[:\-]\s*([A-Z0-9][A-Z0-9\-_/]{1,40})",
        text, re.I | re.M,
    )
    return m.group(1).strip() if m else None


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

        Problem: a reference number like "LPO No: LPO-7732" embedded in an
        address or email footer will match 'l.p.o.' at a very early position,
        beating "TAX INVOICE" which appears later in the heading.

        Fix: patterns are ordered from most-specific to least-specific in
        _DOCTYPE_PATTERNS (LPO before PO before invoice). When two matches
        are within the first 30 % of the document, prefer the one whose
        keyword is longer (more specific). Beyond the 30 % threshold, position
        wins as before so we don't accidentally ignore headings on long docs.
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

            # Both matches are in the "heading zone" — prefer the longer keyword
            if pos <= threshold and best_pos <= threshold:
                if kw_len > best_kw_len:
                    best_match = (dtype, label)
                    best_pos = pos
                    best_kw_len = kw_len
            # New match is clearly earlier than the best so far
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

        title = _extract_title(self.lines, self.doc_type_label)
        if title:
            suggestions["title"] = title

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

        return {k: v for k, v in suggestions.items() if v is not None and v != ""}

    # ── Date extraction ────────────────────────────────────────────────────

    def _extract_dates(self, out: dict) -> None:
        text = self.text

        # ── Document / issue date ──────────────────────────────────────────
        # Try explicit labelled patterns first — most specific to least.
        # The bare "date" fallback is intentionally excluded here because it
        # fires on "Due Date" too, making both fields the same value.
        doc_date = _find_first_date(
            text,
            r"(?:invoice\s*date|bill\s*date|document\s*date|issue(?:d)?\s*date"
            r"|date\s*of\s*issue|p\.?o\.?\s*date|order\s*date|receipt\s*date"
            r"|request\s*date|voucher\s*date)",   # "date" alone removed here
        )
        # Fallback: bare "Date:" only if it appears BEFORE any "Due Date:" label
        if not doc_date:
            bare_m = re.search(
                r"(?<!\w)date\s*[:\-]\s*" + _DATE_VALUE_PAT,
                text, re.IGNORECASE,
            )
            due_m = re.search(
                r"(?:due\s*date|payment\s*(?:due\s*)?date|pay(?:ment)?\s*by)",
                text, re.IGNORECASE,
            )
            # Accept the bare "Date:" hit only if it comes before the due-date label
            # (avoids grabbing "Due Date" value as the document date)
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
        # Use a priority order: ISO first (unambiguous), then D/M/Y, then spelled-out.
        if "document_date" not in out:
            fallback_patterns = [
                r"\b(\d{4}[-/]\d{1,2}[-/]\d{1,2})\b",              # ISO: 2024-07-06
                r"\b(\d{1,2}\s+(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May"
                r"|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?"
                r"|Nov(?:ember)?|Dec(?:ember)?)\s+\d{4})\b",        # 06 July 2024
                r"\b((?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May"
                r"|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?"
                r"|Nov(?:ember)?|Dec(?:ember)?)\s+\d{1,2},?\s+\d{4})\b",  # July 6, 2024
                r"\b(\d{1,2}/\d{1,2}/\d{4})\b",                    # 06/07/2024 (ambiguous, last resort)
            ]
            for pat in fallback_patterns:
                for m in re.finditer(pat, text, re.I):
                    parsed = _parse_date(m.group(1))
                    if parsed:
                        out["document_date"] = parsed
                        break
                if "document_date" in out:
                    break

    # ── Invoice extractor ──────────────────────────────────────────────────

    def _extract_invoice(self, out: dict) -> None:
        text = self.text

        # Invoice number (more specific than generic reference)
        inv_ref = _extract_reference(text, "invoice")
        if inv_ref:
            out["reference_number"] = inv_ref

        # Tax amounts
        tax, subtotal = _extract_tax_and_subtotal(text)
        if tax:
            out["tax_amount"] = tax
        if subtotal:
            out["subtotal"] = subtotal

        # Account/GL code
        acct = _labelled_code(
            r"(?:account\s*(?:code|no\.?)?|acct\.?\s*(?:code|no\.?)?|gl\s*(?:code|no\.?)?|billing\s*code)",
            text,
        )
        if acct:
            out["account_code"] = acct

        # Purchase order reference (cross-ref on invoice)
        po_ref = _labelled_code(
            r"(?:purchase\s*order\s*(?:ref(?:erence)?|no\.?)|p\.?o\.?\s*(?:ref(?:erence)?|no\.?)|order\s*ref)",
            text,
        )
        if po_ref:
            out["po_reference"] = po_ref

        # Payment terms
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

        # Contract value (may differ from "amount" which is the largest value)
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

        txn_ref = _labelled_code(
            r"(?:transaction\s*(?:ref(?:erence)?|no\.?|id)|cheque\s*(?:no\.?|number)"
            r"|chq\s*no\.?|txn\s*(?:ref|id|no\.?)|m[\-\s]?pesa\s*(?:ref|code|no\.?)"
            r"|payment\s*ref(?:erence)?)",
            text,
        )
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
        # Imprest shares most fields with expense claims
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
            # Also set supplier if not already found
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

        acct = _labelled_code(
            r"(?:account\s*(?:number|no\.?)|meter\s*(?:number|no\.?)|customer\s*(?:number|no\.?|id))",
            self.text,
        )
        if acct:
            out["account_code"] = acct

    # ── Statement ─────────────────────────────────────────────────────────

    def _extract_statement(self, out: dict) -> None:
        self._extract_invoice(out)

    # ── General fallback ──────────────────────────────────────────────────

    def _extract_general(self, out: dict) -> None:
        """Fallback: apply all common extractors."""
        tax, subtotal = _extract_tax_and_subtotal(self.text)
        if tax:
            out["tax_amount"] = tax
        if subtotal:
            out["subtotal"] = subtotal

        acct = _labelled_code(
            r"(?:account\s*(?:code|no\.?)?|acct\.?\s*(?:code|no\.?)?|gl\s*(?:code|no\.?)?)",
            self.text,
        )
        if acct:
            out["account_code"] = acct

    # ── Universal supplementary fields ────────────────────────────────────

    def _extract_universal_fields(self, out: dict) -> None:
        """Fields extracted for all document types (supplements type-specific)."""
        text = self.text

        # Account code (if not already set by type-specific extractor)
        if "account_code" not in out:
            acct = _labelled_code(
                r"(?:account\s*(?:code|no\.?)?|acct\.?\s*(?:code|no\.?)?|gl\s*code|project\s*code|billing\s*code)",
                text,
            )
            if acct:
                out["account_code"] = acct

        # Cost centre
        if "cost_centre" not in out:
            cc = _labelled_code(
                r"(?:cost\s*cent(?:re|er)|department\s*code|dept\.?\s*code|budget\s*code)",
                text,
            )
            if cc:
                out["cost_centre"] = cc

        # Approved by
        if "approved_by" not in out:
            appr = _labelled_text(
                r"(?:approved\s*by|authoris(?:ed|ation)\s*(?:by)?|authorized\s*by"
                r"|authorised\s*signatory)",
                text,
            )
            if appr:
                out["approved_by"] = appr

        # M-PESA / mobile money specific
        mpesa_ref = _labelled_code(
            r"(?:m[\-\s]?pesa\s*(?:ref(?:erence)?|code|no\.?|transaction)"
            r"|mpesa\s*(?:ref(?:erence)?|code|no\.?))",
            text,
        )
        if mpesa_ref:
            out["transaction_ref"] = mpesa_ref
            if "payment_method" not in out:
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