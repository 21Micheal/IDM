"""
Tenant IDP policy — entitlement, failure reasons, and fallback routing.

Separates commercial entitlement (Claude enabled) from runtime availability
(API/spend errors) and tenant admin policy (claude_only / ask / regex).

Page counts (idp_pages_used / idp_page_allowance) are reporting-only.
Hard spend limits are enforced by Anthropic workspace caps on each API key.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass

from apps.documents.ocr.status import clear_ocr_tracking_metadata

logger = logging.getLogger(__name__)


def resolve_anthropic_api_key() -> str:
    """
    Return the Anthropic API key for the current tenant/deployment.

    Prefers the operator-managed key on DMSSettings, then falls back to the
    global ANTHROPIC_API_KEY environment variable.
    """
    from django.conf import settings as django_settings

    from apps.documents.models import DMSSettings

    row = DMSSettings.load()
    db_key = (row.idp_anthropic_api_key or "").strip()
    if db_key:
        return db_key
    return str(getattr(django_settings, "ANTHROPIC_API_KEY", "") or "").strip()


def has_anthropic_api_key() -> bool:
    return bool(resolve_anthropic_api_key())


@dataclass(frozen=True)
class IdpPolicy:
    claude_enabled: bool
    fallback_policy: str
    allow_regex_fallback: bool
    page_allowance: int
    pages_used: int

    @classmethod
    def load(cls) -> "IdpPolicy":
        from apps.documents.models import DMSSettings

        row = DMSSettings.load()
        return cls(
            claude_enabled=row.idp_claude_enabled,
            fallback_policy=row.idp_fallback_policy,
            allow_regex_fallback=row.idp_allow_regex_fallback,
            page_allowance=row.idp_page_allowance,
            pages_used=row.idp_pages_used,
        )

    def has_page_budget(self, pages: int = 1) -> bool:
        """Reporting-only — page allowance is never enforced in the application."""
        return True

    def should_use_regex_on_failure(self, reason: str) -> bool:
        from apps.documents.models import DMSSettings

        if reason in {"subscription_inactive", "quota_exhausted"}:
            return (
                self.fallback_policy == DMSSettings.IdpFallbackPolicy.CLAUDE_THEN_REGEX
                and self.allow_regex_fallback
            )
        if self.fallback_policy == DMSSettings.IdpFallbackPolicy.CLAUDE_THEN_REGEX:
            return self.allow_regex_fallback
        return False

    def awaiting_user_choice(self) -> bool:
        from apps.documents.models import DMSSettings

        return self.fallback_policy == DMSSettings.IdpFallbackPolicy.CLAUDE_ASK


def classify_anthropic_error(exc: BaseException) -> str:
    """Map an Anthropic/runtime exception to a stable failure reason code."""
    msg = str(exc).lower()
    name = type(exc).__name__.lower()
    if "rate" in msg or "429" in msg or "rate" in name:
        return "rate_limited"
    if any(
        token in msg
        for token in (
            "402",
            "credit",
            "billing",
            "spend",
            "quota",
            "insufficient",
            "balance",
            "limit exceeded",
            "usage limit",
            "budget",
        )
    ):
        return "quota_exhausted"
    if any(token in msg for token in ("401", "403", "authentication", "api_key", "unauthorized")):
        return "auth_error"
    if any(token in msg for token in ("timeout", "timed out", "connection", "unreachable", "503", "502")):
        return "unreachable"
    return "extraction_error"


def claude_unavailable_reason(*, policy: IdpPolicy, has_api_key: bool | None = None) -> str | None:
    if not policy.claude_enabled:
        return "subscription_inactive"
    if has_api_key is None:
        has_api_key = has_anthropic_api_key()
    if not has_api_key:
        return "anthropic_key_missing"
    return None


def increment_idp_pages_used(pages: int) -> None:
    if pages <= 0:
        return
    from django.db.models import F

    from apps.documents.models import DMSSettings

    DMSSettings.objects.filter(pk=1).update(idp_pages_used=F("idp_pages_used") + pages)


def estimate_claude_pages(doc) -> int:
    from django.conf import settings as django_settings

    mime = (doc.file_mime_type or "").lower()
    max_pages = int(getattr(django_settings, "OCR_IDP_MAX_PAGES", 3))
    if mime.startswith("image/"):
        return 1
    if mime != "application/pdf":
        return 1
    try:
        import pdfplumber

        with pdfplumber.open(doc.file.path) as pdf:
            return min(len(pdf.pages), max_pages)
    except Exception:
        return 1


def should_promote_suggestions(quality: dict | None) -> bool:
    """Only Claude-extracted values may auto-fill canonical Document columns."""
    if not isinstance(quality, dict):
        return False
    if quality.get("user_confirmed"):
        return True
    engine = str(quality.get("engine") or "").lower()
    return engine.startswith("claude")


def build_needs_manual_metadata(*, reason: str, awaiting_user_choice: bool) -> dict:
    return {
        "ocr_suggestions": {
            "fields": {},
            "quality": {
                "engine": None,
                "provider": "anthropic",
                "model": None,
                "confidence": None,
                "low_quality_warning": True,
                "fallback_reason": reason,
                "requires_review": True,
                "awaiting_user_choice": awaiting_user_choice,
            },
        },
    }


def apply_idp_unavailable_state(document) -> bool:
    """
    Mark a document needs_manual when Claude cannot run and policy forbids
    automatic regex. Skips queuing the heavy local OCR pipeline.

    Returns True when the document was updated (caller should not queue OCR).
    """
    from apps.documents.models import OCRStatus

    policy = IdpPolicy.load()
    reason = claude_unavailable_reason(policy=policy)
    if not reason or policy.should_use_regex_on_failure(reason):
        return False

    metadata_updates = build_needs_manual_metadata(
        reason=reason,
        awaiting_user_choice=policy.awaiting_user_choice(),
    )
    current_metadata = document.metadata or {}
    merged_metadata = {**current_metadata, **metadata_updates}
    merged_metadata = clear_ocr_tracking_metadata(merged_metadata)

    type(document).objects.filter(id=document.id).update(
        ocr_status=OCRStatus.NEEDS_MANUAL,
        metadata=merged_metadata,
    )
    document.ocr_status = OCRStatus.NEEDS_MANUAL
    document.metadata = merged_metadata
    return True
