#!/usr/bin/env python
"""
Test script to verify LayoutLM-only configuration works correctly.
This script tests the new OCR pipeline without running full Django.
"""
import os
import sys
import django
from pathlib import Path

# Add the project root to Python path
project_root = Path(__file__).parent
sys.path.insert(0, str(project_root))

# Set up Django settings
os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'IDM.settings')
django.setup()

def test_layoutlm_only_config():
    """Test that LayoutLM-only configuration is properly set."""
    from django.conf import settings
    
    print("=== LayoutLM-Only Configuration Test ===")
    print(f"OCR_ENGINE: {getattr(settings, 'OCR_ENGINE', 'NOT SET')}")
    print(f"LAYOUTLMV3_ENABLED: {getattr(settings, 'LAYOUTLMV3_ENABLED', 'NOT SET')}")
    print(f"LAYOUTLMV3_OVERRIDE_REGEX: {getattr(settings, 'LAYOUTLMV3_OVERRIDE_REGEX', 'NOT SET')}")
    print(f"OCR_SPACY_ENABLED: {getattr(settings, 'OCR_SPACY_ENABLED', 'NOT SET')}")
    print(f"LAYOUTLMV3_CONFIDENCE: {getattr(settings, 'LAYOUTLMV3_CONFIDENCE', 'NOT SET')}")
    print(f"LAYOUTLMV3_MAX_LENGTH: {getattr(settings, 'LAYOUTLMV3_MAX_LENGTH', 'NOT SET')}")
    
    # Verify LayoutLM-only mode is configured
    engine = getattr(settings, 'OCR_ENGINE', '').lower()
    layoutlm_enabled = getattr(settings, 'LAYOUTLMV3_ENABLED', False)
    spacy_disabled = not getattr(settings, 'OCR_SPACY_ENABLED', True)
    layoutlm_override = getattr(settings, 'LAYOUTLMV3_OVERRIDE_REGEX', False)
    
    success = (
        engine == 'layoutlm_only' and
        layoutlm_enabled and
        spacy_disabled and
        layoutlm_override
    )
    
    if success:
        print("\n✅ LayoutLM-only mode is properly configured!")
        print("   - PaddleOCR/Tesseract disabled")
        print("   - spaCy NER disabled") 
        print("   - LayoutLM enabled with override")
        print("   - Ready for testing")
    else:
        print("\n❌ Configuration issues detected:")
        if engine != 'layoutlm_only':
            print(f"   - OCR_ENGINE should be 'layoutlm_only', got '{engine}'")
        if not layoutlm_enabled:
            print("   - LAYOUTLMV3_ENABLED should be True")
        if not spacy_disabled:
            print("   - OCR_SPACY_ENABLED should be False")
        if not layoutlm_override:
            print("   - LAYOUTLMV3_OVERRIDE_REGEX should be True")
    
    return success

def test_layoutlm_import():
    """Test that LayoutLM can be imported and initialized."""
    try:
        from apps.documents.ocr.layoutlm import _get_layoutlm_extractor
        extractor = _get_layoutlm_extractor()
        
        if extractor:
            print("✅ LayoutLM extractor initialized successfully")
            return True
        else:
            print("❌ LayoutLM extractor failed to initialize")
            return False
    except Exception as e:
        print(f"❌ LayoutLM import/initialization failed: {e}")
        return False

def test_layoutlm_only_function():
    """Test the new _ocr_layoutlm_only function."""
    try:
        from apps.documents.ocr.tasks_ocr import _ocr_layoutlm_only
        print("✅ _ocr_layoutlm_only function imported successfully")
        return True
    except Exception as e:
        print(f"❌ Failed to import _ocr_layoutlm_only: {e}")
        return False

if __name__ == "__main__":
    print("Testing LayoutLM-only OCR configuration...\n")
    
    config_ok = test_layoutlm_only_config()
    import_ok = test_layoutlm_import()
    function_ok = test_layoutlm_only_function()
    
    if config_ok and import_ok and function_ok:
        print("\n🎉 All tests passed! LayoutLM-only mode is ready.")
        print("\nTo test with a real document:")
        print("1. Upload a document through the web interface")
        print("2. Check the OCR processing logs")
        print("3. Verify metadata contains LayoutLM-extracted fields")
        print("4. Compare results with previous OCR outputs")
    else:
        print("\n⚠️  Some tests failed. Check the configuration above.")
        sys.exit(1)
