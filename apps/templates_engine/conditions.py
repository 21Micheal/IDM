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
    def step_matches(actual: str, expected: str) -> bool:
        actual = (actual or "").strip().lower()
        expected = (expected or "").strip().lower()
        if actual == expected:
            return True
        aliases = {
            "approved": {"approved", "request_approved", "fully_approved"},
            "pending_approval": {"pending_approval", "request_pending", "retirement_pending"},
            "returned": {"returned", "retirement_returned"},
            "rejected": {"rejected", "retirement_rejected"},
        }
        return actual in aliases.get(expected, set())

    if cond.get("source") == "process_step":
        sv = process_step
    else:
        raw = values.get(cond.get("fieldKey"))
        sv = "" if raw is None else str(raw)
    operator = cond.get("operator")
    expected = cond.get("value") or ""
    if operator == "equals":
        if cond.get("source") == "process_step":
            return step_matches(sv, expected)
        return sv == expected
    if operator == "not_equals":
        if cond.get("source") == "process_step":
            return not step_matches(sv, expected)
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
# The grammar is intentionally small and side-effect free — no eval/exec, no
# arbitrary code execution:
#   - numbers, "string literals", field/column keys
#   - + - * / ( ) with the usual precedence, unary +/-
#   - comparisons: > < >= <= == !=  (numeric for > < >= <=; ==/!= compare as
#     strings if either side is text-natured, else numerically)
#   - IF(condition, value_if_true, value_if_false) — the one place a formula
#     can produce a STRING result (e.g. a status message), not just a number
#   - pure functions: ROUND, ABS, MIN, MAX (numeric), plus the whole-column
#     aggregates SUM/AVG/COUNT/COLMIN/COLMAX resolved separately by
#     ``_resolve_row_aggregates`` before this parser ever sees the formula.
# A formula's result can therefore be either a number or a string — see
# ``compute_calculated_values``, which stores whichever came out.

import re as _re

_CALC_TOKEN_RE = _re.compile(
    r'\s*(?:(?P<num>\d+\.\d+|\d+)'
    r'|(?P<str>"(?:[^"\\]|\\.)*")'
    r"|(?P<ident>[A-Za-z_][A-Za-z0-9_]*)"
    r"|(?P<cmp>>=|<=|==|!=)"
    r"|(?P<op>[+\-*/(),><]))"
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
        elif m.group("str"):
            raw = m.group("str")[1:-1]
            tokens.append(("str", raw.replace('\\"', '"').replace("\\\\", "\\")))
        elif m.group("ident"):
            tokens.append(("ident", m.group("ident")))
        elif m.group("cmp"):
            tokens.append(("op", m.group("cmp")))
        else:
            tokens.append(("op", m.group("op")))
    return tokens


def _to_number(value) -> float:
    """Coerce any calc VALUE (number or string) to a float for arithmetic /
    comparison, never raising — an unparseable string is treated as 0,
    consistent with the evaluator's "never throws" philosophy."""
    if isinstance(value, (int, float)):
        return float(value)
    if isinstance(value, str):
        try:
            return float(value)
        except ValueError:
            return 0.0
    return 0.0


def _is_truthy(value) -> bool:
    if isinstance(value, str):
        return value.strip() != ""
    return _to_number(value) != 0


_CALC_FUNCS = {
    "ROUND": lambda a, n=0: round(_to_number(a), int(_to_number(n))),
    "ABS": lambda a: abs(_to_number(a)),
    "MIN": lambda *a: min((_to_number(x) for x in a), default=0.0),
    "MAX": lambda *a: max((_to_number(x) for x in a), default=0.0),
}


class _CalcParser:
    """Recursive-descent parser/evaluator over a small typed-value (number |
    string) expression language:
        expr       := comparison
        comparison := arith ( (">"|"<"|">="|"<="|"=="|"!=") arith )?
        arith      := term (("+"|"-") term)*
        term       := factor (("*"|"/") factor)*
        factor     := ("+"|"-")? atom
        atom       := NUMBER | STRING | IDENT | IDENT "(" args ")" | "(" expr ")"
    IF(cond, a, b) is a special-cased function: both branches are always
    evaluated (this language is pure/side-effect-free, so there's no
    correctness cost to skipping short-circuit evaluation) and the truthy
    one is returned — which is what lets it return either branch's type
    (typically a string message) rather than forcing a number."""

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
        value = self._comparison()
        if self._peek() is not None:
            raise CalcError("Unexpected trailing input")
        return value

    def _comparison(self):
        left = self._arith()
        t = self._peek()
        if t and t[0] == "op" and t[1] in (">", "<", ">=", "<=", "==", "!="):
            op = self._next()[1]
            right = self._arith()
            if op in ("==", "!="):
                if isinstance(left, str) or isinstance(right, str):
                    equal = str(left) == str(right)
                else:
                    equal = _to_number(left) == _to_number(right)
                return 1.0 if (equal if op == "==" else not equal) else 0.0
            ln, rn = _to_number(left), _to_number(right)
            if op == ">":
                return 1.0 if ln > rn else 0.0
            if op == "<":
                return 1.0 if ln < rn else 0.0
            if op == ">=":
                return 1.0 if ln >= rn else 0.0
            return 1.0 if ln <= rn else 0.0
        return left

    def _arith(self):
        value = self._term()
        while True:
            t = self._peek()
            if t and t[0] == "op" and t[1] in ("+", "-"):
                self._next()
                rhs = self._term()
                a, b = _to_number(value), _to_number(rhs)
                value = a + b if t[1] == "+" else a - b
            else:
                return value

    def _term(self):
        value = self._factor()
        while True:
            t = self._peek()
            if t and t[0] == "op" and t[1] in ("*", "/"):
                self._next()
                rhs = self._factor()
                a, b = _to_number(value), _to_number(rhs)
                value = a * b if t[1] == "*" else (a / b if b else 0.0)
            else:
                return value

    def _factor(self):
        t = self._peek()
        if t and t == ("op", "-"):
            self._next()
            return -_to_number(self._factor())
        if t and t == ("op", "+"):
            self._next()
            return _to_number(self._factor())
        return self._atom()

    def _atom(self):
        t = self._next()
        if t is None:
            raise CalcError("Unexpected end of expression")
        if t[0] == "num":
            return t[1]
        if t[0] == "str":
            return t[1]
        if t == ("op", "("):
            value = self._comparison()
            if self._next() != ("op", ")"):
                raise CalcError("Expected ')'")
            return value
        if t[0] == "ident":
            name = t[1]
            if self._peek() == ("op", "("):
                self._next()
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
                if self._peek() != ("op", ")"):
                    args.append(self._comparison())
                    while self._peek() == ("op", ","):
                        self._next()
                        args.append(self._comparison())
                if self._next() != ("op", ")"):
                    raise CalcError("Expected ')'")
                fn = _CALC_FUNCS.get(name.upper())
                if not fn:
                    raise CalcError(f"Unknown function '{name}'")
                return fn(*args)
            return self.scope.get(name, 0)
        raise CalcError("Unexpected token")


def _coerce_numeric(field_type, raw) -> float:
    """Convert one raw field/column value into the NUMBER a calc formula
    should see for arithmetic/aggregation, based on its declared type.

    This replaces a previous naive ``float(raw)`` coercion that silently
    broke date arithmetic: ``float("2026-07-12")`` raises (or, with the old
    two-argument fallback, could mis-parse), so ``end_date - start_date``
    formulas never produced a meaningful day count. Dates/datetimes now
    convert to a day-count (days since the Unix epoch) so subtracting two
    dates yields the number of days between them directly — e.g. UniFi's own
    ``(travel_end_date - travel_start_date) + 1`` pattern.

    Always returns a float regardless of type — this is the coercion used
    for whole-column aggregates (SUM/AVG/COUNT/COLMIN/COLMAX), which need a
    number even from a text-natured column (summing text is meaningless but
    must not crash)."""
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


# Field/column types whose natural VALUE for a calc formula is text, not a
# number — passed through as a raw string rather than coerced to 0. This is
# what makes ``category == "Travel"`` or an IF() condition testing a
# dropdown's selection actually work, while numeric-natured types (currency,
# number, date, boolean, …) still coerce as before for arithmetic.
_TEXT_CALC_TYPES = {
    "text", "textarea", "email", "phone", "select", "radio", "multi_select",
    "reference", "user", "url", "calc_text", "auto_number",
}


def _coerce_scope_value(field_type, raw):
    """Convert one raw field/column value into the calc VALUE (number OR
    string) a formula should see, based on its declared type. Text-natured
    types (see ``_TEXT_CALC_TYPES``) pass through as a string so string
    comparisons (``status == "Approved"``) and IF() conditions work;
    everything else coerces to a number via ``_coerce_numeric``."""
    if field_type in _TEXT_CALC_TYPES:
        return "" if raw is None else str(raw)
    return _coerce_numeric(field_type, raw)


def evaluate_calc_expression(expression: str, scope: dict):
    """Evaluate a calc expression referencing field *keys* in ``scope``
    (e.g. ``total_days * daily_rate``, or ``IF(status=="Approved","OK","")``).
    Never raises — any parse or evaluation error resolves to 0 so a bad
    formula can't break document generation.

    ``scope`` here is a plain value dict passed through as-is (values may
    already be str or number); callers with field-type information
    (``compute_calculated_values`` below) should build a properly-coerced
    scope themselves via ``_coerce_scope_value`` for correct string-vs-number
    behavior — this generic entry point just uses whatever's already there."""
    if not expression or not isinstance(expression, str):
        return 0
    try:
        tokens = _calc_tokenize(expression)
        return _CalcParser(tokens, dict(scope or {})).parse()
    except (CalcError, ZeroDivisionError, IndexError):
        return 0


def _eval_typed(expression: str, scope: dict):
    """Run the parser against an already-coerced scope (see
    ``_coerce_scope_value``) without re-coercing it. Never raises."""
    if not expression or not isinstance(expression, str):
        return 0
    try:
        tokens = _calc_tokenize(expression)
        return _CalcParser(tokens, scope).parse()
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
            _coerce_numeric(col_type, (row or {}).get(col_key))
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
                calc_columns = table_info["calc_columns"]

                # Same rationale as the client (calculations.ts evaluateTableColumnFormulas):
                # resolve in multiple full passes so a calc column can reference another
                # calc column regardless of declaration order in the table. Bounded by
                # len(calc_columns) so a circular formula just stops changing.
                for _pass in range(len(calc_columns)):
                    changed = False
                    for col in calc_columns:
                        col_key = col["key"]
                        calc = col["calc"]
                        decimals = calc.get("decimals")
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
                            if isinstance(decimals, int) and isinstance(result, (int, float)):
                                result = round(result, decimals)
                            if row.get(col_key) != result:
                                changed = True
                            row[col_key] = result
                    if not changed:
                        break
                continue
            calc = field.get("calc")
            if not calc:
                continue
            result = _eval_typed(calc.get("expression", ""), top_scope)
            decimals = calc.get("decimals")
            if isinstance(decimals, int) and isinstance(result, (int, float)):
                result = round(result, decimals)
            out[key] = result
            top_scope[key] = result

    return out
