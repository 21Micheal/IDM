"""
apps/documents/webdav.py

Bug fixes in this revision (from log analysis)
───────────────────────────────────────────────

Bug 1 — LibreOffice 404 → "cannot create in directory" error
  LibreOffice probes the *collection* URL (no filename) before it touches
  the file URL:
      HEAD /webdav/<id>/          → was 404 (pattern required <filename>)
      GET  /webdav/<id>/          → was 404
  Seeing 404 on the parent collection, LibreOffice concludes the server
  doesn't support the location and refuses to save.

  Fix: dispatch() now tolerates a missing/empty filename and serves the
  document file for HEAD/GET/PROPFIND on the bare /<id>/ path. The URL
  pattern in urls.py is extended with a no-filename variant.

Bug 2 — Windows Word "password" dialog
  The 401 response included `WWW-Authenticate: Bearer realm="DocVault"`.
  Windows Office only understands Basic and NTLM challenges; it
  interprets an unknown scheme as "needs credentials" and shows a
  username/password dialog.

  Fix: return BOTH challenge types so Windows can fall back to Basic:
      WWW-Authenticate: Basic realm="DocVault", Bearer realm="DocVault"
  Also: _authenticate() now decodes the Authorization: Basic header —
  some clients encode the token as base64("token:") or base64("token:token")
  which is non-standard but what LibreOffice actually sends.

Bug 3 — Office Online / Microsoft viewer "ran into a problem"
  view.officeapps.live.com fetches the file URL directly. It cannot pass
  your JWT, so it hits the media endpoint and gets a 403 (or the Django
  auth middleware redirects it).

  Fix: preview_url in views.py now returns the WebDAV URL with the JWT
  embedded as ?token= instead of the raw media URL. Office Online is
  pointed at this WebDAV endpoint which already accepts token auth and
  serves the file as a plain GET.  See views.py → preview_url.

Supported HTTP methods
──────────────────────
OPTIONS, HEAD, GET, PROPFIND, LOCK, UNLOCK, PUT
"""
import base64
import hashlib
import logging
import uuid
from datetime import timedelta
from email.utils import formatdate

from django.core.files.base import ContentFile
from django.db import transaction
from django.http import HttpResponse
from django.utils import timezone
from django.utils.decorators import method_decorator
from django.views import View
from django.views.decorators.csrf import csrf_exempt

from rest_framework_simplejwt.exceptions import InvalidToken, TokenError
from rest_framework_simplejwt.tokens import AccessToken

from .models import Document, DocumentVersion
from apps.accounts.models import User

logger = logging.getLogger(__name__)

# ── In-process lock store ─────────────────────────────────────────────────────
# key: str(document_id)
# value: {"token": str, "user_id": str, "expires_at": datetime}
#
# Production note: replace with django.core.cache for multi-worker deployments.
_LOCKS: dict[str, dict] = {}


# ── Helpers ───────────────────────────────────────────────────────────────────

def _xml_response(body: str, status: int = 200) -> HttpResponse:
    return HttpResponse(
        body.strip(),
        content_type="application/xml; charset=utf-8",
        status=status,
    )


def _add_dav_headers(resp: HttpResponse) -> HttpResponse:
    """Standard DAV headers required on every response."""
    resp["DAV"] = "1, 2"
    resp["MS-Author-Via"] = "DAV"
    return resp


def _unauthorized() -> HttpResponse:
    """
    401 with BOTH Basic and Bearer challenges.

    Windows Office only understands Basic/NTLM.  Sending Bearer alone
    causes it to show a username/password dialog instead of using the
    token already embedded in the URL.  By listing Basic first, Office
    can fall back to it; we decode the Basic credentials in _authenticate()
    to recover the token.
    """
    resp = HttpResponse("Unauthorized", status=401)
    resp["WWW-Authenticate"] = 'Basic realm="DocVault", Bearer realm="DocVault"'
    return resp


# ── Main view ─────────────────────────────────────────────────────────────────

@method_decorator(csrf_exempt, name="dispatch")
class DocumentWebDAVView(View):
    """
    Minimal WebDAV handler for Microsoft Office and LibreOffice native
    edit-and-save via the ms-word:/ms-excel:/ms-powerpoint: URI schemes.

    URL patterns (in apps/documents/urls.py):
        path("webdav/<uuid:document_id>/",
             DocumentWebDAVView.as_view(), name="document-webdav-bare")
        path("webdav/<uuid:document_id>/<path:filename>",
             DocumentWebDAVView.as_view(), name="document-webdav")

    Note: <path:filename> instead of <str:filename> so filenames with
    spaces encoded as %20 or containing slashes are captured correctly.
    """

    http_method_names = [
        "options", "head", "get", "put",
        "propfind", "lock", "unlock",
    ]

    # ── Auth ──────────────────────────────────────────────────────────────

    def _authenticate(self, request) -> "User | None":
        """
        Extract a JWT from (in priority order):
          1. ?token= query parameter  — used by the Office URI scheme
          2. Authorization: Bearer <token>  header
          3. Authorization: Basic <b64>  header — LibreOffice and some
             Windows Office builds encode the token as the Basic password.
             We accept base64(":<token>"), base64("<token>:"),
             and base64("<token>:<token>").
        """
        token_str = request.GET.get("token", "").strip()

        if not token_str:
            auth_header = request.headers.get("Authorization", "")
            if auth_header.startswith("Bearer "):
                token_str = auth_header[7:].strip()
            elif auth_header.startswith("Basic "):
                try:
                    decoded = base64.b64decode(auth_header[6:]).decode("utf-8", errors="replace")
                    # Formats: "token:" or ":token" or "token:token"
                    parts = decoded.split(":", 1)
                    # Take whichever part looks like a JWT (contains two dots)
                    for part in parts:
                        if part.count(".") == 2:
                            token_str = part
                            break
                    if not token_str:
                        token_str = parts[0] or parts[-1]
                except Exception:
                    pass

        if not token_str:
            return None

        try:
            payload = AccessToken(token_str)
            user = User.objects.get(id=payload["user_id"])
            return user if user.is_active else None
        except (TokenError, InvalidToken, User.DoesNotExist, KeyError):
            return None

    def _get_doc(self, document_id) -> "Document | None":
        try:
            return (
                Document.objects
                .select_related("document_type", "uploaded_by")
                .get(id=document_id)
            )
        except Document.DoesNotExist:
            return None

    def _can(self, user: "User", doc: Document, action: str) -> bool:
        if user.is_admin:
            return True
        return action in user.get_all_permissions_for_doctype(str(doc.document_type_id))

    # ── Dispatch ──────────────────────────────────────────────────────────

    def dispatch(self, request, document_id, filename="", *args, **kwargs):
        """
        Authenticate on every request, then route to the correct handler.

        filename may be empty when LibreOffice probes the bare collection
        URL (/webdav/<id>/) — we treat that identically to the full URL.
        """
        method = request.method.lower()

        user = self._authenticate(request)
        if not user:
            return _unauthorized()

        doc = self._get_doc(document_id)
        if not doc:
            return HttpResponse("Not Found", status=404)

        request.dav_user = user
        request.dav_doc  = doc
        # Canonical href always uses the full filename URL for XML responses
        canonical_path = request.path
        if not filename and doc.file_name:
            from urllib.parse import quote
            canonical_path = canonical_path.rstrip("/") + "/" + quote(doc.file_name)
        request.dav_href = request.build_absolute_uri(canonical_path)

        handler = getattr(self, method, self.http_method_not_allowed)
        return handler(request, document_id, filename, *args, **kwargs)

    # ── OPTIONS ───────────────────────────────────────────────────────────

    def options(self, request, document_id, filename=""):
        resp = HttpResponse(status=200)
        resp["Allow"] = "OPTIONS, HEAD, GET, PUT, PROPFIND, LOCK, UNLOCK"
        _add_dav_headers(resp)
        return resp

    # ── HEAD ──────────────────────────────────────────────────────────────

    def head(self, request, document_id, filename=""):
        doc = request.dav_doc
        resp = HttpResponse(status=200)
        resp["Content-Length"]  = str(doc.file_size)
        resp["Content-Type"]    = doc.file_mime_type or "application/octet-stream"
        resp["Last-Modified"]   = formatdate(timeval=doc.updated_at.timestamp(), usegmt=True)
        resp["ETag"]            = f'"{doc.checksum[:16]}"'
        _add_dav_headers(resp)
        return resp

    # ── GET ───────────────────────────────────────────────────────────────

    def get(self, request, document_id, filename=""):
        doc  = request.dav_doc
        user = request.dav_user

        if not self._can(user, doc, "view"):
            return HttpResponse("Forbidden", status=403)

        try:
            content = doc.file.read()
        except Exception:
            return HttpResponse("File not found on storage", status=404)

        resp = HttpResponse(
            content,
            content_type=doc.file_mime_type or "application/octet-stream",
        )
        resp["Content-Disposition"] = f'attachment; filename="{doc.file_name}"'
        resp["Content-Length"]      = str(len(content))
        resp["Last-Modified"]       = formatdate(timeval=doc.updated_at.timestamp(), usegmt=True)
        resp["ETag"]                = f'"{doc.checksum[:16]}"'
        _add_dav_headers(resp)
        return resp

    # ── PROPFIND ──────────────────────────────────────────────────────────

    def propfind(self, request, document_id, filename=""):
        doc  = request.dav_doc
        user = request.dav_user

        if not self._can(user, doc, "view"):
            return HttpResponse("Forbidden", status=403)

        last_modified = formatdate(timeval=doc.updated_at.timestamp(), usegmt=True)

        lock_entry = _LOCKS.get(str(document_id))
        lock_xml   = ""
        if lock_entry and lock_entry["expires_at"] > timezone.now():
            lock_xml = f"""
        <D:lockdiscovery>
          <D:activelock>
            <D:locktype><D:write/></D:locktype>
            <D:lockscope><D:exclusive/></D:lockscope>
            <D:depth>0</D:depth>
            <D:timeout>Second-3600</D:timeout>
            <D:locktoken>
              <D:href>urn:uuid:{lock_entry["token"]}</D:href>
            </D:locktoken>
          </D:activelock>
        </D:lockdiscovery>"""

        # Escape filename for XML
        safe_name = doc.file_name.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")

        xml = f"""<?xml version="1.0" encoding="UTF-8"?>
<D:multistatus xmlns:D="DAV:">
  <D:response>
    <D:href>{request.dav_href}</D:href>
    <D:propstat>
      <D:prop>
        <D:displayname>{safe_name}</D:displayname>
        <D:getcontentlength>{doc.file_size}</D:getcontentlength>
        <D:getcontenttype>{doc.file_mime_type or "application/octet-stream"}</D:getcontenttype>
        <D:getlastmodified>{last_modified}</D:getlastmodified>
        <D:getetag>"{doc.checksum[:16]}"</D:getetag>
        <D:resourcetype/>
        <D:supportedlock>
          <D:lockentry>
            <D:lockscope><D:exclusive/></D:lockscope>
            <D:locktype><D:write/></D:locktype>
          </D:lockentry>
        </D:supportedlock>
        {lock_xml}
      </D:prop>
      <D:status>HTTP/1.1 200 OK</D:status>
    </D:propstat>
  </D:response>
</D:multistatus>"""

        resp = _xml_response(xml, status=207)
        _add_dav_headers(resp)
        return resp

    # ── LOCK ──────────────────────────────────────────────────────────────

    def lock(self, request, document_id, filename=""):
        doc  = request.dav_doc
        user = request.dav_user

        if not self._can(user, doc, "upload"):
            return HttpResponse("Forbidden", status=403)

        existing = _LOCKS.get(str(document_id))
        if (
            existing
            and existing["expires_at"] > timezone.now()
            and existing["user_id"] != str(user.id)
        ):
            return HttpResponse("Locked", status=423)

        lock_token = str(uuid.uuid4())
        _LOCKS[str(document_id)] = {
            "token":      lock_token,
            "user_id":    str(user.id),
            "expires_at": timezone.now() + timedelta(hours=1),
        }

        xml = f"""<?xml version="1.0" encoding="UTF-8"?>
<D:prop xmlns:D="DAV:">
  <D:lockdiscovery>
    <D:activelock>
      <D:locktype><D:write/></D:locktype>
      <D:lockscope><D:exclusive/></D:lockscope>
      <D:depth>0</D:depth>
      <D:owner><D:href>{user.email}</D:href></D:owner>
      <D:timeout>Second-3600</D:timeout>
      <D:locktoken>
        <D:href>urn:uuid:{lock_token}</D:href>
      </D:locktoken>
      <D:lockroot>
        <D:href>{request.dav_href}</D:href>
      </D:lockroot>
    </D:activelock>
  </D:lockdiscovery>
</D:prop>"""

        resp = _xml_response(xml, status=200)
        resp["Lock-Token"] = f"<urn:uuid:{lock_token}>"
        _add_dav_headers(resp)
        return resp

    # ── UNLOCK ────────────────────────────────────────────────────────────

    def unlock(self, request, document_id, filename=""):
        lock_token = (
            request.headers.get("Lock-Token", "")
            .strip("<>")
            .removeprefix("urn:uuid:")
        )
        existing = _LOCKS.get(str(document_id))
        if existing and existing.get("token") == lock_token:
            del _LOCKS[str(document_id)]
        resp = HttpResponse(status=204)
        _add_dav_headers(resp)
        return resp

    # ── PUT ───────────────────────────────────────────────────────────────

    def put(self, request, document_id, filename=""):
        """
        Receive the file saved by Office/LibreOffice and create a new
        DocumentVersion.

        Steps:
          1. Authenticate + authorise (upload permission required)
          2. Validate lock token if a lock exists
          3. Compute SHA-256; skip save if file is identical
          4. Create DocumentVersion row
          5. Update Document.file, checksum, current_version
          6. Release lock automatically
          7. Trigger async text extraction + search re-index
        """
        doc  = request.dav_doc
        user = request.dav_user

        if not self._can(user, doc, "upload"):
            return HttpResponse("Forbidden", status=403)

        # Validate lock ownership (non-fatal if no lock exists)
        existing_lock = _LOCKS.get(str(document_id))
        if existing_lock and existing_lock["expires_at"] > timezone.now():
            if_header   = request.headers.get("If", "")
            lock_header = request.headers.get("Lock-Token", "")
            token       = existing_lock["token"]
            owner_match = existing_lock["user_id"] == str(user.id)
            token_match = token in if_header or token in lock_header
            if not owner_match and not token_match:
                return HttpResponse("Locked", status=423)

        content = request.body
        if not content:
            return HttpResponse("No content provided", status=400)

        checksum = hashlib.sha256(content).hexdigest()
        if checksum == doc.checksum:
            # File unchanged — acknowledge without creating a new version
            return HttpResponse(status=204)

        new_version_number = doc.current_version + 1

        try:
            with transaction.atomic():
                version_file = ContentFile(content, name=doc.file_name)
                version = DocumentVersion(
                    document       = doc,
                    version_number = new_version_number,
                    file_name      = doc.file_name,
                    file_size      = len(content),
                    checksum       = checksum,
                    change_summary = "Saved from native application",
                    created_by     = user,
                )
                version.file.save(doc.file_name, version_file, save=False)
                version.save()

                doc_file = ContentFile(content, name=doc.file_name)
                doc.file.save(doc.file_name, doc_file, save=False)
                doc.file_size       = len(content)
                doc.checksum        = checksum
                doc.current_version = new_version_number
                doc.save(update_fields=[
                    "file", "file_size", "checksum", "current_version", "updated_at"
                ])

        except Exception as exc:
            logger.error("WebDAV PUT failed for %s: %s", document_id, exc, exc_info=True)
            return HttpResponse("Internal Server Error", status=500)

        _LOCKS.pop(str(document_id), None)

        try:
            from apps.documents.tasks import extract_text
            extract_text.delay(str(doc.id))
        except Exception:
            pass
        try:
            from apps.search.tasks import index_document
            index_document.delay(str(doc.id))
        except Exception:
            pass

        resp = HttpResponse(status=204)
        _add_dav_headers(resp)
        return resp