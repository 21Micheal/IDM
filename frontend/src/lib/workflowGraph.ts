/**
 * workflowGraph.ts — branched workflow definition (v2)
 *
 * ONE workflow per document type / form. Routing that used to be "many
 * templates + amount rules" is expressed *inside* the workflow with
 * if/else and switch blocks.
 *
 * Outcome model (important):
 *   - The workflow's outcome is decided by its APPROVAL steps, not by the last node.
 *     Approved  → advance to the next step; after the last step the workflow is
 *                 Completed with outcome "Approved".
 *     Rejected  → the workflow stops right there and is Completed with outcome
 *                 "Rejected". Later steps are NOT executed. Always. There is no graph
 *                 construct that changes this.
 *     Returned  → NOT a graph concept. It is an approver ACTION chosen at runtime, enabled
 *                 per step via `step.allow_return` (send back to the previous approval on
 *                 the path taken) and `step.allow_return_submitter` (send back to the
 *                 submitter). A return pauses the instance; it does not complete it.
 *   - `end` blocks are an optional shortcut (auto-approve / auto-reject).
 *
 * Pure TypeScript: no React, no API calls. Everything here is unit-testable and
 * the same algorithms should be ported to the backend engine
 * (evaluate / compile / validate).
 */

// ─────────────────────────────────────────────────────────────────────────────
// 1. Fields (what conditions can look at)
// ─────────────────────────────────────────────────────────────────────────────

export type Scalar = string | number | boolean | null;

export type FieldType =
  | "number"       // plain number (line_count, quantity)
  | "money"        // { amount, currency } at runtime
  | "text"
  | "select"       // single value from options
  | "multiselect"  // array of option values (also used for "uploader groups")
  | "boolean"
  | "date"
  | "user"         // user id
  | "group";       // group id

export interface FieldOption { value: string; label: string }

export interface WorkflowField {
  /** Stable id used in conditions. Form fields: the form field id. */
  id: string;
  label: string;
  type: FieldType;
  options?: FieldOption[];
  /** Where the value comes from — drives grouping in the picker. */
  source: "system" | "form" | "variable";
}

/** Fields that exist for every document type. Extend to taste. */
export const SYSTEM_FIELDS: WorkflowField[] = [
  { id: "amount",              label: "Amount",               type: "money",       source: "system" },
  { id: "context.phase",       label: "Workflow phase",       type: "select",      source: "system",
    options: [
      { value: "requisition", label: "Requisition" }, { value: "rfq", label: "RFQ" },
      { value: "lpo", label: "LPO" }, { value: "request", label: "Request" },
      { value: "retirement", label: "Retirement" }, { value: "payment_run", label: "Payment run" },
    ] },
  { id: "uploader.groups",     label: "Submitter's groups",   type: "multiselect", source: "system" },
  { id: "uploader.department", label: "Submitter's department", type: "text",      source: "system" },
  { id: "document.title",      label: "Document title",       type: "text",        source: "system" },
  { id: "document.created_at", label: "Date submitted",       type: "date",        source: "system" },
  { id: "payment_run.line_count", label: "Payment run: line count", type: "number", source: "system" },
  { id: "payment_run.total",      label: "Payment run: total",      type: "money",  source: "system" },
];

// ─────────────────────────────────────────────────────────────────────────────
// 2. Conditions
// ─────────────────────────────────────────────────────────────────────────────

export type Operator =
  | "eq" | "neq" | "gt" | "gte" | "lt" | "lte" | "between"
  | "in" | "not_in"
  | "contains" | "not_contains" | "starts_with" | "ends_with"
  | "is_empty" | "is_not_empty"
  | "is_true" | "is_false"
  | "before" | "after" | "within_last_days"
  | "contains_any" | "contains_all";

export const OPERATOR_META: Record<Operator, { label: string; arity: 0 | 1 | 2 | "list" }> = {
  eq: { label: "is", arity: 1 },
  neq: { label: "is not", arity: 1 },
  gt: { label: ">", arity: 1 },
  gte: { label: "≥", arity: 1 },
  lt: { label: "<", arity: 1 },
  lte: { label: "≤", arity: 1 },
  between: { label: "is between", arity: 2 },
  in: { label: "is one of", arity: "list" },
  not_in: { label: "is not one of", arity: "list" },
  contains: { label: "contains", arity: 1 },
  not_contains: { label: "does not contain", arity: 1 },
  starts_with: { label: "starts with", arity: 1 },
  ends_with: { label: "ends with", arity: 1 },
  is_empty: { label: "is empty", arity: 0 },
  is_not_empty: { label: "is not empty", arity: 0 },
  is_true: { label: "is true", arity: 0 },
  is_false: { label: "is false", arity: 0 },
  before: { label: "is before", arity: 1 },
  after: { label: "is after", arity: 1 },
  within_last_days: { label: "is within the last (days)", arity: 1 },
  contains_any: { label: "includes any of", arity: "list" },
  contains_all: { label: "includes all of", arity: "list" },
};

export const OPERATORS_BY_TYPE: Record<FieldType, Operator[]> = {
  number:      ["eq", "neq", "gt", "gte", "lt", "lte", "between", "is_empty", "is_not_empty"],
  money:       ["eq", "neq", "gt", "gte", "lt", "lte", "between", "is_empty", "is_not_empty"],
  text:        ["eq", "neq", "contains", "not_contains", "starts_with", "ends_with", "in", "not_in", "is_empty", "is_not_empty"],
  select:      ["eq", "neq", "in", "not_in", "is_empty", "is_not_empty"],
  multiselect: ["contains_any", "contains_all", "is_empty", "is_not_empty"],
  boolean:     ["is_true", "is_false"],
  date:        ["eq", "before", "after", "between", "within_last_days", "is_empty", "is_not_empty"],
  user:        ["eq", "neq", "in", "not_in", "is_empty", "is_not_empty"],
  group:       ["eq", "neq", "in", "not_in", "is_empty", "is_not_empty"],
};

export interface ConditionRule {
  kind: "rule";
  id: string;
  field_id: string;
  op: Operator;
  /** Literal operand. Array for in/not_in/contains_any/contains_all. */
  value?: Scalar | Scalar[];
  /** Second operand for `between`. */
  value2?: Scalar;
  /** Currency of the literal(s) when the field is `money`. */
  currency?: string;
  /** Compare against another field instead of a literal. */
  value_ref?: string;
}

export interface ConditionGroup {
  kind: "group";
  id: string;
  combinator: "and" | "or";
  negate?: boolean;
  children: Array<ConditionRule | ConditionGroup>;
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. Blocks (the workflow "program")
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Structural stand-in for the page's WorkflowStep so this file has no import
 * cycle. The page's `WorkflowStep` is assignable to this.
 */
export interface StepData {
  name: string;
  step_type: "approval" | "notification";
  order?: number;
  [key: string]: any;
}

export interface ApprovalBlock { kind: "approval"; id: string; step: StepData }
export interface NotificationBlock { kind: "notification"; id: string; step: StepData }

export interface IfElseBranch { id: string; label?: string; when: ConditionGroup; blocks: Block[] }
export interface IfElseBlock  {
  kind: "if_else"; id: string; label?: string;
  /** Evaluated top-to-bottom; first match wins. */
  branches: IfElseBranch[];
  /** Runs when no branch matches. Always present (may be empty). */
  else_blocks: Block[];
}

export interface SwitchCase  { id: string; label?: string; values: string[]; blocks: Block[] }
export interface SwitchBlock {
  kind: "switch"; id: string; label?: string;
  field_id: string;
  cases: SwitchCase[];
  default_blocks: Block[];
}

/** Sets a workflow variable, readable in later conditions as `var.<name>`. */
export interface SetValueBlock {
  kind: "set_value"; id: string;
  variable: string;
  value?: Scalar;
  value_ref?: string;
}

/** Completes the workflow early (auto-approve small items, auto-reject invalid ones). */
export interface EndBlock {
  kind: "end"; id: string;
  outcome: "approved" | "rejected";
  reason?: string;
}

export type Block =
  | ApprovalBlock | NotificationBlock
  | IfElseBlock | SwitchBlock | SetValueBlock | EndBlock;

export interface WorkflowDefinition { version: 2; blocks: Block[] }

export const emptyDefinition = (): WorkflowDefinition => ({ version: 2, blocks: [] });

// ─────────────────────────────────────────────────────────────────────────────
// 4. Helpers: ids, traversal, immutable edits
// ─────────────────────────────────────────────────────────────────────────────

export function uid(prefix = "b"): string {
  const c: any = (globalThis as any).crypto;
  const rnd = c?.randomUUID ? c.randomUUID().slice(0, 8) : Math.random().toString(36).slice(2, 10);
  return `${prefix}_${rnd}`;
}

export const newGroup = (combinator: "and" | "or" = "and"): ConditionGroup =>
  ({ kind: "group", id: uid("g"), combinator, children: [] });

export const newRule = (field_id = "", op: Operator = "eq"): ConditionRule =>
  ({ kind: "rule", id: uid("r"), field_id, op });

export const newIfElse = (): IfElseBlock => ({
  kind: "if_else", id: uid(), label: "",
  branches: [{ id: uid("br"), label: "", when: { ...newGroup(), children: [newRule()] }, blocks: [] }],
  else_blocks: [],
});

export const newSwitch = (field_id = ""): SwitchBlock => ({
  kind: "switch", id: uid(), label: "", field_id,
  cases: [{ id: uid("case"), label: "", values: [], blocks: [] }],
  default_blocks: [],
});

export const newSetValue = (): SetValueBlock => ({ kind: "set_value", id: uid(), variable: "", value: "" });
export const newEnd = (outcome: "approved" | "rejected" = "approved"): EndBlock => ({ kind: "end", id: uid(), outcome });

export interface ChildList { slot: string; label: string; blocks: Block[] }

/** Every nested block list of a block. Slot ids: branch.id | "else" | case.id | "default". */
export function childLists(b: Block): ChildList[] {
  switch (b.kind) {
    case "if_else":
      return [
        ...b.branches.map((br, i) => ({ slot: br.id, label: i === 0 ? "IF" : "ELSE IF", blocks: br.blocks })),
        { slot: "else", label: "ELSE", blocks: b.else_blocks },
      ];
    case "switch":
      return [
        ...b.cases.map((c) => ({ slot: c.id, label: "CASE", blocks: c.blocks })),
        { slot: "default", label: "DEFAULT", blocks: b.default_blocks },
      ];
    default:
      return [];
  }
}

export function setChildList(b: Block, slot: string, blocks: Block[]): Block {
  if (b.kind === "if_else") {
    if (slot === "else") return { ...b, else_blocks: blocks };
    return { ...b, branches: b.branches.map((br) => (br.id === slot ? { ...br, blocks } : br)) };
  }
  if (b.kind === "switch") {
    if (slot === "default") return { ...b, default_blocks: blocks };
    return { ...b, cases: b.cases.map((c) => (c.id === slot ? { ...c, blocks } : c)) };
  }
  return b;
}

/** Apply fn to every approval/notification step (immutably) — e.g. stripping UI-only fields before save. */
export function mapSteps(blocks: Block[], fn: (s: StepData) => StepData): Block[] {
  return blocks.map((b) => {
    if (b.kind === "approval" || b.kind === "notification") return { ...b, step: fn(b.step) };
    let next: Block = b;
    for (const cl of childLists(b)) next = setChildList(next, cl.slot, mapSteps(cl.blocks, fn));
    return next;
  });
}

export function walk(blocks: Block[], fn: (b: Block, depth: number) => void, depth = 0): void {
  for (const b of blocks) {
    fn(b, depth);
    for (const cl of childLists(b)) walk(cl.blocks, fn, depth + 1);
  }
}

export function findBlock(blocks: Block[], id: string): Block | null {
  let hit: Block | null = null;
  walk(blocks, (b) => { if (b.id === id) hit = b; });
  return hit;
}

/** Replace a block by id (immutably). */
export function updateBlock(blocks: Block[], id: string, fn: (b: Block) => Block): Block[] {
  return blocks.map((b) => {
    if (b.id === id) return fn(b);
    let next = b;
    for (const cl of childLists(b)) {
      const updated = updateBlock(cl.blocks, id, fn);
      if (updated !== cl.blocks && updated.some((x, i) => x !== cl.blocks[i])) next = setChildList(next, cl.slot, updated);
    }
    return next;
  });
}

export function removeBlock(blocks: Block[], id: string): Block[] {
  const out: Block[] = [];
  for (const b of blocks) {
    if (b.id === id) continue;
    let next = b;
    for (const cl of childLists(b)) next = setChildList(next, cl.slot, removeBlock(cl.blocks, id));
    out.push(next);
  }
  return out;
}

/** List address: "root" or `${blockId}:${slot}`. */
export type ListKey = string;
export const listKey = (blockId: string, slot: string): ListKey => `${blockId}:${slot}`;

export function editList(blocks: Block[], key: ListKey, fn: (list: Block[]) => Block[]): Block[] {
  if (key === "root") return fn(blocks);
  const [blockId, slot] = key.split(":");
  return updateBlock(blocks, blockId, (b) => {
    const cl = childLists(b).find((c) => c.slot === slot);
    return cl ? setChildList(b, slot, fn(cl.blocks)) : b;
  });
}

export function moveInList(list: Block[], id: string, dir: -1 | 1): Block[] {
  const i = list.findIndex((b) => b.id === id);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= list.length) return list;
  const next = [...list];
  [next[i], next[j]] = [next[j], next[i]];
  return next;
}

/** Deep clone with fresh ids (duplicate block / copy a branch). */
export function cloneBlock(b: Block): Block {
  const fresh = (x: any): any => {
    if (Array.isArray(x)) return x.map(fresh);
    if (x && typeof x === "object") {
      const o: any = {};
      for (const k of Object.keys(x)) o[k] = k === "id" && typeof x[k] === "string"
        ? uid(String(x[k]).split("_")[0] || "b") : fresh(x[k]);
      return o;
    }
    return x;
  };
  const c = fresh(b);
  if (c.step) delete c.step.id; // server assigns new step ids
  return c;
}

/** All field ids referenced by conditions/switches/set_value (for the tester). */
export function collectFieldRefs(blocks: Block[]): string[] {
  const out = new Set<string>();
  const inGroup = (g: ConditionGroup) => {
    for (const c of g.children) {
      if (c.kind === "group") inGroup(c);
      else { if (c.field_id) out.add(c.field_id); if (c.value_ref) out.add(c.value_ref); }
    }
  };
  walk(blocks, (b) => {
    if (b.kind === "if_else") b.branches.forEach((br) => inGroup(br.when));
    if (b.kind === "switch" && b.field_id) out.add(b.field_id);
    if (b.kind === "set_value" && b.value_ref) out.add(b.value_ref);
  });
  return [...out].filter((id) => !id.startsWith("var."));
}

/** Workflow variables declared by set_value blocks, exposed to the field picker. */
export function declaredVariables(blocks: Block[]): WorkflowField[] {
  const seen = new Set<string>();
  const out: WorkflowField[] = [];
  walk(blocks, (b) => {
    if (b.kind === "set_value" && b.variable && !seen.has(b.variable)) {
      seen.add(b.variable);
      out.push({ id: `var.${b.variable}`, label: `Variable: ${b.variable}`, type: "text", source: "variable" });
    }
  });
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. Evaluation
// ─────────────────────────────────────────────────────────────────────────────

export interface EvalEnv {
  values: Record<string, unknown>;
  vars: Record<string, unknown>;
  /** rates[c] = value of 1 unit of c in a common base currency. */
  rates?: Record<string, number>;
  now?: Date;
  warnings: string[];
}

export const makeEnv = (values: Record<string, unknown>, extra: Partial<EvalEnv> = {}): EvalEnv =>
  ({ values, vars: {}, warnings: [], ...extra });

function getValue(env: EvalEnv, id: string): unknown {
  if (id.startsWith("var.")) return env.vars[id.slice(4)];
  if (id in env.values) return env.values[id];
  if (id.includes(".")) { // nested objects: { uploader: { department: "X" } }
    let cur: any = env.values;
    for (const part of id.split(".")) { if (cur == null) return undefined; cur = cur[part]; }
    return cur;
  }
  return undefined;
}

const isMoney = (v: unknown): v is { amount: unknown; currency?: string } =>
  !!v && typeof v === "object" && !Array.isArray(v) && "amount" in (v as any);

function isEmptyValue(v: unknown): boolean {
  if (v === null || v === undefined) return true;
  if (typeof v === "string") return v.trim() === "";
  if (Array.isArray(v)) return v.length === 0;
  if (typeof v === "number") return Number.isNaN(v);
  if (isMoney(v)) return isEmptyValue(v.amount);
  return false;
}

function toNumber(v: unknown): number | null {
  if (isMoney(v)) return toNumber(v.amount);
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string") {
    const n = Number(v.replace(/,/g, "").trim());
    return v.trim() === "" || !Number.isFinite(n) ? null : n;
  }
  return null;
}

function convert(env: EvalEnv, amount: number, from: string | undefined, to: string | undefined): number | null {
  if (!from || !to || from === to) return amount;
  const r = env.rates;
  if (!r || !r[from] || !r[to]) {
    env.warnings.push(`No exchange rate to compare ${from} with ${to}; condition treated as not matching.`);
    return null;
  }
  return (amount * r[from]) / r[to];
}

const str = (v: unknown) => String(v ?? "").trim();
const lc = (v: unknown) => str(v).toLowerCase();
const asList = (v: unknown): string[] =>
  Array.isArray(v) ? v.map(str) : str(v) ? str(v).split(",").map((s) => s.trim()).filter(Boolean) : [];

/** When the field is empty, only these operators are satisfied (besides is_empty). */
const TRUE_WHEN_EMPTY = new Set<Operator>(["neq", "not_in", "not_contains", "is_false"]);

export function evalRule(rule: ConditionRule, fields: Map<string, WorkflowField>, env: EvalEnv): boolean {
  if (!rule.field_id || !rule.op) { env.warnings.push("Incomplete condition ignored."); return false; }
  const field = fields.get(rule.field_id);
  const raw = getValue(env, rule.field_id);
  const type: FieldType = field?.type ?? (isMoney(raw) ? "money" : typeof raw === "number" ? "number"
    : typeof raw === "boolean" ? "boolean" : Array.isArray(raw) ? "multiselect" : "text");

  if (rule.op === "is_empty") return isEmptyValue(raw);
  if (rule.op === "is_not_empty") return !isEmptyValue(raw);
  if (isEmptyValue(raw)) return TRUE_WHEN_EMPTY.has(rule.op);

  // Right-hand operand: literal or another field.
  const refVal = rule.value_ref ? getValue(env, rule.value_ref) : undefined;
  const lit = rule.value_ref ? refVal : rule.value;

  switch (type) {
    case "number":
    case "money": {
      const L0 = toNumber(raw);
      if (L0 === null) return false;
      const leftCur = isMoney(raw) ? raw.currency : undefined;
      // Normalise both sides into the literal's currency (or the left currency for field refs).
      let cmpCur = rule.currency || leftCur;
      let L: number | null = L0;
      if (type === "money" && !rule.value_ref && rule.currency && leftCur) L = convert(env, L0, leftCur, rule.currency);
      const rightNum = (v: unknown): number | null => {
        const n = toNumber(v);
        if (n === null) return null;
        if (rule.value_ref && isMoney(v) && leftCur) return convert(env, n, v.currency, leftCur);
        return n;
      };
      if (rule.value_ref) cmpCur = leftCur;
      void cmpCur;
      if (L === null) return false;
      const R = rightNum(lit);
      switch (rule.op) {
        case "between": {
          const R2 = toNumber(rule.value2);
          return R !== null && R2 !== null && L >= Math.min(R, R2) - 1e-9 && L <= Math.max(R, R2) + 1e-9;
        }
        case "eq":  return R !== null && Math.abs(L - R) < 1e-9;
        case "neq": return R === null || Math.abs(L - R) >= 1e-9;
        case "gt":  return R !== null && L > R;
        case "gte": return R !== null && L >= R - 1e-9;
        case "lt":  return R !== null && L < R;
        case "lte": return R !== null && L <= R + 1e-9;
        default: return false;
      }
    }
    case "boolean": {
      const b = raw === true || lc(raw) === "true" || lc(raw) === "yes" || raw === 1;
      if (rule.op === "is_true") return b;
      if (rule.op === "is_false") return !b;
      return false;
    }
    case "date": {
      const d = Date.parse(str(raw));
      if (Number.isNaN(d)) return false;
      const t = Date.parse(str(lit));
      const now = (env.now ?? new Date()).getTime();
      switch (rule.op) {
        case "eq":     return !Number.isNaN(t) && new Date(d).toDateString() === new Date(t).toDateString();
        case "before": return !Number.isNaN(t) && d < t;
        case "after":  return !Number.isNaN(t) && d > t;
        case "between": { const t2 = Date.parse(str(rule.value2)); return !Number.isNaN(t) && !Number.isNaN(t2) && d >= t && d <= t2; }
        case "within_last_days": { const n = toNumber(lit); return n !== null && d <= now && now - d <= n * 86_400_000; }
        default: return false;
      }
    }
    case "multiselect": {
      const have = new Set(asList(raw).map(lc));
      const want = asList(lit).map(lc);
      if (rule.op === "contains_any") return want.some((w) => have.has(w));
      if (rule.op === "contains_all") return want.length > 0 && want.every((w) => have.has(w));
      return false;
    }
    default: { // text | select | user | group
      const exact = type !== "text";
      const norm = (v: unknown) => (exact ? str(v) : lc(v));
      const L = norm(raw);
      switch (rule.op) {
        case "eq":  return L === norm(lit);
        case "neq": return L !== norm(lit);
        case "in":     return asList(lit).map(norm).includes(L);
        case "not_in": return !asList(lit).map(norm).includes(L);
        case "contains":     return L.includes(norm(lit));
        case "not_contains": return !L.includes(norm(lit));
        case "starts_with":  return L.startsWith(norm(lit));
        case "ends_with":    return L.endsWith(norm(lit));
        default: return false;
      }
    }
  }
}

export function evalGroup(g: ConditionGroup, fields: Map<string, WorkflowField>, env: EvalEnv): boolean {
  // An empty group is *incomplete*, never "always true" — otherwise a half-built IF would swallow everything.
  if (g.children.length === 0) { env.warnings.push("A condition group is empty and was treated as not matching."); return false; }
  const results = g.children.map((c) => (c.kind === "group" ? evalGroup(c, fields, env) : evalRule(c, fields, env)));
  const r = g.combinator === "and" ? results.every(Boolean) : results.some(Boolean);
  return g.negate ? !r : r;
}

// ─────────────────────────────────────────────────────────────────────────────
// 6. Human-readable text (pseudocode + labels)
// ─────────────────────────────────────────────────────────────────────────────

const fmtNum = (n: unknown) => { const x = toNumber(n); return x === null ? String(n ?? "…") : x.toLocaleString("en-US", { maximumFractionDigits: 2 }); };

export function describeRule(r: ConditionRule, fields: Map<string, WorkflowField>): string {
  const f = fields.get(r.field_id);
  const name = f?.label ?? (r.field_id || "…");
  const meta = OPERATOR_META[r.op];
  const cur = f?.type === "money" && r.currency ? ` ${r.currency}` : "";
  const optLabel = (v: unknown) => f?.options?.find((o) => o.value === str(v))?.label ?? str(v);
  const one = (v: unknown) => {
    if (r.value_ref) return `[${fields.get(r.value_ref)?.label ?? r.value_ref}]`;
    if (f?.type === "money" || f?.type === "number") return `${fmtNum(v)}${cur}`;
    if (f?.type === "text" || f?.type === "date") return `"${str(v)}"`;
    return optLabel(v);
  };
  if (!meta) return name;
  if (meta.arity === 0) return `${name} ${meta.label}`;
  if (meta.arity === "list") return `${name} ${meta.label} (${asList(r.value).map(optLabel).join(", ") || "…"})`;
  if (meta.arity === 2) return `${name} ${meta.label} ${one(r.value)} and ${one(r.value2)}`;
  return `${name} ${meta.label} ${one(r.value)}`;
}

export function describeGroup(g: ConditionGroup, fields: Map<string, WorkflowField>, top = true): string {
  if (g.children.length === 0) return "(no condition)";
  const parts = g.children.map((c) => (c.kind === "group" ? describeGroup(c, fields, false) : describeRule(c, fields)));
  const joined = parts.join(g.combinator === "and" ? " AND " : " OR ");
  const wrapped = parts.length > 1 && (!top || g.negate) ? `(${joined})` : joined;
  return g.negate ? `NOT ${wrapped}` : wrapped;
}

export function toPseudocode(blocks: Block[], fields: Map<string, WorkflowField>, groupName: (id: string | null | undefined) => string = (x) => x ?? "?"): string {
  const lines: string[] = [];
  const ind = (n: number) => "  ".repeat(n);
  const emit = (list: Block[], d: number) => {
    for (const b of list) {
      switch (b.kind) {
        case "approval": {
          const s = b.step;
          const mode = s.assignee_type === "group_all" ? "ALL of" : s.assignee_type === "group_specific" ? "SPECIFIC member of" : "ANY of";
          lines.push(`${ind(d)}APPROVE "${s.name || "Untitled"}" by ${mode} ${groupName(s.assignee_group)}${s.sla_hours ? `  [SLA ${s.sla_hours}h]` : ""}`);
          const rt = [s.allow_return ? "previous step" : "", s.allow_return_submitter ? "submitter" : ""].filter(Boolean);
          if (rt.length) lines.push(`${ind(d + 1)}CAN RETURN to ${rt.join(" or ")}`);
          break;
        }
        case "notification": lines.push(`${ind(d)}NOTIFY "${b.step.name || "Untitled"}"`); break;
        case "set_value": lines.push(`${ind(d)}SET var.${b.variable || "?"} = ${b.value_ref ? `[${b.value_ref}]` : JSON.stringify(b.value ?? "")}`); break;
        case "end": lines.push(`${ind(d)}COMPLETE as ${b.outcome.toUpperCase()}${b.reason ? `  // ${b.reason}` : ""}`); break;
        case "if_else": {
          // An ELSE that holds exactly one IF is printed as a flat ELSE IF chain.
          let cur: IfElseBlock = b;
          let first = true;
          for (;;) {
            cur.branches.forEach((br, i) => {
              lines.push(`${ind(d)}${first && i === 0 ? "IF" : "ELSE IF"} ${describeGroup(br.when, fields)} THEN${br.label ? `  // ${br.label}` : ""}`);
              emit(br.blocks, d + 1);
            });
            first = false;
            const only = cur.else_blocks.length === 1 ? cur.else_blocks[0] : null;
            if (only && only.kind === "if_else") { cur = only; continue; }
            // An empty ELSE is simply "skip": independent IFs read as plain IF … END IF.
            if (cur.else_blocks.length) { lines.push(`${ind(d)}ELSE  // fallback`); emit(cur.else_blocks, d + 1); }
            break;
          }
          lines.push(`${ind(d)}END IF`);
          break;
        }
        case "switch":
          lines.push(`${ind(d)}SWITCH ${fields.get(b.field_id)?.label ?? (b.field_id || "?")}`);
          for (const c of b.cases) {
            lines.push(`${ind(d + 1)}CASE ${c.values.join(" | ") || "?"}:${c.label ? `  // ${c.label}` : ""}`);
            emit(c.blocks, d + 2);
          }
          lines.push(`${ind(d + 1)}DEFAULT:`);
          emit(b.default_blocks, d + 2);
          lines.push(`${ind(d)}END SWITCH`);
          break;
      }
    }
  };
  emit(blocks, 0);
  return lines.join("\n");
}

// ─────────────────────────────────────────────────────────────────────────────
// 7. Simulation (dry-run a document through the definition)
// ─────────────────────────────────────────────────────────────────────────────

export interface SimDecision {
  block_id: string;
  kind: "if_else" | "switch";
  /** branch.id | case.id | "else" | "default" */
  matched_slot: string;
  matched_label: string;
  evaluated: { slot: string; label: string; result: boolean }[];
}

/** What an approver can do at a step (Approve is the default path and isn't listed). */
export type ApproverAction = "reject" | "return_previous" | "return_submitter";

/** Which approver actions a step offers, given where it sits on the path taken. */
export function availableActions(step: StepData, hasPreviousApproval: boolean): ApproverAction[] {
  const out: ApproverAction[] = [];
  if (step.allow_reject !== false) out.push("reject");
  if (step.allow_return && hasPreviousApproval) out.push("return_previous");
  if (step.allow_return_submitter) out.push("return_submitter");
  return out;
}

export interface SimResult {
  /**
   * pending_approvals — goes to approvers; it will be Approved once every step approves.
   * rejected / returned — only when `actAt` was given (what-if: an approver takes that action).
   */
  outcome: "pending_approvals" | "auto_approved" | "auto_rejected" | "no_approvers" | "rejected" | "returned";
  /** Set when `actAt` fired. For a return, `return_target` = approval block id, or null = back to the submitter. */
  acted?: { block_id: string; action: ApproverAction; return_target?: string | null };
  chain: (ApprovalBlock | NotificationBlock)[];
  decisions: SimDecision[];
  /** Block ids on the executed path (incl. the if/switch blocks themselves). */
  visited: Set<string>;
  /** `${blockId}:${slot}` that were taken — for highlighting. */
  takenSlots: Set<string>;
  warnings: string[];
}

export function fieldMap(fields: WorkflowField[]): Map<string, WorkflowField> {
  return new Map(fields.map((f) => [f.id, f]));
}

export function simulate(
  blocks: Block[],
  fields: Map<string, WorkflowField>,
  values: Record<string, unknown>,
  opts: { rates?: Record<string, number>; now?: Date; /** simulate "the approver at this step takes this action" */ actAt?: { id: string; action: ApproverAction } } = {},
): SimResult {
  const env = makeEnv(values, { rates: opts.rates, now: opts.now });
  const res: SimResult = {
    outcome: "no_approvers", chain: [], decisions: [], visited: new Set(), takenSlots: new Set(), warnings: env.warnings,
  };
  let ended: "approved" | "rejected" | null = null;
  let halted = false;

  const run = (list: Block[]) => {
    for (const b of list) {
      if (halted) return;
      res.visited.add(b.id);
      switch (b.kind) {
        case "approval": {
          res.chain.push(b);
          if (opts.actAt?.id === b.id) {
            const prev = res.chain.slice(0, -1).reverse().find((c) => c.kind === "approval");
            if (availableActions(b.step, !!prev).includes(opts.actAt.action)) {
              // Reject ends the workflow as Rejected; a return pauses it. Either way nothing after this step runs.
              halted = true;
              const a = opts.actAt.action;
              res.acted = { block_id: b.id, action: a, ...(a === "reject" ? {} : { return_target: a === "return_previous" ? prev!.id : null }) };
            }
          }
          break;
        }
        case "notification": res.chain.push(b); break;
        case "set_value": env.vars[b.variable] = b.value_ref ? getValue(env, b.value_ref) : b.value; break;
        case "end": ended = b.outcome; halted = true; break;
        case "if_else": {
          const evaluated: SimDecision["evaluated"] = [];
          let hit: IfElseBranch | null = null;
          for (const br of b.branches) {
            const r = evalGroup(br.when, fields, env);
            evaluated.push({ slot: br.id, label: br.label || describeGroup(br.when, fields), result: r });
            if (r) { hit = br; break; }           // first match wins
          }
          const slot = hit ? hit.id : "else";
          res.decisions.push({ block_id: b.id, kind: "if_else", matched_slot: slot,
            matched_label: hit ? (hit.label || describeGroup(hit.when, fields)) : b.else_blocks.length ? "ELSE (fallback)" : "no match — skipped", evaluated });
          res.takenSlots.add(`${b.id}:${slot}`);
          run(hit ? hit.blocks : b.else_blocks);
          break;
        }
        case "switch": {
          const v = getValue(env, b.field_id);
          const vals = Array.isArray(v) ? v.map(lc) : [lc(v)];
          const evaluated: SimDecision["evaluated"] = b.cases.map((c) => ({
            slot: c.id, label: c.label || c.values.join(" | "),
            result: c.values.some((x) => vals.includes(lc(x))),
          }));
          const hit = b.cases.find((_, i) => evaluated[i].result) ?? null;
          const slot = hit ? hit.id : "default";
          res.decisions.push({ block_id: b.id, kind: "switch", matched_slot: slot,
            matched_label: hit ? (hit.label || hit.values.join(" | ")) : "DEFAULT", evaluated });
          res.takenSlots.add(`${b.id}:${slot}`);
          run(hit ? hit.blocks : b.default_blocks);
          break;
        }
      }
    }
  };
  run(blocks);
  res.outcome = res.acted ? (res.acted.action === "reject" ? "rejected" : "returned")
    : ended === "approved" ? "auto_approved" : ended === "rejected" ? "auto_rejected"
    : res.chain.some((c) => c.kind === "approval") ? "pending_approvals" : "no_approvers";
  res.warnings = [...new Set(env.warnings)];
  return res;
}

// ─────────────────────────────────────────────────────────────────────────────
// 8. Path enumeration ("what are all the possible approval chains?")
// ─────────────────────────────────────────────────────────────────────────────

export interface PathLeg { block_id: string; kind: "approval" | "notification" | "end"; name: string }
export interface WorkflowPath {
  conditions: string[];
  legs: PathLeg[];
  terminal: "complete" | "approved" | "rejected";
}

export const MAX_PATHS = 300;

export function enumeratePaths(blocks: Block[], fields: Map<string, WorkflowField>): { paths: WorkflowPath[]; truncated: boolean } {
  let truncated = false;

  const seq = (list: Block[]): WorkflowPath[] => {
    let cur: WorkflowPath[] = [{ conditions: [], legs: [], terminal: "complete" }];
    for (const b of list) {
      const next: WorkflowPath[] = [];
      let alts: WorkflowPath[] | null = null; // alternatives contributed by this block
      let leg: PathLeg | null = null;

      if (b.kind === "approval" || b.kind === "notification") leg = { block_id: b.id, kind: b.kind, name: b.step.name || "Untitled" };
      else if (b.kind === "end") leg = { block_id: b.id, kind: "end", name: b.outcome };
      else if (b.kind === "if_else") {
        alts = [];
        b.branches.forEach((br, i) => {
          const cond = `${i === 0 ? "IF" : "ELSE IF"} ${describeGroup(br.when, fields)}`;
          seq(br.blocks).forEach((p) => alts!.push({ ...p, conditions: [cond, ...p.conditions] }));
        });
        seq(b.else_blocks).forEach((p) => alts!.push({ ...p, conditions: ["ELSE", ...p.conditions] }));
      } else if (b.kind === "switch") {
        alts = [];
        const fname = fields.get(b.field_id)?.label ?? b.field_id;
        b.cases.forEach((c) => seq(c.blocks).forEach((p) =>
          alts!.push({ ...p, conditions: [`${fname} = ${c.values.join(" | ") || "?"}`, ...p.conditions] })));
        seq(b.default_blocks).forEach((p) => alts!.push({ ...p, conditions: [`${fname} = other`, ...p.conditions] }));
      }

      for (const p of cur) {
        if (p.terminal !== "complete") { next.push(p); continue; }        // already ended
        if (leg) {
          const terminal = leg.kind === "end" ? (leg.name as "approved" | "rejected") : "complete";
          next.push({ ...p, legs: [...p.legs, leg], terminal });
        } else if (alts) {
          for (const a of alts) {
            if (next.length >= MAX_PATHS) { truncated = true; break; }
            next.push({ conditions: [...p.conditions, ...a.conditions], legs: [...p.legs, ...a.legs], terminal: a.terminal });
          }
        } else next.push(p); // set_value etc.
      }
      cur = next;
    }
    return cur;
  };

  const paths = seq(blocks);
  return { paths: paths.slice(0, MAX_PATHS), truncated: truncated || paths.length > MAX_PATHS };
}

// ─────────────────────────────────────────────────────────────────────────────
// 9. Validation
// ─────────────────────────────────────────────────────────────────────────────

export interface Issue { severity: "error" | "warning"; block_id?: string; message: string }

interface Interval { lo: number; loInc: boolean; hi: number; hiInc: boolean }

const isEmptyInterval = (i: Interval) => i.lo > i.hi || (i.lo === i.hi && !(i.loInc && i.hiInc));

function intersect(a: Interval, b: Interval): Interval {
  const lo = Math.max(a.lo, b.lo);
  const loInc = a.lo === b.lo ? a.loInc && b.loInc : a.lo > b.lo ? a.loInc : b.loInc;
  const hi = Math.min(a.hi, b.hi);
  const hiInc = a.hi === b.hi ? a.hiInc && b.hiInc : a.hi < b.hi ? a.hiInc : b.hiInc;
  return { lo, loInc, hi, hiInc };
}

function ruleInterval(r: ConditionRule): Interval | null {
  if (r.value_ref) return null;
  const v = toNumber(r.value);
  const INF = Infinity;
  switch (r.op) {
    case "gt":  return v === null ? null : { lo: v, loInc: false, hi: INF, hiInc: false };
    case "gte": return v === null ? null : { lo: v, loInc: true,  hi: INF, hiInc: false };
    case "lt":  return v === null ? null : { lo: -INF, loInc: false, hi: v, hiInc: false };
    case "lte": return v === null ? null : { lo: -INF, loInc: false, hi: v, hiInc: true };
    case "eq":  return v === null ? null : { lo: v, loInc: true, hi: v, hiInc: true };
    case "between": {
      const v2 = toNumber(r.value2);
      return v === null || v2 === null ? null : { lo: Math.min(v, v2), loInc: true, hi: Math.max(v, v2), hiInc: true };
    }
    default: return null;
  }
}

/** Only handles the common shape: AND of numeric rules on one field. Returns null otherwise. */
function groupInterval(g: ConditionGroup, fields: Map<string, WorkflowField>): { key: string; interval: Interval } | null {
  if (g.combinator !== "and" || g.negate || g.children.length === 0) return null;
  let key = ""; let acc: Interval = { lo: -Infinity, loInc: false, hi: Infinity, hiInc: false };
  for (const c of g.children) {
    if (c.kind !== "rule") return null;
    const t = fields.get(c.field_id)?.type;
    if (t !== "money" && t !== "number") return null;
    const iv = ruleInterval(c); if (!iv) return null;
    const k = `${c.field_id}|${c.currency ?? ""}`;
    if (key && key !== k) return null;
    key = k; acc = intersect(acc, iv);
  }
  return key ? { key, interval: acc } : null;
}

/** Is target fully covered by the union of `list`? */
export function isCovered(list: Interval[], t: Interval): boolean {
  if (isEmptyInterval(t)) return true;
  const sorted = [...list].filter((i) => !isEmptyInterval(i)).sort((a, b) => a.lo - b.lo || Number(b.loInc) - Number(a.loInc));
  let v = t.lo, inc = t.loInc; // first point still needing cover
  const done = () => v > t.hi || (v === t.hi && (!inc || !t.hiInc));
  if (done()) return true;
  for (const i of sorted) {
    const startsInTime = i.lo < v || (i.lo === v && (i.loInc || !inc));
    if (!startsInTime) break;
    const progresses = i.hi > v || (i.hi === v && i.hiInc && inc);
    if (progresses) { v = i.hi; inc = !i.hiInc; if (done()) return true; }
  }
  return done();
}

const needsValue = (r: ConditionRule) => {
  const a = OPERATOR_META[r.op]?.arity;
  if (a === 0) return false;
  if (r.value_ref) return false;
  if (a === "list") return asList(r.value).length === 0;
  if (a === 2) return isEmptyValue(r.value) || isEmptyValue(r.value2);
  return isEmptyValue(r.value);
};

export function validateDefinition(
  blocks: Block[],
  fields: Map<string, WorkflowField>,
  validateStep?: (step: StepData) => string | null,
): Issue[] {
  const issues: Issue[] = [];
  const err = (message: string, block_id?: string) => issues.push({ severity: "error", block_id, message });
  const warn = (message: string, block_id?: string) => issues.push({ severity: "warning", block_id, message });

  // ids unique
  const seen = new Set<string>();
  walk(blocks, (b) => { if (seen.has(b.id)) err(`Duplicate block id ${b.id}`, b.id); seen.add(b.id); });

  const declared = new Set(declaredVariables(blocks).map((v) => v.id));

  const checkGroup = (g: ConditionGroup, blockId: string, where: string) => {
    if (g.children.length === 0) { err(`${where}: condition is empty.`, blockId); return; }
    for (const c of g.children) {
      if (c.kind === "group") { checkGroup(c, blockId, where); continue; }
      if (!c.field_id) { err(`${where}: pick a field for every condition.`, blockId); continue; }
      const f = fields.get(c.field_id);
      if (!f && !declared.has(c.field_id)) { err(`${where}: field "${c.field_id}" no longer exists on this form.`, blockId); continue; }
      if (f && !OPERATORS_BY_TYPE[f.type].includes(c.op)) err(`${where}: "${OPERATOR_META[c.op]?.label}" can't be used with ${f.label}.`, blockId);
      if (needsValue(c)) err(`${where}: "${f?.label ?? c.field_id}" needs a value.`, blockId);
      if (f?.type === "money" && OPERATOR_META[c.op]?.arity !== 0 && !c.value_ref && !c.currency)
        err(`${where}: choose a currency for "${f.label}".`, blockId);
      if (c.value_ref && !fields.get(c.value_ref) && !declared.has(c.value_ref))
        err(`${where}: compared field "${c.value_ref}" no longer exists.`, blockId);
    }
  };

  walk(blocks, (b) => {
    if (b.kind === "approval" || b.kind === "notification") {
      const m = validateStep?.(b.step);
      if (m) err(m, b.id);
    }
    if (b.kind === "if_else") {
      if (b.branches.length === 0) err("IF block has no branches.", b.id);
      b.branches.forEach((br, i) => {
        const where = `${i === 0 ? "IF" : "ELSE IF"}${br.label ? ` "${br.label}"` : ""}`;
        checkGroup(br.when, b.id, where);
        if (br.blocks.length === 0) warn(`${where} branch is empty — matching documents skip straight past it.`, b.id);
      });
      // An empty ELSE is a legitimate "skip" (independent, stacked IFs rely on it), so it is not flagged.
      // The real safeguard is the "path finishes without any approval" check below.

      // Unreachable branches (numeric ranges on one field)
      const covered = new Map<string, Interval[]>();
      b.branches.forEach((br, i) => {
        const gi = groupInterval(br.when, fields);
        if (!gi) return;
        if (isEmptyInterval(gi.interval)) { warn(`Branch ${i + 1} can never match (its range is empty).`, b.id); return; }
        const prior = covered.get(gi.key) ?? [];
        if (prior.length && isCovered(prior, gi.interval)) warn(`Branch ${i + 1} is unreachable — earlier branches already match every value in its range.`, b.id);
        covered.set(gi.key, [...prior, gi.interval]);
      });
    }
    if (b.kind === "switch") {
      if (!b.field_id) err("SWITCH needs a field.", b.id);
      else if (!fields.get(b.field_id) && !declared.has(b.field_id)) err(`SWITCH field "${b.field_id}" no longer exists.`, b.id);
      const dupes = new Set<string>(); const all = new Set<string>();
      b.cases.forEach((c) => c.values.forEach((v) => { if (all.has(lc(v))) dupes.add(v); all.add(lc(v)); }));
      if (dupes.size) warn(`Value(s) ${[...dupes].join(", ")} appear in more than one case; the first case wins.`, b.id);
      b.cases.forEach((c, i) => { if (c.values.length === 0) err(`Case ${i + 1} has no values.`, b.id); });
    }
    if (b.kind === "set_value") {
      if (!b.variable.trim()) err("SET needs a variable name.", b.id);
      else if (!/^[a-z][a-z0-9_]*$/i.test(b.variable)) err(`Variable "${b.variable}" may only use letters, digits and underscores.`, b.id);
    }
  });

  // ── Approver actions ──
  let firstApproval = true;
  walk(blocks, (b) => {
    if (b.kind !== "approval") return;
    const nm = b.step.name || "Untitled";
    if (firstApproval && b.step.allow_return)
      warn(`"${nm}" is the first approval, so there is no previous step to return to. Use "Return to submitter" instead.`, b.id);
    firstApproval = false;
  });

  // Every path must either need an approval or end explicitly.
  const { paths, truncated } = enumeratePaths(blocks, fields);
  const bad = paths.filter((p) => p.terminal === "complete" && !p.legs.some((l) => l.kind === "approval"));
  if (blocks.length === 0) err("Add at least one block.");
  else if (bad.length) {
    const label = bad[0].conditions.join(" → ") || "the default path";
    err(`${bad.length} path(s) finish without any approval (e.g. ${label}). Add an approval or an explicit END.`);
  }
  if (truncated) warn(`More than ${MAX_PATHS} possible paths — consider simplifying the branching.`);
  return issues;
}

// ─────────────────────────────────────────────────────────────────────────────
// 10. Compile to an executable graph (what the backend engine walks)
// ─────────────────────────────────────────────────────────────────────────────

export type GraphNode =
  | { id: string; type: "approval"; order: number; step: StepData; next: string | null }
  | { id: string; type: "notification"; order: number; step: StepData; next: string | null }
  | { id: string; type: "set_value"; variable: string; value?: Scalar; value_ref?: string; next: string | null }
  | { id: string; type: "end"; outcome: "approved" | "rejected"; reason?: string }
  | { id: string; type: "if_else"; branches: { id: string; when: ConditionGroup; next: string | null }[]; else_next: string | null }
  | { id: string; type: "switch"; field_id: string; cases: { id: string; values: string[]; next: string | null }[]; default_next: string | null };

export interface CompiledGraph { start: string | null; nodes: Record<string, GraphNode> }

/**
 * `null` as a pointer means "workflow complete" — its outcome is Approved, because
 * every approval on the way was approved. A rejection never reaches `next`:
 * it completes the workflow as Rejected. A return (`allow_return` /
 * `allow_return_submitter` on the step) pauses the instance instead. A nested list's last
 * block points at whatever follows the parent block — no explicit join nodes.
 */
export function compileToGraph(blocks: Block[]): CompiledGraph {
  const nodes: Record<string, GraphNode> = {};
  const orderOf = new Map<string, number>();
  let n = 0;
  walk(blocks, (b) => { if (b.kind === "approval" || b.kind === "notification") orderOf.set(b.id, ++n); });

  const list = (bs: Block[], after: string | null): string | null => {
    let next = after;
    for (let i = bs.length - 1; i >= 0; i--) next = one(bs[i], next);
    return next;
  };
  const one = (b: Block, after: string | null): string => {
    switch (b.kind) {
      case "approval":
        nodes[b.id] = { id: b.id, type: "approval", order: orderOf.get(b.id)!, step: { ...b.step, order: orderOf.get(b.id)! }, next: after }; break;
      case "notification":
        nodes[b.id] = { id: b.id, type: "notification", order: orderOf.get(b.id)!, step: { ...b.step, order: orderOf.get(b.id)! }, next: after }; break;
      case "set_value":
        nodes[b.id] = { id: b.id, type: "set_value", variable: b.variable, value: b.value, value_ref: b.value_ref, next: after }; break;
      case "end":
        nodes[b.id] = { id: b.id, type: "end", outcome: b.outcome, reason: b.reason }; break;
      case "if_else":
        nodes[b.id] = { id: b.id, type: "if_else",
          branches: b.branches.map((br) => ({ id: br.id, when: br.when, next: list(br.blocks, after) })),
          else_next: list(b.else_blocks, after) }; break;
      case "switch":
        nodes[b.id] = { id: b.id, type: "switch", field_id: b.field_id,
          cases: b.cases.map((c) => ({ id: c.id, values: c.values, next: list(c.blocks, after) })),
          default_next: list(b.default_blocks, after) }; break;
    }
    return b.id;
  };
  return { start: list(blocks, null), nodes };
}

/** Flat list of every step in document order — for list views / legacy `step_count`. */
export function flattenSteps(blocks: Block[]): StepData[] {
  const out: StepData[] = [];
  walk(blocks, (b) => { if (b.kind === "approval" || b.kind === "notification") out.push({ ...b.step, order: out.length + 1 }); });
  return out;
}

/** Wrap legacy linear `steps` into a v2 definition (no branching). */
export function definitionFromSteps(steps: StepData[]): WorkflowDefinition {
  return {
    version: 2,
    blocks: [...steps].sort((a, b) => (a.order ?? 0) - (b.order ?? 0)).map((s) => ({
      kind: s.step_type === "notification" ? "notification" : "approval", id: uid(), step: { ...s },
    }) as Block),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 11. One-off migration: many templates + amount rules → one branched workflow
// ─────────────────────────────────────────────────────────────────────────────

export interface LegacyTemplate { id: string; name: string; steps: StepData[] }
export interface LegacyRule {
  template: string; phase?: string;
  amount_min: string | number; amount_max: string | number | null;
  currency: string; label?: string; is_active?: boolean;
}

export function migrateLegacyRules(
  templates: LegacyTemplate[],
  rules: LegacyRule[],
  opts: {
    /** Legacy engines differ on whether amount_max is inclusive. VERIFY against your backend. */
    maxInclusive?: boolean;
    /** Field the amount rules apply to. */
    amountFieldId?: string;
    /** Template to use if a document type had templates but no rules. */
    fallbackTemplateId?: string;
  } = {},
): { definition: WorkflowDefinition; notes: string[] } {
  const { maxInclusive = true, amountFieldId = "amount" } = opts;
  const notes: string[] = [];
  const tpl = new Map(templates.map((t) => [t.id, t]));
  const active = rules.filter((r) => r.is_active !== false && tpl.has(r.template));

  const stepsToBlocks = (t: LegacyTemplate): Block[] => definitionFromSteps(t.steps).blocks;

  const byPhase = new Map<string, LegacyRule[]>();
  for (const r of active) {
    const p = (r.phase || "request").toLowerCase();
    byPhase.set(p, [...(byPhase.get(p) ?? []), r]);
  }

  const chainFor = (rs: LegacyRule[]): Block[] => {
    const sorted = [...rs].sort((a, b) => Number(a.amount_min || 0) - Number(b.amount_min || 0));
    const ifelse = newIfElse();
    ifelse.branches = [];
    let openEnded: LegacyRule | null = null;
    const bands: { name: string; min: number; max: number | null }[] = [];

    for (const [i, r] of sorted.entries()) {
      const t = tpl.get(r.template)!;
      const name = r.label || t.name;
      const min = Number(r.amount_min || 0);
      let max = r.amount_max === null || r.amount_max === "" ? null : Number(r.amount_max);
      let inclusive = maxInclusive;
      if (max === null) {
        // An open-ended band is only the ELSE if nothing sits above it. Otherwise it stops where the next band starts
        // (previously every open-ended band but the last was silently dropped).
        const above = sorted.slice(i + 1).find((x) => Number(x.amount_min || 0) > min);
        if (!above) {
          if (openEnded) notes.push(`"${openEnded.label || tpl.get(openEnded.template)!.name}" and "${name}" both start at ${min} with no upper limit — only "${name}" was kept.`);
          openEnded = r; bands.push({ name, min, max: null }); continue;
        }
        max = Number(above.amount_min || 0); inclusive = false;
        notes.push(`"${name}" had no upper limit; it now stops where "${above.label || tpl.get(above.template)!.name}" starts (${max}).`);
      }
      bands.push({ name, min, max });
      const g = newGroup("and");
      if (min > 0) g.children.push({ ...newRule(amountFieldId, "gte"), value: min, currency: r.currency });
      g.children.push({ ...newRule(amountFieldId, inclusive ? "lte" : "lt"), value: max, currency: r.currency });
      ifelse.branches.push({ id: uid("br"), label: name, when: g, blocks: stepsToBlocks(t) });
    }

    // Sanity notes: amounts no band covers silently fall to ELSE, which is the *top* band's chain.
    if (bands.length && bands[0].min > 0) notes.push(`Amounts below ${bands[0].min} matched no rule; they now fall to the ELSE fallback.`);
    for (let i = 1; i < bands.length; i++) {
      const prev = bands[i - 1];
      if (prev.max !== null && bands[i].min > prev.max) notes.push(`Gap: amounts between ${prev.max} and ${bands[i].min} matched no rule; they now fall to the ELSE fallback.`);
      if (prev.max !== null && bands[i].min < prev.max) notes.push(`Overlap: "${prev.name}" and "${bands[i].name}" both cover ${bands[i].min}–${prev.max}; the earlier band wins.`);
    }
    if (openEnded) {
      // The top, unbounded band becomes the fallback: everything not caught above.
      ifelse.else_blocks = stepsToBlocks(tpl.get(openEnded.template)!);
      notes.push(`"${openEnded.label || tpl.get(openEnded.template)!.name}" (${openEnded.currency} ${openEnded.amount_min}+) became the ELSE fallback.`);
    }
    if (ifelse.branches.length === 0) return ifelse.else_blocks; // single unbounded rule → no IF needed
    return [ifelse];
  };

  if (byPhase.size === 0) {
    const t = opts.fallbackTemplateId ? tpl.get(opts.fallbackTemplateId) : templates[0];
    if (t) { notes.push("No active routing rules — used the primary template as-is."); return { definition: definitionFromSteps(t.steps), notes }; }
    return { definition: emptyDefinition(), notes: ["Nothing to migrate."] };
  }

  const currencies = new Set(active.map((r) => r.currency));
  if (currencies.size > 1) notes.push(`Rules use several currencies (${[...currencies].join(", ")}). Set exchange rates on the server so amount comparisons convert correctly.`);
  notes.push(maxInclusive ? "Upper bounds treated as inclusive (≤)." : "Upper bounds treated as exclusive (<).");

  if (byPhase.size === 1) return { definition: { version: 2, blocks: chainFor([...byPhase.values()][0]) }, notes };

  const sw = newSwitch("context.phase");
  sw.cases = [...byPhase.entries()].map(([phase, rs]) => ({ id: uid("case"), label: phase, values: [phase], blocks: chainFor(rs) }));
  return { definition: { version: 2, blocks: [sw] }, notes };
}