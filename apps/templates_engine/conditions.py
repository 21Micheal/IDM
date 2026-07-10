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


def _coerce_scope_value(field_type, raw):
    """Convert one raw field/column value into the number a calc formula
    should see, based on its declared type. Mirrors the frontend's
    ``coerceScopeValue`` exactly.

    This replaces a previous naive ``float(raw)`` coercion that silently
    broke date arithmetic: ``float("2026-07-12")`` raises (or, with the old
    two-argument fallback, could mis-parse), so ``end_date - start_date``
    formulas never produced a meaningful day count. Dates/datetimes now
    convert to a day-count (days since the Unix epoch) so subtracting two
    dates yields the number of days between them directly — e.g. UniFi's own
    ``(travel_end_date - travel_start_date) + 1`` pattern."""
    if raw is None or raw == "":
        return 0.0
    if field_type in ("date", "datetime", "calc_date"):
        from datetime import datetime
        s = str(raw).strip().replace("T", " ")
        for fmt in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%d %H:%M", "%Y-%m-%d"):
            try:
                dt = datetime.strptime(s[:19], fmt)
                break
            except ValueError:
                dt = None
        if dt is None:
            return 0.0
        return (dt - datetime(1970, 1, 1)).total_seconds() / 86400.0
    if field_type == "time":
        parts = str(raw).split(":")
        try:
            hours = int(parts[0])
            minutes = int(parts[1]) if len(parts) > 1 else 0
            return float(hours * 60 + minutes)
        except (ValueError, IndexError):
            return 0.0
    if field_type in ("boolean", "checkbox"):
        return 1.0 if raw else 0.0
    try:
        return float(raw)
    except (TypeError, ValueError):
        return 0.0


def evaluate_calc_expression(expression: str, scope: dict):
    """Evaluate a restricted arithmetic expression referencing field *keys* in
    ``scope`` (e.g. ``total_days * daily_rate``). Non-numeric / missing values
    coerce to 0. Never raises — any parse or evaluation error resolves to 0 so
    a bad formula can't break document generation.

    ``scope`` here is a plain (already-typed-if-the-caller-wants) value dict;
    callers with field-type information (compute_calculated_values below)
    should build a properly-coerced numeric scope themselves via
    ``_coerce_scope_value`` — this entry point applies the generic numeric
    fallback for callers that don't have type info handy."""
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


def _eval_typed(expression: str, numeric_scope: dict):
    """Run the parser against an already-numeric scope (see
    ``_coerce_scope_value``) without re-coercing it. Never raises."""
    if not expression or not isinstance(expression, str):
        return 0
    try:
        tokens = _calc_tokenize(expression)
        return _CalcParser(tokens, numeric_scope).parse()
    except (CalcError, ZeroDivisionError, IndexError):
        return 0


_AGG_CALL_RE = _re.compile(
    r"\b(SUM|AVG|COUNT|COLMIN|COLMAX)\(\s*([A-Za-z_][A-Za-z0-9_]*)"
    r"(?:\.([A-Za-z_][A-Za-z0-9_]*))?\s*\)",
    _re.IGNORECASE,
)


def _resolve_row_aggregates(expression: str, rows, col_types: dict, all_tables: dict = None) -> str:
    """Replace ``SUM(col)``, ``AVG(col)``, ``COUNT(col)``, ``COLMIN(col)``,
    ``COLMAX(col)`` calls in a table-column formula with their computed
    numeric literal, aggregated across EVERY row of a table — not just the
    row currently being evaluated. This is what lets a column do a
    running-total/footer-style calculation (e.g. a "% of total" column, or a
    balance column referencing the sum of another column across all expense
    lines) rather than only ever seeing its own row.

    Unqualified — ``SUM(amount)`` — aggregates the CURRENT table's own
    ``rows``/``col_types``. Qualified with a dot — ``SUM(other_table.amount)``
    — aggregates a *different* table field elsewhere in the same template,
    looked up by that field's key in ``all_tables`` (a ``{table_field_key:
    {"rows": [...], "col_types": {...}}}`` map built once for the whole
    template in ``compute_calculated_values``). This lets one table
    reference totals from another — e.g. an "Approved Budget" table's
    balance column referencing ``SUM(expenses.amount)`` from a separate
    "Expenses" table.

    Deliberately a textual substitution pass *before* the normal expression
    parser runs, rather than a grammar feature: the parser's function calls
    evaluate their arguments as expressions against a single row's scope,
    but an aggregate needs the raw column key and a full row list, which
    that grammar has no way to express. Named distinctly from the pointwise
    ``MIN``/``MAX`` (which take already-evaluated numbers, e.g.
    ``MIN(a, b)``) to avoid confusing the two."""
    if not expression or "(" not in expression:
        return expression

    def replace(match):
        func = match.group(1).upper()
        first_ident = match.group(2)
        second_ident = match.group(3)

        if second_ident:
            # Qualified: first_ident names another table field; second_ident
            # is the column key within THAT table.
            table_info = (all_tables or {}).get(first_ident) or {}
            target_rows = table_info.get("rows") or []
            target_col_types = table_info.get("col_types") or {}
            col_key = second_ident
        else:
            target_rows = rows
            target_col_types = col_types
            col_key = first_ident

        col_type = target_col_types.get(col_key)
        col_values = [
            _coerce_scope_value(col_type, (row or {}).get(col_key))
            for row in target_rows if isinstance(row, dict)
        ]
        if func == "SUM":
            result = sum(col_values)
        elif func == "AVG":
            result = (sum(col_values) / len(col_values)) if col_values else 0.0
        elif func == "COUNT":
            result = float(len(col_values))
        elif func == "COLMIN":
            result = min(col_values) if col_values else 0.0
        elif func == "COLMAX":
            result = max(col_values) if col_values else 0.0
        else:
            result = 0.0
        return repr(result)

    return _AGG_CALL_RE.sub(replace, expression)


def compute_calculated_values(sections, values: dict) -> dict:
    """Return `values` with every field carrying a `calc` config recomputed
    server-side, authoritative over anything the client submitted.

    Two kinds of calculated fields are resolved:

    1. Top-level fields (``field.calc``) — resolved in template order so a
       formula can reference an earlier calculated field's result (e.g. a
       "total" that sums two other calculated fields). Uses each field's
       declared ``type`` for scope coercion, so date/time/boolean fields
       arithmetic correctly (see ``_coerce_scope_value``).

    2. Table columns (``column.calc``, on a field of type "table") —
       resolved COLUMN-MAJOR: each calculated column is fully resolved
       across every row before moving to the next column, so a later
       column's formula can reference an earlier calculated column's
       finished values in ANY row, not just its own. Three kinds of
       references are supported inside a column formula:
         - Same-row references — a sibling cell (``qty * unit_price``) or a
           top-level field whose single value applies to every row
           (``daily_subsistence_allowance`` — mirrors UniFi's "DSA Amount"
           column, which is just ``= daily_subsistence_allowance`` copied
           down every expense line).
         - Whole-column aggregates — ``SUM(col)``, ``AVG(col)``,
           ``COUNT(col)``, ``COLMIN(col)``, ``COLMAX(col)`` computed across
           every row of the SAME table (see ``_resolve_row_aggregates``),
           for running-total / variance-from-average style columns.
         - Cross-table aggregates — ``SUM(other_table_key.col)`` etc.,
           computed across every row of a DIFFERENT table field elsewhere in
           the template, addressed by that field's key. Tables are
           processed in template order, so a cross-table reference sees the
           referenced table's finished (calculated) values if that table
           appears earlier in the template, or its raw submitted values if
           it appears later — the same "template order" rule that already
           applies to top-level calculated fields.
    """
    out = dict(values or {})

    # Build the type map once so table-row scopes can reuse it, and track a
    # running numeric top-level scope that top-level calc fields update as
    # they resolve (letting later formulas see earlier results).
    top_field_types = {}
    for section in sections or []:
        for field in section.get("fields", []):
            key = field.get("key")
            if key:
                top_field_types[key] = field.get("type")

    top_scope = {
        key: _coerce_scope_value(ftype, out.get(key))
        for key, ftype in top_field_types.items()
    }

    # Shared, LIVE registry of every table field in the template — keyed by
    # the table field's own key — so a column formula in one table can
    # aggregate across another table's rows (SUM(other_table.column)). Each
    # entry's "rows" is the SAME list object written back into `out[key]`,
    # and each row is mutated in place as its calculated columns resolve, so
    # a cross-table lookup always sees whatever that table's current state
    # is at the moment it's queried — no separate sync step needed.
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
            out[key] = new_rows  # write back now so other tables see this list
            all_tables[key] = {
                "rows": new_rows,
                "col_types": {c.get("key"): c.get("type") for c in columns if c.get("key")},
                "calc_columns": [c for c in columns if c.get("calc") and c.get("key")],
            }

    for section in sections or []:
        for field in section.get("fields", []):
            key = field.get("key")
            if not key:
                continue

            if field.get("type") == "table":
                table_info = all_tables.get(key)
                if not table_info or not table_info["calc_columns"]:
                    continue
                rows = table_info["rows"]
                col_types = table_info["col_types"]

                for col in table_info["calc_columns"]:
                    col_key = col["key"]
                    calc = col["calc"]
                    decimals = calc.get("decimals")
                    # Aggregates are the same value for every row, so resolve
                    # them once per column (against the column's current
                    # state — including any earlier calculated columns
                    # already written into `rows` this pass, and any other
                    # table's current state via `all_tables`).
                    resolved_expr = _resolve_row_aggregates(
                        calc.get("expression", ""), rows, col_types, all_tables
                    )
                    for row in rows:
                        if not isinstance(row, dict):
                            continue
                        row_scope = dict(top_scope)
                        for ck, ctype in col_types.items():
                            row_scope[ck] = _coerce_scope_value(ctype, row.get(ck))
                        result = _eval_typed(resolved_expr, row_scope)
                        if isinstance(decimals, int):
                            result = round(result, decimals)
                        row[col_key] = result
                continue

            calc = field.get("calc")
            if not calc:
                continue
            result = _eval_typed(calc.get("expression", ""), top_scope)
            decimals = calc.get("decimals")
            if isinstance(decimals, int):
                result = round(result, decimals)
            out[key] = result
            top_scope[key] = result if isinstance(result, (int, float)) else 0.0

    return out