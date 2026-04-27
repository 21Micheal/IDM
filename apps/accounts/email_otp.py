"""
apps/accounts/email_otp.py
Sends OTP emails using Django's configured email backend.
In development (EMAIL_BACKEND = console) the code prints to terminal.
In production point to Gmail SMTP via settings.
"""
from django.core.mail import send_mail
from django.conf import settings
from django.template.loader import render_to_string
from django.utils.html import strip_tags

from .models import EmailOTP, User


def send_otp_email(user: User, purpose: str = "login") -> EmailOTP:
    """
    Generate a fresh OTP for the user and send it to their email.
    Returns the EmailOTP instance (useful for testing).
    """
    otp = EmailOTP.generate(user, purpose=purpose)

    subject = {
        "login":    "Your DMS login code",
        "mfa_setup": "Confirm your DMS email verification",
    }.get(purpose, "Your DMS verification code")

    # Plain-text body — no template required
    body = f"""Hello {user.first_name},

Your one-time verification code is:

    {otp.code}

This code expires in {EmailOTP.OTP_EXPIRY_MINUTES} minutes.
Do not share it with anyone.

If you did not request this code, please contact your system administrator immediately.

— DMS Security
"""

    send_mail(
        subject=subject,
        message=body,
        from_email=settings.DEFAULT_FROM_EMAIL,
        recipient_list=[user.email],
        fail_silently=False,
    )

    return otp
