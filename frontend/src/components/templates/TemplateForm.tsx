/**
 * TemplateForm — Finansys Unifi-style interactive renderer for a BUILT template.
 *
 * v2.0 — Full rewrite:
 *  - 12-column CSS grid with per-field colSpan (1–12) from builder
 *  - react-hook-form with full validation (required, regex, min/max, length)
 *  - Conditional visibility via visibleWhen rules
 *  - All field types: text, textarea, number, currency, date, datetime, time,
 *    email, phone, select, multi_select, radio, boolean, file, image, signature,
 *    reference, user, heading, divider, table, budget
 *  - Table columns fully typed (currency symbol, select options, boolean, etc.)
 *  - Same public API as v1 — callers (UploadPage, DocumentDetailPage) need zero changes
 */
import { useState, useEffect, useRef, useMemo } from "react";
import { createPortal } from "react-dom";
import { useForm, Controller } from "react-hook-form";
import { useQuery } from "@tanstack/react-query";
import { AlertCircle, Calculator, CheckCircle2, ChevronDown, Download, ExternalLink, Info, Loader2, Lock, Pencil, Paperclip, Plus, Search, Star, Trash2, X, Image as ImageIcon, FileText, FileImage, FileCode2, FileSpreadsheet, FileArchive, FileVideo, FileAudio, Upload, Building2, PenTool, User, CalendarClock } from "lucide-react";
import type { ReactNode } from "react";
import { documentsAPI } from "@/services/api";
import BudgetBanner from "./BudgetBanner";
import { toast } from "@/components/ui/vault-toast";
import CustomListbox from "@/components/ui/CustomListbox";
import {
  resolveSource,
  isReferenceValue,
  referenceLabel,
  type ReferenceValue,
} from "@/components/templates/referenceSources";
import { resolveFormula, evaluateFormula, formulaLabel } from "@/components/templates/formulas";
import { currencySymbolFor } from "@/lib/currencies";
import { useAuthStore } from "@/store/authStore";
import { Sparkles } from "lucide-react";
import { buildCalcScope, evaluateCalcExpression, evaluateTableColumnFormulas, resolveRowAggregates, formatCalcResult, type CalcValue } from "@/lib/calculations";
import {
  activeSections,
  addedSectionIds,
  materializeSections,
  withSectionAdded,
  withSectionRemoved,
  type AnyTableRef,
} from "@/lib/formBlocks";
import AccountMultiSelect from "@/components/ui/AccountMultiSelect";
import ExternalSelect from "@/components/ui/ExternalSelect";
import { ANALYSIS_PANEL_SLOTS, analysisDimensionName } from "@/lib/analysisDimensions";
import { matchOperator, isKnownOperator, isNegativeOperator } from "@/lib/ruleOperators";

// ── Types ─────────────────────────────────────────────────────────────────────

type ColType =
  | "text" | "textarea" | "number" | "currency" | "date" | "datetime" | "time"
  | "select" | "boolean" | "email" | "phone" | "reference" | "user" | "file"
  | "url" | "percentage" | "multi_select" | "image" | "external";

type Column = {
  id?: string; key?: string; label?: string; required?: boolean;
  type?: ColType | string; options?: string[]; currencySymbol?: string;
  currencyFromColumn?: string;
  /* Number/currency display config (builder: "Number / Currency" column). */
  decimals?: number; thousandsSeparator?: boolean;
  min?: number; max?: number;
  tooltip?: string; additionalText?: string; readonly?: boolean; hidden?: boolean;
  defaultValue?: string; referenceSource?: string;
  visibleWhen?: VisibleWhen | null;
  editableWhen?: VisibleWhen | null;
  calc?: { expression?: string };
  external?: { source?: string; dimension?: string; mode?: "panel" | "single"; multi?: boolean; slots?: string[]; fillColumn?: string; fillField?: string } | null;
};

type ConditionOperator = "equals" | "not_equals" | "is_empty" | "is_not_empty" | string;

type VisibilityCondition = {
  source?: "field" | "process_step" | "user_group";
  fieldKey?: string;
  operator: ConditionOperator;
  value?: string;
  /** For source "user_group": the RBAC groups the condition tests. The client
   * only has group names, so name matching is used (mirrors the builder). */
  groups?: SectionGroupRef[];
};

// A rule group (AND/OR + conditions), or a legacy single-rule shape (fieldKey at
// top level) still found in older saved templates / document snapshots.
type VisibleWhen =
  | { combinator?: "and" | "or"; conditions?: VisibilityCondition[]; groups?: VisibleWhen[] }
  | { fieldKey: string; operator: ConditionOperator; value?: string };

/* A "button" field's behaviour. Buttons hold no value; they either reveal an
 * on-demand SECTION via "add_block", or evaluate a formula once and write the
 * result into "targetKey" via "calculate". Mirrors the builder's ButtonConfig. */
export interface ButtonConfig {
  action: "add_block" | "calculate";
  variant?: "primary" | "secondary" | "outline";
  /* add_block */
  targetSectionId?: string;
  placement?: "end_of_form" | "below_button" | "after_section";
  anchorSectionId?: string;
  /* calculate */
  targetKey?: string;
  calc?: { expression?: string; decimals?: number } | null;
}

type Field = {
  id?: string; key?: string; type?: string; label?: string;
  placeholder?: string; help_text?: string; helpText?: string;
  required?: boolean; colSpan?: number; width?: number;
  options?: string[]; columns?: Column[]; minRows?: number;
  currencySymbol?: string; currencyFromField?: string; referenceSource?: string; tooltip?: string; regex?: string;
  min?: number; max?: number; minLength?: number; maxLength?: number;
  /* Number/currency display config — a "number" field with `currency` type (or
   * a linked currency dropdown) is money; both share decimals/grouping. */
  decimals?: number; thousandsSeparator?: boolean;
  defaultValue?: string; readonly?: boolean; hidden?: boolean;
  formula?: string;
  multi?: boolean;
  // Calculated value (see calc_number/calc_currency/calc_text/calc_date types)
  // — auto-derived from a formula over sibling field keys, same grammar as a
  // table column's `calc`. Recomputed live below (client preview) and
  // authoritatively by the server at submit time.
  calc?: { expression?: string; decimals?: number } | null;
  visibleWhen?: VisibleWhen | null;
  editableWhen?: VisibleWhen | null;
  /* Button behaviour (type === "button"). Mirrors the builder's ButtonConfig. */
  button?: ButtonConfig | null;
  /* Table reference (type === "reference" && referenceSource === "table"). */
  tableRef?: AnyTableRef | null;
  /* External (SunSystems-backed) lookup — mirrors the builder's ExternalConfig. */
  external?: { source?: string; dimension?: string; mode?: "panel" | "single"; multi?: boolean; slots?: string[]; fillColumn?: string; fillField?: string } | null;
  sunsystems?: {
    budgetAmountField?: string;
    monitoredAmountField?: string;
    account?: string;
    [k: string]: unknown;
  } | null;
};

// Field types whose value is derived from `field.calc.expression` rather than
// typed by the person filling the form. Mirrors the builder's CALCULATED_TYPES.
const CALCULATED_FIELD_TYPES = new Set(["calc_number", "calc_currency", "calc_text", "calc_date", "calc_boolean"]);

/* Presentation-only field types — they never hold a value, are never required
 * and never appear in the submitted payload. Mirrors the builder's
 * PRESENTATION_TYPES. */
const PRESENTATION_TYPES = new Set(["heading", "divider", "info", "spacer", "budget", "button"]);

/* Filled by the server on create (reference number), never typed. */
const SERVER_FILLED_TYPES = new Set(["auto_number"]);

/* ── Numeric display ────────────────────────────────────────────────────────
 * A Number field and a Currency field are the same input; the only difference
 * is the symbol and the default precision. `decimals` fixes precision,
 * `thousandsSeparator` groups by 3 (matches the builder inspector). */
function numberConfig(cfg: { type?: string; decimals?: number; thousandsSeparator?: boolean }) {
  const asCurrency = cfg.type === "currency";
  return {
    asCurrency,
    decimals: typeof cfg.decimals === "number" ? cfg.decimals : (asCurrency ? 2 : 0),
    grouping: cfg.thousandsSeparator !== false,
  };
}

function stepForDecimals(decimals: number): string {
  return decimals > 0 ? `0.${"0".repeat(decimals - 1)}1` : "1";
}

function formatNumeric(raw: unknown, decimals: number, grouping: boolean): string {
  const n = typeof raw === "number" ? raw : parseFloat(String(raw ?? ""));
  if (!Number.isFinite(n)) return "";
  return n.toLocaleString(undefined, {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
    useGrouping: grouping,
  });
}

function numberPlaceholder(placeholder: string | undefined, decimals: number): string {
  if (placeholder) return placeholder;
  return decimals > 0 ? `0.${"0".repeat(decimals)}` : "0";
}

/** Make a pasted/typed link openable ("example.com" -> "https://example.com"). */
function normalizeUrl(v: string): string {
  const t = v.trim();
  if (!t) return "";
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(t) ? t : `https://${t}`;
}

/** Read-only Yes/No switch, used for calculated boolean results. */
function ReadonlyToggle({ on }: { on: boolean }) {
  return (
    <span className="inline-flex items-center gap-2">
      <span
        aria-hidden
        className={`relative inline-flex h-5 w-9 flex-shrink-0 items-center rounded-full transition-colors ${on ? "bg-emerald-500" : "bg-muted-foreground/30"}`}
      >
        <span className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${on ? "translate-x-4" : "translate-x-0.5"}`} />
      </span>
      <span className="text-sm font-semibold text-foreground">{on ? "Yes" : "No"}</span>
    </span>
  );
}

/** Coerce a stored calculated boolean ("false"/"0"/"" are all No). */
function truthyValue(v: unknown): boolean {
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0;
  const s = String(v ?? "").trim().toLowerCase();
  return s !== "" && s !== "false" && s !== "0" && s !== "no";
}

type SectionGroupRef = { id?: string; name?: string };

type Section = {
  id?: string; title?: string; description?: string; fields?: Field[];
  hidden?: boolean; visibleWhen?: VisibleWhen | null;
  visibleToGroups?: SectionGroupRef[];
  readonly?: boolean; editableWhen?: VisibleWhen | null;
  /* "Add on demand": absent from the form until a Button (action "add_block")
   * adds it. `removable` lets the person take it back out again. Mirrors the
   * builder's TemplateSection. */
  onDemand?: boolean; removable?: boolean;
};

/** The person filling/viewing the form, used to evaluate role-restricted
 * sections. The auth payload carries group *names* + admin flags. */
export type FormViewer = { groupNames?: string[]; groupIds?: string[]; isAdmin?: boolean; canEditConditionalSections?: boolean };

/** A section restricted to RBAC groups is visible only to members of those
 * groups (matched by name — the client only has names) and to admins. An empty
 * / absent list means everyone. When the viewer is unknown we don't hide — the
 * server stays authoritative. */
function sectionVisibleToViewer(section: Section, viewer?: FormViewer): boolean {
  const groups = section.visibleToGroups ?? [];
  if (groups.length === 0) return true;
  if (!viewer) return true;
  if (viewer.isAdmin) return true;
  const names = new Set(viewer.groupNames ?? []);
  return groups.some((g) => Boolean(g.name) && names.has(g.name as string));
}

export type TemplateFormValues = Record<string, unknown>;

type AttachmentValue = {
  type?: string;
  field_key?: string;
  name?: string;
  size?: number;
  content_type?: string;
  storage_path?: string;
};

function isAttachmentValue(value: unknown): value is AttachmentValue {
  return Boolean(value && typeof value === "object" && "storage_path" in value);
}

function formatFileSize(size?: number) {
  if (!size) return "";
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

// ── Reference / user picker ─────────────────────────────────────────────────────

/**
 * Searchable picker backed by a real backend source (users, groups, departments,
 * documents, document types). Stores `{ id, label, source }`. In read-only mode
 * it renders the stored label (documents link to the target).
 */
function ReferencePicker({ source, value, onChange, disabled, compact }: {
  source?: string;
  value: unknown;
  onChange: (v: ReferenceValue | undefined) => void;
  disabled?: boolean;
  compact?: boolean;
}) {
  const resolved = resolveSource(source);
  const selected = isReferenceValue(value) ? value : null;
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [debounced, setDebounced] = useState("");
  const [coords, setCoords] = useState<{ top: number; left: number; width: number } | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(search.trim()), 250);
    return () => clearTimeout(t);
  }, [search]);

  // Position the (portalled) dropdown under the trigger; reposition on
  // scroll/resize. The portal escapes the form section's `overflow-hidden`
  // (and the table's horizontal scroll) so results are never clipped.
  useEffect(() => {
    if (!open) return;
    const place = () => {
      const r = boxRef.current?.getBoundingClientRect();
      if (r) setCoords({ top: r.bottom + 4, left: r.left, width: r.width });
    };
    place();
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    return () => {
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
    };
  }, [open]);

  // Close on outside click (trigger and the portalled panel both count as inside).
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      const t = e.target as Node;
      if (boxRef.current?.contains(t) || panelRef.current?.contains(t)) return;
      setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  const { data: options = [], isFetching } = useQuery({
    queryKey: ["reference-source", resolved?.key, resolved?.serverSearch ? debounced : ""],
    queryFn: () => resolved!.fetch(debounced),
    enabled: open && Boolean(resolved),
    staleTime: 30_000,
  });

  // Client-side filter for sources without server search.
  const visibleOptions = resolved?.serverSearch
    ? options
    : options.filter((o) => o.label.toLowerCase().includes(debounced.toLowerCase()));

  // Read-only: show the stored label (documents become a link).
  if (disabled) {
    const label = referenceLabel(value);
    if (!label) return <span className="text-xs text-muted-foreground">—</span>;
    if (resolved?.key === "documents" && selected?.id) {
      return (
        <a href={`/documents/${selected.id}`} target="_blank" rel="noreferrer"
          className="inline-flex items-center gap-1 text-xs text-primary hover:underline">
          {label}<ExternalLink className="h-3 w-3" />
        </a>
      );
    }
    return <span className="text-sm text-foreground">{label}</span>;
  }

  // No known source — degrade to a plain text input so the form never breaks.
  if (!resolved) {
    return (
      <input
        type="text"
        value={referenceLabel(value)}
        disabled={disabled}
        className={compact ? "w-full bg-transparent py-0.5 text-sm outline-none" : "input"}
        onChange={(e) => onChange(e.target.value ? { id: "", label: e.target.value, source } : undefined)}
      />
    );
  }

  const triggerCls = compact
    ? "flex w-full items-center justify-between gap-1 bg-transparent py-0.5 text-sm outline-none text-foreground"
    : "input flex items-center justify-between gap-2";

  return (
    <div className="relative" ref={boxRef}>
      <button type="button" disabled={disabled} className={triggerCls}
        onClick={() => setOpen((o) => !o)}>
        <span className={selected ? "truncate text-foreground" : "truncate text-muted-foreground"}>
          {selected ? selected.label : `Select ${resolved.key.replace(/_/g, " ")}…`}
        </span>
        <span className="flex flex-shrink-0 items-center gap-1">
          {selected && (
            <X className="h-3.5 w-3.5 text-muted-foreground hover:text-red-500"
              onClick={(e) => { e.stopPropagation(); onChange(undefined); }} />
          )}
          <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
        </span>
      </button>

      {open && coords && createPortal(
        <div ref={panelRef}
          style={{ position: "fixed", top: coords.top, left: coords.left, width: Math.max(coords.width, 192) }}
          className="z-[100] rounded-md border border-border bg-card shadow-lg">
          <div className="flex items-center gap-1.5 border-b border-border px-2 py-1.5">
            <Search className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" />
            <input autoFocus value={search} onChange={(e) => setSearch(e.target.value)}
              placeholder="Search…"
              className="w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground" />
          </div>
          <div className="max-h-56 overflow-y-auto py-1">
            {isFetching && (
              <div className="flex items-center gap-2 px-3 py-2 text-xs text-muted-foreground">
                <Loader2 className="h-3 w-3 animate-spin" /> Loading…
              </div>
            )}
            {!isFetching && visibleOptions.length === 0 && (
              <div className="px-3 py-2 text-xs text-muted-foreground">No matches.</div>
            )}
            {visibleOptions.map((opt) => (
              <button key={opt.id} type="button"
                className="block w-full truncate px-3 py-1.5 text-left text-sm text-foreground hover:bg-muted/60"
                onClick={() => {
                  onChange({ id: opt.id, label: opt.label, source: resolved.key });
                  setOpen(false);
                  setSearch("");
                }}>
                {opt.label}
              </button>
            ))}
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}

// ── Conditional visibility ────────────────────────────────────────────────────

// Normalize a stored `visibleWhen` (legacy single rule or a group, with optional
// nested `groups`) into one shape. Mirrors _normalize_group in conditions.py.
type NormalizedRule = { combinator: "and" | "or"; conditions: VisibilityCondition[]; groups: NormalizedRule[] };

function normalizeRule(vw?: VisibleWhen | null): NormalizedRule | null {
  if (!vw || typeof vw !== "object") return null;
  const obj = vw as Record<string, unknown>;
  if (Array.isArray(obj.conditions)) {
    const nested = Array.isArray(obj.groups) ? (obj.groups as VisibleWhen[]) : [];
    return {
      combinator: obj.combinator === "or" ? "or" : "and",
      conditions: obj.conditions as VisibilityCondition[],
      groups: nested.map((g) => normalizeRule(g)).filter((g): g is NormalizedRule => g !== null),
    };
  }
  if (typeof obj.fieldKey === "string") {
    return {
      combinator: "and",
      conditions: [{ source: "field", fieldKey: obj.fieldKey as string, operator: obj.operator as ConditionOperator, value: obj.value as string | undefined }],
      groups: [],
    };
  }
  return null;
}

function ruleHasContent(g: NormalizedRule | null): boolean {
  return Boolean(g) && (g!.conditions.length > 0 || g!.groups.some(ruleHasContent));
}

/** Evaluate a rule group; nested groups combine with the group's own combinator.
 *  An empty/absent group is "no restriction" (true). */
function evalRule(
  vw: VisibleWhen | null | undefined,
  values: TemplateFormValues,
  allFields: Field[],
  processStep: string,
  rowScope?: Record<string, unknown> | null,
  viewer?: FormViewer,
): boolean {
  const walk = (g: NormalizedRule): boolean => {
    const nested = g.groups.filter(ruleHasContent);
    if (g.conditions.length === 0 && nested.length === 0) return true;
    const results = [
      ...g.conditions.map((c) => evalCondition(c, values, allFields, processStep, rowScope, viewer)),
      ...nested.map(walk),
    ];
    return g.combinator === "or" ? results.some(Boolean) : results.every(Boolean);
  };
  const g = normalizeRule(vw);
  return g ? walk(g) : true;
}

function evalCondition(c: VisibilityCondition, values: TemplateFormValues, allFields: Field[], processStep: string, rowScope?: Record<string, unknown> | null, viewer?: FormViewer): boolean {
  // RBAC group membership. The condition stores groups as [{id, name}]; the
  // client only has group names, so matching is by name (and id, if present).
  // No viewer context or an unknown operator never restricts.
  if (c.source === "user_group") {
    if (c.operator !== "in_list" && c.operator !== "not_in_list") return true;
    if (!viewer || viewer.isAdmin) return true;
    const wanted = c.groups ?? [];
    if (wanted.length === 0) return true;
    const mine = new Set([
      ...(viewer.groupNames ?? []).map((g) => g.trim().toLowerCase()),
      ...(viewer.groupIds ?? []).map((g) => String(g).trim().toLowerCase()),
    ]);
    const member = wanted.some((g) => {
      const id = g?.id != null ? String(g.id).trim().toLowerCase() : "";
      const name = (g?.name ?? "").trim().toLowerCase();
      return (id !== "" && mine.has(id)) || (name !== "" && mine.has(name));
    });
    return c.operator === "in_list" ? member : !member;
  }
  const stepMatches = (actual: string, expected: string) => {
    const a = (actual || "").trim().toLowerCase();
    const e = (expected || "").trim().toLowerCase();
    if (a === e) return true;
    const aliases: Record<string, string[]> = {
      approved: ["approved", "request_approved", "requisition_approved", "rfq_approved", "fully_approved"],
      pending_approval: ["pending_approval", "request_pending", "retirement_pending", "requisition_pending", "rfq_pending", "lpo_pending"],
      returned: ["returned", "retirement_returned", "requisition_returned", "rfq_returned", "lpo_returned"],
      rejected: ["rejected", "retirement_rejected", "requisition_rejected", "rfq_rejected", "lpo_rejected"],
    };
    return aliases[e]?.includes(a) ?? false;
  };
  if (c.source === "process_step") {
    const sv = processStep;
    switch (c.operator) {
      case "equals":       return stepMatches(sv, c.value ?? "");
      case "not_equals":   return !stepMatches(sv, c.value ?? "");
      case "is_empty":     return sv.trim() === "";
      case "is_not_empty": return sv.trim() !== "";
      default:             return isKnownOperator(c.operator) ? matchOperator(c.operator, sv, c.value) : true;
    }
  }

  // Candidate source values. A plain key resolves to one value; a dotted key
  // ("expense_items.amount") resolves to one value PER ROW of that table, and
  // a row-scoped evaluation (a rule on a table column, evaluated for one row)
  // resolves sibling column keys against that row first. Mirrors the
  // server-side evaluator in apps/templates_engine/conditions.py.
  const svs = conditionSourceValues(c.fieldKey ?? "", values, allFields, rowScope);
  if (svs === null) return true; // unknown source — never hide/lock on it

  if (!isKnownOperator(c.operator)) return true; // unknown operator — never hide/lock on it
  const match = (sv: string): boolean => matchOperator(c.operator, sv, c.value);

  if (svs.length === 0) {
    // No rows at all — treat as a single empty value.
    return match("");
  }
  // Positive operators match ANY row; negative operators must hold for EVERY row.
  return isNegativeOperator(c.operator) ? svs.every(match) : svs.some(match);
}

/** Resolve the value(s) a condition points at. `null` = unknown source. */
function conditionSourceValues(
  fieldKey: string,
  values: TemplateFormValues,
  allFields: Field[],
  rowScope?: Record<string, unknown> | null,
): string[] | null {
  const str = (v: unknown) => (v == null ? "" : String(v));
  if (!fieldKey) return null;
  // Sibling column inside the same row wins for row-scoped rules.
  if (rowScope && Object.prototype.hasOwnProperty.call(rowScope, fieldKey)) {
    return [str(rowScope[fieldKey])];
  }
  if (fieldKey.includes(".")) {
    const [tableKey, colKey] = fieldKey.split(".");
    const table = allFields.find((f) => f.key === tableKey && f.type === "table");
    if (!table) return null;
    const rows = Array.isArray(values[tableKey]) ? (values[tableKey] as Record<string, unknown>[]) : [];
    return rows.map((r) => str(r?.[colKey]));
  }
  const sib = allFields.find((f) => f.key === fieldKey);
  if (!sib) return null;
  return [str(values[sib.key ?? ""])];
}

/* Section ordering / on-demand + linked-table helpers live in
 * "@/lib/formBlocks" so the client and the Django engine share one contract. */

// Works for a field OR a section — both carry `hidden` + `visibleWhen`. An
// empty/absent rule group means no restriction (visible). `processStep` is the
// document's current workflow status ("draft" while a new form is being filled).
function evalVisible(
  item: { hidden?: boolean; visibleWhen?: VisibleWhen | null },
  values: TemplateFormValues,
  allFields: Field[],
  processStep = "draft",
  rowScope?: Record<string, unknown> | null,
  viewer?: FormViewer,
): boolean {
  if (item.hidden) return false;
  return evalRule(item.visibleWhen, values, allFields, processStep, rowScope, viewer);
}

// Editability mirror: a field/section is editable unless always read-only
// (`readonly`) or it has an `editableWhen` group that doesn't match at the
// current step/values. Absent group = editable (preserves prior behaviour).
export function evalEditable(
  item: { readonly?: boolean; editableWhen?: VisibleWhen | null },
  values: TemplateFormValues,
  allFields: Field[],
  processStep = "draft",
  rowScope?: Record<string, unknown> | null,
  viewer?: FormViewer,
): boolean {
  if (item.readonly) return false;
  return evalRule(item.editableWhen, values, allFields, processStep, rowScope, viewer);
}

function hasEditableRule(item: { editableWhen?: VisibleWhen | null }): boolean {
  return ruleHasContent(normalizeRule(item.editableWhen));
}

function conditionalEditBlockedForViewer(item: { editableWhen?: VisibleWhen | null }, viewer?: FormViewer): boolean {
  return Boolean(
    hasEditableRule(item)
    && viewer
    && viewer.canEditConditionalSections === false
    && !viewer.isAdmin
  );
}

function evalEditableForViewer(
  item: { readonly?: boolean; editableWhen?: VisibleWhen | null },
  values: TemplateFormValues,
  allFields: Field[],
  processStep: string,
  viewer?: FormViewer,
): boolean {
  if (conditionalEditBlockedForViewer(item, viewer)) {
    return false;
  }
  return evalEditable(item, values, allFields, processStep, null, viewer);
}

// ── Table column cell ─────────────────────────────────────────────────────────

function TableFileCell({ value, onChange, disabled, documentId, attachmentKey }: {
  value: unknown;
  onChange: (v: unknown) => void;
  disabled?: boolean;
  documentId?: string;
  attachmentKey?: string;
}) {
  const [downloading, setDownloading] = useState(false);
  const descriptor = isAttachmentValue(value) ? value : null;
  const file = value instanceof File ? value : null;

  const download = async () => {
    if (!documentId || !attachmentKey || !descriptor) return;
    setDownloading(true);
    try {
      const response = await documentsAPI.downloadFormAttachment(documentId, attachmentKey);
      const blob = new Blob([response.data], {
        type: descriptor.content_type || response.data?.type || "application/octet-stream",
      });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = descriptor.name || "attachment";
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
    } catch {
      toast.error("Could not download this attachment.");
    } finally {
      setDownloading(false);
    }
  };

  if (file) {
    return (
      <div className="flex items-center gap-1 text-xs text-foreground">
        <Paperclip className="h-3 w-3 flex-shrink-0 text-primary" />
        <span className="min-w-0 truncate" title={file.name}>{file.name}</span>
        {!disabled && (
          <button type="button" onClick={() => onChange(undefined)}
            className="flex-shrink-0 text-muted-foreground hover:text-red-500">
            <X className="h-3 w-3" />
          </button>
        )}
      </div>
    );
  }

  if (descriptor) {
    return (
      <div className="flex items-center gap-1.5 text-xs text-foreground">
        <Paperclip className="h-3 w-3 flex-shrink-0 text-primary" />
        <span className="min-w-0 truncate" title={descriptor.name}>{descriptor.name}</span>
        {documentId && attachmentKey && (
          <button type="button" onClick={download} disabled={downloading}
            className="flex-shrink-0 text-primary hover:text-primary/80 disabled:opacity-50">
            {downloading ? <Loader2 className="h-3 w-3 animate-spin" /> : <Download className="h-3 w-3" />}
          </button>
        )}
        {!disabled && (
          <label className="flex-shrink-0 cursor-pointer text-[10px] font-semibold text-primary hover:underline">
            Replace
            <input type="file" className="sr-only"
              onChange={(e) => onChange(e.target.files?.[0] ?? undefined)} />
          </label>
        )}
      </div>
    );
  }

  return (
    <input type="file" disabled={disabled} className="text-xs w-full"
      onChange={(e) => onChange(e.target.files?.[0] ?? undefined)} />
  );
}

function TableColInput({ col, value, onChange, onChangeCell, readOnly, documentId, attachmentKey, row }: {
  col: Column; value: unknown; onChange: (v: unknown) => void; readOnly?: boolean;
  onChangeCell?: (key: string, value: unknown) => void;
  documentId?: string; attachmentKey?: string; row?: Record<string, unknown>;
}) {
  const base = "w-full bg-transparent py-0.5 text-sm outline-none text-foreground placeholder:text-muted-foreground/50";
  if (col.hidden) return null;
  const type = (col.type ?? "text") as ColType;
  const dis = readOnly || col.readonly;

  // Calculated column — display computed result (read-only).
  // Show currency symbol when applicable; format numbers nicely.
  if (col.calc?.expression) {
    const sval = typeof value === "string" ? value : value == null ? "" : String(value);
    const num = parseFloat(sval);
    const isNumericType = type === "number" || type === "currency";
    const hasValue = isNumericType ? (sval !== "" && !Number.isNaN(num)) : sval !== "";

    let display: React.ReactNode;
    const numCfg = numberConfig(col);
    if (type === "currency") {
      const linkedVal = col.currencyFromColumn ? row?.[col.currencyFromColumn] : undefined;
      const symbol = currencySymbolFor(typeof linkedVal === "string" ? linkedVal : undefined)
        ?? col.currencySymbol ?? "KSh";
      display = hasValue
        ? <span className="flex items-center gap-0.5"><span className="text-[10px] text-muted-foreground">{symbol}</span>{formatNumeric(num, numCfg.decimals, numCfg.grouping)}</span>
        : <span className="italic text-muted-foreground">—</span>;
    } else if ((type === "number" || type === "percentage") && hasValue) {
      display = `${formatNumeric(num, numCfg.decimals, numCfg.grouping)}${type === "percentage" ? " %" : ""}`;
    } else {
      display = hasValue ? sval : <span className="italic text-muted-foreground">—</span>;
    }
    return (
      <div className="flex items-center justify-between gap-1 w-full py-0.5 text-sm text-foreground font-medium">
        {display}
        <span className="text-[9px] font-semibold text-emerald-600 bg-emerald-50 px-1 rounded flex-shrink-0" title="Formula column">ƒx</span>
      </div>
    );
  }

  if (type === "file" || type === "image") {
    return (
      <TableFileCell value={value} onChange={onChange} disabled={dis}
        documentId={documentId} attachmentKey={attachmentKey} />
    );
  }

  const sval = typeof value === "string" ? value : value == null ? "" : String(value);

  switch (type) {
    case "select":
      const selectOptions = [
        { value: "", label: "—" },
        ...(col.options ?? []).map((o) => ({ value: o, label: o })),
      ];
      return (
        <CustomListbox
          value={sval}
          onChange={onChange}
          options={selectOptions}
          className={base}
          buttonClassName="w-full"
          ariaLabel="Select option"
          disabled={dis}
        />
      );
    case "boolean":
      return <input type="checkbox" checked={sval === "true"} disabled={dis} onChange={(e) => onChange(e.target.checked ? "true" : "false")} className="h-4 w-4 accent-primary" />;
    case "textarea":
      return <textarea rows={1} value={sval} disabled={dis} onChange={(e) => onChange(e.target.value)} className={`${base} resize-none`} />;
    case "currency":
    case "number":
    case "percentage": {
      const cfg = numberConfig(col);
      const linkedVal = col.currencyFromColumn ? row?.[col.currencyFromColumn] : undefined;
      const symbol = type === "currency"
        ? (currencySymbolFor(typeof linkedVal === "string" ? linkedVal : undefined) ?? col.currencySymbol ?? "KSh")
        : null;
      // Locked cells show the formatted value rather than a dead number input.
      if (dis) {
        const shown = formatNumeric(sval, cfg.decimals, cfg.grouping);
        return (
          <span className="flex items-center gap-1 py-0.5 text-sm text-foreground">
            {symbol && shown && <span className="text-[10px] text-muted-foreground">{symbol}</span>}
            {shown || <span className="italic text-muted-foreground">—</span>}
            {type === "percentage" && shown ? "%" : ""}
          </span>
        );
      }
      return (
        <div className="flex items-center gap-1">
          {symbol && <span className="text-[10px] text-muted-foreground flex-shrink-0">{symbol}</span>}
          <input type="number" step={stepForDecimals(cfg.decimals)} value={sval}
            min={col.min ?? (type === "percentage" ? 0 : undefined)}
            max={col.max ?? (type === "percentage" ? 100 : undefined)}
            onChange={(e) => onChange(e.target.value)} className={base}
            placeholder={numberPlaceholder(undefined, cfg.decimals)} />
          {type === "percentage" && <span className="text-[10px] text-muted-foreground flex-shrink-0">%</span>}
        </div>
      );
    }
    case "url":
      return (
        <div className="flex items-center gap-1">
          <input type="url" value={sval} disabled={dis} onChange={(e) => onChange(e.target.value)}
            className={base} placeholder="https://…" />
          {sval.trim() && (
            <a href={normalizeUrl(sval)} target="_blank" rel="noreferrer"
              className="flex-shrink-0 text-muted-foreground hover:text-primary" title="Open link">
              <ExternalLink className="h-3 w-3" />
            </a>
          )}
        </div>
      );
    case "multi_select": {
      const selected = Array.isArray(value) ? (value as string[]) : sval ? sval.split(",").map((x) => x.trim()).filter(Boolean) : [];
      if (dis) return <span className="py-0.5 text-sm text-foreground">{selected.join(", ") || <span className="italic text-muted-foreground">—</span>}</span>;
      return (
        <select multiple value={selected} className={`${base} h-auto min-h-[52px]`}
          onChange={(e) => onChange(Array.from(e.target.selectedOptions).map((o) => o.value))}>
          {(col.options ?? []).map((o) => <option key={o} value={o}>{o}</option>)}
        </select>
      );
    }
    case "date":
      return <input type="date" value={sval} disabled={dis} onChange={(e) => onChange(e.target.value)} className={base} />;
    case "datetime":
      return <input type="datetime-local" value={sval} disabled={dis} onChange={(e) => onChange(e.target.value)} className={base} />;
    case "time":
      return <input type="time" value={sval} disabled={dis} onChange={(e) => onChange(e.target.value)} className={base} />;
    case "email":
      return <input type="email" value={sval} disabled={dis} onChange={(e) => onChange(e.target.value)} className={base} />;
    case "phone":
      return <input type="tel" value={sval} disabled={dis} onChange={(e) => onChange(e.target.value)} className={base} />;
    case "reference":
    case "user":
      return (
        <ReferencePicker
          source={col.referenceSource ?? (type === "user" ? "users" : "documents")}
          value={value}
          onChange={onChange}
          disabled={dis}
          compact
        />
      );
    case "external":
      return (
        <ExternalSelect
          source={col.external?.source ?? "items"}
          dimension={col.external?.dimension}
          value={sval}
          onChange={onChange}
          onSelectRecord={(rec) => {
            // Items: mirror the picked item's BaseItemUnit into a sibling cell.
            const unit = rec.data?.unit;
            if (col.external?.fillColumn && unit !== undefined) {
              onChangeCell?.(col.external.fillColumn, unit);
            }
          }}
          multi={false}
          compact
          disabled={dis}
          className="w-full"
        />
      );
    default:
      return <input type="text" value={sval} disabled={dis} onChange={(e) => onChange(e.target.value)} className={base} />;
  }
}

// ── Table field ───────────────────────────────────────────────────────────────

function TableField({ field, value, onChange, readOnly, tableKey, documentId, allValues, processStep, allFields, viewer }: {
  field: Field;
  value: Record<string, unknown>[];
  onChange: (rows: Record<string, unknown>[]) => void;
  readOnly?: boolean;
  tableKey: string;
  documentId?: string;
  allValues: TemplateFormValues;
  processStep?: string;
  allFields: Field[];
  viewer?: FormViewer;
}) {
  // ALL columns — used by the calc engine. Hidden helper columns must still
  // participate in formula evaluation even though they are not rendered.
  const allCols = field.columns ?? [];

  const step = processStep ?? "draft";

  // A column rule can reference a SIBLING COLUMN, so it is evaluated per row:
  // the row's own cells are merged over the form-level values first. A column
  // is dropped from the header only when it resolves hidden for every row
  // (nothing to show anywhere); otherwise it stays and individual cells that
  // fail the rule render as "—".
  const colVisibleInRow = (c: Column, row?: Record<string, unknown> | null) =>
    evalVisible({ hidden: c.hidden, visibleWhen: c.visibleWhen }, allValues, allFields, step, row ?? null, viewer);
  const colEditableInRow = (c: Column, row?: Record<string, unknown> | null) =>
    evalEditable({ readonly: c.readonly, editableWhen: c.editableWhen }, allValues, allFields, step, row ?? null, viewer);

  const emptyRow = (): Record<string, unknown> => {
    const r: Record<string, unknown> = {};
    allCols.forEach((c) => { if (c.defaultValue && c.key) r[c.key] = c.defaultValue; });
    return r;
  };

  const [rows, setRows] = useState<Record<string, unknown>[]>(() =>
    Array.isArray(value) && value.length > 0
      ? value
      : Array.from({ length: field.minRows ?? 1 }, emptyRow)
  );
  // Mirror of `rows` for synchronous multi-cell edits (e.g. picking an item
  // writes both the item cell and the auto-filled UOM cell in one event; the
  // second write must build on the first, before React re-renders).
  const rowsRef = useRef<Record<string, unknown>[]>(rows);
  useEffect(() => { rowsRef.current = rows; }, [rows]);

  // ── Sync rows from parent prop ─────────────────────────────────────────────
  // The parent passes the saved/live table rows via `value`. Because useState
  // initialises only once, we need an effect to pick up prop changes that happen
  // AFTER mount: e.g. the document query settling with saved data, or the page
  // toggling from edit mode (formValues) back to read-only mode (formData.values).
  // We compare serialised JSON to avoid re-setting on every parent re-render.
  const lastValueRef = useRef<string>("");
  const hydratedRef = useRef(Array.isArray(value) && value.length > 0);
  const lastDocRef = useRef(documentId);
  useEffect(() => {
    if (documentId !== lastDocRef.current) {
      // Different document instance (e.g. navigated between documents without
      // a full remount) — always resync to the new one's data.
      lastDocRef.current = documentId;
      hydratedRef.current = Array.isArray(value) && value.length > 0;
      setRows(Array.isArray(value) && value.length > 0 ? value : Array.from({ length: field.minRows ?? 1 }, emptyRow));
      return;
    }
    if (!hydratedRef.current && Array.isArray(value) && value.length > 0) {
      hydratedRef.current = true;
      setRows(value);
      return;
    }
    // Normal sync for edit mode toggling
    if (!Array.isArray(value) || value.length === 0) return;
    const serialised = JSON.stringify(value);
    if (serialised === lastValueRef.current) return; // nothing actually changed
    lastValueRef.current = serialised;
    setRows(value);
  }, [value, documentId]);

  // ── Compute calculated column values for each row ──────────────────────────
  const colTypeByKey = useMemo(() => {
    const map: Record<string, string | undefined> = {};
    allCols.forEach((c) => { if (c.key) map[c.key] = c.type; });
    return map;
  }, [allCols]);

  // Resolve sibling table fields (by key) so cross-table aggregate formulas
  // like SUM(expense_items.amount) can look up another table's live rows,
  // not just this table's own columns.
  const crossTableTables = useMemo(() => {
    const map: Record<string, { rows: Record<string, unknown>[]; colTypeByKey: Record<string, string | undefined> }> = {};
    for (const f of allFields) {
      if (f.type !== "table" || !f.key) continue;
      const otherRows = Array.isArray(allValues[f.key]) ? (allValues[f.key] as Record<string, unknown>[]) : [];
      const typeByKey: Record<string, string | undefined> = {};
      (f.columns ?? []).forEach((c) => { if (c.key) typeByKey[c.key] = c.type; });
      map[f.key] = { rows: otherRows, colTypeByKey: typeByKey };
    }
    return map;
  }, [allFields, allValues]);

  const computedRows = useMemo(() => {
    return evaluateTableColumnFormulas(allCols, rows, allFields, allValues, crossTableTables);
  }, [rows, allCols, allFields, allValues, crossTableTables]);

  // Rendered columns: visible in at least one row (or, with no rows yet,
  // visible against the form-level values alone).
  const cols = useMemo(() => allCols.filter((c) => {
    if (c.hidden) return false;
    if (!c.visibleWhen) return true;
    if (computedRows.length === 0) return colVisibleInRow(c, null);
    return computedRows.some((row) => colVisibleInRow(c, row));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [allCols, computedRows, allValues, allFields, step]);

  // ── Persist computed column values to parent ───────────────────────────────
  // When any calc column updates, push the merged (raw + computed) rows to the
  // parent so the values are included in the submission payload. Guard against
  // loops: only fire when computedRows actually differs from what we last sent.
  // Skip persistence in read-only mode (viewing saved document) since the server
  // already computed and saved these values.
  const lastComputedRef = useRef<string>("");
  useEffect(() => {
    const hasCalcCols = allCols.some((c) => c.calc?.expression && c.key);
    if (!hasCalcCols) return;
    if (readOnly) return; // Don't persist computed values when viewing a saved document
    const serialised = JSON.stringify(computedRows);
    if (serialised === lastComputedRef.current) return;
    lastComputedRef.current = serialised;
    // Update the last-seen value ref too so the VALUE sync effect above won't
    // re-set rows when the parent echoes our own payload back as a new prop.
    lastValueRef.current = serialised;
    onChange(computedRows as Record<string, unknown>[]);
  }, [computedRows, allCols, onChange, readOnly]);

  // ── Row mutation helpers ───────────────────────────────────────────────────
  const update = (ri: number, key: string, val: unknown) => {
    const next = rowsRef.current.map((r, i) => i === ri ? { ...r, [key]: val } : r);
    rowsRef.current = next;
    setRows(next);
    // computedRows effect will fire and call onChange with the merged result.
    // For non-calc tables (no calc columns), call onChange directly now.
    const hasCalcCols = allCols.some((c) => c.calc?.expression && c.key);
    if (!hasCalcCols) onChange(next);
  };
  const addRow = () => {
    const next = [...rows, emptyRow()];
    setRows(next);
    const hasCalcCols = allCols.some((c) => c.calc?.expression && c.key);
    if (!hasCalcCols) onChange(next);
  };
  const removeRow = (i: number) => {
    const next = rows.filter((_, idx) => idx !== i);
    setRows(next);
    const hasCalcCols = allCols.some((c) => c.calc?.expression && c.key);
    if (!hasCalcCols) onChange(next);
  };

  return (
    <div className="col-span-12 space-y-3">
      <div className="text-xs font-semibold text-foreground">
        {field.label}
        {field.required && <span className="ml-1 text-red-500">*</span>}
        {(field.helpText ?? field.help_text) && (
          <span className="ml-2 font-normal text-muted-foreground">{field.helpText ?? field.help_text}</span>
        )}
      </div>
      <div className="overflow-x-auto border border-border bg-white shadow-sm">
        <div className="min-w-full">
          <table className="w-full text-sm border-separate border-spacing-0">
            <thead>
              <tr className="text-[11px] uppercase tracking-wide text-muted-foreground">
                {cols.map((col, i) => {
                  // Alternating column tint: even → faint blue-grey, odd → white.
                  const colBg = i % 2 === 0 ? "bg-[#F4F7FA]" : "bg-white";
                  return (
                    <th key={col.id ?? i} title={col.tooltip}
                        className={`w-[230px] flex-shrink-0 px-5 py-4 text-left font-semibold border-b border-r border-border/60 last:border-r-0 whitespace-nowrap ${colBg}`}>
                      <div className="flex items-center gap-1">
                        {col.label}{col.required && <span className="text-red-400 ml-0.5">*</span>}
                        {col.calc?.expression && (
                          <span className="text-[9px] font-semibold text-emerald-600 bg-emerald-50 px-1 rounded" title="Formula column">ƒx</span>
                        )}
                        {(col.readonly || col.editableWhen) && !col.calc?.expression && (
                          <Lock className="h-3 w-3 text-muted-foreground/70" aria-label="Locked in some rows" />
                        )}
                      </div>
                      {col.additionalText && <div className="mt-1 text-[10px] font-normal text-muted-foreground/80">{col.additionalText}</div>}
                    </th>
                  );
                })}
                {!readOnly && <th className="w-8 flex-shrink-0 px-4 py-4 border-b border-border/60 bg-white" />}
              </tr>
            </thead>
            <tbody>
              {computedRows.map((row, ri) => {
                const isEvenRow = ri % 2 === 0;
                return (
                  <tr key={ri} className="border-b border-border/40 last:border-0 group/row">
                    {cols.map((col, ci) => {
                      const key = col.key ?? `col_${ci}`;
                      const shown = colVisibleInRow(col, row);
                      const cellLocked = readOnly || !colEditableInRow(col, row);
                      // 4-shade checkerboard: row parity × col parity
                      const isEvenCol = ci % 2 === 0;
                      const cellBg =
                        isEvenRow && isEvenCol  ? "bg-[#EBF1F7]" :   // darker blue-grey
                        isEvenRow && !isEvenCol ? "bg-[#F3F5F7]" :   // faint warm-grey
                        !isEvenRow && isEvenCol ? "bg-[#F4F7FA]" :   // base blue-grey
                                                  "bg-white";         // plain white
                      return (
                        <td key={col.id ?? ci}
                            className={`w-[230px] flex-shrink-0 px-5 py-4 align-top border-r border-border/25 last:border-r-0 ${cellBg} group-hover/row:brightness-[0.985] transition-[filter]`}>
                          {shown ? (
                            <TableColInput
                              col={col}
                              value={row[key] ?? ""}
                              row={row}
                              onChange={(v) => update(ri, key, v)}
                              onChangeCell={(cellKey, cellVal) => update(ri, cellKey, cellVal)}
                              readOnly={cellLocked}
                              documentId={documentId}
                              attachmentKey={`${tableKey}~${ri}~${key}`}
                            />
                          ) : (
                            <span className="block text-sm italic text-muted-foreground/70" title="Not applicable for this row">—</span>
                          )}
                        </td>
                      );
                    })}
                    {!readOnly && (
                      <td className={`w-8 flex-shrink-0 px-3 py-4 text-center align-top ${isEvenRow ? "bg-[#F3F5F7]" : "bg-white"} group-hover/row:brightness-[0.985] transition-[filter]`}>
                        {rows.length > 1 && (
                          <button type="button" onClick={() => removeRow(ri)} className="inline-flex items-center justify-center rounded text-muted-foreground hover:text-red-500 transition-colors">
                            <Trash2 className="h-4 w-4" />
                          </button>
                        )}
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>

          </table>
        </div>
      </div>
      {!readOnly && (
        <button type="button" onClick={addRow} className="flex items-center gap-1.5 text-xs font-semibold text-primary hover:text-primary/80 transition-colors">
          <Plus className="h-3.5 w-3.5" /> Add row
        </button>
      )}
    </div>
  );
}

// ── File / Image attach field ──────────────────────────────────────────────────

/** Returns a coloured Lucide icon matching a file extension or MIME type. */
function FileTypeIcon({ name, contentType, className = "h-5 w-5" }: { name?: string; contentType?: string; className?: string }) {
  const ext = (name?.split(".").pop() ?? "").toLowerCase();
  const mime = (contentType ?? "").toLowerCase();

  if (mime.startsWith("image/") || ["jpg", "jpeg", "png", "gif", "svg", "webp", "bmp"].includes(ext))
    return <FileImage className={className} style={{ color: "#0ea5e9" }} />;
  if (["pdf"].includes(ext) || mime === "application/pdf")
    return <FileText className={className} style={{ color: "#ef4444" }} />;
  if (["doc", "docx", "odt", "rtf"].includes(ext) || mime.includes("word") || mime.includes("opendocument.text"))
    return <FileText className={className} style={{ color: "#2563eb" }} />;
  if (["xls", "xlsx", "csv", "ods"].includes(ext) || mime.includes("spreadsheet") || mime.includes("excel"))
    return <FileSpreadsheet className={className} style={{ color: "#16a34a" }} />;
  if (["ppt", "pptx", "odp"].includes(ext) || mime.includes("presentation"))
    return <FileText className={className} style={{ color: "#ea580c" }} />;
  if (["zip", "rar", "7z", "tar", "gz"].includes(ext))
    return <FileArchive className={className} style={{ color: "#a16207" }} />;
  if (["mp4", "mov", "avi", "mkv", "webm"].includes(ext) || mime.startsWith("video/"))
    return <FileVideo className={className} style={{ color: "#7c3aed" }} />;
  if (["mp3", "wav", "ogg", "flac", "m4a"].includes(ext) || mime.startsWith("audio/"))
    return <FileAudio className={className} style={{ color: "#db2777" }} />;
  if (["js", "ts", "jsx", "tsx", "py", "java", "cpp", "c", "cs", "go", "rs", "php", "rb", "json", "xml", "html", "css"].includes(ext))
    return <FileCode2 className={className} style={{ color: "#0891b2" }} />;
  return <FileText className={className} style={{ color: "#64748b" }} />;
}

/** Compact thumbnail chip for a single attached file. */
function FileChip({ name, contentType, size, onRemove, onDownload, downloading, disabled }: {
  name: string; contentType?: string; size?: number;
  onRemove?: () => void; onDownload?: () => void;
  downloading?: boolean; disabled?: boolean;
}) {
  return (
    <div className="group relative inline-flex flex-col items-center gap-1" style={{ width: 72 }}>
      {/* Remove button */}
      {!disabled && onRemove && (
        <button
          type="button"
          onClick={onRemove}
          className="absolute -right-1.5 -top-1.5 z-10 flex h-4 w-4 items-center justify-center rounded-full border border-white bg-red-500 text-white opacity-0 shadow group-hover:opacity-100 transition-opacity"
          title="Remove"
        >
          <X className="h-2.5 w-2.5" />
        </button>
      )}
      {/* Icon box */}
      <button
        type="button"
        onClick={onDownload}
        disabled={!onDownload || downloading}
        className="flex h-[52px] w-[52px] flex-shrink-0 items-center justify-center border border-[#E3E7EA] bg-white shadow-sm hover:border-[#287EAD]/40 hover:bg-[#F0F7FC] transition-colors disabled:cursor-default disabled:hover:bg-white disabled:hover:border-[#E3E7EA]"
        title={onDownload ? "Download" : name}
      >
        {downloading
          ? <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          : <FileTypeIcon name={name} contentType={contentType} className="h-6 w-6" />}
      </button>
      {/* Filename */}
      <span className="max-w-[72px] truncate text-center text-[10px] leading-tight text-[#3D454D]" title={name}>
        {name}
      </span>
      {/* Size */}
      {size != null && (
        <span className="text-[9px] text-muted-foreground">{formatFileSize(size)}</span>
      )}
    </div>
  );
}

function FileAttachField({ label, fieldKey, imageOnly, disabled, value, documentId, onChangeCb }: {
  label: string;
  fieldKey: string;
  imageOnly?: boolean;
  disabled?: boolean;
  value?: unknown;
  documentId?: string;
  onChangeCb: (key: string, val: unknown) => void;
}) {
  // Derive staged file directly from the value prop so it survives tab
  // navigation / remounts. The parent stores the File object in its values
  // state after the user picks it; we read it back here instead of keeping a
  // redundant local copy that resets on every unmount.
  const stagedFile = value instanceof File ? value : null;
  const descriptor = isAttachmentValue(value) ? value : null;

  // Generate a preview data-URL whenever the staged image changes.
  const [filePreview, setFilePreview] = useState<string | null>(null);
  useEffect(() => {
    if (!stagedFile || !imageOnly) { setFilePreview(null); return; }
    let cancelled = false;
    const reader = new FileReader();
    reader.onload = (e) => { if (!cancelled) setFilePreview(e.target?.result as string); };
    reader.readAsDataURL(stagedFile);
    return () => { cancelled = true; };
  }, [stagedFile, imageOnly]);

  const [downloading, setDownloading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // Only update the parent — filePreview updates automatically via effect.
  const pick = (f: File | null) => {
    onChangeCb(fieldKey, f ?? undefined);
  };

  const downloadAttachment = async () => {
    if (!documentId || !descriptor) return;
    setDownloading(true);
    try {
      const response = await documentsAPI.downloadFormAttachment(documentId, fieldKey);
      const blob = new Blob([response.data], { type: descriptor.content_type || response.data?.type || "application/octet-stream" });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = descriptor.name || label || "attachment";
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
    } catch {
      toast.error("Could not download this attachment.");
    } finally {
      setDownloading(false);
    }
  };

  // ── Saved image attachment ────────────────────────────────────────────────
  if (!stagedFile && descriptor && descriptor.content_type?.startsWith("image/")) {
    return (
      <div className="space-y-2">
        <div className="overflow-hidden border border-border bg-slate-50">
          <img
            src={`/api/attachments/${descriptor.storage_path}`}
            alt={descriptor.name || label}
            className="h-40 w-full object-contain"
          />
        </div>
        {documentId && (
          <div className="flex items-center gap-2">
            <button type="button" onClick={downloadAttachment} disabled={downloading}
              className="inline-flex items-center gap-1.5 border border-[#C8CDD2] bg-white px-2.5 py-1 text-[11px] font-semibold text-[#1F2933] hover:bg-[#F5F7F8] disabled:opacity-50">
              {downloading ? <Loader2 className="h-3 w-3 animate-spin" /> : <Download className="h-3 w-3" />}
              Download
            </button>
          </div>
        )}
      </div>
    );
  }

  // ── Newly staged image (with preview) ────────────────────────────────────
  if (stagedFile && filePreview) {
    return (
      <div className="space-y-2">
        <div className="overflow-hidden border border-border bg-slate-50">
          <img src={filePreview} alt={stagedFile.name} className="h-40 w-full object-contain" />
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs text-[#5E6870] truncate min-w-0">{stagedFile.name}</span>
          {!disabled && (
            <button type="button" onClick={() => pick(null)}
              className="flex-shrink-0 text-xs font-semibold text-red-500 hover:text-red-700">
              Remove
            </button>
          )}
        </div>
      </div>
    );
  }

  // ── Saved non-image OR staged non-image — compact chip ────────────────────
  const hasChip = stagedFile || descriptor;
  if (hasChip) {
    const chipName = stagedFile ? stagedFile.name : (descriptor?.name || label);
    const chipMime = stagedFile ? stagedFile.type : descriptor?.content_type;
    const chipSize = stagedFile ? stagedFile.size : descriptor?.size;
    return (
      <div className="flex flex-wrap items-start gap-3">
        <FileChip
          name={chipName}
          contentType={chipMime}
          size={chipSize}
          onDownload={descriptor && documentId ? downloadAttachment : undefined}
          downloading={downloading}
          disabled={disabled}
          onRemove={!disabled ? () => pick(null) : undefined}
        />
      </div>
    );
  }

  // ── Empty state — compact upload button ───────────────────────────────────
  return (
    <label
      className={`inline-flex cursor-pointer items-center gap-2 border border-dashed border-[#AEB5BB] bg-[#F9FAFB] px-3 py-2 text-xs font-semibold text-[#5E6870] transition-colors hover:border-[#287EAD] hover:bg-[#EEF6FB] hover:text-[#287EAD] ${
        disabled ? "pointer-events-none opacity-50" : ""
      }`}
    >
      {imageOnly ? (
        <ImageIcon className="h-4 w-4 flex-shrink-0" />
      ) : (
        <Upload className="h-4 w-4 flex-shrink-0" />
      )}
      {imageOnly ? "Upload image" : "Attach file"}
      <input
        ref={inputRef}
        type="file"
        accept={imageOnly ? "image/*" : undefined}
        disabled={disabled}
        className="sr-only"
        onChange={(e) => pick(e.target.files?.[0] ?? null)}
      />
    </label>
  );
}

// ── Signature pad field ────────────────────────────────────────────────────────

function SignatureField({ fieldKey, disabled, value, onChangeCb, onLaunchSignatureModal, allValues }: {
  fieldKey: string;
  disabled?: boolean;
  value?: unknown;
  onChangeCb: (key: string, val: unknown) => void;
  onLaunchSignatureModal?: (fieldKey?: string) => void;
  allValues?: TemplateFormValues;
}) {
  const hasSignature = typeof value === "string" && value.startsWith("data:image");
  
  // Look for associated date and name fields
  const dateValue = allValues?.[`${fieldKey}_date`] as string | undefined;
  const nameValue = allValues?.[`${fieldKey}_name`] as string | undefined;
  
  // Check for styling metadata
  const signatureStyle = allValues?.[`${fieldKey}_style`] as { color?: string; fontSize?: string; fontFamily?: string } | undefined;
  
  const inlineStyle = {
    color: signatureStyle?.color || '#1F2933',
    fontSize: signatureStyle?.fontSize || '16px',
    fontFamily: signatureStyle?.fontFamily || 'inherit',
    fontWeight: '600' as const,
  };

  return (
    <div className="min-w-0 space-y-3">
      {/* Signature button */}
      <button
        type="button"
        onClick={() => onLaunchSignatureModal?.(fieldKey)}
        disabled={disabled}
        className="w-full border border-dashed border-[#AEB5BB] bg-[#F9FAFB] px-4 py-5 text-center transition-colors hover:border-[#287EAD] hover:bg-[#EEF6FB] disabled:opacity-50 disabled:pointer-events-none"
      >
        {hasSignature ? (
          <div className="space-y-2">
            <img 
              src={value as string} 
              alt="Signature" 
              className="mx-auto max-h-44 w-auto max-w-full object-contain"
            />
            <p className="text-xs text-[#5E6870]">Click to change signature</p>
          </div>
        ) : (
          <div className="space-y-2">
            <PenTool className="mx-auto h-8 w-8 text-[#5E6870]" />
            <p className="text-sm font-medium text-[#1F2933]">Click to add signature</p>
            <p className="text-xs text-[#5E6870]">Use your saved signature or draw a new one</p>
          </div>
        )}
      </button>
      
      {/* Date field */}
      {dateValue && (
        <div className="flex items-center gap-2 text-sm" style={inlineStyle}>
          <CalendarClock className="h-4 w-4 text-[#5E6870]" />
          <span>{dateValue}</span>
        </div>
      )}
      
      {/* Name field */}
      {nameValue && (
        <div className="flex items-center gap-2 text-sm" style={inlineStyle}>
          <User className="h-4 w-4 text-[#5E6870]" />
          <span>{nameValue}</span>
        </div>
      )}
    </div>
  );
}

// ── Multiple attachments field ────────────────────────────────────────────────

/**
 * `multi_file` — several supporting attachments on one field. Each slot is an
 * independent attachment stored under `<key>~<index>` (the same "~" convention
 * the table cells use), so the existing per-key upload/download plumbing keeps
 * working unchanged.
 */
function MultiFileField({ fieldKey, label, disabled, allValues, documentId, onChangeCb }: {
  fieldKey: string;
  label: string;
  disabled?: boolean;
  allValues: TemplateFormValues;
  documentId?: string;
  onChangeCb: (key: string, val: unknown) => void;
}) {
  const existing = Object.keys(allValues)
    .filter((k) => k.startsWith(`${fieldKey}~`) && allValues[k] != null)
    .map((k) => Number(k.slice(fieldKey.length + 1)))
    .filter((n) => Number.isInteger(n) && n >= 0);
  const highest = existing.length ? Math.max(...existing) : -1;
  const [slots, setSlots] = useState<number[]>(() =>
    Array.from({ length: Math.max(highest + 2, 1) }, (_, i) => i)
  );

  return (
    <div className="space-y-2">
      {/* Inline chip row — all slots rendered horizontally */}
      <div className="flex flex-wrap items-start gap-3">
        {slots.map((i) => (
          <FileAttachField
            key={i}
            label={`${label} ${i + 1}`}
            fieldKey={`${fieldKey}~${i}`}
            disabled={disabled}
            value={allValues[`${fieldKey}~${i}`]}
            documentId={documentId}
            onChangeCb={(k, v) => {
              onChangeCb(k, v);
              // If a slot is cleared remove it (keep at least 1)
              if (v == null && slots.length > 1) {
                setSlots((prev) => prev.filter((n) => n !== i));
              }
            }}
          />
        ))}
        {/* Add-another button — shown inline after existing chips */}
        {!disabled && (
          <button
            type="button"
            onClick={() => setSlots((prev) => [...prev, (prev[prev.length - 1] ?? -1) + 1])}
            className="inline-flex items-center gap-1.5 self-center border border-dashed border-[#AEB5BB] bg-[#F9FAFB] px-3 py-2 text-xs font-semibold text-[#5E6870] hover:border-[#287EAD] hover:bg-[#EEF6FB] hover:text-[#287EAD] transition-colors"
          >
            <Plus className="h-3.5 w-3.5" /> Add file
          </button>
        )}
      </div>
    </div>
  );
}

// ── Single form field ─────────────────────────────────────────────────────────

const inp = "input";
const errCls = "mt-1 flex items-center gap-1 text-xs text-red-500";

function labelForAuto(label: string, field: Field) {
  return (
    <label style={{ marginBottom: "6px", display: "block", fontSize: "12px", fontWeight: "600", color: "#1F2933" }}>
      {label}
      {field.tooltip && <span style={{ marginLeft: "4px", cursor: "help", color: "#8C969E" }} title={field.tooltip}>(?)</span>}
    </label>
  );
}

function parseAmount(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : parseFloat(String(v).replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

/** Resolve a numeric source key: a top-level field, or a table column
 * ("table.col" or bare "col"), in which case it sums that column across rows. */
function resolveNumericSource(
  key: string | undefined,
  values: TemplateFormValues,
  allFields: Field[],
): number | null {
  if (!key) return null;
  if (allFields.some((f) => f.key === key && f.type !== "table")) return parseAmount(values[key]);

  const [maybeTable, maybeCol] = key.includes(".") ? key.split(".") : [undefined, undefined];
  const colKey = maybeCol ?? key;
  const table = allFields.find(
    (f) => f.type === "table" && f.key && (!maybeTable || f.key === maybeTable) &&
    (f.columns ?? []).some((c) => c.key === colKey),
  );
  if (!table?.key) return null;
  const rows = Array.isArray(values[table.key]) ? (values[table.key] as Record<string, unknown>[]) : [];
  return rows.reduce((sum, r) => sum + (parseAmount(r?.[colKey]) ?? 0), 0);
}

/** "Pick a row" linked table: choose one row from a table in THIS form,
 * labelled by ``tableRef.displayColumn``, and store the label text as a plain
 * string. Another form's rows need a permissions-aware endpoint that isn't
 * shipped yet, so that case renders as unavailable. */
function TableRowPicker({ field, value, disabled, onChange, allValues, allFields }: {
  field: Field;
  value: unknown;
  disabled?: boolean;
  onChange: (value: string) => void;
  allValues: TemplateFormValues;
  allFields: Field[];
}) {
  const ref = field.tableRef;
  const tableKey = ref?.tableKey ?? "";
  const displayColumn = ref?.displayColumn ?? "";
  const table = allFields.find((f) => f.key === tableKey && f.type === "table");
  const rows = Array.isArray(allValues[tableKey]) ? (allValues[tableKey] as Record<string, unknown>[]) : [];
  const labels = rows
    .map((row) => (row && typeof row === "object" ? String(row[displayColumn] ?? "").trim() : ""))
    .filter((label) => label !== "");
  if (ref?.scope !== "this_form" || !table || !displayColumn) {
    return (
      <select disabled className={inp} value="">
        <option value="">
          {ref?.scope === "other_form" ? "Unavailable for other forms" : "No source table"}
        </option>
      </select>
    );
  }
  return (
    <select value={String(value ?? "")} disabled={disabled} className={inp}
      onChange={(e) => onChange(e.target.value)}>
      <option value="">— select a row —</option>
      {labels.map((label, i) => <option key={`${label}-${i}`} value={label}>{label}</option>)}
    </select>
  );
}

/* The ten SunSystems analysis slots (Project, Cost Centre, …). Each slot holds
 * one analysis code; the value is stored as { "1": code, "2": code, … } so an
 * empty panel is `{}` (and therefore falsy to the required-field checks). */
function AnalysisPanelInput({ value, onChange, disabled, slots }: {
  value: unknown; onChange: (v: Record<string, string>) => void; disabled?: boolean; slots?: string[];
}) {
  const current = value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, string>)
    : {};
  const dimensionSlots = Array.isArray(slots) && slots.length === 10 ? slots : ANALYSIS_PANEL_SLOTS;
  return (
    <div className="grid gap-2 border border-border bg-card p-3 sm:grid-cols-2">
      {dimensionSlots.map((dimensionId, idx) => {
        const slot = String(idx + 1);
        const slotValue = current[slot] ?? "";
        return (
          <div key={slot} className="flex items-start gap-2">
            <span className="mt-4 w-4 shrink-0 text-right text-xs text-muted-foreground">{idx + 1}</span>
            <div className="min-w-0 flex-1">
              <div className="mb-1 break-words text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                {analysisDimensionName(dimensionId)}
              </div>
              <ExternalSelect
                source="analysis_codes"
                dimension={dimensionId}
                multi={false}
                compact
                disabled={disabled}
                value={slotValue}
                placeholder="Select code…"
                showSelectedName
                onChange={(v) => {
                  const next = { ...current };
                  const code = Array.isArray(v) ? (v[0] ?? "") : v;
                  if (code) next[slot] = code;
                  else delete next[slot];
                  onChange(next);
                }}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}

function FormField({ field, control, errors, onChangeCb, readOnly, allValues, editable = true, processStep, allFields, onLaunchSignatureModal, onButtonClick, buttonDone = false, viewer }: {
  field: Field;
  control: any;
  errors: Record<string, any>;
  onChangeCb: (key: string, val: unknown) => void;
  readOnly?: boolean;
  allValues: TemplateFormValues;
  // Effective editability at the current process step (section ∧ field). When
  // false the field is shown but locked (read-only) for this step.
  editable?: boolean;
  processStep?: string;
  allFields: Field[];
  onLaunchSignatureModal?: (fieldKey?: string) => void;
  onButtonClick?: (field: Field) => void;
  buttonDone?: boolean;
  viewer?: FormViewer;
}) {
  const key  = field.key ?? field.id ?? "";
  const type = field.type ?? "text";
  const label = field.label ?? key;
  const help  = field.helpText ?? field.help_text;
  const span  = Math.min(12, Math.max(1, field.colSpan ?? field.width ?? 6));
  const style = { gridColumn: `span ${span} / span ${span}` };
  const dis   = readOnly || field.readonly || !editable;
  const err   = errors[key]?.message as string | undefined;

  if (field.hidden) return null;

  // Action button — reveals an on-demand section or runs a one-shot calculation.
  if (type === "button") {
    // Buttons are an editing affordance only; a read-only document hides them.
    if (readOnly) return null;
    const variant = field.button?.variant ?? "primary";
    return (
      <div className="min-w-0" style={style}>
        <button type="button" disabled={dis || buttonDone} onClick={() => onButtonClick?.(field)}
          className={
            "inline-flex h-10 items-center gap-2 px-4 text-sm font-semibold transition disabled:cursor-not-allowed disabled:opacity-60 "
            + (variant === "primary" ? "bg-[#287EAD] text-white hover:bg-[#1E6F99]"
              : variant === "secondary" ? "bg-[#E5E8EB] text-[#1F2933] hover:bg-[#D5D9DC]"
                : "border border-[#287EAD] bg-white text-[#287EAD] hover:bg-[#EEF6FB]")
          }>
          {buttonDone ? <CheckCircle2 className="h-4 w-4" /> : field.button?.action === "calculate" ? <Calculator className="h-4 w-4" /> : <Plus className="h-4 w-4" />}
          {buttonDone ? `${label} — added` : (label || "Button")}
        </button>
      </div>
    );
  }

  // Layout-only elements
  if (type === "heading") return (
    <div className="min-w-0" style={{ gridColumn: "span 12 / span 12" }}>
      <h4 style={{ borderBottom: "1px solid #C8CDD2", paddingBottom: "6px", paddingTop: "8px", fontSize: "14px", fontWeight: "bold", color: "#1F2933" }}>{label}</h4>
    </div>
  );
  if (type === "divider") return <div className="min-w-0" style={{ gridColumn: "span 12 / span 12" }}><hr style={{ borderColor: "#E5E8EB" }} /></div>;
  if (type === "spacer") return <div className="min-w-0" style={{ gridColumn: `span ${span} / span ${span}` }}><div className="h-8" /></div>;

  // Read-only guidance note — never submitted.
  if (type === "info") return (
    <div className="min-w-0" style={{ gridColumn: "span 12 / span 12" }}>
      <div className="flex items-start gap-2 rounded-md border border-sky-200 bg-sky-50 px-3 py-2 text-xs text-sky-900">
        <Info className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" />
        <span>{field.defaultValue || help || label}</span>
      </div>
    </div>
  );

  // Table handled separately (needs full width + local state)
  if (type === "table") return (
    <TableField
      field={field}
      value={Array.isArray(allValues[key]) ? (allValues[key] as Record<string, unknown>[]) : []}
      onChange={(rows) => onChangeCb(key, rows)}
      readOnly={dis}
      tableKey={key}
      documentId={allValues.__document_id as string | undefined}
      allValues={allValues}
      processStep={processStep}
      allFields={allFields}
      viewer={viewer}
    />
  );

  // Auto-fill (formula) fields: read-only, value is computed (client preview /
  // server-authoritative). Rendered the same way whether filling or approving.
  if (resolveFormula(field.formula)) {
    const shown = referenceLabel(allValues[key]);
    return (
      <div className="min-w-0" style={style}>
        <label style={{ marginBottom: "6px", display: "block", fontSize: "12px", fontWeight: "600", color: "#1F2933" }}>
          {label}
          {field.required && <span style={{ marginLeft: "4px", color: "#D32F2F" }}>*</span>}
        </label>
        <div className={`${inp} flex items-center`} style={{ backgroundColor: "#F6F7F8", color: "#8C969E" }}>
          {shown || <span className="italic">Filled automatically on save</span>}
        </div>
      </div>
    );
  }

  // Calculated fields (calc_number/calc_currency/calc_text/calc_date): always
  // read-only — the value is derived from `field.calc.expression`, recomputed
  // live below (client preview, mirroring the builder's own Preview) and
  // authoritatively by the server (compute_calculated_values) at submit time.
  // Never registered with a Controller — there's nothing for the person to type.
  if (CALCULATED_FIELD_TYPES.has(type)) {
    const raw = allValues[key];
    const hasValue = raw !== undefined && raw !== null && raw !== "";
    const symbol = type === "calc_currency" ? (field.currencySymbol ?? "KSh") : null;
    if (type === "calc_boolean") {
      return (
        <div className="min-w-0" style={style}>
          <label style={{ marginBottom: "6px", display: "block", fontSize: "12px", fontWeight: "600", color: "#1F2933" }}>
            {label}
            {field.tooltip && <span style={{ marginLeft: "4px", cursor: "help", color: "#8C969E" }} title={field.tooltip}>(?)</span>}
          </label>
          <div className={`${inp} flex items-center`} style={{ backgroundColor: "#F6F7F8" }}>
            {hasValue || field.calc?.expression
              ? <ReadonlyToggle on={truthyValue(raw)} />
              : <span className="text-sm italic text-muted-foreground">No rule configured</span>}
          </div>
        </div>
      );
    }
    return (
      <div className="min-w-0" style={style}>
        <label style={{ marginBottom: "6px", display: "block", fontSize: "12px", fontWeight: "600", color: "#1F2933" }}>
          {label}
          {field.required && <span style={{ marginLeft: "4px", color: "#D32F2F" }}>*</span>}
          {field.tooltip && <span style={{ marginLeft: "4px", cursor: "help", color: "#8C969E" }} title={field.tooltip}>(?)</span>}
        </label>
        <div className={`${inp} flex items-center gap-1.5`} style={{ backgroundColor: "#F6F7F8", color: "#1F2933", fontWeight: 600 }}>
          {symbol && <span style={{ color: "#8C969E", fontWeight: 500 }}>{symbol}</span>}
          {hasValue ? (
            String(raw)
          ) : field.calc?.expression ? (
            <span className="italic" style={{ color: "#8C969E", fontWeight: 400 }}>Calculating…</span>
          ) : (
            <span className="italic" style={{ color: "#8C969E", fontWeight: 400 }}>No formula configured</span>
          )}
        </div>
      </div>
    );
  }

  // Reference number assigned by the server on create — read-only everywhere.
  if (type === "auto_number") {
    const shown = allValues[key];
    return (
      <div className="min-w-0" style={style}>
        {labelForAuto(label, field)}
        <div className={`${inp} flex items-center`} style={{ backgroundColor: "#F6F7F8", color: "#8C969E" }}>
          {shown ? String(shown) : <span className="italic">Assigned automatically on submit</span>}
        </div>
      </div>
    );
  }

  // Validation rules
  const rules: Record<string, any> = {};
  const isAnalysisPanel =
    (type === "external" && field.external?.source === "analysis_codes" && field.external?.mode !== "single") ||
    type === "analysis_panel";
  if (field.required && !readOnly && type !== "boolean" && type !== "checkbox" && !isAnalysisPanel)
    rules.required = `${label} is required`;
  if (isAnalysisPanel && field.required && !readOnly) {
    rules.validate = (v: unknown) => {
      const filled =
        v && typeof v === "object" && !Array.isArray(v) &&
        Object.values(v as Record<string, unknown>).some((x) => x);
      return filled || `${label} is required`;
    };
  }
  if (field.regex)
    rules.pattern = { value: new RegExp(field.regex), message: "Invalid format" };
  if (field.minLength !== undefined)
    rules.minLength = { value: field.minLength, message: `Minimum ${field.minLength} characters` };
  if (field.maxLength !== undefined)
    rules.maxLength = { value: field.maxLength, message: `Maximum ${field.maxLength} characters` };
  if (field.min !== undefined)
    rules.min = { value: field.min, message: `Minimum value: ${field.min}` };
  if (field.max !== undefined)
    rules.max = { value: field.max, message: `Maximum value: ${field.max}` };

  // Checkbox / boolean — inline label layout
  if (type === "boolean" || type === "checkbox") {
    return (
      <div className="min-w-0" style={style}>
        <Controller control={control} name={key} render={({ field: f }) => (
          <label className="flex cursor-pointer items-center gap-2.5 text-sm text-foreground">
            <input type="checkbox" checked={Boolean(f.value)} disabled={dis}
              className="h-4 w-4 rounded border-border accent-primary"
              onChange={(e) => { f.onChange(e.target.checked); onChangeCb(key, e.target.checked); }} />
            {label}
            {field.required && <span className="text-red-500">*</span>}
          </label>
        )} />
      </div>
    );
  }

  // Shared label element. A field that is visible but not editable at this
  // step gets an explicit lock chip — a greyed-out control alone doesn't tell
  // the person WHY they can't type in it.
  const lockedAtStep = !readOnly && !editable && !field.readonly;
  const labelEl = (
    <label style={{ marginBottom: "6px", display: "block", fontSize: "12px", fontWeight: "600", color: "#1F2933" }}>
      {label}
      {field.required && <span style={{ marginLeft: "4px", color: "#D32F2F" }}>*</span>}
      {field.tooltip && <span style={{ marginLeft: "4px", cursor: "help", color: "#8C969E" }} title={field.tooltip}>(?)</span>}
      {lockedAtStep && (
        <span className="ml-2 inline-flex items-center gap-1 rounded bg-muted px-1.5 py-0.5 text-[10px] font-semibold text-muted-foreground align-middle">
          <Lock className="h-2.5 w-2.5" /> Locked at this step
        </span>
      )}
      {help && <span style={{ marginLeft: "8px", fontWeight: "400", color: "#8C969E" }}>{help}</span>}
    </label>
  );

  // Static / non-interactive types
  if (type === "budget") {
    const ss = field.sunsystems ?? {};
    // Budget: chosen field/column → else the default value → else "not configured"
    const budget =
      resolveNumericSource(ss.budgetAmountField, allValues, allFields) ??
      parseAmount(field.defaultValue);
    const requested = resolveNumericSource(ss.monitoredAmountField, allValues, allFields) ?? 0;
    const budgetNum = budget ?? 0;
    const currency = field.currencySymbol || "KSh";
    const formattedBudget = `${currency} ${budgetNum.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;

    return (
      <div className="min-w-0" style={style}>
        {labelEl}
        <div className="flex items-start gap-3">
          <div className={`${inp} flex-1 bg-[#F6F7F8] text-[#8C969E]`}>
            {formattedBudget}
          </div>
          {budget && requested > budgetNum && (
            <BudgetBanner
              amount={requested}
              budget={budget}
              currency={currency}
              accountCode={ss.account as string | undefined}
            />
          )}
        </div>
      </div>
    );
  }

  if (type === "signature") {
    return (
      <div className="min-w-0" style={style}>
        {labelEl}
        <SignatureField
          fieldKey={key}
          disabled={dis}
          value={allValues[key]}
          onChangeCb={onChangeCb}
          onLaunchSignatureModal={onLaunchSignatureModal}
          allValues={allValues}
        />
      </div>
    );
  }
  if (type === "multi_file") {
    return (
      <div className="min-w-0" style={style}>
        {labelEl}
        <MultiFileField
          fieldKey={key}
          label={label}
          disabled={dis}
          allValues={allValues}
          documentId={(allValues.__document_id as string | undefined)}
          onChangeCb={onChangeCb}
        />
      </div>
    );
  }
  if (type === "file" || type === "image") {
    return (
      <div className="min-w-0" style={style}>
        {labelEl}
        <FileAttachField
          label={label}
          fieldKey={key}
          imageOnly={type === "image"}
          disabled={dis}
          value={allValues[key]}
          documentId={(allValues.__document_id as string | undefined)}
          onChangeCb={onChangeCb}
        />
      </div>
    );
  }

  // All other types via Controller
  let control_el: ReactNode;
  switch (type) {
    case "textarea":
      control_el = (
        <Controller control={control} name={key} rules={rules} render={({ field: f }) => (
          <textarea {...f} value={String(f.value ?? "")} disabled={dis} placeholder={field.placeholder}
            rows={4} className={`${inp} resize-y`}
            onChange={(e) => { f.onChange(e.target.value); onChangeCb(key, e.target.value); }} />
        )} />
      );
      break;

    case "select":
      const fieldSelectOptions = [
        { value: "", label: field.placeholder ?? "Select an option…" },
        ...(field.options ?? []).map((o) => ({ value: o, label: o })),
      ];
      control_el = (
        <Controller control={control} name={key} rules={rules} render={({ field: f }) => (
          <CustomListbox
            value={String(f.value ?? "")}
            onChange={(val) => { f.onChange(val); onChangeCb(key, val); }}
            options={fieldSelectOptions}
            className={inp}
            buttonClassName="w-full"
            ariaLabel={`Select ${field.label}`}
            disabled={dis}
          />
        )} />
      );
      break;

    case "multi_select":
      control_el = (
        <Controller control={control} name={key} rules={rules} render={({ field: f }) => (
          <select multiple value={Array.isArray(f.value) ? f.value as string[] : []} disabled={dis}
            className={`${inp} h-auto min-h-[80px] py-2`}
            onChange={(e) => {
              const sel = Array.from(e.target.selectedOptions).map((o) => o.value);
              f.onChange(sel); onChangeCb(key, sel);
            }}>
            {(field.options ?? []).map((o) => <option key={o} value={o}>{o}</option>)}
          </select>
        )} />
      );
      break;

    case "radio":
      control_el = (
        <Controller control={control} name={key} rules={rules} render={({ field: f }) => (
          <div className="flex flex-col gap-2 pt-1">
            {(field.options ?? []).map((o) => (
              <label key={o} className="flex cursor-pointer items-center gap-2.5 text-sm text-foreground">
                <input type="radio" value={o} checked={f.value === o} disabled={dis} className="h-4 w-4 accent-primary"
                  onChange={() => { f.onChange(o); onChangeCb(key, o); }} />
                {o}
              </label>
            ))}
          </div>
        )} />
      );
      break;

    // Number and Currency are one control: `decimals` + `thousandsSeparator`
    // drive the display, and a currency type (or a linked currency dropdown)
    // adds the symbol. Percentage is the same input with a "%" suffix.
    case "number":
    case "currency":
    case "percentage": {
      const cfg = numberConfig(field);
      const linkedVal = field.currencyFromField ? allValues[field.currencyFromField] : undefined;
      const currencySymbol = cfg.asCurrency
        ? (currencySymbolFor(typeof linkedVal === "string" ? linkedVal : undefined) ?? field.currencySymbol ?? "KSh")
        : null;
      const isPct = type === "percentage";
      control_el = (
        <Controller control={control} name={key} rules={rules} render={({ field: f }) => {
          const raw = String(f.value ?? "");
          // Locked/read-only: show the formatted figure, not a dead spinner.
          if (dis) {
            const shown = formatNumeric(raw, cfg.decimals, cfg.grouping);
            return (
              <div className={`${inp} flex items-center gap-1.5`} style={{ backgroundColor: "#F6F7F8", color: "#1F2933" }}>
                {currencySymbol && shown && <span className="text-muted-foreground">{currencySymbol}</span>}
                {shown ? `${shown}${isPct ? " %" : ""}` : <span className="italic text-muted-foreground">—</span>}
              </div>
            );
          }
          return (
            <div className="relative">
              {currencySymbol && (
                <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm font-medium text-muted-foreground">
                  {currencySymbol}
                </span>
              )}
              <input type="number" step={stepForDecimals(cfg.decimals)} value={raw}
                placeholder={numberPlaceholder(field.placeholder, cfg.decimals)}
                min={field.min ?? (isPct ? 0 : undefined)}
                max={field.max ?? (isPct ? 100 : undefined)}
                className={`${inp} ${currencySymbol ? "pl-14" : ""} ${isPct ? "pr-8" : ""}`}
                onChange={(e) => { f.onChange(e.target.value); onChangeCb(key, e.target.value); }} />
              {isPct && (
                <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">%</span>
              )}
            </div>
          );
        }} />
      );
      break;
    }

    case "url":
      control_el = (
        <Controller control={control} name={key} rules={rules} render={({ field: f }) => {
          const raw = String(f.value ?? "");
          return (
            <div className="relative">
              <input type="url" value={raw} disabled={dis}
                placeholder={field.placeholder ?? "https://…"} className={`${inp} pr-9`}
                onChange={(e) => { f.onChange(e.target.value); onChangeCb(key, e.target.value); }} />
              {raw.trim() && (
                <a href={normalizeUrl(raw)} target="_blank" rel="noreferrer" title="Open link"
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-primary">
                  <ExternalLink className="h-4 w-4" />
                </a>
              )}
            </div>
          );
        }} />
      );
      break;

    // Star rating — buttons, not a number box.
    case "rating": {
      const maxStars = Math.max(1, Math.min(10, field.max ?? 5));
      control_el = (
        <Controller control={control} name={key} rules={rules} render={({ field: f }) => {
          const current = Number(f.value ?? 0) || 0;
          const set = (v: number) => { f.onChange(v); onChangeCb(key, v); };
          return (
            <div className="flex items-center gap-1 pt-1">
              {Array.from({ length: maxStars }).map((_, i) => {
                const filled = i < current;
                return (
                  <button key={i} type="button" disabled={dis}
                    aria-label={`${i + 1} of ${maxStars}`}
                    aria-pressed={filled}
                    onClick={() => set(i + 1 === current ? 0 : i + 1)}
                    className={`rounded p-0.5 transition-transform ${dis ? "cursor-default" : "hover:scale-110"}`}>
                    <Star className={`h-5 w-5 ${filled ? "fill-amber-400 text-amber-400" : "text-muted-foreground/40"}`} />
                  </button>
                );
              })}
              <span className="ml-2 text-xs text-muted-foreground">
                {current ? `${current} / ${maxStars}` : "Not rated"}
              </span>
              {current > 0 && !dis && (
                <button type="button" onClick={() => set(0)}
                  className="ml-1 text-xs font-semibold text-muted-foreground hover:text-red-500">
                  Clear
                </button>
              )}
            </div>
          );
        }} />
      );
      break;
    }

    case "reference":
    case "user":
      if (type === "reference" && field.referenceSource === "table") {
        control_el = (
          <Controller control={control} name={key} rules={rules} render={({ field: f }) => (
            <TableRowPicker
              field={field}
              value={f.value}
              disabled={dis}
              allValues={allValues}
              allFields={allFields}
              onChange={(v) => { f.onChange(v); onChangeCb(key, v); }}
            />
          )} />
        );
        break;
      }
      control_el = (
        <Controller control={control} name={key} rules={rules} render={({ field: f }) => (
          <ReferencePicker
            source={field.referenceSource ?? (type === "user" ? "users" : "documents")}
            value={f.value}
            disabled={dis}
            onChange={(v) => { f.onChange(v); onChangeCb(key, v); }}
          />
        )} />
      );
      break;

    case "sunsystems_account":
      control_el = (
        <Controller control={control} name={key} rules={rules} render={({ field: f }) => (
          <AccountMultiSelect
            value={f.value}
            onChange={(v) => { f.onChange(v); onChangeCb(key, v); }}
            multi={field.multi ?? true}
          />
        )} />
      );
      break;

    case "external":
      // Analysis Codes is a composite: the ten ledger slots, not one lookup.
      // Other sources are a plain lookup (single or multi).
      control_el = isAnalysisPanel ? (
        <Controller control={control} name={key} rules={rules} render={({ field: f }) => (
          <AnalysisPanelInput
            value={f.value}
            disabled={dis}
            slots={field.external?.slots}
            onChange={(v) => { f.onChange(v); onChangeCb(key, v); }}
          />
        )} />
      ) : (
        <Controller control={control} name={key} rules={rules} render={({ field: f }) => (
          <ExternalSelect
            source={field.external?.source ?? "items"}
            dimension={field.external?.dimension}
            value={(f.value as string | string[]) ?? (field.external?.multi ? [] : "")}
            onChange={(v) => { f.onChange(v); onChangeCb(key, v); }}
            onSelectRecord={(rec) => {
              // Items: mirror the picked item's BaseItemUnit into a sibling field.
              const unit = rec.data?.unit;
              if (field.external?.fillField && unit !== undefined) {
                onChangeCb(field.external.fillField, unit);
              }
            }}
            multi={field.external?.multi ?? false}
            disabled={dis}
            showSelectedName={!(field.external?.multi ?? false)}
          />
        )} />
      );
      break;

    default: {
      // text, email, phone, date, datetime, time (and any unknown type, which
      // degrades to a plain text box rather than disappearing from the form).
      const htmlType =
        type === "email" ? "email"
        : type === "phone" ? "tel"
        : type === "date" ? "date"
        : type === "datetime" ? "datetime-local"
        : type === "time" ? "time"
        : "text";
      control_el = (
        <Controller control={control} name={key} rules={rules} render={({ field: f }) => (
          <input type={htmlType} value={String(f.value ?? "")} disabled={dis}
            placeholder={field.placeholder} min={field.min} max={field.max}
            maxLength={field.maxLength} className={inp}
            onChange={(e) => { f.onChange(e.target.value); onChangeCb(key, e.target.value); }} />
        )} />
      );
    }
  }

  return (
    <div className="min-w-0" style={style}>
      {labelEl}
      {control_el}
      {err && (
        <p className={errCls}><AlertCircle className="h-3 w-3 flex-shrink-0" />{err}</p>
      )}
    </div>
  );
}

// ── Main export ───────────────────────────────────────────────────────────────

function TemplateForm({ sections, values, onChange, readOnly = false, documentId, documentStatus, canEditConditionalSections, onLaunchSignatureModal }: {
  sections: unknown[];
  values: TemplateFormValues;
  onChange: (key: string, value: unknown) => void;
  readOnly?: boolean;
  documentId?: string;
  // The document's current workflow status, for "process step" visibility
  // conditions. Absent (a brand-new form) is treated as "draft".
  documentStatus?: string;
  canEditConditionalSections?: boolean;
  onLaunchSignatureModal?: (fieldKey?: string) => void;
}) {
  const rawSections = (Array.isArray(sections) ? sections : []) as Section[];
  // Materialise linked tables (embed -> table) and keep only the ACTIVE
  // sections: normal ones plus the on-demand ones in `__sections_added`. Every
  // downstream computation (allFields, calc, conditions, required) sees only
  // sections that are actually part of the form.
  const addedIds = addedSectionIds(values);
  const active = activeSections(materializeSections(rawSections), values);
  const allFields = active.flatMap((s) => s.fields ?? []);

  // Derive a stable key from the RAW section IDs so we can detect template
  // changes. Deriving it from the rendered list would reset the form whenever a
  // button adds/removes a block.
  const sectionsKey = rawSections.map((s) => s.id ?? "").join("|");
  const prevKeyRef = useRef(sectionsKey);

  const { control, formState: { errors }, reset, watch, setValue, getValues, unregister } = useForm<TemplateFormValues>({
    defaultValues: values,
    mode: "onBlur",
  });

  // When a different template is loaded (sections change), reset the form
  useEffect(() => {
    if (prevKeyRef.current !== sectionsKey) {
      prevKeyRef.current = sectionsKey;
      reset({});
    }
  }, [sectionsKey]);

  // Controllers read React Hook Form state, so mirror values set externally
  // (for example supplier prefill and template defaults) into that state.
  useEffect(() => {
    const current = getValues();
    for (const [key, value] of Object.entries(values)) {
      if (key.startsWith("__") || value instanceof File) continue;
      if (JSON.stringify(current[key]) !== JSON.stringify(value)) {
        setValue(key, value, { shouldDirty: false, shouldValidate: false });
      }
    }
  }, [values, sectionsKey]);

  const currentUser = useAuthStore((s) => s.user);

  // Auto-fill formula fields with a client preview while filling a NEW form.
  // The server finalizes authoritative values on create; an existing document
  // keeps its frozen values, so we skip when editing/viewing one (documentId set).
  useEffect(() => {
    if (readOnly || documentId) return;
    for (const f of allFields) {
      const k = f.key ?? f.id ?? "";
      if (!k || !resolveFormula(f.formula)) continue;
      const current = values[k];
      const isEmpty = current == null || (typeof current === "string" && current.trim() === "");
      if (!isEmpty) continue;
      const computed = evaluateFormula(f.formula, { user: currentUser, now: new Date() });
      if (computed) onChange(k, computed);
    }
  }, [sectionsKey, currentUser, readOnly, documentId]);

  // Recompute every top-level `calc`-bearing field (calc_number/calc_currency/
  // calc_text/calc_date) whenever any value changes — client preview only,
  // mirroring the builder's own Preview and the server's authoritative
  // compute_calculated_values. Resolves in template order so a later formula
  // can reference an earlier calculated field's result, including on an
  // existing document while it is being edited.
  useEffect(() => {
    if (readOnly) return;
    // Build table registry so top-level formulas can reference table columns
    const tableRegistry: Record<string, { rows: Record<string, unknown>[]; colTypeByKey: Record<string, string | undefined> }> = {};
    for (const f of allFields) {
      if (f.type !== "table" || !f.key) continue;
      const tableRows = Array.isArray(values[f.key]) ? (values[f.key] as Record<string, unknown>[]) : [];
      const typeByKey: Record<string, string | undefined> = {};
      (f.columns ?? []).forEach((c) => { if (c.key) typeByKey[c.key] = c.type; });
      tableRegistry[f.key] = { rows: tableRows, colTypeByKey: typeByKey };
    }
    const scope = buildCalcScope(allFields, values, tableRegistry);
    for (const f of allFields) {
      const k = f.key ?? f.id ?? "";
      if (!k || !f.calc?.expression) continue;
      const expr = resolveRowAggregates(f.calc.expression, [], {}, tableRegistry);
      let result = evaluateCalcExpression(expr, scope);
      if (typeof result === "number" && typeof f.calc.decimals === "number") {
        result = Number(result.toFixed(f.calc.decimals));
      }
      result = formatCalcResult(f.type, result);
      scope[k] = result; // let a later formula see this one's result
      if (String(values[k] ?? "") !== String(result)) onChange(k, result);
    }
  }, [sectionsKey, JSON.stringify(values), readOnly, documentId]);

  /* Button click: reveal the target on-demand section at the chosen spot, or
   * evaluate a formula once and write it into the target field. */
  const runButton = (btn: Field) => {
    const b = btn.button;
    if (!b) return;
    if (b.action === "add_block") {
      if (!b.targetSectionId || addedIds.includes(b.targetSectionId)) return;
      onChange("__sections_added", withSectionAdded(values, b.targetSectionId));
      return;
    }
    const target = allFields.find((f) => f.key === b.targetKey);
    if (!target || !b.calc?.expression) return;
    const tableRegistry: Record<string, { rows: Record<string, unknown>[]; colTypeByKey: Record<string, string | undefined> }> = {};
    for (const f of allFields) {
      if (f.type !== "table" || !f.key) continue;
      const rows = Array.isArray(values[f.key]) ? (values[f.key] as Record<string, unknown>[]) : [];
      const typeByKey: Record<string, string | undefined> = {};
      (f.columns ?? []).forEach((c) => { if (c.key) typeByKey[c.key] = c.type; });
      tableRegistry[f.key] = { rows, colTypeByKey: typeByKey };
    }
    const scope = buildCalcScope(allFields, values, tableRegistry);
    const expr = resolveRowAggregates(b.calc.expression, [], {}, tableRegistry);
    let result = evaluateCalcExpression(expr, scope);
    if (typeof result === "number" && typeof b.calc.decimals === "number") {
      result = Number(result.toFixed(b.calc.decimals));
    }
    result = formatCalcResult(target.type, result);
    const k = target.key ?? target.id ?? "";
    if (k) onChange(k, result);
  };

  const removeSpawned = (section: Section) => {
    if (section.id) onChange("__sections_added", withSectionRemoved(values, section.id));
    for (const f of section.fields ?? []) {
      const k = f.key ?? f.id ?? "";
      if (!k) continue;
      unregister(k);
      onChange(k, f.type === "table" ? [] : undefined);
    }
  };

  const ordered = active;

  // Keep a live snapshot of form values for conditional visibility
  const liveValues = { ...(watch() as TemplateFormValues), ...values, __document_id: documentId };

  // Viewer context for role-restricted sections.
  const viewer: FormViewer = {
    groupNames: currentUser?.group_names ?? [],
    isAdmin: Boolean(currentUser?.has_admin_access || currentUser?.is_staff),
    canEditConditionalSections,
  };

  // Current process step for "process step" visibility conditions.
  const processStep = documentStatus || "draft";

  if (rawSections.length === 0) {
    return <p className="text-sm text-muted-foreground">This form has no fields.</p>;
  }

  // Read-only mode: every editing control is individually `disabled`, so we must
  // NOT blanket the form in `pointer-events-none` — that would also block the
  // attachment download buttons (the approver needs to open attachments).
  return (
    <div className="space-y-6">
      {ordered.map((section, si) => {
        // Hidden / conditionally-hidden / role-restricted sections drop out
        // entirely. Whether the viewer is ALLOWED TO EDIT a conditionally-
        // editable section/field is a different axis — handled below via
        // `sectionEditable` / `evalEditableForViewer`, which locks the
        // controls to read-only. It must never also hide the section, or an
        // approver reviewing the document loses visibility into content
        // they're specifically there to review.
        if (!evalVisible(section, liveValues as TemplateFormValues, allFields, processStep, null, viewer)) return null;
        if (!sectionVisibleToViewer(section, viewer)) return null;
        const visibleFields = (section.fields ?? []).filter((f) =>
          evalVisible(f, liveValues as TemplateFormValues, allFields, processStep, null, viewer)
        );
        // Editability cascades: a read-only/locked section locks all its fields.
        const sectionEditable = evalEditableForViewer(section, liveValues as TemplateFormValues, allFields, processStep, viewer);
        const sectionLocked = !readOnly && !sectionEditable;
        return (
          <div key={section.id ?? si} className="overflow-hidden" style={{ border: "1px solid #C8CDD2", backgroundColor: "#FFFFFF" }}>
            {/* Section header */}
            <div style={{ borderBottom: "1px solid #C8CDD2", backgroundColor: "#EEF6FB", paddingLeft: "20px", paddingRight: "20px", paddingTop: "12px", paddingBottom: "12px" }}>
              <h3 className="flex items-center gap-2 font-bold" style={{ fontSize: "14px", color: "#1F2933" }}>
                {section.title ?? `Section ${si + 1}`}
                {sectionLocked && (
                  <span className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] font-semibold" style={{ backgroundColor: "#F0F2F4", color: "#5E6870" }}>
                    <Lock className="h-2.5 w-2.5" /> Read-only at this step
                  </span>
                )}
                {section.onDemand && section.removable && (
                  <button type="button" onClick={() => removeSpawned(section)}
                    className="ml-auto inline-flex items-center gap-1 text-xs font-semibold hover:text-red-600" style={{ color: "#5E6870" }}>
                    <Trash2 className="h-3.5 w-3.5" /> Remove
                  </button>
                )}
              </h3>
              {section.description && (
                <p className="mt-0.5 text-xs" style={{ color: "#8C969E" }}>{section.description}</p>
              )}
            </div>
            {/* Fields — 12-column grid */}
            <div className="p-5 grid grid-cols-12 gap-x-4 gap-y-5">
              {visibleFields.map((f, fi) => (
                <FormField
                  key={f.id ?? fi}
                  field={f}
                  control={control}
                  errors={errors as Record<string, any>}
                  onChangeCb={onChange}
                  readOnly={readOnly}
                  editable={sectionEditable && evalEditableForViewer(f, liveValues as TemplateFormValues, allFields, processStep, viewer)}
                  allValues={liveValues as TemplateFormValues}
                  processStep={processStep}
                  allFields={allFields}
                  onLaunchSignatureModal={onLaunchSignatureModal}
                  onButtonClick={runButton}
                  buttonDone={f.button?.action === "add_block" && addedIds.includes(f.button?.targetSectionId ?? "")}
                  viewer={viewer}
                />
              ))}
              {visibleFields.length === 0 && (
                <p className="col-span-12 text-sm" style={{ color: "#8C969E" }}>No fields in this section.</p>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

export { TemplateForm as default };

// ── Validation helper (unchanged signature) ───────────────────────────────────

/** Returns labels of required fields that are missing or fail basic validation. */
export function requiredFieldLabels(
  sections: unknown[],
  values: TemplateFormValues,
  viewer?: FormViewer,
  processStep = "draft",
): string[] {
  const rawList = (Array.isArray(sections) ? sections : []) as Section[];
  // Validate only the sections that are part of the form (normal + added
  // on-demand), mirroring the renderer and the server.
  const list = activeSections(materializeSections(rawList), values);
  const allFields = list.flatMap((s) => s.fields ?? []);
  const missing: string[] = [];
  for (const s of list) {
    // Don't require fields the user never sees because their section is hidden
    // (always-hidden, a conditional rule that isn't met, or a role restriction
    // the viewer isn't a member of).
    if (!evalVisible(s, values, allFields, processStep, null, viewer)) continue;
    if (!sectionVisibleToViewer(s, viewer)) continue;
    if (conditionalEditBlockedForViewer(s, viewer)) continue;
    // A read-only/locked section's fields can't be filled at this step.
    const sectionEditable = evalEditableForViewer(s, values, allFields, processStep, viewer);
    for (const f of s.fields ?? []) {
      const type = f.type ?? "text";
      // Layout-only elements and server/calculated values are never "missing".
      if (PRESENTATION_TYPES.has(type)) continue;
      if (SERVER_FILLED_TYPES.has(type)) continue;
      if (CALCULATED_FIELD_TYPES.has(type)) continue;
      // Formula fields auto-fill (and the server finalizes them); never block on them.
      if (resolveFormula(f.formula)) continue;
      // Don't require a field the user can't see (hidden / conditionally hidden).
      if (f.hidden || !evalVisible(f, values, allFields, processStep, null, viewer)) continue;
      if (conditionalEditBlockedForViewer(f, viewer)) continue;
      // Don't require a field the user can't edit at this step (read-only / locked).
      if (!sectionEditable || !evalEditableForViewer(f, values, allFields, processStep, viewer)) continue;
      const key = f.key ?? "";

      // Table fields: validate REQUIRED COLUMNS the same way a top-level field
      // is validated. A column can be individually hidden/conditionally shown
      // (`hidden`/`visibleWhen`) and read-only/conditionally editable
      // (`readonly`/`editableWhen`) — only a column the person can actually see
      // and edit is enforced, mirroring the field-level rule just above. A
      // required column with zero rows (nothing entered yet) counts as missing,
      // same as an empty scalar field.
      if (type === "table") {
        const rows = Array.isArray(values[key]) ? (values[key] as Record<string, unknown>[]) : [];
        for (const col of f.columns ?? []) {
          if (!col.required || !col.key || col.calc?.expression) continue;
          if (col.hidden) continue;
          const colKey = col.key;
          // Column rules are row-scoped (they may reference sibling columns),
          // so a value is only enforced in the rows where the column is
          // actually shown and editable.
          const missingInAnyRow =
            rows.length === 0
              ? evalVisible(col, values, allFields, processStep, null, viewer) && evalEditable(col, values, allFields, processStep, null, viewer)
              : rows.some((row) => {
                  if (!evalVisible(col, values, allFields, processStep, row, viewer)) return false;
                  if (!evalEditable(col, values, allFields, processStep, row, viewer)) return false;
                  const v = row?.[colKey];
                  return v === undefined || v === null || (typeof v === "string" && v.trim() === "");
                });
          if (missingInAnyRow) {
            missing.push(`${f.label ?? key} — ${col.label ?? colKey}`);
          }
        }
        continue; // tables have no scalar `required`/regex of their own
      }

      const v = values[key];
      if (f.required) {
        const empty =
          v === undefined || v === null ||
          (typeof v === "string" && v.trim() === "") ||
          (typeof v === "boolean" && !v) ||
          (Array.isArray(v) && v.length === 0) ||
          (((type === "external" && f.external?.source === "analysis_codes") || type === "analysis_panel") &&
            typeof v === "object" && !Array.isArray(v) &&
            !Object.values(v as Record<string, unknown>).some((x) => x));
        if (empty) { missing.push(f.label ?? key); continue; }
      }
      // Regex validation
      if (f.regex && typeof v === "string" && v) {
        try {
          if (!new RegExp(f.regex).test(v)) missing.push(`${f.label ?? key} (invalid format)`);
        } catch { /* bad regex — skip */ }
      }
    }
  }
  return missing;
}
