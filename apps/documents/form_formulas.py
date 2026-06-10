"""
Server-authoritative auto-fill formulas for built-template form fields.

A form field can declare a ``formula`` (e.g. ``current_user``, ``now``). At
**create** time the server computes the value from the request user / server
clock / assigned reference number and writes it into the form values, freezing
it — ``created_by`` captures the creator, ``now`` the moment of submission. The
value isn't recomputed on later edits.

Keep the keys in sync with frontend/src/components/templates/formulas.ts.
"""
from __future__ import annotations

from django.utils import timezone

# Friendly aliases → canonical formula key (mirror of the frontend ALIASES).
_ALIASES = {
    "created_by": "current_user",
    "created_by_email": "current_user_email",
    "department": "current_user_department",
    "now_time": "now",
    "date": "today",
}

_CANONICAL = {
    "current_user",
    "current_user_email",
    "current_user_department",
    "now",
    "today",
    "reference_number",
}

# Field types that can carry a formula (scalar inputs); must match the builder.
_FORMULA_FIELD_TYPES = frozenset(
    {"text", "textarea", "email", "phone", "number", "date", "datetime", "time"}
)


def _canonical(formula) -> str | None:
    if not formula:
        return None
    key = str(formula).strip().lower()
    key = _ALIASES.get(key, key)
    return key if key in _CANONICAL else None


def resolve_formula(formula, *, user=None, reference_number=None, now=None) -> str:
    """Compute a formula's value. Returns "" if it can't be resolved."""
    key = _canonical(formula)
    if not key:
        return ""
    now = now or timezone.localtime()

    if key == "current_user":
        if not user:
            return ""
        return (user.get_full_name() or user.email or "").strip()
    if key == "current_user_email":
        return (getattr(user, "email", "") or "") if user else ""
    if key == "current_user_department":
        dept = getattr(user, "department", None) if user else None
        return getattr(dept, "name", "") or ""
    if key == "now":
        return now.strftime("%Y-%m-%d %H:%M")
    if key == "today":
        return now.strftime("%Y-%m-%d")
    if key == "reference_number":
        return reference_number or ""
    return ""


def apply_formulas(values: dict, sections, *, user=None, reference_number=None, now=None) -> dict:
    """Write authoritative values for every formula field in ``sections`` into a
    copy of ``values`` (overwriting whatever the client previewed)."""
    if not isinstance(values, dict):
        return values
    values = dict(values)
    now = now or timezone.localtime()

    for section in (sections or []):
        for field in (section.get("fields") or []):
            if field.get("type") not in _FORMULA_FIELD_TYPES:
                continue
            key = field.get("key")
            formula = field.get("formula")
            if not key or not _canonical(formula):
                continue
            values[key] = resolve_formula(
                formula, user=user, reference_number=reference_number, now=now
            )
    return values
