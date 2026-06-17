"""
Shared PDF e-signature embedding.

Stamps a user's saved e-signature image onto a document's PDF at a placement and
commits it as a new DocumentVersion. Used by both the workflow approval signing
(apps/workflows/services.py) and the ad-hoc "Request signature" flow
(apps/documents/signature_views.py).
"""
from __future__ import annotations

import hashlib
import mimetypes
import os

from django.core.files.base import ContentFile
from django.utils import timezone

from .models import Document, DocumentVersion


class SignatureError(Exception):
    """Raised for any signing validation/processing failure (bad placement,
    missing saved signature, non-PDF, etc.)."""


def _validate_placement(placement) -> tuple[int, float, float, float]:
    if not isinstance(placement, dict):
        raise SignatureError("Place your signature on the PDF before signing.")
    try:
        page_number = int(placement.get("page_number", 0))
        x_percent = float(placement.get("x_percent"))
        y_percent = float(placement.get("y_percent"))
        width_percent = float(placement.get("width_percent", 24))
    except (TypeError, ValueError):
        raise SignatureError("Signature placement coordinates are invalid.")

    if page_number < 1:
        raise SignatureError("Signature page number is invalid.")
    if not (0 <= x_percent <= 100 and 0 <= y_percent <= 100):
        raise SignatureError("Signature placement must be inside the page.")
    width_percent = max(8, min(width_percent, 40))
    return page_number, x_percent, y_percent, width_percent


def embed_signature_into_document(document: Document, signer_user, placement) -> tuple[DocumentVersion, dict]:
    """Stamp ``signer_user``'s active saved e-signature onto ``document``'s PDF at
    ``placement`` and commit a new DocumentVersion. Returns ``(version, info)``
    where ``info`` carries the geometry + the source signature for the caller to
    record its own audit/DocumentSignature row. Raises ``SignatureError``."""
    signature = signer_user.signatures.filter(is_active=True).order_by("-created_at").first()
    if not signature or not signature.image:
        raise SignatureError("Create a saved e-signature in your profile before signing.")
    if not document.is_pdf():
        raise SignatureError("Only PDF documents can be signed.")

    page_number, x_percent, y_percent, width_percent = _validate_placement(placement)

    try:
        import fitz
    except Exception as exc:  # pragma: no cover - server config
        raise SignatureError("PDF signing is not available on this server.") from exc

    try:
        document.file.open("rb")
        pdf_bytes = document.file.read()
    finally:
        try:
            document.file.close()
        except Exception:
            pass

    try:
        signature.image.open("rb")
        signature_bytes = signature.image.read()
    finally:
        try:
            signature.image.close()
        except Exception:
            pass

    pdf = fitz.open(stream=pdf_bytes, filetype="pdf")
    try:
        if page_number > pdf.page_count:
            raise SignatureError("Signature page number is outside the document.")
        page = pdf[page_number - 1]
        page_rect = page.rect
        width = min(220, page_rect.width * (width_percent / 100))
        height = width * 0.38
        x0 = max(0, min(page_rect.width - width, page_rect.width * (x_percent / 100)))
        y0 = max(0, min(page_rect.height - height, page_rect.height * (y_percent / 100)))
        rect = fitz.Rect(x0, y0, x0 + width, y0 + height)
        page.insert_image(rect, stream=signature_bytes, keep_proportion=True)

        signer_name = signer_user.get_full_name() or signer_user.email
        signed_at = timezone.localtime(timezone.now()).strftime("%Y-%m-%d %H:%M %Z")
        label_y0 = y0 + height + 4
        if label_y0 + 24 > page_rect.height:
            label_y0 = max(0, y0 - 28)
        label_x1 = min(page_rect.width, max(x0 + width, x0 + width + 120))
        page.insert_textbox(
            fitz.Rect(x0, label_y0, label_x1, min(page_rect.height, label_y0 + 28)),
            f"Signed by {signer_name} on {signed_at}",
            fontsize=7,
            color=(0.20, 0.20, 0.20),
        )
        signed_bytes = pdf.tobytes(garbage=4, deflate=True)
    finally:
        pdf.close()

    checksum = hashlib.sha256(signed_bytes).hexdigest()
    root, _ = os.path.splitext(document.file_name or "document.pdf")
    new_version = document.current_version + 1
    signed_name = f"{root}-signed-v{new_version}.pdf"

    version = DocumentVersion.objects.create(
        document=document,
        version_number=new_version,
        file=ContentFile(signed_bytes, name=signed_name),
        file_name=signed_name,
        file_size=len(signed_bytes),
        checksum=checksum,
        change_summary=f"E-signature applied by {signer_name}",
        created_by=signer_user,
    )

    document.file.save(signed_name, ContentFile(signed_bytes, name=signed_name), save=False)
    document.file_name = signed_name
    document.file_size = len(signed_bytes)
    document.file_mime_type = mimetypes.guess_type(signed_name)[0] or "application/pdf"
    document.checksum = checksum
    document.current_version = new_version
    document.preview_pdf = None
    document.preview_status = ""
    Document.objects.filter(id=document.id).update(
        file=document.file.name,
        file_name=document.file_name,
        file_size=document.file_size,
        file_mime_type=document.file_mime_type,
        checksum=document.checksum,
        current_version=document.current_version,
        preview_pdf="",
        preview_status="",
        updated_at=timezone.now(),
    )

    info = {
        "signature": signature,
        "version": version,
        "page_number": page_number,
        "x": x0,
        "y": y0,
        "width": width,
        "height": height,
        "checksum": checksum,
    }
    return version, info
