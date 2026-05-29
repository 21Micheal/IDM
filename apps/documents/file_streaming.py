"""
Signed, authenticated document file streaming.

Media files are not exposed via anonymous /media URLs in API responses;
clients use GET /documents/{id}/file/ with JWT or a short-lived ?sig= link.
"""
from __future__ import annotations

import json
import mimetypes
from typing import Any

from django.core.files.storage import default_storage
from django.core.signing import BadSignature, TimestampSigner
from django.db import models
from django.http import HttpResponse
from django.utils import timezone
from django.utils.http import content_disposition_header

from apps.accounts.models import GroupAction, User
from apps.documents.models import DMSSettings, Document, DocumentShare, DocumentVersion
from apps.workflows.models import WorkflowTask

SIGN_SALT = "idm.document-file"
SIGN_MAX_AGE = 30 * 60  # 30 minutes


def signed_file_urls_enabled() -> bool:
    return DMSSettings.load().signed_file_urls_enabled


def user_can_view_document(user: User, doc: Document) -> bool:
    if not user or not user.is_authenticated:
        return False
    if user.has_admin_access:
        return True
    if getattr(doc, "is_self_upload", False):
        return doc.uploaded_by_id == user.id or getattr(doc, "owned_by_id", None) == user.id
    document_type_id = str(getattr(doc, "document_type_id", None) or "")
    if not document_type_id:
        return False
    if doc.uploaded_by_id == user.id or getattr(doc, "owned_by_id", None) == user.id:
        return True
    if WorkflowTask.objects.filter(
        assigned_to=user,
        workflow_instance__document_id=doc.id,
        status__in=["pending", "in_progress", "held", "returned"],
    ).exists():
        return True
    if DocumentShare.objects.filter(
        document=doc,
        recipient=user,
        revoked_at__isnull=True,
    ).filter(
        models.Q(expires_at__isnull=True) | models.Q(expires_at__gt=timezone.now())
    ).exists():
        return True
    perms = user.get_all_permissions_for_doctype(document_type_id)
    return GroupAction.VIEW.value in perms


def user_can_download_document(user: User, doc: Document) -> bool:
    if not user or not user.is_authenticated:
        return False
    if user.has_admin_access:
        return True
    if getattr(doc, "is_self_upload", False):
        return doc.uploaded_by_id == user.id or getattr(doc, "owned_by_id", None) == user.id
    if DocumentShare.objects.filter(
        document=doc,
        recipient=user,
        access_level=DocumentShare.AccessLevel.DOWNLOAD,
        revoked_at__isnull=True,
    ).filter(
        models.Q(expires_at__isnull=True) | models.Q(expires_at__gt=timezone.now())
    ).exists():
        return True
    document_type_id = str(getattr(doc, "document_type_id", None) or "")
    if not document_type_id:
        return False
    perms = user.get_all_permissions_for_doctype(document_type_id)
    return GroupAction.DOWNLOAD.value in perms


def user_can_edit_document(user: User, doc: Document) -> bool:
    if not user or not user.is_authenticated:
        return False
    if user.has_admin_access:
        return True
    if getattr(doc, "is_self_upload", False):
        return doc.uploaded_by_id == user.id or getattr(doc, "owned_by_id", None) == user.id
    document_type_id = str(getattr(doc, "document_type_id", None) or "")
    if not document_type_id:
        return False
    perms = user.get_all_permissions_for_doctype(document_type_id)
    return GroupAction.EDIT.value in perms


def version_preview_storage_name(version_id: str) -> str:
    return f"previews/versions/{version_id}_preview.pdf"


def build_file_signature_payload(
    *,
    user_id: str,
    document_id: str,
    version_id: str,
    use_preview: bool,
    disposition: str,
) -> dict[str, Any]:
    return {
        "sub": user_id,
        "doc": document_id,
        "ver": version_id or "",
        "preview": bool(use_preview),
        "disp": disposition if disposition in ("inline", "attachment") else "inline",
    }


def sign_file_payload(payload: dict[str, Any]) -> str:
    signer = TimestampSigner(salt=SIGN_SALT)
    compact = json.dumps(payload, separators=(",", ":"), sort_keys=True)
    return signer.sign(compact)


def unsign_file_payload(token: str) -> dict[str, Any]:
    signer = TimestampSigner(salt=SIGN_SALT)
    raw = signer.unsign(token, max_age=SIGN_MAX_AGE)
    data = json.loads(raw)
    if not isinstance(data, dict):
        raise BadSignature("Malformed payload")
    return data


def verify_file_query_matches_payload(request, payload: dict[str, Any]) -> bool:
    ver = (request.query_params.get("version_id") or "").strip()
    use_preview = str(request.query_params.get("use_preview", "0")).lower() in ("1", "true", "yes")
    disp = (request.query_params.get("disposition") or "inline").strip()
    if disp not in ("inline", "attachment"):
        disp = "inline"
    return (
        payload.get("ver", "") == ver
        and bool(payload.get("preview")) is use_preview
        and payload.get("disp", "inline") == disp
    )


def read_document_bytes(
    doc: Document,
    *,
    version: DocumentVersion | None,
    use_preview: bool,
) -> tuple[bytes, str, str]:
    """
    Returns (content_bytes, content_type, filename_for_download).
    """
    if version:
        if use_preview:
            preview_name = version_preview_storage_name(str(version.id))
            if not default_storage.exists(preview_name):
                raise FileNotFoundError("version preview not available")
            with default_storage.open(preview_name, "rb") as fh:
                raw = fh.read()
            return raw, "application/pdf", f"v{version.version_number}-preview.pdf"

        if not version.file:
            raise FileNotFoundError("version file missing")
        with version.file.open("rb") as fh:
            raw = fh.read()
        mime = mimetypes.guess_type(version.file_name or "")[0] or "application/octet-stream"
        return raw, mime, version.file_name or "file"

    if use_preview:
        if not doc.preview_pdf:
            raise FileNotFoundError("document preview not available")
        with doc.preview_pdf.open("rb") as fh:
            raw = fh.read()
        return raw, "application/pdf", "preview.pdf"

    if not doc.file:
        raise FileNotFoundError("document file missing")
    with doc.file.open("rb") as fh:
        raw = fh.read()
    mime = doc.file_mime_type or mimetypes.guess_type(doc.file_name or "")[0] or "application/octet-stream"
    return raw, mime, doc.file_name or "file"


def build_http_file_response(
    *,
    raw: bytes,
    content_type: str,
    download_name: str,
    disposition: str,
) -> HttpResponse:
    body = raw
    out_type = content_type

    disp = content_disposition_header(disposition == "attachment", download_name)
    resp = HttpResponse(body, content_type=out_type)
    if disp:
        resp["Content-Disposition"] = disp
    resp["Cache-Control"] = "private, no-store"
    resp["Pragma"] = "no-cache"
    resp["Expires"] = "0"
    resp["X-Content-Type-Options"] = "nosniff"
    return resp


def build_absolute_document_file_url(
    request,
    doc: Document,
    *,
    version_id: str = "",
    use_preview: bool = False,
    disposition: str = "inline",
) -> str:
    """URL for GET .../documents/{id}/file/.

    When signed file URLs are disabled, callers receive the same endpoint
    without a query signature and must send normal Authorization headers.
    """
    from django.urls import reverse
    from urllib.parse import urlencode

    disp = disposition if disposition in ("inline", "attachment") else "inline"
    params = {
        "version_id": version_id or "",
        "use_preview": "1" if use_preview else "0",
        "disposition": disp,
    }
    if signed_file_urls_enabled():
        payload = build_file_signature_payload(
            user_id=str(request.user.id),
            document_id=str(doc.id),
            version_id=version_id or "",
            use_preview=use_preview,
            disposition=disp,
        )
        params["sig"] = sign_file_payload(payload)
    q = urlencode(params)
    rel = reverse("document-file", kwargs={"pk": str(doc.id)})
    return request.build_absolute_uri(f"{rel}?{q}")
