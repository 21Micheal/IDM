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


# ─── Calculated fields ──────────────────────────────────────────────────────
# Server-side mirror of the frontend's calculation evaluator (TemplateBuilderV2
# .tsx `evaluateCalcExpression`). A field carrying ``calc: {"expression": "...",
# "decimals": n}`` (see TemplateField.calc) is auto-derived from sibling field
# values and is never trusted from the client — `compute_calculated_values` is
# the single authoritative place this is (re)computed, called from both the
# fill() required-field check and document generation (tasks.py).
#
# The grammar is intentionally tiny and side-effect free: numbers, field keys,
# + - * / ( ) with the usual precedence, unary +/-, and a handful of pure
# functions (ROUND, ABS, MIN, MAX). No arbitrary code execution (no eval/exec).

import re as _re

_CALC_TOKEN_RE = _re.compile(
    r"\s*(?:(?P<num>\d+\.\d+|\d+)|(?P<ident>[A-Za-z_][A-Za-z0-9_]*)|(?P<op>[+\-*/(),]))"
)


class CalcError(Exception):
    pass


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
        if m.group("num"):
            tokens.append(("num", float(m.group("num"))))
        elif m.group("ident"):
            tokens.append(("ident", m.group("ident")))
        else:
            tokens.append(("op", m.group("op")))
    return tokens


_CALC_FUNCS = {
    "ROUND": lambda a, n=0: round(a, int(n)),
    "ABS": abs,
    "MIN": lambda *a: min(a) if a else 0,
    "MAX": lambda *a: max(a) if a else 0,
}


class _CalcParser:
    """Minimal recursive-descent parser/evaluator: expr := term (+|- term)*;
    term := factor (*|/ factor)*; factor := (+|-)? atom; atom := number |
    IDENT | IDENT '(' args ')' | '(' expr ')'."""

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

    def parse(self):
        value = self._expr()
        if self._peek() is not None:
            raise CalcError("Unexpected trailing input")
        return value

    def _expr(self):
        value = self._term()
        while True:
            t = self._peek()
            if t and t[0] == "op" and t[1] in ("+", "-"):
                self._next()
                rhs = self._term()
                value = value + rhs if t[1] == "+" else value - rhs
            else:
                return value

    def _term(self):
        value = self._factor()
        while True:
            t = self._peek()
            if t and t[0] == "op" and t[1] in ("*", "/"):
                self._next()
                rhs = self._factor()
                value = value * rhs if t[1] == "*" else (value / rhs if rhs else 0)
            else:
                return value

    def _factor(self):
        t = self._peek()
        if t and t == ("op", "-"):
            self._next()
            return -self._factor()
        if t and t == ("op", "+"):
            self._next()
            return self._factor()
        return self._atom()

    def _atom(self):
        t = self._next()
        if t is None:
            raise CalcError("Unexpected end of expression")
        if t[0] == "num":
            return t[1]
        if t == ("op", "("):
            value = self._expr()
            if self._next() != ("op", ")"):
                raise CalcError("Expected ')'")
            return value
        if t[0] == "ident":
            name = t[1]
            if self._peek() == ("op", "("):
                self._next()
                args = []
                if self._peek() != ("op", ")"):
                    args.append(self._expr())
                    while self._peek() == ("op", ","):
                        self._next()
                        args.append(self._expr())
                if self._next() != ("op", ")"):
                    raise CalcError("Expected ')'")
                fn = _CALC_FUNCS.get(name.upper())
                if not fn:
                    raise CalcError(f"Unknown function '{name}'")
                return fn(*args)
            return self.scope.get(name, 0)
        raise CalcError("Unexpected token")


def evaluate_calc_expression(expression: str, scope: dict):
    """Evaluate a restricted arithmetic expression referencing field *keys* in
    ``scope`` (e.g. ``total_days * daily_rate``). Non-numeric / missing values
    coerce to 0. Never raises — any parse or evaluation error resolves to 0 so
    a bad formula can't break document generation."""
    if not expression or not isinstance(expression, str):
        return 0
    numeric_scope = {}
    for key, raw in (scope or {}).items():
        try:
            numeric_scope[key] = float(raw) if raw not in (None, "") else 0.0
        except (TypeError, ValueError):
            numeric_scope[key] = 0.0
    try:
        tokens = _calc_tokenize(expression)
        return _CalcParser(tokens, numeric_scope).parse()
    except (CalcError, ZeroDivisionError, IndexError):
        return 0


def compute_calculated_values(sections, values: dict) -> dict:
    """Return `values` with every field carrying a `calc` config recomputed
    server-side, authoritative over anything the client submitted. Fields
    resolve in template order so a formula can reference an earlier
    calculated field's result (e.g. a "total" that sums two other
    calculated fields)."""
    out = dict(values or {})
    for section in sections or []:
        for field in section.get("fields", []):
            calc = field.get("calc")
            key = field.get("key")
            if not calc or not key:
                continue
            result = evaluate_calc_expression(calc.get("expression", ""), out)
            decimals = calc.get("decimals")
            if isinstance(decimals, int):
                result = round(result, decimals)
            out[key] = result
    return out