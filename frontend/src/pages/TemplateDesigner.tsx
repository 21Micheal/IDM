/**
 * TemplateDesigner.tsx — structured, paginated document template designer (v2)
 *
 * Drop-in React component for a DMS. Unlike the original flat block composer,
 * this version stores pages -> rows -> cells -> elements, allowing precise
 * business-document layouts without fragile absolute positioning.
 *
 * Runtime dependencies: react, @dnd-kit/core, lucide-react, sonner
 */
import {
  Fragment, useCallback, useEffect, useMemo, useRef, useState,
  type CSSProperties, type ReactNode,
} from "react";
import {
  DndContext, DragOverlay, PointerSensor, useDraggable, useDroppable,
  useSensor, useSensors, type DragEndEvent, type DragStartEvent,
} from "@dnd-kit/core";
import {
  AlignCenter, AlignJustify, AlignLeft, AlignRight, ArrowDown, ArrowLeft,
  ArrowUp, Bold, Braces, Check, ChevronDown, ChevronRight, Columns2, Copy,
  Download, Eye, FileJson, FileText, GripVertical, Heading, Image as ImageIcon,
  Italic, LayoutGrid, List, ListOrdered, Minus, PanelLeftClose, PanelRightClose,
  PenLine, Plus, Printer, Quote, Redo2, Rows3, Save, Search, Settings,
  Table2, Trash2, Underline, Undo2, Upload, X, ZoomIn, ZoomOut,
} from "lucide-react";
import { toast } from "sonner";
import "./designer.css";

const cx = (...values: Array<string | false | null | undefined>) => values.filter(Boolean).join(" ");
const uid = () => Math.random().toString(36).slice(2, 10);

/* ========================================================================== *
 * Public schema
 * ========================================================================== */

export type PageSize = "A4" | "Letter" | "Legal";
export type Orientation = "portrait" | "landscape";
export type Align = "left" | "center" | "right" | "justify";
export type VerticalAlign = "start" | "center" | "end";
export type ElementType =
  | "text" | "heading" | "bulleted_list" | "numbered_list" | "note"
  | "field_group" | "data_table" | "image" | "divider" | "spacer"
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

export interface DocumentPage {
  id: string;
  name: string;
  rows: GridRow[];
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

type Selection =
  | { kind: "band"; band: "header" | "footer" }
  | { kind: "page"; pageId: string }
  | { kind: "row"; pageId: string; rowId: string }
  | { kind: "cell"; pageId: string; rowId: string; cellId: string }
  | { kind: "element"; pageId: string; rowId: string; cellId: string; elementId: string };

type EditorTab = "design" | "preview" | "settings";
type PaletteGroup = "text" | "data" | "media" | "layout" | "signoff";

/* ========================================================================== *
 * Constants and factories
 * ========================================================================== */

const PAGE_DIMS: Record<PageSize, { w: number; h: number }> = {
  A4: { w: 210, h: 297 }, Letter: { w: 216, h: 279 }, Legal: { w: 216, h: 356 },
};

const DEFAULT_FIELDS: MergeField[] = [
  { key: "company.name", label: "Company name", group: "Organisation" },
  { key: "company.address", label: "Company address", group: "Organisation" },
  { key: "company.phone", label: "Company phone", group: "Organisation" },
  { key: "company.email", label: "Company email", group: "Organisation" },
  { key: "company.logo_left", label: "Left logo", group: "Organisation", type: "image" },
  { key: "company.logo_right", label: "Right logo", group: "Organisation", type: "image" },
  { key: "lpo.number", label: "LPO number", group: "Purchase order" },
  { key: "lpo.date", label: "LPO date", group: "Purchase order", type: "date" },
  { key: "lpo.valid_until", label: "Valid until", group: "Purchase order", type: "date" },
  { key: "lpo.description", label: "Description", group: "Purchase order" },
  { key: "lpo.currency", label: "Currency", group: "Purchase order" },
  { key: "lpo.subtotal", label: "Subtotal", group: "Computed", type: "number" },
  { key: "lpo.vat_total", label: "VAT total", group: "Computed", type: "number" },
  { key: "lpo.grand_total", label: "Grand total", group: "Computed", type: "number" },
  { key: "lpo.amount_words", label: "Amount in words", group: "Computed" },
  { key: "supplier.code", label: "Supplier code", group: "Supplier" },
  { key: "supplier.name", label: "Supplier name", group: "Supplier" },
  { key: "supplier.email", label: "Supplier email", group: "Supplier" },
  { key: "supplier.phone", label: "Supplier telephone", group: "Supplier" },
  { key: "supplier.address", label: "Supplier address", group: "Supplier" },
  { key: "prepared_by.role", label: "Prepared by role", group: "Approvals" },
  { key: "prepared_by.name", label: "Prepared by name", group: "Approvals" },
  { key: "prepared_by.date", label: "Prepared date", group: "Approvals", type: "date" },
  { key: "approved_by.role", label: "Approver role", group: "Approvals" },
  { key: "approved_by.name", label: "Approver name", group: "Approvals" },
  { key: "approved_by.date", label: "Approval date", group: "Approvals", type: "date" },
  {
    key: "line_items", label: "Line items", group: "Collections", type: "collection", repeating: true,
    children: [
      { key: "number", label: "No" }, { key: "item", label: "Item" }, { key: "uom", label: "U.O.M" },
      { key: "quantity", label: "Qty", type: "number" }, { key: "unit_price", label: "Unit price", type: "number" },
      { key: "net_price", label: "Net price", type: "number" }, { key: "vat_percent", label: "VAT%", type: "number" },
      { key: "vat", label: "VAT", type: "number" }, { key: "gross_value", label: "Gross value", type: "number" },
    ],
  },
];

const SAMPLE_DATA: Record<string, unknown> = {
  "company.name": "Flaxem System Enterprises Ltd",
  "company.address": "Mombasa Road, NEXTGEN Mall, Third Floor, Unit 3&4\nP. O. Box 3885-00100 Nairobi, Kenya",
  "company.phone": "+254 20 2305051 / +254 722 956048",
  "company.email": "info@example.com",
  "lpo.number": "FLM/LPO/2026/133",
  "lpo.date": "September 07, 2026 18:09",
  "lpo.valid_until": "06-12-2026",
  "lpo.description": "Office Chairs",
  "lpo.currency": "USD",
  "lpo.subtotal": "180.00",
  "lpo.vat_total": "28.80",
  "lpo.grand_total": "208.80",
  "lpo.amount_words": "Two hundred eight and eighty cents USD only",
  "supplier.code": "SUP.07.0004",
  "supplier.name": "IBM General Supplies",
  "supplier.email": "supplier@example.com",
  "supplier.phone": "+254 722 222 475",
  "supplier.address": "North Airport Road\nEmbakasi",
  "prepared_by.role": "Procurement Officer",
  "prepared_by.name": "Alimon Sakala",
  "prepared_by.date": "September 07 2026, 18:09",
  "approved_by.role": "Managing Director",
  "approved_by.name": "Alimon Sakala",
  "approved_by.date": "September 08, 2026 - 08:07",
  line_items: [
    { number: "1", item: "NCIC-530 - HIGH BACK ERGONOMIC OFFICE CHAIR - High Back Office Chair", uom: "Pcs", quantity: 1, unit_price: 60, net_price: 60, vat_percent: 16, vat: 9.6, gross_value: 69.6 },
    { number: "2", item: "NCIC-1790 - SUKI EXECUTIVE OFFICE CHAIR - Executive office Chair", uom: "Pcs", quantity: 1, unit_price: 120, net_price: 120, vat_percent: 16, vat: 19.2, gross_value: 139.2 },
  ],
};

const elementMeta: Record<ElementType, { label: string; group: PaletteGroup; icon: typeof FileText; hint: string }> = {
  text: { label: "Paragraph", group: "text", icon: FileText, hint: "Text with inline DMS fields" },
  heading: { label: "Heading", group: "text", icon: Heading, hint: "Section or document heading" },
  bulleted_list: { label: "Bulleted list", group: "text", icon: List, hint: "List with editable items" },
  numbered_list: { label: "Numbered list", group: "text", icon: ListOrdered, hint: "Ordered clauses and terms" },
  note: { label: "Note / callout", group: "text", icon: Quote, hint: "Emphasized note or disclaimer" },
  field_group: { label: "Field group", group: "data", icon: Rows3, hint: "Label and value pairs" },
  data_table: { label: "Data table", group: "data", icon: Table2, hint: "Static or repeating DMS records" },
  image: { label: "Image / logo", group: "media", icon: ImageIcon, hint: "Uploaded image or image field" },
  divider: { label: "Divider", group: "layout", icon: Minus, hint: "Horizontal rule" },
  spacer: { label: "Spacer", group: "layout", icon: Rows3, hint: "Controlled vertical space" },
  signature_group: { label: "Approvals", group: "signoff", icon: PenLine, hint: "Signatories, roles, dates and signatures" },
};

const groupLabels: Array<{ key: PaletteGroup; label: string }> = [
  { key: "text", label: "Text" }, { key: "data", label: "Data & fields" },
  { key: "media", label: "Media" }, { key: "layout", label: "Layout" },
  { key: "signoff", label: "Sign-off" },
];

const makeElement = (type: ElementType): DocumentElement => {
  const base: DocumentElement = { id: uid(), type, style: { marginBottom: 8 } };
  if (type === "heading") return { ...base, text: "Section heading", level: 2, style: { ...base.style, bold: true, fontSize: 16 } };
  if (type === "text") return { ...base, text: "Write text or insert a {{field}}.", style: { ...base.style, fontSize: 11 } };
  if (type === "note") return { ...base, text: "Important note", style: { ...base.style, padding: 8, borderWidth: 1, background: "#F8FAFC" } };
  if (type === "bulleted_list" || type === "numbered_list") return { ...base, items: ["First item", "Second item"] };
  if (type === "field_group") return { ...base, labelWidth: 120, fields: [{ id: uid(), label: "Label", value: "{{field}}", boldLabel: true }] };
  if (type === "image") return { ...base, src: "", alt: "Image", width: 140, height: 64, objectFit: "contain", opacity: 1 };
  if (type === "divider") return { ...base, style: { marginTop: 8, marginBottom: 8, borderWidth: 1, borderColor: "#94A3B8" } };
  if (type === "spacer") return { ...base, height: 24 };
  if (type === "signature_group") return { ...base, signatories: [{ id: uid(), step: "1", role: "Prepared by", name: "{{prepared_by.name}}", date: "{{prepared_by.date}}" }] };
  return {
    ...base, sourceKey: "line_items", showHeader: true, repeatHeader: true, striped: false, cellPadding: 4,
    headerBackground: "#E7E9F8", headerColor: "#111827", previewRows: 2,
    columns: [
      { id: uid(), key: "number", label: "No", width: 5 }, { id: uid(), key: "item", label: "Item", width: 38 },
      { id: uid(), key: "uom", label: "U.O.M", width: 7 }, { id: uid(), key: "quantity", label: "Qty", width: 5, align: "right" },
      { id: uid(), key: "unit_price", label: "Unit Price", width: 11, align: "right" },
      { id: uid(), key: "net_price", label: "Net Price", width: 11, align: "right" },
      { id: uid(), key: "vat_percent", label: "VAT%", width: 7, align: "right" },
      { id: uid(), key: "vat", label: "VAT", width: 6, align: "right" },
      { id: uid(), key: "gross_value", label: "Gross Value", width: 10, align: "right" },
    ],
    summaries: [{ id: uid(), label: "Totals in {{lpo.currency}}", labelSpan: 5, values: ["{{lpo.subtotal}}", "", "{{lpo.vat_total}}", "{{lpo.grand_total}}"], bold: true }],
  };
};

const makeCell = (width = 1, elements: DocumentElement[] = []): GridCell => ({ id: uid(), width, verticalAlign: "start", padding: 0, elements });
const makeRow = (ratios: number[] = [1], elements?: DocumentElement[][]): GridRow => ({
  id: uid(), gap: 12, marginBottom: 8,
  columns: ratios.map((w, i) => makeCell(w, elements?.[i] ?? [])),
});
const text = (value: string, style?: ElementStyle): DocumentElement => ({ id: uid(), type: "text", text: value, style: { fontSize: 11, marginBottom: 4, ...style } });
const heading = (value: string, level: 1 | 2 | 3 = 2, style?: ElementStyle): DocumentElement => ({ id: uid(), type: "heading", text: value, level, style: { bold: true, fontSize: level === 1 ? 20 : level === 2 ? 15 : 12, marginBottom: 8, ...style } });

const terms = [
  "Fixed Price: The prices indicated above are fixed and not subject to any adjustment.",
  "Payment: The payment will be effected in 30 days from receipt of dated Invoice, Delivery Notes and a copy of this LPO. Failing to deliver these documents may result in delayed payment.",
  "Technical Specifications of the Goods offered: The Goods shall comply with the technical specification indicated in the Contractor's quotation attached to this Purchase Order.",
  "Delivery Schedule: Delivery shall be completed according to the Contractor's quotation and calculated from signature of the Purchase Order.",
  "Delivery Instructions: The items will be delivered to the address specified by the purchaser.",
  "Liquidated Damages: Failure to deliver within the specified period may result in liquidated damages up to the maximum permitted by the Purchase Order.",
  "Failure to Perform: The purchaser may cancel the Purchase Order if the Contractor fails to deliver according to these terms without compensation.",
];

export const createLpoTemplate = (): DocumentTemplateV2 => {
  const header: PageBand = {
    enabled: true, height: 30, border: true,
    rows: [makeRow([1, 2.7, 1.5], [
      [{ ...makeElement("image"), alt: "Left logo", text: "{{company.logo_left}}", width: 72, height: 52 }],
      [text("{{company.name}}\n{{company.address}}\nTel: {{company.phone}}\nEmail: {{company.email}}", { align: "center", fontSize: 9 })],
      [{ ...makeElement("image"), alt: "Right logo", text: "{{company.logo_right}}", width: 120, height: 52, style: { align: "right" } }],
    ])],
  };
  const footer: PageBand = {
    enabled: true, height: 14, border: true,
    rows: [makeRow([1], [[text("Purchase Order {{lpo.number}} : Page {{page}} of {{pages}}", { align: "center", bold: true, italic: true, fontSize: 8 })]])],
  };
  const itemTable = makeElement("data_table");
  const page1: DocumentPage = {
    id: uid(), name: "Purchase order",
    rows: [
      makeRow([1], [[heading("Purchase Order", 1, { align: "center", underline: true, marginTop: 12, marginBottom: 24 })]]),
      makeRow([1, 1], [
        [],
        [{ ...makeElement("field_group"), labelWidth: 74, fields: [
          { id: uid(), label: "Date:", value: "{{lpo.date}}", boldLabel: true },
          { id: uid(), label: "LPO No:", value: "{{lpo.number}}", boldLabel: true, boldValue: true },
          { id: uid(), label: "Valid Until:", value: "{{lpo.valid_until}}", boldLabel: false, boldValue: true },
        ], style: { fontSize: 11, align: "right", marginBottom: 18 } }],
      ]),
      makeRow([1], [[
        heading("SUPPLIER DETAILS", 3, { marginBottom: 2 }),
        { ...makeElement("field_group"), labelWidth: 66, fields: [
          { id: uid(), label: "Code:", value: "{{supplier.code}}", boldValue: true },
          { id: uid(), label: "Name:", value: "{{supplier.name}}", boldValue: true },
          { id: uid(), label: "Email:", value: "{{supplier.email}}", boldValue: true },
          { id: uid(), label: "Telephone:", value: "{{supplier.phone}}", boldValue: true },
          { id: uid(), label: "", value: "{{supplier.address}}" },
        ], style: { marginBottom: 12 } },
        text("Description: {{lpo.description}}", { bold: false, marginBottom: 28 }),
      ]]),
      makeRow([1], [[heading("Please Supply the Underlisted", 1, { align: "center", underline: true, fontSize: 17, marginBottom: 10 })]]),
      makeRow([1], [[itemTable]]),
      makeRow([1], [[text("Total in Words: {{lpo.amount_words}}", { bold: true, padding: 4, borderWidth: 1, marginBottom: 22 })]]),
      makeRow([1], [[heading("APPROVALS", 3, { marginBottom: 14 })]]),
      makeRow([1], [[{ ...makeElement("signature_group"), signatories: [{ id: uid(), step: "1", role: "Prepared By\n{{prepared_by.role}}", name: "{{prepared_by.name}}", date: "{{prepared_by.date}}" }] }]]),
    ],
  };
  const page2: DocumentPage = {
    id: uid(), name: "Approval and terms",
    rows: [
      makeRow([1], [[{ ...makeElement("signature_group"), signatories: [{ id: uid(), step: "2", role: "Approved By\n{{approved_by.role}}", name: "{{approved_by.name}}", date: "{{approved_by.date}}", signature: "[[Signature]]" }] }]]),
      { ...makeRow([1], [[{ ...makeElement("divider"), style: { borderWidth: 1, borderColor: "#94A3B8", marginTop: 26, marginBottom: 26 } }]]), keepTogether: true },
      makeRow([1], [[heading("Standard Terms & Conditions", 2, { align: "center", marginBottom: 14 })]]),
      makeRow([1], [[{ ...makeElement("numbered_list"), items: terms, style: { fontSize: 10.5, marginBottom: 8 } }]]),
    ],
  };
  const template: DocumentTemplateV2 = {
    schemaVersion: 2,
    name: "Purchase Order Template", description: "Structured two-page local purchase order", category: "procurement", tags: ["LPO", "purchase order"],
    page: { size: "A4", orientation: "portrait", margin: { top: 12, right: 15, bottom: 12, left: 15 } },
    theme: { fontFamily: "Arial, Helvetica, sans-serif", headingFamily: "Georgia, 'Times New Roman', serif", baseFontSize: 11, lineHeight: 1.25, textColor: "#111827", headingColor: "#111827", accentColor: "#287EAD" },
    header, footer,
    watermark: { enabled: true, kind: "text", value: "{{company.name}}", opacity: 0.055, width: 300, rotation: 0 },
    pages: [page1, page2], requiredFields: [],
  };
  return normalizeTemplate(template);
};

/* ========================================================================== *
 * Data and schema helpers
 * ========================================================================== */

const TOKEN_RE = /\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g;
const MANUAL_RE = /\[\[([^\]]+)\]\]/g;

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
    for (const match of value.matchAll(TOKEN_RE)) if (match[1] && !['page', 'pages'].includes(match[1])) fields.add(match[1]);
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
  scanRows(template.header.rows); scanRows(template.footer.rows); template.pages.forEach((page) => scanRows(page.rows)); scan(template.watermark.value);
  return [...fields].sort();
}

function normalizeTemplate(template: DocumentTemplateV2): DocumentTemplateV2 {
  const copy = JSON.parse(JSON.stringify(template)) as DocumentTemplateV2;
  copy.schemaVersion = 2;
  copy.pages = Array.isArray(copy.pages) && copy.pages.length ? copy.pages : [{ id: uid(), name: "Page 1", rows: [makeRow()] }];
  copy.requiredFields = collectRequiredFields(copy);
  return copy;
}

type LegacyBlock = { id?: string; type: string; text?: string; level?: 1 | 2 | 3; items?: string[]; pairs?: FieldPair[]; columns?: Array<{ id?: string; key: string; label: string; width?: number; align?: Align }>; rows?: string[][]; bound?: boolean; sourceKey?: string; src?: string; alt?: string; width?: number; height?: number; left?: string; right?: string; signatories?: Array<{ id?: string; role: string; nameToken?: string; dateToken?: string }>; align?: Align; bold?: boolean; italic?: boolean; fontSize?: number; color?: string; marginTop?: number; marginBottom?: number };
type LegacyTemplate = { name?: string; description?: string; page?: DocumentTemplateV2["page"]; theme?: DocumentTemplateV2["theme"]; header?: { enabled: boolean; rule?: boolean; content: { left?: string; center?: string; right?: string } }; footer?: { enabled: boolean; rule?: boolean; content: { left?: string; center?: string; right?: string } }; blocks: LegacyBlock[] };
function importLegacy(input: LegacyTemplate): DocumentTemplateV2 {
  const band = (old?: LegacyTemplate["header"]): PageBand => ({ enabled: old?.enabled ?? false, border: old?.rule ?? false, rows: [makeRow([1, 1, 1], [old?.content.left, old?.content.center, old?.content.right].map((value, index) => value ? [text(value, { align: index === 0 ? "left" : index === 1 ? "center" : "right" })] : []))] });
  const pages: DocumentPage[] = [{ id: uid(), name: "Page 1", rows: [] }];
  for (const block of input.blocks) {
    if (block.type === "page_break") { pages.push({ id: uid(), name: `Page ${pages.length + 1}`, rows: [] }); continue; }
    const style: ElementStyle = Object.fromEntries(Object.entries({ align: block.align, bold: block.bold, italic: block.italic, fontSize: block.fontSize, color: block.color, marginTop: block.marginTop, marginBottom: block.marginBottom }).filter(([, value]) => value !== undefined)) as ElementStyle;
    const map: Record<string, ElementType> = { paragraph: "text", quote: "note", key_value: "field_group", logo: "image", two_column: "text", signature: "signature_group" };
    const type = map[block.type] ?? block.type as ElementType;
    const element = { id: uid(), type, text: block.text, level: block.level, items: block.items, fields: block.pairs?.map((pair) => ({ ...pair, id: pair.id ?? uid() })), columns: block.columns?.map((col) => ({ ...col, id: col.id ?? uid(), width: col.width ?? Math.round(100 / (block.columns?.length || 1)) })), staticRows: block.rows, sourceKey: block.bound ? block.sourceKey : undefined, src: block.src, alt: block.alt, width: block.width, height: block.height, signatories: block.signatories?.map((sig) => ({ id: sig.id ?? uid(), role: sig.role, name: sig.nameToken ?? "", date: sig.dateToken ?? "" })), style } as DocumentElement;
    const currentPage = pages[pages.length - 1];
    if (!currentPage) continue;
    if (block.type === "two_column") currentPage.rows.push(makeRow([1, 1], [[text(block.left ?? "")], [text(block.right ?? "")]]));
    else currentPage.rows.push(makeRow([1], [[element]]));
  }
  return normalizeTemplate({ ...createLpoTemplate(), name: input.name ?? "Imported document", description: input.description ?? "", page: input.page ?? createLpoTemplate().page, theme: input.theme ?? createLpoTemplate().theme, header: band(input.header), footer: band(input.footer), watermark: { enabled: false, kind: "text", value: "", opacity: .05 }, pages });
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

/* ========================================================================== *
 * Shared controls
 * ========================================================================== */

const inputClass = "dtd-input";
function Field({ label, children }: { label: string; children: ReactNode }) {
  return <label className="dtd-field"><span>{label}</span>{children}</label>;
}
function NumberInput({ value, onChange, min = 0, max = 999, suffix }: { value?: number | undefined; onChange: (value: number) => void; min?: number; max?: number; suffix?: string }) {
  return <div className="dtd-number"><input type="number" min={min} max={max} value={value ?? 0} onChange={(event) => onChange(Number(event.target.value))} />{suffix && <small>{suffix}</small>}</div>;
}
function IconButton({ title, onClick, disabled, children, active }: { title: string; onClick: () => void; disabled?: boolean | undefined; children: ReactNode; active?: boolean | undefined | undefined }) {
  return <button type="button" className={cx("dtd-icon-button", active && "is-active")} title={title} aria-label={title} disabled={disabled} onClick={onClick}>{children}</button>;
}
function Segmented<T extends string>({ value, options, onChange }: { value: T; options: Array<{ value: T; label: ReactNode; title?: string }>; onChange: (value: T) => void }) {
  return <div className="dtd-segmented">{options.map((option) => <button type="button" title={option.title} className={value === option.value ? "is-active" : ""} key={option.value} onClick={() => onChange(option.value)}>{option.label}</button>)}</div>;
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
      <div className="dtd-picker-scroll">{groups.map((group) => <div key={group}><h5>{group}</h5>{filtered.filter((field) => (field.group ?? "Fields") === group).map((field) => <button key={field.key} type="button" onClick={() => { onPick(`{{${field.key}}}`); setOpen(false); }}><span>{field.label}</span><code>{field.key}</code></button>)}</div>)}</div>
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

function elementStyle(element: DocumentElement, theme: DocumentTemplateV2["theme"]): CSSProperties {
  const style = element.style ?? {};
  return {
    textAlign: style.align, fontWeight: style.bold ? 700 : undefined, fontStyle: style.italic ? "italic" : undefined,
    textDecoration: style.underline ? "underline" : undefined, fontSize: style.fontSize ?? theme.baseFontSize,
    color: style.color ?? theme.textColor, background: style.background, padding: style.padding,
    marginTop: style.marginTop, marginBottom: style.marginBottom, minHeight: style.minHeight,
    borderWidth: style.borderWidth, borderColor: style.borderColor ?? "#CBD5E1", borderStyle: style.borderWidth ? (style.borderStyle ?? "solid") : undefined,
    borderRadius: style.radius, whiteSpace: "pre-wrap", overflowWrap: "anywhere",
  };
}

function DocumentImage({ source, alt, width, height, objectFit, opacity }: { source: string | undefined; alt: string; width?: number | undefined; height?: number | undefined; objectFit?: "contain" | "cover" | "fill" | undefined; opacity?: number | undefined }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [source]);
  return source && !failed ? <img src={source} alt={alt} onError={() => setFailed(true)} style={{ width, height, objectFit: objectFit ?? "contain", opacity: opacity ?? 1 }} /> : <div className="dtd-image-placeholder" style={{ width, height }}><ImageIcon size={18} /><span>{alt || "Image"}</span></div>;
}

function ElementRenderer({ element, theme, data, page, pages }: { element: DocumentElement; theme: DocumentTemplateV2["theme"]; data: Record<string, unknown> | null; page: number; pages: number }) {
  const render = (value?: string) => renderedText(value, data, page, pages);
  const style = elementStyle(element, theme);
  if (element.type === "heading") return <div style={{ ...style, fontFamily: theme.headingFamily, color: element.style?.color ?? theme.headingColor }}>{render(element.text)}</div>;
  if (element.type === "text") return <div style={style}>{render(element.text)}</div>;
  if (element.type === "note") return <div style={style}>{render(element.text)}</div>;
  if (element.type === "divider") return <div style={{ borderTop: `${element.style?.borderWidth ?? 1}px ${element.style?.borderStyle ?? "solid"} ${element.style?.borderColor ?? "#94A3B8"}`, marginTop: element.style?.marginTop, marginBottom: element.style?.marginBottom }} />;
  if (element.type === "spacer") return <div style={{ height: element.height ?? 24 }} />;
  if (element.type === "bulleted_list" || element.type === "numbered_list") {
    const Tag = element.type === "bulleted_list" ? "ul" : "ol";
    return <Tag style={{ ...style, paddingLeft: 20 }}>{(element.items ?? []).map((item, index) => <li key={index}>{render(item)}</li>)}</Tag>;
  }
  if (element.type === "field_group") return <div style={style}>{(element.fields ?? []).map((field) => <div className="dtd-kv" key={field.id}><span style={{ width: element.labelWidth ?? 120, fontWeight: field.boldLabel ? 700 : undefined }}>{render(field.label)}</span><span style={{ fontWeight: field.boldValue ? 700 : undefined }}>{render(field.value)}</span></div>)}</div>;
  if (element.type === "image") {
    const source = element.src?.trim() || (data && element.text ? valueAt(data, element.text.replace(/[{}\s]/g, "")) : undefined);
    return <div style={{ ...style, display: "flex", justifyContent: style.textAlign === "right" ? "flex-end" : style.textAlign === "center" ? "center" : "flex-start" }}><DocumentImage source={typeof source === "string" ? source : undefined} alt={element.alt ?? "Image"} width={element.width} height={element.height} objectFit={element.objectFit} opacity={element.opacity} /></div>;
  }
  if (element.type === "signature_group") return <div className="dtd-signatures" style={style}>{(element.signatories ?? []).map((sig) => <div className="dtd-signatory" key={sig.id}><strong>{sig.step ? `${sig.step}. ` : ""}{render(sig.role)}</strong><div className="dtd-signatory-line"><span>{render(sig.name)}</span><span><b>Date:</b> {render(sig.date)}</span></div>{sig.signature && <div><b>Signature:</b> {render(sig.signature)}</div>}</div>)}</div>;
  const columns = element.columns ?? [];
  const source = data && element.sourceKey ? valueAt(data, element.sourceKey) : null;
  const rows = Array.isArray(source) ? source as Array<Record<string, unknown>> : element.staticRows ?? Array.from({ length: element.previewRows ?? 2 }, () => columns.map(() => ""));
  const border = `${element.style?.borderWidth ?? 1}px solid ${element.style?.borderColor ?? "#475569"}`;
  return <div style={style} className="dtd-table-wrap"><table className="dtd-data-table" style={{ borderCollapse: "collapse", width: "100%", tableLayout: "fixed" }}>
    {element.showHeader !== false && <thead><tr style={{ background: element.headerBackground, color: element.headerColor }}>{columns.map((column) => <th key={column.id} style={{ width: `${column.width}%`, textAlign: column.align ?? "left", border, padding: element.cellPadding ?? 4 }}>{column.label}</th>)}</tr></thead>}
    <tbody>{rows.map((row, rowIndex) => <tr key={rowIndex} style={{ background: element.striped && rowIndex % 2 ? "#F8FAFC" : undefined }}>{columns.map((column, columnIndex) => {
      const raw = Array.isArray(row) ? row[columnIndex] : row[column.key];
      return <td key={column.id} style={{ textAlign: column.align ?? "left", border, padding: element.cellPadding ?? 4 }}>{render(String(raw ?? ""))}</td>;
    })}</tr>)}</tbody>
    {!!element.summaries?.length && <tfoot>{element.summaries.map((summary) => <tr key={summary.id}><td colSpan={Math.max(1, summary.labelSpan)} style={{ border, padding: element.cellPadding ?? 4, textAlign: "right", fontWeight: summary.bold ? 700 : undefined }}>{render(summary.label)}</td>{summary.values.map((value, index) => <td key={index} style={{ border, padding: element.cellPadding ?? 4, textAlign: "right", fontWeight: summary.bold ? 700 : undefined }}>{render(value)}</td>)}</tr>)}</tfoot>}
  </table></div>;
}

function RowRenderer({ row, theme, data, page, pages, children }: { row: GridRow; theme: DocumentTemplateV2["theme"]; data: Record<string, unknown> | null; page: number; pages: number; children?: (cell: GridCell, cellIndex: number) => ReactNode }) {
  return <div className="dtd-grid-row" style={{ display: "grid", gridTemplateColumns: row.columns.map((column) => `${column.width}fr`).join(" "), gap: row.gap, marginTop: row.marginTop, marginBottom: row.marginBottom, minHeight: row.minHeight, breakInside: row.keepTogether ? "avoid" : undefined }}>
    {row.columns.map((cell, index) => children ? children(cell, index) : <div key={cell.id} style={{ alignSelf: cell.verticalAlign === "center" ? "center" : cell.verticalAlign === "end" ? "end" : "start", padding: cell.padding, background: cell.background, border: cell.borderWidth ? `${cell.borderWidth}px solid ${cell.borderColor ?? "#CBD5E1"}` : undefined }}>{cell.elements.map((element) => <ElementRenderer key={element.id} element={element} theme={theme} data={data} page={page} pages={pages} />)}</div>)}
  </div>;
}

function BandRenderer({ band, theme, data, page, pages, kind }: { band: PageBand; theme: DocumentTemplateV2["theme"]; data: Record<string, unknown> | null; page: number; pages: number; kind: "header" | "footer" }) {
  if (!band.enabled) return null;
  return <div className={cx("dtd-band", `dtd-${kind}`, band.border && "has-rule")} style={{ minHeight: band.height }}>{band.rows.map((row) => <RowRenderer key={row.id} row={row} theme={theme} data={data} page={page} pages={pages} />)}</div>;
}

function Watermark({ watermark, data }: { watermark: WatermarkSettings; data: Record<string, unknown> | null }) {
  if (!watermark.enabled) return null;
  const value = data ? substitute(watermark.value, data) : watermark.value;
  return <div className="dtd-watermark" style={{ opacity: watermark.opacity, transform: `translate(-50%, -50%) rotate(${watermark.rotation ?? 0}deg)`, width: watermark.width }}>{watermark.kind === "image" && value && !value.includes("{{") ? <img src={value} alt="" /> : <span>{value}</span>}</div>;
}

/* ========================================================================== *
 * Design canvas and dragging
 * ========================================================================== */

function PaletteItem({ type }: { type: ElementType }) {
  const meta = elementMeta[type]; const Icon = meta.icon;
  const draggable = useDraggable({ id: `palette:${type}`, data: { source: "palette", type } });
  return <button ref={draggable.setNodeRef} {...draggable.listeners} {...draggable.attributes} type="button" className={cx("dtd-palette-item", draggable.isDragging && "is-dragging")} title={meta.hint} onClick={() => { /* drag to place */ }}><Icon size={15} /><span>{meta.label}</span></button>;
}

function Palette({ onAddRow }: { onAddRow: (ratios: number[]) => void }) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState<Record<PaletteGroup, boolean>>({ text: true, data: true, media: true, layout: true, signoff: true });
  const types = Object.keys(elementMeta) as ElementType[];
  const filtered = types.filter((type) => elementMeta[type].label.toLowerCase().includes(query.toLowerCase()));
  return <aside className="dtd-palette"><div className="dtd-panel-title"><span>Elements</span></div><div className="dtd-search"><Search size={14} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search elements" /></div><div className="dtd-palette-scroll">
    {groupLabels.map((group) => { const items = filtered.filter((type) => elementMeta[type].group === group.key); if (!items.length) return null; return <section key={group.key}><button type="button" className="dtd-group-title" onClick={() => setOpen((state) => ({ ...state, [group.key]: !state[group.key] }))}>{open[group.key] ? <ChevronDown size={13} /> : <ChevronRight size={13} />}<span>{group.label}</span><small>{items.length}</small></button>{open[group.key] && items.map((type) => <PaletteItem key={type} type={type} />)}</section>; })}
    <section><div className="dtd-group-title static"><Columns2 size={13} /><span>Rows & columns</span></div><div className="dtd-layout-presets">{[[1], [1, 1], [1, 2], [2, 1], [1, 1, 1], [1, 2, 1]].map((ratios) => <button type="button" key={ratios.join("-")} title={`Add ${ratios.length}-column row`} onClick={() => onAddRow(ratios)}>{ratios.map((ratio, index) => <i key={index} style={{ flex: ratio }} />)}</button>)}</div></section>
  </div><div className="dtd-palette-help">Drag an element into any cell, or add a row layout.</div></aside>;
}

function ElementFrame({ element, selected, onSelect, onDelete, onDuplicate, onMove, theme, page, pages }: { element: DocumentElement; selected: boolean; onSelect: () => void; onDelete: () => void; onDuplicate: () => void; onMove: (direction: -1 | 1) => void; theme: DocumentTemplateV2["theme"]; page: number; pages: number }) {
  const drag = useDraggable({ id: `element:${element.id}`, data: { source: "element", elementId: element.id } });
  return <div ref={drag.setNodeRef} className={cx("dtd-element-frame", selected && "is-selected", drag.isDragging && "is-dragging")} onClick={(event) => { event.stopPropagation(); onSelect(); }}><div className="dtd-element-toolbar"><button type="button" className="dtd-grip" title="Drag element" {...drag.listeners} {...drag.attributes}><GripVertical size={13} /></button><IconButton title="Move up" onClick={() => onMove(-1)}><ArrowUp size={12} /></IconButton><IconButton title="Move down" onClick={() => onMove(1)}><ArrowDown size={12} /></IconButton><IconButton title="Duplicate" onClick={onDuplicate}><Copy size={12} /></IconButton><IconButton title="Delete" onClick={onDelete}><Trash2 size={12} /></IconButton></div><ElementRenderer element={element} theme={theme} data={null} page={page} pages={pages} /></div>;
}

function CellCanvas({ pageId, row, cell, selection, onSelect, onDeleteElement, onDuplicateElement, onMoveElement, theme, pageNo, pages }: { pageId: string; row: GridRow; cell: GridCell; selection: Selection | null; onSelect: (selection: Selection) => void; onDeleteElement: (elementId: string) => void; onDuplicateElement: (elementId: string) => void; onMoveElement: (elementId: string, direction: -1 | 1) => void; theme: DocumentTemplateV2["theme"]; pageNo: number; pages: number }) {
  const drop = useDroppable({ id: `cell:${pageId}:${row.id}:${cell.id}`, data: { source: "cell", pageId, rowId: row.id, cellId: cell.id } });
  const selected = selection?.kind === "cell" && selection.cellId === cell.id;
  return <div ref={drop.setNodeRef} className={cx("dtd-cell-canvas", selected && "is-selected", drop.isOver && "is-over")} style={{ alignSelf: cell.verticalAlign === "center" ? "center" : cell.verticalAlign === "end" ? "end" : "start", padding: cell.padding, background: cell.background, borderWidth: cell.borderWidth, borderColor: cell.borderColor, minHeight: row.minHeight }} onClick={(event) => { event.stopPropagation(); onSelect({ kind: "cell", pageId, rowId: row.id, cellId: cell.id }); }}>
    {cell.elements.map((element) => <ElementFrame key={element.id} element={element} theme={theme} page={pageNo} pages={pages} selected={selection?.kind === "element" && selection.elementId === element.id} onSelect={() => onSelect({ kind: "element", pageId, rowId: row.id, cellId: cell.id, elementId: element.id })} onDelete={() => onDeleteElement(element.id)} onDuplicate={() => onDuplicateElement(element.id)} onMove={(direction) => onMoveElement(element.id, direction)} />)}
    {!cell.elements.length && <div className="dtd-empty-cell"><Plus size={13} />Drop an element here</div>}
  </div>;
}

function DesignerPage({ template, page, pageIndex, selection, onSelect, onDeleteRow, onDuplicateRow, onMoveRow, onDeleteElement, onDuplicateElement, onMoveElement }: { template: DocumentTemplateV2; page: DocumentPage; pageIndex: number; selection: Selection | null; onSelect: (selection: Selection) => void; onDeleteRow: (rowId: string) => void; onDuplicateRow: (rowId: string) => void; onMoveRow: (rowId: string, direction: -1 | 1) => void; onDeleteElement: (elementId: string) => void; onDuplicateElement: (elementId: string) => void; onMoveElement: (elementId: string, direction: -1 | 1) => void }) {
  const dims = PAGE_DIMS[template.page.size]; const portrait = template.page.orientation === "portrait";
  const width = portrait ? dims.w : dims.h; const height = portrait ? dims.h : dims.w; const margin = template.page.margin;
  return <div className="dtd-page-wrap" style={{ width: `${width}mm` }}><div className="dtd-page-label">{page.name} · Page {pageIndex + 1} of {template.pages.length}</div><article className="dtd-paper" style={{ width: `${width}mm`, minHeight: `${height}mm`, fontFamily: template.theme.fontFamily, fontSize: template.theme.baseFontSize, lineHeight: template.theme.lineHeight }} onClick={() => onSelect({ kind: "page", pageId: page.id })}>
    <Watermark watermark={template.watermark} data={null} /><div className={cx("dtd-editable-band", selection?.kind === "band" && selection.band === "header" && "is-selected")} onClick={(event) => { event.stopPropagation(); onSelect({ kind: "band", band: "header" }); }} title="Edit header"><BandRenderer band={template.header} theme={template.theme} data={null} page={pageIndex + 1} pages={template.pages.length} kind="header" /></div>
    <div className="dtd-page-content" style={{ padding: `${margin.top}mm ${margin.right}mm ${margin.bottom}mm ${margin.left}mm` }}>{page.rows.map((row) => <div key={row.id} className={cx("dtd-row-frame", selection?.kind === "row" && selection.rowId === row.id && "is-selected")} onClick={(event) => { event.stopPropagation(); onSelect({ kind: "row", pageId: page.id, rowId: row.id }); }}><div className="dtd-row-toolbar"><IconButton title="Move row up" onClick={() => onMoveRow(row.id, -1)}><ArrowUp size={12} /></IconButton><IconButton title="Move row down" onClick={() => onMoveRow(row.id, 1)}><ArrowDown size={12} /></IconButton><IconButton title="Duplicate row" onClick={() => onDuplicateRow(row.id)}><Copy size={12} /></IconButton><IconButton title="Delete row" onClick={() => onDeleteRow(row.id)}><Trash2 size={12} /></IconButton></div><RowRenderer row={row} theme={template.theme} data={null} page={pageIndex + 1} pages={template.pages.length}>{(cell) => <CellCanvas key={cell.id} pageId={page.id} row={row} cell={cell} selection={selection} onSelect={onSelect} onDeleteElement={onDeleteElement} onDuplicateElement={onDuplicateElement} onMoveElement={onMoveElement} theme={template.theme} pageNo={pageIndex + 1} pages={template.pages.length} />}</RowRenderer></div>)}</div>
    <BandRenderer band={template.footer} theme={template.theme} data={null} page={pageIndex + 1} pages={template.pages.length} kind="footer" />
  </article></div>;
}

/* ========================================================================== *
 * Inspector
 * ========================================================================== */

function StyleInspector({ element, patch }: { element: DocumentElement; patch: (value: Partial<DocumentElement>) => void }) {
  const style = element.style ?? {};
  const setStyle = (value: Partial<ElementStyle>) => patch({ style: { ...style, ...value } });
  return <div className="dtd-inspector-section"><h4>Style</h4><Field label="Alignment"><Segmented value={style.align ?? "left"} onChange={(align) => setStyle({ align })} options={[{ value: "left", label: <AlignLeft size={14} />, title: "Left" }, { value: "center", label: <AlignCenter size={14} />, title: "Center" }, { value: "right", label: <AlignRight size={14} />, title: "Right" }, { value: "justify", label: <AlignJustify size={14} />, title: "Justify" }]} /></Field><div className="dtd-inline-controls"><IconButton title="Bold" active={style.bold} onClick={() => setStyle({ bold: !style.bold })}><Bold size={14} /></IconButton><IconButton title="Italic" active={style.italic} onClick={() => setStyle({ italic: !style.italic })}><Italic size={14} /></IconButton><IconButton title="Underline" active={style.underline} onClick={() => setStyle({ underline: !style.underline })}><Underline size={14} /></IconButton></div><div className="dtd-two"><Field label="Font size"><NumberInput value={style.fontSize} min={6} max={96} onChange={(fontSize) => setStyle({ fontSize })} suffix="px" /></Field><Field label="Text colour"><input type="color" value={style.color ?? "#111827"} onChange={(event) => setStyle({ color: event.target.value })} /></Field></div><div className="dtd-two"><Field label="Space above"><NumberInput value={style.marginTop} onChange={(marginTop) => setStyle({ marginTop })} suffix="px" /></Field><Field label="Space below"><NumberInput value={style.marginBottom} onChange={(marginBottom) => setStyle({ marginBottom })} suffix="px" /></Field></div><div className="dtd-two"><Field label="Padding"><NumberInput value={style.padding} onChange={(padding) => setStyle({ padding })} suffix="px" /></Field><Field label="Border"><NumberInput value={style.borderWidth} max={12} onChange={(borderWidth) => setStyle({ borderWidth })} suffix="px" /></Field></div></div>;
}

function ElementInspector({ element, fields, patch }: { element: DocumentElement; fields: MergeField[]; patch: (value: Partial<DocumentElement>) => void }) {
  const updateList = (index: number, value: string) => patch({ items: (element.items ?? []).map((item, itemIndex) => itemIndex === index ? value : item) });
  return <div>
    <div className="dtd-inspector-section"><h4>Content</h4>
      {(["text", "heading", "note"] as ElementType[]).includes(element.type) && <TokenArea value={element.text ?? ""} onChange={(textValue) => patch({ text: textValue })} fields={fields} rows={element.type === "text" ? 5 : 2} />}
      {element.type === "heading" && <Field label="Heading level"><Segmented value={String(element.level ?? 2)} onChange={(value) => patch({ level: Number(value) as 1 | 2 | 3 })} options={[1, 2, 3].map((level) => ({ value: String(level), label: `H${level}` }))} /></Field>}
      {(element.type === "bulleted_list" || element.type === "numbered_list") && <div className="dtd-stack">{(element.items ?? []).map((item, index) => <div className="dtd-list-input" key={index}><textarea value={item} rows={2} onChange={(event) => updateList(index, event.target.value)} /><IconButton title="Remove item" onClick={() => patch({ items: (element.items ?? []).filter((_, itemIndex) => itemIndex !== index) })}><Trash2 size={13} /></IconButton></div>)}<button type="button" className="dtd-secondary" onClick={() => patch({ items: [...(element.items ?? []), "New item"] })}><Plus size={13} />Add item</button></div>}
      {element.type === "field_group" && <div className="dtd-stack"><Field label="Label width"><NumberInput value={element.labelWidth} onChange={(labelWidth) => patch({ labelWidth })} suffix="px" /></Field>{(element.fields ?? []).map((item) => <div className="dtd-box" key={item.id}><input className={inputClass} value={item.label} placeholder="Label" onChange={(event) => patch({ fields: (element.fields ?? []).map((field) => field.id === item.id ? { ...field, label: event.target.value } : field) })} /><TokenArea rows={2} fields={fields} value={item.value} onChange={(value) => patch({ fields: (element.fields ?? []).map((field) => field.id === item.id ? { ...field, value } : field) })} /><div className="dtd-check-row"><label><input type="checkbox" checked={!!item.boldLabel} onChange={(event) => patch({ fields: (element.fields ?? []).map((field) => field.id === item.id ? { ...field, boldLabel: event.target.checked } : field) })} />Bold label</label><label><input type="checkbox" checked={!!item.boldValue} onChange={(event) => patch({ fields: (element.fields ?? []).map((field) => field.id === item.id ? { ...field, boldValue: event.target.checked } : field) })} />Bold value</label><IconButton title="Remove row" onClick={() => patch({ fields: (element.fields ?? []).filter((field) => field.id !== item.id) })}><Trash2 size={13} /></IconButton></div></div>)}<button type="button" className="dtd-secondary" onClick={() => patch({ fields: [...(element.fields ?? []), { id: uid(), label: "Label", value: "" }] })}><Plus size={13} />Add field row</button></div>}
      {element.type === "image" && <><Field label="Image field or URL"><TokenArea value={element.text ?? element.src ?? ""} onChange={(value) => patch(value.trim().startsWith("{{") ? { text: value, src: "" } : { src: value, text: "" })} fields={fields} rows={2} /></Field><label className="dtd-upload"><Upload size={14} />Choose local image<input type="file" accept="image/*" onChange={(event) => { const file = event.target.files?.[0]; if (!file) return; const reader = new FileReader(); reader.onload = () => patch({ src: String(reader.result), text: "" }); reader.readAsDataURL(file); }} /></label><div className="dtd-two"><Field label="Width"><NumberInput value={element.width} onChange={(width) => patch({ width })} suffix="px" /></Field><Field label="Height"><NumberInput value={element.height} onChange={(height) => patch({ height })} suffix="px" /></Field></div><Field label="Alternative text"><input className={inputClass} value={element.alt ?? ""} onChange={(event) => patch({ alt: event.target.value })} /></Field></>}
      {element.type === "spacer" && <Field label="Height"><NumberInput value={element.height} onChange={(height) => patch({ height })} suffix="px" /></Field>}
      {element.type === "data_table" && <TableInspector element={element} fields={fields} patch={patch} />}
      {element.type === "signature_group" && <SignatureInspector element={element} fields={fields} patch={patch} />}
    </div>
    {!(["divider", "spacer"] as ElementType[]).includes(element.type) && <StyleInspector element={element} patch={patch} />}
    {element.type === "divider" && <StyleInspector element={element} patch={patch} />}
  </div>;
}

function TableInspector({ element, fields, patch }: { element: DocumentElement; fields: MergeField[]; patch: (value: Partial<DocumentElement>) => void }) {
  const collections = fields.filter((field) => field.repeating);
  const collection = collections.find((field) => field.key === element.sourceKey);
  const columns = element.columns ?? [];
  return <div className="dtd-stack"><Field label="Repeating source"><select className={inputClass} value={element.sourceKey ?? ""} onChange={(event) => patch({ sourceKey: event.target.value })}><option value="">Static rows</option>{collections.map((field) => <option key={field.key} value={field.key}>{field.label}</option>)}</select></Field><div className="dtd-check-row"><label><input type="checkbox" checked={element.showHeader !== false} onChange={(event) => patch({ showHeader: event.target.checked })} />Header</label><label><input type="checkbox" checked={!!element.repeatHeader} onChange={(event) => patch({ repeatHeader: event.target.checked })} />Repeat</label><label><input type="checkbox" checked={!!element.striped} onChange={(event) => patch({ striped: event.target.checked })} />Striped</label></div><Field label="Cell padding"><NumberInput value={element.cellPadding} max={24} onChange={(cellPadding) => patch({ cellPadding })} suffix="px" /></Field><h5 className="dtd-subtitle">Columns</h5>{columns.map((column) => <div className="dtd-box" key={column.id}><div className="dtd-list-input"><input className={inputClass} value={column.label} onChange={(event) => patch({ columns: columns.map((item) => item.id === column.id ? { ...item, label: event.target.value } : item) })} /><IconButton title="Remove column" onClick={() => patch({ columns: columns.filter((item) => item.id !== column.id) })}><Trash2 size={13} /></IconButton></div><div className="dtd-two"><Field label="Data field"><select className={inputClass} value={column.key} onChange={(event) => patch({ columns: columns.map((item) => item.id === column.id ? { ...item, key: event.target.value } : item) })}>{collection?.children?.map((child) => <option key={child.key} value={child.key}>{child.label}</option>)}{!collection?.children?.some((child) => child.key === column.key) && <option value={column.key}>{column.key}</option>}</select></Field><Field label="Width %"><NumberInput value={column.width} min={1} max={100} onChange={(width) => patch({ columns: columns.map((item) => item.id === column.id ? { ...item, width } : item) })} /></Field></div></div>)}<button type="button" className="dtd-secondary" onClick={() => patch({ columns: [...columns, { id: uid(), key: collection?.children?.[0]?.key ?? "field", label: "Column", width: 10 }] })}><Plus size={13} />Add column</button><h5 className="dtd-subtitle">Summary rows</h5>{(element.summaries ?? []).map((summary) => <div className="dtd-box" key={summary.id}><TokenArea fields={fields} value={summary.label} onChange={(label) => patch({ summaries: (element.summaries ?? []).map((item) => item.id === summary.id ? { ...item, label } : item) })} rows={2} /><div className="dtd-list-input"><NumberInput value={summary.labelSpan} min={1} max={Math.max(1, columns.length)} onChange={(labelSpan) => patch({ summaries: (element.summaries ?? []).map((item) => item.id === summary.id ? { ...item, labelSpan } : item) })} /><IconButton title="Remove summary" onClick={() => patch({ summaries: (element.summaries ?? []).filter((item) => item.id !== summary.id) })}><Trash2 size={13} /></IconButton></div><Field label="Remaining cell values"><input className={inputClass} value={summary.values.join(" | ")} onChange={(event) => patch({ summaries: (element.summaries ?? []).map((item) => item.id === summary.id ? { ...item, values: event.target.value.split("|").map((value) => value.trim()) } : item) })} /></Field></div>)}<button type="button" className="dtd-secondary" onClick={() => patch({ summaries: [...(element.summaries ?? []), { id: uid(), label: "Total", labelSpan: Math.max(1, columns.length - 1), values: ["{{total}}"], bold: true }] })}><Plus size={13} />Add summary</button></div>;
}

function SignatureInspector({ element, fields, patch }: { element: DocumentElement; fields: MergeField[]; patch: (value: Partial<DocumentElement>) => void }) {
  const signatures = element.signatories ?? [];
  const set = (id: string, value: Partial<Signatory>) => patch({ signatories: signatures.map((item) => item.id === id ? { ...item, ...value } : item) });
  return <div className="dtd-stack">{signatures.map((signature) => <div className="dtd-box" key={signature.id}><div className="dtd-list-input"><input className={inputClass} value={signature.step ?? ""} placeholder="Step" onChange={(event) => set(signature.id, { step: event.target.value })} /><IconButton title="Remove signatory" onClick={() => patch({ signatories: signatures.filter((item) => item.id !== signature.id) })}><Trash2 size={13} /></IconButton></div><Field label="Role"><TokenArea fields={fields} value={signature.role} onChange={(role) => set(signature.id, { role })} rows={2} /></Field><Field label="Name"><TokenArea fields={fields} value={signature.name} onChange={(name) => set(signature.id, { name })} rows={2} /></Field><Field label="Date"><TokenArea fields={fields} value={signature.date} onChange={(date) => set(signature.id, { date })} rows={2} /></Field><Field label="Signature"><TokenArea fields={fields} value={signature.signature ?? ""} onChange={(signatureValue) => set(signature.id, { signature: signatureValue })} rows={2} /></Field></div>)}<button type="button" className="dtd-secondary" onClick={() => patch({ signatories: [...signatures, { id: uid(), step: String(signatures.length + 1), role: "Approved by", name: "[[Name]]", date: "[[Date]]", signature: "[[Signature]]" }] })}><Plus size={13} />Add signatory</button></div>;
}

function Inspector({ template, selection, fields, onPatchElement, onPatchRow, onPatchCell, onPatchBand, onClose }: { template: DocumentTemplateV2; selection: Selection | null; fields: MergeField[]; onPatchElement: (value: Partial<DocumentElement>) => void; onPatchRow: (value: Partial<GridRow>) => void; onPatchCell: (value: Partial<GridCell>) => void; onPatchBand: (band: "header" | "footer", value: PageBand) => void; onClose: () => void }) {
  let title = "Properties"; let body: ReactNode = <div className="dtd-empty-inspector"><Settings size={30} /><p>Select a page, row, cell, or element.</p></div>;
  if (selection?.kind === "band") {
    const bandKey = selection.band;
    const band = template[bandKey];
    title = bandKey === "header" ? "Header" : "Footer";
    const updateElement = (elementId: string, patch: Partial<DocumentElement>) => onPatchBand(bandKey, { ...band, rows: band.rows.map((row) => ({ ...row, columns: row.columns.map((cell) => ({ ...cell, elements: cell.elements.map((element) => element.id === elementId ? { ...element, ...patch } : element) })) })) });
    body = <div className="dtd-inspector-section"><h4>{title} content</h4><label className="dtd-checkbox"><input type="checkbox" checked={band.enabled} onChange={(event) => onPatchBand(bandKey, { ...band, enabled: event.target.checked })} />Show on every page</label><label className="dtd-checkbox"><input type="checkbox" checked={band.border} onChange={(event) => onPatchBand(bandKey, { ...band, border: event.target.checked })} />Divider rule</label><Field label="Minimum height"><NumberInput value={band.height} onChange={(height) => onPatchBand(bandKey, { ...band, height })} suffix="px" /></Field>{band.rows.flatMap((row) => row.columns.flatMap((cell, index) => cell.elements.map((element) => <div className="dtd-box" key={element.id}><h5 className="dtd-subtitle">Column {index + 1} · {element.type === "image" ? "Logo / image" : "Text"}</h5><ElementInspector element={element} fields={fields} patch={(value) => updateElement(element.id, value)} /><IconButton title="Remove from band" onClick={() => onPatchBand(bandKey, { ...band, rows: band.rows.map((item) => ({ ...item, columns: item.columns.map((column) => ({ ...column, elements: column.elements.filter((child) => child.id !== element.id) })) })) })}><Trash2 size={13} /></IconButton></div>)))}<div className="dtd-stack"><button className="dtd-secondary" type="button" onClick={() => onPatchBand(bandKey, { ...band, rows: [...band.rows, makeRow([1], [[makeElement("text")]])] })}><Plus size={13} />Add text row</button><button className="dtd-secondary" type="button" onClick={() => onPatchBand(bandKey, { ...band, rows: [...band.rows, makeRow([1], [[makeElement("image")]])] })}><Plus size={13} />Add image row</button></div></div>;
  }
  if (selection?.kind === "element") { const element = template.pages.flatMap((page) => page.rows).flatMap((row) => row.columns).flatMap((cell) => cell.elements).find((item) => item.id === selection.elementId); if (element) { title = elementMeta[element.type].label; body = <ElementInspector element={element} fields={fields} patch={onPatchElement} />; } }
  if (selection?.kind === "row") { const row = template.pages.flatMap((page) => page.rows).find((item) => item.id === selection.rowId); if (row) { title = "Row layout"; body = <div className="dtd-inspector-section"><h4>Structure</h4><div className="dtd-two"><Field label="Column gap"><NumberInput value={row.gap} max={80} onChange={(gap) => onPatchRow({ gap })} suffix="px" /></Field><Field label="Min height"><NumberInput value={row.minHeight} onChange={(minHeight) => onPatchRow({ minHeight })} suffix="px" /></Field></div><div className="dtd-two"><Field label="Space above"><NumberInput value={row.marginTop} onChange={(marginTop) => onPatchRow({ marginTop })} suffix="px" /></Field><Field label="Space below"><NumberInput value={row.marginBottom} onChange={(marginBottom) => onPatchRow({ marginBottom })} suffix="px" /></Field></div><label className="dtd-checkbox"><input type="checkbox" checked={!!row.keepTogether} onChange={(event) => onPatchRow({ keepTogether: event.target.checked })} />Keep row together when printing</label><h4>Column ratios</h4>{row.columns.map((cell) => <Field key={cell.id} label={`Column ${row.columns.indexOf(cell) + 1}`}><NumberInput min={1} max={12} value={cell.width} onChange={(width) => onPatchRow({ columns: row.columns.map((item) => item.id === cell.id ? { ...item, width } : item) })} /></Field>)}</div>; } }
  if (selection?.kind === "cell") { const cell = template.pages.flatMap((page) => page.rows).flatMap((row) => row.columns).find((item) => item.id === selection.cellId); if (cell) { title = "Column"; body = <div className="dtd-inspector-section"><h4>Cell layout</h4><Field label="Vertical alignment"><Segmented value={cell.verticalAlign ?? "start"} onChange={(verticalAlign) => onPatchCell({ verticalAlign })} options={[{ value: "start", label: "Top" }, { value: "center", label: "Middle" }, { value: "end", label: "Bottom" }]} /></Field><div className="dtd-two"><Field label="Padding"><NumberInput value={cell.padding} onChange={(padding) => onPatchCell({ padding })} suffix="px" /></Field><Field label="Border"><NumberInput value={cell.borderWidth} max={12} onChange={(borderWidth) => onPatchCell({ borderWidth })} suffix="px" /></Field></div><Field label="Background"><input type="color" value={cell.background ?? "#FFFFFF"} onChange={(event) => onPatchCell({ background: event.target.value })} /></Field></div>; } }
  return <aside className="dtd-inspector"><div className="dtd-panel-title"><span>{title}</span><IconButton title="Close properties" onClick={onClose}><X size={15} /></IconButton></div><div className="dtd-inspector-scroll">{body}</div></aside>;
}

/* ========================================================================== *
 * Settings and preview
 * ========================================================================== */

function SettingsView({ template, documentTypes, commit }: { template: DocumentTemplateV2; documentTypes: TemplateDesignerProps["documentTypes"]; commit: (value: DocumentTemplateV2) => void }) {
  const setPage = (value: Partial<DocumentTemplateV2["page"]>) => commit({ ...template, page: { ...template.page, ...value } });
  const setTheme = (value: Partial<DocumentTemplateV2["theme"]>) => commit({ ...template, theme: { ...template.theme, ...value } });
  const setMargin = (key: keyof DocumentTemplateV2["page"]["margin"], value: number) => setPage({ margin: { ...template.page.margin, [key]: value } });
  return <main className="dtd-settings"><div className="dtd-settings-grid"><section><h3>Template details</h3><Field label="Name"><input className={inputClass} value={template.name} onChange={(event) => commit({ ...template, name: event.target.value })} /></Field><Field label="Description"><textarea className={inputClass} rows={3} value={template.description ?? ""} onChange={(event) => commit({ ...template, description: event.target.value })} /></Field>{!!documentTypes?.length && <Field label="Document type"><select className={inputClass} value={template.documentTypeId ?? ""} onChange={(event) => commit({ ...template, documentTypeId: event.target.value })}><option value="">Select type</option>{documentTypes.map((type) => <option key={type.id} value={type.id}>{type.name}</option>)}</select></Field>}</section><section><h3>Page setup</h3><div className="dtd-two"><Field label="Size"><select className={inputClass} value={template.page.size} onChange={(event) => setPage({ size: event.target.value as PageSize })}><option>A4</option><option>Letter</option><option>Legal</option></select></Field><Field label="Orientation"><select className={inputClass} value={template.page.orientation} onChange={(event) => setPage({ orientation: event.target.value as Orientation })}><option value="portrait">Portrait</option><option value="landscape">Landscape</option></select></Field></div><h4>Margins (mm)</h4><div className="dtd-four">{(["top", "right", "bottom", "left"] as const).map((key) => <Field key={key} label={key}><NumberInput value={template.page.margin[key]} min={0} max={60} onChange={(value) => setMargin(key, value)} /></Field>)}</div></section><section><h3>Typography & colour</h3><div className="dtd-two"><Field label="Body font"><select className={inputClass} value={template.theme.fontFamily} onChange={(event) => setTheme({ fontFamily: event.target.value })}><option value="Arial, Helvetica, sans-serif">Arial</option><option value="Calibri, 'Segoe UI', sans-serif">Calibri</option><option value="Georgia, 'Times New Roman', serif">Georgia</option><option value="'Times New Roman', Times, serif">Times New Roman</option></select></Field><Field label="Heading font"><select className={inputClass} value={template.theme.headingFamily} onChange={(event) => setTheme({ headingFamily: event.target.value })}><option value="Arial, Helvetica, sans-serif">Arial</option><option value="Georgia, 'Times New Roman', serif">Georgia</option><option value="'Times New Roman', Times, serif">Times New Roman</option></select></Field></div><div className="dtd-four"><Field label="Base size"><NumberInput value={template.theme.baseFontSize} min={7} max={24} onChange={(baseFontSize) => setTheme({ baseFontSize })} /></Field><Field label="Line height"><NumberInput value={template.theme.lineHeight} min={1} max={3} onChange={(lineHeight) => setTheme({ lineHeight })} /></Field><Field label="Text"><input type="color" value={template.theme.textColor} onChange={(event) => setTheme({ textColor: event.target.value })} /></Field><Field label="Accent"><input type="color" value={template.theme.accentColor} onChange={(event) => setTheme({ accentColor: event.target.value })} /></Field></div></section><section><h3>Page bands & watermark</h3><div className="dtd-check-row"><label><input type="checkbox" checked={template.header.enabled} onChange={(event) => commit({ ...template, header: { ...template.header, enabled: event.target.checked } })} />Header</label><label><input type="checkbox" checked={template.footer.enabled} onChange={(event) => commit({ ...template, footer: { ...template.footer, enabled: event.target.checked } })} />Footer</label><label><input type="checkbox" checked={template.watermark.enabled} onChange={(event) => commit({ ...template, watermark: { ...template.watermark, enabled: event.target.checked } })} />Watermark</label></div><Field label="Watermark value"><input className={inputClass} value={template.watermark.value} onChange={(event) => commit({ ...template, watermark: { ...template.watermark, value: event.target.value } })} /></Field><div className="dtd-two"><Field label="Opacity"><input type="range" min="0.01" max="0.4" step="0.01" value={template.watermark.opacity} onChange={(event) => commit({ ...template, watermark: { ...template.watermark, opacity: Number(event.target.value) } })} /></Field><Field label="Rotation"><NumberInput min={-180} max={180} value={template.watermark.rotation} onChange={(rotation) => commit({ ...template, watermark: { ...template.watermark, rotation } })} suffix="°" /></Field></div></section><section className="dtd-wide"><h3>Required DMS fields</h3><div className="dtd-field-chips">{collectRequiredFields(template).map((field) => <code key={field}>{`{{${field}}}`}</code>)}</div></section></div></main>;
}

function Preview({ template, data }: { template: DocumentTemplateV2; data: Record<string, unknown> }) {
  const dims = PAGE_DIMS[template.page.size]; const portrait = template.page.orientation === "portrait";
  const width = portrait ? dims.w : dims.h; const height = portrait ? dims.h : dims.w; const margin = template.page.margin;
  return <main className="dtd-preview">{template.pages.map((page, index) => <article key={page.id} className="dtd-paper dtd-preview-paper" style={{ width: `${width}mm`, minHeight: `${height}mm`, fontFamily: template.theme.fontFamily, fontSize: template.theme.baseFontSize, lineHeight: template.theme.lineHeight }}><Watermark watermark={template.watermark} data={data} /><BandRenderer band={template.header} theme={template.theme} data={data} page={index + 1} pages={template.pages.length} kind="header" /><div className="dtd-page-content" style={{ padding: `${margin.top}mm ${margin.right}mm ${margin.bottom}mm ${margin.left}mm` }}>{page.rows.map((row) => <RowRenderer key={row.id} row={row} theme={template.theme} data={data} page={index + 1} pages={template.pages.length} />)}</div><BandRenderer band={template.footer} theme={template.theme} data={data} page={index + 1} pages={template.pages.length} kind="footer" /></article>)}</main>;
}

/* ========================================================================== *
 * Main component
 * ========================================================================== */

export default function TemplateDesigner({ initial, mergeFields = DEFAULT_FIELDS, sampleData, documentTypes = [], onSave, onCancel, isSaving }: TemplateDesignerProps) {
  const [history, setHistory] = useState<DocumentTemplateV2[]>(() => [normalizeTemplate(initial ?? createLpoTemplate())]);
  const [cursor, setCursor] = useState(0); const template: DocumentTemplateV2 = history[cursor] ?? history[0] ?? createLpoTemplate();
  const [selection, setSelection] = useState<Selection | null>(() => ({ kind: "band", band: "header" }));
  const [tab, setTab] = useState<EditorTab>("design"); const [zoom, setZoom] = useState(0.78);
  const [leftOpen, setLeftOpen] = useState(true); const [rightOpen, setRightOpen] = useState(true);
  const [dragType, setDragType] = useState<ElementType | null>(null); const importRef = useRef<HTMLInputElement>(null);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));
  const data = useMemo(() => ({ ...SAMPLE_DATA, ...(sampleData ?? {}) }), [sampleData]);

  const commit = useCallback((next: DocumentTemplateV2) => { setHistory((current) => [...current.slice(0, cursor + 1), normalizeTemplate(next)].slice(-80)); setCursor((current) => Math.min(current + 1, 79)); }, [cursor]);
  const mutatePages = (mutator: (pages: DocumentPage[]) => DocumentPage[]) => commit({ ...template, pages: mutator(template.pages) });
  const mapRows = (mapper: (row: GridRow, page: DocumentPage) => GridRow) => mutatePages((pages) => pages.map((page) => ({ ...page, rows: page.rows.map((row) => mapper(row, page)) })));
  const mapCells = (mapper: (cell: GridCell, row: GridRow, page: DocumentPage) => GridCell) => mapRows((row, page) => ({ ...row, columns: row.columns.map((cell) => mapper(cell, row, page)) }));

  const selectedPageId = (selection && "pageId" in selection ? selection.pageId : undefined) ?? template.pages[0]?.id ?? "";
  const addRow = (ratios: number[]) => { const pageId = selectedPageId; const row = makeRow(ratios); mutatePages((pages) => pages.map((page) => page.id === pageId ? { ...page, rows: [...page.rows, row] } : page)); setSelection({ kind: "row", pageId, rowId: row.id }); };
  const deleteRow = (rowId: string) => { mutatePages((pages) => pages.map((page) => ({ ...page, rows: page.rows.filter((row) => row.id !== rowId) }))); setSelection(null); };
  const duplicateRow = (rowId: string) => mutatePages((pages) => pages.map((page) => { const index = page.rows.findIndex((row) => row.id === rowId); if (index < 0) return page; const rows = [...page.rows]; const original = rows[index]; if (!original) return page; rows.splice(index + 1, 0, cloneWithNewIds(original)); return { ...page, rows }; }));
  const moveRow = (rowId: string, direction: -1 | 1) => mutatePages((pages) => pages.map((page) => { const index = page.rows.findIndex((row) => row.id === rowId); const target = index + direction; if (index < 0 || target < 0 || target >= page.rows.length) return page; const rows = [...page.rows]; const first = rows[index], second = rows[target]; if (!first || !second) return page; [rows[index], rows[target]] = [second, first]; return { ...page, rows }; }));
  const deleteElement = (elementId: string) => { mapCells((cell) => ({ ...cell, elements: cell.elements.filter((element) => element.id !== elementId) })); setSelection(null); };
  const duplicateElement = (elementId: string) => mapCells((cell) => { const index = cell.elements.findIndex((element) => element.id === elementId); if (index < 0) return cell; const elements = [...cell.elements]; const original = elements[index]; if (!original) return cell; elements.splice(index + 1, 0, cloneWithNewIds(original)); return { ...cell, elements }; });
  const moveElement = (elementId: string, direction: -1 | 1) => mapCells((cell) => { const index = cell.elements.findIndex((element) => element.id === elementId); const target = index + direction; if (index < 0 || target < 0 || target >= cell.elements.length) return cell; const elements = [...cell.elements]; const first = elements[index], second = elements[target]; if (!first || !second) return cell; [elements[index], elements[target]] = [second, first]; return { ...cell, elements }; });
  const patchElement = (value: Partial<DocumentElement>) => { if (selection?.kind !== "element") return; mapCells((cell) => ({ ...cell, elements: cell.elements.map((element) => element.id === selection.elementId ? { ...element, ...value } : element) })); };
  const patchRow = (value: Partial<GridRow>) => { if (selection?.kind !== "row") return; mapRows((row) => row.id === selection.rowId ? { ...row, ...value } : row); };
  const patchCell = (value: Partial<GridCell>) => { if (selection?.kind !== "cell") return; mapCells((cell) => cell.id === selection.cellId ? { ...cell, ...value } : cell); };
  const patchBand = (band: "header" | "footer", value: PageBand) => commit({ ...template, [band]: value });

  const onDragStart = (event: DragStartEvent) => { const type = event.active.data.current?.["type"] as ElementType | undefined; setDragType(type ?? null); };
  const onDragEnd = (event: DragEndEvent) => {
    setDragType(null); const target = event.over?.data.current; if (!target || target["source"] !== "cell") return;
    const pageId = String(target["pageId"]); const rowId = String(target["rowId"]); const cellId = String(target["cellId"]);
    const source = event.active.data.current;
    if (source?.["source"] === "palette") { const element = makeElement(source["type"] as ElementType); mapCells((cell, row, page) => cell.id === cellId && row.id === rowId && page.id === pageId ? { ...cell, elements: [...cell.elements, element] } : cell); setSelection({ kind: "element", pageId, rowId, cellId, elementId: element.id }); return; }
    if (source?.["source"] === "element") { const elementId = String(source["elementId"]); let moved: DocumentElement | undefined; template.pages.forEach((page) => page.rows.forEach((row) => row.columns.forEach((cell) => { const found = cell.elements.find((element) => element.id === elementId); if (found) moved = found; }))); if (!moved) return; mutatePages((pages) => pages.map((page) => ({ ...page, rows: page.rows.map((row) => ({ ...row, columns: row.columns.map((cell) => ({ ...cell, elements: cell.id === cellId ? [...cell.elements.filter((element) => element.id !== elementId), moved as DocumentElement] : cell.elements.filter((element) => element.id !== elementId) })) })) }))); setSelection({ kind: "element", pageId, rowId, cellId, elementId }); }
  };

  const newBlank = () => { const fresh = createLpoTemplate(); fresh.name = "Untitled document"; fresh.description = ""; fresh.header = { enabled: false, border: false, rows: [makeRow([1], [[text("")]])] }; fresh.footer = { enabled: false, border: false, rows: [makeRow([1], [[text("")]])] }; fresh.watermark.enabled = false; fresh.pages = [{ id: uid(), name: "Page 1", rows: [makeRow([1], [[heading("Document title", 1)]])] }]; setHistory([normalizeTemplate(fresh)]); setCursor(0); setSelection({ kind: "page", pageId: fresh.pages[0]?.id ?? "" }); };
  const addPage = () => { const page = { id: uid(), name: `Page ${template.pages.length + 1}`, rows: [makeRow()] }; commit({ ...template, pages: [...template.pages, page] }); setSelection({ kind: "page", pageId: page.id }); };
  const duplicatePage = () => { const page = template.pages.find((item) => item.id === selectedPageId) ?? template.pages[0]; if (!page) return; const copy = cloneWithNewIds(page); copy.name = `${page.name} copy`; commit({ ...template, pages: [...template.pages, copy] }); setSelection({ kind: "page", pageId: copy.id }); };
  const removePage = () => { if (template.pages.length === 1) { toast.error("A template needs at least one page."); return; } commit({ ...template, pages: template.pages.filter((page) => page.id !== selectedPageId) }); setSelection({ kind: "page", pageId: template.pages.find((page) => page.id !== selectedPageId)?.id ?? template.pages[0]?.id ?? "" }); };
  const importJson = async (file?: File) => { if (!file) return; try { const parsed = JSON.parse(await file.text()) as DocumentTemplateV2 | LegacyTemplate; if (!("pages" in parsed && Array.isArray(parsed.pages)) && !("blocks" in parsed && Array.isArray(parsed.blocks))) throw new Error("Not a document template"); const normalized = "pages" in parsed && Array.isArray(parsed.pages) ? normalizeTemplate(parsed as DocumentTemplateV2) : importLegacy(parsed as LegacyTemplate); setHistory([normalized]); setCursor(0); setSelection({ kind: "page", pageId: normalized.pages[0]?.id ?? "" }); toast.success("Template imported"); } catch (error) { toast.error(error instanceof Error ? error.message : "Could not import template"); } };
  const save = async () => { try { await onSave(outputDocumentTemplate(template), false); toast.success("Template saved"); } catch (error) { toast.error(error instanceof Error ? error.message : "Template could not be saved"); } };

  return <div className="dtd-root"><header className="dtd-topbar"><div className="dtd-top-left"><IconButton title="Close designer" onClick={onCancel}><ArrowLeft size={16} /></IconButton><div className="dtd-top-divider" /><input className="dtd-name" value={template.name} onChange={(event) => commit({ ...template, name: event.target.value })} /><span className="dtd-version">{template.pages.length} {template.pages.length === 1 ? "page" : "pages"}</span></div><nav className="dtd-tabs">{([{ id: "design", label: "Design", icon: LayoutGrid }, { id: "preview", label: "Preview", icon: Eye }, { id: "settings", label: "Settings", icon: Settings }] as const).map((item) => <button key={item.id} type="button" className={tab === item.id ? "is-active" : ""} onClick={() => setTab(item.id)}><item.icon size={14} />{item.label}</button>)}</nav><div className="dtd-top-actions"><IconButton title="Undo" disabled={cursor === 0} onClick={() => setCursor((value) => Math.max(0, value - 1))}><Undo2 size={15} /></IconButton><IconButton title="Redo" disabled={cursor >= history.length - 1} onClick={() => setCursor((value) => Math.min(history.length - 1, value + 1))}><Redo2 size={15} /></IconButton>{tab === "preview" && <IconButton title="Print or save as PDF" onClick={() => window.print()}><Printer size={15} /></IconButton>}<button type="button" className="dtd-save" disabled={isSaving} onClick={() => void save()}><Save size={14} />{isSaving ? "Saving…" : "Save template"}</button></div></header>
    <div className="dtd-subbar"><div><IconButton title={leftOpen ? "Hide elements" : "Show elements"} active={leftOpen} onClick={() => setLeftOpen((value) => !value)}><PanelLeftClose size={15} /></IconButton>{tab === "design" && <><button type="button" className="dtd-secondary" onClick={newBlank}><FileText size={13} />New blank</button><button type="button" className="dtd-secondary" onClick={addPage}><Plus size={13} />Add page</button><button type="button" className="dtd-secondary" onClick={duplicatePage}><Copy size={13} />Duplicate page</button><IconButton title="Delete page" disabled={template.pages.length === 1} onClick={removePage}><Trash2 size={14} /></IconButton></>}</div><div className="dtd-zoom"><IconButton title="Zoom out" onClick={() => setZoom((value) => Math.max(.45, value - .1))}><ZoomOut size={14} /></IconButton><span>{Math.round(zoom * 100)}%</span><IconButton title="Zoom in" onClick={() => setZoom((value) => Math.min(1.35, value + .1))}><ZoomIn size={14} /></IconButton></div><div><input ref={importRef} hidden type="file" accept="application/json" onChange={(event) => { void importJson(event.target.files?.[0]); event.target.value = ""; }} /><button type="button" className="dtd-secondary" onClick={() => importRef.current?.click()}><FileJson size={13} />Import JSON</button><button type="button" className="dtd-secondary" onClick={() => downloadJson(template)}><Download size={13} />Export JSON</button>{tab === "design" && <IconButton title={rightOpen ? "Hide properties" : "Show properties"} active={rightOpen} onClick={() => setRightOpen((value) => !value)}><PanelRightClose size={15} /></IconButton>}</div></div>
    {tab === "settings" ? <SettingsView template={template} documentTypes={documentTypes} commit={commit} /> : tab === "preview" ? <Preview template={template} data={data} /> : <DndContext sensors={sensors} onDragStart={onDragStart} onDragEnd={onDragEnd}><div className="dtd-workspace">{leftOpen && <Palette onAddRow={addRow} />}<main className="dtd-canvas"><div className="dtd-canvas-scale" style={{ transform: `scale(${zoom})`, transformOrigin: "top center", width: "100%" }}>{template.pages.map((page, pageIndex) => <DesignerPage key={page.id} template={template} page={page} pageIndex={pageIndex} selection={selection} onSelect={setSelection} onDeleteRow={deleteRow} onDuplicateRow={duplicateRow} onMoveRow={moveRow} onDeleteElement={deleteElement} onDuplicateElement={duplicateElement} onMoveElement={moveElement} />)}</div></main>{rightOpen && <Inspector template={template} selection={selection} fields={mergeFields} onPatchElement={patchElement} onPatchRow={patchRow} onPatchCell={patchCell} onPatchBand={patchBand} onClose={() => setRightOpen(false)} />}</div><DragOverlay>{dragType && <div className="dtd-drag-overlay">{(() => { const Icon = elementMeta[dragType].icon; return <Icon size={15} />; })()}{elementMeta[dragType].label}</div>}</DragOverlay></DndContext>}
  </div>;
}

/* ========================================================================== *
 * Component-scoped CSS (keeps this deliverable genuinely single-file)
 * ========================================================================== */

export { DEFAULT_FIELDS as defaultMergeFields, SAMPLE_DATA as lpoSampleData, collectRequiredFields, normalizeTemplate };
