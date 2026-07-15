"""
apps/sunsystems/client.py

A thin client for Infor **SunSystems Connect** (SSC) web services, used to run
budget inquiries and post journals (Ledger Import) from filled forms.

Why this layer exists
─────────────────────
SunSystems Connect exposes two SOAP/WSDL endpoints under one base URL:

    SecurityProvider   → Authenticate(username, password) -> token
    ComponentExecutor  → Execute(component, method, payload, authentication)

Every call funnels through this one client so WSDL loading/caching, auth token
handling, and error handling live in a single, well-documented place. The
*business* document (the ``<SSC>`` XML — context, posting parameters, ledger
lines) is built elsewhere, by :mod:`apps.sunsystems.mapping`, from a declarative
per-template mapping. This client only knows how to authenticate and how to
call Execute with a ready-made ``<SSC>`` payload string.

Transport, concretely
──────────────────────
This talks to the *real* schema via ``zeep``, built from the live WSDL, rather
than a hand-constructed SOAP envelope. That matters here: the exact namespace
and message shape are whatever this tenant's WSDL says, and reproducing them by
hand risks silently drifting from the real contract. Two things confirmed
against the live gateway that are easy to get wrong otherwise:

  * The ``<SSC>`` payload is passed as a **plain string** — zeep XML-escapes it
    into the ``payload`` element's text content. No CDATA wrapping needed.
  * ``Authenticate`` returns the token as a bare string (not a nested object);
    ``Execute`` returns the raw ``<SSC>`` reply, also as a bare string.

Authentication is two-layered: an HTTP Basic Auth header on the session
*and* the business-level ``Authenticate`` call that returns the token passed
to every ``Execute``. Both were required against the live gateway.

zeep Clients are cached per endpoint, credentials, and TLS setting — building
one means fetching + parsing the WSDL, which is too expensive to redo on every
call.
"""
from __future__ import annotations

import hashlib
import logging
import re
import threading
from dataclasses import dataclass, field

import requests
from requests.auth import HTTPBasicAuth
from zeep import Client as ZeepClient
from zeep.exceptions import Fault as ZeepFault
from zeep.transports import Transport

logger = logging.getLogger(__name__)

# Network timeouts (connect, read) in seconds. Journal imports can take a while
# server-side, so the read side is generous.
_DEFAULT_TIMEOUT = (10, 120)


class SunSystemsError(RuntimeError):
    """Raised for any unrecoverable SunSystems Connect interaction."""


@dataclass
class SunSystemsConfig:
    """Normalized SunSystems Connect connection settings.

    Built from friendly keys (``base_url``, ``username`` …). ``base_url`` is
    the WSDL root, e.g. ``http://sunsrv02.flaxem.int:81/sunsystems-connect/wsdl``
    — ``security_path``/``executor_path`` are appended to it (each becoming
    ``{base_url}/{path}?wsdl``). ``business_unit`` and ``budget_code`` are
    defaults for the ``<SunSystemsContext>`` block; a template mapping may
    override them per posting.
    """

    base_url: str = ""           # WSDL root, e.g. http://host:81/sunsystems-connect/wsdl
    security_path: str = "SecurityProvider"
    executor_path: str = "ComponentExecutor"
    username: str = ""
    password: str = ""
    business_unit: str = ""
    budget_code: str = "A"
    verify_tls: bool = True
    extra: dict = field(default_factory=dict)

    @classmethod
    def from_mapping(cls, data: dict | None) -> "SunSystemsConfig":
        data = dict(data or {})

        def pick(*keys, default=""):
            for k in keys:
                v = data.get(k)
                if v not in (None, ""):
                    return v
            return default

        known = {
            "base_url", "security_path", "executor_path", "username", "password",
            "business_unit", "budget_code", "verify_tls",
        }
        return cls(
            base_url=_normalize_base_url(pick("base_url")),
            security_path=pick("security_path", default="SecurityProvider"),
            executor_path=pick("executor_path", default="ComponentExecutor"),
            username=pick("username"),
            password=pick("password"),
            business_unit=pick("business_unit"),
            budget_code=pick("budget_code", default="A"),
            verify_tls=bool(data.get("verify_tls", True)),
            extra={k: v for k, v in data.items() if k not in known},
        )

    def missing_fields(self) -> list[str]:
        """Return the names of required-but-empty fields."""
        required = {
            "base_url": self.base_url,
            "username": self.username,
        }
        return [k for k, v in required.items() if not v]

    def cache_key(self) -> tuple:
        password_digest = hashlib.sha256(self.password.encode("utf-8")).hexdigest()
        return (
            self.base_url,
            self.security_path,
            self.executor_path,
            self.username,
            password_digest,
            self.verify_tls,
        )


def _normalize_base_url(url: str) -> str:
    """Tolerate a base URL that already includes an endpoint segment (and a
    trailing ``?wsdl``/``/wsdl``), stripping it back to the WSDL root so the
    per-call paths aren't appended twice."""
    u = (url or "").strip().rstrip("/")
    u = re.sub(r"\?wsdl.*$", "", u, flags=re.IGNORECASE)
    for endpoint in ("SecurityProvider", "ComponentExecutor"):
        if u.lower().endswith("/" + endpoint.lower()):
            u = u[: -(len(endpoint) + 1)]
    return u


def default_connection_from_settings() -> dict:
    """SunSystems connection defaults sourced from Django settings (env).

    Returns the friendly-key shape used by the admin/template mapping. Secrets
    are included so the runner can fall back to them; callers exposing this to
    the browser must redact ``password``.
    """
    from django.conf import settings

    return {
        "base_url": getattr(settings, "SUNSYSTEMS_BASE_URL", "") or "",
        "security_path": getattr(settings, "SUNSYSTEMS_SECURITY_PATH", "SecurityProvider") or "SecurityProvider",
        "executor_path": getattr(settings, "SUNSYSTEMS_EXECUTOR_PATH", "ComponentExecutor") or "ComponentExecutor",
        "username": getattr(settings, "SUNSYSTEMS_USERNAME", "") or "",
        "password": getattr(settings, "SUNSYSTEMS_PASSWORD", "") or "",
        "business_unit": getattr(settings, "SUNSYSTEMS_BUSINESS_UNIT", "") or "",
        "budget_code": getattr(settings, "SUNSYSTEMS_BUDGET_CODE", "A") or "A",
        "verify_tls": bool(getattr(settings, "SUNSYSTEMS_VERIFY_TLS", True)),
    }


def merge_connection_with_defaults(connection: dict | None) -> dict:
    """Overlay a template's connection override onto the environment defaults.

    Blank/missing values fall back to the configured env defaults, so an
    operator can set credentials once in the environment and leave per-template
    overrides to just the business unit / budget code.
    """
    merged = default_connection_from_settings()
    for key, value in (connection or {}).items():
        if value not in (None, ""):
            merged[key] = value
    return merged


# ── zeep client cache ───────────────────────────────────────────────────────────
# Building a zeep Client fetches + parses the WSDL, which is too expensive to
# redo on every call. Cache one pair (security, executor) per distinct config.
_client_cache: dict[tuple, tuple[ZeepClient, ZeepClient]] = {}
_cache_lock = threading.Lock()


def _build_zeep_clients(cfg: SunSystemsConfig) -> tuple[ZeepClient, ZeepClient]:
    key = cfg.cache_key()
    with _cache_lock:
        cached = _client_cache.get(key)
        if cached:
            return cached

        session = requests.Session()
        session.trust_env = False
        session.proxies = {}
        session.auth = HTTPBasicAuth(cfg.username, cfg.password)
        session.verify = cfg.verify_tls
        transport = Transport(session=session, timeout=_DEFAULT_TIMEOUT[0], operation_timeout=_DEFAULT_TIMEOUT[1])

        base = cfg.base_url.rstrip("/")
        security_wsdl = f"{base}/{cfg.security_path.strip('/')}?wsdl"
        executor_wsdl = f"{base}/{cfg.executor_path.strip('/')}?wsdl"

        try:
            security_client = ZeepClient(wsdl=security_wsdl, transport=transport)
            executor_client = ZeepClient(wsdl=executor_wsdl, transport=transport)
        except Exception as exc:  # noqa: BLE001 - surface as our own error type
            raise SunSystemsError(f"Could not load SunSystems WSDL: {exc}") from exc

        _client_cache[key] = (security_client, executor_client)
        return security_client, executor_client


def clear_client_cache() -> None:
    """Drop all cached zeep clients (e.g. after an admin changes credentials)."""
    with _cache_lock:
        _client_cache.clear()


class SunSystemsClient:
    """Authenticated session against one SunSystems Connect gateway.

    Usage::

        client = SunSystemsClient(SunSystemsConfig.from_mapping(conn))
        client.test_connection()
        result_xml = client.execute("PurchaseOrder", "CreateOrAmend", ssc_payload_xml)
    """

    def __init__(self, config: SunSystemsConfig):
        self.config = config
        self._token: str | None = None

    # ── auth ────────────────────────────────────────────────────────────────
    def reset_token(self) -> None:
        self._token = None

    def get_token(self, *, force: bool = False) -> str:
        if self._token and not force:
            return self._token

        cfg = self.config
        missing = cfg.missing_fields()
        if missing:
            raise SunSystemsError(
                f"Incomplete SunSystems connection settings: {', '.join(missing)}."
            )

        security_client, _ = _build_zeep_clients(cfg)
        try:
            token = security_client.service.Authenticate(cfg.username, cfg.password)
        except ZeepFault as exc:
            raise SunSystemsError(f"SunSystems authentication fault: {exc}") from exc
        except Exception as exc:  # noqa: BLE001
            raise SunSystemsError(f"Could not reach SunSystems (authentication): {exc}") from exc

        if not token:
            raise SunSystemsError(
                "Authentication failed — the SunSystems gateway returned an empty "
                "token. Check the username and password."
            )
        self._token = token
        return token

    # ── public API ──────────────────────────────────────────────────────────
    def test_connection(self) -> dict:
        """Validate credentials by acquiring a token. Raises on failure."""
        self.get_token(force=True)
        return {"ok": True, "base_url": self.config.base_url, "token_acquired": True}

    def execute(self, component: str, method: str, ssc_payload: str) -> str:
        """Run a SunSystems component/method with an ``<SSC>`` payload.

        ``ssc_payload`` is the inner business document XML (built by
        :mod:`apps.sunsystems.mapping``), passed as a plain string — the
        service expects XML-escaped text here, not a CDATA block. Returns the
        raw ``<SSC>`` response (also a plain string) for the caller to parse.
        Re-authenticates once on an auth/access failure.
        """
        token = self.get_token()
        try:
            return self._execute_once(component, method, ssc_payload, token)
        except SunSystemsError as exc:
            if _looks_like_auth_failure(str(exc)):
                token = self.get_token(force=True)
                return self._execute_once(component, method, ssc_payload, token)
            raise

    def _execute_once(self, component: str, method: str, ssc_payload: str, token: str) -> str:
        _, executor_client = _build_zeep_clients(self.config)
        try:
            response = executor_client.service.Execute(
                component=component,
                method=method,
                payload=ssc_payload,
                authentication=token,
            )
        except ZeepFault as exc:
            raise SunSystemsError(f"SunSystems {component}/{method} fault: {exc}") from exc
        except Exception as exc:  # noqa: BLE001
            raise SunSystemsError(f"Could not reach SunSystems ({component}/{method}): {exc}") from exc
        return response or ""


def build_executor_envelope(token: str, component: str, method: str, ssc_payload: str, *, config: SunSystemsConfig | None = None) -> str:
    """Render the exact SOAP envelope Execute(...) would send, for preview/audit.

    Uses the real WSDL (via zeep's message-building, no network send) so the
    preview matches the true schema instead of a hand-guessed shape. Pass a
    placeholder ``token`` (e.g. ``"{{SECURITY_TOKEN}}"``) when the real one
    isn't available yet -- the rest of the envelope is exactly what gets sent.
    Requires ``config`` to build/reuse a zeep client against the live WSDL; if
    omitted or unreachable, falls back to a plain description (no envelope).
    """
    if config is None:
        return (
            f"<!-- Preview unavailable without a connection: would call "
            f"{component}/{method} with authentication={token!r} -->"
        )
    try:
        from lxml import etree

        _, executor_client = _build_zeep_clients(config)
        node = executor_client.create_message(
            executor_client.service,
            "Execute",
            component=component,
            method=method,
            payload=ssc_payload,
            authentication=token,
        )
        return etree.tostring(node, pretty_print=True).decode("utf-8")
    except Exception as exc:  # noqa: BLE001 - preview is best-effort
        logger.warning("Could not render live SOAP preview, falling back: %s", exc)
        return (
            f"<!-- Preview unavailable ({exc}) -- would call {component}/{method} "
            f"with authentication={token!r} -->"
        )


def _looks_like_auth_failure(message: str) -> bool:
    return bool(re.search(r"auth|token|unauthor|session|security|access rights", message, re.IGNORECASE))
