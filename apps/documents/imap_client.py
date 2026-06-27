"""
apps/documents/imap_client.py

A thin client for reading inbound mail from an IMAP mailbox, used to ingest
email attachments as documents into this DMS.

Why this layer exists
──────────────────────
Mirrors :mod:`apps.documents.ion_client`: every IMAP interaction funnels
through one well-documented client so connection handling, folder selection,
and incremental fetching live in a single place. The ingestion logic in
:mod:`apps.documents.email_ingestion` consumes :meth:`IMAPClient.iter_messages`
and never touches :mod:`imaplib` directly.

This is deliberately built on the standard library (``imaplib`` + ``email``) so
there is no new dependency. A later Microsoft Graph backend can implement the
same small surface (``test_connection`` / ``iter_messages``) and be swapped in
behind the mailbox connector without the ingestion code changing.

Incremental fetch
─────────────────
A poll should only see mail it has not seen before. IMAP UIDs are monotonic
within a mailbox (per UIDVALIDITY), so the mailbox stores ``last_seen_uid`` and
asks for ``UID <n+1>:*``. UIDs are stable, unlike sequence numbers, which makes
them the right cursor for a recurring poll.
"""
from __future__ import annotations

import email
import imaplib
import logging
from dataclasses import dataclass, field
from email.message import Message
from typing import Iterator

logger = logging.getLogger(__name__)

# IMAP folder is usually INBOX; kept configurable for sub-folder routing.
_DEFAULT_FOLDER = "INBOX"


class IMAPError(RuntimeError):
    """Raised for any unrecoverable IMAP interaction."""


@dataclass
class IMAPConfig:
    """Normalized IMAP connection settings."""

    host: str = ""
    port: int = 993
    use_ssl: bool = True
    username: str = ""
    password: str = ""
    folder: str = _DEFAULT_FOLDER
    verify_tls: bool = True
    extra: dict = field(default_factory=dict)

    @classmethod
    def from_mapping(cls, data: dict | None) -> "IMAPConfig":
        data = dict(data or {})

        def pick(*keys, default=""):
            for k in keys:
                v = data.get(k)
                if v not in (None, ""):
                    return v
            return default

        use_ssl = data.get("use_ssl", True)
        if isinstance(use_ssl, str):
            use_ssl = use_ssl.strip().lower() in ("1", "true", "yes", "on")

        raw_port = pick("port", default=993 if use_ssl else 143)
        try:
            port = int(raw_port)
        except (TypeError, ValueError):
            port = 993 if use_ssl else 143

        known = {
            "host", "port", "use_ssl", "username", "password", "folder",
            "verify_tls",
        }
        return cls(
            host=pick("host", "server"),
            port=port,
            use_ssl=bool(use_ssl),
            username=pick("username", "user"),
            password=pick("password"),
            folder=pick("folder", default=_DEFAULT_FOLDER),
            verify_tls=bool(data.get("verify_tls", True)),
            extra={k: v for k, v in data.items() if k not in known},
        )

    def missing_fields(self) -> list[str]:
        """Return the names of required-but-empty fields."""
        required = {
            "host": self.host,
            "username": self.username,
            "password": self.password,
        }
        return [k for k, v in required.items() if not v]


def default_connection_from_settings() -> dict:
    """IMAP connection defaults sourced from Django settings (env).

    Returns the friendly-key shape used by the admin UI. The password is
    included so the runner can fall back to it, but callers exposing this to the
    browser must redact it.
    """
    from django.conf import settings

    return {
        "host": getattr(settings, "IMAP_HOST", "") or "",
        "port": getattr(settings, "IMAP_PORT", 993) or 993,
        "use_ssl": bool(getattr(settings, "IMAP_USE_SSL", True)),
        "username": getattr(settings, "IMAP_USERNAME", "") or "",
        "password": getattr(settings, "IMAP_PASSWORD", "") or "",
        "folder": getattr(settings, "IMAP_FOLDER", _DEFAULT_FOLDER) or _DEFAULT_FOLDER,
        "verify_tls": bool(getattr(settings, "IMAP_VERIFY_TLS", True)),
    }


def merge_connection_with_defaults(connection: dict | None) -> dict:
    """Overlay a mailbox's connection onto the environment defaults.

    Blank/missing values fall back to the configured IMAP env defaults, so an
    operator can set shared credentials once in the environment and leave the
    per-mailbox form mostly empty.
    """
    merged = default_connection_from_settings()
    for key, value in (connection or {}).items():
        if value not in (None, ""):
            merged[key] = value
    return merged


@dataclass
class FetchedMessage:
    """One message pulled from the mailbox."""
    uid: int
    raw: bytes
    message: Message


class IMAPClient:
    """Authenticated session against one IMAP mailbox.

    Usage::

        client = IMAPClient(IMAPConfig.from_mapping(mailbox.connection))
        client.test_connection()
        for msg in client.iter_messages(since_uid=mailbox.last_seen_uid):
            ...
        client.close()

    Also works as a context manager so the connection is always released.
    """

    def __init__(self, config: IMAPConfig):
        self.config = config
        self._conn: imaplib.IMAP4 | None = None

    def __enter__(self) -> "IMAPClient":
        self._connect()
        return self

    def __exit__(self, *exc) -> None:
        self.close()

    # ── connection ────────────────────────────────────────────────────────────
    def _connect(self) -> imaplib.IMAP4:
        if self._conn is not None:
            return self._conn
        cfg = self.config
        missing = cfg.missing_fields()
        if missing:
            raise IMAPError(f"Incomplete IMAP connection settings: {', '.join(missing)}.")
        try:
            if cfg.use_ssl:
                import ssl

                context = ssl.create_default_context()
                if not cfg.verify_tls:
                    context.check_hostname = False
                    context.verify_mode = ssl.CERT_NONE
                conn = imaplib.IMAP4_SSL(cfg.host, cfg.port, ssl_context=context)
            else:
                conn = imaplib.IMAP4(cfg.host, cfg.port)
        except (OSError, imaplib.IMAP4.error) as exc:
            raise IMAPError(f"Could not reach IMAP server {cfg.host}:{cfg.port}: {exc}") from exc

        try:
            conn.login(cfg.username, cfg.password)
        except imaplib.IMAP4.error as exc:
            try:
                conn.logout()
            except Exception:  # pragma: no cover - best effort
                pass
            raise IMAPError(f"IMAP login failed for {cfg.username}: {exc}") from exc

        self._conn = conn
        return conn

    def _select_folder(self) -> None:
        conn = self._connect()
        typ, _ = conn.select(self.config.folder, readonly=False)
        if typ != "OK":
            raise IMAPError(f"Could not open IMAP folder {self.config.folder!r}.")

    def close(self) -> None:
        if self._conn is None:
            return
        try:
            self._conn.logout()
        except Exception:  # pragma: no cover - best effort
            pass
        finally:
            self._conn = None

    # ── public API ────────────────────────────────────────────────────────────
    def test_connection(self) -> dict:
        """Validate credentials by logging in and selecting the folder.

        Returns a small status dict suitable for returning to the UI. Raises
        :class:`IMAPError` on failure.
        """
        try:
            self._select_folder()
            return {
                "ok": True,
                "host": self.config.host,
                "folder": self.config.folder,
                "username": self.config.username,
            }
        finally:
            self.close()

    def highest_uid(self) -> int:
        """Return the largest UID currently in the folder (0 if empty).

        Used to skip an existing backlog: a new mailbox can fast-forward its
        cursor to here so only mail arriving afterwards is ingested.
        """
        conn = self._connect()
        self._select_folder()
        try:
            typ, data = conn.uid("search", None, "ALL")
        except imaplib.IMAP4.error as exc:
            raise IMAPError(f"IMAP search failed: {exc}") from exc
        if typ != "OK":
            raise IMAPError(f"IMAP search returned {typ!r}.")
        uids = [int(x) for x in (data[0].split() if data and data[0] else [])]
        return max(uids) if uids else 0

    def iter_messages(self, *, since_uid: int = 0, since_date=None) -> Iterator[FetchedMessage]:
        """Yield messages whose UID is greater than ``since_uid``, oldest first.

        Uses UID search/fetch so the cursor is stable across polls. The caller
        is responsible for persisting the highest UID it processed back onto the
        mailbox. ``since_date`` (a ``date``) additionally limits results to
        messages received on or after that day via the IMAP ``SINCE`` key.
        """
        conn = self._connect()
        self._select_folder()

        # UID n:* always returns at least the message with the highest UID, even
        # when none are strictly greater than ``since_uid``; filter those out.
        low = (since_uid or 0) + 1
        criteria = f"UID {low}:*"
        if since_date is not None:
            criteria += f" SINCE {_imap_date(since_date)}"
        try:
            typ, data = conn.uid("search", None, criteria)
        except imaplib.IMAP4.error as exc:
            raise IMAPError(f"IMAP search failed: {exc}") from exc
        if typ != "OK":
            raise IMAPError(f"IMAP search returned {typ!r}.")

        uids = [int(x) for x in (data[0].split() if data and data[0] else [])]
        uids = sorted(u for u in uids if u >= low)

        for uid in uids:
            try:
                typ, msg_data = conn.uid("fetch", str(uid), "(RFC822)")
            except imaplib.IMAP4.error as exc:
                raise IMAPError(f"IMAP fetch failed for UID {uid}: {exc}") from exc
            if typ != "OK" or not msg_data:
                logger.warning("IMAP fetch for UID %s returned %r — skipping", uid, typ)
                continue
            raw = _first_rfc822_payload(msg_data)
            if not raw:
                logger.warning("IMAP fetch for UID %s had no payload — skipping", uid)
                continue
            yield FetchedMessage(uid=uid, raw=raw, message=email.message_from_bytes(raw))


_IMAP_MONTHS = (
    "Jan", "Feb", "Mar", "Apr", "May", "Jun",
    "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
)


def _imap_date(d) -> str:
    """Format a date as IMAP's ``DD-Mon-YYYY`` with English months.

    Avoids ``strftime('%b')`` so a non-English server locale can't produce a
    month name IMAP won't understand.
    """
    return f"{d.day:02d}-{_IMAP_MONTHS[d.month - 1]}-{d.year}"


def _first_rfc822_payload(msg_data) -> bytes | None:
    """Pull the raw RFC822 bytes out of an imaplib fetch response."""
    for part in msg_data:
        if isinstance(part, tuple) and len(part) >= 2 and isinstance(part[1], (bytes, bytearray)):
            return bytes(part[1])
    return None
