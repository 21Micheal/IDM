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
 *  - Inspector now has "Field Properties" / "Advanced Properties" tabs
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
import { useQueryClient, useMutation } from "@tanstack/react-query";
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
  Sigma, Wrench, Eye as EyeIcon, EyeOff,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { documentTypesAPI } from "@/services/api";

/* ============================================================
 * Types
 * ============================================================ */

export type FieldType =
  | "text" | "textarea" | "number" | "currency" | "date" | "datetime" | "time"
  | "select" | "radio" | "boolean" | "checkbox" | "email" | "phone"
  | "file" | "image" | "table" | "divider" | "heading" | "signature"
  | "reference" | "user" | "multi_select";

export type TableColumnType =
  | "text" | "textarea" | "number" | "currency" | "date" | "datetime" | "time"
  | "select" | "boolean" | "email" | "phone" | "reference" | "user" | "file";

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
  dateFormat?: string;
  referenceSource?: string;    // e.g. "users", "departments", "vendors"
  readonly?: boolean;
  hidden?: boolean;
}

export interface ConditionalRule {
  fieldKey: string;   // sibling field's KEY
  operator: "equals" | "not_equals" | "is_empty" | "is_not_empty";
  value?: string;
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
  currencySymbol?: string;
  dateFormat?: string;
  referenceSource?: string;
  readonly?: boolean;
  hidden?: boolean;
  visibleWhen?: ConditionalRule | null;
}

export interface TemplateSection {
  id: string;
  title: string;
  description?: string;
  fields: TemplateField[];
  collapsible?: boolean;
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
}

export type EditableTemplate = Omit<Template, "type"> & { type?: Template["type"] };

type FieldGroup = "input" | "choice" | "reference" | "advanced" | "layout";

const FIELD_META: Record<FieldType, { label: string; group: FieldGroup; defaults: Partial<TemplateField>; hint?: string }> = {
  text:        { label: "Short text",    group: "input",     defaults: { colSpan: 6, placeholder: "Enter text…" } },
  textarea:    { label: "Long text",     group: "input",     defaults: { colSpan: 12, placeholder: "Write something…" } },
  number:      { label: "Number",        group: "input",     defaults: { colSpan: 4, placeholder: "0" } },
  currency:    { label: "Currency",      group: "input",     defaults: { colSpan: 4, placeholder: "0.00", currencySymbol: "KSh" } },
  date:        { label: "Date",          group: "input",     defaults: { colSpan: 4, dateFormat: "YYYY-MM-DD" } },
  datetime:    { label: "Date & Time",   group: "input",     defaults: { colSpan: 6 } },
  time:        { label: "Time",          group: "input",     defaults: { colSpan: 4 } },
  email:       { label: "Email",         group: "input",     defaults: { colSpan: 6, placeholder: "name@company.com" } },
  phone:       { label: "Phone",         group: "input",     defaults: { colSpan: 4, placeholder: "+254 700 000000" } },
  select:      { label: "Dropdown",      group: "choice",    defaults: { colSpan: 6, options: ["Option 1", "Option 2"] } },
  multi_select:{ label: "Multi-select",  group: "choice",    defaults: { colSpan: 6, options: ["Option 1", "Option 2"] } },
  radio:       { label: "Radio group",   group: "choice",    defaults: { colSpan: 6, options: ["Yes", "No"] } },
  boolean:     { label: "Checkbox",      group: "choice",    defaults: { colSpan: 6 } },
  checkbox:    { label: "Checkbox",      group: "choice",    defaults: { colSpan: 6 } },
  reference:   { label: "Reference",     group: "reference", defaults: { colSpan: 6, referenceSource: "documents" }, hint: "Links to another document/record" },
  user:        { label: "User picker",   group: "reference", defaults: { colSpan: 6, referenceSource: "users" } },
  signature:   { label: "Signature",     group: "advanced",  defaults: { colSpan: 12 } },
  file:        { label: "File upload",   group: "advanced",  defaults: { colSpan: 6 } },
  image:       { label: "Image",         group: "advanced",  defaults: { colSpan: 6 } },
  table:       { label: "Data table",    group: "advanced",  defaults: { colSpan: 12, minRows: 2 } },
  heading:     { label: "Heading",       group: "layout",    defaults: { colSpan: 12, defaultValue: "Section heading" } },
  divider:     { label: "Divider",       group: "layout",    defaults: { colSpan: 12 } },
};

const ICONS: Record<FieldType, React.ElementType> = {
  text: Type, textarea: AlignLeft, number: Hash, currency: Hash,
  date: Calendar, datetime: Calendar, time: Clock, select: List,
  multi_select: List, radio: CircleDot, boolean: CheckSquare, checkbox: CheckSquare,
  signature: Pencil, email: Mail, phone: Phone, file: Paperclip,
  image: ImageIcon, table: Table2, heading: Heading, divider: Minus,
  reference: Link2, user: UserIcon,
};

const uid = () => Math.random().toString(36).slice(2, 10);

function slugify(s: string) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 50);
}

function toDocTypeCode(name: string) {
  return name.toUpperCase().trim().replace(/\s+/g, "_").replace(/[^A-Z0-9_]/g, "").replace(/_+/g, "_").replace(/^_|_$/g, "");
}

/* ============================================================
 * Quick "create document type" modal — unchanged from v2
 * ============================================================ */
const QUICK_TITLE_FIELD_OPTIONS = [
  { key: "filename",         label: "File name (default)" },
  { key: "title",            label: "Document Name" },
  { key: "reference_number", label: "Reference Number" },
  { key: "supplier",         label: "Supplier / Vendor" },
  { key: "amount",           label: "Amount" },
  { key: "document_date",    label: "Document Date" },
];

function CreateDocTypeQuickModal({
  onClose, onCreated,
}: {
  onClose: () => void;
  onCreated: (type: { id: string; name: string; code: string }) => void;
}) {
  const qc = useQueryClient();
  const [dname, setDname]           = useState("");
  const [code, setCode]             = useState("");
  const [refPrefix, setRefPrefix]   = useState("");
  const [refPadding, setRefPadding] = useState(5);
  const [titleField, setTitleField] = useState("filename");
  const [desc, setDesc]             = useState("");

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
      toast.success(`Document type "${dname}" created`);
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
  if (c.defaultValue) return c.defaultValue;
  switch (t) {
    case "number":   return "0";
    case "currency": return `${c.currencySymbol ?? "KSh"} 0.00`;
    case "date":     return c.dateFormat ?? "YYYY-MM-DD";
    case "datetime": return "YYYY-MM-DD HH:mm";
    case "time":     return "HH:mm";
    case "select":   return c.options?.[0] ? `${c.options[0]} ▾` : "Select… ▾";
    case "boolean":  return "☐";
    case "email":    return "name@example.com";
    case "phone":    return "+254 …";
    case "reference":return `↗ ${c.referenceSource ?? "record"}`;
    case "user":     return "👤 user";
    case "file":     return "📎 file";
    case "textarea": return "Long text…";
    default:         return "—";
  }
}

function newColumn(type: TableColumnType = "text", label = "New Column"): TableColumn {
  return {
    id: uid(),
    key: `${slugify(label)}_${uid().slice(0, 4)}`,
    label,
    type,
    width: 2,
    options: type === "select" ? ["Option 1", "Option 2"] : undefined,
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
    base.minRows = 2;
    base.columns = [
      newColumn("select",   "Expense Category"),
      newColumn("text",     "Other Category"),
      newColumn("number",   "Days"),
      newColumn("currency", "DSA Amount"),
      newColumn("currency", "Amount"),
      newColumn("currency", "Actual Amount"),
      newColumn("text",     "Warning"),
      newColumn("textarea", "Note"),
      newColumn("file",     "Attachments"),
    ];
    // pre-seed common option list for the first dropdown
    if (base.columns[0]) base.columns[0].options = ["Hotel", "Transport", "Meal", "Air Ticket", "Others"];
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
  sections: [
    {
      id: uid(),
      title: "Header",
      description: "Basic identifying information for this document.",
      fields: [
        { ...newField("text"),   label: "Staff Name",        key: "staff_name",     colSpan: 4, required: true },
        { ...newField("text"),   label: "Purpose of Travel", key: "purpose",        colSpan: 4 },
        { ...newField("date"),   label: "Travel Start Date", key: "travel_start",   colSpan: 2, required: true },
        { ...newField("date"),   label: "Travel End Date",   key: "travel_end",     colSpan: 2, required: true },
      ],
    },
    {
      id: uid(),
      title: "Expenditure",
      description: "Itemized breakdown.",
      fields: [
        { ...newField("table"), label: "Expense Items", key: "items" },
      ],
    },
  ],
};

function normalizeField(field: TemplateField): TemplateField {
  const type = field.type === "checkbox" ? "boolean" : field.type;
  const colSpan = field.colSpan ?? field.width ?? 6;
  const helpText = field.helpText ?? field.help_text;
  const key = field.key || `field_${uid()}`;
  const columns = (field.type === "table" || type === "table")
    ? (field.columns ?? [newColumn("text", "Item"), newColumn("number", "Amount")])
    : field.columns;
  return { ...field, type, key, colSpan, width: colSpan, helpText, columns };
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
      fields: Array.isArray(s.fields) ? s.fields.map(normalizeField) : [],
    })),
  };
}

function outputTemplate(template: Template, keepId: boolean): Template {
  const out = {
    ...template,
    type: template.type ?? "built",
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
  { key: "input",     label: "Input" },
  { key: "choice",    label: "Choice / Dropdown" },
  { key: "reference", label: "Reference" },
  { key: "advanced",  label: "Advanced" },
  { key: "layout",    label: "Layout" },
];

function Palette() {
  const [query, setQuery] = useState("");
  const [openGroups, setOpenGroups] = useState<Record<FieldGroup, boolean>>({
    input: true, choice: true, reference: false, advanced: false, layout: false,
  });
  const all = Object.keys(FIELD_META) as FieldType[];
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
                <span className="rounded bg-[#E5E8EB] px-1.5 py-0.5 text-[10px] font-semibold text-[#5E6870]">{items.length}</span>
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
  const inputPreview = "h-8 rounded border border-zinc-200 bg-white px-3 text-xs text-zinc-400 flex items-center";
  switch (field.type) {
    case "heading":
      return <div className="text-sm font-bold text-zinc-800">{field.label || "Heading"}</div>;
    case "divider":
      return <div className="h-px w-full bg-zinc-200 my-1" />;
    case "textarea":
      return <div className="h-14 rounded border border-zinc-200 bg-white px-3 py-2 text-xs text-zinc-400">{field.placeholder || "Long text…"}</div>;
    case "boolean":
    case "checkbox":
      return (
        <label className="flex items-center gap-2 text-xs text-zinc-700">
          <span className="h-3.5 w-3.5 rounded border border-zinc-300 bg-white flex-shrink-0" />
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
      return <div className={cn(inputPreview, "justify-between")}><span className="flex items-center gap-1.5"><Link2 className="h-3 w-3"/> Choose {field.referenceSource ?? "record"}…</span></div>;
    case "user":
      return <div className={cn(inputPreview, "justify-between")}><span className="flex items-center gap-1.5"><UserIcon className="h-3 w-3"/> Select user…</span></div>;
    case "table": {
      const cols = field.columns ?? [];
      return (
        <div className="rounded-lg border border-[#C8CDD2] overflow-hidden bg-white shadow-sm">
          {/* Header bar */}
          <div className="flex items-center justify-between gap-2 border-b border-[#C8CDD2] bg-[#EEF6FB] px-3 py-1.5">
            <div className="flex items-center gap-1.5">
              <Table2 className="h-3.5 w-3.5 text-[#287EAD]" />
              <span className="text-[11px] font-semibold text-[#287EAD]">
                Data table — {cols.length} column{cols.length !== 1 ? "s" : ""}
              </span>
            </div>
            <button
              onClick={(e) => { e.stopPropagation(); onAddColumn?.(); }}
              className="flex items-center gap-1 rounded border border-[#287EAD]/40 bg-white px-2 py-0.5 text-[10px] font-semibold text-[#287EAD] hover:bg-[#287EAD] hover:text-white transition-colors"
              title="Add column"
            >
              <Plus className="h-3 w-3" /> Add column
            </button>
          </div>
          {/* Scrollable table area */}
          <div className="overflow-x-auto">
            <div className="min-w-max">
              {/* Column headers */}
              <div className="flex border-b border-[#C8CDD2] bg-[#F3F5F6]">
                {cols.map((c, idx) => {
                  const ColIcon = ({
                    text: Type, textarea: AlignLeft, number: Hash, currency: Hash,
                    date: Calendar, datetime: Calendar, time: Clock, select: List,
                    boolean: CheckSquare, email: Mail, phone: Phone, reference: Link2,
                    user: UserIcon, file: Paperclip,
                  } as Record<TableColumnType, React.ElementType>)[(c.type ?? "text") as TableColumnType] ?? Type;
                  return (
                    <div
                      key={c.id}
                      onClick={(e) => { e.stopPropagation(); onConfigureColumn?.(c.id); }}
                      className="group/col w-[200px] flex-shrink-0 border-r border-[#C8CDD2] last:border-0 cursor-pointer hover:bg-[#D6EAF5] transition-colors"
                      title="Click to configure column"
                    >
                      <div className="flex items-center gap-1.5 px-3 py-2.5">
                        <ColIcon className="h-3 w-3 flex-shrink-0 text-[#287EAD]" />
                        <input
                          value={c.label}
                          onClick={(e) => e.stopPropagation()}
                          onChange={(e) => onUpdateColumn?.(c.id, { label: e.target.value })}
                          className="min-w-0 flex-1 truncate bg-transparent text-xs font-semibold text-[#1F2933] outline-none focus:bg-white focus:px-1 focus:rounded"
                        />
                        {c.required && <span className="text-red-500 flex-shrink-0 text-[10px]">*</span>}
                      </div>
                      {/* Column actions on hover */}
                      <div className="flex items-center gap-0.5 px-3 pb-1.5 opacity-0 transition group-hover/col:opacity-100">
                        <button onClick={(e) => { e.stopPropagation(); onConfigureColumn?.(c.id); }} title="Configure"
                                className="rounded p-0.5 text-[#5E6870] hover:bg-[#287EAD]/10 hover:text-[#287EAD]">
                          <Wrench className="h-3 w-3" />
                        </button>
                        <button onClick={(e) => { e.stopPropagation(); onMoveColumn?.(c.id, "left"); }} disabled={idx === 0}
                                title="Move left" className="rounded p-0.5 text-[#5E6870] hover:bg-[#287EAD]/10 disabled:opacity-20">
                          <ChevronUp className="h-3 w-3 -rotate-90" />
                        </button>
                        <button onClick={(e) => { e.stopPropagation(); onMoveColumn?.(c.id, "right"); }} disabled={idx === (cols.length) - 1}
                                title="Move right" className="rounded p-0.5 text-[#5E6870] hover:bg-[#287EAD]/10 disabled:opacity-20">
                          <ChevronDown className="h-3 w-3 -rotate-90" />
                        </button>
                        <button onClick={(e) => { e.stopPropagation(); onRemoveColumn?.(c.id); }} title="Remove"
                                className="rounded p-0.5 text-[#5E6870] hover:bg-red-50 hover:text-red-500">
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
                      className="w-[200px] flex-shrink-0 px-3 py-2 text-xs text-[#8C969E] border-r border-[#E5E8EB] last:border-0 cursor-pointer hover:bg-[#EEF6FB] hover:text-[#287EAD] transition-colors truncate"
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
      return <div className="flex h-10 items-center justify-center rounded border border-dashed border-zinc-200 bg-zinc-50 text-xs text-zinc-400"><Paperclip className="h-3 w-3 mr-1.5" />Attach file</div>;
    case "signature":
      return <div className="flex h-12 items-center justify-center rounded border border-dashed border-zinc-200 bg-zinc-50 text-xs text-zinc-400"><Pencil className="h-3 w-3 mr-1.5" />Signature</div>;
    case "currency":
      return <div className={cn(inputPreview, "gap-1")}><span className="text-zinc-500">{field.currencySymbol ?? "KSh"}</span>{field.placeholder || "0.00"}</div>;
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
}: {
  field: TemplateField; sectionId: string; isSelected: boolean;
  onSelect: () => void; onRemove: () => void; onDuplicate: () => void;
  onResize: (col: number) => void; rowWidth: number;
  onConfigureColumn: (colId: string) => void;
  onAddColumn: () => void;
  onRemoveColumn: (colId: string) => void;
  onMoveColumn: (colId: string, dir: "left" | "right") => void;
  onUpdateColumn: (colId: string, patch: Partial<TableColumn>) => void;
}) {
  const dropBefore = useDroppable({ id: `drop-before-${sectionId}-${field.id}`, data: { source: "canvas", kind: "before", sectionId, fieldId: field.id } });
  const dropAfter  = useDroppable({ id: `drop-after-${sectionId}-${field.id}`,  data: { source: "canvas", kind: "after",  sectionId, fieldId: field.id } });
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
    <div className={cn("relative flex items-stretch", isDragging && "opacity-40")}
         style={{ gridColumn: `span ${field.type === "table" ? 12 : (field.colSpan ?? 1)} / span ${field.type === "table" ? 12 : (field.colSpan ?? 1)}` }}>
      <div ref={dropBefore.setNodeRef}
           className={cn("w-1 shrink-0 rounded-full transition-all", dropBefore.isOver ? "bg-[#287EAD]" : "bg-transparent")} />
      <div onClick={(e) => { e.stopPropagation(); onSelect(); }}
           className={cn(
             "group relative flex-1 rounded-lg border bg-white p-3 transition-all cursor-pointer",
             isSelected ? "border-[#287EAD] ring-2 ring-[#287EAD]/20 shadow-sm" : "border-slate-200 hover:border-[#287EAD]/60 hover:shadow-sm",
           )}>
        <div className="mb-2 flex items-center justify-between gap-2">
          <div ref={setDragRef} {...listeners} {...attributes}
               className="flex items-center gap-1.5 text-xs font-semibold text-slate-700 cursor-grab active:cursor-grabbing flex-1 min-w-0 overflow-hidden">
            <GripVertical className="h-3.5 w-3.5 text-slate-300 flex-shrink-0" />
            <span className="truncate min-w-0 flex-1" title={field.label}>{field.label || <em className="font-normal text-slate-400">Unlabelled</em>}</span>
            {field.required && <span className="text-red-500 flex-shrink-0">*</span>}
            <span className="ml-1 rounded bg-[#EEF6FB] px-1.5 py-0.5 text-[9px] uppercase tracking-wider text-[#287EAD] flex-shrink-0 border border-[#287EAD]/20">
              {FIELD_META[field.type]?.label ?? field.type}
            </span>
            {field.visibleWhen && (
              <span className="rounded bg-amber-50 px-1.5 py-0.5 text-[9px] font-semibold text-amber-700 border border-amber-200 flex-shrink-0" title={`Show when ${field.visibleWhen.fieldKey} ${field.visibleWhen.operator} ${field.visibleWhen.value ?? ""}`}>cond</span>
            )}
          </div>
          <div className="flex items-center gap-0.5 opacity-0 transition group-hover:opacity-100 flex-shrink-0">
            <button onClick={(e) => { e.stopPropagation(); onDuplicate(); }} title="Duplicate"
                    className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700">
              <Copy className="h-3 w-3" />
            </button>
            <button onClick={(e) => { e.stopPropagation(); onRemove(); }} title="Remove"
                    className="rounded p-1 text-slate-400 hover:bg-red-50 hover:text-red-500">
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
               className="absolute right-0 top-0 h-full w-1.5 cursor-col-resize rounded-r-lg opacity-0 transition group-hover:bg-[#287EAD]/40 group-hover:opacity-100"
               title="Drag to resize" />
        )}
      </div>
      <div ref={dropAfter.setNodeRef}
           className={cn("w-1 shrink-0 rounded-full transition-all", dropAfter.isOver ? "bg-[#287EAD]" : "bg-transparent")} />
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
           "col-span-12 flex h-11 items-center justify-center rounded-lg border-2 border-dashed text-xs font-medium transition",
           isOver ? "border-[#287EAD] bg-[#EEF6FB] text-[#287EAD]" : "border-slate-200 text-slate-400 hover:border-[#287EAD]/60",
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
               "rounded-xl border-2 bg-white shadow-sm transition-all overflow-hidden",
               isSelected ? "border-[#287EAD] ring-2 ring-[#287EAD]/20" : "border-[#C8CDD2] hover:border-[#287EAD]/50",
             )}>
      <header className="flex items-start gap-3 border-b border-[#D0D5DA] bg-[#F3F5F6] px-5 py-3.5">
        <div className="flex flex-col gap-0.5 mt-1 flex-shrink-0">
          <button onClick={(e) => { e.stopPropagation(); props.onMoveSection(section.id, "up"); }} disabled={props.isFirst}
                  className="rounded p-0.5 text-slate-500 hover:bg-white hover:text-slate-800 disabled:opacity-20 transition-colors">
            <ChevronUp className="h-3.5 w-3.5" />
          </button>
          <button onClick={(e) => { e.stopPropagation(); props.onMoveSection(section.id, "down"); }} disabled={props.isLast}
                  className="rounded p-0.5 text-slate-500 hover:bg-white hover:text-slate-800 disabled:opacity-20 transition-colors">
            <ChevronDown className="h-3.5 w-3.5" />
          </button>
        </div>
        <div className="flex-1 min-w-0">
          <input value={section.title}
                 onChange={(e) => props.onUpdateSection(section.id, { title: e.target.value })}
                 onClick={(e) => e.stopPropagation()}
                 className="w-full bg-transparent text-sm font-bold text-[#1F2933] outline-none border-b border-transparent focus:border-[#287EAD] pb-0.5 transition-colors" />
          <input value={section.description ?? ""}
                 placeholder="Add a description…"
                 onChange={(e) => props.onUpdateSection(section.id, { description: e.target.value })}
                 onClick={(e) => e.stopPropagation()}
                 className="mt-1 w-full bg-transparent text-xs text-[#5E6870] outline-none placeholder:text-[#AEB5BB] border-b border-transparent focus:border-[#AEB5BB] pb-0.5 transition-colors" />
        </div>
        <button onClick={(e) => { e.stopPropagation(); setCollapsed((c) => !c); }}
                title={collapsed ? "Expand" : "Collapse"}
                className="rounded-md p-1.5 text-slate-500 hover:bg-white hover:text-slate-800 transition-colors flex-shrink-0">
          {collapsed ? <ChevronDown className="h-4 w-4" /> : <ChevronUp className="h-4 w-4" />}
        </button>
        <button onClick={(e) => { e.stopPropagation(); props.onRemoveSection(section.id); }}
                className="rounded-md p-1.5 text-slate-500 hover:bg-red-50 hover:text-red-600 transition-colors flex-shrink-0"
                title="Remove section">
          <Trash2 className="h-4 w-4" />
        </button>
      </header>
      {!collapsed && (
        <div className="p-5">
          <div ref={gridRef} className="grid grid-cols-12 gap-3">
            {section.fields.map((f) => (
              <FieldCard key={f.id} field={f} sectionId={section.id}
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
          onConfigureColumn={props.onConfigureColumn}
          onAddColumn={props.onAddColumn}
          onRemoveColumn={props.onRemoveColumn}
          onMoveColumn={props.onMoveColumn}
          onUpdateColumn={props.onUpdateColumn}
        />
      ))}
      <button onClick={(e) => { e.stopPropagation(); props.onAddSection(); }}
              className="flex items-center justify-center gap-2 rounded-xl border-2 border-dashed border-slate-200 bg-white py-5 text-sm font-semibold text-slate-400 transition hover:border-[#287EAD] hover:bg-[#EEF6FB] hover:text-[#287EAD]">
        <Plus className="h-4 w-4" /> Add Section
      </button>
    </div>
  );
}

/* ============================================================
 * Column Configuration Modal (UniFi-style)
 * ============================================================ */

const COL_TYPES: Array<{ value: TableColumnType; label: string }> = [
  { value: "text",      label: "Text" },
  { value: "textarea",  label: "Long text" },
  { value: "number",    label: "Number" },
  { value: "currency",  label: "Currency" },
  { value: "date",      label: "Date" },
  { value: "datetime",  label: "Date & Time" },
  { value: "time",      label: "Time" },
  { value: "select",    label: "Dropdown" },
  { value: "boolean",   label: "Checkbox" },
  { value: "email",     label: "Email" },
  { value: "phone",     label: "Phone" },
  { value: "reference", label: "Reference" },
  { value: "user",      label: "User picker" },
  { value: "file",      label: "File / Attachment" },
];

function ColumnConfigModal({
  column, onClose, onSave, onDelete,
}: {
  column: TableColumn;
  onClose: () => void;
  onSave: (col: TableColumn) => void;
  onDelete: () => void;
}) {
  const [tab, setTab]   = useState<"field" | "advanced">("field");
  const [draft, setDraft] = useState<TableColumn>({ ...column });

  const set = (patch: Partial<TableColumn>) => setDraft((d) => ({ ...d, ...patch }));
  const isDropdown = draft.type === "select";
  const isNumeric  = draft.type === "number" || draft.type === "currency";
  const isText     = draft.type === "text" || draft.type === "textarea" || draft.type === "email" || draft.type === "phone";

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
                <input className={iCls} value={draft.label} onChange={(e) => set({ label: e.target.value })} />
              </Row>
              <Row label="ID">
                <input className={cn(iCls, "font-mono")} value={draft.key} onChange={(e) => set({ key: slugify(e.target.value) || draft.key })} />
              </Row>
              <Row label="Type">
                <select value={draft.type ?? "text"}
                        onChange={(e) => set({ type: e.target.value as TableColumnType })}
                        className={iCls}>
                  {COL_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
                </select>
              </Row>
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
              {draft.type === "currency" && (
                <Row label="Currency symbol"><input className={iCls} value={draft.currencySymbol ?? "KSh"} onChange={(e) => set({ currencySymbol: e.target.value })} /></Row>
              )}
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
                <Row label="Reference source"><input className={iCls} value={draft.referenceSource ?? ""} onChange={(e) => set({ referenceSource: e.target.value })} placeholder="users, documents, departments…" /></Row>
              )}
              <div className="flex items-center gap-6 pt-2">
                <label className="flex items-center gap-2 text-sm text-[#1F2933]">
                  <input type="checkbox" checked={!!draft.readonly} onChange={(e) => set({ readonly: e.target.checked })} className="h-4 w-4 accent-[#287EAD]" />
                  Read-only
                </label>
                <label className="flex items-center gap-2 text-sm text-[#1F2933]">
                  <input type="checkbox" checked={!!draft.hidden} onChange={(e) => set({ hidden: e.target.checked })} className="h-4 w-4 accent-[#287EAD]" />
                  Hidden in preview
                </label>
              </div>
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

function Row({ label, required, children }: { label: string; required?: boolean; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[180px_1fr] items-start gap-4">
      <label className="pt-2 text-sm font-medium text-[#1F2933]">
        {label}{required && <span className="ml-0.5 text-red-500">*</span>}
      </label>
      <div>{children}</div>
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
      <div className="flex items-center border-b border-[#C8CDD2] bg-[#EEF6FB] px-3 py-2">
        <span className="text-xs font-semibold uppercase tracking-wider text-[#287EAD]">Values</span>
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

function FieldEditor({ field, onUpdate, allFields }: {
  field: TemplateField;
  onUpdate: (patch: Partial<TemplateField>) => void;
  allFields: TemplateField[];
}) {
  const [tab, setTab] = useState<"field" | "advanced">("field");
  const hasOptions = field.type === "select" || field.type === "radio" || field.type === "multi_select";
  const isTable    = field.type === "table";
  const isLayout   = field.type === "divider" || field.type === "heading";
  const isNumeric  = field.type === "number" || field.type === "currency";
  const isText     = field.type === "text" || field.type === "textarea" || field.type === "email" || field.type === "phone";

  const keyDuplicate = allFields.filter((f) => f.id !== field.id && f.key === field.key).length > 0;
  const siblings = allFields.filter((f) => f.id !== field.id && f.key);

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
              <input className={inputCls} value={field.label} onChange={(e) => onUpdate({ label: e.target.value })} />
            </InspectorRow>
          )}
          <InspectorRow label="Field Key" hint="Used as the variable name in generated documents">
            <input
              className={cn(inputCls, keyDuplicate && "border-red-500 focus:border-red-500 focus:ring-red-500/20", "font-mono")}
              value={field.key}
              onChange={(e) => onUpdate({ key: slugify(e.target.value) || field.key })}
            />
            {keyDuplicate && (
              <div className="flex items-center gap-1.5 text-xs text-red-500 mt-1">
                <AlertCircle className="h-3 w-3" /> Duplicate key — must be unique
              </div>
            )}
          </InspectorRow>
          {!["heading", "divider", "checkbox", "boolean", "table", "file", "image", "signature"].includes(field.type) && (
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
          {!isLayout && !isTable && (
            <div className="flex items-center gap-6">
              <label className="flex cursor-pointer items-center gap-2.5 text-sm text-[#1F2933]">
                <input type="checkbox" checked={!!field.required} onChange={(e) => onUpdate({ required: e.target.checked })}
                       className="h-4 w-4 border-[#AEB5BB] accent-[#287EAD]" />
                Required
              </label>
              <label className="flex cursor-pointer items-center gap-2.5 text-sm text-[#1F2933]">
                <input type="checkbox" checked={!!field.readonly} onChange={(e) => onUpdate({ readonly: e.target.checked })}
                       className="h-4 w-4 border-[#AEB5BB] accent-[#287EAD]" />
                Read-only
              </label>
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
          {(field.type === "reference" || field.type === "user") && (
            <InspectorRow label="Reference source">
              <input className={inputCls} value={field.referenceSource ?? ""} onChange={(e) => onUpdate({ referenceSource: e.target.value })} placeholder="users, documents, departments…" />
            </InspectorRow>
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
          {field.type === "currency" && (
            <InspectorRow label="Currency symbol">
              <input className={inputCls} value={field.currencySymbol ?? "KSh"} onChange={(e) => onUpdate({ currencySymbol: e.target.value })} />
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
          <InspectorRow label="Conditional visibility" hint="Show this field only when another field matches">
            <div className="space-y-2 border border-[#C8CDD2] bg-white p-2.5">
              <select className={inputCls}
                      value={field.visibleWhen?.fieldKey ?? ""}
                      onChange={(e) => onUpdate({
                        visibleWhen: e.target.value
                          ? { fieldKey: e.target.value, operator: field.visibleWhen?.operator ?? "equals", value: field.visibleWhen?.value }
                          : null,
                      })}>
                <option value="">Always visible</option>
                {siblings.map((s) => <option key={s.id} value={s.key}>{s.label} ({s.key})</option>)}
              </select>
              {field.visibleWhen && (
                <div className="grid grid-cols-2 gap-2">
                  <select className={inputCls} value={field.visibleWhen.operator}
                          onChange={(e) => onUpdate({ visibleWhen: { ...field.visibleWhen!, operator: e.target.value as ConditionalRule["operator"] } })}>
                    <option value="equals">equals</option>
                    <option value="not_equals">not equals</option>
                    <option value="is_empty">is empty</option>
                    <option value="is_not_empty">is not empty</option>
                  </select>
                  {(field.visibleWhen.operator === "equals" || field.visibleWhen.operator === "not_equals") && (
                    <input className={inputCls} value={field.visibleWhen.value ?? ""}
                           onChange={(e) => onUpdate({ visibleWhen: { ...field.visibleWhen!, value: e.target.value } })}
                           placeholder="Value" />
                  )}
                </div>
              )}
            </div>
          </InspectorRow>
          <label className="flex cursor-pointer items-center gap-2.5 text-sm text-[#1F2933]">
            <input type="checkbox" checked={!!field.hidden} onChange={(e) => onUpdate({ hidden: e.target.checked })}
                   className="h-4 w-4 accent-[#287EAD]" />
            Hidden in preview
          </label>
        </>
      )}
    </div>
  );
}

function SectionEditor({ section, onUpdate }: {
  section: TemplateSection;
  onUpdate: (patch: Partial<TemplateSection>) => void;
}) {
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
    </div>
  );
}

function Inspector({ sections, selectedId, onUpdateField, onUpdateSection, onCollapse }: {
  sections: TemplateSection[]; selectedId: string | null;
  onUpdateField: (sectionId: string, fieldId: string, patch: Partial<TemplateField>) => void;
  onUpdateSection: (sectionId: string, patch: Partial<TemplateSection>) => void;
  onCollapse: () => void;
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
          <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed border-[#C8CDD2] bg-white px-6 py-10 text-center">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-[#EEF6FB]">
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
            onUpdate={(patch) => target!.kind === "section" && onUpdateSection(target.section.id, patch)} />
        )}
        {target?.kind === "field" && (
          <FieldEditor field={target.field}
            allFields={allFields}
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
  "h-10 w-full rounded-lg border border-slate-200 bg-white px-3 text-sm outline-none transition " +
  "focus:border-[#287EAD] focus:ring-2 focus:ring-[#287EAD]/15 text-slate-800";

function PreviewColumnInput({ col, value, onChange }: { col: TableColumn; value: string; onChange: (v: string) => void }) {
  const base = "w-full bg-transparent text-sm outline-none text-slate-700 placeholder:text-slate-300 py-1";
  if (col.hidden) return null;
  switch (col.type) {
    case "select":
      return (
        <select value={value} onChange={(e) => onChange(e.target.value)} className={base} disabled={col.readonly}>
          <option value="">—</option>
          {(col.options ?? []).map((o) => <option key={o} value={o}>{o}</option>)}
        </select>
      );
    case "boolean":
      return <input type="checkbox" checked={value === "true"} disabled={col.readonly} onChange={(e) => onChange(e.target.checked ? "true" : "false")} className="h-4 w-4 accent-[#287EAD]" />;
    case "textarea":
      return <textarea rows={1} value={value} disabled={col.readonly} onChange={(e) => onChange(e.target.value)} className={cn(base, "resize-none")} />;
    case "currency":
      return (
        <div className="flex items-center gap-1">
          <span className="text-[10px] text-slate-400">{col.currencySymbol ?? "KSh"}</span>
          <input type="number" step="0.01" min={col.min} max={col.max} disabled={col.readonly} value={value} onChange={(e) => onChange(e.target.value)} className={base} placeholder="0.00" />
        </div>
      );
    case "number":
      return <input type="number" min={col.min} max={col.max} value={value} disabled={col.readonly} onChange={(e) => onChange(e.target.value)} className={base} />;
    case "date":
      return <input type="date" value={value} disabled={col.readonly} onChange={(e) => onChange(e.target.value)} className={base} />;
    case "datetime":
      return <input type="datetime-local" value={value} disabled={col.readonly} onChange={(e) => onChange(e.target.value)} className={base} />;
    case "time":
      return <input type="time" value={value} disabled={col.readonly} onChange={(e) => onChange(e.target.value)} className={base} />;
    case "email":
      return <input type="email" value={value} disabled={col.readonly} onChange={(e) => onChange(e.target.value)} className={base} />;
    case "phone":
      return <input type="tel" value={value} disabled={col.readonly} onChange={(e) => onChange(e.target.value)} className={base} />;
    case "reference":
    case "user":
      return (
        <select value={value} onChange={(e) => onChange(e.target.value)} disabled={col.readonly} className={base}>
          <option value="">Select {col.referenceSource ?? "…"}</option>
          <option value="sample-1">Sample 1</option>
          <option value="sample-2">Sample 2</option>
        </select>
      );
    case "file":
      return <input type="file" disabled={col.readonly} className="text-xs" />;
    default:
      return <input type="text" value={value} disabled={col.readonly} maxLength={col.maxLength} onChange={(e) => onChange(e.target.value)} className={base} />;
  }
}

function PreviewTableField({ field }: { field: TemplateField }) {
  const cols = (field.columns ?? []).filter((c) => !c.hidden);
  const [rows, setRows] = useState<Record<string, string>[]>(
    Array.from({ length: field.minRows ?? 2 }, () => {
      const r: Record<string, string> = {};
      cols.forEach((c) => { if (c.defaultValue) r[c.key] = c.defaultValue; });
      return r;
    })
  );
  const updateCell = (rowIdx: number, key: string, val: string) =>
    setRows((rs) => rs.map((r, i) => i === rowIdx ? { ...r, [key]: val } : r));
  const addRow = () => {
    const r: Record<string, string> = {};
    cols.forEach((c) => { if (c.defaultValue) r[c.key] = c.defaultValue; });
    setRows((rs) => [...rs, r]);
  };
  const removeRow = (idx: number) => setRows((rs) => rs.filter((_, i) => i !== idx));

  return (
    <div className="col-span-12 space-y-2">
      <label className="text-sm font-semibold text-slate-700">{field.label}{field.required && <span className="ml-1 text-red-500">*</span>}</label>
      {field.helpText && <p className="text-xs text-slate-500">{field.helpText}</p>}
      <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-slate-200 bg-slate-50">
              {cols.map((col) => (
                <th key={col.id} className="px-3 py-2.5 text-left text-xs font-semibold text-slate-600 border-r border-slate-100 last:border-0" title={col.tooltip}>
                  {col.label}{col.required && <span className="text-red-400 ml-0.5">*</span>}
                  {col.additionalText && <div className="text-[10px] font-normal text-slate-400">{col.additionalText}</div>}
                </th>
              ))}
              <th className="w-10" />
            </tr>
          </thead>
          <tbody>
            {rows.map((row, rowIdx) => (
              <tr key={rowIdx} className="border-b border-slate-100 last:border-0 hover:bg-slate-50/50 transition-colors">
                {cols.map((col) => (
                  <td key={col.id} className="px-2 py-1 border-r border-slate-100 last:border-0">
                    <PreviewColumnInput col={col} value={row[col.key] ?? ""} onChange={(v) => updateCell(rowIdx, col.key, v)} />
                  </td>
                ))}
                <td className="text-center px-1">
                  {rows.length > 1 && (
                    <button onClick={() => removeRow(rowIdx)} className="text-slate-300 hover:text-red-500 transition-colors p-1 rounded">
                      <Trash2 className="h-3 w-3" />
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <button onClick={addRow} className="flex items-center gap-1.5 text-xs font-semibold text-[#287EAD] hover:text-[#1E6F99] transition-colors">
        <Plus className="h-3.5 w-3.5" /> Add row
      </button>
    </div>
  );
}

function evalVisible(field: TemplateField, values: Record<string, unknown>, allFields: TemplateField[]): boolean {
  if (!field.visibleWhen) return true;
  const sib = allFields.find((f) => f.key === field.visibleWhen!.fieldKey);
  if (!sib) return true;
  const v = values[sib.id];
  const sv = v == null ? "" : String(v);
  switch (field.visibleWhen.operator) {
    case "equals":       return sv === (field.visibleWhen.value ?? "");
    case "not_equals":   return sv !== (field.visibleWhen.value ?? "");
    case "is_empty":     return sv.trim() === "";
    case "is_not_empty": return sv.trim() !== "";
    default:             return true;
  }
}

function PreviewField({ field, register, errors }: {
  field: TemplateField;
  register: UseFormRegister<Record<string, unknown>>;
  errors: FieldErrors<Record<string, unknown>>;
}) {
  if (field.hidden) return null;
  if (field.type === "table") return <PreviewTableField field={field} />;

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

  if (field.type === "heading") return <h3 className="text-base font-bold text-slate-800 border-b border-slate-200 pb-2">{field.label}</h3>;
  if (field.type === "divider") return <hr className="border-slate-200" />;

  const label = field.type !== "boolean" && field.type !== "checkbox" ? (
    <label className="text-sm font-semibold text-slate-700">
      {field.label} {field.required && <span className="text-red-500">*</span>}
      {field.tooltip && <span className="ml-1 text-slate-400" title={field.tooltip}>(?)</span>}
    </label>
  ) : null;

  let control: React.ReactNode = null;
  switch (field.type) {
    case "textarea":
      control = <textarea {...reg} placeholder={field.placeholder} rows={4} disabled={field.readonly}
                          defaultValue={field.defaultValue ?? ""}
                          className={previewInputCls.replace("h-10", "min-h-[100px] py-2.5 resize-none")} />;
      break;
    case "select":
      control = (
        <select {...reg} className={previewInputCls} defaultValue={field.defaultValue ?? ""} disabled={field.readonly}>
          <option value="" disabled>{field.placeholder ?? "Select an option"}</option>
          {(field.options ?? []).map((o) => <option key={o} value={o}>{o}</option>)}
        </select>
      );
      break;
    case "multi_select":
      control = (
        <select {...reg} multiple className={cn(previewInputCls, "h-auto min-h-[80px] py-2")} disabled={field.readonly}>
          {(field.options ?? []).map((o) => <option key={o} value={o}>{o}</option>)}
        </select>
      );
      break;
    case "radio":
      control = (
        <div className="flex flex-col gap-2 pt-1">
          {(field.options ?? []).map((o) => (
            <label key={o} className="flex items-center gap-2.5 text-sm text-slate-700 cursor-pointer">
              <input type="radio" value={o} {...reg} className="h-4 w-4 accent-[#287EAD]" />{o}
            </label>
          ))}
        </div>
      );
      break;
    case "boolean":
    case "checkbox":
      return (
        <label className="flex items-center gap-2.5 text-sm text-slate-700 cursor-pointer">
          <input type="checkbox" {...reg} className="h-4 w-4 rounded border-slate-300 accent-[#287EAD]" />
          {field.label}
          {field.required && <span className="text-red-500">*</span>}
        </label>
      );
    case "currency":
      control = (
        <div className="relative">
          <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm text-slate-400 font-medium">{field.currencySymbol ?? "KSh"}</span>
          <input type="number" step="0.01" {...reg} placeholder="0.00" disabled={field.readonly}
                 defaultValue={field.defaultValue ?? ""} className={cn(previewInputCls, "pl-14")} />
        </div>
      );
      break;
    case "number":
      control = <input type="number" {...reg} placeholder={field.placeholder} disabled={field.readonly} defaultValue={field.defaultValue ?? ""} className={previewInputCls} />;
      break;
    case "email":
      control = <input type="email" {...reg} placeholder={field.placeholder} disabled={field.readonly} defaultValue={field.defaultValue ?? ""} className={previewInputCls} />;
      break;
    case "phone":
      control = <input type="tel" {...reg} placeholder={field.placeholder} disabled={field.readonly} defaultValue={field.defaultValue ?? ""} className={previewInputCls} />;
      break;
    case "date":
      control = <input type="date" {...reg} disabled={field.readonly} defaultValue={field.defaultValue ?? ""} className={previewInputCls} />;
      break;
    case "datetime":
      control = <input type="datetime-local" {...reg} disabled={field.readonly} defaultValue={field.defaultValue ?? ""} className={previewInputCls} />;
      break;
    case "time":
      control = <input type="time" {...reg} disabled={field.readonly} defaultValue={field.defaultValue ?? ""} className={previewInputCls} />;
      break;
    case "reference":
    case "user":
      control = (
        <select {...reg} className={previewInputCls} disabled={field.readonly}>
          <option value="">Select {field.referenceSource ?? "…"}</option>
          <option value="sample-1">Sample 1</option>
          <option value="sample-2">Sample 2</option>
        </select>
      );
      break;
    case "file":
    case "image":
      control = (
        <input type="file" {...reg} accept={field.type === "image" ? "image/*" : undefined} disabled={field.readonly}
               className="block w-full text-sm text-slate-500 file:mr-3 file:rounded-lg file:border-0 file:bg-[#287EAD] file:px-4 file:py-2 file:text-sm file:font-semibold file:text-white hover:file:bg-[#1E6F99]" />
      );
      break;
    case "signature":
      control = <div className="flex h-16 items-center justify-center rounded-lg border-2 border-dashed border-slate-200 text-sm text-slate-400"><Pencil className="h-4 w-4 mr-2" />Click to sign</div>;
      break;
    default:
      control = <input type="text" {...reg} placeholder={field.placeholder} disabled={field.readonly} defaultValue={field.defaultValue ?? ""} className={previewInputCls} />;
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

function Preview({ sections, templateName }: { sections: TemplateSection[]; templateName: string }) {
  const { register, handleSubmit, reset, watch, formState: { errors } } = useForm<Record<string, unknown>>();
  const [submitted, setSubmitted] = useState<Record<string, unknown> | null>(null);
  const values = watch();
  const allFields = sections.flatMap((s) => s.fields);

  if (submitted) {
    return (
      <div className="mx-auto max-w-4xl p-8">
        <div className="rounded-2xl border border-slate-200 bg-white p-8 shadow-sm">
          <div className="mb-6 flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-emerald-100"><CheckCircle2 className="h-5 w-5 text-emerald-600" /></div>
            <div>
              <h2 className="text-lg font-bold text-slate-800">Submission preview</h2>
              <p className="text-sm text-slate-500">This is what would be saved when a user submits the form.</p>
            </div>
          </div>
          <pre className="overflow-auto rounded-xl bg-slate-900 p-5 text-xs text-emerald-400 font-mono leading-relaxed">
            {JSON.stringify(submitted, null, 2)}
          </pre>
          <button onClick={() => { setSubmitted(null); reset(); }}
                  className="mt-5 inline-flex items-center gap-1.5 rounded-xl border border-slate-200 bg-white px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50">
            <RotateCcw className="h-4 w-4" /> Test again
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-4xl p-8">
      <form onSubmit={handleSubmit((d) => setSubmitted(d))} className="space-y-6">
        <header className="pb-4 border-b border-slate-200">
          <h1 className="text-2xl font-bold text-slate-900">{templateName}</h1>
          <p className="mt-1 text-sm text-slate-500">Fill out the form below to preview how end users will experience this template.</p>
        </header>
        {sections.map((s) => (
          <section key={s.id} className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
            <div className="mb-5 pb-4 border-b border-slate-100">
              <h2 className="text-base font-bold text-slate-800">{s.title}</h2>
              {s.description && <p className="mt-0.5 text-sm text-slate-500">{s.description}</p>}
            </div>
            <div className="grid grid-cols-12 gap-4">
              {s.fields.map((f) => {
                if (!evalVisible(f, values, allFields)) return null;
                return (
                  <div key={f.id} style={{ gridColumn: `span ${f.colSpan ?? 12} / span ${f.colSpan ?? 12}` }}>
                    <PreviewField field={f} register={register} errors={errors} />
                  </div>
                );
              })}
            </div>
          </section>
        ))}
        <div className="flex items-center justify-end gap-3 pt-2">
          <button type="button" onClick={() => reset()}
                  className="inline-flex items-center gap-1.5 rounded-xl border border-slate-200 bg-white px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50">
            <RotateCcw className="h-4 w-4" /> Reset
          </button>
          <button type="submit"
                  className="inline-flex items-center gap-1.5 rounded-xl bg-[#287EAD] px-5 py-2 text-sm font-semibold text-white hover:bg-[#1E6F99] shadow-sm">
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

function SettingsTab({ template, onCommit, documentTypes }: {
  template: Template;
  onCommit: (patch: Partial<Template>) => void;
  documentTypes: Array<{ id: string; name: string; code: string }>;
}) {
  const [tagInput, setTagInput]     = useState("");
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
    <div className="mx-auto max-w-2xl space-y-5 p-8">
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
            { label: "Fields",   value: fieldCount },
            { label: "Document type", value: documentTypes.find((type) => type.id === template.document_type_id)?.code ?? "—" },
          ].map((s) => (
            <div key={s.label} className="px-5 py-4 text-center">
              <div className="text-2xl font-bold text-[#287EAD]">{s.value}</div>
              <div className="text-xs text-[#5E6870] mt-0.5 font-medium">{s.label}</div>
            </div>
          ))}
        </div>
      </div>
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

export default function TemplateBuilderV2({ initial, onSave, onCancel, isSaving, documentTypes = [] }: TemplateBuilderV2Props) {
  const [history, setHistory]       = useState<Template[]>([normalizeTemplate(initial ?? initialTemplate)]);
  const [cursor, setCursor]         = useState(0);
  const template = history[cursor];
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [tab, setTab]               = useState<Tab>("form");
  const [dragType, setDragType]     = useState<FieldType | null>(null);
  const [inspectorOpen, setInspectorOpen] = useState(true);
  const [visible, setVisible]       = useState(false);
  const [closing, setClosing]       = useState(false);
  const [configuringColumn, setConfiguringColumn] = useState<{ sectionId: string; fieldId: string; colId: string } | null>(null);
  const [autoSave, setAutoSave] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    return window.localStorage.getItem("tb:autoSave") === "1";
  });
  const autoSaveSkipNext = useRef(true);
  const [lastAutoSavedAt, setLastAutoSavedAt] = useState<number | null>(null);
  const autoSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

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
    setHistory([normalizeTemplate(initial ?? initialTemplate)]);
    setCursor(0);
    setSelectedId(null);
    autoSaveSkipNext.current = true;
  }, [initial]);

  const commit = useCallback((next: Template) => {
    setHistory((h) => [...h.slice(0, cursor + 1), next]);
    setCursor((c) => c + 1);
  }, [cursor]);

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

  const updateField = (sectionId: string, fieldId: string, patch: Partial<TemplateField>) => {
    commit({
      ...template,
      sections: template.sections.map((s) =>
        s.id !== sectionId ? s : { ...s, fields: s.fields.map((f) => f.id === fieldId ? { ...f, ...patch } : f) }
      ),
    });
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
  const removeSection = (sectionId: string) =>
    commit({ ...template, sections: template.sections.filter((s) => s.id !== sectionId) });
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
  const updateColumn = (sectionId: string, fieldId: string, colId: string, patch: Partial<TableColumn>) =>
    mutateColumns(sectionId, fieldId, (cols) => cols.map((c) => c.id === colId ? { ...c, ...patch } : c));

  const fieldCount = useMemo(() => (template?.sections ?? []).reduce((a, s) => a + (s.fields?.length ?? 0), 0), [template]);

  const handleSave = () => {
    const allFields = template.sections.flatMap((s) => s.fields);
    const keys = allFields.map((f) => f.key);
    const dupes = keys.filter((k, i) => keys.indexOf(k) !== i);
    if (dupes.length > 0) {
      toast.error(`Duplicate field keys: ${[...new Set(dupes)].join(", ")}. Each field must have a unique key.`);
      return;
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
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [template, autoSave]);

  /* Configure modal data */
  const configCol = useMemo(() => {
    if (!configuringColumn) return null;
    const sec = template.sections.find((s) => s.id === configuringColumn.sectionId);
    const fld = sec?.fields.find((f) => f.id === configuringColumn.fieldId);
    const col = fld?.columns?.find((c) => c.id === configuringColumn.colId);
    return col ? { ...configuringColumn, column: col } : null;
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
            { id: "form",     label: "Build",    icon: LayoutGrid },
            { id: "preview",  label: "Preview",  icon: Eye },
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
            <button disabled={!canUndo} onClick={() => setCursor((c) => Math.max(0, c - 1))} title="Undo"
                    className="p-1.5 text-white/70 hover:bg-white/10 hover:text-white disabled:opacity-25">
              <Undo2 className="h-4 w-4" />
            </button>
            <button disabled={!canRedo} onClick={() => setCursor((c) => Math.min(history.length - 1, c + 1))} title="Redo"
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
                  onSelect={setSelectedId}
                  onAddSection={addSection}
                  onUpdateSection={updateSection}
                  onRemoveSection={removeSection}
                  onRemoveField={removeField}
                  onDuplicateField={duplicateField}
                  onResizeField={(sid, fid, c) => updateField(sid, fid, { colSpan: c })}
                  onMoveSection={moveSection}
                  onConfigureColumn={(sectionId, fieldId, colId) => setConfiguringColumn({ sectionId, fieldId, colId })}
                  onAddColumn={addColumn}
                  onRemoveColumn={removeColumn}
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
                />
              </div>
            </div>
          )}
          {tab === "preview" && (
            <main key="preview" className="flex-1 overflow-y-auto bg-slate-100 animate-in fade-in duration-150">
              <Preview sections={template.sections} templateName={template.name} />
            </main>
          )}
          {tab === "settings" && (
            <main key="settings" className="flex-1 overflow-y-auto bg-slate-100 animate-in fade-in duration-150">
              <SettingsTab template={template} documentTypes={documentTypes}
                           onCommit={(patch) => commit({ ...template, ...patch })} />
            </main>
          )}
        </div>

        <DragOverlay dropAnimation={{
          sideEffects: defaultDropAnimationSideEffects({ styles: { active: { opacity: "0.4" } } }),
        }}>
          {dragType ? (
            <div className="flex items-center gap-2 rounded-lg border border-[#287EAD] bg-[#287EAD] px-3 py-2 text-sm font-semibold text-white shadow-xl">
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
          onClose={() => setConfiguringColumn(null)}
          onSave={(updated) => {
            updateColumn(configCol.sectionId, configCol.fieldId, configCol.colId, updated);
            setConfiguringColumn(null);
          }}
          onDelete={() => {
            removeColumn(configCol.sectionId, configCol.fieldId, configCol.colId);
            setConfiguringColumn(null);
          }}
        />
      )}
    </div>
  );
}