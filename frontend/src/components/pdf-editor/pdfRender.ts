/**
 * pdfRender — thin pdf.js wrapper for rasterising pages to data URLs.
 *
 *   npm i pdfjs-dist
 *
 * pdf-lib does the *editing*; pdf.js does the *rendering* (thumbnails in the
 * organizer and the full-resolution canvas behind the annotation layer).
 * Rendered documents are cached per source so re-renders are cheap.
 */
import type { PDFDocumentProxy } from "pdfjs-dist";

const pdfWorkerPath = new URL(
  "pdfjs-dist/build/pdf.worker.min.mjs",
  import.meta.url,
).toString();
const pdfjsImportPromise = import("pdfjs-dist");

const docCache = new Map<string, Promise<PDFDocumentProxy>>();

function getDoc(sourceId: string, bytes: Uint8Array): Promise<PDFDocumentProxy> {
  let cached = docCache.get(sourceId);
  if (!cached) {
    cached = pdfjsImportPromise.then((pdfjsLib) => {
      pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerPath;
      const copy = bytes.slice();
      return pdfjsLib.getDocument({ data: copy }).promise;
    });
    docCache.set(sourceId, cached);
  }
  return cached;
}

export function evictRenderCache(sourceId?: string) {
  if (sourceId) docCache.delete(sourceId);
  else docCache.clear();
}

export interface RenderOptions {
  maxSize: number;
  rotation?: number;
  mime?: "image/png" | "image/jpeg";
  quality?: number;
}

export async function renderPage(
  sourceId: string,
  bytes: Uint8Array,
  pageIndex: number,
  opts: RenderOptions,
): Promise<{ dataUrl: string; width: number; height: number }> {
  const doc = await getDoc(sourceId, bytes);
  const page = await doc.getPage(pageIndex + 1);
  const base = page.getViewport({ scale: 1, rotation: (opts.rotation ?? 0) });
  const scale = opts.maxSize / Math.max(base.width, base.height);
  const viewport = page.getViewport({ scale, rotation: opts.rotation ?? 0 });

  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("2d context unavailable");
  await page.render({ canvasContext: ctx, viewport, canvas } as never).promise;

  return {
    dataUrl: canvas.toDataURL(opts.mime ?? "image/png", opts.quality ?? 0.92),
    width: viewport.width,
    height: viewport.height,
  };
}

/* ------------------------------------------------------------------ */
/*  existing-text detection                                           */
/* ------------------------------------------------------------------ */

export interface ExistingTextRun {
  str: string;
  x: number;
  y: number;
  width: number;
  height: number;
  fontSize: number;
}

export async function getPageTextRuns(
  sourceId: string,
  bytes: Uint8Array,
  pageIndex: number,
  rotation: number,
): Promise<ExistingTextRun[]> {
  if (((rotation % 360) + 360) % 360 !== 0) return [];
  const doc = await getDoc(sourceId, bytes);
  const page = await doc.getPage(pageIndex + 1);
  const viewport = page.getViewport({ scale: 1, rotation: 0 });
  const { width: W, height: H } = viewport;
  const content = await page.getTextContent();

  const out: ExistingTextRun[] = [];
  for (const item of content.items as Array<{
    str?: string; transform?: number[]; width?: number; height?: number;
  }>) {
    if (!item.str || !item.str.trim() || !item.transform) continue;
    const [a, b, c] = item.transform;
    if (Math.abs(b) > 0.01 || Math.abs(c) > 0.01) continue;

    const fontSize = Math.abs(item.transform[3]) || Math.abs(a) || 10;
    const width = item.width ?? item.str.length * fontSize * 0.5;
    const height = item.height ?? fontSize * 1.15;
    const baselineX = item.transform[4];
    const baselineY = item.transform[5];

    out.push({
      str: item.str,
      x: baselineX / W,
      y: 1 - (baselineY + height * 0.82) / H,
      width: width / W,
      height: (height * 1.05) / H,
      fontSize: fontSize / H,
    });
  }
  return out;
}

/* ------------------------------------------------------------------ */
/*  page-color sampling                                                */
/* ------------------------------------------------------------------ */

/**
 * Sample a single pixel from an already-rendered page bitmap (data URL),
 * returning a hex color. Used by the "click existing text to edit" flow so
 * the cover-and-retype mask matches the underlying paper color rather than
 * always being pure white.
 *
 * Sampling is best-effort; if the image isn't loaded yet, or the pixel sits
 * on a glyph, we fall back to white. The image lives in the same origin
 * (it's a data URL), so canvas-tainting isn't a concern.
 */
const sampleCache = new Map<string, HTMLImageElement>();
export function samplePageColor(dataUrl: string, fx: number, fy: number): string {
  try {
    let img = sampleCache.get(dataUrl);
    if (!img) {
      img = new Image();
      img.src = dataUrl;
      sampleCache.set(dataUrl, img);
    }
    if (!img.complete || !img.naturalWidth) return "#ffffff";
    const c = document.createElement("canvas");
    c.width = img.naturalWidth; c.height = img.naturalHeight;
    const ctx = c.getContext("2d");
    if (!ctx) return "#ffffff";
    ctx.drawImage(img, 0, 0);
    const x = Math.floor(fx * c.width);
    const y = Math.floor(fy * c.height);
    // Average a small 3×3 neighborhood so a single glyph pixel doesn't bias.
    let r = 0, g = 0, b = 0, n = 0;
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const px = Math.min(c.width - 1, Math.max(0, x + dx));
        const py = Math.min(c.height - 1, Math.max(0, y + dy));
        const d = ctx.getImageData(px, py, 1, 1).data;
        r += d[0]; g += d[1]; b += d[2]; n++;
      }
    }
    const hex = (v: number) => Math.round(v / n).toString(16).padStart(2, "0");
    return `#${hex(r)}${hex(g)}${hex(b)}`;
  } catch {
    return "#ffffff";
  }
}

/** Render every page of a document to data URLs (used by PDF→image export). */
export async function rasterizeAll(
  sourceId: string,
  bytes: Uint8Array,
  opts: RenderOptions,
): Promise<string[]> {
  const doc = await getDoc(sourceId, bytes);
  const out: string[] = [];
  for (let i = 0; i < doc.numPages; i++) {
    const { dataUrl } = await renderPage(sourceId, bytes, i, opts);
    out.push(dataUrl);
  }
  return out;
}