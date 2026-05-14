#!/usr/bin/env python
"""Regression tests for OCR extraction + regex/NER field resolution."""
import os
import sys
from pathlib import Path

project_root = Path(__file__).parent
sys.path.insert(0, str(project_root))

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "IDM.settings")


def test_compact_header_grid_variations():
    """Regression tests for multiple compact header grid layouts."""
    import django

    django.setup()

    from apps.documents.ocr.extractor import DocumentFieldExtractor

    variations = [
        (
            "ACCOUNT CODE\tSUPPLIER ID\tDATE ISSUED\tDUE DATE\n"
            "NET-OPS-88\tSUPP-CCS-99\tOct 25, 2024\tNov 24, 2024"
        ),
        (
            "SUPPLIER ID\tACCOUNT CODE\tDATE ISSUED\tDUE DATE\n"
            "SUPP-CCS-99\tNET-OPS-88\tOct 25, 2024\tNov 24, 2024"
        ),
        (
            "Apex Solutions Ltd\n"
            "SUPPLIER ID\tACCOUNT CODE\tINVOICE DATE\tDUE DATE\n"
            "SUPP-APX-01\tNET-OPS-88\tMay 8, 2026\tJun 7, 2026"
        ),
    ]

    for sample_text in variations:
        extractor = DocumentFieldExtractor(sample_text)
        result = extractor.extract()

        print("\n=== Compact Header Grid Regression Test ===")
        print(result)

        assert result.get("account_code") == "NET-OPS-88", (
            f"expected account_code NET-OPS-88, got {result.get('account_code')}"
        )
        assert result.get("vendor_code") in ("SUPP-CCS-99", "SUPP-APX-01"), (
            f"expected vendor id from grid, got {result.get('vendor_code')!r}"
        )
        if "SUPP-APX-01" in sample_text:
            assert result.get("supplier") == "Apex Solutions Ltd", (
                f"expected issuer line as supplier, got {result.get('supplier')!r}"
            )
        assert result.get("document_date") in {"2024-10-25", "2026-05-08"}, (
            f"expected valid document_date, got {result.get('document_date')}"
        )
        assert result.get("due_date") in {"2024-11-24", "2026-06-07"}, (
            f"expected valid due_date, got {result.get('due_date')}"
        )


def test_amount_extraction_with_thousands_separator():
    """Ensure amount extraction handles KES totals with thousands separators."""
    import django

    django.setup()

    from apps.documents.ocr.extractor import _best_amount

    sample_text = (
        "Subtotal: KES 75,700.00\n"
        "VAT (16%): KES 12,112.00\n"
        "Total Amount: KES 87,812.00\n"
        "Payment Instructions: Net 30 days. Please include INV-2026-0508 with your transfer."
    )

    amount, currency = _best_amount(sample_text)
    print("\n=== Amount Extraction Regression Test ===")
    print("amount=", amount, "currency=", currency)

    assert amount == "87812.0", f"expected 87812.0, got {amount}"
    assert currency == "KES", f"expected currency KES, got {currency}"


def test_field_resolver_regex_over_ner():
    import django

    django.setup()

    from apps.documents.ocr.field_resolver import FieldResolver

    regex = {"supplier": "ACME Ltd", "document_date": "2024-05-11"}
    ner = {"supplier": "Wrong Org Inc", "document_date": "2024-01-01"}
    resolved, src = FieldResolver().resolve(regex, ner)
    assert resolved["supplier"] == "ACME Ltd"
    assert src["supplier"] == "regex"
    assert resolved["document_date"] == "2024-05-11"


def test_ner_field_hints_smoke():
    import django

    django.setup()

    from apps.documents.ocr.tasks_ocr import _ner_field_hints

    text = (
        "Tax invoice from East Africa Widgets Limited. "
        "Invoice date 15 March 2026. Total KES 10,000.00 due 30 April 2026."
    )
    hints = _ner_field_hints(text)
    print("\n=== NER hints ===", hints)
    assert isinstance(hints, dict)


def test_cyber_core_invoice_sample():
    """Regression: issuer vs Bill To, grid dates/codes, reject long digit account numbers."""
    import django

    django.setup()

    from apps.documents.ocr.extractor import DocumentFieldExtractor

    text = """CYBER CORE SYSTEMS INVOICE

#CCS-2024-5001

Enterprise Network Solutions

900 Data Lane, Suite 200, San Jose, CA 95110

EIN: 12-345678 | billing@cybercore.sys

ACCOUNT CODE SUPPLIER ID DATE ISSUED DUE DATE

NET-OPS-88 SUPP-CCS-99 Oct 25, 2024 Nov 24, 2024

BILL TO:

Nexus Innovations LLC

404 Silicon Drive, Austin, TX 78701

Account Number: 009988771122

PRODUCT / SERVICE DESCRIPTION QTY UNIT PRICE AMOUNT
"""
    result = DocumentFieldExtractor(text).extract()
    print("\n=== Cyber Core sample ===", result)

    assert result.get("supplier") in ("CYBER CORE SYSTEMS", "Enterprise Network Solutions")
    assert result.get("vendor_code") == "SUPP-CCS-99"
    assert result.get("account_code") == "NET-OPS-88"
    assert result.get("due_date") == "2024-11-24"
    assert result.get("document_date") == "2024-10-25"


def test_configuration():
    import django

    django.setup()
    from django.conf import settings

    print("\n=== Configuration Check ===")
    print(f"OCR_ENGINE: {getattr(settings, 'OCR_ENGINE', 'NOT SET')}")
    print(f"OCR_SPACY_ENABLED: {getattr(settings, 'OCR_SPACY_ENABLED', 'NOT SET')}")


if __name__ == "__main__":
    test_configuration()
    test_compact_header_grid_variations()
    test_cyber_core_invoice_sample()
    test_amount_extraction_with_thousands_separator()
    test_field_resolver_regex_over_ner()
    test_ner_field_hints_smoke()
    print("\nAll tests passed.")
