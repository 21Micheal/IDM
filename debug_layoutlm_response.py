#!/usr/bin/env python
"""
Debug script to analyze LayoutLM response and identify issues.
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

def debug_layoutlm_processing():
    """Debug LayoutLM processing with a sample document."""
    from apps.documents.ocr.layoutlm import extract_with_layoutlm, PageData
    from apps.documents.ocr.tasks_ocr import _rasterise
    from apps.documents.models import Document
    from PIL import Image
    import numpy as np
    
    print("=== LayoutLM Debug Analysis ===")
    
    # Get a recent document for testing
    try:
        doc = Document.objects.filter(ocr_status='DONE').first()
        if not doc:
            print("❌ No processed documents found for debugging")
            return
        print(f"📄 Testing with document: {doc.id}")
        print(f"   File: {doc.file.path}")
        print(f"   MIME: {doc.file_mime_type}")
    except Exception as e:
        print(f"❌ Error accessing documents: {e}")
        return
    
    try:
        # Rasterize the document
        dpi = 300
        mime = doc.file_mime_type or ""
        file_path = doc.file.path
        pil_pages = _rasterise(file_path, mime, dpi)
        
        if not pil_pages:
            print("❌ Failed to rasterize document")
            return
        
        print(f"📄 Rasterized {len(pil_pages)} pages")
        
        # Create PageData for LayoutLM
        pages_data = []
        for i, pil_img in enumerate(pil_pages):
            # Create dummy words (as in layoutlm_only mode)
            width, height = pil_img.size
            dummy_words = [{
                "text": "",
                "left": 0,
                "top": 0,
                "right": width,
                "bottom": height,
                "width": width,
                "height": height,
                "conf": 100.0,
            }]
            
            page_data = PageData(
                image=pil_img.convert("RGB"),
                words=dummy_words
            )
            pages_data.append(page_data)
            print(f"   Page {i+1}: {width}x{height}")
        
        # Run LayoutLM extraction
        print("\n🤖 Running LayoutLM extraction...")
        try:
            results = extract_with_layoutlm(pages_data, doc_type="general")
            print("✅ LayoutLM extraction completed")
            print(f"📊 Results: {results}")
            
            # Analyze results
            if not results:
                print("❌ LayoutLM returned empty results")
                return
            
            print("\n📋 Field Analysis:")
            for field, value in results.items():
                if value:
                    print(f"   {field}: {value}")
                else:
                    print(f"   {field}: [EMPTY]")
            
            # Check confidence scores if available
            if isinstance(results, dict) and any(isinstance(v, dict) and 'confidence' in v for v in results.values()):
                print("\n📈 Confidence Analysis:")
                for field, value in results.items():
                    if isinstance(value, dict) and 'confidence' in value:
                        print(f"   {field}: {value['confidence']:.2f}")
            
        except Exception as e:
            print(f"❌ LayoutLM extraction failed: {e}")
            import traceback
            traceback.print_exc()
        
    except Exception as e:
        print(f"❌ Error during processing: {e}")
        import traceback
        traceback.print_exc()

def check_layoutlm_model():
    """Check LayoutLM model and configuration."""
    try:
        from apps.documents.ocr.layoutlm import _get_layoutlm_extractor
        from django.conf import settings
        
        print("=== LayoutLM Model Check ===")
        print(f"Model: {getattr(settings, 'LAYOUTLMV3_MODEL', 'NOT SET')}")
        print(f"Device: {getattr(settings, 'LAYOUTLMV3_DEVICE', 'NOT SET')}")
        print(f"Confidence: {getattr(settings, 'LAYOUTLMV3_CONFIDENCE', 'NOT SET')}")
        print(f"Max Length: {getattr(settings, 'LAYOUTLMV3_MAX_LENGTH', 'NOT SET')}")
        
        extractor = _get_layoutlm_extractor()
        if extractor:
            print("✅ LayoutLM extractor initialized")
            if hasattr(extractor, 'model'):
                print(f"   Model type: {type(extractor.model)}")
            if hasattr(extractor, 'tokenizer'):
                print(f"   Tokenizer type: {type(extractor.tokenizer)}")
        else:
            print("❌ LayoutLM extractor failed to initialize")
            
    except Exception as e:
        print(f"❌ Error checking LayoutLM model: {e}")

if __name__ == "__main__":
    check_layoutlm_model()
    print()
    debug_layoutlm_processing()
