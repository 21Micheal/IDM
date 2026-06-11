// src/components/profile/SignaturePanel.tsx
import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  FileSignature, PenLine, Type as TypeIcon, Upload, Undo2,
  Loader2, Shield, CheckCircle2, Trash2, Download, Image as ImageIcon,
  Info, ZoomIn, RotateCcw, Sparkles, Lock, Clock, User,
} from "lucide-react";
import clsx from "clsx";
import { profileAPI } from "@/services/api";
import { useAuthStore } from "@/store/authStore";
import { toast } from "@/components/ui/vault-toast";

/* ---------- types ---------- */
type SignatureMode = "draw" | "type" | "upload";
interface SavedSignature {
  id: string;
  method: SignatureMode;
  typed_name?: string;
  image_url?: string;
  image_data?: string;
  created_at: string;
}
type Point = { x: number; y: number; t: number };
type Stroke = { color: string; width: number; points: Point[] };

const INK_COLORS = [
  { id: "black", value: "#0d1117", label: "Onyx" },
  { id: "navy",  value: "#1e3a8a", label: "Navy" },
  { id: "blue",  value: "#2563eb", label: "Sapphire" },
];

const SCRIPT_FONTS = [
  { id: "dancing",   label: "Elegant",     css: `"Dancing Script", "Brush Script MT", cursive` },
  { id: "allura",    label: "Refined",     css: `"Allura", "Snell Roundhand", cursive` },
  { id: "great",     label: "Classic",     css: `"Great Vibes", "Apple Chancery", cursive` },
  { id: "homemade",  label: "Handwritten", css: `"Homemade Apple", "Bradley Hand", cursive` },
  { id: "caveat",    label: "Natural",     css: `"Caveat", "Marker Felt", cursive` },
];

const PEN_PRESETS = [
  { label: "Fine",   value: 1.4 },
  { label: "Medium", value: 2.4 },
  { label: "Bold",   value: 3.8 },
];

async function dataUrlToFile(dataUrl: string, filename: string) {
  const res = await fetch(dataUrl);
  const blob = await res.blob();
  return new File([blob], filename, { type: blob.type || "image/png" });
}

/* ---------- component ---------- */
export default function SignaturePanel() {
  const qc = useQueryClient();
  const user = useAuthStore((s) => s.user);
  const fullName = `${user?.first_name ?? ""} ${user?.last_name ?? ""}`.trim() || "Your Name";
  const initials = (user?.first_name?.[0] ?? "") + (user?.last_name?.[0] ?? "");

  const [mode, setMode] = useState<SignatureMode>("draw");
  const [color, setColor] = useState(INK_COLORS[0].value);
  const [weight, setWeight] = useState(PEN_PRESETS[1].value);
  const [showGuide, setShowGuide] = useState(true);
  const [isCanvasHovered, setIsCanvasHovered] = useState(false);

  // Draw state
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [strokes, setStrokes] = useState<Stroke[]>([]);
  const strokesRef = useRef<Stroke[]>([]);
  const currentRef = useRef<Stroke | null>(null);
  const drawingRef = useRef(false);

  // Type state
  const [typedSignature, setTypedSignature] = useState(fullName);
  const [typedInitials, setTypedInitials] = useState(initials);
  const [fontId, setFontId] = useState(SCRIPT_FONTS[0].id);
  const fontCss = SCRIPT_FONTS.find((f) => f.id === fontId)!.css;

  // Upload state
  const [uploadedFile, setUploadedFile] = useState<File | null>(null);
  const [uploadedPreview, setUploadedPreview] = useState<string | null>(null);
  const [dragActive, setDragActive] = useState(false);

  const [consent, setConsent] = useState(false);
  const [previewZoomed, setPreviewZoomed] = useState(false);

  /* ----- query ----- */
  const { data: savedSignature, isLoading } = useQuery<SavedSignature | null>({
    queryKey: ["profile-signature"],
    queryFn: () => profileAPI.getSignature().then((r) => r.data.signature ?? null),
  });

  /* ----- Hi-DPI canvas setup via ResizeObserver ----- */
  // We size the canvas ONCE when it first mounts (or when the draw panel re-mounts after
  // a mode switch) using a ResizeObserver so we always get the real laid-out dimensions.
  // Setting canvas.width / canvas.height erases all pixel data, so we ONLY do it when
  // the physical pixel size has actually changed — never mid-stroke.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const sizeAndRedraw = () => {
      const ratio = window.devicePixelRatio || 1;
      const rect  = canvas.getBoundingClientRect();
      const newW  = Math.round(rect.width  * ratio);
      const newH  = Math.round(rect.height * ratio);
      if (newW === 0 || newH === 0) return; // not laid out yet — observer will fire again
      if (canvas.width !== newW || canvas.height !== newH) {
        // Only resize (which clears the bitmap) when dimensions genuinely changed
        canvas.width  = newW;
        canvas.height = newH;
        const ctx = canvas.getContext("2d");
        if (ctx) ctx.scale(ratio, ratio);
      }
      redraw();
    };

    const ro = new ResizeObserver(sizeAndRedraw);
    ro.observe(canvas);
    // Also run immediately in case the element is already laid out
    sizeAndRedraw();
    return () => ro.disconnect();
  }, [mode]);

  useEffect(() => { redraw(); }, [strokes, showGuide, color]);

  const commitStrokes = (next: Stroke[]) => {
    strokesRef.current = next;
    setStrokes(next);
  };

  const redraw = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const ratio = window.devicePixelRatio || 1;
    const w = canvas.width / ratio;
    const h = canvas.height / ratio;
    ctx.clearRect(0, 0, w, h);

    if (showGuide) {
      ctx.save();
      // Subtle dot grid
      ctx.fillStyle = "rgba(100,116,139,0.12)";
      for (let x = 24; x < w - 24; x += 28) {
        for (let y = 20; y < h - 20; y += 28) {
          ctx.beginPath();
          ctx.arc(x, y, 1, 0, Math.PI * 2);
          ctx.fill();
        }
      }
      // Baseline
      ctx.strokeStyle = "rgba(99,102,241,0.18)";
      ctx.setLineDash([6, 8]);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(32, h * 0.74);
      ctx.lineTo(w - 32, h * 0.74);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = "rgba(99,102,241,0.45)";
      ctx.font = "10px ui-sans-serif, system-ui";
      ctx.fillText("Sign above", 32, h * 0.74 + 14);
      ctx.restore();
    }

    for (const s of strokesRef.current) drawStroke(ctx, s);
    if (currentRef.current) drawStroke(ctx, currentRef.current);
  };

  const drawStroke = (ctx: CanvasRenderingContext2D, s: Stroke) => {
    const pts = s?.points || [];
    if (pts.length < 2) {
      if (pts.length === 1) {
        ctx.fillStyle = s.color;
        ctx.beginPath();
        ctx.arc(pts[0].x, pts[0].y, s.width * 0.6, 0, Math.PI * 2);
        ctx.fill();
      }
      return;
    }
    ctx.strokeStyle = s.color;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";

    for (let i = 1; i < pts.length; i++) {
      const p0 = pts[i - 1];
      const p1 = pts[i];
      const dt = Math.max(1, p1.t - p0.t);
      const dist = Math.hypot(p1.x - p0.x, p1.y - p0.y);
      const velocity = dist / dt;
      const target = s.width * Math.max(0.45, Math.min(1.6, 1.4 - velocity * 1.6));
      ctx.lineWidth = target;
      const mid = { x: (p0.x + p1.x) / 2, y: (p0.y + p1.y) / 2 };
      const prevMid = i > 1
        ? { x: (pts[i - 2].x + p0.x) / 2, y: (pts[i - 2].y + p0.y) / 2 }
        : p0;
      ctx.beginPath();
      ctx.moveTo(prevMid.x, prevMid.y);
      ctx.quadraticCurveTo(p0.x, p0.y, mid.x, mid.y);
      ctx.stroke();
    }
  };

  /* ----- pointer handlers ----- */
  const getPoint = (e: React.PointerEvent<HTMLCanvasElement>): Point => {
    const r = e.currentTarget.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top, t: performance.now() };
  };
  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    drawingRef.current = true;
    currentRef.current = { color, width: weight, points: [getPoint(e)] };
    redraw();
  };
  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!drawingRef.current || !currentRef.current) return;
    e.preventDefault();
    currentRef.current.points.push(getPoint(e));
    redraw();
  };
  const finishDrawing = (e?: React.PointerEvent<HTMLCanvasElement>) => {
    if (!drawingRef.current) return;
    e?.preventDefault();
    drawingRef.current = false;
    if (currentRef.current && currentRef.current.points.length) {
      commitStrokes([...strokesRef.current, currentRef.current]);
    }
    currentRef.current = null;
    redraw();
  };

  const undo  = () => commitStrokes(strokesRef.current.slice(0, -1));
  const clear = () => commitStrokes([]);

  /* ----- typed preview canvas rendering (for save) ----- */
  const renderTypedToCanvas = () => {
    const canvas = document.createElement("canvas");
    canvas.width = 1200; canvas.height = 360;
    const ctx = canvas.getContext("2d")!;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = color;
    ctx.textBaseline = "middle";
    ctx.font = `italic 140px ${fontCss}`;
    ctx.fillText(typedSignature.trim(), 60, canvas.height / 2);
    return canvas;
  };

  const renderDrawToCanvas = () => {
    const src = canvasRef.current!;
    const out = document.createElement("canvas");
    out.width = src.width; out.height = src.height;
    const ctx = out.getContext("2d")!;
    const ratio = window.devicePixelRatio || 1;
    ctx.scale(ratio, ratio);
    for (const s of strokesRef.current) drawStroke(ctx, s);
    return out;
  };

  /* ----- upload handlers ----- */
  const handleFiles = (file: File | null) => {
    if (!file) return;
    if (!/^image\/(png|jpeg)$/.test(file.type)) {
      toast.error("Only PNG or JPG images are allowed");
      return;
    }
    if (file.size > 2 * 1024 * 1024) {
      toast.error("Image must be smaller than 2 MB");
      return;
    }
    setUploadedFile(file);
    const reader = new FileReader();
    reader.onload = () => setUploadedPreview(reader.result as string);
    reader.readAsDataURL(file);
  };

  /* ----- save / delete ----- */
  const saveMutation = useMutation({
    mutationFn: async () => {
      if (!consent) throw new Error("Please confirm the e-signature consent");
      const form = new FormData();
      form.append("method", mode);
      if (mode === "draw") {
        if (strokesRef.current.length === 0) throw new Error("Draw your signature first");
        form.append("image", await dataUrlToFile(renderDrawToCanvas().toDataURL("image/png"), "signature.png"));
      } else if (mode === "type") {
        if (!typedSignature.trim()) throw new Error("Type your signature first");
        form.append("typed_name", typedSignature.trim());
        form.append("font", fontId);
        form.append("image", await dataUrlToFile(renderTypedToCanvas().toDataURL("image/png"), "typed-signature.png"));
      } else {
        if (!uploadedFile) throw new Error("Choose a signature image first");
        form.append("image", uploadedFile);
      }
      return profileAPI.saveSignature(form);
    },
    onSuccess: () => {
      toast.success("Signature saved securely");
      qc.invalidateQueries({ queryKey: ["profile-signature"] });
      setUploadedFile(null); setUploadedPreview(null); commitStrokes([]);
    },
    onError: (err: any) =>
      toast.error(err?.response?.data?.detail || err?.message || "Failed to save signature"),
  });

  const deleteMutation = useMutation({
    mutationFn: () => profileAPI.deleteSignature(),
    onSuccess: () => {
      toast.success("Signature removed");
      qc.invalidateQueries({ queryKey: ["profile-signature"] });
    },
    onError: () => toast.error("Failed to remove signature"),
  });

  const canSave = useMemo(() => {
    if (!consent) return false;
    if (mode === "draw")   return strokes.length > 0;
    if (mode === "type")   return typedSignature.trim().length > 0;
    if (mode === "upload") return !!uploadedFile;
    return false;
  }, [mode, strokes, typedSignature, uploadedFile, consent]);

  const _hasContent =
    (mode === "draw" && strokes.length > 0) ||
    (mode === "type" && typedSignature.trim().length > 0) ||
    (mode === "upload" && !!uploadedPreview);

  void _hasContent;

  /* ---------- UI ---------- */
  return (
    <div className="overflow-hidden border border-[#C8CDD2] bg-white text-[#1F2933]">

      {/* ── Top bar: document-style header ── */}
      <div className="flex items-center justify-between gap-4 border-b border-[#C8CDD2] bg-[#F5F7F8] px-5 py-4">
        <div className="flex items-center gap-3">
          <div className="flex h-9 w-9 items-center justify-center bg-[#DCEAF2]">
            <FileSignature className="h-5 w-5 text-[#287EAD]" />
          </div>
          <div>
            <h3 className="text-sm font-semibold leading-tight tracking-tight text-[#1F2933]">Electronic Signature</h3>
            <p className="mt-0.5 text-[11px] text-[#5E6870]">Legally binding · ESIGN Act / eIDAS compliant</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <span className="hidden items-center gap-1.5 border border-[#C8CDD2] bg-white px-2.5 py-1 text-[11px] font-medium text-[#0F7A3A] sm:inline-flex">
            <Lock className="w-3 h-3" /> Encrypted at rest
          </span>
          {savedSignature && (
            <span className="hidden items-center gap-1.5 border border-[#C8CDD2] bg-white px-2.5 py-1 text-[11px] font-medium text-[#287EAD] sm:inline-flex">
              <CheckCircle2 className="w-3 h-3" /> Signature on file
            </span>
          )}
        </div>
      </div>

      {/* ── Step progress bar ── */}
      <div className="flex items-center gap-0 border-b border-[#C8CDD2] bg-white text-xs font-medium">
        {[
          { n: "1", label: "Create signature" },
          { n: "2", label: "Review & agree" },
          { n: "3", label: "Save" },
        ].map((step, i) => (
          <div
            key={step.n}
            className={clsx(
              "flex items-center gap-2 border-r border-[#C8CDD2] px-5 py-2.5 last:border-r-0",
              i === 0 ? "bg-[#EEF6FB] text-[#287EAD]" : "text-[#5E6870]"
            )}
          >
            <span className={clsx(
              "flex h-5 w-5 items-center justify-center text-[10px] font-bold",
              i === 0 ? "bg-[#287EAD] text-white" : "bg-[#E1E5E8] text-[#5E6870]"
            )}>{step.n}</span>
            <span className="hidden sm:inline">{step.label}</span>
          </div>
        ))}
      </div>

      {/* ── Main two-column body ── */}
      <div className="grid grid-cols-1 divide-y divide-[#C8CDD2] xl:grid-cols-[minmax(0,1.45fr)_minmax(360px,0.75fr)] xl:divide-x xl:divide-y-0">

        {/* ══ LEFT: Editor ══ */}
        <div className="space-y-5 p-5">

          {/* Mode tabs */}
          <div className="flex items-center gap-3 flex-wrap">
            <div
              role="tablist"
              className="inline-flex border border-[#C8CDD2] bg-white"
            >
              {([
                { id: "draw"   as const, label: "Draw",   icon: PenLine  },
                { id: "type"   as const, label: "Type",   icon: TypeIcon },
                { id: "upload" as const, label: "Upload", icon: Upload   },
              ] as const).map((it) => (
                <button
                  key={it.id}
                  role="tab"
                  aria-selected={mode === it.id}
                  onClick={() => setMode(it.id)}
                  className={clsx(
                    "flex items-center gap-2 border-r border-[#C8CDD2] px-4 py-2 text-sm font-medium transition-colors last:border-r-0",
                    mode === it.id
                      ? "bg-[#EEF6FB] text-[#287EAD]"
                      : "text-[#5E6870] hover:bg-[#F5F7F8] hover:text-[#1F2933]"
                  )}
                >
                  <it.icon className="w-4 h-4" />
                  {it.label}
                </button>
              ))}
            </div>

            {/* Draw tool options */}
            {mode === "draw" && (
              <div className="flex items-center gap-4 ml-auto flex-wrap">
                {/* Color swatches */}
                <div className="flex items-center gap-1.5">
                  {INK_COLORS.map((c) => (
                    <button
                      key={c.id}
                      title={c.label}
                      onClick={() => setColor(c.value)}
                      className={clsx("h-6 w-6 border border-[#C8CDD2] transition-transform hover:scale-105", color === c.value && "outline outline-2 outline-[#287EAD] outline-offset-2")}
                      style={{ backgroundColor: c.value }}
                    />
                  ))}
                </div>

                {/* Pen weight presets */}
                <div className="flex items-center border border-[#C8CDD2] bg-white">
                  {PEN_PRESETS.map((p) => (
                    <button
                      key={p.label}
                      onClick={() => setWeight(p.value)}
                      className={clsx(
                        "border-r border-[#C8CDD2] px-2.5 py-1 text-xs font-medium transition-colors last:border-r-0",
                        weight === p.value
                          ? "bg-[#287EAD] text-white"
                          : "text-[#5E6870] hover:bg-[#F5F7F8] hover:text-[#1F2933]"
                      )}
                    >
                      {p.label}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* ── DRAW canvas ── */}
          {mode === "draw" && (
            <div className="space-y-3">
              <div
                className={clsx(
                  "overflow-hidden border transition-colors",
                  "bg-white",
                  isCanvasHovered
                    ? "border-[#287EAD]"
                    : "border-[#C8CDD2]"
                )}
                onMouseEnter={() => setIsCanvasHovered(true)}
                onMouseLeave={() => setIsCanvasHovered(false)}
              >
                {/* Toolbar ribbon in normal flow above the canvas — NOT absolute,
                    so getBoundingClientRect on the canvas only measures the canvas */}
                <div className="flex items-center justify-between border-b border-[#C8CDD2] bg-[#F5F7F8] px-3 py-1.5">
                  <span className="text-[10px] uppercase tracking-wider text-[#5E6870]">Signature field</span>
                  <div className="flex items-center gap-1">
                    <button
                      onClick={undo}
                      disabled={!strokes.length}
                      title="Undo"
                      className="p-1 text-[#5E6870] transition-colors hover:bg-[#EDEDED] hover:text-[#1F2933] disabled:opacity-30"
                    >
                      <Undo2 className="w-3.5 h-3.5" />
                    </button>
                    <button
                      onClick={clear}
                      disabled={!strokes.length}
                      title="Clear"
                      className="p-1 text-[#5E6870] transition-colors hover:bg-[#EDEDED] hover:text-[#1F2933] disabled:opacity-30"
                    >
                      <RotateCcw className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>

                {/* Canvas wrapper with placeholder overlay */}
                <div className="relative">
                  <canvas
                    ref={canvasRef}
                    className="block w-full touch-none"
                    style={{ height: "200px", cursor: "crosshair" }}
                    onPointerDown={onPointerDown}
                    onPointerMove={onPointerMove}
                    onPointerUp={finishDrawing}
                    onPointerCancel={finishDrawing}
                  />
                  {strokes.length === 0 && !drawingRef.current && (
                    <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-1">
                      <PenLine className="h-8 w-8 text-[#A8B0B7]" />
                      <span className="text-sm font-light italic text-[#7C8790]">Draw your signature here</span>
                    </div>
                  )}
                </div>
              </div>

              <div className="flex items-center justify-between gap-3">
                <label className="flex items-center gap-2 text-xs text-muted-foreground cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={showGuide}
                    onChange={(e) => setShowGuide(e.target.checked)}
                    className="accent-[#287EAD]"
                  />
                  Show guide grid & baseline
                </label>
                {strokes.length > 0 && (
                  <span className="flex items-center gap-1 text-xs text-[#287EAD]">
                    <Sparkles className="w-3 h-3" />
                    {strokes.length} stroke{strokes.length !== 1 ? "s" : ""}
                  </span>
                )}
              </div>
            </div>
          )}

          {/* ── TYPE mode ── */}
          {mode === "type" && (
            <div className="space-y-5">
              {/* Inputs */}
              <div className="grid grid-cols-1 sm:grid-cols-[1fr_140px] gap-3">
                <div>
                  <label className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-[#5E6870]">Full Legal Name</label>
                  <input
                    value={typedSignature}
                    onChange={(e) => setTypedSignature(e.target.value)}
                    className="input"
                    placeholder="Type your full legal name"
                    maxLength={64}
                  />
                </div>
                <div>
                  <label className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-[#5E6870]">Initials</label>
                  <input
                    value={typedInitials}
                    onChange={(e) => setTypedInitials(e.target.value.toUpperCase().slice(0, 4))}
                    className="input uppercase tracking-widest"
                  />
                </div>
              </div>

              {/* Color pick */}
              <div className="flex items-center gap-3">
                <span className="text-xs font-semibold uppercase tracking-wide text-[#5E6870]">Ink Color</span>
                <div className="flex items-center gap-1.5">
                  {INK_COLORS.map((c) => (
                    <button
                      key={c.id}
                      title={c.label}
                      onClick={() => setColor(c.value)}
                      className={clsx("h-6 w-6 border border-[#C8CDD2] transition-transform hover:scale-105", color === c.value && "outline outline-2 outline-[#287EAD] outline-offset-2")}
                      style={{ backgroundColor: c.value }}
                    />
                  ))}
                </div>
              </div>

              {/* Font style grid */}
              <div>
                <p className="mb-3 text-xs font-semibold uppercase tracking-wide text-[#5E6870]">Choose a Style</p>
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
                  {SCRIPT_FONTS.map((f) => {
                    const active = fontId === f.id;
                    return (
                      <button
                        key={f.id}
                        onClick={() => setFontId(f.id)}
                        className={clsx(
                          "group relative overflow-hidden border bg-white px-4 py-3.5 text-left transition-colors",
                          active
                            ? "border-[#287EAD] bg-[#EEF6FB]"
                            : "border-[#C8CDD2] hover:border-[#287EAD]"
                        )}
                      >
                        {active && (
                          <div className="absolute top-2 right-2">
                            <CheckCircle2 className="h-3.5 w-3.5 text-[#287EAD]" />
                          </div>
                        )}
                        <span
                          className="block truncate text-2xl leading-snug"
                          style={{ fontFamily: f.css, fontStyle: "italic", color }}
                        >
                          {typedSignature || fullName}
                        </span>
                        <span className={clsx(
                          "block mt-1.5 text-[10px] uppercase tracking-wider",
                          active ? "font-semibold text-[#287EAD]" : "text-[#5E6870]"
                        )}>
                          {f.label}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Live preview strip */}
              {typedSignature.trim() && (
                <div className="border border-dashed border-[#A7CDE3] bg-[#F7FAFC] p-5 text-center">
                  <p className="mb-2 text-[10px] font-medium uppercase tracking-widest text-[#287EAD]">Live Preview</p>
                  <div
                    className="text-4xl leading-none"
                    style={{ fontFamily: fontCss, fontStyle: "italic", color }}
                  >
                    {typedSignature}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* ── UPLOAD mode ── */}
          {mode === "upload" && (
            <div className="space-y-4">
              <label
                onDragOver={(e) => { e.preventDefault(); setDragActive(true); }}
                onDragLeave={() => setDragActive(false)}
                onDrop={(e) => {
                  e.preventDefault(); setDragActive(false);
                  handleFiles(e.dataTransfer.files?.[0] ?? null);
                }}
                className={clsx(
                  "flex cursor-pointer flex-col items-center justify-center gap-3 border border-dashed px-6 py-12 transition-colors",
                  dragActive
                    ? "border-[#287EAD] bg-[#EEF6FB]"
                    : "border-[#C8CDD2] bg-[#F7F8F9] hover:border-[#287EAD] hover:bg-white"
                )}
              >
                <div className={clsx(
                  "flex h-14 w-14 items-center justify-center transition-colors",
                  dragActive ? "bg-[#DCEAF2]" : "border border-[#C8CDD2] bg-white"
                )}>
                  {dragActive
                    ? <Upload className="h-7 w-7 text-[#287EAD]" />
                    : <ImageIcon className="h-7 w-7 text-[#5E6870]" />
                  }
                </div>
                <div className="text-center">
                  <p className="text-sm font-semibold text-foreground">
                    {uploadedFile ? uploadedFile.name : "Drop your signature image here"}
                  </p>
                  <p className="text-xs text-muted-foreground mt-1">
                    or <span className="font-medium text-[#287EAD]">click to browse</span> · PNG or JPG · max 2 MB
                  </p>
                  <p className="text-xs text-muted-foreground mt-0.5">Transparent background recommended</p>
                </div>
                <input
                  type="file"
                  accept="image/png,image/jpeg"
                  className="hidden"
                  onChange={(e) => handleFiles(e.target.files?.[0] ?? null)}
                />
              </label>

              {uploadedPreview && (
                <div className="flex flex-col items-center gap-3 border border-[#C8CDD2] bg-[#F7F8F9] p-6">
                  <img src={uploadedPreview} alt="Preview" className="max-h-36 max-w-full object-contain" />
                  <button
                    onClick={() => { setUploadedFile(null); setUploadedPreview(null); }}
                    className="text-xs text-muted-foreground hover:text-destructive flex items-center gap-1.5 transition-colors"
                  >
                    <Trash2 className="w-3.5 h-3.5" /> Remove image
                  </button>
                </div>
              )}
            </div>
          )}

          {/* ── Consent & Save ── */}
          <div className="space-y-4 pt-2 border-t border-border">
            <div className={clsx(
              "border p-4 transition-colors",
              consent ? "border-[#93C5A4] bg-[#F0FAF3]" : "border-[#C8CDD2] bg-[#F7F8F9]"
            )}>
              <label className="flex gap-3 items-start cursor-pointer">
                <div className="mt-0.5">
                  <input
                    type="checkbox"
                    checked={consent}
                    onChange={(e) => setConsent(e.target.checked)}
                    className="h-4 w-4 cursor-pointer accent-[#287EAD]"
                  />
                </div>
                <div>
                  <p className={clsx("mb-0.5 text-xs font-semibold", consent ? "text-[#0F7A3A]" : "text-[#1F2933]")}>
                    I adopt this as my legal electronic signature
                  </p>
                  <p className="text-xs text-muted-foreground leading-relaxed">
                    By checking this box, I agree that this electronic signature is the legal equivalent of my handwritten signature and may be used to sign documents in accordance with the ESIGN Act / eIDAS.
                  </p>
                </div>
              </label>
            </div>

            <div className="flex items-center justify-between gap-4">
              <p className="text-xs text-muted-foreground flex items-center gap-1.5">
                <Info className="w-3.5 h-3.5 flex-shrink-0" />
                Applied only with your explicit signing action
              </p>
              <button
                onClick={() => saveMutation.mutate()}
                disabled={!canSave || saveMutation.isPending}
                className={clsx(
                  "inline-flex items-center gap-2 px-5 py-2.5 text-sm font-semibold transition-colors",
                  canSave && !saveMutation.isPending
                    ? "bg-[#287EAD] text-white hover:bg-[#206D99]"
                    : "cursor-not-allowed bg-[#E1E5E8] text-[#6E767D]"
                )}
              >
                {saveMutation.isPending
                  ? <><Loader2 className="w-4 h-4 animate-spin" /> Saving…</>
                  : <><CheckCircle2 className="w-4 h-4" /> Adopt &amp; Save Signature</>
                }
              </button>
            </div>
          </div>
        </div>

        {/* ══ RIGHT: Current signature / preview pane ══ */}
        <div className="space-y-5 bg-[#F7F8F9] p-5">
          {/* Section title */}
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-semibold text-foreground">Signature on File</p>
              <p className="text-xs text-muted-foreground mt-0.5">How it appears on signed documents</p>
            </div>
            {savedSignature && (
              <button
                onClick={() => deleteMutation.mutate()}
                disabled={deleteMutation.isPending}
                className="inline-flex items-center gap-1.5 border border-[#D9A6A0] bg-white px-3 py-1.5 text-xs font-medium text-[#B42318] transition-colors hover:bg-[#FFF1F0]"
              >
                {deleteMutation.isPending
                  ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  : <Trash2 className="w-3.5 h-3.5" />
                }
                Remove
              </button>
            )}
          </div>

          {isLoading ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground py-16 justify-center">
              <Loader2 className="w-4 h-4 animate-spin" /> Loading…
            </div>
          ) : savedSignature ? (
            <div className="space-y-4">
              {/* Document preview frame */}
              <div
                className={clsx(
                  "cursor-pointer overflow-hidden border border-[#C8CDD2] bg-white transition-colors",
                  previewZoomed ? "outline outline-2 outline-[#287EAD]" : "hover:border-[#287EAD]"
                )}
                onClick={() => setPreviewZoomed(!previewZoomed)}
              >
                {/* Doc toolbar */}
                <div className="flex items-center justify-between border-b border-[#C8CDD2] bg-[#F5F7F8] px-4 py-2">
                  <div className="flex items-center gap-1.5">
                    <div className="h-2.5 w-2.5 bg-[#D14343]" />
                    <div className="h-2.5 w-2.5 bg-[#C98600]" />
                    <div className="h-2.5 w-2.5 bg-[#0F7A3A]" />
                    <span className="ml-2 text-[10px] uppercase tracking-wider text-muted-foreground">document-preview.pdf</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={(e) => { e.stopPropagation(); setPreviewZoomed(!previewZoomed); }}
                      className="inline-flex items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground"
                    >
                      <ZoomIn className="w-3 h-3" />
                    </button>
                    <a
                      href={savedSignature.image_data || savedSignature.image_url}
                      download="signature.png"
                      onClick={(e) => e.stopPropagation()}
                      className="inline-flex items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground"
                    >
                      <Download className="w-3 h-3" /> PNG
                    </a>
                  </div>
                </div>

                {/* Simulated doc body */}
                <div className="px-6 py-5">
                  {/* Fake doc lines */}
                  <div className="space-y-1.5 mb-5 opacity-30">
                    {[80, 92, 75, 88, 55].map((w, i) => (
                      <div key={i} className="h-1.5 bg-[#D3D7DA]" style={{ width: `${w}%` }} />
                    ))}
                  </div>

                  {/* Signature block */}
                  <div className="border border-dashed border-[#A7CDE3] bg-[#EEF6FB] p-4">
                    <p className="mb-2 text-[9px] font-semibold uppercase tracking-widest text-[#287EAD]">Authorized Signature</p>
                    <img
                      src={savedSignature.image_data || savedSignature.image_url}
                      alt="Saved signature"
                      className={clsx(
                        "object-contain transition-all duration-300",
                        previewZoomed ? "max-h-32" : "max-h-20"
                      )}
                    />
                    <div className="mt-3 flex items-end justify-between border-t border-dashed border-[#A7CDE3] pt-2">
                      <div>
                        <p className="text-[10px] font-semibold text-[#1F2933]">{fullName}</p>
                        <p className="text-[9px] text-muted-foreground">{new Date(savedSignature.created_at).toLocaleDateString()}</p>
                      </div>
                      <span className="border border-[#93C5A4] bg-[#F0FAF3] px-1.5 py-0.5 text-[9px] font-medium text-[#0F7A3A]">
                        ✓ Signed
                      </span>
                    </div>
                  </div>
                </div>
              </div>

              {/* Metadata chips */}
              <div className="grid grid-cols-2 gap-2">
                {[
                  { icon: User,          label: "Signer",  value: fullName },
                  { icon: Clock,         label: "Adopted", value: new Date(savedSignature.created_at).toLocaleDateString() },
                  { icon: PenLine,       label: "Method",  value: savedSignature.method.charAt(0).toUpperCase() + savedSignature.method.slice(1) },
                  { icon: FileSignature, label: "Initials",value: initials || "—" },
                ].map(({ icon: Icon, label, value }) => (
                  <div key={label} className="flex items-start gap-2 border border-[#C8CDD2] bg-white px-3 py-2.5">
                    <Icon className="w-3.5 h-3.5 text-muted-foreground mt-0.5 flex-shrink-0" />
                    <div className="min-w-0">
                      <p className="text-[10px] text-muted-foreground uppercase tracking-wide">{label}</p>
                      <p className="text-xs font-semibold text-foreground truncate mt-0.5">{value}</p>
                    </div>
                  </div>
                ))}
              </div>

              {/* Security badge */}
              <div className="flex items-center gap-2.5 border border-[#93C5A4] bg-[#F0FAF3] px-3.5 py-2.5 text-[11px] font-medium text-[#0F7A3A]">
                <Shield className="w-4 h-4 flex-shrink-0" />
                <span>Encrypted · bound to your account · applied only with explicit signing action</span>
              </div>
            </div>
          ) : (
            /* Empty state */
            <div className="flex flex-col items-center justify-center border border-dashed border-[#C8CDD2] bg-white py-14 text-center">
              <div className="mb-4 flex h-16 w-16 items-center justify-center border border-[#A7CDE3] bg-[#EEF6FB]">
                <FileSignature className="h-8 w-8 text-[#287EAD]" />
              </div>
              <p className="text-sm font-semibold text-foreground">No signature on file yet</p>
              <p className="text-xs text-muted-foreground mt-1.5 max-w-[220px] leading-relaxed">
                Create your signature using one of the methods on the left, then adopt it.
              </p>
              <div className="mt-5 flex gap-2">
                {["Draw", "Type", "Upload"].map((m) => (
                  <button
                    key={m}
                    onClick={() => setMode(m.toLowerCase() as SignatureMode)}
                    className="border border-[#C8CDD2] px-3 py-1.5 text-xs font-medium transition-colors hover:border-[#287EAD] hover:bg-[#EEF6FB] hover:text-[#287EAD]"
                  >
                    {m}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
