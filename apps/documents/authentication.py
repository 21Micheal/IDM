"""
Optional query-signature authentication for document file streaming.

Used when <img> or window.open cannot attach a Bearer token; the signed URL
carries a time-limited MAC tied to the user and query parameters.
"""
from django.contrib.auth import get_user_model
from rest_framework.authentication import BaseAuthentication
from rest_framework.exceptions import AuthenticationFailed

from .file_streaming import signed_file_urls_enabled, unsign_file_payload, verify_file_query_matches_payload

User = get_user_model()


class DocumentFileSignatureAuthentication(BaseAuthentication):
    """
    Authenticate via ?sig= when no Authorization: Bearer header is present.
    JWT authentication runs first in the view action configuration.
    """

    def authenticate(self, request):
        auth = request.META.get("HTTP_AUTHORIZATION") or ""
        if auth.strip().lower().startswith("bearer "):
            return None

        sig = (request.query_params.get("sig") or "").strip()
        if not sig:
            return None
        if not signed_file_urls_enabled():
            return None

        try:
            payload = unsign_file_payload(sig)
        except Exception as exc:
            raise AuthenticationFailed("Invalid or expired file link.") from exc

        if not verify_file_query_matches_payload(request, payload):
            raise AuthenticationFailed("File link does not match request parameters.")

        try:
            user = User.objects.get(pk=payload["sub"], is_active=True)
        except User.DoesNotExist as exc:
            raise AuthenticationFailed("Unknown user for file link.") from exc

        return (user, None)
