/**
 * SignaturePad — self-contained signature creator (draw / type / upload).
 *
 * Produces a TRANSPARENT PNG data URL via `onChange`. Designed to be embedded
 * inside the signing flow so a signer can quickly create a *different*
 * signature without overwriting their saved one. Has its own undo/clear.
 *
 * It does NOT call your API. The parent decides whether to persist the result.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { PenLine, Type as TypeIcon, Upload, Undo2, Eraser } from "lucide-react";
import clsx from "clsx";
import UploadCurator from "./UploadCurator";

export type SignatureMode = "draw" | "type" | "upload";

type Point = { x: number; y: number; t: number };
type Stroke = { color: string; width: number; points: Point[] };

const INK_COLORS = [
  { id: "black", value: "#0d1117", label: "Onyx" },
  { id: "navy", value: "#1e3a8a", label: "Navy" },
  { id: "blue", value: "#2563eb", label: "Sapphire" },
];

const SCRIPT_FONTS = [
  { id: "dancing", label: "Elegant", css: `"Dancing Script", "Brush Script MT", cursive` },
  { id: "allura", label: "Refined", css: `"Allura", "Snell Roundhand", cursive` },
  { id: "great", label: "Classic", css: `"Great Vibes", "Apple Chancery", cursive` },
  { id: "caveat", label: "Natural", css: `"Caveat", "Marker Felt", cursive` },
];

const PEN_PRESETS = [
  { label: "Fine", value: 1.6 },
  { label: "Medium", value: 2.6 },
  { label: "Bold", value: 4.0 },
];

export interface SignaturePadProps {
  /** Called whenever a usable signature exists. Passes a transparent PNG data URL. */
  onChange: (dataUrl: string | null) => void;
  defaultName?: string;
  className?: string;
}

/** Trim transparent padding around drawn/typed signatures for a tight crop. */
function trimTransparent(source: HTMLCanvasElement): HTMLCanvasElement {
  const ctx = source.getContext("2d");
  if (!ctx) return source;
  const { width, height } = source;
  const { data } = ctx.getImageData(0, 0, width, height);
  let top = height, left = width, right = 0, bottom = 0, found = false;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (data[(y * width + x) * 4 + 3] > 8) {
        found = true;
        if (x < left) left = x;
        if (x > right) right = x;
        if (y < top) top = y;
        if (y > bottom) bottom = y;
      }
    }
  }
  if (!found) return source;
  const pad = 12;
  left = Math.max(0, left - pad);
  top = Math.max(0, top - pad);
  right = Math.min(width - 1, right + pad);
  bottom = Math.min(height - 1, bottom + pad);
  const w = right - left + 1;
  const h = bottom - top + 1;
  const out = document.createElement("canvas");
  out.width = w;
  out.height = h;
  out.getContext("2d")!.drawImage(source, left, top, w, h, 0, 0, w, h);
  return out;
}

export default function SignaturePad({ onChange, defaultName = "", className }: SignaturePadProps) {
  const [mode, setMode] = useState<SignatureMode>("draw");
  const [color, setColor] = useState(INK_COLORS[0].value);
  const [weight, setWeight] = useState(PEN_PRESETS[1].value);

  // draw state
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const strokesRef = useRef<Stroke[]>([]);
  const [strokeCount, setStrokeCount] = useState(0);
  const currentRef = useRef<Stroke | null>(null);
  const drawingRef = useRef(false);

  // type state
  const [typed, setTyped] = useState(defaultName);
  const [fontId, setFontId] = useState(SCRIPT_FONTS[0].id);
  const fontCss = SCRIPT_FONTS.find((f) => f.id === fontId)!.css;

  // upload state
  const [curatedSignature, setCuratedSignature] = useState<string | null>(null);

  /* ---- canvas sizing (Hi-DPI) ---- */
  useEffect(() => {
    if (mode !== "draw") return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const size = () => {
      const ratio = window.devicePixelRatio || 1;
      const rect = canvas.getBoundingClientRect();
      const w = Math.round(rect.width * ratio);
      const h = Math.round(rect.height * ratio);
      if (!w || !h) return;
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
        canvas.getContext("2d")!.scale(ratio, ratio);
      }
      redraw();
    };
    const ro = new ResizeObserver(size);
    ro.observe(canvas);
    size();
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode]);

  const redraw = () => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    const ratio = window.devicePixelRatio || 1;
    ctx.clearRect(0, 0, canvas.width / ratio, canvas.height / ratio);
    for (const s of strokesRef.current) drawStroke(ctx, s);
    if (currentRef.current) drawStroke(ctx, currentRef.current);
  };

  const drawStroke = (ctx: CanvasRenderingContext2D, s: Stroke) => {
    const pts = s.points || [];
    ctx.strokeStyle = s.color;
    ctx.fillStyle = s.color;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    if (pts.length === 1) {
      ctx.beginPath();
      ctx.arc(pts[0].x, pts[0].y, s.width * 0.6, 0, Math.PI * 2);
      ctx.fill();
      return;
    }
    for (let i = 1; i < pts.length; i++) {
      const p0 = pts[i - 1];
      const p1 = pts[i];
      const dt = Math.max(1, p1.t - p0.t);
      const v = Math.hypot(p1.x - p0.x, p1.y - p0.y) / dt;
      ctx.lineWidth = s.width * Math.max(0.45, Math.min(1.6, 1.4 - v * 1.6));
      const mid = { x: (p0.x + p1.x) / 2, y: (p0.y + p1.y) / 2 };
      const prevMid = i > 1 ? { x: (pts[i - 2].x + p0.x) / 2, y: (pts[i - 2].y + p0.y) / 2 } : p0;
      ctx.beginPath();
      ctx.moveTo(prevMid.x, prevMid.y);
      ctx.quadraticCurveTo(p0.x, p0.y, mid.x, mid.y);
      ctx.stroke();
    }
  };

  const getPoint = (e: React.PointerEvent<HTMLCanvasElement>): Point => {
    const r = e.currentTarget.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top, t: performance.now() };
  };

  const onDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    drawingRef.current = true;
    currentRef.current = { color, width: weight, points: [getPoint(e)] };
    redraw();
  };
  const onMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!drawingRef.current || !currentRef.current) return;
    e.preventDefault();
    currentRef.current.points.push(getPoint(e));
    redraw();
  };
  const onUp = () => {
    if (!drawingRef.current) return;
    drawingRef.current = false;
    if (currentRef.current?.points.length) {
      strokesRef.current = [...strokesRef.current, currentRef.current];
      setStrokeCount(strokesRef.current.length);
    }
    currentRef.current = null;
    redraw();
    emit();
  };

  const undo = () => {
    strokesRef.current = strokesRef.current.slice(0, -1);
    setStrokeCount(strokesRef.current.length);
    redraw();
    emit();
  };
  const clear = () => {
    strokesRef.current = [];
    setStrokeCount(0);
    redraw();
    onChange(null);
  };

  /* ---- rasterizers (transparent output) ---- */
  const renderDraw = (): string | null => {
    if (!strokesRef.current.length || !canvasRef.current) return null;
    const ratio = window.devicePixelRatio || 1;
    const tmp = document.createElement("canvas");
    tmp.width = canvasRef.current.width;
    tmp.height = canvasRef.current.height;
    const ctx = tmp.getContext("2d")!;
    ctx.scale(ratio, ratio);
    for (const s of strokesRef.current) drawStroke(ctx, s);
    return trimTransparent(tmp).toDataURL("image/png");
  };

  const renderTyped = (): string | null => {
    if (!typed.trim()) return null;
    const canvas = document.createElement("canvas");
    canvas.width = 1400;
    canvas.height = 420;
    const ctx = canvas.getContext("2d")!;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = color;
    ctx.textBaseline = "middle";
    ctx.font = `italic 170px ${fontCss}`;
    ctx.fillText(typed.trim(), 40, canvas.height / 2);
    return trimTransparent(canvas).toDataURL("image/png");
  };

  const emit = () => {
    if (mode === "draw") onChange(renderDraw());
    else if (mode === "type") onChange(renderTyped());
    else onChange(curatedSignature);
  };

  // re-emit when typed/font/color/mode/upload changes
  useEffect(() => {
    if (mode === "type") onChange(renderTyped());
    if (mode === "upload") onChange(curatedSignature);
    if (mode === "draw") onChange(renderDraw());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, typed, fontId, color, curatedSignature]);

  const handleCuratedChange = (dataUrl: string | null) => {
    setCuratedSignature(dataUrl);
  };

  const tabs = useMemo(
    () => [
      { id: "draw" as const, label: "Draw", icon: PenLine },
      { id: "type" as const, label: "Type", icon: TypeIcon },
      { id: "upload" as const, label: "Upload", icon: Upload },
    ],
    [],
  );

  return (
    <div className={clsx("rounded-lg border border-[#C8CDD2] bg-white", className)}>
      {/* tabs + ink */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[#C8CDD2] px-3 py-2">
        <div role="tablist" className="inline-flex overflow-hidden rounded-md border border-[#C8CDD2]">
          {tabs.map((t) => (
            <button
              key={t.id}
              role="tab"
              aria-selected={mode === t.id}
              onClick={() => setMode(t.id)}
              className={clsx(
                "flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium transition-colors",
                mode === t.id ? "bg-[#287EAD] text-white" : "bg-white text-[#5E6870] hover:bg-[#F1F5F8]",
              )}
            >
              <t.icon className="h-3.5 w-3.5" />
              {t.label}
            </button>
          ))}
        </div>

        {mode !== "upload" && (
          <div className="flex items-center gap-2">
            {INK_COLORS.map((c) => (
              <button
                key={c.id}
                title={c.label}
                onClick={() => setColor(c.value)}
                className={clsx(
                  "h-5 w-5 rounded-full border transition",
                  color === c.value ? "ring-2 ring-[#287EAD] ring-offset-1" : "border-[#C8CDD2]",
                )}
                style={{ backgroundColor: c.value }}
              />
            ))}
          </div>
        )}
      </div>

      {/* body */}
      <div className="p-3">
        {mode === "draw" && (
          <div>
            <div className="relative h-40 w-full overflow-hidden rounded-md border border-dashed border-[#C8CDD2] bg-[repeating-linear-gradient(45deg,#fafbfc,#fafbfc_10px,#f3f5f7_10px,#f3f5f7_20px)]">
              <canvas
                ref={canvasRef}
                className="h-full w-full touch-none"
                onPointerDown={onDown}
                onPointerMove={onMove}
                onPointerUp={onUp}
                onPointerCancel={onUp}
              />
              {strokeCount === 0 && (
                <span className="pointer-events-none absolute inset-0 flex items-center justify-center text-sm text-[#9AA4AD]">
                  Draw your signature here
                </span>
              )}
            </div>
            <div className="mt-2 flex items-center justify-between">
              <div className="flex items-center gap-1">
                {PEN_PRESETS.map((p) => (
                  <button
                    key={p.label}
                    onClick={() => setWeight(p.value)}
                    className={clsx(
                      "rounded border px-2 py-1 text-[11px]",
                      weight === p.value ? "border-[#287EAD] text-[#287EAD]" : "border-[#C8CDD2] text-[#5E6870]",
                    )}
                  >
                    {p.label}
                  </button>
                ))}
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={undo}
                  disabled={!strokeCount}
                  className="flex items-center gap-1 rounded border border-[#C8CDD2] px-2 py-1 text-[11px] text-[#5E6870] disabled:opacity-40"
                >
                  <Undo2 className="h-3.5 w-3.5" /> Undo
                </button>
                <button
                  onClick={clear}
                  disabled={!strokeCount}
                  className="flex items-center gap-1 rounded border border-[#C8CDD2] px-2 py-1 text-[11px] text-[#5E6870] disabled:opacity-40"
                >
                  <Eraser className="h-3.5 w-3.5" /> Clear
                </button>
              </div>
            </div>
          </div>
        )}

        {mode === "type" && (
          <div className="space-y-3">
            <input
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              placeholder="Type your full name"
              className="w-full rounded-md border border-[#C8CDD2] px-3 py-2 text-sm outline-none focus:border-[#287EAD]"
            />
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              {SCRIPT_FONTS.map((f) => (
                <button
                  key={f.id}
                  onClick={() => setFontId(f.id)}
                  className={clsx(
                    "truncate rounded-md border px-2 py-3 text-lg",
                    fontId === f.id ? "border-[#287EAD] bg-[#EEF6FB]" : "border-[#C8CDD2]",
                  )}
                  style={{ fontFamily: f.css, color }}
                >
                  {typed.trim() || "Signature"}
                </button>
              ))}
            </div>
          </div>
        )}

        {mode === "upload" && (
          <UploadCurator onChange={handleCuratedChange} />
        )}
      </div>
    </div>
  );
}
