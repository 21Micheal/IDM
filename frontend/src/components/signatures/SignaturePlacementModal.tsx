/**
 * SignaturePlacementModal — Dual-mode signing surface for both PDF documents and interactive Forms.
 *
 * Capabilities:
 *  1. PDF Mode (traditional): Loads PDF document, allows draggable and resizable signature, date,
 *     name, and custom text stamps with multi-page navigation and zoom.
 *  2. Form Mode (direct web form): Lets users apply their saved signature or draw/type a new
 *     signature, choose a formatted date (East Africa Time / Africa/Nairobi), and apply them
 *     directly to form fields (e.g., `requester_signature`, `signature`, `date`, `signed_by`)
 *     or stamp them onto the form canvas.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Loader2, Type as TypeIcon, CalendarClock, Trash2, Undo2,
  PenLine, ChevronLeft, ChevronRight, ZoomIn, ZoomOut,
  Bold, Italic, AlignLeft, AlignCenter, AlignRight, CheckCircle2,
  Sparkles, FileText, Check, Layers
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
  x_percent: number;
  y_percent: number;
  width_percent: number;
  height_percent: number;
  image_data?: string;
  text?: string;
  font_percent?: number;
  date_iso?: string;
  date_format?: string;
  font_family?: "helvetica" | "times" | "courier";
  bold?: boolean;
  italic?: boolean;
  align?: "left" | "center" | "right";
  color?: string;
  field_key?: string;
}

const FONT_CSS: Record<string, string> = {
  helvetica: "Helvetica, Arial, sans-serif",
  times: "'Times New Roman', Times, serif",
  courier: "'Courier New', Courier, monospace",
};

export type SignaturePlacement = {
  page_number: number;
  x_percent: number;
  y_percent: number;
  width_percent?: number;
};

export interface SignaturePlacementResult {
  items: PlacedItem[];
  timezone: string;
  signaturePlacement: SignaturePlacement | null;
  useNewSignature: boolean;
  signatureImage: string | null;
  /** Form field key-value pairs when applied directly to a form */
  formFieldValues?: Record<string, unknown>;
}

export interface FormTargetField {
  key: string;
  label: string;
  kind: "signature" | "date" | "text";
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

function isoDate(d: Date) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: EAT_TZ, year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)!.value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}

const uid = () => Math.random().toString(36).slice(2, 10);

export interface SignaturePlacementModalProps {
  documentId?: string;
  documentTitle?: string;
  documentRef?: string;
  note?: string;
  confirmLabel?: string;
  signerName?: string;
  /** Force specific mode: "form" for live web form signing, "pdf" for PDF canvas, or "auto" */
  mode?: "auto" | "pdf" | "form";
  /** Available signature/date/text fields in the form for direct binding */
  formFields?: FormTargetField[];
  onCancel: () => void;
  onConfirm: (result: SignaturePlacementResult) => void;
  /** Direct hook for form fields injection */
  onApplyToForm?: (fields: Record<string, unknown>, rawResult: SignaturePlacementResult) => void;
  isSubmitting?: boolean;
}

export default function SignaturePlacementModal({
  documentId,
  documentTitle,
  documentRef,
  note,
  confirmLabel = "Apply Signature",
  signerName = "",
  mode = "auto",
  formFields = [],
  onCancel,
  onConfirm,
  onApplyToForm,
  isSubmitting = false,
}: SignaturePlacementModalProps) {
  const token = useAuthStore((s) => s.accessToken);
  const user = useAuthStore((s) => s.user);
  const effectiveSignerName = signerName || user?.full_name || `${user?.first_name ?? ""} ${user?.last_name ?? ""}`.trim() || user?.email || "Authorized Signer";

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

  // Signature source
  const [useNewSignature, setUseNewSignature] = useState(false);
  const [newSignature, setNewSignature] = useState<string | null>(null);

  // Date config
  const [dateFormatId, setDateFormatId] = useState(DATE_FORMATS[0].id);
  const [dateValue, setDateValue] = useState<string>(() => isoDate(new Date()));

  // Form mode field mapping selections
  const [selectedSigField, setSelectedSigField] = useState<string>(() => {
    const defaultSig = formFields.find((f) => f.kind === "signature");
    return defaultSig ? defaultSig.key : "signature";
  });
  const [selectedDateField, setSelectedDateField] = useState<string>(() => {
    const defaultDate = formFields.find((f) => f.kind === "date");
    return defaultDate ? defaultDate.key : "signature_date";
  });
  const [selectedNameField, setSelectedNameField] = useState<string>(() => {
    const defaultName = formFields.find((f) => f.kind === "text" && /name|signed_by|authorizer/i.test(f.key));
    return defaultName ? defaultName.key : "signed_by";
  });
  const [applyDateToForm, setApplyDateToForm] = useState(true);
  const [applyNameToForm, setApplyNameToForm] = useState(true);

  // Query PDF preview only if documentId is present
  const { data: preview, isLoading: previewLoading } = useQuery({
    queryKey: ["signature-placement-preview", documentId],
    queryFn: () => (documentId ? documentsAPI.previewUrl(documentId).then((r) => r.data) : Promise.resolve(null)),
    enabled: !!documentId && mode !== "form",
  });

  const { data: savedSignature, isLoading: signatureLoading } = useQuery<any>({
    queryKey: ["profile-signature"],
    queryFn: () => profileAPI.getSignature().then((r) => r.data.signature ?? null),
  });

  const activeSignatureImage = useNewSignature ? newSignature : savedSignature?.image_data ?? null;
  const hasSignatureSource = !!activeSignatureImage;

  // Resolve actual operating mode
  const activeMode: "pdf" | "form" = useMemo(() => {
    if (mode === "form") return "form";
    if (mode === "pdf") return "pdf";
    if (!documentId) return "form";
    if (preview?.viewer === "pdfjs") return "pdf";
    return "form";
  }, [mode, documentId, preview?.viewer]);

  /* ---------- Load PDF if in PDF mode ---------- */
  useEffect(() => {
    if (activeMode !== "pdf") return;
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
        if (!cancelled && err?.message !== "cancelled") setError("Failed to load PDF preview for signing.");
      });

    return () => {
      cancelled = true;
      loadingTask?.destroy?.();
    };
  }, [activeMode, preview?.url, preview?.viewer, token]);

  useEffect(() => {
    if (activeMode !== "pdf" || !pdfDoc || !hostEl) return;
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
  }, [activeMode, pdfDoc, hostEl, currentPage, scale]);

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

  const currentDateText = useMemo(() => {
    const d = new Date(`${dateValue}T12:00:00`);
    const opt = DATE_FORMATS.find((f) => f.id === dateFormatId) ?? DATE_FORMATS[0];
    return opt.format(d);
  }, [dateValue, dateFormatId]);

  const addSignatureItem = () => {
    if (!hasSignatureSource) {
      setError("Please draw or choose a signature first.");
      return;
    }
    setError("");
    const item: PlacedItem = {
      id: uid(),
      kind: "signature",
      page_number: currentPage,
      x_percent: 30,
      y_percent: 65,
      width_percent: 26,
      height_percent: 10,
      image_data: activeSignatureImage!,
    };
    updateItems([...items, item]);
    setSelectedId(item.id);
  };

  const addTextItem = (kind: Extract<PlacedItemKind, "name" | "date" | "text">) => {
    const text = kind === "name" ? effectiveSignerName : kind === "date" ? currentDateText : "Certified Approved";
    const item: PlacedItem = {
      id: uid(),
      kind,
      page_number: currentPage,
      x_percent: 30,
      y_percent: 78,
      width_percent: 26,
      height_percent: 6,
      text,
      font_percent: 1.6,
      font_family: "helvetica",
      bold: false,
      italic: false,
      align: "center",
      color: "#1F2933",
      ...(kind === "date" ? { date_iso: new Date(`${dateValue}T12:00:00`).toISOString(), date_format: dateFormatId } : {}),
    };
    updateItems([...items, item]);
    setSelectedId(item.id);
  };

  // Submit / Confirm logic
  const handleConfirm = () => {
    if (!hasSignatureSource) {
      setError("Please provide a signature before continuing.");
      return;
    }

    const roundedItems = items.map((i) => ({
      ...i,
      x_percent: Number(i.x_percent.toFixed(3)),
      y_percent: Number(i.y_percent.toFixed(3)),
      width_percent: Number(i.width_percent.toFixed(3)),
      height_percent: Number(i.height_percent.toFixed(3)),
    }));
    const firstSig = roundedItems.find((i) => i.kind === "signature");

    const formValuesToApply: Record<string, unknown> = {};
    if (selectedSigField) {
      formValuesToApply[selectedSigField] = activeSignatureImage;
    }
    if (applyDateToForm && selectedDateField) {
      formValuesToApply[selectedDateField] = currentDateText;
    }
    if (applyNameToForm && selectedNameField) {
      formValuesToApply[selectedNameField] = effectiveSignerName;
    }

    const resultPayload: SignaturePlacementResult = {
      items: roundedItems,
      timezone: EAT_TZ,
      signaturePlacement: firstSig ? {
        page_number: firstSig.page_number,
        x_percent: firstSig.x_percent,
        y_percent: firstSig.y_percent,
        width_percent: firstSig.width_percent,
      } : null,
      useNewSignature: Boolean(useNewSignature && newSignature),
      signatureImage: activeSignatureImage,
      formFieldValues: formValuesToApply,
    };

    if (onApplyToForm) {
      onApplyToForm(formValuesToApply, resultPayload);
    }
    onConfirm(resultPayload);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 backdrop-blur-sm">
      <div className="flex max-h-[92vh] w-full max-w-5xl flex-col rounded-lg border border-[#C8CDD2] bg-white shadow-xl">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-[#E4E7EB] px-6 py-4">
          <div>
            <div className="flex items-center gap-2">
              <span className="inline-flex items-center gap-1.5 rounded-full bg-[#EBF5FB] px-2.5 py-0.5 text-xs font-semibold text-[#287EAD]">
                <Sparkles className="h-3 w-3" />
                {activeMode === "pdf" ? "PDF Signature Placement" : "Form Signature Application"}
              </span>
              <h2 className="text-lg font-semibold text-[#1F2933]">
                {documentTitle || "Apply Digital Signature"}
              </h2>
            </div>
            {documentRef && <p className="text-xs text-[#5E6870] mt-0.5">Ref: {documentRef}</p>}
          </div>
          <button
            onClick={onCancel}
            disabled={isSubmitting}
            className="rounded p-1 text-[#5E6870] hover:bg-[#F3F5F6] hover:text-[#1F2933]"
          >
            ✕
          </button>
        </div>

        {/* Content Body */}
        <div className="grid flex-1 grid-cols-1 md:grid-cols-12 overflow-hidden min-h-[460px]">
          {/* Controls Sidebar */}
          <div className="md:col-span-4 border-r border-[#E4E7EB] bg-[#F9FAFB] p-5 overflow-y-auto space-y-5">
            {/* Signature Source */}
            <div>
              <label className="text-xs font-bold uppercase tracking-wider text-[#5E6870] mb-2 block">
                Signature Source
              </label>
              <div className="grid grid-cols-2 gap-2 mb-3">
                <button
                  type="button"
                  onClick={() => setUseNewSignature(false)}
                  disabled={!savedSignature?.image_data}
                  className={clsx(
                    "flex flex-col items-center justify-center rounded border p-2.5 text-xs font-medium transition",
                    !useNewSignature
                      ? "border-[#287EAD] bg-[#EEF6FB] text-[#287EAD] font-semibold"
                      : "border-[#C8CDD2] bg-white text-[#5E6870] hover:bg-[#F4F6F8]",
                    !savedSignature?.image_data && "opacity-50 cursor-not-allowed"
                  )}
                >
                  <CheckCircle2 className="h-4 w-4 mb-1" />
                  Saved Signature
                </button>
                <button
                  type="button"
                  onClick={() => setUseNewSignature(true)}
                  className={clsx(
                    "flex flex-col items-center justify-center rounded border p-2.5 text-xs font-medium transition",
                    useNewSignature
                      ? "border-[#287EAD] bg-[#EEF6FB] text-[#287EAD] font-semibold"
                      : "border-[#C8CDD2] bg-white text-[#5E6870] hover:bg-[#F4F6F8]"
                  )}
                >
                  <PenLine className="h-4 w-4 mb-1" />
                  Draw / Upload New
                </button>
              </div>

              {/* Signature display / pad */}
              {!useNewSignature ? (
                <div className="rounded border border-[#C8CDD2] bg-white p-3 text-center min-h-[100px] flex items-center justify-center">
                  {signatureLoading ? (
                    <Loader2 className="h-5 w-5 animate-spin text-[#287EAD]" />
                  ) : savedSignature?.image_data ? (
                    <img
                      src={savedSignature.image_data}
                      alt="Saved Signature"
                      className="max-h-20 object-contain mx-auto"
                    />
                  ) : (
                    <div className="text-xs text-amber-700">
                      No saved signature found. Switch to "Draw / Upload New".
                    </div>
                  )}
                </div>
              ) : (
                <div className="rounded border border-[#C8CDD2] bg-white p-2">
                  <SignaturePad
                    onSave={(dataUrl) => setNewSignature(dataUrl)}
                    onClear={() => setNewSignature(null)}
                  />
                </div>
              )}
            </div>

            {/* Date Selection */}
            <div>
              <label className="text-xs font-bold uppercase tracking-wider text-[#5E6870] mb-2 block">
                Date & Format (EAT)
              </label>
              <div className="space-y-2">
                <input
                  type="date"
                  value={dateValue}
                  onChange={(e) => setDateValue(e.target.value)}
                  className="w-full rounded border border-[#C8CDD2] bg-white px-3 py-1.5 text-xs text-[#1F2933] outline-none focus:border-[#287EAD]"
                />
                <select
                  value={dateFormatId}
                  onChange={(e) => setDateFormatId(e.target.value)}
                  className="w-full rounded border border-[#C8CDD2] bg-white px-3 py-1.5 text-xs text-[#1F2933] outline-none focus:border-[#287EAD]"
                >
                  {DATE_FORMATS.map((f) => (
                    <option key={f.id} value={f.id}>
                      {f.label} ({f.format(new Date(`${dateValue}T12:00:00`))})
                    </option>
                  ))}
                </select>
              </div>
            </div>

            {/* Target Form Fields (Form Mode) */}
            {activeMode === "form" && (
              <div className="border-t border-[#E4E7EB] pt-4 space-y-3">
                <label className="text-xs font-bold uppercase tracking-wider text-[#5E6870] block">
                  Form Field Mapping
                </label>
                <div className="space-y-2 text-xs">
                  <div>
                    <label className="text-[#5E6870] block mb-1">Signature Field:</label>
                    <input
                      type="text"
                      value={selectedSigField}
                      onChange={(e) => setSelectedSigField(e.target.value)}
                      placeholder="e.g. signature or requester_signature"
                      className="w-full rounded border border-[#C8CDD2] bg-white px-2.5 py-1.5 text-xs outline-none focus:border-[#287EAD]"
                    />
                  </div>
                  <div>
                    <div className="flex items-center justify-between mb-1">
                      <label className="text-[#5E6870]">Date Field:</label>
                      <input
                        type="checkbox"
                        checked={applyDateToForm}
                        onChange={(e) => setApplyDateToForm(e.target.checked)}
                      />
                    </div>
                    {applyDateToForm && (
                      <input
                        type="text"
                        value={selectedDateField}
                        onChange={(e) => setSelectedDateField(e.target.value)}
                        placeholder="e.g. signature_date or date"
                        className="w-full rounded border border-[#C8CDD2] bg-white px-2.5 py-1.5 text-xs outline-none focus:border-[#287EAD]"
                      />
                    )}
                  </div>
                  <div>
                    <div className="flex items-center justify-between mb-1">
                      <label className="text-[#5E6870]">Signer Name / Title:</label>
                      <input
                        type="checkbox"
                        checked={applyNameToForm}
                        onChange={(e) => setApplyNameToForm(e.target.checked)}
                      />
                    </div>
                    {applyNameToForm && (
                      <input
                        type="text"
                        value={selectedNameField}
                        onChange={(e) => setSelectedNameField(e.target.value)}
                        placeholder="e.g. signed_by or name"
                        className="w-full rounded border border-[#C8CDD2] bg-white px-2.5 py-1.5 text-xs outline-none focus:border-[#287EAD]"
                      />
                    )}
                  </div>
                </div>
              </div>
            )}

            {/* Stamp Buttons for Canvas Placement */}
            <div className="border-t border-[#E4E7EB] pt-4">
              <label className="text-xs font-bold uppercase tracking-wider text-[#5E6870] mb-2 block">
                Interactive Stamps
              </label>
              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={addSignatureItem}
                  disabled={!hasSignatureSource}
                  className="inline-flex items-center justify-center gap-1.5 rounded border border-[#287EAD] bg-white px-3 py-1.5 text-xs font-semibold text-[#287EAD] hover:bg-[#EEF6FB] disabled:opacity-50"
                >
                  <PenLine className="h-3.5 w-3.5" /> Stamp Signature
                </button>
                <button
                  type="button"
                  onClick={() => addTextItem("date")}
                  className="inline-flex items-center justify-center gap-1.5 rounded border border-[#C8CDD2] bg-white px-3 py-1.5 text-xs font-medium text-[#1F2933] hover:bg-[#F3F5F6]"
                >
                  <CalendarClock className="h-3.5 w-3.5" /> Stamp Date
                </button>
              </div>
              <div className="grid grid-cols-2 gap-2 mt-2">
                <button
                  type="button"
                  onClick={() => addTextItem("name")}
                  className="inline-flex items-center justify-center gap-1.5 rounded border border-[#C8CDD2] bg-white px-3 py-1.5 text-xs font-medium text-[#1F2933] hover:bg-[#F3F5F6]"
                >
                  <TypeIcon className="h-3.5 w-3.5" /> Stamp Name
                </button>
                <button
                  type="button"
                  onClick={undo}
                  disabled={!history.length}
                  className="inline-flex items-center justify-center gap-1.5 rounded border border-[#C8CDD2] bg-white px-3 py-1.5 text-xs font-medium text-[#5E6870] hover:bg-[#F3F5F6] disabled:opacity-40"
                >
                  <Undo2 className="h-3.5 w-3.5" /> Undo
                </button>
              </div>
            </div>
          </div>

          {/* Canvas / Preview Stage */}
          <div className="md:col-span-8 bg-[#E5E9EC] p-6 flex flex-col items-center justify-center overflow-auto relative">
            {error && (
              <div className="absolute top-4 left-4 right-4 z-20 rounded bg-red-50 border border-red-200 p-2.5 text-xs text-red-700">
                {error}
              </div>
            )}

            {activeMode === "pdf" ? (
              <div className="relative border border-[#C8CDD2] bg-white shadow-md">
                <div ref={setHostEl} />
                {/* Placed overlay items */}
                {items
                  .filter((i) => i.page_number === currentPage)
                  .map((item) => (
                    <div
                      key={item.id}
                      onClick={() => setSelectedId(item.id)}
                      style={{
                        position: "absolute",
                        left: `${item.x_percent}%`,
                        top: `${item.y_percent}%`,
                        width: `${item.width_percent}%`,
                        height: `${item.height_percent}%`,
                      }}
                      className={clsx(
                        "group cursor-move select-none border border-dashed p-1",
                        selectedId === item.id ? "border-[#287EAD] bg-blue-50/20" : "border-transparent"
                      )}
                    >
                      {item.kind === "signature" && item.image_data ? (
                        <img src={item.image_data} alt="signature" className="h-full w-full object-contain" />
                      ) : (
                        <div
                          style={{
                            fontFamily: FONT_CSS[item.font_family || "helvetica"],
                            color: item.color || "#1F2933",
                            textAlign: item.align || "center",
                          }}
                          className="h-full w-full flex items-center justify-center text-xs font-medium"
                        >
                          {item.text}
                        </div>
                      )}
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          removeItem(item.id);
                        }}
                        className="absolute -top-2 -right-2 hidden group-hover:flex h-5 w-5 items-center justify-center rounded-full bg-red-500 text-white text-[10px]"
                      >
                        ✕
                      </button>
                    </div>
                  ))}
              </div>
            ) : (
              /* Direct Form Mode Preview Card */
              <div className="w-full max-w-lg rounded-lg border border-[#C8CDD2] bg-white p-6 shadow-sm">
                <div className="border-b border-[#E4E7EB] pb-3 mb-4 flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <FileText className="h-5 w-5 text-[#287EAD]" />
                    <h3 className="text-sm font-semibold text-[#1F2933]">Requisition Form Sign-off</h3>
                  </div>
                  <span className="text-xs text-[#5E6870]">Verification stamp</span>
                </div>

                <div className="space-y-4">
                  {/* Signature Box */}
                  <div className="rounded border-2 border-dashed border-[#C8CDD2] bg-[#FAFBFB] p-4 text-center">
                    <span className="text-xs font-medium text-[#5E6870] mb-2 block">
                      Target Field: <code className="text-[#287EAD]">{selectedSigField}</code>
                    </span>
                    {activeSignatureImage ? (
                      <div className="flex flex-col items-center justify-center">
                        <img
                          src={activeSignatureImage}
                          alt="Signature Preview"
                          className="max-h-24 object-contain"
                        />
                        <span className="mt-2 text-[11px] text-emerald-600 font-medium flex items-center gap-1">
                          <Check className="h-3 w-3" /> Ready to bind to form
                        </span>
                      </div>
                    ) : (
                      <p className="text-xs text-[#5E6870]">No signature selected yet</p>
                    )}
                  </div>

                  {/* Date & Signer Details */}
                  <div className="grid grid-cols-2 gap-3 text-xs bg-[#F4F6F8] p-3 rounded">
                    <div>
                      <span className="text-[#5E6870] block">Signer Name:</span>
                      <span className="font-semibold text-[#1F2933]">{effectiveSignerName}</span>
                    </div>
                    <div>
                      <span className="text-[#5E6870] block">Date (EAT):</span>
                      <span className="font-semibold text-[#1F2933]">{currentDateText}</span>
                    </div>
                  </div>
                </div>

                {note && <p className="mt-4 text-xs italic text-[#5E6870]">{note}</p>}
              </div>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between border-t border-[#E4E7EB] bg-white px-6 py-4">
          <p className="text-xs text-[#5E6870]">
            Signatures and date stamps are verified and securely bound upon confirmation.
          </p>
          <div className="flex items-center gap-3">
            <button
              onClick={onCancel}
              disabled={isSubmitting}
              className="rounded border border-[#AEB5BB] bg-white px-4 py-2 text-sm font-semibold text-[#1F2933] hover:bg-[#F3F5F6]"
            >
              Cancel
            </button>
            <button
              onClick={handleConfirm}
              disabled={isSubmitting || !hasSignatureSource}
              className="inline-flex items-center gap-2 rounded bg-[#287EAD] px-5 py-2 text-sm font-semibold text-white hover:bg-[#1E6F99] disabled:opacity-50"
            >
              {isSubmitting ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              {confirmLabel}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}