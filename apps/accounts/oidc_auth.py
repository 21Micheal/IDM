"""
OIDC / Keycloak helpers for the DMS PKCE token-exchange flow.

Split-horizon:
  JWKS fetch  → KEYCLOAK_INTERNAL_URL (http://keycloak:8080)
  issuer/aud  → KEYCLOAK_URL / OIDC_OP_ISSUER (http://localhost:8080/realms/idp-dev)
"""
from __future__ annotations

import json
import logging
from typing import Any
from urllib.request import Request, urlopen

import jwt
from django.conf import settings
from django.core.cache import cache
from jwt.algorithms import RSAAlgorithm

logger = logging.getLogger(__name__)

_JWKS_CACHE_KEY = "oidc:keycloak:jwks"


def fetch_keycloak_jwks(*, force_refresh: bool = False) -> dict[str, Any]:
    if not force_refresh:
        cached = cache.get(_JWKS_CACHE_KEY)
        if cached is not None:
            return cached

    endpoint = settings.OIDC_OP_JWKS_ENDPOINT
    request = Request(endpoint, headers={"Accept": "application/json"})
    with urlopen(request, timeout=5) as response:
        jwks = json.loads(response.read().decode("utf-8"))
    cache.set(_JWKS_CACHE_KEY, jwks, timeout=getattr(settings, "OIDC_JWKS_CACHE_TTL", 300))
    return jwks


def _get_signing_key(raw_token: str, jwks: dict[str, Any]):
    header = jwt.get_unverified_header(raw_token)
    kid = header.get("kid")
    for key_data in jwks.get("keys", []):
        if key_data.get("kid") == kid:
            return RSAAlgorithm.from_jwk(json.dumps(key_data))
    raise jwt.exceptions.PyJWKClientError(f"No signing key found for kid={kid!r}.")


def validate_id_token(raw_token: str) -> dict[str, Any]:
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
        logger.info("JWKS kid miss — forcing refresh and retrying.")
        return _decode(fetch_keycloak_jwks(force_refresh=True))


def resolve_dms_user(claims: dict[str, Any]):
    from .models import User

    email = (
        claims.get("email")
        or claims.get("preferred_username")
        or claims.get("username")
        or ""
    ).strip().lower()
    user_id = claims.get("dms_user_id")

    user = None
    if user_id:
        user = User.objects.filter(id=user_id).first()
    if user is None and email:
        user = User.objects.filter(email=email).first()
    if user is None:
        raise ValueError(
            "No matching DMS user exists for this Keycloak identity."
        )
    return user
