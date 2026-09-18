"""Per-deployment IDP usage recording and rollups."""
from __future__ import annotations

import logging
from datetime import date, timedelta
from decimal import Decimal
from typing import Any

from django.conf import settings as django_settings
from django.db.models import F, Sum
from django.utils import timezone

logger = logging.getLogger(__name__)

# Claude Haiku-class defaults ($/million tokens) — override via env.
_DEFAULT_INPUT_PER_MTOK = Decimal("0.80")
_DEFAULT_OUTPUT_PER_MTOK = Decimal("4.00")


def estimate_token_cost_usd(
    *,
    input_tokens: int = 0,
    output_tokens: int = 0,
    cache_read_tokens: int = 0,
    cache_write_tokens: int = 0,
) -> Decimal:
    input_rate = Decimal(
        str(getattr(django_settings, "IDP_COST_INPUT_PER_MTOK", _DEFAULT_INPUT_PER_MTOK))
    )
    output_rate = Decimal(
        str(getattr(django_settings, "IDP_COST_OUTPUT_PER_MTOK", _DEFAULT_OUTPUT_PER_MTOK))
    )
    # Cache reads are cheaper; treat writes like input if no separate rate.
    cache_read_rate = input_rate * Decimal("0.1")
    cache_write_rate = input_rate * Decimal("1.25")

    cost = (
        (Decimal(input_tokens) * input_rate)
        + (Decimal(output_tokens) * output_rate)
        + (Decimal(cache_read_tokens) * cache_read_rate)
        + (Decimal(cache_write_tokens) * cache_write_rate)
    ) / Decimal("1000000")
    return cost.quantize(Decimal("0.000001"))


def usage_from_anthropic_response(response) -> dict[str, int]:
    """Extract token counts from an Anthropic Messages API response."""
    usage = getattr(response, "usage", None)
    if usage is None:
        return {}
    cache_creation = getattr(usage, "cache_creation", None) or {}
    if hasattr(cache_creation, "ephemeral_5m_input_tokens"):
        cache_write = int(
            getattr(cache_creation, "ephemeral_5m_input_tokens", 0) or 0
        ) + int(getattr(cache_creation, "ephemeral_1h_input_tokens", 0) or 0)
    elif isinstance(cache_creation, dict):
        cache_write = int(cache_creation.get("ephemeral_5m_input_tokens") or 0) + int(
            cache_creation.get("ephemeral_1h_input_tokens") or 0
        )
    else:
        cache_write = int(getattr(usage, "cache_creation_input_tokens", 0) or 0)

    return {
        "input_tokens": int(getattr(usage, "input_tokens", 0) or 0),
        "output_tokens": int(getattr(usage, "output_tokens", 0) or 0),
        "cache_read_tokens": int(getattr(usage, "cache_read_input_tokens", 0) or 0),
        "cache_write_tokens": cache_write,
    }


def record_idp_usage_event(
    *,
    outcome: str,
    claude_pages: int = 0,
    input_tokens: int = 0,
    output_tokens: int = 0,
    cache_read_tokens: int = 0,
    cache_write_tokens: int = 0,
    on_date: date | None = None,
) -> None:
    """
    Atomically bump today's IdpUsageDaily row.

    outcome: "claude" | "regex" | "needs_manual" | "failed"
    """
    from apps.documents.models import IdpUsageDaily

    day = on_date or timezone.localdate()
    doc_field = {
        "claude": "claude_docs",
        "regex": "regex_docs",
        "needs_manual": "needs_manual_docs",
        "failed": "failed_docs",
    }.get(outcome)
    if not doc_field:
        logger.warning("record_idp_usage_event: unknown outcome=%s", outcome)
        return

    cost_delta = estimate_token_cost_usd(
        input_tokens=input_tokens,
        output_tokens=output_tokens,
        cache_read_tokens=cache_read_tokens,
        cache_write_tokens=cache_write_tokens,
    )

    row, _created = IdpUsageDaily.objects.get_or_create(date=day)
    updates: dict[str, Any] = {
        doc_field: F(doc_field) + 1,
        "claude_pages": F("claude_pages") + max(0, int(claude_pages or 0)),
        "input_tokens": F("input_tokens") + max(0, int(input_tokens or 0)),
        "output_tokens": F("output_tokens") + max(0, int(output_tokens or 0)),
        "cache_read_tokens": F("cache_read_tokens") + max(0, int(cache_read_tokens or 0)),
        "cache_write_tokens": F("cache_write_tokens") + max(0, int(cache_write_tokens or 0)),
        "estimated_cost_usd": F("estimated_cost_usd") + cost_delta,
    }
    IdpUsageDaily.objects.filter(pk=row.pk).update(**updates)


def build_idp_usage_report(*, days: int = 30, include_billing: bool = False) -> dict:
    """Roll up IdpUsageDaily + DMSSettings pages for the Admin UI."""
    from apps.documents.models import DMSSettings, IdpUsageDaily

    days = max(1, min(int(days or 30), 90))
    end = timezone.localdate()
    start = end - timedelta(days=days - 1)
    month_start = end.replace(day=1)

    qs = IdpUsageDaily.objects.filter(date__gte=start, date__lte=end).order_by("date")
    month_qs = IdpUsageDaily.objects.filter(date__gte=month_start, date__lte=end)

    def _sum(queryset, *fields):
        agg = queryset.aggregate(**{f: Sum(f) for f in fields})
        return {f: int(agg[f] or 0) for f in fields}

    month_docs = _sum(
        month_qs,
        "claude_docs",
        "regex_docs",
        "needs_manual_docs",
        "failed_docs",
        "claude_pages",
    )
    total_outcomes = (
        month_docs["claude_docs"]
        + month_docs["needs_manual_docs"]
        + month_docs["failed_docs"]
    )
    # Success = Claude completed extraction (not regex/manual).
    success_rate = (
        round(100.0 * month_docs["claude_docs"] / total_outcomes, 1)
        if total_outcomes
        else None
    )

    dms = DMSSettings.load()
    daily = [
        {
            "date": row.date.isoformat(),
            "claude_docs": row.claude_docs,
            "regex_docs": row.regex_docs,
            "needs_manual_docs": row.needs_manual_docs,
            "failed_docs": row.failed_docs,
            "claude_pages": row.claude_pages,
            "documents": (
                row.claude_docs
                + row.regex_docs
                + row.needs_manual_docs
                + row.failed_docs
            ),
        }
        for row in qs
    ]

    report: dict[str, Any] = {
        "summary": {
            "period_days": days,
            "month_start": month_start.isoformat(),
            "claude_docs": month_docs["claude_docs"],
            "regex_docs": month_docs["regex_docs"],
            "needs_manual_docs": month_docs["needs_manual_docs"],
            "failed_docs": month_docs["failed_docs"],
            "documents_processed": (
                month_docs["claude_docs"]
                + month_docs["regex_docs"]
                + month_docs["needs_manual_docs"]
                + month_docs["failed_docs"]
            ),
            "claude_pages_month": month_docs["claude_pages"],
            "pages_used": dms.idp_pages_used,
            "page_reference_target": dms.idp_page_allowance,
            "success_rate_pct": success_rate,
        },
        "daily": daily,
    }

    if include_billing:
        month_tokens = month_qs.aggregate(
            input_tokens=Sum("input_tokens"),
            output_tokens=Sum("output_tokens"),
            cache_read_tokens=Sum("cache_read_tokens"),
            cache_write_tokens=Sum("cache_write_tokens"),
            estimated_cost_usd=Sum("estimated_cost_usd"),
        )
        cost = month_tokens["estimated_cost_usd"] or Decimal("0")
        limit = dms.idp_monthly_limit_usd or Decimal("0")
        report["billing"] = {
            "input_tokens": int(month_tokens["input_tokens"] or 0),
            "output_tokens": int(month_tokens["output_tokens"] or 0),
            "cache_read_tokens": int(month_tokens["cache_read_tokens"] or 0),
            "cache_write_tokens": int(month_tokens["cache_write_tokens"] or 0),
            "estimated_cost_usd": str(cost.quantize(Decimal("0.000001"))),
            "monthly_limit_usd": str(limit.quantize(Decimal("0.01"))),
            "limit_used_pct": (
                round(float(cost / limit) * 100, 1) if limit > 0 else None
            ),
        }

    return report
