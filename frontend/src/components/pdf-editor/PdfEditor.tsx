/**
 * PdfEditor — a comprehensive, Sejda-style PDF editor.
 *
 * UX improvements & bug fixes in this revision:
 *  • EditToolbar color picker: uses a popover-style swatch that clearly closes
 *    after a color is picked (no more dangling open picker).
 *  • Text tool: annotation starts at a tiny seed size; the textarea auto-expands
 *    as the user types so it never feels like a "big empty box".
 *  • Selecting an existing text annotation now reliably shows the full formatting
 *    toolbar (font, size, B/I/U, align, color, fill). The select tool recognizes
 *    typed text annotations just like it already recognized PDF text runs.
 *  • Font family + size changes propagate immediately to the focused textarea via
 *    the per-annotation floating toolbar — the text re-renders live.
 *  • EditToolbar exposes a font-size control even before the user creates a text
 *    box so the default can be set upfront.
 *  • Shapes popover closes cleanly when a shape is picked.
 *  • Hint copy updated to be clearer per-tool.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Files, Combine, Scissors, FilePlus2, MousePointer2, Type as TypeIcon,
  Image as ImageIcon, PenLine, Highlighter, Square, Circle, Minus,
  ArrowUpRight, Pencil, Eraser, EyeOff, Link2, Stamp, Hash, PanelTop,
  FileText, Settings2, Shrink, RefreshCw, Lock, Unlock, Undo2, Redo2,
  ZoomIn, ZoomOut, Download, Save, ChevronLeft, ChevronRight, Loader2, X,
  Shapes as ShapesIcon, ChevronDown, Crop, Check,
} from "lucide-react";
import clsx from "clsx";
import type {
  Annotation, BatesConfig, CompressLevel, ConvertConfig, EditorJob,
  EditorPage, HeaderFooterConfig, MetadataConfig, PageNumberConfig,
  PdfEditorProps, SourceDocument, SplitConfig, TextAnnotation, ToolId,
  WatermarkConfig,
} from "./types";
import {
  compressLite, downloadBytes, exportDocument, imagesToPdf,
  loadSource, makeId, pagesForSource, splitDocument, toBytes,
} from "./pdfEngine";
import { evictRenderCache, rasterizeAll } from "./pdfRender";
import PageOrganizer from "./components/PageOrganizer";
import AnnotationCanvas, { type EditTool } from "./components/AnnotationCanvas";
import CropView from "./components/CropView";
import SidePanel from "./components/SidePanel";
import SignaturePad from "../profile/SignaturePad";

/* ---------- tool registry ---------- */
interface RailItem { id: ToolId; label: string; icon: typeof Files }
const RAIL: Array<{ group: string; items: RailItem[] }> = [
  { group: "Organize", items: [
    { id: "pages", label: "Pages", icon: Files },
    { id: "merge", label: "Merge", icon: Combine },
    { id: "split", label: "Split", icon: Scissors },
    { id: "insert", label: "Insert", icon: FilePlus2 },
    { id: "crop", label: "Crop", icon: Crop },
  ]},
  { group: "Edit", items: [
    { id: "edit", label: "Select", icon: MousePointer2 },
    { id: "text", label: "Text", icon: TypeIcon },
    { id: "image", label: "Image", icon: ImageIcon },
    { id: "sign", label: "Sign", icon: PenLine },
    { id: "highlight", label: "Highlight", icon: Highlighter },
    { id: "shape", label: "Shapes", icon: ShapesIcon },
    { id: "draw", label: "Draw", icon: Pencil },
    { id: "whiteout", label: "Whiteout", icon: Eraser },
    { id: "redact", label: "Redact", icon: EyeOff },
    { id: "link", label: "Link", icon: Link2 },
  ]},
  { group: "Enrich", items: [
    { id: "watermark", label: "Watermark", icon: Stamp },
    { id: "page_numbers", label: "Numbers", icon: Hash },
    { id: "header_footer", label: "Header", icon: PanelTop },
    { id: "bates", label: "Bates", icon: Hash },
    { id: "metadata", label: "Properties", icon: Settings2 },
  ]},
  { group: "Optimize", items: [
    { id: "compress", label: "Compress", icon: Shrink },
    { id: "convert", label: "Convert", icon: RefreshCw },
    { id: "protect", label: "Protect", icon: Lock },
    { id: "unlock", label: "Unlock", icon: Unlock },
  ]},
];

const RAIL_TIPS: Partial<Record<ToolId, string>> = {
  pages: "Organize pages — reorder, rotate, duplicate, delete, or extract",
  merge: "Merge — append other PDFs after this document",
  split: "Split — break this document into multiple files",
  insert: "Insert — add pages from another PDF or images",
  crop: "Crop — trim the current page's margins",
  edit: "Select — click any object to move, resize, or format it. Click existing PDF text to edit it inline.",
  text: "Text — click the page to place a text box, then start typing",
  image: "Image — pick an image then click the page to place it",
  sign: "Sign — draw or type a signature, then click to place it",
  highlight: "Highlight — drag over an area to highlight",
  shape: "Shapes — rectangle, ellipse, line or arrow",
  draw: "Draw — freehand pen; keep drawing strokes",
  whiteout: "Whiteout — drag a white box to cover content",
  redact: "Redact — drag a black box over content to redact it",
  link: "Link — drag a box, then set a clickable URL",
  watermark: "Watermark — stamp text across every page",
  page_numbers: "Page numbers — add page numbering",
  header_footer: "Header & footer — add running text top and bottom",
  bates: "Bates numbering — sequential legal numbering",
  metadata: "Document properties — title, author, subject…",
  compress: "Compress — reduce file size",
  convert: "Convert — PDF ↔ images and more",
  protect: "Protect — add a password",
  unlock: "Unlock — remove a password",
};

const ORGANIZE_VIEW: ToolId[] = ["pages", "merge", "split", "insert"];
const SIDE_PANEL: ToolId[] = [
  "merge", "split", "insert", "watermark", "page_numbers", "header_footer",
  "bates", "metadata", "compress", "convert", "protect", "unlock",
];
const EDIT_TOOL_MAP: Partial<Record<ToolId, EditTool>> = {
  edit: "select", text: "text", image: "image", sign: "signature",
  highlight: "highlight", shape: "rect", draw: "ink", whiteout: "whiteout",
  redact: "redact", link: "link",
};
const SHAPE_TOOLS: EditTool[] = ["rect", "ellipse", "line", "arrow"];
const SHAPE_PICKER: Array<{ id: EditTool; label: string; icon: typeof Square }> = [
  { id: "rect", label: "Rectangle", icon: Square },
  { id: "ellipse", label: "Ellipse", icon: Circle },
  { id: "line", label: "Line", icon: Minus },
  { id: "arrow", label: "Arrow", icon: ArrowUpRight },
];

interface Snapshot { pages: EditorPage[]; annotations: Annotation[] }

function formatBytes(n: number): string {
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${n} B`;
}

const MIME_BY_EXT: Record<string, string> = {
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  txt: "text/plain",
  pdf: "application/pdf",
};

export default function PdfEditor({
  initialFiles, signerName = "", savedSignatures = [], onJob, onSave, disabledTools = [], className,
}: PdfEditorProps) {
  const [sources, setSources] = useState<SourceDocument[]>([]);
  const [pages, setPages] = useState<EditorPage[]>([]);
  const [annotations, setAnnotations] = useState<Annotation[]>([]);
  const [tool, setTool] = useState<ToolId>("pages");
  const [shapeTool, setShapeTool] = useState<EditTool>("rect");
  const [shapesOpen, setShapesOpen] = useState(false);
  const [selectedPages, setSelectedPages] = useState<Set<string>>(new Set());
  const [selectedAnn, setSelectedAnn] = useState<string | null>(null);
  const [pageIdx, setPageIdx] = useState(0);
  const [zoom, setZoom] = useState(1);
  const [color, setColor] = useState("#287EAD");
  const [strokeWidth, setStrokeWidth] = useState(2);
  const [fontFamily, setFontFamily] = useState("Helvetica");
  // fontSize stored as page fraction (same unit as TextAnnotation.fontSize)
  const [fontSize, setFontSize] = useState(0.022);
  const [imageSrc, setImageSrc] = useState<string | null>(null);
  const [showSignPad, setShowSignPad] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  // Transient success message (e.g. compression result), shown as a toast.
  const [flash, setFlash] = useState<string | null>(null);
  useEffect(() => {
    if (!flash) return;
    const t = window.setTimeout(() => setFlash(null), 5000);
    return () => window.clearTimeout(t);
  }, [flash]);

  // A converted output awaiting the user's choice to Download a copy or Save it
  // onward — the editor stays open until they pick. Holds one or more files
  // (multi-page image exports produce several); only single-file results can be
  // "used" as the upload.
  const [pendingExport, setPendingExport] = useState<{
    files: Array<{ name: string; bytes: Uint8Array; mime: string }>;
    label: string;
    canUseInUpload: boolean;
  } | null>(null);
  // Editing the document invalidates a pending conversion (it would be stale).
  useEffect(() => { setPendingExport(null); }, [pages, annotations, sources]);
  const [past, setPast] = useState<Snapshot[]>([]);
  const [future, setFuture] = useState<Snapshot[]>([]);
  // Guards the one-time initial load against React 18 StrictMode's double effect
  // invocation, which would otherwise load every initial file twice (duplicates).
  const loadedRef = useRef(false);

  useEffect(() => {
    if (loadedRef.current || !initialFiles?.length) return;
    loadedRef.current = true;
    (async () => {
      setBusy("Loading…");
      for (let i = 0; i < initialFiles.length; i++) {
        await addFile(initialFiles[i], `Document ${i + 1}.pdf`);
      }
      setBusy(null);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const visiblePages = useMemo(() => pages.filter((p) => !p.deleted), [pages]);
  const redactCount = useMemo(() => annotations.filter((a) => a.kind === "redact").length, [annotations]);
  const activePage = visiblePages[Math.min(pageIdx, visiblePages.length - 1)];
  const activeSource = activePage && sources.find((s) => s.id === activePage.sourceId);
  const isOrganize = ORGANIZE_VIEW.includes(tool);
  const showSide = SIDE_PANEL.includes(tool) && !disabledTools.includes(tool);
  const editTool: EditTool = tool === "shape" ? shapeTool : (EDIT_TOOL_MAP[tool] ?? "select");

  const snapshot = useCallback((): Snapshot => ({ pages, annotations }), [pages, annotations]);
  const commit = useCallback((next: Partial<Snapshot>) => {
    setPast((p) => [...p.slice(-49), snapshot()]);
    setFuture([]);
    if (next.pages) setPages(next.pages);
    if (next.annotations) setAnnotations(next.annotations);
  }, [snapshot]);

  const undo = () => {
    setPast((p) => {
      if (!p.length) return p;
      const prev = p[p.length - 1];
      setFuture((f) => [snapshot(), ...f]);
      setPages(prev.pages); setAnnotations(prev.annotations);
      return p.slice(0, -1);
    });
  };
  const redo = () => {
    setFuture((f) => {
      if (!f.length) return f;
      const next = f[0];
      setPast((p) => [...p, snapshot()]);
      setPages(next.pages); setAnnotations(next.annotations);
      return f.slice(1);
    });
  };

  async function addFile(input: File | string | Uint8Array, name: string) {
    const src = await loadSource(input, name);
    const newPages = await pagesForSource(src);
    setSources((s) => [...s, src]);
    setPages((p) => [...p, ...newPages]);
  }

  const mergeFiles = async (files: File[]) => {
    setBusy("Merging…");
    setPast((p) => [...p, snapshot()]); setFuture([]);
    for (const f of files) await addFile(f, f.name);
    setBusy(null); setTool("pages");
  };

  const insertFiles = async (files: File[]) => {
    setBusy("Inserting…");
    const added: EditorPage[] = [];
    for (const f of files) {
      const isImage = f.type.startsWith("image/");
      const bytes = isImage ? await imagesToPdf([f], { pageSize: "fit" }) : await toBytes(f);
      const src = await loadSource(bytes, f.name);
      setSources((s) => [...s, src]);
      added.push(...(await pagesForSource(src)));
    }
    const at = pages.findIndex((p) => p.id === activePage?.id);
    const next = [...pages];
    next.splice(at < 0 ? pages.length : at + 1, 0, ...added);
    commit({ pages: next });
    setBusy(null); setTool("pages");
  };

  const reorder = (orderedIds: string[]) => {
    const map = new Map(pages.map((p) => [p.id, p]));
    commit({ pages: orderedIds.map((id) => map.get(id)!).filter(Boolean) });
  };
  const rotatePages = (ids: string[], delta: number) =>
    commit({ pages: pages.map((p) => ids.includes(p.id) ? { ...p, rotation: (((p.rotation + delta) % 360) + 360) % 360 } : p) });
  const setPageCrop = (id: string, crop: EditorPage["crop"]) =>
    commit({ pages: pages.map((p) => p.id === id ? { ...p, crop } : p) });
  const deletePages = (ids: string[]) =>
    commit({ pages: pages.map((p) => ids.includes(p.id) ? { ...p, deleted: true } : p) });
  const restorePages = (ids: string[]) =>
    commit({ pages: pages.map((p) => ids.includes(p.id) ? { ...p, deleted: false } : p) });
  const duplicatePages = (ids: string[]) => {
    const next: EditorPage[] = [];
    for (const p of pages) {
      next.push(p);
      if (ids.includes(p.id)) next.push({ ...p, id: makeId() });
    }
    commit({ pages: next });
  };
  const extractPages = async (ids: string[]) => {
    setBusy("Extracting…");
    const subset = pages.filter((p) => ids.includes(p.id) && !p.deleted);
    const bytes = await exportDocument(sources, subset, annotations);
    downloadBytes("extracted.pdf", bytes);
    setBusy(null);
  };
  // Open a page from the organizer straight into the edit canvas.
  const openPageForEdit = (pageId: string) => {
    const idx = visiblePages.findIndex((p) => p.id === pageId);
    if (idx >= 0) setPageIdx(idx);
    setTool("edit");
  };

  const createAnn = (a: Annotation) => commit({ annotations: [...annotations, a] });
  const createMany = (arr: Annotation[]) => commit({ annotations: [...annotations, ...arr] });
  const changeAnn = (a: Annotation) => setAnnotations((list) => list.map((x) => x.id === a.id ? a : x));
  const deleteAnn = (id: string) => commit({ annotations: annotations.filter((x) => x.id !== id) });

  // Prune abandoned-empty text box when selection truly moves elsewhere.
  const selectAnn = useCallback((id: string | null) => {
    setAnnotations((list) => {
      if (!selectedAnn || selectedAnn === id) return list;
      const active = document.activeElement as HTMLElement | null;
      if (active && (active.tagName === "INPUT" || active.tagName === "TEXTAREA" || active.tagName === "SELECT")) {
        return list;
      }
      const prev = list.find((a) => a.id === selectedAnn);
      if (prev && prev.kind === "text"
        && !(prev as TextAnnotation).text.trim()
        && !(prev as TextAnnotation).background) {
        return list.filter((a) => a.id !== selectedAnn);
      }
      return list;
    });
    setSelectedAnn(id);
  }, [selectedAnn]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      const typing = !!t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable);
      const mod = e.metaKey || e.ctrlKey;
      if (mod && (e.key === "z" || e.key === "Z")) { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
      if (mod && (e.key === "y" || e.key === "Y")) { e.preventDefault(); redo(); return; }
      if (typing) return;
      if ((e.key === "Delete" || e.key === "Backspace") && selectedAnn) {
        e.preventDefault(); deleteAnn(selectedAnn); setSelectedAnn(null); return;
      }
      if (e.key === "Escape") setSelectedAnn(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selectedAnn, undo, redo, deleteAnn]);

  const currentBytes = useCallback(
    () => exportDocument(sources, pages, annotations),
    [sources, pages, annotations],
  );

  const runJob = async (job: Omit<EditorJob, "bytes" | "filename">, fallbackName: string) => {
    if (!onJob) { alert("This operation needs a backend. Provide an `onJob` handler."); return; }
    setBusy("Processing on server…");
    try {
      const bytes = await currentBytes();
      const result = await onJob({ ...job, bytes, filename: fallbackName });
      if (result) downloadBytes(fallbackName, result);
    } finally { setBusy(null); }
  };

  // Save path: hand the document to the host (DMS) when onSave is wired,
  // otherwise fall back to a local download. Used by Save + the enrich tools.
  const doExport = async (extra: Parameters<typeof exportDocument>[3] = {}, name = "edited.pdf") => {
    setBusy(onSave ? "Saving…" : "Exporting…");
    try {
      const bytes = await exportDocument(sources, pages, annotations, extra);
      if (onSave) await onSave({ blobs: [{ name, bytes, mime: "application/pdf" }] });
      else downloadBytes(name, bytes);
    } finally { setBusy(null); }
  };

  // Always writes a file to the user's computer, regardless of onSave.
  const doDownload = async (extra: Parameters<typeof exportDocument>[3] = {}, name = "edited.pdf") => {
    setBusy("Preparing download…");
    try {
      downloadBytes(name, await exportDocument(sources, pages, annotations, extra));
    } finally { setBusy(null); }
  };

  const applyWatermark = (c: WatermarkConfig) => applyEnrich({ watermark: c }, "watermarked.pdf", "Watermark");
  const applyNumbers = (c: PageNumberConfig) => applyEnrich({ pageNumbers: c }, "numbered.pdf", "Page numbers");
  const applyHF = (c: HeaderFooterConfig) => applyEnrich({ headerFooter: c }, "header-footer.pdf", "Header & footer");
  const applyBates = (c: BatesConfig) => applyEnrich({ bates: c }, "bates.pdf", "Bates numbering");
  const applyMeta = (c: MetadataConfig) => applyEnrich({ metadata: c }, "properties.pdf", "Document properties");

  const doSplit = async (c: SplitConfig) => {
    setBusy("Splitting…");
    try {
      const bytes = await currentBytes();
      const parts = await splitDocument(bytes, c);
      parts.forEach((p, i) => setTimeout(() => downloadBytes(p.name, p.bytes), i * 250));
    } finally { setBusy(null); }
  };

  // Replace the whole working document with new bytes (flattening current pages
  // + annotations into a single fresh source). Used by Compress so the result
  // stays in the editor for the user to keep working / save back — not downloaded.
  const replaceWorkingDoc = async (bytes: Uint8Array, name: string) => {
    const src = await loadSource(bytes, name);
    const newPages = await pagesForSource(src);
    setPast((p) => [...p.slice(-49), snapshot()]);
    setFuture([]);
    setSources([src]);
    setPages(newPages);
    setAnnotations([]);
    setSelectedAnn(null);
    setPageIdx(0);
  };

  // Enrich tools (watermark / page numbers / header-footer / Bates / properties)
  // bake their result into the working document and keep the editor open — the
  // same flow as Compress — so the user can stack edits and then choose Download
  // or Save, instead of the old apply-and-immediately-export behaviour.
  const applyEnrich = async (
    extra: Parameters<typeof exportDocument>[3],
    name: string,
    label: string,
  ) => {
    setBusy("Applying…");
    try {
      const bytes = await exportDocument(sources, pages, annotations, extra);
      await replaceWorkingDoc(bytes, name);
      setFlash(`${label} applied. Download or Save to keep it.`);
    } finally {
      setBusy(null);
    }
  };

  // True redaction: cosmetic redact boxes only *cover* content (recoverable). This
  // sends the document plus the redaction rectangles to the backend, which rewrites
  // the page content streams to permanently delete what's underneath, then bakes the
  // clean result back into the working doc.
  const doRedact = async () => {
    const redactions = annotations.filter((a) => a.kind === "redact");
    if (!redactions.length) return;
    if (!onJob) { setFlash("Permanent redaction needs a backend."); return; }
    const order = new Map(pages.filter((p) => !p.deleted).map((p, i) => [p.id, i]));
    const rects = redactions
      .map((a) => {
        const page = order.get(a.pageId);
        return page === undefined ? null : { page, x: a.x, y: a.y, w: a.width, h: a.height };
      })
      .filter((r): r is { page: number; x: number; y: number; w: number; h: number } => r !== null);
    if (!rects.length) return;

    setBusy("Redacting…");
    try {
      const bytes = await currentBytes();
      const result = await onJob({
        type: "redact",
        params: { rects: JSON.stringify(rects) },
        bytes,
        filename: "redacted.pdf",
      });
      if (!result) return; // host surfaces the error
      await replaceWorkingDoc(result, "redacted.pdf");
      setFlash(`${rects.length} area${rects.length > 1 ? "s" : ""} permanently redacted. Download or Save to keep it.`);
    } finally {
      setBusy(null);
    }
  };

  const doCompress = async (level: CompressLevel) => {
    setBusy("Compressing…");
    try {
      // Baseline = the faithful current document. For an unedited single source,
      // use its ORIGINAL bytes: pdf-lib re-assembly inflates small/optimised PDFs,
      // which would make compression look like it grew the file.
      const visible = pages.filter((p) => !p.deleted);
      const pristine =
        sources.length === 1 &&
        annotations.length === 0 &&
        visible.length === sources[0].pageCount &&
        visible.every((p, i) =>
          p.sourceId === sources[0].id && p.sourceIndex === i && (p.rotation % 360) === 0 && !p.crop);
      const before = pristine ? sources[0].bytes : await currentBytes();

      let after: Uint8Array | null;
      if (level === "low" || level === "medium") {
        after = await compressLite(before);
      } else if (onJob) {
        after = await onJob({ type: "compress", params: { level }, bytes: before, filename: "compressed.pdf" });
      } else {
        setFlash("Deep compression needs a backend.");
        return;
      }
      if (!after) return; // server-side failures are surfaced by the host's onJob

      if (after.length < before.length) {
        await replaceWorkingDoc(after, "compressed.pdf");
        const pct = Math.round((1 - after.length / before.length) * 100);
        setFlash(`Compressed from ${formatBytes(before.length)} to ${formatBytes(after.length)} — ${pct}% smaller. Save to keep it.`);
      } else {
        // No real gain — leave the document untouched rather than inflate it.
        setFlash(`Already optimised — ${formatBytes(before.length)}. It can't be compressed further.`);
      }
    } finally {
      setBusy(null);
    }
  };

  // Every conversion produces a "pending export" (one or more files) so the user
  // chooses Download (a copy) or Save (proceed with it) — consistent across all
  // targets. Multi-file results (page images) can be downloaded but not used as
  // a single upload.
  const doConvert = async (c: ConvertConfig) => {
    if (c.target === "pdf-to-jpg" || c.target === "pdf-to-png") {
      setBusy("Rendering pages…");
      try {
        const bytes = await currentBytes();
        const tmp = await loadSource(bytes, "out.pdf");
        const size = Math.round((c.dpi ?? 150) / 72 * 1000);
        const png = c.target === "pdf-to-png";
        const mime = png ? "image/png" : "image/jpeg";
        const imgs = await rasterizeAll(tmp.id, bytes, { maxSize: size, mime });
        const files = await Promise.all(imgs.map(async (url, i) => ({
          name: `page-${i + 1}.${png ? "png" : "jpg"}`,
          bytes: await toBytes(url),
          mime,
        })));
        if (!files.length) return;
        setPendingExport({ files, label: png ? "PNG images" : "JPG images", canUseInUpload: files.length === 1 });
        setTool("edit");
      } finally { setBusy(null); }
    } else if (c.target === "jpg-to-pdf") {
      const input = document.createElement("input");
      input.type = "file"; input.accept = "image/*"; input.multiple = true;
      input.onchange = async () => {
        if (!input.files?.length) return;
        setBusy("Building PDF…");
        try {
          const bytes = await imagesToPdf([...input.files], { pageSize: "a4", margin: 24 });
          setPendingExport({ files: [{ name: "images.pdf", bytes, mime: "application/pdf" }], label: "PDF", canUseInUpload: true });
          setTool("edit");
        } finally { setBusy(null); }
      };
      input.click();
    } else {
      // PDF → Word/Excel/PowerPoint/Text on the backend.
      if (!onJob) { setFlash("Conversion needs a backend."); return; }
      const ext = c.target.includes("docx") ? "docx" : c.target.includes("xlsx") ? "xlsx"
        : c.target.includes("pptx") ? "pptx" : c.target.includes("text") ? "txt" : "pdf";
      const name = `converted.${ext}`;
      setBusy("Converting on server…");
      try {
        const result = await onJob({ type: "convert", params: { target: c.target, dpi: c.dpi }, bytes: await currentBytes(), filename: name });
        if (!result) return; // host surfaced any error
        setPendingExport({
          files: [{ name, bytes: result, mime: MIME_BY_EXT[ext] ?? "application/octet-stream" }],
          label: ext.toUpperCase(),
          canUseInUpload: true,
        });
        setTool("edit"); // close the convert panel so the banner + page are visible
      } finally { setBusy(null); }
    }
  };

  const doProtect = (password: string, permissions: string[]) =>
    runJob({ type: "protect", params: { password, permissions } }, "protected.pdf");
  const doUnlock = (password: string) =>
    runJob({ type: "unlock", params: { password } }, "unlocked.pdf");

  const pickTool = (id: ToolId) => {
    setSelectedAnn(null);
    if (id === "image") {
      const input = document.createElement("input");
      input.type = "file"; input.accept = "image/*";
      input.onchange = () => {
        const f = input.files?.[0]; if (!f) return;
        const reader = new FileReader();
        reader.onload = () => { setImageSrc(reader.result as string); setTool("image"); };
        reader.readAsDataURL(f);
      };
      input.click();
      return;
    }
    if (id === "sign") { setShowSignPad(true); return; }
    if (id === "shape") { setShapesOpen((v) => !v); setTool("shape"); return; }
    setShapesOpen(false);
    setTool(id);
  };

  useEffect(() => () => evictRenderCache(), []);

  const hasDoc = sources.length > 0;

  // Derive the display font size (points) from the fraction stored in state
  // so EditToolbar can show a human-friendly number
  const activePage_ = activePage;
  const displayFontPt = Math.max(1, Math.round(fontSize * (activePage_?.height || 792)));

  return (
    <div className={clsx("flex h-full min-h-[640px] flex-col bg-white text-[#2A3138]", className)}>
      {/* ---- header ---- */}
      <header className="flex items-center gap-2 border-b border-[#C8CDD2] bg-[#FAFBFC] px-3 py-2">
        <span className="mr-2 flex items-center gap-2 font-semibold text-[#287EAD]">
          <FileText className="h-5 w-5" /> PDF Editor
        </span>
        <IconBtn icon={Undo2} label="Undo (⌘Z)" disabled={!past.length} onClick={undo} />
        <IconBtn icon={Redo2} label="Redo (⌘⇧Z)" disabled={!future.length} onClick={redo} />
        <div className="mx-1 h-5 w-px bg-[#C8CDD2]" />
        <IconBtn icon={ZoomOut} label="Zoom out" onClick={() => setZoom((z) => Math.max(0.4, +(z - 0.15).toFixed(2)))} />
        <button
          className="w-14 rounded-md border border-[#C8CDD2] px-1 py-1 text-center text-xs text-[#5E6870] hover:bg-[#F1F5F8]"
          title="Reset zoom"
          onClick={() => setZoom(1)}
        >
          {Math.round(zoom * 100)}%
        </button>
        <IconBtn icon={ZoomIn} label="Zoom in" onClick={() => setZoom((z) => Math.min(3, +(z + 0.15).toFixed(2)))} />
        <div className="flex-1" />
        {!isOrganize && visiblePages.length > 0 && (
          <div className="flex items-center gap-1 text-sm text-[#5E6870]">
            <IconBtn icon={ChevronLeft} label="Previous page" disabled={pageIdx <= 0} onClick={() => setPageIdx((i) => i - 1)} />
            <span className="w-20 text-center text-xs">
              Page {Math.min(pageIdx + 1, visiblePages.length)} / {visiblePages.length}
            </span>
            <IconBtn icon={ChevronRight} label="Next page" disabled={pageIdx >= visiblePages.length - 1} onClick={() => setPageIdx((i) => i + 1)} />
          </div>
        )}
        <button
          onClick={() => {
            if (pendingExport) {
              pendingExport.files.forEach((f, i) =>
                setTimeout(() => downloadBytes(f.name, f.bytes, f.mime), i * 150));
            } else {
              doDownload({}, "edited.pdf");
            }
          }}
          disabled={!hasDoc}
          title={pendingExport ? "Download the converted file(s) to this computer" : "Download a copy to this computer"}
          className="ml-2 inline-flex items-center gap-1.5 rounded-md border border-[#C8CDD2] px-3 py-1.5 text-sm text-[#5E6870] hover:bg-[#F1F5F8] disabled:opacity-40"
        >
          <Download className="h-4 w-4" /> Download
        </button>
        {onSave && (
          <button
            onClick={async () => {
              if (pendingExport) {
                if (!pendingExport.canUseInUpload) return;
                await onSave({ blobs: [pendingExport.files[0]] });
                setPendingExport(null);
              } else {
                doExport({}, "edited.pdf");
              }
            }}
            disabled={!hasDoc || (!!pendingExport && !pendingExport.canUseInUpload)}
            title={
              pendingExport
                ? (pendingExport.canUseInUpload
                    ? "Use the converted file and continue to upload"
                    : "Multiple files — download them instead")
                : "Save back to the document library"
            }
            className="inline-flex items-center gap-1.5 rounded-md bg-[#287EAD] px-3 py-1.5 text-sm font-medium text-white hover:bg-[#216C95] disabled:opacity-40"
          >
            <Save className="h-4 w-4" /> {pendingExport ? "Use & continue" : "Save"}
          </button>
        )}
      </header>

      {/* Pending-conversion banner: choose Download (copy) or Save (proceed). */}
      {pendingExport && (
        <div className="flex flex-wrap items-center gap-2 border-b border-[#F2D98E] bg-[#FFF8E6] px-4 py-2 text-sm text-[#7A5B12]">
          <FileText className="h-4 w-4 shrink-0 text-[#B7791F]" />
          <span>
            Converted to <strong>{pendingExport.label}</strong> —{" "}
            {pendingExport.files.length === 1
              ? <span className="font-mono">{pendingExport.files[0].name}</span>
              : <>{pendingExport.files.length} files</>}.{" "}
            Use <strong>Download</strong> for {pendingExport.files.length === 1 ? "a copy" : "the files"}
            {onSave && pendingExport.canUseInUpload && <> or <strong>Use &amp; continue</strong> to proceed with it</>}.
          </span>
          <button
            onClick={() => setPendingExport(null)}
            className="ml-auto font-medium text-[#7A5B12] underline-offset-2 hover:underline"
          >
            Discard &amp; keep editing
          </button>
        </div>
      )}

      {/* Redaction is only cosmetic until burned in on the server — nudge the user. */}
      {redactCount > 0 && (
        <div className="flex flex-wrap items-center gap-2 border-b border-[#F0B4B4] bg-[#FDECEC] px-4 py-2 text-sm text-[#9B2C2C]">
          <EyeOff className="h-4 w-4 shrink-0 text-[#C53030]" />
          <span>
            {redactCount} redaction box{redactCount > 1 ? "es" : ""} placed. These only
            <strong> cover </strong> content — the text underneath is still in the file until you apply them.
          </span>
          <button
            onClick={doRedact}
            disabled={!onJob}
            title={onJob ? "Permanently remove the content under each box" : "Needs a backend connection"}
            className="ml-auto inline-flex items-center gap-1.5 rounded-md bg-[#C53030] px-3 py-1.5 text-xs font-medium text-white hover:bg-[#9B2C2C] disabled:opacity-40"
          >
            <EyeOff className="h-3.5 w-3.5" /> Apply redactions
          </button>
        </div>
      )}

      <div className="flex min-h-0 flex-1">
        {/* ---- left rail (scrolls so every group stays reachable) ---- */}
        <nav className="w-[88px] shrink-0 overflow-y-auto overflow-x-hidden border-r border-[#C8CDD2] bg-[#FAFBFC] py-2">
          {RAIL.map((grp) => (
            <div key={grp.group} className="mb-2">
              <div className="px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-[#9AA4AD]">
                {grp.group}
              </div>
              {grp.items.filter((it) => !disabledTools.includes(it.id)).map((it) => {
                const active = tool === it.id || (it.id === "shape" && SHAPE_TOOLS.includes(editTool));
                const isShapes = it.id === "shape";
                return (
                  <div key={it.id} className="relative">
                    <button
                      onClick={() => pickTool(it.id)}
                      title={RAIL_TIPS[it.id] ?? it.label}
                      className={clsx(
                        "flex w-full flex-col items-center gap-1 rounded-md px-1 py-2 text-[11px] transition",
                        active ? "bg-[#EEF6FB] text-[#287EAD]" : "text-[#5E6870] hover:bg-[#F1F5F8]",
                      )}
                    >
                      <it.icon className="h-5 w-5" />
                      <span className="inline-flex items-center gap-0.5">
                        {it.label}
                        {isShapes && <ChevronDown className="h-3 w-3" />}
                      </span>
                    </button>
                    {/* Compact inline shape picker — stays within the rail width
                        so the rail can scroll without clipping a side flyout. */}
                    {isShapes && shapesOpen && tool === "shape" && (
                      <div className="mt-0.5 space-y-0.5 rounded-md bg-[#F1F5F8] p-1">
                        {SHAPE_PICKER.map((s) => (
                          <button
                            key={s.id}
                            onClick={() => { setShapeTool(s.id); setShapesOpen(false); }}
                            title={s.label}
                            className={clsx(
                              "flex w-full flex-col items-center gap-0.5 rounded px-1 py-1 text-[10px]",
                              shapeTool === s.id
                                ? "bg-white text-[#287EAD] shadow-sm"
                                : "text-[#5E6870] hover:bg-white",
                            )}
                          >
                            <s.icon className="h-4 w-4" /> {s.label}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          ))}
        </nav>

        {/* ---- main canvas area ---- */}
        <main className="flex min-w-0 flex-1 flex-col">
          {!isOrganize && tool !== "crop" && hasDoc && (
            <EditToolbar
              tool={tool}
              shapeTool={shapeTool}
              setShapeTool={setShapeTool}
              color={color}
              setColor={setColor}
              strokeWidth={strokeWidth}
              setStrokeWidth={setStrokeWidth}
              fontFamily={fontFamily}
              setFontFamily={setFontFamily}
              fontSizePt={displayFontPt}
              setFontSizePt={(pt) => setFontSize(pt / (activePage_?.height || 792))}
            />
          )}

          {!hasDoc ? (
            <EmptyState onOpen={(f) => mergeFiles(f)} />
          ) : isOrganize ? (
            <PageOrganizer
              pages={pages} sources={sources}
              selected={selectedPages} onSelect={setSelectedPages}
              onReorder={reorder} onRotate={rotatePages}
              onDelete={deletePages} onRestore={restorePages}
              onDuplicate={duplicatePages} onExtract={extractPages}
              onOpen={openPageForEdit}
            />
          ) : tool === "crop" && activePage && activeSource ? (
            <CropView
              page={activePage}
              source={activeSource}
              zoom={zoom}
              onApply={(crop) => setPageCrop(activePage.id, crop)}
              onReset={() => setPageCrop(activePage.id, undefined)}
            />
          ) : activePage && activeSource ? (
            <AnnotationCanvas
              page={activePage}
              source={activeSource}
              annotations={annotations}
              tool={editTool}
              color={color}
              strokeWidth={strokeWidth}
              fontFamily={fontFamily}
              fontSize={fontSize}
              imageSrc={imageSrc}
              selectedId={selectedAnn}
              onSelect={selectAnn}
              onChange={changeAnn}
              onCreate={createAnn}
              onCreateMany={createMany}
              onDelete={deleteAnn}
              onCommit={() => setTool("edit")}
              onInteractionStart={() => {
                setPast((p) => [...p.slice(-49), snapshot()]);
                setFuture([]);
              }}
              zoom={zoom}
            />
          ) : null}
        </main>

        {showSide && hasDoc && (
          <aside className="w-[280px] shrink-0 border-l border-[#C8CDD2] bg-white">
            <SidePanel
              tool={tool}
              pageCount={visiblePages.length}
              onMerge={mergeFiles}
              onInsertFiles={insertFiles}
              onWatermark={applyWatermark}
              onPageNumbers={applyNumbers}
              onHeaderFooter={applyHF}
              onBates={applyBates}
              onMetadata={applyMeta}
              onSplit={doSplit}
              onCompress={doCompress}
              onConvert={doConvert}
              onProtect={doProtect}
              onUnlock={doUnlock}
            />
          </aside>
        )}
      </div>

      {/* ---- signature pad modal ---- */}
      {showSignPad && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="w-full max-w-lg rounded-xl bg-white p-5 shadow-2xl">
            <div className="mb-4 flex items-center justify-between">
              <h3 className="text-base font-semibold text-[#2A3138]">
                {savedSignatures.length ? "Add signature" : "Create signature"}
              </h3>
              <button
                onClick={() => setShowSignPad(false)}
                className="rounded-md p-1 text-[#5E6870] hover:bg-[#F1F5F8]"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            {/* one-click reuse of the user's stored signatures */}
            {savedSignatures.length > 0 && (
              <div className="mb-4">
                <p className="mb-2 text-xs font-medium uppercase tracking-wide text-[#9AA4AD]">Your saved signatures</p>
                <div className="flex flex-wrap gap-2">
                  {savedSignatures.map((sig) => (
                    <button
                      key={sig.id}
                      title={sig.label ?? "Use this signature"}
                      onClick={() => { setImageSrc(sig.src); setShowSignPad(false); setTool("sign"); }}
                      className="flex h-16 w-36 items-center justify-center rounded-md border border-[#C8CDD2] bg-white p-1.5 hover:border-[#287EAD] hover:bg-[#EEF6FB]"
                    >
                      <img src={sig.src} alt={sig.label ?? "Saved signature"} className="max-h-full max-w-full object-contain" />
                    </button>
                  ))}
                </div>
                <div className="my-4 flex items-center gap-3 text-[11px] uppercase tracking-wide text-[#9AA4AD]">
                  <span className="h-px flex-1 bg-[#E1E5E8]" /> or create new <span className="h-px flex-1 bg-[#E1E5E8]" />
                </div>
              </div>
            )}

            <SignaturePad defaultName={signerName} onChange={(url) => setImageSrc(url)} />
            <div className="mt-4 flex justify-end gap-2">
              <button
                onClick={() => setShowSignPad(false)}
                className="rounded-md border border-[#C8CDD2] px-4 py-2 text-sm text-[#5E6870] hover:bg-[#F1F5F8]"
              >
                Cancel
              </button>
              <button
                disabled={!imageSrc}
                onClick={() => { setShowSignPad(false); setTool("sign"); }}
                className="rounded-md bg-[#287EAD] px-4 py-2 text-sm font-medium text-white hover:bg-[#216C95] disabled:opacity-40"
              >
                Use signature
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ---- busy overlay ---- */}
      {busy && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30">
          <div className="flex items-center gap-3 rounded-xl bg-white px-6 py-4 shadow-2xl">
            <Loader2 className="h-5 w-5 animate-spin text-[#287EAD]" />
            <span className="text-sm font-medium">{busy}</span>
          </div>
        </div>
      )}

      {/* ---- transient success toast ---- */}
      {flash && (
        <div className="pointer-events-none fixed bottom-6 left-1/2 z-[60] -translate-x-1/2">
          <div className="pointer-events-auto flex items-center gap-2 rounded-lg bg-[#1F2933] px-4 py-2.5 text-sm font-medium text-white shadow-2xl">
            <Check className="h-4 w-4 text-[#7ED0A0]" />
            <span>{flash}</span>
            <button onClick={() => setFlash(null)} className="ml-2 text-white/60 hover:text-white">
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Subviews & atoms                                                     */
/* ------------------------------------------------------------------ */

function IconBtn({
  icon: Icon, label, onClick, disabled,
}: { icon: typeof Files; label: string; onClick: () => void; disabled?: boolean }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={label}
      className="rounded-md p-1.5 text-[#5E6870] transition hover:bg-[#F1F5F8] disabled:opacity-30"
    >
      <Icon className="h-4 w-4" />
    </button>
  );
}

/**
 * EditToolbar — the secondary toolbar shown above the canvas while in edit mode.
 *
 * Changes:
 *  • Color picker is now a styled swatch button; clicking opens the OS picker.
 *    After picking, the swatch updates immediately and the picker dismisses on its own.
 *  • Font size is now editable even before placing a text box (sets the default).
 *  • Hint text is cleaner and context-specific.
 */
function EditToolbar({
  tool, shapeTool, setShapeTool,
  color, setColor,
  strokeWidth, setStrokeWidth,
  fontFamily, setFontFamily,
  fontSizePt, setFontSizePt,
}: {
  tool: ToolId; shapeTool: EditTool; setShapeTool: (t: EditTool) => void;
  color: string; setColor: (c: string) => void;
  strokeWidth: number; setStrokeWidth: (n: number) => void;
  fontFamily: string; setFontFamily: (f: string) => void;
  fontSizePt: number; setFontSizePt: (pt: number) => void;
}) {
  const colorInputRef = useRef<HTMLInputElement>(null);
  const showColor = tool !== "edit";
  const showStroke = tool === "draw" || tool === "shape" || tool === "highlight";
  const showFont = tool === "text";
  const showShapePicker = tool === "shape";

  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-[#C8CDD2] bg-white px-4 py-2 text-sm">
      {showColor && (
        <label className="flex cursor-pointer items-center gap-2 text-[#5E6870]">
          <span className="text-xs font-medium">Colour</span>
          <button
            type="button"
            onClick={() => colorInputRef.current?.click()}
            className="flex h-7 w-7 items-center justify-center rounded-md border border-[#C8CDD2] p-0.5 shadow-sm hover:shadow"
            title="Pick colour"
          >
            <span
              className="h-full w-full rounded-sm"
              style={{ background: color }}
            />
          </button>
          <input
            ref={colorInputRef}
            type="color"
            value={color}
            onChange={(e) => setColor(e.target.value)}
            className="sr-only"
          />
        </label>
      )}

      {showStroke && (
        <label className="flex items-center gap-2 text-[#5E6870]">
          <span className="text-xs font-medium">Width</span>
          <input
            type="range" min={1} max={12} value={strokeWidth}
            onChange={(e) => setStrokeWidth(+e.target.value)}
            className="w-24 accent-[#287EAD]"
          />
          <span className="w-4 text-xs text-[#9AA4AD]">{strokeWidth}</span>
        </label>
      )}

      {showFont && (
        <>
          <label className="flex items-center gap-2 text-[#5E6870]">
            <span className="text-xs font-medium">Font</span>
            <select
              value={fontFamily}
              onChange={(e) => setFontFamily(e.target.value)}
              className="rounded-md border border-[#C8CDD2] px-2 py-1 text-xs focus:border-[#287EAD] focus:outline-none"
            >
              <option value="Helvetica">Helvetica</option>
              <option value="Arial">Arial</option>
              <option value="Times">Times</option>
              <option value="Georgia">Georgia</option>
              <option value="Courier">Courier</option>
              <option value="Verdana">Verdana</option>
            </select>
          </label>
          <label className="flex items-center gap-2 text-[#5E6870]">
            <span className="text-xs font-medium">Size</span>
            <input
              type="number"
              min={4} max={300}
              value={fontSizePt}
              onChange={(e) => setFontSizePt(Math.max(4, Math.min(300, Number(e.target.value) || 12)))}
              className="w-14 rounded-md border border-[#C8CDD2] px-2 py-1 text-xs focus:border-[#287EAD] focus:outline-none"
            />
            <span className="text-xs text-[#9AA4AD]">pt</span>
          </label>
        </>
      )}

      {showShapePicker && (
        <div className="flex items-center gap-1">
          {SHAPE_PICKER.map((s) => (
            <button
              key={s.id}
              onClick={() => setShapeTool(s.id)}
              title={s.label}
              className={clsx(
                "rounded-md p-1.5 transition",
                shapeTool === s.id ? "bg-[#EEF6FB] text-[#287EAD]" : "text-[#5E6870] hover:bg-[#F1F5F8]",
              )}
            >
              <s.icon className="h-4 w-4" />
            </button>
          ))}
        </div>
      )}

      {/* Contextual hint */}
      <span className="ml-auto text-xs text-[#B0B8BF]">
        {tool === "edit"
          ? "Click an object to select · Del removes · Esc deselects · ⌘Z undo"
          : tool === "text"
            ? "Click page to place text — then type. Click again later to reselect."
            : tool === "draw"
              ? "Draw freehand — release to end a stroke"
              : tool === "highlight" || tool === "whiteout" || tool === "redact"
                ? "Drag to cover an area"
                : tool === "link"
                  ? "Drag a box, then set the URL in the floating toolbar"
                  : "Click or drag on the page to place"}
      </span>
    </div>
  );
}

function EmptyState({ onOpen }: { onOpen: (files: File[]) => void }) {
  const [dragging, setDragging] = useState(false);

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    const files = [...e.dataTransfer.files].filter((f) => f.type === "application/pdf");
    if (files.length) onOpen(files);
  };

  return (
    <div className="flex flex-1 items-center justify-center bg-[#F7F9FB] p-8">
      <label
        className={clsx(
          "flex cursor-pointer flex-col items-center gap-4 rounded-2xl border-2 border-dashed bg-white px-16 py-20 text-center transition",
          dragging ? "border-[#287EAD] bg-[#EEF6FB]" : "border-[#C8CDD2] hover:border-[#287EAD]",
        )}
        onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={handleDrop}
      >
        <FileText className="h-12 w-12 text-[#287EAD]" />
        <div>
          <p className="text-base font-semibold text-[#2A3138]">Open a PDF to start editing</p>
          <p className="mt-1 text-sm text-[#5E6870]">or drop one here — merge more later</p>
        </div>
        <span className="rounded-lg bg-[#287EAD] px-5 py-2 text-sm font-medium text-white">
          Choose file
        </span>
        <input
          type="file"
          accept="application/pdf"
          multiple
          hidden
          onChange={(e) => e.target.files && onOpen([...e.target.files])}
        />
      </label>
    </div>
  );
}