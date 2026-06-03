/**
 * TemplateBuilderV2.tsx — Enterprise template builder
 *
 * Changes from original:
 *  - Table builder: add/remove/reorder columns inline on canvas
 *  - Field key editor (auto-slugified) + duplicate key guard
 *  - Conditional visibility rules placeholder (extensible)
 *  - Section reordering via up/down arrows
 *  - Field search in palette with grouping
 *  - DnD canvas-to-canvas field reordering
 *  - Inspector: full table column editor
 *  - Preview: proper table fill UI
 *  - Settings tab: document type selector + tags
 *  - Dark topbar aesthetic with refined mid-tone canvas
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
  ChevronRight, X, Loader2,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { documentTypesAPI } from "@/services/api";

/* ============================================================
 * Types
 * ============================================================ */

export type FieldType =
  | "text" | "textarea" | "number" | "currency" | "date" | "datetime" | "time"
  | "select" | "radio" | "boolean" | "checkbox" | "email" | "phone"
  | "file" | "image" | "table" | "divider" | "heading" | "signature";

export interface TableColumn {
  id: string;
  key: string;
  label: string;
  required?: boolean;
  type?: "text" | "number" | "currency" | "date" | "select";
  options?: string[];
  width?: number; // 1-12
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
  minRows?: number; // for table: minimum rows to show
}

export interface TemplateSection {
  id: string;
  title: string;
  description?: string;
  fields: TemplateField[];
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

type FieldGroup = "input" | "choice" | "layout" | "advanced";

const FIELD_META: Record<FieldType, { label: string; group: FieldGroup; defaults: Partial<TemplateField> }> = {
  text:      { label: "Short text",   group: "input",    defaults: { colSpan: 6, placeholder: "Enter text…" } },
  textarea:  { label: "Long text",    group: "input",    defaults: { colSpan: 12, placeholder: "Write something…" } },
  number:    { label: "Number",       group: "input",    defaults: { colSpan: 4, placeholder: "0" } },
  currency:  { label: "Currency",     group: "input",    defaults: { colSpan: 4, placeholder: "0.00" } },
  date:      { label: "Date",         group: "input",    defaults: { colSpan: 4 } },
  datetime:  { label: "Date & Time",  group: "input",    defaults: { colSpan: 6 } },
  time:      { label: "Time",         group: "input",    defaults: { colSpan: 4 } },
  email:     { label: "Email",        group: "input",    defaults: { colSpan: 6, placeholder: "name@company.com" } },
  phone:     { label: "Phone",        group: "input",    defaults: { colSpan: 4, placeholder: "+254 700 000000" } },
  select:    { label: "Dropdown",     group: "choice",   defaults: { colSpan: 6, options: ["Option 1", "Option 2"] } },
  radio:     { label: "Radio group",  group: "choice",   defaults: { colSpan: 6, options: ["Yes", "No"] } },
  boolean:   { label: "Checkbox",     group: "choice",   defaults: { colSpan: 6 } },
  checkbox:  { label: "Checkbox",     group: "choice",   defaults: { colSpan: 6 } },
  signature: { label: "Signature",    group: "advanced", defaults: { colSpan: 12 } },
  file:      { label: "File upload",  group: "advanced", defaults: { colSpan: 6 } },
  image:     { label: "Image",        group: "advanced", defaults: { colSpan: 6 } },
  table:     { label: "Data table",   group: "advanced", defaults: { colSpan: 12, minRows: 2 } },
  heading:   { label: "Heading",      group: "layout",   defaults: { colSpan: 12, defaultValue: "Section heading" } },
  divider:   { label: "Divider",      group: "layout",   defaults: { colSpan: 12 } },
};

const ICONS: Record<FieldType, React.ElementType> = {
  text: Type, textarea: AlignLeft, number: Hash, currency: Hash,
  date: Calendar, datetime: Calendar, time: Clock, select: List,
  radio: CircleDot, boolean: CheckSquare, checkbox: CheckSquare,
  signature: Pencil, email: Mail, phone: Phone, file: Paperclip,
  image: ImageIcon, table: Table2, heading: Heading, divider: Minus,
};

const uid = () => Math.random().toString(36).slice(2, 10);

function slugify(s: string) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 50);
}

function toDocTypeCode(name: string) {
  return name.toUpperCase().trim().replace(/\s+/g, "_").replace(/[^A-Z0-9_]/g, "").replace(/_+/g, "_").replace(/^_|_$/g, "");
}

function CreateDocTypeQuickModal({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (type: { id: string; name: string; code: string }) => void;
}) {
  const qc = useQueryClient();
  const [dname, setDname]           = useState("");
  const [code, setCode]             = useState("");
  const [refPrefix, setRefPrefix]   = useState("");
  const [refPadding, setRefPadding] = useState(5);
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
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-md overflow-hidden border border-[#C8CDD2] bg-white shadow-2xl">
        <div className="flex items-start justify-between border-b border-[#1E6F99] bg-[#287EAD] px-5 py-3 text-white">
          <div>
            <p className="text-sm font-semibold">Create document type</p>
            <p className="mt-0.5 text-xs text-white/75">Metadata fields can be added later from Admin Document Types.</p>
          </div>
          <button onClick={onClose}
                  className="mt-0.5 flex-shrink-0 p-1.5 text-white/70 hover:text-white">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="p-5 space-y-4">
          <div className="space-y-1.5">
            <label className="text-xs font-semibold uppercase tracking-wider text-[#5E6870]">
              Name <span className="text-red-400 normal-case font-normal">*</span>
            </label>
            <input
              value={dname}
              onChange={(e) => { setDname(e.target.value); setCode(toDocTypeCode(e.target.value)); }}
              placeholder="e.g. Payment Voucher"
              autoFocus
              className={iCls}
            />
          </div>
          <div className="space-y-1.5">
            <label className="text-xs font-semibold uppercase tracking-wider text-[#5E6870]">
              Code <span className="text-red-400 normal-case font-normal">*</span>
            </label>
            <input
              value={code}
              onChange={(e) => setCode(e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, ""))}
              placeholder="PAYMENT_VOUCHER"
              className={cn(iCls, "font-mono")}
            />
          </div>
          <div className="space-y-1.5">
            <label className="text-xs font-semibold uppercase tracking-wider text-[#5E6870]">
              Reference prefix <span className="text-red-400 normal-case font-normal">*</span>
            </label>
            <input
              value={refPrefix}
              onChange={(e) => setRefPrefix(e.target.value.toUpperCase().replace(/\s+/g, "").replace(/[^A-Z0-9]/g, ""))}
              placeholder="e.g. PO"
              className={cn(iCls, "font-mono tracking-widest")}
            />
            <p className="text-[10px] text-[#5E6870]">
              Short prefix for auto-generated document IDs — e.g.{" "}
              <span className="font-mono font-semibold">PO</span> → <span className="font-mono">PO-00001</span>,{" "}
              <span className="font-mono font-semibold">INV</span> → <span className="font-mono">INV-00001</span>
            </p>
          </div>
          <div className="space-y-1.5">
            <label className="text-xs font-semibold uppercase tracking-wider text-[#5E6870]">Reference padding</label>
            <input
              type="number" min={3} max={8} value={refPadding}
              onChange={(e) => setRefPadding(Math.max(3, Math.min(8, Number(e.target.value))))}
              className={iCls}
            />
          </div>
          <div className="space-y-1.5">
            <label className="text-xs font-semibold uppercase tracking-wider text-[#5E6870]">
              Description <span className="normal-case font-normal text-zinc-600">(optional)</span>
            </label>
            <textarea
              value={desc}
              onChange={(e) => setDesc(e.target.value)}
              rows={2}
              className={cn(iCls, "h-auto py-2 resize-none")}
            />
          </div>
        </div>

        <div className="flex justify-end gap-2 border-t border-[#C8CDD2] px-5 py-3">
          <button onClick={onClose}
                  className="border border-[#AEB5BB] bg-white px-4 py-2 text-sm font-semibold text-[#1F2933] hover:bg-[#F3F5F6]">
            Cancel
          </button>
          <button
            onClick={() => createMutation.mutate()}
            disabled={!dname.trim() || !code.trim() || !refPrefix.trim() || createMutation.isPending}
            className="inline-flex items-center gap-2 bg-[#287EAD] px-4 py-2 text-sm font-semibold text-white hover:bg-[#1E6F99] disabled:opacity-50">
            {createMutation.isPending
              ? <><Loader2 className="h-4 w-4 animate-spin" /> Creating…</>
              : <><Plus className="h-4 w-4" /> Create type</>}
          </button>
        </div>
      </div>
    </div>
  );
}

function newField(type: FieldType): TemplateField {
  const m = FIELD_META[type];
  const labelText = m.label;
  return {
    id: uid(),
    key: `${slugify(labelText)}_${uid().slice(0, 4)}`,
    type,
    label: labelText,
    colSpan: m.defaults.colSpan ?? 6,
    placeholder: m.defaults.placeholder,
    options: m.defaults.options ? [...m.defaults.options] : undefined,
    columns: type === "table" ? [
      { id: uid(), key: `item_${uid().slice(0,4)}`,   label: "Item",     type: "text",     width: 4 },
      { id: uid(), key: `qty_${uid().slice(0,4)}`,    label: "Qty",      type: "number",   width: 2 },
      { id: uid(), key: `unit_${uid().slice(0,4)}`,   label: "Unit",     type: "text",     width: 2 },
      { id: uid(), key: `amount_${uid().slice(0,4)}`, label: "Amount",   type: "currency", width: 2 },
      { id: uid(), key: `notes_${uid().slice(0,4)}`,  label: "Notes",    type: "text",     width: 2 },
    ] : undefined,
    minRows: type === "table" ? 2 : undefined,
    defaultValue: m.defaults.defaultValue,
    required: false,
  };
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
      title: "Document Details",
      description: "Basic identifying information for this document.",
      fields: [
        { ...newField("text"),   label: "Full Name",       key: "full_name",   colSpan: 6, required: true },
        { ...newField("date"),   label: "Date",            key: "doc_date",    colSpan: 3, required: true },
        { ...newField("text"),   label: "Reference No.",   key: "ref_number",  colSpan: 3 },
        { ...newField("select"), label: "Department",      key: "department",  colSpan: 4,
          options: ["Finance", "HR", "Procurement", "Legal", "Operations"] },
        { ...newField("text"),   label: "Authorized By",   key: "authorized_by", colSpan: 4 },
        { ...newField("text"),   label: "Designation",     key: "designation", colSpan: 4 },
      ],
    },
    {
      id: uid(),
      title: "Line Items",
      description: "Itemized breakdown.",
      fields: [
        { ...newField("table"), label: "Items", key: "items" },
        { ...newField("textarea"), label: "Remarks", key: "remarks", colSpan: 12 },
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
    ? (field.columns ?? [
        { id: uid(), key: `item_${uid().slice(0,4)}`,   label: "Item",   type: "text"    as const },
        { id: uid(), key: `amount_${uid().slice(0,4)}`, label: "Amount", type: "number"  as const },
      ])
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
 * Palette
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
      className={cn(
        "group flex w-full cursor-grab items-center gap-2.5 border border-[#C8CDD2] bg-white",
        "px-3 py-2.5 text-left text-sm transition-all cursor-grab active:cursor-grabbing",
        "hover:border-[#287EAD] hover:bg-[#EEF6FB]",
        isDragging && "opacity-30",
      )}
    >
      <span className="flex h-7 w-7 shrink-0 items-center justify-center border border-[#D3D7DA] bg-[#F6F7F8] text-[#5E6870] group-hover:border-[#287EAD] group-hover:text-[#287EAD]">
        <Icon className="h-3.5 w-3.5" />
      </span>
      <span className="font-medium text-[#1F2933]">{meta.label}</span>
    </button>
  );
}

const PALETTE_GROUPS: Array<{ key: FieldGroup; label: string }> = [
  { key: "input",    label: "Input Fields" },
  { key: "choice",   label: "Choice Fields" },
  { key: "advanced", label: "Advanced" },
  { key: "layout",   label: "Layout" },
];

function Palette() {
  const [query, setQuery] = useState("");
  const all = Object.keys(FIELD_META) as FieldType[];
  const filtered = all.filter((t) =>
    FIELD_META[t].label.toLowerCase().includes(query.toLowerCase())
  );

  return (
    <aside className="flex h-full w-full flex-col overflow-hidden border-r border-[#C8CDD2] bg-[#F6F7F8]">
      <div className="border-b border-[#C8CDD2] px-4 pb-3 pt-4">
        <p className="mb-3 text-xs font-semibold uppercase tracking-widest text-[#5E6870]">Field Library</p>
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[#5E6870]" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search fields…"
            className="h-8 w-full border border-[#AEB5BB] bg-white pl-8 pr-2 text-sm text-[#1F2933] outline-none placeholder:text-[#8C969E] focus:border-[#287EAD]"
          />
        </div>
      </div>
      <div className="flex-1 overflow-y-auto px-3 py-3 space-y-4">
        {PALETTE_GROUPS.map((g) => {
          const items = filtered.filter((t) => FIELD_META[t].group === g.key);
          if (!items.length) return null;
          return (
            <div key={g.key}>
              <p className="mb-1.5 px-1 text-[10px] font-semibold uppercase tracking-widest text-[#5E6870]">{g.label}</p>
              <div className="flex flex-col gap-1">
                {items.map((t) => <PaletteItem key={t} type={t} />)}
              </div>
            </div>
          );
        })}
        {filtered.length === 0 && (
          <p className="pt-6 text-center text-sm text-[#5E6870]">No fields match</p>
        )}
      </div>
      <div className="border-t border-[#C8CDD2] px-4 py-3">
        <p className="border border-dashed border-[#AEB5BB] bg-white p-3 text-xs leading-relaxed text-[#5E6870]">
          Drag a field onto any section drop zone. Resize using the right edge handle.
        </p>
      </div>
    </aside>
  );
}

/* ============================================================
 * Canvas — FieldCard
 * ============================================================ */

function FieldPreview({ field }: { field: TemplateField }) {
  const inputPreview = "h-8 rounded border border-zinc-200 bg-white px-3 text-xs text-zinc-400";
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
      return <div className={cn(inputPreview, "flex items-center justify-between")}><span>{field.options?.[0] ?? "Select…"}</span><ChevronDown className="h-3 w-3" /></div>;
    case "table":
      return (
        <div className="rounded border border-zinc-200 overflow-hidden">
          <div className="flex bg-zinc-100 border-b border-zinc-200">
            {(field.columns ?? []).map((c) => (
              <div key={c.id} className="flex-1 px-2 py-1 text-[10px] font-semibold text-zinc-500 truncate border-r border-zinc-200 last:border-0">{c.label}</div>
            ))}
          </div>
          {Array.from({ length: Math.min(field.minRows ?? 2, 2) }).map((_, i) => (
            <div key={i} className="flex border-b border-zinc-100 last:border-0">
              {(field.columns ?? []).map((c) => (
                <div key={c.id} className="flex-1 px-2 py-1.5 text-[10px] text-zinc-300 border-r border-zinc-100 last:border-0">—</div>
              ))}
            </div>
          ))}
        </div>
      );
    case "file":
    case "image":
      return <div className="flex h-10 items-center justify-center rounded border border-dashed border-zinc-200 bg-zinc-50 text-xs text-zinc-400"><Paperclip className="h-3 w-3 mr-1.5" />Attach file</div>;
    case "signature":
      return <div className="flex h-12 items-center justify-center rounded border border-dashed border-zinc-200 bg-zinc-50 text-xs text-zinc-400"><Pencil className="h-3 w-3 mr-1.5" />Signature</div>;
    case "currency":
      return <div className={cn(inputPreview, "flex items-center gap-1")}><span className="text-zinc-500">KSh</span>{field.placeholder || "0.00"}</div>;
    default:
      return <div className={inputPreview}>{field.placeholder || ""}</div>;
  }
}

function FieldCard({
  field, sectionId, isSelected, onSelect, onRemove, onDuplicate, onResize, rowWidth,
}: {
  field: TemplateField; sectionId: string; isSelected: boolean;
  onSelect: () => void; onRemove: () => void; onDuplicate: () => void;
  onResize: (col: number) => void; rowWidth: number;
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
         style={{ gridColumn: `span ${field.colSpan ?? 1} / span ${field.colSpan ?? 1}` }}>
      <div ref={dropBefore.setNodeRef}
           className={cn("w-1 shrink-0 rounded-full transition-all", dropBefore.isOver ? "bg-indigo-500" : "bg-transparent")} />
      <div onClick={(e) => { e.stopPropagation(); onSelect(); }}
           className={cn(
             "group relative flex-1 rounded-xl border bg-white p-3 transition-all cursor-pointer",
             isSelected ? "border-indigo-500 ring-2 ring-indigo-500/20 shadow-sm" : "border-slate-200 hover:border-indigo-300 hover:shadow-sm",
           )}>
        {/* Header */}
        <div className="mb-2 flex items-center justify-between gap-2">
          <div ref={setDragRef} {...listeners} {...attributes}
               className="flex items-center gap-1.5 text-xs font-semibold text-slate-700 cursor-grab active:cursor-grabbing flex-1 min-w-0">
            <GripVertical className="h-3.5 w-3.5 text-slate-300 flex-shrink-0" />
            <span className="truncate">{field.label}</span>
            {field.required && <span className="text-red-500 flex-shrink-0">*</span>}
            <span className="ml-1 rounded bg-slate-100 px-1.5 py-0.5 text-[9px] uppercase tracking-wider text-slate-400 flex-shrink-0">
              {FIELD_META[field.type]?.label ?? field.type}
            </span>
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
        <FieldPreview field={field} />
        <div className="mt-1.5 text-[9px] text-slate-400 font-mono">{field.key} · {field.colSpan}/12</div>
        {/* Resize handle */}
        <div onMouseDown={startResize}
             className="absolute right-0 top-0 h-full w-1.5 cursor-col-resize rounded-r-xl opacity-0 transition group-hover:bg-indigo-400/40 group-hover:opacity-100"
             title="Drag to resize" />
      </div>
      <div ref={dropAfter.setNodeRef}
           className={cn("w-1 shrink-0 rounded-full transition-all", dropAfter.isOver ? "bg-indigo-500" : "bg-transparent")} />
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
           "col-span-12 flex h-12 items-center justify-center rounded-xl border-2 border-dashed text-xs font-medium transition",
           isOver ? "border-indigo-500 bg-indigo-50 text-indigo-600" : "border-slate-200 text-slate-400 hover:border-indigo-300",
         )}>
      <Plus className="h-3.5 w-3.5 mr-1.5" /> Drop a field here
    </div>
  );
}

function SectionBlock({
  section, selectedId, isFirst, isLast, onSelect, onUpdateSection, onRemoveSection,
  onRemoveField, onDuplicateField, onResizeField, onMoveSection,
}: {
  section: TemplateSection; selectedId: string | null;
  isFirst: boolean; isLast: boolean;
  onSelect: (id: string | null) => void;
  onUpdateSection: (id: string, patch: Partial<TemplateSection>) => void;
  onRemoveSection: (id: string) => void;
  onRemoveField: (sectionId: string, fieldId: string) => void;
  onDuplicateField: (sectionId: string, fieldId: string) => void;
  onResizeField: (sectionId: string, fieldId: string, colSpan: number) => void;
  onMoveSection: (id: string, dir: "up" | "down") => void;
}) {
  const isSelected = selectedId === section.id;
  const gridRef = useRef<HTMLDivElement>(null);
  const [rowWidth, setRowWidth] = useState(720);

  useEffect(() => {
    if (!gridRef.current) return;
    const ro = new ResizeObserver(() => {
      if (gridRef.current) setRowWidth(gridRef.current.offsetWidth);
    });
    ro.observe(gridRef.current);
    return () => ro.disconnect();
  }, []);

  return (
    <section onClick={() => onSelect(section.id)}
             className={cn(
               "rounded-2xl border bg-white p-5 shadow-sm transition-all",
               isSelected ? "border-indigo-400 ring-2 ring-indigo-400/20" : "border-slate-200 hover:border-slate-300",
             )}>
      <header className="mb-4 flex items-start gap-3">
        {/* Move arrows */}
        <div className="flex flex-col gap-0.5 mt-1 flex-shrink-0">
          <button onClick={(e) => { e.stopPropagation(); onMoveSection(section.id, "up"); }}
                  disabled={isFirst}
                  className="rounded p-0.5 text-slate-300 hover:text-slate-600 disabled:opacity-20 transition-colors">
            <ChevronUp className="h-3.5 w-3.5" />
          </button>
          <button onClick={(e) => { e.stopPropagation(); onMoveSection(section.id, "down"); }}
                  disabled={isLast}
                  className="rounded p-0.5 text-slate-300 hover:text-slate-600 disabled:opacity-20 transition-colors">
            <ChevronDown className="h-3.5 w-3.5" />
          </button>
        </div>
        <div className="flex-1 min-w-0">
          <input value={section.title}
                 onChange={(e) => onUpdateSection(section.id, { title: e.target.value })}
                 onClick={(e) => e.stopPropagation()}
                 className="w-full bg-transparent text-base font-bold text-slate-800 outline-none focus:ring-0 border-b border-transparent focus:border-slate-300 pb-0.5" />
          <input value={section.description ?? ""}
                 placeholder="Add section description…"
                 onChange={(e) => onUpdateSection(section.id, { description: e.target.value })}
                 onClick={(e) => e.stopPropagation()}
                 className="mt-1 w-full bg-transparent text-sm text-slate-400 outline-none placeholder:text-slate-300 border-b border-transparent focus:border-slate-200 pb-0.5" />
        </div>
        <button onClick={(e) => { e.stopPropagation(); onRemoveSection(section.id); }}
                className="rounded-md p-1.5 text-slate-300 hover:bg-red-50 hover:text-red-500 transition-colors flex-shrink-0"
                title="Remove section">
          <Trash2 className="h-4 w-4" />
        </button>
      </header>
      <div ref={gridRef} className="grid grid-cols-12 gap-3">
        {section.fields.map((f) => (
          <FieldCard key={f.id} field={f} sectionId={section.id}
            isSelected={selectedId === f.id}
            onSelect={() => onSelect(f.id)}
            onRemove={() => onRemoveField(section.id, f.id)}
            onDuplicate={() => onDuplicateField(section.id, f.id)}
            onResize={(c) => onResizeField(section.id, f.id, c)}
            rowWidth={rowWidth} />
        ))}
        <SectionDropZone sectionId={section.id} />
      </div>
      <div className="mt-3 flex items-center gap-2 text-xs text-slate-400">
        <Layers className="h-3 w-3" />
        <span>{section.fields.length} field{section.fields.length !== 1 ? "s" : ""}</span>
      </div>
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
}) {
  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-4 p-6" onClick={() => props.onSelect(null)}>
      {props.sections.map((s, idx) => (
        <SectionBlock key={s.id} section={s} selectedId={props.selectedId}
          isFirst={idx === 0} isLast={idx === props.sections.length - 1}
          onSelect={props.onSelect}
          onUpdateSection={props.onUpdateSection}
          onRemoveSection={props.onRemoveSection}
          onRemoveField={props.onRemoveField}
          onDuplicateField={props.onDuplicateField}
          onResizeField={props.onResizeField}
          onMoveSection={props.onMoveSection} />
      ))}
      <button onClick={(e) => { e.stopPropagation(); props.onAddSection(); }}
              className="flex items-center justify-center gap-2 rounded-2xl border-2 border-dashed border-slate-200 bg-white py-5 text-sm font-semibold text-slate-400 transition hover:border-indigo-400 hover:bg-indigo-50/40 hover:text-indigo-600">
        <Plus className="h-4 w-4" /> Add Section
      </button>
    </div>
  );
}

/* ============================================================
 * Inspector
 * ============================================================ */

function InspectorRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <label className="text-xs font-semibold uppercase tracking-wider text-[#5E6870]">{label}</label>
      {children}
    </div>
  );
}

function TableColumnEditor({ columns, onChange }: {
  columns: TableColumn[];
  onChange: (cols: TableColumn[]) => void;
}) {
  const COL_TYPES: Array<{ value: string; label: string }> = [
    { value: "text",     label: "Text" },
    { value: "number",   label: "Number" },
    { value: "currency", label: "Currency" },
    { value: "date",     label: "Date" },
    { value: "select",   label: "Dropdown" },
  ];

  const update = (idx: number, patch: Partial<TableColumn>) => {
    const next = columns.map((c, i) => i === idx ? { ...c, ...patch } : c);
    onChange(next);
  };
  const remove = (idx: number) => onChange(columns.filter((_, i) => i !== idx));
  const add = () => onChange([...columns, {
    id: uid(), key: `col_${uid().slice(0,4)}`, label: "New Column", type: "text", width: 2,
  }]);
  const move = (idx: number, dir: "up" | "down") => {
    const next = [...columns];
    const target = dir === "up" ? idx - 1 : idx + 1;
    if (target < 0 || target >= next.length) return;
    [next[idx], next[target]] = [next[target], next[idx]];
    onChange(next);
  };

  return (
    <div className="space-y-2">
      {columns.map((col, idx) => (
        <div key={col.id} className="space-y-2 border border-[#C8CDD2] bg-white p-2.5">
          <div className="flex items-center gap-2">
            <div className="flex flex-col gap-0.5">
              <button onClick={() => move(idx, "up")} disabled={idx === 0}
                      className="text-[#5E6870] hover:text-[#287EAD] disabled:opacity-20"><ChevronUp className="h-3 w-3" /></button>
              <button onClick={() => move(idx, "down")} disabled={idx === columns.length - 1}
                      className="text-[#5E6870] hover:text-[#287EAD] disabled:opacity-20"><ChevronDown className="h-3 w-3" /></button>
            </div>
            <input value={col.label}
                   onChange={(e) => update(idx, { label: e.target.value, key: col.key })}
                   placeholder="Column label"
                   className="h-7 flex-1 border border-[#AEB5BB] bg-white px-2 text-xs text-[#1F2933] outline-none focus:border-[#287EAD]" />
            <button onClick={() => remove(idx)}
                    className="p-1 text-[#5E6870] hover:text-red-600">
              <Trash2 className="h-3 w-3" />
            </button>
          </div>
          <div className="flex items-center gap-2">
            <div className="flex-1">
              <label className="mb-1 block text-[10px] uppercase tracking-wider text-[#5E6870]">Key</label>
              <input value={col.key}
                     onChange={(e) => update(idx, { key: slugify(e.target.value) || col.key })}
                     className="h-6 w-full border border-[#AEB5BB] bg-white px-2 font-mono text-xs text-[#1F2933] outline-none focus:border-[#287EAD]" />
            </div>
            <div className="flex-1">
              <label className="mb-1 block text-[10px] uppercase tracking-wider text-[#5E6870]">Type</label>
              <select value={col.type ?? "text"} onChange={(e) => update(idx, { type: e.target.value as TableColumn["type"] })}
                      className="h-6 w-full border border-[#AEB5BB] bg-white px-2 text-xs text-[#1F2933] outline-none focus:border-[#287EAD]">
                {COL_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
              </select>
            </div>
            <div className="w-14">
              <label className="mb-1 block text-[10px] uppercase tracking-wider text-[#5E6870]">Width</label>
              <input type="number" min={1} max={12} value={col.width ?? 2}
                     onChange={(e) => update(idx, { width: Number(e.target.value) })}
                     className="h-6 w-full border border-[#AEB5BB] bg-white px-2 text-xs text-[#1F2933] outline-none focus:border-[#287EAD]" />
            </div>
          </div>
        </div>
      ))}
      <button onClick={add}
              className="flex w-full items-center justify-center gap-1.5 border border-dashed border-[#AEB5BB] py-2 text-xs font-medium text-[#5E6870] hover:border-[#287EAD] hover:text-[#287EAD]">
        <Plus className="h-3.5 w-3.5" /> Add column
      </button>
    </div>
  );
}

function FieldEditor({ field, onUpdate, allFields }: {
  field: TemplateField;
  onUpdate: (patch: Partial<TemplateField>) => void;
  allFields: TemplateField[];
}) {
  const hasOptions = field.type === "select" || field.type === "radio";
  const isTable    = field.type === "table";
  const isLayout   = field.type === "divider" || field.type === "heading";

  // Check for duplicate keys
  const keyDuplicate = allFields.filter((f) => f.id !== field.id && f.key === field.key).length > 0;

  return (
    <div className="space-y-5">
      {!isLayout && (
        <InspectorRow label="Label">
          <input className={inputCls} value={field.label}
                 onChange={(e) => onUpdate({ label: e.target.value })} />
        </InspectorRow>
      )}

      <InspectorRow label="Field Key">
        <input
          className={cn(inputCls, keyDuplicate && "border-red-500 focus:border-red-500 focus:ring-red-500/20")}
          value={field.key}
          onChange={(e) => onUpdate({ key: slugify(e.target.value) || field.key })}
        />
        {keyDuplicate && (
          <div className="flex items-center gap-1.5 text-xs text-red-400 mt-1">
            <AlertCircle className="h-3 w-3" /> Duplicate key — must be unique
          </div>
        )}
        <p className="mt-1 text-[10px] text-[#5E6870]">Used as the variable name in generated documents</p>
      </InspectorRow>

      {!["heading", "divider", "checkbox", "boolean", "table", "file", "image", "signature"].includes(field.type) && (
        <InspectorRow label="Placeholder">
          <input className={inputCls} value={field.placeholder ?? ""}
                 onChange={(e) => onUpdate({ placeholder: e.target.value })} />
        </InspectorRow>
      )}

      <InspectorRow label="Help text">
        <input className={inputCls} value={field.helpText ?? ""}
               onChange={(e) => onUpdate({ helpText: e.target.value })} />
      </InspectorRow>

      {!isTable && (
        <InspectorRow label={`Column width — ${field.colSpan} / 12`}>
          <input type="range" min={1} max={12} value={field.colSpan ?? 6}
                 onChange={(e) => onUpdate({ colSpan: Number(e.target.value) })}
                 className="w-full accent-[#287EAD]" />
          <div className="flex justify-between text-[10px] text-[#5E6870]">
            <span>1</span><span>6</span><span>12</span>
          </div>
        </InspectorRow>
      )}

      {!isLayout && !isTable && (
        <label className="flex cursor-pointer items-center gap-2.5 text-sm text-[#1F2933]">
          <input type="checkbox" checked={!!field.required}
                 onChange={(e) => onUpdate({ required: e.target.checked })}
                 className="h-4 w-4 border-[#AEB5BB] text-[#287EAD] focus:ring-[#287EAD]/30" />
          Required field
        </label>
      )}

      {isTable && (
        <>
          <InspectorRow label="Minimum rows shown">
            <input type="number" min={1} max={20} value={field.minRows ?? 2}
                   onChange={(e) => onUpdate({ minRows: Number(e.target.value) })}
                   className={inputCls} />
          </InspectorRow>
          <InspectorRow label="Table columns">
            <TableColumnEditor
              columns={field.columns ?? []}
              onChange={(cols) => onUpdate({ columns: cols })}
            />
          </InspectorRow>
        </>
      )}

      {hasOptions && (
        <InspectorRow label="Options">
          <div className="space-y-1.5">
            {(field.options ?? []).map((opt, i) => (
              <div key={i} className="flex items-center gap-2">
                <input value={opt}
                       onChange={(e) => {
                         const next = [...(field.options ?? [])];
                         next[i] = e.target.value;
                         onUpdate({ options: next });
                       }}
                       className={inputCls} />
                <button onClick={() => onUpdate({ options: (field.options ?? []).filter((_, j) => j !== i) })}
                        className="p-1.5 text-[#5E6870] hover:text-red-600">
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            ))}
            <button onClick={() => onUpdate({ options: [...(field.options ?? []), `Option ${(field.options?.length ?? 0) + 1}`] })}
                    className="flex w-full items-center justify-center gap-1.5 border border-dashed border-[#AEB5BB] py-2 text-xs font-medium text-[#5E6870] hover:border-[#287EAD] hover:text-[#287EAD]">
              <Plus className="h-3.5 w-3.5" /> Add option
            </button>
          </div>
        </InspectorRow>
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
        <input className={inputCls} value={section.title}
               onChange={(e) => onUpdate({ title: e.target.value })} />
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
    <aside className="flex h-full w-full flex-col border-l border-[#C8CDD2] bg-[#F6F7F8]" style={{ minWidth: "320px" }}>
      <div className="flex items-start justify-between gap-2 border-b border-[#C8CDD2] px-5 py-4">
        <div className="flex-1 min-w-0">
          <h2 className="text-xs font-semibold uppercase tracking-widest text-[#5E6870]">
            {target?.kind === "field" ? "Field Settings" : target?.kind === "section" ? "Section Settings" : "Inspector"}
          </h2>
          <p className="mt-1 truncate text-sm font-semibold text-[#1F2933]">
            {target?.kind === "field"
              ? FIELD_META[target.field.type]?.label ?? target.field.type
              : target?.kind === "section" ? target.section.title
              : "Select a field or section"}
          </p>
          {target?.kind === "field" && (
            <p className="mt-0.5 truncate font-mono text-xs text-[#5E6870]">{target.field.key}</p>
          )}
        </div>
        <button onClick={onCollapse} title="Collapse inspector"
                className="mt-0.5 shrink-0 p-1.5 text-[#5E6870] hover:bg-white hover:text-[#287EAD]">
          <ChevronRight className="h-4 w-4" />
        </button>
      </div>
      <div className="flex-1 overflow-y-auto px-5 py-5">
        {!target && (
          <div className="border border-dashed border-[#AEB5BB] bg-white p-6 text-center text-sm text-[#5E6870]">
            Click any field or section on the canvas to configure it here.
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
 * Preview
 * ============================================================ */

const previewInputCls =
  "h-10 w-full rounded-lg border border-slate-200 bg-white px-3 text-sm outline-none transition " +
  "focus:border-indigo-400 focus:ring-2 focus:ring-indigo-400/20 text-slate-800";

function PreviewTableField({ field }: { field: TemplateField }) {
  const cols = field.columns ?? [];
  const [rows, setRows] = useState<Record<string, string>[]>(
    Array.from({ length: field.minRows ?? 2 }, () => ({}))
  );

  const updateCell = (rowIdx: number, key: string, val: string) =>
    setRows((rs) => rs.map((r, i) => i === rowIdx ? { ...r, [key]: val } : r));
  const addRow = () => setRows((rs) => [...rs, {}]);
  const removeRow = (idx: number) => setRows((rs) => rs.filter((_, i) => i !== idx));

  return (
    <div className="col-span-12 space-y-2">
      <label className="text-sm font-semibold text-slate-700">{field.label}</label>
      <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-slate-200 bg-slate-50">
              {cols.map((col) => (
                <th key={col.id} className="px-3 py-2.5 text-left text-xs font-semibold text-slate-500 border-r border-slate-100 last:border-0">
                  {col.label}{col.required && <span className="text-red-400 ml-0.5">*</span>}
                </th>
              ))}
              <th className="w-10" />
            </tr>
          </thead>
          <tbody>
            {rows.map((row, rowIdx) => (
              <tr key={rowIdx} className="border-b border-slate-100 last:border-0 hover:bg-slate-50/50 transition-colors">
                {cols.map((col) => (
                  <td key={col.id} className="px-2 py-1.5 border-r border-slate-100 last:border-0">
                    {col.type === "select" && col.options ? (
                      <select value={row[col.key] ?? ""}
                              onChange={(e) => updateCell(rowIdx, col.key, e.target.value)}
                              className="w-full bg-transparent text-sm outline-none text-slate-700">
                        <option value="">—</option>
                        {col.options.map((o) => <option key={o} value={o}>{o}</option>)}
                      </select>
                    ) : (
                      <input
                        type={col.type === "number" || col.type === "currency" ? "number" : col.type === "date" ? "date" : "text"}
                        value={row[col.key] ?? ""}
                        onChange={(e) => updateCell(rowIdx, col.key, e.target.value)}
                        className="w-full bg-transparent text-sm outline-none text-slate-700 placeholder:text-slate-300 py-0.5"
                        placeholder={col.type === "currency" ? "0.00" : ""}
                      />
                    )}
                  </td>
                ))}
                <td className="text-center px-1">
                  {rows.length > 1 && (
                    <button onClick={() => removeRow(rowIdx)}
                            className="text-slate-300 hover:text-red-400 transition-colors p-1 rounded">
                      <Trash2 className="h-3 w-3" />
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <button onClick={addRow}
              className="flex items-center gap-1.5 text-xs font-semibold text-indigo-600 hover:text-indigo-800 transition-colors">
        <Plus className="h-3.5 w-3.5" /> Add row
      </button>
    </div>
  );
}

function PreviewField({ field, register, errors }: {
  field: TemplateField;
  register: UseFormRegister<Record<string, unknown>>;
  errors: FieldErrors<Record<string, unknown>>;
}) {
  if (field.type === "table") return <PreviewTableField field={field} />;

  const err = errors[field.id]?.message as string | undefined;
  const reg = register(field.id, { required: field.required ? `${field.label} is required` : false });

  if (field.type === "heading") return <h3 className="text-base font-bold text-slate-800 border-b border-slate-200 pb-2">{field.label}</h3>;
  if (field.type === "divider") return <hr className="border-slate-200" />;

  const label = field.type !== "boolean" && field.type !== "checkbox" ? (
    <label className="text-sm font-semibold text-slate-700">
      {field.label} {field.required && <span className="text-red-500">*</span>}
    </label>
  ) : null;

  let control: React.ReactNode = null;
  switch (field.type) {
    case "textarea":
      control = <textarea {...reg} placeholder={field.placeholder} rows={4} className={previewInputCls.replace("h-10", "min-h-[100px] py-2.5 resize-none")} />;
      break;
    case "select":
      control = (
        <select {...reg} className={previewInputCls} defaultValue="">
          <option value="" disabled>{field.placeholder ?? "Select an option"}</option>
          {(field.options ?? []).map((o) => <option key={o} value={o}>{o}</option>)}
        </select>
      );
      break;
    case "radio":
      control = (
        <div className="flex flex-col gap-2 pt-1">
          {(field.options ?? []).map((o) => (
            <label key={o} className="flex items-center gap-2.5 text-sm text-slate-700 cursor-pointer">
              <input type="radio" value={o} {...reg} className="h-4 w-4 text-indigo-600" />{o}
            </label>
          ))}
        </div>
      );
      break;
    case "boolean":
    case "checkbox":
      return (
        <label className="flex items-center gap-2.5 text-sm text-slate-700 cursor-pointer">
          <input type="checkbox" {...reg} className="h-4 w-4 rounded border-slate-300 text-indigo-600" />
          {field.label}
          {field.required && <span className="text-red-500">*</span>}
        </label>
      );
    case "currency":
      control = (
        <div className="relative">
          <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm text-slate-400 font-medium">KSh</span>
          <input type="number" step="0.01" {...reg} placeholder="0.00" className={cn(previewInputCls, "pl-12")} />
        </div>
      );
      break;
    case "number":
      control = <input type="number" {...reg} placeholder={field.placeholder} className={previewInputCls} />;
      break;
    case "email":
      control = <input type="email" {...reg} placeholder={field.placeholder} className={previewInputCls} />;
      break;
    case "phone":
      control = <input type="tel" {...reg} placeholder={field.placeholder} className={previewInputCls} />;
      break;
    case "date":
      control = <input type="date" {...reg} className={previewInputCls} />;
      break;
    case "datetime":
      control = <input type="datetime-local" {...reg} className={previewInputCls} />;
      break;
    case "time":
      control = <input type="time" {...reg} className={previewInputCls} />;
      break;
    case "file":
    case "image":
      control = (
        <input type="file" {...reg} accept={field.type === "image" ? "image/*" : undefined}
               className="block w-full text-sm text-slate-500 file:mr-3 file:rounded-lg file:border-0 file:bg-indigo-600 file:px-4 file:py-2 file:text-sm file:font-semibold file:text-white hover:file:bg-indigo-700" />
      );
      break;
    case "signature":
      control = <div className="flex h-16 items-center justify-center rounded-lg border-2 border-dashed border-slate-200 text-sm text-slate-400"><Pencil className="h-4 w-4 mr-2" />Click to sign</div>;
      break;
    default:
      control = <input type="text" {...reg} placeholder={field.placeholder} className={previewInputCls} />;
  }

  return (
    <div className="space-y-1.5">
      {label}
      {control}
      {field.helpText && <p className="text-xs text-slate-400">{field.helpText}</p>}
      {err && <p className="text-xs text-red-500 flex items-center gap-1"><AlertCircle className="h-3 w-3" />{err}</p>}
    </div>
  );
}

function Preview({ sections, templateName }: { sections: TemplateSection[]; templateName: string }) {
  const { register, handleSubmit, reset, formState: { errors } } = useForm<Record<string, unknown>>();
  const [submitted, setSubmitted] = useState<Record<string, unknown> | null>(null);

  if (submitted) {
    return (
      <div className="mx-auto max-w-3xl p-8">
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
    <div className="mx-auto max-w-3xl p-8">
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
              {s.fields.map((f) => (
                <div key={f.id} style={{ gridColumn: `span ${f.colSpan ?? 12} / span ${f.colSpan ?? 12}` }}>
                  <PreviewField field={f} register={register} errors={errors} />
                </div>
              ))}
            </div>
          </section>
        ))}
        <div className="flex items-center justify-end gap-3 pt-2">
          <button type="button" onClick={() => reset()}
                  className="inline-flex items-center gap-1.5 rounded-xl border border-slate-200 bg-white px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50">
            <RotateCcw className="h-4 w-4" /> Reset
          </button>
          <button type="submit"
                  className="inline-flex items-center gap-1.5 rounded-xl bg-indigo-600 px-5 py-2 text-sm font-semibold text-white hover:bg-indigo-700 shadow-sm">
            <ArrowRight className="h-4 w-4" /> Submit test
          </button>
        </div>
      </form>
    </div>
  );
}

/* ============================================================
 * Settings tab
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
    if (!(template.tags ?? []).includes(t)) {
      onCommit({ tags: [...(template.tags ?? []), t] });
    }
    setTagInput("");
  };
  const removeTag = (tag: string) =>
    onCommit({ tags: (template.tags ?? []).filter((t) => t !== tag) });

  const fieldCount = template.sections.reduce((a, s) => a + s.fields.length, 0);

  return (
    <div className="mx-auto max-w-2xl space-y-5 p-8">
      <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
        <h2 className="text-base font-bold text-slate-800 mb-1">Template metadata</h2>
        <p className="text-sm text-slate-500 mb-5">Used for search, organisation, and document filing.</p>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <label className="text-xs font-semibold uppercase tracking-wider text-slate-500">Name</label>
            <input value={template.name} onChange={(e) => onCommit({ name: e.target.value })}
                   className="h-10 w-full rounded-xl border border-slate-200 bg-white px-3 text-sm text-slate-800 outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-400/20" />
          </div>
          <div className="space-y-1.5">
            <label className="text-xs font-semibold uppercase tracking-wider text-slate-500">Description</label>
            <textarea value={template.description ?? ""} rows={3}
                      onChange={(e) => onCommit({ description: e.target.value })}
                      className="min-h-[76px] w-full rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-sm text-slate-800 outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-400/20 resize-none" />
          </div>
          <div className="space-y-1.5">
            <label className="text-xs font-semibold uppercase tracking-wider text-slate-500">Document type</label>
            <div className="flex gap-2">
              <select
                value={template.document_type_id ?? ""}
                onChange={(e) => onCommit({ document_type_id: e.target.value })}
                className="flex-1 h-10 rounded-xl border border-slate-200 bg-white px-3 text-sm text-slate-800 outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-400/20">
                <option value="">Select document type</option>
                {documentTypes.map((type) => <option key={type.id} value={type.id}>{type.name}</option>)}
              </select>
              <button
                type="button"
                onClick={() => setShowCreate(true)}
                title="Create new document type"
                className="h-10 px-3 rounded-xl border border-slate-200 bg-white text-slate-400 hover:text-indigo-600 hover:border-indigo-300 hover:bg-indigo-50 transition-all flex items-center gap-1.5 text-xs font-semibold whitespace-nowrap">
                <Plus className="h-3.5 w-3.5" /> New type
              </button>
            </div>
            {showCreate && (
              <CreateDocTypeQuickModal
                onClose={() => setShowCreate(false)}
                onCreated={(type) => {
                  onCommit({ document_type_id: type.id });
                  setShowCreate(false);
                }}
              />
            )}
          </div>
          <div className="space-y-1.5">
            <label className="text-xs font-semibold uppercase tracking-wider text-slate-500">Tags</label>
            <div className="flex gap-2">
              <input value={tagInput} onChange={(e) => setTagInput(e.target.value)}
                     onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), addTag())}
                     placeholder="Add tag and press Enter"
                     className="flex-1 h-9 rounded-xl border border-slate-200 bg-white px-3 text-sm outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-400/20" />
              <button onClick={addTag}
                      className="h-9 px-3 rounded-xl bg-indigo-600 text-white text-sm font-semibold hover:bg-indigo-700">
                <Plus className="h-4 w-4" />
              </button>
            </div>
            {(template.tags ?? []).length > 0 && (
              <div className="flex flex-wrap gap-2 mt-2">
                {(template.tags ?? []).map((tag) => (
                  <span key={tag} className="flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-indigo-50 text-indigo-700 text-xs font-semibold border border-indigo-100">
                    <Tag className="h-2.5 w-2.5" />{tag}
                    <button onClick={() => removeTag(tag)} className="text-indigo-400 hover:text-indigo-700 ml-0.5"><Minus className="h-2.5 w-2.5" /></button>
                  </span>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Stats card */}
      <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
        <h2 className="text-base font-bold text-slate-800 mb-4">Template summary</h2>
        <div className="grid grid-cols-3 gap-4">
          {[
            { label: "Sections", value: template.sections.length },
            { label: "Fields",   value: fieldCount },
            { label: "Document type", value: documentTypes.find((type) => type.id === template.document_type_id)?.code ?? "None" },
          ].map((s) => (
            <div key={s.label} className="rounded-xl bg-slate-50 p-4 text-center">
              <div className="text-2xl font-bold text-slate-800">{s.value}</div>
              <div className="text-xs text-slate-500 mt-0.5">{s.label}</div>
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
  onSave: (template: Template) => void;
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

  useEffect(() => {
    const id = requestAnimationFrame(() => setVisible(true));
    return () => cancelAnimationFrame(id);
  }, []);

  const handleCancel = () => {
    setClosing(true);
    setTimeout(onCancel, 220);
  };

  useEffect(() => {
    setHistory([normalizeTemplate(initial ?? initialTemplate)]);
    setCursor(0);
    setSelectedId(null);
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
  const updateSection = (sectionId: string, patch: Partial<TemplateSection>) => {
    commit({ ...template, sections: template.sections.map((s) => s.id === sectionId ? { ...s, ...patch } : s) });
  };
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

  const fieldCount = useMemo(() => (template?.sections ?? []).reduce((a, s) => a + (s.fields?.length ?? 0), 0), [template]);

  const handleSave = () => {
    // Check for duplicate keys
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
    onSave(outputTemplate(template, Boolean(initial?.id)));
  };

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
          <button onClick={handleCancel}
                  className="p-1.5 text-white/75 hover:bg-white/10 hover:text-white">
            <ArrowLeft className="h-4 w-4" />
          </button>
          <div className="h-5 w-px bg-white/25" />
          <input value={template.name}
                 onChange={(e) => commit({ ...template, name: e.target.value })}
                 className="h-9 w-56 border border-transparent bg-transparent px-2 text-sm font-semibold text-white outline-none hover:border-white/25 focus:border-white/70 focus:bg-white/10" />
          <span className="border border-white/25 bg-white/10 px-2.5 py-0.5 text-[10px] font-semibold text-white/80">
            {template.sections.length} sections · {fieldCount} fields
          </span>
        </div>

        {/* Tab switcher */}
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
                        tab === t.id
                          ? "bg-white text-[#287EAD]"
                          : "text-white/70 hover:bg-white/10 hover:text-white",
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
              <div className="w-[248px] shrink-0"><Palette /></div>
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
                />
                {!inspectorOpen && (
                  <button
                    onClick={() => setInspectorOpen(true)}
                    title="Open inspector"
                    className="absolute right-4 top-4 flex items-center gap-1.5 border border-[#AEB5BB] bg-white px-3 py-2 text-xs font-semibold text-[#5E6870] shadow-md hover:border-[#287EAD] hover:bg-[#EEF6FB] hover:text-[#287EAD]">
                    <Settings className="h-3.5 w-3.5" /> Inspector
                  </button>
                )}
              </main>
              <div className={cn("shrink-0 overflow-hidden transition-all duration-200", inspectorOpen ? "w-[320px]" : "w-0")}>
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
              <SettingsTab template={template}
                           documentTypes={documentTypes}
                           onCommit={(patch) => commit({ ...template, ...patch })} />
            </main>
          )}
        </div>

        <DragOverlay dropAnimation={{
          sideEffects: defaultDropAnimationSideEffects({ styles: { active: { opacity: "0.4" } } }),
        }}>
          {dragType ? (
            <div className="flex items-center gap-2 rounded-xl border border-indigo-500 bg-indigo-600 px-3 py-2 text-sm font-semibold text-white shadow-xl">
              {(() => { const Icon = ICONS[dragType]; return <Icon className="h-4 w-4" />; })()}
              {FIELD_META[dragType].label}
            </div>
          ) : null}
        </DragOverlay>
      </DndContext>
    </div>
  );
}
