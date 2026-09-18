"""Sync Anthropic Admin reports into APIUsageSnapshot + spend alerts."""
from __future__ import annotations

import logging
from datetime import date, timedelta
from decimal import Decimal

from django.conf import settings
from django.core.mail import send_mail
from django.db.models import Sum
from django.utils import timezone

from apps.billing.anthropic_admin import (
    admin_api_key,
    estimate_cost_usd,
    fetch_cost_by_workspace,
    fetch_org_api_keys,
    fetch_usage_by_api_key,
)
from apps.billing.models import APIUsageSnapshot, ClientDeployment

logger = logging.getLogger(__name__)


def sync_usage_for_day(day: date | None = None) -> dict:
    """
    Pull one UTC day's usage/cost for all active ClientDeployments.

    Returns a small status dict for logging / API responses.
    """
    if not admin_api_key():
        return {"ok": False, "reason": "ANTHROPIC_ADMIN_KEY not configured", "saved": 0}

    day = day or (date.today() - timedelta(days=1))
    deployments = list(ClientDeployment.objects.filter(is_active=True))
    if not deployments:
        return {"ok": True, "reason": "no active client deployments", "saved": 0, "day": str(day)}

    key_ids = [d.api_key_id for d in deployments]
    try:
        usage = fetch_usage_by_api_key(day, api_key_ids=key_ids)
    except Exception as exc:
        logger.exception("Failed to fetch Anthropic usage for %s", day)
        return {"ok": False, "reason": str(exc), "saved": 0, "day": str(day)}

    try:
        costs_by_ws = fetch_cost_by_workspace(day)
    except Exception as exc:
        logger.warning("Cost fetch failed for %s: %s", day, exc)
        costs_by_ws = {}

    # Allocate workspace cost across keys in that workspace by token share.
    tokens_by_ws: dict[str, int] = {}
    for dep in deployments:
        u = usage.get(dep.api_key_id) or {}
        tok = int(u.get("input_tokens", 0)) + int(u.get("output_tokens", 0))
        ws = (dep.workspace_id or "").strip()
        tokens_by_ws[ws] = tokens_by_ws.get(ws, 0) + tok

    saved = 0
    for dep in deployments:
        u = usage.get(dep.api_key_id) or {
            "input_tokens": 0,
            "output_tokens": 0,
            "cache_read_tokens": 0,
            "cache_write_tokens": 0,
        }
        ws = (dep.workspace_id or "").strip()
        ws_cost = costs_by_ws.get(ws)
        estimated = False
        if ws_cost is not None and tokens_by_ws.get(ws, 0) > 0:
            share_tokens = int(u.get("input_tokens", 0)) + int(u.get("output_tokens", 0))
            cost = (ws_cost * Decimal(share_tokens) / Decimal(tokens_by_ws[ws])).quantize(
                Decimal("0.000001")
            )
        elif ws_cost is not None and len([d for d in deployments if (d.workspace_id or "").strip() == ws]) == 1:
            cost = ws_cost.quantize(Decimal("0.000001"))
        else:
            cost = estimate_cost_usd(**u)
            estimated = True

        APIUsageSnapshot.objects.update_or_create(
            api_key_id=dep.api_key_id,
            date=day,
            defaults={
                "client_name": dep.client_name,
                "input_tokens": u["input_tokens"],
                "output_tokens": u["output_tokens"],
                "cache_read_tokens": u["cache_read_tokens"],
                "cache_write_tokens": u["cache_write_tokens"],
                "cost_usd": cost,
                "cost_is_estimated": estimated,
            },
        )
        saved += 1

    alerts = check_spend_alerts()
    return {
        "ok": True,
        "day": str(day),
        "saved": saved,
        "alerts_sent": alerts,
    }


def check_spend_alerts(*, threshold_pct: Decimal = Decimal("90")) -> int:
    """Email Flaxem ops when a client is at/above threshold of monthly_limit_usd.

    Alerts are deduplicated: at most one email is sent per client per calendar
    month, tracked via ClientDeployment.last_alert_sent_at.
    """
    month_start = timezone.now().date().replace(day=1)
    default_to = str(getattr(settings, "FLAXEM_OPS_ALERT_EMAIL", "") or "").strip()
    sent = 0

    for dep in ClientDeployment.objects.filter(is_active=True, monthly_limit_usd__gt=0):
        # Suppress if an alert was already sent this calendar month.
        if dep.last_alert_sent_at and dep.last_alert_sent_at.date() >= month_start:
            continue

        month_spend = (
            APIUsageSnapshot.objects.filter(
                api_key_id=dep.api_key_id,
                date__gte=month_start,
            ).aggregate(total=Sum("cost_usd"))["total"]
            or Decimal("0")
        )
        pct = (month_spend / dep.monthly_limit_usd) * Decimal("100")
        if pct < threshold_pct:
            continue

        to_addr = (dep.alert_email or default_to).strip()
        if not to_addr:
            logger.warning(
                "Spend alert for %s at %.0f%% but no alert email configured",
                dep.client_name,
                pct,
            )
            continue

        try:
            send_mail(
                subject=f"[Flaxem] {dep.client_name} at {pct:.0f}% of API cap",
                message=(
                    f"{dep.client_name} has used ${month_spend} of their "
                    f"${dep.monthly_limit_usd} monthly reference cap "
                    f"(month starting {month_start}).\n\n"
                    "Hard stop remains the Anthropic workspace spend limit."
                ),
                from_email=settings.DEFAULT_FROM_EMAIL,
                recipient_list=[to_addr],
                fail_silently=True,
            )
            sent += 1
            # Stamp the send time so we don't re-alert this month.
            dep.last_alert_sent_at = timezone.now()
            dep.save(update_fields=["last_alert_sent_at"])
        except Exception:
            logger.exception("Failed to send spend alert for %s", dep.client_name)

    return sent


def list_discovered_keys() -> dict:
    """
    Return Anthropic org keys annotated with whether they are already registered.
    """
    if not admin_api_key():
        return {"configured": False, "keys": [], "error": "ANTHROPIC_ADMIN_KEY not configured"}

    try:
        remote = fetch_org_api_keys(status="active")
    except Exception as exc:
        logger.exception("Failed to list Anthropic API keys")
        return {"configured": True, "keys": [], "error": str(exc)}

    registered = {
        d.api_key_id: d
        for d in ClientDeployment.objects.all().only("id", "api_key_id", "client_name", "is_active")
    }
    keys = []
    for item in remote:
        existing = registered.get(item["id"])
        keys.append(
            {
                **item,
                "registered": existing is not None,
                "deployment_id": str(existing.id) if existing else None,
                "registered_name": existing.client_name if existing else None,
                "is_active": existing.is_active if existing else None,
            }
        )
    return {"configured": True, "keys": keys, "error": None}


def import_discovered_keys(
    *,
    api_key_ids: list[str] | None = None,
    monthly_limit_usd: Decimal | None = None,
) -> dict:
    """
    Create ClientDeployment rows from Anthropic org keys.

    If ``api_key_ids`` is None/empty, import all active keys not already registered.
    """
    discovered = list_discovered_keys()
    if discovered.get("error") and not discovered.get("keys"):
        return {
            "ok": False,
            "reason": discovered.get("error") or "Could not list keys",
            "imported": 0,
            "skipped": 0,
        }

    wanted = {k.strip() for k in (api_key_ids or []) if k and str(k).strip()}
    limit = monthly_limit_usd if monthly_limit_usd is not None else Decimal("0")
    imported = 0
    skipped = 0
    created_ids: list[str] = []

    for item in discovered.get("keys") or []:
        key_id = item.get("id") or ""
        if wanted and key_id not in wanted:
            continue
        if item.get("registered"):
            skipped += 1
            continue
        dep = ClientDeployment.objects.create(
            client_name=item.get("name") or key_id,
            api_key_id=key_id,
            workspace_id=item.get("workspace_id") or "",
            monthly_limit_usd=limit,
            is_active=True,
            notes=f"Imported from Anthropic Admin API ({item.get('partial_key_hint') or key_id})",
        )
        created_ids.append(str(dep.id))
        imported += 1

    return {
        "ok": True,
        "imported": imported,
        "skipped": skipped,
        "created_ids": created_ids,
    }


def build_ops_usage_report(*, days: int = 30) -> dict:
    """Roll up ClientDeployment + snapshots for the Flaxem ops dashboard."""
    days = max(1, min(days, 90))
    end = timezone.now().date()
    start = end - timedelta(days=days - 1)
    month_start = end.replace(day=1)

    deployments = list(ClientDeployment.objects.filter(is_active=True).order_by("client_name"))
    month_qs = APIUsageSnapshot.objects.filter(date__gte=month_start, date__lte=end)

    by_key: dict[str, dict] = {}
    for row in month_qs.values("api_key_id").annotate(
        input_tokens=Sum("input_tokens"),
        output_tokens=Sum("output_tokens"),
        cost_usd=Sum("cost_usd"),
    ):
        by_key[row["api_key_id"]] = row

    clients = []
    total_cost = Decimal("0")
    total_in = 0
    total_out = 0
    alerts = []

    for dep in deployments:
        agg = by_key.get(dep.api_key_id) or {}
        cost = Decimal(str(agg.get("cost_usd") or 0))
        inp = int(agg.get("input_tokens") or 0)
        out = int(agg.get("output_tokens") or 0)
        total_cost += cost
        total_in += inp
        total_out += out
        limit = dep.monthly_limit_usd
        pct = None
        if limit and limit > 0:
            pct = float((cost / limit * Decimal("100")).quantize(Decimal("0.1")))
            if pct >= 90:
                alerts.append(
                    {
                        "client_name": dep.client_name,
                        "pct": pct,
                        "cost_usd": str(cost),
                        "monthly_limit_usd": str(limit),
                    }
                )
        clients.append(
            {
                "id": str(dep.id),
                "client_name": dep.client_name,
                "api_key_id": dep.api_key_id,
                "workspace_id": dep.workspace_id,
                "input_tokens": inp,
                "output_tokens": out,
                "cost_usd": str(cost),
                "monthly_limit_usd": str(limit),
                "limit_used_pct": pct,
            }
        )

    daily = list(
        APIUsageSnapshot.objects.filter(date__gte=start, date__lte=end)
        .values("date")
        .annotate(cost_usd=Sum("cost_usd"), input_tokens=Sum("input_tokens"))
        .order_by("date")
    )
    daily_out = [
        {
            "date": row["date"].isoformat(),
            "cost_usd": str(row["cost_usd"] or 0),
            "input_tokens": int(row["input_tokens"] or 0),
        }
        for row in daily
    ]

    return {
        "configured": bool(admin_api_key()),
        "month_start": month_start.isoformat(),
        "period_days": days,
        "summary": {
            "clients": len(clients),
            "input_tokens": total_in,
            "output_tokens": total_out,
            "cost_usd": str(total_cost),
        },
        "alerts": alerts,
        "clients": clients,
        "daily": daily_out,
    }
