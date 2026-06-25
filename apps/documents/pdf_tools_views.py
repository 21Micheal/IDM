"""
apps/documents/pdf_tools_views.py

PdfToolView — the server-side job endpoint for the in-app PDF editor.

The editor (frontend `onJob`) POSTs the working PDF plus a job descriptor; the
view runs the operation and streams the processed file back. Stateless: it
operates on the uploaded bytes only, so it needs no document object.

Supported jobs:
  • type=compress  params: level (high|extreme)        → application/pdf
  • type=convert   params: target=pdf-to-text          → text/plain
  • type=convert   params: target=pdf-to-docx|xlsx|pptx → Office file (LibreOffice)
  • type=redact    params: rects (JSON page fractions) → application/pdf

Password protect/unlock are intentionally not implemented here.
"""
import json
import logging

from django.http import HttpResponse
from rest_framework import permissions
from rest_framework.parsers import FormParser, MultiPartParser
from rest_framework.response import Response
from rest_framework.views import APIView

from .pdf_tools import (
    compress_pdf, office_to_pdf, pdf_to_docx, pdf_to_pptx, pdf_to_text_bytes,
    pdf_to_xlsx, redact_pdf,
)

logger = logging.getLogger(__name__)

_DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
_XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
_PPTX_MIME = "application/vnd.openxmlformats-officedocument.presentationml.presentation"

# target → (handler, output filename, mime)
_PDF_TO_OFFICE = {
    "pdf-to-docx": (pdf_to_docx, "converted.docx", _DOCX_MIME),
    "pdf-to-xlsx": (pdf_to_xlsx, "converted.xlsx", _XLSX_MIME),
    "pdf-to-pptx": (pdf_to_pptx, "converted.pptx", _PPTX_MIME),
}

_MAX_BYTES = 100 * 1024 * 1024  # 100 MB


class PdfToolView(APIView):
    permission_classes = [permissions.IsAuthenticated]
    parser_classes = [MultiPartParser, FormParser]

    def post(self, request):
        tool = (request.data.get("type") or "").strip()
        upload = request.FILES.get("file")
        if not upload:
            return Response({"detail": "No file was provided."}, status=400)

        data = upload.read()
        if not data:
            return Response({"detail": "The uploaded file is empty."}, status=400)
        if len(data) > _MAX_BYTES:
            return Response({"detail": "This file is too large for server processing."}, status=400)

        try:
            if tool == "compress":
                level = (request.data.get("level") or "high").strip()
                return self._file(compress_pdf(data, level), "compressed.pdf", "application/pdf")

            if tool == "redact":
                try:
                    rects = json.loads(request.data.get("rects") or "[]")
                except (ValueError, TypeError):
                    return Response({"detail": "The redaction data was malformed."}, status=400)
                if not isinstance(rects, list) or not rects:
                    return Response({"detail": "No redaction areas were provided."}, status=400)
                return self._file(redact_pdf(data, rects), "redacted.pdf", "application/pdf")

            if tool == "convert":
                target = (request.data.get("target") or "").strip()
                if target == "pdf-to-text":
                    return self._file(pdf_to_text_bytes(data), "converted.txt", "text/plain; charset=utf-8")
                if target in _PDF_TO_OFFICE:
                    handler, filename, mime = _PDF_TO_OFFICE[target]
                    return self._file(handler(data), filename, mime)
                if target in ("office-to-pdf", "html-to-pdf"):
                    # Source is an Office/HTML file (e.g. opening it in the editor).
                    pdf = office_to_pdf(data, getattr(upload, "name", "") or "")
                    return self._file(pdf, "converted.pdf", "application/pdf")
                return Response({"detail": f"Unsupported conversion target: {target or '(none)'}."}, status=400)

            return Response({"detail": f"Unsupported operation: {tool or '(none)'}."}, status=400)

        except RuntimeError as exc:
            # Tooling missing / conversion failed / timed out — a clean message.
            return Response({"detail": str(exc)}, status=422)
        except Exception:
            logger.exception("PDF tool job failed (type=%s)", tool)
            return Response({"detail": "Processing failed. Please try again."}, status=500)

    @staticmethod
    def _file(data: bytes, filename: str, content_type: str) -> HttpResponse:
        resp = HttpResponse(data, content_type=content_type)
        resp["Content-Disposition"] = f'attachment; filename="{filename}"'
        resp["Content-Length"] = str(len(data))
        return resp
