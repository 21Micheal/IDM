"""
apps/documents/ocr/field_resolver.py

Arbitrates between regex-based extraction (DocumentFieldExtractor) and
spaCy NER hints so low-confidence NER does not overwrite precise regex hits.

Merge rules
───────────
• Each field is scored with keyword / regex / entity / confidence signals.
• Regex candidates receive a high regex-channel score by construction.
• NER candidates receive a high entity-channel score by construction.
• On a tie, regex wins over NER.

Integrity pass
──────────────
Corrects obvious cross-field contamination (e.g. a date string in supplier)
using the other source as fallback.
"""
from __future__ import annotations

import logging
import re
from dataclasses import dataclass
from typing import Dict, List, Optional

logger = logging.getLogger(__name__)

MIN_SCORE_THRESHOLD = 0.25

_AMOUNT_FIELDS = frozenset({"amount", "subtotal", "tax_amount", "contract_value"})

_DATE_FIELDS = frozenset({
    "document_date", "due_date", "effective_date", "expiry_date",
    "delivery_date", "signed_date",
})

_ENTITY_FIELDS = frozenset({"supplier"})

_REF_FIELDS = frozenset({
    "reference_number", "invoice_number", "po_number",
    "transaction_ref", "vendor_code", "account_code",
})

_HARD_VALIDATORS: dict[str, re.Pattern] = {
    "kra_pin":    re.compile(r"^[A-Z]\d{9}[A-Z]$", re.I),
    "vat_number": re.compile(r"^[A-Z0-9][A-Z0-9\-/]{3,30}$", re.I),
    "currency":   re.compile(r"^[A-Z]{3}$"),
    "amount":     re.compile(r"^\d+(?:[.,]\d+)?$"),
    "tax_amount": re.compile(r"^\d+(?:[.,]\d+)?$"),
    "subtotal":   re.compile(r"^\d+(?:[.,]\d+)?$"),
    "quantity":   re.compile(r"^\d+(?:[.,]\d+)?$"),
}

_HEADER_REJECT_RE = re.compile(
    r"^(?:supplier|vendor|account\s*code|invoice\s*(?:no|date|number)|"
    r"due\s*date|amount|total|currency|qty|quantity|description|"
    r"reference|ref|date|po\s*number|unit|uom|price|rate)$",
    re.I,
)

_ISO_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
_AMBIGUOUS_DATE_RE = re.compile(r"^\d{1,2}/\d{1,2}/\d{2}$")
_LEGAL_SUFFIX_RE = re.compile(
    r"\b(?:ltd\.?|limited|inc\.?|corp\.?|llc|plc|llp|gmbh|s\.a\.?|pty\.?)\b", re.I
)
_REF_STRUCTURE_RE = re.compile(r"[A-Z]{1,6}[-/]\w{2,}", re.I)


@dataclass
class FieldCandidate:
    value: str
    source: str  # "regex" | "ner"
    confidence: float = 1.0
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
    """Candidate with computed scores for resolve() logic."""
    raw_score: float = 1.0
    base_score: float = 0.0
    validation_bonus: float = 0.0
    total_score: float = 0.0


class FieldResolver:
    """
    Pick the best value per field from regex extraction and NER hints.
    """

    def __init__(self, admin_fields: List[str] = None, field_regex: Dict[str, str] = None):
        self.admin_fields = admin_fields or []
        self.field_regex = field_regex or {}

    def resolve(
        self,
        regex_result: dict[str, str],
        ner_result: dict[str, str],
    ) -> tuple[dict[str, str], dict[str, str]]:
        """
        Returns:
            resolved   — {field_name: value}
            source_map — {field_name: "regex"|"ner"}
        """
        all_fields: set[str] = set(regex_result) | set(ner_result)
        passthrough = {"raw_lines", "line_items", "document_type"}
        resolved: dict[str, str] = {}
        source_map: dict[str, str] = {}

        for f in all_fields:
            if f in passthrough:
                if f in regex_result:
                    resolved[f] = regex_result[f]
                    source_map[f] = "regex"
                continue

            candidates = self._build_candidates(f, regex_result, ner_result)
            if not candidates:
                continue

            best = self._select(f, candidates)
            if best is not None:
                resolved[f] = best.value
                source_map[f] = best.source

        resolved, source_map = self._integrity_pass(
            resolved, source_map, regex_result, ner_result,
        )

        return resolved, source_map

    def resolve_fields(
        self, candidates: Dict[str, List[FieldCandidate]]
    ) -> Dict[str, str]:
        """Score and select the best candidate for each field."""
        resolved_fields: dict[str, str] = {}

        for field, field_candidates in candidates.items():
            if not field_candidates:
                continue
            scored_candidates = []
            for candidate in field_candidates:
                scored = self._score_candidate(field, candidate)
                scored_candidates.append(scored)

            best_candidate = max(scored_candidates, key=lambda x: x.total_score)
            if best_candidate.total_score > MIN_SCORE_THRESHOLD:
                resolved_fields[field] = best_candidate.candidate.value

        return resolved_fields

    def _score_candidate(self, field_name: str, candidate: Candidate) -> ScoredCandidate:
        keyword_score = self._calculate_keyword_score(field_name, candidate)
        regex_score = self._calculate_regex_score(field_name, candidate)
        entity_score = self._calculate_entity_score(field_name, candidate)
        layout_score = 0.0
        confidence_score = getattr(candidate, "confidence", None) or 0.5
        if not isinstance(confidence_score, (int, float)):
            confidence_score = 0.5
        confidence_score = float(confidence_score)

        total_score = (
            keyword_score * 0.3
            + regex_score * 0.25
            + entity_score * 0.2
            + layout_score * 0.15
            + confidence_score * 0.1
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
        field_tokens = set(field.lower().split("_"))
        val_tokens = set(candidate.value.lower().split())
        return 0.4 if field_tokens & val_tokens else 0.0

    def _calculate_regex_score(self, field: str, candidate: Candidate) -> float:
        if candidate.source == "regex":
            return 1.0
        pattern = self.field_regex.get(field)
        if pattern and re.match(pattern, candidate.value, re.IGNORECASE):
            return 1.0
        return 0.0

    def _calculate_entity_score(self, field: str, candidate: Candidate) -> float:
        if candidate.source == "ner":
            return 1.0
        if not candidate.entity_type:
            return 0.0
        expected = {
            "document_date": ["DATE"],
            "supplier": ["ORG"],
            "amount": ["MONEY"],
            "reference_number": ["REF", "ID", "NUM"],
        }.get(field, [])
        return 1.0 if candidate.entity_type in expected else 0.0

    def _build_candidates(
        self,
        field_name: str,
        regex: dict[str, str],
        ner: dict[str, str],
    ) -> list[Candidate]:
        candidates: list[Candidate] = []

        for source, src_dict in (("regex", regex), ("ner", ner)):
            raw = src_dict.get(field_name)
            if not raw:
                continue
            value = str(raw).strip()
            if not value:
                continue

            if _HEADER_REJECT_RE.match(value):
                logger.debug(
                    "FieldResolver: rejected header-lookalike %r for field %r from %s",
                    value, field_name, source,
                )
                continue

            validator = _HARD_VALIDATORS.get(field_name)
            if validator and not validator.match(value):
                logger.debug(
                    "FieldResolver: hard-validation rejected %r for field %r from %s",
                    value, field_name, source,
                )
                continue

            candidates.append(Candidate(value=value, source=source, confidence=1.0))

        return candidates

    def _apply_validation_bonus(self, candidate: Candidate, field_name: str) -> None:
        v = candidate.value
        bonus = 0.0

        if field_name in _DATE_FIELDS:
            if _ISO_DATE_RE.match(v):
                bonus += 0.10
            elif _AMBIGUOUS_DATE_RE.match(v):
                bonus -= 0.05

        if field_name in _ENTITY_FIELDS:
            if _LEGAL_SUFFIX_RE.search(v):
                bonus += 0.10
            if v.isupper() and len(v) <= 5:
                bonus -= 0.10

        if field_name in _REF_FIELDS:
            if _REF_STRUCTURE_RE.search(v):
                bonus += 0.08

        if len(v) < 2:
            bonus -= 0.30

        candidate.validation_bonus = bonus

    def _select(self, field_name: str, candidates: list[Candidate]) -> Optional[Candidate]:
        for c in candidates:
            scored = self._score_candidate(field_name, c)
            c.total_score = scored.total_score
            self._apply_validation_bonus(c, field_name)
            c.total_score += c.validation_bonus

        if field_name in _AMOUNT_FIELDS:
            candidates.sort(
                key=lambda c: (round(c.total_score, 3), _safe_float(c.value)),
                reverse=True,
            )
        else:
            priority = {"regex": 1, "ner": 0}
            candidates.sort(
                key=lambda c: (round(c.total_score, 3), priority.get(c.source, 0)),
                reverse=True,
            )

        best = candidates[0]

        if best.total_score < MIN_SCORE_THRESHOLD:
            logger.debug(
                "FieldResolver: all candidates below threshold for field %r "
                "(best=%.3f from %s: %r)",
                field_name, best.total_score, best.source, best.value,
            )
            return None

        return best

    def _integrity_pass(
        self,
        resolved: dict[str, str],
        source_map: dict[str, str],
        regex: dict[str, str],
        ner: dict[str, str],
    ) -> tuple[dict[str, str], dict[str, str]]:
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
                continue

            logger.warning(
                "FieldResolver integrity: %r fails type-check for field %r (source=%s)",
                current, field_name, source_map.get(field_name, "?"),
            )

            substituted = False
            for src, src_dict in (("regex", regex), ("ner", ner)):
                alt = src_dict.get(field_name, "").strip()
                if alt and check_re.search(alt):
                    resolved[field_name] = alt
                    source_map[field_name] = src
                    logger.info(
                        "FieldResolver integrity: substituted %r=%r from %s",
                        field_name, alt, src,
                    )
                    substituted = True
                    break

            if not substituted:
                resolved.pop(field_name, None)
                source_map.pop(field_name, None)

        supplier = resolved.get("supplier", "")
        if supplier and _ISO_DATE_RE.match(supplier):
            logger.warning(
                "FieldResolver integrity: supplier %r looks like a date — correcting",
                supplier,
            )
            if "document_date" not in resolved:
                resolved["document_date"] = supplier
                source_map["document_date"] = source_map.get("supplier", "regex")
            for src, src_dict in (("regex", regex), ("ner", ner)):
                alt = src_dict.get("supplier", "").strip()
                if alt and not _ISO_DATE_RE.match(alt) and len(alt) > 3:
                    resolved["supplier"] = alt
                    source_map["supplier"] = src
                    break
            else:
                resolved.pop("supplier", None)
                source_map.pop("supplier", None)

        doc_date = resolved.get("document_date", "")
        if doc_date and not TYPE_CHECKS["document_date"].search(doc_date):
            logger.warning(
                "FieldResolver integrity: document_date %r looks like text — removing",
                doc_date,
            )
            resolved.pop("document_date", None)
            source_map.pop("document_date", None)

        return resolved, source_map


def _safe_float(value: str) -> float:
    try:
        return float(re.sub(r"[,\s]", "", value))
    except (ValueError, TypeError):
        return 0.0
