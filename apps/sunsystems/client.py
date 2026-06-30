"""
apps/sunsystems/client.py

A thin client for Infor **SunSystems Connect** (SSC) web services, used to run
budget inquiries and post journals (Ledger Import) from filled forms.

Why this layer exists
─────────────────────
SunSystems Connect exposes two SOAP endpoints under one base URL:

    SecurityProvider   POST → authenticate, returns a session token
    ComponentExecutor  POST → run a {component, method} with an <SSC> payload

Every call funnels through this one client so the SOAP envelope shapes, auth
token caching, and error handling live in a single, well-documented place. The
*business* document (the ``<SSC>`` XML — context, posting parameters, ledger
lines) is built elsewhere, by :mod:`apps.sunsystems.mapping`, from a declarative
per-template mapping. This client only knows how to authenticate and how to
wrap a ready-made ``<SSC>`` payload in the ComponentExecutor envelope.

Authentication
──────────────
SecurityProvider takes a username/password and returns a token string. The
token is cached on the client and reused until a call fails auth, at which point
the caller can retry after :meth:`reset_token`. Credentials come from Django
settings (env) and may be overridden per template via the connection mapping.

Nothing here is hard-coded to one tenant beyond URLs and credentials, so it is
easy to point at a sandbox/mock during development. Network responses come from
a trusted finance gateway; XML is parsed with the standard library.
"""
from __future__ import annotations

import logging
import re
from dataclasses import dataclass, field
from typing import Any
from urllib.parse import urljoin
from xml.etree import ElementTree as ET

import requests

logger = logging.getLogger(__name__)

# Network timeouts (connect, read) in seconds. Journal imports can take a while
# server-side, so the read side is generous.
_DEFAULT_TIMEOUT = (10, 120)

# SOAP / SunSystems Connect namespaces.
_NS_SOAPENV = "http://schemas.xmlsoap.org/soap/envelope/"
_NS_WEB = "http://systemsunion.com/connect/webservices/"

# SOAPAction headers (verified against the live SunSystems Connect demo gateway).
_SOAP_ACTION_AUTHENTICATE = "http://systemsunion.com/connect/webservices/Authenticate"
_SOAP_ACTION_EXECUTE = "http://systemsunion.com/connect/webservices/Execute"


class SunSystemsError(RuntimeError):
    """Raised for any unrecoverable SunSystems Connect interaction."""


@dataclass
class SunSystemsConfig:
    """Normalized SunSystems Connect connection settings.

    Built from friendly keys (``base_url``, ``username`` …). ``business_unit``
    and ``budget_code`` are defaults for the ``<SunSystemsContext>`` block; a
    template mapping may override them per posting.
    """

    base_url: str = ""           # gateway base, e.g. https://host/sunsystems-connect/soap
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
            "password": self.password,
        }
        return [k for k, v in required.items() if not v]


def _normalize_base_url(url: str) -> str:
    """Tolerate a base URL that already includes an endpoint segment.

    Admins often paste the full ``.../soap/SecurityProvider`` URL into the base
    field; strip a trailing ``/SecurityProvider`` or ``/ComponentExecutor`` so
    the per-call paths aren't appended twice.
    """
    u = (url or "").rstrip("/")
    for endpoint in ("SecurityProvider", "ComponentExecutor"):
        if u.lower().endswith("/" + endpoint.lower()):
            return u[: -(len(endpoint) + 1)]
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


class SunSystemsClient:
    """Authenticated session against one SunSystems Connect gateway.

    Usage::

        client = SunSystemsClient(SunSystemsConfig.from_mapping(conn))
        client.test_connection()
        result_xml = client.execute("Journal", "Import", ssc_payload_xml)
    """

    def __init__(self, config: SunSystemsConfig, *, session: requests.Session | None = None):
        self.config = config
        self._session = session or requests.Session()
        self._token: str | None = None

    # ── urls ────────────────────────────────────────────────────────────────
    def _url(self, path: str) -> str:
        base = self.config.base_url
        if not base.endswith("/"):
            base = base + "/"
        return urljoin(base, path.lstrip("/"))

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

        envelope = _security_envelope(cfg.username, cfg.password)
        body = self._post(
            self._url(cfg.security_path),
            envelope,
            soap_action=_SOAP_ACTION_AUTHENTICATE,
            what="authentication",
        )
        token = _extract_token(body)
        if not token:
            if _is_auth_response(body):
                raise SunSystemsError(
                    "Authentication failed — the SunSystems gateway returned an empty "
                    "token. Check the username and password."
                )
            raise SunSystemsError(
                "SunSystems SecurityProvider response did not contain a token."
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
        :mod:`apps.sunsystems.mapping`). Returns the raw response body (SOAP
        XML) for the caller to parse. Re-authenticates once on an auth failure.
        """
        token = self.get_token()
        envelope = _executor_envelope(token, component, method, ssc_payload)
        try:
            return self._post(
                self._url(self.config.executor_path),
                envelope,
                soap_action=_SOAP_ACTION_EXECUTE,
                what=f"{component}/{method}",
            )
        except SunSystemsError as exc:
            # A stale token surfaces as an auth fault; re-authenticate once.
            if _looks_like_auth_failure(str(exc)):
                token = self.get_token(force=True)
                envelope = _executor_envelope(token, component, method, ssc_payload)
                return self._post(
                    self._url(self.config.executor_path),
                    envelope,
                    soap_action=_SOAP_ACTION_EXECUTE,
                    what=f"{component}/{method}",
                )
            raise

    # ── transport ─────────────────────────────────────────────────────────────
    def _post(self, url: str, envelope: str, *, soap_action: str, what: str) -> str:
        try:
            resp = self._session.post(
                url,
                data=envelope.encode("utf-8"),
                timeout=_DEFAULT_TIMEOUT,
                verify=self.config.verify_tls,
                headers={
                    "Content-Type": "text/xml; charset=utf-8",
                    "SOAPAction": soap_action,
                    "Accept": "text/xml, application/xml",
                },
            )
        except requests.RequestException as exc:
            raise SunSystemsError(f"Could not reach SunSystems ({what}): {exc}") from exc

        body = resp.text or ""
        if resp.status_code != 200:
            raise SunSystemsError(
                f"SunSystems {what} returned {resp.status_code}: {_safe(body)}"
            )
        fault = _extract_soap_fault(body)
        if fault:
            raise SunSystemsError(f"SunSystems {what} fault: {fault}")
        return body


# ── envelope builders ────────────────────────────────────────────────────────
def _security_envelope(username: str, password: str) -> str:
    """SecurityProvider.Authenticate request.

    Element names match the live SunSystems Connect schema: the user goes in
    ``<web:name>`` (not ``<web:user>``) and the password in ``<web:password>``,
    sent in plain text inside the SOAP body — SunSystems Connect's native auth,
    protected by TLS on the wire.
    """
    return (
        '<?xml version="1.0" encoding="utf-8"?>'
        f'<soapenv:Envelope xmlns:soapenv="{_NS_SOAPENV}" xmlns:web="{_NS_WEB}">'
        "<soapenv:Body>"
        "<web:SecurityProviderAuthenticateRequest>"
        f"<web:name>{_xml_escape(username)}</web:name>"
        f"<web:password>{_xml_escape(password)}</web:password>"
        "</web:SecurityProviderAuthenticateRequest>"
        "</soapenv:Body>"
        "</soapenv:Envelope>"
    )


def build_executor_envelope(token: str, component: str, method: str, ssc_payload: str) -> str:
    """Public access to the ComponentExecutor SOAP envelope (e.g. payload preview).

    For a preview, pass a placeholder ``token`` (the real one is injected at post
    time) — the rest of the envelope is exactly what gets sent to SunSystems.
    """
    return _executor_envelope(token, component, method, ssc_payload)


def _executor_envelope(token: str, component: str, method: str, ssc_payload: str) -> str:
    """Wrap a ready-made ``<SSC>`` payload in the ComponentExecutor envelope.

    The payload is CDATA-embedded exactly as SunSystems Connect expects (see the
    reference TRN SunSystem EXP Journal connector).
    """
    return (
        '<?xml version="1.0" encoding="utf-8"?>'
        f'<soapenv:Envelope xmlns:soapenv="{_NS_SOAPENV}" xmlns:web="{_NS_WEB}">'
        "<soapenv:Body>"
        "<web:ComponentExecutorExecuteRequest>"
        f"<web:authentication>{_xml_escape(token)}</web:authentication>"
        f"<web:component>{_xml_escape(component)}</web:component>"
        f"<web:method>{_xml_escape(method)}</web:method>"
        f"<web:payload><![CDATA[{_strip_cdata(ssc_payload)}]]></web:payload>"
        "</web:ComponentExecutorExecuteRequest>"
        "</soapenv:Body>"
        "</soapenv:Envelope>"
    )


# ── response parsing ───────────────────────────────────────────────────────────
def _localname(tag: str) -> str:
    return tag.rsplit("}", 1)[-1].lower()


def _parse(xml: str) -> ET.Element | None:
    try:
        return ET.fromstring(xml.encode("utf-8") if isinstance(xml, str) else xml)
    except ET.ParseError:
        return None


def _extract_token(xml: str) -> str | None:
    """Pull the auth token out of a SecurityProvider response.

    SunSystems Connect returns the token as the **text of the
    ``<SecurityProviderAuthenticateResponse>`` element** (empty when the
    credentials are rejected). We also accept a few token-ish child names for
    tenants that nest it differently.
    """
    root = _parse(xml)
    if root is None:
        return None
    for el in root.iter():
        name = _localname(el.tag)
        if name.endswith("authenticateresponse") or name in {
            "token", "authentication", "securitytoken", "sessiontoken",
        }:
            if el.text and el.text.strip():
                return el.text.strip()
    return None


def _is_auth_response(xml: str) -> bool:
    """True when the body carries a SecurityProvider auth-response wrapper —
    i.e. the gateway processed the request (an empty one ⇒ bad credentials)."""
    root = _parse(xml)
    if root is None:
        return False
    return any(_localname(el.tag).endswith("authenticateresponse") for el in root.iter())


def _extract_soap_fault(xml: str) -> str | None:
    root = _parse(xml)
    if root is None:
        return None
    for el in root.iter():
        if _localname(el.tag) in {"fault", "faultstring"}:
            text = (el.text or "").strip()
            if text:
                return text
            # <Fault> wrapper: gather child text.
            inner = " ".join(
                (c.text or "").strip() for c in el.iter() if (c.text or "").strip()
            )
            if inner:
                return inner
    return None


def _looks_like_auth_failure(message: str) -> bool:
    return bool(re.search(r"auth|token|unauthor|session|security", message, re.IGNORECASE))


# ── helpers ────────────────────────────────────────────────────────────────────
def _xml_escape(value: Any) -> str:
    s = "" if value is None else str(value)
    return (
        s.replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace('"', "&quot;")
    )


def _strip_cdata(payload: str) -> str:
    # Guard against a payload that accidentally contains a CDATA close marker,
    # which would terminate the wrapper early.
    return (payload or "").replace("]]>", "]] >")


def _safe(body: str, limit: int = 500) -> str:
    try:
        return body[:limit]
    except Exception:  # pragma: no cover - defensive
        return "<unreadable response body>"
