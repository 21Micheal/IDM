/**
   * PdfEditor — Rev-7
   * ─────────────────
   * • Header: solid Infor blue (#0067AC)
   * • No left sidebar — all tools live in a horizontal ribbon below the header
   * • Groups (Organize / Edit / Enrich / Optimize) are separated by dividers
   *   with small group labels above each cluster
   * • Shapes button opens a floating popover tray (2×2 card grid)
   * • SidePanel tools render their form content as a collapsible shelf
   *   that drops below the ribbon (no right sidebar)
   */
  import {
    useCallback, useEffect, useMemo, useRef, useState,
  } from "react";
  import { createPortal } from "react-dom";
  import {
    Files, Combine, Scissors, FilePlus2, MousePointer2, Type as TypeIcon,
    Image as ImageIcon, PenLine, Highlighter, Square, Circle, Minus,
    ArrowUpRight, Pencil, Eraser, EyeOff, Link2, Stamp, Hash, PanelTop,
    FileText, Settings2, Shrink, RefreshCw, Lock, Unlock, Undo2, Redo2,
    ZoomIn, ZoomOut, Download, Save, ChevronLeft, ChevronRight, Loader2, X,
    ChevronDown, ChevronUp, Crop, Check,
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

  /* ── tool registry ──────────────────────────────────────────────────── */

  interface ToolItem { id: ToolId; label: string; icon: typeof Files }
  const RIBBON: Array<{ group: string; items: ToolItem[] }> = [
    { group: "Organize", items: [
      { id: "pages",  label: "Pages",  icon: Files },
      { id: "merge",  label: "Merge",  icon: Combine },
      { id: "split",  label: "Split",  icon: Scissors },
      { id: "insert", label: "Insert", icon: FilePlus2 },
      { id: "crop",   label: "Crop",   icon: Crop },
    ]},
    { group: "Edit", items: [
      { id: "edit",      label: "Select",    icon: MousePointer2 },
      { id: "text",      label: "Text",      icon: TypeIcon },
      { id: "image",     label: "Image",     icon: ImageIcon },
      { id: "sign",      label: "Sign",      icon: PenLine },
      { id: "highlight", label: "Highlight", icon: Highlighter },
      { id: "shape",     label: "Shapes",    icon: Square },
      { id: "draw",      label: "Draw",      icon: Pencil },
      { id: "whiteout",  label: "Whiteout",  icon: Eraser },
      { id: "redact",    label: "Redact",    icon: EyeOff },
      { id: "link",      label: "Link",      icon: Link2 },
    ]},
    { group: "Enrich", items: [
      { id: "watermark",    label: "Watermark",  icon: Stamp },
      { id: "page_numbers", label: "Numbers",    icon: Hash },
      { id: "header_footer",label: "Header",     icon: PanelTop },
      { id: "bates",        label: "Bates",      icon: Hash },
      { id: "metadata",     label: "Properties", icon: Settings2 },
    ]},
    { group: "Optimize", items: [
      { id: "compress", label: "Compress", icon: Shrink },
      { id: "convert",  label: "Convert",  icon: RefreshCw },
      { id: "protect",  label: "Protect",  icon: Lock },
      { id: "unlock",   label: "Unlock",   icon: Unlock },
    ]},
  ];

  const TOOL_TIPS: Partial<Record<ToolId, string>> = {
    pages: "Organize pages — reorder, rotate, duplicate, delete, or extract",
    merge: "Merge — append other PDFs",
    split: "Split — break into multiple files",
    insert: "Insert — add pages from another PDF or images",
    crop: "Crop — trim the current page",
    edit: "Select — click objects to move, resize, or format",
    text: "Text — click page to place a text box",
    image: "Image — pick an image then click to place",
    sign: "Sign — draw or type a signature",
    highlight: "Highlight — drag over an area",
    shape: "Shapes — rectangle, ellipse, line or arrow",
    draw: "Draw — freehand pen",
    whiteout: "Whiteout — drag a white cover box",
    redact: "Redact — drag a black cover box",
    link: "Link — drag a box, then set a URL",
    watermark: "Watermark — stamp text across every page",
    page_numbers: "Page numbers — add page numbering",
    header_footer: "Header & footer — running text top and bottom",
    bates: "Bates numbering — sequential legal numbering",
    metadata: "Document properties — title, author, subject…",
    compress: "Compress — reduce file size",
    convert: "Convert — PDF ↔ images and more",
    protect: "Protect — add a password",
    unlock: "Unlock — remove a password",
  };

  /* Tools that only make sense as page-organizing full-area views */
  const ORGANIZE_VIEW: ToolId[] = ["pages", "merge", "split", "insert"];
  /* Tools that need the config shelf (formerly the side panel) */
  const SHELF_TOOLS: ToolId[] = [
    "merge", "split", "insert", "watermark", "page_numbers", "header_footer",
    "bates", "metadata", "compress", "convert", "protect", "unlock",
  ];
  const EDIT_TOOL_MAP: Partial<Record<ToolId, EditTool>> = {
    edit: "select", text: "text", image: "image", sign: "signature",
    highlight: "highlight", shape: "rect", draw: "ink", whiteout: "whiteout",
    redact: "redact", link: "link",
  };
  const SHAPE_TOOLS: EditTool[] = ["rect", "ellipse", "line", "arrow"];
  const SHAPE_PICKER: Array<{ id: EditTool; label: string; icon: typeof Square; desc: string }> = [
    { id: "rect",   label: "Rectangle", icon: Square,      desc: "Drag to draw" },
    { id: "ellipse",label: "Ellipse",   icon: Circle,      desc: "Drag to draw" },
    { id: "line",   label: "Line",      icon: Minus,       desc: "Drag a straight line" },
    { id: "arrow",  label: "Arrow",     icon: ArrowUpRight,desc: "Drag with arrowhead" },
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
    txt: "text/plain", pdf: "application/pdf",
  };

  /* ═══════════════════════════════════════════════════════════════════════ */
  /* PdfEditor                                                                */
  /* ═══════════════════════════════════════════════════════════════════════ */

  export default function PdfEditor({
    initialFiles, signerName = "", savedSignatures = [], onJob, onSave, disabledTools = [], className,
  }: PdfEditorProps) {
    const [sources, setSources]       = useState<SourceDocument[]>([]);
    const [pages, setPages]           = useState<EditorPage[]>([]);
    const [annotations, setAnnotations] = useState<Annotation[]>([]);
    const [tool, setTool]             = useState<ToolId>("pages");
    const [shapeTool, setShapeTool]   = useState<EditTool>("rect");
    const [shapesOpen, setShapesOpen] = useState(false);
    const shapeBtnRef = useRef<HTMLButtonElement>(null);
    const ribbonRef = useRef<HTMLDivElement>(null);
    const [selectedPages, setSelectedPages] = useState<Set<string>>(new Set());
    const [selectedAnn, setSelectedAnn]     = useState<string | null>(null);
    const [pageIdx, setPageIdx] = useState(0);
    const [zoom, setZoom]       = useState(1);
    const [color, setColor]           = useState("#0067AC");
    const [strokeWidth, setStrokeWidth] = useState(2);
    const [fontFamily, setFontFamily] = useState("Helvetica");
    const [fontSize, setFontSize]     = useState(0.022);
    const [imageSrc, setImageSrc]     = useState<string | null>(null);
    const [showSignPad, setShowSignPad] = useState(false);
    const [busy, setBusy]   = useState<string | null>(null);
    const [flash, setFlash] = useState<string | null>(null);
    const [shelfOpen, setShelfOpen] = useState(false);

    useEffect(() => {
      if (!flash) return;
      const t = window.setTimeout(() => setFlash(null), 5000);
      return () => window.clearTimeout(t);
    }, [flash]);

    const [pendingExport, setPendingExport] = useState<{
      files: Array<{ name: string; bytes: Uint8Array; mime: string }>;
      label: string; canUseInUpload: boolean;
    } | null>(null);
    useEffect(() => { setPendingExport(null); }, [pages, annotations, sources]);

    const [past, setPast]     = useState<Snapshot[]>([]);
    const [future, setFuture] = useState<Snapshot[]>([]);
    const loadedRef = useRef(false);

    useEffect(() => {
      if (loadedRef.current || !initialFiles?.length) return;
      loadedRef.current = true;
      (async () => {
        setBusy("Loading…");
        for (let i = 0; i < initialFiles.length; i++) await addFile(initialFiles[i], `Document ${i + 1}.pdf`);
        setBusy(null);
      })();
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const visiblePages = useMemo(() => pages.filter((p) => !p.deleted), [pages]);
    const redactCount  = useMemo(() => annotations.filter((a) => a.kind === "redact").length, [annotations]);
    const activePage   = visiblePages[Math.min(pageIdx, visiblePages.length - 1)];
    const activeSource = activePage && sources.find((s) => s.id === activePage.sourceId);
    const isOrganize   = ORGANIZE_VIEW.includes(tool);
    const showShelf    = SHELF_TOOLS.includes(tool) && !disabledTools.includes(tool);
    const editTool: EditTool = tool === "shape" ? shapeTool : (EDIT_TOOL_MAP[tool] ?? "select");

    const snapshot = useCallback((): Snapshot => ({ pages, annotations }), [pages, annotations]);
    const commit = useCallback((next: Partial<Snapshot>) => {
      setPast((p) => [...p.slice(-49), snapshot()]); setFuture([]);
      if (next.pages) setPages(next.pages);
      if (next.annotations) setAnnotations(next.annotations);
    }, [snapshot]);

    const undo = () => setPast((p) => {
      if (!p.length) return p;
      const prev = p[p.length - 1];
      setFuture((f) => [snapshot(), ...f]);
      setPages(prev.pages); setAnnotations(prev.annotations);
      return p.slice(0, -1);
    });
    const redo = () => setFuture((f) => {
      if (!f.length) return f;
      const next = f[0];
      setPast((p) => [...p, snapshot()]);
      setPages(next.pages); setAnnotations(next.annotations);
      return f.slice(1);
    });

    async function addFile(input: File | string | Uint8Array, name: string) {
      const src = await loadSource(input, name);
      setSources((s) => [...s, src]);
      const pagesToAdd = await pagesForSource(src);
      setPages((p) => [...p, ...pagesToAdd]);
    }

    const mergeFiles  = async (files: File[]) => { setBusy("Merging…"); setPast((p) => [...p, snapshot()]); setFuture([]); for (const f of files) await addFile(f, f.name); setBusy(null); setTool("pages"); };
    const insertFiles = async (files: File[]) => {
      setBusy("Inserting…");
      const added: EditorPage[] = [];
      for (const f of files) {
        const isImg = f.type.startsWith("image/");
        const bytes = isImg ? await imagesToPdf([f], { pageSize: "fit" }) : await toBytes(f);
        const src = await loadSource(bytes, f.name);
        setSources((s) => [...s, src]);
        added.push(...(await pagesForSource(src)));
      }
      const at = pages.findIndex((p) => p.id === activePage?.id);
      const next = [...pages];
      next.splice(at < 0 ? pages.length : at + 1, 0, ...added);
      commit({ pages: next }); setBusy(null); setTool("pages");
    };

    const reorder       = (ids: string[]) => { const m = new Map(pages.map((p) => [p.id, p])); commit({ pages: ids.map((id) => m.get(id)!).filter(Boolean) }); };
    const rotatePages   = (ids: string[], d: number) => commit({ pages: pages.map((p) => ids.includes(p.id) ? { ...p, rotation: (((p.rotation + d) % 360) + 360) % 360 } : p) });
    const setPageCrop   = (id: string, crop: EditorPage["crop"]) => commit({ pages: pages.map((p) => p.id === id ? { ...p, crop } : p) });
    const deletePages   = (ids: string[]) => commit({ pages: pages.map((p) => ids.includes(p.id) ? { ...p, deleted: true } : p) });
    const restorePages  = (ids: string[]) => commit({ pages: pages.map((p) => ids.includes(p.id) ? { ...p, deleted: false } : p) });
    const duplicatePages = (ids: string[]) => {
      const next: EditorPage[] = [];
      for (const p of pages) { next.push(p); if (ids.includes(p.id)) next.push({ ...p, id: makeId() }); }
      commit({ pages: next });
    };
    const extractPages = async (ids: string[]) => {
      setBusy("Extracting…");
      downloadBytes("extracted.pdf", await exportDocument(sources, pages.filter((p) => ids.includes(p.id) && !p.deleted), annotations));
      setBusy(null);
    };
    const openPageForEdit = (pageId: string) => {
      const idx = visiblePages.findIndex((p) => p.id === pageId);
      if (idx >= 0) setPageIdx(idx);
      setTool("edit");
    };

    const createAnn = (a: Annotation) => commit({ annotations: [...annotations, a] });
    const createMany = (arr: Annotation[]) => commit({ annotations: [...annotations, ...arr] });
    const changeAnn  = (a: Annotation) => setAnnotations((list) => list.map((x) => x.id === a.id ? a : x));
    const deleteAnn  = (id: string) => commit({ annotations: annotations.filter((x) => x.id !== id) });

    const selectAnn = useCallback((id: string | null) => {
      setAnnotations((list) => {
        if (!selectedAnn || selectedAnn === id) return list;
        const ae = document.activeElement as HTMLElement | null;
        if (ae && (ae.tagName === "INPUT" || ae.tagName === "TEXTAREA" || ae.tagName === "SELECT")) return list;
        const prev = list.find((a) => a.id === selectedAnn);
        if (prev?.kind === "text" && !(prev as TextAnnotation).text.trim() && !(prev as TextAnnotation).background)
          return list.filter((a) => a.id !== selectedAnn);
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
        if ((e.key === "Delete" || e.key === "Backspace") && selectedAnn) { e.preventDefault(); deleteAnn(selectedAnn); setSelectedAnn(null); return; }
        if (e.key === "Escape") setSelectedAnn(null);
      };
      window.addEventListener("keydown", onKey);
      return () => window.removeEventListener("keydown", onKey);
    }, [selectedAnn, undo, redo, deleteAnn]);

    const currentBytes = useCallback(() => exportDocument(sources, pages, annotations), [sources, pages, annotations]);

    const runJob = async (job: Omit<EditorJob, "bytes" | "filename">, name: string) => {
      if (!onJob) { alert("This operation needs a backend."); return; }
      setBusy("Processing on server…");
      try { const r = await onJob({ ...job, bytes: await currentBytes(), filename: name }); if (r) downloadBytes(name, r); }
      finally { setBusy(null); }
    };

    const doExport = async (extra: Parameters<typeof exportDocument>[3] = {}, name = "edited.pdf") => {
      setBusy(onSave ? "Saving…" : "Exporting…");
      try {
        const bytes = await exportDocument(sources, pages, annotations, extra);
        if (onSave) await onSave({ blobs: [{ name, bytes, mime: "application/pdf" }] });
        else downloadBytes(name, bytes);
      } finally { setBusy(null); }
    };
    const doDownload = async (extra: Parameters<typeof exportDocument>[3] = {}, name = "edited.pdf") => {
      setBusy("Preparing download…");
      try { downloadBytes(name, await exportDocument(sources, pages, annotations, extra)); }
      finally { setBusy(null); }
    };

    const applyEnrich = async (extra: Parameters<typeof exportDocument>[3], name: string, label: string) => {
      setBusy("Applying…");
      try {
        await replaceWorkingDoc(await exportDocument(sources, pages, annotations, extra), name);
        setFlash(`${label} applied. Download or Save to keep it.`);
      } finally { setBusy(null); }
    };
    const applyWatermark = (c: WatermarkConfig) => applyEnrich({ watermark: c }, "watermarked.pdf", "Watermark");
    const applyNumbers   = (c: PageNumberConfig) => applyEnrich({ pageNumbers: c }, "numbered.pdf", "Page numbers");
    const applyHF        = (c: HeaderFooterConfig) => applyEnrich({ headerFooter: c }, "header-footer.pdf", "Header & footer");
    const applyBates     = (c: BatesConfig) => applyEnrich({ bates: c }, "bates.pdf", "Bates numbering");
    const applyMeta      = (c: MetadataConfig) => applyEnrich({ metadata: c }, "properties.pdf", "Document properties");

    const doSplit = async (c: SplitConfig) => {
      setBusy("Splitting…");
      try { (await splitDocument(await currentBytes(), c)).forEach((p, i) => setTimeout(() => downloadBytes(p.name, p.bytes), i * 250)); }
      finally { setBusy(null); }
    };

    const replaceWorkingDoc = async (bytes: Uint8Array, name: string) => {
      const src = await loadSource(bytes, name);
      setPast((p) => [...p.slice(-49), snapshot()]); setFuture([]);
      setSources([src]); setPages(await pagesForSource(src)); setAnnotations([]); setSelectedAnn(null); setPageIdx(0);
    };

    const doRedact = async () => {
      const redactions = annotations.filter((a) => a.kind === "redact");
      if (!redactions.length || !onJob) { if (!onJob) setFlash("Permanent redaction needs a backend."); return; }
      const order = new Map(pages.filter((p) => !p.deleted).map((p, i) => [p.id, i]));
      const rects = redactions.map((a) => { const pg = order.get(a.pageId); return pg === undefined ? null : { page: pg, x: a.x, y: a.y, w: a.width, h: a.height }; }).filter(Boolean) as Array<{ page: number; x: number; y: number; w: number; h: number }>;
      if (!rects.length) return;
      setBusy("Redacting…");
      try {
        const result = await onJob({ type: "redact", params: { rects: JSON.stringify(rects) }, bytes: await currentBytes(), filename: "redacted.pdf" });
        if (!result) return;
        await replaceWorkingDoc(result, "redacted.pdf");
        setFlash(`${rects.length} area${rects.length > 1 ? "s" : ""} permanently redacted.`);
      } finally { setBusy(null); }
    };

    const doCompress = async (level: CompressLevel) => {
      setBusy("Compressing…");
      try {
        const visible = pages.filter((p) => !p.deleted);
        const pristine = sources.length === 1 && !annotations.length && visible.length === sources[0].pageCount && visible.every((p, i) => p.sourceId === sources[0].id && p.sourceIndex === i && !(p.rotation % 360) && !p.crop);
        const before = pristine ? sources[0].bytes : await currentBytes();
        let after: Uint8Array | null = level === "low" || level === "medium" ? await compressLite(before)
          : onJob ? await onJob({ type: "compress", params: { level }, bytes: before, filename: "compressed.pdf" })
          : (setFlash("Deep compression needs a backend."), null);
        if (!after) return;
        if (after.length < before.length) {
          await replaceWorkingDoc(after, "compressed.pdf");
          setFlash(`Compressed ${formatBytes(before.length)} → ${formatBytes(after.length)} (${Math.round((1 - after.length / before.length) * 100)}% smaller).`);
        } else {
          setFlash(`Already optimised — ${formatBytes(before.length)}.`);
        }
      } finally { setBusy(null); }
    };

    const doConvert = async (c: ConvertConfig) => {
      if (c.target === "pdf-to-jpg" || c.target === "pdf-to-png") {
        setBusy("Rendering pages…");
        try {
          const bytes = await currentBytes();
          const tmp = await loadSource(bytes, "out.pdf");
          const png = c.target === "pdf-to-png";
          const mime = png ? "image/png" : "image/jpeg";
          const imgs = await rasterizeAll(tmp.id, bytes, { maxSize: Math.round((c.dpi ?? 150) / 72 * 1000), mime });
          const files = await Promise.all(imgs.map(async (url, i) => ({ name: `page-${i + 1}.${png ? "png" : "jpg"}`, bytes: await toBytes(url), mime })));
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
        if (!onJob) { setFlash("Conversion needs a backend."); return; }
        const ext = c.target.includes("docx") ? "docx" : c.target.includes("xlsx") ? "xlsx" : c.target.includes("pptx") ? "pptx" : c.target.includes("text") ? "txt" : "pdf";
        const name = `converted.${ext}`;
        setBusy("Converting on server…");
        try {
          const result = await onJob({ type: "convert", params: { target: c.target, dpi: c.dpi }, bytes: await currentBytes(), filename: name });
          if (!result) return;
          setPendingExport({ files: [{ name, bytes: result, mime: MIME_BY_EXT[ext] ?? "application/octet-stream" }], label: ext.toUpperCase(), canUseInUpload: true });
          setTool("edit");
        } finally { setBusy(null); }
      }
    };

    const doProtect = (pw: string, perms: string[]) => runJob({ type: "protect", params: { password: pw, permissions: perms } }, "protected.pdf");
    const doUnlock  = (pw: string) => runJob({ type: "unlock", params: { password: pw } }, "unlocked.pdf");

    const pickTool = (id: ToolId) => {
      setSelectedAnn(null);
      if (id === "image") {
        const input = document.createElement("input"); input.type = "file"; input.accept = "image/*";
        input.onchange = () => { const f = input.files?.[0]; if (!f) return; const r = new FileReader(); r.onload = () => { setImageSrc(r.result as string); setTool("image"); }; r.readAsDataURL(f); };
        input.click(); return;
      }
      if (id === "sign") { setShowSignPad(true); return; }
      if (id === "shape") {
        setShapesOpen((v) => !v);
        setTool("shape"); return;
      }
      setShapesOpen(false);
      // For shelf tools: toggle if same tool, open if switching
      if (SHELF_TOOLS.includes(id)) {
        if (id === tool) { setShelfOpen((v) => !v); }
        else { setTool(id); setShelfOpen(true); }
        return;
      }
      setTool(id);
      setShelfOpen(false);
    };

    useEffect(() => () => evictRenderCache(), []);

    const hasDoc = sources.length > 0;
    const displayFontPt = Math.max(1, Math.round(fontSize * (activePage?.height || 792)));

    return (
      <div className={clsx("flex h-full min-h-[640px] flex-col bg-white text-[#2A3138]", className)}>

        {/* ══════════════════════════════════════════════════════════════════
            HEADER — solid Infor blue
        ══════════════════════════════════════════════════════════════════ */}
        <header className="flex shrink-0 items-center gap-2 bg-[#287EAD] px-4 py-2.5 shadow-md">
          {/* Brand */}
          <span className="mr-3 flex items-center gap-2">
            <FileText className="h-5 w-5 text-white/80" />
            <span className="text-sm font-bold tracking-wide text-white">PDF Editor</span>
          </span>

          <div className="h-5 w-px bg-white/25" />

          {/* Undo / Redo */}
          <HBtn icon={Undo2} label="Undo (⌘Z)"  disabled={!past.length}   onClick={undo} />
          <HBtn icon={Redo2} label="Redo (⌘⇧Z)" disabled={!future.length} onClick={redo} />

          <div className="h-5 w-px bg-white/25" />

          {/* Zoom */}
          <HBtn icon={ZoomOut} label="Zoom out" onClick={() => setZoom((z) => Math.max(0.4, +(z - 0.15).toFixed(2)))} />
          <button onClick={() => setZoom(1)} title="Reset zoom"
            className="w-14 border border-white/30 px-1 py-1 text-center text-xs text-white/80 hover:bg-white/10">
            {Math.round(zoom * 100)}%
          </button>
          <HBtn icon={ZoomIn} label="Zoom in" onClick={() => setZoom((z) => Math.min(3, +(z + 0.15).toFixed(2)))} />

          <div className="flex-1" />

          {/* Page nav */}
          {!isOrganize && visiblePages.length > 0 && (
            <div className="flex items-center gap-1">
              <HBtn icon={ChevronLeft}  label="Prev page" disabled={pageIdx <= 0}                    onClick={() => setPageIdx((i) => i - 1)} />
              <span className="w-24 text-center text-xs text-white/70">
                Page {Math.min(pageIdx + 1, visiblePages.length)} / {visiblePages.length}
              </span>
              <HBtn icon={ChevronRight} label="Next page" disabled={pageIdx >= visiblePages.length - 1} onClick={() => setPageIdx((i) => i + 1)} />
            </div>
          )}

          <div className="h-5 w-px bg-white/25" />

          {/* Download / Save */}
          <button
            onClick={() => pendingExport
              ? pendingExport.files.forEach((f, i) => setTimeout(() => downloadBytes(f.name, f.bytes, f.mime), i * 150))
              : doDownload({}, "edited.pdf")
            }
            disabled={!hasDoc}
            className="inline-flex items-center gap-1.5 border border-white/30 px-3 py-1.5 text-sm text-white/90 hover:bg-white/10 disabled:opacity-40"
          >
            <Download className="h-4 w-4" /> Download
          </button>

          {onSave && (
            <button
              onClick={async () => {
                if (pendingExport) {
                  if (!pendingExport.canUseInUpload) return;
                  await onSave({ blobs: [pendingExport.files[0]] }); setPendingExport(null);
                } else { doExport({}, "edited.pdf"); }
              }}
              disabled={!hasDoc || (!!pendingExport && !pendingExport.canUseInUpload)}
              className="inline-flex items-center gap-1.5 bg-white px-3 py-1.5 text-sm font-semibold text-[#287EAD] hover:bg-[#EEF6FB] disabled:opacity-40"
            >
              <Save className="h-4 w-4" /> {pendingExport ? "Use & continue" : "Save"}
            </button>
          )}
        </header>

        {/* ══════════════════════════════════════════════════════════════════
            TOOL RIBBON — horizontal, grouped, replaces the left sidebar
        ══════════════════════════════════════════════════════════════════ */}
        <div ref={ribbonRef} className="relative shrink-0 overflow-x-auto border-b border-[#C8CDD2] bg-[#FAFBFC]">
          <div className="flex min-w-max items-end px-3 pb-1 pt-2">
            {RIBBON.map((grp, gi) => (
              <div key={grp.group} className={clsx("flex flex-col", gi > 0 && "ml-1")}>
                {/* Group label */}
                <span className="mb-1 pl-1 text-[9px] font-semibold uppercase tracking-widest text-[#9AA4AD]">
                  {grp.group}
                </span>
                <div className="flex items-center gap-0.5">
                  {grp.items.filter((it) => !disabledTools.includes(it.id)).map((it) => {
                    const active = tool === it.id || (it.id === "shape" && SHAPE_TOOLS.includes(editTool));
                    const isShape = it.id === "shape";
                    return (
                      <button
                        key={it.id}
                        ref={isShape ? shapeBtnRef : undefined}
                        onClick={() => pickTool(it.id)}
                        title={TOOL_TIPS[it.id] ?? it.label}
                        className={clsx(
                          "flex flex-col items-center gap-0.5 px-2.5 py-1.5 text-[11px] font-medium transition border-b-2",
                          active
                            ? "border-[#287EAD] bg-[#EEF6FB] text-[#287EAD]"
                            : "border-transparent text-[#5E6870] hover:bg-[#EEF0F2] hover:text-[#1C2830]",
                        )}
                      >
                        <it.icon className="h-4 w-4" />
                        <span className="flex items-center gap-0.5 leading-none">
                          {it.label}
                          {isShape && (
                            <ChevronDown className={clsx("h-2.5 w-2.5 transition-transform", shapesOpen && "rotate-180")} />
                          )}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
            {/* Thin separators between groups */}
          </div>

          {/* Inter-group separators rendered via CSS (simpler than per-item) */}
          {/* We achieve the separation through gap + the group label spacing above */}

          {/* ── Shapes popover tray ─────────────────────────────────────── */}
          {shapesOpen && tool === "shape" && createPortal(
            <ShapesTray
              shapeBtnRef={shapeBtnRef}
              current={shapeTool}
              onPick={(s) => { setShapeTool(s); setShapesOpen(false); }}
              onClose={() => setShapesOpen(false)}
            />,
            document.body,
          )}
        </div>

        {/* Pending-conversion banner */}
        {pendingExport && (
          <div className="flex flex-wrap items-center gap-2 border-b border-[#F2D98E] bg-[#FFF8E6] px-4 py-2 text-sm text-[#7A5B12]">
            <FileText className="h-4 w-4 shrink-0 text-[#B7791F]" />
            <span>
              Converted to <strong>{pendingExport.label}</strong> —{" "}
              {pendingExport.files.length === 1 ? <span className="font-mono">{pendingExport.files[0].name}</span> : <>{pendingExport.files.length} files</>}.{" "}
              Use <strong>Download</strong> for a copy{onSave && pendingExport.canUseInUpload && <> or <strong>Use &amp; continue</strong> to proceed</>}.
            </span>
            <button onClick={() => setPendingExport(null)} className="ml-auto font-medium hover:underline">Discard &amp; keep editing</button>
          </div>
        )}

        {/* Redaction warning */}
        {redactCount > 0 && (
          <div className="flex flex-wrap items-center gap-2 border-b border-[#F0B4B4] bg-[#FDECEC] px-4 py-2 text-sm text-[#9B2C2C]">
            <EyeOff className="h-4 w-4 shrink-0 text-[#C53030]" />
            <span>{redactCount} redaction box{redactCount > 1 ? "es" : ""} placed — <strong>cover only</strong>, text is still in the file until applied.</span>
            <button onClick={doRedact} disabled={!onJob}
              className="ml-auto inline-flex items-center gap-1.5 bg-red-700 px-3 py-1.5 text-xs font-medium text-white hover:bg-red-800 disabled:opacity-40">
              <EyeOff className="h-3.5 w-3.5" /> Apply redactions
            </button>
          </div>
        )}

        {/* ══════════════════════════════════════════════════════════════════
            CONFIG SHELF — compact floating panel (portal)
        ══════════════════════════════════════════════════════════════════ */}
        {showShelf && shelfOpen && createPortal(
          <ShelfPanel
            ribbonRef={ribbonRef}
            tool={tool}
            label={RIBBON.flatMap((g) => g.items).find((it) => it.id === tool)?.label ?? "Options"}
            pageCount={visiblePages.length}
            onClose={() => setShelfOpen(false)}
            onMerge={mergeFiles} onInsertFiles={insertFiles}
            onWatermark={applyWatermark} onPageNumbers={applyNumbers}
            onHeaderFooter={applyHF} onBates={applyBates} onMetadata={applyMeta}
            onSplit={doSplit} onCompress={doCompress} onConvert={doConvert}
            onProtect={doProtect} onUnlock={doUnlock}
          />,
          document.body,
        )}

        {/* ══════════════════════════════════════════════════════════════════
            MAIN AREA
        ══════════════════════════════════════════════════════════════════ */}
        <div className="flex min-h-0 flex-1 flex-col">
          {/* Secondary edit toolbar (colour, stroke, font) */}
          {!isOrganize && tool !== "crop" && hasDoc && (
            <EditToolbar
              tool={tool} shapeTool={shapeTool} setShapeTool={setShapeTool}
              color={color} setColor={setColor}
              strokeWidth={strokeWidth} setStrokeWidth={setStrokeWidth}
              fontFamily={fontFamily} setFontFamily={setFontFamily}
              fontSizePt={displayFontPt}
              setFontSizePt={(pt) => setFontSize(pt / (activePage?.height || 792))}
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
              page={activePage} source={activeSource} zoom={zoom}
              onApply={(crop) => setPageCrop(activePage.id, crop)}
              onReset={() => setPageCrop(activePage.id, undefined)}
            />
          ) : activePage && activeSource ? (
            <AnnotationCanvas
              page={activePage} source={activeSource} annotations={annotations}
              tool={editTool} color={color} strokeWidth={strokeWidth}
              fontFamily={fontFamily} fontSize={fontSize} imageSrc={imageSrc}
              selectedId={selectedAnn}
              onSelect={selectAnn} onChange={changeAnn} onCreate={createAnn}
              onCreateMany={createMany} onDelete={deleteAnn}
              onCommit={() => setTool("edit")}
              onInteractionStart={() => { setPast((p) => [...p.slice(-49), snapshot()]); setFuture([]); }}
              zoom={zoom}
            />
          ) : null}
        </div>

        {/* ── Signature pad modal ── */}
        {showSignPad && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
            <div className="w-full max-w-lg border border-[#C8CDD2] bg-white shadow-2xl">
              {/* Header */}
              <div className="flex items-center justify-between border-b border-[#C8CDD2] bg-[#287EAD] px-5 py-3">
                <h3 className="text-base font-semibold text-white">
                  {savedSignatures.length ? "Add signature" : "Create signature"}
                </h3>
                <button onClick={() => setShowSignPad(false)} className="p-1 text-white/75 hover:text-white">
                  <X className="h-5 w-5" />
                </button>
              </div>
              <div className="p-5">
                {savedSignatures.length > 0 && (
                  <div className="mb-4">
                    <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-[#5E6870]">Your saved signatures</p>
                    <div className="flex flex-wrap gap-2">
                      {savedSignatures.map((sig) => (
                        <button key={sig.id} onClick={() => { setImageSrc(sig.src); setShowSignPad(false); setTool("sign"); }}
                          className="flex h-16 w-36 items-center justify-center border border-[#C8CDD2] bg-white p-1.5 hover:border-[#287EAD] hover:bg-[#EEF6FB]">
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
                <div className="mt-4 flex justify-end gap-2 border-t border-[#C8CDD2] pt-4">
                  <button onClick={() => setShowSignPad(false)}
                    className="border border-[#C8CDD2] bg-white px-4 py-2 text-sm text-[#5E6870] hover:bg-[#F5F7F8] transition-colors">
                    Cancel
                  </button>
                  <button disabled={!imageSrc} onClick={() => { setShowSignPad(false); setTool("sign"); }}
                    className="bg-[#287EAD] px-4 py-2 text-sm font-medium text-white hover:bg-[#206D99] disabled:opacity-40 transition-colors">
                    Use signature
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Busy overlay */}
        {busy && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30">
            <div className="flex items-center gap-3 border border-[#C8CDD2] bg-white px-6 py-4 shadow-2xl">
              <Loader2 className="h-5 w-5 animate-spin text-[#287EAD]" />
              <span className="text-sm font-medium">{busy}</span>
            </div>
          </div>
        )}

        {/* Toast */}
        {flash && (
          <div className="pointer-events-none fixed bottom-6 left-1/2 z-[60] -translate-x-1/2">
            <div className="pointer-events-auto flex items-center gap-2 border border-[#C8CDD2] bg-[#287EAD] px-4 py-2.5 text-sm font-medium text-white shadow-2xl">
              <Check className="h-4 w-4 text-white" />
              <span>{flash}</span>
              <button onClick={() => setFlash(null)} className="ml-2 text-white/70 hover:text-white"><X className="h-4 w-4" /></button>
            </div>
          </div>
        )}
      </div>
    );
  }

  /* ═══════════════════════════════════════════════════════════════════════ */
  /* ShapesTray — portal popover anchored to the Shapes button               */
  /* ═══════════════════════════════════════════════════════════════════════ */

  function ShapesTray({
    shapeBtnRef, current, onPick, onClose,
  }: {
    shapeBtnRef: React.RefObject<HTMLButtonElement>;
    current: EditTool;
    onPick: (s: EditTool) => void;
    onClose: () => void;
  }) {
    const ref = useRef<HTMLDivElement>(null);
    const [pos, setPos] = useState({ top: 0, left: 0 });

    useEffect(() => {
      const btn = shapeBtnRef.current;
      if (!btn) return;
      const r = btn.getBoundingClientRect();
      setPos({ top: r.bottom + 6, left: r.left });
    }, [shapeBtnRef]);

    useEffect(() => {
      const handler = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) onClose(); };
      const esc = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
      window.addEventListener("mousedown", handler, true);
      window.addEventListener("keydown", esc);
      return () => { window.removeEventListener("mousedown", handler, true); window.removeEventListener("keydown", esc); };
    }, [onClose]);

    return (
      <div
        ref={ref}
        style={{ position: "fixed", top: pos.top, left: pos.left, zIndex: 10000 }}
        className="border border-[#C8CDD2] bg-white shadow-2xl overflow-hidden"
      >
        <p className="px-3 py-2 border-b border-[#C8CDD2] bg-[#287EAD] text-[10px] font-semibold uppercase tracking-widest text-white">
          Choose a shape
        </p>
        <div className="grid grid-cols-2 gap-2 p-3">
          {SHAPE_PICKER.map((s) => (
            <button
              key={s.id}
              onClick={() => onPick(s.id)}
              className={clsx(
                "flex flex-col items-center gap-1.5 border-2 px-4 py-3 text-center transition",
                current === s.id
                  ? "border-[#287EAD] bg-[#EEF6FB] text-[#287EAD]"
                  : "border-[#C8CDD2] text-[#5E6870] hover:border-[#287EAD] hover:bg-[#F5F9FC] hover:text-[#287EAD]",
              )}
            >
              <s.icon className="h-5 w-5" />
              <span className="text-xs font-medium leading-none">{s.label}</span>
              <span className="text-[10px] text-[#9AA4AD]">{s.desc}</span>
            </button>
          ))}
        </div>
      </div>
    );
  }

  /* ═══════════════════════════════════════════════════════════════════════ */
  /* ShelfPanel — compact floating config panel anchored below the ribbon    */
  /* ═══════════════════════════════════════════════════════════════════════ */

  function ShelfPanel({
    ribbonRef, tool, label, pageCount, onClose,
    onMerge, onInsertFiles, onWatermark, onPageNumbers,
    onHeaderFooter, onBates, onMetadata, onSplit, onCompress, onConvert,
    onProtect, onUnlock,
  }: {
    ribbonRef: React.RefObject<HTMLDivElement>;
    tool: ToolId; label: string; pageCount: number; onClose: () => void;
    onMerge: (f: File[]) => void;
    onInsertFiles: (f: File[]) => void;
    onWatermark: (c: WatermarkConfig) => void;
    onPageNumbers: (c: PageNumberConfig) => void;
    onHeaderFooter: (c: HeaderFooterConfig) => void;
    onBates: (c: BatesConfig) => void;
    onMetadata: (c: MetadataConfig) => void;
    onSplit: (c: SplitConfig) => void;
    onCompress: (l: CompressLevel) => void;
    onConvert: (c: ConvertConfig) => void;
    onProtect: (pw: string, perms: string[]) => void;
    onUnlock: (pw: string) => void;
  }) {
    const panelRef = useRef<HTMLDivElement>(null);
    const [top, setTop] = useState(120);

    /* Position just below the ribbon */
    useEffect(() => {
      const el = ribbonRef.current;
      if (!el) return;
      setTop(el.getBoundingClientRect().bottom + 4);
    }, [ribbonRef]);

    /* Close on outside click or Escape */
    useEffect(() => {
      const onDown = (e: MouseEvent) => {
        if (panelRef.current && !panelRef.current.contains(e.target as Node)) onClose();
      };
      const onKey  = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
      window.addEventListener("mousedown", onDown, true);
      window.addEventListener("keydown", onKey);
      return () => {
        window.removeEventListener("mousedown", onDown, true);
        window.removeEventListener("keydown", onKey);
      };
    }, [onClose]);

    return (
      <div
        ref={panelRef}
        style={{ position: "fixed", top, right: 16, zIndex: 9999 }}
        className="w-[300px] border border-[#C8CDD2] bg-white shadow-2xl overflow-hidden"
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-[#C8CDD2] bg-[#287EAD] px-3 py-2">
          <span className="text-sm font-semibold text-white">{label}</span>
          <button onClick={onClose} className="p-0.5 text-white/75 hover:text-white" title="Close panel">
            <X className="h-4 w-4" />
          </button>
        </div>
        {/* Scrollable body */}
        <div className="max-h-[calc(100vh-16rem)] overflow-y-auto p-3">
          <SidePanel
            tool={tool} pageCount={pageCount}
            onMerge={onMerge} onInsertFiles={onInsertFiles}
            onWatermark={onWatermark} onPageNumbers={onPageNumbers}
            onHeaderFooter={onHeaderFooter} onBates={onBates} onMetadata={onMetadata}
            onSplit={onSplit} onCompress={onCompress} onConvert={onConvert}
            onProtect={onProtect} onUnlock={onUnlock}
            compact
          />
        </div>
      </div>
    );
  }


  /* ═══════════════════════════════════════════════════════════════════════ */

  function EditToolbar({
    tool, shapeTool, setShapeTool, color, setColor,
    strokeWidth, setStrokeWidth, fontFamily, setFontFamily,
    fontSizePt, setFontSizePt,
  }: {
    tool: ToolId; shapeTool: EditTool; setShapeTool: (t: EditTool) => void;
    color: string; setColor: (c: string) => void;
    strokeWidth: number; setStrokeWidth: (n: number) => void;
    fontFamily: string; setFontFamily: (f: string) => void;
    fontSizePt: number; setFontSizePt: (pt: number) => void;
  }) {
    const colorRef = useRef<HTMLInputElement>(null);
    const showColor  = tool !== "edit";
    const showStroke = tool === "draw" || tool === "shape" || tool === "highlight";
    const showFont   = tool === "text";

    return (
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-[#C8CDD2] bg-white px-4 py-2 text-sm">
        {showColor && (
          <label className="flex cursor-pointer items-center gap-2 text-[#5E6870]">
            <span className="text-xs font-medium">Colour</span>
            <button type="button" onClick={() => colorRef.current?.click()}
              className="flex h-7 w-7 items-center justify-center border border-[#C8CDD2] p-0.5 hover:shadow">
              <span className="h-full w-full" style={{ background: color }} />
            </button>
            <input ref={colorRef} type="color" value={color} onChange={(e) => setColor(e.target.value)} className="sr-only" />
          </label>
        )}
        {showStroke && (
          <label className="flex items-center gap-2 text-[#5E6870]">
            <span className="text-xs font-medium">Width</span>
            <input type="range" min={1} max={12} value={strokeWidth} onChange={(e) => setStrokeWidth(+e.target.value)} className="w-24 accent-[#0067AC]" />
            <span className="w-4 text-xs text-[#9AA4AD]">{strokeWidth}</span>
          </label>
        )}
        {showFont && (
          <>
            <label className="flex items-center gap-2 text-[#5E6870]">
              <span className="text-xs font-medium">Font</span>
              <select value={fontFamily} onChange={(e) => setFontFamily(e.target.value)}
                className="border border-[#C8CDD2] px-2 py-1 text-xs focus:border-[#287EAD] focus:outline-none">
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
              <input type="number" min={4} max={300} value={fontSizePt}
                onChange={(e) => setFontSizePt(Math.max(4, Math.min(300, Number(e.target.value) || 12)))}
                className="w-14 border border-[#C8CDD2] px-2 py-1 text-xs focus:border-[#287EAD] focus:outline-none" />
              <span className="text-xs text-[#9AA4AD]">pt</span>
            </label>
          </>
        )}
        <span className="ml-auto text-xs text-[#B0B8BF]">
          {tool === "edit" ? "Click an object to select · Del removes · Esc deselects · ⌘Z undo"
            : tool === "text" ? "Click page to place text — then type"
            : tool === "draw" ? "Draw freehand — release to end"
            : tool === "highlight" || tool === "whiteout" || tool === "redact" ? "Drag to cover an area"
            : tool === "link" ? "Drag a box, then set the URL"
            : "Click or drag on the page to place"}
        </span>
      </div>
    );
  }

  /* ═══════════════════════════════════════════════════════════════════════ */
  /* Helpers                                                                  */
  /* ═══════════════════════════════════════════════════════════════════════ */

  /** Button for the blue header bar */
  function HBtn({ icon: Icon, label, onClick, disabled }: { icon: typeof Files; label: string; onClick: () => void; disabled?: boolean }) {
    return (
      <button onClick={onClick} disabled={disabled} title={label}
        className="p-1.5 text-white/80 transition hover:bg-white/15 disabled:opacity-30">
        <Icon className="h-4 w-4" />
      </button>
    );
  }

  function EmptyState({ onOpen }: { onOpen: (files: File[]) => void }) {
    const [dragging, setDragging] = useState(false);
    const handleDrop = (e: React.DragEvent) => {
      e.preventDefault(); setDragging(false);
      const files = [...e.dataTransfer.files].filter((f) => f.type === "application/pdf");
      if (files.length) onOpen(files);
    };
    return (
      <div className="flex flex-1 items-center justify-center bg-[#EEF0F2] p-8">
        <label
          className={clsx(
            "flex cursor-pointer flex-col items-center gap-4 border-2 border-dashed bg-white px-16 py-20 text-center transition",
            dragging ? "border-[#287EAD] bg-[#EEF6FB]" : "border-[#C8CDD2] hover:border-[#287EAD]",
          )}
          onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
          onDragLeave={() => setDragging(false)}
          onDrop={handleDrop}
        >
          <FileText className="h-12 w-12 text-[#287EAD]" />
          <div>
            <p className="text-base font-semibold text-[#1C2830]">Open a PDF to start editing</p>
            <p className="mt-1 text-sm text-[#5E6870]">or drop one here — merge more later</p>
          </div>
          <span className="bg-[#287EAD] px-5 py-2 text-sm font-medium text-white hover:bg-[#206D99]">Choose file</span>
          <input type="file" accept="application/pdf" multiple hidden onChange={(e) => e.target.files && onOpen([...e.target.files])} />
        </label>
      </div>
    );
  }
  