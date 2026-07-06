"""Server-side mirror of the frontend rule-group evaluation used for built-form
field/section **visibility** and **editability** (TemplateForm.tsx / TemplateBuilderV2.tsx).

A rule group is ``{"combinator": "and"|"or", "conditions": [ {source, fieldKey,
operator, value}, ... ]}``. Legacy single-rule ``{fieldKey, operator, value}`` is
tolerated. Conditions test either a form field's value (``source: "field"``) or
the document's current process step (``source: "process_step"``).

Kept dependency-free so both apps/templates_engine and apps/documents can import it.
"""


def rule_conditions(vw):
    """Normalize a stored rule (legacy single rule or a group) into
    ``(combinator, conditions)``, or ``None`` when there's no rule."""
    if not isinstance(vw, dict):
        return None
    if isinstance(vw.get("conditions"), list):
        combinator = vw.get("combinator") if vw.get("combinator") in ("and", "or") else "and"
        return combinator, vw["conditions"]
    if isinstance(vw.get("fieldKey"), str):
        return "and", [{
            "source": "field", "fieldKey": vw["fieldKey"],
            "operator": vw.get("operator"), "value": vw.get("value"),
        }]
    return None


def eval_condition(cond: dict, values: dict, process_step: str) -> bool:
    if cond.get("source") == "process_step":
        sv = process_step
    else:
        raw = values.get(cond.get("fieldKey"))
        sv = "" if raw is None else str(raw)
    operator = cond.get("operator")
    expected = cond.get("value") or ""
    if operator == "equals":
        return sv == expected
    if operator == "not_equals":
        return sv != expected
    if operator == "is_empty":
        return sv.strip() == ""
    if operator == "is_not_empty":
        return sv.strip() != ""
    return True


def eval_group(group, values: dict, process_step: str) -> bool:
    """True if the rule group matches. An empty/absent group is True (no restriction)."""
    g = rule_conditions(group)
    if not g or not g[1]:
        return True
    combinator, conditions = g
    results = [eval_condition(c, values, process_step) for c in conditions]
    return any(results) if combinator == "or" else all(results)


def is_visible(item: dict, values: dict, process_step: str = "draft") -> bool:
    """A field/section is visible unless always-hidden or its ``visibleWhen`` group
    doesn't match at the current step/values."""
    if item.get("hidden"):
        return False
    return eval_group(item.get("visibleWhen"), values, process_step)


def is_editable(item: dict, values: dict, process_step: str = "draft") -> bool:
    """A field/section is editable unless always read-only (``readonly``) or it has
    an ``editableWhen`` group that doesn't match at the current step/values.
    Absent ``editableWhen`` = editable by default (preserves prior behaviour)."""
    if item.get("readonly"):
        return False
    return eval_group(item.get("editableWhen"), values, process_step)
