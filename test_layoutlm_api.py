#!/usr/bin/env python
"""
Test LayoutLM-only API response by triggering OCR processing.
"""
import requests
import json
import time

def test_layoutlm_api():
    """Test LayoutLM-only API by checking OCR suggestions endpoint."""
    
    # Test document ID from logs
    doc_id = "0c11247b-cef0-4a11-8c70-4cf9cddf49d8"
    
    print(f"Testing LayoutLM-only API for document: {doc_id}")
    
    # Test OCR suggestions endpoint
    url = f"http://localhost:8000/api/v1/documents/{doc_id}/ocr_suggestions/"
    
    try:
        response = requests.get(url)
        print(f"Status Code: {response.status_code}")
        print(f"Response Size: {len(response.content)} bytes")
        
        if response.status_code == 200:
            try:
                data = response.json()
                print(f"Response Data: {json.dumps(data, indent=2)}")
                
                # Check if we have suggestions
                if 'ocr_suggestions' in data:
                    suggestions = data['ocr_suggestions']
                    print(f"\nOCR Suggestions ({len(suggestions)} fields):")
                    for field, value in suggestions.items():
                        print(f"  {field}: {value}")
                else:
                    print("No 'ocr_suggestions' field in response")
                    
                # Check OCR quality
                if 'ocr_quality' in data:
                    quality = data['ocr_quality']
                    print(f"\nOCR Quality: {quality}")
                    
            except json.JSONDecodeError as e:
                print(f"Failed to parse JSON: {e}")
                print(f"Raw Response: {response.text[:500]}...")
        else:
            print(f"HTTP Error: {response.status_code}")
            print(f"Response: {response.text[:500]}...")
            
    except requests.exceptions.ConnectionError:
        print("❌ Cannot connect to API. Make sure Django is running on localhost:8000")
    except Exception as e:
        print(f"❌ Error: {e}")

def test_document_list():
    """Get list of recent documents to test with."""
    try:
        response = requests.get("http://localhost:8000/api/v1/documents/")
        if response.status_code == 200:
            data = response.json()
            print(f"Found {len(data.get('results', []))} documents")
            
            for doc in data.get('results', [])[:5]:  # Show first 5
                print(f"  ID: {doc.get('id')}")
                print(f"  Title: {doc.get('title', 'N/A')}")
                print(f"  Status: {doc.get('ocr_status', 'N/A')}")
                print(f"  Metadata: {doc.get('metadata', {})}")
                print()
        else:
            print(f"Failed to get documents: {response.status_code}")
            
    except Exception as e:
        print(f"Error getting documents: {e}")

if __name__ == "__main__":
    print("=== LayoutLM-Only API Test ===")
    test_document_list()
    print("\n" + "="*50 + "\n")
    test_layoutlm_api()
