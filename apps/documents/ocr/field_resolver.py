"""
apps/documents/ocr/field_resolver.py  — v3

The Field Resolver is the arbitration layer that sits between the three
extraction sources (regex, spaCy NER, LayoutLM) and the final field dict
written to the database.

Why this exists
───────────────
The v1 implementation used sequential dict merges:
    merged = regex | ner | layoutlm
This caused two classes of bug:
  A. A low-confidence NER or LayoutLM result silently overwrote a precise
     regex hit (e.g. "INVOICE DATE" regex → "2025-01-15" being replaced
     by NER's vague "January 2025").
  B. On documents with ambiguous header grids (SUPPLIER | ACCOUNT CODE |
     DATE in a single row), all three sources produced different values for
     the same canonical field with no way to adjudicate.

Resolution strategy
─────────────────── (v3 Dynamic Scoring)
Replaces static source weights with a multi-signal scoring matrix:
  • Keyword Score (0.3)  — Proximity to field labels in OCR
  • Regex Score (0.25)   — Pattern validation
  • Entity Score (0.2)   — NER type matching
  • Layout Score (0.15)  — Spatial distance/LayoutLM signal
  • Confidence (0.1)     — Raw OCR/Model confidence

The highest total score wins if it exceeds MIN_SCORE_THRESHOLD (0.25).

Grid disambiguation for ambiguous layouts
─────────────────────────────────────────
The extractor already emits tab-separated rows for header grids. The resolver
applies a second pass that detects when a NER or regex value could plausibly
belong to a different column than the one it was assigned to, and re-runs
scoring with the LayoutLM spatial result as the tiebreaker. This is the
primary fix for "SUPPLIER → date" and "ACCOUNT CODE → supplier" misclassifications.

Usage
─────
    from apps.documents.ocr.field_resolver import FieldResolver

    resolver = FieldResolver()
    resolved, source_map = resolver.resolve(
        regex_result    = regex_suggestions,    # dict[str, str]
        ner_result      = ner_updates,          # dict[str, str]
        layoutlm_result = layoutlm_updates,     # dict[str, str]
    )
    # resolved:   {field: value}
    # source_map: {field: "regex"|"ner"|"layoutlm"}
"""
from __future__ import annotations

import logging
import re
from dataclasses import dataclass, field
from typing import Optional, List, Dict

logger = logging.getLogger(__name__)


# ─────────────────────────────────────────────────────────────────────────────
# Constants
# ─────────────────────────────────────────────────────────────────────────────

# Minimum total score below which a candidate is rejected entirely
MIN_SCORE_THRESHOLD = 0.25

# Fields where we take the LARGEST numeric value on a tie (total > line-item)
_AMOUNT_FIELDS = frozenset({"amount", "subtotal", "tax_amount", "contract_value"})

# Fields where an ISO date format is a strong positive signal
_DATE_FIELDS = frozenset({
    "document_date", "due_date", "effective_date", "expiry_date",
    "delivery_date", "signed_date",
})

# Fields where legal-entity suffixes are a positive signal
_ENTITY_FIELDS = frozenset({"supplier"})

# Fields where an alphanumeric-with-dash structure is a positive signal
_REF_FIELDS = frozenset({
    "reference_number", "invoice_number", "po_number",
    "transaction_ref", "vendor_code", "account_code",
})

# Hard validation patterns — candidates that fail these are rejected outright
_HARD_VALIDATORS: dict[str, re.Pattern] = {
    "kra_pin":    re.compile(r"^[A-Z]\d{9}[A-Z]$", re.I),
    "vat_number": re.compile(r"^[A-Z0-9][A-Z0-9\-/]{3,30}$", re.I),
    "currency":   re.compile(r"^[A-Z]{3}$"),
    "amount":     re.compile(r"^\d+(?:[.,]\d+)?$"),
    "tax_amount": re.compile(r"^\d+(?:[.,]\d+)?$"),
    "subtotal":   re.compile(r"^\d+(?:[.,]\d+)?$"),
    "quantity":   re.compile(r"^\d+(?:[.,]\d+)?$"),
}

# Values that are almost certainly column headers, not actual values —
# these appear in ambiguous grid layouts and must be rejected
_HEADER_REJECT_RE = re.compile(
    r"^(?:supplier|vendor|account\s*code|invoice\s*(?:no|date|number)|"
    r"due\s*date|amount|total|currency|qty|quantity|description|"
    r"reference|ref|date|po\s*number|unit|uom|price|rate)$",
    re.I,
)

# ISO date pattern for bonus scoring
_ISO_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")

# Ambiguous date pattern (only m/d or d/m — hard to tell which)
_AMBIGUOUS_DATE_RE = re.compile(r"^\d{1,2}/\d{1,2}/\d{2}$")

# Legal entity suffix — positive signal for supplier
_LEGAL_SUFFIX_RE = re.compile(
    r"\b(?:ltd\.?|limited|inc\.?|corp\.?|llc|plc|llp|gmbh|s\.a\.?|pty\.?)\b", re.I
)

# Alphanumeric-dash structure — positive for reference numbers
_REF_STRUCTURE_RE = re.compile(r"[A-Z]{1,6}[-/]\w{2,}", re.I)


# ─────────────────────────────────────────────────────────────────────────────
# Data class
# ─────────────────────────────────────────────────────────────────────────────

@dataclass
class FieldCandidate:
    value: str
    source: str  # "ocr", "ner", "layoutlm"
    confidence: float
    bbox: List[int] = None
    entity_type: str = None
    layout_distance: float = None

@dataclass
class ScoredCandidate:
    candidate: FieldCandidate
    keyword_score: float = 0.0
    regex_score: float = 0.0
    entity_score: float = 0.0
    layout_score: float = 0.0
    confidence_score: float = 0.0
    total_score: float = 0.0

@dataclass
class Candidate(FieldCandidate):
    """Backward compatibility wrapper for resolve() logic."""
    raw_score: float = 1.0
    base_score: float = 0.0
    validation_bonus: float = 0.0
    total_score: float = 0.0
    entity_type: str = None


# ─────────────────────────────────────────────────────────────────────────────
# FieldResolver
# ─────────────────────────────────────────────────────────────────────────────

class FieldResolver:
    """
    Arbitrates between regex, NER, and LayoutLM candidates to produce
    the final set of field values.
    """

    def __init__(self, admin_fields: List[str] = None, field_regex: Dict[str, str] = None):
        self.admin_fields = admin_fields or []
        self.field_regex = field_regex or {}

    def resolve(
        self,
        regex_result:    dict[str, str],
        ner_result:      dict[str, str],
        layoutlm_result: dict[str, str],
    ) -> tuple[dict[str, str], dict[str, str]]:
        """
        Resolve all fields from three sources.

        Returns:
            resolved   — {field_name: value}
            source_map — {field_name: "regex"|"ner"|"layoutlm"}
        """
        # Collect every field name mentioned by any source
        all_fields: set[str] = (
            set(regex_result) | set(ner_result) | set(layoutlm_result)
        )
        # Structural/auxiliary fields pass through directly from regex
        passthrough = {"raw_lines", "line_items", "document_type"}
        resolved:   dict[str, str] = {}
        source_map: dict[str, str] = {}

        for f in all_fields:
            if f in passthrough:
                if f in regex_result:
                    resolved[f]   = regex_result[f]
                    source_map[f] = "regex"
                continue

            candidates = self._build_candidates(f, regex_result, ner_result, layoutlm_result)
            if not candidates:
                continue

            best = self._select(f, candidates)
            if best is not None:
                resolved[f]   = best.value
                source_map[f] = best.source

        # Integrity pass: catch cross-field contamination from ambiguous grids
        resolved, source_map = self._integrity_pass(
            resolved, source_map,
            regex_result, ner_result, layoutlm_result,
        )

        return resolved, source_map

    def resolve_fields(
        self, candidates: Dict[str, List[FieldCandidate]]
    ) -> Dict[str, str]:
        """Score and select the best candidate for each field using dynamic scoring."""
        resolved_fields = {}

        for field, field_candidates in candidates.items():
            if not field_candidates:
                continue

            # Score all candidates for this field
            scored_candidates = []
            for candidate in field_candidates:
                scored = self._score_candidate(field, candidate)
                scored_candidates.append(scored)

            # Select the best candidate
            best_candidate = max(scored_candidates, key=lambda x: x.total_score)
            if best_candidate.total_score > MIN_SCORE_THRESHOLD:
                resolved_fields[field] = best_candidate.candidate.value

        return resolved_fields

    def _score_candidate(self, field_name: str, candidate: Candidate) -> ScoredCandidate:
        """Calculate a dynamic score for a candidate."""
        keyword_score = self._calculate_keyword_score(field_name, candidate)
        regex_score = self._calculate_regex_score(field_name, candidate)
        entity_score = self._calculate_entity_score(field_name, candidate)
        layout_score = self._calculate_layout_score(candidate)
        confidence_score = candidate.confidence if hasattr(candidate, 'confidence') else 0.5

        total_score = (
            keyword_score * 0.3 +
            regex_score * 0.25 +
            entity_score * 0.2 +
            layout_score * 0.15 +
            confidence_score * 0.1
        )

        return ScoredCandidate(
            candidate=candidate,
            keyword_score=keyword_score,
            regex_score=regex_score,
            entity_score=entity_score,
            layout_score=layout_score,
            confidence_score=confidence_score,
            total_score=total_score,
        )

    def _calculate_keyword_score(self, field: str, candidate: Candidate) -> float:
        # Example: check if candidate value contains field name token
        field_tokens = set(field.lower().split('_'))
        val_tokens = set(candidate.value.lower().split())
        return 0.4 if field_tokens & val_tokens else 0.0

    def _calculate_regex_score(self, field: str, candidate: Candidate) -> float:
        # Use your self.field_regex if provided, else return 0
        pattern = self.field_regex.get(field)
        if pattern and re.match(pattern, candidate.value, re.IGNORECASE):
            return 1.0
        return 0.0

    def _calculate_entity_score(self, field: str, candidate: Candidate) -> float:
        # Use candidate.entity_type if set
        if not candidate.entity_type:
            return 0.0
        expected = {
            "document_date": ["DATE"],
            "supplier": ["ORG"],
            "amount": ["MONEY"],
            "reference_number": ["REF", "ID", "NUM"],
        }.get(field, [])
        return 1.0 if candidate.entity_type in expected else 0.0

    def _calculate_layout_score(self, candidate: Candidate) -> float:
        # Use candidate.layout_distance if set
        if candidate.layout_distance is None:
            return 0.0
        return max(0.0, 1.0 - (candidate.layout_distance / 10.0))

    # ── Candidate construction ─────────────────────────────────────────────

    def _build_candidates(
        self,
        field_name: str,
        regex:    dict[str, str],
        ner:      dict[str, str],
        layoutlm: dict[str, str],
    ) -> list[Candidate]:
        candidates: list[Candidate] = []

        for source, src_dict in (
            ("regex",    regex),
            ("ner",      ner),
            ("layoutlm", layoutlm),
        ):
            raw = src_dict.get(field_name)
            if not raw:
                continue
            value = str(raw).strip()
            if not value:
                continue

            # Reject obvious column header values in data cells
            if _HEADER_REJECT_RE.match(value):
                logger.debug(
                    "FieldResolver: rejected header-lookalike '%s' for field '%s' from %s",
                    value, field_name, source,
                )
                continue

            # Hard validator — reject structurally invalid values
            validator = _HARD_VALIDATORS.get(field_name)
            if validator and not validator.match(value):
                logger.debug(
                    "FieldResolver: hard-validation rejected '%s' for field '%s' from %s",
                    value, field_name, source,
                )
                continue

            # LayoutLM provides its own confidence; regex/NER default to 1.0
            raw_score = 1.0
            candidates.append(Candidate(value=value, source=source, raw_score=raw_score))

        return candidates

    # ── Scoring ────────────────────────────────────────────────────────────

    def _apply_validation_bonus(self, candidate: Candidate, field_name: str) -> None:
        """Compute and set candidate.validation_bonus in place."""
        v     = candidate.value
        bonus = 0.0

        if field_name in _DATE_FIELDS:
            if _ISO_DATE_RE.match(v):
                bonus += 0.10   # ISO format is unambiguous
            elif _AMBIGUOUS_DATE_RE.match(v):
                bonus -= 0.05   # two-digit year, ambiguous order

        if field_name in _ENTITY_FIELDS:
            if _LEGAL_SUFFIX_RE.search(v):
                bonus += 0.10   # "ACME Ltd" is more likely a company than "ACME"
            if v.isupper() and len(v) <= 5:
                bonus -= 0.10   # short all-caps likely an abbreviation/code

        if field_name in _REF_FIELDS:
            if _REF_STRUCTURE_RE.search(v):
                bonus += 0.08   # "INV-2024-001" structure is a strong positive

        # Penalise very short values that are probably noise (< 2 chars)
        if len(v) < 2:
            bonus -= 0.30

        candidate.validation_bonus = bonus

    def _select(self, field_name: str, candidates: list[Candidate]) -> Optional[Candidate]:
        """Score all candidates and return the winner, or None if all fail threshold."""
        # Use dynamic scoring logic for total_score
        for c in candidates:
            scored = self._score_candidate(field_name, c)
            c.total_score = scored.total_score
            # Keep validation bonus for tie-breaking/logging if needed
            self._apply_validation_bonus(c, field_name) 

        # Amount fields: on a score tie, prefer the larger numeric value
        if field_name in _AMOUNT_FIELDS:
            candidates.sort(
                key=lambda c: (round(c.total_score, 3), _safe_float(c.value)),
                reverse=True,
            )
        else:
            # Source priority as tiebreaker: layoutlm > regex > ner
            priority = {"layoutlm": 2, "regex": 1, "ner": 0}
            candidates.sort(
                key=lambda c: (round(c.total_score, 3), priority.get(c.source, 0)),
                reverse=True,
            )

        best = candidates[0]

        if best.total_score < MIN_SCORE_THRESHOLD:
            logger.debug(
                "FieldResolver: all candidates below threshold for field '%s' "
                "(best=%.3f from %s: '%s')",
                field_name, best.total_score, best.source, best.value,
            )
            return None

        # Log when LayoutLM overrode regex — useful for diagnosing misclassifications
        regex_val = next((c.value for c in candidates if c.source == "regex"), None)
        if best.source == "layoutlm" and regex_val and regex_val != best.value:
            logger.info(
                "FieldResolver: LayoutLM overrode regex for '%s': "
                "regex='%s' → layoutlm='%s' (scores: regex=%.3f lm=%.3f)",
                field_name,
                regex_val, best.value,
                next(c.total_score for c in candidates if c.source == "regex"),
                best.total_score,
            )

        return best

    # ── Integrity pass ─────────────────────────────────────────────────────

    def _integrity_pass(
        self,
        resolved:   dict[str, str],
        source_map: dict[str, str],
        regex:    dict[str, str],
        ner:      dict[str, str],
        layoutlm: dict[str, str],
    ) -> tuple[dict[str, str], dict[str, str]]:
        """
        Detect and correct cross-field contamination from ambiguous grid layouts.

        Symptoms targeted:
          • A date value ending up in the 'supplier' field (or vice versa)
          • A numeric code in a text field
          • A company name in a date field

        Strategy: for each resolved value, check that it passes a
        field-type plausibility check.  If it fails, attempt to substitute
        the LayoutLM value (most spatially-aware), then regex, then blank.
        """
        TYPE_CHECKS: dict[str, re.Pattern] = {
            "document_date": re.compile(
                r"\d{4}[-/]\d{1,2}[-/]\d{1,2}"
                r"|\d{1,2}[/.\-]\d{1,2}[/.\-]\d{2,4}"
                r"|\b\d{1,2}\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\w*\s+\d{4}\b",
                re.I,
            ),
            "due_date": re.compile(
                r"\d{4}[-/]\d{1,2}[-/]\d{1,2}"
                r"|\d{1,2}[/.\-]\d{1,2}[/.\-]\d{2,4}",
                re.I,
            ),
            "amount":     re.compile(r"^\d[\d,.\s]*$"),
            "tax_amount": re.compile(r"^\d[\d,.\s]*$"),
            "subtotal":   re.compile(r"^\d[\d,.\s]*$"),
            "quantity":   re.compile(r"^\d+(?:[.,]\d+)?$"),
            "currency":   re.compile(r"^[A-Z]{3}$"),
            "kra_pin":    re.compile(r"^[A-Z]\d{9}[A-Z]$", re.I),
        }

        for field_name, check_re in TYPE_CHECKS.items():
            current = resolved.get(field_name)
            if not current:
                continue
            if check_re.search(current):
                continue  # passes plausibility — no action

            # Value is implausible for this field type
            logger.warning(
                "FieldResolver integrity: '%s' fails type-check for field '%s' "
                "(source=%s) — attempting substitution",
                current, field_name, source_map.get(field_name, "?"),
            )

            # Try each source in priority order
            substituted = False
            for src, src_dict in (("layoutlm", layoutlm), ("regex", regex), ("ner", ner)):
                alt = src_dict.get(field_name, "").strip()
                if alt and check_re.search(alt):
                    resolved[field_name]   = alt
                    source_map[field_name] = src
                    logger.info(
                        "FieldResolver integrity: substituted '%s'='%s' from %s",
                        field_name, alt, src,
                    )
                    substituted = True
                    break

            if not substituted:
                logger.warning(
                    "FieldResolver integrity: no valid substitute for '%s' — removing",
                    field_name,
                )
                resolved.pop(field_name, None)
                source_map.pop(field_name, None)

        # Cross-contamination: if supplier looks like a date, swap
        supplier = resolved.get("supplier", "")
        if supplier and _ISO_DATE_RE.match(supplier):
            logger.warning(
                "FieldResolver integrity: supplier '%s' looks like a date — swapping",
                supplier,
            )
            # Try to put it in document_date if empty
            if "document_date" not in resolved:
                resolved["document_date"]   = supplier
                source_map["document_date"] = source_map.get("supplier", "regex")
            # Find a real supplier from available sources
            for src, src_dict in (("layoutlm", layoutlm), ("regex", regex), ("ner", ner)):
                alt = src_dict.get("supplier", "").strip()
                if alt and not _ISO_DATE_RE.match(alt) and len(alt) > 3:
                    resolved["supplier"]   = alt
                    source_map["supplier"] = src
                    break
            else:
                resolved.pop("supplier", None)
                source_map.pop("supplier", None)

        # Cross-contamination: if document_date looks like a company name
        doc_date = resolved.get("document_date", "")
        if doc_date and not TYPE_CHECKS["document_date"].search(doc_date):
            logger.warning(
                "FieldResolver integrity: document_date '%s' looks like text — removing",
                doc_date,
            )
            resolved.pop("document_date", None)
            source_map.pop("document_date", None)

        return resolved, source_map


# ─────────────────────────────────────────────────────────────────────────────
# Helpers
# ─────────────────────────────────────────────────────────────────────────────

def _safe_float(value: str) -> float:
    """Convert a numeric string to float, returning 0.0 on failure."""
    try:
        return float(re.sub(r"[,\s]", "", value))
    except (ValueError, TypeError):
        return 0.0