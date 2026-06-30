"""
apps/sunsystems/budget.py

Budget availability checks against SunSystems, for the *live* form-fill
experience ("always aware of available budget").

Status: the SunSystems Connect *budget inquiry* component/method and its reply
shape are not yet confirmed, so the real query is **stubbed behind this stable
interface**. The form UI, endpoint, and mapping all work end-to-end today; when a
real inquiry sample arrives, implement :func:`_real_budget_query` and flip
``SUNSYSTEMS_BUDGET_STUB`` off — nothing else changes.

A *budget mapping* (configured per template alongside the journal mapping)
describes which form fields supply the inquiry dimensions::

    {
      "enabled": true,
      "mode": "warn",                 # "warn" | "block" at submit time
      "component": "...", "method": "...",
      "account": {"field": "sunsystems_code"},
      "analysis": { "1": {"field": "cost_centre"} },
      "period":   {"field": "period"},
      "currency": {"const": "GBP"},
      "amount":   {"field": "total_estimated_expenditure"}
    }
"""
from __future__ import annotations

import logging
from dataclasses import asdict, dataclass
from decimal import Decimal

from django.conf import settings

from .client import SunSystemsClient, SunSystemsConfig
from .mapping import resolve_amount, resolve_value
from .models import effective_connection

logger = logging.getLogger(__name__)


@dataclass
class BudgetResult:
    ok: bool                    # is the requested amount within remaining budget?
    available: bool             # did we get a real/usable answer?
    account: str
    currency: str
    budget: str                 # original budget figure (as string)
    actual: str                 # actuals to date
    commitment: str             # commitments to date
    remaining: str              # budget - actual - commitment
    requested: str              # amount being tested
    over_by: str                # how much the request exceeds remaining (0 if within)
    mode: str                   # "warn" | "block"
    message: str
    stub: bool                  # True when this is a placeholder answer

    def to_dict(self) -> dict:
        return asdict(self)


def _stub_enabled() -> bool:
    return bool(getattr(settings, "SUNSYSTEMS_BUDGET_STUB", True))


def check_budget(*, mapping: dict | None, values: dict, connection: dict | None = None) -> BudgetResult:
    """Resolve inquiry dimensions from ``mapping`` + ``values`` and return budget
    availability. Returns a stub answer while the real inquiry is unconfigured."""
    mapping = mapping or {}
    account = resolve_value(mapping.get("account"), values)
    currency = resolve_value(mapping.get("currency"), values) or "GBP"
    requested = resolve_amount(mapping.get("amount"), values)
    mode = (mapping.get("mode") or "warn").lower()

    if not mapping.get("enabled"):
        return _empty(account, currency, requested, mode, "Budget check is not enabled for this form.")

    if _stub_enabled():
        return _stub_budget(account, currency, requested, mode)

    try:
        conn = effective_connection(connection)
        client = SunSystemsClient(SunSystemsConfig.from_mapping(conn))
        return _real_budget_query(client, mapping, values, account, currency, requested, mode)
    except Exception as exc:  # pragma: no cover - until the real query exists
        logger.warning("SunSystems budget query failed: %s", exc)
        return _empty(account, currency, requested, mode, f"Budget check unavailable: {exc}")


def _real_budget_query(
    client: SunSystemsClient,
    mapping: dict,
    values: dict,
    account: str,
    currency: str,
    requested: Decimal,
    mode: str,
) -> BudgetResult:
    """Real SunSystems Connect budget inquiry. Implement once a sample exists.

    Build the inquiry ``<SSC>`` from ``mapping`` (account/analysis/period),
    call ``client.execute(component, method, ssc)``, parse budget/actual/
    commitment out of the reply, and return a populated :class:`BudgetResult`.
    """
    raise NotImplementedError(
        "SunSystems budget inquiry not yet wired — set SUNSYSTEMS_BUDGET_STUB=True "
        "until a real inquiry sample is available."
    )


def _stub_budget(account: str, currency: str, requested: Decimal, mode: str) -> BudgetResult:
    """Deterministic placeholder so the form UI is fully functional.

    Derives a plausible budget envelope from the account string so the same
    account always returns the same numbers, and the pass/over indicator
    actually reacts to the amount entered.
    """
    seed = sum(ord(c) for c in (account or "ACCT")) or 1
    budget = Decimal(5000 + (seed % 20) * 1000)        # 5,000 … 24,000
    actual = Decimal((seed * 37) % int(budget))        # some spent
    commitment = Decimal((seed * 13) % 2000)
    remaining = budget - actual - commitment
    over = requested - remaining
    ok = over <= 0
    return BudgetResult(
        ok=ok,
        available=True,
        account=account,
        currency=currency,
        budget=_s(budget),
        actual=_s(actual),
        commitment=_s(commitment),
        remaining=_s(remaining),
        requested=_s(requested),
        over_by=_s(over if over > 0 else Decimal("0")),
        mode=mode,
        message=(
            "Within budget." if ok
            else f"Exceeds remaining budget by {currency} {_s(over)}."
        ),
        stub=True,
    )


def _empty(account: str, currency: str, requested: Decimal, mode: str, message: str) -> BudgetResult:
    return BudgetResult(
        ok=True, available=False, account=account, currency=currency,
        budget="0", actual="0", commitment="0", remaining="0",
        requested=_s(requested), over_by="0", mode=mode, message=message, stub=False,
    )


def _s(value: Decimal) -> str:
    return format(value, "f")
