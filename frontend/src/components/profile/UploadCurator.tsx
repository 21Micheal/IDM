/**
 * UploadCurator — the "upload" experience for signatures.
 *
 * Drop / pick / paste a photo or scan, and it is automatically converted to a
 * transparent-background signature. Live before/after comparison, presets for
 * the common cases, and manual fine-tuning when the automatic pass isn't
 * perfect. Emits a transparent PNG data URL through `onChange`.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Upload, Loader2, RotateCcw, Sliders, CheckCircle2, AlertTriangle, Trash2 } from "lucide-react";
import clsx from "clsx";
import {
  curateSignatureImage,
  fileToDataUrl,
  DEFAULT_CURATE_OPTIONS,
  type CurateOptions,
} from "@/lib/signature-image";

const MAX_BYTES = 8 * 1024 * 1024;
const ACCEPT = ["image/png", "image/jpeg", "image/webp", "image/heic"];

const PRESETS: { id: string; label: string; hint: string; values: Partial<CurateOptions> }[] = [
  { id: "auto", label: "Auto", hint: "Balanced — works for most photos", values: DEFAULT_CURATE_OPTIONS },
  {
    id: "photo",
    label: "Phone photo",
    hint: "Shadows, uneven lighting, textured paper",
    values: { threshold: 42, softness: 40, despeckle: 45, inkStrength: 72 },
  },
  {
    id: "scan",
    label: "Clean scan",
    hint: "Flatbed scan or crisp white page",
    values: { threshold: 62, softness: 22, despeckle: 12, inkStrength: 55 },
  },
  {
    id: "faint",
    label: "Faint ink",
    hint: "Pencil or light pen that keeps disappearing",
    values: { threshold: 26, softness: 30, despeckle: 30, inkStrength: 85 },
  },
];

const INK_COLORS = [
  { id: "original", value: null, label: "Original ink" },
  { id: "black", value: "#0d1117", label: "Onyx" },
  { id: "navy", value: "#1e3a8a", label: "Navy" },
  { id: "blue", value: "#2563eb", label: "Sapphire" },
];

export interface UploadCuratorProps {
  onChange: (dataUrl: string | null) => void;
  className?: string;
}

export default function UploadCurator({ onChange, className }: UploadCuratorProps) {
  const [original, setOriginal] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const [inkRatio, setInkRatio] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [showTuning, setShowTuning] = useState(false);
  const [presetId, setPresetId] = useState("auto");
  const [opts, setOpts] = useState<CurateOptions>(DEFAULT_CURATE_OPTIONS);
  const [compare, setCompare] = useState(50);
  const runId = useRef(0);

  /* ---- run the curation pipeline whenever source or options change ---- */
  useEffect(() => {
    if (!original) {
      setResult(null);
      onChange(null);
      return;
    }
    const id = ++runId.current;
    setBusy(true);
    setError(null);
    const timer = window.setTimeout(async () => {
      try {
        const out = await curateSignatureImage(original, opts);
        if (id !== runId.current) return;
        setResult(out.dataUrl);
        setInkRatio(out.inkRatio);
        onChange(out.dataUrl);
      } catch (e) {
        if (id !== runId.current) return;
        setError(e instanceof Error ? e.message : "Could not process that image.");
        setResult(null);
        onChange(null);
      } finally {
        if (id === runId.current) setBusy(false);
      }
    }, 90);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [original, opts]);

  const accept = useCallback(async (file: File | null | undefined) => {
    if (!file) return;
    if (!ACCEPT.includes(file.type)) {
      setError("Use a PNG, JPG or WebP image.");
      return;
    }
    if (file.size > MAX_BYTES) {
      setError("That image is larger than 8 MB.");
      return;
    }
    setError(null);
    setOriginal(await fileToDataUrl(file));
  }, []);

  /* ---- paste support: screenshots straight from the clipboard ---- */
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const item = Array.from(e.clipboardData?.items ?? []).find((i) => i.type.startsWith("image/"));
      if (item) accept(item.getAsFile());
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, [accept]);

  const applyPreset = (id: string) => {
    const preset = PRESETS.find((p) => p.id === id);
    if (!preset) return;
    setPresetId(id);
    setOpts((o) => ({ ...DEFAULT_CURATE_OPTIONS, ...preset.values, recolor: o.recolor ?? null }));
  };

  const reset = () => {
    setOriginal(null);
    setResult(null);
    setError(null);
    setPresetId("auto");
    setOpts(DEFAULT_CURATE_OPTIONS);
  };

  const weak = !!result && inkRatio < 0.0008;
  const heavy = !!result && inkRatio > 0.18;

  if (!original) {
    return (
      <div className={className}>
        <label
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragging(false);
            accept(e.dataTransfer.files?.[0]);
          }}
          className={clsx(
            "flex h-44 w-full cursor-pointer flex-col items-center justify-center gap-2 rounded-md border border-dashed px-4 text-center text-sm transition-colors",
            dragging
              ? "border-[#287EAD] bg-[#EEF6FB] text-[#287EAD]"
              : "border-[#C8CDD2] bg-[#FAFBFC] text-[#5E6870] hover:bg-[#F1F5F8]",
          )}
        >
          <Upload className="h-6 w-6 text-[#9AA4AD]" />
          <span className="font-medium">Drop a photo or scan of your signature</span>
          <span className="text-[11px] text-[#9AA4AD]">
            PNG, JPG or WebP up to 8 MB — you can also paste from the clipboard. The background is
            removed automatically.
          </span>
          <input
            type="file"
            accept="image/png,image/jpeg,image/webp"
            className="hidden"
            onChange={(e) => accept(e.target.files?.[0])}
          />
        </label>
        {error && (
          <p className="mt-2 flex items-center gap-1.5 text-[11px] text-[#B42318]">
            <AlertTriangle className="h-3.5 w-3.5" /> {error}
          </p>
        )}
      </div>
    );
  }

  return (
    <div className={clsx("space-y-3", className)}>
      {/* before / after comparison on a checkerboard so transparency is visible */}
      <div className="relative h-44 w-full select-none overflow-hidden rounded-md border border-[#C8CDD2] bg-[repeating-conic-gradient(#eef1f4_0%_25%,#ffffff_0%_50%)] bg-[length:16px_16px]">
        <div className="absolute inset-0 flex items-center justify-center p-3">
          {result ? (
            <img src={result} alt="Signature with background removed" className="max-h-full max-w-full object-contain" />
          ) : (
            <span className="text-xs text-[#9AA4AD]">Processing…</span>
          )}
        </div>
        {/* original revealed on the left of the slider */}
        <div className="absolute inset-0 overflow-hidden" style={{ width: `${compare}%` }}>
          <div className="flex h-44 w-full items-center justify-center bg-white p-3" style={{ width: "100%" }}>
            <img
              src={original}
              alt="Original upload"
              className="max-h-full max-w-full object-contain"
              style={{ maxWidth: "none", width: "auto" }}
            />
          </div>
          <div className="absolute right-0 top-0 h-full w-px bg-[#287EAD]" />
        </div>
        <span className="absolute left-2 top-2 rounded bg-black/55 px-1.5 py-0.5 text-[10px] font-medium text-white">
          Original
        </span>
        <span className="absolute right-2 top-2 rounded bg-[#287EAD] px-1.5 py-0.5 text-[10px] font-medium text-white">
          Background removed
        </span>
        {busy && (
          <span className="absolute inset-x-0 bottom-2 mx-auto flex w-fit items-center gap-1.5 rounded-full bg-white/90 px-2 py-1 text-[11px] text-[#5E6870] shadow">
            <Loader2 className="h-3 w-3 animate-spin" /> Curating…
          </span>
        )}
      </div>

      <input
        type="range"
        min={0}
        max={100}
        value={compare}
        onChange={(e) => setCompare(Number(e.target.value))}
        aria-label="Compare original and cleaned signature"
        className="w-full accent-[#287EAD]"
      />

      {/* presets */}
      <div className="flex flex-wrap gap-1.5">
        {PRESETS.map((p) => (
          <button
            key={p.id}
            title={p.hint}
            onClick={() => applyPreset(p.id)}
            className={clsx(
              "rounded border px-2 py-1 text-[11px] transition-colors",
              presetId === p.id
                ? "border-[#287EAD] bg-[#EEF6FB] text-[#287EAD]"
                : "border-[#C8CDD2] text-[#5E6870] hover:bg-[#F1F5F8]",
            )}
          >
            {p.label}
          </button>
        ))}
        <div className="ml-auto flex items-center gap-1.5">
          <button
            onClick={() => setShowTuning((s) => !s)}
            className="flex items-center gap-1 rounded border border-[#C8CDD2] px-2 py-1 text-[11px] text-[#5E6870] hover:bg-[#F1F5F8]"
          >
            <Sliders className="h-3.5 w-3.5" /> Fine-tune
          </button>
          <button
            onClick={reset}
            className="flex items-center gap-1 rounded border border-[#C8CDD2] px-2 py-1 text-[11px] text-[#5E6870] hover:bg-[#F1F5F8]"
          >
            <Trash2 className="h-3.5 w-3.5" /> Replace
          </button>
        </div>
      </div>

      {showTuning && (
        <div className="space-y-3 rounded-md border border-[#C8CDD2] bg-[#FAFBFC] p-3">
          {(
            [
              ["threshold", "Background removal", "More removes lighter paper and shadows"],
              ["softness", "Edge softness", "Higher keeps strokes smooth, lower keeps them crisp"],
              ["despeckle", "Remove specks", "Clears paper grain, dust and stray marks"],
              ["inkStrength", "Ink strength", "Darkens faint strokes so they print clearly"],
            ] as const
          ).map(([key, label, hint]) => (
            <label key={key} className="block">
              <span className="flex items-center justify-between text-[11px] text-[#5E6870]">
                <span>{label}</span>
                <span className="tabular-nums text-[#9AA4AD]">{opts[key]}</span>
              </span>
              <input
                type="range"
                min={0}
                max={100}
                value={opts[key]}
                onChange={(e) => {
                  setPresetId("custom");
                  setOpts((o) => ({ ...o, [key]: Number(e.target.value) }));
                }}
                className="w-full accent-[#287EAD]"
              />
              <span className="text-[10px] text-[#9AA4AD]">{hint}</span>
            </label>
          ))}

          <div className="flex flex-wrap items-center gap-2 border-t border-[#E4E8EB] pt-2">
            <span className="text-[11px] text-[#5E6870]">Ink colour</span>
            {INK_COLORS.map((c) => (
              <button
                key={c.id}
                title={c.label}
                onClick={() => setOpts((o) => ({ ...o, recolor: c.value }))}
                className={clsx(
                  "h-5 w-5 rounded-full border transition",
                  opts.recolor === c.value ? "ring-2 ring-[#287EAD] ring-offset-1" : "border-[#C8CDD2]",
                  !c.value && "bg-[conic-gradient(#0d1117,#2563eb,#1e3a8a,#0d1117)]",
                )}
                style={c.value ? { backgroundColor: c.value } : undefined}
              />
            ))}
            <button
              onClick={() => {
                setPresetId("auto");
                setOpts({ ...DEFAULT_CURATE_OPTIONS });
              }}
              className="ml-auto flex items-center gap-1 rounded border border-[#C8CDD2] px-2 py-1 text-[11px] text-[#5E6870] hover:bg-white"
            >
              <RotateCcw className="h-3.5 w-3.5" /> Reset
            </button>
          </div>
        </div>
      )}

      {/* feedback */}
      {error ? (
        <p className="flex items-center gap-1.5 text-[11px] text-[#B42318]">
          <AlertTriangle className="h-3.5 w-3.5" /> {error}
        </p>
      ) : weak ? (
        <p className="flex items-center gap-1.5 text-[11px] text-[#B54708]">
          <AlertTriangle className="h-3.5 w-3.5" /> Almost nothing was kept — try the “Faint ink” preset or
          lower “Background removal”.
        </p>
      ) : heavy ? (
        <p className="flex items-center gap-1.5 text-[11px] text-[#B54708]">
          <AlertTriangle className="h-3.5 w-3.5" /> Some background may still be included — raise
          “Background removal” or use the “Phone photo” preset.
        </p>
      ) : result ? (
        <p className="flex items-center gap-1.5 text-[11px] text-[#067647]">
          <CheckCircle2 className="h-3.5 w-3.5" /> Background removed — saved as a transparent PNG.
        </p>
      ) : null}
    </div>
  );
}
