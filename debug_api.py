#!/usr/bin/env python3
"""
Debug the OCR suggestions API to see what's actually being returned
"""
import os
import sys
import django

# Set up Django
os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'IDM.settings')
django.setup()

from apps.documents.models import Document

def debug_ocr_api(document_id):
    """Debug what the OCR API would return for a specific document"""
    try:
        doc = Document.objects.get(id=document_id)
        print(f"=== DEBUGGING DOCUMENT: {doc.title} (ID: {doc.id}) ===")
        print(f"OCR Status: {doc.ocr_status}")
        print(f"Is Scanned: {doc.is_scanned}")
        print(f"Full metadata: {doc.metadata}")
        
        # Simulate what the API returns
        meta = doc.metadata or {}
        fields = meta.get("ocr_suggestions")
        quality = meta.get("ocr_quality")
        
        print(f"\n=== API RESPONSE STRUCTURE ===")
        print(f"OCR suggestions from metadata: {fields}")
        print(f"OCR quality from metadata: {quality}")
        
        if fields or quality:
            suggestions = {
                "fields": fields or None,
                "quality": quality or None,
            }
        else:
            suggestions = None
            
        api_response = {
            "ocr_status": doc.ocr_status,
            "suggestions": suggestions,
        }
        
        print(f"\n=== FULL API RESPONSE ===")
        print(f"Status: {api_response['ocr_status']}")
        print(f"Suggestions: {api_response['suggestions']}")
        
        if suggestions and suggestions.get('fields'):
            print(f"\n=== EXTRACTED FIELDS ===")
            for key, value in suggestions['fields'].items():
                print(f"  {key}: '{value}'")
        
        return True
        
    except Document.DoesNotExist:
        print(f"Document with ID {document_id} not found")
        return False
    except Exception as e:
        print(f"Error: {e}")
        import traceback
        traceback.print_exc()
        return False

def list_recent_documents():
    """List recent documents to find one to debug"""
    docs = Document.objects.filter(ocr_status='done').order_by('-created_at')[:5]
    print("=== RECENT OCR-PROCESSED DOCUMENTS ===")
    for doc in docs:
        print(f"ID: {doc.id}, Title: {doc.title}, OCR: {doc.ocr_status}, Created: {doc.created_at}")
    return docs

if __name__ == "__main__":
    if len(sys.argv) > 1:
        doc_id = sys.argv[1]
        debug_ocr_api(doc_id)
    else:
        docs = list_recent_documents()
        if docs:
            print(f"\nUsage: python debug_api.py <document_id>")
            print(f"Try one of these IDs: {[d.id for d in docs]}")
