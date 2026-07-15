"""
apps/documents/graph_client.py

A thin client for reading inbound mail from a Microsoft 365 / Outlook mailbox
over the Microsoft Graph API, as an alternative to IMAP.

Why this layer exists
──────────────────────
Mirrors :mod:`apps.documents.imap_client`: every Graph interaction funnels
through one client exposing the same small surface the ingestion code needs
(``test_connection`` / ``iter_messages`` / ``highest_received``). Because Graph
can return each message's raw RFC-822 MIME (``/messages/{id}/$value``), the
ingestion logic in :mod:`apps.documents.email_ingestion` parses Graph messages
exactly like IMAP ones — only the connector and the cursor differ.

Authentication
──────────────
App-only (daemon) access via the OAuth2 *client credentials* flow, the same
grant :mod:`apps.documents.ion_client` uses for ION:

    tenant_id     → Azure AD directory (tenant) id
    client_id     → app registration's application (client) id
    client_secret → a client secret on that app registration
    mailbox       → the target user principal name / email to read
    folder        → well-known folder name (default "inbox")

The app registration needs the **application** permission ``Mail.Read`` (or
``Mail.ReadWrite``) with admin consent. Tokens are requested for the
``https://graph.microsoft.com/.default`` scope.

Cursor
──────
Graph has no monotonic UID, so incremental polling uses ``receivedDateTime``:
messages are pulled ``ge`` the stored cursor, oldest first, and the cursor
advances to the newest processed timestamp. The ``ge`` boundary can re-surface
the last message, but the per-mailbox Message-ID dedupe makes that a no-op.
"""
from __future__ import annotations

import email
import logging
import time
from dataclasses import dataclass, field
from email.message import Message
from typing import Any, Iterator
from urllib.parse import quote

import requests

logger = logging.getLogger(__name__)

_DEFAULT_TIMEOUT = (10, 120)
_GRAPH_BASE = "https://graph.microsoft.com/v1.0"
_AUTHORITY = "https://login.microsoftonline.com"
_DEFAULT_FOLDER = "inbox"


class GraphError(RuntimeError):
    """Raised for any unrecoverable Microsoft Graph interaction."""


@dataclass
class GraphConfig:
    tenant_id: str = ""
    client_id: str = ""
    client_secret: str = ""
    mailbox: str = ""          # user principal name / email to read
    folder: str = _DEFAULT_FOLDER
    graph_base: str = _GRAPH_BASE
    authority: str = _AUTHORITY
    verify_tls: bool = True
    extra: dict = field(default_factory=dict)

    @classmethod
    def from_mapping(cls, data: dict | None) -> "GraphConfig":
        data = dict(data or {})

        def pick(*keys, default=""):
            for k in keys:
                v = data.get(k)
                if v not in (None, ""):
                    return v
            return default

        known = {
            "tenant_id", "tenant", "client_id", "client_secret", "mailbox",
            "user", "folder", "graph_base", "authority", "verify_tls",
        }
        return cls(
            tenant_id=pick("tenant_id", "tenant"),
            client_id=pick("client_id"),
            client_secret=pick("client_secret"),
            mailbox=pick("mailbox", "user"),
            folder=pick("folder", default=_DEFAULT_FOLDER),
            graph_base=pick("graph_base", default=_GRAPH_BASE),
            authority=pick("authority", default=_AUTHORITY),
            verify_tls=bool(data.get("verify_tls", True)),
            extra={k: v for k, v in data.items() if k not in known},
        )

    def missing_fields(self) -> list[str]:
        required = {
            "tenant_id": self.tenant_id,
            "client_id": self.client_id,
            "client_secret": self.client_secret,
            "mailbox": self.mailbox,
        }
        return [k for k, v in required.items() if not v]


def default_connection_from_settings() -> dict:
    """Graph connection defaults sourced from Django settings (env)."""
    from django.conf import settings

    return {
        "tenant_id": getattr(settings, "GRAPH_TENANT_ID", "") or "",
        "client_id": getattr(settings, "GRAPH_CLIENT_ID", "") or "",
        "client_secret": getattr(settings, "GRAPH_CLIENT_SECRET", "") or "",
        "mailbox": getattr(settings, "GRAPH_MAILBOX", "") or "",
        "folder": getattr(settings, "GRAPH_FOLDER", _DEFAULT_FOLDER) or _DEFAULT_FOLDER,
        "verify_tls": bool(getattr(settings, "GRAPH_VERIFY_TLS", True)),
    }


def merge_connection_with_defaults(connection: dict | None) -> dict:
    """Overlay a mailbox's Graph connection onto the environment defaults."""
    merged = default_connection_from_settings()
    for key, value in (connection or {}).items():
        if value not in (None, ""):
            merged[key] = value
    return merged


@dataclass
class GraphMessage:
    """One message pulled from Graph, shaped like imap_client.FetchedMessage.

    ``uid`` is always 0 (Graph has no UID); identity comes from the MIME
    Message-ID. ``received_at`` is the ISO ``receivedDateTime`` used as the cursor.
    """
    uid: int
    raw: bytes
    message: Message
    received_at: str
    graph_id: str


class GraphClient:
    """Authenticated session against one Microsoft Graph mailbox."""

    def __init__(self, config: GraphConfig, *, session: requests.Session | None = None):
        self.config = config
        self._session = session or requests.Session()
        self._token: str | None = None
        self._token_expiry: float = 0.0

    def __enter__(self) -> "GraphClient":
        return self

    def __exit__(self, *exc) -> None:
        self.close()

    def close(self) -> None:
        try:
            self._session.close()
        except Exception:  # pragma: no cover - best effort
            pass

    # ── auth ────────────────────────────────────────────────────────────────
    def _fetch_token(self) -> str:
        cfg = self.config
        missing = cfg.missing_fields()
        if missing:
            raise GraphError(f"Incomplete Graph connection settings: {', '.join(missing)}.")

        token_url = f"{cfg.authority}/{cfg.tenant_id}/oauth2/v2.0/token"
        payload = {
            "grant_type": "client_credentials",
            "client_id": cfg.client_id,
            "client_secret": cfg.client_secret,
            "scope": "https://graph.microsoft.com/.default",
        }
        try:
            resp = self._session.post(
                token_url, data=payload, timeout=_DEFAULT_TIMEOUT,
                verify=cfg.verify_tls, headers={"Accept": "application/json"},
            )
        except requests.RequestException as exc:
            raise GraphError(f"Could not reach Microsoft identity endpoint: {exc}") from exc
        if resp.status_code != 200:
            raise GraphError(f"Graph authentication failed ({resp.status_code}): {_safe_body(resp)}")
        try:
            data = resp.json()
        except ValueError as exc:
            raise GraphError("Graph token endpoint returned a non-JSON response.") from exc
        token = data.get("access_token")
        if not token:
            raise GraphError("Graph token response did not contain an access_token.")
        self._token = token
        self._token_expiry = time.monotonic() + max(int(data.get("expires_in", 3600)) - 60, 30)
        return token

    def _auth_header(self) -> dict:
        if not self._token or time.monotonic() >= self._token_expiry:
            self._fetch_token()
        return {"Authorization": f"Bearer {self._token}", "Accept": "application/json"}

    def _mailbox_path(self) -> str:
        return f"users/{quote(self.config.mailbox)}"

    def _get(self, url: str, params: dict | None = None) -> requests.Response:
        if url.startswith("http"):
            full = url  # an @odata.nextLink is already absolute
        else:
            full = f"{self.config.graph_base}/{url.lstrip('/')}"
        try:
            resp = self._session.get(
                full, params=params, headers=self._auth_header(),
                timeout=_DEFAULT_TIMEOUT, verify=self.config.verify_tls,
            )
        except requests.RequestException as exc:
            raise GraphError(f"Graph request failed: {exc}") from exc
        if resp.status_code != 200:
            raise GraphError(f"Graph request to {full} returned {resp.status_code}: {_safe_body(resp)}")
        return resp

    # ── public API ────────────────────────────────────────────────────────────
    def test_connection(self) -> dict:
        """Validate credentials and mailbox access. Raises :class:`GraphError`."""
        self._fetch_token()
        # Touch the target folder so misconfigured mailbox/permission errors
        # surface here rather than on the first poll.
        self._get(f"{self._mailbox_path()}/mailFolders/{quote(self.config.folder)}",
                  params={"$select": "id,displayName"})
        return {"ok": True, "mailbox": self.config.mailbox, "folder": self.config.folder}

    def highest_received(self) -> str:
        """ISO receivedDateTime of the newest message, or "" if the folder is empty."""
        resp = self._get(
            f"{self._mailbox_path()}/mailFolders/{quote(self.config.folder)}/messages",
            params={"$select": "receivedDateTime", "$orderby": "receivedDateTime desc", "$top": 1},
        )
        items = resp.json().get("value") or []
        return str(items[0].get("receivedDateTime", "")) if items else ""

    def iter_messages(self, *, since_datetime: str | None = None) -> Iterator[GraphMessage]:
        """Yield messages with ``receivedDateTime >= since_datetime``, oldest first."""
        params: dict[str, Any] = {
            "$select": "id,receivedDateTime,hasAttachments,internetMessageId",
            "$orderby": "receivedDateTime asc",
            "$top": 50,
        }
        if since_datetime:
            params["$filter"] = f"receivedDateTime ge {since_datetime}"

        url = f"{self._mailbox_path()}/mailFolders/{quote(self.config.folder)}/messages"
        next_params: dict | None = params
        while url:
            resp = self._get(url, params=next_params)
            payload = resp.json()
            for item in payload.get("value") or []:
                msg_id = item.get("id")
                if not msg_id:
                    continue
                raw = self._download_mime(msg_id)
                if not raw:
                    continue
                yield GraphMessage(
                    uid=0,
                    raw=raw,
                    message=email.message_from_bytes(raw),
                    received_at=str(item.get("receivedDateTime", "")),
                    graph_id=str(msg_id),
                )
            url = payload.get("@odata.nextLink") or ""
            next_params = None  # nextLink already carries the query

    def _download_mime(self, message_id: str) -> bytes | None:
        """Fetch a message's raw RFC-822 MIME via /messages/{id}/$value."""
        full = f"{self.config.graph_base}/{self._mailbox_path()}/messages/{quote(message_id)}/$value"
        try:
            resp = self._session.get(
                full, headers={"Authorization": f"Bearer {self._token}"},
                timeout=_DEFAULT_TIMEOUT, verify=self.config.verify_tls,
            )
        except requests.RequestException as exc:
            raise GraphError(f"Graph MIME download failed for {message_id}: {exc}") from exc
        if resp.status_code != 200:
            logger.warning("Graph $value for %s returned %s — skipping", message_id, resp.status_code)
            return None
        return resp.content


def _safe_body(resp: requests.Response, limit: int = 500) -> str:
    try:
        return resp.text[:limit]
    except Exception:  # pragma: no cover - defensive
        return "<unreadable response body>"
