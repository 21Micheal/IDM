/**
 * Client-side calculation engine for form formulas (top-level calc fields and
 * table column formulas). Mirrors the server-side evaluator in
 * apps/templates_engine/conditions.py and the builder's own preview engine in
 * TemplateBuilderV2.tsx, so a formula the builder marks "Valid" evaluates the
 * same way while a user is filling the form.
 *
 * Differences from the builder's copy are deliberate:
 *  - scopes are keyed by field KEY (the builder Preview keys by field id);
 *  - coerceNumeric strips currency symbols / thousands separators;
 *  - an unknown identifier resolves to 0 instead of failing the whole formula.
 */

export type CalcValue = number | string;

type CalcToken =
  | { t: "num"; v: number }
  | { t: "str"; v: string }
  | { t: "ident"; v: string }
  | { t: "op"; v: string };

function calcTokenize(expr: string): CalcToken[] {
  const re = /\s*(?:(\d+\.\d+|\d+)|("(?:[^"\\]|\\.)*")|('(?:[^'\\]|\\.)*')|([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)?)|(>=|<=|==|!=|<>)|([+\-*/%^&(),><]))/y;
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
    else if (m[3] !== undefined) tokens.push({ t: "str", v: m[3].slice(1, -1).replace(/\\'/g, "'").replace(/\\\\/g, "\\") });
    else if (m[4] !== undefined) tokens.push({ t: "ident", v: m[4] });
    else if (m[5] !== undefined) tokens.push({ t: "op", v: m[5] === "<>" ? "!=" : m[5] });
    else if (m[6] !== undefined) tokens.push({ t: "op", v: m[6] });
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

/* ── Value helpers ────────────────────────────────────────────────────────
 * Dates travel through the engine as a DAY SERIAL (days since 1970-01-01 UTC)
 * and times as MINUTES SINCE MIDNIGHT, so date/time arithmetic is plain
 * arithmetic (see coerceNumeric). */
const MS_PER_DAY = 86400000;

function calcText(v: CalcValue | undefined): string {
  if (v === undefined || v === null) return "";
  if (typeof v === "number") {
    if (!Number.isFinite(v)) return "";
    return Number.isInteger(v) ? String(v) : String(parseFloat(v.toFixed(10)));
  }
  return String(v);
}

const pad2 = (n: number) => String(Math.abs(Math.trunc(n))).padStart(2, "0");

function serialToDate(serial: CalcValue | undefined): Date {
  return new Date(Math.round(toNumber(serial) * MS_PER_DAY));
}
function dateToSerial(d: Date): number { return Math.floor(d.getTime() / MS_PER_DAY); }

function formatSerial(serial: CalcValue | undefined, fmt: CalcValue = "YYYY-MM-DD"): string {
  const d = serialToDate(serial);
  if (Number.isNaN(d.getTime())) return "";
  return calcText(fmt || "YYYY-MM-DD")
    .replace(/YYYY/g, String(d.getUTCFullYear()))
    .replace(/MM/g, pad2(d.getUTCMonth() + 1))
    .replace(/DD/g, pad2(d.getUTCDate()))
    .replace(/HH/g, pad2(d.getUTCHours()))
    .replace(/mm/g, pad2(d.getUTCMinutes()))
    .replace(/ss/g, pad2(d.getUTCSeconds()));
}

function addMonthsSerial(serial: CalcValue, months: CalcValue): number {
  const d = serialToDate(serial);
  if (Number.isNaN(d.getTime())) return 0;
  const day = d.getUTCDate();
  const target = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + Math.trunc(toNumber(months)), 1));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(day, lastDay));
  return dateToSerial(target);
}

function networkDays(a: CalcValue, b: CalcValue): number {
  let start = Math.round(toNumber(a));
  let end = Math.round(toNumber(b));
  const sign = end < start ? -1 : 1;
  if (sign < 0) { const t = start; start = end; end = t; }
  const span = Math.min(end - start, 20000);
  let count = 0;
  for (let i = 0; i < span; i += 1) {
    const dow = new Date((start + i) * MS_PER_DAY).getUTCDay();
    if (dow !== 0 && dow !== 6) count += 1;
  }
  return count * sign;
}

/* Pure, total function library — a bad argument yields 0 or "" rather than
 * throwing. Kept identical to CALC_FUNCS in TemplateBuilderV2.tsx. */
const CALC_FUNCS: Record<string, (...args: CalcValue[]) => CalcValue> = {
  // Maths
  ROUND: (a, n = 0) => { const f = Math.pow(10, Math.trunc(toNumber(n))); return Math.round(toNumber(a) * f) / f; },
  ROUNDUP: (a, n = 0) => { const f = Math.pow(10, Math.trunc(toNumber(n))); return Math.ceil(toNumber(a) * f) / f; },
  ROUNDDOWN: (a, n = 0) => { const f = Math.pow(10, Math.trunc(toNumber(n))); return Math.floor(toNumber(a) * f) / f; },
  CEIL: (a) => Math.ceil(toNumber(a)),
  CEILING: (a) => Math.ceil(toNumber(a)),
  FLOOR: (a) => Math.floor(toNumber(a)),
  INT: (a) => Math.trunc(toNumber(a)),
  TRUNC: (a) => Math.trunc(toNumber(a)),
  ABS: (a) => Math.abs(toNumber(a)),
  SIGN: (a) => Math.sign(toNumber(a)),
  SQRT: (a) => { const n = toNumber(a); return n < 0 ? 0 : Math.sqrt(n); },
  POWER: (a, b) => { const r = Math.pow(toNumber(a), toNumber(b)); return Number.isFinite(r) ? r : 0; },
  MOD: (a, b) => { const d = toNumber(b); return d === 0 ? 0 : toNumber(a) % d; },
  MIN: (...a) => (a.length ? Math.min(...a.map(toNumber)) : 0),
  MAX: (...a) => (a.length ? Math.max(...a.map(toNumber)) : 0),
  AVERAGE: (...a) => (a.length ? a.reduce<number>((s, x) => s + toNumber(x), 0) / a.length : 0),
  SUMARGS: (...a) => a.reduce<number>((s, x) => s + toNumber(x), 0),
  CLAMP: (v, lo, hi) => Math.min(Math.max(toNumber(v), toNumber(lo)), toNumber(hi)),
  PERCENT: (part, whole) => { const w = toNumber(whole); return w === 0 ? 0 : (toNumber(part) / w) * 100; },
  APPLYRATE: (amount, ratePct) => (toNumber(amount) * toNumber(ratePct)) / 100,
  GROSS: (amount, ratePct) => toNumber(amount) * (1 + toNumber(ratePct) / 100),
  NET: (gross, ratePct) => toNumber(gross) / (1 + toNumber(ratePct) / 100),

  // Logic
  AND: (...a) => (a.length > 0 && a.every(isTruthy) ? 1 : 0),
  OR: (...a) => (a.some(isTruthy) ? 1 : 0),
  NOT: (a) => (isTruthy(a) ? 0 : 1),
  XOR: (...a) => (a.filter(isTruthy).length % 2 === 1 ? 1 : 0),
  TRUE: () => 1,
  FALSE: () => 0,
  ISBLANK: (a) => (calcText(a).trim() === "" || toNumber(a) === 0 && calcText(a) === "" ? 1 : 0),
  ISNUMBER: (a) => (typeof a === "number" || (calcText(a).trim() !== "" && Number.isFinite(parseFloat(calcText(a)))) ? 1 : 0),
  COALESCE: (...a) => a.find((v) => calcText(v).trim() !== "") ?? "",
  IFS: (...a) => {
    for (let i = 0; i + 1 < a.length; i += 2) if (isTruthy(a[i])) return a[i + 1];
    return a.length % 2 === 1 ? a[a.length - 1] : "";
  },
  SWITCH: (...a) => {
    const subject = calcText(a[0]);
    for (let i = 1; i + 1 < a.length; i += 2) if (calcText(a[i]) === subject) return a[i + 1];
    return (a.length - 1) % 2 === 1 ? a[a.length - 1] : "";
  },

  // Text
  CONCAT: (...a) => a.map(calcText).join(""),
  CONCATENATE: (...a) => a.map(calcText).join(""),
  JOIN: (sep, ...a) => a.map(calcText).filter((s) => s !== "").join(calcText(sep)),
  TEXT: (v, decimals) => (decimals === undefined ? calcText(v) : toNumber(v).toFixed(Math.max(0, Math.trunc(toNumber(decimals))))),
  VALUE: (v) => toNumber(v),
  UPPER: (v) => calcText(v).toUpperCase(),
  LOWER: (v) => calcText(v).toLowerCase(),
  PROPER: (v) => calcText(v).replace(/\w\S*/g, (w) => w[0].toUpperCase() + w.slice(1).toLowerCase()),
  TRIM: (v) => calcText(v).trim(),
  LEN: (v) => calcText(v).length,
  LEFT: (v, n) => calcText(v).slice(0, Math.max(0, Math.trunc(toNumber(n)))),
  RIGHT: (v, n) => { const k = Math.max(0, Math.trunc(toNumber(n))); return k === 0 ? "" : calcText(v).slice(-k); },
  MID: (v, start, len) => calcText(v).slice(Math.max(0, Math.trunc(toNumber(start)) - 1), Math.max(0, Math.trunc(toNumber(start)) - 1 + Math.max(0, Math.trunc(toNumber(len))))),
  FIND: (needle, hay) => calcText(hay).indexOf(calcText(needle)) + 1,
  CONTAINS: (hay, needle) => (calcText(hay).toLowerCase().includes(calcText(needle).toLowerCase()) ? 1 : 0),
  STARTSWITH: (hay, needle) => (calcText(hay).toLowerCase().startsWith(calcText(needle).toLowerCase()) ? 1 : 0),
  ENDSWITH: (hay, needle) => (calcText(hay).toLowerCase().endsWith(calcText(needle).toLowerCase()) ? 1 : 0),
  SUBSTITUTE: (v, find, repl) => calcText(v).split(calcText(find)).join(calcText(repl)),
  REPLACE: (v, find, repl) => calcText(v).split(calcText(find)).join(calcText(repl)),
  PADLEFT: (v, width, ch = "0") => calcText(v).padStart(Math.max(0, Math.trunc(toNumber(width))), calcText(ch) || "0"),
  PADRIGHT: (v, width, ch = " ") => calcText(v).padEnd(Math.max(0, Math.trunc(toNumber(width))), calcText(ch) || " "),
  SPLIT: (v, sep, idx) => calcText(v).split(calcText(sep))[Math.max(1, Math.trunc(toNumber(idx))) - 1] ?? "",

  // Dates & times
  TODAY: () => dateToSerial(new Date()),
  NOW: () => Date.now() / MS_PER_DAY,
  DATE: (y, m, d) => dateToSerial(new Date(Date.UTC(Math.trunc(toNumber(y)), Math.trunc(toNumber(m)) - 1, Math.trunc(toNumber(d))))),
  YEAR: (s) => serialToDate(s).getUTCFullYear(),
  MONTH: (s) => serialToDate(s).getUTCMonth() + 1,
  DAY: (s) => serialToDate(s).getUTCDate(),
  WEEKDAY: (s) => serialToDate(s).getUTCDay() + 1,
  ISWEEKEND: (s) => { const d = serialToDate(s).getUTCDay(); return d === 0 || d === 6 ? 1 : 0; },
  DAYS: (end, start) => Math.round(toNumber(end) - toNumber(start)),
  NETWORKDAYS: (start, end) => networkDays(start, end),
  ADDDAYS: (s, n) => Math.round(toNumber(s)) + Math.trunc(toNumber(n)),
  ADDMONTHS: (s, n) => addMonthsSerial(s, n),
  ADDYEARS: (s, n) => addMonthsSerial(s, toNumber(n) * 12),
  EOMONTH: (s, n = 0) => {
    const d = serialToDate(addMonthsSerial(s, n));
    return dateToSerial(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)));
  },
  DATEDIF: (start, end, unit = "d") => {
    const a = serialToDate(start), b = serialToDate(end);
    const u = calcText(unit).toLowerCase();
    if (u === "y") {
      let years = b.getUTCFullYear() - a.getUTCFullYear();
      if (b.getUTCMonth() < a.getUTCMonth() || (b.getUTCMonth() === a.getUTCMonth() && b.getUTCDate() < a.getUTCDate())) years -= 1;
      return years;
    }
    if (u === "m") {
      let months = (b.getUTCFullYear() - a.getUTCFullYear()) * 12 + (b.getUTCMonth() - a.getUTCMonth());
      if (b.getUTCDate() < a.getUTCDate()) months -= 1;
      return months;
    }
    return Math.round(toNumber(end) - toNumber(start));
  },
  FORMATDATE: (s, fmt = "YYYY-MM-DD") => formatSerial(s, fmt),
  HOUR: (t) => Math.floor(toNumber(t) / 60),
  MINUTE: (t) => Math.round(toNumber(t) % 60),
  FORMATTIME: (t) => `${pad2(Math.floor(toNumber(t) / 60))}:${pad2(Math.round(toNumber(t) % 60))}`,
  HOURSBETWEEN: (a, b) => (toNumber(b) - toNumber(a)) / 60,
};

class CalcParser {
  private i = 0;
  constructor(private tokens: CalcToken[], private scope: Record<string, CalcValue>) {}
  private peek() { return this.tokens[this.i]; }
  private next() { return this.tokens[this.i++]; }
  private isOp(v: string) { const t = this.peek(); return t?.t === "op" && t.v === v; }

  parse(): CalcValue {
    const v = this.comparison();
    if (this.peek() !== undefined) throw new Error("Unexpected trailing input");
    return v;
  }

  private comparison(): CalcValue {
    const left = this.concat();
    const t = this.peek();
    if (t?.t === "op" && [">", "<", ">=", "<=", "==", "!="].includes(t.v)) {
      const op = this.next() as { t: "op"; v: string };
      const right = this.concat();
      if (op.v === "==" || op.v === "!=") {
        const equal = (typeof left === "string" || typeof right === "string")
          ? String(left) === String(right)
          : toNumber(left) === toNumber(right);
        return (op.v === "==" ? equal : !equal) ? 1 : 0;
      }
      if (typeof left === "string" && typeof right === "string") {
        const c = left.localeCompare(right);
        if (op.v === ">") return c > 0 ? 1 : 0;
        if (op.v === "<") return c < 0 ? 1 : 0;
        if (op.v === ">=") return c >= 0 ? 1 : 0;
        return c <= 0 ? 1 : 0;
      }
      const ln = toNumber(left), rn = toNumber(right);
      if (op.v === ">") return ln > rn ? 1 : 0;
      if (op.v === "<") return ln < rn ? 1 : 0;
      if (op.v === ">=") return ln >= rn ? 1 : 0;
      return ln <= rn ? 1 : 0;
    }
    return left;
  }

  /** `a & b` — string concatenation, looser than arithmetic. */
  private concat(): CalcValue {
    let v: CalcValue = this.arith();
    while (this.isOp("&")) {
      this.next();
      v = calcText(v) + calcText(this.arith());
    }
    return v;
  }

  private arith(): CalcValue {
    let v: CalcValue = this.term();
    while (this.isOp("+") || this.isOp("-")) {
      const op = (this.next() as { v: string }).v;
      const rhs = this.term();
      v = op === "+" ? toNumber(v) + toNumber(rhs) : toNumber(v) - toNumber(rhs);
    }
    return v;
  }

  private term(): CalcValue {
    let v: CalcValue = this.factor();
    while (this.isOp("*") || this.isOp("/") || this.isOp("%")) {
      const op = (this.next() as { v: string }).v;
      const rn = toNumber(this.factor());
      if (op === "*") v = toNumber(v) * rn;
      else v = rn ? (op === "/" ? toNumber(v) / rn : toNumber(v) % rn) : 0;
    }
    return v;
  }

  private factor(): CalcValue {
    if (this.isOp("-")) { this.next(); return -toNumber(this.factor()); }
    if (this.isOp("+")) { this.next(); return toNumber(this.factor()); }
    return this.power();
  }

  /** `a ^ b` — right-associative, tighter than * and /. */
  private power(): CalcValue {
    const base = this.atom();
    if (this.isOp("^")) {
      this.next();
      const r = Math.pow(toNumber(base), toNumber(this.factor()));
      return Number.isFinite(r) ? r : 0;
    }
    return base;
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
      if (this.isOp("(")) {
        this.next();
        return this.parseFunctionCall(t.v);
      }
      return this.scope[t.v] ?? 0;
    }
    throw new Error("Unexpected token");
  }

  private parseFunctionCall(name: string): CalcValue {
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
    if (!this.isOp(")")) {
      args.push(this.comparison());
      while (this.isOp(",")) { this.next(); args.push(this.comparison()); }
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

const NUMERIC_CALC_TYPES = new Set([
  "number", "currency", "percentage", "rating",
  "calc_number", "calc_currency",
]);

function coerceNumeric(fieldType: string | undefined, raw: unknown): number {
  if (raw === null || raw === undefined || raw === "") return 0;
  if (fieldType === "date" || fieldType === "datetime" || fieldType === "calc_date") {
    const d = new Date(String(raw));
    if (Number.isNaN(d.getTime())) return 0;
    return Math.floor(d.getTime() / MS_PER_DAY);
  }
  if (fieldType === "time") {
    const [hStr, mStr] = String(raw).split(":");
    const h = parseInt(hStr, 10), m = parseInt(mStr, 10);
    return (Number.isFinite(h) ? h : 0) * 60 + (Number.isFinite(m) ? m : 0);
  }
  if (fieldType === "boolean" || fieldType === "checkbox" || fieldType === "calc_boolean") {
    if (typeof raw === "string") {
      return ["yes", "true", "1"].includes(raw.trim().toLowerCase()) ? 1 : 0;
    }
    return raw ? 1 : 0;
  }
  if (NUMERIC_CALC_TYPES.has(fieldType || "")) {
    if (typeof raw === "string") {
      const n = parseFloat(raw.replace(/[^0-9.\-]/g, ""));
      return Number.isFinite(n) ? n : 0;
    }
  }
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

/** A calc_date field's formula yields a day serial — store/display it as an ISO
 *  date. Other types pass through unchanged. */
export function formatCalcResult(fieldType: string | undefined, result: CalcValue): CalcValue {
  if (fieldType === "calc_date") return typeof result === "number" ? formatSerial(result) : result;
  return result;
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

export type RowAggregateRegistryEntry = {
  rows: Record<string, unknown>[];
  colTypeByKey: Record<string, string | undefined>;
};

/** { bareColKey / "table.col": value } fallbacks from each table's FIRST row.
 *  Bare keys follow "first table wins"; dotted keys are unambiguous. */
function firstRowScopeEntries(registry: Record<string, RowAggregateRegistryEntry>): Record<string, CalcValue> {
  const scope: Record<string, CalcValue> = {};
  for (const [tableKey, entry] of Object.entries(registry)) {
    const firstRow = entry.rows[0] ?? {};
    for (const [colKey, colType] of Object.entries(entry.colTypeByKey)) {
      const value = coerceScopeValue(colType, firstRow[colKey]);
      if (!(colKey in scope)) scope[colKey] = value;
      scope[`${tableKey}.${colKey}`] = value;
    }
  }
  return scope;
}

/** Scope keyed by field KEY (what TemplateForm and the server use). */
export function buildCalcScope(
  allFields: TemplateField[],
  values: Record<string, unknown>,
  registry?: Record<string, RowAggregateRegistryEntry>,
): Record<string, CalcValue> {
  const scope: Record<string, CalcValue> = registry ? firstRowScopeEntries(registry) : {};
  for (const f of allFields) {
    if (!f.key) continue;
    scope[f.key] = coerceScopeValue(f.type, values[f.key]);
  }
  return scope;
}

export function buildRowCalcScope(
  allFields: TemplateField[],
  values: Record<string, unknown>,
  columns: TableColumn[],
  row: Record<string, unknown>,
  registry?: Record<string, RowAggregateRegistryEntry>,
): Record<string, CalcValue> {
  const scope = buildCalcScope(allFields, values, registry);
  const colTypeByKey: Record<string, string | undefined> = {};
  columns.forEach((c) => { if (c.key) colTypeByKey[c.key] = c.type; });
  for (const [k, v] of Object.entries(row)) {
    scope[k] = coerceScopeValue(colTypeByKey[k], v);
  }
  return scope;
}

/* ── Whole-column aggregates ─────────────────────────────────────────────
 * Replaced with their literal BEFORE parsing, since an aggregate needs a raw
 * column plus the full row list. Arguments are literals, not expressions.
 * SUM AVG COUNT COUNTA COUNTBLANK COLMIN COLMAX MEDIAN PRODUCT FIRST LAST
 * SUMIF(value_col, test_col, "crit")  COUNTIF(test_col, "crit")
 * AVGIF(value_col, test_col, "crit")  COLJOIN(col, ", ")  ROWCOUNT(table_key)
 * Works for a column formula (rows = the table's own rows) and for a top-level
 * field formula (rows = null/[], everything resolved through `allTables`). */
const AGG_FUNCS = new Set([
  "SUM", "AVG", "COUNT", "COUNTA", "COUNTBLANK", "COLMIN", "COLMAX",
  "MEDIAN", "PRODUCT", "FIRST", "LAST", "SUMIF", "COUNTIF", "AVGIF",
  "COLJOIN", "ROWCOUNT",
]);

const cellText = (v: unknown): string => (v === null || v === undefined ? "" : String(v).trim());

function splitTopLevelArgs(inner: string): string[] {
  const args: string[] = [];
  let depth = 0, quote: string | null = null, current = "";
  for (let i = 0; i < inner.length; i += 1) {
    const ch = inner[i];
    if (quote) {
      current += ch;
      if (ch === "\\" && i + 1 < inner.length) { current += inner[i + 1]; i += 1; }
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; current += ch; continue; }
    if (ch === "(") depth += 1;
    if (ch === ")") depth -= 1;
    if (ch === "," && depth === 0) { args.push(current.trim()); current = ""; continue; }
    current += ch;
  }
  if (current.trim() !== "" || args.length > 0) args.push(current.trim());
  return args;
}

function literalArg(arg: string | undefined): string {
  if (!arg) return "";
  const t = arg.trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    return t.slice(1, -1).replace(/\\(["'\\])/g, "$1");
  }
  return t;
}

function matchesCriteria(raw: unknown, criteria: string): boolean {
  const cell = cellText(raw);
  const c = criteria.trim();
  const m = /^(>=|<=|<>|!=|=|>|<)\s*(.*)$/.exec(c);
  if (!m) return cell.toLowerCase() === c.toLowerCase();
  const [, op, rhsRaw] = m;
  const rhs = rhsRaw.trim();
  const bothNumeric = cell !== "" && rhs !== "" && Number.isFinite(parseFloat(cell)) && Number.isFinite(parseFloat(rhs));
  if (op === "=") return cell.toLowerCase() === rhs.toLowerCase();
  if (op === "<>" || op === "!=") return cell.toLowerCase() !== rhs.toLowerCase();
  if (bothNumeric) {
    const a = parseFloat(cell), b = parseFloat(rhs);
    if (op === ">") return a > b;
    if (op === ">=") return a >= b;
    if (op === "<") return a < b;
    return a <= b;
  }
  const cmp = cell.localeCompare(rhs);
  if (op === ">") return cmp > 0;
  if (op === ">=") return cmp >= 0;
  if (op === "<") return cmp < 0;
  return cmp <= 0;
}

function resolveColumnRef(
  ref: string,
  rows: Record<string, unknown>[] | null,
  colTypeByKey: Record<string, string | undefined> | null,
  allTables?: Record<string, RowAggregateRegistryEntry>,
): { rows: Record<string, unknown>[]; colType: string | undefined; colKey: string } {
  const [first, second] = ref.split(".");
  if (second) {
    const entry = allTables?.[first];
    return { rows: entry?.rows ?? [], colType: entry?.colTypeByKey[second], colKey: second };
  }
  if (rows && colTypeByKey && first in colTypeByKey) {
    return { rows, colType: colTypeByKey[first], colKey: first };
  }
  for (const entry of Object.values(allTables ?? {})) {
    if (first in entry.colTypeByKey) return { rows: entry.rows, colType: entry.colTypeByKey[first], colKey: first };
  }
  return { rows: [], colType: undefined, colKey: first };
}

export function resolveRowAggregates(
  expression: string,
  rows: Record<string, unknown>[] | null,
  colTypeByKey: Record<string, string | undefined> | null,
  allTables?: Record<string, RowAggregateRegistryEntry>,
): string {
  if (!expression || !expression.includes("(")) return expression;
  const nameRe = /\b([A-Za-z_][A-Za-z0-9_]*)\s*\(/g;
  let out = expression;
  let guard = 0;
  while (guard < 200) {
    guard += 1;
    nameRe.lastIndex = 0;
    let match: RegExpExecArray | null = null;
    let found: { start: number; inner: string; end: number; fn: string } | null = null;
    while ((match = nameRe.exec(out))) {
      const fn = match[1].toUpperCase();
      if (!AGG_FUNCS.has(fn)) continue;
      let depth = 1, quote: string | null = null, i = match.index + match[0].length;
      for (; i < out.length && depth > 0; i += 1) {
        const ch = out[i];
        if (quote) { if (ch === "\\") i += 1; else if (ch === quote) quote = null; continue; }
        if (ch === '"' || ch === "'") quote = ch;
        else if (ch === "(") depth += 1;
        else if (ch === ")") depth -= 1;
      }
      if (depth !== 0) continue;
      found = { start: match.index, inner: out.slice(match.index + match[0].length, i - 1), end: i, fn };
      break;
    }
    if (!found) break;

    const args = splitTopLevelArgs(found.inner);
    const fn = found.fn;
    let literal = "(0)";

    if (fn === "ROWCOUNT") {
      const entry = allTables?.[literalArg(args[0])];
      literal = `(${entry ? entry.rows.length : (rows?.length ?? 0)})`;
    } else {
      const target = resolveColumnRef(literalArg(args[0]), rows, colTypeByKey, allTables);
      const cells = target.rows.filter((r) => r && typeof r === "object").map((r) => r[target.colKey]);
      const nums = cells.map((v) => coerceNumeric(target.colType, v));
      const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

      if (fn === "SUMIF" || fn === "AVGIF" || fn === "COUNTIF") {
        const testRef = fn === "COUNTIF" ? literalArg(args[0]) : literalArg(args[1]);
        const criteria = fn === "COUNTIF" ? literalArg(args[1]) : literalArg(args[2]);
        const test = resolveColumnRef(testRef, rows, colTypeByKey, allTables);
        const keep: number[] = [];
        let matched = 0;
        target.rows.forEach((row, idx) => {
          const testCell = (test.rows[idx] ?? row)?.[test.colKey];
          if (!matchesCriteria(testCell, criteria)) return;
          matched += 1;
          keep.push(coerceNumeric(target.colType, row?.[target.colKey]));
        });
        if (fn === "COUNTIF") literal = `(${matched})`;
        else if (fn === "SUMIF") literal = `(${sum(keep)})`;
        else literal = `(${keep.length ? sum(keep) / keep.length : 0})`;
      } else if (fn === "COLJOIN") {
        const sep = args.length > 1 ? literalArg(args[1]) : ", ";
        literal = JSON.stringify(cells.map(cellText).filter((v) => v !== "").join(sep));
      } else {
        let result = 0;
        switch (fn) {
          case "SUM": result = sum(nums); break;
          case "AVG": result = nums.length ? sum(nums) / nums.length : 0; break;
          case "COUNT": result = nums.length; break;
          case "COUNTA": result = cells.filter((v) => cellText(v) !== "").length; break;
          case "COUNTBLANK": result = cells.filter((v) => cellText(v) === "").length; break;
          case "COLMIN": result = nums.length ? Math.min(...nums) : 0; break;
          case "COLMAX": result = nums.length ? Math.max(...nums) : 0; break;
          case "PRODUCT": result = nums.length ? nums.reduce((a, b) => a * b, 1) : 0; break;
          case "MEDIAN": {
            if (nums.length) {
              const sorted = [...nums].sort((a, b) => a - b);
              const mid = Math.floor(sorted.length / 2);
              result = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
            }
            break;
          }
          case "FIRST": result = nums.length ? nums[0] : 0; break;
          case "LAST": result = nums.length ? nums[nums.length - 1] : 0; break;
        }
        literal = `(${Number.isFinite(result) ? result : 0})`;
      }
    }
    out = out.slice(0, found.start) + literal + out.slice(found.end);
  }
  return out;
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
  // regardless of declaration order. Bounded by calcColumns.length so a
  // circular formula just stops changing rather than looping forever.
  for (let pass = 0; pass < calcColumns.length; pass++) {
    let changed = false;
    computedRows = computedRows.map((row) => {
      const computedRow: Record<string, unknown> = { ...row };
      for (const column of calcColumns) {
        const colKey = column.key!;
        try {
          const scope = buildRowCalcScope(allFields, values, columns, computedRow, allTables);
          const resolvedExpr = resolveRowAggregates(
            column.calc!.expression!,
            computedRows,
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