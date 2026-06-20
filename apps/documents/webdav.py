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
import logging
import uuid
from datetime import timedelta
from email.utils import formatdate
from urllib.parse import unquote, quote

from django.core.cache import cache
from django.core.files.base import ContentFile
from django.db import transaction
from django.http import HttpResponse
from django.utils import timezone
from django.utils.decorators import method_decorator
from django.views import View
from django.views.decorators.csrf import csrf_exempt

from rest_framework_simplejwt.exceptions import InvalidToken, TokenError
from rest_framework_simplejwt.tokens import AccessToken

from .file_streaming import user_can_edit_document
from .models import Document, DocumentVersion
from apps.accounts.models import User

logger = logging.getLogger(__name__)

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

    def _authenticate(self, request):
        """
        Fallback authenticator — only reached if the path-token in dispatch()
        didn't match (e.g. direct curl calls, browser-based WebDAV clients,
        or the bare collection URL with no token segment).

        LibreOffice / MS Office use the path-token in dispatch() exclusively.
        They must NOT reach this method, because they strip query strings and
        may drop Authorization headers after redirects — both would produce a
        401 that triggers the credential dialog.
        """
        auth_header = (
            request.META.get("HTTP_AUTHORIZATION", "")
            or request.META.get("REDIRECT_HTTP_AUTHORIZATION", "")
            or request.META.get("Authorization", "")
        )

        # 2. Bearer header (JWT only)
        if auth_header.startswith("Bearer "):
            user = self._try_jwt(auth_header[7:].strip())
            if user:
                return user

        # 3. Basic auth — password is the short opaque hex token stored in cache.
        #    We deliberately do NOT try JWT here: JWTs are 500+ chars with dots
        #    and LibreOffice/MS Office WebDAV clients mangle them when embedded
        #    in the URL netloc, causing truncation or encoding errors.
        if auth_header.startswith("Basic "):
            try:
                encoded_creds = auth_header[6:].strip()
                # Handle missing base64 padding gracefully
                padding = 4 - len(encoded_creds) % 4
                if padding != 4:
                    encoded_creds += "=" * padding
                decoded = base64.b64decode(encoded_creds).decode("utf-8", errors="replace")
                if ":" not in decoded:
                    logger.warning("WebDAV Basic auth: no colon in decoded credentials")
                    return None
                email, password = decoded.split(":", 1)
                email = unquote(email).strip()
                password = password.strip()

                logger.debug(
                    "WebDAV Basic auth attempt: email=%r token_len=%d path=%s",
                    email, len(password), request.path,
                )

                # Primary path: opaque hex token lookup in cache
                cache_key = f"webdav_edit_token:{password}"
                cached_data = cache.get(cache_key)
                if cached_data:
                    user = User.objects.filter(id=cached_data["user_id"]).first()
                    if user and user.email.lower() == email.lower():
                        # Slide the TTL forward on every successful request so
                        # long editing sessions don't lose auth mid-save.
                        cache.set(cache_key, cached_data, timeout=3600)
                        logger.debug("WebDAV auth OK via cache token: user=%s", user.email)
                        return user
                    logger.warning(
                        "WebDAV cache token found but email mismatch: "
                        "cached_user=%s presented_email=%r",
                        cached_data.get("user_id"), email,
                    )
                    return None

                # Fallback: direct password auth (for clients that don't use the token flow)
                user = User.objects.filter(email__iexact=email).first()
                if user and user.check_password(password):
                    logger.debug("WebDAV auth OK via password: user=%s", user.email)
                    return user

                logger.warning(
                    "WebDAV Basic auth failed: email=%r cache_miss=True password_ok=False token_len=%d",
                    email, len(password),
                )
            except Exception:
                logger.warning("WebDAV auth parse failed", exc_info=True)
                return None

        logger.debug(
            "WebDAV auth failed — no matching method: auth_header_prefix=%r path=%s",
            (auth_header[:30] + "...") if len(auth_header) > 30 else auth_header,
            request.path,
        )
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
        if not user:
            return False
        if action == "edit":
            return user_can_edit_document(user, doc)
        if user.has_admin_access:
            return True
        if getattr(doc, "is_self_upload", False) and (
            doc.uploaded_by_id == user.id or getattr(doc, "owned_by_id", None) == user.id
        ):
            return True

        permissions = user.get_all_permissions_for_doctype(
            str(doc.document_type_id),
            document=doc,
        )
        if action == "view":
            return bool(permissions)
        return action in permissions

    # ── Dispatch ───────────────────────────────────────────────────────────────

    _DAV_REALM = "DocVault"

    def dispatch(self, request, document_id, token="", filename="", *args, **kwargs):
        method = request.method.lower()

        # OPTIONS is always credential-free (pre-flight / capability probe).
        if method == "options":
            return self.options(request, document_id, filename)

        request.dav_doc_id = str(document_id)

        # ── Token-in-path authentication ──────────────────────────────────────
        # URL shape: /api/v1/documents/webdav/<doc_id>/<token>/<filename>
        #
        # The token is an opaque hex path segment, NOT a query string param.
        # LibreOffice (and MS Office) strip query strings from WebDAV URLs
        # after the initial request — ?token=... disappears on PROPFIND/LOCK/PUT,
        # causing a 401 → credential dialog. Path segments are forwarded
        # verbatim by every layer (ms-word:ofe|u|, vnd.sun.star.webdavs://,
        # nginx, Django) so the token survives all subsequent requests.
        #
        # Django URL pattern required (in documents/urls.py):
        #   path("webdav/<uuid:document_id>/<str:token>/<str:filename>",
        #        DocumentWebDAVView.as_view()),
        #   path("webdav/<uuid:document_id>/",          # bare collection probe
        #        DocumentWebDAVView.as_view()),

        # ── Token-in-path authentication ──────────────────────────────────────
        # The token is a path segment: /webdav/<doc_id>/<token>/<filename>
        # Path segments are forwarded verbatim by every layer (ms-word:ofe|u|,
        # vnd.sun.star.webdav://, curl, nginx) unlike netloc credentials and
        # query strings, which LibreOffice strips or discards after a 401.
        # Authenticating here means we never issue a 401 that triggers the
        # LibreOffice credential dialog.
        user = None
        read_only = False
        if token:
            cached = cache.get(f"webdav_edit_token:{token}")
            if cached and str(cached.get("document_id")) == str(document_id):
                try:
                    from apps.accounts.models import User as _User
                    candidate = _User.objects.get(id=cached["user_id"])
                    if candidate.is_active:
                        user = candidate
                        read_only = bool(cached.get("read_only"))
                        # Slide TTL forward on every request so long editing
                        # sessions don't lose auth after an hour.
                        cache.set(f"webdav_edit_token:{token}", cached, timeout=3600)
                        logger.debug(
                            "WebDAV path-token auth OK: user=%s doc=%s",
                            user.email, document_id,
                        )
                except Exception:
                    logger.warning(
                        "WebDAV path-token lookup failed for doc=%s", document_id,
                        exc_info=True,
                    )

        # ── Fallback: header-based auth (Basic / Bearer) ──────────────────────
        # Handles direct API callers, curl, and browser-based WebDAV clients.
        if user is None:
            user = self._authenticate(request)

        if not user:
            resp = HttpResponse(
                '<?xml version="1.0" encoding="UTF-8"?>'
                '<D:error xmlns:D="DAV:"><D:need-privileges/></D:error>',
                content_type="application/xml; charset=utf-8",
                status=401,
            )
            resp["WWW-Authenticate"] = f'Basic realm="{self._DAV_REALM}", charset="UTF-8"'
            return resp

        doc = self._get_doc(document_id)
        if not doc:
            return HttpResponse("Not Found", status=404)

        required = "view" if read_only else "edit"
        if not self._can(user, doc, required):
            return HttpResponse("Forbidden", status=403)
        # Read-only tokens may only use safe (non-writing) WebDAV methods.
        if read_only and method not in ("head", "get", "propfind"):
            return HttpResponse("Read-only", status=403)

        request.dav_user = user
        request.dav_doc  = doc
        request.dav_read_only = read_only
        # Use a host-agnostic ABSOLUTE-PATH href (no scheme/host) in every WebDAV
        # XML response (PROPFIND resources + LOCK lockroot). build_absolute_uri()
        # would embed request.get_host(), which behind a changeOrigin proxy is the
        # internal upstream (e.g. backend:8000) — a host the desktop editor can't
        # reach. The editor opens the file fine via direct GET, but then can't
        # resolve the LOCK root / save target and fails with "object cannot be
        # created in directory". An absolute path resolves against whatever origin
        # the editor actually opened (localhost:3000, ngrok, prod), so it's correct
        # under every proxy. request.path is URL-decoded, so re-encode it.
        request.dav_href = quote(request.path, safe="/")
        # Time each WebDAV request server-side. A save is ~7 round-trips
        # (OPTIONS/PROPFIND/LOCK/GET/PUT/PROPFIND/UNLOCK); logging per-request
        # server time lets you tell whether a slow save is spent in Django
        # (storage/broker/cache) or in the network + desktop WebDAV redirector
        # (IIS ARR, Windows WebClient, Word/LibreOffice), which the server can't
        # speed up. Compare the sum of these to the wall-clock save time.
        import time as _time
        _started = _time.monotonic()
        handler = getattr(self, method, self.http_method_not_allowed)
        try:
            return handler(request, document_id, filename, *args, **kwargs)
        finally:
            _elapsed_ms = (_time.monotonic() - _started) * 1000
            logger.info(
                "WebDAV %s doc=%s ro=%s -> %.0fms",
                method.upper(), document_id, read_only, _elapsed_ms,
            )

    # ── OPTIONS ────────────────────────────────────────────────────────────────

    def options(self, request, document_id, filename=""):
        resp = HttpResponse(status=200)
        resp["Allow"]         = "OPTIONS, HEAD, GET, PUT, PROPFIND, LOCK, UNLOCK"
        resp["DAV"]           = "1, 2"
        resp["MS-Author-Via"] = "DAV"
        resp["WWW-Authenticate"] = f'Basic realm="{self._DAV_REALM}", charset="UTF-8"'
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

        depth = request.headers.get("Depth", "infinity")
        if not filename:
            # Collection probe for the tokenized directory root. LibreOffice
            # expects a collection resource and a child listing for the file.
            file_href = f"{request.dav_href}{quote(doc.file_name, safe='')}"
            xml = f"""<?xml version="1.0" encoding="UTF-8"?>
<D:multistatus xmlns:D="DAV:">
  <D:response>
    <D:href>{request.dav_href}</D:href>
    <D:propstat>
      <D:prop>
        <D:displayname>{doc.file_name}</D:displayname>
        <D:resourcetype><D:collection/></D:resourcetype>
        <D:supportedlock>
          <D:lockentry>
            <D:lockscope><D:exclusive/></D:lockscope>
            <D:locktype><D:write/></D:locktype>
          </D:lockentry>
        </D:supportedlock>
      </D:prop>
      <D:status>HTTP/1.1 200 OK</D:status>
    </D:propstat>
  </D:response>"""
            if depth != "0":
                xml += f"""
  <D:response>
    <D:href>{file_href}</D:href>
    <D:propstat>
      <D:prop>
        <D:displayname>{doc.file_name}</D:displayname>
        <D:getcontentlength>{doc.file_size}</D:getcontentlength>
        <D:getcontenttype>{doc.file_mime_type or "application/octet-stream"}</D:getcontenttype>
        <D:getlastmodified>{formatdate(timeval=doc.updated_at.timestamp(), usegmt=True)}</D:getlastmodified>
        <D:getetag>"{doc.checksum[:16]}"</D:getetag>
        <D:resourcetype/>
        <D:supportedlock>
          <D:lockentry>
            <D:lockscope><D:exclusive/></D:lockscope>
            <D:locktype><D:write/></D:locktype>
          </D:lockentry>
        </D:supportedlock>
      </D:prop>
      <D:status>HTTP/1.1 200 OK</D:status>
    </D:propstat>
  </D:response>"""
            xml += "\n</D:multistatus>"
            return _xml_response(xml, status=207)

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
        if not self._can(user, doc, "edit"):
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
        resp["Lock-Token"]    = f"<urn:uuid:{token}>"
        resp["ETag"]          = f'"{doc.checksum[:16]}"'
        resp["Last-Modified"] = formatdate(timeval=doc.updated_at.timestamp(), usegmt=True)
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
          1. EDIT permission
          2. Application-level lock — requester must own it or it must be expired
          3. WebDAV protocol lock — honour the If/Lock-Token headers
          4. Checksum de-duplication — skip identical saves
          5. Atomic version creation + document update
          6. Refresh application-level lock TTL
          7. Queue Office→PDF preview regeneration + text re-indexing
        """
        doc  = request.dav_doc
        user = request.dav_user

        if not self._can(user, doc, "edit"):
            logger.warning(
                "WebDAV PUT denied (no edit permission): user=%s doc=%s",
                user.email, document_id,
            )
            return HttpResponse("Forbidden", status=403)

        # Application-level lock check
        if doc.is_edit_locked and doc.edit_lock_holder != user:
            holder = doc.edit_lock_holder
            logger.warning(
                "WebDAV PUT denied (locked by other): user=%s holder=%s doc=%s",
                user.email, getattr(holder, "email", None), document_id,
            )
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
                logger.warning(
                    "WebDAV PUT denied (protocol lock held by other session): "
                    "user=%s doc=%s", user.email, document_id,
                )
                return HttpResponse("Locked", status=423)

        # Read the raw PUT body. Prefer request.body (cached; safe if any
        # upstream middleware already buffered the stream), but fall back to a
        # streaming read() when the body exceeds settings.DATA_UPLOAD_MAX_MEMORY_SIZE
        # (2.5 MB by default), which would otherwise raise RequestDataTooBig and
        # fail every save of a larger document. On RequestDataTooBig the stream
        # has not been consumed yet, so read() can still pull the full body.
        from django.core.exceptions import RequestDataTooBig
        try:
            content = request.body
        except RequestDataTooBig:
            content = request.read()
        except Exception:
            logger.warning(
                "WebDAV PUT: could not read request body for %s", document_id,
                exc_info=True,
            )
            return HttpResponse("Bad Request", status=400)
        if not content:
            logger.warning(
                "WebDAV PUT: empty body for doc=%s (content_length=%s, transfer_encoding=%s)",
                document_id,
                request.META.get("CONTENT_LENGTH"),
                request.META.get("HTTP_TRANSFER_ENCODING"),
            )
            return HttpResponse("No content provided", status=400)

        checksum = hashlib.sha256(content).hexdigest()
        if checksum == doc.checksum:
            # Identical save — refresh lock TTL only
            doc.refresh_lock(user)
            return self._put_ok(doc)

        new_version = doc.current_version + 1

        import time as _time
        _t_write = _time.monotonic()
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
                # Use update() to avoid triggering save signals that queue ES indexing.
                # Indexing will happen via the scheduled task below.
                Document.objects.filter(id=doc.id).update(
                    file=doc.file.name,
                    file_size=len(content),
                    checksum=checksum,
                    current_version=new_version,
                    updated_at=timezone.now(),
                )
                # Refresh local instance to reflect DB state
                doc.refresh_from_db()

        except Exception as exc:
            logger.error(
                "WebDAV PUT failed for %s: %s", document_id, exc, exc_info=True
            )
            return HttpResponse("Internal Server Error", status=500)

        _write_ms = (_time.monotonic() - _t_write) * 1000

        # Refresh application-level lock TTL
        doc.refresh_lock(user)

        # Keep the WebDAV protocol lock alive for the rest of the editing session
        # (it is released on UNLOCK when the editor closes). Popping it here
        # desynced us from the editor's model: LibreOffice/Word hold ONE lock from
        # open to close and save repeatedly within it. After a pop, the editor's
        # post-save PROPFIND saw an empty <lockdiscovery> — its lock had vanished —
        # so neon re-polled to reconcile, producing the ~2s-spaced PROPFIND tail
        # that makes a save feel slow. Refresh the TTL instead so lockdiscovery
        # stays consistent and the editor's first post-save PROPFIND succeeds.
        proto = _PROTOCOL_LOCKS.get(str(document_id))
        if proto and proto.get("user_id") == str(user.id):
            proto["expires_at"] = timezone.now() + timedelta(hours=1)

        # Post-save fan-out: reset the Office→PDF preview and queue text
        # re-extraction / search indexing. These enqueue Celery jobs (a broker
        # publish) and must never block or fail the editor's save — a slow or
        # unreachable broker would otherwise stall every Ctrl+S. Best-effort and
        # timed so a slow broker shows up clearly in the logs.
        _t_post = _time.monotonic()
        try:
            if doc.is_office_doc():
                Document.objects.filter(id=doc.id).update(
                    preview_status="",
                    preview_pdf="",
                )
            from apps.search.indexing import schedule_document_search_pipeline
            schedule_document_search_pipeline(
                str(doc.id),
                reextract_content=True,
                index_immediately=True,
            )
        except Exception:
            logger.warning(
                "WebDAV PUT: post-save indexing/preview fan-out failed for %s "
                "(save itself succeeded)", document_id, exc_info=True,
            )
        _post_ms = (_time.monotonic() - _t_post) * 1000

        logger.info(
            "WebDAV PUT saved v%s doc=%s user=%s (%d bytes) write=%.0fms post=%.0fms",
            new_version, document_id, user.email, len(content), _write_ms, _post_ms,
        )

        return self._put_ok(doc)

    @staticmethod
    def _put_ok(doc) -> HttpResponse:
        """
        204 response for a successful save, carrying the new ETag and
        Last-Modified. Desktop editors (Word/LibreOffice via the Windows
        WebClient) otherwise can't learn the saved state from the PUT itself and
        fall back to a burst of confirmation PROPFINDs — the slow ~2s-spaced
        tail you see after every save. Echoing validators here lets the client
        accept the save immediately and skip (most of) that round-tripping.
        """
        resp = HttpResponse(status=204)
        resp["ETag"]          = f'"{doc.checksum[:16]}"'
        resp["Last-Modified"] = formatdate(timeval=doc.updated_at.timestamp(), usegmt=True)
        return resp
