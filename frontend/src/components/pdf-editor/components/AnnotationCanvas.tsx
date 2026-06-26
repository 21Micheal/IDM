/**
   * AnnotationCanvas — interactive PDF editing surface.
   *
   * Rev-6 changes
   * ─────────────
   * FEATURE  Snap-to-grid / snap-to-annotation
   *   • Toggle button (grid icon) in the canvas toolbar enables snapping.
   *   • Grid size selector: 1%, 2%, 5% of page dimensions.
   *   • While snapping is on a dot-grid overlay is drawn on the canvas.
   *   • Move, resize, and create all snap to the nearest grid line.
   *   • Snap-to-annotation: dragged element also snaps to the edges and
   *     centre lines of every other annotation on the page (thin cyan guides).
   *
   * KEPT (rev 5)
   *   • Multi-select (Shift+click), group move/delete/nudge, alignment toolbar
   *   • Ghost-div text layout, portal toolbar/context menu
   *   • Right-click context menu, Ctrl+D, opacity, Bring to Front / Send to Back
   */

  import {
    useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState,
  } from "react";
  import { createPortal } from "react-dom";
  import {
    Trash2, Lock, Unlock, Bold, Italic, Underline, Type, Copy,
    AlignLeft, AlignCenter, AlignRight, PaintBucket, Ban,
    ChevronsUp, ChevronsDown, SlidersHorizontal,
    AlignStartVertical, AlignCenterHorizontal, AlignEndVertical,
    AlignStartHorizontal, AlignCenterVertical, AlignEndHorizontal,
    Grid3x3,
  } from "lucide-react";
  import clsx from "clsx";
  import type {
    Annotation, AnnotationKind, EditorPage, ImageAnnotation,
    InkAnnotation, ShapeAnnotation, SourceDocument, TextAnnotation,
  } from "../types";
  import {
    renderPage, getPageTextRuns, samplePageColor, type ExistingTextRun,
  } from "../pdfRender";
  import { makeId } from "../pdfEngine";

  export type EditTool =
    | "select" | "text" | "image" | "signature" | "rect" | "ellipse"
    | "line" | "arrow" | "highlight" | "whiteout" | "ink" | "redact" | "link";

  interface Props {
    page: EditorPage;
    source: SourceDocument;
    annotations: Annotation[];
    tool: EditTool;
    color: string;
    strokeWidth: number;
    fontFamily: string;
    fontSize?: number;
    imageSrc?: string | null;
    selectedId: string | null;
    onSelect: (id: string | null) => void;
    onChange: (a: Annotation) => void;
    onCreate: (a: Annotation) => void;
    onCreateMany?: (anns: Annotation[]) => void;
    onDelete: (id: string) => void;
    onCommit?: () => void;
    onInteractionStart?: () => void;
    onUndo?: () => void;
    onRedo?: () => void;
    zoom: number;
  }

  type Handle = "nw" | "ne" | "sw" | "se";
  interface CanvasRect { left: number; top: number; width: number; height: number }

  const clamp = (v: number) => Math.min(1, Math.max(0, v));

  /* ── snap helpers ─────────────────────────────────────────────────────── */

  const GRID_SIZES = [0.01, 0.025, 0.05] as const;
  const GRID_LABELS = ["1%", "2.5%", "5%"] as const;
  const SNAP_THRESHOLD = 0.012; // max distance (fraction) to trigger a snap

  function snapToGrid(v: number, gridSize: number): number {
    return Math.round(v / gridSize) * gridSize;
  }

  interface SnapLines { x: number[]; y: number[] }

  function buildSnapLines(anns: Annotation[], excludeId: string | null): SnapLines {
    const xs: number[] = [];
    const ys: number[] = [];
    for (const a of anns) {
      if (a.id === excludeId) continue;
      xs.push(a.x, a.x + a.width / 2, a.x + a.width);
      ys.push(a.y, a.y + a.height / 2, a.y + a.height);
    }
    return { x: xs, y: ys };
  }

  function snapToLines(v: number, lines: number[]): number {
    let best = v;
    let bestDist = SNAP_THRESHOLD;
    for (const l of lines) {
      const d = Math.abs(v - l);
      if (d < bestDist) { bestDist = d; best = l; }
    }
    return best;
  }

  function snapVal(v: number, gridSize: number, lines: number[], useGrid: boolean): number {
    const gs = useGrid ? snapToGrid(v, gridSize) : v;
    const ls = snapToLines(v, lines);
    // pick whichever is closer
    if (useGrid && Math.abs(gs - v) <= Math.abs(ls - v)) return gs;
    if (lines.length) return ls;
    return useGrid ? gs : v;
  }

  /* ═══════════════════════════════════════════════════════════════════════ */
  /* AnnotationCanvas                                                         */
  /* ═══════════════════════════════════════════════════════════════════════ */

  export default function AnnotationCanvas({
    page, source, annotations, tool, color, strokeWidth, fontFamily, fontSize = 0.022,
    imageSrc, selectedId, onSelect, onChange, onCreate, onCreateMany, onDelete,
    onCommit, onInteractionStart, onUndo, onRedo, zoom,
  }: Props) {
    const wrapRef = useRef<HTMLDivElement>(null);
    const [bg, setBg] = useState<string | null>(null);
    const [box, setBox] = useState({ w: 0, h: 0 });
    const [canvasRect, setCanvasRect] = useState<CanvasRect>({ left: 0, top: 0, width: 0, height: 0 });
    const [draft, setDraft] = useState<Annotation | null>(null);
    const [textRuns, setTextRuns] = useState<ExistingTextRun[]>([]);
    const [hoverRun, setHoverRun] = useState<ExistingTextRun | null>(null);

    // ── snap state ─────────────────────────────────────────────────────────
    const [snapEnabled, setSnapEnabled] = useState(false);
    const [gridSizeIdx, setGridSizeIdx] = useState(1); // default 2.5%
    const gridSize = GRID_SIZES[gridSizeIdx];
    // active snap guide lines (shown while dragging)
    const [snapGuides, setSnapGuides] = useState<{ x: number[]; y: number[] } | null>(null);

    // ── Multi-select ───────────────────────────────────────────────────────
    const [multiIds, setMultiIds] = useState<Set<string>>(new Set());
    const allSelected = useMemo<Set<string>>(() => {
      const s = new Set(multiIds);
      if (selectedId) s.add(selectedId);
      return s;
    }, [multiIds, selectedId]);
    const isMulti = allSelected.size >= 2;

    const drag = useRef<{
      mode: "create" | "move" | "resize"; handle?: Handle;
      startX: number; startY: number; orig: Annotation;
      origMulti?: Record<string, { x: number; y: number }>;
      moved?: boolean;
      wasSelected?: boolean;
    } | null>(null);

    // ── page render ─────────────────────────────────────────────────────────
    useEffect(() => {
      let dead = false;
      setBg(null);
      renderPage(source.id, source.bytes, page.sourceIndex, {
        maxSize: 1600, rotation: page.rotation, mime: "image/jpeg", quality: 0.85,
      }).then((r) => { if (!dead) setBg(r.dataUrl); }).catch(() => {});
      return () => { dead = true; };
    }, [source.id, source.bytes, page.sourceIndex, page.rotation]);

    // ── text runs ───────────────────────────────────────────────────────────
    useEffect(() => {
      let dead = false;
      setTextRuns([]);
      getPageTextRuns(source.id, source.bytes, page.sourceIndex, page.rotation)
        .then((runs) => { if (!dead) setTextRuns(runs); })
        .catch(() => {});
      return () => { dead = true; };
    }, [source.id, source.bytes, page.sourceIndex, page.rotation]);

    // ── canvas size + viewport rect ─────────────────────────────────────────
    useEffect(() => {
      const el = wrapRef.current;
      if (!el) return;
      const update = () => {
        const r = el.getBoundingClientRect();
        setBox({ w: r.width, h: r.height });
        setCanvasRect({ left: r.left, top: r.top, width: r.width, height: r.height });
      };
      const ro = new ResizeObserver(update);
      ro.observe(el);
      window.addEventListener("scroll", update, true);
      window.addEventListener("resize", update);
      update();
      return () => { ro.disconnect(); window.removeEventListener("scroll", update, true); window.removeEventListener("resize", update); };
    }, []);

    const pageAnns = useMemo(
      () => annotations.filter((a) => a.pageId === page.id),
      [annotations, page.id],
    );

    // ── global keyboard shortcuts ───────────────────────────────────────────
    useEffect(() => {
      const onKey = (e: KeyboardEvent) => {
        const tag = (e.target as HTMLElement).tagName;
        const typing = tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT"
          || (e.target as HTMLElement).isContentEditable;
        const mod = e.metaKey || e.ctrlKey;
        if (mod && !e.shiftKey && e.key === "z") { e.preventDefault(); onUndo?.(); return; }
        if (mod && (e.shiftKey ? e.key === "z" : e.key === "y")) { e.preventDefault(); onRedo?.(); return; }
        if (typing) return;
        if ((e.key === "Delete" || e.key === "Backspace") && allSelected.size) {
          e.preventDefault();
          onInteractionStart?.();
          allSelected.forEach((id) => onDelete(id));
          setMultiIds(new Set());
          onSelect(null);
          return;
        }
        if (mod && e.key === "d" && selectedId) {
          e.preventDefault();
          const ann = annotations.find((a) => a.id === selectedId);
          if (ann) {
            const copy = { ...ann, id: makeId(), x: clamp(ann.x + 0.02), y: clamp(ann.y + 0.02), z: Date.now() } as Annotation;
            onCreate(copy); onSelect(copy.id); setMultiIds(new Set());
          }
          return;
        }
        if (e.key === "Escape") { onSelect(null); setMultiIds(new Set()); return; }
        if (allSelected.size && ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key)) {
          e.preventDefault();
          const step = e.shiftKey ? 0.01 : 0.001;
          allSelected.forEach((id) => {
            const ann = annotations.find((a) => a.id === id);
            if (!ann) return;
            let { x, y } = ann;
            if (e.key === "ArrowLeft")  x = clamp(x - step);
            if (e.key === "ArrowRight") x = clamp(x + step);
            if (e.key === "ArrowUp")    y = clamp(y - step);
            if (e.key === "ArrowDown")  y = clamp(y + step);
            onChange({ ...ann, x, y });
          });
        }
      };
      window.addEventListener("keydown", onKey);
      return () => window.removeEventListener("keydown", onKey);
    }, [selectedId, allSelected, annotations, onChange, onCreate, onDelete, onSelect, onUndo, onRedo, onInteractionStart]);

    // ── coordinate helper ───────────────────────────────────────────────────
    const toFrac = useCallback((cx: number, cy: number) => {
      const r = wrapRef.current!.getBoundingClientRect();
      return {
        x: Math.min(1, Math.max(0, (cx - r.left) / r.width)),
        y: Math.min(1, Math.max(0, (cy - r.top) / r.height)),
      };
    }, []);

    const hitExistingText = useCallback(
      (x: number, y: number): ExistingTextRun | null => {
        const hits = textRuns.filter(
          (r) => x >= r.x && x <= r.x + r.width && y >= r.y && y <= r.y + r.height,
        );
        if (!hits.length) return null;
        const best = hits.reduce((b, r) => r.width * r.height < b.width * b.height ? r : b);
        const lineH = best.fontSize * 1.4;
        const lineY = Math.max(best.y, Math.min(best.y + best.height - lineH, y - lineH / 2));
        return { ...best, y: lineY, height: Math.min(lineH, best.height) };
      },
      [textRuns],
    );

    /* ── snap helpers ─────────────────────────────────────────────────────── */

    const applySnap = useCallback((x: number, y: number, excludeId: string | null): { x: number; y: number; guides: { x: number[]; y: number[] } } => {
      if (!snapEnabled) return { x, y, guides: { x: [], y: [] } };
      const annLines = buildSnapLines(pageAnns, excludeId);
      const sx = snapVal(x, gridSize, annLines.x, true);
      const sy = snapVal(y, gridSize, annLines.y, true);
      // collect which annotation lines fired
      const gx = Math.abs(sx - x) < SNAP_THRESHOLD && sx !== snapToGrid(x, gridSize) ? [sx] : [];
      const gy = Math.abs(sy - y) < SNAP_THRESHOLD && sy !== snapToGrid(y, gridSize) ? [sy] : [];
      return { x: clamp(sx), y: clamp(sy), guides: { x: gx, y: gy } };
    }, [snapEnabled, gridSize, pageAnns]);

    /* ── creation ─────────────────────────────────────────────────────────── */
    const startCreate = (e: React.MouseEvent) => {
      setMultiIds(new Set());
      if (tool === "select") {
        const { x, y } = toFrac(e.clientX, e.clientY);
        const hit = hitExistingText(x, y);
        if (hit) {
          onInteractionStart?.();
          const probeX = Math.min(0.999, Math.max(0.001, hit.x + hit.width + 0.005));
          const probeY = Math.min(0.999, Math.max(0.001, hit.y + hit.height / 2));
          const paper = bg ? samplePageColor(bg, probeX, probeY) : "#ffffff";
          const pad = 0.0015;
          const cover: ShapeAnnotation = {
            id: makeId(), pageId: page.id, kind: "whiteout",
            x: Math.max(0, hit.x - pad), y: Math.max(0, hit.y - pad),
            width: hit.width + pad * 2, height: hit.height + pad * 2,
            color: paper, z: Date.now() - 1,
          };
          const ann: TextAnnotation = {
            id: makeId(), pageId: page.id, z: Date.now(), kind: "text",
            x: hit.x, y: hit.y, width: hit.width, height: hit.height,
            text: hit.str, fontFamily, fontSize: hit.fontSize,
            align: "left", color: "#000000",
          };
          (onCreateMany ?? ((arr: Annotation[]) => arr.forEach(onCreate)))([cover, ann]);
          onSelect(ann.id);
          return;
        }
        onSelect(null);
        return;
      }

      const raw = toFrac(e.clientX, e.clientY);
      const { x, y } = snapEnabled
        ? applySnap(raw.x, raw.y, null)
        : { x: raw.x, y: raw.y };
      const base = { id: makeId(), pageId: page.id, x, y, width: 0.001, height: 0.001, color, z: Date.now() };

      if (tool === "text") {
        const ann: TextAnnotation = { ...base, kind: "text", text: "", fontFamily, fontSize, align: "left" };
        onCreate(ann); onSelect(ann.id); onCommit?.(); return;
      }
      if (tool === "image" || tool === "signature") {
        if (!imageSrc) return;
        const ann: ImageAnnotation = { ...base, kind: tool, width: 0.25, height: 0.12, src: imageSrc };
        onCreate(ann); onSelect(ann.id); onCommit?.(); return;
      }
      if (tool === "ink") {
        const ann: InkAnnotation = { ...base, kind: "ink", width: 1, height: 1, x: 0, y: 0, paths: [[{ x: raw.x, y: raw.y }]], strokeWidth, color };
        setDraft(ann);
        drag.current = { mode: "create", startX: raw.x, startY: raw.y, orig: ann };
        return;
      }
      const ann = { ...base, kind: tool as AnnotationKind, width: 0, height: 0, strokeWidth, ...(tool === "link" ? { url: "https://" } : {}) } as Annotation;
      setDraft(ann);
      drag.current = { mode: "create", startX: x, startY: y, orig: ann };
    };

    const onMove = (e: React.MouseEvent) => {
      if (!drag.current) {
        if (tool === "select") {
          const { x, y } = toFrac(e.clientX, e.clientY);
          setHoverRun(hitExistingText(x, y));
        }
        return;
      }
      if (hoverRun) setHoverRun(null);
      const raw = toFrac(e.clientX, e.clientY);
      const d = drag.current;

      if (d.mode === "create" && draft) {
        if (draft.kind === "ink") {
          const paths = [...(draft as InkAnnotation).paths];
          paths[paths.length - 1] = [...paths[paths.length - 1], { x: raw.x, y: raw.y }];
          setDraft({ ...(draft as InkAnnotation), paths });
        } else {
          const x1 = Math.min(d.startX, raw.x), y1 = Math.min(d.startY, raw.y);
          const x2 = Math.max(d.startX, raw.x), y2 = Math.max(d.startY, raw.y);
          let sx2 = x2, sy2 = y2;
          if (snapEnabled) {
            const s2 = applySnap(x2, y2, draft.id);
            sx2 = s2.x; sy2 = s2.y;
            setSnapGuides(s2.guides);
          } else {
            setSnapGuides(null);
          }
          setDraft({ ...draft, x: x1, y: y1, width: Math.abs(sx2 - x1), height: Math.abs(sy2 - y1) });
        }
        return;
      }

      if (d.mode === "move") {
        const dx = raw.x - d.startX, dy = raw.y - d.startY;
        if (!d.moved) {
          if (Math.abs(dx) <= 0.004 && Math.abs(dy) <= 0.004) return;
          d.moved = true;
          onInteractionStart?.();
        }
        if (d.origMulti) {
          pageAnns.filter((a) => allSelected.has(a.id)).forEach((a) => {
            const orig = d.origMulti![a.id];
            if (orig) {
              let nx = clamp(orig.x + dx), ny = clamp(orig.y + dy);
              if (snapEnabled) {
                const s = applySnap(nx, ny, a.id);
                nx = s.x; ny = s.y;
                setSnapGuides(s.guides);
              }
              onChange({ ...a, x: nx, y: ny });
            }
          });
        } else {
          let nx = clamp(d.orig.x + dx), ny = clamp(d.orig.y + dy);
          if (snapEnabled) {
            const s = applySnap(nx, ny, d.orig.id);
            nx = s.x; ny = s.y;
            setSnapGuides(s.guides);
          } else {
            setSnapGuides(null);
          }
          onChange({ ...d.orig, x: nx, y: ny });
        }
        return;
      }

      if (d.mode === "resize" && d.handle) {
        const o = d.orig;
        let nx = o.x, ny = o.y, nw = o.width, nh = o.height;
        const right = o.x + o.width, bottom = o.y + o.height;
        let rx = raw.x, ry = raw.y;
        if (snapEnabled) {
          const s = applySnap(raw.x, raw.y, o.id);
          rx = s.x; ry = s.y;
          setSnapGuides(s.guides);
        }
        if (d.handle.includes("e")) nw = Math.max(0.01, rx - o.x);
        if (d.handle.includes("s")) nh = Math.max(0.01, ry - o.y);
        if (d.handle.includes("w")) { nx = Math.min(rx, right - 0.01); nw = right - nx; }
        if (d.handle.includes("n")) { ny = Math.min(ry, bottom - 0.01); nh = bottom - ny; }
        onChange({ ...o, x: nx, y: ny, width: nw, height: nh });
      }
    };

    const endDrag = () => {
      const d = drag.current;
      if (d?.mode === "create" && draft) {
        if (draft.width >= (draft.kind === "ink" ? 0 : 0.01) || draft.kind === "ink") {
          onCreate(draft); onSelect(draft.id); onCommit?.();
        }
        setDraft(null);
      }
      if (d?.mode === "move" && !d.moved && d.wasSelected) onSelect(null);
      drag.current = null;
      setSnapGuides(null);
    };

    const beginMove = (e: React.MouseEvent, a: Annotation) => {
      if (a.locked || tool !== "select") return;
      e.stopPropagation();
      if (e.shiftKey) {
        setMultiIds((prev) => {
          const next = new Set(prev);
          if (selectedId) next.add(selectedId);
          if (next.has(a.id)) { next.delete(a.id); }
          else { next.add(a.id); }
          return next;
        });
        onSelect(a.id);
        return;
      }
      const wasSelected = a.id === selectedId;
      onSelect(a.id);
      const { x, y } = toFrac(e.clientX, e.clientY);
      const isGrouped = allSelected.has(a.id) && allSelected.size >= 2;
      const origMulti = isGrouped
        ? Object.fromEntries(
            pageAnns
              .filter((p) => allSelected.has(p.id))
              .map((p) => [p.id, { x: p.x, y: p.y }]),
          )
        : undefined;
      if (!allSelected.has(a.id)) setMultiIds(new Set());
      drag.current = { mode: "move", startX: x, startY: y, orig: a, origMulti, moved: false, wasSelected: wasSelected && !isGrouped };
    };

    const beginResize = (e: React.MouseEvent, a: Annotation, handle: Handle) => {
      e.stopPropagation(); onInteractionStart?.();
      drag.current = { mode: "resize", handle, startX: 0, startY: 0, orig: a };
    };

    // ── alignment ───────────────────────────────────────────────────────────
    const selectedAnns = useMemo(
      () => pageAnns.filter((a) => allSelected.has(a.id)),
      [pageAnns, allSelected],
    );

    const alignAll = useCallback((fn: (a: Annotation, bb: { x1: number; y1: number; x2: number; y2: number }) => Partial<Annotation>) => {
      if (selectedAnns.length < 2) return;
      onInteractionStart?.();
      const bb = {
        x1: Math.min(...selectedAnns.map((a) => a.x)),
        y1: Math.min(...selectedAnns.map((a) => a.y)),
        x2: Math.max(...selectedAnns.map((a) => a.x + a.width)),
        y2: Math.max(...selectedAnns.map((a) => a.y + a.height)),
      };
      selectedAnns.forEach((a) => {
        const patch = fn(a, bb) as Partial<Annotation>;
        onChange({ ...a, ...patch } as Annotation);
      });
    }, [selectedAnns, onChange, onInteractionStart]);

    const selectionBB = useMemo(() => {
      if (allSelected.size < 2 || !selectedAnns.length) return null;
      return {
        x: Math.min(...selectedAnns.map((a) => a.x)),
        y: Math.min(...selectedAnns.map((a) => a.y)),
        x2: Math.max(...selectedAnns.map((a) => a.x + a.width)),
        y2: Math.max(...selectedAnns.map((a) => a.y + a.height)),
      };
    }, [allSelected, selectedAnns]);

    const aspect = page.width / page.height;

    // ── grid overlay cells ──────────────────────────────────────────────────
    const gridDots = useMemo(() => {
      if (!snapEnabled) return null;
      const dots: Array<{ cx: string; cy: string }> = [];
      for (let gx = 0; gx <= 1 + gridSize / 2; gx += gridSize) {
        for (let gy = 0; gy <= 1 + gridSize / 2; gy += gridSize) {
          dots.push({ cx: `${clamp(gx) * 100}%`, cy: `${clamp(gy) * 100}%` });
        }
      }
      return dots;
    }, [snapEnabled, gridSize]);

    return (
      <div className="flex h-full flex-col">
        {/* Snap toolbar */}
        <div className="flex items-center gap-2 border-b border-[#C8CDD2] bg-white px-4 py-1.5">
          <button
            title={snapEnabled ? "Disable snapping" : "Enable snap-to-grid / snap-to-annotation"}
            onClick={() => setSnapEnabled((v) => !v)}
            className={clsx(
              "flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium transition",
              snapEnabled
                ? "bg-[#0067AC] text-white shadow-sm"
                : "border border-[#C8CDD2] text-[#5E6870] hover:bg-[#F1F5F8]",
            )}
          >
            <Grid3x3 className="h-3.5 w-3.5" />
            Snap
          </button>

          {snapEnabled && (
            <>
              <span className="text-xs text-[#9AA4AD]">Grid:</span>
              {GRID_SIZES.map((s, i) => (
                <button
                  key={s}
                  onClick={() => setGridSizeIdx(i)}
                  className={clsx(
                    "rounded-md px-2 py-0.5 text-xs transition",
                    gridSizeIdx === i
                      ? "bg-[#0067AC]/10 font-semibold text-[#0067AC]"
                      : "text-[#5E6870] hover:bg-[#F1F5F8]",
                  )}
                >
                  {GRID_LABELS[i]}
                </button>
              ))}
              <span className="ml-2 text-xs text-[#B0B8BF]">
                Snaps to grid lines and annotation edges
              </span>
            </>
          )}
        </div>

        <div className="flex flex-1 items-start justify-center overflow-auto bg-[#EEF0F2] p-6">
          <div className="relative shadow-xl" style={{ width: `${680 * zoom}px`, maxWidth: "100%", aspectRatio: String(aspect) }}>
            <div
              ref={wrapRef}
              className={clsx(
                "relative h-full w-full select-none bg-white",
                tool !== "select" && "cursor-crosshair",
                tool === "select" && hoverRun && "cursor-text",
              )}
              onMouseDown={startCreate}
              onMouseMove={onMove}
              onMouseUp={endDrag}
              onMouseLeave={endDrag}
            >
              {bg
                ? <img src={bg} alt="" draggable={false} className="pointer-events-none h-full w-full object-contain" />
                : <div className="flex h-full items-center justify-center text-sm text-[#C8CDD2]">Rendering…</div>}

              {/* Snap grid overlay */}
              {snapEnabled && gridDots && (
                <svg className="pointer-events-none absolute inset-0 h-full w-full" style={{ opacity: 0.35 }}>
                  {gridDots.map((d, i) => (
                    <circle key={i} cx={d.cx} cy={d.cy} r="1.5" fill="#0067AC" />
                  ))}
                </svg>
              )}

              {/* Active snap guide lines */}
              {snapGuides && (snapGuides.x.length > 0 || snapGuides.y.length > 0) && (
                <svg className="pointer-events-none absolute inset-0 h-full w-full">
                  {snapGuides.x.map((xv, i) => (
                    <line key={`x${i}`} x1={0} y1={`${xv * 100}%`} x2="100%" y2={`${xv * 100}%`}
                      stroke="#00B4D8" strokeWidth="1" strokeDasharray="4 3" />
                  ))}
                  {snapGuides.y.map((yv, i) => (
                    <line key={`y${i}`} x1={`${yv * 100}%`} y1={0} x2={`${yv * 100}%`} y2="100%"
                      stroke="#00B4D8" strokeWidth="1" strokeDasharray="4 3" />
                  ))}
                </svg>
              )}

              {/* Hover highlight for existing PDF text */}
              {tool === "select" && hoverRun && (
                <div className="pointer-events-none absolute rounded-[2px] outline-dashed outline-1 outline-[#0067AC]"
                  style={{ left: `${hoverRun.x * 100}%`, top: `${hoverRun.y * 100}%`, width: `${hoverRun.width * 100}%`, height: `${hoverRun.height * 100}%` }} />
              )}

              {/* Multi-selection bounding box overlay */}
              {selectionBB && (
                <div className="pointer-events-none absolute"
                  style={{
                    left: `${selectionBB.x * 100}%`, top: `${selectionBB.y * 100}%`,
                    width: `${(selectionBB.x2 - selectionBB.x) * 100}%`,
                    height: `${(selectionBB.y2 - selectionBB.y) * 100}%`,
                    outline: "2px dashed #0067AC",
                    outlineOffset: 4,
                    borderRadius: 3,
                  }} />
              )}

              {/* Annotations */}
              {[...pageAnns, ...(draft ? [draft] : [])]
                .sort((a, b) => (a.z ?? 0) - (b.z ?? 0))
                .map((a) => (
                  <AnnotationView
                    key={a.id}
                    a={a}
                    box={box}
                    canvasRect={canvasRect}
                    selected={allSelected.has(a.id)}
                    isPrimary={a.id === selectedId}
                    interactive={tool === "select"}
                    onMouseDown={(e) => beginMove(e, a)}
                    onResize={(e, h) => beginResize(e, a, h)}
                    onTextChange={(text) => onChange({ ...(a as TextAnnotation), text })}
                    onTextEditStart={() => onInteractionStart?.()}
                    onUpdate={(patch) => { onInteractionStart?.(); onChange({ ...a, ...patch } as Annotation); }}
                    onSizeChange={(patch) => onChange({ ...a, ...patch } as Annotation)}
                    onDuplicate={() => {
                      const copy = { ...a, id: makeId(), x: clamp(a.x + 0.02), y: clamp(a.y + 0.02), z: Date.now() } as Annotation;
                      onCreate(copy); onSelect(copy.id); setMultiIds(new Set());
                    }}
                    onBringToFront={() => {
                      const maxZ = Math.max(...pageAnns.map((p) => p.z ?? 0));
                      onChange({ ...a, z: maxZ + 1 });
                    }}
                    onSendToBack={() => {
                      const minZ = Math.min(...pageAnns.map((p) => p.z ?? 0));
                      onChange({ ...a, z: minZ - 1 });
                    }}
                    pageHeightPt={page.height}
                    onDelete={() => { onDelete(a.id); onSelect(null); setMultiIds(new Set()); }}
                    onToggleLock={() => onChange({ ...a, locked: !a.locked })}
                    onSelect={() => { onSelect(a.id); }}
                    onDeselect={() => { onSelect(null); setMultiIds(new Set()); }}
                    suppressToolbar={isMulti}
                  />
                ))}
            </div>
          </div>

          {/* Alignment toolbar */}
          {isMulti && selectionBB && createPortal(
            <AlignmentToolbar
              selectionBB={selectionBB}
              canvasRect={canvasRect}
              count={allSelected.size}
              onAlignLeft={()   => alignAll((a, bb) => ({ x: bb.x1 }))}
              onAlignCenterH={() => alignAll((a, bb) => ({ x: (bb.x1 + bb.x2) / 2 - a.width / 2 }))}
              onAlignRight={()  => alignAll((a, bb) => ({ x: bb.x2 - a.width }))}
              onAlignTop={()    => alignAll((a, bb) => ({ y: bb.y1 }))}
              onAlignCenterV={() => alignAll((a, bb) => ({ y: (bb.y1 + bb.y2) / 2 - a.height / 2 }))}
              onAlignBottom={() => alignAll((a, bb) => ({ y: bb.y2 - a.height }))}
              onDeleteAll={() => { onInteractionStart?.(); allSelected.forEach((id) => onDelete(id)); setMultiIds(new Set()); onSelect(null); }}
            />,
            document.body,
          )}
        </div>
      </div>
    );
  }

  /* ═══════════════════════════════════════════════════════════════════════ */
  /* AlignmentToolbar                                                         */
  /* ═══════════════════════════════════════════════════════════════════════ */

  function AlignmentToolbar({
    selectionBB, canvasRect, count,
    onAlignLeft, onAlignCenterH, onAlignRight,
    onAlignTop, onAlignCenterV, onAlignBottom,
    onDeleteAll,
  }: {
    selectionBB: { x: number; y: number; x2: number; y2: number };
    canvasRect: CanvasRect;
    count: number;
    onAlignLeft: () => void; onAlignCenterH: () => void; onAlignRight: () => void;
    onAlignTop: () => void; onAlignCenterV: () => void; onAlignBottom: () => void;
    onDeleteAll: () => void;
  }) {
    const vpTop  = canvasRect.top  + selectionBB.y  * canvasRect.height;
    const vpLeft = canvasRect.left + selectionBB.x  * canvasRect.width;
    const flipped = vpTop < 60;
    const vpBottom = canvasRect.top + selectionBB.y2 * canvasRect.height;

    const btn = (title: string, icon: React.ReactNode, action: () => void, danger = false) => (
      <button key={title} title={title}
        onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); action(); }}
        className={clsx("rounded-md p-1.5 transition",
          danger ? "text-red-500 hover:bg-red-50 hover:text-red-700" : "text-[#5E6870] hover:bg-[#F1F5F8] hover:text-[#0067AC]")}
      >{icon}</button>
    );

    return (
      <div style={{ position: "fixed", left: vpLeft, top: flipped ? vpBottom + 6 : vpTop - 6, transform: flipped ? "none" : "translateY(-100%)", zIndex: 9999, pointerEvents: "none" }}>
        <div style={{ pointerEvents: "auto" }} onMouseDown={(e) => e.stopPropagation()} onClick={(e) => e.stopPropagation()}
          className="flex items-center gap-0.5 rounded-lg border border-[#C8CDD2] bg-white px-2 py-1.5 shadow-xl">
          <span className="mr-1 rounded-md bg-[#0067AC]/10 px-1.5 py-0.5 text-[10px] font-semibold text-[#0067AC]">{count} selected</span>
          <Divider />
          {btn("Align Left edges",    <AlignStartVertical   className="h-4 w-4" />, onAlignLeft)}
          {btn("Centre horizontally", <AlignCenterHorizontal className="h-4 w-4" />, onAlignCenterH)}
          {btn("Align Right edges",   <AlignEndVertical     className="h-4 w-4" />, onAlignRight)}
          <Divider />
          {btn("Align Top edges",    <AlignStartHorizontal className="h-4 w-4" />, onAlignTop)}
          {btn("Centre vertically",  <AlignCenterVertical  className="h-4 w-4" />, onAlignCenterV)}
          {btn("Align Bottom edges", <AlignEndHorizontal   className="h-4 w-4" />, onAlignBottom)}
          <Divider />
          {btn("Delete all selected (Del)", <Trash2 className="h-4 w-4" />, onDeleteAll, true)}
        </div>
      </div>
    );
  }

  /* ═══════════════════════════════════════════════════════════════════════ */
  /* AnnotationView                                                           */
  /* ═══════════════════════════════════════════════════════════════════════ */

  function AnnotationView({
    a, box, canvasRect, selected, isPrimary, interactive,
    onMouseDown, onResize, onTextChange, onTextEditStart,
    onUpdate, onSizeChange, onDuplicate, onBringToFront, onSendToBack,
    pageHeightPt, onDelete, onToggleLock, onSelect, onDeselect,
    suppressToolbar,
  }: {
    a: Annotation; box: { w: number; h: number }; canvasRect: CanvasRect;
    selected: boolean; isPrimary: boolean; interactive: boolean;
    onMouseDown: (e: React.MouseEvent) => void;
    onResize: (e: React.MouseEvent, h: Handle) => void;
    onTextChange: (t: string) => void;
    onTextEditStart?: () => void;
    onUpdate: (patch: Partial<Annotation>) => void;
    onSizeChange: (patch: Partial<Annotation>) => void;
    onDuplicate: () => void; onBringToFront: () => void; onSendToBack: () => void;
    pageHeightPt: number; onDelete: () => void; onToggleLock: () => void;
    onSelect: () => void; onDeselect: () => void; suppressToolbar: boolean;
  }) {
    const annDivRef = useRef<HTMLDivElement>(null);
    const textRef = useRef<HTMLTextAreaElement>(null);
    const editStarted = useRef(false);
    const prevSize = useRef({ w: a.width, h: a.height });
    const [ctxPos, setCtxPos] = useState<{ x: number; y: number } | null>(null);

    useEffect(() => {
      if (a.kind === "text" && isPrimary && interactive) {
        const t = setTimeout(() => textRef.current?.focus(), 30);
        return () => clearTimeout(t);
      }
    }, [a.kind, isPrimary, interactive]);

    const syncTextSize = useCallback(() => {
      const el = annDivRef.current;
      if (!el || !box.w || !box.h) return;
      const w = el.offsetWidth / box.w;
      const h = el.offsetHeight / box.h;
      if (Math.abs(w - prevSize.current.w) > 0.003 || Math.abs(h - prevSize.current.h) > 0.003) {
        prevSize.current = { w, h };
        onSizeChange({ width: w, height: h });
      }
    }, [box.w, box.h, onSizeChange]);

    useLayoutEffect(() => {
      if (a.kind !== "text") return;
      syncTextSize();
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [
      (a as TextAnnotation).text,
      (a as TextAnnotation).fontSize,
      (a as TextAnnotation).fontFamily,
      (a as TextAnnotation).bold,
      (a as TextAnnotation).italic,
      box.w, box.h,
    ]);

    if (a.kind === "ink") {
      const ink = a as InkAnnotation;
      return (
        <svg className="pointer-events-none absolute inset-0 h-full w-full" viewBox="0 0 1 1" preserveAspectRatio="none">
          {ink.paths.map((path, i) => (
            <polyline key={i}
              points={path.map((p) => `${p.x},${p.y}`).join(" ")}
              fill="none" stroke={a.color ?? "#000"}
              strokeWidth={(ink.strokeWidth ?? 2) / Math.max(box.w, 1)}
              strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
          ))}
        </svg>
      );
    }

    let inner: React.ReactNode = null;

    if (a.kind === "text") {
      const t = a as TextAnnotation;
      const fsPx = t.fontSize * box.h;
      const fontStyle: React.CSSProperties = {
        fontFamily: t.fontFamily, fontSize: `${fsPx}px`,
        fontWeight: t.bold ? 700 : 400, fontStyle: t.italic ? "italic" : "normal",
        textDecoration: t.underline ? "underline" : "none",
        lineHeight: "1.3", padding: "2px 4px", whiteSpace: "pre", wordBreak: "normal",
      };
      inner = (
        <div ref={annDivRef}
          style={{ display: "inline-block", position: "relative", minWidth: 60, minHeight: fsPx * 1.4 }}
          onMouseDown={onMouseDown}
          onContextMenu={(e) => {
            if (!interactive) return;
            e.preventDefault(); e.stopPropagation();
            onSelect(); setCtxPos({ x: e.clientX, y: e.clientY });
          }}
        >
          <div aria-hidden style={{ ...fontStyle, color: "transparent", userSelect: "none", pointerEvents: "none" }}>
            {t.text || " "}
          </div>
          <textarea ref={textRef} value={t.text}
            onChange={(e) => onTextChange(e.target.value)}
            onFocus={() => { if (!editStarted.current) { editStarted.current = true; onTextEditStart?.(); } }}
            onBlur={() => { editStarted.current = false; }}
            onKeyDown={(e) => {
              const mod = e.metaKey || e.ctrlKey;
              if (mod && !e.altKey && !e.shiftKey) {
                if (e.key === "b" || e.key === "B") { e.preventDefault(); onUpdate({ bold: !t.bold }); }
                if (e.key === "i" || e.key === "I") { e.preventDefault(); onUpdate({ italic: !t.italic }); }
                if (e.key === "u" || e.key === "U") { e.preventDefault(); onUpdate({ underline: !t.underline }); }
              }
              if (e.key === "Escape") { e.preventDefault(); textRef.current?.blur(); onDeselect(); }
            }}
            onMouseDown={(e) => e.stopPropagation()}
            placeholder="Type here…"
            style={{
              ...fontStyle, position: "absolute", inset: 0, width: "100%", height: "100%",
              resize: "none", border: "none", outline: "none",
              background: t.background ?? "transparent", color: t.color ?? "#000000",
              textAlign: t.align ?? "left", overflow: "hidden",
              pointerEvents: isPrimary && interactive ? "auto" : "none",
            }}
          />
          {selected && (
            <div className="pointer-events-none absolute inset-0 rounded-sm"
              style={{ outline: "1.5px dashed #0067AC", outlineOffset: 2 }} />
          )}
        </div>
      );
    } else if (a.kind === "image" || a.kind === "signature") {
      inner = <img src={(a as ImageAnnotation).src} alt="" className="h-full w-full object-contain" draggable={false} />;
    } else if (a.kind === "highlight") {
      inner = <div className="h-full w-full" style={{ background: a.color ?? "#ffeb3b", opacity: 0.4 }} />;
    } else if (a.kind === "whiteout") {
      inner = <div className="h-full w-full" style={{ background: a.color ?? "#ffffff" }} />;
    } else if (a.kind === "redact") {
      inner = <div className="h-full w-full bg-black" />;
    } else if (a.kind === "rect") {
      const s = a as ShapeAnnotation;
      inner = <div className="h-full w-full" style={{ border: `${s.strokeWidth ?? 1}px solid ${a.color}`, background: s.fill ?? "transparent" }} />;
    } else if (a.kind === "ellipse") {
      const s = a as ShapeAnnotation;
      inner = <div className="h-full w-full rounded-[50%]" style={{ border: `${s.strokeWidth ?? 1}px solid ${a.color}`, background: s.fill ?? "transparent" }} />;
    } else if (a.kind === "line" || a.kind === "arrow") {
      inner = (
        <svg className="h-full w-full overflow-visible" preserveAspectRatio="none">
          {a.kind === "arrow" && (
            <defs>
              <marker id={`arrow-${a.id}`} markerWidth="10" markerHeight="7" refX="9" refY="3.5" orient="auto">
                <polygon points="0 0, 10 3.5, 0 7" fill={a.color ?? "#000"} />
              </marker>
            </defs>
          )}
          <line x1="0" y1="0" x2="100%" y2="100%"
            stroke={a.color ?? "#000"} strokeWidth={(a as ShapeAnnotation).strokeWidth ?? 1.5}
            markerEnd={a.kind === "arrow" ? `url(#arrow-${a.id})` : undefined} />
        </svg>
      );
    } else if (a.kind === "link") {
      const url = (a as { url?: string }).url ?? "";
      const linkPx = Math.max(8, a.height * canvasRect.height * 0.66);
      inner = (
        <div className="flex h-full w-full items-center overflow-hidden border border-dashed border-[#0067AC] bg-[#0067AC]/10 px-1">
          <span className="truncate font-medium text-[#0067AC] underline" style={{ fontSize: linkPx, lineHeight: 1 }}>
            {url || "link"}
          </span>
        </div>
      );
    }

    const boxStyle: React.CSSProperties = a.kind === "text"
      ? { position: "absolute", left: `${a.x * 100}%`, top: `${a.y * 100}%`, opacity: a.opacity ?? 1 }
      : { position: "absolute", left: `${a.x * 100}%`, top: `${a.y * 100}%`, width: `${a.width * 100}%`, height: `${a.height * 100}%`, opacity: a.opacity ?? 1 };

    const annVpTop    = canvasRect.top  + a.y * canvasRect.height;
    const annVpLeft   = canvasRect.left + a.x * canvasRect.width;
    const annVpBottom = annVpTop + a.height * canvasRect.height;
    const toolbarFlipped = annVpTop < 56;

    return (
      <>
        <div
          ref={a.kind === "text" ? undefined : annDivRef}
          style={boxStyle}
          onMouseDown={a.kind === "text" ? undefined : onMouseDown}
          onContextMenu={a.kind === "text" ? undefined : (e) => {
            if (!interactive) return;
            e.preventDefault(); e.stopPropagation();
            onSelect(); setCtxPos({ x: e.clientX, y: e.clientY });
          }}
          className={clsx(
            "group",
            interactive && a.kind !== "text" && "cursor-move",
            selected && a.kind !== "text" && "outline outline-2 outline-[#0067AC]",
          )}
        >
          {inner}
          {isPrimary && !suppressToolbar && a.kind !== "text" &&
            (["nw", "ne", "sw", "se"] as Handle[]).map((h) => (
              <span key={h} onMouseDown={(e) => onResize(e, h)}
                className={clsx(
                  "absolute z-20 h-3 w-3 rounded-sm border-2 border-white bg-[#0067AC] shadow-sm",
                  h === "nw" && "-left-1.5 -top-1.5 cursor-nwse-resize",
                  h === "ne" && "-right-1.5 -top-1.5 cursor-nesw-resize",
                  h === "sw" && "-bottom-1.5 -left-1.5 cursor-nesw-resize",
                  h === "se" && "-bottom-1.5 -right-1.5 cursor-nwse-resize",
                )} />
            ))}
        </div>

        {isPrimary && !suppressToolbar && createPortal(
          <div style={{ position: "fixed", left: annVpLeft, top: toolbarFlipped ? annVpBottom + 6 : annVpTop - 6, transform: toolbarFlipped ? "none" : "translateY(-100%)", zIndex: 9999, pointerEvents: "none" }}>
            <div style={{ pointerEvents: "auto" }} onMouseDown={(e) => e.stopPropagation()} onClick={(e) => e.stopPropagation()}>
              <AnnotationToolbar a={a} pageHeightPt={pageHeightPt} onUpdate={onUpdate}
                onDuplicate={onDuplicate} onBringToFront={onBringToFront} onSendToBack={onSendToBack}
                onToggleLock={onToggleLock} onDelete={onDelete} />
            </div>
          </div>,
          document.body,
        )}

        {ctxPos && createPortal(
          <ContextMenu x={ctxPos.x} y={ctxPos.y} locked={!!a.locked}
            onBringToFront={() => { onBringToFront(); setCtxPos(null); }}
            onSendToBack={() => { onSendToBack(); setCtxPos(null); }}
            onDuplicate={() => { onDuplicate(); setCtxPos(null); }}
            onToggleLock={() => { onToggleLock(); setCtxPos(null); }}
            onDelete={() => { onDelete(); setCtxPos(null); }}
            onClose={() => setCtxPos(null)}
          />,
          document.body,
        )}
      </>
    );
  }

  /* ═══════════════════════════════════════════════════════════════════════ */
  /* ContextMenu                                                              */
  /* ═══════════════════════════════════════════════════════════════════════ */

  function ContextMenu({ x, y, locked, onBringToFront, onSendToBack, onDuplicate, onToggleLock, onDelete, onClose }: {
    x: number; y: number; locked: boolean;
    onBringToFront: () => void; onSendToBack: () => void;
    onDuplicate: () => void; onToggleLock: () => void;
    onDelete: () => void; onClose: () => void;
  }) {
    const ref = useRef<HTMLDivElement>(null);
    const [pos, setPos] = useState({ left: x, top: y });

    useEffect(() => {
      const handler = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) onClose(); };
      const esc = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
      window.addEventListener("mousedown", handler);
      window.addEventListener("keydown", esc);
      return () => { window.removeEventListener("mousedown", handler); window.removeEventListener("keydown", esc); };
    }, [onClose]);

    useEffect(() => {
      const el = ref.current; if (!el) return;
      const r = el.getBoundingClientRect();
      setPos({ left: Math.min(x, window.innerWidth - r.width - 8), top: Math.min(y, window.innerHeight - r.height - 8) });
    }, [x, y]);

    const item = (label: string, icon: React.ReactNode, action: () => void, danger = false) => (
      <button key={label}
        onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); action(); }}
        className={clsx("flex w-full items-center gap-2.5 px-3 py-1.5 text-left text-sm transition hover:bg-[#F1F5F8]",
          danger ? "text-red-600 hover:bg-red-50" : "text-[#2E3740]")}>
        <span className="h-4 w-4 shrink-0">{icon}</span>{label}
      </button>
    );

    return (
      <div ref={ref}
        style={{ position: "fixed", left: pos.left, top: pos.top, zIndex: 10000 }}
        className="min-w-[170px] overflow-hidden rounded-lg border border-[#C8CDD2] bg-white py-1 shadow-2xl">
        {item("Bring to Front", <ChevronsUp   className="h-4 w-4" />, onBringToFront)}
        {item("Send to Back",   <ChevronsDown className="h-4 w-4" />, onSendToBack)}
        <div className="my-1 border-t border-[#E1E5E8]" />
        {item("Duplicate",      <Copy  className="h-4 w-4" />, onDuplicate)}
        {item(locked ? "Unlock" : "Lock", locked ? <Unlock className="h-4 w-4" /> : <Lock className="h-4 w-4" />, onToggleLock)}
        <div className="my-1 border-t border-[#E1E5E8]" />
        {item("Delete",         <Trash2 className="h-4 w-4" />, onDelete, true)}
      </div>
    );
  }

  /* ═══════════════════════════════════════════════════════════════════════ */
  /* AnnotationToolbar                                                        */
  /* ═══════════════════════════════════════════════════════════════════════ */

  const SHAPE_KINDS = new Set<AnnotationKind>(["rect", "ellipse", "line", "arrow"]);

  function AnnotationToolbar({ a, pageHeightPt, onUpdate, onDuplicate, onBringToFront, onSendToBack, onToggleLock, onDelete }: {
    a: Annotation; pageHeightPt: number;
    onUpdate: (patch: Partial<Annotation>) => void;
    onDuplicate: () => void; onBringToFront: () => void; onSendToBack: () => void;
    onToggleLock: () => void; onDelete: () => void;
  }) {
    return (
      <div className="flex flex-wrap items-center gap-0.5 rounded-lg border border-[#C8CDD2] bg-white px-2 py-1.5 shadow-xl">
        {a.kind === "text" && <TextToolbarSection a={a as TextAnnotation} pageHeightPt={pageHeightPt} onUpdate={onUpdate} />}
        {SHAPE_KINDS.has(a.kind) && <ShapeToolbarSection a={a as ShapeAnnotation} onUpdate={onUpdate} />}
        {a.kind === "highlight" && <><ColorSwatch title="Colour" value={a.color ?? "#ffeb3b"} onChange={(c) => onUpdate({ color: c })} /><Divider /></>}
        {a.kind === "link" && (
          <><input type="url" placeholder="https://…" defaultValue={(a as { url?: string }).url ?? ""}
            onChange={(e) => onUpdate({ url: e.target.value } as Partial<Annotation>)}
            className="w-48 rounded-md border border-[#C8CDD2] px-2 py-1 text-xs outline-none focus:border-[#0067AC]" /><Divider /></>
        )}
        <OpacityControl opacity={a.opacity ?? 1} onChange={(v) => onUpdate({ opacity: v })} />
        <Divider />
        <ToolBtn title="Bring to Front" onClick={onBringToFront}><ChevronsUp   className="h-4 w-4" /></ToolBtn>
        <ToolBtn title="Send to Back"   onClick={onSendToBack}><ChevronsDown className="h-4 w-4" /></ToolBtn>
        <Divider />
        <ToolBtn title="Duplicate (Ctrl+D)" onClick={onDuplicate}><Copy className="h-4 w-4" /></ToolBtn>
        <ToolBtn title={a.locked ? "Unlock" : "Lock"} onClick={onToggleLock}>
          {a.locked ? <Lock className="h-4 w-4" /> : <Unlock className="h-4 w-4" />}
        </ToolBtn>
        <ToolBtn title="Delete (Del)" onClick={onDelete} danger><Trash2 className="h-4 w-4" /></ToolBtn>
      </div>
    );
  }

  function TextToolbarSection({ a, pageHeightPt, onUpdate }: {
    a: TextAnnotation; pageHeightPt: number; onUpdate: (p: Partial<Annotation>) => void;
  }) {
    const curPt = Math.max(1, Math.round(a.fontSize * (pageHeightPt || 792)));
    return (
      <>
        <select title="Font family" value={a.fontFamily} onChange={(e) => onUpdate({ fontFamily: e.target.value })}
          className="h-7 rounded-md border border-[#C8CDD2] px-1.5 py-0 text-xs text-[#5E6870] outline-none focus:border-[#0067AC]">
          <option value="Helvetica">Helvetica</option>
          <option value="Arial">Arial</option>
          <option value="Times">Times</option>
          <option value="Georgia">Georgia</option>
          <option value="Courier">Courier</option>
          <option value="Verdana">Verdana</option>
        </select>
        <span className="flex items-center gap-0.5" title="Font size (pt)">
          <Type className="h-3.5 w-3.5 text-[#9AA4AD]" />
          <input type="number" min={4} max={300} value={curPt}
            onChange={(e) => { const pt = Math.max(1, Number(e.target.value) || 1); onUpdate({ fontSize: pt / (pageHeightPt || 792) }); }}
            className="h-7 w-12 rounded-md border border-[#C8CDD2] px-1 text-xs outline-none focus:border-[#0067AC]" />
        </span>
        <Divider />
        <Toggle active={!!a.bold}      title="Bold (Ctrl+B)"      onClick={() => onUpdate({ bold: !a.bold })}><Bold className="h-4 w-4" /></Toggle>
        <Toggle active={!!a.italic}    title="Italic (Ctrl+I)"    onClick={() => onUpdate({ italic: !a.italic })}><Italic className="h-4 w-4" /></Toggle>
        <Toggle active={!!a.underline} title="Underline (Ctrl+U)" onClick={() => onUpdate({ underline: !a.underline })}><Underline className="h-4 w-4" /></Toggle>
        <Divider />
        <Toggle active={a.align === "left"}   title="Left"   onClick={() => onUpdate({ align: "left" })}><AlignLeft className="h-4 w-4" /></Toggle>
        <Toggle active={a.align === "center"} title="Center" onClick={() => onUpdate({ align: "center" })}><AlignCenter className="h-4 w-4" /></Toggle>
        <Toggle active={a.align === "right"}  title="Right"  onClick={() => onUpdate({ align: "right" })}><AlignRight className="h-4 w-4" /></Toggle>
        <Divider />
        <ColorSwatch title="Text colour" value={a.color ?? "#000000"} onChange={(c) => onUpdate({ color: c })} />
        <FillSwatch title="Background" value={a.background}
          onChange={(c) => onUpdate({ background: c })}
          onClear={() => onUpdate({ background: undefined })} />
        <Divider />
      </>
    );
  }

  function ShapeToolbarSection({ a, onUpdate }: { a: ShapeAnnotation; onUpdate: (p: Partial<Annotation>) => void }) {
    return (
      <>
        <ColorSwatch title="Stroke" value={a.color ?? "#000000"} onChange={(c) => onUpdate({ color: c })} />
        {(a.kind === "rect" || a.kind === "ellipse") && (
          <FillSwatch title="Fill" value={a.fill}
            onChange={(c) => onUpdate({ fill: c } as Partial<ShapeAnnotation>)}
            onClear={() => onUpdate({ fill: undefined } as Partial<ShapeAnnotation>)} />
        )}
        <span className="flex items-center gap-1 px-1 text-[10px] text-[#5E6870]">
          <span className="font-medium">W</span>
          <input type="range" min={1} max={12} value={a.strokeWidth ?? 1}
            onChange={(e) => onUpdate({ strokeWidth: +e.target.value } as Partial<ShapeAnnotation>)}
            className="w-16 accent-[#0067AC]" />
          <span>{a.strokeWidth ?? 1}</span>
        </span>
        <Divider />
      </>
    );
  }

  function OpacityControl({ opacity, onChange }: { opacity: number; onChange: (v: number) => void }) {
    return (
      <span className="flex items-center gap-1 px-1 text-[10px] text-[#5E6870]" title="Opacity">
        <SlidersHorizontal className="h-3.5 w-3.5 text-[#9AA4AD]" />
        <input type="range" min={0} max={100} value={Math.round(opacity * 100)}
          onChange={(e) => onChange(Number(e.target.value) / 100)}
          className="w-14 accent-[#0067AC]" />
        <span className="w-7 tabular-nums">{Math.round(opacity * 100)}%</span>
      </span>
    );
  }

  /* ═══════════════════════════════════════════════════════════════════════ */
  /* Toolbar atoms                                                            */
  /* ═══════════════════════════════════════════════════════════════════════ */

  function Divider() { return <span className="mx-0.5 h-5 w-px bg-[#E1E5E8]" />; }

  function ToolBtn({ title, onClick, danger = false, children }: {
    title: string; onClick: () => void; danger?: boolean; children: React.ReactNode;
  }) {
    return (
      <button title={title}
        onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); onClick(); }}
        className={clsx("rounded-md p-1.5 transition",
          danger ? "text-red-500 hover:bg-red-50 hover:text-red-700" : "text-[#5E6870] hover:bg-[#F1F5F8] hover:text-[#0067AC]")}>
        {children}
      </button>
    );
  }

  function Toggle({ active, title, onClick, children }: {
    active: boolean; title: string; onClick: () => void; children: React.ReactNode;
  }) {
    return (
      <button title={title}
        onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); onClick(); }}
        className={clsx("rounded-md p-1.5 transition",
          active ? "bg-[#0067AC]/10 text-[#0067AC]" : "text-[#5E6870] hover:bg-[#F1F5F8]")}>
        {children}
      </button>
    );
  }

  function ColorSwatch({ value, onChange, title }: { value: string; onChange: (c: string) => void; title: string }) {
    const ref = useRef<HTMLInputElement>(null);
    return (
      <label title={title} className="flex h-7 w-7 cursor-pointer items-center justify-center rounded-md hover:bg-[#F1F5F8]">
        <span className="h-4 w-4 rounded border border-black/20 shadow-sm" style={{ background: value }} onClick={() => ref.current?.click()} />
        <input ref={ref} type="color" value={value} onChange={(e) => onChange(e.target.value)}
          onMouseDown={(e) => e.stopPropagation()} className="sr-only" />
      </label>
    );
  }

  function FillSwatch({ value, onChange, onClear, title }: {
    value?: string; onChange: (c: string) => void; onClear: () => void; title: string;
  }) {
    const ref = useRef<HTMLInputElement>(null);
    return (
      <span className="flex items-center gap-0.5" title={title}>
        <label className="relative flex h-7 w-7 cursor-pointer items-center justify-center rounded-md hover:bg-[#F1F5F8]">
          <PaintBucket className="h-4 w-4 text-[#5E6870]" />
          <span className="absolute bottom-0.5 right-0.5 h-2 w-2 rounded-sm border border-white shadow-sm"
            style={{ background: value ?? "transparent", ...(!value ? { backgroundImage: "linear-gradient(135deg,#ccc 25%,transparent 25%,transparent 75%,#ccc 75%)" } : {}) }}
            onClick={() => ref.current?.click()} />
          <input ref={ref} type="color" value={value ?? "#ffffff"} onChange={(e) => onChange(e.target.value)}
            onMouseDown={(e) => e.stopPropagation()} className="sr-only" />
        </label>
        {value && (
          <button title="Remove fill" onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); onClear(); }}
            className="rounded-md p-1 text-[#5E6870] hover:bg-[#F1F5F8]"><Ban className="h-3.5 w-3.5" /></button>
        )}
      </span>
    );
  }
  