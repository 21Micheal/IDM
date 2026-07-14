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
        if (name.toUpperCase() === "IF") {
          const cond = this.comparison();
          let sep = this.next();
          if (!sep || sep.t !== "op" || sep.v !== ",") throw new Error("IF expects 3 arguments: IF(condition, if_true, if_false)");
          const trueVal = this.comparison();
          sep = this.next();
          if (!sep || sep.t !== "op" || sep.v !== ",") throw new Error("IF expects 3 arguments: IF(condition, if_true, if_false)");
          const falseVal = this.comparison();
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
      return this.scope[name] ?? 0;
    }
    throw new Error("Unexpected token");
  }
}

const TEXT_CALC_TYPES = new Set([
  "text", "textarea", "email", "phone", "select", "radio", "multi_select",
  "reference", "user", "url", "calc_text", "auto_number",
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
  if (fieldType === "boolean" || fieldType === "checkbox") return raw ? 1 : 0;
  const n = typeof raw === "number" ? raw : parseFloat(String(raw));
  return Number.isFinite(n) ? n : 0;
}

function coerceScopeValue(fieldType: string | undefined, raw: unknown): CalcValue {
  if (fieldType && TEXT_CALC_TYPES.has(fieldType)) return raw === null || raw === undefined ? "" : String(raw);
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
}

export interface TemplateField {
  key?: string;
  id?: string;
  type?: string;
}

export function buildCalcScope(allFields: TemplateField[], values: Record<string, unknown>): Record<string, CalcValue> {
  const scope: Record<string, CalcValue> = {};
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

export function resolveRowAggregates(
  expression: string,
  rows: Record<string, string>[],
  colTypeByKey: Record<string, string | undefined>,
): string {
  if (!expression || !expression.includes("(")) return expression;
  return expression.replace(AGG_CALL_RE, (_match, func: string, firstIdent: string, secondIdent: string | undefined) => {
    const targetColType = colTypeByKey[firstIdent];
    const colKey = firstIdent;
    const colValues = rows.map((r) => coerceNumeric(targetColType, r[colKey]));
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