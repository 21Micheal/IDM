#!/usr/bin/env python3
"""
generate_test_pdf.py
Run this locally (no extra dependencies) to produce a minimal valid PDF
you can upload to the DMS for viewer testing.

Usage:
    python generate_test_pdf.py
    # Produces: test_invoice.pdf in the current directory
"""

import struct
import zlib


def make_pdf(filename: str, title: str, lines: list[str]) -> None:
    """
    Build a minimal valid PDF without any external libraries.
    Uses PDF 1.4 syntax with a single page and embedded text.
    """
    # ── PDF content stream ────────────────────────────────────────────────────
    content_lines = ["BT", "/F1 14 Tf", "50 780 Td", "16 TL"]
    for line in lines:
        # Escape parentheses in PDF string syntax
        safe = line.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")
        content_lines.append(f"({safe}) Tj T*")
    content_lines.append("ET")
    content = "\n".join(content_lines).encode()

    # ── Build PDF objects ─────────────────────────────────────────────────────
    objects: list[bytes] = []
    offsets: list[int] = []

    def add_obj(content_bytes: bytes) -> int:
        obj_num = len(objects) + 1
        objects.append(content_bytes)
        return obj_num

    # Object 1: Catalog
    catalog_num = add_obj(b"<< /Type /Catalog /Pages 2 0 R >>")

    # Object 2: Pages
    pages_num = add_obj(b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>")

    # Object 3: Page
    page_num = add_obj(
        b"<< /Type /Page /Parent 2 0 R "
        b"/MediaBox [0 0 595 842] "
        b"/Contents 4 0 R "
        b"/Resources << /Font << /F1 5 0 R >> >> >>"
    )

    # Object 4: Content stream
    stream_content = content
    stream_num = add_obj(
        f"<< /Length {len(stream_content)} >>\nstream\n".encode()
        + stream_content
        + b"\nendstream"
    )

    # Object 5: Font
    font_num = add_obj(
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"
    )

    # ── Assemble PDF bytes ────────────────────────────────────────────────────
    pdf = bytearray(b"%PDF-1.4\n%\xe2\xe3\xcf\xd3\n")

    xref_offsets = []
    for i, obj_bytes in enumerate(objects):
        xref_offsets.append(len(pdf))
        obj_num = i + 1
        pdf += f"{obj_num} 0 obj\n".encode()
        pdf += obj_bytes
        pdf += b"\nendobj\n\n"

    # ── Cross-reference table ─────────────────────────────────────────────────
    xref_start = len(pdf)
    pdf += b"xref\n"
    pdf += f"0 {len(objects) + 1}\n".encode()
    pdf += b"0000000000 65535 f \n"
    for offset in xref_offsets:
        pdf += f"{offset:010d} 00000 n \n".encode()

    pdf += (
        f"trailer\n<< /Size {len(objects) + 1} /Root 1 0 R >>\n"
        f"startxref\n{xref_start}\n%%EOF\n"
    ).encode()

    with open(filename, "wb") as f:
        f.write(pdf)

    size_kb = len(pdf) / 1024
    print(f"✓ Created {filename} ({size_kb:.1f} KB)")


if __name__ == "__main__":
    make_pdf(
        "test_invoice.pdf",
        "Test Invoice",
        [
            "INVOICE",
            "",
            "Reference:  INV-00001",
            "Date:       11 April 2026",
            "Supplier:   Acme Corp Ltd",
            "Amount:     USD 4,500.00",
            "",
            "Description:",
            "  Professional services - Q1 2026",
            "  Software licences x 5",
            "",
            "Subtotal:   USD 4,500.00",
            "Tax (16%):  USD   720.00",
            "Total:      USD 5,220.00",
            "",
            "Bank: First National Bank",
            "Account: 0123456789",
            "Sort code: 00-11-22",
            "",
            "Thank you for your business.",
        ],
    )

    make_pdf(
        "test_contract.pdf",
        "Test Contract",
        [
            "SERVICE AGREEMENT",
            "",
            "Reference:  CTR-00001",
            "Date:       11 April 2026",
            "Parties:",
            "  Client:    DocVault Enterprises Ltd",
            "  Supplier:  Acme Corp Ltd",
            "",
            "Term: 12 months from the date of signing.",
            "",
            "Scope of work:",
            "  Provision of software development services",
            "  as per Schedule A attached hereto.",
            "",
            "Value: USD 54,000.00 per annum",
            "",
            "Signatures:",
            "  Client:   ________________",
            "  Supplier: ________________",
        ],
    )

    print("\nUpload either file through the DMS to test the PDF viewer.")
