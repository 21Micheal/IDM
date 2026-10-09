"""Server-side mirror of the frontend rule-group evaluation used for built-form
field/section **visibility** and **editability** (TemplateForm.tsx / TemplateBuilderV2.tsx).

A rule group is ``{"combinator": "and"|"or", "conditions": [ {source, fieldKey,
operator, value}, ... ], "groups": [ <nested rule groups> ]}``. Legacy single-rule ``{fieldKey, operator, value}`` is
tolerated. Conditions test a form field's value (``source: "field"``), the
document's current process step (``source: "process_step"``), or the viewer's
RBAC membership (``source: "user_group"`` with ``groups: [{id, name}]`` and
operator ``in_list`` / ``not_in_list``).

Kept dependency-free so both apps/templates_engine and apps/documents can import it.
"""

import calendar as _calendar
import json as _json
import math
import re as _re
from datetime import datetime as _datetime, timedelta as _timedelta
from decimal import Decimal as _Decimal, ROUND_HALF_UP as _ROUND_HALF_UP, localcontext as _localcontext


def rule_conditions(vw):
    """Normalize a stored rule (legacy single rule or a group) into
    ``(combinator, conditions)``, or ``None`` when there's no rule.
    (Nested ``groups`` are handled by ``eval_group`` via ``_normalize_group``.)"""
    g = _normalize_group(vw)
    if g is None:
        return None
    return g["combinator"], g["conditions"]


def _normalize_group(vw):
    """Normalize a rule into ``{"combinator", "conditions", "groups"}`` or None.
    Accepts the legacy single-rule shape ``{fieldKey, operator, value}``."""
    if not isinstance(vw, dict):
        return None
    if isinstance(vw.get("conditions"), list):
        combinator = vw.get("combinator") if vw.get("combinator") in ("and", "or") else "and"
        nested = vw.get("groups") if isinstance(vw.get("groups"), list) else []
        return {
            "combinator": combinator,
            "conditions": vw["conditions"],
            "groups": [n for n in (_normalize_group(x) for x in nested) if n is not None],
        }
    if isinstance(vw.get("fieldKey"), str):
        return {
            "combinator": "and",
            "conditions": [{
                "source": "field", "fieldKey": vw["fieldKey"],
                "operator": vw.get("operator"), "value": vw.get("value"),
            }],
            "groups": [],
        }
    return None


def _group_has_conditions(g) -> bool:
    return bool(g) and (bool(g["conditions"]) or any(_group_has_conditions(n) for n in g["groups"]))


def build_viewer(group_ids=(), group_names=(), is_admin=False) -> dict:
    """Viewer context for ``user_group`` conditions. A plain dict keeps this
    module dependency-free; callers pass the ids/names they already have."""
    return {
        "group_ids": {str(g) for g in (group_ids or [])},
        "group_names": set(group_names or []),
        "is_admin": bool(is_admin),
    }


def _match_user_group(cond: dict, viewer) -> bool:
    """Evaluate one ``user_group`` condition. Group rules are a convenience, not
    an access boundary: with no viewer context (or for admins) they never
    restrict, matching the frontend's behaviour."""
    operator = cond.get("operator")
    if operator not in ("in_list", "not_in_list"):
        return True  # unknown operator — never hide/lock on it
    if not viewer or viewer.get("is_admin"):
        return True
    groups = cond.get("groups") or []
    ids = viewer.get("group_ids") or set()
    names = viewer.get("group_names") or set()
    member = any(
        isinstance(g, dict) and (
            (g.get("id") and str(g["id"]) in ids)
            or (g.get("name") and g["name"] in names)
        )
        for g in groups
    )
    return member if operator == "in_list" else not member


def _condition_values(field_key, values: dict):
    """Every candidate value a condition's ``fieldKey`` can resolve to.

    A plain key is a top-level form field and yields exactly one value. A
    dotted ``table_key.column_key`` reference targets a table column, which has
    one value *per row* — so it yields one entry per row. Rule evaluation then
    uses "any row matches" semantics (and "every row" for the negative
    operators), which is what people mean by "show this when a table row has
    an amount over the limit".
    """
    if not field_key:
        return [""]

    if "." in field_key:
        table_key, _, column_key = field_key.partition(".")
        rows = values.get(table_key)
        if isinstance(rows, dict):
            rows = [rows]
        if not isinstance(rows, list):
            return [""]
        out = []
        for row in rows:
            if not isinstance(row, dict):
                continue
            raw = row.get(column_key)
            out.append("" if raw is None else str(raw))
        return out or [""]

    raw = values.get(field_key)
    return ["" if raw is None else str(raw)]


# ── Condition operators ─────────────────────────────────────────────────────
# Mirrors the operator set offered by the builder (TemplateBuilderV2.tsx
# OPERATOR_GROUPS) and lib/ruleOperators.ts. equals/not_equals keep their
# original EXACT comparison; every other operator compares trimmed,
# case-insensitively, numbers numerically and everything else by code point.

_RULE_NUM_RE = _re.compile(r"^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$")
_TRUTHY_TEXT = {"true", "yes", "1", "on", "checked"}
_VALUELESS_OPERATORS = {"is_empty", "is_not_empty", "is_true", "is_false"}
# Negative operators must hold for EVERY candidate row; positive ones for ANY.
_NEGATIVE_OPERATORS = {"not_equals", "is_empty", "not_contains", "not_in_list", "not_between", "is_false"}
_KNOWN_OPERATORS = {
    "equals", "not_equals", "is_empty", "is_not_empty",
    "greater_than", "greater_or_equal", "less_than", "less_or_equal",
    "between", "not_between",
    "contains", "not_contains", "starts_with", "ends_with",
    "in_list", "not_in_list", "is_true", "is_false",
}


def _rule_num(s: str):
    s = s.strip()
    return float(s) if s and _RULE_NUM_RE.match(s) else None


def _rule_compare(sv: str, rhs: str) -> int:
    """<0, 0, >0. Numeric when both sides are numbers (ISO dates fall through
    to the string compare, which orders them correctly)."""
    a, b = _rule_num(sv), _rule_num(rhs)
    if a is not None and b is not None:
        return (a > b) - (a < b)
    x, y = sv.strip(), rhs.strip()
    return (x > y) - (x < y)


def match_operator(operator, sv: str, expected: str) -> bool:
    """Does one candidate value ``sv`` satisfy ``operator`` against ``expected``?"""
    target = (expected or "").strip()
    lower = sv.strip().lower()
    tl = target.lower()
    nonblank = sv.strip() != ""
    if operator == "equals":
        return sv == (expected or "")
    if operator == "not_equals":
        return sv != (expected or "")
    if operator == "is_empty":
        return not nonblank
    if operator == "is_not_empty":
        return nonblank
    if operator == "greater_than":
        return nonblank and _rule_compare(sv, target) > 0
    if operator == "greater_or_equal":
        return nonblank and _rule_compare(sv, target) >= 0
    if operator == "less_than":
        return nonblank and _rule_compare(sv, target) < 0
    if operator == "less_or_equal":
        return nonblank and _rule_compare(sv, target) <= 0
    if operator in ("between", "not_between"):
        parts = (expected or "").split(",")
        lo = parts[0].strip() if len(parts) > 0 else ""
        hi = parts[1].strip() if len(parts) > 1 else ""
        inside = nonblank and _rule_compare(sv, lo) >= 0 and _rule_compare(sv, hi) <= 0
        return inside if operator == "between" else not inside
    if operator == "contains":
        return tl != "" and tl in lower
    if operator == "not_contains":
        return tl == "" or tl not in lower
    if operator == "starts_with":
        return lower.startswith(tl)
    if operator == "ends_with":
        return lower.endswith(tl)
    if operator in ("in_list", "not_in_list"):
        listed = [v.strip().lower() for v in (expected or "").split(",") if v.strip()]
        return (lower in listed) if operator == "in_list" else (lower not in listed)
    if operator == "is_true":
        return lower in _TRUTHY_TEXT
    if operator == "is_false":
        return lower not in _TRUTHY_TEXT
    return True


def _process_step_matches(actual: str, expected: str) -> bool:
    """Match lifecycle milestones that remain true after the workflow advances.

    Requisition and LPO approvals remain completed milestones while later
    procurement and retirement steps are active. Visibility rules for retirement
    sections commonly target these earlier approvals.
    """
    actual = (actual or "").strip().lower()
    expected = (expected or "").strip().lower()
    if actual == expected:
        return True
    downstream_requisition_approved = {
        "request_approved",
        "lpo_pending",
        "lpo_approved",
        "retirement_pending",
        "retirement_returned",
        "retirement_rejected",
        "retirement_approved",
        "fully_approved",
    }
    downstream_lpo_approved = {
        "lpo_approved",
        "retirement_pending",
        "retirement_returned",
        "retirement_rejected",
        "retirement_approved",
        "fully_approved",
    }
    return (
        (expected == "requisition_approved" and actual in downstream_requisition_approved)
        or (expected == "lpo_approved" and actual in downstream_lpo_approved)
        or (expected == "approved" and actual in downstream_requisition_approved)
        or (expected == "retirement_approved" and actual == "fully_approved")
    )


def eval_condition(cond: dict, values: dict, process_step: str, viewer=None) -> bool:
    operator = cond.get("operator")
    expected = cond.get("value") or ""

    if operator not in _KNOWN_OPERATORS:
        return True  # unknown operator — never hide/lock on it

    if cond.get("source") == "user_group":
        return _match_user_group(cond, viewer)

    if cond.get("source") == "process_step":
        if operator == "equals":
            return _process_step_matches(process_step, expected)
        if operator == "not_equals":
            return not _process_step_matches(process_step, expected)
        candidates = [process_step]
    else:
        candidates = _condition_values(cond.get("fieldKey"), values)

    if operator in _NEGATIVE_OPERATORS:
        return all(match_operator(operator, sv, expected) for sv in candidates)
    return any(match_operator(operator, sv, expected) for sv in candidates)


def _eval_normalized(g, values: dict, process_step: str, viewer=None) -> bool:
    nested = [n for n in g["groups"] if _group_has_conditions(n)]
    if not g["conditions"] and not nested:
        return True
    results = [eval_condition(c, values, process_step, viewer) for c in g["conditions"]]
    results += [_eval_normalized(n, values, process_step, viewer) for n in nested]
    return any(results) if g["combinator"] == "or" else all(results)


def eval_group(group, values: dict, process_step: str, viewer=None) -> bool:
    """True if the rule group matches. An empty/absent group is True (no
    restriction). Nested ``groups`` are combined with the group's own combinator."""
    g = _normalize_group(group)
    if g is None:
        return True
    return _eval_normalized(g, values, process_step, viewer)


def is_visible(item: dict, values: dict, process_step: str = "draft", viewer=None) -> bool:
    """A field/section is visible unless always-hidden or its ``visibleWhen`` group
    doesn't match at the current step/values/viewer."""
    if item.get("hidden"):
        return False
    return eval_group(item.get("visibleWhen"), values, process_step, viewer)


def is_editable(item: dict, values: dict, process_step: str = "draft", viewer=None) -> bool:
    """A field/section is editable unless always read-only (``readonly``) or it has
    an ``editableWhen`` group that doesn't match at the current step/values/viewer.
    Absent ``editableWhen`` = editable by default (preserves prior behaviour)."""
    if item.get("readonly"):
        return False
    return eval_group(item.get("editableWhen"), values, process_step, viewer)


def row_scoped_values(values: dict, row: dict) -> dict:
    """Merge one table row's own cell values over the form-level values, so a
    table COLUMN rule can reference a sibling column in the SAME row. Row keys
    win over form keys."""
    merged = dict(values or {})
    merged.update(row or {})
    return merged


def is_column_visible(column: dict, values: dict, rows=None, process_step: str = "draft", viewer=None) -> bool:
    """Column headers are shared by every row, so a column stays visible when
    ANY row satisfies its ``visibleWhen`` (evaluated with that row's own cell
    values merged in). With no rows, the form-level values decide."""
    if column.get("hidden"):
        return False
    if not rows:
        return eval_group(column.get("visibleWhen"), values, process_step, viewer)
    return any(
        eval_group(column.get("visibleWhen"), row_scoped_values(values, row), process_step, viewer)
        for row in rows
    )


def is_cell_editable(column: dict, values: dict, row: dict, process_step: str = "draft", viewer=None) -> bool:
    """Per-row editability for one table cell: the column must be editable AND
    visible for THIS row's values."""
    if column.get("hidden") or column.get("readonly"):
        return False
    scoped = row_scoped_values(values, row)
    return (
        eval_group(column.get("visibleWhen"), scoped, process_step, viewer)
        and eval_group(column.get("editableWhen"), scoped, process_step, viewer)
    )


# ─── Calculated fields ──────────────────────────────────────────────────────
# Server-side mirror of the frontend calculation engine (lib/calculations.ts and
# the builder's preview engine in TemplateBuilderV2.tsx). A field carrying
# ``calc: {"expression": "...", "decimals": n}`` (see TemplateField.calc) is
# auto-derived from sibling field values and is never trusted from the client —
# `compute_calculated_values` is the single authoritative place this is
# (re)computed, called from fill(), form updates and document generation.
#
# The grammar is side-effect free — no eval/exec, no arbitrary code execution:
#   - numbers, "string" / 'string' literals, field/column keys (table.column ok)
#   - + - * / % ^ & ( ) with the usual precedence, unary +/-  (& joins text)
#   - comparisons: > < >= <= == != <>  (numeric for numbers, code-point order
#     for two strings; ==/!= compare as text if either side is text)
#   - IF(condition, a, b) plus the pure function library in ``_CALC_FUNCS``
#   - whole-column aggregates (SUM AVG COUNT COUNTA COUNTBLANK COLMIN COLMAX
#     MEDIAN PRODUCT FIRST LAST SUMIF COUNTIF AVGIF COLJOIN ROWCOUNT) resolved
#     by ``_resolve_row_aggregates`` before the parser sees the formula.
#
# PARITY RULE: every function here is a line-for-line port of CALC_FUNCS in
# lib/calculations.ts, including JS quirks (Math.round rounds half UP,
# toFixed rounds half up, parseFloat reads a numeric prefix). Change one side
# and you must change the other — backend/tests/calc_vectors.json exercises both.


class CalcError(Exception):
    pass


_CALC_TOKEN_RE = _re.compile(
    r'\s*(?:(?P<num>\d+\.\d+|\d+)'
    r'|(?P<dq>"(?:[^"\\]|\\.)*")'
    r"|(?P<sq>'(?:[^'\\]|\\.)*')"
    r"|(?P<ident>[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)?)"
    r"|(?P<cmp>>=|<=|==|!=|<>)"
    r"|(?P<op>[+\-*/%^&(),><]))"
)


def _calc_tokenize(expression: str):
    tokens = []
    pos = 0
    while pos < len(expression):
        m = _CALC_TOKEN_RE.match(expression, pos)
        if not m or m.end() == pos:
            if expression[pos].isspace():
                pos += 1
                continue
            raise CalcError(f"Unexpected character at position {pos}")
        pos = m.end()
        if m.group("num") is not None:
            tokens.append(("num", float(m.group("num"))))
        elif m.group("dq") is not None:
            raw = m.group("dq")[1:-1]
            tokens.append(("str", raw.replace('\\"', '"').replace("\\\\", "\\")))
        elif m.group("sq") is not None:
            raw = m.group("sq")[1:-1]
            tokens.append(("str", raw.replace("\\'", "'").replace("\\\\", "\\")))
        elif m.group("ident") is not None:
            tokens.append(("ident", m.group("ident")))
        elif m.group("cmp") is not None:
            c = m.group("cmp")
            tokens.append(("op", "!=" if c == "<>" else c))
        else:
            tokens.append(("op", m.group("op")))
    return tokens


# ── JS-compatible primitives ────────────────────────────────────────────────

_FLOAT_PREFIX_RE = _re.compile(r"^\s*[+-]?(?:\d+\.?\d*(?:[eE][+-]?\d+)?|\.\d+(?:[eE][+-]?\d+)?)")
_INT_PREFIX_RE = _re.compile(r"^\s*[+-]?\d+")


def _parse_float(s: str):
    """JS ``parseFloat``: reads a numeric PREFIX ("12abc" -> 12). None if none."""
    m = _FLOAT_PREFIX_RE.match(s)
    if not m:
        return None
    try:
        v = float(m.group(0))
    except ValueError:
        return None
    return v if math.isfinite(v) else None


def _parse_int(s: str):
    m = _INT_PREFIX_RE.match(s)
    return int(m.group(0)) if m else None


def _js_round(x: float) -> int:
    """JS ``Math.round``: halves round toward +infinity (Python's round() is banker's)."""
    if not math.isfinite(x):
        return 0
    return int(math.floor(x + 0.5))


def _to_number(value) -> float:
    """Coerce a calc VALUE (number or string) to a float, never raising —
    an unparseable string is 0. Strings use JS parseFloat semantics."""
    if isinstance(value, bool):
        return float(value)
    if isinstance(value, (int, float)):
        return float(value) if math.isfinite(value) else 0.0
    if isinstance(value, str):
        n = _parse_float(value)
        return n if n is not None else 0.0
    return 0.0


def _is_truthy(value) -> bool:
    if isinstance(value, str):
        return value.strip() != ""
    return _to_number(value) != 0


def _js_str(v) -> str:
    """JS ``String(v)`` for the value shapes that reach a formula."""
    if v is None:
        return ""
    if isinstance(v, bool):
        return "true" if v else "false"
    if isinstance(v, (int, float)):
        f = float(v)
        if not math.isfinite(f):
            return "NaN" if math.isnan(f) else ("Infinity" if f > 0 else "-Infinity")
        if f.is_integer() and abs(f) < 1e21:
            return str(int(f))
        return repr(f)
    if isinstance(v, (list, tuple)):
        return ",".join("" if x is None else _js_str(x) for x in v)
    if isinstance(v, dict):
        return "[object Object]"
    return str(v)


def _calc_text(v) -> str:
    """Render a calc VALUE as text (used by text functions and the & operator).
    Trims float noise off computed numbers, like the client."""
    if v is None:
        return ""
    if isinstance(v, bool):
        v = float(v)
    if isinstance(v, (int, float)):
        f = float(v)
        if not math.isfinite(f):
            return ""
        if f.is_integer():
            return str(int(f))
        s = f"{f:.10f}".rstrip("0").rstrip(".")
        return "0" if s in ("-0", "") else s
    return str(v)


def _to_fixed(x: float, digits: int) -> str:
    """JS ``Number.prototype.toFixed`` (ties round half away from zero)."""
    digits = max(0, min(100, int(digits)))
    if x == 0:
        x = 0.0
    try:
        with _localcontext() as ctx:
            ctx.prec = 200
            q = _Decimal(x).quantize(_Decimal(1).scaleb(-digits), rounding=_ROUND_HALF_UP)
        return format(q, "f")
    except Exception:
        return str(x)


def _round_decimals(result, decimals):
    """``Number(result.toFixed(decimals))`` — applied to numeric results only."""
    if isinstance(result, bool) or not isinstance(result, (int, float)):
        return result
    if isinstance(decimals, bool) or not isinstance(decimals, (int, float)):
        return result
    try:
        return float(_to_fixed(float(result), int(decimals)))
    except Exception:
        return result


def _safe_pow(a: float, b: float) -> float:
    try:
        r = math.pow(a, b)
    except (ValueError, OverflowError, ZeroDivisionError):
        return 0.0
    return r if math.isfinite(r) else 0.0


def _div(a: float, b: float) -> float:
    return a / b if b else 0.0


# ── Dates (day serial = days since 1970-01-01 UTC; time = minutes) ──────────

_EPOCH = _datetime(1970, 1, 1)


def _serial_to_dt(serial):
    try:
        return _EPOCH + _timedelta(milliseconds=_js_round(_to_number(serial) * 86400000))
    except (OverflowError, ValueError):
        return None


def _dt_to_serial(d) -> int:
    return (d - _EPOCH).days


def _format_serial(serial, fmt="YYYY-MM-DD") -> str:
    d = _serial_to_dt(serial)
    if d is None:
        return ""
    out = _calc_text(fmt) or "YYYY-MM-DD"
    for token, val in (
        ("YYYY", str(d.year)), ("MM", f"{d.month:02d}"), ("DD", f"{d.day:02d}"),
        ("HH", f"{d.hour:02d}"), ("mm", f"{d.minute:02d}"), ("ss", f"{d.second:02d}"),
    ):
        out = out.replace(token, val)
    return out


def _add_months(serial, months) -> int:
    d = _serial_to_dt(serial)
    if d is None:
        return 0
    total = d.year * 12 + (d.month - 1) + int(math.trunc(_to_number(months)))
    y, m0 = divmod(total, 12)
    try:
        last = _calendar.monthrange(y, m0 + 1)[1]
        return _dt_to_serial(_datetime(y, m0 + 1, min(d.day, last)))
    except (ValueError, OverflowError):
        return 0


def _date_unit(u) -> str:
    c = _calc_text(u).strip().lower()[:1]
    return "y" if c == "y" else "m" if c == "m" else "d"


def _network_days(a, b) -> int:
    start, end = _js_round(_to_number(a)), _js_round(_to_number(b))
    sign = -1 if end < start else 1
    if sign < 0:
        start, end = end, start
    count = 0
    for i in range(min(end - start, 20000)):
        dow = (start + i + 4) % 7  # 1970-01-01 was a Thursday; 0 = Sunday, 6 = Saturday
        if dow not in (0, 6):
            count += 1
    return count * sign


def _make_date(y, m, d):
    try:
        total = int(math.trunc(_to_number(y))) * 12 + int(math.trunc(_to_number(m))) - 1
        yy, m0 = divmod(total, 12)
        base = _datetime(yy, m0 + 1, 1) + _timedelta(days=int(math.trunc(_to_number(d))) - 1)
        return _dt_to_serial(base)
    except (ValueError, OverflowError):
        return 0


def _dt_part(s, attr):
    d = _serial_to_dt(s)
    return getattr(d, attr) if d is not None else 0


def _datedif(start, end, unit="d"):
    a, b = _serial_to_dt(start), _serial_to_dt(end)
    u = _date_unit(unit)
    if a is not None and b is not None:
        if u == "y":
            years = b.year - a.year
            if b.month < a.month or (b.month == a.month and b.day < a.day):
                years -= 1
            return years
        if u == "m":
            months = (b.year - a.year) * 12 + (b.month - a.month)
            if b.day < a.day:
                months -= 1
            return months
    return _js_round(_to_number(end) - _to_number(start))


def _eomonth(s, n=0):
    d = _serial_to_dt(_add_months(s, n))
    if d is None:
        return 0
    return _dt_to_serial(_datetime(d.year, d.month, _calendar.monthrange(d.year, d.month)[1]))


def _weekday(s):
    d = _serial_to_dt(s)
    return ((d.weekday() + 1) % 7) + 1 if d is not None else 0


def _now_serial() -> float:
    return (_datetime.utcnow() - _EPOCH).total_seconds() / 86400.0


# ── Function library (port of CALC_FUNCS) ───────────────────────────────────
# Every function takes the argument tuple ``a``; a missing argument behaves
# like JS ``undefined`` (0 as a number, "" as text). Total: never raises.

def _N(a, i):
    return _to_number(a[i]) if i < len(a) else 0.0


def _S(a, i):
    return _calc_text(a[i]) if i < len(a) else ""


def _has(a, i):
    return i < len(a)


def _pow10(a, i):
    return 10.0 ** int(math.trunc(_N(a, i))) if _has(a, i) else 1.0


def _f_proper(a):
    return _re.sub(r"\w\S*", lambda m: m.group(0)[0].upper() + m.group(0)[1:].lower(), _S(a, 0), flags=_re.ASCII)


def _f_pad(a, left: bool):
    s = _S(a, 0)
    width = max(0, int(math.trunc(_N(a, 1))))
    ch = (_S(a, 2) if _has(a, 2) else ("0" if left else " ")) or ("0" if left else " ")
    if len(s) >= width:
        return s
    fill = (ch * (width - len(s)))[: width - len(s)]
    return fill + s if left else s + fill


def _f_split(a):
    s, sep = _S(a, 0), _S(a, 1)
    parts = list(s) if sep == "" else s.split(sep)
    idx = max(1, int(math.trunc(_N(a, 2)))) - 1
    return parts[idx] if idx < len(parts) else ""


def _f_replace(a):
    s, find, repl = _S(a, 0), _S(a, 1), _S(a, 2)
    return repl.join(s) if find == "" else s.replace(find, repl)


def _f_mid(a):
    s = _S(a, 0)
    start = max(0, int(math.trunc(_N(a, 1))) - 1)
    return s[start: start + max(0, int(math.trunc(_N(a, 2))))]


def _f_right(a):
    k = max(0, int(math.trunc(_N(a, 1))))
    return "" if k == 0 else _S(a, 0)[-k:]


def _f_ifs(a):
    for i in range(0, len(a) - 1, 2):
        if _is_truthy(a[i]):
            return a[i + 1]
    return a[-1] if len(a) % 2 == 1 else ""


def _f_switch(a):
    subject = _S(a, 0)
    for i in range(1, len(a) - 1, 2):
        if _calc_text(a[i]) == subject:
            return a[i + 1]
    return a[-1] if (len(a) - 1) % 2 == 1 else ""


def _f_coalesce(a):
    for v in a:
        if _calc_text(v).strip() != "":
            return v
    return ""


def _f_isnumber(a):
    if not a:
        return 0.0
    v = a[0]
    if isinstance(v, (int, float)) and not isinstance(v, bool):
        return 1.0
    t = _calc_text(v).strip()
    return 1.0 if t != "" and _parse_float(t) is not None else 0.0


def _f_text(a):
    if not _has(a, 1):
        return _S(a, 0)
    return _to_fixed(_N(a, 0), max(0, int(math.trunc(_N(a, 1)))))


def _f_dateadd(a):
    u = _date_unit(a[2]) if _has(a, 2) else "d"
    if u == "y":
        return _add_months(a[0] if a else 0, _N(a, 1) * 12)
    if u == "m":
        return _add_months(a[0] if a else 0, _N(a, 1))
    return _js_round(_N(a, 0)) + int(math.trunc(_N(a, 1)))


def _f_formatdate(a):
    return _format_serial(a[0] if a else 0, a[1] if _has(a, 1) else "YYYY-MM-DD")


def _f_min(a):
    return min(_to_number(x) for x in a) if a else 0.0


def _f_max(a):
    return max(_to_number(x) for x in a) if a else 0.0


def _b(cond) -> float:
    return 1.0 if cond else 0.0


_CALC_FUNCS = {
    # Maths
    "ROUND": lambda a: math.floor(_N(a, 0) * _pow10(a, 1) + 0.5) / _pow10(a, 1),
    "ROUNDUP": lambda a: math.ceil(_N(a, 0) * _pow10(a, 1)) / _pow10(a, 1),
    "ROUNDDOWN": lambda a: math.floor(_N(a, 0) * _pow10(a, 1)) / _pow10(a, 1),
    "CEIL": lambda a: float(math.ceil(_N(a, 0))),
    "CEILING": lambda a: float(math.ceil(_N(a, 0))),
    "FLOOR": lambda a: float(math.floor(_N(a, 0))),
    "INT": lambda a: float(math.trunc(_N(a, 0))),
    "TRUNC": lambda a: math.trunc(_N(a, 0) * _pow10(a, 1)) / _pow10(a, 1),
    "ABS": lambda a: abs(_N(a, 0)),
    "SIGN": lambda a: float((_N(a, 0) > 0) - (_N(a, 0) < 0)),
    "SQRT": lambda a: 0.0 if _N(a, 0) < 0 else math.sqrt(_N(a, 0)),
    "POWER": lambda a: _safe_pow(_N(a, 0), _N(a, 1)),
    "MOD": lambda a: 0.0 if _N(a, 1) == 0 else math.fmod(_N(a, 0), _N(a, 1)),
    "MIN": _f_min,
    "MAX": _f_max,
    "AVERAGE": lambda a: sum(_to_number(x) for x in a) / len(a) if a else 0.0,
    "SUMARGS": lambda a: sum(_to_number(x) for x in a),
    "SUMALL": lambda a: sum(_to_number(x) for x in a),
    "CLAMP": lambda a: min(max(_N(a, 0), _N(a, 1)), _N(a, 2)),
    "PERCENT": lambda a: _div(_N(a, 0), _N(a, 1)) * 100,
    "APPLYRATE": lambda a: _N(a, 0) * _N(a, 1) / 100,
    "PCT": lambda a: _N(a, 0) * _N(a, 1) / 100,
    "GROSS": lambda a: _N(a, 0) * (1 + _N(a, 1) / 100),
    "NET": lambda a: _div(_N(a, 0), 1 + _N(a, 1) / 100),
    # Logic
    "AND": lambda a: _b(len(a) > 0 and all(_is_truthy(x) for x in a)),
    "OR": lambda a: _b(any(_is_truthy(x) for x in a)),
    "NOT": lambda a: _b(not _is_truthy(a[0] if a else None)),
    "XOR": lambda a: _b(sum(1 for x in a if _is_truthy(x)) % 2 == 1),
    "TRUE": lambda a: 1.0,
    "FALSE": lambda a: 0.0,
    "ISBLANK": lambda a: _b(_S(a, 0).strip() == ""),
    "ISNUMBER": _f_isnumber,
    "COALESCE": _f_coalesce,
    "IFS": _f_ifs,
    "SWITCH": _f_switch,
    # Text
    "CONCAT": lambda a: "".join(_calc_text(x) for x in a),
    "CONCATENATE": lambda a: "".join(_calc_text(x) for x in a),
    "JOIN": lambda a: _S(a, 0).join(t for t in (_calc_text(x) for x in a[1:]) if t != ""),
    "TEXT": _f_text,
    "VALUE": lambda a: _N(a, 0),
    "UPPER": lambda a: _S(a, 0).upper(),
    "LOWER": lambda a: _S(a, 0).lower(),
    "PROPER": _f_proper,
    "TRIM": lambda a: _S(a, 0).strip(),
    "LEN": lambda a: float(len(_S(a, 0))),
    "LEFT": lambda a: _S(a, 0)[: max(0, int(math.trunc(_N(a, 1))))],
    "RIGHT": _f_right,
    "MID": _f_mid,
    "FIND": lambda a: float(_S(a, 1).find(_S(a, 0)) + 1),
    "CONTAINS": lambda a: _b(_S(a, 1).lower() in _S(a, 0).lower()),
    "STARTSWITH": lambda a: _b(_S(a, 0).lower().startswith(_S(a, 1).lower())),
    "ENDSWITH": lambda a: _b(_S(a, 0).lower().endswith(_S(a, 1).lower())),
    "SUBSTITUTE": _f_replace,
    "REPLACE": _f_replace,
    "PADLEFT": lambda a: _f_pad(a, True),
    "PADRIGHT": lambda a: _f_pad(a, False),
    "SPLIT": _f_split,
    # Dates & times
    "TODAY": lambda a: float(_dt_to_serial(_datetime.utcnow())),
    "NOW": lambda a: _now_serial(),
    "DATE": lambda a: float(_make_date(_N(a, 0), _N(a, 1), _N(a, 2))),
    "YEAR": lambda a: float(_dt_part(a[0] if a else 0, "year")),
    "MONTH": lambda a: float(_dt_part(a[0] if a else 0, "month")),
    "DAY": lambda a: float(_dt_part(a[0] if a else 0, "day")),
    "WEEKDAY": lambda a: float(_weekday(a[0] if a else 0)),
    "ISWEEKEND": lambda a: _b(_weekday(a[0] if a else 0) in (1, 7)),
    "DAYS": lambda a: float(_js_round(_N(a, 0) - _N(a, 1))),
    "NETWORKDAYS": lambda a: float(_network_days(_N(a, 0), _N(a, 1))),
    "ADDDAYS": lambda a: float(_js_round(_N(a, 0)) + int(math.trunc(_N(a, 1)))),
    "DATEADD": lambda a: float(_f_dateadd(a)),
    "ADDMONTHS": lambda a: float(_add_months(a[0] if a else 0, _N(a, 1))),
    "ADDYEARS": lambda a: float(_add_months(a[0] if a else 0, _N(a, 1) * 12)),
    "EOMONTH": lambda a: float(_eomonth(a[0] if a else 0, _N(a, 1))),
    "DATEDIF": lambda a: float(_datedif(a[0] if a else 0, a[1] if _has(a, 1) else 0, a[2] if _has(a, 2) else "d")),
    "FORMATDATE": _f_formatdate,
    "HOUR": lambda a: float(math.floor(_N(a, 0) / 60)),
    "MINUTE": lambda a: float(_js_round(math.fmod(_N(a, 0), 60))),
    "FORMATTIME": lambda a: f"{abs(math.floor(_N(a, 0) / 60)):02d}:{abs(_js_round(math.fmod(_N(a, 0), 60))):02d}",
    "HOURSBETWEEN": lambda a: (_N(a, 1) - _N(a, 0)) / 60,
}


class _CalcParser:
    """Recursive-descent parser/evaluator over a typed-value (number | string)
    expression language:
        expr       := comparison
        comparison := concat ( (">"|"<"|">="|"<="|"=="|"!=") concat )?
        concat     := arith ("&" arith)*
        arith      := term (("+"|"-") term)*
        term       := factor (("*"|"/"|"%") factor)*
        factor     := ("+"|"-") factor | power
        power      := atom ("^" factor)?
        atom       := NUMBER | STRING | IDENT | IDENT "(" args ")" | "(" expr ")"
    IF(cond, a, b) is special-cased so it can return either branch's type."""

    def __init__(self, tokens, scope):
        self.tokens = tokens
        self.i = 0
        self.scope = scope

    def _peek(self):
        return self.tokens[self.i] if self.i < len(self.tokens) else None

    def _next(self):
        t = self._peek()
        self.i += 1
        return t

    def _is_op(self, v):
        t = self._peek()
        return t is not None and t[0] == "op" and t[1] == v

    def parse(self):
        value = self._comparison()
        if self._peek() is not None:
            raise CalcError("Unexpected trailing input")
        return value

    def _comparison(self):
        left = self._concat()
        t = self._peek()
        if t and t[0] == "op" and t[1] in (">", "<", ">=", "<=", "==", "!="):
            op = self._next()[1]
            right = self._concat()
            if op in ("==", "!="):
                if isinstance(left, str) or isinstance(right, str):
                    equal = _js_str(left) == _js_str(right)
                else:
                    equal = _to_number(left) == _to_number(right)
                return 1.0 if (equal if op == "==" else not equal) else 0.0
            if isinstance(left, str) and isinstance(right, str):
                c = (left > right) - (left < right)
                return _b({">": c > 0, "<": c < 0, ">=": c >= 0, "<=": c <= 0}[op])
            ln, rn = _to_number(left), _to_number(right)
            return _b({">": ln > rn, "<": ln < rn, ">=": ln >= rn, "<=": ln <= rn}[op])
        return left

    def _concat(self):
        v = self._arith()
        while self._is_op("&"):
            self._next()
            v = _calc_text(v) + _calc_text(self._arith())
        return v

    def _arith(self):
        v = self._term()
        while self._is_op("+") or self._is_op("-"):
            op = self._next()[1]
            rhs = self._term()
            a, b = _to_number(v), _to_number(rhs)
            v = a + b if op == "+" else a - b
        return v

    def _term(self):
        v = self._factor()
        while self._is_op("*") or self._is_op("/") or self._is_op("%"):
            op = self._next()[1]
            rn = _to_number(self._factor())
            if op == "*":
                v = _to_number(v) * rn
            elif rn == 0:
                v = 0.0
            else:
                v = _to_number(v) / rn if op == "/" else math.fmod(_to_number(v), rn)
        return v

    def _factor(self):
        if self._is_op("-"):
            self._next()
            return -_to_number(self._factor())
        if self._is_op("+"):
            self._next()
            return _to_number(self._factor())
        return self._power()

    def _power(self):
        base = self._atom()
        if self._is_op("^"):
            self._next()
            return _safe_pow(_to_number(base), _to_number(self._factor()))
        return base

    def _atom(self):
        t = self._next()
        if t is None:
            raise CalcError("Unexpected end of expression")
        if t[0] in ("num", "str"):
            return t[1]
        if t == ("op", "("):
            value = self._comparison()
            if self._next() != ("op", ")"):
                raise CalcError("Expected ')'")
            return value
        if t[0] == "ident":
            name = t[1]
            if self._is_op("("):
                self._next()
                return self._function_call(name)
            v = self.scope.get(name)
            return 0 if v is None else v
        raise CalcError("Unexpected token")

    def _function_call(self, name):
        if name.upper() == "IF":
            cond = self._comparison()
            if self._next() != ("op", ","):
                raise CalcError("IF expects 3 arguments: IF(condition, if_true, if_false)")
            true_val = self._comparison()
            if self._next() != ("op", ","):
                raise CalcError("IF expects 3 arguments: IF(condition, if_true, if_false)")
            false_val = self._comparison()
            if self._next() != ("op", ")"):
                raise CalcError("Expected ')'")
            return true_val if _is_truthy(cond) else false_val
        args = []
        if not self._is_op(")"):
            args.append(self._comparison())
            while self._is_op(","):
                self._next()
                args.append(self._comparison())
        if self._next() != ("op", ")"):
            raise CalcError("Expected ')'")
        fn = _CALC_FUNCS.get(name.upper())
        if not fn:
            raise CalcError(f"Unknown function '{name}'")
        return fn(tuple(args))


# ── Scope coercion (port of coerceNumeric / coerceScopeValue) ───────────────

_TEXT_CALC_TYPES = {
    "text", "textarea", "email", "phone", "select", "radio", "multi_select",
    "reference", "user", "url", "calc_text", "auto_number",
}
_NUMERIC_CALC_TYPES = {"number", "currency", "percentage", "rating", "calc_number", "calc_currency"}


def _coerce_numeric(field_type, raw) -> float:
    """Convert one raw field/column value into the NUMBER a calc formula sees.
    Dates -> day count (floored, UTC), times -> minutes, booleans -> 1/0
    ("yes"/"true"/"1" are truthy), currency strings have symbols and thousands
    separators stripped. Always returns a float."""
    if raw is None or raw == "":
        return 0.0
    if field_type in ("date", "datetime", "calc_date"):
        s = str(raw).strip().replace("T", " ")
        dt = None
        for fmt in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%d %H:%M", "%Y-%m-%d"):
            try:
                dt = _datetime.strptime(s[:19], fmt)
                break
            except ValueError:
                continue
        if dt is None:
            return 0.0
        return float(math.floor((dt - _EPOCH).total_seconds() / 86400.0))
    if field_type == "time":
        parts = str(raw).split(":")
        h = _parse_int(parts[0])
        m = _parse_int(parts[1]) if len(parts) > 1 else None
        return float((h or 0) * 60 + (m or 0))
    if field_type in ("boolean", "checkbox", "calc_boolean"):
        if isinstance(raw, str):
            return 1.0 if raw.strip().lower() in ("yes", "true", "1") else 0.0
        return 1.0 if raw else 0.0
    if field_type in _NUMERIC_CALC_TYPES and isinstance(raw, str):
        n = _parse_float(_re.sub(r"[^0-9.\-]", "", raw))
        return n if n is not None else 0.0
    if isinstance(raw, bool):
        return 0.0
    if isinstance(raw, (int, float)):
        return float(raw) if math.isfinite(raw) else 0.0
    if isinstance(raw, str):
        n = _parse_float(raw)
        return n if n is not None else 0.0
    return 0.0


def _coerce_scope_value(field_type, raw):
    """Calc VALUE (number OR string) for a formula. Text-natured types pass
    through as strings so ``status == "Approved"`` works; the rest coerce to
    numbers."""
    if field_type in _TEXT_CALC_TYPES:
        return _js_str(raw)
    return _coerce_numeric(field_type, raw)


def _eval_typed(expression: str, scope: dict):
    """Run the parser against an already-coerced scope. Never raises."""
    if not expression or not isinstance(expression, str):
        return 0
    try:
        return _CalcParser(_calc_tokenize(expression), scope).parse()
    except Exception:  # noqa: BLE001 — a bad formula must never break generation
        return 0


def evaluate_calc_expression(expression: str, scope: dict):
    """Evaluate a calc expression referencing field *keys* in ``scope``.
    Never raises — any parse or evaluation error resolves to 0. ``scope`` is
    used as-is; callers with field types should build it via
    ``_coerce_scope_value`` (see ``compute_calculated_values``)."""
    return _eval_typed(expression, dict(scope or {}))


def format_calc_result(field_type, result):
    """A calc_date formula yields a day serial — store it as an ISO date."""
    if field_type == "calc_date" and isinstance(result, (int, float)) and not isinstance(result, bool):
        return _format_serial(result)
    return result


# ── Whole-column aggregates ─────────────────────────────────────────────────

_AGG_FUNCS = {
    "SUM", "AVG", "COUNT", "COUNTA", "COUNTBLANK", "COLMIN", "COLMAX",
    "MEDIAN", "PRODUCT", "FIRST", "LAST", "SUMIF", "COUNTIF", "AVGIF",
    "COLJOIN", "ROWCOUNT",
}
_AGG_NAME_RE = _re.compile(r"\b([A-Za-z_][A-Za-z0-9_]*)\s*\(")
_CRITERIA_RE = _re.compile(r"^(>=|<=|<>|!=|=|>|<)\s*(.*)$")


def _cell_text(v) -> str:
    return "" if v is None else _js_str(v).strip()


def _split_top_level_args(inner: str):
    args, depth, quote, current = [], 0, None, ""
    i = 0
    while i < len(inner):
        ch = inner[i]
        if quote:
            current += ch
            if ch == "\\" and i + 1 < len(inner):
                current += inner[i + 1]
                i += 1
            elif ch == quote:
                quote = None
            i += 1
            continue
        if ch in ('"', "'"):
            quote = ch
            current += ch
        elif ch == "(":
            depth += 1
            current += ch
        elif ch == ")":
            depth -= 1
            current += ch
        elif ch == "," and depth == 0:
            args.append(current.strip())
            current = ""
        else:
            current += ch
        i += 1
    if current.strip() != "" or args:
        args.append(current.strip())
    return args


def _literal_arg(arg) -> str:
    if not arg:
        return ""
    t = arg.strip()
    if len(t) >= 2 and ((t[0] == '"' and t[-1] == '"') or (t[0] == "'" and t[-1] == "'")):
        return _re.sub(r"\\([\"'\\])", r"\1", t[1:-1])
    return t


def _matches_criteria(raw, criteria: str) -> bool:
    cell = _cell_text(raw)
    c = criteria.strip()
    m = _CRITERIA_RE.match(c)
    if not m:
        return cell.lower() == c.lower()
    op, rhs = m.group(1), m.group(2).strip()
    if op == "=":
        return cell.lower() == rhs.lower()
    if op in ("<>", "!="):
        return cell.lower() != rhs.lower()
    a, b = _parse_float(cell), _parse_float(rhs)
    if cell != "" and rhs != "" and a is not None and b is not None:
        return {">": a > b, ">=": a >= b, "<": a < b, "<=": a <= b}[op]
    cmp = (cell > rhs) - (cell < rhs)
    return {">": cmp > 0, ">=": cmp >= 0, "<": cmp < 0, "<=": cmp <= 0}[op]


def _resolve_column_ref(ref: str, rows, col_types, all_tables):
    first, _, second = ref.partition(".")
    if second:
        info = (all_tables or {}).get(first) or {}
        return info.get("rows") or [], (info.get("col_types") or {}).get(second), second
    if rows is not None and col_types is not None and first in col_types:
        return rows, col_types[first], first
    for info in (all_tables or {}).values():
        ct = info.get("col_types") or {}
        if first in ct:
            return info.get("rows") or [], ct[first], first
    return [], None, first


def _num_literal(x) -> str:
    # Aggregate results can be plain ints (e.g. ``SUM`` over an empty/unknown
    # table is ``sum([]) == 0``), so normalise before the float-only checks.
    try:
        x = float(x)
    except (TypeError, ValueError):
        return "0"
    if not math.isfinite(x):
        return "0"
    if x.is_integer() and abs(x) < 1e21:
        return str(int(x))
    s = repr(float(x))
    if "e" in s or "E" in s:
        s = format(_Decimal(s), "f")
    return s


def _resolve_row_aggregates(expression: str, rows, col_types, all_tables: dict = None) -> str:
    """Replace whole-column aggregate calls with their computed literal, across
    EVERY row of a table — from a table column's formula (``rows`` = that
    table's rows) or a top-level field's formula (``rows`` = None; everything
    resolves through ``all_tables``, a ``{table_key: {"rows", "col_types"}}`` map).

    Supported: SUM AVG COUNT COUNTA COUNTBLANK COLMIN COLMAX MEDIAN PRODUCT
    FIRST LAST, SUMIF/AVGIF(value_col, test_col, "criteria"),
    COUNTIF(test_col, "criteria"), COLJOIN(col, sep), ROWCOUNT(table_key).
    A textual pre-pass (not a grammar feature) because an aggregate needs the
    raw column key plus the full row list."""
    if not expression or "(" not in expression:
        return expression
    out = expression
    for _guard in range(200):
        found = None
        for match in _AGG_NAME_RE.finditer(out):
            fn = match.group(1).upper()
            if fn not in _AGG_FUNCS:
                continue
            depth, quote, i = 1, None, match.end()
            while i < len(out) and depth > 0:
                ch = out[i]
                if quote:
                    if ch == "\\":
                        i += 1
                    elif ch == quote:
                        quote = None
                elif ch in ('"', "'"):
                    quote = ch
                elif ch == "(":
                    depth += 1
                elif ch == ")":
                    depth -= 1
                i += 1
            if depth != 0:
                continue
            found = (match.start(), out[match.end(): i - 1], i, fn)
            break
        if not found:
            break
        start, inner, end, fn = found
        args = _split_top_level_args(inner)
        literal = "(0)"

        if fn == "ROWCOUNT":
            info = (all_tables or {}).get(_literal_arg(args[0] if args else ""))
            literal = f"({len(info['rows']) if info else (len(rows) if rows else 0)})"
        else:
            t_rows, t_type, t_key = _resolve_column_ref(_literal_arg(args[0] if args else ""), rows, col_types, all_tables)
            t_rows = [r for r in t_rows if isinstance(r, dict)]
            cells = [r.get(t_key) for r in t_rows]
            nums = [_coerce_numeric(t_type, v) for v in cells]
            if fn in ("SUMIF", "AVGIF", "COUNTIF"):
                test_ref = _literal_arg(args[0] if args else "") if fn == "COUNTIF" else _literal_arg(args[1] if len(args) > 1 else "")
                criteria = _literal_arg(args[1] if len(args) > 1 else "") if fn == "COUNTIF" else _literal_arg(args[2] if len(args) > 2 else "")
                test_rows, _tt, test_key = _resolve_column_ref(test_ref, rows, col_types, all_tables)
                keep, matched = [], 0
                for idx, row in enumerate(t_rows):
                    src = test_rows[idx] if idx < len(test_rows) and isinstance(test_rows[idx], dict) else row
                    if not _matches_criteria(src.get(test_key), criteria):
                        continue
                    matched += 1
                    keep.append(_coerce_numeric(t_type, row.get(t_key)))
                if fn == "COUNTIF":
                    literal = f"({matched})"
                elif fn == "SUMIF":
                    literal = f"({_num_literal(sum(keep))})"
                else:
                    literal = f"({_num_literal(sum(keep) / len(keep) if keep else 0.0)})"
            elif fn == "COLJOIN":
                sep = _literal_arg(args[1]) if len(args) > 1 else ", "
                literal = _json.dumps(sep.join(t for t in (_cell_text(v) for v in cells) if t != ""), ensure_ascii=False)
            else:
                if fn == "SUM":
                    result = sum(nums)
                elif fn == "AVG":
                    result = sum(nums) / len(nums) if nums else 0.0
                elif fn == "COUNT":
                    result = float(len(nums))
                elif fn == "COUNTA":
                    result = float(sum(1 for v in cells if _cell_text(v) != ""))
                elif fn == "COUNTBLANK":
                    result = float(sum(1 for v in cells if _cell_text(v) == ""))
                elif fn == "COLMIN":
                    result = min(nums) if nums else 0.0
                elif fn == "COLMAX":
                    result = max(nums) if nums else 0.0
                elif fn == "PRODUCT":
                    result = math.prod(nums) if nums else 0.0
                elif fn == "MEDIAN":
                    s = sorted(nums)
                    mid = len(s) // 2
                    result = (s[mid] if len(s) % 2 else (s[mid - 1] + s[mid]) / 2) if s else 0.0
                elif fn == "FIRST":
                    result = nums[0] if nums else 0.0
                elif fn == "LAST":
                    result = nums[-1] if nums else 0.0
                else:
                    result = 0.0
                literal = f"({_num_literal(result)})"
        out = out[:start] + literal + out[end:]
    return out


# ── Orchestration ───────────────────────────────────────────────────────────

def _first_row_scope(all_tables: dict) -> dict:
    """A PLAIN reference to a table column — bare ``amount`` or ``table.amount``
    — is that column's value off the FIRST row. Bare keys: first table wins."""
    scope = {}
    for table_key, info in all_tables.items():
        rows = info["rows"]
        first_row = rows[0] if rows and isinstance(rows[0], dict) else {}
        for col_key, col_type in info["col_types"].items():
            value = _coerce_scope_value(col_type, first_row.get(col_key))
            scope.setdefault(col_key, value)
            scope[f"{table_key}.{col_key}"] = value
    return scope


def compute_calculated_values(sections, values: dict) -> dict:
    """Return `values` with every field carrying a `calc` config recomputed
    server-side, authoritative over anything the client submitted.

    1. Top-level fields (``field.calc``) resolve in template order, so a formula
       can reference an earlier calculated field. They may aggregate any table
       (``SUM(expenses.amount)``, ``SUMIF(...)`` …). A ``calc_date`` result is
       stored as an ISO date string.
    2. Table columns (``column.calc``) resolve column-by-column across every row,
       repeated until stable (bounded by the number of calc columns) so a column
       may reference a calculated column declared later in the table. A column
       formula can use same-row cells, top-level fields, whole-column aggregates
       of its own or another table, and another table's first row.
    """
    out = dict(values or {})

    top_field_types = {}
    for section in sections or []:
        for field in section.get("fields", []):
            key = field.get("key")
            if key:
                top_field_types[key] = field.get("type")

    # Shared LIVE registry of every table: each entry's "rows" is the SAME list
    # written back into `out[key]`, mutated in place as calculated columns
    # resolve, so cross-table lookups always see current state.
    all_tables: dict = {}
    for section in sections or []:
        for field in section.get("fields", []):
            key = field.get("key")
            if not key or field.get("type") != "table":
                continue
            columns = field.get("columns") or []
            rows = out.get(key)
            if not isinstance(rows, list):
                rows = []
            new_rows = [dict(r) if isinstance(r, dict) else r for r in rows]
            out[key] = new_rows
            all_tables[key] = {
                "rows": new_rows,
                "col_types": {c.get("key"): c.get("type") for c in columns if c.get("key")},
                "calc_columns": [c for c in columns if c.get("calc") and c.get("calc", {}).get("expression") and c.get("key")],
            }

    # Real top-level field values; table-derived fallbacks are layered UNDER them.
    field_scope = {key: _coerce_scope_value(ftype, out.get(key)) for key, ftype in top_field_types.items()}

    def top_scope():
        scope = _first_row_scope(all_tables)
        scope.update(field_scope)
        return scope

    for section in sections or []:
        for field in section.get("fields", []):
            key = field.get("key")
            if not key:
                continue

            if field.get("type") == "table":
                info = all_tables.get(key)
                if not info or not info["calc_columns"]:
                    continue
                rows, col_types, calc_cols = info["rows"], info["col_types"], info["calc_columns"]
                for _pass in range(len(calc_cols)):
                    changed = False
                    for col in calc_cols:
                        col_key = col["key"]
                        calc = col["calc"]
                        decimals = calc.get("decimals")
                        resolved = _resolve_row_aggregates(calc.get("expression", ""), rows, col_types, all_tables)
                        for row in rows:
                            if not isinstance(row, dict):
                                continue
                            scope = top_scope()
                            for ck, ctype in col_types.items():
                                scope[ck] = _coerce_scope_value(ctype, row.get(ck))
                            result = _round_decimals(_eval_typed(resolved, scope), decimals)
                            if row.get(col_key) != result:
                                changed = True
                            row[col_key] = result
                    if not changed:
                        break
                continue

            calc = field.get("calc")
            if not calc or not calc.get("expression"):
                continue
            resolved = _resolve_row_aggregates(calc.get("expression", ""), None, {}, all_tables)
            result = _round_decimals(_eval_typed(resolved, top_scope()), calc.get("decimals"))
            # Downstream formulas see the raw value (a date serial, not its text).
            field_scope[key] = result
            out[key] = format_calc_result(field.get("type"), result)

    return out
