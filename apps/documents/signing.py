"""
Shared PDF e-signature embedding.

Stamps signature/text items onto a document's PDF and commits the result as a
new DocumentVersion. Used by both the workflow approval signing
(apps/workflows/services.py) and the ad-hoc "Request signature" flow
(apps/documents/signature_views.py).

Two entry points:

* ``embed_signature_into_document`` — legacy single-placement API used by the
  workflow approval path. Always uses the signer's saved e-signature and
  stamps a fixed "Signed by ... on ..." label. Unchanged in behavior.

* ``embed_signing_items_into_document`` — Sejda-style multi-item API used by
  the ad-hoc signature-request flow. Accepts an arbitrary list of placed
  items (signature / name / date / text), each with its own page and
  position, and optionally an ad-hoc (not-saved) signature image supplied by
  the signer for this signing action only. No label is force-appended; any
  name/date the signer wants on the page must be placed explicitly as its
  own item, matching the placement UI.
"""
from __future__ import annotations

import base64
import hashlib
import mimetypes
import os
import re
from io import BytesIO

from django.core.files.base import ContentFile
from django.utils import timezone

from .models import Document, DocumentVersion

# ── ad-hoc signature image limits ───────────────────────────────────────────
MAX_SIGNATURE_IMAGE_BYTES = 2 * 1024 * 1024
MAX_SIGNATURE_IMAGE_DIM = 3000
_DATA_URL_RE = re.compile(r"^data:image/(png|jpeg);base64,(?P<data>.+)$", re.IGNORECASE | re.DOTALL)

# ── placed-item limits (Sejda-style multi-item flow) ────────────────────────
ALLOWED_ITEM_KINDS = {"signature", "name", "date", "text"}
MAX_ITEMS_PER_REQUEST = 40
MAX_ITEM_TEXT_LENGTH = 200


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


def _decode_signature_image(raw: bytes) -> bytes:
    """Validate arbitrary signature image bytes and re-encode through Pillow
    as a transparent PNG. This is defense-in-depth for any signature image
    that isn't pulled from a trusted, already-stored ``Signature`` row:
    re-encoding strips anything but pixel data and enforces a hard size/
    dimension cap, so a crafted "PNG" can't be used to smuggle a payload or
    a decompression bomb into the PDF pipeline."""
    if len(raw) > MAX_SIGNATURE_IMAGE_BYTES:
        raise SignatureError("Signature image is too large.")
    try:
        from PIL import Image
    except Exception as exc:  # pragma: no cover - server config
        raise SignatureError("Signature image processing is not available on this server.") from exc
    try:
        probe = Image.open(BytesIO(raw))
        probe.verify()
        img = Image.open(BytesIO(raw))  # must reopen; verify() leaves it unusable
        img.load()
    except Exception:
        raise SignatureError("Signature image could not be read.")
    if img.width > MAX_SIGNATURE_IMAGE_DIM or img.height > MAX_SIGNATURE_IMAGE_DIM:
        raise SignatureError("Signature image dimensions are too large.")
    out = BytesIO()
    img.convert("RGBA").save(out, format="PNG")
    return out.getvalue()


def _decode_signature_data_url(data_url) -> bytes:
    if not isinstance(data_url, str):
        raise SignatureError("Draw, type, or upload a signature before signing.")
    match = _DATA_URL_RE.match(data_url.strip())
    if not match:
        raise SignatureError("Only PNG or JPG signature images are supported.")
    try:
        raw = base64.b64decode(match.group("data"), validate=True)
    except Exception:
        raise SignatureError("Signature image could not be decoded.")
    return _decode_signature_image(raw)


def _validate_items(items) -> list[dict]:
    """Validate and normalize the Sejda-style placed-items array. Unknown or
    malformed entries are rejected outright; empty optional text items are
    silently dropped rather than failing the whole request."""
    if not isinstance(items, list) or not items:
        raise SignatureError("Place at least one item on the document before signing.")
    if len(items) > MAX_ITEMS_PER_REQUEST:
        raise SignatureError("Too many items placed on the document.")

    cleaned: list[dict] = []
    for raw in items:
        if not isinstance(raw, dict):
            raise SignatureError("Placement data is invalid.")
        kind = raw.get("kind")
        if kind not in ALLOWED_ITEM_KINDS:
            raise SignatureError("Placement data contains an unsupported item type.")
        try:
            page_number = int(raw.get("page_number", 0))
            x_percent = float(raw.get("x_percent"))
            y_percent = float(raw.get("y_percent"))
            width_percent = float(raw.get("width_percent"))
            height_percent = float(raw.get("height_percent"))
        except (TypeError, ValueError):
            raise SignatureError("Placement coordinates are invalid.")

        if page_number < 1:
            raise SignatureError("Placement page number is invalid.")
        if not (0 <= x_percent <= 100 and 0 <= y_percent <= 100):
            raise SignatureError("Placed items must be inside the page.")
        width_percent = max(2, min(width_percent, 100))
        height_percent = max(1, min(height_percent, 100))

        item = {
            "kind": kind,
            "page_number": page_number,
            "x_percent": x_percent,
            "y_percent": y_percent,
            "width_percent": width_percent,
            "height_percent": height_percent,
        }

        if kind != "signature":
            text = str(raw.get("text") or "").strip()
            if not text:
                continue  # drop empty optional text/name/date items
            item["text"] = text[:MAX_ITEM_TEXT_LENGTH]
            try:
                item["font_percent"] = max(0.5, min(8.0, float(raw.get("font_percent", 1.6))))
            except (TypeError, ValueError):
                item["font_percent"] = 1.6
            # Optional styling so signers can match the document's font.
            fam = str(raw.get("font_family") or "helvetica").lower()
            item["font_family"] = fam if fam in ("helvetica", "times", "courier") else "helvetica"
            item["bold"] = bool(raw.get("bold"))
            item["italic"] = bool(raw.get("italic"))
            align = str(raw.get("align") or "center").lower()
            item["align"] = align if align in ("left", "center", "right") else "center"
            item["color"] = _normalize_hex_color(raw.get("color"))

        cleaned.append(item)

    if not any(i["kind"] == "signature" for i in cleaned):
        raise SignatureError("Place at least one signature on the document.")
    return cleaned


def _percent_rect(page_rect, item: dict):
    import fitz  # local import: only needed where PDF geometry is built

    width = page_rect.width * (item["width_percent"] / 100)
    height = page_rect.height * (item["height_percent"] / 100)
    x0 = max(0, min(page_rect.width - width, page_rect.width * (item["x_percent"] / 100)))
    y0 = max(0, min(page_rect.height - height, page_rect.height * (item["y_percent"] / 100)))
    return fitz.Rect(x0, y0, x0 + width, y0 + height), x0, y0, width, height


# PDF base-14 font codes (PyMuPDF) by family → (regular, bold, italic, bold-italic).
_BASE_FONTS = {
    "helvetica": ("helv", "hebo", "heit", "hebi"),
    "times":     ("tiro", "tibo", "tiit", "tibi"),
    "courier":   ("cour", "cobo", "coit", "cobi"),
}

_TEXT_ALIGN = {"left": 0, "center": 1, "right": 2}


def _normalize_hex_color(value) -> str:
    s = str(value or "").strip().lstrip("#")
    if len(s) == 6:
        try:
            int(s, 16)
            return f"#{s.lower()}"
        except ValueError:
            pass
    return "#1f2933"


def _hex_to_rgb01(hexstr: str):
    s = (hexstr or "").lstrip("#")
    try:
        return (int(s[0:2], 16) / 255, int(s[2:4], 16) / 255, int(s[4:6], 16) / 255)
    except (ValueError, IndexError):
        return (0.12, 0.16, 0.20)


def _font_code(item: dict) -> str:
    reg, bold, italic, bolditalic = _BASE_FONTS.get(item.get("font_family", "helvetica"), _BASE_FONTS["helvetica"])
    b, i = bool(item.get("bold")), bool(item.get("italic"))
    return bolditalic if (b and i) else bold if b else italic if i else reg


def _stamp_text_item(page, rect, item: dict):
    """Stamp a text/name/date item. The font size is shrunk so the text fits the
    box on a single line — PyMuPDF's insert_textbox draws nothing (returns < 0)
    when the text overflows, which made longer names silently vanish."""
    import fitz

    text = item["text"]
    fontname = _font_code(item)
    color = _hex_to_rgb01(item.get("color", "#1f2933"))
    align = _TEXT_ALIGN.get(item.get("align", "center"), 1)

    requested = max(6, min(40, (item["font_percent"] / 100) * page.rect.height))
    # Shrink to fit the box width (single line) and height so it always renders.
    try:
        font = fitz.Font(fontname=fontname)
        text_w = font.text_length(text, fontsize=requested) or 1
        fit_by_width = requested * (rect.width * 0.96) / text_w
    except Exception:
        fit_by_width = requested
    fit_by_height = rect.height / 1.25
    fontsize = max(5.0, min(requested, fit_by_width, fit_by_height))

    rc = page.insert_textbox(rect, text, fontsize=fontsize, fontname=fontname, color=color, align=align)
    if rc < 0:
        # Final safety net: a single baseline line is never clipped.
        page.insert_text((rect.x0 + 1, rect.y0 + fontsize), text, fontsize=fontsize, fontname=fontname, color=color)


def _read_filefield(ff) -> bytes:
    ff.open("rb")
    try:
        return ff.read()
    finally:
        try:
            ff.close()
        except Exception:
            pass


def _office_to_pdf_bytes(document: Document) -> bytes:
    """Render an Office document to PDF bytes via LibreOffice (same converter the
    preview pipeline uses)."""
    from apps.documents.tasks import _convert_office_source_to_pdf_bytes
    import tempfile
    from pathlib import Path

    ext = os.path.splitext(document.file_name or "")[1] or ".docx"
    src = _read_filefield(document.file)
    with tempfile.NamedTemporaryFile(suffix=ext, delete=False) as f:
        f.write(src)
        tmp = f.name
    try:
        return _convert_office_source_to_pdf_bytes(Path(tmp), soffice_bin="libreoffice", timeout=90)
    finally:
        try:
            os.unlink(tmp)
        except Exception:
            pass


def _load_signable_pdf(document: Document) -> bytes:
    """Return the PDF bytes to stamp signatures onto.

    Native PDFs are used directly. Office documents are signed on their PDF
    rendition — preferring the cached ``preview_pdf`` (the exact PDF the signer
    placed items on in the UI), falling back to converting the source now. The
    signed result is committed as a new PDF version, so a Word/Excel/PowerPoint
    document becomes a finalized PDF once signed (the original stays in history).
    """
    if document.is_pdf():
        return _read_filefield(document.file)
    if document.is_office_doc():
        preview = getattr(document, "preview_pdf", None)
        if preview:
            try:
                data = _read_filefield(preview)
                if data:
                    return data
            except Exception:
                pass
        return _office_to_pdf_bytes(document)
    raise SignatureError("Only PDF and Office documents can be signed.")


def _commit_new_version(document: Document, signer_user, signed_bytes: bytes, change_summary: str) -> DocumentVersion:
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
        change_summary=change_summary,
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
    return version


def embed_signature_into_document(document: Document, signer_user, placement) -> tuple[DocumentVersion, dict]:
    """Stamp ``signer_user``'s active saved e-signature onto ``document``'s PDF at
    ``placement`` and commit a new DocumentVersion. Returns ``(version, info)``
    where ``info`` carries the geometry + the source signature for the caller to
    record its own audit/DocumentSignature row. Raises ``SignatureError``."""
    signature = signer_user.signatures.filter(is_active=True).order_by("-created_at").first()
    if not signature or not signature.image:
        raise SignatureError("Create a saved e-signature in your profile before signing.")

    page_number, x_percent, y_percent, width_percent = _validate_placement(placement)

    try:
        import fitz
    except Exception as exc:  # pragma: no cover - server config
        raise SignatureError("PDF signing is not available on this server.") from exc

    pdf_bytes = _load_signable_pdf(document)

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

    version = _commit_new_version(
        document, signer_user, signed_bytes,
        change_summary=f"E-signature applied by {signer_name}",
    )

    info = {
        "signature": signature,
        "version": version,
        "page_number": page_number,
        "x": x0,
        "y": y0,
        "width": width,
        "height": height,
        "checksum": version.checksum,
    }
    return version, info


def embed_signing_items_into_document(
    document: Document,
    signer_user,
    items,
    *,
    use_new_signature: bool = False,
    signature_image=None,
) -> tuple[DocumentVersion, dict]:
    """Sejda-style multi-item signing. Stamps every placed item (one or more
    ``signature`` items plus any optional ``name`` / ``date`` / ``text``
    items the signer dropped onto the page) and commits a new
    ``DocumentVersion``. Unlike ``embed_signature_into_document``, nothing is
    appended automatically — the rendered page contains exactly what the
    signer placed in the UI.

    The image used for every ``signature`` item is resolved server-side, not
    trusted from the client payload:

    * by default, the signer's saved active ``Signature`` (same source as
      the legacy flow), or
    * if ``use_new_signature`` is true, the ad-hoc image supplied in
      ``signature_image`` (a ``data:image/png|jpeg;base64,...`` URL) for
      this signing action only — validated, size/dimension-capped, and
      re-encoded, but never persisted as the user's saved signature.

    Raises ``SignatureError`` on any validation failure.
    """
    cleaned_items = _validate_items(items)

    signature_record = None
    if use_new_signature:
        signature_bytes = _decode_signature_data_url(signature_image)
    else:
        signature_record = signer_user.signatures.filter(is_active=True).order_by("-created_at").first()
        if not signature_record or not signature_record.image:
            raise SignatureError("Create a saved e-signature in your profile before signing.")
        signature_record.image.open("rb")
        try:
            saved_bytes = signature_record.image.read()
        finally:
            try:
                signature_record.image.close()
            except Exception:
                pass
        signature_bytes = _decode_signature_image(saved_bytes)

    try:
        import fitz
    except Exception as exc:  # pragma: no cover - server config
        raise SignatureError("PDF signing is not available on this server.") from exc

    pdf_bytes = _load_signable_pdf(document)

    pdf = fitz.open(stream=pdf_bytes, filetype="pdf")
    try:
        for item in cleaned_items:
            if item["page_number"] > pdf.page_count:
                raise SignatureError(f"Page {item['page_number']} is outside the document.")
            page = pdf[item["page_number"] - 1]
            rect, *_ = _percent_rect(page.rect, item)
            if item["kind"] == "signature":
                page.insert_image(rect, stream=signature_bytes, keep_proportion=True)
            else:
                _stamp_text_item(page, rect, item)
        signed_bytes = pdf.tobytes(garbage=4, deflate=True)
    finally:
        pdf.close()

    signer_name = signer_user.get_full_name() or signer_user.email
    version = _commit_new_version(
        document, signer_user, signed_bytes,
        change_summary=f"E-signature applied by {signer_name}",
    )

    info = {
        "signature": signature_record,
        "version": version,
        "items": cleaned_items,
        "used_new_signature": use_new_signature,
        "checksum": version.checksum,
    }
    return version, info