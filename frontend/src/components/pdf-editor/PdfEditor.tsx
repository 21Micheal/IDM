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
  Shapes as ShapesIcon, ChevronDown,
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

export default function PdfEditor({
  initialFiles, signerName = "", onJob, onSave, disabledTools = [], className,
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
  const [past, setPast] = useState<Snapshot[]>([]);
  const [future, setFuture] = useState<Snapshot[]>([]);

  useEffect(() => {
    if (!initialFiles?.length) return;
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

  const doExport = async (extra: Parameters<typeof exportDocument>[3] = {}, name = "edited.pdf") => {
    setBusy("Exporting…");
    try {
      const bytes = await exportDocument(sources, pages, annotations, extra);
      if (onSave) await onSave({ blobs: [{ name, bytes, mime: "application/pdf" }] });
      else downloadBytes(name, bytes);
    } finally { setBusy(null); }
  };

  const applyWatermark = (c: WatermarkConfig) => doExport({ watermark: c }, "watermarked.pdf");
  const applyNumbers = (c: PageNumberConfig) => doExport({ pageNumbers: c }, "numbered.pdf");
  const applyHF = (c: HeaderFooterConfig) => doExport({ headerFooter: c }, "header-footer.pdf");
  const applyBates = (c: BatesConfig) => doExport({ bates: c }, "bates.pdf");
  const applyMeta = (c: MetadataConfig) => doExport({ metadata: c }, "properties.pdf");

  const doSplit = async (c: SplitConfig) => {
    setBusy("Splitting…");
    try {
      const bytes = await currentBytes();
      const parts = await splitDocument(bytes, c);
      parts.forEach((p, i) => setTimeout(() => downloadBytes(p.name, p.bytes), i * 250));
    } finally { setBusy(null); }
  };

  const doCompress = async (level: CompressLevel) => {
    if (level === "low" || level === "medium") {
      setBusy("Compressing…");
      try { downloadBytes("compressed.pdf", await compressLite(await currentBytes())); }
      finally { setBusy(null); }
    } else {
      runJob({ type: "compress", params: { level } }, "compressed.pdf");
    }
  };

  const doConvert = async (c: ConvertConfig) => {
    if (c.target === "pdf-to-jpg" || c.target === "pdf-to-png") {
      setBusy("Rendering pages…");
      try {
        const bytes = await currentBytes();
        const tmp = await loadSource(bytes, "out.pdf");
        const size = Math.round((c.dpi ?? 150) / 72 * 1000);
        const mime = c.target === "pdf-to-png" ? "image/png" : "image/jpeg";
        const imgs = await rasterizeAll(tmp.id, bytes, { maxSize: size, mime });
        imgs.forEach((url, i) => setTimeout(async () => {
          downloadBytes(`page-${i + 1}.${c.target === "pdf-to-png" ? "png" : "jpg"}`, await toBytes(url), mime);
        }, i * 200));
      } finally { setBusy(null); }
    } else if (c.target === "jpg-to-pdf") {
      const input = document.createElement("input");
      input.type = "file"; input.accept = "image/*"; input.multiple = true;
      input.onchange = async () => {
        if (!input.files?.length) return;
        setBusy("Building PDF…");
        try { downloadBytes("images.pdf", await imagesToPdf([...input.files], { pageSize: "a4", margin: 24 })); }
        finally { setBusy(null); }
      };
      input.click();
    } else {
      const ext = c.target.includes("docx") ? "docx" : c.target.includes("xlsx") ? "xlsx"
        : c.target.includes("pptx") ? "pptx" : c.target.includes("text") ? "txt" : "pdf";
      runJob({ type: "convert", params: { target: c.target, dpi: c.dpi } }, `converted.${ext}`);
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
          onClick={() => doExport({}, "edited.pdf")}
          disabled={!hasDoc}
          className="ml-2 inline-flex items-center gap-1.5 rounded-md border border-[#C8CDD2] px-3 py-1.5 text-sm text-[#5E6870] hover:bg-[#F1F5F8] disabled:opacity-40"
        >
          <Download className="h-4 w-4" /> Download
        </button>
        {onSave && (
          <button
            onClick={() => doExport({}, "edited.pdf")}
            disabled={!hasDoc}
            className="inline-flex items-center gap-1.5 rounded-md bg-[#287EAD] px-3 py-1.5 text-sm font-medium text-white hover:bg-[#216C95] disabled:opacity-40"
          >
            <Save className="h-4 w-4" /> Save
          </button>
        )}
      </header>

      <div className="flex min-h-0 flex-1">
        {/* ---- left rail ---- */}
        <nav className="relative w-[88px] shrink-0 overflow-visible border-r border-[#C8CDD2] bg-[#FAFBFC] py-2">
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
                    {isShapes && shapesOpen && tool === "shape" && (
                      <div
                        className="absolute left-full top-0 z-30 ml-1 w-36 rounded-md border border-[#C8CDD2] bg-white py-1 shadow-lg"
                        onMouseLeave={() => setShapesOpen(false)}
                      >
                        {SHAPE_PICKER.map((s) => (
                          <button
                            key={s.id}
                            onClick={() => { setShapeTool(s.id); setShapesOpen(false); }}
                            className={clsx(
                              "flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm",
                              shapeTool === s.id
                                ? "bg-[#EEF6FB] text-[#287EAD]"
                                : "text-[#5E6870] hover:bg-[#F1F5F8]",
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
          {!isOrganize && hasDoc && (
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
              <h3 className="text-base font-semibold text-[#2A3138]">Create signature</h3>
              <button
                onClick={() => setShowSignPad(false)}
                className="rounded-md p-1 text-[#5E6870] hover:bg-[#F1F5F8]"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
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