"""
apps/documents/ocr/field_resolver.py

Field Resolver - The final stage that fills forms.

This is the missing brain that coordinates OCR, NER, and LayoutLM outputs
to produce the final field values.

Pipeline:
OCR → NER/LayoutLM → candidate generation → field resolver → form filling
"""

import logging
import re
from typing import Dict, List, Any, Optional
from dataclasses import dataclass

logger = logging.getLogger(__name__)


@dataclass
class Candidate:
    """A candidate value for a field with multiple confidence signals."""
    value: str
    keyword_score: float = 0.0
    ner_score: float = 0.0
    layout_score: float = 0.0
    regex_score: float = 0.0
    confidence_score: float = 0.0
    source: str = "unknown"
    
    @property
    def total_score(self) -> float:
        """Calculate total weighted score."""
        return (
            self.keyword_score * 0.3 +
            self.ner_score * 0.2 +
            self.layout_score * 0.25 +
            self.regex_score * 0.15 +
            self.confidence_score * 0.1
        )


class FieldResolver:
    """
    Resolves field values from multiple signal sources.
    
    This is the only component that should fill forms.
    """
    
    def __init__(self, field_schema: List[str]):
        self.field_schema = field_schema
        self._compile_patterns()
    
    def _compile_patterns(self):
        """Pre-compile regex patterns for validation."""
        self.patterns = {
            'invoice_number': [
                re.compile(r'INV-\d+', re.IGNORECASE),
                re.compile(r'Invoice\s*#?\s*([A-Z0-9-]+)', re.IGNORECASE),
                re.compile(r'[A-Z]{2,4}-\d{4,}', re.IGNORECASE),
            ],
            'reference_number': [
                re.compile(r'REF-\d+', re.IGNORECASE),
                re.compile(r'Reference\s*#?\s*([A-Z0-9-]+)', re.IGNORECASE),
                re.compile(r'[A-Z]{2,4}-\d{4,}', re.IGNORECASE),
            ],
            'document_date': [
                re.compile(r'\d{4}-\d{2}-\d{2}'),
                re.compile(r'\d{2}/\d{2}/\d{4}'),
                re.compile(r'\d{1,2}\s+\w{3,9}\s+\d{4}', re.IGNORECASE),
            ],
            'due_date': [
                re.compile(r'Due\s*:?\s*(\d{4}-\d{2}-\d{2})', re.IGNORECASE),
                re.compile(r'Due\s+Date\s*:?\s*(\d{4}-\d{2}-\d{2})', re.IGNORECASE),
            ],
            'amount': [
                re.compile(r'\$\s*\d{1,3}(?:,\d{3})*(?:\.\d{2})?'),
                re.compile(r'USD\s*\d{1,3}(?:,\d{3})*(?:\.\d{2})?'),
                re.compile(r'Total\s*:?\s*\$?(\d{1,3}(?:,\d{3})*(?:\.\d{2})?)', re.IGNORECASE),
            ],
            'supplier': [
                re.compile(r'[A-Z\s&]+(?:LTD|LIMITED|INC|CORP|LLC)', re.IGNORECASE),
                re.compile(r'From\s*:?\s*([A-Z\s&]+(?:LTD|LIMITED|INC|CORP|LLC))', re.IGNORECASE),
            ],
        }
    
    def resolve_fields(self, 
                   ocr_results: List[Dict], 
                   ner_entities: Dict[str, List[str]], 
                   layout_predictions: Dict[str, Any]) -> Dict[str, str]:
        """
        Main resolution method - generates candidates and selects best values.
        
        Args:
            ocr_results: List of OCR word results with text, bbox, confidence
            ner_entities: NER classified entities by type
            layout_predictions: LayoutLM field predictions
            
        Returns:
            Dictionary of resolved field values
        """
        candidates = self._generate_candidates(ocr_results, ner_entities, layout_predictions)
        resolved = self._select_best_candidates(candidates)
        
        return resolved
    
    def _generate_candidates(self, 
                          ocr_results: List[Dict], 
                          ner_entities: Dict[str, List[str]], 
                          layout_predictions: Dict[str, Any]) -> Dict[str, List[Candidate]]:
        """Generate candidates for each field from all sources."""
        candidates = {field: [] for field in self.field_schema}
        
        # Generate from OCR + keywords
        self._generate_ocr_candidates(ocr_results, candidates)
        
        # Generate from NER
        self._generate_ner_candidates(ner_entities, candidates)
        
        # Generate from LayoutLM
        self._generate_layout_candidates(layout_predictions, candidates)
        
        return candidates
    
    def _generate_ocr_candidates(self, ocr_results: List[Dict], candidates: Dict[str, List[Candidate]]):
        """Generate candidates from OCR text using keyword proximity."""
        # Build text with positions for proximity analysis
        full_text = " ".join([w.get('text', '') for w in ocr_results])
        
        # Find keyword positions
        keyword_positions = {}
        for i, word in enumerate(ocr_results):
            text = word.get('text', '').lower()
            
            # Check for field keywords
            if any(kw in text for kw in ['invoice', 'inv#', 'invoice #']):
                keyword_positions['invoice_number'] = i
            elif any(kw in text for kw in ['reference', 'ref#', 'reference #']):
                keyword_positions['reference_number'] = i
            elif any(kw in text for kw in ['date', 'dated']):
                keyword_positions['document_date'] = i
            elif any(kw in text for kw in ['due', 'payment due']):
                keyword_positions['due_date'] = i
            elif any(kw in text for kw in ['total', 'amount', 'sum']):
                keyword_positions['amount'] = i
            elif any(kw in text for kw in ['from', 'supplier', 'vendor', 'company']):
                keyword_positions['supplier'] = i
        
        # Generate candidates near keywords
        for field, keyword_idx in keyword_positions.items():
            if field not in self.field_schema:
                continue
                
            # Look for values near keyword (within 5 words)
            for j in range(max(0, keyword_idx - 2), min(len(ocr_results), keyword_idx + 6)):
                word = ocr_results[j]
                if self._is_candidate_value(word.get('text', ''), field):
                    candidate = Candidate(
                        value=word.get('text', ''),
                        keyword_score=1.0 if abs(j - keyword_idx) <= 2 else 0.5,
                        confidence_score=word.get('conf', 0.0) / 100.0,
                        source='ocr_keyword'
                    )
                    candidates[field].append(candidate)
    
    def _generate_ner_candidates(self, ner_entities: Dict[str, List[str]], candidates: Dict[str, List[Candidate]]):
        """Generate candidates from NER entities."""
        # Map NER types to our fields
        ner_mapping = {
            'ORG': ['supplier'],
            'DATE': ['document_date', 'due_date'],
            'MONEY': ['amount'],
        }
        
        for ner_type, values in ner_entities.items():
            if ner_type not in ner_mapping:
                continue
                
            target_fields = ner_mapping[ner_type]
            for value in values:
                for field in target_fields:
                    if field not in self.field_schema:
                        continue
                        
                    candidate = Candidate(
                        value=value,
                        ner_score=1.0,
                        source='ner'
                    )
                    candidates[field].append(candidate)
    
    def _generate_layout_candidates(self, layout_predictions: Dict[str, Any], candidates: Dict[str, List[Candidate]]):
        """Generate candidates from LayoutLM predictions."""
        for field, prediction in layout_predictions.items():
            if field not in self.field_schema:
                continue
                
            # Handle both direct value and Entity objects
            if hasattr(prediction, 'value'):
                value = prediction.value
                confidence = prediction.confidence
            else:
                value = str(prediction)
                confidence = 0.8  # Default confidence for LayoutLM
                
            candidate = Candidate(
                value=value,
                layout_score=confidence,
                source='layoutlm'
            )
            candidates[field].append(candidate)
    
    def _is_candidate_value(self, text: str, field: str) -> bool:
        """Check if text could be a value for the given field."""
        text = text.strip()
        if not text or len(text) < 2:
            return False
        
        # Skip keywords
        keywords = ['invoice', 'reference', 'date', 'due', 'total', 'amount', 'from', 'supplier']
        if text.lower() in keywords:
            return False
        
        # Field-specific validation
        if field in ['invoice_number', 'reference_number']:
            return bool(re.search(r'[A-Z0-9-]', text))
        elif field in ['document_date', 'due_date']:
            return bool(re.search(r'\d{4}|\d{2}/\d{2}', text))
        elif field == 'amount':
            return bool(re.search(r'\$|\d+|\d+\.\d+', text))
        elif field == 'supplier':
            return len(text) > 3 and text[0].isupper()
        
        return True
    
    def _select_best_candidates(self, candidates: Dict[str, List[Candidate]]) -> Dict[str, str]:
        """Select best candidate for each field based on total score."""
        resolved = {}
        
        for field, candidate_list in candidates.items():
            if not candidate_list:
                continue
            
            # Calculate regex scores
            for candidate in candidate_list:
                candidate.regex_score = self._calculate_regex_score(candidate.value, field)
            
            # Select best candidate
            best_candidate = max(candidate_list, key=lambda x: x.total_score)
            
            # Only use if score is reasonable
            if best_candidate.total_score > 0.3:
                resolved[field] = best_candidate.value
                logger.debug(
                    "Field %s resolved to '%s' (score: %.3f, source: %s)",
                    field, best_candidate.value, best_candidate.total_score, best_candidate.source
                )
        
        return resolved
    
    def _calculate_regex_score(self, value: str, field: str) -> float:
        """Calculate regex validation score."""
        if field not in self.patterns:
            return 0.0
        
        for pattern in self.patterns[field]:
            if pattern.search(value):
                return 1.0
        
        return 0.0


def resolve_document_fields(ocr_results: List[Dict], 
                        ner_entities: Dict[str, List[str]], 
                        layout_predictions: Dict[str, Any],
                        field_schema: Optional[List[str]] = None) -> Dict[str, str]:
    """
    Convenience function to resolve document fields.
    
    This is the main entry point that should be used instead of direct field assignment.
    """
    if field_schema is None:
        field_schema = [
            'invoice_number', 'reference_number', 'document_date', 'due_date',
            'amount', 'supplier', 'currency', 'tax_amount'
        ]
    
    resolver = FieldResolver(field_schema)
    return resolver.resolve_fields(ocr_results, ner_entities, layout_predictions)
