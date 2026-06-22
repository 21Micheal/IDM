/**
 * DocumentTemplateDesigner.tsx — Enterprise document template designer (v1)
 *
 * Companion to TemplateBuilderV2 (the FORM editor). Where TemplateBuilderV2
 * builds the *data-entry form* (sections + fields a user fills in), this file
 * builds the *printable document itself* — the WYSIWYG layout that replaces
 * uploading Word/Excel templates.
 *
 * Admins compose a paginated A4/Letter document out of content blocks
 * (headings, rich paragraphs, lists, key/value grids, bound data tables,
 * images/logos, signatures, dividers, spacers, page breaks, two-column rows)
 * and drop {{merge_field}} tokens anywhere. At generation time those tokens
 * are substituted with the document's metadata / form values.
 *
 * Design language is intentionally identical to TemplateBuilderV2:
 *  - UniFi palette (#287EAD primary), square-ish chrome, grouped/searchable
 *    palette, draggable blocks, history undo/redo, fixed-overlay shell,
 *    Design / Preview / Settings tabs, AutoSave toggle.
 *
 * Highly configurable:
 *  - Page: size (A4 / Letter / Legal), orientation, margins, default font
 *    family / size / line-height, text + heading + accent colours.
 *  - Header / footer bands (left / center / right slots, page numbers, rule).
 *  - Per-block styling: alignment, weight, italic, font size, colour, spacing.
 *  - Merge fields are pulled from `mergeFields` prop (defaults provided) and
 *    grouped; every text-bearing block has an "Insert field" menu.
 *  - Data tables can be STATIC (fixed rows) or BOUND to a repeating data
 *    source key (one row rendered per record at generation time).
 *
 * Output: `onSave(outputDocumentTemplate(...))` returns a normalized
 * DocumentTemplate whose `placeholders[]` is auto-derived by scanning every
 * block for {{tokens}}, so your backend/merge engine knows exactly which
 * values it must supply.
 *
 * Dependencies (already used by TemplateBuilderV2): react,
 * @dnd-kit/core, lucide-react, sonner, and `cn` from "@/lib/utils".
 */

import { useState, useCallback, useMemo, useRef, useEffect } from "react";
import {
  DndContext, PointerSensor, useSensor, useSensors,
  useDraggable, useDroppable, DragOverlay,
  defaultDropAnimationSideEffects,
  type DragEndEvent, type DragStartEvent,
} from "@dnd-kit/core";
import { toast } from "sonner";
import {
  ArrowLeft, Save, Undo2, Redo2, Eye, LayoutGrid, Settings, Printer,
  Plus, Trash2, GripVertical, Copy, Search, ChevronDown, ChevronUp,
  Heading, AlignLeft, AlignCenter, AlignRight, List, ListOrdered,
  Quote, Table2, Image as ImageIcon, Minus, SeparatorHorizontal,
  FileText, PenLine, Columns2, Bold, Italic, Underline, Tag, X,
  Braces, Rows3, ScrollText, Building2,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { FORMULAS, evaluateFormula } from "@/components/templates/formulas";
import { useAuthStore } from "@/store/authStore";

/* ============================================================
 * Types
 * ============================================================ */

export type BlockType =
  | "heading" | "paragraph" | "bulleted_list" | "numbered_list" | "quote"
  | "key_value" | "data_table" | "image" | "logo"
  | "divider" | "spacer" | "page_break" | "two_column" | "signature";

export type BlockGroup = "text" | "data" | "media" | "layout" | "signoff";

export type Align = "left" | "center" | "right" | "justify";

export interface DocTableColumn {
  id: string;
  key: string;
  label: string;
  align?: Align;
  width?: number;        // relative weight, default 1
}

export interface KeyValuePair {
  id: string;
  label: string;
  value: string;         // may contain {{tokens}}
}

export interface Signatory {
  id: string;
  role: string;          // e.g. "Prepared by"
  nameToken?: string;    // e.g. "{{author_name}}"
  dateToken?: string;    // e.g. "{{document_date}}"
}

/** A single content block on the page. Most fields are optional and only
 *  meaningful for specific block types — kept flat for easy persistence. */
export interface DocBlock {
  id: string;
  type: BlockType;

  /* shared text content (heading / paragraph / quote) — supports {{tokens}} */
  text?: string;

  /* shared styling */
  align?: Align;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  fontSize?: number;      // px
  color?: string;         // hex; falls back to theme text/heading colour
  marginTop?: number;     // px
  marginBottom?: number;  // px

  /* heading */
  level?: 1 | 2 | 3;

  /* lists */
  items?: string[];

  /* key/value grid */
  pairs?: KeyValuePair[];
  labelWidth?: number;    // px width of the label column

  /* data table */
  columns?: DocTableColumn[];
  rows?: string[][];      // static rows (each cell may hold {{tokens}})
  bound?: boolean;        // if true, render fillable/repeating rows (not static)
  sourceKey?: string;     // optional data key to bind to, e.g. "line_items"
  fillRows?: number;      // blank rows to render for the user to fill (when bound, no data)
  striped?: boolean;
  bordered?: boolean;

  /* image / logo */
  src?: string;
  alt?: string;
  width?: number;         // px (image)
  height?: number;        // px (image / spacer)

  /* two column */
  left?: string;          // tokens allowed
  right?: string;

  /* signature */
  signatories?: Signatory[];
}

export interface PageSettings {
  size: "A4" | "Letter" | "Legal";
  orientation: "portrait" | "landscape";
  margin: { top: number; right: number; bottom: number; left: number }; // mm
}

export interface ThemeSettings {
  fontFamily: string;
  headingFamily: string;
  baseFontSize: number;   // px
  lineHeight: number;
  textColor: string;
  headingColor: string;
  accentColor: string;
}

export interface BandSlot {
  left?: string;
  center?: string;
  right?: string;
}

export interface BandSettings {
  enabled: boolean;
  content: BandSlot;      // tokens allowed; {{page}} / {{pages}} supported in footer
  rule: boolean;          // show the divider rule
}

export interface DocumentTemplate {
  id?: string;
  name: string;
  description?: string;
  type: "built";
  kind: "document";       // distinguishes from form templates
  category?: string;
  tags?: string[];
  document_type_id?: string;
  page: PageSettings;
  theme: ThemeSettings;
  header: BandSettings;
  footer: BandSettings;
  blocks: DocBlock[];
  /** Document-reference fields: at create time the user picks a related document
   *  per entry; {{key}} resolves to its label and {{key__field}} pulls its data. */
  references?: Array<{ key: string; label: string }>;
  placeholders?: string[];
  created_at?: string;
  updated_at?: string;
}

export type EditableDocumentTemplate =
  Omit<DocumentTemplate, "type" | "kind"> & { type?: "built"; kind?: "document" };

/** A merge field that can be inserted into the document. */
export interface MergeField {
  key: string;
  label: string;
  group?: string;
  /** true => a repeating collection usable as a bound data-table source */
  repeating?: boolean;
}

/* ============================================================
 * Constants
 * ============================================================ */

const BLOCK_META: Record<BlockType, {
  label: string; group: BlockGroup; icon: React.ElementType; hint?: string;
}> = {
  heading:       { label: "Heading",        group: "text",   icon: Heading },
  paragraph:     { label: "Paragraph",      group: "text",   icon: AlignLeft },
  bulleted_list: { label: "Bulleted list",  group: "text",   icon: List },
  numbered_list: { label: "Numbered list",  group: "text",   icon: ListOrdered },
  quote:         { label: "Quote / note",   group: "text",   icon: Quote },
  key_value:     { label: "Field grid",     group: "data",   icon: Rows3,   hint: "Label / value pairs bound to fields" },
  data_table:    { label: "Data table",     group: "data",   icon: Table2,  hint: "Static or repeating per record" },
  image:         { label: "Image",          group: "media",  icon: ImageIcon },
  logo:          { label: "Logo",           group: "media",  icon: Building2 },
  two_column:    { label: "Two columns",    group: "layout", icon: Columns2 },
  divider:       { label: "Divider",        group: "layout", icon: SeparatorHorizontal },
  spacer:        { label: "Spacer",         group: "layout", icon: Minus },
  page_break:    { label: "Page break",     group: "layout", icon: ScrollText },
  signature:     { label: "Signature",      group: "signoff", icon: PenLine },
};

const BLOCK_GROUPS: Array<{ key: BlockGroup; label: string }> = [
  { key: "text",    label: "Text" },
  { key: "data",    label: "Data & Fields" },
  { key: "media",   label: "Media" },
  { key: "layout",  label: "Layout" },
  { key: "signoff", label: "Sign-off" },
];

/** mm dimensions per page size (portrait). */
const PAGE_DIMS: Record<PageSettings["size"], { w: number; h: number }> = {
  A4:     { w: 210, h: 297 },
  Letter: { w: 216, h: 279 },
  Legal:  { w: 216, h: 356 },
};

const FONT_OPTIONS = [
  { value: "'Inter', system-ui, sans-serif",            label: "Inter (sans)" },
  { value: "Arial, Helvetica, sans-serif",              label: "Arial" },
  { value: "'Times New Roman', Times, serif",           label: "Times New Roman" },
  { value: "Georgia, 'Times New Roman', serif",         label: "Georgia (serif)" },
  { value: "'Courier New', Courier, monospace",         label: "Courier (mono)" },
  { value: "Calibri, 'Segoe UI', sans-serif",           label: "Calibri" },
];

/**
 * Auto-fill merge fields — resolved server-side at create time (and STATIC in the
 * document thereafter). The formula entries share the exact vocabulary the form
 * builder uses (frontend/src/components/templates/formulas.ts ↔ backend
 * apps/documents/form_formulas.py); apps/templates_engine/tasks.py
 * `_designer_merge_values` resolves them. The host also appends the selected
 * document type's own metadata fields to this list.
 */
const DEFAULT_MERGE_FIELDS: MergeField[] = [
  ...Object.values(FORMULAS).map((f) => ({ key: f.key, label: f.label, group: "Auto-fill (formula)" })),
  { key: "document_title",   label: "Document title",      group: "Auto-fill (formula)" },
  { key: "company_name",     label: "Company name",        group: "Organisation" },
  { key: "company_address",  label: "Company address",     group: "Organisation" },
];

const uid = () => Math.random().toString(36).slice(2, 10);

function slugify(s: string) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 50);
}

/** Find every {{token}} inside a string. */
function tokensIn(s?: string): string[] {
  if (!s) return [];
  const out: string[] = [];
  const re = /\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) out.push(m[1]);
  return out;
}

/** Substitute {{tokens}} using a flat sample-data map (for preview). */
function substitute(s: string | undefined, data: Record<string, string>): string {
  if (!s) return "";
  return s.replace(/\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g, (_, key) =>
    data[key] ?? `\u00ab${key}\u00bb`,
  );
}

/** Render a string with [[user placeholders]] shown as highlighted fill-in
 *  markers \u2014 matching how the generated document highlights them for the user. */
function highlightPlaceholders(str: string): React.ReactNode {
  if (!str || !str.includes("[[")) return str;
  return str.split(/(\[\[[^\]]+\]\])/g).map((part, i) => {
    const m = /^\[\[([^\]]+)\]\]$/.exec(part);
    return m
      ? <mark key={i} className="rounded-sm bg-yellow-200 px-0.5 text-[#1F2933]">{m[1]}</mark>
      : part;
  });
}

/* ============================================================
 * Factories
 * ============================================================ */

function newColumn(label = "Column"): DocTableColumn {
  return { id: uid(), key: `${slugify(label)}_${uid().slice(0, 4)}`, label, align: "left", width: 1 };
}

function newBlock(type: BlockType): DocBlock {
  const base: DocBlock = { id: uid(), type, align: "left", marginTop: 0, marginBottom: 12 };
  switch (type) {
    case "heading":
      return { ...base, text: "Section heading", level: 2 };
    case "paragraph":
      return { ...base, text: "Write your paragraph here. Insert merge fields like {{document_title}} anywhere." };
    case "quote":
      return { ...base, text: "Important note or disclaimer." };
    case "bulleted_list":
      return { ...base, items: ["First point", "Second point", "Third point"] };
    case "numbered_list":
      return { ...base, items: ["First step", "Second step", "Third step"] };
    case "key_value":
      return {
        ...base, labelWidth: 160,
        pairs: [
          { id: uid(), label: "Document No.", value: "{{document_no}}" },
          { id: uid(), label: "Date",         value: "{{document_date}}" },
          { id: uid(), label: "Prepared by",  value: "{{author_name}}" },
        ],
      };
    case "data_table":
      return {
        ...base, bordered: true, striped: false, bound: false,
        columns: [newColumn("Item"), newColumn("Description"), newColumn("Amount")],
        rows: [["", "", ""], ["", "", ""]],
      };
    case "image":
      return { ...base, align: "center", src: "", alt: "Image", width: 320, height: 180 };
    case "logo":
      return { ...base, align: "left", src: "", alt: "Company logo", width: 160, height: 64 };
    case "two_column":
      return { ...base, left: "Left column text. {{company_name}}", right: "Right column text. {{document_date}}" };
    case "divider":
      return { ...base, marginBottom: 16 };
    case "spacer":
      return { ...base, height: 24, marginBottom: 0 };
    case "page_break":
      return { ...base, marginBottom: 0 };
    case "signature":
      return {
        ...base, marginTop: 24,
        signatories: [
          { id: uid(), role: "Prepared by", nameToken: "{{current_user}}", dateToken: "{{today}}" },
          { id: uid(), role: "Approved by", nameToken: "[[Approver name]]", dateToken: "[[Date]]" },
        ],
      };
    default:
      return base;
  }
}

const initialDocument: DocumentTemplate = {
  name: "Untitled Document Template",
  description: "",
  type: "built",
  kind: "document",
  category: "other",
  tags: [],
  page: { size: "A4", orientation: "portrait", margin: { top: 20, right: 18, bottom: 20, left: 18 } },
  theme: {
    fontFamily: "'Inter', system-ui, sans-serif",
    headingFamily: "'Inter', system-ui, sans-serif",
    baseFontSize: 13,
    lineHeight: 1.5,
    textColor: "#1F2933",
    headingColor: "#0F2A3A",
    accentColor: "#287EAD",
  },
  header: { enabled: true, rule: true, content: { left: "{{company_name}}", center: "", right: "{{document_no}}" } },
  footer: { enabled: true, rule: true, content: { left: "{{document_title}}", center: "", right: "Page {{page}} of {{pages}}" } },
  blocks: [
    { ...newBlock("logo") },
    { ...newBlock("heading"), text: "{{document_title}}", level: 1, align: "left" },
    { ...newBlock("key_value") },
    { ...newBlock("paragraph") },
    { ...newBlock("data_table") },
    { ...newBlock("signature") },
  ],
  references: [],
};

/* ============================================================
 * Normalize / output
 * ============================================================ */

function normalizeTemplate(t: EditableDocumentTemplate): DocumentTemplate {
  return {
    ...initialDocument,
    ...t,
    type: "built",
    kind: "document",
    page: { ...initialDocument.page, ...(t.page ?? {}), margin: { ...initialDocument.page.margin, ...(t.page?.margin ?? {}) } },
    theme: { ...initialDocument.theme, ...(t.theme ?? {}) },
    header: { ...initialDocument.header, ...(t.header ?? {}), content: { ...initialDocument.header.content, ...(t.header?.content ?? {}) } },
    footer: { ...initialDocument.footer, ...(t.footer ?? {}), content: { ...initialDocument.footer.content, ...(t.footer?.content ?? {}) } },
    blocks: Array.isArray(t.blocks) && t.blocks.length ? t.blocks : initialDocument.blocks,
    references: Array.isArray(t.references) ? t.references : [],
    tags: t.tags ?? [],
  };
}

/** Collect every distinct {{token}} used across the whole document. */
function collectPlaceholders(t: DocumentTemplate): string[] {
  const set = new Set<string>();
  const add = (s?: string) => tokensIn(s).forEach((k) => set.add(k));
  [t.header.content, t.footer.content].forEach((c) => { add(c.left); add(c.center); add(c.right); });
  for (const b of t.blocks) {
    add(b.text); add(b.left); add(b.right); add(b.alt);
    (b.items ?? []).forEach(add);
    (b.pairs ?? []).forEach((p) => { add(p.label); add(p.value); });
    (b.rows ?? []).forEach((r) => r.forEach(add));
    (b.signatories ?? []).forEach((s) => { add(s.nameToken); add(s.dateToken); });
    if (b.bound && b.sourceKey) set.add(b.sourceKey);
  }
  set.delete("page"); set.delete("pages");
  return [...set].sort();
}

function outputDocumentTemplate(t: DocumentTemplate, keepId: boolean): DocumentTemplate {
  const out: DocumentTemplate = { ...t, type: "built", kind: "document", placeholders: collectPlaceholders(t) };
  if (!keepId) {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { id, ...rest } = out;
    return rest as DocumentTemplate;
  }
  return out;
}

/* ============================================================
 * Shared styles
 * ============================================================ */

const inputCls =
  "h-9 w-full border border-[#AEB5BB] bg-white px-3 text-sm text-[#1F2933] " +
  "placeholder:text-[#8C969E] outline-none focus:border-[#287EAD] focus:ring-1 focus:ring-[#287EAD]";

const labelCls = "text-[11px] font-semibold uppercase tracking-wider text-[#5E6870]";

/* ============================================================
 * Merge field insert menu
 * ============================================================ */

function MergeFieldMenu({ fields, onPick, label = "Insert field", repeatingOnly = false, allowPlaceholder = true }: {
  fields: MergeField[];
  onPick: (token: string, field: MergeField) => void;
  label?: string;
  repeatingOnly?: boolean;
  /** Show the "Ask the user (fill-in)" control that inserts [[label]] placeholders. */
  allowPlaceholder?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [ph, setPh] = useState("");
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [open]);

  const pool = fields.filter((f) => (repeatingOnly ? f.repeating : true));
  const filtered = pool.filter((f) =>
    f.label.toLowerCase().includes(q.toLowerCase()) || f.key.toLowerCase().includes(q.toLowerCase()),
  );
  const groups = [...new Set(filtered.map((f) => f.group ?? "Fields"))];

  return (
    <div ref={ref} className="relative inline-block">
      <button type="button" onClick={() => setOpen((v) => !v)}
              className="inline-flex items-center gap-1 border border-[#287EAD]/40 bg-white px-2 py-1 text-[11px] font-semibold text-[#287EAD] hover:bg-[#EEF6FB]">
        <Braces className="h-3 w-3" /> {label}
      </button>
      {open && (
        <div className="absolute right-0 z-50 mt-1 w-72 border border-[#C8CDD2] bg-white shadow-xl">
          {allowPlaceholder && !repeatingOnly && (
            <div className="border-b border-[#C8CDD2] bg-[#FFFBEB] p-2">
              <p className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-[#92700A]">Ask the user (fill when editing)</p>
              <div className="flex items-center gap-1">
                <input value={ph} onChange={(e) => setPh(e.target.value)}
                       onKeyDown={(e) => { if (e.key === "Enter" && ph.trim()) { e.preventDefault(); onPick(`[[${ph.trim()}]]`, { key: ph.trim(), label: ph.trim() }); setOpen(false); setPh(""); } }}
                       placeholder="e.g. Amount, Due date"
                       className="h-8 w-full border border-[#E3C765] bg-white px-2 text-xs outline-none focus:border-[#C9A227]" />
                <button type="button" disabled={!ph.trim()}
                        onClick={() => { if (ph.trim()) { onPick(`[[${ph.trim()}]]`, { key: ph.trim(), label: ph.trim() }); setOpen(false); setPh(""); } }}
                        className="h-8 shrink-0 bg-[#C9A227] px-2 text-[11px] font-semibold text-white disabled:opacity-40">Add</button>
              </div>
            </div>
          )}
          <div className="border-b border-[#C8CDD2] p-2">
            <p className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-[#8C969E]">Auto-fill field (static on create)</p>
            <div className="relative">
              <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[#5E6870]" />
              <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search fields…"
                     className="h-8 w-full border border-[#AEB5BB] bg-white pl-7 pr-2 text-xs outline-none focus:border-[#287EAD]" />
            </div>
          </div>
          <div className="max-h-64 overflow-y-auto py-1">
            {groups.map((g) => (
              <div key={g}>
                <p className="px-3 py-1 text-[10px] font-semibold uppercase tracking-wider text-[#8C969E]">{g}</p>
                {filtered.filter((f) => (f.group ?? "Fields") === g).map((f) => (
                  <button key={f.key} type="button"
                          onClick={() => { onPick(`{{${f.key}}}`, f); setOpen(false); setQ(""); }}
                          className="flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left text-xs hover:bg-[#EEF6FB]">
                    <span className="text-[#1F2933]">{f.label}</span>
                    <span className="font-mono text-[10px] text-[#8C969E]">{f.key}</span>
                  </button>
                ))}
              </div>
            ))}
            {filtered.length === 0 && <p className="px-3 py-4 text-center text-xs text-[#8C969E]">No fields</p>}
          </div>
        </div>
      )}
    </div>
  );
}

/* ============================================================
 * Palette
 * ============================================================ */

function PaletteItem({ type }: { type: BlockType }) {
  const meta = BLOCK_META[type];
  const Icon = meta.icon;
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: `palette-${type}`,
    data: { source: "palette", blockType: type },
  });
  return (
    <button ref={setNodeRef} {...listeners} {...attributes} type="button" title={meta.hint ?? meta.label}
      className={cn(
        "group flex w-full cursor-grab items-center gap-2.5 border border-transparent px-3 py-2 text-left text-sm",
        "transition-all active:cursor-grabbing hover:border-[#287EAD] hover:bg-[#EEF6FB]",
        isDragging && "opacity-30",
      )}>
      <Icon className="h-4 w-4 shrink-0 text-[#287EAD]" />
      <span className="font-medium text-[#1F2933]">{meta.label}</span>
    </button>
  );
}

function Palette() {
  const [query, setQuery] = useState("");
  const [openGroups, setOpenGroups] = useState<Record<BlockGroup, boolean>>({
    text: true, data: true, media: false, layout: false, signoff: false,
  });
  const all = Object.keys(BLOCK_META) as BlockType[];
  const filtered = all.filter((t) => BLOCK_META[t].label.toLowerCase().includes(query.toLowerCase()));
  const isSearching = query.trim().length > 0;

  return (
    <aside className="flex h-full w-full flex-col overflow-hidden border-r border-[#C8CDD2] bg-[#F6F7F8]">
      <div className="border-b border-[#C8CDD2] px-3 pb-3 pt-3">
        <p className="mb-2 px-1 text-[10px] font-semibold uppercase tracking-widest text-[#5E6870]">Content Blocks</p>
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[#5E6870]" />
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search…"
                 className="h-8 w-full border border-[#AEB5BB] bg-white pl-8 pr-2 text-sm text-[#1F2933] outline-none placeholder:text-[#8C969E] focus:border-[#287EAD]" />
        </div>
      </div>
      <div className="flex-1 overflow-y-auto py-2">
        {BLOCK_GROUPS.map((g) => {
          const items = filtered.filter((t) => BLOCK_META[t].group === g.key);
          if (!items.length) return null;
          const open = isSearching || openGroups[g.key];
          return (
            <div key={g.key} className="mb-0.5">
              <button onClick={() => setOpenGroups((s) => ({ ...s, [g.key]: !s[g.key] }))}
                      className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left transition hover:bg-white">
                <span className="flex items-center gap-1.5">
                  <ChevronDown className={cn("h-3 w-3 text-[#5E6870] transition-transform", !open && "-rotate-90")} />
                  <span className="text-[11px] font-semibold uppercase tracking-wider text-[#1F2933]">{g.label}</span>
                </span>
                <span className="rounded bg-[#E5E8EB] px-1.5 py-0.5 text-[10px] font-semibold text-[#5E6870]">{items.length}</span>
              </button>
              {open && <div className="flex flex-col">{items.map((t) => <PaletteItem key={t} type={t} />)}</div>}
            </div>
          );
        })}
        {filtered.length === 0 && <p className="pt-6 text-center text-sm text-[#5E6870]">No blocks match</p>}
      </div>
      <div className="border-t border-[#C8CDD2] px-3 py-3">
        <p className="border border-dashed border-[#AEB5BB] bg-white p-2.5 text-[11px] leading-relaxed text-[#5E6870]">
          Drag a block onto the page. Click any block to edit it in the inspector.
        </p>
      </div>
    </aside>
  );
}

/* ============================================================
 * Block rendering (canvas + preview share this)
 * ============================================================ */

function alignClass(a?: Align) {
  return a === "center" ? "text-center" : a === "right" ? "text-right" : a === "justify" ? "text-justify" : "text-left";
}

function blockTextStyle(b: DocBlock, theme: ThemeSettings, heading = false): React.CSSProperties {
  return {
    fontWeight: b.bold ? 700 : undefined,
    fontStyle: b.italic ? "italic" : undefined,
    textDecoration: b.underline ? "underline" : undefined,
    fontSize: b.fontSize ? `${b.fontSize}px` : undefined,
    color: b.color ?? (heading ? theme.headingColor : theme.textColor),
    marginTop: b.marginTop ? `${b.marginTop}px` : undefined,
    marginBottom: b.marginBottom != null ? `${b.marginBottom}px` : undefined,
    whiteSpace: "pre-wrap",
  };
}

/** Render a block as it will appear in the document. `data` non-null => preview
 *  (tokens substituted); when null we show raw tokens. */
function RenderBlock({ block: b, theme, data }: {
  block: DocBlock; theme: ThemeSettings; data: Record<string, string> | null;
}) {
  // String form (for attributes like alt); node form highlights [[placeholders]].
  const renderStr = (s?: string) => (data ? substitute(s, data) : (s ?? ""));
  const render = (s?: string): React.ReactNode => highlightPlaceholders(renderStr(s));
  const headingSize = b.level === 1 ? 24 : b.level === 2 ? 18 : 15;

  switch (b.type) {
    case "heading":
      return (
        <div className={alignClass(b.align)} style={{ ...blockTextStyle(b, theme, true), fontFamily: theme.headingFamily, fontSize: b.fontSize ?? headingSize, fontWeight: 700 }}>
          {render(b.text) || "Heading"}
        </div>
      );
    case "paragraph":
      return <p className={alignClass(b.align)} style={blockTextStyle(b, theme)}>{render(b.text)}</p>;
    case "quote":
      return (
        <blockquote className={alignClass(b.align)} style={{ ...blockTextStyle(b, theme), borderLeft: `3px solid ${theme.accentColor}`, paddingLeft: 12, fontStyle: "italic" }}>
          {render(b.text)}
        </blockquote>
      );
    case "bulleted_list":
      return (
        <ul className={cn("list-disc pl-5", alignClass(b.align))} style={blockTextStyle(b, theme)}>
          {(b.items ?? []).map((it, i) => <li key={i}>{render(it)}</li>)}
        </ul>
      );
    case "numbered_list":
      return (
        <ol className={cn("list-decimal pl-5", alignClass(b.align))} style={blockTextStyle(b, theme)}>
          {(b.items ?? []).map((it, i) => <li key={i}>{render(it)}</li>)}
        </ol>
      );
    case "key_value":
      return (
        <table style={{ ...blockTextStyle(b, theme), borderCollapse: "collapse", width: "100%" }}>
          <tbody>
            {(b.pairs ?? []).map((p) => (
              <tr key={p.id}>
                <td style={{ width: b.labelWidth ?? 160, padding: "3px 8px 3px 0", fontWeight: 600, verticalAlign: "top", color: theme.textColor }}>
                  {render(p.label)}
                </td>
                <td style={{ padding: "3px 0", color: theme.textColor }}>{render(p.value)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      );
    case "data_table": {
      const cols = b.columns ?? [];
      const border = b.bordered ? "1px solid #C8CDD2" : "none";
      const totalW = cols.reduce((a, c) => a + (c.width ?? 1), 0) || 1;
      const fillRows = Math.max(1, b.fillRows ?? 3);
      const rows = b.bound ? Array.from({ length: fillRows }, () => cols.map(() => "")) : (b.rows ?? []);
      return (
        <div style={blockTextStyle(b, theme)}>
          {b.bound && (
            <div className="mb-1 inline-flex items-center gap-1 rounded bg-[#FFFBEB] px-2 py-0.5 text-[10px] font-semibold text-[#92700A]">
              <Rows3 className="h-3 w-3" /> {b.sourceKey ? `Repeats per “${b.sourceKey}” (or ${fillRows} blank rows)` : `${fillRows} blank rows for the user to fill`}
            </div>
          )}
          <table style={{ borderCollapse: "collapse", width: "100%", border }}>
            <thead>
              <tr style={{ background: theme.accentColor, color: "#fff" }}>
                {cols.map((c) => (
                  <th key={c.id} style={{ width: `${((c.width ?? 1) / totalW) * 100}%`, textAlign: c.align ?? "left", padding: "6px 8px", border, fontWeight: 600 }}>
                    {c.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, ri) => (
                <tr key={ri} style={{ background: b.striped && ri % 2 ? "#F3F5F6" : undefined }}>
                  {cols.map((c, ci) => (
                    <td key={c.id} style={{ textAlign: c.align ?? "left", padding: "6px 8px", border, color: theme.textColor, minWidth: 40 }}>
                      {b.bound ? <span>&nbsp;</span> : render(r?.[ci])}
                    </td>
                  ))}
                </tr>
              ))}
              {rows.length === 0 && (
                <tr><td colSpan={Math.max(1, cols.length)} style={{ padding: "8px", textAlign: "center", color: "#8C969E", border }}>No rows</td></tr>
              )}
            </tbody>
          </table>
        </div>
      );
    }
    case "image":
    case "logo": {
      const wrapAlign = b.align === "center" ? "center" : b.align === "right" ? "flex-end" : "flex-start";
      return (
        <div style={{ display: "flex", justifyContent: wrapAlign, marginTop: b.marginTop, marginBottom: b.marginBottom }}>
          {b.src ? (
            <img src={b.src} alt={renderStr(b.alt)} style={{ width: b.width, height: b.height, objectFit: "contain" }} />
          ) : (
            <div style={{ width: b.width, height: b.height, border: "1px dashed #AEB5BB", display: "flex", alignItems: "center", justifyContent: "center", color: "#8C969E", fontSize: 11, background: "#F6F7F8" }}>
              {b.type === "logo" ? "Company logo" : "Image"}
            </div>
          )}
        </div>
      );
    }
    case "two_column":
      return (
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 24, ...blockTextStyle(b, theme) }}>
          <div>{render(b.left)}</div>
          <div>{render(b.right)}</div>
        </div>
      );
    case "divider":
      return <hr style={{ border: "none", borderTop: "1px solid #C8CDD2", marginTop: b.marginTop, marginBottom: b.marginBottom }} />;
    case "spacer":
      return <div style={{ height: b.height ?? 24 }} />;
    case "page_break":
      return (
        <div className="my-2 flex items-center gap-2 text-[10px] font-semibold uppercase tracking-widest text-[#8C969E]" style={{ pageBreakAfter: "always" }}>
          <div className="h-px flex-1 bg-[#C8CDD2]" /> Page break <div className="h-px flex-1 bg-[#C8CDD2]" />
        </div>
      );
    case "signature":
      return (
        <div style={{ display: "grid", gridTemplateColumns: `repeat(${Math.min((b.signatories ?? []).length || 1, 3)}, 1fr)`, gap: 28, marginTop: b.marginTop, marginBottom: b.marginBottom }}>
          {(b.signatories ?? []).map((s) => (
            <div key={s.id} style={{ color: theme.textColor, fontSize: 12 }}>
              <div style={{ fontWeight: 600, marginBottom: 30 }}>{s.role}</div>
              <div style={{ borderTop: "1px solid #1F2933", paddingTop: 3 }}>
                <div style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: "0.05em", color: "#5E6870" }}>Signature</div>
                {(s.nameToken || s.dateToken) && (
                  <div style={{ marginTop: 6, lineHeight: 1.6 }}>
                    {s.nameToken && <div><span style={{ color: "#5E6870" }}>Name: </span>{render(s.nameToken)}</div>}
                    {s.dateToken && <div><span style={{ color: "#5E6870" }}>Date: </span>{render(s.dateToken)}</div>}
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      );
    default:
      return null;
  }
}

/* ============================================================
 * Canvas — the editable paper
 * ============================================================ */

function DropZone({ id, data }: { id: string; data: Record<string, unknown> }) {
  const { setNodeRef, isOver } = useDroppable({ id, data });
  return (
    <div ref={setNodeRef}
         className={cn(
           "flex items-center justify-center rounded border-2 border-dashed text-[11px] font-medium transition",
           isOver ? "h-10 border-[#287EAD] bg-[#EEF6FB] text-[#287EAD]" : "h-2 border-transparent text-transparent hover:h-8 hover:border-[#287EAD]/40 hover:text-[#287EAD]/60",
         )}>
      Drop here
    </div>
  );
}

/** Lightweight theme carrier so the (pointer-events-none) canvas preview can
 *  read the current theme without prop drilling into RenderBlock. */
const CANVAS_THEME: { current: ThemeSettings } = { current: initialDocument.theme };

function BlockCard({ block, index, count, isSelected, onSelect, onRemove, onDuplicate, onMove }: {
  block: DocBlock; index: number; count: number; isSelected: boolean;
  onSelect: () => void; onRemove: () => void; onDuplicate: () => void;
  onMove: (dir: "up" | "down") => void;
}) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: `canvas-${block.id}`, data: { source: "canvas-block", blockId: block.id },
  });
  const meta = BLOCK_META[block.type];
  return (
    <div ref={setNodeRef} onClick={(e) => { e.stopPropagation(); onSelect(); }}
         className={cn(
           "group relative rounded border bg-white px-3 py-2 transition-all",
           isDragging && "opacity-40",
           isSelected ? "border-[#287EAD] ring-2 ring-[#287EAD]/20" : "border-transparent hover:border-[#287EAD]/40",
         )}>
      <div className="absolute -top-3 right-2 z-10 flex items-center gap-0.5 rounded border border-[#C8CDD2] bg-white px-0.5 py-0.5 opacity-0 shadow-sm transition group-hover:opacity-100">
        <span {...listeners} {...attributes} title="Drag to move"
              className="cursor-grab rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700 active:cursor-grabbing">
          <GripVertical className="h-3 w-3" />
        </span>
        <button onClick={(e) => { e.stopPropagation(); onMove("up"); }} disabled={index === 0} title="Move up"
                className="rounded p-1 text-slate-400 hover:bg-slate-100 disabled:opacity-20"><ChevronUp className="h-3 w-3" /></button>
        <button onClick={(e) => { e.stopPropagation(); onMove("down"); }} disabled={index === count - 1} title="Move down"
                className="rounded p-1 text-slate-400 hover:bg-slate-100 disabled:opacity-20"><ChevronDown className="h-3 w-3" /></button>
        <button onClick={(e) => { e.stopPropagation(); onDuplicate(); }} title="Duplicate"
                className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700"><Copy className="h-3 w-3" /></button>
        <button onClick={(e) => { e.stopPropagation(); onRemove(); }} title="Remove"
                className="rounded p-1 text-slate-400 hover:bg-red-50 hover:text-red-500"><Trash2 className="h-3 w-3" /></button>
      </div>
      <span className="absolute -top-2.5 left-2 z-10 rounded bg-[#EEF6FB] px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-[#287EAD] opacity-0 transition group-hover:opacity-100">
        {meta.label}
      </span>
      <div className="pointer-events-none">
        <RenderBlock block={block} theme={CANVAS_THEME.current} data={null} />
      </div>
    </div>
  );
}

function BandRow({ slot, data }: { slot: BandSlot; data?: Record<string, string> }) {
  const r = (s?: string) => (data ? substitute(s, { ...data, page: "1", pages: "1" }) : (s ?? ""));
  return (
    <div className="flex items-center justify-between gap-4 text-[11px]">
      <span className="flex-1 text-left">{r(slot.left)}</span>
      <span className="flex-1 text-center">{r(slot.center)}</span>
      <span className="flex-1 text-right">{r(slot.right)}</span>
    </div>
  );
}

function Paper({ template, selectedId, onSelect, onRemove, onDuplicate, onMove }: {
  template: DocumentTemplate;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onRemove: (id: string) => void;
  onDuplicate: (id: string) => void;
  onMove: (id: string, dir: "up" | "down") => void;
}) {
  CANVAS_THEME.current = template.theme;
  const dims = PAGE_DIMS[template.page.size];
  const portrait = template.page.orientation === "portrait";
  const pageW = portrait ? dims.w : dims.h;
  const m = template.page.margin;
  const { setNodeRef, isOver } = useDroppable({ id: "drop-body-end", data: { source: "canvas", kind: "end" } });

  return (
    <div className="flex justify-center px-8 py-8" onClick={() => onSelect(null)}>
      <div className="bg-white shadow-lg" style={{ width: `${pageW}mm`, minHeight: "60vh", fontFamily: template.theme.fontFamily, fontSize: template.theme.baseFontSize, lineHeight: template.theme.lineHeight }}>
        {template.header.enabled && (
          <div className="text-[#5E6870]" style={{ padding: `${m.top}mm ${m.right}mm 4mm ${m.left}mm`, borderBottom: template.header.rule ? "1px solid #C8CDD2" : "none" }}>
            <BandRow slot={template.header.content} />
          </div>
        )}
        <div style={{ padding: `${template.header.enabled ? 6 : m.top}mm ${m.right}mm ${template.footer.enabled ? 6 : m.bottom}mm ${m.left}mm` }}>
          <DropZone id="drop-before-0" data={{ source: "canvas", kind: "before", index: 0 }} />
          {template.blocks.map((b, i) => (
            <div key={b.id}>
              <BlockCard block={b} index={i} count={template.blocks.length}
                         isSelected={selectedId === b.id}
                         onSelect={() => onSelect(b.id)}
                         onRemove={() => onRemove(b.id)}
                         onDuplicate={() => onDuplicate(b.id)}
                         onMove={(d) => onMove(b.id, d)} />
              <DropZone id={`drop-before-${i + 1}`} data={{ source: "canvas", kind: "before", index: i + 1 }} />
            </div>
          ))}
          <div ref={setNodeRef}
               className={cn("mt-1 flex h-12 items-center justify-center rounded border-2 border-dashed text-xs font-medium transition",
                 isOver ? "border-[#287EAD] bg-[#EEF6FB] text-[#287EAD]" : "border-slate-200 text-slate-400 hover:border-[#287EAD]/60")}>
            <Plus className="mr-1.5 h-3.5 w-3.5" /> Drop a block here
          </div>
        </div>
        {template.footer.enabled && (
          <div className="text-[#5E6870]" style={{ padding: `4mm ${m.right}mm ${m.bottom}mm ${m.left}mm`, borderTop: template.footer.rule ? "1px solid #C8CDD2" : "none" }}>
            <BandRow slot={template.footer.content} />
          </div>
        )}
      </div>
    </div>
  );
}

/* ============================================================
 * Inspector
 * ============================================================ */

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <div className="space-y-1.5"><label className={labelCls}>{label}</label>{children}</div>;
}

function NumberRow({ label, value, onChange, min, max, suffix }: {
  label: string; value?: number; onChange: (n: number) => void; min?: number; max?: number; suffix?: string;
}) {
  return (
    <div className="flex items-center justify-between gap-2">
      <label className="text-xs text-[#5E6870]">{label}</label>
      <div className="flex items-center gap-1">
        <input type="number" min={min} max={max} value={value ?? 0} onChange={(e) => onChange(Number(e.target.value))}
               className="h-8 w-20 border border-[#AEB5BB] bg-white px-2 text-sm outline-none focus:border-[#287EAD]" />
        {suffix && <span className="text-xs text-[#8C969E]">{suffix}</span>}
      </div>
    </div>
  );
}

function AlignJustifyIcon(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg {...props} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round">
      <line x1="3" y1="6" x2="21" y2="6" /><line x1="3" y1="12" x2="21" y2="12" /><line x1="3" y1="18" x2="21" y2="18" />
    </svg>
  );
}

function AlignToggle({ value, onChange }: { value?: Align; onChange: (a: Align) => void }) {
  const opts: Array<{ a: Align; icon: React.ElementType }> = [
    { a: "left", icon: AlignLeft }, { a: "center", icon: AlignCenter },
    { a: "right", icon: AlignRight }, { a: "justify", icon: AlignJustifyIcon },
  ];
  return (
    <div className="flex border border-[#AEB5BB]">
      {opts.map(({ a, icon: Icon }) => (
        <button key={a} type="button" onClick={() => onChange(a)}
                className={cn("flex h-8 flex-1 items-center justify-center border-r border-[#AEB5BB] last:border-0",
                  (value ?? "left") === a ? "bg-[#287EAD] text-white" : "bg-white text-[#5E6870] hover:bg-[#EEF6FB]")}>
          <Icon className="h-3.5 w-3.5" />
        </button>
      ))}
    </div>
  );
}

function StyleToggles({ block, patch }: { block: DocBlock; patch: (p: Partial<DocBlock>) => void }) {
  const Tog = ({ on, onClick, icon: Icon }: { on?: boolean; onClick: () => void; icon: React.ElementType }) => (
    <button type="button" onClick={onClick}
            className={cn("flex h-8 w-9 items-center justify-center border border-[#AEB5BB]", on ? "bg-[#287EAD] text-white" : "bg-white text-[#5E6870] hover:bg-[#EEF6FB]")}>
      <Icon className="h-3.5 w-3.5" />
    </button>
  );
  return (
    <div className="flex gap-1">
      <Tog on={block.bold} onClick={() => patch({ bold: !block.bold })} icon={Bold} />
      <Tog on={block.italic} onClick={() => patch({ italic: !block.italic })} icon={Italic} />
      <Tog on={block.underline} onClick={() => patch({ underline: !block.underline })} icon={Underline} />
    </div>
  );
}

function TokenTextarea({ value, onChange, rows = 3, fields, placeholder }: {
  value: string; onChange: (v: string) => void; rows?: number; fields: MergeField[]; placeholder?: string;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const insert = (token: string) => {
    const el = ref.current;
    const start = el?.selectionStart ?? value.length;
    const end = el?.selectionEnd ?? value.length;
    onChange(value.slice(0, start) + token + value.slice(end));
    requestAnimationFrame(() => { el?.focus(); el?.setSelectionRange(start + token.length, start + token.length); });
  };
  return (
    <div className="space-y-1.5">
      <div className="flex justify-end"><MergeFieldMenu fields={fields} onPick={(t) => insert(t)} /></div>
      <textarea ref={ref} value={value} rows={rows} placeholder={placeholder} onChange={(e) => onChange(e.target.value)}
                className={cn(inputCls, "h-auto resize-y py-2")} />
    </div>
  );
}

function DataTableInspector({ block, repeatingFields, patch }: {
  block: DocBlock; repeatingFields: MergeField[]; patch: (p: Partial<DocBlock>) => void;
}) {
  const cols = block.columns ?? [];
  const setCols = (next: DocTableColumn[]) => patch({ columns: next });
  const setRows = (next: string[][]) => patch({ rows: next });

  const addColumn = () => {
    const c = newColumn(`Column ${cols.length + 1}`);
    setCols([...cols, c]);
    setRows((block.rows ?? []).map((r) => [...r, ""]));
  };
  const removeColumn = (idx: number) => {
    setCols(cols.filter((_, i) => i !== idx));
    setRows((block.rows ?? []).map((r) => r.filter((_, i) => i !== idx)));
  };

  return (
    <div className="space-y-4">
      <Field label="Rows">
        <div className="space-y-2">
          <label className="flex items-center gap-2 text-xs text-[#1F2933]">
            <input type="radio" checked={!block.bound} onChange={() => patch({ bound: false })} /> Static rows (typed in the template)
          </label>
          <label className="flex items-center gap-2 text-xs text-[#1F2933]">
            <input type="radio" checked={!!block.bound} onChange={() => patch({ bound: true })} /> Fillable rows — the user completes them when editing
          </label>
          {block.bound && (
            <div className="space-y-2 border-l-2 border-[#E3C765] pl-3">
              <NumberRow label="Blank rows" value={block.fillRows ?? 3} min={1} max={50} onChange={(n) => patch({ fillRows: Math.max(1, n) })} />
              <div>
                <p className="mb-1 text-[10px] text-[#8C969E]">Optionally bind to a collection (one row per record when data is supplied):</p>
                <select value={block.sourceKey ?? ""} onChange={(e) => patch({ sourceKey: e.target.value })} className={cn(inputCls, "h-8")}>
                  <option value="">No collection — blank rows</option>
                  {repeatingFields.map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}
                </select>
              </div>
            </div>
          )}
        </div>
      </Field>

      <div className="grid grid-cols-2 gap-2">
        <label className="flex items-center gap-2 text-xs text-[#1F2933]">
          <input type="checkbox" checked={!!block.bordered} onChange={(e) => patch({ bordered: e.target.checked })} /> Borders
        </label>
        <label className="flex items-center gap-2 text-xs text-[#1F2933]">
          <input type="checkbox" checked={!!block.striped} onChange={(e) => patch({ striped: e.target.checked })} /> Zebra rows
        </label>
      </div>

      <Field label="Columns">
        <div className="space-y-2">
          {cols.map((c, i) => (
            <div key={c.id} className="flex items-center gap-1">
              <input value={c.label} onChange={(e) => setCols(cols.map((x) => x.id === c.id ? { ...x, label: e.target.value } : x))} className={cn(inputCls, "h-8")} />
              <select value={c.align ?? "left"} onChange={(e) => setCols(cols.map((x) => x.id === c.id ? { ...x, align: e.target.value as Align } : x))}
                      className="h-8 w-20 border border-[#AEB5BB] bg-white px-1 text-xs outline-none focus:border-[#287EAD]">
                <option value="left">Left</option><option value="center">Center</option><option value="right">Right</option>
              </select>
              <button onClick={() => removeColumn(i)} className="flex h-8 w-8 shrink-0 items-center justify-center border border-[#AEB5BB] text-[#5E6870] hover:bg-red-50 hover:text-red-500"><Minus className="h-3.5 w-3.5" /></button>
            </div>
          ))}
          <button onClick={addColumn} className="inline-flex items-center gap-1.5 border border-[#287EAD]/40 bg-white px-3 py-1.5 text-xs font-semibold text-[#287EAD] hover:bg-[#EEF6FB]"><Plus className="h-3.5 w-3.5" /> Add column</button>
        </div>
      </Field>

      {!block.bound && (
        <Field label="Static rows">
          <div className="space-y-2">
            {(block.rows ?? []).map((r, ri) => (
              <div key={ri} className="flex items-start gap-1">
                <div className="flex-1 space-y-1">
                  {cols.map((c, ci) => (
                    <input key={c.id} value={r[ci] ?? ""} placeholder={c.label}
                           onChange={(e) => setRows((block.rows ?? []).map((row, i) => i === ri ? row.map((cell, j) => j === ci ? e.target.value : cell) : row))}
                           className={cn(inputCls, "h-8 text-xs")} />
                  ))}
                </div>
                <button onClick={() => setRows((block.rows ?? []).filter((_, i) => i !== ri))}
                        className="flex h-8 w-8 shrink-0 items-center justify-center border border-[#AEB5BB] text-[#5E6870] hover:bg-red-50 hover:text-red-500"><Trash2 className="h-3.5 w-3.5" /></button>
              </div>
            ))}
            <button onClick={() => setRows([...(block.rows ?? []), cols.map(() => "")])}
                    className="inline-flex items-center gap-1.5 border border-[#287EAD]/40 bg-white px-3 py-1.5 text-xs font-semibold text-[#287EAD] hover:bg-[#EEF6FB]"><Plus className="h-3.5 w-3.5" /> Add row</button>
          </div>
        </Field>
      )}
    </div>
  );
}

function BlockInspector({ block, theme, fields, repeatingFields, patch }: {
  block: DocBlock; theme: ThemeSettings; fields: MergeField[]; repeatingFields: MergeField[];
  patch: (p: Partial<DocBlock>) => void;
}) {
  const common = (
    <>
      {!["divider", "spacer", "page_break", "image", "logo"].includes(block.type) && (
        <Field label="Alignment"><AlignToggle value={block.align} onChange={(a) => patch({ align: a })} /></Field>
      )}
      {["heading", "paragraph", "quote", "bulleted_list", "numbered_list", "key_value", "two_column"].includes(block.type) && (
        <>
          <Field label="Text style"><StyleToggles block={block} patch={patch} /></Field>
          <div className="grid grid-cols-2 gap-2">
            <Field label="Font size"><input type="number" value={block.fontSize ?? ""} placeholder={`${theme.baseFontSize}`}
              onChange={(e) => patch({ fontSize: e.target.value ? Number(e.target.value) : undefined })} className={inputCls} /></Field>
            <Field label="Text colour">
              <input type="color" value={block.color ?? theme.textColor} onChange={(e) => patch({ color: e.target.value })} className="h-9 w-full border border-[#AEB5BB] bg-white p-1" />
            </Field>
          </div>
        </>
      )}
      <div className="grid grid-cols-2 gap-2">
        <NumberRow label="Space above" value={block.marginTop} onChange={(n) => patch({ marginTop: n })} suffix="px" />
        <NumberRow label="Space below" value={block.marginBottom} onChange={(n) => patch({ marginBottom: n })} suffix="px" />
      </div>
    </>
  );

  return (
    <div className="space-y-4">
      {block.type === "heading" && (
        <>
          <Field label="Heading text"><TokenTextarea value={block.text ?? ""} rows={2} fields={fields} onChange={(v) => patch({ text: v })} /></Field>
          <Field label="Level">
            <div className="flex border border-[#AEB5BB]">
              {[1, 2, 3].map((lvl) => (
                <button key={lvl} type="button" onClick={() => patch({ level: lvl as 1 | 2 | 3 })}
                        className={cn("h-8 flex-1 border-r border-[#AEB5BB] text-xs font-semibold last:border-0",
                          (block.level ?? 2) === lvl ? "bg-[#287EAD] text-white" : "bg-white text-[#5E6870] hover:bg-[#EEF6FB]")}>H{lvl}</button>
              ))}
            </div>
          </Field>
        </>
      )}

      {(block.type === "paragraph" || block.type === "quote") && (
        <Field label="Content"><TokenTextarea value={block.text ?? ""} rows={5} fields={fields} onChange={(v) => patch({ text: v })} /></Field>
      )}

      {(block.type === "bulleted_list" || block.type === "numbered_list") && (
        <Field label="List items">
          <div className="space-y-2">
            {(block.items ?? []).map((it, i) => (
              <div key={i} className="flex gap-1">
                <input value={it} onChange={(e) => patch({ items: (block.items ?? []).map((x, xi) => xi === i ? e.target.value : x) })} className={inputCls} />
                <button onClick={() => patch({ items: (block.items ?? []).filter((_, xi) => xi !== i) })}
                        className="flex h-9 w-9 shrink-0 items-center justify-center border border-[#AEB5BB] text-[#5E6870] hover:bg-red-50 hover:text-red-500"><Minus className="h-3.5 w-3.5" /></button>
              </div>
            ))}
            <button onClick={() => patch({ items: [...(block.items ?? []), "New item"] })}
                    className="inline-flex items-center gap-1.5 border border-[#287EAD]/40 bg-white px-3 py-1.5 text-xs font-semibold text-[#287EAD] hover:bg-[#EEF6FB]"><Plus className="h-3.5 w-3.5" /> Add item</button>
          </div>
        </Field>
      )}

      {block.type === "key_value" && (
        <>
          <NumberRow label="Label width" value={block.labelWidth} onChange={(n) => patch({ labelWidth: n })} suffix="px" />
          <Field label="Rows">
            <div className="space-y-2">
              {(block.pairs ?? []).map((p) => (
                <div key={p.id} className="space-y-1 border border-[#E5E8EB] p-2">
                  <div className="flex gap-1">
                    <input value={p.label} placeholder="Label"
                           onChange={(e) => patch({ pairs: (block.pairs ?? []).map((x) => x.id === p.id ? { ...x, label: e.target.value } : x) })} className={cn(inputCls, "h-8")} />
                    <button onClick={() => patch({ pairs: (block.pairs ?? []).filter((x) => x.id !== p.id) })}
                            className="flex h-8 w-8 shrink-0 items-center justify-center border border-[#AEB5BB] text-[#5E6870] hover:bg-red-50 hover:text-red-500"><Minus className="h-3.5 w-3.5" /></button>
                  </div>
                  <div className="flex items-center gap-1">
                    <input value={p.value} placeholder="Value or {{field}}"
                           onChange={(e) => patch({ pairs: (block.pairs ?? []).map((x) => x.id === p.id ? { ...x, value: e.target.value } : x) })} className={cn(inputCls, "h-8 font-mono text-xs")} />
                    <MergeFieldMenu fields={fields} label="" onPick={(t) => patch({ pairs: (block.pairs ?? []).map((x) => x.id === p.id ? { ...x, value: (x.value ? x.value + " " : "") + t } : x) })} />
                  </div>
                </div>
              ))}
              <button onClick={() => patch({ pairs: [...(block.pairs ?? []), { id: uid(), label: "New", value: "" }] })}
                      className="inline-flex items-center gap-1.5 border border-[#287EAD]/40 bg-white px-3 py-1.5 text-xs font-semibold text-[#287EAD] hover:bg-[#EEF6FB]"><Plus className="h-3.5 w-3.5" /> Add row</button>
            </div>
          </Field>
        </>
      )}

      {block.type === "data_table" && (
        <DataTableInspector block={block} repeatingFields={repeatingFields} patch={patch} />
      )}

      {(block.type === "image" || block.type === "logo") && (
        <>
          <Field label="Upload image">
            <div className="space-y-2">
              <label className="flex cursor-pointer items-center justify-center gap-2 border border-dashed border-[#287EAD]/50 bg-[#EEF6FB] px-3 py-2 text-xs font-semibold text-[#287EAD] hover:bg-[#E3F0F8]">
                <ImageIcon className="h-3.5 w-3.5" /> Choose image…
                <input type="file" accept="image/*" className="hidden"
                       onChange={(e) => {
                         const f = e.target.files?.[0];
                         if (!f) return;
                         const reader = new FileReader();
                         reader.onload = () => patch({ src: String(reader.result) });
                         reader.readAsDataURL(f);
                         e.target.value = "";
                       }} />
              </label>
              {block.src?.startsWith("data:image") && (
                <div className="flex items-center justify-between gap-2 border border-[#C8CDD2] bg-white p-2">
                  <img src={block.src} alt="" className="h-10 w-auto object-contain" />
                  <button type="button" onClick={() => patch({ src: "" })} className="text-[11px] font-semibold text-[#5E6870] hover:text-red-600">Remove</button>
                </div>
              )}
            </div>
          </Field>
          <Field label="…or image URL"><input value={block.src?.startsWith("data:") ? "" : (block.src ?? "")} placeholder="https://… or {{logo_url}}" onChange={(e) => patch({ src: e.target.value })} className={inputCls} /></Field>
          <Field label="Alt text"><input value={block.alt ?? ""} onChange={(e) => patch({ alt: e.target.value })} className={inputCls} /></Field>
          <div className="grid grid-cols-2 gap-2">
            <NumberRow label="Width" value={block.width} onChange={(n) => patch({ width: n })} suffix="px" />
            <NumberRow label="Height" value={block.height} onChange={(n) => patch({ height: n })} suffix="px" />
          </div>
          <Field label="Alignment"><AlignToggle value={block.align} onChange={(a) => patch({ align: a })} /></Field>
        </>
      )}

      {block.type === "two_column" && (
        <>
          <Field label="Left column"><TokenTextarea value={block.left ?? ""} rows={4} fields={fields} onChange={(v) => patch({ left: v })} /></Field>
          <Field label="Right column"><TokenTextarea value={block.right ?? ""} rows={4} fields={fields} onChange={(v) => patch({ right: v })} /></Field>
        </>
      )}

      {block.type === "spacer" && <NumberRow label="Height" value={block.height} onChange={(n) => patch({ height: n })} suffix="px" />}

      {block.type === "signature" && (
        <Field label="Signatories">
          <div className="space-y-2">
            <p className="text-[11px] text-[#8C969E]">
              Each entry is a signature line. Set <strong>Name</strong>/<strong>Date</strong> to an
              auto-fill field (e.g. <code className="font-mono">{"{{current_user}}"}</code>), a
              fill-in <code className="font-mono">[[placeholder]]</code>, or plain text. Add as many
              approvers as you need.
            </p>
            {(block.signatories ?? []).map((s, idx) => {
              const setSig = (p: Partial<Signatory>) =>
                patch({ signatories: (block.signatories ?? []).map((x) => x.id === s.id ? { ...x, ...p } : x) });
              return (
              <div key={s.id} className="space-y-1.5 border border-[#E5E8EB] p-2">
                <div className="flex items-center gap-1">
                  <span className="shrink-0 text-[10px] font-semibold text-[#8C969E]">#{idx + 1}</span>
                  <input value={s.role} placeholder="Role e.g. Approved by" onChange={(e) => setSig({ role: e.target.value })} className={cn(inputCls, "h-8")} />
                  <button onClick={() => patch({ signatories: (block.signatories ?? []).filter((x) => x.id !== s.id) })}
                          title="Remove signatory"
                          className="flex h-8 w-8 shrink-0 items-center justify-center border border-[#AEB5BB] text-[#5E6870] hover:bg-red-50 hover:text-red-500"><Minus className="h-3.5 w-3.5" /></button>
                </div>
                <div className="flex items-center gap-1">
                  <input value={s.nameToken ?? ""} placeholder="Name — field, [[ask]] or text" onChange={(e) => setSig({ nameToken: e.target.value })} className={cn(inputCls, "h-8 font-mono text-xs")} />
                  <MergeFieldMenu fields={fields} label="" onPick={(t) => setSig({ nameToken: (s.nameToken ? s.nameToken + " " : "") + t })} />
                </div>
                <div className="flex items-center gap-1">
                  <input value={s.dateToken ?? ""} placeholder="Date — field, [[ask]] or text" onChange={(e) => setSig({ dateToken: e.target.value })} className={cn(inputCls, "h-8 font-mono text-xs")} />
                  <MergeFieldMenu fields={fields} label="" onPick={(t) => setSig({ dateToken: (s.dateToken ? s.dateToken + " " : "") + t })} />
                </div>
              </div>
              );
            })}
            <button onClick={() => patch({ signatories: [...(block.signatories ?? []), { id: uid(), role: "Approved by", nameToken: "[[Name]]", dateToken: "[[Date]]" }] })}
                    className="inline-flex items-center gap-1.5 border border-[#287EAD]/40 bg-white px-3 py-1.5 text-xs font-semibold text-[#287EAD] hover:bg-[#EEF6FB]"><Plus className="h-3.5 w-3.5" /> Add approver / signatory</button>
          </div>
        </Field>
      )}

      <div className="border-t border-[#E5E8EB] pt-4">{common}</div>
    </div>
  );
}

function Inspector({ template, selectedId, fields, onUpdateBlock, onCollapse }: {
  template: DocumentTemplate; selectedId: string | null; fields: MergeField[];
  onUpdateBlock: (id: string, patch: Partial<DocBlock>) => void; onCollapse: () => void;
}) {
  const block = template.blocks.find((b) => b.id === selectedId) ?? null;
  const repeatingFields = fields.filter((f) => f.repeating);

  return (
    <aside className="flex h-full w-full flex-col overflow-hidden border-l border-[#C8CDD2] bg-white">
      <div className="flex items-center justify-between border-b border-[#C8CDD2] bg-[#F3F5F6] px-4 py-3">
        <div className="flex items-center gap-2">
          <Settings className="h-4 w-4 text-[#287EAD]" />
          <span className="text-sm font-bold text-[#1F2933]">{block ? BLOCK_META[block.type].label : "Inspector"}</span>
        </div>
        <button onClick={onCollapse} className="p-1 text-[#5E6870] hover:text-[#1F2933]"><X className="h-4 w-4" /></button>
      </div>
      <div className="flex-1 overflow-y-auto p-4">
        {block ? (
          <BlockInspector block={block} theme={template.theme} fields={fields} repeatingFields={repeatingFields} patch={(p) => onUpdateBlock(block.id, p)} />
        ) : (
          <div className="flex h-full flex-col items-center justify-center text-center text-[#8C969E]">
            <FileText className="mb-3 h-10 w-10 text-[#C8CDD2]" />
            <p className="text-sm font-medium text-[#5E6870]">Select a block to edit it</p>
            <p className="mt-1 text-xs">Use the <strong>Settings</strong> tab for page setup, fonts, and header/footer.</p>
          </div>
        )}
      </div>
    </aside>
  );
}

/* ============================================================
 * Preview tab — sample-data rendered, print-ready
 * ============================================================ */

function buildSampleData(fields: MergeField[], provided?: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of fields) {
    if (f.repeating) continue;
    out[f.key] = provided?.[f.key] ?? `[${f.label}]`;
  }
  return { ...out, ...(provided ?? {}) };
}

function PreviewTab({ template, fields, sampleData }: {
  template: DocumentTemplate; fields: MergeField[]; sampleData?: Record<string, string>;
}) {
  const data = useMemo(() => buildSampleData(fields, sampleData), [fields, sampleData]);
  const dims = PAGE_DIMS[template.page.size];
  const portrait = template.page.orientation === "portrait";
  const pageW = portrait ? dims.w : dims.h;
  const pageH = portrait ? dims.h : dims.w;
  const m = template.page.margin;

  return (
    <div className="flex flex-col items-center gap-6 px-8 py-8">
      <div className="doc-preview-sheet bg-white shadow-lg"
           style={{ width: `${pageW}mm`, minHeight: `${pageH}mm`, display: "flex", flexDirection: "column",
                    fontFamily: template.theme.fontFamily, fontSize: template.theme.baseFontSize, lineHeight: template.theme.lineHeight, color: template.theme.textColor }}>
        {template.header.enabled && (
          <div style={{ padding: `${m.top}mm ${m.right}mm 4mm ${m.left}mm`, borderBottom: template.header.rule ? "1px solid #C8CDD2" : "none", color: "#5E6870" }}>
            <BandRow slot={template.header.content} data={data} />
          </div>
        )}
        <div style={{ flex: 1, padding: `${template.header.enabled ? 6 : m.top}mm ${m.right}mm ${template.footer.enabled ? 6 : m.bottom}mm ${m.left}mm` }}>
          {template.blocks.map((b) => (
            <div key={b.id}><RenderBlock block={b} theme={template.theme} data={data} /></div>
          ))}
        </div>
        {template.footer.enabled && (
          <div style={{ padding: `4mm ${m.right}mm ${m.bottom}mm ${m.left}mm`, borderTop: template.footer.rule ? "1px solid #C8CDD2" : "none", color: "#5E6870" }}>
            <BandRow slot={template.footer.content} data={data} />
          </div>
        )}
      </div>
      <p className="text-xs text-[#8C969E]">Preview uses sample values. Repeating tables show one representative row.</p>
    </div>
  );
}

/* ============================================================
 * Settings tab — metadata, page setup, theme, header/footer
 * ============================================================ */

function Card({ title, subtitle, children }: { title: string; subtitle?: string; children: React.ReactNode }) {
  return (
    <div className="border border-[#C8CDD2] bg-white shadow-sm">
      <div className="border-b border-[#C8CDD2] bg-[#F3F5F6] px-5 py-3">
        <h2 className="text-sm font-bold text-[#1F2933]">{title}</h2>
        {subtitle && <p className="mt-0.5 text-xs text-[#5E6870]">{subtitle}</p>}
      </div>
      <div className="space-y-4 p-5">{children}</div>
    </div>
  );
}

function BandEditor({ title, band, fields, allowPageTokens, onChange }: {
  title: string; band: BandSettings; fields: MergeField[]; allowPageTokens?: boolean;
  onChange: (b: BandSettings) => void;
}) {
  const slot = (k: keyof BandSlot, label: string) => (
    <Field label={label}>
      <div className="flex items-center gap-1">
        <input value={band.content[k] ?? ""} onChange={(e) => onChange({ ...band, content: { ...band.content, [k]: e.target.value } })}
               className={cn(inputCls, "font-mono text-xs")} placeholder="text or {{field}}" />
        <MergeFieldMenu fields={fields} label="" onPick={(t) => onChange({ ...band, content: { ...band.content, [k]: (band.content[k] ? band.content[k] + " " : "") + t } })} />
      </div>
    </Field>
  );
  return (
    <Card title={title}>
      <label className="flex items-center gap-2 text-sm text-[#1F2933]">
        <input type="checkbox" checked={band.enabled} onChange={(e) => onChange({ ...band, enabled: e.target.checked })} /> Show {title.toLowerCase()}
      </label>
      {band.enabled && (
        <>
          <div className="grid grid-cols-1 gap-3">
            {slot("left", "Left")}
            {slot("center", "Center")}
            {slot("right", "Right")}
          </div>
          <label className="flex items-center gap-2 text-sm text-[#1F2933]">
            <input type="checkbox" checked={band.rule} onChange={(e) => onChange({ ...band, rule: e.target.checked })} /> Divider rule
          </label>
          {allowPageTokens && (
            <p className="text-[11px] text-[#8C969E]">Tip: use <code className="font-mono">{"{{page}}"}</code> and <code className="font-mono">{"{{pages}}"}</code> for page numbers.</p>
          )}
        </>
      )}
    </Card>
  );
}

function SettingsTab({ template, documentTypes, fields, onCommit }: {
  template: DocumentTemplate;
  documentTypes: Array<{ id: string; name: string; code: string }>;
  fields: MergeField[];
  onCommit: (patch: Partial<DocumentTemplate>) => void;
}) {
  const [tagInput, setTagInput] = useState("");
  const addTag = () => {
    const t = tagInput.trim();
    if (t && !(template.tags ?? []).includes(t)) onCommit({ tags: [...(template.tags ?? []), t] });
    setTagInput("");
  };
  const [refInput, setRefInput] = useState("");
  const refs = template.references ?? [];
  const addRef = () => {
    const label = refInput.trim();
    const key = slugify(label);
    if (key && !refs.some((r) => r.key === key)) onCommit({ references: [...refs, { key, label }] });
    setRefInput("");
  };
  const theme = template.theme;
  const setTheme = (p: Partial<ThemeSettings>) => onCommit({ theme: { ...theme, ...p } });
  const page = template.page;
  const setPage = (p: Partial<PageSettings>) => onCommit({ page: { ...page, ...p } });
  const setMargin = (p: Partial<PageSettings["margin"]>) => onCommit({ page: { ...page, margin: { ...page.margin, ...p } } });

  return (
    <div className="mx-auto max-w-2xl space-y-5 p-8">
      <Card title="Template metadata" subtitle="Used for search, organisation, and document filing.">
        <Field label="Name"><input value={template.name} onChange={(e) => onCommit({ name: e.target.value })} className={inputCls} /></Field>
        <Field label="Description"><textarea value={template.description ?? ""} rows={3} onChange={(e) => onCommit({ description: e.target.value })} className={cn(inputCls, "h-auto py-2 resize-none")} /></Field>
        <Field label="Document type">
          <select value={template.document_type_id ?? ""} onChange={(e) => onCommit({ document_type_id: e.target.value })} className={inputCls}>
            <option value="">Select document type</option>
            {documentTypes.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
        </Field>
        <Field label="Tags">
          <div className="flex gap-2">
            <input value={tagInput} onChange={(e) => setTagInput(e.target.value)} onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), addTag())} placeholder="Add tag and press Enter" className={cn(inputCls, "flex-1")} />
            <button onClick={addTag} className="h-9 px-3 bg-[#287EAD] text-white text-sm font-semibold hover:bg-[#1E6F99]"><Plus className="h-4 w-4" /></button>
          </div>
          {(template.tags ?? []).length > 0 && (
            <div className="mt-2 flex flex-wrap gap-2">
              {(template.tags ?? []).map((tag) => (
                <span key={tag} className="flex items-center gap-1.5 border border-[#287EAD]/20 bg-[#EEF6FB] px-2.5 py-1 text-xs font-semibold text-[#287EAD]">
                  <Tag className="h-2.5 w-2.5" />{tag}
                  <button onClick={() => onCommit({ tags: (template.tags ?? []).filter((x) => x !== tag) })} className="ml-0.5 text-[#287EAD]/60 hover:text-[#287EAD]"><Minus className="h-2.5 w-2.5" /></button>
                </span>
              ))}
            </div>
          )}
        </Field>
      </Card>

      <Card title="Page setup">
        <div className="grid grid-cols-2 gap-3">
          <Field label="Size">
            <select value={page.size} onChange={(e) => setPage({ size: e.target.value as PageSettings["size"] })} className={inputCls}>
              <option value="A4">A4</option><option value="Letter">Letter</option><option value="Legal">Legal</option>
            </select>
          </Field>
          <Field label="Orientation">
            <select value={page.orientation} onChange={(e) => setPage({ orientation: e.target.value as PageSettings["orientation"] })} className={inputCls}>
              <option value="portrait">Portrait</option><option value="landscape">Landscape</option>
            </select>
          </Field>
        </div>
        <Field label="Margins (mm)">
          <div className="grid grid-cols-4 gap-2">
            {(["top", "right", "bottom", "left"] as const).map((side) => (
              <div key={side}>
                <input type="number" min={0} max={60} value={page.margin[side]} onChange={(e) => setMargin({ [side]: Number(e.target.value) })} className={cn(inputCls, "text-center")} />
                <p className="mt-1 text-center text-[10px] uppercase tracking-wider text-[#8C969E]">{side}</p>
              </div>
            ))}
          </div>
        </Field>
      </Card>

      <Card title="Typography & colours">
        <div className="grid grid-cols-2 gap-3">
          <Field label="Body font">
            <select value={theme.fontFamily} onChange={(e) => setTheme({ fontFamily: e.target.value })} className={inputCls}>
              {FONT_OPTIONS.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}
            </select>
          </Field>
          <Field label="Heading font">
            <select value={theme.headingFamily} onChange={(e) => setTheme({ headingFamily: e.target.value })} className={inputCls}>
              {FONT_OPTIONS.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}
            </select>
          </Field>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <NumberRow label="Base size" value={theme.baseFontSize} onChange={(n) => setTheme({ baseFontSize: n })} suffix="px" />
          <NumberRow label="Line height" value={theme.lineHeight} onChange={(n) => setTheme({ lineHeight: n })} />
        </div>
        <div className="grid grid-cols-3 gap-3">
          {([["Text", "textColor"], ["Heading", "headingColor"], ["Accent", "accentColor"]] as const).map(([lbl, key]) => (
            <Field key={key} label={lbl}>
              <input type="color" value={theme[key]} onChange={(e) => setTheme({ [key]: e.target.value } as Partial<ThemeSettings>)} className="h-9 w-full border border-[#AEB5BB] bg-white p-1" />
            </Field>
          ))}
        </div>
      </Card>

      <BandEditor title="Header" band={template.header} fields={fields} onChange={(b) => onCommit({ header: b })} />
      <BandEditor title="Footer" band={template.footer} fields={fields} allowPageTokens onChange={(b) => onCommit({ footer: b })} />

      <Card title="Document references" subtitle="Pull data from a related document. The user picks the document at create time; insert {{key}} for its label and {{key__field}} (e.g. supplier, amount) for its data.">
        <div className="flex gap-2">
          <input value={refInput} onChange={(e) => setRefInput(e.target.value)} onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), addRef())} placeholder="e.g. Related Purchase Order" className={cn(inputCls, "flex-1")} />
          <button onClick={addRef} className="h-9 bg-[#287EAD] px-3 text-sm font-semibold text-white hover:bg-[#1E6F99]"><Plus className="h-4 w-4" /></button>
        </div>
        {refs.length > 0 && (
          <div className="mt-2 space-y-1.5">
            {refs.map((r) => (
              <div key={r.key} className="flex items-center justify-between gap-2 border border-[#E5E8EB] px-2.5 py-1.5 text-xs">
                <span className="text-[#1F2933]">{r.label} <span className="ml-1 font-mono text-[10px] text-[#8C969E]">{`{{${r.key}}}`}</span></span>
                <button onClick={() => onCommit({ references: refs.filter((x) => x.key !== r.key) })} className="text-[#8C969E] hover:text-red-600"><Minus className="h-3.5 w-3.5" /></button>
              </div>
            ))}
          </div>
        )}
      </Card>

      <Card title="Merge fields in use">
        <div className="flex flex-wrap gap-2">
          {collectPlaceholders(template).length === 0 && <p className="text-xs text-[#8C969E]">No merge fields used yet.</p>}
          {collectPlaceholders(template).map((p) => (
            <span key={p} className="border border-[#287EAD]/20 bg-[#EEF6FB] px-2 py-1 font-mono text-[11px] text-[#287EAD]">{`{{${p}}}`}</span>
          ))}
        </div>
      </Card>
    </div>
  );
}

/* ============================================================
 * Root component
 * ============================================================ */

type Tab = "design" | "preview" | "settings";

export interface DocumentTemplateDesignerProps {
  initial?: EditableDocumentTemplate | null;
  onSave: (template: DocumentTemplate, stayOpen?: boolean) => void;
  onCancel: () => void;
  isSaving?: boolean;
  /** Document types for filing. Their metadata fields become insertable merge fields. */
  documentTypes?: Array<{
    id: string; name: string; code: string;
    metadata_fields?: Array<{ key?: string; field_key?: string; label: string }>;
  }>;
  /** Merge fields available to insert. Defaults + the doc type's fields if omitted. */
  mergeFields?: MergeField[];
  /** Optional sample values used by the Preview tab. */
  sampleData?: Record<string, string>;
}

export default function DocumentTemplateDesigner({
  initial, onSave, onCancel, isSaving, documentTypes = [], mergeFields, sampleData,
}: DocumentTemplateDesignerProps) {
  const [history, setHistory] = useState<DocumentTemplate[]>([normalizeTemplate(initial ?? initialDocument)]);
  const [cursor, setCursor] = useState(0);
  const template = history[cursor];

  const currentUser = useAuthStore((s) => s.user);

  // Live preview values for formula merge fields — evaluated client-side with the
  // current user (mirrors the form builder preview), so the Preview tab shows real
  // values (your name, today's date) instead of placeholders.
  const formulaSample = useMemo<Record<string, string>>(() => {
    const ctx = { user: currentUser as Parameters<typeof evaluateFormula>[1]["user"], now: new Date() };
    const out: Record<string, string> = {};
    for (const f of Object.values(FORMULAS)) {
      const v = evaluateFormula(f.key, ctx);
      if (v) out[f.key] = v;
    }
    out.document_title = template?.name || "Document title";
    return out;
  }, [currentUser, template?.name]);

  // Available merge fields = caller override, else the auto-fill defaults plus the
  // selected document type's own metadata fields (so admins insert real fields).
  const fields = useMemo<MergeField[]>(() => {
    if (mergeFields && mergeFields.length) return mergeFields;
    const dt = documentTypes.find((t) => t.id === template?.document_type_id);
    const meta: MergeField[] = (dt?.metadata_fields ?? [])
      .map((f) => ({ key: (f.key ?? f.field_key ?? "").trim(), label: f.label, group: "Document fields" }))
      .filter((f) => f.key);
    // Each document-reference field offers its link label + pull-through subfields.
    const refs: MergeField[] = (template?.references ?? []).flatMap((r) => [
      { key: r.key, label: `${r.label} — link label`, group: "Document references" },
      { key: `${r.key}__reference_number`, label: `${r.label} — reference no.`, group: "Document references" },
      { key: `${r.key}__supplier`, label: `${r.label} — supplier`, group: "Document references" },
      { key: `${r.key}__amount`, label: `${r.label} — amount`, group: "Document references" },
      { key: `${r.key}__document_date`, label: `${r.label} — date`, group: "Document references" },
    ]);
    const seen = new Set(DEFAULT_MERGE_FIELDS.map((f) => f.key));
    return [...DEFAULT_MERGE_FIELDS, ...meta.filter((f) => !seen.has(f.key)), ...refs];
  }, [mergeFields, documentTypes, template?.document_type_id, template?.references]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("design");
  const [dragType, setDragType] = useState<BlockType | null>(null);
  const [inspectorOpen, setInspectorOpen] = useState(true);
  const [visible, setVisible] = useState(false);
  const [closing, setClosing] = useState(false);
  const [autoSave, setAutoSave] = useState<boolean>(() =>
    typeof window !== "undefined" && window.localStorage.getItem("dtd:autoSave") === "1");
  const autoSaveSkip = useRef(true);
  const autoSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [lastSavedAt, setLastSavedAt] = useState<number | null>(null);

  useEffect(() => { if (typeof window !== "undefined") window.localStorage.setItem("dtd:autoSave", autoSave ? "1" : "0"); }, [autoSave]);
  useEffect(() => { const id = requestAnimationFrame(() => setVisible(true)); return () => cancelAnimationFrame(id); }, []);
  useEffect(() => {
    setHistory([normalizeTemplate(initial ?? initialDocument)]);
    setCursor(0); setSelectedId(null); autoSaveSkip.current = true;
  }, [initial]);

  const handleCancel = () => { setClosing(true); setTimeout(onCancel, 220); };

  const commit = useCallback((next: DocumentTemplate) => {
    setHistory((h) => [...h.slice(0, cursor + 1), next]);
    setCursor((c) => c + 1);
  }, [cursor]);

  const canUndo = cursor > 0;
  const canRedo = cursor < history.length - 1;

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));

  const onDragStart = (e: DragStartEvent) => {
    const t = e.active.data.current?.blockType as BlockType | undefined;
    if (t) setDragType(t);
  };

  const insertBlock = (block: DocBlock, atIndex: number) => {
    const blocks = [...template.blocks];
    blocks.splice(Math.max(0, Math.min(atIndex, blocks.length)), 0, block);
    commit({ ...template, blocks });
    setSelectedId(block.id);
  };

  const onDragEnd = (e: DragEndEvent) => {
    setDragType(null);
    const { active, over } = e;
    if (!over) return;
    const src = active.data.current;
    const dst = over.data.current;

    if (src?.source === "palette") {
      const block = newBlock(src.blockType as BlockType);
      const idx = dst?.kind === "before" ? (dst.index as number) : template.blocks.length;
      insertBlock(block, idx);
      return;
    }
    if (src?.source === "canvas-block") {
      const fromIdx = template.blocks.findIndex((b) => b.id === src.blockId);
      if (fromIdx < 0) return;
      let toIdx = dst?.kind === "before" ? (dst.index as number) : template.blocks.length;
      const blocks = [...template.blocks];
      const [moved] = blocks.splice(fromIdx, 1);
      if (toIdx > fromIdx) toIdx -= 1;
      blocks.splice(Math.max(0, Math.min(toIdx, blocks.length)), 0, moved);
      commit({ ...template, blocks });
    }
  };

  const updateBlock = (id: string, patch: Partial<DocBlock>) =>
    commit({ ...template, blocks: template.blocks.map((b) => b.id === id ? { ...b, ...patch } : b) });
  const removeBlock = (id: string) => {
    commit({ ...template, blocks: template.blocks.filter((b) => b.id !== id) });
    if (selectedId === id) setSelectedId(null);
  };
  const duplicateBlock = (id: string) => {
    const idx = template.blocks.findIndex((b) => b.id === id);
    if (idx < 0) return;
    const copy: DocBlock = JSON.parse(JSON.stringify(template.blocks[idx]));
    copy.id = uid();
    (copy.columns ?? []).forEach((c) => (c.id = uid()));
    (copy.pairs ?? []).forEach((p) => (p.id = uid()));
    (copy.signatories ?? []).forEach((s) => (s.id = uid()));
    const blocks = [...template.blocks];
    blocks.splice(idx + 1, 0, copy);
    commit({ ...template, blocks });
  };
  const moveBlock = (id: string, dir: "up" | "down") => {
    const idx = template.blocks.findIndex((b) => b.id === id);
    const target = dir === "up" ? idx - 1 : idx + 1;
    if (idx < 0 || target < 0 || target >= template.blocks.length) return;
    const blocks = [...template.blocks];
    [blocks[idx], blocks[target]] = [blocks[target], blocks[idx]];
    commit({ ...template, blocks });
  };

  const handleSave = (stayOpen = false) => {
    if (!template.document_type_id) {
      toast.error("Select a document type before saving (Settings tab).");
      setTab("settings");
      return;
    }
    if (template.blocks.length === 0) {
      toast.error("Add at least one block to the document.");
      return;
    }
    onSave(outputDocumentTemplate(template, Boolean(initial?.id)), stayOpen);
  };

  useEffect(() => {
    if (!autoSave) return;
    if (autoSaveSkip.current) { autoSaveSkip.current = false; return; }
    if (autoSaveTimer.current) clearTimeout(autoSaveTimer.current);
    autoSaveTimer.current = setTimeout(() => {
      if (!template.document_type_id || template.blocks.length === 0) return;
      onSave(outputDocumentTemplate(template, Boolean(initial?.id)), true);
      setLastSavedAt(Date.now());
    }, 1200);
    return () => { if (autoSaveTimer.current) clearTimeout(autoSaveTimer.current); };
  }, [template, autoSave]); // eslint-disable-line react-hooks/exhaustive-deps

  const blockCount = template.blocks.length;

  return (
    <div className={cn("fixed inset-0 z-50 flex h-screen w-full flex-col overflow-hidden transition-all duration-200",
      visible && !closing ? "opacity-100 translate-y-0" : "opacity-0 translate-y-3")}
      style={{ background: "#EDEDED" }}>
      <style>{`@media print { body * { visibility: hidden; } .doc-preview-sheet, .doc-preview-sheet * { visibility: visible; } .doc-preview-sheet { position: absolute; left: 0; top: 0; box-shadow: none !important; } }`}</style>

      {/* Top bar */}
      <header className="flex h-14 shrink-0 items-center justify-between border-b border-[#1E6F99] bg-[#287EAD] px-5 text-white">
        <div className="flex items-center gap-3">
          <button onClick={handleCancel} className="p-1.5 text-white/75 hover:bg-white/10 hover:text-white"><ArrowLeft className="h-4 w-4" /></button>
          <div className="h-5 w-px bg-white/25" />
          <input value={template.name} onChange={(e) => commit({ ...template, name: e.target.value })}
                 className="h-9 w-72 border border-transparent bg-transparent px-2 text-sm font-semibold text-white outline-none hover:border-white/25 focus:border-white/70 focus:bg-white/10" />
          <span className="border border-white/25 bg-white/10 px-2.5 py-0.5 text-[10px] font-semibold text-white/80">
            {template.page.size} · {blockCount} block{blockCount !== 1 ? "s" : ""}
          </span>
          <div className="ml-2 flex items-center gap-2 border border-white/25 bg-white/10 px-2 py-1">
            <span className="text-[11px] font-semibold uppercase tracking-wider text-white/80">AutoSave</span>
            <button onClick={() => setAutoSave((v) => !v)} role="switch" aria-checked={autoSave}
                    className={cn("relative h-5 w-10 rounded-full border transition-colors", autoSave ? "border-emerald-300 bg-emerald-400" : "border-white/40 bg-white/20")}>
              <span className={cn("absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-all", autoSave ? "left-[22px]" : "left-0.5")} />
            </button>
          </div>
          {autoSave && lastSavedAt && <span className="text-[10px] text-white/70">Saved {Math.max(1, Math.round((Date.now() - lastSavedAt) / 1000))}s ago</span>}
        </div>

        <div className="flex h-9 items-center gap-0.5 border border-white/25 bg-white/10 p-0.5">
          {([
            { id: "design", label: "Design", icon: LayoutGrid },
            { id: "preview", label: "Preview", icon: Eye },
            { id: "settings", label: "Settings", icon: Settings },
          ] as const).map((t) => {
            const Icon = t.icon;
            return (
              <button key={t.id} onClick={() => setTab(t.id)}
                      className={cn("flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold transition-all",
                        tab === t.id ? "bg-white text-[#287EAD]" : "text-white/70 hover:bg-white/10 hover:text-white")}>
                <Icon className="h-3.5 w-3.5" />{t.label}
              </button>
            );
          })}
        </div>

        <div className="flex items-center gap-2">
          {tab === "preview" && (
            <button onClick={() => window.print()} className="inline-flex items-center gap-1.5 p-1.5 text-white/75 hover:bg-white/10 hover:text-white" title="Print / PDF">
              <Printer className="h-4 w-4" />
            </button>
          )}
          <div className="flex items-center gap-1">
            <button disabled={!canUndo} onClick={() => setCursor((c) => Math.max(0, c - 1))} title="Undo" className="p-1.5 text-white/70 hover:bg-white/10 hover:text-white disabled:opacity-25"><Undo2 className="h-4 w-4" /></button>
            <button disabled={!canRedo} onClick={() => setCursor((c) => Math.min(history.length - 1, c + 1))} title="Redo" className="p-1.5 text-white/70 hover:bg-white/10 hover:text-white disabled:opacity-25"><Redo2 className="h-4 w-4" /></button>
          </div>
          <div className="h-5 w-px bg-white/25" />
          <button onClick={() => handleSave(false)} disabled={isSaving}
                  className="inline-flex items-center gap-2 border border-white/30 bg-white px-4 py-2 text-sm font-semibold text-[#287EAD] hover:bg-[#EEF6FB] disabled:opacity-50">
            <Save className="h-4 w-4" />{isSaving ? "Saving…" : "Save template"}
          </button>
        </div>
      </header>

      {/* Body */}
      <DndContext sensors={sensors} onDragStart={onDragStart} onDragEnd={onDragEnd}>
        <div className="flex flex-1 overflow-hidden">
          {tab === "design" && (
            <div className="flex flex-1 overflow-hidden animate-in fade-in duration-150">
              <div className="w-[260px] shrink-0"><Palette /></div>
              <main className="relative flex-1 overflow-y-auto" style={{ background: "#EDEDED" }}>
                <Paper template={template} selectedId={selectedId} onSelect={setSelectedId}
                       onRemove={removeBlock} onDuplicate={duplicateBlock} onMove={moveBlock} />
                {!inspectorOpen && (
                  <button onClick={() => setInspectorOpen(true)} title="Open inspector"
                          className="absolute right-4 top-4 flex items-center gap-1.5 border border-[#AEB5BB] bg-white px-3 py-2 text-xs font-semibold text-[#5E6870] shadow-md hover:border-[#287EAD] hover:bg-[#EEF6FB] hover:text-[#287EAD]">
                    <Settings className="h-3.5 w-3.5" /> Inspector
                  </button>
                )}
              </main>
              <div className={cn("shrink-0 overflow-hidden transition-all duration-200", inspectorOpen ? "w-[380px]" : "w-0")}>
                <Inspector template={template} selectedId={selectedId} fields={fields}
                           onUpdateBlock={updateBlock} onCollapse={() => setInspectorOpen(false)} />
              </div>
            </div>
          )}
          {tab === "preview" && (
            <main className="flex-1 overflow-y-auto bg-slate-100 animate-in fade-in duration-150">
              <PreviewTab template={template} fields={fields} sampleData={{ ...formulaSample, ...sampleData }} />
            </main>
          )}
          {tab === "settings" && (
            <main className="flex-1 overflow-y-auto bg-slate-100 animate-in fade-in duration-150">
              <SettingsTab template={template} documentTypes={documentTypes} fields={fields}
                           onCommit={(patch) => commit({ ...template, ...patch })} />
            </main>
          )}
        </div>

        <DragOverlay dropAnimation={{ sideEffects: defaultDropAnimationSideEffects({ styles: { active: { opacity: "0.4" } } }) }}>
          {dragType ? (
            <div className="flex items-center gap-2 rounded-lg border border-[#287EAD] bg-[#287EAD] px-3 py-2 text-sm font-semibold text-white shadow-xl">
              {(() => { const Icon = BLOCK_META[dragType].icon; return <Icon className="h-4 w-4" />; })()}
              {BLOCK_META[dragType].label}
            </div>
          ) : null}
        </DragOverlay>
      </DndContext>
    </div>
  );
}

/* Re-exports for convenience when wiring into the host app. */
export {
  initialDocument as defaultDocumentTemplate,
  normalizeTemplate as normalizeDocumentTemplate,
  outputDocumentTemplate,
  collectPlaceholders,
  DEFAULT_MERGE_FIELDS,
};
