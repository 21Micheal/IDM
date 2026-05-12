#!/usr/bin/env python
"""
Test the corrected pipeline architecture with proper Field Resolver.
"""
import os
import sys
import django
from pathlib import Path

# Add project root to Python path
project_root = Path(__file__).parent
sys.path.insert(0, str(project_root))

# Set up Django settings
os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'IDM.settings')
django.setup()

def test_pipeline_architecture():
    """Test the corrected pipeline components."""
    from apps.documents.ocr.field_resolver import resolve_document_fields, Candidate
    from apps.documents.ocr.layoutlm import extract_with_layoutlm, PageData
    from apps.documents.ocr.tasks_ocr import _ner_extract_entities
    from PIL import Image, ImageDraw, ImageFont
    
    print("=== Testing Corrected Pipeline Architecture ===")
    
    # Create test OCR results (simulating PaddleOCR output)
    ocr_results = [
        {
            'text': 'Invoice',
            'bbox': [50, 50, 200, 80],
            'conf': 0.99
        },
        {
            'text': 'INV-2024-001',
            'bbox': [220, 50, 400, 80],
            'conf': 0.97
        },
        {
            'text': 'Date:',
            'bbox': [50, 120, 120, 150],
            'conf': 0.95
        },
        {
            'text': '2024-05-11',
            'bbox': [130, 120, 280, 150],
            'conf': 0.96
        },
        {
            'text': 'Total:',
            'bbox': [50, 200, 120, 230],
            'conf': 0.98
        },
        {
            'text': '$1,234.56',
            'bbox': [130, 200, 280, 230],
            'conf': 0.94
        },
        {
            'text': 'Supplier:',
            'bbox': [50, 270, 140, 300],
            'conf': 0.95
        },
        {
            'text': 'Test Company Ltd',
            'bbox': [150, 270, 350, 300],
            'conf': 0.93
        },
    ]
    
    # Test NER extraction
    print("\n1. Testing NER Entity Extraction...")
    text = " ".join([item['text'] for item in ocr_results])
    ner_entities = _ner_extract_entities(text)
    print(f"   NER entities: {ner_entities}")
    
    # Test LayoutLM with proper input
    print("\n2. Testing LayoutLM with Proper Bounding Boxes...")
    try:
        # Create test image
        img = Image.new('RGB', (800, 600), color='white')
        draw = ImageDraw.Draw(img)
        
        try:
            font = ImageFont.load_default()
        except:
            font = None
            
        # Draw text on image
        for i, item in enumerate(ocr_results):
            x, y = item['bbox'][0], item['bbox'][1]
            draw.text((x, y), item['text'], fill='black', font=font)
        
        # Create PageData with proper word format for LayoutLM
        words = []
        for item in ocr_results:
            bbox = item['bbox']
            words.append({
                'text': item['text'],
                'left': bbox[0],
                'top': bbox[1],
                'right': bbox[2],
                'bottom': bbox[3],
                'width': bbox[2] - bbox[0],
                'height': bbox[3] - bbox[1],
                'conf': item['conf'] * 100
            })
        
        page_data = PageData(image=img, words=words)
        
        # Run LayoutLM
        layout_predictions = extract_with_layoutlm([page_data], doc_type="invoice")
        print(f"   LayoutLM predictions: {layout_predictions}")
        
    except Exception as e:
        print(f"   LayoutLM failed: {e}")
        layout_predictions = {}
    
    # Test Field Resolution (final stage)
    print("\n3. Testing Field Resolution...")
    resolved_fields = resolve_document_fields(
        ocr_results=ocr_results,
        ner_entities=ner_entities,
        layout_predictions=layout_predictions
    )
    
    print(f"\n   Resolved Fields: {resolved_fields}")
    
    # Analyze results
    print("\n=== Pipeline Analysis ===")
    expected_fields = {
        'invoice_number': 'INV-2024-001',
        'document_date': '2024-05-11',
        'amount': '$1,234.56',
        'supplier': 'Test Company Ltd'
    }
    
    print("\nExpected vs Actual:")
    for field, expected_value in expected_fields.items():
        actual_value = resolved_fields.get(field, 'NOT FOUND')
        status = "✅" if actual_value == expected_value else "❌"
        print(f"   {status} {field}: '{actual_value}' (expected: '{expected_value}')")
    
    # Test candidate scoring
    print("\n=== Candidate Scoring Analysis ===")
    from apps.documents.ocr.field_resolver import FieldResolver
    
    resolver = FieldResolver(['invoice_number', 'document_date', 'amount', 'supplier'])
    candidates = resolver._generate_candidates(ocr_results, ner_entities, layout_predictions)
    
    for field, candidate_list in candidates.items():
        if candidate_list:
            print(f"\n   {field} candidates:")
            for i, candidate in enumerate(candidate_list):
                print(f"     {i+1}. '{candidate.value}' (score: {candidate.total_score:.3f})")
                print(f"        keyword: {candidate.keyword_score:.2f}, ner: {candidate.ner_score:.2f}")
                print(f"        layout: {candidate.layout_score:.2f}, regex: {candidate.regex_score:.2f}")
                print(f"        conf: {candidate.confidence_score:.2f}, source: {candidate.source}")

def test_compact_header_grid_variations():
    """Regression tests for multiple compact header grid layouts."""
    from apps.documents.ocr.extractor import DocumentFieldExtractor

    variations = [
        (
            'ACCOUNT CODE\tSUPPLIER ID\tDATE ISSUED\tDUE DATE\n'
            'NET-OPS-88\tSUPP-CCS-99\tOct 25, 2024\tNov 24, 2024'
        ),
        (
            'SUPPLIER ID\tACCOUNT CODE\tDATE ISSUED\tDUE DATE\n'
            'SUPP-CCS-99\tNET-OPS-88\tOct 25, 2024\tNov 24, 2024'
        ),
        (
            'SUPPLIER\tACCOUNT CODE\tINVOICE DATE\tDUE DATE\n'
            'Apex Solutions Ltd\tNET-OPS-88\tMay 8, 2026\tJun 7, 2026'
        ),
    ]

    for sample_text in variations:
        extractor = DocumentFieldExtractor(sample_text)
        result = extractor.extract()

        print("\n=== Compact Header Grid Regression Test ===")
        print(result)

        assert result.get('supplier') in {'SUPP-CCS-99', 'Apex Solutions Ltd'}, (
            f"expected supplier in compact grid, got {result.get('supplier')}"
        )
        assert result.get('account_code') == 'NET-OPS-88', (
            f"expected account_code NET-OPS-88, got {result.get('account_code')}"
        )
        assert result.get('document_date') in {'2024-05-08', '2024-10-25'}, (
            f"expected valid document_date, got {result.get('document_date')}"
        )
        assert result.get('due_date') in {'2024-06-07', '2024-11-24'}, (
            f"expected valid due_date, got {result.get('due_date')}"
        )


def test_amount_extraction_with_thousands_separator():
    """Ensure amount extraction handles KES totals with thousands separators."""
    from apps.documents.ocr.extractor import _best_amount

    sample_text = (
        'Subtotal: KES 75,700.00\n'
        'VAT (16%): KES 12,112.00\n'
        'Total Amount: KES 87,812.00\n'
        'Payment Instructions: Net 30 days. Please include INV-2026-0508 with your transfer.'
    )

    amount, currency = _best_amount(sample_text)
    print('\n=== Amount Extraction Regression Test ===')
    print('amount=', amount, 'currency=', currency)

    assert amount == '87812.0', f"expected 87812.0, got {amount}"
    assert currency == 'KES', f"expected currency KES, got {currency}"


def test_configuration():
    """Test current configuration."""
    from django.conf import settings
    
    print("\n=== Configuration Check ===")
    print(f"OCR_ENGINE: {getattr(settings, 'OCR_ENGINE', 'NOT SET')}")
    print(f"LAYOUTLMV3_ENABLED: {getattr(settings, 'LAYOUTLMV3_ENABLED', 'NOT SET')}")
    print(f"OCR_SPACY_ENABLED: {getattr(settings, 'OCR_SPACY_ENABLED', 'NOT SET')}")
    print(f"LAYOUTLMV3_CONFIDENCE: {getattr(settings, 'LAYOUTLMV3_CONFIDENCE', 'NOT SET')}")
    print(f"LAYOUTLMV3_OVERRIDE_REGEX: {getattr(settings, 'LAYOUTLMV3_OVERRIDE_REGEX', 'NOT SET')}")

if __name__ == "__main__":
    test_configuration()
    test_compact_header_grid_extraction()
    test_pipeline_architecture()
