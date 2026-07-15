/**
 * PageOrganizer — the "Organize pages" surface.
 *
 *  • drag-and-drop reorder (native HTML5 DnD, no extra deps)
 *  • multi-select (click, shift-range, ctrl-toggle, select all)
 *  • per-page + bulk: rotate, delete/restore, duplicate, extract
 *  • lazy thumbnail rendering via pdf.js
 */
import { useEffect, useMemo, useRef, useState } from "react";
import {
  RotateCw, RotateCcw, Trash2, Copy, Download, CheckSquare,
  Square, Undo2, GripVertical, ZoomIn, ZoomOut, Pencil,
} from "lucide-react";
import clsx from "clsx";
import type { EditorPage, SourceDocument } from "../types";
import { renderPage } from "../pdfRender";

interface Props {
  pages: EditorPage[];
  sources: SourceDocument[];
  selected: Set<string>;
  onSelect: (next: Set<string>) => void;
  onReorder: (orderedIds: string[]) => void;
  onRotate: (ids: string[], delta: number) => void;
  onDelete: (ids: string[]) => void;
  onRestore: (ids: string[]) => void;
  onDuplicate: (ids: string[]) => void;
  onExtract: (ids: string[]) => void;
  /** Open a page straight into the edit canvas. */
  onOpen: (id: string) => void;
}

const THUMB_MIN = 110;
const THUMB_MAX = 300;
const THUMB_STEP = 40;

export default function PageOrganizer({
  pages, sources, selected, onSelect, onReorder,
  onRotate, onDelete, onRestore, onDuplicate, onExtract, onOpen,
}: Props) {
  const [thumbW, setThumbW] = useState(150);
  const sourceMap = useMemo(
    () => new Map(sources.map((s) => [s.id, s])),
    [sources],
  );
  const [thumbs, setThumbs] = useState<Record<string, string>>({});
  const [dragId, setDragId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);
  const lastClicked = useRef<string | null>(null);

  // lazily render thumbnails
  useEffect(() => {
    let cancelled = false;
    (async () => {
      for (const p of pages) {
        const key = `${p.id}:${p.rotation}`;
        if (thumbs[key]) continue;
        const src = sourceMap.get(p.sourceId);
        if (!src) continue;
        try {
          const { dataUrl } = await renderPage(src.id, src.bytes, p.sourceIndex, {
            maxSize: 220, rotation: p.rotation, mime: "image/jpeg", quality: 0.7,
          });
          if (cancelled) return;
          setThumbs((t) => ({ ...t, [key]: dataUrl }));
        } catch { /* ignore */ }
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pages, sourceMap]);

  const ids = pages.map((p) => p.id);
  const allSelected = ids.length > 0 && ids.every((id) => selected.has(id));

  const toggle = (id: string, e: React.MouseEvent) => {
    const next = new Set(selected);
    if (e.shiftKey && lastClicked.current) {
      // Shift-click extends a contiguous range from the last clicked page.
      const a = ids.indexOf(lastClicked.current);
      const b = ids.indexOf(id);
      for (let i = Math.min(a, b); i <= Math.max(a, b); i++) next.add(ids[i]);
    } else {
      // Plain (and Ctrl/Cmd) click toggles this page, accumulating a multi-select
      // like checkboxes — so users can pick several pages to extract/delete/etc.
      next.has(id) ? next.delete(id) : next.add(id);
    }
    lastClicked.current = id;
    onSelect(next);
  };

  const handleDrop = (targetId: string) => {
    if (!dragId || dragId === targetId) return;
    const moving = selected.has(dragId) ? ids.filter((id) => selected.has(id)) : [dragId];
    const rest = ids.filter((id) => !moving.includes(id));
    const at = rest.indexOf(targetId);
    const next = [...rest.slice(0, at), ...moving, ...rest.slice(at)];
    onReorder(next);
    setDragId(null);
    setOverId(null);
  };

  const selIds = [...selected];

  return (
    <div className="flex h-full flex-col">
      {/* toolbar */}
      <div className="flex flex-wrap items-center gap-2 border-b border-[#C8CDD2] px-4 py-2.5 text-sm">
        <button
          onClick={() => onSelect(allSelected ? new Set() : new Set(ids))}
          className="inline-flex items-center gap-1.5 rounded-md border border-[#C8CDD2] px-2.5 py-1.5 text-[#5E6870] hover:bg-[#F1F5F8]"
        >
          {allSelected ? <CheckSquare className="h-4 w-4" /> : <Square className="h-4 w-4" />}
          {allSelected ? "Deselect all" : "Select all"}
        </button>
        <span className="text-xs text-[#5E6870]">{selected.size} selected</span>
        <div className="mx-1 h-5 w-px bg-[#C8CDD2]" />
        <ToolBtn icon={RotateCcw} label="Rotate left" disabled={!selIds.length} onClick={() => onRotate(selIds, -90)} />
        <ToolBtn icon={RotateCw} label="Rotate right" disabled={!selIds.length} onClick={() => onRotate(selIds, 90)} />
        <ToolBtn icon={Copy} label="Duplicate" disabled={!selIds.length} onClick={() => onDuplicate(selIds)} />
        <ToolBtn icon={Download} label="Extract" title="Extract selected pages to a new PDF" disabled={!selIds.length} onClick={() => onExtract(selIds)} />
        <ToolBtn icon={Trash2} label="Delete" disabled={!selIds.length} danger onClick={() => onDelete(selIds)} />
        <ToolBtn icon={Undo2} label="Restore" disabled={!selIds.length} onClick={() => onRestore(selIds)} />

        <div className="ml-auto flex items-center gap-1">
          <span className="mr-1 hidden text-xs text-[#9AA4AD] md:inline">Click a page to edit · checkbox to select</span>
          <button title="Smaller thumbnails" disabled={thumbW <= THUMB_MIN}
            onClick={() => setThumbW((w) => Math.max(THUMB_MIN, w - THUMB_STEP))}
            className="rounded-md border border-[#C8CDD2] p-1.5 text-[#5E6870] hover:bg-[#F1F5F8] disabled:opacity-40">
            <ZoomOut className="h-4 w-4" />
          </button>
          <button title="Larger thumbnails" disabled={thumbW >= THUMB_MAX}
            onClick={() => setThumbW((w) => Math.min(THUMB_MAX, w + THUMB_STEP))}
            className="rounded-md border border-[#C8CDD2] p-1.5 text-[#5E6870] hover:bg-[#F1F5F8] disabled:opacity-40">
            <ZoomIn className="h-4 w-4" />
          </button>
        </div>
      </div>

      {/* grid */}
      <div
        className="grid flex-1 content-start gap-4 overflow-auto bg-[#F7F9FB] p-4"
        style={{ gridTemplateColumns: `repeat(auto-fill, minmax(${thumbW}px, 1fr))` }}
      >
        {pages.map((p, i) => {
          const key = `${p.id}:${p.rotation}`;
          const isSel = selected.has(p.id);
          return (
            <div
              key={p.id}
              draggable
              onDragStart={() => setDragId(p.id)}
              onDragOver={(e) => { e.preventDefault(); setOverId(p.id); }}
              onDrop={() => handleDrop(p.id)}
              onDragEnd={() => { setDragId(null); setOverId(null); }}
              onClick={() => onOpen(p.id)}
              onDoubleClick={() => onOpen(p.id)}
              title="Click to edit this page · use the checkbox to select"
              className={clsx(
                "group relative cursor-pointer rounded-lg border-2 bg-white p-2 transition",
                isSel ? "border-[#287EAD] shadow-sm" : "border-transparent hover:border-[#C8CDD2]",
                overId === p.id && dragId && "ring-2 ring-[#287EAD]",
                p.deleted && "opacity-40",
              )}
            >
              <div className="absolute left-1.5 top-1.5 z-10 cursor-grab text-[#5E6870] opacity-0 group-hover:opacity-100">
                <GripVertical className="h-4 w-4" />
              </div>
              {/* selection checkbox — click to (de)select; card click opens for edit */}
              <button
                type="button"
                title={isSel ? "Deselect page" : "Select page"}
                onClick={(e) => { e.stopPropagation(); toggle(p.id, e); }}
                className={clsx(
                  "absolute right-1.5 top-1.5 z-10 flex h-5 w-5 items-center justify-center rounded border transition",
                  isSel
                    ? "border-[#287EAD] bg-[#287EAD] text-white"
                    : "border-[#C8CDD2] bg-white/90 text-[#C8CDD2] hover:border-[#287EAD] hover:text-[#287EAD]",
                )}
              >
                {isSel ? <CheckSquare className="h-3.5 w-3.5" /> : <Square className="h-3.5 w-3.5" />}
              </button>
              <div className="relative flex aspect-[3/4] items-center justify-center overflow-hidden rounded bg-[#EEF1F4]">
                {thumbs[key] ? (
                  <img src={thumbs[key]} alt={`Page ${i + 1}`} className="h-full w-full object-contain" />
                ) : (
                  <div className="h-5 w-5 animate-pulse rounded-full bg-[#C8CDD2]" />
                )}
                {/* hover affordance making "click = edit" discoverable */}
                <span className="pointer-events-none absolute bottom-1 left-1/2 flex -translate-x-1/2 items-center gap-1 rounded bg-black/55 px-1.5 py-0.5 text-[10px] font-medium text-white opacity-0 transition group-hover:opacity-100">
                  <Pencil className="h-2.5 w-2.5" /> Edit
                </span>
              </div>
              <div className="mt-1.5 flex items-center justify-between text-xs text-[#5E6870]">
                <span>{i + 1}</span>
                {p.deleted && <span className="text-red-500">deleted</span>}
              </div>
              {/* quick actions */}
              <div className="absolute inset-x-0 bottom-9 flex justify-center gap-1 opacity-0 transition group-hover:opacity-100">
                <QuickBtn icon={RotateCw} title="Rotate right" onClick={(e) => { e.stopPropagation(); onRotate([p.id], 90); }} />
                <QuickBtn icon={Copy} title="Duplicate page" onClick={(e) => { e.stopPropagation(); onDuplicate([p.id]); }} />
                <QuickBtn icon={Trash2} danger title={p.deleted ? "Restore page" : "Delete page"} onClick={(e) => { e.stopPropagation(); p.deleted ? onRestore([p.id]) : onDelete([p.id]); }} />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function ToolBtn({
  icon: Icon, label, onClick, disabled, danger, title,
}: { icon: typeof RotateCw; label: string; onClick: () => void; disabled?: boolean; danger?: boolean; title?: string }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title ?? label}
      className={clsx(
        "inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 transition disabled:cursor-not-allowed disabled:opacity-40",
        danger
          ? "border-[#C8CDD2] text-red-600 hover:bg-red-50"
          : "border-[#C8CDD2] text-[#5E6870] hover:bg-[#F1F5F8]",
      )}
    >
      <Icon className="h-4 w-4" />
      <span className="hidden sm:inline">{label}</span>
    </button>
  );
}

function QuickBtn({
  icon: Icon, onClick, danger, title,
}: { icon: typeof RotateCw; onClick: (e: React.MouseEvent) => void; danger?: boolean; title?: string }) {
  return (
    <button
      onClick={onClick}
      title={title}
      className={clsx(
        "rounded-md bg-white/95 p-1.5 shadow ring-1 ring-[#C8CDD2] transition hover:scale-105",
        danger ? "text-red-600" : "text-[#5E6870]",
      )}
    >
      <Icon className="h-3.5 w-3.5" />
    </button>
  );
}