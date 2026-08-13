/**
 * TemplateBuilderV2.tsx — Enterprise template builder (v3)
 *
 * Major upgrades (v3.1):
 *  - Data Table no longer overflows the section: scrolls horizontally
 *    inside the field card with sticky add-column button.
 *  - Click ANY data cell or header cell in the table to open that column's
 *    configuration modal (UniFi behavior).
 *  - Section cards have higher contrast against the canvas (darker borders,
 *    tinted header strip, stronger title/description text).
 *  - AutoSave toggle in the top bar — when ON, edits debounce-save
 *    automatically (1.2s after the last change).
 *  - Field Library: UniFi-style grouped, collapsible, searchable palette
 *    (Input / Choice / Reference / Advanced / Layout) with per-group counts.
 *  - Wider canvas (max-w-6xl) and wider Inspector (400px).
 *  - Inspector now has "Field Properties" / "Advanced Properties"tabs
 *    (tooltip, default value, regex, min/max, min/maxLength, conditional
 *    visibility — "show this field only when X equals Y").
 *  - Data Table is no longer decorative: every column opens a FULL
 *    configuration modal — Label, ID, Mandatory, Additional text, Tooltip,
 *    Default value, Regular expression, type-specific config (dropdown
 *    values list w/ add/remove/reorder; number min/max; text min/maxLength;
 *    currency symbol; date format; reference source).
 *  - Inline column controls on the table card (label, type, width, reorder,
 *    duplicate, delete, configure).
 *  - Preview renders correctly typed inputs for every table column (dropdown
 *    becomes <select>, currency shows prefix, etc.) with validation.
 *
 * Backwards-compatible with your existing Template / TemplateField /
 * TableColumn shapes — only adds optional fields. `outputTemplate` still
 * normalizes back to width/help_text/type=boolean for your API.
 */

import { useState, useCallback, useMemo, useRef, useEffect } from "react";
import { useQueryClient, useMutation, useQuery } from "@tanstack/react-query";
import {
  DndContext, PointerSensor, useSensor, useSensors,
  useDraggable, useDroppable, DragOverlay,
  defaultDropAnimationSideEffects,
  type DragEndEvent, type DragStartEvent,
} from "@dnd-kit/core";
import { useForm, type UseFormRegister, type FieldErrors } from "react-hook-form";
import { toast } from "sonner";
import {
  ArrowLeft, Save, Undo2, Redo2, Eye, LayoutGrid, Settings,
  Plus, Trash2, GripVertical, Copy, Search, CheckCircle2,
  RotateCcw, Type, AlignLeft, Hash, Mail, Phone, Calendar,
  Clock, Pencil, List, CircleDot, CheckSquare, Paperclip,
  Image as ImageIcon, Table2, Heading, Minus, ChevronUp,
  ChevronDown, AlertCircle, Tag, Layers, ArrowRight,
  ChevronRight, X, Loader2, Sliders, Link2, User as UserIcon,
  Wrench, FileCode, Calculator, Star, Percent, Link as UrlIcon, ListOrdered,
  Info, Files, ToggleLeft, MoveLeft, MoveRight, CopyPlus, Sigma,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { documentTypesAPI, groupsAPI, workflowAPI } from "@/services/api";
import { FORMULA_OPTIONS } from "@/components/templates/formulas";
import { CURRENCY_CODES, currencySymbolFor } from "@/lib/currencies";
import JournalPayloadModal from "@/components/templates/JournalPayloadModal";

/* ============================================================
 * Types
 * ============================================================ */

export type FieldType =
  | "text" | "textarea" | "number" | "currency" | "date" | "datetime" | "time"
  | "select" | "radio" | "boolean" | "checkbox" | "email" | "phone"
  | "file" | "image" | "table" | "divider" | "heading" | "signature"
  | "reference" | "user" | "multi_select"
  | "url" | "percentage" | "rating" | "auto_number"
  | "multi_file"
  | "calc_number" | "calc_currency" | "calc_text" | "calc_date" | "calc_boolean"
  | "info" | "spacer";

/* Field types that are auto-derived rather than typed by the person filling
 * the form: calculated values (formula over sibling field keys) and the
 * auto-number shortcut (sugar for a read-only reference-number formula
 * field). Kept in one place so palette/newField/validation agree on which
 * types never need to be "required". */
const CALCULATED_TYPES = new Set<FieldType>(["calc_number", "calc_currency", "calc_text", "calc_date", "calc_boolean"]);

/* A field's calculation config. `expression` is a small arithmetic formula
 * referencing sibling fields by KEY (matches the server-side evaluator in
 * apps/templates_engine/conditions.py) — e.g. "total_days * daily_rate".
 * Supports + - * / (), unary +/-, and ROUND/ABS/MIN/MAX(...). Non-numeric or
 * missing sibling values resolve to 0; a malformed expression evaluates to 0
 * rather than throwing, both in the browser and on the server. */
export interface CalcConfig {
  expression: string;
  decimals?: number;
}

export type TableColumnType =
  | "text" | "textarea" | "number" | "currency" | "date" | "datetime" | "time"
  | "select" | "boolean" | "email" | "phone" | "reference" | "user" | "file"
  | "percentage" | "url" | "multi_select" | "image";

export interface TableColumn {
  id: string;
  key: string;
  label: string;
  required?: boolean;
  type?: TableColumnType;
  options?: string[];
  width?: number; // 1-12
  /* Extended (UniFi-style) */
  tooltip?: string;
  additionalText?: string;     // "Additional text" — helper shown beside label
  defaultValue?: string;
  regex?: string;
  min?: number;
  max?: number;
  minLength?: number;
  maxLength?: number;
  currencySymbol?: string;
  /* Number formatting (also applies when the column is shown as currency). */
  decimals?: number;
  thousandsSeparator?: boolean;
  // For a currency column: the KEY of a sibling column (a currency dropdown) in
  // the same table whose selected code drives this cell's symbol per row. When
  // set, `currencySymbol` is only the fallback for unknown codes.
  currencyFromColumn?: string;
  dateFormat?: string;
  referenceSource?: string;    // e.g. "users", "departments", "vendors"
  readonly?: boolean;
  hidden?: boolean;
  /* Conditional visibility/editability — same rule-group model as
   * TemplateField/TemplateSection (see RuleGroup below). Evaluated against
   * top-level form values + the current process step (NOT other cells in
   * the same row — a column is a single definition shared by every row, so
   * its visibility is necessarily table-wide, consistent with how a whole
   * SECTION's visibility works rather than per-field). `hidden`/`readonly`
   * above still cover the "always" cases; these cover the "only when…"
   * cases — e.g. hide a "Foreign Amount" column unless the currency field
   * isn't the local currency, or make a column editable only at a specific
   * workflow step. */
  visibleWhen?: RuleGroup | null;
  editableWhen?: RuleGroup | null;
  /* Calculated column value — same grammar/engine as TemplateField.calc, but
   * evaluated per table ROW: the scope is that row's other column values
   * plus every top-level form field (so a column formula can reference both
   * a sibling cell in its own row, e.g. `qty * unit_price`, and a form-level
   * field, e.g. `daily_subsistence_allowance` copied into every row — see
   * the UniFi "DSA Amount"column). Builder UI marks such columns read-only. */
  calc?: CalcConfig | null;
  /* SunSystems binding for table columns (journal line column roles). */
  sunsystems?: ColumnFinanceBinding;
}

/* SunSystems / finance bindings (see compileSunSystems). A field/column carries
 * a semantic role that the builder compiles into the journal + budget mapping. */
export interface FieldFinanceBinding {
  // Journal / header role (posting side) — see FINANCE_FIELD_ROLES.
  role?: string;
  dc?: "D" | "C";           // for role "journal_amount"
  account?: string;         // SunSystems account code for that line
  /** Offsetting (counter) account that automatically creates the balancing entry.
   *  e.g. set account=71001 dc=D counterAccount=10101 counterDc=C to get both
   *  legs of an imprest advance from a single amount field. */
  counterAccount?: string;
  counterDc?: "D" | "C";
  // Budget role (live-check side) — independent of the journal role, so one
  // amount field can both post a journal line AND be the budget-checked amount.
  // See FINANCE_BUDGET_ROLES. ("budget_amount"/"budget_account"were the old
  // combined `role` values; migrated to this on load — see normalizeField.)
  budgetRole?: string;
}
export interface ColumnFinanceBinding {
  role?: string;            // see FINANCE_COLUMN_ROLES
  account?: string;         // for role "account_code": a constant fallback account.
  // for role "line_amount": THIS line's own default/
  // fallback account (used when the table has no
  // separate "account_code"-role column).
  dc?: "D" | "C";           // for role "line_amount": this line's debit/credit
  // direction — settable right on the amount column
  // instead of only at the table level, so multiple
  // "line_amount" columns in one table can each pick
  // their own account + direction.
  analysisNumber?: number;  // for role "analysis" → AnalysisCode{n}
  /* Imprest/retirement reconciliation — only meaningful for role
   * "line_amount". When set, this column's total (summed across every row)
   * is compared against a top-level "issued/requested" amount field and
   * classified into exact/under/over spend, each emitting its own
   * configurable set of journal lines instead of one line per row. See
   * RetirementConfig below and compileSunSystems' table handling. */
  retirement?: RetirementConfig;
}

/* Where a retirement-scenario line's amount comes from: the original
 * issued/requested figure, the actual total spent (summed from the table's
 * amount column), or the absolute difference between the two. */
export type RetirementAmountSource = "issued" | "spent" | "variance";

export interface RetirementLine {
  account: string;
  dc: "D" | "C";
  amountSource: RetirementAmountSource;
}

export interface RetirementScenario {
  lines: RetirementLine[];
}

/* Imprest/retirement reconciliation config for a table's amount column.
 * Compares SUM(this column) against `issuedAmountField` (a top-level
 * number/currency field elsewhere on the form — e.g. the original advance/
 * imprest amount) and classifies the result into one of three scenarios,
 * each posting its own admin-configured set of lines rather than one line
 * per expense row:
 *   - exact — spent == issued
 *   - under — spent <  issued (money is returned)
 *   - over  — spent >  issued (the user is owed the difference)
 * The account codes, DC direction, and which amount (issued/spent/variance)
 * feeds each line are all configured here — see compileSunSystems, which
 * compiles this into the mapping the backend (apps/sunsystems/mapping.py
 * _expand_retirement_lines) interprets at posting time. */
export interface RetirementConfig {
  enabled: boolean;
  issuedAmountField?: string; // top-level field KEY holding the issued amount
  exact: RetirementScenario;
  under: RetirementScenario;
  over: RetirementScenario;
}

function emptyRetirementConfig(): RetirementConfig {
  return {
    enabled: true,
    exact: { lines: [{ account: "", dc: "C", amountSource: "issued" }, { account: "", dc: "D", amountSource: "spent" }] },
    under: { lines: [{ account: "", dc: "C", amountSource: "issued" }, { account: "", dc: "D", amountSource: "spent" }, { account: "", dc: "D", amountSource: "variance" }] },
    over: { lines: [{ account: "", dc: "C", amountSource: "spent" }, { account: "", dc: "D", amountSource: "spent" }, { account: "", dc: "D", amountSource: "variance" }, { account: "", dc: "C", amountSource: "variance" }] },
  };
}

export type ConditionOperator =
  | "equals" | "not_equals" | "is_empty" | "is_not_empty"
  | "greater_than" | "greater_or_equal" | "less_than" | "less_or_equal"
  | "between" | "not_between"
  | "contains" | "not_contains" | "starts_with" | "ends_with"
  | "in_list" | "not_in_list"
  | "is_true" | "is_false";

/* Operators that need no right-hand value at all. */
const VALUELESS_OPERATORS = new Set<ConditionOperator>(["is_empty", "is_not_empty", "is_true", "is_false"]);
/* Operators whose value is a two-part range ("100,500"). */
const RANGE_OPERATORS = new Set<ConditionOperator>(["between", "not_between"]);
/* Operators whose value is a comma-separated list. */
const LIST_OPERATORS = new Set<ConditionOperator>(["in_list", "not_in_list"]);

/* Legacy single-rule shape (pre rule-groups). Still read from older saved
 * templates and migrated into a one-condition RuleGroup on load (toRuleGroup). */
export interface ConditionalRule {
  fieldKey: string;   // sibling field's KEY
  operator: ConditionOperator;
  value?: string;
}

/* A single visibility condition. `source` selects what it tests:
 *  - "field":        a sibling field's value (by key)
 *  - "process_step": the document's current workflow status (status_label) */
export type ConditionSource = "field" | "process_step";
export interface VisibilityCondition {
  source: ConditionSource;
  fieldKey?: string;          // when source === "field"
  operator: ConditionOperator;
  value?: string;             // a field value, or a status_label for process_step
}

/* A group of conditions combined with AND/OR. A field/section is shown only when
 * the group evaluates true (an empty group = no restriction = always shown). */
export interface RuleGroup {
  combinator: "and" | "or";
  conditions: VisibilityCondition[];
  /* Optional NESTED groups, evaluated with this group's own combinator
   * alongside its plain conditions. Lets you express real-world rules like
   * "step = approved AND (amount > 5000 OR category = capital)"without a
   * separate rules language. Older templates simply have no `groups` key. */
  groups?: RuleGroup[];
}

/* Normalize any stored `visibleWhen` (legacy single rule, a group, or null) into
 * a RuleGroup. Idempotent — safe to run on every load. */
function toRuleGroup(v: unknown): RuleGroup | null {
  if (!v || typeof v !== "object") return null;
  const obj = v as Record<string, unknown>;
  if (Array.isArray(obj.conditions)) {
    const nested = Array.isArray(obj.groups)
      ? (obj.groups as unknown[]).map(toRuleGroup).filter((g): g is RuleGroup => !!g)
      : [];
    return {
      combinator: obj.combinator === "or" ? "or" : "and",
      conditions: (obj.conditions as VisibilityCondition[]).map((c) => ({
        source: c.source === "process_step" ? "process_step" : "field",
        fieldKey: c.fieldKey,
        operator: c.operator,
        value: c.value,
      })),
      ...(nested.length ? { groups: nested } : {}),
    };
  }
  if (typeof obj.fieldKey === "string") {
    return {
      combinator: "and",
      conditions: [{ source: "field", fieldKey: obj.fieldKey as string, operator: obj.operator as ConditionOperator, value: obj.value as string | undefined }],
    };
  }
  return null;
}

const OPERATOR_LABEL: Record<ConditionOperator, string> = {
  equals: "=", not_equals: "≠", is_empty: "is empty", is_not_empty: "is not empty",
  greater_than: ">", greater_or_equal: "≥", less_than: "<", less_or_equal: "≤",
  between: "between", not_between: "not between",
  contains: "contains", not_contains: "does not contain",
  starts_with: "starts with", ends_with: "ends with",
  in_list: "is one of", not_in_list: "is not one of",
  is_true: "is ticked", is_false: "is not ticked",
};

/* Grouped operator menu, so the dropdown stays readable as the list grows. */
const OPERATOR_GROUPS: Array<{ label: string; ops: ConditionOperator[] }> = [
  { label: "Basic", ops: ["equals", "not_equals", "is_empty", "is_not_empty"] },
  { label: "Numbers & dates", ops: ["greater_than", "greater_or_equal", "less_than", "less_or_equal", "between", "not_between"] },
  { label: "Text", ops: ["contains", "not_contains", "starts_with", "ends_with"] },
  { label: "Lists", ops: ["in_list", "not_in_list"] },
  { label: "Yes / No", ops: ["is_true", "is_false"] },
];

function summarizeCondition(c: VisibilityCondition): string {
  const left = c.source === "process_step" ? "step" : (c.fieldKey || "field");
  const op = OPERATOR_LABEL[c.operator] ?? c.operator;
  if (VALUELESS_OPERATORS.has(c.operator)) return `${left} ${op}`;
  if (RANGE_OPERATORS.has(c.operator)) {
    const [lo = "?", hi = "?"] = (c.value ?? "").split(",");
    return `${left} ${op} ${lo.trim()}–${hi.trim()}`;
  }
  return `${left} ${op} ${c.value ?? ""}`.trim();
}

function summarizeRuleGroup(g?: RuleGroup | null): string {
  if (!g) return "";
  const parts = [
    ...g.conditions.map(summarizeCondition),
    ...(g.groups ?? []).filter((n) => ruleGroupHasConditions(n)).map((n) => `(${summarizeRuleGroup(n)})`),
  ];
  if (!parts.length) return "";
  return parts.join(g.combinator === "or" ? " OR " : " AND ");
}

function ruleGroupHasConditions(g?: RuleGroup | null): boolean {
  if (!g) return false;
  return g.conditions.length > 0 || (g.groups ?? []).some(ruleGroupHasConditions);
}

export interface TemplateField {
  id: string;
  key: string;
  type: FieldType;
  label: string;
  placeholder?: string;
  helpText?: string;
  help_text?: string;
  required?: boolean;
  options?: string[];
  colSpan?: number;
  width?: number;
  columns?: TableColumn[];
  defaultValue?: string;
  minRows?: number;
  /* Extended */
  tooltip?: string;
  additionalText?: string;
  regex?: string;
  min?: number;
  max?: number;
  minLength?: number;
  maxLength?: number;
  currencySymbol?: string;     // fixed / fallback symbol for a currency field
  /* Number formatting — shared by number and currency fields. `decimals`
   * fixes the displayed precision; `thousandsSeparator` groups by 3. */
  decimals?: number;
  thousandsSeparator?: boolean;
  // For a currency field: the KEY of a sibling field (a currency dropdown) whose
  // selected code drives the symbol dynamically. When set, `currencySymbol` is
  // only the fallback used if the selected value isn't a known currency code.
  currencyFromField?: string;
  dateFormat?: string;
  referenceSource?: string;
  formula?: string;            // auto-fill formula, e.g. "current_user", "now"
  /* Calculated value — when set, this field is auto-derived from sibling
   * field keys (see CalcConfig) instead of typed by the person filling the
   * form. Builder UI marks such fields read-only by convention; the server
   * (apps/templates_engine/conditions.py compute_calculated_values) is the
   * authoritative source of the final value regardless of client state. */
  calc?: CalcConfig | null;
  readonly?: boolean;
  /* Editability — `readonly` = always read-only; `editableWhen` = editable only
   * when the rule group matches (read-only otherwise). Absent = editable. */
  editableWhen?: RuleGroup | null;
  hidden?: boolean;
  visibleWhen?: RuleGroup | null;
  /* SunSystems binding (journal line / budget / header role). */
  sunsystems?: FieldFinanceBinding;
}

/* The header/connection config the SunSystems settings card edits. The journal
 * + budget mappings sent to the backend are *compiled* from this plus the field
 * bindings (compileSunSystems); this is the editable source of truth. */
export interface SunSystemsUi {
  journalEnabled?: boolean;
  postingKind?: "journal" | "purchase_order";
  journalStages?: {
    stage: number;
    label?: string;
    postOn?: string;
    /** Keys of fields/tables whose lines belong to this stage.
     *  When empty/absent, all journal-bound fields are used (single-stage compat). */
    fieldKeys?: string[];
  }[];
  budgetEnabled?: boolean;
  budgetMode?: "warn" | "block";
  businessUnit?: string;
  budgetCode?: string;
  journalType?: string;
  postingType?: string;
  parameters?: { name: string; value: string }[];
  currencyConst?: string;
  dateFormat?: string;
  validateBalance?: boolean;
  supplierCode?: string;
  purchaseTransactionType?: string;
  invoiceAddressCode?: string;
  itemCode?: string;
  accountCode?: string;
  analysis10Category?: string;
  analysis10Code?: string;
  /** Fixed order quantity (default "1"). Blank = use the backend default. */
  quantity?: string;
  /** Fixed unit price. Blank = derived from total amount (qty-1 pattern). */
  unitPrice?: string;
  /** VLAB label number for the base/quantity value line (default "1"). */
  vlabBase?: string;
  /** VLAB label number for the transaction/amount value line (default "2"). */
  vlabTrans?: string;
}
export interface SunSystemsConfig {
  ui?: SunSystemsUi;
  journal?: Record<string, unknown>;
  budget?: Record<string, unknown>;
  connection?: Record<string, unknown>;
}

export interface TemplateSection {
  id: string;
  title: string;
  description?: string;
  fields: TemplateField[];
  collapsible?: boolean;
  /* Visibility — mirrors the per-field model. `hidden` always hides the whole
   * section (and its fields); `visibleWhen` shows it only when a field matches;
   * `visibleToGroups` restricts the section to members of the listed RBAC groups
   * (empty/absent = everyone). The three are mutually-exclusive modes in the UI. */
  hidden?: boolean;
  visibleWhen?: RuleGroup | null;
  visibleToGroups?: SectionGroupRef[];
  /* Editability (cascades to the section's fields). `readonly` = always
   * read-only; `editableWhen` = editable only when the rule group matches. */
  readonly?: boolean;
  editableWhen?: RuleGroup | null;
}

/* A reference to an RBAC group a section is restricted to. `id` is canonical
 * (matched server-side); `name` is the label + the client-side match key (the
 * auth payload only carries group names). */
export interface SectionGroupRef {
  id: string;
  name: string;
}

export interface Template {
  id?: string;
  name: string;
  description?: string;
  type: "built" | "uploaded";
  category?: string;
  tags?: string[];
  document_type_id?: string;
  file_url?: string;
  placeholders?: string[];
  created_at?: string;
  updated_at?: string;
  created_by?: { full_name: string };
  use_count?: number;
  sections: TemplateSection[];
  sunsystems?: SunSystemsConfig;
}

export type EditableTemplate = Omit<Template, "type"> & { type?: Template["type"] };

type FieldGroup = "input" | "choice" | "reference" | "advanced" | "calculated" | "layout";

const FIELD_META: Record<FieldType, { label: string; group: FieldGroup; defaults: Partial<TemplateField>; hint?: string }> = {
  text: { label: "Short text", group: "input", defaults: { colSpan: 6, placeholder: "Enter text…" } },
  textarea: { label: "Long text", group: "input", defaults: { colSpan: 12, placeholder: "Write something…" } },
  number: { label: "Number / Currency", group: "input", defaults: { colSpan: 4, placeholder: "0", decimals: 0, thousandsSeparator: true }, hint: "Turn on “Show as currency” in the inspector for money values" },
  // Currency stays a valid stored type for existing templates, but it is not
  // offered separately in the palette — it is a Number with currency format.
  currency: { label: "Currency", group: "input", defaults: { colSpan: 4, placeholder: "0.00", currencySymbol: "KSh", decimals: 2, thousandsSeparator: true } },
  date: { label: "Date", group: "input", defaults: { colSpan: 4, dateFormat: "YYYY-MM-DD" } },
  datetime: { label: "Date & Time", group: "input", defaults: { colSpan: 6 } },
  time: { label: "Time", group: "input", defaults: { colSpan: 4 } },
  email: { label: "Email", group: "input", defaults: { colSpan: 6, placeholder: "name@company.com" } },
  phone: { label: "Phone", group: "input", defaults: { colSpan: 4, placeholder: "+254 700 000000" } },
  select: { label: "Dropdown", group: "choice", defaults: { colSpan: 6, options: ["Option 1", "Option 2"] } },
  multi_select: { label: "Multi-select", group: "choice", defaults: { colSpan: 6, options: ["Option 1", "Option 2"] } },
  radio: { label: "Radio group", group: "choice", defaults: { colSpan: 6, options: ["Yes", "No"] } },
  boolean: { label: "Checkbox", group: "choice", defaults: { colSpan: 6 } },
  // Legacy alias of `boolean`; kept for stored templates, hidden from the palette.
  checkbox: { label: "Checkbox", group: "choice", defaults: { colSpan: 6 } },
  reference: { label: "Reference", group: "reference", defaults: { colSpan: 6, referenceSource: "documents" }, hint: "Links to another document/record" },
  user: { label: "User picker", group: "reference", defaults: { colSpan: 6, referenceSource: "users" } },
  signature: { label: "Signature", group: "advanced", defaults: { colSpan: 12 } },
  file: { label: "File upload", group: "advanced", defaults: { colSpan: 6 } },
  image: { label: "Image", group: "advanced", defaults: { colSpan: 6 } },
  table: { label: "Data table", group: "advanced", defaults: { colSpan: 12, minRows: 2 } },
  url: { label: "URL / Link", group: "input", defaults: { colSpan: 6, placeholder: "https://…" } },
  percentage: { label: "Percentage", group: "input", defaults: { colSpan: 4, placeholder: "0", min: 0, max: 100 } },
  rating: { label: "Rating", group: "choice", defaults: { colSpan: 4, max: 5 }, hint: "Star rating, 1–5 by default" },
  auto_number: { label: "Auto Number", group: "calculated", defaults: { colSpan: 4 }, hint: "Auto-populated with the document's reference number" },
  calc_number: { label: "Calculated Number", group: "calculated", defaults: { colSpan: 4 }, hint: "Computed from a formula over other fields" },
  calc_currency: { label: "Calculated Currency", group: "calculated", defaults: { colSpan: 4, currencySymbol: "KSh" }, hint: "Computed from a formula over other fields" },
  calc_text: { label: "Calculated Text", group: "calculated", defaults: { colSpan: 6 }, hint: "Computed from a formula over other fields" },
  calc_date: { label: "Calculated Date", group: "calculated", defaults: { colSpan: 4, dateFormat: "YYYY-MM-DD" }, hint: "Computed from a formula over other fields" },
  calc_boolean: { label: "Calculated Yes/No", group: "calculated", defaults: { colSpan: 4 }, hint: "A rule that resolves to Yes or No, e.g. amount > limit" },
  multi_file: { label: "Multiple files", group: "advanced", defaults: { colSpan: 12 }, hint: "Several supporting attachments on one field" },
  heading: { label: "Heading", group: "layout", defaults: { colSpan: 12, defaultValue: "Section heading" } },
  divider: { label: "Divider", group: "layout", defaults: { colSpan: 12 } },
  info: { label: "Info note", group: "layout", defaults: { colSpan: 12, defaultValue: "Guidance for the person filling this form." }, hint: "Read-only guidance — never submitted" },
  spacer: { label: "Spacer", group: "layout", defaults: { colSpan: 6 }, hint: "Empty gap for aligning fields on a row" },
};

const ICONS: Record<FieldType, React.ElementType> = {
  text: Type, textarea: AlignLeft, number: Hash, currency: Hash,
  date: Calendar, datetime: Calendar, time: Clock, select: List,
  multi_select: List, radio: CircleDot, boolean: CheckSquare, checkbox: CheckSquare,
  signature: Pencil, email: Mail, phone: Phone, file: Paperclip,
  image: ImageIcon, table: Table2, heading: Heading, divider: Minus,
  reference: Link2, user: UserIcon,
  url: UrlIcon, percentage: Percent, rating: Star, auto_number: ListOrdered,
  calc_number: Calculator, calc_currency: Calculator, calc_text: Calculator, calc_date: Calculator,
  calc_boolean: Sigma, multi_file: Files, info: Info, spacer: Minus,
};

/* Presentational-only field types. They never hold a value, so they're
 * skipped by the payload preview, can't be marked required, and never
 * appear as a formula/condition source. */
const PRESENTATION_TYPES = new Set<FieldType>(["heading", "divider", "info", "spacer"]);

const uid = () => Math.random().toString(36).slice(2, 10);

function slugify(s: string) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 50);
}

/* Same normalization as slugify() but used while the person is actively
 * typing an ID (field key / column key). slugify() trims a trailing
 * underscore on every call, which — re-run on every keystroke via a
 * controlled input — made it impossible to type "expense_"at all: the
 * underscore was stripped the instant it became the last character, and
 * only "stuck"once a further character pushed it out of trailing position.
 * This variant collapses invalid runs to a single underscore but never
 * trims leading/trailing underscores, so what you type is what you get. */
function slugifyLive(s: string) {
  return s.toLowerCase().replace(/[^a-z0-9_]+/g, "_").slice(0, 50);
}

function toDocTypeCode(name: string) {
  return name.toUpperCase().trim().replace(/\s+/g, "_").replace(/[^A-Z0-9_]/g, "").replace(/_+/g, "_").replace(/^_|_$/g, "");
}

/* Every freshly-created field/column key ends in "_xxxx" (a 4-char random
 * suffix from uid().slice(0,4) — see newField/newColumn below). As long as
 * a key still has that shape, it's presumed to be an unclaimed auto-default
 * that nothing references yet, so the ID input can safely keep following
 * the Label as the admin types (see the "auto-sync ID from label" behavior
 * in FieldEditor / ColumnConfigModal). The moment someone edits the ID
 * directly, or the key no longer matches this shape, auto-sync stops —
 * otherwise renaming an already-in-use field would silently break every
 * formula/reference pointing at its old key. */
const AUTO_KEY_SUFFIX_RE = /_([a-z0-9]{4})$/;

function looksAutoGenerated(key: string): boolean {
  return AUTO_KEY_SUFFIX_RE.test(key || "");
}

/* Re-derive a key from a changing Label while auto-sync is active: keep the
 * existing random suffix (so the key doesn't jump around unpredictably)
 * and just re-slugify the label into the prefix. */
function deriveKeyFromLabel(label: string, existingKey: string): string {
  const m = existingKey?.match(AUTO_KEY_SUFFIX_RE);
  const suffix = m ? m[1] : uid().slice(0, 4);
  const base = slugifyLive(label).replace(/^_+|_+$/g, "") || "field";
  return `${base}_${suffix}`;
}

// Reference/user picker sources — must match the keys in
// frontend/src/components/templates/referenceSources.ts.
const REFERENCE_SOURCE_OPTIONS = [
  { value: "users", label: "Users" },
  { value: "groups", label: "Groups" },
  { value: "departments", label: "Departments" },
  { value: "documents", label: "Documents" },
  { value: "document_types", label: "Document types" },
];

// Field types that can carry an auto-fill formula (scalar inputs).
const FORMULA_FIELD_TYPES = new Set<string>([
  "text", "textarea", "email", "phone", "number", "date", "datetime", "time", "auto_number",
]);

/* ============================================================
 * Quick "create document type"modal — unchanged from v2
 * ============================================================ */
const QUICK_TITLE_FIELD_OPTIONS = [
  { key: "filename", label: "File name (default)" },
  { key: "title", label: "Document Name" },
  { key: "reference_number", label: "Reference Number" },
  { key: "supplier", label: "Supplier / Vendor" },
  { key: "amount", label: "Amount" },
  { key: "document_date", label: "Document Date" },
];

function CreateDocTypeQuickModal({
  onClose, onCreated,
}: {
  onClose: () => void;
  onCreated: (type: { id: string; name: string; code: string }) => void;
}) {
  const qc = useQueryClient();
  const [dname, setDname] = useState("");
  const [code, setCode] = useState("");
  const [refPrefix, setRefPrefix] = useState("");
  const [refPadding, setRefPadding] = useState(5);
  const [titleField, setTitleField] = useState("filename");
  const [desc, setDesc] = useState("");

  const iCls =
    "h-9 w-full border border-[#AEB5BB] bg-white px-3 text-sm text-[#1F2933] " +
    "placeholder:text-[#8C969E] outline-none focus:border-[#287EAD] focus:ring-1 focus:ring-[#287EAD]";

  const createMutation = useMutation({
    mutationFn: () =>
      documentTypesAPI.create({
        name: dname, code,
        reference_prefix: refPrefix,
        reference_padding: refPadding,
        title_field: titleField,
        description: desc,
        metadata_mode: "admin_defined",
        is_personal_type: false,
        metadata_fields: [],
        relationship_rules: [],
      }),
    onSuccess: ({ data }: { data: any }) => {
      qc.invalidateQueries({ queryKey: ["document-types"] });
      toast.success(`Document type "${dname}"created`);
      onCreated({ id: data.id, name: data.name, code: data.code });
    },
    onError: (err: any) => {
      const d = err?.response?.data;
      const msg = d
        ? Object.entries(d as Record<string, unknown>)
          .map(([f, m]) => `${f}: ${Array.isArray(m) ? m.join(", ") : String(m)}`)
          .join(" | ")
        : "Failed to create document type";
      toast.error(msg);
    },
  });

  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-md overflow-hidden border border-[#C8CDD2] bg-white shadow-2xl">
        <div className="flex items-start justify-between border-b border-[#1E6F99] bg-[#287EAD] px-5 py-3 text-white">
          <div>
            <p className="text-sm font-semibold">Create document type</p>
            <p className="mt-0.5 text-xs text-white/75">Metadata fields can be added later from Admin Document Types.</p>
          </div>
          <button onClick={onClose} className="mt-0.5 flex-shrink-0 p-1.5 text-white/70 hover:text-white">
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="p-5 space-y-4">
          <div className="space-y-1.5">
            <label className="text-xs font-semibold uppercase tracking-wider text-[#5E6870]">Display name <span className="text-red-400 normal-case font-normal">*</span></label>
            <input value={dname} onChange={(e) => { setDname(e.target.value); setCode(toDocTypeCode(e.target.value)); }} placeholder="e.g. Supplier Invoice" autoFocus className={iCls} />
          </div>
          <div className="space-y-1.5">
            <label className="text-xs font-semibold uppercase tracking-wider text-[#5E6870]">Code <span className="text-red-400 normal-case font-normal">*</span></label>
            <input value={code} onChange={(e) => setCode(e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, ""))} placeholder="e.g. INV" className={cn(iCls, "font-mono")} />
          </div>
          <div className="space-y-1.5">
            <label className="text-xs font-semibold uppercase tracking-wider text-[#5E6870]">Reference prefix <span className="text-red-400 normal-case font-normal">*</span></label>
            <input value={refPrefix} onChange={(e) => setRefPrefix(e.target.value.toUpperCase().replace(/\s+/g, "").replace(/[^A-Z0-9]/g, ""))} placeholder="e.g. INV" className={cn(iCls, "font-mono tracking-widest uppercase")} />
          </div>
          <div className="space-y-1.5">
            <label className="text-xs font-semibold uppercase tracking-wider text-[#5E6870]">Reference padding</label>
            <input type="number" min={3} max={8} value={refPadding} onChange={(e) => setRefPadding(Math.max(3, Math.min(8, Number(e.target.value))))} className={iCls} />
          </div>
          <div className="space-y-1.5">
            <label className="text-xs font-semibold uppercase tracking-wider text-[#5E6870]">Document title</label>
            <select value={titleField} onChange={(e) => setTitleField(e.target.value)} className={iCls}>
              {QUICK_TITLE_FIELD_OPTIONS.map((o) => <option key={o.key} value={o.key}>{o.label}</option>)}
            </select>
            <p className="text-[10px] text-[#8C969E]">Which field's value names documents of this type</p>
          </div>
          <div className="space-y-1.5">
            <label className="text-xs font-semibold uppercase tracking-wider text-[#5E6870]">Description <span className="normal-case font-normal text-[#8C969E]">(optional)</span></label>
            <textarea value={desc} onChange={(e) => setDesc(e.target.value)} rows={2} className={cn(iCls, "h-auto py-2 resize-none")} />
          </div>
        </div>
        <div className="flex justify-end gap-2 border-t border-[#C8CDD2] px-5 py-3">
          <button onClick={onClose} className="border border-[#AEB5BB] bg-white px-4 py-2 text-sm font-semibold text-[#1F2933] hover:bg-[#F3F5F6]">Cancel</button>
          <button onClick={() => createMutation.mutate()} disabled={!dname.trim() || !code.trim() || !refPrefix.trim() || createMutation.isPending}
            className="inline-flex items-center gap-2 bg-[#287EAD] px-4 py-2 text-sm font-semibold text-white hover:bg-[#1E6F99] disabled:opacity-50">
            {createMutation.isPending ? <><Loader2 className="h-4 w-4 animate-spin" /> Creating…</> : <><Plus className="h-4 w-4" /> Create type</>}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ============================================================
 * Factories
 * ============================================================ */

function cellPlaceholder(c: TableColumn): string {
  const t = c.type ?? "text";
  if (c.calc?.expression) return `ƒx = ${c.calc.expression}`;
  if (c.defaultValue) return c.defaultValue;
  switch (t) {
    case "number": return "0";
    case "currency": return `${c.currencySymbol ?? "KSh"} 0.00`;
    case "date": return c.dateFormat ?? "YYYY-MM-DD";
    case "datetime": return "YYYY-MM-DD HH:mm";
    case "time": return "HH:mm";
    case "select": return c.options?.[0] ? `${c.options[0]} ▾` : "Select… ▾";
    case "boolean": return "☐";
    case "email": return "name@example.com";
    case "phone": return "+254 …";
    case "reference": return `↗ ${c.referenceSource ?? "record"}`;
    case "user": return "👤 user";
    case "file": return "📎 file";
    case "textarea": return "Long text…";
    case "percentage": return "0 %";
    case "url": return "https://…";
    case "multi_select": return c.options?.[0] ? `${c.options[0]} +` : "Select many…";
    case "image": return "🖼 image";
    default: return "—";
  }
}

function newColumn(type: TableColumnType = "text", label = "New Column"): TableColumn {
  return {
    id: uid(),
    key: `${slugify(label)}_${uid().slice(0, 4)}`,
    label,
    type,
    width: 2,
    options: type === "select" || type === "multi_select" ? ["Option 1", "Option 2"] : undefined,
    currencySymbol: type === "currency" ? "KSh" : undefined,
    referenceSource: type === "reference" ? "documents" : type === "user" ? "users" : undefined,
  };
}

function newField(type: FieldType): TemplateField {
  const m = FIELD_META[type];
  const labelText = m.label;
  const base: TemplateField = {
    id: uid(),
    key: `${slugify(labelText)}_${uid().slice(0, 4)}`,
    type,
    label: labelText,
    colSpan: m.defaults.colSpan ?? 6,
    placeholder: m.defaults.placeholder,
    options: m.defaults.options ? [...m.defaults.options] : undefined,
    defaultValue: m.defaults.defaultValue,
    currencySymbol: m.defaults.currencySymbol,
    dateFormat: m.defaults.dateFormat,
    referenceSource: m.defaults.referenceSource,
    required: false,
  };
  if (type === "table") {
    // Start with a minimal, generic table. The builder lets the user rename
    // these, change their types, and add columns (including a file column for
    // per-row attachments). Avoid imposing a domain-specific stub.
    base.minRows = 1;
    base.columns = [
      newColumn("text", "Item"),
      newColumn("text", "Description"),
      newColumn("currency", "Amount"),
    ];
  }
  if (CALCULATED_TYPES.has(type)) {
    // Always read-only — the value comes from the formula, not typed input.
    base.readonly = true;
    base.calc = { expression: "", decimals: type === "calc_text" || type === "calc_date" ? undefined : 2 };
  }
  if (type === "auto_number") {
    // Sugar over the existing auto-fill formula mechanism: a read-only text
    // field that freezes to the document's assigned reference number at
    // submit time (see FORMULA_OPTIONS / apply_formulas).
    base.readonly = true;
    base.formula = "reference_number";
  }
  return base;
}

function newSection(title = "New Section"): TemplateSection {
  return { id: uid(), title, description: "", fields: [] };
}

const initialTemplate: Template = {
  name: "Untitled Template",
  description: "",
  type: "built",
  category: "other",
  tags: [],
  /* A brand-new template opens on ONE empty section — no domain-specific
   * sample fields to delete first. */
  sections: [newSection("Section 1")],
};

/* Migrate the legacy single-`role` budget tags onto the independent
 * `budgetRole` axis so a field can carry a journal role and a budget role at
 * once. Idempotent — runs whenever a template is (re)loaded into the builder. */
function migrateFinanceBinding(ss?: FieldFinanceBinding): FieldFinanceBinding | undefined {
  if (!ss) return ss;
  if (ss.role === "budget_amount") return { ...ss, role: undefined, budgetRole: ss.budgetRole ?? "amount" };
  if (ss.role === "budget_account") return { ...ss, role: undefined, budgetRole: ss.budgetRole ?? "account" };
  return ss;
}

function normalizeField(field: TemplateField): TemplateField {
  const type = field.type === "checkbox" ? "boolean" : field.type;
  const colSpan = field.colSpan ?? field.width ?? 6;
  const helpText = field.helpText ?? field.help_text;
  const key = field.key || `field_${uid()}`;
  const columns = (field.type === "table" || type === "table")
    ? (field.columns ?? [newColumn("text", "Item"), newColumn("number", "Amount")])
    : field.columns;
  const sunsystems = migrateFinanceBinding(field.sunsystems);
  const visibleWhen = toRuleGroup(field.visibleWhen);
  const editableWhen = toRuleGroup(field.editableWhen);
  return { ...field, type, key, colSpan, width: colSpan, helpText, columns, sunsystems, visibleWhen, editableWhen };
}

function normalizeTemplate(template: EditableTemplate): Template {
  const sections = Array.isArray(template.sections) ? template.sections : [];
  return {
    ...template,
    type: template.type ?? "built",
    category: template.category ?? "other",
    tags: template.tags ?? [],
    sections: sections.map((s) => ({
      ...s,
      visibleWhen: toRuleGroup(s.visibleWhen),
      editableWhen: toRuleGroup(s.editableWhen),
      fields: Array.isArray(s.fields) ? s.fields.map(normalizeField) : [],
    })),
  };
}

/* ── SunSystems finance bindings ──────────────────────────────────────────────
 * Field/column roles the inspector exposes, and the compiler that turns the
 * visual bindings + settings card into the declarative mapping the backend
 * (apps/sunsystems/mapping.py) consumes. */
// Journal / header roles (posting side). Budget roles live on a separate axis.
export const FINANCE_FIELD_ROLES = [
  { value: "", label: "— none —" },
  { value: "journal_amount", label: "Journal line amount" },
  { value: "currency", label: "Currency" },
  { value: "reference", label: "Transaction reference" },
  { value: "transaction_date", label: "Transaction date" },
  { value: "description", label: "Description" },
];
// Budget roles (live-check side) — independent of the journal role.
export const FINANCE_BUDGET_ROLES = [
  { value: "", label: "— none —" },
  { value: "amount", label: "Budget amount (checked)" },
  { value: "account", label: "Budget account / code" },
];
export const FINANCE_COLUMN_ROLES = [
  { value: "", label: "— none —" },
  { value: "line_amount", label: "Line amount" },
  { value: "account_code", label: "Account code" },
  { value: "description", label: "Description" },
  { value: "analysis", label: "Analysis code" },
];

/* A field's budget role, tolerating the legacy combined `role` values
 * ("budget_amount"/"budget_account") in case a template wasn't re-saved. */
function budgetRoleOf(field: TemplateField): string {
  const ss = field.sunsystems;
  if (!ss) return "";
  if (ss.budgetRole) return ss.budgetRole;
  if (ss.role === "budget_amount") return "amount";
  if (ss.role === "budget_account") return "account";
  return "";
}

function tableHasJournalAmountColumn(field: TemplateField): boolean {
  return field.type === "table" && (field.columns ?? []).some((c) => c.sunsystems?.role === "line_amount");
}

function isJournalLineSource(field: TemplateField): boolean {
  if (field.type === "table") {
    return field.sunsystems?.role === "journal_lines" || tableHasJournalAmountColumn(field);
  }
  return field.sunsystems?.role === "journal_amount";
}

function valueSpec(field?: { key: string } | null, opts?: { format?: string }) {
  return field ? { field: field.key, ...(opts?.format ? { format: opts.format } : {}) } : undefined;
}

/* Placeholder values for the builder's payload preview (no real form data yet).
 * Mirrors the value shape the compiled mapping expects: header fields keyed by
 * field key, tables as arrays of column-keyed rows. */
function sampleScalar(f: { type: FieldType; label: string; options?: string[]; defaultValue?: string }): string | number {
  if (f.defaultValue) return f.defaultValue;
  switch (f.type) {
    case "number": case "currency": return 100;
    case "date": return new Date().toISOString().slice(0, 10);
    case "datetime": return new Date().toISOString().slice(0, 16);
    case "time": return "09:00";
    case "select": case "radio": case "multi_select": return f.options?.[0] ?? "Sample";
    case "boolean": case "checkbox": return "true";
    case "email": return "sample@example.com";
    default: return f.label || "Sample";
  }
}

function buildSampleValues(template: Template): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const skip = new Set(["divider", "heading", "info", "spacer", "file", "image", "multi_file", "signature"]);
  for (const s of template.sections) {
    for (const f of s.fields ?? []) {
      if (!f.key) continue;
      if (f.type === "table") {
        const row: Record<string, unknown> = {};
        for (const c of f.columns ?? []) {
          row[c.key] = (c.type === "number" || c.type === "currency") ? 100 : (c.label || "Item");
        }
        out[f.key] = [row, { ...row }];
      } else if (!skip.has(f.type)) {
        out[f.key] = sampleScalar(f);
      }
    }
  }
  return out;
}

function compileSunSystems(template: Template): SunSystemsConfig | undefined {
  const ss = template.sunsystems ?? {};
  const ui: SunSystemsUi = ss.ui ?? {};
  if (!ui.journalEnabled && !ui.budgetEnabled) return ss;

  const fields = template.sections.flatMap((s) => s.fields ?? []);
  const byRole = (role: string) => fields.find((f) => f.sunsystems?.role === role);

  const currencyField = byRole("currency");
  const currencySpec = valueSpec(currencyField) ?? (ui.currencyConst ? { const: ui.currencyConst } : undefined);
  const referenceSpec = valueSpec(byRole("reference"));
  const dateSpec = valueSpec(byRole("transaction_date"), { format: ui.dateFormat || "DDMMYYYY" });
  const descSpec = valueSpec(byRole("description"));
  const postingKind = ui.postingKind ?? "journal";

  // Journal lines: header amount fields + table "journal_lines"repeat blocks.
  // Each entry carries a hidden _fieldKey so per-stage fieldKeys filters can match.
  const lines: Record<string, unknown>[] = [];
  for (const f of fields) {
    const b = f.sunsystems ?? {};
    if (f.type !== "table" && b.role === "journal_amount") {
      // Primary line
      lines.push({
        _fieldKey: f.key,
        account: { const: b.account ?? "" },
        dc: b.dc ?? "D",
        amount: { field: f.key },
        ...(descSpec ? { description: descSpec } : {}),
      });
      // Counter (offsetting) line — automatic double-entry when counterAccount is set.
      // e.g. Dr 71001 advance_amount → also Cr 10101 same amount (imprest advance).
      if (b.counterAccount) {
        const counterDc = b.counterDc ?? (b.dc === "D" ? "C" : "D");
        lines.push({
          _fieldKey: f.key,
          account: { const: b.counterAccount },
          dc: counterDc,
          amount: { field: f.key },
          ...(descSpec ? { description: descSpec } : {}),
        });
      }
    }
    if (f.type === "table" && isJournalLineSource(f)) {
      const cols = f.columns ?? [];
      const amountCol = cols.find((c) => c.sunsystems?.role === "line_amount");
      if (!amountCol) continue;
      const retirement = amountCol.sunsystems?.retirement;
      if (retirement?.enabled) {
        // Imprest/retirement reconciliation: post a fixed set of lines based
        // on comparing SUM(this column) against an issued/requested amount,
        // instead of one line per expense row. See RetirementConfig's
        // docstring and apps/sunsystems/mapping.py's _expand_retirement_lines,
        // which interprets this exact shape at posting time.
        const toScenario = (s: RetirementScenario) => ({
          lines: s.lines.map((l) => ({
            account: { const: l.account ?? "" },
            dc: l.dc ?? "D",
            amount_source: l.amountSource ?? "spent",
          })),
        });
        lines.push({
          _fieldKey: f.key,
          retirement: {
            issued_amount: retirement.issuedAmountField ? { field: retirement.issuedAmountField } : { const: "0" },
            spent_amount: { table: f.key, column: amountCol.key },
            scenarios: {
              exact: toScenario(retirement.exact),
              under: toScenario(retirement.under),
              over: toScenario(retirement.over),
            },
          },
        });
        continue;
      }
      const acctCol = cols.find((c) => c.sunsystems?.role === "account_code");
      const descCol = cols.find((c) => c.sunsystems?.role === "description");
      const analysis: Record<string, unknown> = {};
      for (const c of cols.filter((c) => c.sunsystems?.role === "analysis")) {
        analysis[String(c.sunsystems?.analysisNumber ?? 1)] = { row_field: c.key };
      }
      lines.push({
        _fieldKey: f.key,
        repeat_over: f.key,
        // The amount column's OWN account/DC (settable right on the column,
        // per the "Debit / Credit" + "Default account" fields shown when its
        // role is "Line amount") take priority; the table-level default
        // (set via the table field's Journal role card) is the fallback for
        // templates that haven't been re-configured since this was added.
        account: acctCol ? { row_field: acctCol.key } : { const: amountCol.sunsystems?.account ?? b.account ?? "" },
        dc: amountCol.sunsystems?.dc ?? b.dc ?? "D",
        amount: { row_field: amountCol.key },
        description: descCol ? { row_field: descCol.key } : descSpec,
        ...(Object.keys(analysis).length ? { analysis } : {}),
      });
    }
  }

  const parameters: Record<string, string> = {};
  if (ui.journalType) parameters.JournalType = ui.journalType;
  if (ui.postingType) parameters.PostingType = ui.postingType;
  for (const p of ui.parameters ?? []) if (p.name) parameters[p.name] = p.value;

  const journalStageBase = {
    component: "Journal",
    method: "Import",
    context: {
      ...(ui.businessUnit ? { business_unit: { const: ui.businessUnit } } : {}),
      ...(ui.budgetCode ? { budget_code: { const: ui.budgetCode } } : {}),
    },
    parameters,
    ...(currencySpec ? { currency: currencySpec } : {}),
    ...(referenceSpec ? { reference: referenceSpec } : {}),
    ...(dateSpec ? { date: dateSpec } : {}),
    validate_balance: ui.validateBalance !== false,
    lines,
  };
  const configuredStages = (ui.journalStages ?? [])
    .filter((s) => Number(s.stage) > 0)
    .sort((a, b) => Number(a.stage) - Number(b.stage));
  const defaultJournalStages = [{ stage: 1, label: "Stage 1", postOn: "approved", fieldKeys: [] as string[] }];
  const isMultiStage = configuredStages.length > 1;

  const journalStages = (configuredStages.length ? configuredStages : defaultJournalStages).map((s) => {
    // Per-stage line filtering. Single-stage templates keep the old "all lines"
    // default; multi-stage templates require explicit assignment to avoid
    // accidentally posting the same source lines in every stage.
    const stageFieldKeys = s.fieldKeys?.length
      ? new Set(s.fieldKeys)
      : (isMultiStage ? new Set<string>() : null);
    const stageLines = stageFieldKeys
      ? lines.filter((l) => {
        const key = (l as any)._fieldKey as string | undefined;
        return key ? stageFieldKeys.has(key) : true;
      })
      : lines;
    return {
      ...journalStageBase,
      // Override lines with stage-filtered lines (drop internal _fieldKey).
      lines: stageLines.map(({ _fieldKey: _k, ...rest }: any) => rest),
      stage: Number(s.stage),
      ...(s.label ? { label: s.label } : {}),
      post_on: s.postOn || "approved",
    };
  });

  // When only one stage is configured, also expose a flat (non-stages) mapping
  // for the XML preview which expects a single-stage shape.
  void isMultiStage;

  const purchaseAmountField = byRole("journal_amount");
  const journal = ui.journalEnabled
    ? postingKind === "purchase_order"
      ? {
        enabled: true,
        post_on: "approved",
        component: "PurchaseOrder",
        method: "CreateOrAmend",
        context: {
          ...(ui.businessUnit ? { business_unit: { const: ui.businessUnit } } : {}),
          ...(ui.budgetCode ? { budget_code: { const: ui.budgetCode } } : {}),
        },
        ...(currencySpec ? { currency: currencySpec } : {}),
        ...(referenceSpec ? { reference: referenceSpec } : {}),
        ...(dateSpec ? { date: dateSpec } : {}),
        purchase_order: {
          supplier_code: { const: ui.supplierCode || "81105" },
          transaction_type: { const: ui.purchaseTransactionType || "ASSETS" },
          invoice_address_code: { const: ui.invoiceAddressCode || "0000000000" },
          item_code: { const: ui.itemCode || "ITM29" },
          account_code: { const: ui.accountCode || "" },
          analysis10_category: { const: ui.analysis10Category ?? "11" },
          analysis10_code: { const: ui.analysis10Code ?? "E" },
          // quantity / unit_price: only emit when the operator has set them;
          // the backend defaults quantity to "1"and unit_price to the total amount.
          ...(ui.quantity ? { quantity: { const: ui.quantity } } : {}),
          ...(ui.unitPrice ? { unit_price: { const: ui.unitPrice } } : {}),
          // VLAB numbers: only emit when explicitly set; backend defaults to 1 and 2.
          ...(ui.vlabBase ? { vlab_base_num: { const: ui.vlabBase } } : {}),
          ...(ui.vlabTrans ? { vlab_trans_num: { const: ui.vlabTrans } } : {}),
          ...(purchaseAmountField ? { amount: { field: purchaseAmountField.key } } : {}),
          ...(currencySpec ? { currency: currencySpec } : {}),
          ...(referenceSpec ? { reference: referenceSpec } : {}),
          ...(dateSpec ? { date: dateSpec } : {}),
          ...(descSpec ? { description: descSpec } : {}),
        },
      }
      : {
        enabled: true,
        stages: journalStages,
      }
    : { enabled: false };

  const byBudgetRole = (r: string) => fields.find((f) => budgetRoleOf(f) === r);
  const budget = ui.budgetEnabled
    ? {
      enabled: true,
      mode: ui.budgetMode ?? "warn",
      ...(valueSpec(byBudgetRole("account")) ? { account: valueSpec(byBudgetRole("account")) } : {}),
      ...(valueSpec(byBudgetRole("amount")) ? { amount: valueSpec(byBudgetRole("amount")) } : {}),
      ...(currencySpec ? { currency: currencySpec } : {}),
    }
    : { enabled: false };

  return { ...ss, ui, journal, budget };
}

function outputTemplate(template: Template, keepId: boolean): Template {
  const out = {
    ...template,
    type: template.type ?? "built",
    sunsystems: compileSunSystems(template),
    sections: template.sections.map((s) => ({
      ...s,
      fields: s.fields.map((f) => ({
        ...f,
        type: f.type === "checkbox" ? "boolean" : f.type,
        width: f.colSpan,
        help_text: f.helpText,
      })),
    })),
  };
  if (!keepId) {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { id, ...rest } = out;
    return rest as Template;
  }
  return out;
}

const inputCls =
  "h-9 w-full border border-[#AEB5BB] bg-white px-3 text-sm text-[#1F2933] " +
  "placeholder:text-[#8C969E] outline-none focus:border-[#287EAD] focus:ring-1 focus:ring-[#287EAD]";

/* ============================================================
 * Palette (UniFi-style grouped, collapsible, searchable)
 * ============================================================ */

function PaletteItem({ type }: { type: FieldType }) {
  const meta = FIELD_META[type];
  const Icon = ICONS[type];
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: `palette-${type}`,
    data: { source: "palette", fieldType: type },
  });
  return (
    <button
      ref={setNodeRef}
      {...listeners}
      {...attributes}
      type="button"
      title={meta.hint ?? meta.label}
      className={cn(
        "group flex w-full cursor-grab items-center gap-2.5 border border-transparent",
        "px-3 py-2 text-left text-sm transition-all cursor-grab active:cursor-grabbing",
        "hover:border-[#287EAD] hover:bg-[#EEF6FB]",
        isDragging && "opacity-30",
      )}
    >
      <Icon className="h-4 w-4 shrink-0 text-[#287EAD]" />
      <span className="font-medium text-[#1F2933]">{meta.label}</span>
    </button>
  );
}

const PALETTE_GROUPS: Array<{ key: FieldGroup; label: string }> = [
  { key: "input", label: "Input" },
  { key: "choice", label: "Choice / Dropdown" },
  { key: "reference", label: "Reference" },
  { key: "calculated", label: "Calculated" },
  { key: "advanced", label: "Advanced" },
  { key: "layout", label: "Layout" },
];

function Palette() {
  const [query, setQuery] = useState("");
  const [openGroups, setOpenGroups] = useState<Record<FieldGroup, boolean>>({
    input: true, choice: true, reference: false, calculated: false, advanced: false, layout: false,
  });
  // Types that exist only for backwards compatibility with saved templates:
  // `checkbox` duplicates `boolean`, and `currency` is now a Number with a
  // currency number-format. Showing them would double up the library.
  const HIDDEN_TYPES = new Set<FieldType>(["checkbox", "currency"]);
  const all = (Object.keys(FIELD_META) as FieldType[]).filter((t) => !HIDDEN_TYPES.has(t));
  const filtered = all.filter((t) =>
    FIELD_META[t].label.toLowerCase().includes(query.toLowerCase())
  );
  const isSearching = query.trim().length > 0;

  return (
    <aside className="flex h-full w-full flex-col overflow-hidden border-r border-[#C8CDD2] bg-[#F6F7F8]">
      <div className="border-b border-[#C8CDD2] px-3 pb-3 pt-3">
        <p className="mb-2 px-1 text-[10px] font-semibold uppercase tracking-widest text-[#5E6870]">Field Library</p>
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[#5E6870]" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search…"
            className="h-8 w-full border border-[#AEB5BB] bg-white pl-8 pr-2 text-sm text-[#1F2933] outline-none placeholder:text-[#8C969E] focus:border-[#287EAD]"
          />
        </div>
      </div>
      <div className="flex-1 overflow-y-auto py-2">
        {PALETTE_GROUPS.map((g) => {
          const items = filtered.filter((t) => FIELD_META[t].group === g.key);
          if (!items.length) return null;
          const open = isSearching || openGroups[g.key];
          return (
            <div key={g.key} className="mb-0.5">
              <button
                onClick={() => setOpenGroups((s) => ({ ...s, [g.key]: !s[g.key] }))}
                className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left transition hover:bg-white"
              >
                <span className="flex items-center gap-1.5">
                  <ChevronDown className={cn("h-3 w-3 text-[#5E6870] transition-transform", !open && "-rotate-90")} />
                  <span className="text-[11px] font-semibold uppercase tracking-wider text-[#1F2933]">{g.label}</span>
                </span>
                <span className="bg-[#E5E8EB] px-1.5 py-0.5 text-[10px] font-semibold text-[#5E6870]">{items.length}</span>
              </button>
              {open && (
                <div className="flex flex-col">
                  {items.map((t) => <PaletteItem key={t} type={t} />)}
                </div>
              )}
            </div>
          );
        })}
        {filtered.length === 0 && (
          <p className="pt-6 text-center text-sm text-[#5E6870]">No fields match</p>
        )}
      </div>
      <div className="border-t border-[#C8CDD2] px-3 py-3">
        <p className="border border-dashed border-[#AEB5BB] bg-white p-2.5 text-[11px] leading-relaxed text-[#5E6870]">
          Drag a field to any section drop zone. Resize using the right-edge handle.
        </p>
      </div>
    </aside>
  );
}

/* ============================================================
 * Field previews on canvas
 * ============================================================ */

function FieldPreview({ field, onConfigureColumn, onAddColumn, onRemoveColumn, onMoveColumn, onUpdateColumn }: {
  field: TemplateField;
  onConfigureColumn?: (colId: string) => void;
  onAddColumn?: () => void;
  onRemoveColumn?: (colId: string) => void;
  onMoveColumn?: (colId: string, dir: "left" | "right") => void;
  onUpdateColumn?: (colId: string, patch: Partial<TableColumn>) => void;
}) {
  const inputPreview = "h-8  border border-zinc-200 bg-white px-3 text-xs text-zinc-400 flex items-center";
  switch (field.type) {
    case "heading":
      return <div className="text-sm font-bold text-zinc-800">{field.label || "Heading"}</div>;
    case "divider":
      return <div className="h-px w-full bg-zinc-200 my-1" />;
    case "textarea":
      return <div className="h-14 border border-zinc-200 bg-white px-3 py-2 text-xs text-zinc-400">{field.placeholder || "Long text…"}</div>;
    case "boolean":
    case "checkbox":
      return (
        <label className="flex items-center gap-2 text-xs text-zinc-700">
          <span className="h-3.5 w-3.5 border border-zinc-300 bg-white flex-shrink-0" />
          {field.label}
        </label>
      );
    case "radio":
      return (
        <div className="flex flex-col gap-1">
          {(field.options ?? []).slice(0, 3).map((o) => (
            <label key={o} className="flex items-center gap-2 text-xs text-zinc-700">
              <span className="h-3 w-3 rounded-full border border-zinc-300" />{o}
            </label>
          ))}
        </div>
      );
    case "select":
    case "multi_select":
      return <div className={cn(inputPreview, "justify-between")}><span>{field.options?.[0] ?? "Select…"}</span><ChevronDown className="h-3 w-3" /></div>;
    case "reference":
      return <div className={cn(inputPreview, "justify-between")}><span className="flex items-center gap-1.5"><Link2 className="h-3 w-3" /> Choose {field.referenceSource ?? "record"}…</span></div>;
    case "user":
      return <div className={cn(inputPreview, "justify-between")}><span className="flex items-center gap-1.5"><UserIcon className="h-3 w-3" /> Select user…</span></div>;
    case "table": {
      const cols = field.columns ?? [];
      return (
        <div className="border border-[#AEB5BB] overflow-hidden bg-white">
          {/* Header bar */}
          <div className="flex items-center justify-between gap-2 border-b border-[#AEB5BB] bg-[#EEF6FB] px-3 py-2">
            <div className="flex items-center gap-1.5">
              <Table2 className="h-3.5 w-3.5 text-[#287EAD]" />
              <span className="text-[11px] font-semibold text-[#287EAD]">
                Data table — {cols.length} column{cols.length !== 1 ? "s" : ""}
              </span>
            </div>
            <button
              onClick={(e) => { e.stopPropagation(); onAddColumn?.(); }}
              className="flex items-center gap-1 border border-[#287EAD]/40 bg-white px-2 py-1 text-[10px] font-semibold text-[#287EAD] hover:bg-[#287EAD] hover:text-white transition-colors"
              title="Add column"
            >
              <Plus className="h-3 w-3" /> Add column
            </button>
          </div>
          {/* Scrollable table area */}
          <div className="overflow-x-auto">
            <div className="min-w-max">
              {/* Column headers */}
              <div className="flex border-b border-[#AEB5BB] bg-[#F0F2F4]">
                {cols.map((c, idx) => {
                  const ColIcon = ({
                    text: Type, textarea: AlignLeft, number: Hash, currency: Hash,
                    date: Calendar, datetime: Calendar, time: Clock, select: List,
                    boolean: CheckSquare, email: Mail, phone: Phone, reference: Link2,
                    user: UserIcon, file: Paperclip, image: ImageIcon, multi_select: List,
                    url: UrlIcon, percentage: Percent,
                  } as Record<TableColumnType, React.ElementType>)[(c.type ?? "text") as TableColumnType] ?? Type;
                  return (
                    <div
                      key={c.id}
                      onClick={(e) => { e.stopPropagation(); onConfigureColumn?.(c.id); }}
                      className="group/col w-[230px] flex-shrink-0 border-r border-[#C8CDD2] last:border-0 cursor-pointer hover:bg-[#D6EAF5] transition-colors"
                      title="Click to configure column"
                    >
                      <div className="flex items-center gap-2 px-3.5 py-3">
                        <ColIcon className="h-3.5 w-3.5 flex-shrink-0 text-[#287EAD]" />
                        <input
                          value={c.label}
                          onClick={(e) => e.stopPropagation()}
                          onChange={(e) => onUpdateColumn?.(c.id, { label: e.target.value })}
                          className="min-w-0 flex-1 truncate bg-transparent text-xs font-semibold text-[#1F2933] outline-none focus:bg-white focus:px-1"
                        />
                        {c.required && <span className="text-red-500 flex-shrink-0 text-[10px]">*</span>}
                        {c.calc?.expression && (
                          <span className="bg-emerald-50 px-1 py-0.5 text-[8px] font-bold text-emerald-700 border border-emerald-200 flex-shrink-0" title="Calculated column">ƒx</span>
                        )}
                        {c.hidden ? (
                          <span className="bg-slate-100 px-1 py-0.5 text-[8px] font-bold text-slate-500 border border-slate-300 flex-shrink-0" title="Column always hidden from people filling the form">hidden</span>
                        ) : ruleGroupHasConditions(c.visibleWhen) && (
                          <span className="bg-amber-50 px-1 py-0.5 text-[8px] font-bold text-amber-700 border border-amber-200 flex-shrink-0" title={`Column shows when ${summarizeRuleGroup(c.visibleWhen)}`}>cond</span>
                        )}
                        {c.readonly ? (
                          <span className="bg-slate-100 px-1 py-0.5 text-[8px] font-bold text-slate-500 border border-slate-300 flex-shrink-0" title="Column always read-only">read-only</span>
                        ) : ruleGroupHasConditions(c.editableWhen) && (
                          <span className="bg-violet-50 px-1 py-0.5 text-[8px] font-bold text-violet-700 border border-violet-200 flex-shrink-0" title={`Column editable when ${summarizeRuleGroup(c.editableWhen)}`}>edit-cond</span>
                        )}
                      </div>
                      {/* Column actions on hover */}
                      <div className="flex items-center gap-0.5 px-3.5 pb-2 opacity-0 transition group-hover/col:opacity-100">
                        <button onClick={(e) => { e.stopPropagation(); onConfigureColumn?.(c.id); }} title="Configure"
                          className="p-0.5 text-[#5E6870] hover:bg-[#287EAD]/10 hover:text-[#287EAD]">
                          <Wrench className="h-3 w-3" />
                        </button>
                        <button onClick={(e) => { e.stopPropagation(); onMoveColumn?.(c.id, "left"); }} disabled={idx === 0}
                          title="Move left" className="p-0.5 text-[#5E6870] hover:bg-[#287EAD]/10 disabled:opacity-20">
                          <ChevronUp className="h-3 w-3 -rotate-90" />
                        </button>
                        <button onClick={(e) => { e.stopPropagation(); onMoveColumn?.(c.id, "right"); }} disabled={idx === (cols.length) - 1}
                          title="Move right" className="p-0.5 text-[#5E6870] hover:bg-[#287EAD]/10 disabled:opacity-20">
                          <ChevronDown className="h-3 w-3 -rotate-90" />
                        </button>
                        <button onClick={(e) => { e.stopPropagation(); onRemoveColumn?.(c.id); }} title="Remove"
                          className="p-0.5 text-[#5E6870] hover:bg-red-50 hover:text-red-500">
                          <Trash2 className="h-3 w-3" />
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
              {/* Preview rows */}
              {Array.from({ length: Math.min(field.minRows ?? 2, 3) }).map((_, i) => (
                <div key={i} className="flex border-b border-[#E5E8EB] last:border-0">
                  {cols.map((c) => (
                    <div
                      key={c.id}
                      onClick={(e) => { e.stopPropagation(); onConfigureColumn?.(c.id); }}
                      className="w-[230px] flex-shrink-0 px-3.5 py-3 text-xs text-[#8C969E] border-r border-[#E5E8EB] last:border-0 cursor-pointer hover:bg-[#EEF6FB] hover:text-[#287EAD] transition-colors truncate"
                      title={`Click to configure "${c.label}"`}
                    >
                      {cellPlaceholder(c)}
                    </div>
                  ))}
                </div>
              ))}
              {cols.length === 0 && (
                <div className="px-4 py-6 text-center text-xs text-[#8C969E]">
                  No columns yet — click <strong className="text-[#287EAD]">Add column</strong> above to start.
                </div>
              )}
            </div>
          </div>
        </div>
      );
    }
    case "file":
    case "image":
      return <div className="flex h-10 items-center justify-center border border-dashed border-zinc-200 bg-zinc-50 text-xs text-zinc-400"><Paperclip className="h-3 w-3 mr-1.5" />Attach file</div>;
    case "signature":
      return <div className="flex h-12 items-center justify-center border border-dashed border-zinc-200 bg-zinc-50 text-xs text-zinc-400"><Pencil className="h-3 w-3 mr-1.5" />Signature</div>;
    case "currency":
      return <div className={cn(inputPreview, "gap-1")}><span className="text-zinc-500">{field.currencySymbol ?? "KSh"}</span>{field.placeholder || "0.00"}</div>;
    case "url":
      return <div className={cn(inputPreview, "gap-1.5")}><UrlIcon className="h-3 w-3 text-zinc-400" />{field.placeholder || "https://…"}</div>;
    case "percentage":
      return <div className={cn(inputPreview, "justify-between")}><span>{field.placeholder || "0"}</span><Percent className="h-3 w-3 text-zinc-400" /></div>;
    case "rating":
      return (
        <div className="flex items-center gap-0.5 text-zinc-200">
          {Array.from({ length: field.max ?? 5 }).map((_, i) => <Star key={i} className="h-4 w-4" />)}
        </div>
      );
    case "auto_number":
      return <div className={cn(inputPreview, "gap-1.5 italic")}><ListOrdered className="h-3 w-3 text-zinc-400" />Assigned on submit</div>;
    case "info":
      return (
        <div className="flex items-start gap-2 border border-sky-200 bg-sky-50 px-3 py-2 text-xs text-sky-800">
          <Info className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" />
          <span>{field.defaultValue || field.helpText || "Informational note"}</span>
        </div>
      );
    case "spacer":
      return <div className="h-8 border border-dashed border-zinc-200 bg-[repeating-linear-gradient(45deg,#F6F7F8,#F6F7F8_6px,#FFF_6px,#FFF_12px)]" />;
    case "multi_file":
      return (
        <div className="flex h-10 items-center justify-center border border-dashed border-zinc-200 bg-zinc-50 text-xs text-zinc-400">
          <Files className="h-3 w-3 mr-1.5" />Attach one or more files
        </div>
      );
    case "calc_number":
    case "calc_currency":
    case "calc_date":
    case "calc_text":
    case "calc_boolean":
      return (
        <div className={cn(inputPreview, "gap-1.5 bg-[#F0FBF6] border-emerald-200 text-emerald-700")}>
          <Calculator className="h-3 w-3 flex-shrink-0" />
          <span className="truncate">{field.calc?.expression ? `= ${field.calc.expression}` : "No formula set"}</span>
        </div>
      );
    default:
      return <div className={inputPreview}>{field.placeholder || ""}</div>;
  }
}

/* ============================================================
 * FieldCard (canvas)
 * ============================================================ */

function FieldCard({
  field, sectionId, isSelected, onSelect, onRemove, onDuplicate, onResize, rowWidth,
  onConfigureColumn, onAddColumn, onRemoveColumn, onMoveColumn, onUpdateColumn,
  onMoveField, isFirstField, isLastField,
}: {
  field: TemplateField; sectionId: string; isSelected: boolean;
  onSelect: () => void; onRemove: () => void; onDuplicate: () => void;
  onResize: (col: number) => void; rowWidth: number;
  onConfigureColumn: (colId: string) => void;
  onAddColumn: () => void;
  onRemoveColumn: (colId: string) => void;
  onMoveColumn: (colId: string, dir: "left" | "right") => void;
  /* Keyboard/click reordering within the section — drag-and-drop is fast for
   * a mouse user but unusable on a trackpad-less laptop or with a screen
   * reader, and impossible in a long section that scrolls. */
  onMoveField: (dir: "back" | "forward") => void;
  isFirstField: boolean;
  isLastField: boolean;
  onUpdateColumn: (colId: string, patch: Partial<TableColumn>) => void;
}) {
  const dropBefore = useDroppable({ id: `drop-before-${sectionId}-${field.id}`, data: { source: "canvas", kind: "before", sectionId, fieldId: field.id } });
  const dropAfter = useDroppable({ id: `drop-after-${sectionId}-${field.id}`, data: { source: "canvas", kind: "after", sectionId, fieldId: field.id } });
  const { attributes, listeners, setNodeRef: setDragRef, isDragging } = useDraggable({
    id: `canvas-${sectionId}-${field.id}`,
    data: { source: "canvas-field", sectionId, fieldId: field.id },
  });

  const startResize = (e: React.MouseEvent) => {
    e.preventDefault(); e.stopPropagation();
    const startX = e.clientX;
    const startCol = field.colSpan ?? 6;
    const colPx = rowWidth / 12;
    const onMove = (ev: MouseEvent) => {
      const delta = Math.round((ev.clientX - startX) / colPx);
      const next = Math.max(1, Math.min(12, startCol + delta));
      if (next !== (field.colSpan ?? 0)) onResize(next);
    };
    const onUp = () => { window.removeEventListener("mousemove", onMove); window.removeEventListener("mouseup", onUp); };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  return (
    <div className={cn("relative flex items-stretch min-w-0", isDragging && "opacity-40")}
      style={{ gridColumn: `span ${field.type === "table" ? 12 : (field.colSpan ?? 1)} / span ${field.type === "table" ? 12 : (field.colSpan ?? 1)}` }}>
      <div ref={dropBefore.setNodeRef}
        className={cn("w-1 shrink-0 transition-all", dropBefore.isOver ? "bg-[#287EAD]" : "bg-transparent")} />
      <div onClick={(e) => { e.stopPropagation(); onSelect(); }}
        className={cn(
          "group relative flex-1 min-w-0 border bg-white p-3 transition-all cursor-pointer",
          isSelected ? "border-[#287EAD] ring-2 ring-[#287EAD]/20 shadow-sm" : "border-slate-300 hover:border-[#287EAD]/60 hover:shadow-sm",
        )}>
        <div className="mb-2 flex items-center justify-between gap-2">
          <div ref={setDragRef} {...listeners} {...attributes}
            className="flex items-center gap-1.5 text-xs font-semibold text-slate-700 cursor-grab active:cursor-grabbing flex-1 min-w-0 overflow-hidden">
            <GripVertical className="h-3.5 w-3.5 text-slate-300 flex-shrink-0" />
            {(() => { const TypeIcon = ICONS[field.type]; return <TypeIcon className="h-3.5 w-3.5 text-[#287EAD] flex-shrink-0" />; })()}
            <span className="truncate min-w-0 flex-1" title={`${field.label || "Unlabelled"} — ${FIELD_META[field.type]?.label ?? field.type}`}>
              {field.label || <em className="font-normal text-slate-400">Unlabelled</em>}
            </span>
            {field.required && <span className="text-red-500 flex-shrink-0">*</span>}
            {field.calc?.expression && (
              <span className="bg-emerald-50 px-1.5 py-0.5 text-[9px] font-semibold text-emerald-700 border border-emerald-200 flex-shrink-0" title="Calculated field">ƒx</span>
            )}
            {field.hidden ? (
              <span className="bg-slate-100 px-1.5 py-0.5 text-[9px] font-semibold text-slate-500 border border-slate-300 flex-shrink-0" title="Always hidden from people filling the form">hidden</span>
            ) : ruleGroupHasConditions(field.visibleWhen) && (
              <span className="bg-amber-50 px-1.5 py-0.5 text-[9px] font-semibold text-amber-700 border border-amber-200 flex-shrink-0" title={`Show when ${summarizeRuleGroup(field.visibleWhen)}`}>cond</span>
            )}
            {field.readonly ? (
              <span className="bg-slate-100 px-1.5 py-0.5 text-[9px] font-semibold text-slate-500 border border-slate-300 flex-shrink-0" title="Always read-only">read-only</span>
            ) : ruleGroupHasConditions(field.editableWhen) && (
              <span className="bg-violet-50 px-1.5 py-0.5 text-[9px] font-semibold text-violet-700 border border-violet-200 flex-shrink-0" title={`Editable when ${summarizeRuleGroup(field.editableWhen)}`}>edit-cond</span>
            )}
          </div>
          <div className="flex items-center gap-0.5 opacity-0 transition group-hover:opacity-100 flex-shrink-0">
            <button onClick={(e) => { e.stopPropagation(); onMoveField("back"); }} title="Move backward (earlier in this section)"
              disabled={isFirstField}
              className="p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700 disabled:opacity-25 disabled:hover:bg-transparent">
              <MoveLeft className="h-3 w-3" />
            </button>
            <button onClick={(e) => { e.stopPropagation(); onMoveField("forward"); }} title="Move forward (later in this section)"
              disabled={isLastField}
              className="p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700 disabled:opacity-25 disabled:hover:bg-transparent">
              <MoveRight className="h-3 w-3" />
            </button>
            <button onClick={(e) => { e.stopPropagation(); onDuplicate(); }} title="Duplicate"
              className="p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700">
              <Copy className="h-3 w-3" />
            </button>
            <button onClick={(e) => { e.stopPropagation(); onRemove(); }} title="Remove"
              className="p-1 text-slate-400 hover:bg-red-50 hover:text-red-500">
              <Trash2 className="h-3 w-3" />
            </button>
          </div>
        </div>
        <FieldPreview
          field={field}
          onConfigureColumn={onConfigureColumn}
          onAddColumn={onAddColumn}
          onRemoveColumn={onRemoveColumn}
          onMoveColumn={onMoveColumn}
          onUpdateColumn={onUpdateColumn}
        />
        <div className="mt-1.5 flex items-center justify-between gap-2 text-[9px] text-slate-400 font-mono">
          <span className="truncate">{field.key}</span>
          <span>{field.colSpan}/12</span>
        </div>
        {field.type !== "table" && (
          <div onMouseDown={startResize}
            className="absolute right-0 top-0 h-full w-1.5 cursor-col-resize opacity-0 transition group-hover:bg-[#287EAD]/40 group-hover:opacity-100"
            title="Drag to resize" />
        )}
      </div>
      <div ref={dropAfter.setNodeRef}
        className={cn("w-1 shrink-0 transition-all", dropAfter.isOver ? "bg-[#287EAD]" : "bg-transparent")} />
    </div>
  );
}

function SectionDropZone({ sectionId }: { sectionId: string }) {
  const { setNodeRef, isOver } = useDroppable({
    id: `drop-section-${sectionId}`,
    data: { source: "canvas", kind: "section-end", sectionId },
  });
  return (
    <div ref={setNodeRef}
      className={cn(
        "col-span-12 flex h-11 items-center justify-center border-2 border-dashed text-xs font-medium transition",
        isOver ? "border-[#287EAD] bg-[#EEF6FB] text-[#287EAD]" : "border-slate-300 text-slate-400 hover:border-[#287EAD]/60",
      )}>
      <Plus className="h-3.5 w-3.5 mr-1.5" /> Drop a field here
    </div>
  );
}

function SectionBlock(props: {
  section: TemplateSection; selectedId: string | null;
  isFirst: boolean; isLast: boolean;
  onSelect: (id: string | null) => void;
  onUpdateSection: (id: string, patch: Partial<TemplateSection>) => void;
  onRemoveSection: (id: string) => void;
  onRemoveField: (sectionId: string, fieldId: string) => void;
  onDuplicateField: (sectionId: string, fieldId: string) => void;
  onResizeField: (sectionId: string, fieldId: string, colSpan: number) => void;
  onMoveSection: (id: string, dir: "up" | "down") => void;
  onMoveField: (sectionId: string, fieldId: string, dir: "back" | "forward") => void;
  onConfigureColumn: (sectionId: string, fieldId: string, colId: string) => void;
  onAddColumn: (sectionId: string, fieldId: string) => void;
  onRemoveColumn: (sectionId: string, fieldId: string, colId: string) => void;
  onMoveColumn: (sectionId: string, fieldId: string, colId: string, dir: "left" | "right") => void;
  onUpdateColumn: (sectionId: string, fieldId: string, colId: string, patch: Partial<TableColumn>) => void;
}) {
  const { section, selectedId } = props;
  const isSelected = selectedId === section.id;
  const gridRef = useRef<HTMLDivElement>(null);
  const [rowWidth, setRowWidth] = useState(960);
  const [collapsed, setCollapsed] = useState(false);

  useEffect(() => {
    if (!gridRef.current) return;
    const ro = new ResizeObserver(() => {
      if (gridRef.current) setRowWidth(gridRef.current.offsetWidth);
    });
    ro.observe(gridRef.current);
    return () => ro.disconnect();
  }, []);

  return (
    <section onClick={() => props.onSelect(section.id)}
      className={cn(
        "border-2 bg-white shadow-sm transition-all overflow-hidden",
        isSelected ? "border-[#287EAD] ring-2 ring-[#287EAD]/20" : "border-[#C8CDD2] hover:border-[#287EAD]/50",
      )}>
      <header className="flex items-start gap-3 border-b border-[#D0D5DA] bg-[#F3F5F6] px-5 py-3.5">
        <div className="flex flex-col gap-0.5 mt-1 flex-shrink-0">
          <button onClick={(e) => { e.stopPropagation(); props.onMoveSection(section.id, "up"); }} disabled={props.isFirst}
            className="p-0.5 text-slate-500 hover:bg-white hover:text-slate-800 disabled:opacity-20 transition-colors">
            <ChevronUp className="h-3.5 w-3.5" />
          </button>
          <button onClick={(e) => { e.stopPropagation(); props.onMoveSection(section.id, "down"); }} disabled={props.isLast}
            className="p-0.5 text-slate-500 hover:bg-white hover:text-slate-800 disabled:opacity-20 transition-colors">
            <ChevronDown className="h-3.5 w-3.5" />
          </button>
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5">
            <input value={section.title}
              onChange={(e) => props.onUpdateSection(section.id, { title: e.target.value })}
              onClick={(e) => e.stopPropagation()}
              className="min-w-0 flex-1 bg-transparent text-sm font-bold text-[#1F2933] outline-none border-b border-transparent focus:border-[#287EAD] pb-0.5 transition-colors" />
            {section.hidden ? (
              <span className="bg-slate-100 px-1.5 py-0.5 text-[9px] font-semibold text-slate-500 border border-slate-300 flex-shrink-0" title="Section always hidden from people filling the form">hidden</span>
            ) : section.visibleToGroups && section.visibleToGroups.length > 0 ? (
              <span className="bg-[#EEF6FB] px-1.5 py-0.5 text-[9px] font-semibold text-[#287EAD] border border-[#287EAD]/30 flex-shrink-0" title={`Visible only to: ${section.visibleToGroups.map((g) => g.name).join(", ")}`}>
                {section.visibleToGroups.length === 1 ? section.visibleToGroups[0].name : `${section.visibleToGroups.length} groups`}
              </span>
            ) : ruleGroupHasConditions(section.visibleWhen) && (
              <span className="bg-amber-50 px-1.5 py-0.5 text-[9px] font-semibold text-amber-700 border border-amber-200 flex-shrink-0" title={`Section shows when ${summarizeRuleGroup(section.visibleWhen)}`}>cond</span>
            )}
            {section.readonly ? (
              <span className="bg-slate-100 px-1.5 py-0.5 text-[9px] font-semibold text-slate-500 border border-slate-300 flex-shrink-0" title="Section always read-only">read-only</span>
            ) : ruleGroupHasConditions(section.editableWhen) && (
              <span className="bg-violet-50 px-1.5 py-0.5 text-[9px] font-semibold text-violet-700 border border-violet-200 flex-shrink-0" title={`Section editable when ${summarizeRuleGroup(section.editableWhen)}`}>edit-cond</span>
            )}
          </div>
          <input value={section.description ?? ""}
            placeholder="Add a description…"
            onChange={(e) => props.onUpdateSection(section.id, { description: e.target.value })}
            onClick={(e) => e.stopPropagation()}
            className="mt-1 w-full bg-transparent text-xs text-[#5E6870] outline-none placeholder:text-[#AEB5BB] border-b border-transparent focus:border-[#AEB5BB] pb-0.5 transition-colors" />
        </div>
        <button onClick={(e) => { e.stopPropagation(); props.onSelect(section.id); }}
          title="Section settings"
          className={cn(
            "p-1.5 transition-colors flex-shrink-0",
            isSelected ? "bg-[#287EAD] text-white" : "text-slate-500 hover:bg-white hover:text-[#287EAD]",
          )}>
          <Settings className="h-4 w-4" />
        </button>
        <button onClick={(e) => { e.stopPropagation(); setCollapsed((c) => !c); }}
          title={collapsed ? "Expand" : "Collapse"}
          className="p-1.5 text-slate-500 hover:bg-white hover:text-slate-800 transition-colors flex-shrink-0">
          {collapsed ? <ChevronDown className="h-4 w-4" /> : <ChevronUp className="h-4 w-4" />}
        </button>
        <button onClick={(e) => { e.stopPropagation(); props.onRemoveSection(section.id); }}
          className="p-1.5 text-slate-500 hover:bg-red-50 hover:text-red-600 transition-colors flex-shrink-0"
          title="Remove section">
          <Trash2 className="h-4 w-4" />
        </button>
      </header>
      {!collapsed && (
        <div className="p-5">
          <div ref={gridRef} className="grid grid-cols-12 gap-3">
            {section.fields.map((f, fi) => (
              <FieldCard key={f.id} field={f} sectionId={section.id}
                onMoveField={(dir) => props.onMoveField(section.id, f.id, dir)}
                isFirstField={fi === 0}
                isLastField={fi === section.fields.length - 1}
                isSelected={selectedId === f.id}
                onSelect={() => props.onSelect(f.id)}
                onRemove={() => props.onRemoveField(section.id, f.id)}
                onDuplicate={() => props.onDuplicateField(section.id, f.id)}
                onResize={(c) => props.onResizeField(section.id, f.id, c)}
                rowWidth={rowWidth}
                onConfigureColumn={(colId) => props.onConfigureColumn(section.id, f.id, colId)}
                onAddColumn={() => props.onAddColumn(section.id, f.id)}
                onRemoveColumn={(colId) => props.onRemoveColumn(section.id, f.id, colId)}
                onMoveColumn={(colId, dir) => props.onMoveColumn(section.id, f.id, colId, dir)}
                onUpdateColumn={(colId, patch) => props.onUpdateColumn(section.id, f.id, colId, patch)}
              />
            ))}
            <SectionDropZone sectionId={section.id} />
          </div>
          <div className="mt-3 flex items-center gap-2 text-xs text-slate-500">
            <Layers className="h-3 w-3" />
            <span>{section.fields.length} field{section.fields.length !== 1 ? "s" : ""}</span>
          </div>
        </div>
      )}
    </section>
  );
}

/* ============================================================
 * Canvas
 * ============================================================ */

function Canvas(props: {
  sections: TemplateSection[]; selectedId: string | null;
  onSelect: (id: string | null) => void; onAddSection: () => void;
  onUpdateSection: (id: string, patch: Partial<TemplateSection>) => void;
  onRemoveSection: (id: string) => void;
  onRemoveField: (sectionId: string, fieldId: string) => void;
  onDuplicateField: (sectionId: string, fieldId: string) => void;
  onResizeField: (sectionId: string, fieldId: string, colSpan: number) => void;
  onMoveSection: (id: string, dir: "up" | "down") => void;
  onMoveField: (sectionId: string, fieldId: string, dir: "back" | "forward") => void;
  onConfigureColumn: (sectionId: string, fieldId: string, colId: string) => void;
  onAddColumn: (sectionId: string, fieldId: string) => void;
  onRemoveColumn: (sectionId: string, fieldId: string, colId: string) => void;
  onMoveColumn: (sectionId: string, fieldId: string, colId: string, dir: "left" | "right") => void;
  onUpdateColumn: (sectionId: string, fieldId: string, colId: string, patch: Partial<TableColumn>) => void;
}) {
  return (
    <div className="flex w-full flex-col gap-4 p-6" onClick={() => props.onSelect(null)}>
      {props.sections.map((s, idx) => (
        <SectionBlock key={s.id} section={s} selectedId={props.selectedId}
          isFirst={idx === 0} isLast={idx === props.sections.length - 1}
          onSelect={props.onSelect}
          onUpdateSection={props.onUpdateSection}
          onRemoveSection={props.onRemoveSection}
          onRemoveField={props.onRemoveField}
          onDuplicateField={props.onDuplicateField}
          onResizeField={props.onResizeField}
          onMoveSection={props.onMoveSection}
          onMoveField={props.onMoveField}
          onConfigureColumn={props.onConfigureColumn}
          onAddColumn={props.onAddColumn}
          onRemoveColumn={props.onRemoveColumn}
          onMoveColumn={props.onMoveColumn}
          onUpdateColumn={props.onUpdateColumn}
        />
      ))}
      <button onClick={(e) => { e.stopPropagation(); props.onAddSection(); }}
        className="flex items-center justify-center gap-2 border-2 border-dashed border-slate-300 bg-white py-5 text-sm font-semibold text-slate-400 transition hover:border-[#287EAD] hover:bg-[#EEF6FB] hover:text-[#287EAD]">
        <Plus className="h-4 w-4" /> Add Section
      </button>
    </div>
  );
}

/* ============================================================
 * Column Configuration Modal (UniFi-style)
 * ============================================================ */

const COL_TYPES: Array<{ value: TableColumnType; label: string }> = [
  { value: "text", label: "Text" },
  { value: "textarea", label: "Long text" },
  // "Currency" is not listed: it is a Number with a currency number-format.
  { value: "number", label: "Number / Currency" },
  { value: "date", label: "Date" },
  { value: "datetime", label: "Date & Time" },
  { value: "time", label: "Time" },
  { value: "select", label: "Dropdown" },
  { value: "boolean", label: "Checkbox" },
  { value: "email", label: "Email" },
  { value: "phone", label: "Phone" },
  { value: "reference", label: "Reference" },
  { value: "user", label: "User picker" },
  { value: "file", label: "File / Attachment" },
  { value: "image", label: "Image" },
  { value: "percentage", label: "Percentage" },
  { value: "url", label: "URL / Link" },
  { value: "multi_select", label: "Multi-select" },
];

/* ── Formula reference ────────────────────────────────────────────────────
 * The single source of truth for what a form author can type into a formula.
 * Kept beside the editors (rather than in a wiki) so it can never drift from
 * the engine: every entry below is implemented in CALC_FUNCS / the aggregate
 * pre-pass here AND mirrored in apps/templates_engine/conditions.py. */
const FUNCTION_REFERENCE: Array<{ group: string; items: Array<[string, string]> }> = [
  {
    group: "Operators", items: [
      ["+ - * /", "Arithmetic"],
      ["^", "Power: base ^ exponent"],
      ["%", "Remainder after division"],
      ["&", 'Join text: first_name & " " & last_name'],
      ["> < >= <= == != <>", "Comparisons — result is true/false"],
    ]
  },
  {
    group: "Numbers", items: [
      ["ROUND(n, places)", "Round to N decimal places"],
      ["CEIL(n) / FLOOR(n)", "Round up / down to a whole number"],
      ["TRUNC(n, places)", "Cut off decimals without rounding"],
      ["ABS(n) / SIGN(n)", "Magnitude / -1, 0 or 1"],
      ["SQRT(n) / POWER(a, b)", "Square root / a to the power b"],
      ["MIN(…) / MAX(…)", "Smallest / largest of the arguments"],
      ["AVERAGE(…) / SUMALL(…)", "Mean / total of the arguments"],
      ["CLAMP(n, low, high)", "Force a value inside a range"],
      ["PCT(n, percent)", "percent% of n — PCT(amount, 7.5)"],
      ["GROSS(net, rate) / NET(gross, rate)", "Add / strip a VAT-style rate"],
    ]
  },
  {
    group: "Logic", items: [
      ["IF(test, then, else)", "Two-way branch"],
      ["IFS(test1, val1, test2, val2, …, fallback)", "Many branches, first match wins"],
      ["SWITCH(value, match1, val1, …, fallback)", "Compare one value against options"],
      ["AND(…) / OR(…) / NOT(x) / XOR(…)", "Combine true/false tests"],
      ["ISBLANK(x) / ISNUMBER(x)", "Emptiness / numeric checks"],
      ["COALESCE(…)", "First argument that isn't blank"],
    ]
  },
  {
    group: "Text", items: [
      ["UPPER / LOWER / PROPER(text)", "Change case"],
      ["TRIM(text) / LEN(text)", "Strip spaces / character count"],
      ["LEFT(text, n) / RIGHT(text, n) / MID(text, start, n)", "Take part of the text"],
      ["CONCAT(…)", "Join any number of values"],
      ["FIND(needle, haystack)", "Position of text, 0 when absent"],
      ["SUBSTITUTE(text, find, replace)", "Replace every occurrence"],
      ["PADLEFT(text, width, char)", "Pad a reference number to a fixed width"],
      ["SPLIT(text, separator, index)", "Nth part of a delimited value"],
      ["TEXT(value) / VALUE(text)", "Convert between text and number"],
    ]
  },
  {
    group: "Dates", items: [
      ["TODAY() / NOW()", "Current date / date-time"],
      ["DATE(year, month, day)", "Build a date"],
      ["YEAR(d) / MONTH(d) / DAY(d) / WEEKDAY(d)", "Pull a date apart"],
      ["DATEADD(d, n, \"days|months|years\")", "Shift a date"],
      ["DATEDIF(start, end, \"days|months|years\")", "Distance between two dates"],
      ["NETWORKDAYS(start, end)", "Working days, weekends excluded"],
      ["FORMATDATE(d, \"YYYY-MM-DD\")", "Render a date as text"],
    ]
  },
  {
    group: "Table columns (all rows)", items: [
      ["SUM(col) / AVG(col) / COUNT(col)", "Totals down a column"],
      ["COUNTA(col) / COUNTBLANK(col)", "Filled / empty cells"],
      ["COLMIN(col) / COLMAX(col) / MEDIAN(col) / PRODUCT(col)", "Column statistics"],
      ["FIRST(col) / LAST(col)", "Value in the first / last row"],
      ['SUMIF(value_col, test_col, ">1000")', "Conditional total"],
      ['COUNTIF(test_col, "Travel")', "Conditional count"],
      ['AVGIF(value_col, test_col, "<>Cancelled")', "Conditional average"],
      ['COLJOIN(col, ", ")', "Join every cell into one text value"],
      ["ROWCOUNT(table_key)", "How many rows the table has"],
    ]
  },
];

/* Collapsible cheat-sheet shared by both formula editors. */
function FormulaReference() {
  const [open, setOpen] = useState(false);
  return (
    <div className="border border-[#E5E8EB] bg-[#FAFBFC]">
      <button type="button" onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center justify-between px-2 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-[#5E6870] hover:bg-[#F3F5F6]">
        <span className="flex items-center gap-1"><FileCode className="h-3 w-3" /> Function reference</span>
        {open ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
      </button>
      {open && (
        <div className="max-h-64 space-y-2 overflow-y-auto border-t border-[#E5E8EB] p-2">
          {FUNCTION_REFERENCE.map((g) => (
            <div key={g.group}>
              <p className="text-[10px] font-semibold uppercase tracking-wider text-[#287EAD]">{g.group}</p>
              <ul className="mt-0.5 space-y-0.5">
                {g.items.map(([sig, desc]) => (
                  <li key={sig} className="text-[10px] leading-snug text-[#5E6870]">
                    <code className="font-mono text-[#1F2933]">{sig}</code> — {desc}
                  </li>
                ))}
              </ul>
            </div>
          ))}
          <p className="text-[10px] text-[#8C969E]">
            Reference other fields and table columns by their ID. Every formula re-runs
            authoritatively on the server at submit time.
          </p>
        </div>
      )}
    </div>
  );
}

/* Shared "is this formula valid?" banner. */
function FormulaStatus({ error, expression, previewValue }: {
  error: string | null; expression: string; previewValue: CalcValue;
}) {
  if (!expression.trim()) return null;
  if (error) {
    return (
      <p className="flex items-start gap-1.5 border border-red-200 bg-red-50 px-2 py-1.5 text-[11px] text-red-700">
        <AlertCircle className="mt-0.5 h-3 w-3 flex-shrink-0" /> <span>{error}</span>
      </p>
    );
  }
  return (
    <p className="flex items-start gap-1.5 border border-emerald-200 bg-emerald-50 px-2 py-1.5 text-[11px] text-emerald-800">
      <CheckCircle2 className="mt-0.5 h-3 w-3 flex-shrink-0" />
      <span>Valid. Sanity check with every referenced value = 100 and empty tables:{" "}
        <span className="font-mono font-semibold">{String(previewValue)}</span></span>
    </p>
  );
}

/* Formula editor for a calculated TABLE COLUMN. Same grammar/engine as the
 * top-level CalcFormulaEditor, but the chip picker offers two scopes: this
 * row's OTHER columns (e.g. `qty * unit_price`) and the form's top-level
 * fields (e.g. `daily_subsistence_allowance`, copied into every row — this
 * is exactly how UniFi's "DSA Amount"column formula works). Both resolve
 * per-row on the server (apps/templates_engine/conditions.py
 * compute_calculated_values), so a formula referencing a top-level field sees
 * that field's single value in every row, while a formula referencing a
 * sibling column sees that specific row's cell. */
function ColumnCalcFormulaEditor({ column, siblingColumns, formFields, onChange }: {
  column: TableColumn;
  siblingColumns: TableColumn[];
  formFields: TemplateField[];
  onChange: (calc: CalcConfig) => void;
}) {
  const calc = column.calc ?? { expression: "" };
  const exprRef = useRef<HTMLTextAreaElement>(null);
  const keyedColumns = siblingColumns.filter((c) => c.id !== column.id && c.key);
  const keyedFormFields = formFields.filter((f) => f.key);
  const numericColumns = siblingColumns.filter(
    (c) => c.id !== column.id && c.key && (c.type === "number" || c.type === "currency"),
  );

  const insertToken = (key: string) => {
    const el = exprRef.current;
    if (!el) { onChange({ ...calc, expression: `${calc.expression}${key}` }); return; }
    const start = el.selectionStart ?? el.value.length;
    const end = el.selectionEnd ?? el.value.length;
    const next = `${calc.expression.slice(0, start)}${key}${calc.expression.slice(end)}`;
    onChange({ ...calc, expression: next });
    requestAnimationFrame(() => { el.focus(); el.selectionStart = el.selectionEnd = start + key.length; });
  };

  // Quick sanity preview: every referenced column/field = 100.
  const sampleScope: Record<string, number> = {};
  keyedColumns.forEach((c) => { sampleScope[c.key] = 100; });
  keyedFormFields.forEach((f) => { sampleScope[f.key] = 100; });
  const knownKeys = [...keyedColumns.map((c) => c.key), ...keyedFormFields.map((f) => f.key)];
  const formulaError = validateCalcExpression(calc.expression, knownKeys);
  const previewValue = formulaError ? "" : previewCalcValue(calc.expression, sampleScope, calc.decimals);
  const showDecimals = column.type === "number" || column.type === "currency";
  const iCls =
    "h-9 w-full border border-[#AEB5BB] bg-white px-3 text-sm text-[#1F2933] " +
    "placeholder:text-[#8C969E] outline-none focus:border-[#287EAD] focus:ring-1 focus:ring-[#287EAD]";

  const sampleFormula = sampleFormulaFor(keyedColumns[0]?.key ?? keyedFormFields[0]?.key, numericColumns[0]?.key);

  return (
    <div className="space-y-2 border border-[#C8CDD2] bg-white p-2.5">
      <textarea
        ref={exprRef}
        value={calc.expression}
        onChange={(e) => onChange({ ...calc, expression: e.target.value })}
        placeholder={`e.g. ${sampleFormula}`}
        rows={2}
        className={cn(iCls, "h-auto min-h-[52px] py-2 font-mono resize-none")}
      />
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" onClick={() => insertToken('IF(condition, "value if true", "value if false")')}
          className="inline-flex items-center gap-1 border border-[#287EAD]/40 bg-[#EEF6FB] px-2 py-1 font-mono text-[10px] font-semibold text-[#287EAD] hover:bg-[#287EAD] hover:text-white">
          + Insert IF(condition, …)
        </button>
        <button type="button" onClick={() => insertToken(sampleFormula)}
          className="inline-flex items-center gap-1 border border-[#C8CDD2] bg-[#F6F7F8] px-2 py-1 font-mono text-[10px] font-semibold text-[#5E6870] hover:border-[#287EAD] hover:text-[#287EAD]">
          + Insert sample
        </button>
      </div>

      {/* IDs live behind a disclosure: a wide table has far too many of them
          to list permanently inside the column modal. */}
      <RefPicker count={keyedColumns.length + keyedFormFields.length}>
        {keyedColumns.length > 0 && (
          <div className="space-y-1">
            <span className="text-[10px] font-semibold uppercase tracking-wider text-[#5E6870]">This row's columns</span>
            <div className="flex flex-wrap gap-1">
              {keyedColumns.map((c) => (
                <button key={c.id} type="button" onClick={() => insertToken(c.key)} title={`Insert ${c.key}`}
                  className="border border-[#C8CDD2] bg-[#F6F7F8] px-1.5 py-0.5 font-mono text-[10px] text-[#287EAD] hover:border-[#287EAD] hover:bg-[#EEF6FB]">
                  {c.key}
                </button>
              ))}
            </div>
          </div>
        )}
        {keyedFormFields.length > 0 && (
          <div className="space-y-1">
            <span className="text-[10px] font-semibold uppercase tracking-wider text-[#5E6870]">Form fields (same value in every row)</span>
            <div className="flex flex-wrap gap-1">
              {keyedFormFields.map((f) => (
                <button key={f.id} type="button" onClick={() => insertToken(f.key)} title={`Insert ${f.key}`}
                  className="border border-emerald-200 bg-emerald-50 px-1.5 py-0.5 font-mono text-[10px] text-emerald-700 hover:border-emerald-400">
                  {f.key}
                </button>
              ))}
            </div>
          </div>
        )}
        <p className="text-[10px] text-[#8C969E]">
          A bare ID is this row's value. Wrap a column ID to total every row — e.g.{" "}
          <code className="font-mono">SUM(column_id)</code>, <code className="font-mono">AVG(column_id)</code>,{" "}
          <code className="font-mono">COUNT(column_id)</code>.
        </p>
      </RefPicker>
      {keyedColumns.length === 0 && keyedFormFields.length === 0 && (
        <p className="text-[10px] text-amber-600">Add other columns or form fields first — a formula needs something to reference.</p>
      )}
      {showDecimals && (
        <div className="flex items-center gap-2 pt-1">
          <span className="text-[11px] font-semibold uppercase tracking-wider text-[#5E6870]">Decimal places</span>
          <input type="number" min={0} max={6} value={calc.decimals ?? 2}
            onChange={(e) => onChange({ ...calc, decimals: Math.max(0, Math.min(6, Number(e.target.value))) })}
            className={cn(iCls, "h-8 w-20")} />
        </div>
      )}
      <FormulaStatus error={formulaError} expression={calc.expression} previewValue={previewValue} />
      <FormulaReference />
    </div>
  );
}

const RETIREMENT_SCENARIOS: Array<{ key: "exact" | "under" | "over"; label: string; hint: string }> = [
  { key: "exact", label: "Exact spend", hint: "Spent equals the issued/requested amount." },
  { key: "under", label: "Underspend", hint: "Spent is less than issued — a balance is returned." },
  { key: "over", label: "Overspend", hint: "Spent exceeds issued — the user is owed the difference." },
];

const AMOUNT_SOURCE_OPTIONS: Array<{ value: RetirementAmountSource; label: string }> = [
  { value: "issued", label: "Issued amount" },
  { value: "spent", label: "Spent (this column, summed)" },
  { value: "variance", label: "Variance (|issued − spent|)" },
];

/* Configures the imprest/retirement reconciliation posting for a table's
 * "Line amount" column — see RetirementConfig's docstring. Lets the admin
 * pick the top-level "issued/requested" field to compare against, then for
 * each of the three possible outcomes (exact / under / over spend) build a
 * free-form list of journal lines (account + D/C + which amount feeds it).
 * Nothing here is hard-coded business logic — the account codes and which
 * scenario debits/credits which account are entirely what the admin enters;
 * this editor only shapes that data into RetirementConfig. */
function RetirementConfigEditor({ column, formFields, onChange }: {
  column: TableColumn;
  formFields: TemplateField[];
  onChange: (retirement: RetirementConfig | undefined) => void;
}) {
  const retirement = column.sunsystems?.retirement;
  const amountFieldOptions = formFields.filter((f) => f.key && (f.type === "number" || f.type === "currency" || CALCULATED_TYPES.has(f.type)));

  const iCls =
    "h-9 w-full border border-[#AEB5BB] bg-white px-3 text-sm text-[#1F2933] " +
    "placeholder:text-[#8C969E] outline-none focus:border-[#287EAD] focus:ring-1 focus:ring-[#287EAD]";

  const updateScenario = (key: "exact" | "under" | "over", scenario: RetirementScenario) => {
    if (!retirement) return;
    onChange({ ...retirement, [key]: scenario });
  };

  return (
    <Row label="Retirement / Reconciliation" hint="For imprest-style tables: compare this column's total against an issued amount and post different journal lines depending on whether the user under- or over-spent.">
      <div className="space-y-3 border border-[#C8CDD2] bg-white p-2.5">
        <ToggleYesNo
          value={!!retirement?.enabled}
          onChange={(v) => onChange(v ? (retirement ?? emptyRetirementConfig()) : undefined)}
        />
        {retirement?.enabled && (
          <div className="space-y-3">
            <div>
              <span className="text-[11px] font-semibold uppercase tracking-wider text-[#5E6870]">Issued / requested amount field</span>
              <select className={cn(iCls, "mt-1", !retirement.issuedAmountField && amountFieldOptions.length > 0 && "border-amber-400")}
                value={retirement.issuedAmountField ?? ""}
                onChange={(e) => onChange({ ...retirement, issuedAmountField: e.target.value || undefined })}>
                <option value="">— choose a field —</option>
                {amountFieldOptions.map((f) => <option key={f.id} value={f.key}>{f.label} ({f.key})</option>)}
              </select>
              {amountFieldOptions.length === 0 ? (
                <p className="mt-1 text-[10px] text-amber-600">Add a Number or Currency field elsewhere on the form to hold the issued/requested amount.</p>
              ) : !retirement.issuedAmountField && (
                <p className="mt-1 flex items-center gap-1 text-[10px] text-amber-600">
                  <AlertCircle className="h-3 w-3 flex-shrink-0" />
                  Without this, issued is treated as 0 and every submission posts as a full overspend.
                </p>
              )}
            </div>
            {RETIREMENT_SCENARIOS.map((s) => (
              <RetirementScenarioEditor
                key={s.key}
                label={s.label}
                hint={s.hint}
                scenario={retirement[s.key]}
                onChange={(scenario) => updateScenario(s.key, scenario)}
              />
            ))}
          </div>
        )}
      </div>
    </Row>
  );
}

function RetirementScenarioEditor({ label, hint, scenario, onChange }: {
  label: string;
  hint: string;
  scenario: RetirementScenario;
  onChange: (scenario: RetirementScenario) => void;
}) {
  const iCls =
    "h-8 w-full border border-[#AEB5BB] bg-white px-2 text-xs text-[#1F2933] " +
    "placeholder:text-[#8C969E] outline-none focus:border-[#287EAD] focus:ring-1 focus:ring-[#287EAD]";

  const updateLine = (idx: number, patch: Partial<RetirementLine>) =>
    onChange({ lines: scenario.lines.map((l, i) => (i === idx ? { ...l, ...patch } : l)) });
  const addLine = () =>
    onChange({ lines: [...scenario.lines, { account: "", dc: "D", amountSource: "spent" }] });
  const removeLine = (idx: number) =>
    onChange({ lines: scenario.lines.filter((_, i) => i !== idx) });

  return (
    <div className="border border-[#E1E5E8] bg-[#F8FAFB] p-2.5">
      <div className="mb-2 flex items-center justify-between">
        <div>
          <p className="text-xs font-semibold text-[#1F2933]">{label}</p>
          <p className="text-[10px] text-[#8C969E]">{hint}</p>
        </div>
        <button type="button" onClick={addLine}
          className="inline-flex items-center gap-1 border border-[#287EAD] px-2 py-1 text-[10px] font-semibold text-[#287EAD] hover:bg-[#EEF6FB]">
          <Plus className="h-3 w-3" /> Add line
        </button>
      </div>
      <div className="space-y-1.5">
        {scenario.lines.map((line, idx) => (
          <div key={idx} className="grid grid-cols-[1fr_90px_1fr_auto] gap-1.5 items-center">
            <input className={cn(iCls, "font-mono")} value={line.account}
              onChange={(e) => updateLine(idx, { account: e.target.value })}
              placeholder="Account code" />
            <select className={iCls} value={line.dc} onChange={(e) => updateLine(idx, { dc: e.target.value as "D" | "C" })}>
              <option value="D">Debit</option>
              <option value="C">Credit</option>
            </select>
            <select className={iCls} value={line.amountSource}
              onChange={(e) => updateLine(idx, { amountSource: e.target.value as RetirementAmountSource })}>
              {AMOUNT_SOURCE_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
            <button type="button" onClick={() => removeLine(idx)} title="Remove line"
              className="p-1 text-[#5E6870] hover:bg-red-50 hover:text-red-600">
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          </div>
        ))}
        {scenario.lines.length === 0 && (
          <p className="text-[10px] text-amber-600">No lines configured — nothing will post for this outcome.</p>
        )}
      </div>
    </div>
  );
}

function ColumnConfigModal({
  column, siblingColumns = [], formFields = [], processSteps = [], onClose, onSave, onDelete,
}: {
  column: TableColumn;
  siblingColumns?: TableColumn[];
  formFields?: TemplateField[];
  processSteps?: { value: string; label: string }[];
  onClose: () => void;
  onSave: (col: TableColumn) => void;
  onDelete: () => void;
}) {
  const [tab, setTab] = useState<"field" | "advanced">("field");
  const [draft, setDraft] = useState<TableColumn>({ ...column });
  // Whether the column's ID still follows its Label — see FieldEditor's
  // identical pattern (deriveKeyFromLabel / looksAutoGenerated above). Each
  // time the modal is opened for a column, this starts "on" only if that
  // column's key still looks like an untouched auto-default.
  const [autoKey, setAutoKey] = useState(() => looksAutoGenerated(column.key));

  const set = (patch: Partial<TableColumn>) => setDraft((d) => ({ ...d, ...patch }));
  const isDropdown = draft.type === "select";
  // Sibling columns whose value can hold a currency code (drives this cell's symbol).
  const currencySourceColumns = siblingColumns.filter(
    (c) => c.id !== draft.id && c.key && ["select", "text"].includes(c.type ?? "text"),
  );
  const isNumeric = draft.type === "number" || draft.type === "currency";
  const isText = draft.type === "text" || draft.type === "textarea" || draft.type === "email" || draft.type === "phone";
  const isCalcCol = !!draft.calc;
  const keyDuplicate = siblingColumns.some((c) => c.id !== draft.id && c.key === draft.key);

  const iCls =
    "h-9 w-full border border-[#AEB5BB] bg-white px-3 text-sm text-[#1F2933] " +
    "placeholder:text-[#8C969E] outline-none focus:border-[#287EAD] focus:ring-1 focus:ring-[#287EAD]";

  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-2xl overflow-hidden border border-[#C8CDD2] bg-white shadow-2xl">
        {/* Header */}
        <div className="flex items-stretch border-b border-[#C8CDD2]">
          <div className="flex flex-1 items-center gap-2 px-5 py-3">
            <Table2 className="h-4 w-4 text-[#287EAD]" />
            <span className="text-sm font-semibold text-[#1F2933]">Column: {draft.label || "Untitled"}</span>
          </div>
          <button onClick={() => setTab("field")}
            className={cn("px-6 py-3 text-sm font-semibold transition-colors",
              tab === "field" ? "bg-[#287EAD] text-white" : "bg-white text-[#5E6870] hover:bg-[#F3F5F6]")}>
            Field Properties
          </button>
          <button onClick={() => setTab("advanced")}
            className={cn("px-6 py-3 text-sm font-semibold transition-colors",
              tab === "advanced" ? "bg-[#287EAD] text-white" : "bg-white text-[#5E6870] hover:bg-[#F3F5F6]")}>
            Advanced Properties
          </button>
          <button onClick={onClose} className="px-4 text-[#5E6870] hover:bg-[#F3F5F6]">
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Body */}
        <div className="max-h-[70vh] overflow-y-auto p-6">
          {tab === "field" && (
            <div className="space-y-4">
              <Row label="Label" required>
                <input className={iCls} value={draft.label}
                  onChange={(e) => {
                    const label = e.target.value;
                    set(autoKey ? { label, key: deriveKeyFromLabel(label, draft.key) } : { label });
                  }} />
              </Row>
              <Row label="ID" hint={autoKey ? "Following the label automatically — edit directly to take over." : undefined}>
                <input className={cn(iCls, "font-mono", keyDuplicate && "border-red-500 focus:border-red-500 focus:ring-red-500/20")} value={draft.key}
                  onChange={(e) => { setAutoKey(false); set({ key: slugifyLive(e.target.value) || draft.key }); }} />
                {keyDuplicate && (
                  <div className="flex items-center gap-1.5 text-xs text-red-500 mt-1">
                    <AlertCircle className="h-3 w-3" /> Duplicate ID — must be unique within this table
                  </div>
                )}
              </Row>
              <Row label="Type">
                {/* Currency is no longer a separate type — a Number column
                    becomes a currency purely through its number format. */}
                <select value={draft.type === "currency" ? "number" : (draft.type ?? "text")}
                  onChange={(e) => set({ type: e.target.value as TableColumnType })}
                  className={iCls}>
                  {COL_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
                </select>
              </Row>
              {isNumeric && (
                <Row label="Number format" hint="Controls how the cell is displayed and rounded. Turn on “Show as currency” to prefix a symbol.">
                  <NumberFormatEditor
                    value={{
                      asCurrency: draft.type === "currency",
                      decimals: draft.decimals,
                      thousandsSeparator: draft.thousandsSeparator,
                      currencySymbol: draft.currencySymbol,
                      currencyFrom: draft.currencyFromColumn,
                    }}
                    symbolSources={currencySourceColumns.map((c) => ({ key: c.key, label: c.label }))}
                    symbolSourceNoun="column"
                    inputCls={iCls}
                    onChange={(patch) =>
                      set({
                        ...(patch.asCurrency === undefined ? {} : { type: patch.asCurrency ? "currency" : "number" }),
                        ...("decimals" in patch ? { decimals: patch.decimals } : {}),
                        ...("thousandsSeparator" in patch ? { thousandsSeparator: patch.thousandsSeparator } : {}),
                        ...("currencySymbol" in patch ? { currencySymbol: patch.currencySymbol } : {}),
                        ...("currencyFrom" in patch ? { currencyFromColumn: patch.currencyFrom } : {}),
                      })
                    }
                  />
                </Row>
              )}
              <Row label="Mandatory">
                <ToggleYesNo value={!!draft.required} onChange={(v) => set({ required: v })} />
              </Row>
              <Row label="Additional text">
                <input className={iCls} value={draft.additionalText ?? ""} onChange={(e) => set({ additionalText: e.target.value })} placeholder="Helper line shown below the label" />
              </Row>
              <Row label="Tooltip">
                <input className={iCls} value={draft.tooltip ?? ""} onChange={(e) => set({ tooltip: e.target.value })} placeholder="Shown on hover (?)" />
              </Row>
              <Row label="Default value">
                {isDropdown ? (
                  <select className={iCls} value={draft.defaultValue ?? ""} onChange={(e) => set({ defaultValue: e.target.value })}>
                    <option value="">—</option>
                    {(draft.options ?? []).map((o) => <option key={o} value={o}>{o}</option>)}
                  </select>
                ) : (
                  <input className={iCls} value={draft.defaultValue ?? ""} onChange={(e) => set({ defaultValue: e.target.value })} />
                )}
              </Row>
              <Row label="Regular expression">
                <input className={cn(iCls, "font-mono")} value={draft.regex ?? ""} onChange={(e) => set({ regex: e.target.value })} placeholder="^[A-Z0-9-]+$" />
              </Row>

              {isDropdown && (
                <Row label="List of dropdown values">
                  <DropdownValuesEditor
                    options={draft.options ?? []}
                    onChange={(opts) => set({ options: opts })}
                  />
                </Row>
              )}
              <Row label="SunSystems role">
                <select
                  className={iCls}
                  value={draft.sunsystems?.role ?? ""}
                  onChange={(e) => set({ sunsystems: { ...(draft.sunsystems ?? {}), role: e.target.value || undefined } })}
                >
                  {FINANCE_COLUMN_ROLES.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select>
              </Row>
              {draft.sunsystems?.role === "analysis" && (
                <Row label="Analysis code number (1–10)">
                  <input
                    type="number" min={1} max={10}
                    className={iCls}
                    value={draft.sunsystems?.analysisNumber ?? 1}
                    onChange={(e) => set({ sunsystems: { ...(draft.sunsystems ?? {}), analysisNumber: Math.max(1, Math.min(10, Number(e.target.value))) } })}
                  />
                </Row>
              )}
              {draft.sunsystems?.role === "line_amount" && (
                <>
                  <div className="grid grid-cols-2 gap-3">
                    <Row label="Debit / Credit">
                      <select className={iCls} value={draft.sunsystems?.dc ?? "D"}
                        onChange={(e) => set({ sunsystems: { ...(draft.sunsystems ?? {}), dc: e.target.value as "D" | "C" } })}>
                        <option value="D">Debit</option>
                        <option value="C">Credit</option>
                      </select>
                    </Row>
                    <Row label="Default account" hint="Used unless a separate 'Account code' column is set on this table.">
                      <input className={cn(iCls, "font-mono")} value={draft.sunsystems?.account ?? ""}
                        onChange={(e) => set({ sunsystems: { ...(draft.sunsystems ?? {}), account: e.target.value } })}
                        placeholder="e.g. 37400" />
                    </Row>
                  </div>
                  <RetirementConfigEditor
                    column={draft}
                    formFields={formFields}
                    onChange={(retirement) => set({ sunsystems: { ...(draft.sunsystems ?? {}), retirement } })}
                  />
                </>
              )}
              {(isNumeric || draft.type === "date" || draft.type === "text") && (
                <Row label="Calculated">
                  <div className="space-y-1">
                    <ToggleYesNo
                      value={isCalcCol}
                      onChange={(v) => {
                        if (v) set({ calc: draft.calc ?? { expression: "", decimals: isNumeric ? 2 : undefined }, readonly: true });
                        else set({ calc: null, readonly: false });
                      }}
                    />
                    <p className="text-[10px] text-[#8C969E]">Auto-derive this column's value from a formula instead of typing it.</p>
                  </div>
                </Row>
              )}
              {isCalcCol && (
                <Row label="Formula">
                  <ColumnCalcFormulaEditor
                    column={draft}
                    siblingColumns={siblingColumns}
                    formFields={formFields}
                    onChange={(calc) => set({ calc })}
                  />
                </Row>
              )}
            </div>
          )}

          {tab === "advanced" && (
            <div className="space-y-4">
              <Row label="Column width (1–12)">
                <input type="number" min={1} max={12} value={draft.width ?? 2} onChange={(e) => set({ width: Math.max(1, Math.min(12, Number(e.target.value))) })} className={iCls} />
              </Row>
              {isNumeric && (
                <>
                  <Row label="Minimum value"><input type="number" value={draft.min ?? ""} onChange={(e) => set({ min: e.target.value === "" ? undefined : Number(e.target.value) })} className={iCls} /></Row>
                  <Row label="Maximum value"><input type="number" value={draft.max ?? ""} onChange={(e) => set({ max: e.target.value === "" ? undefined : Number(e.target.value) })} className={iCls} /></Row>
                </>
              )}
              {/* Currency symbol / decimals / thousands separator moved to the
                  Field Properties tab ("Number format") — Number and Currency
                  are one type there, distinguished only by that config. */}
              {isText && (
                <>
                  <Row label="Minimum length"><input type="number" min={0} value={draft.minLength ?? ""} onChange={(e) => set({ minLength: e.target.value === "" ? undefined : Number(e.target.value) })} className={iCls} /></Row>
                  <Row label="Maximum length"><input type="number" min={0} value={draft.maxLength ?? ""} onChange={(e) => set({ maxLength: e.target.value === "" ? undefined : Number(e.target.value) })} className={iCls} /></Row>
                </>
              )}
              {(draft.type === "date" || draft.type === "datetime") && (
                <Row label="Date format"><input className={cn(iCls, "font-mono")} value={draft.dateFormat ?? "YYYY-MM-DD"} onChange={(e) => set({ dateFormat: e.target.value })} /></Row>
              )}
              {(draft.type === "reference" || draft.type === "user") && (
                <Row label="Reference source">
                  <select className={iCls} value={draft.referenceSource ?? (draft.type === "user" ? "users" : "documents")} onChange={(e) => set({ referenceSource: e.target.value })}>
                    {REFERENCE_SOURCE_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                  </select>
                </Row>
              )}
              <VisibilityEditor
                value={draft}
                sources={columnRuleSources(draft, siblingColumns, formFields)}
                onChange={(patch) => set(patch)}
                subject="column"
                processSteps={processSteps}
              />
              <EditabilityEditor
                value={draft}
                sources={columnRuleSources(draft, siblingColumns, formFields)}
                onChange={(patch) => set(patch)}
                subject="column"
                processSteps={processSteps}
              />
              <p className="text-[11px] text-[#5E6870]">
                Rules that reference another column in this table are evaluated per row —
                the cell is locked (or the column hidden) based on that row's own values.
              </p>

            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between gap-2 border-t border-[#C8CDD2] px-5 py-3">
          <button onClick={onDelete} className="inline-flex items-center gap-1.5 border border-[#AEB5BB] bg-white px-4 py-2 text-sm font-semibold text-red-600 hover:bg-red-50">
            <Trash2 className="h-4 w-4" /> Delete
          </button>
          <div className="flex gap-2">
            <button onClick={onClose} className="border border-[#AEB5BB] bg-white px-4 py-2 text-sm font-semibold text-[#1F2933] hover:bg-[#F3F5F6]">Cancel</button>
            <button onClick={() => onSave(draft)} className="inline-flex items-center gap-2 bg-[#287EAD] px-5 py-2 text-sm font-semibold text-white hover:bg-[#1E6F99]">
              <CheckCircle2 className="h-4 w-4" /> Save
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/* Rule sources available to a table column: its sibling columns in the same
 * table (evaluated per row) plus the top-level form fields. */
function columnRuleSources(
  draft: TableColumn,
  siblingColumns: TableColumn[],
  formFields: TemplateField[],
): Array<{ key: string; label: string }> {
  const own = siblingColumns
    .filter((c) => c.key && c.id !== draft.id)
    .map((c) => ({ key: c.key, label: `This row › ${c.label || c.key}` }));
  return [...own, ...conditionSourcesFrom(formFields)];
}

/* Merge a table row's own cell values into the form-level value map so a
 * column rule can be resolved per row. Row keys win over form keys. */
function rowScopedValues(values: Record<string, unknown>, row?: Record<string, string>): Record<string, unknown> {
  return row ? { ...values, ...row } : values;
}

/* Reusable destructive-action confirmation. Deleting a field, section or
 * column is irreversible from the canvas, so it always goes through here. */
function ConfirmDeleteDialog({ open, title, message, confirmLabel = "Delete", onCancel, onConfirm }: {
  open: boolean;
  title: string;
  message: React.ReactNode;
  confirmLabel?: string;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onCancel(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onCancel]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 p-4" onClick={onCancel}>
      <div role="alertdialog" aria-modal="true" onClick={(e) => e.stopPropagation()}
        className="w-full max-w-md border border-[#C8CDD2] bg-white shadow-2xl">
        <div className="flex items-start gap-3 px-5 py-4">
          <div className="mt-0.5 flex h-8 w-8 flex-shrink-0 items-center justify-center bg-red-50 text-red-600">
            <Trash2 className="h-4 w-4" />
          </div>
          <div className="min-w-0">
            <h3 className="text-sm font-bold text-[#1F2933]">{title}</h3>
            <div className="mt-1 text-sm text-[#5E6870]">{message}</div>
          </div>
        </div>
        <div className="flex justify-end gap-2 border-t border-[#E4E7E9] px-5 py-3">
          <button autoFocus onClick={onCancel}
            className="border border-[#AEB5BB] bg-white px-4 py-2 text-sm font-semibold text-[#1F2933] hover:bg-[#F3F5F6]">
            Cancel
          </button>
          <button onClick={onConfirm}
            className="inline-flex items-center gap-1.5 bg-red-600 px-4 py-2 text-sm font-semibold text-white hover:bg-red-700">
            <Trash2 className="h-4 w-4" /> {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}



function Row({ label, required, hint, children }: { label: string; required?: boolean; hint?: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[180px_1fr] items-start gap-4">
      <label className="pt-2 text-sm font-medium text-[#1F2933]">
        {label}{required && <span className="ml-0.5 text-red-500">*</span>}
      </label>
      <div>
        {children}
        {hint && <p className="mt-1 text-[10px] text-[#8C969E]">{hint}</p>}
      </div>
    </div>
  );
}

function ToggleYesNo({ value, onChange }: { value: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      type="button"
      onClick={() => onChange(!value)}
      className={cn(
        "inline-flex h-7 w-16 items-center rounded-full px-1 transition-colors",
        value ? "bg-[#287EAD]" : "bg-[#C8CDD2]"
      )}
    >
      <span className={cn(
        "flex h-5 w-7 items-center justify-center rounded-full bg-white text-[10px] font-bold transition-transform",
        value ? "translate-x-7 text-[#287EAD]" : "translate-x-0 text-[#5E6870]"
      )}>
        {value ? "Yes" : "No"}
      </span>
    </button>
  );
}

/* A read-only version of the same switch, used to render calculated
 * Yes/No values in the preview — the switch position IS the answer. */
function ReadonlyToggle({ value }: { value: boolean }) {
  return (
    <span
      aria-hidden
      className={cn(
        "inline-flex h-6 w-11 shrink-0 items-center rounded-full px-0.5 transition-colors",
        value ? "bg-[#287EAD]" : "bg-[#C8CDD2]"
      )}
    >
      <span className={cn("h-5 w-5 rounded-full bg-white shadow-sm transition-transform", value ? "translate-x-5" : "translate-x-0")} />
    </span>
  );
}

/* Condition sources include table columns as `table.column`, so visibility
 * and editability rules can be driven by table data and not just form fields. */
function conditionSourcesFrom(fields: TemplateField[]): Array<{ key: string; label: string }> {
  const out: Array<{ key: string; label: string }> = [];
  for (const f of fields) {
    if (!f.key) continue;
    if (f.type === "table") {
      for (const c of f.columns ?? []) {
        if (!c.key) continue;
        out.push({ key: `${f.key}.${c.key}`, label: `${f.label} › ${c.label}` });
      }
      continue;
    }
    if (f.type === "divider" || f.type === "heading") continue;
    out.push({ key: f.key, label: f.label });
  }
  return out;
}

/* One short, contextual example instead of a wall of SUM()/AVG()/COUNT()
 * sample chips that grows with the form. */
function sampleFormulaFor(fieldKey?: string, tableRef?: string): string {
  if (fieldKey && tableRef) return `SUM(${tableRef}) * ${fieldKey}`;
  if (tableRef) return `SUM(${tableRef})`;
  if (fieldKey) return `${fieldKey} * 1.16`;
  return "quantity * unit_price";
}

/* Collapsible list of insertable IDs — collapsed by default so a big form
 * doesn't bury the formula box under dozens of chips. */
function RefPicker({ count, children }: { count: number; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  if (count === 0) return null;
  return (
    <div className="border border-[#E4E7E9] bg-[#FAFBFB]">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center justify-between px-2 py-1.5 text-left text-[11px] font-semibold text-[#5E6870] hover:text-[#287EAD]"
      >
        <span>Insert a field ID{count ? ` (${count})` : ""}</span>
        <span className="font-mono text-[10px]">{open ? "▲" : "▼"}</span>
      </button>
      {open && <div className="space-y-2 border-t border-[#E4E7E9] p-2">{children}</div>}
    </div>
  );
}

/* Numeric display helpers driven by the number-format settings. */
function stepForDecimals(decimals: number): string {
  return decimals <= 0 ? "1" : `0.${"0".repeat(decimals - 1)}1`;
}
function formatNumeric(n: number, decimals: number, thousandsSeparator: boolean): string {
  return n.toLocaleString("en-US", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
    useGrouping: thousandsSeparator,
  });
}
function placeholderForNumber(
  cfg: { placeholder?: string; decimals?: number; thousandsSeparator?: boolean },
  fallback: string,
): string {
  if (cfg.placeholder) return cfg.placeholder;
  if (cfg.decimals === undefined) return fallback;
  return formatNumeric(0, cfg.decimals, cfg.thousandsSeparator ?? true);
}


/* Number formatting shared by top-level fields and table columns. This is the
 * single place where a number "becomes" a currency. */
function NumberFormatEditor({
  value, onChange, symbolSources, inputCls, symbolSourceNoun = "field",
}: {
  value: { asCurrency: boolean; decimals?: number; thousandsSeparator?: boolean; currencySymbol?: string; currencyFrom?: string };
  onChange: (patch: Partial<{ asCurrency: boolean; decimals?: number; thousandsSeparator?: boolean; currencySymbol?: string; currencyFrom?: string }>) => void;
  symbolSources: Array<{ key: string; label: string }>;
  inputCls: string;
  symbolSourceNoun?: string;
}) {
  const decimals = value.decimals ?? (value.asCurrency ? 2 : 0);
  const sep = value.thousandsSeparator ?? true;
  const sample = (12345.6789).toLocaleString(sep ? "en-US" : undefined, {
    minimumFractionDigits: decimals, maximumFractionDigits: decimals, useGrouping: sep,
  });

  return (
    <div className="space-y-2.5 border border-[#C8CDD2] bg-white p-2.5">
      <div className="flex items-center justify-between gap-3">
        <div>
          <div className="text-[12px] font-semibold text-[#2C3338]">Show as currency</div>
          <div className="text-[10px] text-[#8C969E]">Prefixes a symbol; otherwise it stays a plain number.</div>
        </div>
        <ToggleYesNo value={value.asCurrency} onChange={(v) => onChange({ asCurrency: v })} />
      </div>

      <div className="grid grid-cols-2 gap-2">
        <label className="space-y-1">
          <span className="text-[10px] font-semibold uppercase tracking-wider text-[#5E6870]">Decimal places</span>
          <input type="number" min={0} max={6} value={decimals}
            onChange={(e) => onChange({ decimals: Math.max(0, Math.min(6, Number(e.target.value) || 0)) })}
            className={cn(inputCls, "h-8")} />
        </label>
        <div className="space-y-1">
          <span className="text-[10px] font-semibold uppercase tracking-wider text-[#5E6870]">Thousands separator</span>
          <div className="flex h-8 items-center">
            <ToggleYesNo value={sep} onChange={(v) => onChange({ thousandsSeparator: v })} />
          </div>
        </div>
      </div>

      {value.asCurrency && (
        <div className="grid grid-cols-2 gap-2">
          <label className="space-y-1">
            <span className="text-[10px] font-semibold uppercase tracking-wider text-[#5E6870]">Symbol source</span>
            <select className={cn(inputCls, "h-8")} value={value.currencyFrom ?? ""}
              onChange={(e) => onChange({ currencyFrom: e.target.value || undefined })}>
              <option value="">Fixed symbol</option>
              {symbolSources.map((s) => (
                <option key={s.key} value={s.key}>From {symbolSourceNoun}: {s.label}</option>
              ))}
            </select>
          </label>
          <label className="space-y-1">
            <span className="text-[10px] font-semibold uppercase tracking-wider text-[#5E6870]">
              {value.currencyFrom ? "Fallback symbol" : "Symbol"}
            </span>
            <input className={cn(inputCls, "h-8")} value={value.currencySymbol ?? "KSh"}
              onChange={(e) => onChange({ currencySymbol: e.target.value })} />
          </label>
        </div>
      )}

      <div className="border-t border-dashed border-[#E4E7E9] pt-2 text-[11px] text-[#5E6870]">
        Preview:{" "}
        <span className="font-mono font-semibold text-[#2C3338]">
          {value.asCurrency ? `${value.currencySymbol ?? "KSh"} ` : ""}{sample}
        </span>
      </div>
    </div>
  );
}



function DropdownValuesEditor({ options, onChange }: { options: string[]; onChange: (opts: string[]) => void }) {
  const [draft, setDraft] = useState("");
  const move = (idx: number, dir: "up" | "down") => {
    const next = [...options];
    const target = dir === "up" ? idx - 1 : idx + 1;
    if (target < 0 || target >= next.length) return;
    [next[idx], next[target]] = [next[target], next[idx]];
    onChange(next);
  };
  return (
    <div className="border border-[#C8CDD2] bg-white">
      <div className="flex items-center justify-between border-b border-[#C8CDD2] bg-[#EEF6FB] px-3 py-2">
        <span className="text-xs font-semibold uppercase tracking-wider text-[#287EAD]">Values</span>
        <button
          type="button"
          title="Append standard currency codes (USD, EUR, KES…) — link an amount field to this dropdown to auto-set its symbol"
          onClick={() => onChange([...options, ...CURRENCY_CODES.filter((c) => !options.includes(c))])}
          className="text-[10px] font-semibold text-[#287EAD] hover:text-[#1E6F99]"
        >
          + Currency codes
        </button>
      </div>
      <div className="divide-y divide-[#E5E8EB]">
        {options.map((opt, idx) => (
          <div key={idx} className="flex items-center gap-2 px-3 py-2">
            <div className="flex flex-col">
              <button onClick={() => move(idx, "up")} disabled={idx === 0} className="text-[#5E6870] hover:text-[#287EAD] disabled:opacity-20"><ChevronUp className="h-3 w-3" /></button>
              <button onClick={() => move(idx, "down")} disabled={idx === options.length - 1} className="text-[#5E6870] hover:text-[#287EAD] disabled:opacity-20"><ChevronDown className="h-3 w-3" /></button>
            </div>
            <input
              value={opt}
              onChange={(e) => {
                const next = [...options]; next[idx] = e.target.value; onChange(next);
              }}
              className="h-8 flex-1 border border-[#AEB5BB] bg-white px-2 text-sm outline-none focus:border-[#287EAD]"
            />
            <button onClick={() => onChange(options.filter((_, i) => i !== idx))} className="p-1.5 text-[#5E6870] hover:text-red-600">
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          </div>
        ))}
      </div>
      <div className="flex gap-2 border-t border-[#C8CDD2] p-2">
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && draft.trim()) { onChange([...options, draft.trim()]); setDraft(""); }
          }}
          placeholder="New value, then Enter or Add"
          className="h-8 flex-1 border border-[#AEB5BB] bg-white px-2 text-sm outline-none focus:border-[#287EAD]"
        />
        <button
          onClick={() => { if (draft.trim()) { onChange([...options, draft.trim()]); setDraft(""); } }}
          className="inline-flex items-center gap-1 bg-[#287EAD] px-3 text-sm font-semibold text-white hover:bg-[#1E6F99]">
          <Plus className="h-3.5 w-3.5" /> Add item
        </button>
      </div>
    </div>
  );
}

/* ============================================================
 * Inspector — Field Properties / Advanced Properties tabs
 * ============================================================ */

function InspectorRow({ label, children, hint }: { label: string; children: React.ReactNode; hint?: string }) {
  return (
    <div className="space-y-1.5">
      <label className="text-xs font-semibold uppercase tracking-wider text-[#5E6870]">{label}</label>
      {children}
      {hint && <p className="text-[10px] text-[#8C969E]">{hint}</p>}
    </div>
  );
}

/* SunSystems binding controls for a single field (inspector). Journal role and
 * budget role are two independent axes, so e.g. an "amount spent"field can both
 * post a journal line AND be the figure checked against the budget. For a table
 * field the journal axis offers "journal lines" (one ledger line per row, with
 * column roles set in the column editor). */
function FinanceBindingFields({ field, onUpdate }: {
  field: TemplateField;
  onUpdate: (patch: Partial<TemplateField>) => void;
}) {
  const isTable = field.type === "table";
  const binding = field.sunsystems ?? {};
  const setB = (patch: Partial<FieldFinanceBinding>) =>
    onUpdate({ sunsystems: { ...binding, ...patch } });

  const role = binding.role ?? "";
  const journalOptions = isTable
    ? [{ value: "", label: "— infer from columns —" }, { value: "journal_lines", label: "Journal lines (one per row)" }]
    : FINANCE_FIELD_ROLES;
  const showAcct = role === "journal_amount" || role === "journal_lines";

  return (
    <div className="space-y-3 border-t border-dashed border-[#C8CDD2] pt-3">
      <InspectorRow
        label="Journal role"
        hint={isTable
          ? "A table becomes a journal line source when one of its columns is marked Line amount."
          : "How this field posts to the SunSystems ledger on approval."}
      >
        <select className={inputCls} value={role} onChange={(e) => setB({ role: e.target.value || undefined })}>
          {journalOptions.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      </InspectorRow>
      {showAcct && (
        <>
          <div className="grid grid-cols-2 gap-3">
            <InspectorRow label="Debit / Credit">
              <select className={inputCls} value={binding.dc ?? "D"} onChange={(e) => setB({ dc: e.target.value as "D" | "C" })}>
                <option value="D">Debit</option>
                <option value="C">Credit</option>
              </select>
            </InspectorRow>
            <InspectorRow label={isTable ? "Default account" : "Account code"} hint={isTable ? "Used unless a column is 'Account code'." : undefined}>
              <input className={cn(inputCls, "font-mono")} value={binding.account ?? ""} onChange={(e) => setB({ account: e.target.value })} placeholder="e.g. 71001" />
            </InspectorRow>
          </div>
          {!isTable && (
            <div className="space-y-1 border border-dashed border-[#C8CDD2] p-2">
              <p className="text-[10px] font-semibold uppercase text-[#5E6870]">Counter entry (double-entry offset)</p>
              <p className="text-[10px] text-[#8C969E]">Automatically posts the balancing leg from the same amount — e.g. Dr 71001 / Cr 10101 for an imprest advance.</p>
              <div className="grid grid-cols-2 gap-2 mt-1.5">
                <InspectorRow label="Counter account">
                  <input className={cn(inputCls, "font-mono")} value={binding.counterAccount ?? ""}
                    onChange={(e) => {
                      const acct = e.target.value || undefined;
                      // Auto-set counterDc to the opposite of the primary dc when first filling this in.
                      const autoCounterDc = binding.dc === "C" ? "D" : "C";
                      setB({ counterAccount: acct, counterDc: binding.counterDc ?? autoCounterDc });
                    }}
                    placeholder="e.g. 10101 (leave blank to skip)" />
                </InspectorRow>
                <InspectorRow label="Counter D/C">
                  <select className={inputCls}
                    value={binding.counterDc ?? (binding.dc === "C" ? "D" : "C")}
                    onChange={(e) => setB({ counterDc: e.target.value as "D" | "C" })}>
                    <option value="D">Debit</option>
                    <option value="C">Credit</option>
                  </select>
                </InspectorRow>
              </div>
            </div>
          )}
        </>
      )}
      {!isTable && (
        <InspectorRow label="Budget role" hint="Independent of the journal role — the same field can do both.">
          <select className={inputCls} value={binding.budgetRole ?? ""} onChange={(e) => setB({ budgetRole: e.target.value || undefined })}>
            {FINANCE_BUDGET_ROLES.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </InspectorRow>
      )}
    </div>
  );
}

/* Visibility modes shared by fields and sections. `hidden` = always hidden,
 * `visibleWhen` = conditional, `visibleToGroups` = role-restricted (sections
 * only), none = always visible. */
type VisibilityMode = "visible" | "hidden" | "conditional" | "groups";

interface VisibilityState {
  hidden?: boolean;
  visibleWhen?: RuleGroup | null;
  visibleToGroups?: SectionGroupRef[];
}

function visibilityModeOf(item: VisibilityState): VisibilityMode {
  if (item.hidden) return "hidden";
  // A defined (even empty) list means "groups"mode is selected — keeps the
  // picker open while the user is still choosing. Other modes clear it to
  // undefined, so an empty list never lingers once a different mode is chosen.
  if (item.visibleToGroups !== undefined) return "groups";
  if (item.visibleWhen) return "conditional";
  return "visible";
}

function defaultCondition(sources: { key: string }[]): VisibilityCondition {
  return { source: "field", fieldKey: sources[0]?.key ?? "", operator: "equals", value: "" };
}

/* Editor for an AND/OR group of visibility conditions. Each condition tests
 * either a form field's value or the document's current process step. */
function RuleGroupEditor({ group, sources, processSteps, onChange, depth = 0 }: {
  group: RuleGroup;
  sources: { key: string; label: string }[];
  processSteps: { value: string; label: string }[];
  onChange: (g: RuleGroup) => void;
  /* Nesting level. One extra level is allowed (depth 1) — deeper rule trees
   * are unreadable in a side panel and are better modelled as two rules. */
  depth?: number;
}) {
  const updateCond = (i: number, patch: Partial<VisibilityCondition>) =>
    onChange({ ...group, conditions: group.conditions.map((c, idx) => (idx === i ? { ...c, ...patch } : c)) });
  const removeCond = (i: number) =>
    onChange({ ...group, conditions: group.conditions.filter((_, idx) => idx !== i) });
  const addCond = () =>
    onChange({ ...group, conditions: [...group.conditions, defaultCondition(sources)] });
  const nested = group.groups ?? [];
  const addGroup = () =>
    onChange({ ...group, groups: [...nested, { combinator: group.combinator === "and" ? "or" : "and", conditions: [defaultCondition(sources)] }] });
  const updateGroup = (i: number, g: RuleGroup) =>
    onChange({ ...group, groups: nested.map((n, idx) => (idx === i ? g : n)) });
  const removeGroup = (i: number) =>
    onChange({ ...group, groups: nested.filter((_, idx) => idx !== i) });

  return (
    <div className="space-y-2">
      {/* AND / OR combinator — only meaningful with 2+ conditions */}
      <div className="flex items-center gap-2">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-[#5E6870]">Match</span>
        <div className="inline-flex overflow-hidden border border-[#C8CDD2]">
          {(["and", "or"] as const).map((c) => (
            <button key={c} type="button" onClick={() => onChange({ ...group, combinator: c })}
              className={cn("px-2.5 py-1 text-[11px] font-semibold uppercase",
                group.combinator === c ? "bg-[#287EAD] text-white" : "bg-white text-[#5E6870] hover:bg-[#F3F5F6]")}>
              {c}
            </button>
          ))}
        </div>
        <span className="text-[10px] text-[#8C969E]">{group.combinator === "and" ? "all conditions" : "any condition"}</span>
      </div>

      {group.conditions.map((c, i) => (
        <div key={i} className="space-y-1.5 border border-[#E5E8EB] bg-[#FAFBFC] p-2">
          <div className="flex items-center gap-1.5">
            <select className={cn(inputCls, "h-8 flex-1")} value={c.source}
              onChange={(e) => {
                const source = e.target.value as ConditionSource;
                updateCond(i, source === "process_step"
                  ? { source, fieldKey: undefined, operator: "equals", value: processSteps[0]?.value ?? "" }
                  : { source, fieldKey: sources[0]?.key ?? "", value: "" });
              }}>
              <option value="field">Form field</option>
              <option value="process_step">Process step</option>
            </select>
            <button type="button" onClick={() => removeCond(i)} title="Remove condition"
              className="p-1 text-[#8C969E] hover:bg-red-50 hover:text-red-500">
              <X className="h-3.5 w-3.5" />
            </button>
          </div>

          {c.source === "field" && (
            <select className={cn(inputCls, "h-8")} value={c.fieldKey ?? ""}
              onChange={(e) => updateCond(i, { fieldKey: e.target.value })}>
              <option value="">— choose a field —</option>
              {sources.map((s) => <option key={s.key} value={s.key}>{s.label} ({s.key})</option>)}
            </select>
          )}

          <div className="grid grid-cols-2 gap-1.5">
            <select className={cn(inputCls, "h-8")} value={c.operator}
              onChange={(e) => updateCond(i, { operator: e.target.value as ConditionOperator })}>
              {OPERATOR_GROUPS.map((g) => {
                /* A process step is a plain label: only text-ish operators apply. */
                const ops = c.source === "process_step"
                  ? g.ops.filter((o) => ["equals", "not_equals", "contains", "not_contains", "starts_with", "ends_with", "in_list", "not_in_list"].includes(o))
                  : g.ops;
                if (!ops.length) return null;
                return (
                  <optgroup key={g.label} label={g.label}>
                    {ops.map((o) => <option key={o} value={o}>{OPERATOR_LABEL[o]}</option>)}
                  </optgroup>
                );
              })}
            </select>
            {!VALUELESS_OPERATORS.has(c.operator) && (
              c.source === "process_step" && !LIST_OPERATORS.has(c.operator) ? (
                <select className={cn(inputCls, "h-8")} value={c.value ?? ""}
                  onChange={(e) => updateCond(i, { value: e.target.value })}>
                  <option value="">— choose a step —</option>
                  {processSteps.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
                </select>
              ) : RANGE_OPERATORS.has(c.operator) ? (
                <div className="flex items-center gap-1">
                  <input className={cn(inputCls, "h-8 min-w-0")} value={(c.value ?? "").split(",")[0] ?? ""} placeholder="From"
                    onChange={(e) => updateCond(i, { value: `${e.target.value},${(c.value ?? "").split(",")[1] ?? ""}` })} />
                  <span className="text-[10px] text-[#8C969E]">–</span>
                  <input className={cn(inputCls, "h-8 min-w-0")} value={(c.value ?? "").split(",")[1] ?? ""} placeholder="To"
                    onChange={(e) => updateCond(i, { value: `${(c.value ?? "").split(",")[0] ?? ""},${e.target.value}` })} />
                </div>
              ) : (
                <input className={cn(inputCls, "h-8")} value={c.value ?? ""}
                  onChange={(e) => updateCond(i, { value: e.target.value })}
                  placeholder={LIST_OPERATORS.has(c.operator) ? "A, B, C" : "Value"} />
              )
            )}
          </div>
          {LIST_OPERATORS.has(c.operator) && (
            <p className="text-[10px] text-[#8C969E]">Separate each accepted value with a comma.</p>
          )}
          <p className="text-[10px] text-[#8C969E]">{summarizeCondition(c)}</p>
        </div>
      ))}

      {/* Nested groups — one level deep, to express "A AND (B OR C)". */}
      {nested.map((n, i) => (
        <div key={`g${i}`} className="border-l-2 border-[#287EAD]/40 pl-2">
          <div className="mb-1 flex items-center justify-between">
            <span className="text-[10px] font-semibold uppercase tracking-wider text-[#287EAD]">Nested group</span>
            <button type="button" onClick={() => removeGroup(i)} title="Remove group"
              className="p-1 text-[#8C969E] hover:bg-red-50 hover:text-red-500">
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
          <RuleGroupEditor group={n} sources={sources} processSteps={processSteps}
            depth={depth + 1} onChange={(g) => updateGroup(i, g)} />
        </div>
      ))}

      <div className="flex flex-wrap items-center gap-3">
        <button type="button" onClick={addCond}
          className="flex items-center gap-1 text-[11px] font-semibold text-[#287EAD] hover:text-[#1E6F99]">
          <Plus className="h-3 w-3" /> Add condition
        </button>
        {depth < 1 && (
          <button type="button" onClick={addGroup}
            className="flex items-center gap-1 text-[11px] font-semibold text-[#5E6870] hover:text-[#287EAD]">
            <Layers className="h-3 w-3" /> Add nested group
          </button>
        )}
      </div>

      {group.conditions.length === 0 && nested.length === 0 && (
        <p className="text-[10px] text-amber-600">Add at least one condition, or this stays visible to everyone.</p>
      )}
      {processSteps.length === 0 && group.conditions.some((c) => c.source === "process_step") && (
        <p className="text-[10px] text-amber-600">No workflow steps found for this document type yet.</p>
      )}
    </div>
  );
}

/* Unified visibility control used by both the field inspector and the section
 * inspector. A single mode selector:
 *   Always visible · Always hidden · Show only when <rule group>
 *   · Visible only to groups…   (sections only — pass `groupOptions`)
 * `sources` are the fields whose values can drive a conditional rule;
 * `processSteps` are the workflow statuses for "process step"conditions. */
function VisibilityEditor({ value, sources, onChange, subject, groupOptions, processSteps = [] }: {
  value: VisibilityState;
  sources: { key: string; label: string }[];
  onChange: (patch: VisibilityState) => void;
  subject: "field" | "section" | "column";
  groupOptions?: { id: string; name: string }[];
  processSteps?: { value: string; label: string }[];
}) {
  const mode = visibilityModeOf(value);
  const rule = value.visibleWhen ?? null;
  const allowsGroups = Array.isArray(groupOptions);
  const selectedGroups = value.visibleToGroups ?? [];
  const isGroupSelected = (id: string) => selectedGroups.some((g) => g.id === id);

  const setMode = (m: VisibilityMode) => {
    const cleared = { hidden: false, visibleWhen: null, visibleToGroups: undefined } as VisibilityState;
    if (m === "visible") onChange(cleared);
    else if (m === "hidden") onChange({ ...cleared, hidden: true });
    else if (m === "groups") onChange({ ...cleared, visibleToGroups: selectedGroups });
    else onChange({
      ...cleared,
      visibleWhen: rule ?? { combinator: "and", conditions: [defaultCondition(sources)] },
    });
  };

  const toggleGroup = (g: { id: string; name: string }) => {
    const next = isGroupSelected(g.id)
      ? selectedGroups.filter((s) => s.id !== g.id)
      : [...selectedGroups, { id: g.id, name: g.name }];
    onChange({ hidden: false, visibleWhen: null, visibleToGroups: next });
  };

  return (
    <InspectorRow
      label="Visibility"
      hint={
        mode === "hidden"
          ? `This ${subject} is always hidden from people filling the form.`
          : mode === "groups"
            ? "Only members of the selected groups (and admins) see this section."
            : `Control when this ${subject} appears for people filling the form.`
      }
    >
      <div className="space-y-2 border border-[#C8CDD2] bg-white p-2.5">
        <select className={inputCls} value={mode} onChange={(e) => setMode(e.target.value as VisibilityMode)}>
          <option value="visible">Always visible</option>
          <option value="hidden">Always hidden</option>
          <option value="conditional">Show only when…</option>
          {allowsGroups && <option value="groups">Visible only to groups…</option>}
        </select>
        {mode === "groups" && allowsGroups && (
          <div className="space-y-1">
            {groupOptions!.length === 0 && (
              <p className="text-[10px] text-amber-600">No groups defined yet.</p>
            )}
            <div className="max-h-40 overflow-y-auto border border-[#E5E8EB] divide-y divide-[#F0F2F3]">
              {groupOptions!.map((g) => (
                <label key={g.id} className="flex cursor-pointer items-center gap-2 px-2 py-1.5 text-xs text-[#1F2933] hover:bg-[#F6F7F8]">
                  <input type="checkbox" checked={isGroupSelected(g.id)} onChange={() => toggleGroup(g)}
                    className="h-3.5 w-3.5 accent-[#287EAD]" />
                  <span className="truncate">{g.name}</span>
                </label>
              ))}
            </div>
            {selectedGroups.length === 0 && (
              <p className="text-[10px] text-amber-600">Pick at least one group, or the section stays visible to everyone.</p>
            )}
          </div>
        )}
        {mode === "conditional" && rule && (
          <RuleGroupEditor group={rule} sources={sources} processSteps={processSteps}
            onChange={(g) => onChange({ visibleWhen: g })} />
        )}
      </div>
    </InspectorRow>
  );
}

/* Editability modes — the "Security"axis. `readonly` = always read-only,
 * `editableWhen` = editable only when the group matches (read-only otherwise). */
type EditabilityMode = "editable" | "readonly" | "conditional";
interface EditabilityState {
  readonly?: boolean;
  editableWhen?: RuleGroup | null;
}
function editabilityModeOf(item: EditabilityState): EditabilityMode {
  if (item.readonly) return "readonly";
  if (item.editableWhen) return "conditional";
  return "editable";
}

/* Companion to VisibilityEditor for the "Editable if / read-only"axis. Reuses
 * the same rule-group editor (form-field + process-step conditions). */
function EditabilityEditor({ value, sources, onChange, subject, processSteps = [] }: {
  value: EditabilityState;
  sources: { key: string; label: string }[];
  onChange: (patch: EditabilityState) => void;
  subject: "field" | "section" | "column";
  processSteps?: { value: string; label: string }[];
}) {
  const mode = editabilityModeOf(value);
  const rule = value.editableWhen ?? null;
  const setMode = (m: EditabilityMode) => {
    const cleared = { readonly: false, editableWhen: null } as EditabilityState;
    if (m === "editable") onChange(cleared);
    else if (m === "readonly") onChange({ ...cleared, readonly: true });
    else onChange({ ...cleared, editableWhen: rule ?? { combinator: "and", conditions: [defaultCondition(sources)] } });
  };
  return (
    <InspectorRow
      label="Editability"
      hint={
        mode === "readonly"
          ? `This ${subject} is always read-only.`
          : mode === "conditional"
            ? `Editable only while the rules below match — read-only at every other step.`
            : `Control when people can edit this ${subject}.`
      }
    >
      <div className="space-y-2 border border-[#C8CDD2] bg-white p-2.5">
        <select className={inputCls} value={mode} onChange={(e) => setMode(e.target.value as EditabilityMode)}>
          <option value="editable">Always editable</option>
          <option value="readonly">Always read-only</option>
          <option value="conditional">Editable only when…</option>
        </select>
        {mode === "conditional" && rule && (
          <RuleGroupEditor group={rule} sources={sources} processSteps={processSteps}
            onChange={(g) => onChange({ editableWhen: g })} />
        )}
      </div>
    </InspectorRow>
  );
}

/* Formula editor for the four "Calculated …"field types. Lets the admin
 * write an arithmetic expression over sibling field KEYS (click a chip to
 * insert it), matching the server evaluator 1:1. Shows a quick sanity-check
 * value (every referenced field = 100) so a typo is obvious immediately,
 * without needing to switch to the Preview tab. */
function CalcFormulaEditor({ field, siblings, onUpdate }: {
  field: TemplateField;
  siblings: TemplateField[];
  onUpdate: (patch: Partial<TemplateField>) => void;
}) {
  const calc = field.calc ?? { expression: "" };
  const exprRef = useRef<HTMLTextAreaElement>(null);
  const keyedSiblings = siblings.filter((s) => s.key && s.type !== "table");
  const tableSiblings = siblings.filter((s) => s.key && s.type === "table");

  const insertToken = (key: string) => {
    const el = exprRef.current;
    if (!el) { onUpdate({ calc: { ...calc, expression: `${calc.expression}${key}` } }); return; }
    const start = el.selectionStart ?? el.value.length;
    const end = el.selectionEnd ?? el.value.length;
    const next = `${calc.expression.slice(0, start)}${key}${calc.expression.slice(end)}`;
    onUpdate({ calc: { ...calc, expression: next } });
    requestAnimationFrame(() => { el.focus(); el.selectionStart = el.selectionEnd = start + key.length; });
  };

  // Quick sanity preview: every referenced sibling = 100.
  const sampleScope: Record<string, number> = {};
  keyedSiblings.forEach((s) => { sampleScope[s.key] = 100; });
  /* Table columns are addressable both bare (`amount`) and qualified
   * (`expenses.amount`), so both spellings count as "known"for validation. */
  const knownKeys = [
    ...keyedSiblings.map((s) => s.key),
    ...tableSiblings.flatMap((t) => (t.columns ?? []).filter((c) => c.key).flatMap((c) => [c.key, `${t.key}.${c.key}`])),
  ];
  const formulaError = validateCalcExpression(calc.expression, knownKeys);
  const previewValue = formulaError
    ? ""
    : formatCalcResult(field.type, previewCalcValue(calc.expression, sampleScope, calc.decimals));
  const showDecimals = field.type !== "calc_text" && field.type !== "calc_date" && field.type !== "calc_boolean";

  const sampleFormula = sampleFormulaFor(
    keyedSiblings[0]?.key,
    tableSiblings[0] ? `${tableSiblings[0].key}.${(tableSiblings[0].columns ?? []).find((c) => c.key)?.key ?? "amount"}` : undefined,
  );

  return (
    <InspectorRow
      label="Formula"
      hint="Arithmetic, comparisons and IF(…) over other field IDs. Open Function reference below for the full list. This formula re-runs authoritatively on the server at submit time."
    >
      <div className="space-y-2 border border-[#C8CDD2] bg-white p-2.5">
        <textarea
          ref={exprRef}
          value={calc.expression}
          onChange={(e) => onUpdate({ calc: { ...calc, expression: e.target.value } })}
          placeholder={`e.g. ${sampleFormula}`}
          rows={2}
          className={cn(inputCls, "h-auto min-h-[52px] py-2 font-mono resize-none")}
        />
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" onClick={() => insertToken('IF(condition, "value if true", "value if false")')}
            className="inline-flex items-center gap-1 border border-[#287EAD]/40 bg-[#EEF6FB] px-2 py-1 font-mono text-[10px] font-semibold text-[#287EAD] hover:bg-[#287EAD] hover:text-white">
            + Insert IF(condition, …)
          </button>
          <button type="button" onClick={() => insertToken(sampleFormula)}
            className="inline-flex items-center gap-1 border border-[#C8CDD2] bg-[#F6F7F8] px-2 py-1 font-mono text-[10px] font-semibold text-[#5E6870] hover:border-[#287EAD] hover:text-[#287EAD]">
            + Insert sample
          </button>
        </div>

        {/* Field / column IDs are hidden behind a disclosure — a long form can
            have dozens of them and they used to flood the inspector. */}
        <RefPicker
          count={keyedSiblings.length + tableSiblings.reduce((n, t) => n + (t.columns ?? []).filter((c) => c.key).length, 0)}
        >
          {keyedSiblings.length > 0 && (
            <div className="space-y-1">
              <span className="text-[10px] font-semibold uppercase tracking-wider text-[#5E6870]">Other fields</span>
              <div className="flex flex-wrap gap-1">
                {keyedSiblings.map((s) => (
                  <button key={s.id} type="button" onClick={() => insertToken(s.key)} title={`Insert ${s.key}`}
                    className="border border-[#C8CDD2] bg-[#F6F7F8] px-1.5 py-0.5 font-mono text-[10px] text-[#287EAD] hover:border-[#287EAD] hover:bg-[#EEF6FB]">
                    {s.key}
                  </button>
                ))}
              </div>
            </div>
          )}
          {tableSiblings.map((t) => {
            const allCols = (t.columns ?? []).filter((c) => c.key);
            if (allCols.length === 0) return null;
            return (
              <div key={t.id} className="space-y-1">
                <span className="text-[10px] font-semibold uppercase tracking-wider text-[#5E6870]">"{t.label}" columns</span>
                <div className="flex flex-wrap gap-1">
                  {allCols.map((c) => (
                    <button key={c.id} type="button" onClick={() => insertToken(`${t.key}.${c.key}`)} title={`Insert ${t.key}.${c.key} — wrap in SUM()/AVG()/COUNT() to total every row`}
                      className="border border-teal-200 bg-teal-50 px-1.5 py-0.5 font-mono text-[10px] text-teal-700 hover:border-teal-400">
                      {t.key}.{c.key}
                    </button>
                  ))}
                </div>
              </div>
            );
          })}
          <p className="text-[10px] text-[#8C969E]">
            A bare reference is the field's own value (row 1 for a table column). Wrap a table
            column to total every row — e.g. <code className="font-mono">SUM(table_id.column_id)</code>.
          </p>
        </RefPicker>
        {keyedSiblings.length === 0 && tableSiblings.length === 0 && (
          <p className="text-[10px] text-amber-600">Add other fields to this form first — a formula needs something to reference.</p>
        )}
        {showDecimals && (
          <div className="flex items-center gap-2 pt-1">
            <span className="text-[11px] font-semibold uppercase tracking-wider text-[#5E6870]">Decimal places</span>
            <input type="number" min={0} max={6} value={calc.decimals ?? 2}
              onChange={(e) => onUpdate({ calc: { ...calc, decimals: Math.max(0, Math.min(6, Number(e.target.value))) } })}
              className={cn(inputCls, "h-8 w-20")} />
          </div>
        )}
        <FormulaStatus error={formulaError} expression={calc.expression} previewValue={previewValue} />
        <FormulaReference />
      </div>
    </InspectorRow>
  );
}

function FieldEditor({ field, onUpdate, allFields, processSteps }: {
  field: TemplateField;
  onUpdate: (patch: Partial<TemplateField>) => void;
  allFields: TemplateField[];
  processSteps: { value: string; label: string }[];
}) {
  const [tab, setTab] = useState<"field" | "advanced">("field");
  const isTable = field.type === "table";
  const isLayout = field.type === "divider" || field.type === "heading";
  const isNumeric = field.type === "number" || field.type === "currency";
  const isText = field.type === "text" || field.type === "textarea" || field.type === "email" || field.type === "phone";
  const isCalculated = CALCULATED_TYPES.has(field.type);
  const hasOptions = field.type === "select" || field.type === "radio" || field.type === "multi_select";

  // Whether the Field Key still follows the Label (see deriveKeyFromLabel /
  // looksAutoGenerated above). Re-evaluated whenever a DIFFERENT field is
  // selected — each field's editor session starts fresh, defaulting to "on"
  // only if its key still looks like an untouched auto-default.
  const [autoKey, setAutoKey] = useState(() => looksAutoGenerated(field.key));
  useEffect(() => { setAutoKey(looksAutoGenerated(field.key)); }, [field.id]);

  const keyDuplicate = allFields.filter((f) => f.id !== field.id && f.key === field.key).length > 0;
  const siblings = allFields.filter((f) => f.id !== field.id && f.key);
  // Fields whose selected value can drive a currency field's symbol — dropdowns
  // (and plain text) that hold a currency code.
  const currencySourceSiblings = siblings.filter((s) => ["select", "radio", "text"].includes(s.type));

  return (
    <div className="space-y-5">
      {/* Tabs */}
      <div className="flex border border-[#C8CDD2] bg-white">
        <button onClick={() => setTab("field")}
          className={cn("flex-1 py-2 text-xs font-semibold transition-colors",
            tab === "field" ? "bg-[#287EAD] text-white" : "text-[#5E6870] hover:bg-[#F3F5F6]")}>
          Field Properties
        </button>
        <button onClick={() => setTab("advanced")}
          className={cn("flex-1 py-2 text-xs font-semibold transition-colors",
            tab === "advanced" ? "bg-[#287EAD] text-white" : "text-[#5E6870] hover:bg-[#F3F5F6]")}>
          Advanced Properties
        </button>
      </div>

      {tab === "field" && (
        <>
          {!isLayout && (
            <InspectorRow label="Label">
              <input className={inputCls} value={field.label}
                onChange={(e) => {
                  const label = e.target.value;
                  onUpdate(autoKey ? { label, key: deriveKeyFromLabel(label, field.key) } : { label });
                }} />
            </InspectorRow>
          )}
          <InspectorRow label="Field Key" hint={autoKey ? "Following the label automatically — edit directly to take over." : "Used as the variable name in generated documents"}>
            <input
              className={cn(inputCls, keyDuplicate && "border-red-500 focus:border-red-500 focus:ring-red-500/20", "font-mono")}
              value={field.key}
              onChange={(e) => { setAutoKey(false); onUpdate({ key: slugifyLive(e.target.value) || field.key }); }}
            />
            {keyDuplicate && (
              <div className="flex items-center gap-1.5 text-xs text-red-500 mt-1">
                <AlertCircle className="h-3 w-3" /> Duplicate key — must be unique
              </div>
            )}
          </InspectorRow>
          {!["heading", "divider", "checkbox", "boolean", "table", "file", "image", "signature",
            "rating", "auto_number", "calc_number", "calc_currency", "calc_text", "calc_date",
            "calc_boolean", "multi_file", "info", "spacer"].includes(field.type) && (
              <InspectorRow label="Placeholder">
                <input className={inputCls} value={field.placeholder ?? ""} onChange={(e) => onUpdate({ placeholder: e.target.value })} />
              </InspectorRow>
            )}
          <InspectorRow label="Help text">
            <input className={inputCls} value={field.helpText ?? ""} onChange={(e) => onUpdate({ helpText: e.target.value })} />
          </InspectorRow>
          <InspectorRow label="Tooltip">
            <input className={inputCls} value={field.tooltip ?? ""} onChange={(e) => onUpdate({ tooltip: e.target.value })} />
          </InspectorRow>
          {!isTable && (
            <InspectorRow label={`Column width — ${field.colSpan} / 12`}>
              <input type="range" min={1} max={12} value={field.colSpan ?? 6}
                onChange={(e) => onUpdate({ colSpan: Number(e.target.value) })}
                className="w-full accent-[#287EAD]" />
              <div className="flex justify-between text-[10px] text-[#5E6870]"><span>1</span><span>6</span><span>12</span></div>
            </InspectorRow>
          )}
          {!isLayout && !isTable && !isCalculated && (
            <div className="flex items-center gap-6">
              <label className="flex cursor-pointer items-center gap-2.5 text-sm text-[#1F2933]">
                <input type="checkbox" checked={!!field.required} onChange={(e) => onUpdate({ required: e.target.checked })}
                  className="h-4 w-4 border-[#AEB5BB] accent-[#287EAD]" />
                Required
              </label>
              {/* Read-only moved to the Editability control (Advanced tab). */}
            </div>
          )}
          {isTable && (
            <InspectorRow label="Minimum rows shown">
              <input type="number" min={1} max={20} value={field.minRows ?? 2}
                onChange={(e) => onUpdate({ minRows: Number(e.target.value) })} className={inputCls} />
            </InspectorRow>
          )}
          {hasOptions && (
            <InspectorRow label="Options">
              <DropdownValuesEditor
                options={field.options ?? []}
                onChange={(opts) => onUpdate({ options: opts })}
              />
            </InspectorRow>
          )}
          {field.type === "rating" && (
            <InspectorRow label="Number of stars">
              <input type="number" min={2} max={10} value={field.max ?? 5}
                onChange={(e) => onUpdate({ max: Math.max(2, Math.min(10, Number(e.target.value))) })} className={inputCls} />
            </InspectorRow>
          )}
          {isNumeric && (
            <NumberFormatEditor
              value={{
                asCurrency: field.type === "currency",
                decimals: field.decimals,
                thousandsSeparator: field.thousandsSeparator,
                currencySymbol: field.currencySymbol,
                currencyFrom: field.currencyFromField,
              }}
              symbolSources={currencySourceSiblings.map((s) => ({ key: s.key, label: s.label }))}
              inputCls={inputCls}
              onChange={(patch) =>
                onUpdate({
                  ...(patch.asCurrency === undefined ? {} : { type: patch.asCurrency ? "currency" : "number" }),
                  ...("decimals" in patch ? { decimals: patch.decimals } : {}),
                  ...("thousandsSeparator" in patch ? { thousandsSeparator: patch.thousandsSeparator } : {}),
                  ...("currencySymbol" in patch ? { currencySymbol: patch.currencySymbol } : {}),
                  ...("currencyFrom" in patch ? { currencyFromField: patch.currencyFrom } : {}),
                })
              }
            />
          )}
          {(field.type === "reference" || field.type === "user") && (
            <InspectorRow label="Reference source">
              <select className={inputCls} value={field.referenceSource ?? (field.type === "user" ? "users" : "documents")} onChange={(e) => onUpdate({ referenceSource: e.target.value })}>
                {REFERENCE_SOURCE_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </InspectorRow>
          )}
          {FORMULA_FIELD_TYPES.has(field.type) && (
            <InspectorRow label="Auto-fill" hint="Fill this field automatically — the user won't type it.">
              <select className={inputCls} value={field.formula ?? ""} onChange={(e) => onUpdate({ formula: e.target.value || undefined })}>
                {FORMULA_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </InspectorRow>
          )}
          {isCalculated && (
            <CalcFormulaEditor field={field} siblings={siblings} onUpdate={onUpdate} />
          )}
          {!isLayout && (
            <FinanceBindingFields field={field} onUpdate={onUpdate} />
          )}
        </>
      )}

      {tab === "advanced" && (
        <>
          <InspectorRow label="Default value">
            <input className={inputCls} value={field.defaultValue ?? ""} onChange={(e) => onUpdate({ defaultValue: e.target.value })} />
          </InspectorRow>
          <InspectorRow label="Regular expression" hint="Validation pattern, e.g. ^[A-Z0-9-]+$">
            <input className={cn(inputCls, "font-mono")} value={field.regex ?? ""} onChange={(e) => onUpdate({ regex: e.target.value })} />
          </InspectorRow>
          {isNumeric && (
            <div className="grid grid-cols-2 gap-3">
              <InspectorRow label="Min"><input type="number" className={inputCls} value={field.min ?? ""} onChange={(e) => onUpdate({ min: e.target.value === "" ? undefined : Number(e.target.value) })} /></InspectorRow>
              <InspectorRow label="Max"><input type="number" className={inputCls} value={field.max ?? ""} onChange={(e) => onUpdate({ max: e.target.value === "" ? undefined : Number(e.target.value) })} /></InspectorRow>
            </div>
          )}
          {/* Currency/number formatting now lives in Field Properties — see
              the "Number format" block there (merged Number + Currency). */}
          {field.type === "calc_currency" && (
            <InspectorRow label="Currency symbol" hint="Fixed symbol shown before the computed amount.">
              <input className={inputCls} value={field.currencySymbol ?? "KSh"}
                onChange={(e) => onUpdate({ currencySymbol: e.target.value })} placeholder="Symbol, e.g. KSh" />
            </InspectorRow>
          )}
          {isText && (
            <div className="grid grid-cols-2 gap-3">
              <InspectorRow label="Min length"><input type="number" min={0} className={inputCls} value={field.minLength ?? ""} onChange={(e) => onUpdate({ minLength: e.target.value === "" ? undefined : Number(e.target.value) })} /></InspectorRow>
              <InspectorRow label="Max length"><input type="number" min={0} className={inputCls} value={field.maxLength ?? ""} onChange={(e) => onUpdate({ maxLength: e.target.value === "" ? undefined : Number(e.target.value) })} /></InspectorRow>
            </div>
          )}
          {(field.type === "date" || field.type === "datetime") && (
            <InspectorRow label="Date format">
              <input className={cn(inputCls, "font-mono")} value={field.dateFormat ?? "YYYY-MM-DD"} onChange={(e) => onUpdate({ dateFormat: e.target.value })} />
            </InspectorRow>
          )}
          <VisibilityEditor
            value={field}
            sources={conditionSourcesFrom(siblings)}
            onChange={onUpdate}
            subject="field"
            processSteps={processSteps}
          />
          <EditabilityEditor
            value={field}
            sources={conditionSourcesFrom(siblings)}
            onChange={onUpdate}
            subject="field"
            processSteps={processSteps}
          />
        </>
      )}
    </div>
  );
}

function SectionEditor({ section, onUpdate, allFields, processSteps }: {
  section: TemplateSection;
  onUpdate: (patch: Partial<TemplateSection>) => void;
  allFields: TemplateField[];
  processSteps: { value: string; label: string }[];
}) {
  // A section rule can be driven by any field on the form (sections have no
  // siblings of their own), excluding fields that live in this same section —
  // those would be hidden alongside it.
  const ownFieldIds = new Set(section.fields.map((f) => f.id));
  const sources = conditionSourcesFrom(allFields.filter((f) => f.key && !ownFieldIds.has(f.id)));

  // RBAC groups for the "visible only to groups"mode.
  const { data: groups = [] } = useQuery({
    queryKey: ["groups", "list"],
    queryFn: async () => {
      const res = await groupsAPI.list();
      const rows = (res.data?.results ?? res.data ?? []) as Array<{ id: string; name: string }>;
      return rows.map((g) => ({ id: String(g.id), name: String(g.name) }));
    },
    staleTime: 60_000,
  });
  return (
    <div className="space-y-4">
      <InspectorRow label="Section title">
        <input className={inputCls} value={section.title} onChange={(e) => onUpdate({ title: e.target.value })} />
      </InspectorRow>
      <InspectorRow label="Description">
        <textarea value={section.description ?? ""} rows={3}
          onChange={(e) => onUpdate({ description: e.target.value })}
          className={inputCls.replace("h-9", "min-h-[76px] py-2 resize-none")} />
      </InspectorRow>
      <VisibilityEditor
        value={section}
        sources={sources}
        onChange={onUpdate}
        subject="section"
        groupOptions={groups}
        processSteps={processSteps}
      />
      <EditabilityEditor
        value={section}
        sources={sources}
        onChange={onUpdate}
        subject="section"
        processSteps={processSteps}
      />
    </div>
  );
}

function Inspector({ sections, selectedId, onUpdateField, onUpdateSection, onCollapse, processSteps }: {
  sections: TemplateSection[]; selectedId: string | null;
  onUpdateField: (sectionId: string, fieldId: string, patch: Partial<TemplateField>) => void;
  onUpdateSection: (sectionId: string, patch: Partial<TemplateSection>) => void;
  onCollapse: () => void;
  processSteps: { value: string; label: string }[];
}) {
  let target:
    | { kind: "field"; field: TemplateField; sectionId: string }
    | { kind: "section"; section: TemplateSection }
    | null = null;

  const allFields: TemplateField[] = sections.flatMap((s) => s.fields);

  for (const s of sections) {
    if (s.id === selectedId) { target = { kind: "section", section: s }; break; }
    const f = s.fields.find((x) => x.id === selectedId);
    if (f) { target = { kind: "field", field: f, sectionId: s.id }; break; }
  }

  return (
    <aside className="flex h-full w-full flex-col border-l border-[#C8CDD2] bg-[#F6F7F8]">
      <div className="flex items-start justify-between gap-2 border-b border-[#C8CDD2] px-5 py-4">
        <div className="flex-1 min-w-0">
          <h2 className="text-xs font-semibold uppercase tracking-widest text-[#5E6870]">
            {target?.kind === "field" ? "Field Settings" : target?.kind === "section" ? "Section Settings" : "Inspector"}
          </h2>
          <p className="mt-1 truncate text-sm font-semibold text-[#1F2933]">
            {target?.kind === "field"
              ? FIELD_META[target.field.type]?.label ?? target.field.type
              : target?.kind === "section" ? target.section.title
                : "Nothing selected"}
          </p>
          {target?.kind === "field" && (
            <p className="mt-0.5 truncate font-mono text-xs text-[#5E6870]">{target.field.key}</p>
          )}
        </div>
        <button onClick={onCollapse} title="Collapse inspector"
          className="mt-0.5 shrink-0 p-1.5 text-[#5E6870] hover:bg-white hover:text-[#287EAD] transition-colors">
          <ChevronRight className="h-4 w-4" />
        </button>
      </div>
      <div className="flex-1 overflow-y-auto px-5 py-5">
        {!target && (
          <div className="flex flex-col items-center gap-3 border border-dashed border-[#C8CDD2] bg-white px-6 py-10 text-center">
            <div className="flex h-10 w-10 items-center justify-center bg-[#EEF6FB]">
              <Sliders className="h-5 w-5 text-[#287EAD]" />
            </div>
            <div>
              <p className="text-sm font-semibold text-[#1F2933]">No selection</p>
              <p className="mt-1 text-xs text-[#5E6870] leading-relaxed">Click any field or section on the canvas to configure it here.</p>
            </div>
          </div>
        )}
        {target?.kind === "section" && (
          <SectionEditor section={target.section}
            allFields={allFields}
            processSteps={processSteps}
            onUpdate={(patch) => target!.kind === "section" && onUpdateSection(target.section.id, patch)} />
        )}
        {target?.kind === "field" && (
          <FieldEditor field={target.field}
            allFields={allFields}
            processSteps={processSteps}
            onUpdate={(patch) => target!.kind === "field" && onUpdateField(target.sectionId, target.field.id, patch)} />
        )}
      </div>
    </aside>
  );
}

/* ============================================================
 * Preview (with full table column types)
 * ============================================================ */

const previewInputCls =
  "h-10 w-full border border-slate-300 bg-white px-3 text-sm outline-none transition " +
  "focus:border-[#287EAD] focus:ring-2 focus:ring-[#287EAD]/15 text-slate-800";

function PreviewColumnInput({ col, value, onChange, row, disabled }: { col: TableColumn; value: string; onChange: (v: string) => void; row?: Record<string, string>; disabled?: boolean }) {
  const base = "w-full bg-transparent text-sm outline-none text-slate-700 placeholder:text-slate-300 py-1";
  if (col.hidden) return null;
  const ro = disabled || col.readonly;
  switch (col.type) {
    case "select":
      return (
        <select value={value} onChange={(e) => onChange(e.target.value)} className={base} disabled={ro}>
          <option value="">—</option>
          {(col.options ?? []).map((o) => <option key={o} value={o}>{o}</option>)}
        </select>
      );
    case "boolean":
      return <input type="checkbox" checked={value === "true"} disabled={ro} onChange={(e) => onChange(e.target.checked ? "true" : "false")} className="h-4 w-4 accent-[#287EAD]" />;
    case "textarea":
      return <textarea rows={1} value={value} disabled={ro} onChange={(e) => onChange(e.target.value)} className={cn(base, "resize-none")} />;
    case "currency": {
      const symbol = currencySymbolFor(col.currencyFromColumn ? row?.[col.currencyFromColumn] : undefined)
        ?? col.currencySymbol ?? "KSh";
      return (
        <div className="flex items-center gap-1">
          <span className="text-[10px] text-slate-400">{symbol}</span>
          <input type="number" step={stepForDecimals(col.decimals ?? 2)} min={col.min} max={col.max} disabled={ro} value={value} onChange={(e) => onChange(e.target.value)} className={base} placeholder={placeholderForNumber(col, "0.00")} />
        </div>
      );
    }
    case "number":
      return <input type="number" step={stepForDecimals(col.decimals ?? 0)} min={col.min} max={col.max} value={value} disabled={ro} onChange={(e) => onChange(e.target.value)} className={base} placeholder={placeholderForNumber(col, "0")} />;
    case "date":
      return <input type="date" value={value} disabled={ro} onChange={(e) => onChange(e.target.value)} className={base} />;
    case "datetime":
      return <input type="datetime-local" value={value} disabled={ro} onChange={(e) => onChange(e.target.value)} className={base} />;
    case "time":
      return <input type="time" value={value} disabled={ro} onChange={(e) => onChange(e.target.value)} className={base} />;
    case "email":
      return <input type="email" value={value} disabled={ro} onChange={(e) => onChange(e.target.value)} className={base} />;
    case "phone":
      return <input type="tel" value={value} disabled={ro} onChange={(e) => onChange(e.target.value)} className={base} />;
    case "reference":
    case "user":
      return (
        <div className={cn(base, "flex items-center justify-between gap-1 text-muted-foreground")}>
          <span className="truncate">Pick {col.referenceSource ?? (col.type === "user" ? "user" : "record")}…</span>
          <Link2 className="h-3 w-3 flex-shrink-0" />
        </div>
      );
    case "file":
      return <input type="file" disabled={ro} className="text-xs" />;
    case "image":
      return <input type="file" accept="image/*" disabled={ro} className="text-xs" />;
    case "percentage":
      return (
        <div className="flex items-center gap-1">
          <input type="number" step="0.01" min={col.min ?? 0} max={col.max ?? 100} disabled={ro} value={value}
            onChange={(e) => onChange(e.target.value)} className={base} placeholder="0" />
          <span className="text-[10px] text-slate-400">%</span>
        </div>
      );
    case "url":
      return <input type="url" value={value} disabled={ro} onChange={(e) => onChange(e.target.value)} className={base} placeholder="https://…" />;
    case "multi_select":
      return (
        <select multiple value={value ? value.split("|") : []} disabled={ro} size={2}
          onChange={(e) => onChange(Array.from(e.target.selectedOptions).map((o) => o.value).join("|"))}
          className={cn(base, "min-h-[42px]")}>
          {(col.options ?? []).map((o) => <option key={o} value={o}>{o}</option>)}
        </select>
      );
    default:
      return <input type="text" value={value} disabled={ro} maxLength={col.maxLength} onChange={(e) => onChange(e.target.value)} className={base} />;
  }
}

function PreviewTableField({ field, readOnly = false, rows, onUpdateCell, onAddRow, onRemoveRow, values, allFields, previewStep }: {
  field: TemplateField;
  readOnly?: boolean;
  rows: Record<string, string>[];
  onUpdateCell: (rowIdx: number, colKey: string, val: string) => void;
  onAddRow: () => void;
  onRemoveRow: (rowIdx: number) => void;
  values: Record<string, unknown>;
  allFields: TemplateField[];
  previewStep: string;
}) {
  // Column rules use the same hidden/visibleWhen/readonly/editableWhen shape
  // as fields and sections, but they are resolved with the row's own cell
  // values merged over the top-level form values, so a rule can reference a
  // sibling column. A column stays visible when ANY row satisfies its rule
  // (a column header is shared by every row); editability is evaluated per
  // row, so a cell can be locked on one row and editable on the next.
  const cols = (field.columns ?? []).filter((c) =>
    rows.length === 0
      ? evalVisible(c, values, allFields, previewStep)
      : rows.some((r) => evalVisible(c, rowScopedValues(values, r), allFields, previewStep)),
  );


  return (
    <div className="col-span-12 space-y-2">
      <label className="text-sm font-semibold text-slate-700">{field.label}{field.required && <span className="ml-1 text-red-500">*</span>}</label>
      {field.helpText && <p className="text-xs text-slate-500">{field.helpText}</p>}
      <div className="overflow-x-auto border border-slate-300 bg-white">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-slate-300 bg-slate-100">
              {cols.map((col) => (
                <th key={col.id} className="px-4 py-3.5 text-left text-xs font-semibold text-slate-700 border-r border-slate-300 last:border-0" title={col.tooltip}>
                  <span className="inline-flex items-center gap-1.5">
                    {col.label}{col.required && <span className="text-red-500 ml-0.5">*</span>}
                    {col.calc?.expression && <Calculator className="h-3 w-3 text-emerald-600 flex-shrink-0" />}
                  </span>
                  {col.additionalText && <div className="text-[10px] font-normal text-slate-400">{col.additionalText}</div>}
                </th>
              ))}
              <th className="w-10" />
            </tr>
          </thead>
          <tbody>
            {rows.map((row, rowIdx) => (
              <tr key={rowIdx} className="border-b border-slate-300 last:border-0 hover:bg-slate-50 transition-colors">
                {cols.map((col) => {
                  const rowValues = rowScopedValues(values, row);
                  const colDisabled = readOnly
                    || !evalVisible(col, rowValues, allFields, previewStep)
                    || !evalEditable(col, rowValues, allFields, previewStep);

                  return (
                    <td key={col.id} className="px-3 py-2.5 border-r border-slate-300 last:border-0">
                      <PreviewColumnInput col={col} value={row[col.key] ?? ""} row={row} disabled={colDisabled} onChange={(v) => onUpdateCell(rowIdx, col.key, v)} />
                    </td>
                  );
                })}
                <td className="text-center px-1">
                  {!readOnly && rows.length > 1 && (
                    <button type="button" onClick={() => onRemoveRow(rowIdx)} className="text-slate-300 hover:text-red-500 transition-colors p-1">
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!readOnly && (
        <button type="button" onClick={onAddRow} className="flex items-center gap-1.5 text-xs font-semibold text-[#287EAD] hover:text-[#1E6F99] transition-colors">
          <Plus className="h-3.5 w-3.5" /> Add row
        </button>
      )}
    </div>
  );
}

/* Evaluate one condition. In the builder preview there is no live document, so
 * the process step is treated as "draft" (the implicit start state). Field
 * values here are keyed by field id (react-hook-form register key). */
function evalCondition(c: VisibilityCondition, values: Record<string, unknown>, allFields: TemplateField[], processStep: string): boolean {
  let sv: string;
  if (c.source === "process_step") {
    sv = processStep;
  } else {
    const sib = allFields.find((f) => f.key === c.fieldKey);
    if (!sib) return true;
    const v = values[sib.id];
    sv = v == null ? "" : String(v);
  }
  const target = (c.value ?? "").trim();
  const lower = sv.trim().toLowerCase();
  const targetLower = target.toLowerCase();
  const num = parseFloat(sv);
  /* Dates compare correctly as ISO strings, so fall back to a string compare
   * whenever either side isn't numeric. */
  const compare = (rhs: string): number => {
    const b = parseFloat(rhs);
    if (Number.isFinite(num) && Number.isFinite(b) && `${num}` === sv.trim()) return num - b;
    if (Number.isFinite(num) && Number.isFinite(b) && !/[^0-9.\-+eE]/.test(sv.trim())) return num - b;
    return sv.trim().localeCompare(rhs);
  };
  const listValues = () => target.split(",").map((v) => v.trim().toLowerCase()).filter(Boolean);
  const rangeBounds = () => {
    const [lo, hi] = target.split(",");
    return [(lo ?? "").trim(), (hi ?? "").trim()];
  };
  const truthyText = new Set(["true", "yes", "1", "on", "checked"]);

  switch (c.operator) {
    case "equals": return lower === targetLower;
    case "not_equals": return lower !== targetLower;
    case "is_empty": return sv.trim() === "";
    case "is_not_empty": return sv.trim() !== "";
    case "greater_than": return sv.trim() !== "" && compare(target) > 0;
    case "greater_or_equal": return sv.trim() !== "" && compare(target) >= 0;
    case "less_than": return sv.trim() !== "" && compare(target) < 0;
    case "less_or_equal": return sv.trim() !== "" && compare(target) <= 0;
    case "between": {
      const [lo, hi] = rangeBounds();
      return sv.trim() !== "" && compare(lo) >= 0 && compare(hi) <= 0;
    }
    case "not_between": {
      const [lo, hi] = rangeBounds();
      return sv.trim() === "" || compare(lo) < 0 || compare(hi) > 0;
    }
    case "contains": return targetLower !== "" && lower.includes(targetLower);
    case "not_contains": return targetLower === "" || !lower.includes(targetLower);
    case "starts_with": return lower.startsWith(targetLower);
    case "ends_with": return lower.endsWith(targetLower);
    case "in_list": return listValues().includes(lower);
    case "not_in_list": return !listValues().includes(lower);
    case "is_true": return truthyText.has(lower);
    case "is_false": return !truthyText.has(lower);
    default: return true;
  }
}

/* Evaluate a (possibly nested) rule group. Plain conditions and nested
 * groups are combined with the SAME combinator, so a group reads exactly
 * like its summary string. An empty group is "no restriction"= true. */
function evalRuleGroup(group: RuleGroup | null | undefined, values: Record<string, unknown>, allFields: TemplateField[], processStep: string): boolean {
  if (!group) return true;
  const nested = (group.groups ?? []).filter(ruleGroupHasConditions);
  if (group.conditions.length === 0 && nested.length === 0) return true;
  const results = [
    ...group.conditions.map((c) => evalCondition(c, values, allFields, processStep)),
    ...nested.map((g) => evalRuleGroup(g, values, allFields, processStep)),
  ];
  return group.combinator === "or" ? results.some(Boolean) : results.every(Boolean);
}

/* Visibility for a field OR a section (both carry `hidden` + `visibleWhen`).
 * An empty/absent rule group means no restriction (visible). */
function evalVisible(item: VisibilityState, values: Record<string, unknown>, allFields: TemplateField[], processStep = "draft"): boolean {
  if (item.hidden) return false;
  return evalRuleGroup(item.visibleWhen, values, allFields, processStep);
}

/* Editability mirror (both carry `readonly` + `editableWhen`). Absent group =
 * editable. The builder Preview evaluates at the "draft"process step. */
function evalEditable(item: EditabilityState, values: Record<string, unknown>, allFields: TemplateField[], processStep = "draft"): boolean {
  if (item.readonly) return false;
  return evalRuleGroup(item.editableWhen, values, allFields, processStep);
}

/* ── Calculated fields ────────────────────────────────────────────────────
 * Client-side mirror of apps/templates_engine/conditions.py's evaluator, used
 * to drive the live Build/Preview canvas. The server recomputes the same
 * formulas authoritatively at submit time — this copy only powers what the
 * person sees while filling the form, never what gets persisted.
 *
 * The grammar: numbers, "string literals", field/column keys, + - * / ( )
 * with unary +/-, comparisons (> < >= <= == !=), and IF(cond, a, b) — the
 * one place a formula can produce a STRING result (e.g. a status message)
 * rather than just a number. ==/!= compare as strings if either side is
 * text-natured, else numerically. No eval/exec — a small hand-written
 * tokenizer + recursive-descent parser only. */
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
    // "<>"is accepted as a friendlier spelling of "!="(spreadsheet muscle memory).
    else if (m[5] !== undefined) tokens.push({ t: "op", v: m[5] === "<>" ? "!=" : m[5] });
    else if (m[6] !== undefined) tokens.push({ t: "op", v: m[6] });
  }
  return tokens;
}

/** Coerce any calc VALUE (number or string) to a number for arithmetic /
 * comparison. Never throws — an unparseable string becomes 0. */
function toNumber(value: CalcValue | undefined): number {
  if (typeof value === "number") return value;
  if (typeof value === "string") { const n = parseFloat(value); return Number.isFinite(n) ? n : 0; }
  return 0;
}

function isTruthy(value: CalcValue | undefined): boolean {
  if (typeof value === "string") return value.trim() !== "";
  return toNumber(value) !== 0;
}

/* ── Value helpers shared by the whole function library ───────────────────
 * A calc VALUE is a number or a string. Dates/date-times travel through the
 * engine as a DAY SERIAL (days since 1970-01-01 UTC — see coerceNumeric), and
 * times as MINUTES SINCE MIDNIGHT, so date/time arithmetic is plain
 * arithmetic and the date functions below are thin wrappers over it. */
const MS_PER_DAY = 86400000;

/** Render a calc VALUE as text — used by every text function and by the `&`
 *  concatenation operator. Trims float noise off computed numbers. */
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

/** Format a day serial with the YYYY / MM / DD / HH / mm / ss tokens. */
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

/** Whole weekdays (Mon–Fri) between two day serials, inclusive of the start
 *  and exclusive of the end — the usual "working days"count. Bounded so a
 *  nonsense pair of dates can never spin. */
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

/* The pure function library. Every entry is side-effect free and total —
 * a bad argument yields 0 or "" rather than throwing, matching the engine's
 * "never break the form"contract. Mirrored 1:1 by _CALC_FUNCS in
 * apps/templates_engine/conditions.py. */
const CALC_FUNCS: Record<string, (...args: CalcValue[]) => CalcValue> = {
  /* ── Maths ───────────────────────────────────────────────────────────── */
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
  /** PERCENT(part, whole) → part as a percentage of whole (0 when whole is 0). */
  PERCENT: (part, whole) => { const w = toNumber(whole); return w === 0 ? 0 : (toNumber(part) / w) * 100; },
  /** VAT-style helpers: APPLYRATE(1000, 16) = 160, GROSS(1000, 16) = 1160. */
  APPLYRATE: (amount, ratePct) => (toNumber(amount) * toNumber(ratePct)) / 100,
  GROSS: (amount, ratePct) => toNumber(amount) * (1 + toNumber(ratePct) / 100),
  NET: (gross, ratePct) => toNumber(gross) / (1 + toNumber(ratePct) / 100),

  /* ── Logic ───────────────────────────────────────────────────────────── */
  AND: (...a) => (a.length > 0 && a.every(isTruthy) ? 1 : 0),
  OR: (...a) => (a.some(isTruthy) ? 1 : 0),
  NOT: (a) => (isTruthy(a) ? 0 : 1),
  XOR: (...a) => (a.filter(isTruthy).length % 2 === 1 ? 1 : 0),
  TRUE: () => 1,
  FALSE: () => 0,
  ISBLANK: (a) => (calcText(a).trim() === "" || toNumber(a) === 0 && calcText(a) === "" ? 1 : 0),
  ISNUMBER: (a) => (typeof a === "number" || (calcText(a).trim() !== "" && Number.isFinite(parseFloat(calcText(a)))) ? 1 : 0),
  /** First argument that isn't blank. */
  COALESCE: (...a) => a.find((v) => calcText(v).trim() !== "") ?? "",
  /** IFS(cond1, val1, cond2, val2, …, fallback?) — first matching branch. */
  IFS: (...a) => {
    for (let i = 0; i + 1 < a.length; i += 2) if (isTruthy(a[i])) return a[i + 1];
    return a.length % 2 === 1 ? a[a.length - 1] : "";
  },
  /** SWITCH(value, match1, result1, …, fallback?) — string-compared. */
  SWITCH: (...a) => {
    const subject = calcText(a[0]);
    for (let i = 1; i + 1 < a.length; i += 2) if (calcText(a[i]) === subject) return a[i + 1];
    return (a.length - 1) % 2 === 1 ? a[a.length - 1] : "";
  },

  /* ── Text ────────────────────────────────────────────────────────────── */
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
  /** SPLIT(text, separator, index) — 1-based index, "" when out of range. */
  SPLIT: (v, sep, idx) => calcText(v).split(calcText(sep))[Math.max(1, Math.trunc(toNumber(idx))) - 1] ?? "",

  /* ── Dates & times ───────────────────────────────────────────────────── */
  TODAY: () => dateToSerial(new Date()),
  NOW: () => Date.now() / MS_PER_DAY,
  DATE: (y, m, d) => dateToSerial(new Date(Date.UTC(Math.trunc(toNumber(y)), Math.trunc(toNumber(m)) - 1, Math.trunc(toNumber(d))))),
  YEAR: (s) => serialToDate(s).getUTCFullYear(),
  MONTH: (s) => serialToDate(s).getUTCMonth() + 1,
  DAY: (s) => serialToDate(s).getUTCDate(),
  /** 1 = Sunday … 7 = Saturday, matching the spreadsheet convention. */
  WEEKDAY: (s) => serialToDate(s).getUTCDay() + 1,
  ISWEEKEND: (s) => { const d = serialToDate(s).getUTCDay(); return d === 0 || d === 6 ? 1 : 0; },
  /** DAYS(end, start) — calendar days between two dates. */
  DAYS: (end, start) => Math.round(toNumber(end) - toNumber(start)),
  NETWORKDAYS: (start, end) => networkDays(start, end),
  ADDDAYS: (s, n) => Math.round(toNumber(s)) + Math.trunc(toNumber(n)),
  ADDMONTHS: (s, n) => addMonthsSerial(s, n),
  ADDYEARS: (s, n) => addMonthsSerial(s, toNumber(n) * 12),
  /** Last day of the month `n` months from the given date. */
  EOMONTH: (s, n = 0) => {
    const d = serialToDate(addMonthsSerial(s, n));
    return dateToSerial(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)));
  },
  /** DATEDIF(start, end, "d"|"m"|"y") — whole units between two dates. */
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
  /** Time values are minutes since midnight (see coerceNumeric). */
  HOUR: (t) => Math.floor(toNumber(t) / 60),
  MINUTE: (t) => Math.round(toNumber(t) % 60),
  FORMATTIME: (t) => `${pad2(Math.floor(toNumber(t) / 60))}:${pad2(Math.round(toNumber(t) % 60))}`,
  /** Decimal hours between two time values, e.g. HOURSBETWEEN(start, end). */
  HOURSBETWEEN: (a, b) => (toNumber(b) - toNumber(a)) / 60,
};

/** Function names, grouped, for the builder's formula reference panel. */
export const CALC_FUNCTION_GROUPS: Array<{ label: string; items: Array<{ name: string; signature: string; help: string }> }> = [
  {
    label: "Logic",
    items: [
      { name: "IF", signature: 'IF(condition, if_true, if_false)', help: "Pick one of two values." },
      { name: "IFS", signature: 'IFS(cond1, val1, cond2, val2, fallback)', help: "First matching branch wins." },
      { name: "SWITCH", signature: 'SWITCH(value, "A", 1, "B", 2, 0)', help: "Match a value against a list." },
      { name: "AND", signature: "AND(a, b, …)", help: "True when every argument is true." },
      { name: "OR", signature: "OR(a, b, …)", help: "True when any argument is true." },
      { name: "NOT", signature: "NOT(a)", help: "Inverts a condition." },
      { name: "COALESCE", signature: "COALESCE(a, b, …)", help: "First value that isn't blank." },
      { name: "ISBLANK", signature: "ISBLANK(a)", help: "1 when empty, else 0." },
    ],
  },
  {
    label: "Numbers",
    items: [
      { name: "ROUND", signature: "ROUND(value, decimals)", help: "Round to N decimals." },
      { name: "ROUNDUP", signature: "ROUNDUP(value, decimals)", help: "Always round away from zero." },
      { name: "ROUNDDOWN", signature: "ROUNDDOWN(value, decimals)", help: "Always round toward zero." },
      { name: "ABS", signature: "ABS(value)", help: "Absolute value." },
      { name: "MIN", signature: "MIN(a, b, …)", help: "Smallest argument." },
      { name: "MAX", signature: "MAX(a, b, …)", help: "Largest argument." },
      { name: "MOD", signature: "MOD(a, b)", help: "Remainder of a / b." },
      { name: "POWER", signature: "POWER(a, b)", help: "a to the power of b (or a ^ b)." },
      { name: "CLAMP", signature: "CLAMP(value, low, high)", help: "Keep a value inside a range." },
      { name: "PERCENT", signature: "PERCENT(part, whole)", help: "part as a % of whole." },
      { name: "APPLYRATE", signature: "APPLYRATE(amount, rate_pct)", help: "e.g. VAT on a net amount." },
      { name: "GROSS", signature: "GROSS(amount, rate_pct)", help: "Amount plus the rate." },
      { name: "NET", signature: "NET(gross, rate_pct)", help: "Strip the rate back out." },
    ],
  },
  {
    label: "Text",
    items: [
      { name: "CONCAT", signature: 'CONCAT(a, " - ", b)', help: "Join values (or use a & b)." },
      { name: "TEXT", signature: "TEXT(value, decimals)", help: "Number to text." },
      { name: "UPPER", signature: "UPPER(text)", help: "Uppercase." },
      { name: "LOWER", signature: "LOWER(text)", help: "Lowercase." },
      { name: "TRIM", signature: "TRIM(text)", help: "Strip outer spaces." },
      { name: "LEN", signature: "LEN(text)", help: "Character count." },
      { name: "LEFT", signature: "LEFT(text, n)", help: "First n characters." },
      { name: "RIGHT", signature: "RIGHT(text, n)", help: "Last n characters." },
      { name: "MID", signature: "MID(text, start, length)", help: "Substring, 1-based." },
      { name: "CONTAINS", signature: 'CONTAINS(text, "abc")', help: "1 when found." },
      { name: "SUBSTITUTE", signature: 'SUBSTITUTE(text, "a", "b")', help: "Replace every occurrence." },
      { name: "PADLEFT", signature: 'PADLEFT(value, 5, "0")', help: "Zero-pad a reference number." },
      { name: "SPLIT", signature: 'SPLIT(text, ",", 2)', help: "Nth piece of a delimited value." },
    ],
  },
  {
    label: "Dates & times",
    items: [
      { name: "TODAY", signature: "TODAY()", help: "Today's date." },
      { name: "DAYS", signature: "DAYS(end_date, start_date)", help: "Calendar days between." },
      { name: "NETWORKDAYS", signature: "NETWORKDAYS(start, end)", help: "Working days (Mon–Fri)." },
      { name: "ADDDAYS", signature: "ADDDAYS(date, n)", help: "Shift a date by n days." },
      { name: "ADDMONTHS", signature: "ADDMONTHS(date, n)", help: "Shift a date by n months." },
      { name: "EOMONTH", signature: "EOMONTH(date, n)", help: "End of month, n months out." },
      { name: "DATEDIF", signature: 'DATEDIF(start, end, "y")', help: 'Whole "d", "m"or "y"between.' },
      { name: "YEAR", signature: "YEAR(date)", help: "Calendar year." },
      { name: "MONTH", signature: "MONTH(date)", help: "Month number." },
      { name: "DAY", signature: "DAY(date)", help: "Day of month." },
      { name: "WEEKDAY", signature: "WEEKDAY(date)", help: "1 = Sunday … 7 = Saturday." },
      { name: "FORMATDATE", signature: 'FORMATDATE(date, "DD/MM/YYYY")', help: "Date as text." },
      { name: "HOURSBETWEEN", signature: "HOURSBETWEEN(start_time, end_time)", help: "Decimal hours." },
    ],
  },
  {
    label: "Table aggregates",
    items: [
      { name: "SUM", signature: "SUM(table.column)", help: "Total a column across every row." },
      { name: "AVG", signature: "AVG(table.column)", help: "Mean of a column." },
      { name: "COUNT", signature: "COUNT(table.column)", help: "Number of rows." },
      { name: "COUNTA", signature: "COUNTA(table.column)", help: "Rows where the cell isn't blank." },
      { name: "COUNTBLANK", signature: "COUNTBLANK(table.column)", help: "Rows where the cell is blank." },
      { name: "COLMIN", signature: "COLMIN(table.column)", help: "Smallest value in a column." },
      { name: "COLMAX", signature: "COLMAX(table.column)", help: "Largest value in a column." },
      { name: "MEDIAN", signature: "MEDIAN(table.column)", help: "Middle value of a column." },
      { name: "PRODUCT", signature: "PRODUCT(table.column)", help: "All values multiplied." },
      { name: "FIRST", signature: "FIRST(table.column)", help: "Value in the first row." },
      { name: "LAST", signature: "LAST(table.column)", help: "Value in the last row." },
      { name: "SUMIF", signature: 'SUMIF(amount, category, "Travel")', help: "Total the rows that match." },
      { name: "COUNTIF", signature: 'COUNTIF(category, "Travel")', help: "Count the rows that match." },
      { name: "AVGIF", signature: 'AVGIF(amount, category, "Travel")', help: "Mean of the matching rows." },
      { name: "COLJOIN", signature: 'COLJOIN(table.column, ", ")', help: "Every value as one text list." },
      { name: "ROWCOUNT", signature: "ROWCOUNT(table)", help: "How many rows a table has." },
    ],
  },
];

class CalcParser {
  private i = 0;
  constructor(private tokens: CalcToken[], private scope: Record<string, CalcValue>) { }
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
      // > < >= <= compare numerically for numbers, lexically when BOTH sides
      // are text (so "Approved">"Draft"is meaningful for sorted status codes).
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

  /** `a & b` — string concatenation, binding looser than arithmetic. */
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
    while (this.peek()?.t === "op" && ((this.peek() as any).v === "+" || (this.peek() as any).v === "-")) {
      const op = (this.next() as any).v;
      const rhs = this.term();
      v = op === "+" ? toNumber(v) + toNumber(rhs) : toNumber(v) - toNumber(rhs);
    }
    return v;
  }

  private term(): CalcValue {
    let v: CalcValue = this.factor();
    while (this.peek()?.t === "op" && ["*", "/", "%"].includes((this.peek() as any).v)) {
      const op = (this.next() as any).v;
      const rhs = this.factor();
      const rn = toNumber(rhs);
      if (op === "*") v = toNumber(v) * rn;
      else v = rn ? (op === "/" ? toNumber(v) / rn : toNumber(v) % rn) : 0;
    }
    return v;
  }

  private factor(): CalcValue {
    const t = this.peek();
    if (t?.t === "op" && t.v === "-") { this.next(); return -toNumber(this.factor()); }
    if (t?.t === "op" && t.v === "+") { this.next(); return toNumber(this.factor()); }
    return this.power();
  }

  /** `a ^ b` — exponentiation, right-associative, tighter than * and /. */
  private power(): CalcValue {
    const base = this.atom();
    if (this.isOp("^")) {
      this.next();
      const exp = this.factor();
      const r = Math.pow(toNumber(base), toNumber(exp));
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
        if (!fn) throw new Error(`Unknown function ${name}()`);
        return fn(...args);
      }
      if (!(name in this.scope)) throw new Error(`Unknown field or column "${name}"`);
      return this.scope[name] ?? 0;
    }
    throw new Error("Unexpected token");
  }
}

/** Field/column types whose natural VALUE for a calc formula is text, not a
 * number — passed through as a raw string rather than coerced to 0. This is
 * what makes `category == "Travel"` or an IF() condition testing a
 * dropdown's selection actually work, while numeric-natured types
 * (currency, number, date, boolean, …) still coerce for arithmetic. Mirrors
 * the server's `_TEXT_CALC_TYPES` exactly. */
const TEXT_CALC_TYPES = new Set([
  "text", "textarea", "email", "phone", "select", "radio", "multi_select",
  "reference", "user", "url", "calc_text", "auto_number",
]);

/** Coerce a raw field/column value into the NUMBER a calc formula should see
 * for arithmetic/aggregation, based on its declared type. The naive
 * `parseFloat(value)` this replaced silently broke date arithmetic:
 * parseFloat("2026-07-12") reads as 2026 (just the leading digits), so
 * `end_date - start_date` on two dates in the same year always evaluated to
 * 0 regardless of the actual gap. Dates/datetimes now convert to a day-count
 * (days since the Unix epoch, UTC) so subtracting two dates yields the
 * number of days between them directly — matching how UniFi's own
 * `(travel_end_date-travel_start_date)+1` formula behaves. Always returns a
 * number regardless of type — used for whole-column aggregates, which need
 * a number even from a text-natured column. */
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

/** Coerce a raw field/column value into the calc VALUE (number OR string) a
 * formula should see, based on its declared type. Text-natured types (see
 * TEXT_CALC_TYPES) pass through as a string so string comparisons and IF()
 * conditions work; everything else coerces to a number via coerceNumeric. */
function coerceScopeValue(fieldType: string | undefined, raw: unknown): CalcValue {
  if (fieldType && TEXT_CALC_TYPES.has(fieldType)) return raw === null || raw === undefined ? "" : String(raw);
  return coerceNumeric(fieldType, raw);
}

/** Evaluate a calc expression against a { fieldKey: value } scope. Never
 * throws — returns 0 for a malformed formula, matching the server. */
function evaluateCalcExpression(expression: string | undefined, scope: Record<string, CalcValue>): CalcValue {
  if (!expression || !expression.trim()) return 0;
  try {
    return new CalcParser(calcTokenize(expression), scope).parse();
  } catch {
    return 0;
  }
}

/** Build a { fieldKey: value } scope from the form's current (id-keyed)
 * values, for evaluating sibling calc expressions. Type-aware per field
 * (see coerceScopeValue) — this is what makes date-difference formulas AND
 * string comparisons/IF() work.
 *
 * When `registry` is supplied, a PLAIN (non-aggregate) reference to a table
 * column — bare `amount` or qualified `table_key.amount` — resolves to that
 * column's value straight off the first row, mirroring how a table column
 * can already reference a top-level field's single value directly by its
 * key (the "DSA Amount" pattern) — this is the same idea running the other
 * way. Table-derived fallbacks are lowest priority: a real field of that
 * key always wins, and bare (unqualified) column references follow the
 * same "first table wins" rule as unqualified aggregates. */
function buildCalcScope(
  allFields: TemplateField[],
  values: Record<string, unknown>,
  registry?: Record<string, TableCalcRegistryEntry>,
): Record<string, CalcValue> {
  const scope: Record<string, CalcValue> = registry ? firstRowScopeEntries(registry) : {};
  for (const f of allFields) {
    if (!f.key) continue;
    scope[f.key] = coerceScopeValue(f.type, values[f.id]);
  }
  return scope;
}

/** Scope for a table column formula on one row: every top-level field (plus
 * table-derived fallbacks via `registry`, see buildCalcScope), overlaid with
 * that row's own columns (row-local keys win on a name collision — the row
 * is "closer"than the sheet, same as a spreadsheet). This is what lets a
 * column formula reference a sibling cell in its own row (`qty *
 * unit_price`), a form-level field copied into every row
 * (`daily_subsistence_allowance`), or another table's first row
 * (`other_table.amount`). */
function buildRowCalcScope(
  allFields: TemplateField[],
  values: Record<string, unknown>,
  columns: TableColumn[],
  row: Record<string, string>,
  registry?: Record<string, TableCalcRegistryEntry>,
): Record<string, CalcValue> {
  const scope = buildCalcScope(allFields, values, registry);
  const colTypeByKey: Record<string, TableColumnType | undefined> = {};
  columns.forEach((c) => { colTypeByKey[c.key] = c.type; });
  for (const [k, v] of Object.entries(row)) {
    scope[k] = coerceScopeValue(colTypeByKey[k], v);
  }
  return scope;
}

/* Client-side mirror of the server's ``_resolve_row_aggregates`` (see
 * apps/templates_engine/conditions.py). Whole-column aggregate calls are
 * replaced with their computed literal BEFORE the expression parser ever
 * sees the formula, because an aggregate needs a raw column key plus a full
 * row list — things the value-oriented grammar can't express.
 *
 * Supported (all also work cross-table via the qualified `table_key.column`
 * form, and from a top-level field's formula as well as from a table
 * column's own formula):
 *   SUM AVG COUNT COUNTA COUNTBLANK COLMIN COLMAX MEDIAN PRODUCT FIRST LAST
 *   SUMIF(value_col, test_col, "criteria")   COUNTIF(test_col, "criteria")
 *   AVGIF(value_col, test_col, "criteria")   COLJOIN(col, ", ")
 *   ROWCOUNT(table_key)
 * A criteria literal may be a plain value ("Travel", case-insensitive) or a
 * comparison (">1000", "<=0", "<>Cancelled"). Arguments are LITERALS, not
 * expressions — that's what keeps this a pre-pass rather than a grammar
 * feature. Powers the live builder Preview only; the server recomputes the
 * authoritative figure exactly the same way at submit time. */
const AGG_FUNCS = new Set([
  "SUM", "AVG", "COUNT", "COUNTA", "COUNTBLANK", "COLMIN", "COLMAX",
  "MEDIAN", "PRODUCT", "FIRST", "LAST", "SUMIF", "COUNTIF", "AVGIF",
  "COLJOIN", "ROWCOUNT",
]);

/** Registry entry for one table field, used to resolve cross-table
 *  aggregates: SUM(other_table_key.col) looks this up by table field key. */
export interface TableCalcRegistryEntry {
  rows: Record<string, string>[];
  colTypeByKey: Record<string, TableColumnType | undefined>;
}

/** Build the { bareColKey / "table.col": value } fallback entries derived
 *  from each table's FIRST row — see buildCalcScope's docstring. Bare keys
 *  follow "first table wins"when more than one table has a same-named
 *  column; dotted keys are always unambiguous. */
function firstRowScopeEntries(registry: Record<string, TableCalcRegistryEntry>): Record<string, CalcValue> {
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

/** Build the shared cross-table aggregate registry from every table field's
 *  current row data — used by both the top-level calc effect and the table
 *  calc effect, so both share one consistent snapshot of every table. */
function buildTableCalcRegistry(
  tableFields: TemplateField[],
  tableRowsState: Record<string, Record<string, string>[]>,
): Record<string, TableCalcRegistryEntry> {
  const registry: Record<string, TableCalcRegistryEntry> = {};
  for (const f of tableFields) {
    const colTypeByKey: Record<string, TableColumnType | undefined> = {};
    (f.columns ?? []).forEach((c) => { colTypeByKey[c.key] = c.type; });
    registry[f.key] = { rows: tableRowsState[f.key] ?? [], colTypeByKey };
  }
  return registry;
}

/** Split an argument list on top-level commas, ignoring commas inside
 *  nested parentheses or quoted strings. */
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

/** Strip the surrounding quotes off a literal argument (leaves bare words
 *  and numbers untouched). */
function literalArg(arg: string | undefined): string {
  if (!arg) return "";
  const t = arg.trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    return t.slice(1, -1).replace(/\\(["'\\])/g, "$1");
  }
  return t;
}

/** Does one cell satisfy a criteria literal? Plain values compare
 *  case-insensitively; ">", ">=", "<", "<=", "=", "<>" prefixes compare
 *  numerically when both sides look numeric, textually otherwise. */
function matchesCriteria(raw: string | undefined, criteria: string): boolean {
  const cell = (raw ?? "").trim();
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

/** Resolve a column reference ("amount"or "expenses.amount") against the
 *  current table (when called from a column formula) or the whole registry.
 *  Precedence matches the server: qualified wins, then this table's own
 *  columns, then the first registered table carrying that column key. */
function resolveColumnRef(
  ref: string,
  rows: Record<string, string>[] | null,
  colTypeByKey: Record<string, TableColumnType | undefined> | null,
  allTables?: Record<string, TableCalcRegistryEntry>,
): { rows: Record<string, string>[]; colType: TableColumnType | undefined; colKey: string } {
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

function resolveRowAggregates(
  expression: string,
  rows: Record<string, string>[] | null,
  colTypeByKey: Record<string, TableColumnType | undefined> | null,
  allTables?: Record<string, TableCalcRegistryEntry>,
): string {
  if (!expression || !expression.includes("(")) return expression;
  const nameRe = /\b([A-Za-z_][A-Za-z0-9_]*)\s*\(/g;
  let out = expression;
  let guard = 0;
  // Re-scan from the start after each substitution so nested/repeated calls
  // all resolve, with a hard guard against a pathological formula.
  while (guard < 200) {
    guard += 1;
    nameRe.lastIndex = 0;
    let match: RegExpExecArray | null = null;
    let found: { start: number; inner: string; end: number; fn: string } | null = null;
    while ((match = nameRe.exec(out))) {
      const fn = match[1].toUpperCase();
      if (!AGG_FUNCS.has(fn)) continue;
      // Walk to the matching close paren.
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
      const key = literalArg(args[0]);
      const entry = allTables?.[key];
      literal = `(${entry ? entry.rows.length : (rows?.length ?? 0)})`;
    } else {
      const target = resolveColumnRef(literalArg(args[0]), rows, colTypeByKey, allTables);
      const cells = target.rows.filter((r) => r && typeof r === "object").map((r) => r[target.colKey]);
      const nums = cells.map((v) => coerceNumeric(target.colType, v));
      const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

      if (fn === "SUMIF" || fn === "AVGIF" || fn === "COUNTIF") {
        // COUNTIF(test_col, criteria) · SUMIF/AVGIF(value_col, test_col, criteria)
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
        const text = cells.map((v) => (v ?? "").trim()).filter((v) => v !== "").join(sep);
        literal = JSON.stringify(text);
      } else {
        let result = 0;
        switch (fn) {
          case "SUM": result = sum(nums); break;
          case "AVG": result = nums.length ? sum(nums) / nums.length : 0; break;
          case "COUNT": result = nums.length; break;
          case "COUNTA": result = cells.filter((v) => (v ?? "").trim() !== "").length; break;
          case "COUNTBLANK": result = cells.filter((v) => (v ?? "").trim() === "").length; break;
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

/** Compile-time check for the builder: returns a human-readable problem with
 *  a formula, or null when it parses cleanly. `knownKeys` are the field /
 *  column IDs the formula is allowed to reference — an unknown one is the
 *  single most common authoring mistake (a renamed field, a typo) and used
 *  to silently evaluate to 0 forever. */
function validateCalcExpression(expression: string | undefined, knownKeys: string[]): string | null {
  if (!expression || !expression.trim()) return null;
  const scope: Record<string, CalcValue> = {};
  knownKeys.forEach((k) => { if (k) scope[k] = 1; });
  try {
    // Aggregates are a pre-pass; with an empty registry they collapse to 0,
    // which is exactly what we want for a syntax/reference check.
    new CalcParser(calcTokenize(resolveRowAggregates(expression, null, null, {})), scope).parse();
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : "Invalid formula";
  }
}

/** Evaluate a formula the way the builder previews do: aggregates first,
 *  then the expression, then the field's decimal rounding. */
function previewCalcValue(expression: string | undefined, scope: Record<string, CalcValue>, decimals?: number): CalcValue {
  const resolved = resolveRowAggregates(expression ?? "", null, null, {});
  let result = evaluateCalcExpression(resolved, scope);
  if (typeof result === "number" && typeof decimals === "number") result = Number(result.toFixed(decimals));
  return result;
}

/** A calc_date field's formula produces a day serial; store/display it as an
 *  ISO date instead of a bare number. calc_boolean renders as Yes/No. */
function formatCalcResult(fieldType: string | undefined, result: CalcValue): CalcValue {
  if (fieldType === "calc_date") return typeof result === "number" ? formatSerial(result) : result;
  if (fieldType === "calc_boolean") return isTruthy(result) ? "Yes" : "No";
  return result;
}

function PreviewField({ field, register, errors, values, allFields, editable = true, tableRows, onUpdateTableCell, onAddTableRow, onRemoveTableRow, previewStep = "draft" }: {
  field: TemplateField;
  register: UseFormRegister<Record<string, unknown>>;
  errors: FieldErrors<Record<string, unknown>>;
  values: Record<string, unknown>;
  allFields: TemplateField[];
  editable?: boolean;
  tableRows?: Record<string, Record<string, string>[]>;
  onUpdateTableCell?: (tableKey: string, rowIdx: number, colKey: string, val: string) => void;
  onAddTableRow?: (tableKey: string) => void;
  onRemoveTableRow?: (tableKey: string, rowIdx: number) => void;
  previewStep?: string;
}) {
  if (field.hidden) return null;
  // Read-only when always-read-only or not editable at this (draft) step.
  const dis = Boolean(field.readonly) || !editable;
  if (field.type === "table") {
    return (
      <PreviewTableField
        field={field}
        readOnly={dis}
        rows={tableRows?.[field.key] ?? []}
        onUpdateCell={(rowIdx, colKey, val) => onUpdateTableCell?.(field.key, rowIdx, colKey, val)}
        onAddRow={() => onAddTableRow?.(field.key)}
        onRemoveRow={(rowIdx) => onRemoveTableRow?.(field.key, rowIdx)}
        values={values}
        allFields={allFields}
        previewStep={previewStep}
      />
    );
  }

  const err = errors[field.id]?.message as string | undefined;
  const validation: Record<string, unknown> = {
    required: field.required ? `${field.label} is required` : false,
  };
  if (field.regex) validation.pattern = { value: new RegExp(field.regex), message: `Invalid format` };
  if (field.minLength !== undefined) validation.minLength = { value: field.minLength, message: `Min ${field.minLength} chars` };
  if (field.maxLength !== undefined) validation.maxLength = { value: field.maxLength, message: `Max ${field.maxLength} chars` };
  if (field.min !== undefined) validation.min = { value: field.min, message: `Min ${field.min}` };
  if (field.max !== undefined) validation.max = { value: field.max, message: `Max ${field.max}` };

  const reg = register(field.id, validation as any);

  if (field.type === "heading") return <h3 className="text-base font-bold text-slate-800 border-b border-slate-300 pb-2">{field.label}</h3>;
  if (field.type === "divider") return <hr className="border-slate-300" />;
  if (field.type === "spacer") return <div aria-hidden className="h-2" />;
  if (field.type === "info") {
    return (
      <div className="flex items-start gap-2 border border-sky-200 bg-sky-50 px-3 py-2.5 text-sm text-sky-900">
        <Info className="mt-0.5 h-4 w-4 flex-shrink-0" />
        <span>{field.defaultValue || field.helpText || field.label}</span>
      </div>
    );
  }

  const label = field.type !== "boolean" && field.type !== "checkbox" ? (
    <label className="text-sm font-semibold text-slate-700">
      {field.label} {field.required && <span className="text-red-500">*</span>}
      {field.tooltip && <span className="ml-1 text-slate-400" title={field.tooltip}>(?)</span>}
    </label>
  ) : null;

  let control: React.ReactNode = null;
  switch (field.type) {
    case "textarea":
      control = <textarea {...reg} placeholder={field.placeholder} rows={4} disabled={dis}
        defaultValue={field.defaultValue ?? ""}
        className={previewInputCls.replace("h-10", "min-h-[100px] py-2.5 resize-none")} />;
      break;
    case "select":
      control = (
        <select {...reg} className={previewInputCls} defaultValue={field.defaultValue ?? ""} disabled={dis}>
          <option value="" disabled>{field.placeholder ?? "Select an option"}</option>
          {(field.options ?? []).map((o) => <option key={o} value={o}>{o}</option>)}
        </select>
      );
      break;
    case "multi_select":
      control = (
        <select {...reg} multiple className={cn(previewInputCls, "h-auto min-h-[80px] py-2")} disabled={dis}>
          {(field.options ?? []).map((o) => <option key={o} value={o}>{o}</option>)}
        </select>
      );
      break;
    case "radio":
      control = (
        <div className="flex flex-col gap-2 pt-1">
          {(field.options ?? []).map((o) => (
            <label key={o} className="flex items-center gap-2.5 text-sm text-slate-700 cursor-pointer">
              <input type="radio" value={o} {...reg} disabled={dis} className="h-4 w-4 accent-[#287EAD]" />{o}
            </label>
          ))}
        </div>
      );
      break;
    case "boolean":
    case "checkbox":
      return (
        <label className="flex items-center gap-2.5 text-sm text-slate-700 cursor-pointer">
          <input type="checkbox" {...reg} disabled={dis} className="h-4 w-4 border-slate-300 accent-[#287EAD]" />
          {field.label}
          {field.required && <span className="text-red-500">*</span>}
        </label>
      );
    case "currency": {
      const linked = field.currencyFromField
        ? allFields.find((f) => f.key === field.currencyFromField)
        : undefined;
      const linkedVal = linked ? values[linked.id] : undefined;
      const symbol = currencySymbolFor(typeof linkedVal === "string" ? linkedVal : undefined)
        ?? field.currencySymbol ?? "KSh";
      control = (
        <div className="relative">
          <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm text-slate-400 font-medium">{symbol}</span>
          <input type="number" step={stepForDecimals(field.decimals ?? 2)} {...reg} placeholder={placeholderForNumber(field, "0.00")} disabled={dis}
            defaultValue={field.defaultValue ?? ""} className={cn(previewInputCls, "pl-14")} />
        </div>
      );
      break;
    }
    case "number":
      control = <input type="number" step={stepForDecimals(field.decimals ?? 0)} {...reg} placeholder={placeholderForNumber(field, field.placeholder ?? "0")} disabled={dis} defaultValue={field.defaultValue ?? ""} className={previewInputCls} />;
      break;
    case "email":
      control = <input type="email" {...reg} placeholder={field.placeholder} disabled={dis} defaultValue={field.defaultValue ?? ""} className={previewInputCls} />;
      break;
    case "phone":
      control = <input type="tel" {...reg} placeholder={field.placeholder} disabled={dis} defaultValue={field.defaultValue ?? ""} className={previewInputCls} />;
      break;
    case "date":
      control = <input type="date" {...reg} disabled={dis} defaultValue={field.defaultValue ?? ""} className={previewInputCls} />;
      break;
    case "datetime":
      control = <input type="datetime-local" {...reg} disabled={dis} defaultValue={field.defaultValue ?? ""} className={previewInputCls} />;
      break;
    case "time":
      control = <input type="time" {...reg} disabled={dis} defaultValue={field.defaultValue ?? ""} className={previewInputCls} />;
      break;
    case "reference":
    case "user":
      control = (
        <div className={cn(previewInputCls, "flex items-center justify-between gap-2 text-[#5E6870]")}>
          <span className="truncate">Pick {field.referenceSource ?? (field.type === "user" ? "user" : "record")}…</span>
          <Link2 className="h-3.5 w-3.5 flex-shrink-0" />
        </div>
      );
      break;
    case "file":
    case "image":
      control = (
        <input type="file" {...reg} accept={field.type === "image" ? "image/*" : undefined} disabled={dis}
          className="block w-full text-sm text-slate-500 file:mr-3 file:rounded-none file:border-0 file:bg-[#287EAD] file:px-4 file:py-2 file:text-sm file:font-semibold file:text-white hover:file:bg-[#1E6F99]" />
      );
      break;
    case "signature":
      control = <div className="flex h-16 items-center justify-center border-2 border-dashed border-slate-300 text-sm text-slate-400"><Pencil className="h-4 w-4 mr-2" />Click to sign</div>;
      break;
    case "url":
      control = <input type="url" {...reg} placeholder={field.placeholder || "https://…"} disabled={dis} defaultValue={field.defaultValue ?? ""} className={previewInputCls} />;
      break;
    case "percentage":
      control = (
        <div className="relative">
          <input type="number" step="0.01" min={field.min ?? 0} max={field.max ?? 100} {...reg}
            placeholder={field.placeholder || "0"} disabled={dis} defaultValue={field.defaultValue ?? ""}
            className={cn(previewInputCls, "pr-9")} />
          <span className="absolute right-3 top-1/2 -translate-y-1/2 text-sm text-slate-400 font-medium">%</span>
        </div>
      );
      break;
    case "rating": {
      const max = field.max ?? 5;
      const current = Number(values[field.id] ?? 0);
      return (
        <div className="space-y-1.5">
          {label}
          <div className="flex items-center gap-1">
            {Array.from({ length: max }, (_, i) => i + 1).map((n) => (
              <button key={n} type="button" disabled={dis}
                onClick={() => !dis && reg.onChange({ target: { name: field.id, value: n } })}
                className={cn("transition-colors", n <= current ? "text-amber-400" : "text-slate-200", !dis && "hover:text-amber-300")}>
                <Star className="h-5 w-5" fill="currentColor" />
              </button>
            ))}
            <input type="hidden" {...reg} defaultValue={field.defaultValue ?? ""} />
          </div>
          {field.helpText && <p className="text-xs text-slate-500">{field.helpText}</p>}
        </div>
      );
    }
    case "auto_number":
      control = (
        <div className={cn(previewInputCls, "flex items-center gap-2 bg-slate-50 text-slate-400 italic")}>
          <ListOrdered className="h-3.5 w-3.5" /> Assigned automatically on submit
        </div>
      );
      break;
    case "calc_number":
    case "calc_currency": {
      const symbol = field.type === "calc_currency" ? (field.currencySymbol ?? "KSh") : null;
      control = (
        <div className="relative">
          {symbol && <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm text-slate-400 font-medium">{symbol}</span>}
          <input type="number" {...reg} disabled className={cn(previewInputCls, "bg-slate-50 font-semibold text-slate-700", symbol && "pl-14")} />
        </div>
      );
      break;
    }
    case "calc_date":
      control = <input type="text" {...reg} disabled className={cn(previewInputCls, "bg-slate-50 font-semibold text-slate-700")} />;
      break;
    case "calc_boolean": {
      /* Calculated boolean is rendered as a real (read-only) toggle rather
       * than the words Yes/No — the switch position IS the answer. */
      const raw = values[field.id];
      const on = typeof raw === "string"
        ? ["yes", "true", "1"].includes(raw.trim().toLowerCase())
        : isTruthy(raw as CalcValue);
      control = (
        <div className={cn(previewInputCls, "flex items-center gap-3 bg-slate-50")}>
          <ReadonlyToggle value={on} />
          <span className="text-sm font-semibold text-slate-700">{on ? "Yes" : "No"}</span>
          <input type="hidden" {...reg} />
        </div>
      );
      break;
    }
    case "multi_file":
      control = (
        <input type="file" multiple {...reg} disabled={dis}
          className="block w-full text-sm text-slate-500 file:mr-3 file:rounded-none file:border-0 file:bg-[#287EAD] file:px-4 file:py-2 file:text-sm file:font-semibold file:text-white hover:file:bg-[#1E6F99]" />
      );
      break;
    case "calc_text":
      control = <input type="text" {...reg} disabled className={cn(previewInputCls, "bg-slate-50 font-semibold text-slate-700")} />;
      break;
    default:
      control = <input type="text" {...reg} placeholder={field.placeholder} disabled={dis} defaultValue={field.defaultValue ?? ""} className={previewInputCls} />;
  }

  return (
    <div className="space-y-1.5">
      {label}
      {control}
      {field.helpText && <p className="text-xs text-slate-500">{field.helpText}</p>}
      {err && <p className="text-xs text-red-500 flex items-center gap-1"><AlertCircle className="h-3 w-3" />{err}</p>}
    </div>
  );
}

function Preview({ sections, templateName, processSteps }: {
  sections: TemplateSection[]; templateName: string;
  processSteps: { value: string; label: string }[];
}) {
  const { register, handleSubmit, reset, watch, setValue, formState: { errors } } = useForm<Record<string, unknown>>();
  const [submitted, setSubmitted] = useState<Record<string, unknown> | null>(null);
  // Simulate the document being at a given workflow step, so process-step
  // visibility/editability rules can be exercised without a live document.
  const [previewStep, setPreviewStep] = useState("draft");
  const values = watch();
  const allFields = sections.flatMap((s) => s.fields);
  const tableFields = allFields.filter((f) => f.type === "table" && f.key);
  // "draft"is always offered even if it isn't in the workflow's step list.
  const stepOptions = processSteps.some((s) => s.value === "draft")
    ? processSteps
    : [{ value: "draft", label: "Draft (start)" }, ...processSteps];

  // Table row data lives HERE (not inside each table field) rather than as
  // local state per PreviewTableField, keyed by the table field's own key
  // (unique across the template — enforced at save). Lifting it up is what
  // makes cross-table aggregates possible: SUM(other_table.column) needs a
  // single place that can see every table's current rows at once, mirroring
  // the server's shared `all_tables` registry in compute_calculated_values.
  const [tableRows, setTableRows] = useState<Record<string, Record<string, string>[]>>({});

  // Seed a fresh table's initial rows the first time it appears (new field
  // dropped onto the canvas, or first mount). Keyed off a structural
  // fingerprint so it only re-seeds when a table is genuinely new/changed,
  // not on every keystroke elsewhere in the form.
  useEffect(() => {
    setTableRows((prev) => {
      let changed = false;
      const next = { ...prev };
      for (const f of tableFields) {
        if (next[f.key]) continue;
        const cols = f.columns ?? [];
        next[f.key] = Array.from({ length: f.minRows ?? 2 }, () => {
          const r: Record<string, string> = {};
          cols.forEach((c) => { if (c.defaultValue) r[c.key] = c.defaultValue; });
          return r;
        });
        changed = true;
      }
      // Drop rows for tables that no longer exist (field removed on canvas).
      for (const key of Object.keys(next)) {
        if (!tableFields.some((f) => f.key === key)) { delete next[key]; changed = true; }
      }
      return changed ? next : prev;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(tableFields.map((f) => ({ key: f.key, minRows: f.minRows, cols: (f.columns ?? []).map((c) => c.key) })))]);

  // Recompute every `calc`-bearing field whenever any value changes, mirroring
  // the server's authoritative recompute at submit time. Fields resolve in
  // template order so a later formula can reference an earlier calculated
  // field's result. A formula can ALSO aggregate a table elsewhere on the
  // form via SUM(table_key.col) (or the unqualified SUM(col), which searches
  // every table for a matching column — see resolveRowAggregates), so this
  // effect also depends on tableRows/tableFields, not just top-level values.
  // Guarded by a value comparison so this settles to a fixed point instead
  // of looping — a circular formula (A depends on B depends on A) will
  // simply stop updating rather than hang.
  useEffect(() => {
    const registry = buildTableCalcRegistry(tableFields, tableRows);
    const scope = buildCalcScope(allFields, values, registry);
    for (const f of allFields) {
      if (!f.calc?.expression) continue;
      const resolvedExpr = resolveRowAggregates(f.calc.expression, null, null, registry);
      let result = evaluateCalcExpression(resolvedExpr, scope);
      if (typeof result === "number" && typeof f.calc.decimals === "number") result = Number(result.toFixed(f.calc.decimals));
      scope[f.key] = result; // let later formulas see this one's result
      if (values[f.id] !== result) setValue(f.id, result);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    JSON.stringify(values),
    JSON.stringify(allFields.map((f) => f.calc)),
    JSON.stringify(tableRows),
    JSON.stringify(tableFields.map((f) => ({ key: f.key, columns: f.columns }))),
  ]);

  // Recompute every calc-bearing TABLE COLUMN across every table at once —
  // mirrors the server's authoritative compute_calculated_values. Column
  // major (each column resolved across all its own rows before moving to
  // the next) and cross-table aware: a column formula can reference another
  // table's rows via SUM(other_table_key.col), resolved through the shared
  // `registry` built fresh each pass, exactly like the server's all_tables.
  useEffect(() => {
    const colTypesByTable: Record<string, Record<string, TableColumnType | undefined>> = {};
    tableFields.forEach((f) => {
      const map: Record<string, TableColumnType | undefined> = {};
      (f.columns ?? []).forEach((c) => { map[c.key] = c.type; });
      colTypesByTable[f.key] = map;
    });

    setTableRows((prev) => {
      const working: Record<string, Record<string, string>[]> = {};
      for (const f of tableFields) {
        working[f.key] = (prev[f.key] ?? []).map((r) => ({ ...r }));
      }
      const registry: Record<string, TableCalcRegistryEntry> = {};
      for (const f of tableFields) {
        registry[f.key] = { rows: working[f.key], colTypeByKey: colTypesByTable[f.key] };
      }

      let changed = false;
      for (const f of tableFields) {
        const calcCols = (f.columns ?? []).filter((c) => c.calc?.expression);
        if (calcCols.length === 0) continue;
        const rows = working[f.key];
        for (const col of calcCols) {
          const resolvedExpr = resolveRowAggregates(col.calc!.expression, rows, colTypesByTable[f.key], registry);
          for (const row of rows) {
            const scope = buildRowCalcScope(allFields, values, f.columns ?? [], row, registry);
            let result = evaluateCalcExpression(resolvedExpr, scope);
            if (typeof result === "number" && typeof col.calc!.decimals === "number") result = Number(result.toFixed(col.calc!.decimals));
            const str = String(result);
            if (row[col.key] !== str) { row[col.key] = str; changed = true; }
          }
        }
      }
      return changed ? working : prev;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    JSON.stringify(values),
    JSON.stringify(tableRows),
    JSON.stringify(tableFields.map((f) => ({ key: f.key, columns: f.columns }))),
  ]);

  const updateTableCell = (tableKey: string, rowIdx: number, colKey: string, val: string) =>
    setTableRows((prev) => ({
      ...prev,
      [tableKey]: (prev[tableKey] ?? []).map((r, i) => (i === rowIdx ? { ...r, [colKey]: val } : r)),
    }));
  const addTableRow = (tableKey: string) => {
    const f = tableFields.find((tf) => tf.key === tableKey);
    const cols = f?.columns ?? [];
    const r: Record<string, string> = {};
    cols.forEach((c) => { if (c.defaultValue) r[c.key] = c.defaultValue; });
    setTableRows((prev) => ({ ...prev, [tableKey]: [...(prev[tableKey] ?? []), r] }));
  };
  const removeTableRow = (tableKey: string, rowIdx: number) =>
    setTableRows((prev) => ({
      ...prev,
      [tableKey]: (prev[tableKey] ?? []).filter((_, i) => i !== rowIdx),
    }));


  if (submitted) {
    return (
      <div className="mx-auto max-w-4xl p-8">
        <div className="border border-slate-300 bg-white p-8 shadow-sm">
          <div className="mb-6 flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center bg-emerald-100"><CheckCircle2 className="h-5 w-5 text-emerald-600" /></div>
            <div>
              <h2 className="text-lg font-bold text-slate-800">Submission preview</h2>
              <p className="text-sm text-slate-500">This is what would be saved when a user submits the form.</p>
            </div>
          </div>
          <pre className="overflow-auto bg-slate-900 p-5 text-xs text-emerald-400 font-mono leading-relaxed">
            {JSON.stringify(submitted, null, 2)}
          </pre>
          <button type="button" onClick={() => { setSubmitted(null); reset(); }}
            className="mt-5 inline-flex items-center gap-1.5 border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50">
            <RotateCcw className="h-4 w-4" /> Test again
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-4xl p-8">
      <form onSubmit={handleSubmit((d) => setSubmitted(d))} className="space-y-6">
        <header className="flex items-start justify-between gap-4 pb-4 border-b border-slate-300">
          <div>
            <h1 className="text-2xl font-bold text-slate-900">{templateName}</h1>
            <p className="mt-1 text-sm text-slate-500">Fill out the form below to preview how end users will experience this template.</p>
          </div>
          <label className="flex flex-shrink-0 flex-col gap-1 text-right">
            <span className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">Preview as step</span>
            <select value={previewStep} onChange={(e) => setPreviewStep(e.target.value)}
              className="h-9 min-w-[180px] border border-[#AEB5BB] bg-white px-2 text-sm text-[#1F2933] outline-none focus:border-[#287EAD]">
              {stepOptions.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </label>
        </header>
        {sections.map((s) => {
          if (!evalVisible(s, values, allFields, previewStep)) return null;
          const sectionEditable = evalEditable(s, values, allFields, previewStep);
          return (
            <section key={s.id} className="border border-slate-300 bg-white p-6 shadow-sm">
              <div className="mb-5 pb-4 border-b border-slate-200">
                <h2 className="flex items-center gap-2 text-base font-bold text-slate-800">
                  {s.title}
                  {!sectionEditable && (
                    <span className="inline-flex items-center gap-1 bg-slate-100 px-1.5 py-0.5 text-[10px] font-semibold text-slate-500">read-only</span>
                  )}
                </h2>
                {s.description && <p className="mt-0.5 text-sm text-slate-500">{s.description}</p>}
              </div>
              <div className="grid grid-cols-12 gap-4">
                {s.fields.map((f) => {
                  if (!evalVisible(f, values, allFields, previewStep)) return null;
                  return (
                    <div key={f.id} className="min-w-0" style={{ gridColumn: `span ${f.colSpan ?? 12} / span ${f.colSpan ?? 12}` }}>
                      <PreviewField field={f} register={register} errors={errors} values={values} allFields={allFields}
                        editable={sectionEditable && evalEditable(f, values, allFields, previewStep)}
                        tableRows={tableRows} onUpdateTableCell={updateTableCell}
                        onAddTableRow={addTableRow} onRemoveTableRow={removeTableRow}
                        previewStep={previewStep} />
                    </div>
                  );
                })}
              </div>
            </section>
          );
        })}
        <div className="flex items-center justify-end gap-3 pt-2">
          <button type="button" onClick={() => reset()}
            className="inline-flex items-center gap-1.5 border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50">
            <RotateCcw className="h-4 w-4" /> Reset
          </button>
          <button type="submit"
            className="inline-flex items-center gap-1.5 bg-[#287EAD] px-5 py-2 text-sm font-semibold text-white hover:bg-[#1E6F99] shadow-sm">
            <ArrowRight className="h-4 w-4" /> Submit test
          </button>
        </div>
      </form>
    </div>
  );
}

/* ============================================================
 * Settings tab (unchanged behavior)
 * ============================================================ */

function SettingsTab({ template, onCommit, documentTypes, processSteps }: {
  template: Template;
  onCommit: (patch: Partial<Template>) => void;
  documentTypes: Array<{ id: string; name: string; code: string }>;
  processSteps: { value: string; label: string }[];
}) {
  const [tagInput, setTagInput] = useState("");
  const [showCreate, setShowCreate] = useState(false);

  const addTag = () => {
    const t = tagInput.trim().toLowerCase().replace(/\s+/g, "-");
    if (!t) return;
    if (!(template.tags ?? []).includes(t)) onCommit({ tags: [...(template.tags ?? []), t] });
    setTagInput("");
  };
  const removeTag = (tag: string) =>
    onCommit({ tags: (template.tags ?? []).filter((t) => t !== tag) });

  const fieldCount = template.sections.reduce((a, s) => a + s.fields.length, 0);

  const iCls =
    "h-9 w-full border border-[#AEB5BB] bg-white px-3 text-sm text-[#1F2933] " +
    "placeholder:text-[#8C969E] outline-none focus:border-[#287EAD] focus:ring-1 focus:ring-[#287EAD]";

  return (
    <div className="mx-auto max-w-4xl space-y-5 p-8">
      <div className="border border-[#C8CDD2] bg-white shadow-sm">
        <div className="border-b border-[#C8CDD2] bg-[#F3F5F6] px-5 py-3">
          <h2 className="text-sm font-bold text-[#1F2933]">Template metadata</h2>
          <p className="text-xs text-[#5E6870] mt-0.5">Used for search, organisation, and document filing.</p>
        </div>
        <div className="space-y-4 p-5">
          <div className="space-y-1.5">
            <label className="text-xs font-semibold uppercase tracking-wider text-[#5E6870]">Name</label>
            <input value={template.name} onChange={(e) => onCommit({ name: e.target.value })} className={iCls} />
          </div>
          <div className="space-y-1.5">
            <label className="text-xs font-semibold uppercase tracking-wider text-[#5E6870]">Description</label>
            <textarea value={template.description ?? ""} rows={3}
              onChange={(e) => onCommit({ description: e.target.value })}
              className={iCls.replace("h-9", "min-h-[76px] py-2 resize-none")} />
          </div>
          <div className="space-y-1.5">
            <label className="text-xs font-semibold uppercase tracking-wider text-[#5E6870]">Document type <span className="text-red-400 normal-case font-normal">*</span></label>
            <div className="flex gap-2">
              <select value={template.document_type_id ?? ""} onChange={(e) => onCommit({ document_type_id: e.target.value })}
                className={cn(iCls, "flex-1")}>
                <option value="">Select document type</option>
                {documentTypes.map((type) => <option key={type.id} value={type.id}>{type.name}</option>)}
              </select>
              <button type="button" onClick={() => setShowCreate(true)} title="Create new document type"
                className="h-9 px-3 border border-[#AEB5BB] bg-white text-[#5E6870] hover:text-[#287EAD] hover:border-[#287EAD]/60 hover:bg-[#EEF6FB] transition-all flex items-center gap-1.5 text-xs font-semibold whitespace-nowrap">
                <Plus className="h-3.5 w-3.5" /> New type
              </button>
            </div>
            {showCreate && (
              <CreateDocTypeQuickModal
                onClose={() => setShowCreate(false)}
                onCreated={(type) => { onCommit({ document_type_id: type.id }); setShowCreate(false); }}
              />
            )}
          </div>
          <div className="space-y-1.5">
            <label className="text-xs font-semibold uppercase tracking-wider text-[#5E6870]">Tags</label>
            <div className="flex gap-2">
              <input value={tagInput} onChange={(e) => setTagInput(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), addTag())}
                placeholder="Add tag and press Enter"
                className={cn(iCls, "flex-1")} />
              <button onClick={addTag} className="h-9 px-3 bg-[#287EAD] text-white text-sm font-semibold hover:bg-[#1E6F99]">
                <Plus className="h-4 w-4" />
              </button>
            </div>
            {(template.tags ?? []).length > 0 && (
              <div className="flex flex-wrap gap-2 mt-2">
                {(template.tags ?? []).map((tag) => (
                  <span key={tag} className="flex items-center gap-1.5 px-2.5 py-1 bg-[#EEF6FB] text-[#287EAD] text-xs font-semibold border border-[#287EAD]/20">
                    <Tag className="h-2.5 w-2.5" />{tag}
                    <button onClick={() => removeTag(tag)} className="text-[#287EAD]/60 hover:text-[#287EAD] ml-0.5"><Minus className="h-2.5 w-2.5" /></button>
                  </span>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
      <div className="border border-[#C8CDD2] bg-white shadow-sm">
        <div className="border-b border-[#C8CDD2] bg-[#F3F5F6] px-5 py-3">
          <h2 className="text-sm font-bold text-[#1F2933]">Template summary</h2>
        </div>
        <div className="grid grid-cols-3 divide-x divide-[#C8CDD2]">
          {[
            { label: "Sections", value: template.sections.length },
            { label: "Fields", value: fieldCount },
            { label: "Document type", value: documentTypes.find((type) => type.id === template.document_type_id)?.code ?? "—" },
          ].map((s) => (
            <div key={s.label} className="px-5 py-4 text-center">
              <div className="text-2xl font-bold text-[#287EAD]">{s.value}</div>
              <div className="text-xs text-[#5E6870] mt-0.5 font-medium">{s.label}</div>
            </div>
          ))}
        </div>
      </div>
      <FinanceSettingsCard template={template} onCommit={onCommit} iCls={iCls} processSteps={processSteps} />
    </div>
  );
}

/* SunSystems / finance header config. Field-level bindings (accounts, amounts,
 * analysis) are set visually in the field inspector; this card holds the
 * connection-level constants (business unit, journal type, …) and the on/off
 * toggles, and previews what the bindings will compile into. */
function FinanceSettingsCard({ template, onCommit, iCls, processSteps }: {
  template: Template;
  onCommit: (patch: Partial<Template>) => void;
  iCls: string;
  processSteps: { value: string; label: string }[];
}) {
  const ss = template.sunsystems ?? {};
  const ui: SunSystemsUi = ss.ui ?? {};
  const setUi = (patch: Partial<SunSystemsUi>) =>
    onCommit({ sunsystems: { ...ss, ui: { ...ui, ...patch } } });
  const [showXml, setShowXml] = useState(false);

  const fields = template.sections.flatMap((s) => s.fields ?? []);
  const roleLabel = (role: string) => {
    const bound = fields.filter((f) => f.sunsystems?.role === role).map((f) => f.label);
    return bound.length ? bound.join(", ") : "—";
  };
  const budgetLabel = (r: string) => {
    const bound = fields.filter((f) => budgetRoleOf(f) === r).map((f) => f.label);
    return bound.length ? bound.join(", ") : "—";
  };
  const journalFieldLines = fields.filter((f) => f.type !== "table" && isJournalLineSource(f)).length;
  const journalTableLines = fields.filter((f) => f.type === "table" && isJournalLineSource(f)).length;
  const postingKind = ui.postingKind ?? "journal";
  const purchaseAmountLabel = roleLabel("journal_amount");
  const stageOptions = processSteps.some((s) => s.value === "approved")
    ? processSteps
    : [...processSteps, { value: "approved", label: "Approved" }];
  const journalBoundFields = fields.filter(isJournalLineSource);
  const journalStages = (ui.journalStages?.length ? ui.journalStages : [{ stage: 1, label: "Stage 1", postOn: "approved", fieldKeys: [] as string[] }])
    .map((s, idx) => ({
      stage: Number(s.stage || idx + 1),
      label: s.label ?? `Stage ${idx + 1}`,
      postOn: s.postOn ?? "approved",
      fieldKeys: s.fieldKeys ?? [],
    }));
  const setStages = (stages: NonNullable<SunSystemsUi["journalStages"]>) => setUi({ journalStages: stages });
  const updateStage = (index: number, patch: Partial<NonNullable<SunSystemsUi["journalStages"]>[number]>) =>
    setStages(journalStages.map((s, i) => i === index ? { ...s, ...patch } : s));
  const addStage = () => {
    const next = Math.max(0, ...journalStages.map((s) => Number(s.stage) || 0)) + 1;
    setStages([...journalStages, { stage: next, label: `Stage ${next}`, postOn: "approved", fieldKeys: [] }]);
  };
  const removeStage = (index: number) =>
    setStages(journalStages.filter((_, i) => i !== index).map((s, i) => ({ ...s, stage: i + 1 })));
  const toggleStageField = (stageIndex: number, fieldKey: string) => {
    const current = journalStages[stageIndex].fieldKeys ?? [];
    const next = current.includes(fieldKey)
      ? current.filter((k) => k !== fieldKey)
      : [...current, fieldKey];
    updateStage(stageIndex, { fieldKeys: next });
  };
  const compiledJournal = compileSunSystems(template)?.journal as any;
  const previewMapping = Array.isArray(compiledJournal?.stages)
    ? compiledJournal.stages[0]
    : (compiledJournal ?? null);

  const label = "text-xs font-semibold uppercase tracking-wider text-[#5E6870]";
  const Toggle = ({ on, onClick }: { on: boolean; onClick: () => void }) => (
    <button type="button" onClick={onClick}
      className={cn("relative h-5 w-9 rounded-full transition-colors", on ? "bg-[#287EAD]" : "bg-[#C8CDD2]")}>
      <span className={cn("absolute top-0.5 h-4 w-4 rounded-full bg-white transition-all", on ? "left-[18px]" : "left-0.5")} />
    </button>
  );

  return (
    <div className="border border-[#C8CDD2] bg-white shadow-sm">
      <div className="border-b border-[#C8CDD2] bg-[#F3F5F6] px-5 py-3">
        <h2 className="text-sm font-bold text-[#1F2933]">Infor SunSystems</h2>
        <p className="text-xs text-[#5E6870] mt-0.5">Budget checks while filling, and journal posting on approval. Bind individual fields in the field inspector.</p>
      </div>
      <div className="space-y-5 p-5">
        {/* Budget check */}
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm font-semibold text-[#1F2933]">Budget check</p>
            <p className="text-xs text-[#5E6870]">Show available budget while the form is filled.</p>
          </div>
          <Toggle on={!!ui.budgetEnabled} onClick={() => setUi({ budgetEnabled: !ui.budgetEnabled })} />
        </div>
        {ui.budgetEnabled && (
          <div className="space-y-3 border-l-2 border-[#287EAD]/30 pl-4">
            <div className="grid grid-cols-2 gap-3 text-xs">
              <div><span className={label}>Budget account</span><div className="mt-1 text-[#1F2933]">{budgetLabel("account")}</div></div>
              <div><span className={label}>Budget amount</span><div className="mt-1 text-[#1F2933]">{budgetLabel("amount")}</div></div>
            </div>
            <div className="space-y-1.5">
              <span className={label}>When over budget at submit</span>
              <select className={iCls} value={ui.budgetMode ?? "warn"} onChange={(e) => setUi({ budgetMode: e.target.value as "warn" | "block" })}>
                <option value="warn">Warn only</option>
                <option value="block">Block submission</option>
              </select>
            </div>
          </div>
        )}

        {/* Journal posting */}
        <div className="flex items-center justify-between border-t border-[#EEF0F2] pt-4">
          <div>
            <p className="text-sm font-semibold text-[#1F2933]">Journal posting</p>
            <p className="text-xs text-[#5E6870]">Post a ledger journal to SunSystems on final approval.</p>
          </div>
          <Toggle on={!!ui.journalEnabled} onClick={() => setUi({ journalEnabled: !ui.journalEnabled })} />
        </div>
        {ui.journalEnabled && (
          <div className="space-y-3 border-l-2 border-[#287EAD]/30 pl-4">
            <div className="space-y-1.5">
              <span className={label}>Posting type</span>
              <select className={iCls} value={postingKind} onChange={(e) => setUi({ postingKind: e.target.value as "journal" | "purchase_order" })}>
                <option value="journal">Ledger journal</option>
                <option value="purchase_order">Purchase order / LPO</option>
              </select>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5"><span className={label}>Business unit</span>
                <input className={iCls} value={ui.businessUnit ?? ""} onChange={(e) => setUi({ businessUnit: e.target.value })} placeholder="e.g. ZRD" /></div>
              <div className="space-y-1.5"><span className={label}>Budget code</span>
                <input className={iCls} value={ui.budgetCode ?? ""} onChange={(e) => setUi({ budgetCode: e.target.value })} placeholder="e.g. A" /></div>
              {postingKind === "journal" ? (
                <>
                  <div className="space-y-1.5"><span className={label}>Journal type</span>
                    <input className={cn(iCls, "font-mono")} value={ui.journalType ?? ""} onChange={(e) => setUi({ journalType: e.target.value })} placeholder="e.g. PIINV" /></div>
                  <div className="space-y-1.5"><span className={label}>Posting type</span>
                    <input className={cn(iCls, "font-mono")} value={ui.postingType ?? ""} onChange={(e) => setUi({ postingType: e.target.value })} placeholder="e.g. 2" /></div>
                </>
              ) : (
                <>
                  <div className="space-y-1.5"><span className={label}>Supplier code</span>
                    <input className={cn(iCls, "font-mono")} value={ui.supplierCode ?? "81105"} onChange={(e) => setUi({ supplierCode: e.target.value })} placeholder="81105" /></div>
                  <div className="space-y-1.5"><span className={label}>Transaction type</span>
                    <input className={cn(iCls, "font-mono")} value={ui.purchaseTransactionType ?? "ASSETS"} onChange={(e) => setUi({ purchaseTransactionType: e.target.value })} placeholder="ASSETS" /></div>
                  <div className="space-y-1.5"><span className={label}>Invoice address</span>
                    <input className={cn(iCls, "font-mono")} value={ui.invoiceAddressCode ?? "0000000000"} onChange={(e) => setUi({ invoiceAddressCode: e.target.value })} placeholder="0000000000" /></div>
                  <div className="space-y-1.5"><span className={label}>Item code</span>
                    <input className={cn(iCls, "font-mono")} value={ui.itemCode ?? "ITM29"} onChange={(e) => setUi({ itemCode: e.target.value })} placeholder="ITM29" /></div>
                  <div className="space-y-1.5"><span className={label}>Account code</span>
                    <input className={cn(iCls, "font-mono")} value={ui.accountCode ?? ""} onChange={(e) => setUi({ accountCode: e.target.value })} placeholder="optional" /></div>
                  <div className="space-y-1.5"><span className={label}>Analysis 10 category</span>
                    <input className={cn(iCls, "font-mono")} value={ui.analysis10Category ?? "11"} onChange={(e) => setUi({ analysis10Category: e.target.value })} placeholder="11" /></div>
                  <div className="space-y-1.5"><span className={label}>Analysis 10 code</span>
                    <input className={cn(iCls, "font-mono")} value={ui.analysis10Code ?? "E"} onChange={(e) => setUi({ analysis10Code: e.target.value })} placeholder="E" /></div>
                  <div className="space-y-1.5"><span className={label}>Order quantity</span>
                    <input className={cn(iCls, "font-mono")} value={ui.quantity ?? ""} onChange={(e) => setUi({ quantity: e.target.value })} placeholder="1 (default)" /></div>
                  <div className="space-y-1.5"><span className={label}>Unit price</span>
                    <input className={cn(iCls, "font-mono")} value={ui.unitPrice ?? ""} onChange={(e) => setUi({ unitPrice: e.target.value })} placeholder="= total amount (default)" /></div>
                  <div className="space-y-1.5"><span className={label}>VLAB base # (qty label)</span>
                    <input className={cn(iCls, "font-mono")} value={ui.vlabBase ?? ""} onChange={(e) => setUi({ vlabBase: e.target.value })} placeholder="1 (default)" /></div>
                  <div className="space-y-1.5"><span className={label}>VLAB trans # (amount label)</span>
                    <input className={cn(iCls, "font-mono")} value={ui.vlabTrans ?? ""} onChange={(e) => setUi({ vlabTrans: e.target.value })} placeholder="2 (default)" /></div>
                </>
              )}
            </div>
            <div className="grid grid-cols-2 gap-3 text-xs">
              <div><span className={label}>Reference</span><div className="mt-1 text-[#1F2933]">{roleLabel("reference")}</div></div>
              <div><span className={label}>Transaction date</span><div className="mt-1 text-[#1F2933]">{roleLabel("transaction_date")}</div></div>
              <div><span className={label}>Currency</span><div className="mt-1 text-[#1F2933]">{roleLabel("currency") !== "—" ? roleLabel("currency") : (ui.currencyConst || "—")}</div></div>
              <div><span className={label}>Description</span><div className="mt-1 text-[#1F2933]">{roleLabel("description")}</div></div>
              {postingKind === "purchase_order" && <div><span className={label}>Amount</span><div className="mt-1 text-[#1F2933]">{purchaseAmountLabel}</div></div>}
            </div>
            {postingKind === "journal" && (
              <>
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <span className={label}>Posting stages</span>
                    <button type="button" onClick={addStage} className="inline-flex items-center gap-1 border border-[#287EAD] px-2 py-1 text-[11px] font-semibold text-[#287EAD] hover:bg-[#EEF6FB]">
                      <Plus className="h-3 w-3" /> Add stage
                    </button>
                  </div>
                  <div className="space-y-2">
                    {journalStages.map((stage, index) => (
                      <div key={index} className="border border-[#E1E5E8] bg-[#F8FAFB] p-2 space-y-2">
                        {/* row 1: stage number / label / trigger / delete */}
                        <div className="grid grid-cols-[70px_1fr_1.3fr_auto] gap-2">
                          <div className="space-y-1">
                            <span className="text-[10px] font-semibold uppercase text-[#5E6870]">Stage</span>
                            <input
                              className={cn(iCls, "font-mono")}
                              type="number"
                              min={1}
                              value={stage.stage}
                              onChange={(e) => updateStage(index, { stage: Math.max(1, Number(e.target.value) || 1) })}
                            />
                          </div>
                          <div className="space-y-1">
                            <span className="text-[10px] font-semibold uppercase text-[#5E6870]">Label</span>
                            <input
                              className={iCls}
                              value={stage.label ?? ""}
                              onChange={(e) => updateStage(index, { label: e.target.value })}
                              placeholder={`Stage ${stage.stage}`}
                            />
                          </div>
                          <div className="space-y-1">
                            <span className="text-[10px] font-semibold uppercase text-[#5E6870]">Post when workflow status becomes</span>
                            <select
                              className={iCls}
                              value={stage.postOn ?? "approved"}
                              onChange={(e) => updateStage(index, { postOn: e.target.value })}
                            >
                              {stageOptions.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
                            </select>
                          </div>
                          <button
                            type="button"
                            onClick={() => removeStage(index)}
                            disabled={journalStages.length <= 1}
                            title="Remove stage"
                            className="self-end inline-flex h-9 w-9 items-center justify-center border border-[#C8CDD2] text-[#5E6870] hover:border-red-300 hover:bg-red-50 hover:text-red-700 disabled:opacity-40"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        </div>
                        {/* row 2: field assignment (only shown when multi-stage + there are bound fields) */}
                        {journalStages.length > 1 && journalBoundFields.length > 0 && (
                          <div className="space-y-1 border-t border-[#E8EAEC] pt-2">
                            <span className="text-[10px] font-semibold uppercase text-[#5E6870]">Lines in this stage</span>
                            <div className="flex flex-wrap gap-1.5">
                              {journalBoundFields.map((f) => {
                                const assigned = stage.fieldKeys?.includes(f.key) ?? false;
                                return (
                                  <button
                                    key={f.key}
                                    type="button"
                                    onClick={() => toggleStageField(index, f.key)}
                                    title={f.key}
                                    className={cn(
                                      "inline-flex items-center gap-1 border px-2 py-0.5 text-[11px] font-medium transition-colors",
                                      assigned
                                        ? "border-[#287EAD] bg-[#EEF6FB] text-[#287EAD]"
                                        : "border-[#C8CDD2] bg-white text-[#5E6870] hover:border-[#287EAD] hover:text-[#287EAD]"
                                    )}
                                  >
                                    {f.type === "table" ? "⊞" : "≡"} {f.label || f.key}
                                  </button>
                                );
                              })}
                            </div>
                            {(stage.fieldKeys?.length ?? 0) === 0 && (
                              <p className="text-[10px] text-amber-600">No lines assigned — this stage will not post any journal lines.</p>
                            )}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
                <label className="flex cursor-pointer items-center gap-2.5 text-sm text-[#1F2933]">
                  <input type="checkbox" checked={ui.validateBalance !== false} onChange={(e) => setUi({ validateBalance: e.target.checked })}
                    className="h-4 w-4 accent-[#287EAD]" />
                  Require debits to balance credits before posting
                </label>
              </>
            )}
            <div className="border border-[#EEF0F2] bg-[#F8FAFB] px-3 py-2 text-xs text-[#5E6870]">
              {postingKind === "journal" ? (
                <>
                  Journal lines from bindings: <b className="text-[#1F2933]">{journalFieldLines}</b> fixed + <b className="text-[#1F2933]">{journalTableLines}</b> table block{journalTableLines !== 1 ? "s" : ""}.
                  {journalFieldLines + journalTableLines === 0 && <span className="text-amber-600"> Bind at least one amount field/table to post.</span>}
                </>
              ) : (
                <>
                  LPO amount binding: <b className="text-[#1F2933]">{purchaseAmountLabel}</b>.
                  {purchaseAmountLabel === "—" && <span className="text-amber-600"> Bind one amount field as Journal line amount.</span>}
                </>
              )}
            </div>
            {(postingKind === "purchase_order" ? purchaseAmountLabel !== "—" : journalFieldLines + journalTableLines > 0) && (
              <button
                type="button"
                onClick={() => setShowXml(true)}
                className="inline-flex items-center gap-1.5 border border-[#287EAD] px-3 py-1.5 text-xs font-semibold text-[#287EAD] hover:bg-[#EEF6FB]"
              >
                <FileCode className="h-3.5 w-3.5" /> Preview {postingKind === "purchase_order" ? "LPO" : "journal"} XML
              </button>
            )}
          </div>
        )}
      </div>
      {showXml && (
        <JournalPayloadModal
          mapping={previewMapping}
          values={buildSampleValues(template)}
          sample
          title={template.name}
          onClose={() => setShowXml(false)}
        />
      )}
    </div>
  );
}

/* ============================================================
 * TemplateBuilderV2 root
 * ============================================================ */

type Tab = "form" | "preview" | "settings";

export interface TemplateBuilderV2Props {
  initial?: EditableTemplate | null;
  onSave: (template: Template, stayOpen?: boolean) => void;
  onCancel: () => void;
  isSaving?: boolean;
  documentTypes?: Array<{ id: string; name: string; code: string }>;
}

/* Propagate a field/column KEY rename to every place in the template that
 * references it by that key string — visibility/editability rule
 * conditions, calc formulas (including the table-qualifier in
 * SUM(table_key.column_key)), currency-symbol-source links, and a
 * SunSystems Retirement panel's "issued amount" field selection.
 *
 * Without this, renaming an already-in-use field — which the auto-key-sync
 * label→ID behavior makes easy to do by accident, since a fresh field's key
 * keeps following its label until manually edited — silently breaks every
 * reference pointing at the old key. Concretely: a Retirement panel's
 * "issued amount" field selection is stored as a bare key string, not a
 * live reference; rename that field afterward and the stored key no longer
 * matches anything in the submitted form values, so it silently resolves
 * to 0 forever after — every submission then reads as a full "overspend",
 * with the variance line posting the entire spent total instead of the
 * true difference. No error, no warning — just a wrong-but-still-balanced
 * journal. This is called from the exact same commit that changes a key,
 * so the rename and its propagation can never land as two separate,
 * separately-undoable steps. */
function renameKeyEverywhere(template: Template, oldKey: string, newKey: string): Template {
  if (!oldKey || !newKey || oldKey === newKey) return template;
  const escaped = oldKey.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const wordRe = new RegExp(`\\b${escaped}\\b`, "g");

  const renameGroup = (g?: RuleGroup | null): RuleGroup | null | undefined => {
    if (!g) return g;
    return {
      ...g,
      conditions: g.conditions.map((c) =>
        c.source === "field" && c.fieldKey === oldKey ? { ...c, fieldKey: newKey } : c
      ),
    };
  };
  const renameCalc = (calc?: CalcConfig | null): CalcConfig | null | undefined =>
    calc?.expression ? { ...calc, expression: calc.expression.replace(wordRe, newKey) } : calc;

  const renameColumn = (c: TableColumn): TableColumn => ({
    ...c,
    visibleWhen: renameGroup(c.visibleWhen),
    editableWhen: renameGroup(c.editableWhen),
    calc: renameCalc(c.calc),
    currencyFromColumn: c.currencyFromColumn === oldKey ? newKey : c.currencyFromColumn,
    sunsystems: c.sunsystems?.retirement?.issuedAmountField === oldKey
      ? { ...c.sunsystems, retirement: { ...c.sunsystems.retirement, issuedAmountField: newKey } }
      : c.sunsystems,
  });
  const renameField = (f: TemplateField): TemplateField => ({
    ...f,
    visibleWhen: renameGroup(f.visibleWhen),
    editableWhen: renameGroup(f.editableWhen),
    calc: renameCalc(f.calc),
    currencyFromField: f.currencyFromField === oldKey ? newKey : f.currencyFromField,
    columns: f.columns ? f.columns.map(renameColumn) : f.columns,
  });

  return {
    ...template,
    sections: template.sections.map((s) => ({
      ...s,
      visibleWhen: renameGroup(s.visibleWhen),
      editableWhen: renameGroup(s.editableWhen),
      fields: s.fields.map(renameField),
    })),
  };
}

export default function TemplateBuilderV2({ initial, onSave, onCancel, isSaving, documentTypes = [] }: TemplateBuilderV2Props) {
  // History + cursor live in ONE state so they can never desync. (A previous
  // split — setHistory using a stale `cursor` from a drag listener's closure
  // while setCursor incremented functionally — let `cursor` outrun the stack
  // during a resize drag, making `history[cursor]` undefined.)
  const [hist, setHist] = useState<{ stack: Template[]; cursor: number }>(() => ({
    stack: [normalizeTemplate(initial ?? initialTemplate)],
    cursor: 0,
  }));
  const { stack: history, cursor } = hist;
  const template = history[cursor];
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("form");
  const [dragType, setDragType] = useState<FieldType | null>(null);
  const [inspectorOpen, setInspectorOpen] = useState(true);
  const [visible, setVisible] = useState(false);
  const [closing, setClosing] = useState(false);
  const [configuringColumn, setConfiguringColumn] = useState<{ sectionId: string; fieldId: string; colId: string } | null>(null);
  const [pendingDelete, setPendingDelete] = useState<{ title: string; message: React.ReactNode; onConfirm: () => void } | null>(null);

  const [autoSave, setAutoSave] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    return window.localStorage.getItem("tb:autoSave") === "1";
  });
  const autoSaveSkipNext = useRef(true);
  const [lastAutoSavedAt, setLastAutoSavedAt] = useState<number | null>(null);
  const autoSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Workflow process steps for this template's document type — drives the
  // "process step"visibility conditions in the inspector.
  const { data: processSteps = [] } = useQuery({
    queryKey: ["workflow-process-steps", template?.document_type_id ?? ""],
    queryFn: async () => {
      const { data } = await workflowAPI.processSteps(template?.document_type_id);
      return (data ?? []) as { value: string; label: string }[];
    },
    staleTime: 60_000,
  });

  useEffect(() => {
    if (typeof window !== "undefined") {
      window.localStorage.setItem("tb:autoSave", autoSave ? "1" : "0");
    }
  }, [autoSave]);

  useEffect(() => {
    const id = requestAnimationFrame(() => setVisible(true));
    return () => cancelAnimationFrame(id);
  }, []);

  const handleCancel = () => { setClosing(true); setTimeout(onCancel, 220); };

  useEffect(() => {
    setHist({ stack: [normalizeTemplate(initial ?? initialTemplate)], cursor: 0 });
    setSelectedId(null);
    autoSaveSkipNext.current = true;
  }, [initial]);

  const commit = useCallback((next: Template) => {
    setHist(({ stack, cursor }) => {
      const nstack = [...stack.slice(0, cursor + 1), next];
      return { stack: nstack, cursor: nstack.length - 1 };
    });
  }, []);

  const canUndo = cursor > 0;
  const canRedo = cursor < history.length - 1;

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));

  const onDragStart = (e: DragStartEvent) => {
    const t = e.active.data.current?.fieldType as FieldType | undefined;
    if (t) setDragType(t);
  };

  const onDragEnd = (e: DragEndEvent) => {
    setDragType(null);
    const { active, over } = e;
    if (!over) return;
    const src = active.data.current;
    const dst = over.data.current;

    if (src?.source === "palette" && dst?.source === "canvas") {
      const field = newField(src.fieldType as FieldType);
      const next: Template = {
        ...template,
        sections: template.sections.map((s) => {
          if (s.id !== dst.sectionId) return s;
          if (dst.kind === "section-end") return { ...s, fields: [...s.fields, field] };
          const idx = s.fields.findIndex((f) => f.id === dst.fieldId);
          if (idx < 0) return { ...s, fields: [...s.fields, field] };
          const insertAt = dst.kind === "before" ? idx : idx + 1;
          const fields = [...s.fields];
          fields.splice(insertAt, 0, field);
          return { ...s, fields };
        }),
      };
      commit(next);
      setSelectedId(field.id);
    }
  };

  /* Propagate a field/column KEY rename to every place in the template that
   * references it by that key string — visibility/editability rule
   * conditions, calc formulas (including the table-qualifier in
   * SUM(table_key.column_key)), currency-symbol-source links, and a
   * SunSystems Retirement panel's "issued amount" field selection.
   *
   * Without this, renaming an already-in-use field — which the auto-key-sync
   * label→ID behavior makes easy to do by accident, since a fresh field's key
   * keeps following its label until manually edited — silently breaks every
   * reference pointing at the old key. Concretely: a Retirement panel's
   * "issued amount" field selection is stored as a bare key string, not a
   * live reference; rename that field afterward and the stored key no longer
   * matches anything in the submitted form values, so it silently resolves
   * to 0 forever after — every submission then reads as a full "overspend",
   * with the variance line posting the entire spent total instead of the
   * true difference. No error, no warning — just a wrong-but-still-balanced
   * journal. This is called from the exact same commit that changes a key,
   * so the rename and its propagation can never land as two separate,
   * separately-undoable steps. */

  const updateField = (sectionId: string, fieldId: string, patch: Partial<TemplateField>) => {
    const current = template.sections.flatMap((s) => s.fields).find((f) => f.id === fieldId);
    let next: Template = {
      ...template,
      sections: template.sections.map((s) =>
        s.id !== sectionId ? s : { ...s, fields: s.fields.map((f) => f.id === fieldId ? { ...f, ...patch } : f) }
      ),
    };
    if (current && patch.key && patch.key !== current.key) {
      next = renameKeyEverywhere(next, current.key, patch.key);
    }
    commit(next);
  };
  const updateSection = (sectionId: string, patch: Partial<TemplateSection>) =>
    commit({ ...template, sections: template.sections.map((s) => s.id === sectionId ? { ...s, ...patch } : s) });
  const removeField = (sectionId: string, fieldId: string) => {
    commit({ ...template, sections: template.sections.map((s) => s.id !== sectionId ? s : { ...s, fields: s.fields.filter((f) => f.id !== fieldId) }) });
    if (selectedId === fieldId) setSelectedId(null);
  };
  const duplicateField = (sectionId: string, fieldId: string) => {
    commit({
      ...template,
      sections: template.sections.map((s) => {
        if (s.id !== sectionId) return s;
        const idx = s.fields.findIndex((f) => f.id === fieldId);
        if (idx < 0) return s;
        const orig = s.fields[idx];
        const copy: TemplateField = {
          ...orig, id: uid(),
          key: `${orig.key}_copy`,
          label: `${orig.label} (copy)`,
          columns: orig.columns ? orig.columns.map((c) => ({ ...c, id: uid() })) : undefined,
        };
        const fields = [...s.fields];
        fields.splice(idx + 1, 0, copy);
        return { ...s, fields };
      }),
    });
  };
  const removeSection = (sectionId: string) => {
    commit({ ...template, sections: template.sections.filter((s) => s.id !== sectionId) });
    if (selectedId === sectionId) setSelectedId(null);
  };
  /* Deleting is destructive and easy to hit by accident (the trash icon sits
   * next to move/duplicate), so both field and section deletes are confirmed. */
  const requestRemoveField = (sectionId: string, fieldId: string) => {
    const field = template.sections.find((s) => s.id === sectionId)?.fields.find((f) => f.id === fieldId);
    setPendingDelete({
      title: "Delete this field?",
      message: (
        <>
          <strong>{field?.label || field?.key || "This field"}</strong> and its settings
          {field?.type === "table" && (field.columns?.length ?? 0) > 0
            ? `, including ${field.columns!.length} column${field.columns!.length === 1 ? "" : "s"},`
            : ""} will be removed from the form. You can undo this afterwards.
        </>
      ),
      onConfirm: () => removeField(sectionId, fieldId),
    });
  };
  const requestRemoveSection = (sectionId: string) => {
    const section = template.sections.find((s) => s.id === sectionId);
    const count = section?.fields.length ?? 0;
    setPendingDelete({
      title: "Delete this section?",
      message: (
        <>
          <strong>{section?.title || "This section"}</strong>
          {count > 0 ? ` and its ${count} field${count === 1 ? "" : "s"}` : ""} will be removed from the form.
          You can undo this afterwards.
        </>
      ),
      onConfirm: () => removeSection(sectionId),
    });
  };

  const addSection = () => {
    const s = newSection();
    commit({ ...template, sections: [...template.sections, s] });
    setSelectedId(s.id);
  };
  const moveSection = (sectionId: string, dir: "up" | "down") => {
    const idx = template.sections.findIndex((s) => s.id === sectionId);
    if (idx < 0) return;
    const target = dir === "up" ? idx - 1 : idx + 1;
    if (target < 0 || target >= template.sections.length) return;
    const sections = [...template.sections];
    [sections[idx], sections[target]] = [sections[target], sections[idx]];
    commit({ ...template, sections });
  };

  /* Reorder a field within its section without dragging. "back"/"forward"
   * (rather than up/down) because the 12-column grid flows inline: the
   * neighbour may sit beside the field, not above it. */
  const moveField = (sectionId: string, fieldId: string, dir: "back" | "forward") => {
    commit({
      ...template,
      sections: template.sections.map((s) => {
        if (s.id !== sectionId) return s;
        const idx = s.fields.findIndex((f) => f.id === fieldId);
        const target = dir === "back" ? idx - 1 : idx + 1;
        if (idx < 0 || target < 0 || target >= s.fields.length) return s;
        const fields = [...s.fields];
        [fields[idx], fields[target]] = [fields[target], fields[idx]];
        return { ...s, fields };
      }),
    });
    setSelectedId(fieldId);
  };



  /* Column ops */
  const mutateColumns = (sectionId: string, fieldId: string, fn: (cols: TableColumn[]) => TableColumn[]) => {
    commit({
      ...template,
      sections: template.sections.map((s) => s.id !== sectionId ? s : {
        ...s,
        fields: s.fields.map((f) => f.id !== fieldId ? f : { ...f, columns: fn(f.columns ?? []) }),
      }),
    });
  };
  const addColumn = (sectionId: string, fieldId: string) =>
    mutateColumns(sectionId, fieldId, (cols) => [...cols, newColumn("text", `Column ${cols.length + 1}`)]);
  const removeColumn = (sectionId: string, fieldId: string, colId: string) =>
    mutateColumns(sectionId, fieldId, (cols) => cols.filter((c) => c.id !== colId));
  const moveColumn = (sectionId: string, fieldId: string, colId: string, dir: "left" | "right") =>
    mutateColumns(sectionId, fieldId, (cols) => {
      const idx = cols.findIndex((c) => c.id === colId);
      const target = dir === "left" ? idx - 1 : idx + 1;
      if (idx < 0 || target < 0 || target >= cols.length) return cols;
      const next = [...cols];
      [next[idx], next[target]] = [next[target], next[idx]];
      return next;
    });
  const updateColumn = (sectionId: string, fieldId: string, colId: string, patch: Partial<TableColumn>) => {
    const currentField = template.sections.find((s) => s.id === sectionId)?.fields.find((f) => f.id === fieldId);
    const current = currentField?.columns?.find((c) => c.id === colId);
    let next: Template = {
      ...template,
      sections: template.sections.map((s) => s.id !== sectionId ? s : {
        ...s,
        fields: s.fields.map((f) => f.id !== fieldId ? f : {
          ...f,
          columns: (f.columns ?? []).map((c) => c.id === colId ? { ...c, ...patch } : c),
        }),
      }),
    };
    if (current && patch.key && patch.key !== current.key) {
      next = renameKeyEverywhere(next, current.key, patch.key);
    }
    commit(next);
  };

  const fieldCount = useMemo(() => (template?.sections ?? []).reduce((a, s) => a + (s.fields?.length ?? 0), 0), [template]);

  const handleSave = () => {
    const allFields = template.sections.flatMap((s) => s.fields);
    const keys = allFields.map((f) => f.key);
    const dupes = keys.filter((k, i) => keys.indexOf(k) !== i);
    if (dupes.length > 0) {
      toast.error(`Duplicate field keys: ${[...new Set(dupes)].join(", ")}. Each field must have a unique key.`);
      return;
    }
    // Column IDs only need to be unique WITHIN their own table (a cross-table
    // aggregate like SUM(other_table.amount) disambiguates by table key, so
    // two different tables reusing "amount" is fine — see conditions.py's
    // compute_calculated_values / the qualified aggregate syntax).
    for (const f of allFields) {
      if (f.type !== "table") continue;
      const colKeys = (f.columns ?? []).map((c) => c.key);
      const colDupes = colKeys.filter((k, i) => colKeys.indexOf(k) !== i);
      if (colDupes.length > 0) {
        toast.error(`"${f.label}" has duplicate column IDs: ${[...new Set(colDupes)].join(", ")}. Each column in a table must have a unique ID.`);
        return;
      }
    }
    // Retirement is easy to half-configure (enable it, build out the
    // scenarios, then forget to actually pick the issued-amount field). That
    // doesn't fail the build server-side — it just silently treats issued as
    // 0, so every submission posts as a full overspend with a journal that
    // still balances. Warn, but don't block save: the admin may genuinely be
    // mid-configuration.
    for (const f of allFields) {
      if (f.type !== "table") continue;
      for (const c of f.columns ?? []) {
        if (c.sunsystems?.retirement?.enabled && !c.sunsystems.retirement.issuedAmountField) {
          toast.warning(`"${f.label}" → "${c.label}": Retirement is enabled but no issued/requested amount field is selected — issued will be treated as 0.`);
        }
      }
    }
    if (!template.document_type_id) {
      toast.error("Select a document type before saving this template.");
      setTab("settings");
      return;
    }
    onSave(outputTemplate(template, Boolean(initial?.id)), false);
  };

  /* AutoSave: debounce on commit when enabled (skip initial mount). */
  useEffect(() => {
    if (!autoSave) return;
    if (autoSaveSkipNext.current) {
      autoSaveSkipNext.current = false;
      return;
    }
    if (autoSaveTimer.current) clearTimeout(autoSaveTimer.current);
    autoSaveTimer.current = setTimeout(() => {
      if (!template.document_type_id) return; // silent skip until configured
      const keys = template.sections.flatMap((s) => s.fields).map((f) => f.key);
      if (keys.length !== new Set(keys).size) return;
      onSave(outputTemplate(template, Boolean(initial?.id)), true);
      setLastAutoSavedAt(Date.now());
    }, 1200);
    return () => { if (autoSaveTimer.current) clearTimeout(autoSaveTimer.current); };
  }, [template, autoSave]);

  /* Configure modal data */
  const configCol = useMemo(() => {
    if (!configuringColumn) return null;
    const sec = template.sections.find((s) => s.id === configuringColumn.sectionId);
    const fld = sec?.fields.find((f) => f.id === configuringColumn.fieldId);
    const col = fld?.columns?.find((c) => c.id === configuringColumn.colId);
    return col ? { ...configuringColumn, column: col, columns: fld?.columns ?? [] } : null;
  }, [configuringColumn, template]);

  return (
    <div
      className={cn(
        "fixed inset-0 z-50 flex h-screen w-full flex-col overflow-hidden transition-all duration-200",
        visible && !closing ? "opacity-100 translate-y-0" : "opacity-0 translate-y-3"
      )}
      style={{ background: "#EDEDED" }}
    >
      {/* Top bar */}
      <header className="flex h-14 shrink-0 items-center justify-between border-b border-[#1E6F99] bg-[#287EAD] px-5 text-white">
        <div className="flex items-center gap-3">
          <button onClick={handleCancel} className="p-1.5 text-white/75 hover:bg-white/10 hover:text-white">
            <ArrowLeft className="h-4 w-4" />
          </button>
          <div className="h-5 w-px bg-white/25" />
          <input value={template.name}
            onChange={(e) => commit({ ...template, name: e.target.value })}
            className="h-9 w-64 border border-transparent bg-transparent px-2 text-sm font-semibold text-white outline-none hover:border-white/25 focus:border-white/70 focus:bg-white/10" />
          <span className="border border-white/25 bg-white/10 px-2.5 py-0.5 text-[10px] font-semibold text-white/80">
            {template.sections.length} sections · {fieldCount} fields
          </span>
          <div className="ml-2 flex items-center gap-2 border border-white/25 bg-white/10 px-2 py-1">
            <span className="text-[11px] font-semibold uppercase tracking-wider text-white/80">AutoSave</span>
            <button
              onClick={() => setAutoSave((v) => !v)}
              role="switch"
              aria-checked={autoSave}
              title={autoSave ? "AutoSave is ON" : "AutoSave is OFF"}
              className={cn(
                "relative h-5 w-10 rounded-full border transition-colors",
                autoSave ? "bg-emerald-400 border-emerald-300" : "bg-white/20 border-white/40"
              )}
            >
              <span
                className={cn(
                  "absolute top-0.5 h-4 w-4 rounded-full bg-white transition-all shadow",
                  autoSave ? "left-[22px]" : "left-0.5"
                )}
              />
            </button>
            <span className="text-[10px] font-bold text-white/90 w-7 text-left">{autoSave ? "ON" : "OFF"}</span>
          </div>
          {autoSave && lastAutoSavedAt && (
            <span className="text-[10px] text-white/70">
              Saved {Math.max(1, Math.round((Date.now() - lastAutoSavedAt) / 1000))}s ago
            </span>
          )}
        </div>

        <div className="flex h-9 items-center gap-0.5 border border-white/25 bg-white/10 p-0.5">
          {([
            { id: "form", label: "Build", icon: LayoutGrid },
            { id: "preview", label: "Preview", icon: Eye },
            { id: "settings", label: "Settings", icon: Settings },
          ] as const).map((t) => {
            const Icon = t.icon;
            return (
              <button key={t.id} onClick={() => setTab(t.id)}
                className={cn(
                  "flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold transition-all",
                  tab === t.id ? "bg-white text-[#287EAD]" : "text-white/70 hover:bg-white/10 hover:text-white",
                )}>
                <Icon className="h-3.5 w-3.5" />{t.label}
              </button>
            );
          })}
        </div>

        <div className="flex items-center gap-2">
          <div className="flex items-center gap-1">
            <button disabled={!canUndo} onClick={() => setHist((s) => ({ ...s, cursor: Math.max(0, s.cursor - 1) }))} title="Undo"
              className="p-1.5 text-white/70 hover:bg-white/10 hover:text-white disabled:opacity-25">
              <Undo2 className="h-4 w-4" />
            </button>
            <button disabled={!canRedo} onClick={() => setHist((s) => ({ ...s, cursor: Math.min(s.stack.length - 1, s.cursor + 1) }))} title="Redo"
              className="p-1.5 text-white/70 hover:bg-white/10 hover:text-white disabled:opacity-25">
              <Redo2 className="h-4 w-4" />
            </button>
          </div>
          <div className="h-5 w-px bg-white/25" />
          <button onClick={handleSave} disabled={isSaving}
            className="inline-flex items-center gap-2 border border-white/30 bg-white px-4 py-2 text-sm font-semibold text-[#287EAD] hover:bg-[#EEF6FB] disabled:opacity-50">
            <Save className="h-4 w-4" />
            {isSaving ? "Saving…" : "Save template"}
          </button>
        </div>
      </header>

      {/* Body */}
      <DndContext sensors={sensors} onDragStart={onDragStart} onDragEnd={onDragEnd}>
        <div className="flex flex-1 overflow-hidden">
          {tab === "form" && (
            <div key="form" className="flex flex-1 overflow-hidden animate-in fade-in duration-150">
              <div className="w-[260px] shrink-0"><Palette /></div>
              <main className="relative flex-1 overflow-y-auto" style={{ background: "#EDEDED" }}>
                <Canvas
                  sections={template.sections}
                  selectedId={selectedId}
                  onSelect={(id) => { setSelectedId(id); if (id) setInspectorOpen(true); }}
                  onAddSection={addSection}
                  onUpdateSection={updateSection}
                  onRemoveSection={requestRemoveSection}
                  onRemoveField={requestRemoveField}

                  onDuplicateField={duplicateField}
                  onResizeField={(sid, fid, c) => updateField(sid, fid, { colSpan: c })}
                  onMoveSection={moveSection}
                  onMoveField={moveField}
                  onConfigureColumn={(sectionId, fieldId, colId) => setConfiguringColumn({ sectionId, fieldId, colId })}
                  onAddColumn={addColumn}
                  onRemoveColumn={(sectionId, fieldId, colId) => {
                    const col = template.sections.find((s) => s.id === sectionId)?.fields
                      .find((f) => f.id === fieldId)?.columns?.find((c) => c.id === colId);
                    setPendingDelete({
                      title: "Delete this column?",
                      message: (
                        <>
                          <strong>{col?.label || col?.key || "This column"}</strong> and any data captured in it
                          will be removed from the table. You can undo this afterwards.
                        </>
                      ),
                      onConfirm: () => removeColumn(sectionId, fieldId, colId),
                    });
                  }}

                  onMoveColumn={moveColumn}
                  onUpdateColumn={updateColumn}
                />
                {!inspectorOpen && (
                  <button onClick={() => setInspectorOpen(true)} title="Open inspector"
                    className="absolute right-4 top-4 flex items-center gap-1.5 border border-[#AEB5BB] bg-white px-3 py-2 text-xs font-semibold text-[#5E6870] shadow-md hover:border-[#287EAD] hover:bg-[#EEF6FB] hover:text-[#287EAD]">
                    <Settings className="h-3.5 w-3.5" /> Inspector
                  </button>
                )}
              </main>
              <div className={cn("shrink-0 overflow-hidden transition-all duration-200", inspectorOpen ? "w-[400px]" : "w-0")}>
                <Inspector
                  sections={template.sections}
                  selectedId={selectedId}
                  onUpdateField={updateField}
                  onUpdateSection={updateSection}
                  onCollapse={() => setInspectorOpen(false)}
                  processSteps={processSteps}
                />
              </div>
            </div>
          )}
          {tab === "preview" && (
            <main key="preview" className="flex-1 overflow-y-auto bg-slate-100 animate-in fade-in duration-150">
              <Preview sections={template.sections} templateName={template.name} processSteps={processSteps} />
            </main>
          )}
          {tab === "settings" && (
            <main key="settings" className="flex-1 overflow-y-auto bg-slate-100 animate-in fade-in duration-150">
              <SettingsTab template={template} documentTypes={documentTypes}
                processSteps={processSteps}
                onCommit={(patch) => commit({ ...template, ...patch })} />
            </main>
          )}
        </div>

        <DragOverlay dropAnimation={{
          sideEffects: defaultDropAnimationSideEffects({ styles: { active: { opacity: "0.4" } } }),
        }}>
          {dragType ? (
            <div className="flex items-center gap-2 border border-[#287EAD] bg-[#287EAD] px-3 py-2 text-sm font-semibold text-white shadow-xl">
              {(() => { const Icon = ICONS[dragType]; return <Icon className="h-4 w-4" />; })()}
              {FIELD_META[dragType].label}
            </div>
          ) : null}
        </DragOverlay>
      </DndContext>

      {/* Column configuration modal */}
      {configCol && (
        <ColumnConfigModal
          column={configCol.column}
          siblingColumns={configCol.columns}
          formFields={template.sections.flatMap((s) => s.fields).filter((f) => f.key && f.type !== "table")}
          processSteps={processSteps}
          onClose={() => setConfiguringColumn(null)}
          onSave={(updated) => {
            updateColumn(configCol.sectionId, configCol.fieldId, configCol.colId, updated);
            setConfiguringColumn(null);
          }}
          onDelete={() => {
            setPendingDelete({
              title: "Delete this column?",
              message: (
                <>
                  <strong>{configCol.column.label || configCol.column.key || "This column"}</strong> and any data
                  captured in it will be removed from the table. You can undo this afterwards.
                </>
              ),
              onConfirm: () => {
                removeColumn(configCol.sectionId, configCol.fieldId, configCol.colId);
                setConfiguringColumn(null);
              },
            });
          }}
        />
      )}

      <ConfirmDeleteDialog
        open={pendingDelete !== null}
        title={pendingDelete?.title ?? ""}
        message={pendingDelete?.message}
        onCancel={() => setPendingDelete(null)}
        onConfirm={() => { pendingDelete?.onConfirm(); setPendingDelete(null); }}
      />

    </div>
  );
}