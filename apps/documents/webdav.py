"""
apps/documents/webdav.py

Fixes in this revision
────────────────────────
1. dispatch() — `filename` parameter is now optional (default "").
   The bare /<id>/ URL pattern (added for LibreOffice collection probes) does
   not capture a filename; the previous required parameter caused a TypeError
   for every HEAD/PROPFIND on the collection URL.

2. _authenticate() — no functional change; comments clarified.

3. PUT handler — no functional change; comment clarified that LibreOffice and
   MS Office save *directly* back to this endpoint (no temp-file watching
   needed in the launcher scripts).
"""
import base64
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

# In-process WebDAV protocol-level lock store (per-session, not application lock)
_PROTOCOL_LOCKS: dict[str, dict] = {}


def _xml_response(body: str, status: int = 200) -> HttpResponse:
    return HttpResponse(
        body.strip(), content_type="application/xml; charset=utf-8", status=status
    )


@method_decorator(csrf_exempt, name="dispatch")
class DocumentWebDAVView(View):
    http_method_names = ["options", "head", "get", "put", "propfind", "lock", "unlock"]

    # ── Authentication ─────────────────────────────────────────────────────────

    def _authenticate(self, request) -> "User | None":
        """
        Accept three credential forms (in priority order):

        A) JWT in ?token= query param       — used by launcher scripts & MS Office
        B) Authorization: Bearer <jwt>      — standard header
        C) Authorization: Basic <b64>       — LibreOffice native WebDAV prompt
           (email : one-time-token stored in Django cache)

        The cache token is NOT consumed on first use because LibreOffice makes
        4–5 sequential requests per editing session.  It expires after 1 hour.
        """
        from django.core.cache import cache

        auth_header = request.headers.get("Authorization", "")

        # ── A: JWT in query string ─────────────────────────────────────────
        qs_token = request.GET.get("token", "").strip()
        if qs_token:
            user = self._try_jwt(qs_token)
            if user:
                return user
            doc_id = getattr(request, "dav_doc_id", None)
            user = self._try_cache_token(qs_token, doc_id, cache)
            if user:
                return user

        # ── B: Bearer header ───────────────────────────────────────────────
        if auth_header.startswith("Bearer "):
            user = self._try_jwt(auth_header[7:].strip())
            if user:
                return user

        # ── C: Basic Auth ──────────────────────────────────────────────────
        if auth_header.startswith("Basic "):
            try:
                decoded   = base64.b64decode(auth_header[6:]).decode("utf-8", errors="replace")
                colon_pos = decoded.find(":")
                if colon_pos == -1:
                    return None
                email    = decoded[:colon_pos]
                ot_token = decoded[colon_pos + 1:]

                cache_key = f"webdav_edit_token:{ot_token}"
                cached    = cache.get(cache_key)
                if not cached:
                    return None

                try:
                    user = User.objects.get(id=cached["user_id"])
                except User.DoesNotExist:
                    return None

                if user.email.lower() != email.lower():
                    return None

                return user if user.is_active else None

            except Exception:
                return None

        return None

    @staticmethod
    def _try_jwt(token_str: str) -> "User | None":
        try:
            payload = AccessToken(token_str)
            user    = User.objects.get(id=payload["user_id"])
            return user if user.is_active else None
        except (TokenError, InvalidToken, User.DoesNotExist, KeyError):
            return None

    @staticmethod
    def _try_cache_token(token_str: str, document_id, cache) -> "User | None":
        from django.core.cache import cache as django_cache
        _cache = cache or django_cache
        cached = _cache.get(f"webdav_edit_token:{token_str}")
        if not cached:
            return None
        if document_id and str(cached.get("document_id")) != str(document_id):
            return None
        try:
            user = User.objects.get(id=cached["user_id"])
            return user if user.is_active else None
        except User.DoesNotExist:
            return None

    def _get_doc(self, document_id) -> "Document | None":
        try:
            return Document.objects.select_related(
                "document_type", "uploaded_by", "edit_locked_by"
            ).get(id=document_id)
        except Document.DoesNotExist:
            return None

    def _can(self, user: User, doc: Document, action: str) -> bool:
        """
        Check if the user may perform `action` on `doc`.
        Uploader of a self-upload doc has full access regardless of group permissions.
        """
        if user.is_admin:
            return True
        if doc.is_self_upload and doc.uploaded_by_id == user.id:
            return True
        return action in user.get_all_permissions_for_doctype(str(doc.document_type_id))

    # ── Dispatch ───────────────────────────────────────────────────────────────

    def dispatch(self, request, document_id, filename="", *args, **kwargs):
        """
        `filename` is optional so that the bare collection URL
        (webdav/<id>/) does not raise a TypeError.
        LibreOffice probes the collection URL with HEAD / PROPFIND before
        issuing requests against the actual file URL.
        """
        method  = request.method.lower()
        handler = getattr(self, method, self.http_method_not_allowed)

        request.dav_doc_id = str(document_id)

        user = self._authenticate(request)
        if not user:
            resp = HttpResponse("Unauthorized", status=401)
            resp["WWW-Authenticate"] = (
                'Basic realm="DocVault WebDAV", '
                'Bearer realm="DocVault"'
            )
            return resp

        doc = self._get_doc(document_id)
        if not doc:
            return HttpResponse("Not Found", status=404)

        request.dav_user = user
        request.dav_doc  = doc
        request.dav_href = request.build_absolute_uri(request.path)
        return handler(request, document_id, filename, *args, **kwargs)

    # ── OPTIONS ────────────────────────────────────────────────────────────────

    def options(self, request, document_id, filename=""):
        resp = HttpResponse(status=200)
        resp["Allow"]         = "OPTIONS, HEAD, GET, PUT, PROPFIND, LOCK, UNLOCK"
        resp["DAV"]           = "1, 2"
        resp["MS-Author-Via"] = "DAV"
        return resp

    # ── HEAD ───────────────────────────────────────────────────────────────────

    def head(self, request, document_id, filename=""):
        doc = request.dav_doc
        resp = HttpResponse(status=200)
        resp["Content-Length"] = str(doc.file_size)
        resp["Content-Type"]   = doc.file_mime_type or "application/octet-stream"
        resp["Last-Modified"]  = formatdate(timeval=doc.updated_at.timestamp(), usegmt=True)
        resp["ETag"]           = f'"{doc.checksum[:16]}"'
        resp["DAV"]            = "1, 2"
        return resp

    # ── GET ────────────────────────────────────────────────────────────────────

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
        return resp

    # ── PROPFIND ───────────────────────────────────────────────────────────────

    def propfind(self, request, document_id, filename=""):
        doc  = request.dav_doc
        user = request.dav_user
        if not self._can(user, doc, "view"):
            return HttpResponse("Forbidden", status=403)

        last_modified = formatdate(timeval=doc.updated_at.timestamp(), usegmt=True)
        lock_entry    = _PROTOCOL_LOCKS.get(str(document_id))
        lock_xml      = ""
        if lock_entry and lock_entry["expires_at"] > timezone.now():
            lock_xml = f"""
        <D:lockdiscovery>
          <D:activelock>
            <D:locktype><D:write/></D:locktype>
            <D:lockscope><D:exclusive/></D:lockscope>
            <D:depth>0</D:depth>
            <D:timeout>Second-3600</D:timeout>
            <D:locktoken><D:href>urn:uuid:{lock_entry["token"]}</D:href></D:locktoken>
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

    # ── LOCK ───────────────────────────────────────────────────────────────────

    def lock(self, request, document_id, filename=""):
        doc  = request.dav_doc
        user = request.dav_user
        if not self._can(user, doc, "upload"):
            return HttpResponse("Forbidden", status=403)

        existing = _PROTOCOL_LOCKS.get(str(document_id))
        if (
            existing
            and existing["expires_at"] > timezone.now()
            and existing["user_id"] != str(user.id)
        ):
            return HttpResponse("Locked", status=423)

        token = str(uuid.uuid4())
        _PROTOCOL_LOCKS[str(document_id)] = {
            "token":      token,
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
      <D:locktoken><D:href>urn:uuid:{token}</D:href></D:locktoken>
      <D:lockroot><D:href>{request.dav_href}</D:href></D:lockroot>
    </D:activelock>
  </D:lockdiscovery>
</D:prop>"""
        resp = _xml_response(xml, status=200)
        resp["Lock-Token"] = f"<urn:uuid:{token}>"
        return resp

    # ── UNLOCK ─────────────────────────────────────────────────────────────────

    def unlock(self, request, document_id, filename=""):
        """
        Release the WebDAV protocol lock AND the application-level edit lock.
        Called by LibreOffice / MS Office when the user closes the file.
        """
        lock_token = (
            request.headers.get("Lock-Token", "")
            .strip("<>")
            .removeprefix("urn:uuid:")
        )
        existing = _PROTOCOL_LOCKS.get(str(document_id))
        if existing and existing.get("token") == lock_token:
            del _PROTOCOL_LOCKS[str(document_id)]

        doc = request.dav_doc
        doc.release_lock(user=request.dav_user)

        return HttpResponse(status=204)

    # ── PUT ─────────────────────────────────────────────────────────────────────

    def put(self, request, document_id, filename=""):
        """
        Accept a file save from the desktop editor and create a new DocumentVersion.

        LibreOffice and MS Office, when opened against a WebDAV URL, send PUT
        requests directly to this endpoint on every Ctrl+S save.  No launcher
        script file-watching is required — the editor handles WebDAV natively.

        Checks performed:
          1. UPLOAD permission
          2. Application-level lock — requester must own it or it must be expired
          3. WebDAV protocol lock — honour the If/Lock-Token headers
          4. Checksum de-duplication — skip identical saves
          5. Atomic version creation + document update
          6. Refresh application-level lock TTL
          7. Queue Office→PDF preview regeneration + text re-indexing
        """
        doc  = request.dav_doc
        user = request.dav_user

        if not self._can(user, doc, "upload"):
            return HttpResponse("Forbidden", status=403)

        # Application-level lock check
        if doc.is_edit_locked and doc.edit_lock_holder != user:
            holder = doc.edit_lock_holder
            return HttpResponse(
                f"423 Locked by {holder.get_full_name() if holder else 'another user'}",
                status=423,
            )

        # WebDAV protocol lock check
        proto_lock = _PROTOCOL_LOCKS.get(str(document_id))
        if proto_lock and proto_lock["expires_at"] > timezone.now():
            if_header   = request.headers.get("If", "")
            lock_header = request.headers.get("Lock-Token", "")
            tok = proto_lock["token"]
            if proto_lock["user_id"] != str(user.id) and tok not in if_header and tok not in lock_header:
                return HttpResponse("Locked", status=423)

        content = request.body
        if not content:
            return HttpResponse("No content provided", status=400)

        checksum = hashlib.sha256(content).hexdigest()
        if checksum == doc.checksum:
            # Identical save — refresh lock TTL only
            doc.refresh_lock(user)
            return HttpResponse(status=204)

        new_version = doc.current_version + 1

        try:
            with transaction.atomic():
                version_file = ContentFile(content, name=doc.file_name)
                version      = DocumentVersion(
                    document       = doc,
                    version_number = new_version,
                    file_name      = doc.file_name,
                    file_size      = len(content),
                    checksum       = checksum,
                    change_summary = "Saved from desktop editor",
                    created_by     = user,
                )
                version.file.save(doc.file_name, version_file, save=False)
                version.save()

                doc_file = ContentFile(content, name=doc.file_name)
                doc.file.save(doc.file_name, doc_file, save=False)
                doc.file_size       = len(content)
                doc.checksum        = checksum
                doc.current_version = new_version
                doc.save(update_fields=[
                    "file", "file_size", "checksum", "current_version", "updated_at"
                ])

        except Exception as exc:
            import logging
            logging.getLogger(__name__).error(
                "WebDAV PUT failed for %s: %s", document_id, exc
            )
            return HttpResponse("Internal Server Error", status=500)

        # Refresh application-level lock TTL
        doc.refresh_lock(user)

        # Release WebDAV protocol lock (editor re-locks on next save if needed)
        _PROTOCOL_LOCKS.pop(str(document_id), None)

        # Re-generate Office PDF preview
        if doc.is_office_doc():
            from .models import PreviewStatus
            Document.objects.filter(id=doc.id).update(
                preview_status="",
                preview_pdf="",
            )

        # Re-index for search
        try:
            from apps.search.tasks import index_document
            index_document.delay(str(doc.id))
        except Exception:
            pass

        return HttpResponse(status=204)