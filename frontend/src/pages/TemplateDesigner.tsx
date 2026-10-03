/**
 * TemplateDesigner.tsx — free-form, paginated document template designer (v3)
 *
 * Drop-in React component for a DMS. Documents are stored as
 * pages -> rows -> cells -> elements (flow layout) plus optional
 * free-positioned ("floating") elements per page, so any content can be
 * placed anywhere on the page:
 *
 *   - drag an element into any cell (header, footer or body)
 *   - drop it onto another element to insert it before that element
 *   - drop it between rows to create a new row at that exact spot
 *   - drop it on empty paper to place it freely (x / y in mm)
 *   - double-click text, headings and notes to edit them in place
 *   - add / remove columns, insert rows above / below, per-page header/footer
 *
 * The designer starts from a blank document; no document-specific stub is
 * bundled. Pass `initial` to open an existing template.
 *
 * Runtime dependencies: react, @dnd-kit/core, lucide-react, sonner
 */
import {
  Fragment, useCallback, useEffect, useMemo, useRef, useState,
  type CSSProperties, type ReactNode,
} from "react";
import {
  DndContext, DragOverlay, PointerSensor, pointerWithin, useDndContext, useDraggable, useDroppable,
  useSensor, useSensors, type CollisionDetection, type DragEndEvent, type DragStartEvent,
} from "@dnd-kit/core";
import {
  AlignCenter, AlignJustify, AlignLeft, AlignRight, ArrowDown, ArrowDownToLine, ArrowLeft,
  ArrowUp, ArrowUpToLine, Bold, Braces, BringToFront, ChevronDown, ChevronRight, Columns2, Copy,
  Download, Eye, FileJson, FileText, GripVertical, Heading, Image as ImageIcon,
  Italic, LayoutGrid, List, ListOrdered, Minus, Move, PanelLeftClose, PanelRightClose,
  PenLine, Plus, Printer, Quote, Redo2, Rows3, Save, Search, SendToBack, Settings, Square,
  Table2, Trash2, Underline, Undo2, Upload, X, ZoomIn, ZoomOut,
} from "lucide-react";
import { toast } from "sonner";
import "./designer.css";

const cx = (...values: Array<string | false | null | undefined>) => values.filter(Boolean).join(" ");
const uid = () => Math.random().toString(36).slice(2, 10);

/* ========================================================================== *
 * Public schema
 * ========================================================================== */

export type PageSize = "A4" | "A5" | "Letter" | "Legal";
export type Orientation = "portrait" | "landscape";
export type Align = "left" | "center" | "right" | "justify";
export type VerticalAlign = "start" | "center" | "end";
export type ElementType =
  | "text" | "heading" | "bulleted_list" | "numbered_list" | "note"
  | "field_group" | "data_table" | "image" | "divider" | "spacer" | "box"
  | "signature_group";

export interface MergeField {
  key: string;
  label: string;
  group?: string;
  type?: "text" | "number" | "date" | "image" | "collection";
  repeating?: boolean;
  children?: Array<{ key: string; label: string; type?: "text" | "number" | "date" }>;
}

export interface ElementStyle {
  align?: Align;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  fontSize?: number;
  fontFamily?: string;
  lineHeight?: number;
  color?: string;
  background?: string;
  padding?: number;
  marginTop?: number;
  marginBottom?: number;
  borderWidth?: number;
  borderColor?: string;
  borderStyle?: "solid" | "dashed" | "dotted";
  radius?: number;
  minHeight?: number;
}

export interface TableColumn {
  id: string;
  key: string;
  label: string;
  width: number;
  align?: Align;
  format?: "text" | "number" | "currency" | "percent" | "date";
}

export interface TableSummary {
  id: string;
  label: string;
  labelSpan: number;
  values: string[];
  bold?: boolean;
}

export interface FieldPair {
  id: string;
  label: string;
  value: string;
  boldLabel?: boolean;
  boldValue?: boolean;
}

export interface Signatory {
  id: string;
  step?: string;
  role: string;
  name: string;
  date: string;
  signature?: string;
}

export interface DocumentElement {
  id: string;
  type: ElementType;
  text?: string;
  level?: 1 | 2 | 3;
  items?: string[];
  fields?: FieldPair[];
  labelWidth?: number;
  columns?: TableColumn[];
  staticRows?: string[][];
  sourceKey?: string;
  previewRows?: number;
  summaries?: TableSummary[];
  showHeader?: boolean;
  repeatHeader?: boolean;
  striped?: boolean;
  cellPadding?: number;
  headerBackground?: string;
  headerColor?: string;
  src?: string;
  alt?: string;
  width?: number;
  height?: number;
  objectFit?: "contain" | "cover" | "fill";
  opacity?: number;
  signatories?: Signatory[];
  style?: ElementStyle;
}

export interface GridCell {
  id: string;
  width: number;
  verticalAlign?: VerticalAlign;
  padding?: number;
  background?: string;
  borderWidth?: number;
  borderColor?: string;
  elements: DocumentElement[];
}

export interface GridRow {
  id: string;
  columns: GridCell[];
  gap: number;
  marginTop?: number;
  marginBottom?: number;
  minHeight?: number;
  keepTogether?: boolean;
  fullBleed?: boolean;
}

export interface PageBand {
  enabled: boolean;
  rows: GridRow[];
  height?: number;
  border?: boolean;
}

export interface WatermarkSettings {
  enabled: boolean;
  kind: "text" | "image";
  value: string;
  opacity: number;
  width?: number;
  rotation?: number;
}

/** Element placed freely on a page. Coordinates are millimetres from the paper's top-left corner. */
export interface FloatingItem {
  id: string;
  x: number;
  y: number;
  width: number;
  height?: number;
  rotation?: number;
  zIndex?: number;
  element: DocumentElement;
}

export interface DocumentPage {
  id: string;
  name: string;
  rows: GridRow[];
  floating?: FloatingItem[];
  showHeader?: boolean;
  showFooter?: boolean;
}

export interface DocumentTemplateV2 {
  schemaVersion: 2;
  id?: string;
  name: string;
  description?: string;
  documentTypeId?: string;
  category?: string;
  tags?: string[];
  page: {
    size: PageSize;
    orientation: Orientation;
    margin: { top: number; right: number; bottom: number; left: number };
  };
  theme: {
    fontFamily: string;
    headingFamily: string;
    baseFontSize: number;
    lineHeight: number;
    textColor: string;
    headingColor: string;
    accentColor: string;
  };
  header: PageBand;
  footer: PageBand;
  watermark: WatermarkSettings;
  pages: DocumentPage[];
  requiredFields: string[];
  updatedAt?: string;
}

export interface TemplateDesignerProps {
  initial?: DocumentTemplateV2 | null;
  mergeFields?: MergeField[];
  sampleData?: Record<string, unknown>;
  documentTypes?: Array<{ id: string; name: string; code?: string }>;
  onSave: (template: DocumentTemplateV2, stayOpen?: boolean) => void | Promise<string | void>;
  onCancel: () => void;
  isSaving?: boolean;
}

/** `pageId` is a container id: a page id, or "header" / "footer" for the bands. */
type Selection =
  | { kind: "band"; band: "header" | "footer" }
  | { kind: "page"; pageId: string }
  | { kind: "row"; pageId: string; rowId: string }
  | { kind: "cell"; pageId: string; rowId: string; cellId: string }
  | { kind: "element"; pageId: string; rowId: string; cellId: string; elementId: string }
  | { kind: "floating"; pageId: string; elementId: string };

type EditorTab = "design" | "preview" | "settings";
type PaletteGroup = "text" | "data" | "media" | "layout" | "signoff";
type RowAction = "up" | "down" | "duplicate" | "delete" | "insertAbove" | "insertBelow" | "addColumn";
type ElementAction = "up" | "down" | "duplicate" | "delete" | "forward" | "backward";

/* ========================================================================== *
 * Constants and factories
 * ========================================================================== */

const PAGE_DIMS: Record<PageSize, { w: number; h: number }> = {
  A4: { w: 210, h: 297 }, A5: { w: 148, h: 210 }, Letter: { w: 216, h: 279 }, Legal: { w: 216, h: 356 },
};
const PX_PER_MM = 96 / 25.4;

const FONT_OPTIONS: Array<{ value: string; label: string }> = [
  { value: "Arial, Helvetica, sans-serif", label: "Arial" },
  { value: "Calibri, 'Segoe UI', sans-serif", label: "Calibri" },
  { value: "Verdana, Geneva, sans-serif", label: "Verdana" },
  { value: "Tahoma, Geneva, sans-serif", label: "Tahoma" },
  { value: "Georgia, 'Times New Roman', serif", label: "Georgia" },
  { value: "'Times New Roman', Times, serif", label: "Times New Roman" },
  { value: "'Courier New', Courier, monospace", label: "Courier New" },
];

/** Generic DMS fields. Replace by passing `mergeFields`. */
const DEFAULT_FIELDS: MergeField[] = [
  { key: "company.name", label: "Company name", group: "Organisation" },
  { key: "company.address", label: "Company address", group: "Organisation" },
  { key: "company.phone", label: "Company phone", group: "Organisation" },
  { key: "company.email", label: "Company email", group: "Organisation" },
  { key: "company.logo", label: "Company logo", group: "Organisation", type: "image" },
  { key: "document.title", label: "Document title", group: "Document" },
  { key: "document.number", label: "Document number", group: "Document" },
  { key: "document.date", label: "Document date", group: "Document", type: "date" },
  { key: "document.reference", label: "Reference", group: "Document" },
  { key: "document.notes", label: "Notes", group: "Document" },
  { key: "recipient.name", label: "Recipient name", group: "Recipient" },
  { key: "recipient.address", label: "Recipient address", group: "Recipient" },
  { key: "recipient.email", label: "Recipient email", group: "Recipient" },
  { key: "recipient.phone", label: "Recipient phone", group: "Recipient" },
  { key: "totals.subtotal", label: "Subtotal", group: "Totals", type: "number" },
  { key: "totals.tax", label: "Tax", group: "Totals", type: "number" },
  { key: "totals.grand_total", label: "Grand total", group: "Totals", type: "number" },
  { key: "totals.amount_words", label: "Amount in words", group: "Totals" },
  { key: "prepared_by.name", label: "Prepared by name", group: "Approvals" },
  { key: "prepared_by.role", label: "Prepared by role", group: "Approvals" },
  { key: "prepared_by.date", label: "Prepared date", group: "Approvals", type: "date" },
  { key: "approved_by.name", label: "Approver name", group: "Approvals" },
  { key: "approved_by.role", label: "Approver role", group: "Approvals" },
  { key: "approved_by.date", label: "Approval date", group: "Approvals", type: "date" },
  {
    key: "items", label: "Items", group: "Collections", type: "collection", repeating: true,
    children: [
      { key: "number", label: "No" }, { key: "description", label: "Description" },
      { key: "quantity", label: "Qty", type: "number" }, { key: "unit_price", label: "Unit price", type: "number" },
      { key: "amount", label: "Amount", type: "number" },
    ],
  },
];

/** Neutral preview values used only in the Preview tab. Override with `sampleData`. */
const SAMPLE_DATA: Record<string, unknown> = {
  "company.name": "Your Company Ltd",
  "company.address": "1 Example Street\nCity, Country",
  "company.phone": "+000 000 000",
  "company.email": "info@example.com",
  "document.title": "Document title",
  "document.number": "DOC-0001",
  "document.date": "01 January 2026",
  "document.reference": "REF-0001",
  "document.notes": "Notes",
  "recipient.name": "Recipient name",
  "recipient.address": "Recipient address",
  "recipient.email": "recipient@example.com",
  "recipient.phone": "+000 000 000",
  "totals.subtotal": "100.00",
  "totals.tax": "16.00",
  "totals.grand_total": "116.00",
  "totals.amount_words": "One hundred sixteen only",
  "prepared_by.name": "Preparer",
  "prepared_by.role": "Officer",
  "prepared_by.date": "01 January 2026",
  "approved_by.name": "Approver",
  "approved_by.role": "Manager",
  "approved_by.date": "02 January 2026",
  items: [
    { number: "1", description: "Item one", quantity: 1, unit_price: 40, amount: 40 },
    { number: "2", description: "Item two", quantity: 2, unit_price: 30, amount: 60 },
  ],
};

const elementMeta: Record<ElementType, { label: string; group: PaletteGroup; icon: typeof FileText; hint: string }> = {
  text: { label: "Paragraph", group: "text", icon: FileText, hint: "Text with inline DMS fields" },
  heading: { label: "Heading", group: "text", icon: Heading, hint: "Section or document heading" },
  bulleted_list: { label: "Bulleted list", group: "text", icon: List, hint: "List with editable items" },
  numbered_list: { label: "Numbered list", group: "text", icon: ListOrdered, hint: "Ordered clauses and terms" },
  note: { label: "Note / callout", group: "text", icon: Quote, hint: "Emphasized note or disclaimer" },
  field_group: { label: "Field group", group: "data", icon: Rows3, hint: "Label and value pairs" },
  data_table: { label: "Table", group: "data", icon: Table2, hint: "Static rows or repeating DMS records" },
  image: { label: "Image / logo", group: "media", icon: ImageIcon, hint: "Uploaded image, URL or image field" },
  box: { label: "Box / shape", group: "media", icon: Square, hint: "Coloured rectangle, frame or background" },
  divider: { label: "Divider", group: "layout", icon: Minus, hint: "Horizontal rule" },
  spacer: { label: "Spacer", group: "layout", icon: Rows3, hint: "Controlled vertical space" },
  signature_group: { label: "Signatures", group: "signoff", icon: PenLine, hint: "Signatories, roles, dates and signatures" },
};

const groupLabels: Array<{ key: PaletteGroup; label: string }> = [
  { key: "text", label: "Text" }, { key: "data", label: "Data & fields" },
  { key: "media", label: "Media & shapes" }, { key: "layout", label: "Layout" },
  { key: "signoff", label: "Sign-off" },
];

const ROW_PRESETS: number[][] = [[1], [1, 1], [1, 2], [2, 1], [1, 1, 1], [1, 2, 1], [1, 1, 1, 1]];

export const makeElement = (type: ElementType): DocumentElement => {
  const base: DocumentElement = { id: uid(), type, style: { marginBottom: 8 } };
  if (type === "heading") return { ...base, text: "Heading", level: 2, style: { ...base.style, bold: true, fontSize: 16 } };
  if (type === "text") return { ...base, text: "Double-click to edit. Insert {{fields}} from the properties panel.", style: { ...base.style, fontSize: 11 } };
  if (type === "note") return { ...base, text: "Note", style: { ...base.style, padding: 8, borderWidth: 1, background: "#F8FAFC" } };
  if (type === "bulleted_list" || type === "numbered_list") return { ...base, items: ["First item", "Second item"] };
  if (type === "field_group") return { ...base, labelWidth: 120, fields: [{ id: uid(), label: "Label", value: "Value", boldLabel: true }] };
  if (type === "image") return { ...base, src: "", alt: "Image", width: 140, height: 64, objectFit: "contain", opacity: 1 };
  if (type === "box") return { ...base, style: { minHeight: 60, background: "#F1F5F9", borderWidth: 1, borderColor: "#CBD5E1", radius: 0 } };
  if (type === "divider") return { ...base, style: { marginTop: 8, marginBottom: 8, borderWidth: 1, borderColor: "#94A3B8" } };
  if (type === "spacer") return { ...base, height: 24 };
  if (type === "signature_group") return { ...base, signatories: [{ id: uid(), step: "1", role: "Signed by", name: "[[Name]]", date: "[[Date]]", signature: "[[Signature]]" }] };
  return {
    ...base, sourceKey: "", showHeader: true, repeatHeader: true, striped: false, cellPadding: 4,
    headerBackground: "#E2E8F0", headerColor: "#111827", previewRows: 2,
    columns: [
      { id: uid(), key: "col1", label: "Column 1", width: 34 },
      { id: uid(), key: "col2", label: "Column 2", width: 33 },
      { id: uid(), key: "col3", label: "Column 3", width: 33 },
    ],
    staticRows: [["", "", ""], ["", "", ""]],
    summaries: [],
  };
};

const makeCell = (width = 1, elements: DocumentElement[] = []): GridCell => ({ id: uid(), width, verticalAlign: "start", padding: 0, elements });
export const makeRow = (ratios: number[] = [1], elements?: DocumentElement[][]): GridRow => ({
  id: uid(), gap: 12, marginBottom: 8,
  columns: ratios.map((w, i) => makeCell(w, elements?.[i] ?? [])),
});

const DEFAULT_PAGE: DocumentTemplateV2["page"] = { size: "A4", orientation: "portrait", margin: { top: 15, right: 15, bottom: 15, left: 15 } };
const DEFAULT_THEME: DocumentTemplateV2["theme"] = {
  fontFamily: "Arial, Helvetica, sans-serif", headingFamily: "Arial, Helvetica, sans-serif", baseFontSize: 11,
  lineHeight: 1.3, textColor: "#111827", headingColor: "#111827", accentColor: "#287EAD",
};

/** A clean, empty one-page document. */
export const createBlankTemplate = (): DocumentTemplateV2 => ({
  schemaVersion: 2,
  name: "Untitled document", description: "", tags: [],
  page: JSON.parse(JSON.stringify(DEFAULT_PAGE)) as DocumentTemplateV2["page"],
  theme: { ...DEFAULT_THEME },
  header: { enabled: false, border: false, rows: [] },
  footer: { enabled: false, border: false, rows: [] },
  watermark: { enabled: false, kind: "text", value: "", opacity: 0.06, width: 300, rotation: -30 },
  pages: [{ id: uid(), name: "Page 1", rows: [], floating: [] }],
  requiredFields: [],
});

/* ========================================================================== *
 * Data and schema helpers
 * ========================================================================== */

const TOKEN_RE = /\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g;

function valueAt(data: Record<string, unknown>, path: string): unknown {
  if (Object.prototype.hasOwnProperty.call(data, path)) return data[path];
  return path.split(".").reduce<unknown>((value, key) =>
    value && typeof value === "object" ? (value as Record<string, unknown>)[key] : undefined, data);
}

function substitute(value: string | undefined, data: Record<string, unknown>, page = 1, pages = 1): string {
  if (!value) return "";
  return value.replace(TOKEN_RE, (_match, key: string) => {
    if (key === "page") return String(page);
    if (key === "pages") return String(pages);
    const result = valueAt(data, key);
    return result == null || typeof result === "object" ? `⟪${key}⟫` : String(result);
  });
}

function renderedText(value: string | undefined, data: Record<string, unknown> | null, page = 1, pages = 1): ReactNode {
  const resolved = data ? substitute(value, data, page, pages) : (value ?? "");
  const parts = resolved.split(/(\[\[[^\]]+\]\]|⟪[^⟫]+⟫)/g);
  return parts.map((part, index) => {
    if (/^\[\[/.test(part)) return <mark key={index} className="dtd-manual">{part.slice(2, -2)}</mark>;
    if (/^⟪/.test(part)) return <span key={index} className="dtd-missing" title="No preview value supplied">{part}</span>;
    return <Fragment key={index}>{part}</Fragment>;
  });
}

function collectRequiredFields(template: DocumentTemplateV2): string[] {
  const fields = new Set<string>();
  const scan = (value?: string) => {
    if (!value) return;
    for (const match of value.matchAll(TOKEN_RE)) if (match[1] && !["page", "pages"].includes(match[1])) fields.add(match[1]);
  };
  const scanElement = (el: DocumentElement) => {
    scan(el.text); scan(el.src); (el.items ?? []).forEach(scan);
    (el.fields ?? []).forEach((item) => { scan(item.label); scan(item.value); });
    (el.staticRows ?? []).flat().forEach(scan);
    (el.summaries ?? []).forEach((summary) => { scan(summary.label); summary.values.forEach(scan); });
    (el.signatories ?? []).forEach((sig) => { scan(sig.role); scan(sig.name); scan(sig.date); scan(sig.signature); });
    if (el.sourceKey) fields.add(el.sourceKey);
  };
  const scanRows = (rows: GridRow[]) => rows.forEach((row) => row.columns.forEach((cell) => cell.elements.forEach(scanElement)));
  scanRows(template.header.rows); scanRows(template.footer.rows);
  template.pages.forEach((page) => { scanRows(page.rows); (page.floating ?? []).forEach((item) => scanElement(item.element)); });
  scan(template.watermark.value);
  return [...fields].sort();
}

function normalizeTemplate(template: DocumentTemplateV2): DocumentTemplateV2 {
  const copy = JSON.parse(JSON.stringify(template)) as DocumentTemplateV2;
  const blank = createBlankTemplate();
  copy.schemaVersion = 2;
  copy.name = copy.name ?? blank.name;
  copy.page = { ...blank.page, ...(copy.page ?? {}), margin: { ...blank.page.margin, ...(copy.page?.margin ?? {}) } };
  copy.theme = { ...blank.theme, ...(copy.theme ?? {}) };
  copy.header = { ...blank.header, ...(copy.header ?? {}) }; copy.header.rows = Array.isArray(copy.header.rows) ? copy.header.rows : [];
  copy.footer = { ...blank.footer, ...(copy.footer ?? {}) }; copy.footer.rows = Array.isArray(copy.footer.rows) ? copy.footer.rows : [];
  copy.watermark = { ...blank.watermark, ...(copy.watermark ?? {}) };
  copy.pages = Array.isArray(copy.pages) && copy.pages.length ? copy.pages : blank.pages;
  copy.pages = copy.pages.map((page) => ({ ...page, rows: Array.isArray(page.rows) ? page.rows : [], floating: Array.isArray(page.floating) ? page.floating : [] }));
  copy.requiredFields = collectRequiredFields(copy);
  return copy;
}

export type LegacyBlock = { id?: string; type: string; text?: string; level?: 1 | 2 | 3; items?: string[]; pairs?: FieldPair[]; columns?: Array<{ id?: string; key: string; label: string; width?: number; align?: Align }>; rows?: string[][]; bound?: boolean; sourceKey?: string; src?: string; alt?: string; width?: number; height?: number; left?: string; right?: string; signatories?: Array<{ id?: string; role: string; nameToken?: string; dateToken?: string }>; align?: Align; bold?: boolean; italic?: boolean; fontSize?: number; color?: string; marginTop?: number; marginBottom?: number };
export type LegacyTemplate = { name?: string; description?: string; page?: DocumentTemplateV2["page"]; theme?: DocumentTemplateV2["theme"]; header?: { enabled: boolean; rule?: boolean; content: { left?: string; center?: string; right?: string } }; footer?: { enabled: boolean; rule?: boolean; content: { left?: string; center?: string; right?: string } }; blocks: LegacyBlock[] };

const textEl = (value: string, style?: ElementStyle): DocumentElement => ({ id: uid(), type: "text", text: value, style: { fontSize: 11, marginBottom: 4, ...style } });

export function importLegacyTemplate(input: LegacyTemplate): DocumentTemplateV2 {
  const band = (old?: LegacyTemplate["header"]): PageBand => ({ enabled: old?.enabled ?? false, border: old?.rule ?? false, rows: [makeRow([1, 1, 1], [old?.content.left, old?.content.center, old?.content.right].map((value, index) => value ? [textEl(value, { align: index === 0 ? "left" : index === 1 ? "center" : "right" })] : []))] });
  const pages: DocumentPage[] = [{ id: uid(), name: "Page 1", rows: [], floating: [] }];
  for (const block of input.blocks) {
    if (block.type === "page_break") { pages.push({ id: uid(), name: `Page ${pages.length + 1}`, rows: [], floating: [] }); continue; }
    const style: ElementStyle = Object.fromEntries(Object.entries({ align: block.align, bold: block.bold, italic: block.italic, fontSize: block.fontSize, color: block.color, marginTop: block.marginTop, marginBottom: block.marginBottom }).filter(([, value]) => value !== undefined)) as ElementStyle;
    const map: Record<string, ElementType> = { paragraph: "text", quote: "note", key_value: "field_group", logo: "image", two_column: "text", signature: "signature_group" };
    const type = map[block.type] ?? block.type as ElementType;
    const element = { id: uid(), type, text: block.text, level: block.level, items: block.items, fields: block.pairs?.map((pair) => ({ ...pair, id: pair.id ?? uid() })), columns: block.columns?.map((col) => ({ ...col, id: col.id ?? uid(), width: col.width ?? Math.round(100 / (block.columns?.length || 1)) })), staticRows: block.rows, sourceKey: block.bound ? block.sourceKey : undefined, src: block.src, alt: block.alt, width: block.width, height: block.height, signatories: block.signatories?.map((sig) => ({ id: sig.id ?? uid(), role: sig.role, name: sig.nameToken ?? "", date: sig.dateToken ?? "" })), style } as DocumentElement;
    const currentPage = pages[pages.length - 1];
    if (!currentPage) continue;
    if (block.type === "two_column") currentPage.rows.push(makeRow([1, 1], [[textEl(block.left ?? "")], [textEl(block.right ?? "")]]));
    else currentPage.rows.push(makeRow([1], [[element]]));
  }
  const blank = createBlankTemplate();
  return normalizeTemplate({ ...blank, name: input.name ?? "Imported document", description: input.description ?? "", page: input.page ?? blank.page, theme: input.theme ?? blank.theme, header: band(input.header), footer: band(input.footer), pages });
}

export function outputDocumentTemplate(template: DocumentTemplateV2): DocumentTemplateV2 {
  return { ...normalizeTemplate(template), updatedAt: new Date().toISOString() };
}

function cloneWithNewIds<T>(input: T): T {
  const value = JSON.parse(JSON.stringify(input)) as T;
  const visit = (node: unknown) => {
    if (!node || typeof node !== "object") return;
    const record = node as Record<string, unknown>;
    if (typeof record["id"] === "string") record["id"] = uid();
    Object.values(record).forEach(visit);
  };
  visit(value);
  return value;
}

function downloadJson(template: DocumentTemplateV2) {
  const blob = new Blob([JSON.stringify(outputDocumentTemplate(template), null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `${template.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "document-template"}.json`;
  anchor.click(); URL.revokeObjectURL(url);
}

/* ---------- Structural tree helpers (pure) ---------- */

type BandKey = "header" | "footer";
const isBand = (cid: string): cid is BandKey => cid === "header" || cid === "footer";

function mapContainers(t: DocumentTemplateV2, fn: (rows: GridRow[], cid: string) => GridRow[]): DocumentTemplateV2 {
  return {
    ...t,
    header: { ...t.header, rows: fn(t.header.rows, "header") },
    footer: { ...t.footer, rows: fn(t.footer.rows, "footer") },
    pages: t.pages.map((page) => ({ ...page, rows: fn(page.rows, page.id) })),
  };
}
function mapAllCells(t: DocumentTemplateV2, fn: (cell: GridCell, row: GridRow, cid: string) => GridCell): DocumentTemplateV2 {
  return mapContainers(t, (rows, cid) => rows.map((row) => ({ ...row, columns: row.columns.map((cell) => fn(cell, row, cid)) })));
}
function rowsOf(t: DocumentTemplateV2, cid: string): GridRow[] {
  if (isBand(cid)) return t[cid].rows;
  return t.pages.find((page) => page.id === cid)?.rows ?? [];
}
function withRows(t: DocumentTemplateV2, cid: string, fn: (rows: GridRow[]) => GridRow[]): DocumentTemplateV2 {
  if (isBand(cid)) return { ...t, [cid]: { ...t[cid], rows: fn(t[cid].rows) } };
  return { ...t, pages: t.pages.map((page) => page.id === cid ? { ...page, rows: fn(page.rows) } : page) };
}
function findRow(t: DocumentTemplateV2, rowId: string): { row: GridRow; cid: string } | null {
  for (const cid of ["header", "footer", ...t.pages.map((page) => page.id)]) {
    const row = rowsOf(t, cid).find((item) => item.id === rowId);
    if (row) return { row, cid };
  }
  return null;
}

type FlowLocation = { element: DocumentElement; cid: string; rowId: string; cellId: string };
type FloatLocation = { element: DocumentElement; floating: FloatingItem; pageId: string };
function locateElement(t: DocumentTemplateV2, id: string): FlowLocation | FloatLocation | null {
  for (const cid of ["header", "footer", ...t.pages.map((page) => page.id)]) {
    for (const row of rowsOf(t, cid)) for (const cell of row.columns) {
      const element = cell.elements.find((item) => item.id === id);
      if (element) return { element, cid, rowId: row.id, cellId: cell.id };
    }
  }
  for (const page of t.pages) {
    const floating = (page.floating ?? []).find((item) => item.element.id === id);
    if (floating) return { element: floating.element, floating, pageId: page.id };
  }
  return null;
}
function locateCell(t: DocumentTemplateV2, cellId: string): { cell: GridCell; row: GridRow; cid: string } | null {
  for (const cid of ["header", "footer", ...t.pages.map((page) => page.id)]) {
    for (const row of rowsOf(t, cid)) { const cell = row.columns.find((item) => item.id === cellId); if (cell) return { cell, row, cid }; }
  }
  return null;
}
function extractElement(t: DocumentTemplateV2, id: string): [DocumentTemplateV2, DocumentElement | undefined] {
  let found: DocumentElement | undefined;
  const stage = mapAllCells(t, (cell) => {
    const element = cell.elements.find((item) => item.id === id);
    if (!element) return cell;
    found = element; return { ...cell, elements: cell.elements.filter((item) => item.id !== id) };
  });
  const next = { ...stage, pages: stage.pages.map((page) => {
    const item = (page.floating ?? []).find((f) => f.element.id === id);
    if (!item) return page;
    found = item.element; return { ...page, floating: (page.floating ?? []).filter((f) => f.element.id !== id) };
  }) };
  return [next, found];
}
function insertIntoCell(t: DocumentTemplateV2, cellId: string, element: DocumentElement, beforeId?: string): DocumentTemplateV2 {
  return mapAllCells(t, (cell) => {
    if (cell.id !== cellId) return cell;
    const elements = [...cell.elements];
    const index = beforeId ? elements.findIndex((item) => item.id === beforeId) : -1;
    if (index < 0) elements.push(element); else elements.splice(index, 0, element);
    return { ...cell, elements };
  });
}
function insertRowAt(t: DocumentTemplateV2, cid: string, index: number, row: GridRow): DocumentTemplateV2 {
  return withRows(t, cid, (rows) => { const next = [...rows]; next.splice(Math.max(0, Math.min(index, next.length)), 0, row); return next; });
}
function addFloatingItem(t: DocumentTemplateV2, pageId: string, item: FloatingItem): DocumentTemplateV2 {
  return { ...t, pages: t.pages.map((page) => page.id === pageId ? { ...page, floating: [...(page.floating ?? []), item] } : page) };
}
function mapFloating(t: DocumentTemplateV2, elementId: string, fn: (item: FloatingItem, all: FloatingItem[]) => FloatingItem): DocumentTemplateV2 {
  return { ...t, pages: t.pages.map((page) => ({ ...page, floating: (page.floating ?? []).map((item) => item.element.id === elementId ? fn(item, page.floating ?? []) : item) })) };
}
function patchElementAnywhere(t: DocumentTemplateV2, elementId: string, patch: Partial<DocumentElement>): DocumentTemplateV2 {
  const flow = mapAllCells(t, (cell) => cell.elements.some((item) => item.id === elementId) ? { ...cell, elements: cell.elements.map((item) => item.id === elementId ? { ...item, ...patch } : item) } : cell);
  return mapFloating(flow, elementId, (item) => ({ ...item, element: { ...item.element, ...patch } }));
}
const defaultFloatWidth = (type: ElementType) => type === "image" ? 45 : type === "box" ? 50 : type === "text" ? 70 : type === "heading" ? 90 : 90;

/* ========================================================================== *
 * Shared controls
 * ========================================================================== */

const inputClass = "dtd-input";
function Field({ label, children }: { label: string; children: ReactNode }) {
  return <label className="dtd-field"><span>{label}</span>{children}</label>;
}
function NumberInput({ value, onChange, min = 0, max = 999, step = 1, suffix }: { value?: number | undefined; onChange: (value: number) => void; min?: number; max?: number; step?: number; suffix?: string }) {
  return <div className="dtd-number"><input type="number" min={min} max={max} step={step} value={value ?? 0} onChange={(event) => onChange(Number(event.target.value))} />{suffix && <small>{suffix}</small>}</div>;
}
function ColorInput({ value, onChange, fallback = "#FFFFFF" }: { value?: string | undefined; onChange: (value: string | undefined) => void; fallback?: string }) {
  return <div className="dtd-color"><input type="color" value={value ?? fallback} onChange={(event) => onChange(event.target.value)} /><button type="button" title="Clear colour" disabled={!value} onClick={() => onChange(undefined)}><X size={12} /></button></div>;
}
function IconButton({ title, onClick, disabled, children, active }: { title: string; onClick: () => void; disabled?: boolean | undefined; children: ReactNode; active?: boolean | undefined }) {
  return <button type="button" className={cx("dtd-icon-button", active && "is-active")} title={title} aria-label={title} disabled={disabled} onClick={(event) => { event.stopPropagation(); onClick(); }}>{children}</button>;
}
function Segmented<T extends string>({ value, options, onChange }: { value: T; options: Array<{ value: T; label: ReactNode; title?: string }>; onChange: (value: T) => void }) {
  return <div className="dtd-segmented">{options.map((option) => <button type="button" title={option.title} className={value === option.value ? "is-active" : ""} key={option.value} onClick={() => onChange(option.value)}>{option.label}</button>)}</div>;
}
function RowPresets({ onPick }: { onPick: (ratios: number[]) => void }) {
  return <div className="dtd-layout-presets">{ROW_PRESETS.map((ratios) => <button type="button" key={ratios.join("-")} title={`Add ${ratios.length}-column row`} onClick={() => onPick(ratios)}>{ratios.map((ratio, index) => <i key={index} style={{ flex: ratio }} />)}</button>)}</div>;
}

function FieldPicker({ fields, onPick, label = "Insert field" }: { fields: MergeField[]; onPick: (token: string) => void; label?: string }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [manual, setManual] = useState("");
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => { if (root.current && !root.current.contains(event.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", close); return () => document.removeEventListener("mousedown", close);
  }, [open]);
  const filtered = fields.filter((field) => !field.repeating && `${field.label} ${field.key}`.toLowerCase().includes(query.toLowerCase()));
  const groups = [...new Set(filtered.map((field) => field.group ?? "Fields"))];
  return <div className="dtd-picker" ref={root}>
    <button type="button" className="dtd-secondary" onClick={() => setOpen((value) => !value)}><Braces size={13} />{label}</button>
    {open && <div className="dtd-picker-menu">
      <div className="dtd-picker-search"><Search size={14} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search DMS fields" /></div>
      <div className="dtd-picker-scroll">
        <div><h5>Page</h5><button type="button" onClick={() => { onPick("{{page}}"); setOpen(false); }}><span>Page number</span><code>page</code></button><button type="button" onClick={() => { onPick("{{pages}}"); setOpen(false); }}><span>Total pages</span><code>pages</code></button></div>
        {groups.map((group) => <div key={group}><h5>{group}</h5>{filtered.filter((field) => (field.group ?? "Fields") === group).map((field) => <button key={field.key} type="button" onClick={() => { onPick(`{{${field.key}}}`); setOpen(false); }}><span>{field.label}</span><code>{field.key}</code></button>)}</div>)}
      </div>
      <div className="dtd-manual-row"><input value={manual} onChange={(event) => setManual(event.target.value)} placeholder="Manual fill-in label" /><button type="button" disabled={!manual.trim()} onClick={() => { onPick(`[[${manual.trim()}]]`); setManual(""); setOpen(false); }}><Plus size={14} /></button></div>
    </div>}
  </div>;
}

function TokenArea({ value, onChange, fields, rows = 3 }: { value: string; onChange: (value: string) => void; fields: MergeField[]; rows?: number }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const insert = (token: string) => {
    const node = ref.current; if (!node) return onChange(value + token);
    const start = node.selectionStart; const end = node.selectionEnd;
    onChange(value.slice(0, start) + token + value.slice(end));
    requestAnimationFrame(() => { node.focus(); node.setSelectionRange(start + token.length, start + token.length); });
  };
  return <div className="dtd-token-area"><textarea ref={ref} className={inputClass} rows={rows} value={value} onChange={(event) => onChange(event.target.value)} /><FieldPicker fields={fields} onPick={insert} /></div>;
}

/* ========================================================================== *
 * Renderer
 * ========================================================================== */

type Theme = DocumentTemplateV2["theme"];

function elementStyle(element: DocumentElement, theme: Theme): CSSProperties {
  const style = element.style ?? {};
  return {
    textAlign: style.align, fontWeight: style.bold ? 700 : undefined, fontStyle: style.italic ? "italic" : undefined,
    textDecoration: style.underline ? "underline" : undefined, fontSize: style.fontSize ?? theme.baseFontSize,
    fontFamily: style.fontFamily, lineHeight: style.lineHeight,
    color: style.color ?? theme.textColor, background: style.background, padding: style.padding,
    marginTop: style.marginTop, marginBottom: style.marginBottom, minHeight: style.minHeight,
    borderWidth: style.borderWidth, borderColor: style.borderColor ?? "#CBD5E1", borderStyle: style.borderWidth ? (style.borderStyle ?? "solid") : undefined,
    borderRadius: style.radius, whiteSpace: "pre-wrap", overflowWrap: "anywhere",
  };
}

function DocumentImage({ source, alt, width, height, objectFit, opacity }: { source: string | undefined; alt: string; width?: number | undefined; height?: number | undefined; objectFit?: "contain" | "cover" | "fill" | undefined; opacity?: number | undefined }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [source]);
  return source && !failed ? <img src={source} alt={alt} onError={() => setFailed(true)} style={{ width, height, maxWidth: "100%", objectFit: objectFit ?? "contain", opacity: opacity ?? 1 }} /> : <div className="dtd-image-placeholder" style={{ width, height, maxWidth: "100%" }}><ImageIcon size={18} /><span>{alt || "Image"}</span></div>;
}

function ElementRenderer({ element, theme, data, page, pages }: { element: DocumentElement; theme: Theme; data: Record<string, unknown> | null; page: number; pages: number }) {
  const render = (value?: string) => renderedText(value, data, page, pages);
  const style = elementStyle(element, theme);
  if (element.type === "heading") return <div style={{ ...style, fontFamily: element.style?.fontFamily ?? theme.headingFamily, color: element.style?.color ?? theme.headingColor }}>{render(element.text)}</div>;
  if (element.type === "text" || element.type === "note") return <div style={style}>{render(element.text)}</div>;
  if (element.type === "box") return <div style={{ ...style, minHeight: element.style?.minHeight ?? 40, height: "100%" }} />;
  if (element.type === "divider") return <div style={{ borderTop: `${element.style?.borderWidth ?? 1}px ${element.style?.borderStyle ?? "solid"} ${element.style?.borderColor ?? "#94A3B8"}`, marginTop: element.style?.marginTop, marginBottom: element.style?.marginBottom }} />;
  if (element.type === "spacer") return <div style={{ height: element.height ?? 24 }} />;
  if (element.type === "bulleted_list" || element.type === "numbered_list") {
    const Tag = element.type === "bulleted_list" ? "ul" : "ol";
    return <Tag style={{ ...style, paddingLeft: 20, margin: 0, marginTop: style.marginTop, marginBottom: style.marginBottom }}>{(element.items ?? []).map((item, index) => <li key={index}>{render(item)}</li>)}</Tag>;
  }
  if (element.type === "field_group") return <div style={style}>{(element.fields ?? []).map((field) => <div className="dtd-kv" key={field.id}><span style={{ width: element.labelWidth ?? 120, fontWeight: field.boldLabel ? 700 : undefined }}>{render(field.label)}</span><span style={{ fontWeight: field.boldValue ? 700 : undefined }}>{render(field.value)}</span></div>)}</div>;
  if (element.type === "image") {
    const source = element.src?.trim() || (data && element.text ? valueAt(data, element.text.replace(/[{}\s]/g, "")) : undefined);
    return <div style={{ ...style, display: "flex", justifyContent: style.textAlign === "right" ? "flex-end" : style.textAlign === "center" ? "center" : "flex-start" }}><DocumentImage source={typeof source === "string" ? source : undefined} alt={element.alt ?? "Image"} width={element.width} height={element.height} objectFit={element.objectFit} opacity={element.opacity} /></div>;
  }
  if (element.type === "signature_group") return <div className="dtd-signatures" style={style}>{(element.signatories ?? []).map((sig) => <div className="dtd-signatory" key={sig.id}><strong>{sig.step ? `${sig.step}. ` : ""}{render(sig.role)}</strong><div className="dtd-signatory-line"><span>{render(sig.name)}</span><span><b>Date:</b> {render(sig.date)}</span></div>{sig.signature && <div><b>Signature:</b> {render(sig.signature)}</div>}</div>)}</div>;
  const columns = element.columns ?? [];
  const source = data && element.sourceKey ? valueAt(data, element.sourceKey) : null;
  const rows: Array<Record<string, unknown> | string[]> = Array.isArray(source)
    ? source as Array<Record<string, unknown>>
    : element.sourceKey
      ? Array.from({ length: element.previewRows ?? 2 }, () => columns.map(() => ""))
      : element.staticRows ?? [];
  const border = `${element.style?.borderWidth ?? 1}px solid ${element.style?.borderColor ?? "#475569"}`;
  return <div style={style} className="dtd-table-wrap"><table className="dtd-data-table" style={{ borderCollapse: "collapse", width: "100%", tableLayout: "fixed" }}>
    {element.showHeader !== false && <thead><tr style={{ background: element.headerBackground, color: element.headerColor }}>{columns.map((column) => <th key={column.id} style={{ width: `${column.width}%`, textAlign: column.align ?? "left", border, padding: element.cellPadding ?? 4 }}>{render(column.label)}</th>)}</tr></thead>}
    <tbody>{rows.map((row, rowIndex) => <tr key={rowIndex} style={{ background: element.striped && rowIndex % 2 ? "#F8FAFC" : undefined }}>{columns.map((column, columnIndex) => {
      const raw = Array.isArray(row) ? row[columnIndex] : row[column.key];
      return <td key={column.id} style={{ textAlign: column.align ?? "left", border, padding: element.cellPadding ?? 4, height: 18 }}>{render(String(raw ?? ""))}</td>;
    })}</tr>)}</tbody>
    {!!element.summaries?.length && <tfoot>{element.summaries.map((summary) => <tr key={summary.id}><td colSpan={Math.max(1, summary.labelSpan)} style={{ border, padding: element.cellPadding ?? 4, textAlign: "right", fontWeight: summary.bold ? 700 : undefined }}>{render(summary.label)}</td>{summary.values.map((value, index) => <td key={index} style={{ border, padding: element.cellPadding ?? 4, textAlign: "right", fontWeight: summary.bold ? 700 : undefined }}>{render(value)}</td>)}</tr>)}</tfoot>}
  </table></div>;
}

const cellAlign = (cell: GridCell) => cell.verticalAlign === "center" ? "center" : cell.verticalAlign === "end" ? "end" : "start";

function RowRenderer({ row, theme, data, page, pages, children }: { row: GridRow; theme: Theme; data: Record<string, unknown> | null; page: number; pages: number; children?: (cell: GridCell, cellIndex: number) => ReactNode }) {
  return <div className="dtd-grid-row" style={{ display: "grid", gridTemplateColumns: row.columns.map((column) => `minmax(0, ${column.width}fr)`).join(" "), gap: row.gap, marginTop: row.marginTop, marginBottom: row.marginBottom, minHeight: row.minHeight, breakInside: row.keepTogether ? "avoid" : undefined }}>
    {row.columns.map((cell, index) => children ? children(cell, index) : <div key={cell.id} style={{ alignSelf: cellAlign(cell), padding: cell.padding, background: cell.background, border: cell.borderWidth ? `${cell.borderWidth}px solid ${cell.borderColor ?? "#CBD5E1"}` : undefined }}>{cell.elements.map((element) => <ElementRenderer key={element.id} element={element} theme={theme} data={data} page={page} pages={pages} />)}</div>)}
  </div>;
}

function bandStyle(band: PageBand, template: DocumentTemplateV2): CSSProperties {
  return { minHeight: band.height, paddingLeft: `${template.page.margin.left}mm`, paddingRight: `${template.page.margin.right}mm` };
}

function BandRenderer({ band, template, data, page, pages, kind }: { band: PageBand; template: DocumentTemplateV2; data: Record<string, unknown> | null; page: number; pages: number; kind: BandKey }) {
  if (!band.enabled) return null;
  return <div className={cx("dtd-band", `dtd-${kind}`, band.border && "has-rule")} style={bandStyle(band, template)}>{band.rows.map((row) => <RowRenderer key={row.id} row={row} theme={template.theme} data={data} page={page} pages={pages} />)}</div>;
}

function Watermark({ watermark, data }: { watermark: WatermarkSettings; data: Record<string, unknown> | null }) {
  if (!watermark.enabled || !watermark.value) return null;
  const value = data ? substitute(watermark.value, data) : watermark.value;
  return <div className="dtd-watermark" style={{ opacity: watermark.opacity, transform: `translate(-50%, -50%) rotate(${watermark.rotation ?? 0}deg)`, width: watermark.width }}>{watermark.kind === "image" && value && !value.includes("{{") ? <img src={value} alt="" /> : <span>{value}</span>}</div>;
}

const floatingStyle = (item: FloatingItem): CSSProperties => ({
  left: `${item.x}mm`, top: `${item.y}mm`, width: `${item.width}mm`, height: item.height ? `${item.height}mm` : undefined,
  transform: item.rotation ? `rotate(${item.rotation}deg)` : undefined, zIndex: 5 + (item.zIndex ?? 0),
});

function FloatingLayer({ items, theme, data, page, pages }: { items: FloatingItem[]; theme: Theme; data: Record<string, unknown> | null; page: number; pages: number }) {
  return <>{items.map((item) => <div key={item.id} className="dtd-floating" style={floatingStyle(item)}><ElementRenderer element={item.element} theme={theme} data={data} page={page} pages={pages} /></div>)}</>;
}

const paperSize = (template: DocumentTemplateV2) => {
  const dims = PAGE_DIMS[template.page.size] ?? PAGE_DIMS.A4; const portrait = template.page.orientation === "portrait";
  return { width: portrait ? dims.w : dims.h, height: portrait ? dims.h : dims.w };
};
const paperStyle = (template: DocumentTemplateV2): CSSProperties => {
  const { width, height } = paperSize(template);
  return { width: `${width}mm`, minHeight: `${height}mm`, fontFamily: template.theme.fontFamily, fontSize: template.theme.baseFontSize, lineHeight: template.theme.lineHeight, ["--dtd-accent" as string]: template.theme.accentColor };
};

/* ========================================================================== *
 * Design canvas and dragging
 * ========================================================================== */

interface CanvasCtx {
  template: DocumentTemplateV2;
  selection: Selection | null;
  onSelect: (selection: Selection) => void;
  rowAction: (rowId: string, action: RowAction) => void;
  elementAction: (elementId: string, action: ElementAction) => void;
  patchElementById: (elementId: string, patch: Partial<DocumentElement>) => void;
  pageNo: number;
  pages: number;
}

function PaletteItem({ type }: { type: ElementType }) {
  const meta = elementMeta[type]; const Icon = meta.icon;
  const draggable = useDraggable({ id: `palette:${type}`, data: { source: "palette", type } });
  return <button ref={draggable.setNodeRef} {...draggable.listeners} {...draggable.attributes} type="button" className={cx("dtd-palette-item", draggable.isDragging && "is-dragging")} title={meta.hint}><Icon size={15} /><span>{meta.label}</span></button>;
}

function Palette({ onAddRow }: { onAddRow: (ratios: number[]) => void }) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState<Record<PaletteGroup, boolean>>({ text: true, data: true, media: true, layout: true, signoff: true });
  const types = Object.keys(elementMeta) as ElementType[];
  const filtered = types.filter((type) => elementMeta[type].label.toLowerCase().includes(query.toLowerCase()));
  return <aside className="dtd-palette"><div className="dtd-panel-title"><span>Elements</span></div><div className="dtd-search"><Search size={14} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search elements" /></div><div className="dtd-palette-scroll">
    {groupLabels.map((group) => { const items = filtered.filter((type) => elementMeta[type].group === group.key); if (!items.length) return null; return <section key={group.key}><button type="button" className="dtd-group-title" onClick={() => setOpen((state) => ({ ...state, [group.key]: !state[group.key] }))}>{open[group.key] ? <ChevronDown size={13} /> : <ChevronRight size={13} />}<span>{group.label}</span><small>{items.length}</small></button>{open[group.key] && items.map((type) => <PaletteItem key={type} type={type} />)}</section>; })}
    <section><div className="dtd-group-title static"><Columns2 size={13} /><span>Rows & columns</span></div><RowPresets onPick={onAddRow} /></section>
  </div><div className="dtd-palette-help">Drag an element into a cell, onto another element, between rows, or onto empty paper to place it freely. Double-click text to edit it in place.</div></aside>;
}

const INLINE_EDITABLE: ElementType[] = ["text", "heading", "note"];

function EditableContent({ element, ctx }: { element: DocumentElement; ctx: CanvasCtx }) {
  const [editing, setEditing] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { if (editing && ref.current) { ref.current.focus(); ref.current.select(); } }, [editing]);
  const canEdit = INLINE_EDITABLE.includes(element.type);
  if (editing && canEdit) {
    const base = elementStyle(element, ctx.template.theme);
    return <textarea ref={ref} className="dtd-inline-editor" value={element.text ?? ""} rows={Math.max(1, (element.text ?? "").split("\n").length)}
      style={{ ...base, fontFamily: element.type === "heading" ? (element.style?.fontFamily ?? ctx.template.theme.headingFamily) : base.fontFamily, color: element.type === "heading" ? (element.style?.color ?? ctx.template.theme.headingColor) : base.color }}
      onClick={(event) => event.stopPropagation()} onPointerDown={(event) => event.stopPropagation()}
      onKeyDown={(event) => { event.stopPropagation(); if (event.key === "Escape") setEditing(false); }}
      onBlur={() => setEditing(false)} onChange={(event) => ctx.patchElementById(element.id, { text: event.target.value })} />;
  }
  return <div onDoubleClick={(event) => { if (!canEdit) return; event.stopPropagation(); setEditing(true); }}><ElementRenderer element={element} theme={ctx.template.theme} data={null} page={ctx.pageNo} pages={ctx.pages} /></div>;
}

function ElementFrame({ element, cid, rowId, cellId, ctx }: { element: DocumentElement; cid: string; rowId: string; cellId: string; ctx: CanvasCtx }) {
  const drag = useDraggable({ id: `element:${element.id}`, data: { source: "element", elementId: element.id } });
  const drop = useDroppable({ id: `drop-el:${element.id}`, data: { source: "element-target", elementId: element.id } });
  const selected = ctx.selection?.kind === "element" && ctx.selection.elementId === element.id;
  const setRef = (node: HTMLDivElement | null) => { drag.setNodeRef(node); drop.setNodeRef(node); };
  return <div ref={setRef} className={cx("dtd-element-frame", selected && "is-selected", drag.isDragging && "is-dragging", drop.isOver && !drag.isDragging && "is-drop-before")} onClick={(event) => { event.stopPropagation(); ctx.onSelect({ kind: "element", pageId: cid, rowId, cellId, elementId: element.id }); }}>
    <div className="dtd-element-toolbar"><button type="button" className="dtd-grip" title="Drag element anywhere" {...drag.listeners} {...drag.attributes}><GripVertical size={13} /></button><IconButton title="Move up" onClick={() => ctx.elementAction(element.id, "up")}><ArrowUp size={12} /></IconButton><IconButton title="Move down" onClick={() => ctx.elementAction(element.id, "down")}><ArrowDown size={12} /></IconButton><IconButton title="Duplicate" onClick={() => ctx.elementAction(element.id, "duplicate")}><Copy size={12} /></IconButton><IconButton title="Delete" onClick={() => ctx.elementAction(element.id, "delete")}><Trash2 size={12} /></IconButton></div>
    <EditableContent element={element} ctx={ctx} />
  </div>;
}

function CellCanvas({ cid, row, cell, ctx }: { cid: string; row: GridRow; cell: GridCell; ctx: CanvasCtx }) {
  const drop = useDroppable({ id: `cell:${cell.id}`, data: { source: "cell", cellId: cell.id } });
  const selected = ctx.selection?.kind === "cell" && ctx.selection.cellId === cell.id;
  return <div ref={drop.setNodeRef} className={cx("dtd-cell-canvas", selected && "is-selected", drop.isOver && "is-over")} style={{ alignSelf: cellAlign(cell), padding: cell.padding, background: cell.background, borderWidth: cell.borderWidth ?? 0, borderColor: cell.borderColor ?? "#CBD5E1", minHeight: row.minHeight }} onClick={(event) => { event.stopPropagation(); ctx.onSelect({ kind: "cell", pageId: cid, rowId: row.id, cellId: cell.id }); }}>
    {cell.elements.map((element) => <ElementFrame key={element.id} element={element} cid={cid} rowId={row.id} cellId={cell.id} ctx={ctx} />)}
    {!cell.elements.length && <div className="dtd-empty-cell"><Plus size={13} />Drop here</div>}
  </div>;
}

function RowGap({ cid, index, label }: { cid: string; index: number; label?: string }) {
  const { active } = useDndContext();
  const drop = useDroppable({ id: `gap:${cid}:${index}`, data: { source: "gap", cid, index } });
  return <div ref={drop.setNodeRef} className={cx("dtd-gap", !!active && "is-active", drop.isOver && "is-over", label && "has-label")}>{label && <span><Plus size={12} />{label}</span>}</div>;
}

function RowsCanvas({ cid, rows, ctx, emptyLabel }: { cid: string; rows: GridRow[]; ctx: CanvasCtx; emptyLabel: string }) {
  if (!rows.length) return <RowGap cid={cid} index={0} label={emptyLabel} />;
  return <>{rows.map((row, index) => <Fragment key={row.id}>
    <RowGap cid={cid} index={index} />
    <div className={cx("dtd-row-frame", ctx.selection?.kind === "row" && ctx.selection.rowId === row.id && "is-selected")} onClick={(event) => { event.stopPropagation(); ctx.onSelect({ kind: "row", pageId: cid, rowId: row.id }); }}>
      <div className="dtd-row-toolbar">
        <IconButton title="Insert row above" onClick={() => ctx.rowAction(row.id, "insertAbove")}><ArrowUpToLine size={12} /></IconButton>
        <IconButton title="Insert row below" onClick={() => ctx.rowAction(row.id, "insertBelow")}><ArrowDownToLine size={12} /></IconButton>
        <IconButton title="Add column" onClick={() => ctx.rowAction(row.id, "addColumn")}><Columns2 size={12} /></IconButton>
        <IconButton title="Move row up" onClick={() => ctx.rowAction(row.id, "up")}><ArrowUp size={12} /></IconButton>
        <IconButton title="Move row down" onClick={() => ctx.rowAction(row.id, "down")}><ArrowDown size={12} /></IconButton>
        <IconButton title="Duplicate row" onClick={() => ctx.rowAction(row.id, "duplicate")}><Copy size={12} /></IconButton>
        <IconButton title="Delete row" onClick={() => ctx.rowAction(row.id, "delete")}><Trash2 size={12} /></IconButton>
      </div>
      <RowRenderer row={row} theme={ctx.template.theme} data={null} page={ctx.pageNo} pages={ctx.pages}>{(cell) => <CellCanvas key={cell.id} cid={cid} row={row} cell={cell} ctx={ctx} />}</RowRenderer>
    </div>
  </Fragment>)}<RowGap cid={cid} index={rows.length} /></>;
}

function FloatingFrame({ item, pageId, ctx }: { item: FloatingItem; pageId: string; ctx: CanvasCtx }) {
  const drag = useDraggable({ id: `floating:${item.element.id}`, data: { source: "floating", elementId: item.element.id, pageId } });
  const selected = ctx.selection?.kind === "floating" && ctx.selection.elementId === item.element.id;
  return <div ref={drag.setNodeRef} className={cx("dtd-floating", "dtd-floating-edit", selected && "is-selected", drag.isDragging && "is-dragging")} style={floatingStyle(item)} onClick={(event) => { event.stopPropagation(); ctx.onSelect({ kind: "floating", pageId, elementId: item.element.id }); }}>
    <div className="dtd-element-toolbar"><button type="button" className="dtd-grip" title="Move" {...drag.listeners} {...drag.attributes}><Move size={13} /></button><IconButton title="Bring forward" onClick={() => ctx.elementAction(item.element.id, "forward")}><BringToFront size={12} /></IconButton><IconButton title="Send backward" onClick={() => ctx.elementAction(item.element.id, "backward")}><SendToBack size={12} /></IconButton><IconButton title="Duplicate" onClick={() => ctx.elementAction(item.element.id, "duplicate")}><Copy size={12} /></IconButton><IconButton title="Delete" onClick={() => ctx.elementAction(item.element.id, "delete")}><Trash2 size={12} /></IconButton></div>
    <EditableContent element={item.element} ctx={ctx} />
  </div>;
}

function BandCanvas({ kind, ctx, hidden }: { kind: BandKey; ctx: CanvasCtx; hidden: boolean }) {
  const band = ctx.template[kind];
  const selected = ctx.selection?.kind === "band" && ctx.selection.band === kind;
  const label = kind === "header" ? "Header" : "Footer";
  if (!band.enabled || hidden) return <button type="button" className={cx("dtd-band-placeholder", `is-${kind}`, selected && "is-selected")} onClick={(event) => { event.stopPropagation(); ctx.onSelect({ kind: "band", band: kind }); }}>{hidden ? `${label} hidden on this page` : `+ Add ${label.toLowerCase()}`}</button>;
  return <div className={cx("dtd-editable-band", `is-${kind}`, selected && "is-selected")} onClick={(event) => { event.stopPropagation(); ctx.onSelect({ kind: "band", band: kind }); }}>
    <span className="dtd-band-tag">{label} · every page</span>
    <div className={cx("dtd-band", `dtd-${kind}`, band.border && "has-rule")} style={bandStyle(band, ctx.template)}><RowsCanvas cid={kind} rows={band.rows} ctx={ctx} emptyLabel={`Drop elements into the ${label.toLowerCase()}`} /></div>
  </div>;
}

function DesignerPage({ page, pageIndex, ctx }: { page: DocumentPage; pageIndex: number; ctx: CanvasCtx }) {
  const { template } = ctx; const margin = template.page.margin;
  const drop = useDroppable({ id: `paper:${page.id}`, data: { source: "paper", pageId: page.id } });
  const pageCtx: CanvasCtx = { ...ctx, pageNo: pageIndex + 1 };
  const selected = ctx.selection?.kind === "page" && ctx.selection.pageId === page.id;
  return <div className="dtd-page-wrap" style={{ width: `${paperSize(template).width}mm` }}><div className="dtd-page-label">{page.name} · Page {pageIndex + 1} of {template.pages.length}</div>
    <article ref={drop.setNodeRef} className={cx("dtd-paper", selected && "is-selected", drop.isOver && "is-over")} style={paperStyle(template)} onClick={() => ctx.onSelect({ kind: "page", pageId: page.id })}>
      <Watermark watermark={template.watermark} data={null} />
      <BandCanvas kind="header" ctx={pageCtx} hidden={page.showHeader === false} />
      <div className="dtd-page-content" style={{ padding: `${margin.top}mm ${margin.right}mm ${margin.bottom}mm ${margin.left}mm` }}><RowsCanvas cid={page.id} rows={page.rows} ctx={pageCtx} emptyLabel="Drop an element here, add a row layout, or drop anywhere on the paper to place freely" /></div>
      <BandCanvas kind="footer" ctx={pageCtx} hidden={page.showFooter === false} />
      {(page.floating ?? []).map((item) => <FloatingFrame key={item.id} item={item} pageId={page.id} ctx={pageCtx} />)}
    </article></div>;
}

/* ========================================================================== *
 * Inspector
 * ========================================================================== */

interface DesignerApi {
  patchElement: (elementId: string, patch: Partial<DocumentElement>) => void;
  patchFloating: (elementId: string, patch: Partial<FloatingItem>) => void;
  patchRow: (rowId: string, patch: Partial<GridRow>) => void;
  patchCell: (cellId: string, patch: Partial<GridCell>) => void;
  patchBand: (band: BandKey, patch: Partial<PageBand>) => void;
  patchPage: (pageId: string, patch: Partial<DocumentPage>) => void;
  addRow: (cid: string, ratios: number[]) => void;
  addColumn: (rowId: string, afterCellId?: string) => void;
  removeColumn: (rowId: string, cellId: string) => void;
  addFloating: (pageId: string, type: ElementType) => void;
  toFloating: (elementId: string) => void;
  toFlow: (elementId: string) => void;
  elementAction: (elementId: string, action: ElementAction) => void;
}

function StyleInspector({ element, patch }: { element: DocumentElement; patch: (value: Partial<DocumentElement>) => void }) {
  const style = element.style ?? {};
  const setStyle = (value: { [K in keyof ElementStyle]?: ElementStyle[K] | undefined }) => {
    const next: Record<string, unknown> = { ...style, ...value };
    Object.keys(next).forEach((key) => { if (next[key] === undefined) delete next[key]; });
    patch({ style: next as ElementStyle });
  };
  const isText = !(["box", "divider", "spacer", "image"] as ElementType[]).includes(element.type);
  return <div className="dtd-inspector-section"><h4>Style</h4>
    {isText && <>
      <Field label="Alignment"><Segmented value={style.align ?? "left"} onChange={(align) => setStyle({ align })} options={[{ value: "left", label: <AlignLeft size={14} />, title: "Left" }, { value: "center", label: <AlignCenter size={14} />, title: "Center" }, { value: "right", label: <AlignRight size={14} />, title: "Right" }, { value: "justify", label: <AlignJustify size={14} />, title: "Justify" }]} /></Field>
      <div className="dtd-inline-controls"><IconButton title="Bold" active={style.bold} onClick={() => setStyle({ bold: !style.bold })}><Bold size={14} /></IconButton><IconButton title="Italic" active={style.italic} onClick={() => setStyle({ italic: !style.italic })}><Italic size={14} /></IconButton><IconButton title="Underline" active={style.underline} onClick={() => setStyle({ underline: !style.underline })}><Underline size={14} /></IconButton></div>
      <Field label="Font"><select className={inputClass} value={style.fontFamily ?? ""} onChange={(event) => setStyle({ fontFamily: event.target.value || undefined })}><option value="">Document default</option>{FONT_OPTIONS.map((font) => <option key={font.value} value={font.value}>{font.label}</option>)}</select></Field>
      <div className="dtd-two"><Field label="Font size"><NumberInput value={style.fontSize} min={6} max={120} onChange={(fontSize) => setStyle({ fontSize })} suffix="px" /></Field><Field label="Line height"><NumberInput value={style.lineHeight} min={0.8} max={4} step={0.05} onChange={(lineHeight) => setStyle({ lineHeight: lineHeight || undefined })} /></Field></div>
      <Field label="Text colour"><ColorInput value={style.color} fallback="#111827" onChange={(color) => setStyle({ color })} /></Field>
    </>}
    {element.type === "image" && <Field label="Alignment"><Segmented value={style.align ?? "left"} onChange={(align) => setStyle({ align })} options={[{ value: "left", label: <AlignLeft size={14} /> }, { value: "center", label: <AlignCenter size={14} /> }, { value: "right", label: <AlignRight size={14} /> }]} /></Field>}
    <div className="dtd-two"><Field label="Space above"><NumberInput value={style.marginTop} onChange={(marginTop) => setStyle({ marginTop })} suffix="px" /></Field><Field label="Space below"><NumberInput value={style.marginBottom} onChange={(marginBottom) => setStyle({ marginBottom })} suffix="px" /></Field></div>
    {element.type !== "divider" && <>
      <div className="dtd-two"><Field label="Padding"><NumberInput value={style.padding} onChange={(padding) => setStyle({ padding })} suffix="px" /></Field><Field label="Min height"><NumberInput value={style.minHeight} onChange={(minHeight) => setStyle({ minHeight: minHeight || undefined })} suffix="px" /></Field></div>
      <Field label="Background"><ColorInput value={style.background} onChange={(background) => setStyle({ background })} /></Field>
      <div className="dtd-two"><Field label="Radius"><NumberInput value={style.radius} max={200} onChange={(radius) => setStyle({ radius })} suffix="px" /></Field><Field label="Border width"><NumberInput value={style.borderWidth} max={12} onChange={(borderWidth) => setStyle({ borderWidth })} suffix="px" /></Field></div>
    </>}
    {element.type === "divider" && <Field label="Thickness"><NumberInput value={style.borderWidth} min={1} max={12} onChange={(borderWidth) => setStyle({ borderWidth })} suffix="px" /></Field>}
    <div className="dtd-two"><Field label="Border style"><select className={inputClass} value={style.borderStyle ?? "solid"} onChange={(event) => setStyle({ borderStyle: event.target.value as ElementStyle["borderStyle"] })}><option value="solid">Solid</option><option value="dashed">Dashed</option><option value="dotted">Dotted</option></select></Field><Field label="Border colour"><ColorInput value={style.borderColor} fallback="#CBD5E1" onChange={(borderColor) => setStyle({ borderColor })} /></Field></div>
  </div>;
}

function ElementInspector({ element, fields, patch }: { element: DocumentElement; fields: MergeField[]; patch: (value: Partial<DocumentElement>) => void }) {
  const updateList = (index: number, value: string) => patch({ items: (element.items ?? []).map((item, itemIndex) => itemIndex === index ? value : item) });
  const setField = (id: string, value: Partial<FieldPair>) => patch({ fields: (element.fields ?? []).map((field) => field.id === id ? { ...field, ...value } : field) });
  return <div>
    <div className="dtd-inspector-section"><h4>Content</h4>
      {INLINE_EDITABLE.includes(element.type) && <TokenArea value={element.text ?? ""} onChange={(textValue) => patch({ text: textValue })} fields={fields} rows={element.type === "text" ? 5 : 2} />}
      {element.type === "heading" && <Field label="Heading level"><Segmented value={String(element.level ?? 2)} onChange={(value) => patch({ level: Number(value) as 1 | 2 | 3 })} options={[1, 2, 3].map((level) => ({ value: String(level), label: `H${level}` }))} /></Field>}
      {(element.type === "bulleted_list" || element.type === "numbered_list") && <div className="dtd-stack">{(element.items ?? []).map((item, index) => <div className="dtd-list-input" key={index}><textarea value={item} rows={2} onChange={(event) => updateList(index, event.target.value)} /><IconButton title="Remove item" onClick={() => patch({ items: (element.items ?? []).filter((_, itemIndex) => itemIndex !== index) })}><Trash2 size={13} /></IconButton></div>)}<button type="button" className="dtd-secondary" onClick={() => patch({ items: [...(element.items ?? []), "New item"] })}><Plus size={13} />Add item</button></div>}
      {element.type === "field_group" && <div className="dtd-stack"><Field label="Label width"><NumberInput value={element.labelWidth} onChange={(labelWidth) => patch({ labelWidth })} suffix="px" /></Field>{(element.fields ?? []).map((item) => <div className="dtd-box" key={item.id}><input className={inputClass} value={item.label} placeholder="Label" onChange={(event) => setField(item.id, { label: event.target.value })} /><TokenArea rows={2} fields={fields} value={item.value} onChange={(value) => setField(item.id, { value })} /><div className="dtd-check-row"><label><input type="checkbox" checked={!!item.boldLabel} onChange={(event) => setField(item.id, { boldLabel: event.target.checked })} />Bold label</label><label><input type="checkbox" checked={!!item.boldValue} onChange={(event) => setField(item.id, { boldValue: event.target.checked })} />Bold value</label><IconButton title="Remove row" onClick={() => patch({ fields: (element.fields ?? []).filter((field) => field.id !== item.id) })}><Trash2 size={13} /></IconButton></div></div>)}<button type="button" className="dtd-secondary" onClick={() => patch({ fields: [...(element.fields ?? []), { id: uid(), label: "Label", value: "" }] })}><Plus size={13} />Add field row</button></div>}
      {element.type === "image" && <><Field label="Image field or URL"><TokenArea value={element.text || element.src || ""} onChange={(value) => patch(value.trim().startsWith("{{") ? { text: value, src: "" } : { src: value, text: "" })} fields={fields} rows={2} /></Field><label className="dtd-upload"><Upload size={14} />Choose local image<input type="file" accept="image/*" onChange={(event) => { const file = event.target.files?.[0]; if (!file) return; const reader = new FileReader(); reader.onload = () => patch({ src: String(reader.result), text: "" }); reader.readAsDataURL(file); }} /></label><div className="dtd-two"><Field label="Width"><NumberInput value={element.width} onChange={(width) => patch({ width })} suffix="px" /></Field><Field label="Height"><NumberInput value={element.height} onChange={(height) => patch({ height })} suffix="px" /></Field></div><div className="dtd-two"><Field label="Fit"><select className={inputClass} value={element.objectFit ?? "contain"} onChange={(event) => patch({ objectFit: event.target.value as "contain" | "cover" | "fill" })}><option value="contain">Contain</option><option value="cover">Cover</option><option value="fill">Stretch</option></select></Field><Field label="Opacity"><NumberInput value={element.opacity ?? 1} min={0} max={1} step={0.05} onChange={(opacity) => patch({ opacity })} /></Field></div><Field label="Alternative text"><input className={inputClass} value={element.alt ?? ""} onChange={(event) => patch({ alt: event.target.value })} /></Field></>}
      {element.type === "spacer" && <Field label="Height"><NumberInput value={element.height} onChange={(height) => patch({ height })} suffix="px" /></Field>}
      {element.type === "box" && <p className="dtd-hint">Use the style options below to set colour, border and size. Float it on the page to use it as a background or frame.</p>}
      {element.type === "divider" && <p className="dtd-hint">Adjust thickness, style and colour below.</p>}
      {element.type === "data_table" && <TableInspector element={element} fields={fields} patch={patch} />}
      {element.type === "signature_group" && <SignatureInspector element={element} fields={fields} patch={patch} />}
    </div>
    {element.type !== "spacer" && <StyleInspector element={element} patch={patch} />}
  </div>;
}

function TableInspector({ element, fields, patch }: { element: DocumentElement; fields: MergeField[]; patch: (value: Partial<DocumentElement>) => void }) {
  const collections = fields.filter((field) => field.repeating);
  const collection = collections.find((field) => field.key === element.sourceKey);
  const columns = element.columns ?? [];
  const staticRows = element.staticRows ?? [];
  const setColumn = (id: string, value: Partial<TableColumn>) => patch({ columns: columns.map((item) => item.id === id ? { ...item, ...value } : item) });
  const removeColumn = (index: number) => patch({ columns: columns.filter((_, i) => i !== index), staticRows: staticRows.map((row) => row.filter((_, i) => i !== index)) });
  const addColumn = () => patch({ columns: [...columns, { id: uid(), key: collection?.children?.[0]?.key ?? `col${columns.length + 1}`, label: `Column ${columns.length + 1}`, width: 15 }], staticRows: staticRows.map((row) => [...row, ""]) });
  const setCell = (r: number, c: number, value: string) => patch({ staticRows: staticRows.map((row, ri) => ri === r ? columns.map((_, ci) => ci === c ? value : (row[ci] ?? "")) : row) });
  return <div className="dtd-stack">
    <Field label="Rows come from"><select className={inputClass} value={element.sourceKey ?? ""} onChange={(event) => patch({ sourceKey: event.target.value })}><option value="">Static rows (typed below)</option>{collections.map((field) => <option key={field.key} value={field.key}>DMS: {field.label}</option>)}</select></Field>
    <div className="dtd-check-row"><label><input type="checkbox" checked={element.showHeader !== false} onChange={(event) => patch({ showHeader: event.target.checked })} />Header</label><label><input type="checkbox" checked={!!element.repeatHeader} onChange={(event) => patch({ repeatHeader: event.target.checked })} />Repeat</label><label><input type="checkbox" checked={!!element.striped} onChange={(event) => patch({ striped: event.target.checked })} />Striped</label></div>
    <div className="dtd-two"><Field label="Header fill"><ColorInput value={element.headerBackground} onChange={(headerBackground) => patch({ headerBackground: headerBackground ?? "" })} /></Field><Field label="Header text"><ColorInput value={element.headerColor} fallback="#111827" onChange={(headerColor) => patch({ headerColor: headerColor ?? "" })} /></Field></div>
    <div className="dtd-two"><Field label="Cell padding"><NumberInput value={element.cellPadding} max={24} onChange={(cellPadding) => patch({ cellPadding })} suffix="px" /></Field>{element.sourceKey ? <Field label="Preview rows"><NumberInput value={element.previewRows} min={1} max={20} onChange={(previewRows) => patch({ previewRows })} /></Field> : <span />}</div>
    <h5 className="dtd-subtitle">Columns</h5>
    {columns.map((column, index) => <div className="dtd-box" key={column.id}>
      <div className="dtd-list-input"><input className={inputClass} value={column.label} onChange={(event) => setColumn(column.id, { label: event.target.value })} /><IconButton title="Remove column" onClick={() => removeColumn(index)}><Trash2 size={13} /></IconButton></div>
      <div className="dtd-two">
        {element.sourceKey ? <Field label="Data field">{collection?.children?.length ? <select className={inputClass} value={column.key} onChange={(event) => setColumn(column.id, { key: event.target.value })}>{collection.children.map((child) => <option key={child.key} value={child.key}>{child.label}</option>)}{!collection.children.some((child) => child.key === column.key) && <option value={column.key}>{column.key}</option>}</select> : <input className={inputClass} value={column.key} onChange={(event) => setColumn(column.id, { key: event.target.value })} />}</Field> : <Field label="Align"><select className={inputClass} value={column.align ?? "left"} onChange={(event) => setColumn(column.id, { align: event.target.value as Align })}><option value="left">Left</option><option value="center">Center</option><option value="right">Right</option></select></Field>}
        <Field label="Width %"><NumberInput value={column.width} min={1} max={100} onChange={(width) => setColumn(column.id, { width })} /></Field>
      </div>
      {element.sourceKey && <Field label="Align"><select className={inputClass} value={column.align ?? "left"} onChange={(event) => setColumn(column.id, { align: event.target.value as Align })}><option value="left">Left</option><option value="center">Center</option><option value="right">Right</option></select></Field>}
    </div>)}
    <button type="button" className="dtd-secondary" onClick={addColumn}><Plus size={13} />Add column</button>
    {!element.sourceKey && <>
      <h5 className="dtd-subtitle">Rows</h5>
      {staticRows.map((row, r) => <div className="dtd-box dtd-static-row" key={r}>{columns.map((column, c) => <input key={column.id} className={inputClass} placeholder={column.label} value={row[c] ?? ""} onChange={(event) => setCell(r, c, event.target.value)} />)}<IconButton title="Remove row" onClick={() => patch({ staticRows: staticRows.filter((_, i) => i !== r) })}><Trash2 size={13} /></IconButton></div>)}
      <button type="button" className="dtd-secondary" onClick={() => patch({ staticRows: [...staticRows, columns.map(() => "")] })}><Plus size={13} />Add row</button>
    </>}
    <h5 className="dtd-subtitle">Summary rows</h5>
    {(element.summaries ?? []).map((summary) => <div className="dtd-box" key={summary.id}><TokenArea fields={fields} value={summary.label} onChange={(label) => patch({ summaries: (element.summaries ?? []).map((item) => item.id === summary.id ? { ...item, label } : item) })} rows={2} /><Field label="Label spans columns"><div className="dtd-list-input"><NumberInput value={summary.labelSpan} min={1} max={Math.max(1, columns.length)} onChange={(labelSpan) => patch({ summaries: (element.summaries ?? []).map((item) => item.id === summary.id ? { ...item, labelSpan } : item) })} /><IconButton title="Remove summary" onClick={() => patch({ summaries: (element.summaries ?? []).filter((item) => item.id !== summary.id) })}><Trash2 size={13} /></IconButton></div></Field><Field label="Remaining cell values (separate with |)"><input className={inputClass} value={summary.values.join(" | ")} onChange={(event) => patch({ summaries: (element.summaries ?? []).map((item) => item.id === summary.id ? { ...item, values: event.target.value.split("|").map((value) => value.trim()) } : item) })} /></Field></div>)}
    <button type="button" className="dtd-secondary" onClick={() => patch({ summaries: [...(element.summaries ?? []), { id: uid(), label: "Total", labelSpan: Math.max(1, columns.length - 1), values: [""], bold: true }] })}><Plus size={13} />Add summary</button>
  </div>;
}

function SignatureInspector({ element, fields, patch }: { element: DocumentElement; fields: MergeField[]; patch: (value: Partial<DocumentElement>) => void }) {
  const signatures = element.signatories ?? [];
  const set = (id: string, value: Partial<Signatory>) => patch({ signatories: signatures.map((item) => item.id === id ? { ...item, ...value } : item) });
  return <div className="dtd-stack">{signatures.map((signature) => <div className="dtd-box" key={signature.id}><div className="dtd-list-input"><input className={inputClass} value={signature.step ?? ""} placeholder="Step" onChange={(event) => set(signature.id, { step: event.target.value })} /><IconButton title="Remove signatory" onClick={() => patch({ signatories: signatures.filter((item) => item.id !== signature.id) })}><Trash2 size={13} /></IconButton></div><Field label="Role"><TokenArea fields={fields} value={signature.role} onChange={(role) => set(signature.id, { role })} rows={2} /></Field><Field label="Name"><TokenArea fields={fields} value={signature.name} onChange={(name) => set(signature.id, { name })} rows={2} /></Field><Field label="Date"><TokenArea fields={fields} value={signature.date} onChange={(date) => set(signature.id, { date })} rows={2} /></Field><Field label="Signature"><TokenArea fields={fields} value={signature.signature ?? ""} onChange={(signatureValue) => set(signature.id, { signature: signatureValue })} rows={2} /></Field></div>)}<button type="button" className="dtd-secondary" onClick={() => patch({ signatories: [...signatures, { id: uid(), step: String(signatures.length + 1), role: "Signed by", name: "[[Name]]", date: "[[Date]]", signature: "[[Signature]]" }] })}><Plus size={13} />Add signatory</button></div>;
}

const FLOAT_QUICK_ADD: ElementType[] = ["text", "heading", "image", "box", "divider", "field_group", "data_table"];

function Inspector({ template, selection, fields, api, onClose }: { template: DocumentTemplateV2; selection: Selection | null; fields: MergeField[]; api: DesignerApi; onClose: () => void }) {
  let title = "Properties";
  let body: ReactNode = <div className="dtd-empty-inspector"><Settings size={30} /><p>Select the page, a row, a cell, or an element.</p></div>;

  if (selection?.kind === "band") {
    const key = selection.band; const band = template[key];
    title = key === "header" ? "Header" : "Footer";
    body = <div className="dtd-inspector-section"><h4>{title}</h4>
      <label className="dtd-checkbox"><input type="checkbox" checked={band.enabled} onChange={(event) => api.patchBand(key, { enabled: event.target.checked })} />Show {title.toLowerCase()} on every page</label>
      <label className="dtd-checkbox"><input type="checkbox" checked={!!band.border} onChange={(event) => api.patchBand(key, { border: event.target.checked })} />Divider rule</label>
      <Field label="Minimum height"><NumberInput value={band.height} onChange={(height) => api.patchBand(key, { height })} suffix="px" /></Field>
      <h4>Add row to {title.toLowerCase()}</h4><RowPresets onPick={(ratios) => api.addRow(key, ratios)} />
      <p className="dtd-hint">Drag elements from the left panel straight into the {title.toLowerCase()} on the page. Hide it on individual pages from the page properties.</p>
    </div>;
  }

  if (selection?.kind === "page") {
    const page = template.pages.find((item) => item.id === selection.pageId);
    if (page) {
      title = "Page";
      body = <div className="dtd-inspector-section"><h4>Page</h4>
        <Field label="Page name"><input className={inputClass} value={page.name} onChange={(event) => api.patchPage(page.id, { name: event.target.value })} /></Field>
        <label className="dtd-checkbox"><input type="checkbox" checked={page.showHeader !== false} onChange={(event) => api.patchPage(page.id, { showHeader: event.target.checked })} />Show header on this page</label>
        <label className="dtd-checkbox"><input type="checkbox" checked={page.showFooter !== false} onChange={(event) => api.patchPage(page.id, { showFooter: event.target.checked })} />Show footer on this page</label>
        <h4>Add row</h4><RowPresets onPick={(ratios) => api.addRow(page.id, ratios)} />
        <h4>Place freely on page</h4>
        <div className="dtd-float-add">{FLOAT_QUICK_ADD.map((type) => { const Icon = elementMeta[type].icon; return <button key={type} type="button" className="dtd-secondary" onClick={() => api.addFloating(page.id, type)}><Icon size={13} />{elementMeta[type].label}</button>; })}</div>
        <p className="dtd-hint">Free elements can sit anywhere — over the header, in the margins, or on top of other content. Drag them by the move handle.</p>
      </div>;
    }
  }

  if (selection?.kind === "element" || selection?.kind === "floating") {
    const loc = locateElement(template, selection.elementId);
    if (loc) {
      const element = loc.element;
      title = elementMeta[element.type].label;
      const patch = (value: Partial<DocumentElement>) => api.patchElement(element.id, value);
      const floating = "floating" in loc ? loc.floating : null;
      body = <>
        {floating ? <div className="dtd-inspector-section"><h4>Position on page</h4>
          <div className="dtd-two"><Field label="X (from left)"><NumberInput value={floating.x} min={-50} max={500} onChange={(x) => api.patchFloating(element.id, { x })} suffix="mm" /></Field><Field label="Y (from top)"><NumberInput value={floating.y} min={-50} max={500} onChange={(y) => api.patchFloating(element.id, { y })} suffix="mm" /></Field></div>
          <div className="dtd-two"><Field label="Width"><NumberInput value={floating.width} min={2} max={500} onChange={(width) => api.patchFloating(element.id, { width })} suffix="mm" /></Field><Field label="Height (0 = auto)"><NumberInput value={floating.height ?? 0} max={500} onChange={(height) => api.patchFloating(element.id, height ? { height } : { height: 0 })} suffix="mm" /></Field></div>
          <div className="dtd-two"><Field label="Rotation"><NumberInput value={floating.rotation ?? 0} min={-180} max={180} onChange={(rotation) => api.patchFloating(element.id, { rotation })} suffix="°" /></Field><Field label="Layer"><NumberInput value={floating.zIndex ?? 0} min={-5} max={50} onChange={(zIndex) => api.patchFloating(element.id, { zIndex })} /></Field></div>
          <button type="button" className="dtd-secondary dtd-full" onClick={() => api.toFlow(element.id)}><Rows3 size={13} />Put back into page flow</button>
        </div> : !isBand((loc as FlowLocation).cid) && <div className="dtd-inspector-section"><button type="button" className="dtd-secondary dtd-full" onClick={() => api.toFloating(element.id)}><Move size={13} />Detach and place freely</button></div>}
        <ElementInspector element={element} fields={fields} patch={patch} />
        <div className="dtd-inspector-section"><button type="button" className="dtd-secondary dtd-full dtd-danger" onClick={() => api.elementAction(element.id, "delete")}><Trash2 size={13} />Delete element</button></div>
      </>;
    }
  }

  if (selection?.kind === "row") {
    const found = findRow(template, selection.rowId);
    if (found) {
      const row = found.row; title = "Row";
      body = <div className="dtd-inspector-section"><h4>Structure</h4>
        <div className="dtd-two"><Field label="Column gap"><NumberInput value={row.gap} max={80} onChange={(gap) => api.patchRow(row.id, { gap })} suffix="px" /></Field><Field label="Min height"><NumberInput value={row.minHeight} onChange={(minHeight) => api.patchRow(row.id, { minHeight })} suffix="px" /></Field></div>
        <div className="dtd-two"><Field label="Space above"><NumberInput value={row.marginTop} onChange={(marginTop) => api.patchRow(row.id, { marginTop })} suffix="px" /></Field><Field label="Space below"><NumberInput value={row.marginBottom} onChange={(marginBottom) => api.patchRow(row.id, { marginBottom })} suffix="px" /></Field></div>
        <label className="dtd-checkbox"><input type="checkbox" checked={!!row.keepTogether} onChange={(event) => api.patchRow(row.id, { keepTogether: event.target.checked })} />Keep row together when printing</label>
        <h4>Columns (relative widths)</h4>
        {row.columns.map((cell, index) => <div className="dtd-list-input dtd-col-row" key={cell.id}><span>Column {index + 1}</span><NumberInput min={1} max={12} value={cell.width} onChange={(width) => api.patchRow(row.id, { columns: row.columns.map((item) => item.id === cell.id ? { ...item, width } : item) })} /><IconButton title="Remove column" disabled={row.columns.length === 1} onClick={() => api.removeColumn(row.id, cell.id)}><Trash2 size={13} /></IconButton></div>)}
        <button type="button" className="dtd-secondary" onClick={() => api.addColumn(row.id)}><Plus size={13} />Add column</button>
      </div>;
    }
  }

  if (selection?.kind === "cell") {
    const found = locateCell(template, selection.cellId);
    if (found) {
      const { cell, row } = found; title = "Cell";
      body = <div className="dtd-inspector-section"><h4>Cell layout</h4>
        <Field label="Vertical alignment"><Segmented value={cell.verticalAlign ?? "start"} onChange={(verticalAlign) => api.patchCell(cell.id, { verticalAlign })} options={[{ value: "start", label: "Top" }, { value: "center", label: "Middle" }, { value: "end", label: "Bottom" }]} /></Field>
        <div className="dtd-two"><Field label="Width (relative)"><NumberInput value={cell.width} min={1} max={12} onChange={(width) => api.patchCell(cell.id, { width })} /></Field><Field label="Padding"><NumberInput value={cell.padding} onChange={(padding) => api.patchCell(cell.id, { padding })} suffix="px" /></Field></div>
        <Field label="Background"><ColorInput value={cell.background} onChange={(background) => api.patchCell(cell.id, background ? { background } : { background: "" })} /></Field>
        <div className="dtd-two"><Field label="Border"><NumberInput value={cell.borderWidth} max={12} onChange={(borderWidth) => api.patchCell(cell.id, { borderWidth })} suffix="px" /></Field><Field label="Border colour"><ColorInput value={cell.borderColor} fallback="#CBD5E1" onChange={(borderColor) => api.patchCell(cell.id, { borderColor: borderColor ?? "#CBD5E1" })} /></Field></div>
        <div className="dtd-stack"><button type="button" className="dtd-secondary" onClick={() => api.addColumn(row.id, cell.id)}><Columns2 size={13} />Add column to the right</button><button type="button" className="dtd-secondary" disabled={row.columns.length === 1} onClick={() => api.removeColumn(row.id, cell.id)}><Trash2 size={13} />Remove this column</button></div>
      </div>;
    }
  }

  return <aside className="dtd-inspector"><div className="dtd-panel-title"><span>{title}</span><IconButton title="Close properties" onClick={onClose}><X size={15} /></IconButton></div><div className="dtd-inspector-scroll">{body}</div></aside>;
}

/* ========================================================================== *
 * Settings and preview
 * ========================================================================== */

function SettingsView({ template, documentTypes, commit }: { template: DocumentTemplateV2; documentTypes: TemplateDesignerProps["documentTypes"]; commit: (value: DocumentTemplateV2) => void }) {
  const setPage = (value: Partial<DocumentTemplateV2["page"]>) => commit({ ...template, page: { ...template.page, ...value } });
  const setTheme = (value: Partial<DocumentTemplateV2["theme"]>) => commit({ ...template, theme: { ...template.theme, ...value } });
  const setWatermark = (value: Partial<WatermarkSettings>) => commit({ ...template, watermark: { ...template.watermark, ...value } });
  const setMargin = (key: keyof DocumentTemplateV2["page"]["margin"], value: number) => setPage({ margin: { ...template.page.margin, [key]: value } });
  return <main className="dtd-settings"><div className="dtd-settings-grid">
    <section><h3>Template details</h3><Field label="Name"><input className={inputClass} value={template.name} onChange={(event) => commit({ ...template, name: event.target.value })} /></Field><Field label="Description"><textarea className={inputClass} rows={3} value={template.description ?? ""} onChange={(event) => commit({ ...template, description: event.target.value })} /></Field><Field label="Category"><input className={inputClass} value={template.category ?? ""} onChange={(event) => commit({ ...template, category: event.target.value })} /></Field><Field label="Tags (comma separated)"><input className={inputClass} value={(template.tags ?? []).join(", ")} onChange={(event) => commit({ ...template, tags: event.target.value.split(",").map((tag) => tag.trim()).filter(Boolean) })} /></Field>{!!documentTypes?.length && <Field label="Document type"><select className={inputClass} value={template.documentTypeId ?? ""} onChange={(event) => commit({ ...template, documentTypeId: event.target.value })}><option value="">Select type</option>{documentTypes.map((type) => <option key={type.id} value={type.id}>{type.name}</option>)}</select></Field>}</section>
    <section><h3>Page setup</h3><div className="dtd-two"><Field label="Size"><select className={inputClass} value={template.page.size} onChange={(event) => setPage({ size: event.target.value as PageSize })}>{(Object.keys(PAGE_DIMS) as PageSize[]).map((size) => <option key={size}>{size}</option>)}</select></Field><Field label="Orientation"><select className={inputClass} value={template.page.orientation} onChange={(event) => setPage({ orientation: event.target.value as Orientation })}><option value="portrait">Portrait</option><option value="landscape">Landscape</option></select></Field></div><h4>Margins (mm)</h4><div className="dtd-four">{(["top", "right", "bottom", "left"] as const).map((key) => <Field key={key} label={key}><NumberInput value={template.page.margin[key]} min={0} max={60} onChange={(value) => setMargin(key, value)} /></Field>)}</div></section>
    <section><h3>Typography & colour</h3><div className="dtd-two"><Field label="Body font"><select className={inputClass} value={template.theme.fontFamily} onChange={(event) => setTheme({ fontFamily: event.target.value })}>{FONT_OPTIONS.map((font) => <option key={font.value} value={font.value}>{font.label}</option>)}</select></Field><Field label="Heading font"><select className={inputClass} value={template.theme.headingFamily} onChange={(event) => setTheme({ headingFamily: event.target.value })}>{FONT_OPTIONS.map((font) => <option key={font.value} value={font.value}>{font.label}</option>)}</select></Field></div><div className="dtd-two"><Field label="Base size"><NumberInput value={template.theme.baseFontSize} min={7} max={24} onChange={(baseFontSize) => setTheme({ baseFontSize })} suffix="px" /></Field><Field label="Line height"><NumberInput value={template.theme.lineHeight} min={1} max={3} step={0.05} onChange={(lineHeight) => setTheme({ lineHeight })} /></Field></div><div className="dtd-three"><Field label="Text"><input type="color" value={template.theme.textColor} onChange={(event) => setTheme({ textColor: event.target.value })} /></Field><Field label="Headings"><input type="color" value={template.theme.headingColor} onChange={(event) => setTheme({ headingColor: event.target.value })} /></Field><Field label="Accent / rules"><input type="color" value={template.theme.accentColor} onChange={(event) => setTheme({ accentColor: event.target.value })} /></Field></div></section>
    <section><h3>Page bands & watermark</h3><div className="dtd-check-row"><label><input type="checkbox" checked={template.header.enabled} onChange={(event) => commit({ ...template, header: { ...template.header, enabled: event.target.checked } })} />Header</label><label><input type="checkbox" checked={template.footer.enabled} onChange={(event) => commit({ ...template, footer: { ...template.footer, enabled: event.target.checked } })} />Footer</label><label><input type="checkbox" checked={template.watermark.enabled} onChange={(event) => setWatermark({ enabled: event.target.checked })} />Watermark</label></div><div className="dtd-two"><Field label="Watermark type"><select className={inputClass} value={template.watermark.kind} onChange={(event) => setWatermark({ kind: event.target.value as WatermarkSettings["kind"] })}><option value="text">Text</option><option value="image">Image URL</option></select></Field><Field label="Width"><NumberInput value={template.watermark.width} max={1000} onChange={(width) => setWatermark({ width })} suffix="px" /></Field></div><Field label="Watermark text, field or image URL"><input className={inputClass} value={template.watermark.value} onChange={(event) => setWatermark({ value: event.target.value })} /></Field><div className="dtd-two"><Field label="Opacity"><input type="range" min="0.01" max="0.4" step="0.01" value={template.watermark.opacity} onChange={(event) => setWatermark({ opacity: Number(event.target.value) })} /></Field><Field label="Rotation"><NumberInput min={-180} max={180} value={template.watermark.rotation} onChange={(rotation) => setWatermark({ rotation })} suffix="°" /></Field></div></section>
    <section className="dtd-wide"><h3>Required DMS fields</h3><div className="dtd-field-chips">{collectRequiredFields(template).map((field) => <code key={field}>{`{{${field}}}`}</code>)}{!collectRequiredFields(template).length && <span className="dtd-hint">No fields used yet.</span>}</div></section>
  </div></main>;
}

function Preview({ template, data }: { template: DocumentTemplateV2; data: Record<string, unknown> }) {
  const margin = template.page.margin; const total = template.pages.length;
  return <main className="dtd-preview">{template.pages.map((page, index) => <article key={page.id} className="dtd-paper dtd-preview-paper" style={paperStyle(template)}>
    <Watermark watermark={template.watermark} data={data} />
    {page.showHeader !== false && <BandRenderer band={template.header} template={template} data={data} page={index + 1} pages={total} kind="header" />}
    <div className="dtd-page-content" style={{ padding: `${margin.top}mm ${margin.right}mm ${margin.bottom}mm ${margin.left}mm` }}>{page.rows.map((row) => <RowRenderer key={row.id} row={row} theme={template.theme} data={data} page={index + 1} pages={total} />)}</div>
    {page.showFooter !== false && <BandRenderer band={template.footer} template={template} data={data} page={index + 1} pages={total} kind="footer" />}
    <FloatingLayer items={page.floating ?? []} theme={template.theme} data={data} page={index + 1} pages={total} />
  </article>)}</main>;
}

/* ========================================================================== *
 * Main component
 * ========================================================================== */

const DROP_RANK = (id: string) => id.startsWith("drop-el:") ? 3 : id.startsWith("gap:") ? 2 : id.startsWith("cell:") ? 1 : 0;
const collisionDetection: CollisionDetection = (args) => {
  const activeId = String(args.active.id);
  const activeElement = activeId.includes(":") ? activeId.slice(activeId.indexOf(":") + 1) : "";
  const hits = pointerWithin(args).filter((hit) => String(hit.id) !== `drop-el:${activeElement}`);
  return hits.sort((a, b) => DROP_RANK(String(b.id)) - DROP_RANK(String(a.id)));
};

export default function TemplateDesigner({ initial, mergeFields = DEFAULT_FIELDS, sampleData, documentTypes = [], onSave, onCancel, isSaving }: TemplateDesignerProps) {
  const [history, setHistory] = useState<DocumentTemplateV2[]>(() => [normalizeTemplate(initial ?? createBlankTemplate())]);
  const [cursor, setCursor] = useState(0);
  const template: DocumentTemplateV2 = history[cursor] ?? history[0] ?? createBlankTemplate();
  const [selection, setSelection] = useState<Selection | null>(() => ({ kind: "page", pageId: template.pages[0]?.id ?? "" }));
  const [tab, setTab] = useState<EditorTab>("design"); const [zoom, setZoom] = useState(0.8);
  const [leftOpen, setLeftOpen] = useState(true); const [rightOpen, setRightOpen] = useState(true);
  const [dragLabel, setDragLabel] = useState<{ label: string; icon: typeof FileText } | null>(null);
  const importRef = useRef<HTMLInputElement>(null);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));
  const data = useMemo(() => ({ ...SAMPLE_DATA, ...(sampleData ?? {}) }), [sampleData]);

  const commit = useCallback((next: DocumentTemplateV2) => {
    setHistory((current) => [...current.slice(0, cursor + 1), normalizeTemplate(next)].slice(-80));
    setCursor((current) => Math.min(current + 1, 79));
  }, [cursor]);
  const undo = () => setCursor((value) => Math.max(0, value - 1));
  const redo = () => setCursor((value) => Math.min(history.length - 1, value + 1));

  /* ---------- selection context ---------- */
  const selectedContainer = selection && "pageId" in selection ? selection.pageId : selection?.kind === "band" ? selection.band : undefined;
  const selectedPageId = (selectedContainer && !isBand(selectedContainer) ? selectedContainer : undefined) ?? template.pages[0]?.id ?? "";
  const selectedRowId = selection && "rowId" in selection ? selection.rowId : undefined;

  /* ---------- rows ---------- */
  const addRow = (cid: string, ratios: number[]) => {
    const row = makeRow(ratios);
    let next: DocumentTemplateV2;
    const current = selectedRowId ? findRow(template, selectedRowId) : null;
    if (current && current.cid === cid) {
      const index = rowsOf(template, cid).findIndex((item) => item.id === selectedRowId);
      next = insertRowAt(template, cid, index + 1, row);
    } else next = withRows(template, cid, (rows) => [...rows, row]);
    if (isBand(cid) && !template[cid].enabled) next = { ...next, [cid]: { ...next[cid], enabled: true } };
    commit(next); setSelection({ kind: "row", pageId: cid, rowId: row.id });
  };
  const rowAction = (rowId: string, action: RowAction) => {
    const found = findRow(template, rowId); if (!found) return;
    const { cid } = found; const rows = rowsOf(template, cid); const index = rows.findIndex((row) => row.id === rowId);
    if (action === "delete") { commit(withRows(template, cid, (items) => items.filter((row) => row.id !== rowId))); setSelection(isBand(cid) ? { kind: "band", band: cid } : { kind: "page", pageId: cid }); return; }
    if (action === "duplicate") { commit(insertRowAt(template, cid, index + 1, cloneWithNewIds(found.row))); return; }
    if (action === "insertAbove" || action === "insertBelow") { const row = makeRow([1]); commit(insertRowAt(template, cid, action === "insertAbove" ? index : index + 1, row)); setSelection({ kind: "row", pageId: cid, rowId: row.id }); return; }
    if (action === "addColumn") { addColumn(rowId); return; }
    const target = index + (action === "up" ? -1 : 1);
    if (target < 0 || target >= rows.length) return;
    commit(withRows(template, cid, (items) => { const next = [...items]; const a = next[index], b = next[target]; if (!a || !b) return items; next[index] = b; next[target] = a; return next; }));
  };
  const addColumn = (rowId: string, afterCellId?: string) => commit(mapContainers(template, (rows) => rows.map((row) => {
    if (row.id !== rowId) return row;
    const columns = [...row.columns]; const index = afterCellId ? columns.findIndex((cell) => cell.id === afterCellId) : columns.length - 1;
    columns.splice(index + 1, 0, makeCell(1)); return { ...row, columns };
  })));
  const removeColumn = (rowId: string, cellId: string) => {
    commit(mapContainers(template, (rows) => rows.map((row) => row.id === rowId && row.columns.length > 1 ? { ...row, columns: row.columns.filter((cell) => cell.id !== cellId) } : row)));
    const found = findRow(template, rowId); if (found) setSelection({ kind: "row", pageId: found.cid, rowId });
  };

  /* ---------- elements ---------- */
  const patchElementById = (elementId: string, patch: Partial<DocumentElement>) => commit(patchElementAnywhere(template, elementId, patch));
  const elementAction = (elementId: string, action: ElementAction) => {
    const loc = locateElement(template, elementId); if (!loc) return;
    if (action === "delete") {
      const [next] = extractElement(template, elementId); commit(next);
      if ("floating" in loc) setSelection({ kind: "page", pageId: loc.pageId }); else setSelection({ kind: "cell", pageId: loc.cid, rowId: loc.rowId, cellId: loc.cellId });
      return;
    }
    if ("floating" in loc) {
      const item = loc.floating;
      if (action === "duplicate") { const copy = cloneWithNewIds(item); copy.x += 5; copy.y += 5; commit(addFloatingItem(template, loc.pageId, copy)); setSelection({ kind: "floating", pageId: loc.pageId, elementId: copy.element.id }); return; }
      if (action === "forward" || action === "backward" || action === "up" || action === "down") commit(mapFloating(template, elementId, (f) => ({ ...f, zIndex: (f.zIndex ?? 0) + (action === "forward" || action === "up" ? 1 : -1) })));
      return;
    }
    if (action === "duplicate") { const copy = cloneWithNewIds(loc.element); commit(mapAllCells(template, (cell) => { const index = cell.elements.findIndex((item) => item.id === elementId); if (index < 0) return cell; const elements = [...cell.elements]; elements.splice(index + 1, 0, copy); return { ...cell, elements }; })); return; }
    if (action === "up" || action === "down") commit(mapAllCells(template, (cell) => {
      const index = cell.elements.findIndex((item) => item.id === elementId); const target = index + (action === "up" ? -1 : 1);
      if (index < 0 || target < 0 || target >= cell.elements.length) return cell;
      const elements = [...cell.elements]; const a = elements[index], b = elements[target]; if (!a || !b) return cell; elements[index] = b; elements[target] = a; return { ...cell, elements };
    }));
  };
  const patchFloating = (elementId: string, patch: Partial<FloatingItem>) => commit(mapFloating(template, elementId, (item) => {
    const next = { ...item, ...patch }; if (!next.height) delete next.height; return next;
  }));
  const addFloating = (pageId: string, type: ElementType) => {
    const element = makeElement(type); const margin = template.page.margin;
    const count = template.pages.find((page) => page.id === pageId)?.floating?.length ?? 0;
    commit(addFloatingItem(template, pageId, { id: uid(), x: margin.left + count * 4, y: margin.top + 20 + count * 4, width: defaultFloatWidth(type), element: { ...element, style: { ...element.style, marginBottom: 0 } } }));
    setSelection({ kind: "floating", pageId, elementId: element.id });
  };
  const toFloating = (elementId: string) => {
    const loc = locateElement(template, elementId); if (!loc || "floating" in loc || isBand(loc.cid)) return;
    const [next, element] = extractElement(template, elementId); if (!element) return;
    commit(addFloatingItem(next, loc.cid, { id: uid(), x: template.page.margin.left, y: template.page.margin.top + 10, width: defaultFloatWidth(element.type), element }));
    setSelection({ kind: "floating", pageId: loc.cid, elementId });
  };
  const toFlow = (elementId: string) => {
    const loc = locateElement(template, elementId); if (!loc || !("floating" in loc)) return;
    const [next, element] = extractElement(template, elementId); if (!element) return;
    const row = makeRow([1], [[element]]);
    commit(withRows(next, loc.pageId, (rows) => [...rows, row]));
    setSelection({ kind: "element", pageId: loc.pageId, rowId: row.id, cellId: row.columns[0]?.id ?? "", elementId });
  };

  const api: DesignerApi = {
    patchElement: patchElementById, patchFloating,
    patchRow: (rowId, patch) => commit(mapContainers(template, (rows) => rows.map((row) => row.id === rowId ? { ...row, ...patch } : row))),
    patchCell: (cellId, patch) => commit(mapAllCells(template, (cell) => cell.id === cellId ? { ...cell, ...patch } : cell)),
    patchBand: (band, patch) => commit({ ...template, [band]: { ...template[band], ...patch } }),
    patchPage: (pageId, patch) => commit({ ...template, pages: template.pages.map((page) => page.id === pageId ? { ...page, ...patch } : page) }),
    addRow, addColumn, removeColumn, addFloating, toFloating, toFlow, elementAction,
  };

  /* ---------- drag & drop ---------- */
  const onDragStart = (event: DragStartEvent) => {
    const source = event.active.data.current;
    if (source?.["source"] === "palette") { const meta = elementMeta[source["type"] as ElementType]; setDragLabel({ label: meta.label, icon: meta.icon }); return; }
    const loc = locateElement(template, String(source?.["elementId"] ?? ""));
    if (loc) { const meta = elementMeta[loc.element.type]; setDragLabel({ label: `Move ${meta.label.toLowerCase()}`, icon: meta.icon }); }
  };
  const onDragEnd = (event: DragEndEvent) => {
    setDragLabel(null);
    const target = event.over?.data.current; const source = event.active.data.current;
    if (!target || !source) return;
    const scale = PX_PER_MM * zoom;
    let base = template; let element: DocumentElement | undefined; let floatOrigin: FloatLocation | null = null;
    if (source["source"] === "palette") element = makeElement(source["type"] as ElementType);
    else {
      const loc = locateElement(template, String(source["elementId"]));
      if (!loc) return;
      if ("floating" in loc) floatOrigin = loc;
      [base, element] = extractElement(template, loc.element.id);
    }
    if (!element) return;
    const kind = target["source"];
    if (kind === "cell") {
      const cellId = String(target["cellId"]);
      const next = insertIntoCell(base, cellId, element); const found = locateCell(next, cellId);
      commit(next); if (found) setSelection({ kind: "element", pageId: found.cid, rowId: found.row.id, cellId, elementId: element.id });
      return;
    }
    if (kind === "element-target") {
      const beforeId = String(target["elementId"]); const loc = locateElement(base, beforeId);
      if (!loc || "floating" in loc) return;
      commit(insertIntoCell(base, loc.cellId, element, beforeId)); setSelection({ kind: "element", pageId: loc.cid, rowId: loc.rowId, cellId: loc.cellId, elementId: element.id });
      return;
    }
    if (kind === "gap") {
      const cid = String(target["cid"]); const row = makeRow([1], [[element]]);
      let next = insertRowAt(base, cid, Number(target["index"]), row);
      if (isBand(cid) && !next[cid].enabled) next = { ...next, [cid]: { ...next[cid], enabled: true } };
      commit(next); setSelection({ kind: "element", pageId: cid, rowId: row.id, cellId: row.columns[0]?.id ?? "", elementId: element.id });
      return;
    }
    if (kind === "paper") {
      const pageId = String(target["pageId"]); const over = event.over?.rect;
      let x: number; let y: number; let width = defaultFloatWidth(element.type); let extra: Partial<FloatingItem> = {};
      if (floatOrigin && floatOrigin.pageId === pageId) {
        x = floatOrigin.floating.x + event.delta.x / scale; y = floatOrigin.floating.y + event.delta.y / scale;
        width = floatOrigin.floating.width; extra = { ...floatOrigin.floating };
      } else {
        const rect = event.active.rect.current.translated;
        x = rect && over ? (rect.left - over.left) / scale : 20; y = rect && over ? (rect.top - over.top) / scale : 20;
        if (floatOrigin) { width = floatOrigin.floating.width; extra = { ...floatOrigin.floating }; }
      }
      const { width: pw, height: ph } = paperSize(template);
      x = Math.round(Math.max(0, Math.min(pw - 5, x)) * 2) / 2; y = Math.round(Math.max(0, Math.min(ph - 5, y)) * 2) / 2;
      const item: FloatingItem = { ...extra, id: floatOrigin?.floating.id ?? uid(), x, y, width, element: source["source"] === "palette" ? { ...element, style: { ...element.style, marginBottom: 0 } } : element };
      commit(addFloatingItem(base, pageId, item)); setSelection({ kind: "floating", pageId, elementId: element.id });
    }
  };

  /* ---------- pages & files ---------- */
  const newBlank = () => {
    if (!window.confirm("Start a new blank document? Unsaved changes in this one will be lost.")) return;
    const fresh = normalizeTemplate(createBlankTemplate()); setHistory([fresh]); setCursor(0); setSelection({ kind: "page", pageId: fresh.pages[0]?.id ?? "" });
  };
  const addPage = () => { const page: DocumentPage = { id: uid(), name: `Page ${template.pages.length + 1}`, rows: [], floating: [] }; const index = template.pages.findIndex((item) => item.id === selectedPageId); const pages = [...template.pages]; pages.splice(index + 1, 0, page); commit({ ...template, pages }); setSelection({ kind: "page", pageId: page.id }); };
  const duplicatePage = () => { const page = template.pages.find((item) => item.id === selectedPageId) ?? template.pages[0]; if (!page) return; const copy = cloneWithNewIds(page); copy.name = `${page.name} copy`; const index = template.pages.indexOf(page); const pages = [...template.pages]; pages.splice(index + 1, 0, copy); commit({ ...template, pages }); setSelection({ kind: "page", pageId: copy.id }); };
  const movePage = (direction: -1 | 1) => { const index = template.pages.findIndex((page) => page.id === selectedPageId); const target = index + direction; if (index < 0 || target < 0 || target >= template.pages.length) return; const pages = [...template.pages]; const a = pages[index], b = pages[target]; if (!a || !b) return; pages[index] = b; pages[target] = a; commit({ ...template, pages }); };
  const removePage = () => { if (template.pages.length === 1) { toast.error("A document needs at least one page."); return; } commit({ ...template, pages: template.pages.filter((page) => page.id !== selectedPageId) }); setSelection({ kind: "page", pageId: template.pages.find((page) => page.id !== selectedPageId)?.id ?? "" }); };
  const importJson = async (file?: File) => { if (!file) return; try { const parsed = JSON.parse(await file.text()) as DocumentTemplateV2 | LegacyTemplate; if (!("pages" in parsed && Array.isArray(parsed.pages)) && !("blocks" in parsed && Array.isArray(parsed.blocks))) throw new Error("Not a document template"); const normalized = "pages" in parsed && Array.isArray(parsed.pages) ? normalizeTemplate(parsed as DocumentTemplateV2) : importLegacyTemplate(parsed as LegacyTemplate); setHistory([normalized]); setCursor(0); setSelection({ kind: "page", pageId: normalized.pages[0]?.id ?? "" }); toast.success("Template imported"); } catch (error) { toast.error(error instanceof Error ? error.message : "Could not import template"); } };
  const save = async () => {
    if (!template.documentTypeId) {
      toast.error("Select a document type in Settings before saving.");
      return;
    }
    try { await onSave(outputDocumentTemplate(template), false); toast.success("Template saved"); }
    catch (error) { toast.error(error instanceof Error ? error.message : "Template could not be saved"); }
  };

  /* ---------- keyboard ---------- */
  const keyRef = useRef<(event: KeyboardEvent) => void>(() => undefined);
  keyRef.current = (event: KeyboardEvent) => {
    const target = event.target as HTMLElement | null;
    if (target && (target.closest("input, textarea, select, [contenteditable=true]"))) return;
    const mod = event.ctrlKey || event.metaKey;
    if (mod && event.key.toLowerCase() === "z") { event.preventDefault(); if (event.shiftKey) redo(); else undo(); return; }
    if (mod && event.key.toLowerCase() === "y") { event.preventDefault(); redo(); return; }
    if (tab !== "design") return;
    if ((event.key === "Delete" || event.key === "Backspace") && (selection?.kind === "element" || selection?.kind === "floating")) { event.preventDefault(); elementAction(selection.elementId, "delete"); }
    if (mod && event.key.toLowerCase() === "d" && (selection?.kind === "element" || selection?.kind === "floating")) { event.preventDefault(); elementAction(selection.elementId, "duplicate"); }
    if (selection?.kind === "floating" && event.key.startsWith("Arrow")) {
      event.preventDefault(); const step = event.shiftKey ? 5 : 0.5;
      const loc = locateElement(template, selection.elementId); if (!loc || !("floating" in loc)) return;
      const f = loc.floating;
      patchFloating(selection.elementId, { x: f.x + (event.key === "ArrowLeft" ? -step : event.key === "ArrowRight" ? step : 0), y: f.y + (event.key === "ArrowUp" ? -step : event.key === "ArrowDown" ? step : 0) });
    }
  };
  useEffect(() => { const handler = (event: KeyboardEvent) => keyRef.current(event); window.addEventListener("keydown", handler); return () => window.removeEventListener("keydown", handler); }, []);

  const ctx: CanvasCtx = { template, selection, onSelect: setSelection, rowAction, elementAction, patchElementById, pageNo: 1, pages: template.pages.length };
  const paletteTarget = selectedContainer ?? selectedPageId;
  const DragIcon = dragLabel?.icon;

  return <div className="dtd-root"><header className="dtd-topbar"><div className="dtd-top-left"><IconButton title="Close designer" onClick={onCancel}><ArrowLeft size={16} /></IconButton><div className="dtd-top-divider" /><input className="dtd-name" value={template.name} onChange={(event) => commit({ ...template, name: event.target.value })} /><span className="dtd-version">{template.pages.length} {template.pages.length === 1 ? "page" : "pages"}</span></div><nav className="dtd-tabs">{([{ id: "design", label: "Design", icon: LayoutGrid }, { id: "preview", label: "Preview", icon: Eye }, { id: "settings", label: "Settings", icon: Settings }] as const).map((item) => <button key={item.id} type="button" className={tab === item.id ? "is-active" : ""} onClick={() => setTab(item.id)}><item.icon size={14} />{item.label}</button>)}</nav><div className="dtd-top-actions"><IconButton title="Undo (Ctrl+Z)" disabled={cursor === 0} onClick={undo}><Undo2 size={15} /></IconButton><IconButton title="Redo (Ctrl+Y)" disabled={cursor >= history.length - 1} onClick={redo}><Redo2 size={15} /></IconButton>{tab === "preview" && <IconButton title="Print or save as PDF" onClick={() => window.print()}><Printer size={15} /></IconButton>}<button type="button" className="dtd-save" disabled={isSaving} onClick={() => void save()}><Save size={14} />{isSaving ? "Saving…" : "Save template"}</button></div></header>
    <div className="dtd-subbar"><div><IconButton title={leftOpen ? "Hide elements" : "Show elements"} active={leftOpen} onClick={() => setLeftOpen((value) => !value)}><PanelLeftClose size={15} /></IconButton>{tab === "design" && <><button type="button" className="dtd-secondary" onClick={newBlank}><FileText size={13} />New blank</button><button type="button" className="dtd-secondary" onClick={addPage}><Plus size={13} />Add page</button><button type="button" className="dtd-secondary" onClick={duplicatePage}><Copy size={13} />Duplicate page</button><IconButton title="Move page up" disabled={template.pages[0]?.id === selectedPageId} onClick={() => movePage(-1)}><ArrowUp size={14} /></IconButton><IconButton title="Move page down" disabled={template.pages[template.pages.length - 1]?.id === selectedPageId} onClick={() => movePage(1)}><ArrowDown size={14} /></IconButton><IconButton title="Delete page" disabled={template.pages.length === 1} onClick={removePage}><Trash2 size={14} /></IconButton></>}</div><div className="dtd-zoom"><IconButton title="Zoom out" onClick={() => setZoom((value) => Math.max(.4, +(value - .1).toFixed(2)))}><ZoomOut size={14} /></IconButton><span>{Math.round(zoom * 100)}%</span><IconButton title="Zoom in" onClick={() => setZoom((value) => Math.min(1.6, +(value + .1).toFixed(2)))}><ZoomIn size={14} /></IconButton></div><div><input ref={importRef} hidden type="file" accept="application/json" onChange={(event) => { void importJson(event.target.files?.[0]); event.target.value = ""; }} /><button type="button" className="dtd-secondary" onClick={() => importRef.current?.click()}><FileJson size={13} />Import JSON</button><button type="button" className="dtd-secondary" onClick={() => downloadJson(template)}><Download size={13} />Export JSON</button>{tab === "design" && <IconButton title={rightOpen ? "Hide properties" : "Show properties"} active={rightOpen} onClick={() => setRightOpen((value) => !value)}><PanelRightClose size={15} /></IconButton>}</div></div>
    {tab === "settings" ? <SettingsView template={template} documentTypes={documentTypes} commit={commit} />
      : tab === "preview" ? <Preview template={template} data={data} />
      : <DndContext sensors={sensors} collisionDetection={collisionDetection} onDragStart={onDragStart} onDragEnd={onDragEnd} onDragCancel={() => setDragLabel(null)}><div className="dtd-workspace">
        {leftOpen && <Palette onAddRow={(ratios) => addRow(paletteTarget, ratios)} />}
        <main className="dtd-canvas" onClick={() => setSelection(null)}><div className="dtd-canvas-scale" style={{ transform: `scale(${zoom})`, transformOrigin: "top center", width: "100%" }}>{template.pages.map((page, pageIndex) => <DesignerPage key={page.id} page={page} pageIndex={pageIndex} ctx={ctx} />)}</div></main>
        {rightOpen && <Inspector template={template} selection={selection} fields={mergeFields} api={api} onClose={() => setRightOpen(false)} />}
      </div><DragOverlay dropAnimation={null}>{dragLabel && DragIcon && <div className="dtd-drag-overlay"><DragIcon size={15} />{dragLabel.label}</div>}</DragOverlay></DndContext>}
  </div>;
}

export { DEFAULT_FIELDS as defaultMergeFields, SAMPLE_DATA as defaultSampleData, collectRequiredFields, normalizeTemplate };