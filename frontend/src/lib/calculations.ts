/**
 * Client-side calculation engine for table column formulas.
 * Mirrors the server-side evaluator in apps/templates_engine/conditions.py
 */

export type CalcValue = number | string;

type CalcToken =
  | { t: "num"; v: number }
  | { t: "str"; v: string }
  | { t: "ident"; v: string }
  | { t: "op"; v: string };

function calcTokenize(expr: string): CalcToken[] {
  const re = /\s*(?:(\d+\.\d+|\d+)|("(?:[^"\\]|\\.)*")|([A-Za-z_][A-Za-z0-9_]*)|(>=|<=|==|!=)|([+\-*/(),><]))/y;
  const tokens: CalcToken[] = [];
  let pos = 0;
  while (pos < expr.length) {
    re.lastIndex = pos;
    const m = re.exec(expr);
    if (!m || m[0].length === 0) {
      if (/\s/.test(expr[pos])) { pos += 1; continue; }
      throw new Error(`Unexpected character at ${pos}`);
    }
    pos = re.lastIndex;
    if (m[1] !== undefined) tokens.push({ t: "num", v: parseFloat(m[1]) });
    else if (m[2] !== undefined) tokens.push({ t: "str", v: m[2].slice(1, -1).replace(/\\"/g, "\"").replace(/\\\\/g, "\\") });
    else if (m[3] !== undefined) tokens.push({ t: "ident", v: m[3] });
    else if (m[4] !== undefined) tokens.push({ t: "op", v: m[4] });
    else if (m[5] !== undefined) tokens.push({ t: "op", v: m[5] });
  }
  return tokens;
}

function toNumber(value: CalcValue | undefined): number {
  if (typeof value === "number") return value;
  if (typeof value === "string") { const n = parseFloat(value); return Number.isFinite(n) ? n : 0; }
  return 0;
}

function isTruthy(value: CalcValue | undefined): boolean {
  if (typeof value === "string") return value.trim() !== "";
  return toNumber(value) !== 0;
}

const CALC_FUNCS: Record<string, (...args: CalcValue[]) => number> = {
  ROUND: (a, n = 0) => { const f = Math.pow(10, Math.trunc(toNumber(n))); return Math.round(toNumber(a) * f) / f; },
  ABS: (a) => Math.abs(toNumber(a)),
  MIN: (...a) => Math.min(...a.map(toNumber)),
  MAX: (...a) => Math.max(...a.map(toNumber)),
};

class CalcParser {
  private i = 0;
  constructor(private tokens: CalcToken[], private scope: Record<string, CalcValue>) {}
  private peek() { return this.tokens[this.i]; }
  private next() { return this.tokens[this.i++]; }

  parse(): CalcValue {
    const v = this.comparison();
    if (this.peek() !== undefined) throw new Error("Unexpected trailing input");
    return v;
  }

  private comparison(): CalcValue {
    const left = this.arith();
    const t = this.peek();
    if (t?.t === "op" && [">", "<", ">=", "<=", "==", "!="].includes(t.v)) {
      const op = this.next() as { t: "op"; v: string };
      const right = this.arith();
      if (op.v === "==" || op.v === "!=") {
        const equal = (typeof left === "string" || typeof right === "string")
          ? String(left) === String(right)
          : toNumber(left) === toNumber(right);
        return (op.v === "==" ? equal : !equal) ? 1 : 0;
      }
      const ln = toNumber(left), rn = toNumber(right);
      if (op.v === ">") return ln > rn ? 1 : 0;
      if (op.v === "<") return ln < rn ? 1 : 0;
      if (op.v === ">=") return ln >= rn ? 1 : 0;
      return ln <= rn ? 1 : 0;
    }
    return left;
  }

  // Like comparison() but preserves string values instead of converting to numbers.
  // Used for IF() true/false branches to allow string results like "OK" or error messages.
  private ternaryExpr(): CalcValue {
    const left = this.valueExpr();
    const t = this.peek();
    if (t?.t === "op" && [">", "<", ">=", "<=", "==", "!="].includes(t.v)) {
      const op = this.next() as { t: "op"; v: string };
      const right = this.valueExpr();
      if (op.v === "==" || op.v === "!=") {
        const equal = (typeof left === "string" || typeof right === "string")
          ? String(left) === String(right)
          : toNumber(left) === toNumber(right);
        return (op.v === "==" ? equal : !equal) ? 1 : 0;
      }
      const ln = toNumber(left), rn = toNumber(right);
      if (op.v === ">") return ln > rn ? 1 : 0;
      if (op.v === "<") return ln < rn ? 1 : 0;
      if (op.v === ">=") return ln >= rn ? 1 : 0;
      return ln <= rn ? 1 : 0;
    }
    return left;
  }

  // Value expression that returns atoms (strings, numbers, identifiers) without
  // forcing arithmetic operations. Used for IF() branches to preserve string values.
  private valueExpr(): CalcValue {
    const t = this.peek();
    // Handle parentheses
    if (t?.t === "op" && t.v === "(") {
      this.next();
      const result = this.ternaryExpr();
      const close = this.next();
      if (!close || close.t !== "op" || close.v !== ")") throw new Error("Expected ')'");
      return result;
    }
    // Fall back to atom for simple values (strings, numbers, identifiers)
    return this.atom();
  }

  private arith(): CalcValue {
    let v: CalcValue = this.term();
    while (this.peek()?.t === "op" && ((this.peek() as any).v === "+" || (this.peek() as any).v === "-")) {
      const op = (this.next() as any).v;
      const rhs = this.term();
      v = op === "+" ? toNumber(v) + toNumber(rhs) : toNumber(v) - toNumber(rhs);
    }
    return v;
  }

  private term(): CalcValue {
    let v: CalcValue = this.factor();
    while (this.peek()?.t === "op" && ((this.peek() as any).v === "*" || (this.peek() as any).v === "/")) {
      const op = (this.next() as any).v;
      const rhs = this.factor();
      const rn = toNumber(rhs);
      v = op === "*" ? toNumber(v) * rn : (rn ? toNumber(v) / rn : 0);
    }
    return v;
  }

  private factor(): CalcValue {
    const t = this.peek();
    if (t?.t === "op" && t.v === "-") { this.next(); return -toNumber(this.factor()); }
    if (t?.t === "op" && t.v === "+") { this.next(); return toNumber(this.factor()); }
    return this.atom();
  }

  private atom(): CalcValue {
    const t = this.next();
    if (!t) throw new Error("Unexpected end of expression");
    if (t.t === "num") return t.v;
    if (t.t === "str") return t.v;
    if (t.t === "op" && t.v === "(") {
      const v = this.comparison();
      const close = this.next();
      if (!close || close.t !== "op" || close.v !== ")") throw new Error("Expected ')'");
      return v;
    }
    if (t.t === "ident") {
      const name = t.v;
      const nxt = this.peek();
      if (nxt?.t === "op" && nxt.v === "(") {
        this.next();
        return this.parseFunctionCall(name);
      }
      return this.scope[name] ?? 0;
    }
    throw new Error("Unexpected token");
  }

  // Handle function calls separately from atom to avoid circular dependency
  private parseFunctionCall(name: string): CalcValue {
    if (name.toUpperCase() === "IF") {
      const cond = this.comparison();
      let sep = this.next();
      if (!sep || sep.t !== "op" || sep.v !== ",") throw new Error("IF expects 3 arguments: IF(condition, if_true, if_false)");
      const trueVal = this.valueExpr();
      sep = this.next();
      if (!sep || sep.t !== "op" || sep.v !== ",") throw new Error("IF expects 3 arguments: IF(condition, if_true, if_false)");
      const falseVal = this.valueExpr();
      const close = this.next();
      if (!close || close.t !== "op" || close.v !== ")") throw new Error("Expected ')'");
      return isTruthy(cond) ? trueVal : falseVal;
    }
    const args: CalcValue[] = [];
    if (!(this.peek()?.t === "op" && (this.peek() as any).v === ")")) {
      args.push(this.comparison());
      while (this.peek()?.t === "op" && (this.peek() as any).v === ",") { this.next(); args.push(this.comparison()); }
    }
    const close = this.next();
    if (!close || close.t !== "op" || close.v !== ")") throw new Error("Expected ')'");
    const fn = CALC_FUNCS[name.toUpperCase()];
    if (!fn) throw new Error(`Unknown function ${name}`);
    return fn(...args);
  }
}

const TEXT_CALC_TYPES = new Set([
  "text", "textarea", "email", "phone", "select", "radio", "multi_select",
  "reference", "user", "url", "calc_text", "auto_number",
]);

const BOOLEAN_CALC_TYPES = new Set([
  "boolean", "checkbox", "calc_boolean",
]);

const NUMERIC_CALC_TYPES = new Set([
  "number", "currency", "percentage", "rating",
  "calc_number", "calc_currency",
]);

function coerceNumeric(fieldType: string | undefined, raw: unknown): number {
  if (raw === null || raw === undefined || raw === "") return 0;
  if (fieldType === "date" || fieldType === "datetime" || fieldType === "calc_date") {
    const d = new Date(String(raw));
    if (Number.isNaN(d.getTime())) return 0;
    return Math.floor(d.getTime() / 86400000);
  }
  if (fieldType === "time") {
    const [hStr, mStr] = String(raw).split(":");
    const h = parseInt(hStr, 10), m = parseInt(mStr, 10);
    return (Number.isFinite(h) ? h : 0) * 60 + (Number.isFinite(m) ? m : 0);
  }
  if (fieldType === "boolean" || fieldType === "checkbox" || fieldType === "calc_boolean") {
    // Handle calc_boolean like the builder: "yes", "true", "1" are truthy
    if (typeof raw === "string") {
      return ["yes", "true", "1"].includes(raw.trim().toLowerCase()) ? 1 : 0;
    }
    return raw ? 1 : 0;
  }
  // For currency and other numeric types, strip currency symbols and commas before parsing
  if (fieldType === "currency" || fieldType === "calc_currency" || NUMERIC_CALC_TYPES.has(fieldType || "")) {
    if (typeof raw === "string") {
      // Remove currency symbols, commas, and whitespace
      const cleaned = raw.replace(/[^0-9.\-]/g, "");
      const n = parseFloat(cleaned);
      return Number.isFinite(n) ? n : 0;
    }
  }
  const n = typeof raw === "number" ? raw : parseFloat(String(raw));
  return Number.isFinite(n) ? n : 0;
}

function coerceScopeValue(fieldType: string | undefined, raw: unknown): CalcValue {
  if (fieldType && TEXT_CALC_TYPES.has(fieldType)) return raw === null || raw === undefined ? "" : String(raw);
  if (fieldType && BOOLEAN_CALC_TYPES.has(fieldType)) return coerceNumeric(fieldType, raw);
  return coerceNumeric(fieldType, raw);
}

export function evaluateCalcExpression(expression: string | undefined, scope: Record<string, CalcValue>): CalcValue {
  if (!expression || !expression.trim()) return 0;
  try {
    return new CalcParser(calcTokenize(expression), scope).parse();
  } catch {
    return 0;
  }
}

export interface TableColumn {
  key?: string;
  type?: string;
  calc?: { expression?: string; decimals?: number };
}

export interface TemplateField {
  key?: string;
  id?: string;
  type?: string;
}

export function buildCalcScope(
  allFields: TemplateField[],
  values: Record<string, unknown>,
  registry?: Record<string, RowAggregateRegistryEntry>,
): Record<string, CalcValue> {
  const scope: Record<string, CalcValue> = registry ? firstRowScopeEntries(registry) : {};
  for (const f of allFields) {
    if (!f.key) continue;
    // Values here are keyed by the field's KEY (see TemplateForm.tsx — every
    // Controller/onChange call uses `field.key`, and this is what the server's
    // compute_calculated_values reads too). This module previously indexed by
    // `f.id`, which is never how values are stored outside the builder's own
    // Preview (which id-keys via react-hook-form register(field.id, ...) and
    // keeps its own separate calc engine for that reason) — that mismatch
   // silently zeroed out every top-level sibling reference in real forms,
    // e.g. a table column formula like `= daily_subsistence_allowance`.
    scope[f.key] = coerceScopeValue(f.type, values[f.key]);
  }
  return scope;
}

export function buildRowCalcScope(
  allFields: TemplateField[],
  values: Record<string, unknown>,
  columns: TableColumn[],
  row: Record<string, string>,
): Record<string, CalcValue> {
  const scope = buildCalcScope(allFields, values);
  const colTypeByKey: Record<string, string | undefined> = {};
  columns.forEach((c) => { if (c.key) colTypeByKey[c.key] = c.type; });
  for (const [k, v] of Object.entries(row)) {
    scope[k] = coerceScopeValue(colTypeByKey[k], v);
  }
  return scope;
}

const AGG_CALL_RE = /\b(SUM|AVG|COUNT|COLMIN|COLMAX)\(\s*([A-Za-z_][A-Za-z0-9_]*)(?:\.([A-Za-z_][A-Za-z0-9_]*))?\s*\)/gi;

type RowAggregateRegistryEntry = {
  rows: Record<string, unknown>[];
  colTypeByKey: Record<string, string | undefined>;
};

/** Build the { bareColKey / "table.col": value } fallback entries derived
 *  from each table's FIRST row — see buildCalcScope's docstring. Bare keys
 *  follow "first table wins" when more than one table has a same-named
 *  column; dotted keys are always unambiguous. */
function firstRowScopeEntries(registry: Record<string, RowAggregateRegistryEntry>): Record<string, CalcValue> {
  const scope: Record<string, CalcValue> = {};
  for (const [tableKey, entry] of Object.entries(registry)) {
    const firstRow = entry.rows[0] ?? {};
    for (const [colKey, colType] of Object.entries(entry.colTypeByKey)) {
      const value = coerceScopeValue(colType, firstRow[colKey]);
      if (!(colKey in scope)) scope[colKey] = value; // first table wins
      scope[`${tableKey}.${colKey}`] = value;
    }
  }
  return scope;
}

export function resolveRowAggregates(
  expression: string,
  rows: Record<string, unknown>[],
  colTypeByKey: Record<string, string | undefined>,
  allTables?: Record<string, RowAggregateRegistryEntry>,
): string {
  if (!expression || !expression.includes("(")) return expression;
  return expression.replace(AGG_CALL_RE, (_match, func: string, firstIdent: string, secondIdent: string | undefined) => {
    const targetRows = secondIdent
      ? (allTables?.[firstIdent]?.rows ?? [])
      : rows;
    const targetColTypes = secondIdent
      ? (allTables?.[firstIdent]?.colTypeByKey ?? {})
      : colTypeByKey;
    const colKey = secondIdent ?? firstIdent;
    const targetColType = targetColTypes[colKey];
    const colValues = targetRows.map((r) => coerceNumeric(targetColType, r[colKey]));
    let result = 0;
    switch (func.toUpperCase()) {
      case "SUM": result = colValues.reduce((a, b) => a + b, 0); break;
      case "AVG": result = colValues.length ? colValues.reduce((a, b) => a + b, 0) / colValues.length : 0; break;
      case "COUNT": result = colValues.length; break;
      case "COLMIN": result = colValues.length ? Math.min(...colValues) : 0; break;
      case "COLMAX": result = colValues.length ? Math.max(...colValues) : 0; break;
    }
    return String(result);
  });
}

export function evaluateTableColumnFormulas(
  columns: TableColumn[],
  rows: Record<string, unknown>[],
  allFields: TemplateField[],
  values: Record<string, unknown>,
  allTables?: Record<string, RowAggregateRegistryEntry>,
): Record<string, unknown>[] {
  const colTypesByKey: Record<string, string | undefined> = {};
  columns.forEach((column) => {
    if (column.key) colTypesByKey[column.key] = column.type;
  });

  const calcColumns = columns.filter((column) => Boolean(column.key) && Boolean(column.calc?.expression));
  if (calcColumns.length === 0) return rows.map((r) => ({ ...r }));

  let computedRows: Record<string, unknown>[] = rows.map((row) => ({ ...row }));

  // Multiple full passes let a calc column reference ANOTHER calc column
  // regardless of which one is declared first in the table — e.g.
  // "Expenditure Check" referencing "DSA Amount" even though DSA Amount is
  // a later column. A single row-major pass only ever sees calc columns
  // that happen to come earlier in the array; each further pass lets a
  // later-declared column's just-resolved value propagate back to an
  // earlier one. Bounded by calcColumns.length — enough passes to settle
  // any acyclic dependency chain however it's ordered — so a genuinely
  // circular formula (A references B references A) just stops changing
  // rather than looping forever.
  for (let pass = 0; pass < calcColumns.length; pass++) {
    let changed = false;
    computedRows = computedRows.map((row) => {
      const computedRow: Record<string, unknown> = { ...row };
      for (const column of calcColumns) {
        const colKey = column.key!;
        try {
          const scope = buildRowCalcScope(allFields, values, columns, computedRow as Record<string, string>);
          const resolvedExpr = resolveRowAggregates(
            column.calc!.expression!,
            computedRows as Record<string, string>[],
            colTypesByKey,
            allTables,
          );
          let result = evaluateCalcExpression(resolvedExpr, scope);
          if (typeof result === "number" && typeof column.calc?.decimals === "number") {
            result = Number(result.toFixed(column.calc.decimals));
          }
          const str = String(result);
          if (computedRow[colKey] !== str) changed = true;
          computedRow[colKey] = str;
        } catch {
          // Preserve existing value on calculation failure instead of clearing it.
        }
      }
      return computedRow;
    });
    if (!changed) break;
  }

  return computedRows;
}