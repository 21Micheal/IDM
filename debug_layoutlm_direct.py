#!/usr/bin/env python
"""
Debug LayoutLM directly without API authentication.
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

def debug_layoutlm_directly():
    """Debug LayoutLM by running it directly on a sample image."""
    from apps.documents.ocr.layoutlm import extract_with_layoutlm, PageData
    from PIL import Image
    import numpy as np
    
    print("=== Direct LayoutLM Debug ===")
    
    # Create a simple test image with some text
    try:
        # Try to find a document image in media
        media_path = Path("/home/michael/Projects/IDM/media")
        if media_path.exists():
            image_files = list(media_path.glob("**/*.png")) + list(media_path.glob("**/*.jpg"))
            if image_files:
                img_path = image_files[0]
                print(f"Using image: {img_path}")
                img = Image.open(img_path).convert("RGB")
            else:
                print("No images found in media, creating test image...")
                # Create a simple test image
                from PIL import ImageDraw, ImageFont
                img = Image.new('RGB', (800, 600), color='white')
                draw = ImageDraw.Draw(img)
                
                # Add some text that LayoutLM should recognize
                try:
                    font = ImageFont.load_default()
                except:
                    font = None
                
                draw.text((50, 50), "INVOICE", fill='black', font=font)
                draw.text((50, 100), "Invoice Number: INV-2024-001", fill='black', font=font)
                draw.text((50, 150), "Date: 2024-05-11", fill='black', font=font)
                draw.text((50, 200), "Total: $1,234.56", fill='black', font=font)
                draw.text((50, 250), "Supplier: Test Company Ltd", fill='black', font=font)
        else:
            print("Media directory doesn't exist, creating test image...")
            from PIL import ImageDraw, ImageFont
            img = Image.new('RGB', (800, 600), color='white')
            draw = ImageDraw.Draw(img)
            
            try:
                font = ImageFont.load_default()
            except:
                font = None
                
            draw.text((50, 50), "INVOICE", fill='black', font=font)
            draw.text((50, 100), "Invoice Number: INV-2024-001", fill='black', font=font)
            draw.text((50, 150), "Date: 2024-05-11", fill='black', font=font)
            draw.text((50, 200), "Total: $1,234.56", fill='black', font=font)
            draw.text((50, 250), "Supplier: Test Company Ltd", fill='black', font=font)
        
        # Create PageData with some basic word regions
        width, height = img.size
        words = [
            {
                "text": "INVOICE",
                "left": 50,
                "top": 50,
                "right": 200,
                "bottom": 80,
                "width": 150,
                "height": 30,
                "conf": 95.0,
            },
            {
                "text": "INV-2024-001",
                "left": 200,
                "top": 100,
                "right": 350,
                "bottom": 130,
                "width": 150,
                "height": 30,
                "conf": 95.0,
            },
            {
                "text": "2024-05-11",
                "left": 150,
                "top": 150,
                "right": 250,
                "bottom": 180,
                "width": 100,
                "height": 30,
                "conf": 95.0,
            },
            {
                "text": "$1,234.56",
                "left": 150,
                "top": 200,
                "right": 280,
                "bottom": 230,
                "width": 130,
                "height": 30,
                "conf": 95.0,
            },
            {
                "text": "Test Company Ltd",
                "left": 150,
                "top": 250,
                "right": 350,
                "bottom": 280,
                "width": 200,
                "height": 30,
                "conf": 95.0,
            },
        ]
        
        page_data = PageData(image=img, words=words)
        
        print(f"Image size: {width}x{height}")
        print(f"Words provided: {len(words)}")
        
        # Run LayoutLM extraction
        print("\n🤖 Running LayoutLM extraction...")
        try:
            results = extract_with_layoutlm([page_data], doc_type="invoice")
            print("✅ LayoutLM extraction completed")
            print(f"📊 Results: {results}")
            
            # Analyze results
            if not results:
                print("❌ LayoutLM returned empty results - this is the problem!")
                return
            
            print(f"\n📋 Found {len(results)} fields:")
            for field, value in results.items():
                if hasattr(value, 'value'):
                    print(f"   {field}: {value.value} (conf: {value.confidence})")
                else:
                    print(f"   {field}: {value}")
            
        except Exception as e:
            print(f"❌ LayoutLM extraction failed: {e}")
            import traceback
            traceback.print_exc()
        
    except Exception as e:
        print(f"❌ Error creating test: {e}")
        import traceback
        traceback.print_exc()

def check_layoutlm_settings():
    """Check current LayoutLM settings."""
    from django.conf import settings
    
    print("=== LayoutLM Settings Check ===")
    print(f"LAYOUTLMV3_ENABLED: {getattr(settings, 'LAYOUTLMV3_ENABLED', 'NOT SET')}")
    print(f"LAYOUTLMV3_MODEL: {getattr(settings, 'LAYOUTLMV3_MODEL', 'NOT SET')}")
    print(f"LAYOUTLMV3_DEVICE: {getattr(settings, 'LAYOUTLMV3_DEVICE', 'NOT SET')}")
    print(f"LAYOUTLMV3_CONFIDENCE: {getattr(settings, 'LAYOUTLMV3_CONFIDENCE', 'NOT SET')}")
    print(f"LAYOUTLMV3_MAX_LENGTH: {getattr(settings, 'LAYOUTLMV3_MAX_LENGTH', 'NOT SET')}")
    print(f"LAYOUTLMV3_OVERRIDE_REGEX: {getattr(settings, 'LAYOUTLMV3_OVERRIDE_REGEX', 'NOT SET')}")
    print(f"OCR_ENGINE: {getattr(settings, 'OCR_ENGINE', 'NOT SET')}")

if __name__ == "__main__":
    check_layoutlm_settings()
    print()
    debug_layoutlm_directly()
