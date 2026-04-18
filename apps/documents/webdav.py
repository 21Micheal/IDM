"""
apps/documents/webdav.py

Minimal WebDAV endpoint that lets Microsoft Office (Word, Excel, PowerPoint)
open and save documents directly from the DMS UI.

Office URI scheme flow
──────────────────────
1. Frontend builds:  ms-word:ofe|u|https://host/api/v1/documents/webdav/<id>/<name>?token=<jwt>
2. Office launches, sends PROPFIND  → we return file metadata (207)
3. Office sends LOCK               → we issue a lock token (200)
4. Office sends GET                → we serve the current file body
5. User edits and saves
6. Office sends PUT                → we create a new DocumentVersion (204)
7. Office sends UNLOCK             → we release the lock (204)

Authentication
──────────────
Office URI schemes cannot set custom headers, so the JWT access token is
passed as the `?token=` query parameter on every request.  The token is
validated on every dispatch before any handler runs.

Lock storage
────────────
Locks are kept in a module-level dict.  For a single-server deployment this
is sufficient.  For multi-process / multi-server deployments replace with a
Django cache call (e.g. cache.set / cache.get with a short TTL).

Supported HTTP methods
──────────────────────
OPTIONS, HEAD, GET, PROPFIND, LOCK, UNLOCK, PUT
"""
import hashlib
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

# ── In-process lock store ─────────────────────────────────────────────────────
# key: str(document_id)
# value: {"token": str, "user_id": str, "expires_at": datetime}
#
# Production note: replace with django.core.cache for multi-worker deployments.
_LOCKS: dict[str, dict] = {}


# ── Helper: XML response ──────────────────────────────────────────────────────

def _xml_response(body: str, status: int = 200) -> HttpResponse:
    return HttpResponse(body.strip(), content_type="application/xml; charset=utf-8", status=status)


# ── Main view ─────────────────────────────────────────────────────────────────

@method_decorator(csrf_exempt, name="dispatch")
class DocumentWebDAVView(View):
    """
    Minimal WebDAV handler for Microsoft Office native edit-and-save.

    URL pattern (added to apps/documents/urls.py):
        path("webdav/<uuid:document_id>/<str:filename>",
             DocumentWebDAVView.as_view(), name="document-webdav")
    """

    http_method_names = [
        "options", "head", "get", "put",
        "propfind", "lock", "unlock",
    ]

    # ── Auth + document lookup ─────────────────────────────────────────────

    def _authenticate(self, request) -> User | None:
        # Accept token from query param (Office URI scheme) or Authorization header
        token_str = (
            request.GET.get("token")
            or request.headers.get("Authorization", "").removeprefix("Bearer ").strip()
        )
        if not token_str:
            return None
        try:
            payload = AccessToken(token_str)
            user = User.objects.get(id=payload["user_id"])
            return user if user.is_active else None
        except (TokenError, InvalidToken, User.DoesNotExist, KeyError):
            return None

    def _get_doc(self, document_id) -> Document | None:
        try:
            return (
                Document.objects
                .select_related("document_type", "uploaded_by")
                .get(id=document_id)
            )
        except Document.DoesNotExist:
            return None

    def _can(self, user: User, doc: Document, action: str) -> bool:
        if user.is_admin:
            return True
        return action in user.get_all_permissions_for_doctype(str(doc.document_type_id))

    # ── Dispatch: authenticate on every request ────────────────────────────

    def dispatch(self, request, document_id, filename, *args, **kwargs):
        # Handle non-standard WebDAV methods that Django doesn't route by default
        method = request.method.lower()
        if method in ("propfind", "lock", "unlock"):
            handler = getattr(self, method, self.http_method_not_allowed)
        else:
            handler = getattr(self, method, self.http_method_not_allowed)

        user = self._authenticate(request)
        if not user:
            resp = HttpResponse("Unauthorized", status=401)
            resp["WWW-Authenticate"] = 'Bearer realm="DocVault"'
            return resp

        doc = self._get_doc(document_id)
        if not doc:
            return HttpResponse("Not Found", status=404)

        # Stash on request for handlers
        request.dav_user = user
        request.dav_doc = doc

        # Build the canonical href once
        request.dav_href = request.build_absolute_uri(request.path)

        return handler(request, document_id, filename, *args, **kwargs)

    # ── OPTIONS ───────────────────────────────────────────────────────────

    def options(self, request, document_id, filename):
        resp = HttpResponse(status=200)
        resp["Allow"] = "OPTIONS, HEAD, GET, PUT, PROPFIND, LOCK, UNLOCK"
        resp["DAV"] = "1, 2"
        resp["MS-Author-Via"] = "DAV"
        return resp

    # ── HEAD ──────────────────────────────────────────────────────────────

    def head(self, request, document_id, filename):
        doc = request.dav_doc
        resp = HttpResponse(status=200)
        resp["Content-Length"] = str(doc.file_size)
        resp["Content-Type"] = doc.file_mime_type or "application/octet-stream"
        resp["Last-Modified"] = formatdate(timeval=doc.updated_at.timestamp(), usegmt=True)
        resp["ETag"] = f'"{doc.checksum[:16]}"'
        resp["DAV"] = "1, 2"
        return resp

    # ── GET ───────────────────────────────────────────────────────────────

    def get(self, request, document_id, filename):
        doc = request.dav_doc
        user = request.dav_user

        if not self._can(user, doc, "view"):
            return HttpResponse("Forbidden", status=403)

        try:
            content = doc.file.read()
        except Exception:
            return HttpResponse("File not found on storage", status=404)

        resp = HttpResponse(content, content_type=doc.file_mime_type or "application/octet-stream")
        resp["Content-Disposition"] = f'attachment; filename="{doc.file_name}"'
        resp["Content-Length"] = str(len(content))
        resp["Last-Modified"] = formatdate(timeval=doc.updated_at.timestamp(), usegmt=True)
        resp["ETag"] = f'"{doc.checksum[:16]}"'
        return resp

    # ── PROPFIND ──────────────────────────────────────────────────────────

    def propfind(self, request, document_id, filename):
        doc = request.dav_doc
        user = request.dav_user

        if not self._can(user, doc, "view"):
            return HttpResponse("Forbidden", status=403)

        last_modified = formatdate(timeval=doc.updated_at.timestamp(), usegmt=True)

        # Build lock-discovery block if an active lock exists
        lock_entry = _LOCKS.get(str(document_id))
        lock_xml = ""
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

        xml = f"""<?xml version="1.0" encoding="UTF-8"?>
<D:multistatus xmlns:D="DAV:">
  <D:response>
    <D:href>{request.dav_href}</D:href>
    <D:propstat>
      <D:prop>
        <D:displayname>{doc.file_name}</D:displayname>
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

        return _xml_response(xml, status=207)

    # ── LOCK ──────────────────────────────────────────────────────────────

    def lock(self, request, document_id, filename):
        doc = request.dav_doc
        user = request.dav_user

        if not self._can(user, doc, "upload"):
            return HttpResponse("Forbidden", status=403)

        # Reject if another user already holds an active lock
        existing = _LOCKS.get(str(document_id))
        if (
            existing
            and existing["expires_at"] > timezone.now()
            and existing["user_id"] != str(user.id)
        ):
            return HttpResponse("Locked", status=423)

        lock_token = str(uuid.uuid4())
        _LOCKS[str(document_id)] = {
            "token": lock_token,
            "user_id": str(user.id),
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
        return resp

    # ── UNLOCK ────────────────────────────────────────────────────────────

    def unlock(self, request, document_id, filename):
        lock_token = (
            request.headers.get("Lock-Token", "")
            .strip("<>")
            .removeprefix("urn:uuid:")
        )
        existing = _LOCKS.get(str(document_id))
        if existing and existing.get("token") == lock_token:
            del _LOCKS[str(document_id)]
        return HttpResponse(status=204)

    # ── PUT ───────────────────────────────────────────────────────────────

    def put(self, request, document_id, filename):
        """
        Receive a file saved by Office and create a new DocumentVersion.

        Steps:
          1. Authenticate + authorise (upload permission required)
          2. Validate lock token if a lock exists
          3. Compute SHA-256; skip if identical to current version
          4. Create DocumentVersion row
          5. Update Document.file, checksum, current_version
          6. Release lock
          7. Trigger async text extraction + search reindex
        """
        doc = request.dav_doc
        user = request.dav_user

        if not self._can(user, doc, "upload"):
            return HttpResponse("Forbidden", status=403)

        # Validate lock ownership
        existing_lock = _LOCKS.get(str(document_id))
        if existing_lock and existing_lock["expires_at"] > timezone.now():
            if_header   = request.headers.get("If", "")
            lock_header = request.headers.get("Lock-Token", "")
            token = existing_lock["token"]
            requester_owns_lock = existing_lock["user_id"] == str(user.id)
            token_presented = token in if_header or token in lock_header
            if not requester_owns_lock and not token_presented:
                return HttpResponse("Locked", status=423)

        content = request.body
        if not content:
            return HttpResponse("No content provided", status=400)

        # Integrity check — skip if the file hasn't changed
        checksum = hashlib.sha256(content).hexdigest()
        if checksum == doc.checksum:
            return HttpResponse(status=204)

        new_version_number = doc.current_version + 1

        try:
            with transaction.atomic():
                # ── 1. Create the version record (stored in versions/ dir) ──
                version_file = ContentFile(content, name=doc.file_name)
                version = DocumentVersion(
                    document       = doc,
                    version_number = new_version_number,
                    file_name      = doc.file_name,
                    file_size      = len(content),
                    checksum       = checksum,
                    change_summary = f"Saved from native application",
                    created_by     = user,
                )
                version.file.save(doc.file_name, version_file, save=False)
                version.save()

                # ── 2. Bump the main Document to the new version ──────────
                doc_file = ContentFile(content, name=doc.file_name)
                doc.file.save(doc.file_name, doc_file, save=False)
                doc.file_size      = len(content)
                doc.checksum       = checksum
                doc.current_version = new_version_number
                doc.save(update_fields=["file", "file_size", "checksum", "current_version", "updated_at"])

        except Exception as exc:
            import logging
            logging.getLogger(__name__).error("WebDAV PUT failed for %s: %s", document_id, exc)
            return HttpResponse("Internal Server Error", status=500)

        # ── 3. Release the lock ────────────────────────────────────────────
        _LOCKS.pop(str(document_id), None)

        # ── 4. Async background tasks ──────────────────────────────────────
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

        return HttpResponse(status=204)
