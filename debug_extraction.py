#!/usr/bin/env python3

import re
import sys
sys.path.append('/home/michael/Projects/IDM')

# Test with the actual problematic OCR text from the database
sample_text = """Nexa Hardware.\tPAyMent PEndING
PAYMENT DUE
StNmit1E2nstruction Ltd #NX-88291-B\tMay 22, 2026
Issued: May 08, 2026\tTerms: 14 Days
Westlands, Nairobi
ITEm DESCRIPTION\tSKU QTY\tRATE Amount
High-Tensile Steel Bolts (12mm)\tHTB-12-00 500\t45.00 22,500.00
Industrial Grade Safety Helmets\tPPE-HELM-Y 25 1,200.00 30,000.00
Reinforced Concrete Drill Bit Set\tDB-RC-SET 10 3,500.00 35,000.00
Heavy Duty Measuring Tape (10m). MT-1OM-HD 15 850.00 12,750.00
Tax (9AT'16%)\t00} 250}0(
16,040:00
Balance Due KES 116,290.00
Note: Goods remains the property of Nexa Hardware until fully paid for. Please use NX-88291-B as
the reference for M-Pesa or Bank transfers.."""

# Import the actual patterns from extractor
try:
    from apps.documents.ocr.extractor import (
        _SUPPLIER_INLINE_RE, _SUPPLIER_HEADER_RE, _SUPPLIER_REJECT_RE,
        _ENTITY_SUFFIX_RE, _extract_supplier, _clean_inline_value
    )
    
    print("=== PATTERNS LOADED ===")
    print(f"_SUPPLIER_INLINE_RE: {_SUPPLIER_INLINE_RE.pattern}")
    
    lines = [ln.strip() for ln in sample_text.splitlines() if ln.strip()]
    
    print("\n=== TESTING INLINE PATTERN ===")
    for line in lines:
        m = _SUPPLIER_INLINE_RE.search(line)
        if m:
            print(f"MATCH: '{line}' -> '{m.group(1)}'")
            cleaned = _clean_inline_value(m.group(1))
            print(f"CLEANED: '{cleaned}'")
        else:
            print(f"NO MATCH: '{line}'")
    
    print("\n=== TESTING FULL EXTRACTOR ===")
    result = _extract_supplier(lines)
    print(f"FINAL SUPPLIER RESULT: '{result}'")
    
    # Test title extraction
    try:
        from apps.documents.ocr.extractor import _extract_title, DocumentFieldExtractor
        
        print("\n=== TESTING TITLE EXTRACTION ===")
        extractor = DocumentFieldExtractor(sample_text)
        title = _extract_title(lines, "Invoice", supplier=result, reference="INV-2026-001")
        print(f"TITLE RESULT: '{title}'")
        
        print("\n=== TESTING FULL EXTRACTOR ===")
        full_result = extractor.extract()
        print("FULL EXTRACTION RESULTS:")
        for key, value in full_result.items():
            print(f"  {key}: '{value}'")
            
    except Exception as e:
        print(f"Title extraction failed: {e}")
    
except ImportError as e:
    print(f"Import failed: {e}")
    print("Testing with local patterns...")
    
    # Local test patterns
    _SUPPLIER_INLINE_RE = re.compile(
        r"(?:vendor|supplier|service\s*provider|sold\s*by|issued\s*by"
        r"|vendor\s*name|supplier\s*name|company\s*name|payee\s*name"
        r"|billed?\s*(?:from|by)|business\s*name)"   
        r"\s*[:\-]\s*(.+)",
        re.I,
    )
    
    lines = [ln.strip() for ln in sample_text.splitlines() if ln.strip()]
    
    for line in lines:
        m = _SUPPLIER_INLINE_RE.search(line)
        if m:
            print(f"MATCH: '{line}' -> '{m.group(1)}'")
