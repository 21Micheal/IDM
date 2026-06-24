/**
 * Shared types for the comprehensive PDF editor (Sejda-style).
 *
 * Changes in this revision:
 *  • TextAnnotation.underline added (toolbar exposes B / I / U).
 *  • Whiteout `color` is now used at stamp time (defaults #ffffff). The
 *    click-to-edit flow seeds it with the sampled paper color so the cover
 *    blends into non-white pages.
 *  • ShapeAnnotation already supports fill; the toolbar now exposes it.
 */

export type ToolId =
  | "pages" | "merge" | "split" | "extract" | "rotate" | "delete"
  | "reorder" | "insert" | "duplicate" | "crop"
  | "edit" | "text" | "image" | "shape" | "highlight" | "whiteout"
  | "draw" | "link" | "redact" | "sign"
  | "watermark" | "page_numbers" | "header_footer" | "bates" | "metadata"
  | "compress" | "convert" | "protect" | "unlock" | "flatten";

export type ToolRuntime = "client" | "server";

export interface ToolDescriptor {
  id: ToolId;
  label: string;
  description: string;
  group: "organize" | "edit" | "enrich" | "optimize";
  runtime: ToolRuntime;
}

export interface EditorPage {
  id: string;
  sourceIndex: number;
  sourceId: string;
  width: number;
  height: number;
  rotation: number;
  deleted?: boolean;
  crop?: { x: number; y: number; width: number; height: number };
  thumbnail?: string;
}

export interface SourceDocument {
  id: string;
  name: string;
  bytes: Uint8Array;
  pageCount: number;
  encrypted?: boolean;
}

export type AnnotationKind =
  | "text" | "image" | "rect" | "ellipse" | "line" | "arrow"
  | "highlight" | "whiteout" | "ink" | "link" | "redact" | "signature";

export interface AnnotationBase {
  id: string;
  kind: AnnotationKind;
  pageId: string;
  x: number;
  y: number;
  width: number;
  height: number;
  rotation?: number;
  opacity?: number;
  color?: string;
  z?: number;
  locked?: boolean;
}

export interface TextAnnotation extends AnnotationBase {
  kind: "text";
  text: string;
  fontFamily: string;
  fontSize: number;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  align?: "left" | "center" | "right";
  background?: string;
}

export interface ImageAnnotation extends AnnotationBase {
  kind: "image" | "signature";
  src: string;
}

export interface ShapeAnnotation extends AnnotationBase {
  kind: "rect" | "ellipse" | "line" | "arrow" | "highlight" | "whiteout";
  strokeWidth?: number;
  fill?: string;
}

export interface InkAnnotation extends AnnotationBase {
  kind: "ink";
  paths: Array<Array<{ x: number; y: number }>>;
  strokeWidth?: number;
}

export interface LinkAnnotation extends AnnotationBase {
  kind: "link";
  url?: string;
  targetPageId?: string;
}

export interface RedactAnnotation extends AnnotationBase {
  kind: "redact";
}

export type Annotation =
  | TextAnnotation | ImageAnnotation | ShapeAnnotation
  | InkAnnotation | LinkAnnotation | RedactAnnotation;

export type PagePosition =
  | "top-left" | "top-center" | "top-right"
  | "middle-left" | "middle-center" | "middle-right"
  | "bottom-left" | "bottom-center" | "bottom-right";

export interface WatermarkConfig {
  type: "text" | "image";
  text?: string;
  imageSrc?: string;
  opacity: number;
  rotation: number;
  fontSize: number;
  color: string;
  position: PagePosition | "tiled";
  scale?: number;
}

export interface PageNumberConfig {
  position: PagePosition;
  startAt: number;
  fontSize: number;
  color: string;
  format: string;
  marginX: number;
  marginY: number;
  fromPage?: number;
  toPage?: number;
}

export interface HeaderFooterConfig {
  header?: { left?: string; center?: string; right?: string };
  footer?: { left?: string; center?: string; right?: string };
  fontSize: number;
  color: string;
  margin: number;
}

export interface BatesConfig {
  prefix?: string;
  suffix?: string;
  startAt: number;
  digits: number;
  position: PagePosition;
  fontSize: number;
  color: string;
}

export interface MetadataConfig {
  title?: string;
  author?: string;
  subject?: string;
  keywords?: string;
  creator?: string;
  producer?: string;
}

export type SplitMode = "ranges" | "everyN" | "byCount" | "individual";

export interface SplitConfig {
  mode: SplitMode;
  ranges?: string;
  everyN?: number;
  count?: number;
}

export type CompressLevel = "low" | "medium" | "high" | "extreme";

export interface ConvertConfig {
  target:
    | "pdf-to-jpg" | "pdf-to-png" | "pdf-to-docx" | "pdf-to-xlsx"
    | "pdf-to-pptx" | "pdf-to-text"
    | "jpg-to-pdf" | "office-to-pdf" | "html-to-pdf";
  dpi?: number;
}

export type JobType =
  | "compress" | "convert" | "protect" | "unlock" | "redact" | "ocr";

export interface EditorJob {
  type: JobType;
  bytes: Uint8Array;
  filename: string;
  params: Record<string, unknown>;
}

export interface ExportResult {
  blobs: Array<{ name: string; bytes: Uint8Array; mime: string }>;
}

export interface PdfEditorProps {
  initialFiles?: Array<File | string | Uint8Array>;
  signerName?: string;
  onJob?: (job: EditorJob) => Promise<Uint8Array | null>;
  onSave?: (result: ExportResult) => void | Promise<void>;
  disabledTools?: ToolId[];
  className?: string;
}