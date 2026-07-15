"""
apps/sunsystems/crypto.py

Encryption-at-rest for SunSystems connection secrets (the SOAP password).

The connection is stored as a JSON dict on the ``SunSystemsConnection`` singleton.
Secret fields are encrypted with Fernet (AES-128-CBC + HMAC) using a key derived
from Django's ``SECRET_KEY``, and carry an ``enc:1:`` marker so we can tell an
encrypted value from a legacy plaintext one and migrate transparently.

Why derive from SECRET_KEY: no new key to manage/rotate separately for a single
low-volume secret. The trade-off is that rotating ``SECRET_KEY`` invalidates the
stored secret — on a decrypt failure we return "" and log, so the connection
falls back to env defaults and the admin simply re-enters the password.
"""
from __future__ import annotations

import base64
import hashlib
import logging

from cryptography.fernet import Fernet, InvalidToken

logger = logging.getLogger(__name__)

_PREFIX = "enc:1:"

# Connection keys that hold secrets and must be encrypted at rest.
SECRET_KEYS = ("password",)


def _fernet() -> Fernet:
    from django.conf import settings

    digest = hashlib.sha256((settings.SECRET_KEY or "").encode("utf-8")).digest()
    return Fernet(base64.urlsafe_b64encode(digest))


def encrypt_secret(plain: str) -> str:
    """Return an ``enc:1:`` token for ``plain``. Blank stays blank."""
    if not plain:
        return ""
    token = _fernet().encrypt(plain.encode("utf-8")).decode("ascii")
    return _PREFIX + token


def decrypt_secret(value: str) -> str:
    """Inverse of :func:`encrypt_secret`. A value without the marker is treated
    as legacy plaintext and returned as-is (backward compatible)."""
    if not value:
        return ""
    if not value.startswith(_PREFIX):
        return value  # legacy plaintext / env value
    try:
        return _fernet().decrypt(value[len(_PREFIX):].encode("ascii")).decode("utf-8")
    except (InvalidToken, ValueError):
        logger.warning("SunSystems secret could not be decrypted (SECRET_KEY changed?).")
        return ""


def is_encrypted(value: str) -> bool:
    return bool(value) and value.startswith(_PREFIX)


def encrypt_connection(conn: dict) -> dict:
    """Copy of ``conn`` with secret fields encrypted (skipping already-encrypted)."""
    out = dict(conn or {})
    for key in SECRET_KEYS:
        v = out.get(key)
        if v and not is_encrypted(v):
            out[key] = encrypt_secret(v)
    return out


def decrypt_connection(conn: dict) -> dict:
    """Copy of ``conn`` with secret fields decrypted for actual use."""
    out = dict(conn or {})
    for key in SECRET_KEYS:
        if out.get(key):
            out[key] = decrypt_secret(out[key])
    return out
