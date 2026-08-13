"""
System identity used to attribute documents ingested from email.

Email ingestion creates DRAFT documents that land in the bulk-upload review
queue. Those documents should not appear as if the admin who configured the
mailbox uploaded them — they are attributed to a dedicated "Email bot" user
so Documents / Dashboard show a clear provenance signal.
"""
from __future__ import annotations

from django.contrib.auth import get_user_model

EMAIL_BOT_EMAIL = "email-bot@system.local"
EMAIL_BOT_FIRST_NAME = "Email"
EMAIL_BOT_LAST_NAME = "bot"


def get_email_bot_user():
    """Return the singleton system user that owns email-ingested documents.

    Created on first use. Inactive for login (``is_active=True`` so FKs stay
    usable, but no usable password and MFA off). Display name is ``Email bot``.
    """
    User = get_user_model()
    user, created = User.objects.get_or_create(
        email=EMAIL_BOT_EMAIL,
        defaults={
            "first_name": EMAIL_BOT_FIRST_NAME,
            "last_name": EMAIL_BOT_LAST_NAME,
            "is_active": True,
            "is_staff": False,
            "is_superuser": False,
            "must_change_password": False,
            "mfa_enabled": False,
        },
    )
    if created:
        user.set_unusable_password()
        user.save(update_fields=["password"])
    elif user.first_name != EMAIL_BOT_FIRST_NAME or user.last_name != EMAIL_BOT_LAST_NAME:
        # Keep the display name stable if an operator renamed the account.
        user.first_name = EMAIL_BOT_FIRST_NAME
        user.last_name = EMAIL_BOT_LAST_NAME
        user.save(update_fields=["first_name", "last_name", "updated_at"])
    return user


def is_email_bot(user) -> bool:
    """Whether ``user`` is the email-ingestion system identity."""
    return bool(user) and getattr(user, "email", None) == EMAIL_BOT_EMAIL
