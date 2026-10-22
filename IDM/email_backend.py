"""Django SMTP backend using Microsoft Entra client-credentials OAuth2."""

import base64
import json
import smtplib
import ssl
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

from django.conf import settings
from django.core.mail.backends.smtp import EmailBackend


class OAuth2SMTPEmailBackend(EmailBackend):
    """Authenticate to SMTP with XOAUTH2 and an Entra client-credentials token."""

    def _access_token(self):
        tenant_id = getattr(settings, "EMAIL_OAUTH_TENANT_ID", "")
        client_id = getattr(settings, "EMAIL_OAUTH_CLIENT_ID", "")
        client_secret = getattr(settings, "EMAIL_OAUTH_CLIENT_SECRET", "")
        scope = getattr(
            settings,
            "EMAIL_OAUTH_SCOPE",
            "https://outlook.office365.com/.default",
        )
        if not all((tenant_id, client_id, client_secret)):
            raise ValueError(
                "EMAIL_OAUTH_TENANT_ID, EMAIL_OAUTH_CLIENT_ID, and "
                "EMAIL_OAUTH_CLIENT_SECRET are required for SMTP OAuth2."
            )

        token_url = f"https://login.microsoftonline.com/{tenant_id}/oauth2/v2.0/token"
        body = urlencode(
            {
                "client_id": client_id,
                "client_secret": client_secret,
                "scope": scope,
                "grant_type": "client_credentials",
            }
        ).encode("ascii")
        request = Request(
            token_url,
            data=body,
            headers={"Content-Type": "application/x-www-form-urlencoded"},
            method="POST",
        )
        try:
            with urlopen(request, timeout=self.timeout or 30) as response:
                payload = json.loads(response.read().decode("utf-8"))
        except HTTPError as exc:
            # Avoid including the response body, which may echo sensitive details.
            raise RuntimeError(
                f"Microsoft Entra token request failed (HTTP {exc.code})."
            ) from None
        except (URLError, TimeoutError) as exc:
            raise RuntimeError("Could not reach the Microsoft Entra token endpoint.") from exc

        token = payload.get("access_token")
        if not token:
            error = payload.get("error", "unknown_error")
            raise RuntimeError(f"Microsoft Entra returned no access token ({error}).")
        return token

    def open(self):
        if self.connection:
            return False

        connection = None
        try:
            if self.use_ssl:
                connection = smtplib.SMTP_SSL(
                    self.host,
                    self.port,
                    timeout=self.timeout,
                    context=self.ssl_context,
                )
            else:
                connection = smtplib.SMTP(self.host, self.port, timeout=self.timeout)

            if self.use_tls and not self.use_ssl:
                connection.ehlo()
                connection.starttls(context=self.ssl_context)
                connection.ehlo()

            username = self.username or ""
            if not username:
                raise ValueError("EMAIL_HOST_USER must be the authorized sender mailbox.")
            token = self._access_token()
            sasl = f"user={username}\x01auth=Bearer {token}\x01\x01".encode("utf-8")
            encoded = base64.b64encode(sasl).decode("ascii")
            code, response = connection.docmd("AUTH", f"XOAUTH2 {encoded}")
            if code != 235:
                raise smtplib.SMTPAuthenticationError(code, response)

            self.connection = connection
            return True
        except (OSError, smtplib.SMTPException, RuntimeError, ValueError):
            if connection is not None:
                try:
                    connection.close()
                except OSError:
                    pass
            if not self.fail_silently:
                raise
            return False
