"""
apps/documents/ion_client.py

A thin client for Infor's ION API gateway, used to reach an Infor IDM tenant
when migrating documents into this DMS.

Why this layer exists
──────────────────────
The exact request/response shapes of a customer's IDM tenant are not known to
us yet (item search query dialect, attribute names, the streaming endpoint for
the binary). Rather than hard-code guesses across the codebase, every call to
ION funnels through this one client so there is a single, well-documented place
to adjust once we have real tenant credentials and can see live responses.

Authentication
──────────────
ION uses OAuth2. Credentials come from an ION API service-account file
(``*.ionapi``). The fields we care about, with the names ION uses:

    ti   → tenant id
    cn   → client/application name
    ci   → client_id          (OAuth2 client id)
    cs   → client_secret       (OAuth2 client secret)
    saak → service account access key   (acts as username, "password" grant)
    sask → service account secret key    (acts as password,  "password" grant)
    pu   → base auth/token URL (e.g. https://mingle-sso.../)
    iu   → ION API base URL    (e.g. https://mingle-ionapi.../)
    ot   → token endpoint path (appended to pu), default "token.oauth2"

We accept those raw names *and* friendlier aliases (api_url, token_url,
client_id, …) so the admin UI can use readable keys. ``from_ionapi`` parses a
raw ``.ionapi`` JSON blob into the normalized config this client expects.

Nothing here is Infor-specific beyond URLs and the OAuth2 password grant, so it
is easy to point at a sandbox/mock during development.
"""
from __future__ import annotations

import logging
import time
from dataclasses import dataclass, field
from typing import Any, Iterator
from urllib.parse import urljoin

import requests

logger = logging.getLogger(__name__)

# Network timeouts (connect, read) in seconds. Migrations can pull large
# binaries, so the read side is generous.
_DEFAULT_TIMEOUT = (10, 120)


class IONError(RuntimeError):
    """Raised for any unrecoverable ION API interaction."""


@dataclass
class IONConfig:
    """Normalized ION connection settings.

    Built from either friendly keys (api_url, token_url, client_id, …) or the
    raw ``.ionapi`` field names (iu, pu, ci, cs, saak, sask, …).
    """

    api_url: str = ""          # ION API gateway base, ends with the tenant, e.g. .../TENANT/
    token_url: str = ""        # full OAuth2 token endpoint
    tenant: str = ""
    client_id: str = ""
    client_secret: str = ""
    saak: str = ""             # service account access key (grant username)
    sask: str = ""             # service account secret key  (grant password)
    scope: str = ""
    # Path of the IDM REST API under the gateway. IDM is reached at
    # ``{api_url}/{idm_path}``; kept configurable because tenants differ.
    idm_path: str = "IDM/api"
    verify_tls: bool = True
    extra: dict = field(default_factory=dict)

    @classmethod
    def from_mapping(cls, data: dict | None) -> "IONConfig":
        data = dict(data or {})

        def pick(*keys, default=""):
            for k in keys:
                v = data.get(k)
                if v not in (None, ""):
                    return v
            return default

        api_url = pick("api_url", "iu")
        tenant = pick("tenant", "ti")
        # ION's token endpoint = pu + ot. Allow a fully-formed token_url too.
        token_url = pick("token_url")
        if not token_url:
            pu = pick("pu")
            ot = pick("ot", default="token.oauth2")
            if pu:
                token_url = urljoin(_ensure_slash(pu), ot)

        return cls(
            api_url=_ensure_slash(api_url) if api_url else "",
            token_url=token_url,
            tenant=tenant,
            client_id=pick("client_id", "ci"),
            client_secret=pick("client_secret", "cs"),
            saak=pick("saak"),
            sask=pick("sask"),
            scope=pick("scope"),
            idm_path=pick("idm_path", default="IDM/api"),
            verify_tls=bool(data.get("verify_tls", True)),
            extra={
                k: v
                for k, v in data.items()
                if k not in {
                    "api_url", "iu", "tenant", "ti", "token_url", "pu", "ot",
                    "client_id", "ci", "client_secret", "cs", "saak", "sask",
                    "scope", "idm_path", "verify_tls",
                }
            },
        )

    def missing_fields(self) -> list[str]:
        """Return the names of required-but-empty fields."""
        required = {
            "api_url": self.api_url,
            "token_url": self.token_url,
            "client_id": self.client_id,
            "client_secret": self.client_secret,
        }
        # Either a service account (saak/sask) or a scope-only client-credentials
        # flow is acceptable; require the service account pair by default since
        # IDM document access is normally bound to a service account.
        missing = [k for k, v in required.items() if not v]
        if not (self.saak and self.sask):
            missing.append("saak/sask")
        return missing


def _ensure_slash(url: str) -> str:
    return url if url.endswith("/") else url + "/"


def default_connection_from_settings() -> dict:
    """ION connection defaults sourced from Django settings (env).

    Returns the friendly-key shape used by the admin UI. Secrets are included
    so the runner can fall back to them, but callers exposing this to the
    browser must redact ``client_secret``/``sask``.
    """
    from django.conf import settings

    return {
        "api_url": getattr(settings, "ION_API_URL", "") or "",
        "token_url": getattr(settings, "ION_TOKEN_URL", "") or "",
        "tenant": getattr(settings, "ION_TENANT", "") or "",
        "client_id": getattr(settings, "ION_CLIENT_ID", "") or "",
        "client_secret": getattr(settings, "ION_CLIENT_SECRET", "") or "",
        "saak": getattr(settings, "ION_SAAK", "") or "",
        "sask": getattr(settings, "ION_SASK", "") or "",
        "scope": getattr(settings, "ION_SCOPE", "") or "",
        "idm_path": getattr(settings, "ION_IDM_PATH", "IDM/api") or "IDM/api",
        "verify_tls": bool(getattr(settings, "ION_VERIFY_TLS", True)),
    }


def merge_connection_with_defaults(connection: dict | None) -> dict:
    """Overlay a job's connection onto the environment defaults.

    Blank/missing values on the job fall back to the configured ION env
    defaults, so an operator can set credentials once in the environment and
    leave the per-job form mostly empty.
    """
    merged = default_connection_from_settings()
    for key, value in (connection or {}).items():
        if value not in (None, ""):
            merged[key] = value
    return merged


class IONClient:
    """Authenticated session against one ION/IDM tenant.

    Usage::

        client = IONClient(IONConfig.from_mapping(job.connection))
        client.test_connection()
        for item in client.iter_documents(query):
            data = client.download_document(item["id"])
    """

    def __init__(self, config: IONConfig, *, session: requests.Session | None = None):
        self.config = config
        self._session = session or requests.Session()
        self._token: str | None = None
        self._token_expiry: float = 0.0

    # ── auth ────────────────────────────────────────────────────────────────
    def _fetch_token(self) -> str:
        cfg = self.config
        missing = cfg.missing_fields()
        if missing:
            raise IONError(f"Incomplete ION connection settings: {', '.join(missing)}.")

        # ION service accounts use the OAuth2 "password" grant with saak/sask as
        # username/password. Fall back to client_credentials when no service
        # account is supplied.
        if cfg.saak and cfg.sask:
            payload = {
                "grant_type": "password",
                "username": cfg.saak,
                "password": cfg.sask,
                "client_id": cfg.client_id,
                "client_secret": cfg.client_secret,
            }
        else:
            payload = {
                "grant_type": "client_credentials",
                "client_id": cfg.client_id,
                "client_secret": cfg.client_secret,
            }
        if cfg.scope:
            payload["scope"] = cfg.scope

        try:
            resp = self._session.post(
                cfg.token_url,
                data=payload,
                timeout=_DEFAULT_TIMEOUT,
                verify=cfg.verify_tls,
                headers={"Accept": "application/json"},
            )
        except requests.RequestException as exc:
            raise IONError(f"Could not reach ION token endpoint: {exc}") from exc

        if resp.status_code != 200:
            raise IONError(
                f"ION authentication failed ({resp.status_code}): {_safe_body(resp)}"
            )
        try:
            data = resp.json()
        except ValueError as exc:
            raise IONError("ION token endpoint returned a non-JSON response.") from exc

        token = data.get("access_token")
        if not token:
            raise IONError("ION token response did not contain an access_token.")
        # Refresh a minute before expiry to avoid edge-of-window 401s.
        expires_in = int(data.get("expires_in", 3600))
        self._token = token
        self._token_expiry = time.monotonic() + max(expires_in - 60, 30)
        return token

    def _auth_header(self) -> dict:
        if not self._token or time.monotonic() >= self._token_expiry:
            self._fetch_token()
        return {"Authorization": f"Bearer {self._token}"}

    def _idm_url(self, path: str) -> str:
        base = urljoin(self.config.api_url, _ensure_slash(self.config.idm_path))
        return urljoin(base, path.lstrip("/"))

    # ── public API ────────────────────────────────────────────────────────────
    def test_connection(self) -> dict:
        """Validate credentials by acquiring a token.

        Returns a small status dict suitable for returning to the UI. Raises
        :class:`IONError` on failure.
        """
        self._fetch_token()
        return {
            "ok": True,
            "tenant": self.config.tenant,
            "api_url": self.config.api_url,
            "token_acquired": True,
        }

    def iter_documents(self, query: str = "", *, page_size: int = 50) -> Iterator[dict]:
        """Yield IDM item descriptors matching ``query``.

        The IDM item-search endpoint and its paging are tenant-dependent; this
        implementation targets the common ``/items`` search with offset paging
        and is the single place to adjust once a live response is available.
        Each yielded dict is the raw IDM item (callers read ``id`` and any
        attribute bag from it via :func:`apps.documents.migration` helpers).
        """
        offset = 0
        while True:
            params: dict[str, Any] = {"$offset": offset, "$top": page_size}
            if query:
                params["$query"] = query
            try:
                resp = self._session.get(
                    self._idm_url("items"),
                    params=params,
                    headers={**self._auth_header(), "Accept": "application/json"},
                    timeout=_DEFAULT_TIMEOUT,
                    verify=self.config.verify_tls,
                )
            except requests.RequestException as exc:
                raise IONError(f"ION item search failed: {exc}") from exc
            if resp.status_code != 200:
                raise IONError(
                    f"ION item search returned {resp.status_code}: {_safe_body(resp)}"
                )
            try:
                payload = resp.json()
            except ValueError as exc:
                raise IONError("ION item search returned a non-JSON response.") from exc

            items = _extract_items(payload)
            if not items:
                return
            for item in items:
                yield item
            if len(items) < page_size:
                return
            offset += len(items)

    def download_document(self, ion_id: str) -> tuple[bytes, str | None]:
        """Download the primary binary stream for an IDM item.

        Returns ``(content_bytes, content_type)``.
        """
        try:
            resp = self._session.get(
                self._idm_url(f"items/{ion_id}/content"),
                headers=self._auth_header(),
                timeout=_DEFAULT_TIMEOUT,
                verify=self.config.verify_tls,
                stream=True,
            )
        except requests.RequestException as exc:
            raise IONError(f"ION document download failed for {ion_id}: {exc}") from exc
        if resp.status_code != 200:
            raise IONError(
                f"ION document download for {ion_id} returned "
                f"{resp.status_code}: {_safe_body(resp)}"
            )
        return resp.content, resp.headers.get("Content-Type")


def _extract_items(payload: Any) -> list[dict]:
    """Best-effort pull of the item list out of an IDM search response.

    IDM responses vary (``{"items": [...]}``, ``{"value": [...]}`` for OData,
    or a bare list). Handle the common shapes; unknown shapes yield nothing so
    paging terminates cleanly rather than looping.
    """
    if isinstance(payload, list):
        return [x for x in payload if isinstance(x, dict)]
    if isinstance(payload, dict):
        for key in ("items", "value", "results", "documents"):
            val = payload.get(key)
            if isinstance(val, list):
                return [x for x in val if isinstance(x, dict)]
    return []


def _safe_body(resp: requests.Response, limit: int = 500) -> str:
    try:
        return resp.text[:limit]
    except Exception:  # pragma: no cover - defensive
        return "<unreadable response body>"
