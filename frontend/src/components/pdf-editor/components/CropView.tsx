/**
 * CropView — the "Crop" surface for a single page.
 *
 * Shows the active page with an interactive crop rectangle (drag to move, drag
 * a corner to resize) and a darkened mask over the discarded margins. Applying
 * stores a crop box on the page (PDF points, origin bottom-left) which
 * assemble() honours on export.
 *
 * Crop math is only reliable on un-rotated pages, so rotated pages show a hint
 * instead (rotate back to 0° to crop) — a wrong crop box is worse than none.
 */
import { useEffect, useRef, useState } from "react";
import { Check, Maximize2, RotateCcw } from "lucide-react";
import type { EditorPage, SourceDocument } from "../types";
import { renderPage } from "../pdfRender";

type Box = { x: number; y: number; w: number; h: number }; // fractions, top-left origin
type Handle = "nw" | "ne" | "sw" | "se";

interface Props {
  page: EditorPage;
  source: SourceDocument;
  zoom: number;
  onApply: (crop: { x: number; y: number; width: number; height: number }) => void;
  onReset: () => void;
}

const MIN = 0.05;

/** Current crop (PDF points, bottom-left) → overlay box (fractions, top-left). */
function cropToBox(page: EditorPage): Box {
  if (page.crop && page.width && page.height) {
    const W = page.width, H = page.height;
    return {
      x: page.crop.x / W,
      y: 1 - (page.crop.y + page.crop.height) / H,
      w: page.crop.width / W,
      h: page.crop.height / H,
    };
  }
  return { x: 0, y: 0, w: 1, h: 1 };
}

export default function CropView({ page, source, zoom, onApply, onReset }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [bg, setBg] = useState<string | null>(null);
  const [box, setBox] = useState<Box>(() => cropToBox(page));
  const drag = useRef<{ mode: "move" | "resize"; handle?: Handle; startX: number; startY: number; orig: Box } | null>(null);

  const rotated = ((page.rotation % 360) + 360) % 360 !== 0;

  useEffect(() => { setBox(cropToBox(page)); }, [page.id, page.crop]);

  useEffect(() => {
    let cancelled = false;
    setBg(null);
    renderPage(source.id, source.bytes, page.sourceIndex, {
      maxSize: 1400, rotation: page.rotation, mime: "image/jpeg", quality: 0.85,
    }).then((r) => { if (!cancelled) setBg(r.dataUrl); }).catch(() => {});
    return () => { cancelled = true; };
  }, [source.id, source.bytes, page.sourceIndex, page.rotation]);

  const toFrac = (cx: number, cy: number) => {
    const r = wrapRef.current!.getBoundingClientRect();
    return {
      x: Math.min(1, Math.max(0, (cx - r.left) / r.width)),
      y: Math.min(1, Math.max(0, (cy - r.top) / r.height)),
    };
  };

  const down = (e: React.MouseEvent, mode: "move" | "resize", handle?: Handle) => {
    e.stopPropagation();
    const { x, y } = toFrac(e.clientX, e.clientY);
    drag.current = { mode, handle, startX: x, startY: y, orig: box };
  };

  const move = (e: React.MouseEvent) => {
    const d = drag.current;
    if (!d) return;
    const { x, y } = toFrac(e.clientX, e.clientY);
    const o = d.orig;
    if (d.mode === "move") {
      const nx = Math.min(Math.max(0, o.x + (x - d.startX)), 1 - o.w);
      const ny = Math.min(Math.max(0, o.y + (y - d.startY)), 1 - o.h);
      setBox({ ...o, x: nx, y: ny });
      return;
    }
    let { x: nx, y: ny, w: nw, h: nh } = o;
    const right = o.x + o.w, bottom = o.y + o.h;
    if (d.handle!.includes("e")) nw = Math.max(MIN, Math.min(1 - o.x, x - o.x));
    if (d.handle!.includes("s")) nh = Math.max(MIN, Math.min(1 - o.y, y - o.y));
    if (d.handle!.includes("w")) { nx = Math.min(Math.max(0, x), right - MIN); nw = right - nx; }
    if (d.handle!.includes("n")) { ny = Math.min(Math.max(0, y), bottom - MIN); nh = bottom - ny; }
    setBox({ x: nx, y: ny, w: nw, h: nh });
  };

  const up = () => { drag.current = null; };

  const apply = () => {
    const W = page.width, H = page.height;
    onApply({ x: box.x * W, y: H * (1 - box.y - box.h), width: box.w * W, height: box.h * H });
  };

  const aspect = page.width / page.height;
  const isFull = box.x <= 0.001 && box.y <= 0.001 && box.w >= 0.999 && box.h >= 0.999;
  const pct = (n: number) => `${n * 100}%`;

  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-[#C8CDD2] bg-white px-4 py-2 text-sm">
        <span className="text-[#5E6870]">
          Crop page — drag the box or its corners, then apply.
        </span>
        <div className="flex-1" />
        <button onClick={() => setBox({ x: 0, y: 0, w: 1, h: 1 })}
          className="inline-flex items-center gap-1.5 rounded-md border border-[#C8CDD2] px-2.5 py-1.5 text-[#5E6870] hover:bg-[#F1F5F8]">
          <Maximize2 className="h-4 w-4" /> Whole page
        </button>
        {page.crop && (
          <button onClick={onReset}
            className="inline-flex items-center gap-1.5 rounded-md border border-[#C8CDD2] px-2.5 py-1.5 text-[#5E6870] hover:bg-[#F1F5F8]">
            <RotateCcw className="h-4 w-4" /> Clear crop
          </button>
        )}
        <button onClick={apply} disabled={rotated || isFull}
          className="inline-flex items-center gap-1.5 rounded-md bg-[#287EAD] px-3 py-1.5 font-medium text-white hover:bg-[#216C95] disabled:opacity-40">
          <Check className="h-4 w-4" /> Apply crop
        </button>
      </div>

      <div className="flex flex-1 items-start justify-center overflow-auto bg-[#EEF0F2] p-6">
        <div className="relative shadow-xl" style={{ width: `${680 * zoom}px`, maxWidth: "100%", aspectRatio: String(aspect) }}>
          <div
            ref={wrapRef}
            className="relative h-full w-full select-none bg-white"
            onMouseMove={move}
            onMouseUp={up}
            onMouseLeave={up}
          >
            {bg
              ? <img src={bg} alt="" draggable={false} className="pointer-events-none h-full w-full object-contain" />
              : <div className="flex h-full items-center justify-center text-sm text-[#C8CDD2]">Rendering…</div>}

            {rotated ? (
              <div className="absolute inset-0 flex items-center justify-center bg-black/40 p-6 text-center text-sm text-white">
                Rotate this page back to 0° to crop it accurately.
              </div>
            ) : (
              <>
                {/* darkened mask over the discarded margins */}
                <div className="pointer-events-none absolute inset-x-0 top-0 bg-black/45" style={{ height: pct(box.y) }} />
                <div className="pointer-events-none absolute inset-x-0 bottom-0 bg-black/45" style={{ height: pct(1 - box.y - box.h) }} />
                <div className="pointer-events-none absolute left-0 bg-black/45" style={{ top: pct(box.y), height: pct(box.h), width: pct(box.x) }} />
                <div className="pointer-events-none absolute right-0 bg-black/45" style={{ top: pct(box.y), height: pct(box.h), width: pct(1 - box.x - box.w) }} />

                {/* crop rectangle */}
                <div
                  className="absolute cursor-move outline outline-2 outline-white"
                  style={{ left: pct(box.x), top: pct(box.y), width: pct(box.w), height: pct(box.h) }}
                  onMouseDown={(e) => down(e, "move")}
                >
                  <div className="pointer-events-none absolute inset-0 border border-[#287EAD]/60" />
                  {(["nw", "ne", "sw", "se"] as Handle[]).map((h) => (
                    <span
                      key={h}
                      onMouseDown={(e) => down(e, "resize", h)}
                      className={[
                        "absolute h-3 w-3 rounded-sm border border-[#287EAD] bg-white",
                        h === "nw" && "-left-1.5 -top-1.5 cursor-nwse-resize",
                        h === "ne" && "-right-1.5 -top-1.5 cursor-nesw-resize",
                        h === "sw" && "-bottom-1.5 -left-1.5 cursor-nesw-resize",
                        h === "se" && "-bottom-1.5 -right-1.5 cursor-nwse-resize",
                      ].filter(Boolean).join(" ")}
                    />
                  ))}
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
