/**
 * pdfEngine — all client-side PDF operations, powered by pdf-lib.
 *
 *   npm i pdf-lib
 *
 * The engine is pure (no React). It takes the editor's working state
 * (sources + pages + annotations + enrichment configs) and assembles the
 * final document, or performs a discrete operation (merge / split / convert).
 *
 * Anything pdf-lib cannot do in-browser (Office conversion, password
 * encryption, deep image recompression, OCR redaction) is surfaced to the UI
 * as a backend job — see PdfEditor's `onJob`.
 */
import {
  PDFDocument,
  StandardFonts,
  degrees,
  rgb,
  type PDFFont,
  type PDFPage,
  type RGB,
} from "pdf-lib";
import type {
  Annotation,
  TextAnnotation,
  BatesConfig,
  EditorPage,
  HeaderFooterConfig,
  MetadataConfig,
  PageNumberConfig,
  PagePosition,
  SourceDocument,
  SplitConfig,
  WatermarkConfig,
} from "./types";

/* ------------------------------------------------------------------ */
/*  helpers                                                            */
/* ------------------------------------------------------------------ */

const uid = () => Math.random().toString(36).slice(2, 10);

export function hexToRgb(hex: string): RGB {
  const h = hex.replace("#", "");
  const full = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  const n = parseInt(full || "000000", 16);
  return rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
}

/** dataURL or remote URL → Uint8Array */
export async function toBytes(src: File | string | Uint8Array): Promise<Uint8Array> {
  if (src instanceof Uint8Array) return src;
  if (typeof src !== "string") return new Uint8Array(await src.arrayBuffer());
  if (src.startsWith("data:")) {
    const b64 = src.split(",")[1] ?? "";
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  const res = await fetch(src);
  return new Uint8Array(await res.arrayBuffer());
}

export async function loadSource(
  input: File | string | Uint8Array,
  name: string,
): Promise<SourceDocument> {
  const bytes = await toBytes(input);
  let pageCount = 0;
  let encrypted = false;
  try {
    const doc = await PDFDocument.load(bytes, { ignoreEncryption: true });
    pageCount = doc.getPageCount();
    encrypted = (doc as unknown as { isEncrypted?: boolean }).isEncrypted ?? false;
  } catch {
    encrypted = true;
  }
  return { id: uid(), name, bytes, pageCount, encrypted };
}

/** Build the initial page list for a freshly-loaded source. */
export async function pagesForSource(source: SourceDocument): Promise<EditorPage[]> {
  const doc = await PDFDocument.load(source.bytes, { ignoreEncryption: true });
  return doc.getPages().map((p, i) => {
    const { width, height } = p.getSize();
    return {
      id: uid(),
      sourceIndex: i,
      sourceId: source.id,
      width,
      height,
      rotation: 0,
    } satisfies EditorPage;
  });
}

/** Parse "1-3, 5, 8-10" (1-based, inclusive) into a sorted unique 0-based list. */
export function parseRanges(input: string, max: number): number[] {
  const out = new Set<number>();
  for (const chunk of input.split(/[,\s]+/).filter(Boolean)) {
    const m = chunk.match(/^(\d+)(?:-(\d+))?$/);
    if (!m) continue;
    const a = parseInt(m[1], 10);
    const b = m[2] ? parseInt(m[2], 10) : a;
    for (let i = Math.min(a, b); i <= Math.max(a, b); i++) {
      if (i >= 1 && i <= max) out.add(i - 1);
    }
  }
  return [...out].sort((x, y) => x - y);
}

/* ------------------------------------------------------------------ */
/*  font handling                                                     */
/* ------------------------------------------------------------------ */

interface FontSet {
  regular: PDFFont;
  bold: PDFFont;
  italic: PDFFont;
  boldItalic: PDFFont;
}

async function embedFonts(doc: PDFDocument, family: string): Promise<FontSet> {
  const f = family.toLowerCase();
  if (f.includes("times") || f.includes("serif")) {
    return {
      regular: await doc.embedFont(StandardFonts.TimesRoman),
      bold: await doc.embedFont(StandardFonts.TimesRomanBold),
      italic: await doc.embedFont(StandardFonts.TimesRomanItalic),
      boldItalic: await doc.embedFont(StandardFonts.TimesRomanBoldItalic),
    };
  }
  if (f.includes("courier") || f.includes("mono")) {
    return {
      regular: await doc.embedFont(StandardFonts.Courier),
      bold: await doc.embedFont(StandardFonts.CourierBold),
      italic: await doc.embedFont(StandardFonts.CourierOblique),
      boldItalic: await doc.embedFont(StandardFonts.CourierBoldOblique),
    };
  }
  return {
    regular: await doc.embedFont(StandardFonts.Helvetica),
    bold: await doc.embedFont(StandardFonts.HelveticaBold),
    italic: await doc.embedFont(StandardFonts.HelveticaOblique),
    boldItalic: await doc.embedFont(StandardFonts.HelveticaBoldOblique),
  };
}

function wrapText(text: string, font: PDFFont, size: number, maxWidth: number): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split("\n")) {
    let line = "";
    for (const word of paragraph.split(/(\s+)/)) {
      const test = line + word;
      if (font.widthOfTextAtSize(test, size) > maxWidth && line) {
        lines.push(line.trimEnd());
        line = word.trimStart();
      } else {
        line = test;
      }
    }
    lines.push(line);
  }
  return lines;
}

/* ------------------------------------------------------------------ */
/*  assembly                                                          */
/* ------------------------------------------------------------------ */

/** Assemble the working pages (honouring delete / reorder / rotate / crop). */
export async function assemble(
  sources: SourceDocument[],
  pages: EditorPage[],
): Promise<{ doc: PDFDocument; order: string[] }> {
  const out = await PDFDocument.create();
  const cache = new Map<string, PDFDocument>();
  for (const s of sources) {
    cache.set(s.id, await PDFDocument.load(s.bytes, { ignoreEncryption: true }));
  }
  const visible = pages.filter((p) => !p.deleted);
  const order: string[] = [];
  for (const p of visible) {
    const src = cache.get(p.sourceId);
    if (!src) continue;
    const [copied] = await out.copyPages(src, [p.sourceIndex]);
    const base = copied.getRotation().angle;
    copied.setRotation(degrees((base + p.rotation) % 360));
    if (p.crop) {
      copied.setCropBox(p.crop.x, p.crop.y, p.crop.width, p.crop.height);
    }
    out.addPage(copied);
    order.push(p.id);
  }
  return { doc: out, order };
}

/* ------------------------------------------------------------------ */
/*  annotation stamping                                               */
/* ------------------------------------------------------------------ */

async function stampAnnotations(
  doc: PDFDocument,
  pageOrder: string[],
  annotations: Annotation[],
) {
  if (!annotations.length) return;
  const fonts = await embedFonts(doc, "Helvetica");
  const pageIndex = new Map(pageOrder.map((id, i) => [id, i]));
  const sorted = [...annotations].sort((a, b) => (a.z ?? 0) - (b.z ?? 0));

  for (const a of sorted) {
    const idx = pageIndex.get(a.pageId);
    if (idx === undefined) continue;
    const page = doc.getPage(idx);
    const { width: W, height: H } = page.getSize();
    const x = a.x * W;
    const w = a.width * W;
    const h = a.height * H;
    const yTop = a.y * H;
    const y = H - yTop - h; // bottom-left origin
    const opacity = a.opacity ?? 1;
    const color = a.color ? hexToRgb(a.color) : rgb(0, 0, 0);

    switch (a.kind) {
      case "text": {
        const font = a.bold && a.italic ? fonts.boldItalic
          : a.bold ? fonts.bold : a.italic ? fonts.italic : fonts.regular;
        const size = a.fontSize * H;
        if (a.background) {
          page.drawRectangle({ x, y, width: w, height: h, color: hexToRgb(a.background), opacity });
        }
        const lines = wrapText(a.text, font, size, w);
        const lineHeight = size * 1.2;
        let cy = H - yTop - size;
        for (const line of lines) {
          let cx = x;
          if (a.align === "center") cx = x + (w - font.widthOfTextAtSize(line, size)) / 2;
          else if (a.align === "right") cx = x + (w - font.widthOfTextAtSize(line, size));
          page.drawText(line, { x: cx, y: cy, size, font, color, opacity });
          if ((a as TextAnnotation).underline) {
            const lw = font.widthOfTextAtSize(line, size);
            const uy = cy - size * 0.12;
            page.drawLine({
              start: { x: cx, y: uy }, end: { x: cx + lw, y: uy },
              thickness: Math.max(0.5, size * 0.06), color, opacity,
            });
          }
          cy -= lineHeight;
        }
        break;
      }
      case "image":
      case "signature": {
        try {
          const bytes = await toBytes((a as { src: string }).src);
          const isPng = (a as { src: string }).src.includes("image/png") ||
            (bytes[0] === 0x89 && bytes[1] === 0x50);
          const img = isPng ? await doc.embedPng(bytes) : await doc.embedJpg(bytes);
          page.drawImage(img, { x, y, width: w, height: h, opacity });
        } catch { /* skip bad image */ }
        break;
      }
      case "highlight": {
        page.drawRectangle({ x, y, width: w, height: h, color, opacity: opacity * 0.4 });
        break;
      }
      case "whiteout": {
        // Cosmetic only — paints over the glyphs, doesn't remove them. The
        // underlying text/content-stream operators are still in the file
        // and recoverable via copy-paste or a text extractor. Fine for
        // "cover a typo before reprinting"; not a privacy control.
        const fill = a.color ? hexToRgb(a.color) : rgb(1, 1, 1);
        page.drawRectangle({ x, y, width: w, height: h, color: fill });
        break;
      }
      case "redact": {
        // Same caveat as whiteout, doubled: this draws an opaque box, it
        // does NOT delete the underlying text/image content. Do not present
        // this as compliant redaction (legal/PII contexts) — route a
        // `redact` EditorJob to the backend for that, where the content
        // stream itself can be rewritten (e.g. PyMuPDF's apply_redactions,
        // pikepdf, or a commercial SDK). README already says this; keeping
        // the warning here too since this is the line most likely to bite
        // someone in production.
        page.drawRectangle({ x, y, width: w, height: h, color: rgb(0, 0, 0) });
        break;
      }
      case "rect": {
        page.drawRectangle({
          x, y, width: w, height: h,
          borderColor: color, borderWidth: (a as { strokeWidth?: number }).strokeWidth ?? 1,
          color: (a as { fill?: string }).fill ? hexToRgb((a as { fill: string }).fill) : undefined,
          opacity,
        });
        break;
      }
      case "ellipse": {
        page.drawEllipse({
          x: x + w / 2, y: y + h / 2, xScale: w / 2, yScale: h / 2,
          borderColor: color, borderWidth: (a as { strokeWidth?: number }).strokeWidth ?? 1,
          color: (a as { fill?: string }).fill ? hexToRgb((a as { fill: string }).fill) : undefined,
          opacity,
        });
        break;
      }
      case "line":
      case "arrow": {
        const thickness = (a as { strokeWidth?: number }).strokeWidth ?? 1.5;
        const x1 = x, y1 = H - yTop, x2 = x + w, y2 = H - yTop - h;
        page.drawLine({ start: { x: x1, y: y1 }, end: { x: x2, y: y2 }, thickness, color, opacity });
        if (a.kind === "arrow") {
          const ang = Math.atan2(y2 - y1, x2 - x1);
          const head = Math.max(8, thickness * 4);
          page.drawLine({ start: { x: x2, y: y2 }, end: { x: x2 - head * Math.cos(ang - 0.4), y: y2 - head * Math.sin(ang - 0.4) }, thickness, color, opacity });
          page.drawLine({ start: { x: x2, y: y2 }, end: { x: x2 - head * Math.cos(ang + 0.4), y: y2 - head * Math.sin(ang + 0.4) }, thickness, color, opacity });
        }
        break;
      }
      case "ink": {
        const ink = a as unknown as { paths: Array<Array<{ x: number; y: number }>>; strokeWidth?: number };
        const thickness = ink.strokeWidth ?? 2;
        for (const path of ink.paths) {
          for (let i = 1; i < path.length; i++) {
            page.drawLine({
              start: { x: path[i - 1].x * W, y: H - path[i - 1].y * H },
              end: { x: path[i].x * W, y: H - path[i].y * H },
              thickness, color, opacity,
            });
          }
        }
        break;
      }
      case "link": {
        drawLink(doc, page, a as unknown as { url?: string }, x, y, w, h);
        break;
      }
    }
  }
}

/** Low-level clickable URI link annotation. */
function drawLink(
  doc: PDFDocument,
  page: PDFPage,
  a: { url?: string },
  x: number, y: number, w: number, h: number,
) {
  if (!a.url) return;
  try {
    const ctx = doc.context;
    const annot = ctx.obj({
      Type: "Annot",
      Subtype: "Link",
      Rect: [x, y, x + w, y + h],
      Border: [0, 0, 0],
      A: ctx.obj({ Type: "Action", S: "URI", URI: ctx.obj(a.url) }),
    });
    const ref = ctx.register(annot);
    const existing = page.node.Annots();
    if (existing) existing.push(ref);
    else page.node.set(ctx.obj("Annots") as never, ctx.obj([ref]) as never);
  } catch { /* link best-effort */ }
}

/* ------------------------------------------------------------------ */
/*  enrichments                                                       */
/* ------------------------------------------------------------------ */

function anchor(pos: PagePosition, W: number, H: number, mx: number, my: number) {
  const [v, hh] = pos.split("-");
  const x = hh === "left" ? mx : hh === "right" ? W - mx : W / 2;
  const y = v === "top" ? H - my : v === "bottom" ? my : H / 2;
  const align: "left" | "center" | "right" =
    hh === "left" ? "left" : hh === "right" ? "right" : "center";
  return { x, y, align };
}

async function applyWatermark(doc: PDFDocument, cfg: WatermarkConfig) {
  const font = await doc.embedFont(StandardFonts.HelveticaBold);
  let img: Awaited<ReturnType<PDFDocument["embedPng"]>> | null = null;
  if (cfg.type === "image" && cfg.imageSrc) {
    const bytes = await toBytes(cfg.imageSrc);
    img = cfg.imageSrc.includes("png") || bytes[0] === 0x89
      ? await doc.embedPng(bytes) : await doc.embedJpg(bytes);
  }
  for (const page of doc.getPages()) {
    const { width: W, height: H } = page.getSize();
    const positions: Array<{ x: number; y: number }> =
      cfg.position === "tiled"
        ? tilePositions(W, H)
        : [{ x: W / 2, y: H / 2 }];
    for (const p of positions) {
      if (img) {
        const scale = (cfg.scale ?? 0.4) * W / img.width;
        const iw = img.width * scale, ih = img.height * scale;
        page.drawImage(img, { x: p.x - iw / 2, y: p.y - ih / 2, width: iw, height: ih, opacity: cfg.opacity, rotate: degrees(cfg.rotation) });
      } else if (cfg.text) {
        const size = cfg.fontSize;
        const tw = font.widthOfTextAtSize(cfg.text, size);
        page.drawText(cfg.text, {
          x: p.x - tw / 2, y: p.y, size, font,
          color: hexToRgb(cfg.color), opacity: cfg.opacity, rotate: degrees(cfg.rotation),
        });
      }
    }
  }
}

function tilePositions(W: number, H: number) {
  const out: Array<{ x: number; y: number }> = [];
  for (let x = W * 0.2; x < W; x += W * 0.4)
    for (let y = H * 0.15; y < H; y += H * 0.3) out.push({ x, y });
  return out;
}

async function applyPageNumbers(doc: PDFDocument, cfg: PageNumberConfig) {
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const pages = doc.getPages();
  const total = pages.length;
  pages.forEach((page, i) => {
    const human = i + 1;
    if (cfg.fromPage && human < cfg.fromPage) return;
    if (cfg.toPage && human > cfg.toPage) return;
    const { width: W, height: H } = page.getSize();
    const label = cfg.format
      .replace("{n}", String(cfg.startAt + i))
      .replace("{total}", String(total));
    const { x, y, align } = anchor(cfg.position, W, H, cfg.marginX, cfg.marginY);
    const tw = font.widthOfTextAtSize(label, cfg.fontSize);
    const drawX = align === "left" ? x : align === "right" ? x - tw : x - tw / 2;
    page.drawText(label, { x: drawX, y, size: cfg.fontSize, font, color: hexToRgb(cfg.color) });
  });
}

async function applyHeaderFooter(doc: PDFDocument, cfg: HeaderFooterConfig) {
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (const page of doc.getPages()) {
    const { width: W, height: H } = page.getSize();
    const draw = (text: string | undefined, align: "left" | "center" | "right", top: boolean) => {
      if (!text) return;
      const tw = font.widthOfTextAtSize(text, cfg.fontSize);
      const x = align === "left" ? cfg.margin : align === "right" ? W - cfg.margin - tw : (W - tw) / 2;
      const y = top ? H - cfg.margin : cfg.margin;
      page.drawText(text, { x, y, size: cfg.fontSize, font, color: hexToRgb(cfg.color) });
    };
    draw(cfg.header?.left, "left", true);
    draw(cfg.header?.center, "center", true);
    draw(cfg.header?.right, "right", true);
    draw(cfg.footer?.left, "left", false);
    draw(cfg.footer?.center, "center", false);
    draw(cfg.footer?.right, "right", false);
  }
}

async function applyBates(doc: PDFDocument, cfg: BatesConfig) {
  const font = await doc.embedFont(StandardFonts.Helvetica);
  doc.getPages().forEach((page, i) => {
    const { width: W, height: H } = page.getSize();
    const num = String(cfg.startAt + i).padStart(cfg.digits, "0");
    const label = `${cfg.prefix ?? ""}${num}${cfg.suffix ?? ""}`;
    const { x, y, align } = anchor(cfg.position, W, H, 24, 24);
    const tw = font.widthOfTextAtSize(label, cfg.fontSize);
    const drawX = align === "left" ? x : align === "right" ? x - tw : x - tw / 2;
    page.drawText(label, { x: drawX, y, size: cfg.fontSize, font, color: hexToRgb(cfg.color) });
  });
}

function applyMetadata(doc: PDFDocument, m: MetadataConfig) {
  if (m.title !== undefined) doc.setTitle(m.title);
  if (m.author !== undefined) doc.setAuthor(m.author);
  if (m.subject !== undefined) doc.setSubject(m.subject);
  if (m.keywords !== undefined) doc.setKeywords(m.keywords.split(/[,\s]+/).filter(Boolean));
  if (m.creator !== undefined) doc.setCreator(m.creator);
  if (m.producer !== undefined) doc.setProducer(m.producer);
}

/* ------------------------------------------------------------------ */
/*  public export API                                                 */
/* ------------------------------------------------------------------ */

export interface ExportOptions {
  watermark?: WatermarkConfig;
  pageNumbers?: PageNumberConfig;
  headerFooter?: HeaderFooterConfig;
  bates?: BatesConfig;
  metadata?: MetadataConfig;
  flatten?: boolean;
}

/** The main export path: assemble + stamp + enrich → final bytes. */
export async function exportDocument(
  sources: SourceDocument[],
  pages: EditorPage[],
  annotations: Annotation[],
  opts: ExportOptions = {},
): Promise<Uint8Array> {
  const { doc, order } = await assemble(sources, pages);
  await stampAnnotations(doc, order, annotations);
  if (opts.watermark) await applyWatermark(doc, opts.watermark);
  if (opts.headerFooter) await applyHeaderFooter(doc, opts.headerFooter);
  if (opts.pageNumbers) await applyPageNumbers(doc, opts.pageNumbers);
  if (opts.bates) await applyBates(doc, opts.bates);
  if (opts.metadata) applyMetadata(doc, opts.metadata);
  return doc.save({ useObjectStreams: true });
}

/** Merge an explicit set of documents in order. */
export async function mergeDocuments(docs: Array<Uint8Array>): Promise<Uint8Array> {
  const out = await PDFDocument.create();
  for (const bytes of docs) {
    const src = await PDFDocument.load(bytes, { ignoreEncryption: true });
    const copied = await out.copyPages(src, src.getPageIndices());
    copied.forEach((p) => out.addPage(p));
  }
  return out.save();
}

/** Split the assembled document according to cfg. Returns named parts. */
export async function splitDocument(
  bytes: Uint8Array,
  cfg: SplitConfig,
  baseName = "document",
): Promise<Array<{ name: string; bytes: Uint8Array }>> {
  const src = await PDFDocument.load(bytes, { ignoreEncryption: true });
  const total = src.getPageCount();
  const groups: number[][] = [];

  if (cfg.mode === "individual") {
    for (let i = 0; i < total; i++) groups.push([i]);
  } else if (cfg.mode === "everyN") {
    const n = Math.max(1, cfg.everyN ?? 1);
    for (let i = 0; i < total; i += n) groups.push(range(i, Math.min(i + n, total)));
  } else if (cfg.mode === "byCount") {
    const c = Math.max(1, cfg.count ?? 1);
    const per = Math.ceil(total / c);
    for (let i = 0; i < total; i += per) groups.push(range(i, Math.min(i + per, total)));
  } else {
    // ranges → each comma segment becomes a file
    for (const chunk of (cfg.ranges ?? "").split(",").map((s) => s.trim()).filter(Boolean)) {
      const idx = parseRanges(chunk, total);
      if (idx.length) groups.push(idx);
    }
    if (!groups.length) groups.push(range(0, total));
  }

  const out: Array<{ name: string; bytes: Uint8Array }> = [];
  for (let g = 0; g < groups.length; g++) {
    const part = await PDFDocument.create();
    const copied = await part.copyPages(src, groups[g]);
    copied.forEach((p) => part.addPage(p));
    out.push({ name: `${baseName}-part${g + 1}.pdf`, bytes: await part.save() });
  }
  return out;
}

function range(a: number, b: number) {
  return Array.from({ length: b - a }, (_, i) => a + i);
}

/** Images → a single PDF (one image per page, fit to A4 or native). */
export async function imagesToPdf(
  images: Array<File | string | Uint8Array>,
  opts: { pageSize?: "fit" | "a4"; margin?: number } = {},
): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const A4 = { w: 595.28, h: 841.89 };
  const margin = opts.margin ?? 0;
  for (const input of images) {
    const bytes = await toBytes(input);
    const isPng = bytes[0] === 0x89 && bytes[1] === 0x50;
    const img = isPng ? await doc.embedPng(bytes) : await doc.embedJpg(bytes);
    if (opts.pageSize === "a4") {
      const page = doc.addPage([A4.w, A4.h]);
      const maxW = A4.w - margin * 2, maxH = A4.h - margin * 2;
      const s = Math.min(maxW / img.width, maxH / img.height);
      const w = img.width * s, h = img.height * s;
      page.drawImage(img, { x: (A4.w - w) / 2, y: (A4.h - h) / 2, width: w, height: h });
    } else {
      const page = doc.addPage([img.width, img.height]);
      page.drawImage(img, { x: 0, y: 0, width: img.width, height: img.height });
    }
  }
  return doc.save();
}

/**
 * "Lite" compression done locally: re-saves with object streams enabled,
 * which dedupes/packs the PDF's internal object table. This helps mildly
 * with text-heavy PDFs that have a lot of repeated objects (form fields,
 * annotations, etc).
 *
 * It does NOT touch embedded images — no downsampling, no JPEG
 * recompression — because pdf-lib doesn't expose a way to decode → resample
 * → re-encode an embedded XObject image stream. For an image-heavy PDF this
 * will barely move the file size. "High"/"extreme" compress levels are
 * routed to the backend (Ghostscript / pikepdf / mutool, or a service like
 * iLovePDF's API) where real image recompression is feasible — see
 * PdfEditor.doCompress.
 */
export async function compressLite(bytes: Uint8Array): Promise<Uint8Array> {
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: true });
  return doc.save({ useObjectStreams: true, addDefaultPage: false });
}

/** Trigger a browser download for one or more output files. */
export function downloadBytes(name: string, bytes: Uint8Array, mime = "application/pdf") {
  // Copy into a fresh ArrayBuffer-backed array so Blob is happy across TS targets.
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const blob = new Blob([copy], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export { uid as makeId };