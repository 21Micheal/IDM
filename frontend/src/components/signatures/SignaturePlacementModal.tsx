/**
 * SignaturePlacementModal — refined PDF signing surface (Sejda-style).
 *
 * Improvements over the original:
 *  • Signature is placed as a TRANSPARENT image that is freely DRAGGABLE and
 *    RESIZABLE (corner handles, aspect-locked) directly on the page.
 *  • No name/date is force-appended. Instead the signer can OPTIONALLY drop a
 *    name field and/or a date field as their own independent, draggable items.
 *  • A draggable DATE picker defaulting to East Africa Time (Africa/Nairobi),
 *    with selectable formats.
 *  • "Use a different signature" — sign with the saved signature OR create a
 *    new one inline (draw / type / upload) without overwriting the saved one.
 *  • Undo / clear for placed items, multi-page support, zoom.
 *
 * Output: an array of placed items (percentages relative to the rendered page),
 * so your backend can stamp each one independently. Backwards-compatible
 * `signaturePlacement` is also provided for the first signature item.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Loader2, Type as TypeIcon, CalendarClock, Trash2, Undo2, RefreshCw,
  PenLine, ChevronLeft, ChevronRight, ZoomIn, ZoomOut, Plus,
  Bold, Italic, AlignLeft, AlignCenter, AlignRight,
} from "lucide-react";
import clsx from "clsx";
import { documentsAPI, profileAPI } from "@/services/api";
import { useAuthStore } from "@/store/authStore";
import SignaturePad from "@/components/profile/SignaturePad";
import type { PDFDocumentProxy } from "pdfjs-dist";

const pdfWorkerPath = new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url).toString();
const pdfjsImportPromise = import("pdfjs-dist");

const EAT_TZ = "Africa/Nairobi";

export type PlacedItemKind = "signature" | "date" | "name" | "text";

export interface PlacedItem {
  id: string;
  kind: PlacedItemKind;
  page_number: number;
  /** top-left position + box size, all as % of the rendered page (0–100). */
  x_percent: number;
  y_percent: number;
  width_percent: number;
  height_percent: number;
  /** For signature items: transparent PNG data URL. */
  image_data?: string;
  /** For text/name/date items: the rendered string. */
  text?: string;
  /** For text/name/date: font size as % of page height (keeps it resolution-independent). */
  font_percent?: number;
  /** For date items: the ISO timestamp + chosen format, for backend re-rendering if desired. */
  date_iso?: string;
  date_format?: string;
  /** Text styling (text/name/date) so signers can match the document's font. */
  font_family?: "helvetica" | "times" | "courier";
  bold?: boolean;
  italic?: boolean;
  align?: "left" | "center" | "right";
  color?: string; // hex, e.g. "#1F2933"
}

/** CSS font stacks mirroring the backend's PDF base-14 fonts. */
const FONT_CSS: Record<string, string> = {
  helvetica: "Helvetica, Arial, sans-serif",
  times: "'Times New Roman', Times, serif",
  courier: "'Courier New', Courier, monospace",
};

/** Back-compat single-signature shape (matches the original modal). */
export type SignaturePlacement = {
  page_number: number;
  x_percent: number;
  y_percent: number;
  width_percent?: number;
};

export interface SignaturePlacementResult {
  items: PlacedItem[];
  timezone: string;
  /** Convenience: the first signature item mapped to the original shape (or null). */
  signaturePlacement: SignaturePlacement | null;
  /** True if the signer drew/typed/uploaded a new signature for this signing
   * action instead of using their saved one. When true, `signatureImage`
   * carries the transparent PNG data URL to send as `signature_image`
   * alongside `use_new_signature: true`; the saved signature on file is
   * left untouched. */
  useNewSignature: boolean;
  signatureImage: string | null;
}

interface DateFormatOption {
  id: string;
  label: string;
  format: (d: Date) => string;
}

const DATE_FORMATS: DateFormatOption[] = [
  { id: "dmy", label: "22 Jun 2026", format: (d) => fmt(d, { day: "2-digit", month: "short", year: "numeric" }) },
  { id: "iso", label: "2026-06-22", format: (d) => isoDate(d) },
  { id: "mdy", label: "Jun 22, 2026", format: (d) => fmt(d, { month: "short", day: "2-digit", year: "numeric" }) },
  { id: "full", label: "22 Jun 2026, 14:30 EAT", format: (d) => `${fmt(d, { day: "2-digit", month: "short", year: "numeric" })}, ${fmt(d, { hour: "2-digit", minute: "2-digit", hour12: false })} EAT` },
];

function fmt(d: Date, opts: Intl.DateTimeFormatOptions) {
  return new Intl.DateTimeFormat("en-GB", { timeZone: EAT_TZ, ...opts }).format(d);
}
/** YYYY-MM-DD in EAT (for the native date input). */
function isoDate(d: Date) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: EAT_TZ, year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)!.value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}

const uid = () => Math.random().toString(36).slice(2, 10);

export interface SignaturePlacementModalProps {
  documentId: string;
  documentTitle?: string;
  documentRef?: string;
  note?: string;
  confirmLabel?: string;
  signerName?: string;
  onCancel: () => void;
  onConfirm: (result: SignaturePlacementResult) => void;
  isSubmitting?: boolean;
}

export default function SignaturePlacementModal({
  documentId,
  documentTitle,
  documentRef,
  note,
  confirmLabel = "Confirm signature",
  signerName = "",
  onCancel,
  onConfirm,
  isSubmitting = false,
}: SignaturePlacementModalProps) {
  const token = useAuthStore((s) => s.accessToken);
  const [hostEl, setHostEl] = useState<HTMLDivElement | null>(null);
  const [pdfDoc, setPdfDoc] = useState<PDFDocumentProxy | null>(null);
  const [currentPage, setCurrentPage] = useState(1);
  const [totalPages, setTotalPages] = useState(0);
  const [scale, setScale] = useState(1.2);
  const [pageSize, setPageSize] = useState({ width: 0, height: 0 });
  const [error, setError] = useState("");

  const [items, setItems] = useState<PlacedItem[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [history, setHistory] = useState<PlacedItem[][]>([]);

  // signature source
  const [useNewSignature, setUseNewSignature] = useState(false);
  const [newSignature, setNewSignature] = useState<string | null>(null);

  // date config
  const [dateFormatId, setDateFormatId] = useState(DATE_FORMATS[0].id);
  const [dateValue, setDateValue] = useState<string>(() => isoDate(new Date()));

  const { data: preview } = useQuery({
    queryKey: ["signature-placement-preview", documentId],
    queryFn: () => documentsAPI.previewUrl(documentId).then((r) => r.data),
  });

  const { data: savedSignature, isLoading: signatureLoading } = useQuery<any>({
    queryKey: ["profile-signature"],
    queryFn: () => profileAPI.getSignature().then((r) => r.data.signature ?? null),
  });

  const activeSignatureImage = useNewSignature ? newSignature : savedSignature?.image_data ?? null;
  const hasSignatureSource = !!activeSignatureImage;

  /* ---------- load + render PDF ---------- */
  useEffect(() => {
    let cancelled = false;
    let loadingTask: { promise: Promise<PDFDocumentProxy>; destroy?: () => void } | null = null;
    setPdfDoc(null);
    setTotalPages(0);
    setPageSize({ width: 0, height: 0 });
    const previewUrl = preview?.url;
    if (!previewUrl || preview.viewer !== "pdfjs") return;

    pdfjsImportPromise
      .then((pdfjsLib) => {
        if (cancelled) return Promise.reject(new Error("cancelled"));
        pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerPath;
        loadingTask = pdfjsLib.getDocument({
          url: previewUrl,
          withCredentials: true,
          httpHeaders: token ? { Authorization: `Bearer ${token}` } : {},
        });
        return loadingTask.promise;
      })
      .then((loaded) => {
        if (cancelled) return;
        setPdfDoc(loaded);
        setTotalPages(loaded.numPages);
        setCurrentPage(1);
      })
      .catch((err) => {
        if (!cancelled && err?.message !== "cancelled") setError("Failed to load PDF for signing.");
      });

    return () => {
      cancelled = true;
      loadingTask?.destroy?.();
    };
  }, [preview?.url, preview?.viewer, token]);

  useEffect(() => {
    if (!pdfDoc || !hostEl) return;
    let cancelled = false;
    let renderTask: { promise: Promise<void>; cancel?: () => void } | null = null;
    hostEl.innerHTML = "";
    setPageSize({ width: 0, height: 0 });

    pdfDoc.getPage(currentPage).then((page) => {
      if (cancelled) return;
      const viewport = page.getViewport({ scale });
      const canvas = document.createElement("canvas");
      canvas.width = viewport.width;
      canvas.height = viewport.height;
      canvas.className = "block shadow-sm bg-white";
      hostEl.innerHTML = "";
      hostEl.appendChild(canvas);
      setPageSize({ width: viewport.width, height: viewport.height });
      renderTask = page.render({ canvasContext: canvas.getContext("2d")!, viewport });
      renderTask.promise.catch((err) => {
        if (!cancelled && err?.name !== "RenderingCancelledException") setError("Failed to render PDF page.");
      });
    });

    return () => {
      cancelled = true;
      renderTask?.cancel?.();
    };
  }, [pdfDoc, hostEl, currentPage, scale]);

  /* ---------- item mutations (with undo history) ---------- */
  const pushHistory = () => setHistory((h) => [...h.slice(-29), items]);

  const updateItems = (next: PlacedItem[], record = true) => {
    if (record) pushHistory();
    setItems(next);
  };

  const undo = () => {
    setHistory((h) => {
      if (!h.length) return h;
      const prev = h[h.length - 1];
      setItems(prev);
      setSelectedId(null);
      return h.slice(0, -1);
    });
  };

  const removeItem = (id: string) => {
    updateItems(items.filter((i) => i.id !== id));
    if (selectedId === id) setSelectedId(null);
  };

  const patchItem = (id: string, patch: Partial<PlacedItem>, record = false) => {
    if (record) pushHistory();
    setItems((prev) => prev.map((i) => (i.id === id ? { ...i, ...patch } : i)));
  };

  const currentDateText = useMemo(() => {
    const d = new Date(`${dateValue}T12:00:00`);
    const opt = DATE_FORMATS.find((f) => f.id === dateFormatId) ?? DATE_FORMATS[0];
    return opt.format(d);
  }, [dateValue, dateFormatId]);

  const addSignature = () => {
    if (!hasSignatureSource) {
      setError("Create or select a signature first.");
      return;
    }
    setError("");
    const item: PlacedItem = {
      id: uid(),
      kind: "signature",
      page_number: currentPage,
      x_percent: 30,
      y_percent: 70,
      width_percent: 24,
      height_percent: 9,
      image_data: activeSignatureImage!,
    };
    updateItems([...items, item]);
    setSelectedId(item.id);
  };

  const addText = (kind: Extract<PlacedItemKind, "name" | "date" | "text">) => {
    const text =
      kind === "name" ? signerName || "Full Name" : kind === "date" ? currentDateText : "Text";
    const item: PlacedItem = {
      id: uid(),
      kind,
      page_number: currentPage,
      x_percent: 30,
      y_percent: 82,
      width_percent: 24,
      height_percent: 5,
      text,
      font_percent: 1.6,
      font_family: "helvetica",
      bold: false,
      italic: false,
      align: "center",
      color: "#1F2933",
      ...(kind === "date"
        ? { date_iso: new Date(`${dateValue}T12:00:00`).toISOString(), date_format: dateFormatId }
        : {}),
    };
    updateItems([...items, item]);
    setSelectedId(item.id);
  };

  const selectedItem = items.find((i) => i.id === selectedId) ?? null;

  const confirm = () => {
    if (preview?.viewer !== "pdfjs") {
      const status = (preview as { preview_status?: string } | undefined)?.preview_status;
      setError(
        status === "pending" || status === "processing"
          ? "The document is still being prepared for signing. Please wait a moment and try again."
          : status === "failed"
            ? "The document could not be prepared for signing."
            : "This document type cannot be signed.",
      );
      return;
    }
    if (!items.some((i) => i.kind === "signature")) {
      setError("Place at least one signature on the document.");
      return;
    }
    const rounded = items.map((i) => ({
      ...i,
      x_percent: Number(i.x_percent.toFixed(3)),
      y_percent: Number(i.y_percent.toFixed(3)),
      width_percent: Number(i.width_percent.toFixed(3)),
      height_percent: Number(i.height_percent.toFixed(3)),
    }));
    const firstSig = rounded.find((i) => i.kind === "signature");
    const sendNewSignature = useNewSignature && !!newSignature;
    onConfirm({
      items: rounded,
      timezone: EAT_TZ,
      signaturePlacement: firstSig
        ? {
            page_number: firstSig.page_number,
            x_percent: firstSig.x_percent,
            y_percent: firstSig.y_percent,
            width_percent: firstSig.width_percent,
          }
        : null,
      useNewSignature: sendNewSignature,
      signatureImage: sendNewSignature ? newSignature : null,
    });
  };

  const pageItems = items.filter((i) => i.page_number === currentPage);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 p-4">
      <div className="flex max-h-[94vh] w-full max-w-6xl flex-col overflow-hidden rounded-xl bg-background shadow-2xl">
        {/* header */}
        <div className="flex items-center justify-between gap-4 border-b border-border px-5 py-4">
          <div>
            <h3 className="text-base font-semibold text-foreground">Place your signature</h3>
            <p className="text-xs text-muted-foreground">
              Drag and resize each item. Drop a date or name only where it's needed.
            </p>
          </div>
          <button onClick={onCancel} className="btn-secondary text-sm">Cancel</button>
        </div>

        {signatureLoading ? (
          <div className="flex min-h-0 flex-1 items-center justify-center p-10">
            <Loader2 className="h-6 w-6 animate-spin text-primary" />
          </div>
        ) : (
          <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[1fr_360px]">
            {/* ===== PDF canvas ===== */}
            <div className="min-h-0 overflow-auto bg-[#EDEDED] p-4">
              <div className="mb-3 flex items-center justify-between rounded-lg border border-border bg-background px-3 py-2">
                <div className="flex items-center gap-2">
                  <button onClick={() => setCurrentPage((p) => Math.max(1, p - 1))} disabled={currentPage <= 1} className="btn-secondary px-2 py-1"><ChevronLeft className="h-4 w-4" /></button>
                  <span className="text-sm text-foreground">Page {currentPage} of {totalPages || "..."}</span>
                  <button onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))} disabled={!totalPages || currentPage >= totalPages} className="btn-secondary px-2 py-1"><ChevronRight className="h-4 w-4" /></button>
                </div>
                <div className="flex items-center gap-2">
                  <button onClick={undo} disabled={!history.length} className="btn-secondary flex items-center gap-1 px-2 py-1 text-xs disabled:opacity-40"><Undo2 className="h-3.5 w-3.5" /> Undo</button>
                  <span className="mx-1 h-4 w-px bg-border" />
                  <button onClick={() => setScale((s) => Math.max(0.7, s - 0.1))} className="btn-secondary px-2 py-1"><ZoomOut className="h-4 w-4" /></button>
                  <span className="w-12 text-center text-xs text-muted-foreground">{Math.round(scale * 100)}%</span>
                  <button onClick={() => setScale((s) => Math.min(2.5, s + 0.1))} className="btn-secondary px-2 py-1"><ZoomIn className="h-4 w-4" /></button>
                </div>
              </div>

              <div className="relative mx-auto w-fit" onPointerDown={() => setSelectedId(null)}>
                <div ref={setHostEl} className="relative" />
                {pageSize.width > 0 &&
                  pageItems.map((item) => (
                    <PlacedItemView
                      key={item.id}
                      item={item}
                      selected={selectedId === item.id}
                      pageSize={pageSize}
                      onSelect={() => setSelectedId(item.id)}
                      onChange={(patch) => patchItem(item.id, patch)}
                      onCommit={() => pushHistory()}
                      onRemove={() => removeItem(item.id)}
                    />
                  ))}
              </div>
            </div>

            {/* ===== Side panel ===== */}
            <div className="flex min-h-0 flex-col gap-4 overflow-auto border-t border-border p-5 lg:border-l lg:border-t-0">
              {/* signature source */}
              <div className="rounded-lg border border-border p-3">
                <div className="mb-2 flex items-center justify-between">
                  <p className="text-sm font-semibold text-foreground">Signature</p>
                  {savedSignature?.image_data && (
                    <button
                      onClick={() => { setUseNewSignature((v) => !v); setNewSignature(null); }}
                      className="flex items-center gap-1 text-xs font-medium text-primary hover:underline"
                    >
                      <RefreshCw className="h-3 w-3" />
                      {useNewSignature ? "Use saved" : "Use a different one"}
                    </button>
                  )}
                </div>

                {useNewSignature || !savedSignature?.image_data ? (
                  <SignaturePad onChange={setNewSignature} defaultName={signerName} />
                ) : (
                  <div className="flex h-20 items-center justify-center rounded-md border border-dashed border-border bg-muted/20 p-2">
                    <img src={savedSignature.image_data} alt="Saved signature" className="max-h-full max-w-full object-contain" />
                  </div>
                )}

                <button
                  onClick={addSignature}
                  disabled={!hasSignatureSource}
                  className="btn-primary mt-3 flex w-full items-center justify-center gap-2 disabled:opacity-50"
                >
                  <PenLine className="h-4 w-4" /> Add signature to page
                </button>
              </div>

              {/* date */}
              <div className="rounded-lg border border-border p-3">
                <p className="mb-2 text-sm font-semibold text-foreground">Date (East Africa Time)</p>
                <div className="flex items-center gap-2">
                  <input
                    type="date"
                    value={dateValue}
                    onChange={(e) => setDateValue(e.target.value)}
                    className="flex-1 rounded-md border border-border px-2 py-1.5 text-sm outline-none focus:border-primary"
                  />
                  <button
                    onClick={() => setDateValue(isoDate(new Date()))}
                    className="btn-secondary whitespace-nowrap px-2 py-1.5 text-xs"
                  >
                    Today
                  </button>
                </div>
                <select
                  value={dateFormatId}
                  onChange={(e) => setDateFormatId(e.target.value)}
                  className="mt-2 w-full rounded-md border border-border px-2 py-1.5 text-sm outline-none focus:border-primary"
                >
                  {DATE_FORMATS.map((f) => (
                    <option key={f.id} value={f.id}>{f.format(new Date(`${dateValue}T12:00:00`))}</option>
                  ))}
                </select>
                <button
                  onClick={() => addText("date")}
                  className="btn-secondary mt-3 flex w-full items-center justify-center gap-2"
                >
                  <CalendarClock className="h-4 w-4" /> Add date field
                </button>
              </div>

              {/* name / text */}
              <div className="rounded-lg border border-border p-3">
                <p className="mb-2 text-sm font-semibold text-foreground">Optional fields</p>
                <div className="grid grid-cols-2 gap-2">
                  <button onClick={() => addText("name")} className="btn-secondary flex items-center justify-center gap-1.5 text-xs">
                    <TypeIcon className="h-3.5 w-3.5" /> Name
                  </button>
                  <button onClick={() => addText("text")} className="btn-secondary flex items-center justify-center gap-1.5 text-xs">
                    <Plus className="h-3.5 w-3.5" /> Text
                  </button>
                </div>
                <p className="mt-2 text-[11px] text-muted-foreground">
                  Double-click a text field on the page to edit it. Drag corners to resize.
                </p>
              </div>

              {/* text style — shown for the selected text/name/date item */}
              {selectedItem && selectedItem.kind !== "signature" && (() => {
                const setStyle = (patch: Partial<PlacedItem>) => patchItem(selectedItem.id, patch, true);
                const tog = (on?: boolean) => clsx(
                  "flex h-8 w-8 items-center justify-center rounded border",
                  on ? "border-primary bg-primary text-primary-foreground" : "border-border bg-background text-muted-foreground hover:bg-muted",
                );
                return (
                  <div className="space-y-2.5 rounded-lg border border-primary/30 bg-primary/5 p-3">
                    <p className="text-sm font-semibold text-foreground capitalize">{selectedItem.kind} style</p>
                    <select
                      value={selectedItem.font_family ?? "helvetica"}
                      onChange={(e) => setStyle({ font_family: e.target.value as PlacedItem["font_family"] })}
                      className="input h-8 w-full text-xs"
                    >
                      <option value="helvetica">Helvetica / Arial (sans)</option>
                      <option value="times">Times (serif)</option>
                      <option value="courier">Courier (mono)</option>
                    </select>
                    <div className="flex items-center gap-1">
                      <button type="button" onClick={() => setStyle({ bold: !selectedItem.bold })} className={tog(selectedItem.bold)} title="Bold"><Bold className="h-3.5 w-3.5" /></button>
                      <button type="button" onClick={() => setStyle({ italic: !selectedItem.italic })} className={tog(selectedItem.italic)} title="Italic"><Italic className="h-3.5 w-3.5" /></button>
                      <span className="mx-1 h-5 w-px bg-border" />
                      <button type="button" onClick={() => setStyle({ align: "left" })} className={tog((selectedItem.align ?? "center") === "left")} title="Align left"><AlignLeft className="h-3.5 w-3.5" /></button>
                      <button type="button" onClick={() => setStyle({ align: "center" })} className={tog((selectedItem.align ?? "center") === "center")} title="Align center"><AlignCenter className="h-3.5 w-3.5" /></button>
                      <button type="button" onClick={() => setStyle({ align: "right" })} className={tog((selectedItem.align ?? "center") === "right")} title="Align right"><AlignRight className="h-3.5 w-3.5" /></button>
                      <span className="ml-auto" />
                      <input type="color" value={selectedItem.color ?? "#1F2933"} onChange={(e) => setStyle({ color: e.target.value })} className="h-8 w-9 cursor-pointer rounded border border-border bg-background p-0.5" title="Text colour" />
                    </div>
                    <div className="flex items-center gap-2">
                      <label className="text-[11px] font-medium text-muted-foreground">Size</label>
                      <input type="range" min={0.8} max={6} step={0.1} value={selectedItem.font_percent ?? 1.6} onChange={(e) => setStyle({ font_percent: Number(e.target.value) })} className="flex-1 accent-primary" />
                    </div>

                    {selectedItem.kind === "date" && (() => {
                      const isoVal = selectedItem.date_iso ? isoDate(new Date(selectedItem.date_iso)) : isoDate(new Date());
                      const fmtId = selectedItem.date_format ?? DATE_FORMATS[0].id;
                      // Recompute the rendered date text whenever the value/format changes.
                      const recompute = (iso: string, fid: string) => {
                        const d = new Date(`${iso}T12:00:00`);
                        const opt = DATE_FORMATS.find((f) => f.id === fid) ?? DATE_FORMATS[0];
                        return { text: opt.format(d), date_iso: d.toISOString(), date_format: fid };
                      };
                      return (
                        <div className="space-y-1.5 border-t border-primary/20 pt-2.5">
                          <p className="text-[11px] font-medium text-muted-foreground">Date (East Africa Time)</p>
                          <div className="flex items-center gap-1.5">
                            <input type="date" value={isoVal} onChange={(e) => setStyle(recompute(e.target.value, fmtId))} className="input h-8 flex-1 text-xs" />
                            <button type="button" onClick={() => setStyle(recompute(isoDate(new Date()), fmtId))} className="btn-secondary whitespace-nowrap px-2 py-1 text-[11px]">Today</button>
                          </div>
                          <select value={fmtId} onChange={(e) => setStyle(recompute(isoVal, e.target.value))} className="input h-8 w-full text-xs">
                            {DATE_FORMATS.map((f) => <option key={f.id} value={f.id}>{f.format(new Date(`${isoVal}T12:00:00`))}</option>)}
                          </select>
                        </div>
                      );
                    })()}
                  </div>
                );
              })()}

              {/* placed list */}
              {items.length > 0 && (
                <div className="rounded-lg border border-border p-3">
                  <p className="mb-2 text-sm font-semibold text-foreground">Placed items ({items.length})</p>
                  <ul className="space-y-1">
                    {items.map((i) => (
                      <li key={i.id} className="flex items-center justify-between rounded px-2 py-1 text-xs hover:bg-muted/40">
                        <button
                          onClick={() => { setCurrentPage(i.page_number); setSelectedId(i.id); }}
                          className="truncate capitalize text-foreground"
                        >
                          {i.kind} · p{i.page_number} {i.text ? `· ${i.text}` : ""}
                        </button>
                        <button onClick={() => removeItem(i.id)} className="text-muted-foreground hover:text-destructive">
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              <div className="rounded-lg border border-border bg-muted/20 p-3">
                <p className="text-xs text-muted-foreground">
                  Signing <span className="font-medium text-foreground">{documentTitle || "this document"}</span>
                  {documentRef && <> · <span className="font-medium text-foreground">{documentRef}</span></>}.
                  This action is recorded.
                </p>
                {note && <p className="mt-2 text-[11px] text-muted-foreground">{note}</p>}
              </div>

              {error && <p className="text-sm text-destructive">{error}</p>}

              <div className="mt-auto flex flex-col gap-2">
                <button onClick={confirm} disabled={isSubmitting || !pageSize.width} className="btn-primary flex w-full items-center justify-center gap-2">
                  {isSubmitting && <Loader2 className="h-4 w-4 animate-spin" />}
                  {confirmLabel}
                </button>
                <button onClick={onCancel} className="btn-secondary w-full justify-center">Back</button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/* ===================== draggable + resizable item ===================== */

type ResizeCorner = "nw" | "ne" | "sw" | "se";

function PlacedItemView({
  item,
  selected,
  pageSize,
  onSelect,
  onChange,
  onCommit,
  onRemove,
}: {
  item: PlacedItem;
  selected: boolean;
  pageSize: { width: number; height: number };
  onSelect: () => void;
  onChange: (patch: Partial<PlacedItem>) => void;
  onCommit: () => void;
  onRemove: () => void;
}) {
  const isText = item.kind !== "signature";
  const [editing, setEditing] = useState(false);
  const dragState = useRef<{
    mode: "move" | ResizeCorner;
    startX: number;
    startY: number;
    item: PlacedItem;
  } | null>(null);

  const aspect = useRef<number | null>(null);

  const beginMove = (e: React.PointerEvent) => {
    if (editing) return;
    e.stopPropagation();
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    onSelect();
    onCommit();
    dragState.current = { mode: "move", startX: e.clientX, startY: e.clientY, item };
  };

  const beginResize = (corner: ResizeCorner) => (e: React.PointerEvent) => {
    e.stopPropagation();
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    onSelect();
    onCommit();
    dragState.current = { mode: corner, startX: e.clientX, startY: e.clientY, item };
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const st = dragState.current;
    if (!st || !pageSize.width || !pageSize.height) return;
    const dxPct = ((e.clientX - st.startX) / pageSize.width) * 100;
    const dyPct = ((e.clientY - st.startY) / pageSize.height) * 100;

    if (st.mode === "move") {
      const x = clamp(st.item.x_percent + dxPct, 0, 100 - st.item.width_percent);
      const y = clamp(st.item.y_percent + dyPct, 0, 100 - st.item.height_percent);
      onChange({ x_percent: x, y_percent: y });
      return;
    }

    // resize
    let { x_percent: x, y_percent: y, width_percent: w, height_percent: h } = st.item;
    const ratio = aspect.current ?? w / h;

    if (st.mode === "se") {
      w = clamp(st.item.width_percent + dxPct, 4, 100 - x);
      h = item.kind === "signature" ? w / ratio : clamp(st.item.height_percent + dyPct, 2, 100 - y);
    } else if (st.mode === "ne") {
      w = clamp(st.item.width_percent + dxPct, 4, 100 - x);
      const newH = item.kind === "signature" ? w / ratio : clamp(st.item.height_percent - dyPct, 2, st.item.y_percent + st.item.height_percent);
      y = st.item.y_percent + (st.item.height_percent - newH);
      h = newH;
    } else if (st.mode === "sw") {
      const newW = clamp(st.item.width_percent - dxPct, 4, st.item.x_percent + st.item.width_percent);
      x = st.item.x_percent + (st.item.width_percent - newW);
      w = newW;
      h = item.kind === "signature" ? w / ratio : clamp(st.item.height_percent + dyPct, 2, 100 - y);
    } else if (st.mode === "nw") {
      const newW = clamp(st.item.width_percent - dxPct, 4, st.item.x_percent + st.item.width_percent);
      x = st.item.x_percent + (st.item.width_percent - newW);
      w = newW;
      const newH = item.kind === "signature" ? w / ratio : clamp(st.item.height_percent - dyPct, 2, st.item.y_percent + st.item.height_percent);
      y = st.item.y_percent + (st.item.height_percent - newH);
      h = newH;
    }

    const patch: Partial<PlacedItem> = { x_percent: x, y_percent: y, width_percent: w, height_percent: h };
    if (isText) patch.font_percent = clamp(h * 0.62, 0.8, 8);
    onChange(patch);
  };

  const endDrag = () => { dragState.current = null; };

  const onImgLoad = (e: React.SyntheticEvent<HTMLImageElement>) => {
    const img = e.currentTarget;
    if (img.naturalHeight) {
      const natRatio = img.naturalWidth / img.naturalHeight;
      aspect.current = natRatio;
      // align box height to natural aspect on first load
      const desiredH = item.width_percent / natRatio;
      if (Math.abs(desiredH - item.height_percent) > 0.5) {
        onChange({ height_percent: desiredH });
      }
    }
  };

  const fontPx = ((item.font_percent ?? 1.6) / 100) * pageSize.height;

  return (
    <div
      role="button"
      tabIndex={0}
      onPointerDown={beginMove}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onClick={(e) => { e.stopPropagation(); onSelect(); }}
      onDoubleClick={() => isText && setEditing(true)}
      className={clsx(
        "absolute flex items-center justify-center",
        editing ? "cursor-text" : "cursor-grab active:cursor-grabbing",
        selected ? "z-20 ring-2 ring-primary" : "z-10 ring-1 ring-transparent hover:ring-primary/40",
      )}
      style={{
        left: `${item.x_percent}%`,
        top: `${item.y_percent}%`,
        width: `${item.width_percent}%`,
        height: `${item.height_percent}%`,
      }}
    >
      {item.kind === "signature" ? (
        <img src={item.image_data} alt="Signature" onLoad={onImgLoad} className="pointer-events-none h-full w-full object-contain" draggable={false} />
      ) : editing ? (
        <input
          autoFocus
          defaultValue={item.text}
          onBlur={(e) => { onChange({ text: e.target.value }); setEditing(false); }}
          onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
          className="h-full w-full bg-white/80 px-1 outline-none"
          style={{
            fontSize: Math.max(8, fontPx),
            fontFamily: FONT_CSS[item.font_family ?? "helvetica"],
            fontWeight: item.bold ? 700 : 400,
            fontStyle: item.italic ? "italic" : "normal",
            textAlign: item.align ?? "center",
            color: item.color ?? "#1F2933",
          }}
        />
      ) : (
        <span
          className="pointer-events-none block w-full truncate leading-none"
          style={{
            fontSize: Math.max(8, fontPx),
            fontFamily: FONT_CSS[item.font_family ?? "helvetica"],
            fontWeight: item.bold ? 700 : 400,
            fontStyle: item.italic ? "italic" : "normal",
            textAlign: item.align ?? "center",
            color: item.color ?? "#1F2933",
          }}
        >
          {item.text}
        </span>
      )}

      {selected && !editing && (
        <>
          {(["nw", "ne", "sw", "se"] as ResizeCorner[]).map((c) => (
            <span
              key={c}
              onPointerDown={beginResize(c)}
              onPointerMove={onPointerMove}
              onPointerUp={endDrag}
              className={clsx(
                "absolute h-3 w-3 rounded-full border-2 border-white bg-primary shadow",
                c === "nw" && "-left-1.5 -top-1.5 cursor-nwse-resize",
                c === "ne" && "-right-1.5 -top-1.5 cursor-nesw-resize",
                c === "sw" && "-bottom-1.5 -left-1.5 cursor-nesw-resize",
                c === "se" && "-bottom-1.5 -right-1.5 cursor-nwse-resize",
              )}
            />
          ))}
          <button
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => { e.stopPropagation(); onRemove(); }}
            className="absolute -right-2 -top-7 flex h-6 w-6 items-center justify-center rounded-full bg-destructive text-destructive-foreground shadow"
            title="Remove"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </>
      )}
    </div>
  );
}

function clamp(v: number, min: number, max: number) {
  return Math.max(min, Math.min(max, v));
}