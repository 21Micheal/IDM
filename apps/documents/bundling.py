"""
Bundling helpers for acting on multiple documents at once.

  - collect_document_files: read the (permission-checked) file bytes for a set
    of documents, preserving caller order.
  - zip_items: package items into a single ZIP (bulk download).
  - stitch_items_to_pdf: merge items into ONE PDF, in order (Infor-style
    "stitching"). PDFs are merged directly; office files use their generated
    preview PDF; images are converted; anything else is skipped with a note.
"""
from __future__ import annotations

import io
import logging

from .file_streaming import read_document_bytes, user_can_download_document

logger = logging.getLogger(__name__)


def collect_document_files(documents, user) -> tuple[list[dict], list[dict]]:
    """
    Return (items, skipped) for the given documents (order preserved).

    Each item: {"document", "raw", "content_type", "filename"}.
    Each skipped: {"id", "title", "detail"}.
    """
    items: list[dict] = []
    skipped: list[dict] = []
    for doc in documents:
        if not user_can_download_document(user, doc):
            skipped.append({"id": str(doc.id), "title": doc.title, "detail": "Download not permitted."})
            continue
        try:
            raw, content_type, filename = read_document_bytes(doc, version=None, use_preview=False)
        except FileNotFoundError as exc:
            skipped.append({"id": str(doc.id), "title": doc.title, "detail": str(exc)})
            continue
        items.append({
            "document": doc,
            "raw": raw,
            "content_type": content_type,
            "filename": filename,
        })
    return items, skipped


def zip_items(items) -> bytes:
    """Package items into a ZIP, de-duplicating colliding file names."""
    import zipfile

    archive = io.BytesIO()
    used_names: set[str] = set()
    with zipfile.ZipFile(archive, "w", zipfile.ZIP_DEFLATED) as zf:
        for item in items:
            name = item["filename"] or f"{item['document'].reference_number}.bin"
            base_name = name
            counter = 2
            while name in used_names:
                stem, dot, ext = base_name.rpartition(".")
                name = f"{stem}-{counter}.{ext}" if dot else f"{base_name}-{counter}"
                counter += 1
            used_names.add(name)
            zf.writestr(name, item["raw"])
    archive.seek(0)
    return archive.read()


def _item_pdf_bytes(item) -> bytes | None:
    """Best-effort PDF representation of a document for stitching."""
    doc = item["document"]
    raw = item["raw"]
    content_type = (item.get("content_type") or "").lower()
    filename = (item.get("filename") or "").lower()

    # Already a PDF.
    if content_type == "application/pdf" or filename.endswith(".pdf"):
        return raw

    # Office (and other) documents: use the generated preview PDF when present.
    preview = getattr(doc, "preview_pdf", None)
    if preview:
        try:
            with preview.open("rb") as fh:
                return fh.read()
        except Exception:
            logger.warning("stitch: could not read preview_pdf for %s", doc.id)

    # Images → single-page PDF.
    if content_type.startswith("image/") or filename.endswith((".png", ".jpg", ".jpeg", ".tif", ".tiff", ".bmp", ".gif")):
        try:
            from PIL import Image
            img = Image.open(io.BytesIO(raw))
            if img.mode not in ("RGB", "L"):
                img = img.convert("RGB")
            out = io.BytesIO()
            img.save(out, "PDF")
            return out.getvalue()
        except Exception:
            logger.warning("stitch: could not convert image %s to PDF", doc.id)

    return None


def stitch_items_to_pdf(items) -> tuple[bytes | None, list[dict]]:
    """
    Merge items into a single PDF, in the given order.

    Returns (pdf_bytes_or_None, skipped). Documents with no PDF representation
    are skipped and reported.
    """
    import pypdfium2 as pdfium

    dest = pdfium.PdfDocument.new()
    sources = []  # keep refs alive until we've saved
    skipped: list[dict] = []
    merged_any = False

    try:
        for item in items:
            doc = item["document"]
            pdf_bytes = _item_pdf_bytes(item)
            if not pdf_bytes:
                skipped.append({
                    "id": str(doc.id), "title": doc.title,
                    "detail": "No PDF version available to stitch (office files need a preview).",
                })
                continue
            try:
                src = pdfium.PdfDocument(pdf_bytes)
                dest.import_pages(src)
                sources.append(src)
                merged_any = True
            except Exception as exc:
                skipped.append({"id": str(doc.id), "title": doc.title, "detail": f"Could not stitch: {exc}"})

        if not merged_any:
            return None, skipped

        out = io.BytesIO()
        dest.save(out)
        return out.getvalue(), skipped
    finally:
        for src in sources:
            try:
                src.close()
            except Exception:
                pass
        try:
            dest.close()
        except Exception:
            pass
