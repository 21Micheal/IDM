"""Thin client for Anthropic Admin Usage & Cost APIs."""
from __future__ import annotations

import logging
from datetime import date, datetime, time, timezone
from decimal import Decimal
from typing import Any
from urllib.parse import urlencode

import requests
from django.conf import settings

logger = logging.getLogger(__name__)

ANTHROPIC_VERSION = "2023-06-01"
USAGE_URL = "https://api.anthropic.com/v1/organizations/usage_report/messages"
COST_URL = "https://api.anthropic.com/v1/organizations/cost_report"
API_KEYS_URL = "https://api.anthropic.com/v1/organizations/api_keys"


def admin_api_key() -> str:
    return str(getattr(settings, "ANTHROPIC_ADMIN_KEY", "") or "").strip()


def _headers() -> dict[str, str]:
    return {
        "x-api-key": admin_api_key(),
        "anthropic-version": ANTHROPIC_VERSION,
        "User-Agent": "FlaxemDMS/1.0 (billing-control-plane)",
    }


def _day_bounds(day: date) -> tuple[str, str]:
    start = datetime.combine(day, time.min, tzinfo=timezone.utc)
    end = datetime.combine(day, time.max, tzinfo=timezone.utc).replace(microsecond=0)
    # ending_at is exclusive in some docs — use next midnight for clean daily buckets
    end_excl = datetime.combine(day, time.min, tzinfo=timezone.utc)
    from datetime import timedelta

    end_excl = end_excl + timedelta(days=1)
    return start.strftime("%Y-%m-%dT%H:%M:%SZ"), end_excl.strftime("%Y-%m-%dT%H:%M:%SZ")


def _get_paginated(url: str, params: list[tuple[str, str]]) -> list[dict[str, Any]]:
    """Fetch all time buckets from a paginated Admin report endpoint."""
    buckets: list[dict[str, Any]] = []
    page: str | None = None
    while True:
        q = list(params)
        if page:
            q.append(("page", page))
        full = f"{url}?{urlencode(q)}"
        resp = requests.get(full, headers=_headers(), timeout=45)
        resp.raise_for_status()
        payload = resp.json()
        buckets.extend(payload.get("data") or [])
        if not payload.get("has_more"):
            break
        page = payload.get("next_page")
        if not page:
            break
    return buckets


def fetch_usage_by_api_key(day: date, api_key_ids: list[str] | None = None) -> dict[str, dict[str, int]]:
    """
    Return {api_key_id: token counts} for ``day``.

    Token fields: input_tokens, output_tokens, cache_read_tokens, cache_write_tokens.
    """
    starting_at, ending_at = _day_bounds(day)
    params: list[tuple[str, str]] = [
        ("starting_at", starting_at),
        ("ending_at", ending_at),
        ("bucket_width", "1d"),
        ("group_by[]", "api_key_id"),
        ("limit", "31"),
    ]
    if api_key_ids:
        for key_id in api_key_ids:
            params.append(("api_key_ids[]", key_id))

    buckets = _get_paginated(USAGE_URL, params)
    totals: dict[str, dict[str, int]] = {}

    for bucket in buckets:
        for item in bucket.get("results") or []:
            key_id = item.get("api_key_id")
            if not key_id:
                continue
            row = totals.setdefault(
                key_id,
                {
                    "input_tokens": 0,
                    "output_tokens": 0,
                    "cache_read_tokens": 0,
                    "cache_write_tokens": 0,
                },
            )
            # Uncached input + cache creation both bill as input-ish; keep simple sum.
            uncached = int(item.get("uncached_input_tokens") or item.get("input_tokens") or 0)
            cache_read = int(item.get("cache_read_input_tokens") or item.get("cache_read_tokens") or 0)
            cache_create = item.get("cache_creation") or {}
            cache_write = int(
                cache_create.get("ephemeral_5m_input_tokens", 0)
                or 0
            ) + int(cache_create.get("ephemeral_1h_input_tokens", 0) or 0)
            if not cache_write:
                cache_write = int(item.get("cache_creation_input_tokens") or item.get("cache_write_tokens") or 0)
            output = int(item.get("output_tokens") or 0)

            row["input_tokens"] += uncached
            row["output_tokens"] += output
            row["cache_read_tokens"] += cache_read
            row["cache_write_tokens"] += cache_write

    return totals


def fetch_cost_by_workspace(day: date) -> dict[str, Decimal]:
    """
    Return {workspace_id: cost_usd} for ``day``.

    Anthropic reports amounts as decimal strings in cents; convert to USD.
    Default workspace may appear as null — keyed as "".
    """
    starting_at, ending_at = _day_bounds(day)
    params: list[tuple[str, str]] = [
        ("starting_at", starting_at),
        ("ending_at", ending_at),
        ("bucket_width", "1d"),
        ("group_by[]", "workspace_id"),
        ("limit", "31"),
    ]
    try:
        buckets = _get_paginated(COST_URL, params)
    except requests.HTTPError as exc:
        logger.warning("Anthropic cost_report failed: %s", exc)
        return {}

    totals: dict[str, Decimal] = {}
    for bucket in buckets:
        for item in bucket.get("results") or []:
            ws = item.get("workspace_id")
            key = ws if ws else ""
            # amount may be string cents
            raw = item.get("amount")
            if raw is None:
                raw = item.get("cost") or "0"
            cents = Decimal(str(raw))
            # Docs: "decimal strings in lowest units (cents)"
            usd = cents / Decimal("100")
            totals[key] = totals.get(key, Decimal("0")) + usd
    return totals


def fetch_org_api_keys(*, status: str = "active") -> list[dict[str, Any]]:
    """
    List organization API keys via Admin API (cursor pagination).

    Returns normalised dicts: id, name, workspace_id, status, partial_key_hint.
    """
    if not admin_api_key():
        return []

    keys: list[dict[str, Any]] = []
    after_id: str | None = None
    while True:
        params: list[tuple[str, str]] = [("limit", "100")]
        if status:
            params.append(("status", status))
        if after_id:
            params.append(("after_id", after_id))
        full = f"{API_KEYS_URL}?{urlencode(params)}"
        resp = requests.get(full, headers=_headers(), timeout=45)
        resp.raise_for_status()
        payload = resp.json()
        for item in payload.get("data") or []:
            scope = item.get("scope") or {}
            workspace_id = (
                item.get("workspace_id")
                or (scope.get("workspace_id") if isinstance(scope, dict) else None)
                or ""
            )
            keys.append(
                {
                    "id": item.get("id") or "",
                    "name": (item.get("name") or "").strip() or (item.get("id") or "Unnamed key"),
                    "workspace_id": workspace_id or "",
                    "status": item.get("status") or "",
                    "partial_key_hint": item.get("partial_key_hint") or "",
                }
            )
        if not payload.get("has_more"):
            break
        after_id = payload.get("last_id")
        if not after_id:
            break
    return [k for k in keys if k.get("id")]


def estimate_cost_usd(
    *,
    input_tokens: int = 0,
    output_tokens: int = 0,
    cache_read_tokens: int = 0,
    cache_write_tokens: int = 0,
) -> Decimal:
    """Fallback estimate using the same Haiku-class rates as local IdpUsageDaily."""
    in_rate = Decimal(str(getattr(settings, "IDP_COST_INPUT_PER_MTOK", "0.80")))
    out_rate = Decimal(str(getattr(settings, "IDP_COST_OUTPUT_PER_MTOK", "4.00")))
    # Treat cache write like input; cache read at 10% of input (Anthropic-ish).
    billable_in = (
        Decimal(input_tokens)
        + Decimal(cache_write_tokens)
        + (Decimal(cache_read_tokens) * Decimal("0.10"))
    )
    cost = (billable_in / Decimal("1000000")) * in_rate
    cost += (Decimal(output_tokens) / Decimal("1000000")) * out_rate
    return cost.quantize(Decimal("0.000001"))
