"""
apps/accounts/oidc_auth.py

OIDC / Keycloak helpers for the DMS token-exchange flow.

Responsibilities:
  1. fetch_keycloak_jwks()     — get public keys from Keycloak's JWKS endpoint,
                                 cached in Redis to avoid per-request network calls.
  2. validate_id_token()       — verify RS256 signature, iss, aud, exp.
  3. provision_or_link_user()  — resolve an existing DMS user from the validated
                                 JWT claims. Keycloak authenticates; DMS remains
                                 the identity and authorization source of truth.

Design notes
------------
* We use the internal Docker hostname (keycloak:8080) for JWKS fetching — no
  host routing, reliable from within the backend container.
* The JWT `iss` claim will say `http://localhost:8080/...` (the browser-facing
  URL set via KC_HOSTNAME).  We validate against that value, NOT the internal URL.
* JWKS are cached for OIDC_JWKS_CACHE_TTL seconds (default 1 h).  On a kid miss
  we force-refresh once in case Keycloak rotated its signing key.
* Authorization is not synced from Keycloak roles. The custom protocol mapper
  emits live DMS claims, and DMS still authorizes against its own database.
"""

from __future__ import annotations

import json
import logging
from typing import Any

import jwt
from jwt.algorithms import RSAAlgorithm
import requests
from django.conf import settings
from django.core.cache import cache

logger = logging.getLogger(__name__)

# ── Cache key ─────────────────────────────────────────────────────────────────
_JWKS_CACHE_KEY = "oidc:keycloak:jwks"


# ── 1. JWKS fetching ──────────────────────────────────────────────────────────

def fetch_keycloak_jwks(*, force_refresh: bool = False) -> dict[str, Any]:
    """
    Return the Keycloak JWKS document (dict with a ``keys`` list).

    Cached in Redis for ``settings.OIDC_JWKS_CACHE_TTL`` seconds.
    Pass ``force_refresh=True`` to bypass the cache (used when a key-ID miss
    suggests Keycloak has rotated its signing key).
    """
    if not force_refresh:
        cached = cache.get(_JWKS_CACHE_KEY)
        if cached is not None:
            return cached

    endpoint = settings.OIDC_OP_JWKS_ENDPOINT
    try:
        response = requests.get(endpoint, timeout=5)
        response.raise_for_status()
    except requests.RequestException as exc:
        logger.error("Failed to fetch Keycloak JWKS from %s: %s", endpoint, exc)
        raise

    jwks = response.json()
    cache.set(_JWKS_CACHE_KEY, jwks, timeout=settings.OIDC_JWKS_CACHE_TTL)
    return jwks


def _get_signing_key(raw_token: str, jwks: dict[str, Any]):
    """
    Locate the RSA public key from the JWKS that matches the JWT's ``kid`` header.
    Returns a cryptography RSA public key object.

    Uses ``jwt.algorithms.RSAAlgorithm.from_jwk()`` — available in all
    PyJWT 2.x versions, unlike the ``PyJWKClient.from_jwks()`` classmethod
    which was added only in later 2.x point releases.
    """
    header = jwt.get_unverified_header(raw_token)
    kid = header.get("kid")

    for key_data in jwks.get("keys", []):
        if key_data.get("kid") == kid:
            return RSAAlgorithm.from_jwk(json.dumps(key_data))

    raise jwt.exceptions.PyJWKClientError(
        f"No signing key found for kid={kid!r}. "
        "Keycloak may have rotated its keys — retry with force_refresh=True."
    )


# ── 2. Token validation ───────────────────────────────────────────────────────

def validate_id_token(raw_token: str) -> dict[str, Any]:
    """
    Validate a Keycloak id_token (RS256).

    Returns the decoded payload dict on success.
    Raises ``jwt.PyJWTError`` (or subclass) on any validation failure.

    Validation checks:
      * RS256 signature via RSA public key from JWKS (matched by ``kid``)
      * ``iss`` == settings.OIDC_OP_ISSUER
      * ``aud`` contains settings.OIDC_CLIENT_ID
      * ``exp`` not expired
    """
    def _decode(jwks: dict) -> dict:
        signing_key = _get_signing_key(raw_token, jwks)
        return jwt.decode(
            raw_token,
            signing_key,
            algorithms=["RS256"],
            issuer=settings.OIDC_OP_ISSUER,
            audience=settings.OIDC_CLIENT_ID,
            options={"require": ["exp", "iat", "sub", "iss", "aud"]},
        )

    try:
        return _decode(fetch_keycloak_jwks())
    except jwt.exceptions.PyJWKClientError:
        # Key ID not found — Keycloak may have rotated keys; refresh and retry.
        logger.info("JWKS kid miss — forcing refresh and retrying.")
        return _decode(fetch_keycloak_jwks(force_refresh=True))


# ── 3. User provisioning / linking ────────────────────────────────────────────

def provision_or_link_user(claims: dict[str, Any]):
    """
    Given validated JWT claims, return the corresponding DMS ``User`` instance.

    Lookup order:
      1. ``dms_user_id`` custom claim from the DMS protocol mapper
      2. ``oidc_sub`` match for accounts already linked during earlier OIDC work
      3. ``email`` / ``preferred_username`` match from federated Keycloak data

    This function deliberately does not create users or sync roles from
    Keycloak. Creating, editing, and authorizing users stays in DMS.
    """
    from .models import User  # avoid circular import at module load time

    sub = claims["sub"]
    dms_user_id = claims.get("dms_user_id") or claims.get("dms_id")
    email = (
        claims.get("email")
        or claims.get("preferred_username")
        or claims.get("username")
        or ""
    ).strip().lower()

    user = None
    if dms_user_id:
        user = User.objects.filter(id=dms_user_id).first()
    if user is None:
        user = User.objects.filter(oidc_sub=sub).first()
    if user is None and email:
        user = User.objects.filter(email=email).first()

    if user is None:
        raise ValueError(
            "No matching DMS user exists for this Keycloak identity. "
            "Create or activate the user in DMS first."
        )

    update_fields = []
    if user.oidc_sub != sub:
        user.oidc_sub = sub
        update_fields.append("oidc_sub")
    if update_fields:
        user.save(update_fields=update_fields)

    logger.info("OIDC: resolved DMS user %s via federated Keycloak login", user.email)
    return user
