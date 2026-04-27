import { useState, useCallback, useEffect, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { useDropzone } from "react-dropzone";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  useForm,
  useFieldArray,
  Controller,
  type Control,
  type UseFormRegister,
  type UseFormSetValue,
} from "react-hook-form";
import { documentsAPI, documentTypesAPI, normalizeListResponse } from "@/services/api";
import {
  Upload,
  File,
  X,
  Loader2,
  ArrowRight,
  CheckCircle,
  Plus,
  Lock,
  Users,
  Info,
  ScanLine,
  FileText,
  Sparkles,
  AlertCircle,
  ChevronRight,
  RotateCcw,
  ShieldAlert,
} from "lucide-react";
import { toast } from "react-toastify";
import type { DocumentType, MetadataField } from "@/types";
import clsx from "clsx";

// ── Types ─────────────────────────────────────────────────────────────────────

type PersonalTagField = { value: string };

type UploadFormValues = {
  title: string;
  supplier?: string;
  amount?: string;
  currency?: string;
  document_date?: string;
  due_date?: string;
  metadata: Record<string, unknown>;
  personal_tags: PersonalTagField[];
};

/**
 * OCR suggestions shape — mirrors the new backend response.
 *
 * The backend now returns:
 *   { ocr_status, suggestions: { fields: {...}, quality: {...} } }
 *
 * `fields` carries every extracted key (reference_number, account_code, etc.)
 * `quality` carries { mean_confidence, overall_quality_ratio, low_quality_warning, … }
 */
type OcrFields = {
  title?: string;
  supplier?: string;
  amount?: string;
  currency?: string;
  document_date?: string;
  due_date?: string;
  reference_number?: string;
  document_type?: string;
  account_code?: string;
  cost_centre?: string;
  vendor_code?: string;
  approved_by?: string;
  payment_terms?: string;
  tax_amount?: string;
  subtotal?: string;
  payment_method?: string;
  transaction_ref?: string;
  kra_pin?: string;
  vat_number?: string;
  po_reference?: string;
  signed_by?: string;
  contract_value?: string;
  raw_lines?: string[];
};

type OcrQuality = {
  mean_confidence?: number;
  overall_quality_ratio?: number;
  low_quality_warning?: boolean;
  total_pages?: number;
  low_quality_pages?: number;
};

type OcrSuggestions = {
  fields?: OcrFields;
  quality?: OcrQuality;
};

// Stage of the scanned-upload flow
type ScanStage =
  | "idle"            // nothing uploaded yet
  | "uploading"       // axios progress
  | "ocr_pending"     // uploaded, OCR not started
  | "ocr_processing"  // OCR in progress
  | "ocr_done"        // suggestions ready → show review form
  | "ocr_failed"      // OCR failed → let user fill manually
  | "submitting";     // saving final metadata

// ── Helpers ───────────────────────────────────────────────────────────────────

const CURRENCY_OPTIONS = ["KES", "USD", "EUR", "GBP", "UGX", "TZS", "NGN", "ZAR"];

function SuggestionPill({ label }: { label: string }) {
  return (
    <span className="inline-flex items-center gap-1 text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-teal/15 text-teal border border-teal/25">
      <Sparkles className="w-2.5 h-2.5" />
      {label}
    </span>
  );
}

function LowQualityBanner({ quality }: { quality: OcrQuality }) {
  const pct = Math.round((quality.overall_quality_ratio ?? 0) * 100);
  return (
    <div className="flex items-start gap-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 mb-6">
      <ShieldAlert className="w-5 h-5 text-amber-500 flex-shrink-0 mt-0.5" />
      <div>
        <p className="text-sm font-semibold text-amber-800">Low scan quality ({pct}% confident)</p>
        <p className="text-xs text-amber-700 mt-0.5">
          The scan may be blurry, skewed, or low-resolution. Please verify all pre-filled fields carefully before saving.
        </p>
      </div>
    </div>
  );
}

// ── Dynamic metadata field ────────────────────────────────────────────────────

function DynamicField({
  field,
  register,
  control,
  errors,
  enforceRequired,
  suggested,
}: {
  field: MetadataField;
  register: UseFormRegister<UploadFormValues>;
  control: Control<UploadFormValues>;
  errors: Record<string, { message?: string }>;
  enforceRequired: boolean;
  suggested?: boolean;
}) {
  const rules =
    field.is_required && enforceRequired
      ? { required: `${field.label} is required` }
      : {};
  const requiredMark =
    field.is_required && enforceRequired ? (
      <span className="text-destructive ml-1">*</span>
    ) : null;
  const errMsg = errors[`metadata.${field.key}`]?.message;

  const wrapper = (children: React.ReactNode) => (
    <div>
      <label className="label flex items-center gap-1.5">
        {field.label}
        {requiredMark}
        {suggested && <SuggestionPill label="OCR" />}
      </label>
      {children}
      {errMsg && <p className="text-destructive text-xs mt-1">{errMsg}</p>}
    </div>
  );

  if (field.field_type === "select") {
    return wrapper(
      <Controller
        name={`metadata.${field.key}`}
        control={control}
        rules={rules}
        render={({ field: f }) => (
          <select {...f} value={String(f.value ?? "")} className="input">
            <option value="">Select…</option>
            {(field.select_options ?? []).map((opt) => (
              <option key={opt} value={opt}>
                {opt}
              </option>
            ))}
          </select>
        )}
      />
    );
  }
  if (field.field_type === "boolean") {
    return (
      <div className="flex items-center gap-2">
        <input
          {...register(`metadata.${field.key}`)}
          type="checkbox"
          id={field.key}
          className="w-4 h-4 rounded border-border text-primary focus:ring-primary"
        />
        <label htmlFor={field.key} className="text-sm text-foreground">
          {field.label}
        </label>
      </div>
    );
  }
  if (field.field_type === "textarea") {
    return wrapper(
      <textarea {...register(`metadata.${field.key}`, rules)} rows={3} className="input" />
    );
  }
  const inputType =
    field.field_type === "date"
      ? "date"
      : field.field_type === "number" || field.field_type === "currency"
      ? "number"
      : "text";
  return wrapper(
    <input
      {...register(`metadata.${field.key}`, rules)}
      type={inputType}
      step={field.field_type === "currency" ? "0.01" : undefined}
      placeholder={field.default_value || field.help_text || ""}
      className={clsx("input", suggested && "ring-1 ring-teal/40")}
    />
  );
}

// ── Personal tag row ──────────────────────────────────────────────────────────

function PersonalTagRow({
  index,
  total,
  register,
  onRemove,
}: {
  index: number;
  total: number;
  register: UseFormRegister<UploadFormValues>;
  onRemove: () => void;
}) {
  return (
    <div className="flex items-center gap-2 rounded-full border border-primary/20 bg-primary/5 px-3 py-2 shadow-sm">
      <span className="inline-flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
        <Lock className="w-3.5 h-3.5" />
      </span>
      <input
        {...register(`personal_tags.${index}.value` as const)}
        className="min-w-0 flex-1 border-0 bg-transparent p-0 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-0"
        placeholder={`Tag ${index + 1}`}
        aria-label={`Personal tag ${index + 1}`}
      />
      <button
        type="button"
        onClick={onRemove}
        disabled={total === 1}
        className="inline-flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full border border-border bg-card text-muted-foreground hover:text-destructive hover:border-destructive/30 hover:bg-destructive/5 disabled:opacity-40 disabled:cursor-not-allowed"
        title="Remove tag"
        aria-label={`Remove personal tag ${index + 1}`}
      >
        <X className="w-4 h-4" />
      </button>
    </div>
  );
}

// ── OCR polling hook ──────────────────────────────────────────────────────────

function useOcrPoller(
  documentId: string | null,
  enabled: boolean,
  onDone: (suggestions: OcrSuggestions) => void,
  onFailed: () => void
) {
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (!enabled || !documentId) return;

    const poll = async () => {
      try {
        const { data } = await documentsAPI.ocrSuggestions(documentId);
        if (data.ocr_status === "done") {
          if (intervalRef.current) clearInterval(intervalRef.current);
          // Handle both the old flat shape and the new nested shape gracefully.
          // New shape: data.suggestions = { fields: {...}, quality: {...} }
          // Old/flat shape: data.suggestions = { title, supplier, ... }
          const raw = data.suggestions as Record<string, unknown> | null;
          let parsed: OcrSuggestions = {};
          if (raw && typeof raw === "object") {
            if ("fields" in raw || "quality" in raw) {
              // New nested shape
              parsed = raw as OcrSuggestions;
            } else {
              // Legacy flat shape — wrap it
              parsed = { fields: raw as OcrFields };
            }
          }
          onDone(parsed);
        } else if (data.ocr_status === "failed") {
          if (intervalRef.current) clearInterval(intervalRef.current);
          onFailed();
        }
      } catch {
        // transient network error — keep polling
      }
    };

    poll();
    intervalRef.current = setInterval(poll, 3000);
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [documentId, enabled]);
}

// ── OCR status screen ─────────────────────────────────────────────────────────

function OcrWaitScreen({
  stage,
  fileName,
  rawLines,
  onSkip,
}: {
  stage: "ocr_pending" | "ocr_processing";
  fileName: string;
  rawLines?: string[];
  onSkip: () => void;
}) {
  return (
    <div className="flex flex-col items-center py-16 px-6 text-center">
      <div className="relative w-20 h-20 mb-6">
        <div className="absolute inset-0 rounded-full bg-teal/10 animate-ping" />
        <div className="relative w-20 h-20 rounded-full bg-teal/15 flex items-center justify-center">
          <ScanLine className="w-9 h-9 text-teal" />
        </div>
      </div>
      <h2 className="text-2xl font-bold text-foreground mb-2">
        {stage === "ocr_pending" ? "Queued for OCR…" : "Extracting text…"}
      </h2>
      <p className="text-muted-foreground max-w-sm mb-1">
        <span className="font-medium text-foreground">{fileName}</span> has been uploaded.
        The OCR pipeline is running in the background.
      </p>
      <p className="text-sm text-muted-foreground mb-8">
        This usually takes a few seconds. The form will appear automatically when ready.
      </p>

      {rawLines && rawLines.length > 0 && (
        <div className="w-full max-w-md text-left rounded-xl border border-border bg-muted/40 p-4 mb-6">
          <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2">
            Detected text (preview)
          </p>
          <div className="space-y-0.5 max-h-32 overflow-y-auto">
            {rawLines.slice(0, 12).map((line, i) => (
              <p key={i} className="text-xs text-foreground font-mono truncate">
                {line}
              </p>
            ))}
          </div>
        </div>
      )}

      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="w-4 h-4 animate-spin" />
        <span>Processing…</span>
      </div>

      <button
        type="button"
        onClick={onSkip}
        className="mt-6 text-sm text-muted-foreground underline underline-offset-2 hover:text-foreground"
      >
        Skip OCR and fill manually
      </button>
    </div>
  );
}

// ── Step indicator ────────────────────────────────────────────────────────────

function StepBadge({
  n,
  active,
  done,
}: {
  n: number;
  active?: boolean;
  done?: boolean;
}) {
  return (
    <div
      className={clsx(
        "w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold flex-shrink-0 transition-colors",
        done
          ? "bg-teal text-white"
          : active
          ? "bg-primary text-primary-foreground"
          : "bg-muted text-muted-foreground"
      )}
    >
      {done ? <CheckCircle className="w-3.5 h-3.5" /> : n}
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export default function UploadPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  // ── File & type ─────────────────────────────────────────────────────────────
  const [droppedFile, setDroppedFile] = useState<File | null>(null);
  const [selectedTypeId, setSelectedTypeId] = useState("");
  const [uploadProgress, setUploadProgress] = useState(0);

  // ── Mode flags ──────────────────────────────────────────────────────────────
  const [isSelfUpload, setIsSelfUpload] = useState(false);
  const [isScanned, setIsScanned] = useState(false);
  const [imageAutoScanned, setImageAutoScanned] = useState(false);

  // ── OCR scan flow state ─────────────────────────────────────────────────────
  const [scanStage, setScanStage] = useState<ScanStage>("idle");
  const [uploadedDocId, setUploadedDocId] = useState<string | null>(null);
  const [ocrSuggestions, setOcrSuggestions] = useState<OcrSuggestions | null>(null);
  const [suggestedFields, setSuggestedFields] = useState<Set<string>>(new Set());

  // ── Form ────────────────────────────────────────────────────────────────────
  const {
    register,
    handleSubmit,
    control,
    reset,
    setValue,
    clearErrors,
    formState: { errors },
  } = useForm<UploadFormValues>({
    defaultValues: { metadata: {}, personal_tags: [{ value: "" }], currency: "KES" },
  });

  const {
    fields: personalTagFields,
    append: appendPersonalTag,
    remove: removePersonalTag,
    replace: replacePersonalTags,
  } = useFieldArray({ control, name: "personal_tags" });

  // ── Document types ──────────────────────────────────────────────────────────
  const { data: docTypes = [] } = useQuery<unknown, Error, DocumentType[]>({
    queryKey: ["document-types"],
    queryFn: () => documentTypesAPI.list().then((r) => r.data as unknown),
    select: (data) => normalizeListResponse<DocumentType>(data),
  });
  const selectedType = docTypes.find((t) => t.id === selectedTypeId);

  // ── Derived state ───────────────────────────────────────────────────────────
  const isOcrFlow = isScanned && !isSelfUpload;

  // The right panel details form is visible when:
  // - NOT in OCR flow (manual mode) AND
  // - a type is selected (or it's a personal upload) AND
  // - we're in the idle stage (not mid-upload)
  const showManualForm =
    !isOcrFlow &&
    (isSelfUpload || Boolean(selectedTypeId)) &&
    scanStage === "idle";

  // The OCR right-panel info box is visible when in OCR flow and idle
  const showOcrIdlePanel = isOcrFlow && scanStage === "idle";

  const showOcrWait =
    isOcrFlow && (scanStage === "ocr_pending" || scanStage === "ocr_processing");
  const showOcrReview = isOcrFlow && scanStage === "ocr_done";
  const showOcrFailed = isOcrFlow && scanStage === "ocr_failed";

  const hasMetadata =
    !isSelfUpload && !!selectedType && selectedType.metadata_fields.length > 0;
  const relaxReq = isSelfUpload || isScanned;

  // ── Side-effects ────────────────────────────────────────────────────────────

  // When type changes, reset form fields but NOT the dropped file.
  // The file should persist across type changes (user selects type first, then drops file).
  useEffect(() => {
    if (selectedTypeId) {
      reset({
        metadata: {},
        personal_tags: [{ value: "" }],
        currency: "KES",
        title: "",
        supplier: "",
        amount: "",
        document_date: "",
        due_date: "",
      });
      setUploadProgress(0);
    }
  }, [selectedTypeId, reset]);

  useEffect(() => {
    clearErrors();
  }, [isSelfUpload, isScanned, clearErrors]);

  useEffect(() => {
    if (isSelfUpload) {
      setSelectedTypeId("");
      replacePersonalTags([{ value: "" }]);
      setIsScanned(false);
    }
  }, [isSelfUpload, replacePersonalTags]);

  // ── OCR poller ──────────────────────────────────────────────────────────────

  useOcrPoller(
    uploadedDocId,
    isOcrFlow && (scanStage === "ocr_pending" || scanStage === "ocr_processing"),
    (suggestions) => {
      setOcrSuggestions(suggestions);
      setScanStage("ocr_done");

      // Pre-fill form with extracted fields
      const fields = suggestions.fields ?? {};
      const fieldsSet = new Set<string>();

      const fill = (key: keyof UploadFormValues, value: string | undefined) => {
        if (value) {
          setValue(key, value);
          fieldsSet.add(key);
        }
      };

      fill("title", fields.title);
      fill("supplier", fields.supplier);
      fill("amount", fields.amount);
      fill("currency", fields.currency);
      fill("document_date", fields.document_date);
      fill("due_date", fields.due_date);

      setSuggestedFields(fieldsSet);

      const warn = suggestions.quality?.low_quality_warning;
      if (warn) {
        toast.warning("OCR complete — low scan quality detected. Please verify all fields carefully.");
      } else {
        toast.success("OCR complete! Review the extracted details below.");
      }
    },
    () => {
      setScanStage("ocr_failed");
      toast.warning("OCR could not extract text. Please fill in the details manually.");
    }
  );

  // ── Dropzone ────────────────────────────────────────────────────────────────

  const onDrop = useCallback((accepted: File[]) => {
    const file = accepted[0];
    if (!file) return;
    setDroppedFile(file);
    const isImage = file.type.startsWith("image/");
    if (isImage) {
      setIsScanned(true);
      setImageAutoScanned(true);
    } else {
      setImageAutoScanned(false);
    }
  }, []);

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    maxFiles: 1,
    accept: {
      "application/pdf": [".pdf"],
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document": [".docx"],
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": [".xlsx"],
      "application/msword": [".doc"],
      "image/*": [".png", ".jpg", ".jpeg", ".tiff", ".bmp", ".webp"],
    },
  });

  // ── Upload mutation ─────────────────────────────────────────────────────────

  const uploadMutation = useMutation({
    mutationFn: (fd: FormData) =>
      documentsAPI.upload(fd, {
        onUploadProgress: (e: { loaded: number; total?: number }) => {
          if (e.total) setUploadProgress(Math.round((e.loaded * 100) / e.total));
        },
      }),
    onSuccess: ({ data }) => {
      setUploadProgress(0);
      if (isOcrFlow) {
        setUploadedDocId(data.id);
        setScanStage(
          data.ocr_status === "processing" ? "ocr_processing" : "ocr_pending"
        );
      } else {
        const msg = isSelfUpload ? "Personal document saved" : "Document uploaded";
        toast.success(`${msg}: ${data.reference_number}`);
        queryClient.invalidateQueries({ queryKey: ["documents"] });
        navigate(`/documents/${data.id}`);
      }
    },
    onError: () => {
      toast.error("Upload failed. Please try again.");
      setUploadProgress(0);
      setScanStage("idle");
    },
  });

  // ── Metadata-save mutation ──────────────────────────────────────────────────

  const saveMutation = useMutation({
    mutationFn: ({ id, payload }: { id: string; payload: Record<string, unknown> }) =>
      documentsAPI.editMetadata(id, payload),
    onSuccess: (_, { id }) => {
      queryClient.invalidateQueries({ queryKey: ["documents"] });
      toast.success("Details confirmed and saved.");
      navigate(`/documents/${id}`);
    },
    onError: () => {
      toast.error("Could not save details. Please try again.");
      setScanStage("ocr_done");
    },
  });

  // ── Submit handlers ─────────────────────────────────────────────────────────

  const onUpload = (values: Record<string, unknown>) => {
    if (!droppedFile) { toast.error("Please select a file"); return; }
    if (!isSelfUpload && !selectedTypeId) {
      toast.error("Please select a document type");
      return;
    }

    const personalTags = (Array.isArray(values.personal_tags) ? values.personal_tags : [])
      .map((tag) => {
        if (typeof tag === "string") return tag.trim();
        if (tag && typeof tag === "object" && "value" in tag)
          return String((tag as { value?: unknown }).value ?? "").trim();
        return "";
      })
      .filter(Boolean);

    if (isSelfUpload && personalTags.length === 0) {
      toast.error("Please add at least one personal tag.");
      return;
    }

    const fd = new FormData();
    fd.append("file", droppedFile);
    fd.append(
      "title",
      isOcrFlow
        ? (droppedFile.name.replace(/\.[^.]+$/, "") || "Scanned document")
        : (values.title as string)
    );
    if (!isSelfUpload) fd.append("document_type_id", selectedTypeId);
    fd.append("is_self_upload", isSelfUpload ? "true" : "false");
    fd.append("is_scanned", isScanned ? "true" : "false");
    if (!isOcrFlow && values.supplier) fd.append("supplier", values.supplier as string);
    if (!isOcrFlow && values.amount) fd.append("amount", values.amount as string);
    if (!isOcrFlow && values.currency) fd.append("currency", values.currency as string);
    if (!isOcrFlow && values.document_date) fd.append("document_date", values.document_date as string);
    personalTags.forEach((tag) => fd.append("personal_tags", tag));
    if (!isSelfUpload && !isOcrFlow && values.metadata && Object.keys(values.metadata as object).length > 0)
      fd.append("metadata", JSON.stringify(values.metadata));

    setScanStage(isOcrFlow ? "uploading" : "idle");
    uploadMutation.mutate(fd);
  };

  const onConfirmOcr = handleSubmit((values) => {
    if (!uploadedDocId) return;
    setScanStage("submitting");

    const payload: Record<string, unknown> = { title: values.title };
    if (values.supplier) payload.supplier = values.supplier;
    if (values.amount) payload.amount = values.amount;
    if (values.currency) payload.currency = values.currency;
    if (values.document_date) payload.document_date = values.document_date;
    if (values.due_date) payload.due_date = values.due_date;
    if (values.metadata && Object.keys(values.metadata).length > 0)
      payload.metadata = values.metadata;

    saveMutation.mutate({ id: uploadedDocId, payload });
  });

  const onSkipToDocument = () => {
    if (!uploadedDocId) return;
    queryClient.invalidateQueries({ queryKey: ["documents"] });
    navigate(`/documents/${uploadedDocId}`);
  };

  // ── Convenience ─────────────────────────────────────────────────────────────

  const ocrFields = ocrSuggestions?.fields ?? {};
  const ocrQuality = ocrSuggestions?.quality;
  const isLowQuality = ocrQuality?.low_quality_warning === true;

  // ── Render ──────────────────────────────────────────────────────────────────

  return (
    <div className="max-w-5xl mx-auto py-8">
      {/* Header */}
      <div className="mb-8">
        <h1 className="text-3xl font-bold text-foreground tracking-tight">
          Upload Document
        </h1>
        <p className="text-muted-foreground mt-1">
          Select a document type, attach your file, then fill in the details.
        </p>
      </div>

      {/* ── OCR wait / review / submitting screens ─────────────────────────── */}
      {isOcrFlow && scanStage !== "idle" && scanStage !== "uploading" && (
        <div
          className="bg-card rounded-2xl border border-border"
          style={{ boxShadow: "var(--shadow-card)" }}
        >
          {showOcrWait && (
            <OcrWaitScreen
              stage={scanStage as "ocr_pending" | "ocr_processing"}
              fileName={droppedFile?.name ?? ""}
              rawLines={ocrFields.raw_lines}
              onSkip={() => {
                setScanStage("ocr_done");
                toast.info("Fill in the details manually and confirm.");
              }}
            />
          )}

          {(showOcrReview || showOcrFailed) && (
            <div className="p-8">
              {/* Review header */}
              <div className="flex items-center gap-3 mb-6">
                {showOcrFailed ? (
                  <div className="w-10 h-10 rounded-xl bg-amber-100 flex items-center justify-center">
                    <AlertCircle className="w-5 h-5 text-amber-600" />
                  </div>
                ) : (
                  <div className="w-10 h-10 rounded-xl bg-teal/15 flex items-center justify-center">
                    <Sparkles className="w-5 h-5 text-teal" />
                  </div>
                )}
                <div>
                  <h2 className="text-xl font-bold text-foreground">
                    {showOcrFailed ? "OCR could not extract text" : "Review extracted details"}
                  </h2>
                  <p className="text-sm text-muted-foreground">
                    {showOcrFailed
                      ? "Please fill in the details manually and confirm."
                      : "Fields marked with the OCR badge were auto-filled. Check them before saving."}
                  </p>
                </div>

                {/* Reference number chip — uses reference_number (new) */}
                {ocrFields.reference_number && (
                  <div className="ml-auto text-right hidden sm:block">
                    <p className="text-xs text-muted-foreground">Detected reference</p>
                    <p className="text-sm font-mono font-semibold text-foreground">
                      {ocrFields.reference_number}
                    </p>
                  </div>
                )}
              </div>

              {/* Low-quality warning banner */}
              {isLowQuality && ocrQuality && <LowQualityBanner quality={ocrQuality} />}

              {/* OCR raw text preview */}
              {ocrFields.raw_lines && ocrFields.raw_lines.length > 0 && (
                <details className="mb-6 group">
                  <summary className="cursor-pointer list-none flex items-center gap-2 text-sm font-medium text-muted-foreground hover:text-foreground select-none">
                    <ChevronRight className="w-4 h-4 transition-transform group-open:rotate-90" />
                    Show extracted text ({ocrFields.raw_lines.length} lines)
                  </summary>
                  <div className="mt-2 rounded-xl border border-border bg-muted/40 p-4 max-h-48 overflow-y-auto">
                    {ocrFields.raw_lines.map((line, i) => (
                      <p key={i} className="text-xs font-mono text-foreground leading-relaxed">
                        {line}
                      </p>
                    ))}
                  </div>
                </details>
              )}

              {/* Review form */}
              <div className="space-y-6">
                {/* Title */}
                <div>
                  <label className="label flex items-center gap-1.5">
                    Document Title <span className="text-destructive">*</span>
                    {suggestedFields.has("title") && <SuggestionPill label="OCR" />}
                  </label>
                  <input
                    {...register("title", { required: "Title is required" })}
                    className={clsx("input", suggestedFields.has("title") && "ring-1 ring-teal/40")}
                    placeholder="e.g. Acme Corp Invoice March 2026"
                  />
                  {errors.title && (
                    <p className="text-destructive text-xs mt-1">{String(errors.title.message)}</p>
                  )}
                </div>

                {/* Supplier + Document Date */}
                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                  <div>
                    <label className="label flex items-center gap-1.5">
                      Supplier / Vendor
                      {suggestedFields.has("supplier") && <SuggestionPill label="OCR" />}
                    </label>
                    <input
                      {...register("supplier")}
                      className={clsx("input", suggestedFields.has("supplier") && "ring-1 ring-teal/40")}
                      placeholder="Supplier name"
                    />
                  </div>
                  <div>
                    <label className="label flex items-center gap-1.5">
                      Document Date
                      {suggestedFields.has("document_date") && <SuggestionPill label="OCR" />}
                    </label>
                    <input
                      {...register("document_date")}
                      type="date"
                      className={clsx("input", suggestedFields.has("document_date") && "ring-1 ring-teal/40")}
                    />
                  </div>
                </div>

                {/* Amount + Currency + Due Date */}
                <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                  <div>
                    <label className="label flex items-center gap-1.5">
                      Amount
                      {suggestedFields.has("amount") && <SuggestionPill label="OCR" />}
                    </label>
                    <input
                      {...register("amount")}
                      type="number"
                      step="0.01"
                      className={clsx("input", suggestedFields.has("amount") && "ring-1 ring-teal/40")}
                      placeholder="0.00"
                    />
                  </div>
                  <div>
                    <label className="label flex items-center gap-1.5">
                      Currency
                      {suggestedFields.has("currency") && <SuggestionPill label="OCR" />}
                    </label>
                    <select
                      {...register("currency")}
                      className={clsx("input", suggestedFields.has("currency") && "ring-1 ring-teal/40")}
                    >
                      {CURRENCY_OPTIONS.map((c) => (
                        <option key={c} value={c}>{c}</option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="label flex items-center gap-1.5">
                      Due Date
                      {suggestedFields.has("due_date") && <SuggestionPill label="OCR" />}
                    </label>
                    <input
                      {...register("due_date")}
                      type="date"
                      className={clsx("input", suggestedFields.has("due_date") && "ring-1 ring-teal/40")}
                    />
                  </div>
                </div>

                {/* Extra OCR-detected fields shown as read-only info chips */}
                {(ocrFields.reference_number || ocrFields.account_code || ocrFields.document_type) && (
                  <div>
                    <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2">
                      Additional detected information
                    </p>
                    <div className="flex flex-wrap gap-2">
                      {ocrFields.reference_number && (
                        <span className="inline-flex items-center gap-1.5 text-xs bg-muted border border-border rounded-full px-3 py-1">
                          <span className="text-muted-foreground">Ref:</span>
                          <span className="font-mono font-medium text-foreground">{ocrFields.reference_number}</span>
                        </span>
                      )}
                      {ocrFields.document_type && (
                        <span className="inline-flex items-center gap-1.5 text-xs bg-muted border border-border rounded-full px-3 py-1">
                          <span className="text-muted-foreground">Type:</span>
                          <span className="font-medium text-foreground">{ocrFields.document_type}</span>
                        </span>
                      )}
                      {ocrFields.account_code && (
                        <span className="inline-flex items-center gap-1.5 text-xs bg-muted border border-border rounded-full px-3 py-1">
                          <span className="text-muted-foreground">Account:</span>
                          <span className="font-mono font-medium text-foreground">{ocrFields.account_code}</span>
                        </span>
                      )}
                      {ocrFields.kra_pin && (
                        <span className="inline-flex items-center gap-1.5 text-xs bg-muted border border-border rounded-full px-3 py-1">
                          <span className="text-muted-foreground">KRA PIN:</span>
                          <span className="font-mono font-medium text-foreground">{ocrFields.kra_pin}</span>
                        </span>
                      )}
                    </div>
                  </div>
                )}

                {/* Dynamic metadata for the selected document type */}
                {hasMetadata && (
                  <div>
                    <h3 className="font-semibold text-foreground mb-4 flex items-center gap-2">
                      <CheckCircle className="w-5 h-5 text-teal" />
                      Additional Information
                    </h3>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                      {[...selectedType!.metadata_fields]
                        .sort((a, b) => a.order - b.order)
                        .map((field) => (
                          <DynamicField
                            key={field.id}
                            field={field}
                            register={register}
                            control={control}
                            errors={errors as Record<string, { message?: string }>}
                            enforceRequired={false}
                            suggested={false}
                          />
                        ))}
                    </div>
                  </div>
                )}

                {/* Actions */}
                <div className="flex gap-4 pt-4 border-t border-border">
                  <button
                    type="button"
                    onClick={onConfirmOcr}
                    disabled={saveMutation.isPending}
                    className="flex-1 flex items-center justify-center gap-2 text-base py-3 rounded-xl font-semibold bg-teal text-teal-foreground hover:bg-teal/90 transition-all disabled:opacity-50"
                    style={{ boxShadow: "var(--shadow-elegant)" }}
                  >
                    {saveMutation.isPending ? (
                      <Loader2 className="w-5 h-5 animate-spin" />
                    ) : (
                      <>
                        <CheckCircle className="w-5 h-5" />
                        Confirm & Save
                        <ArrowRight className="w-4 h-4" />
                      </>
                    )}
                  </button>
                  <button
                    type="button"
                    onClick={onSkipToDocument}
                    className="px-6 py-3 rounded-xl font-semibold border border-border bg-card text-foreground hover:bg-muted transition-colors text-sm"
                  >
                    Skip for now
                  </button>
                </div>
              </div>
            </div>
          )}

          {scanStage === "submitting" && (
            <div className="flex flex-col items-center py-12 text-center">
              <Loader2 className="w-10 h-10 animate-spin text-teal mb-4" />
              <p className="text-foreground font-medium">Saving…</p>
            </div>
          )}
        </div>
      )}

      {/* ── Main upload layout (idle / uploading) ─────────────────────────── */}
      {(scanStage === "idle" || scanStage === "uploading") && (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-8">

          {/* ── Left column ────────────────────────────────────────────────── */}
          <div className="lg:col-span-5 space-y-6">

            {/* Step 1 — Document Type (FIRST now) */}
            <div
              className="bg-card rounded-2xl border border-border p-6"
              style={{ boxShadow: "var(--shadow-card)" }}
            >
              <h2 className="font-semibold text-foreground mb-4 flex items-center gap-2">
                <StepBadge n={1} active={!isSelfUpload && !selectedTypeId} done={isSelfUpload || Boolean(selectedTypeId)} />
                {isSelfUpload ? "Personal Document" : "Document Type"}
              </h2>

              {isSelfUpload ? (
                <p className="text-sm text-muted-foreground">
                  Personal documents don't need a type. Add tags in the next step.
                </p>
              ) : (
                <>
                  <select
                    value={selectedTypeId}
                    onChange={(e) => setSelectedTypeId(e.target.value)}
                    className="input w-full"
                  >
                    <option value="">— Choose document type —</option>
                    {docTypes.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.name}
                      </option>
                    ))}
                  </select>
                  {selectedType?.description && (
                    <p className="mt-3 text-xs text-muted-foreground">
                      {selectedType.description}
                    </p>
                  )}
                </>
              )}
            </div>

            {/* Step 2 — Attach File */}
            <div
              className="bg-card rounded-2xl border border-border p-6"
              style={{ boxShadow: "var(--shadow-card)" }}
            >
              <h2 className="font-semibold text-foreground mb-4 flex items-center gap-2">
                <StepBadge n={2} active={Boolean(isSelfUpload || selectedTypeId) && !droppedFile} done={Boolean(droppedFile)} />
                Attach File
              </h2>
              <div
                {...getRootProps()}
                className={clsx(
                  "border-2 border-dashed rounded-2xl p-8 text-center cursor-pointer transition-all",
                  isDragActive
                    ? "border-primary bg-primary/5"
                    : droppedFile
                    ? isScanned
                      ? "border-teal/50 bg-teal/5"
                      : "border-primary/50 bg-primary/5"
                    : "border-border hover:border-primary/50 hover:bg-muted/40"
                )}
              >
                <input {...getInputProps()} />
                {droppedFile ? (
                  <div className="flex flex-col items-center">
                    <div
                      className={clsx(
                        "w-12 h-12 rounded-xl flex items-center justify-center mb-3",
                        isScanned ? "bg-teal/15" : "bg-primary/10"
                      )}
                    >
                      {isScanned ? (
                        <ScanLine className="w-6 h-6 text-teal" />
                      ) : (
                        <File className="w-6 h-6 text-primary" />
                      )}
                    </div>
                    <p className="font-semibold text-foreground text-sm">{droppedFile.name}</p>
                    <p className="text-xs text-muted-foreground mt-1">
                      {(droppedFile.size / (1024 * 1024)).toFixed(2)} MB
                    </p>
                    {imageAutoScanned && (
                      <span className="mt-2 inline-flex items-center gap-1.5 text-xs text-teal bg-teal/10 border border-teal/30 px-2 py-0.5 rounded-full">
                        <span className="w-1.5 h-1.5 rounded-full bg-teal" />
                        Image — OCR automatic
                      </span>
                    )}
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        setDroppedFile(null);
                        setImageAutoScanned(false);
                        if (!isScanned || imageAutoScanned) setIsScanned(false);
                      }}
                      className="mt-3 text-destructive hover:text-destructive/80 text-xs flex items-center gap-1"
                    >
                      <X className="w-3.5 h-3.5" /> Remove
                    </button>
                  </div>
                ) : (
                  <>
                    <div className="w-12 h-12 rounded-2xl bg-muted text-muted-foreground mx-auto mb-3 flex items-center justify-center">
                      <Upload className="w-6 h-6" />
                    </div>
                    <p className="font-semibold text-foreground">
                      {isDragActive ? "Drop here" : "Drag & drop"}
                    </p>
                    <p className="text-muted-foreground text-sm mt-1">or click to browse</p>
                    <p className="text-xs text-muted-foreground/70 mt-3">
                      PDF · DOCX · XLSX · DOC · PNG · JPG · TIFF
                    </p>
                  </>
                )}
              </div>
            </div>

            {/* Step 3 — Document Mode */}
            <div
              className="bg-card rounded-2xl border border-border p-6 space-y-4"
              style={{ boxShadow: "var(--shadow-card)" }}
            >
              <h2 className="font-semibold text-foreground mb-2 flex items-center gap-2">
                <StepBadge n={3} active={Boolean(droppedFile)} />
                Document Mode
              </h2>

              {/* Workflow vs Personal */}
              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={() => setIsSelfUpload(false)}
                  className={clsx(
                    "flex flex-col items-center gap-1.5 py-3 px-2 rounded-xl border text-sm font-medium transition-all",
                    !isSelfUpload
                      ? "border-primary bg-primary/10 text-primary"
                      : "border-border bg-card text-muted-foreground hover:bg-muted"
                  )}
                >
                  <Users className="w-5 h-5" />
                  <span>Workflow</span>
                </button>
                <button
                  type="button"
                  onClick={() => setIsSelfUpload(true)}
                  className={clsx(
                    "flex flex-col items-center gap-1.5 py-3 px-2 rounded-xl border text-sm font-medium transition-all",
                    isSelfUpload
                      ? "border-primary bg-primary/10 text-primary"
                      : "border-border bg-card text-muted-foreground hover:bg-muted"
                  )}
                >
                  <Lock className="w-5 h-5" />
                  <span>Personal</span>
                </button>
              </div>

              {/* Digital vs Scanned — only visible when not personal */}
              {!isSelfUpload && (
                <div className="grid grid-cols-2 gap-2">
                  <button
                    type="button"
                    disabled={imageAutoScanned}
                    onClick={() => setIsScanned(false)}
                    className={clsx(
                      "flex flex-col items-center gap-1.5 py-3 px-2 rounded-xl border text-sm font-medium transition-all disabled:opacity-60",
                      !isScanned
                        ? "border-primary bg-primary/10 text-primary"
                        : "border-border bg-card text-muted-foreground hover:bg-muted"
                    )}
                  >
                    <FileText className="w-5 h-5" />
                    <span>Digital</span>
                  </button>
                  <button
                    type="button"
                    disabled={imageAutoScanned}
                    onClick={() => setIsScanned(true)}
                    className={clsx(
                      "flex flex-col items-center gap-1.5 py-3 px-2 rounded-xl border text-sm font-medium transition-all disabled:opacity-60",
                      isScanned
                        ? "border-teal bg-teal/10 text-teal"
                        : "border-border bg-card text-muted-foreground hover:bg-muted"
                    )}
                  >
                    <ScanLine className="w-5 h-5" />
                    <span>Scanned / OCR</span>
                  </button>
                </div>
              )}

              {/* Context hints */}
              {isSelfUpload && (
                <div className="flex items-start gap-2 text-xs text-primary bg-primary/10 border border-primary/20 rounded-lg px-3 py-2">
                  <Info className="w-4 h-4 flex-shrink-0 mt-0.5" />
                  <span>Visible only to you and admins. Not submitted for approval.</span>
                </div>
              )}
              {isScanned && !isSelfUpload && (
                <div className="flex items-start gap-2 text-xs text-teal bg-teal/10 border border-teal/20 rounded-lg px-3 py-2">
                  <Sparkles className="w-4 h-4 flex-shrink-0 mt-0.5" />
                  <span>
                    After upload, OCR runs in the background and pre-fills the details form for you to review.
                  </span>
                </div>
              )}
            </div>
          </div>

          {/* ── Right column ────────────────────────────────────────────────── */}
          <div className="lg:col-span-7">

            {/* Manual details form — only when type is chosen and not OCR mode */}
            {showManualForm && (
              <div
                className={clsx(
                  "bg-card rounded-2xl border p-8",
                  isSelfUpload ? "border-primary/30" : "border-border"
                )}
                style={{ boxShadow: "var(--shadow-card)" }}
              >
                <div className="flex items-center gap-2.5 mb-6">
                  <StepBadge n={4} active />
                  <h2 className="text-xl font-semibold text-foreground">
                    {isSelfUpload ? "Personal Details" : "Document Details"}
                  </h2>
                  {isSelfUpload && (
                    <span className="ml-auto inline-flex items-center gap-1 text-xs font-semibold text-primary">
                      <Lock className="w-3.5 h-3.5" /> Personal
                    </span>
                  )}
                </div>

                {/* Dynamic metadata */}
                {hasMetadata && (
                  <div className="mb-8">
                    <h3 className="font-semibold text-foreground mb-4 flex items-center gap-2">
                      <CheckCircle className="w-5 h-5 text-teal" /> Additional Information
                    </h3>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                      {[...selectedType!.metadata_fields]
                        .sort((a, b) => a.order - b.order)
                        .map((field) => (
                          <DynamicField
                            key={field.id}
                            field={field}
                            register={register}
                            control={control}
                            errors={errors as Record<string, { message?: string }>}
                            enforceRequired={!relaxReq}
                            suggested={false}
                          />
                        ))}
                    </div>
                  </div>
                )}

                <div className="space-y-6">
                  {/* Title */}
                  <div>
                    <label className="label">
                      Document Title <span className="text-destructive">*</span>
                    </label>
                    <input
                      {...register("title", { required: "Title is required" })}
                      className="input"
                      placeholder="e.g. Acme Corp Invoice March 2026"
                    />
                    {errors.title && (
                      <p className="text-destructive text-xs mt-1">{String(errors.title.message)}</p>
                    )}
                  </div>

                  {/* Supplier + Date */}
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                    <div>
                      <label className="label">Supplier</label>
                      <input {...register("supplier")} className="input" placeholder="Supplier name" />
                    </div>
                    <div>
                      <label className="label">Document Date</label>
                      <input {...register("document_date")} type="date" className="input" />
                    </div>
                  </div>

                  {/* Personal tags */}
                  {isSelfUpload && (
                    <div>
                      <label className="label">
                        Personal tags <span className="text-destructive">*</span>
                      </label>
                      <div className="space-y-2">
                        {personalTagFields.map((field, index) => (
                          <PersonalTagRow
                            key={field.id}
                            index={index}
                            total={personalTagFields.length}
                            register={register}
                            onRemove={() => removePersonalTag(index)}
                          />
                        ))}
                      </div>
                      <button
                        type="button"
                        onClick={() => appendPersonalTag({ value: "" })}
                        className="mt-3 inline-flex items-center gap-2 text-sm font-medium text-primary hover:text-primary/80"
                      >
                        <Plus className="w-4 h-4" /> Add another tag
                      </button>
                    </div>
                  )}

                  {/* Amount + Currency */}
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                    <div className="md:col-span-2">
                      <label className="label">Amount</label>
                      <input
                        {...register("amount")}
                        type="number"
                        step="0.01"
                        className="input"
                        placeholder="0.00"
                      />
                    </div>
                    <div>
                      <label className="label">Currency</label>
                      <select {...register("currency")} className="input">
                        {CURRENCY_OPTIONS.map((c) => (
                          <option key={c} value={c}>{c}</option>
                        ))}
                      </select>
                    </div>
                  </div>
                </div>

                {/* Upload progress */}
                {uploadMutation.isPending && uploadProgress > 0 && (
                  <div className="mt-6">
                    <div className="flex justify-between text-xs text-muted-foreground mb-1.5">
                      <span>{isSelfUpload ? "Saving personal document…" : "Uploading…"}</span>
                      <span className="font-semibold text-foreground">{uploadProgress}%</span>
                    </div>
                    <div className="h-2.5 bg-muted rounded-full overflow-hidden">
                      <div
                        className="h-full bg-primary transition-all duration-300 ease-out"
                        style={{ width: `${uploadProgress}%` }}
                      />
                    </div>
                  </div>
                )}

                {/* Actions */}
                <div className="flex gap-4 pt-6 mt-6 border-t border-border">
                  <button
                    type="button"
                    onClick={handleSubmit(onUpload)}
                    disabled={uploadMutation.isPending || !droppedFile}
                    className="flex-1 flex items-center justify-center gap-2 text-base py-3 rounded-xl font-semibold bg-primary text-primary-foreground hover:bg-primary/90 transition-all disabled:opacity-50 disabled:cursor-not-allowed"
                    style={{ boxShadow: "var(--shadow-elegant)" }}
                  >
                    {uploadMutation.isPending ? (
                      <Loader2 className="w-5 h-5 animate-spin" />
                    ) : (
                      <>
                        {isSelfUpload ? <Lock className="w-4 h-4" /> : <Upload className="w-4 h-4" />}
                        {isSelfUpload ? "Save Personal Document" : "Upload Document"}
                        <ArrowRight className="w-4 h-4" />
                      </>
                    )}
                  </button>
                  <button
                    type="button"
                    onClick={() => navigate("/documents")}
                    className="px-8 py-3 rounded-xl font-semibold border border-border bg-card text-foreground hover:bg-muted transition-colors"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}

            {/* OCR idle info panel — visible when OCR mode is selected but not yet uploaded */}
            {showOcrIdlePanel && (
              <div
                className="bg-card rounded-2xl border border-teal/30 p-8 flex flex-col items-center text-center"
                style={{ boxShadow: "var(--shadow-card)" }}
              >
                <div className="w-16 h-16 rounded-2xl bg-teal/10 flex items-center justify-center mb-4">
                  <ScanLine className="w-8 h-8 text-teal" />
                </div>
                <h3 className="text-lg font-semibold text-foreground mb-2">OCR Scan Mode</h3>
                <p className="text-sm text-muted-foreground max-w-sm mb-6">
                  Upload the file and the OCR pipeline will extract the text automatically.
                  You'll then review and confirm the extracted details before saving.
                </p>
                <div className="w-full space-y-2 text-left rounded-xl bg-muted/40 border border-border p-4 mb-6 text-sm">
                  {[
                    "Select document type and drop your file",
                    "Click Upload — OCR runs in the background",
                    "Review pre-filled details and confirm",
                  ].map((step, i) => (
                    <div key={i} className="flex items-center gap-3">
                      <span className="w-5 h-5 rounded-full bg-teal/20 text-teal text-xs font-bold flex items-center justify-center flex-shrink-0">
                        {i + 1}
                      </span>
                      <span className="text-foreground">{step}</span>
                    </div>
                  ))}
                </div>

                {/* Upload progress */}
                {uploadMutation.isPending && uploadProgress > 0 && (
                  <div className="w-full mb-4">
                    <div className="flex justify-between text-xs text-muted-foreground mb-1.5">
                      <span>Uploading for OCR…</span>
                      <span className="font-semibold text-foreground">{uploadProgress}%</span>
                    </div>
                    <div className="h-2.5 bg-muted rounded-full overflow-hidden">
                      <div
                        className="h-full bg-teal transition-all duration-300"
                        style={{ width: `${uploadProgress}%` }}
                      />
                    </div>
                  </div>
                )}

                <div className="flex gap-4 w-full">
                  <button
                    type="button"
                    onClick={handleSubmit(onUpload)}
                    disabled={uploadMutation.isPending || !droppedFile || !selectedTypeId}
                    className="flex-1 flex items-center justify-center gap-2 py-3 rounded-xl font-semibold bg-teal text-teal-foreground hover:bg-teal/90 transition-all disabled:opacity-50 disabled:cursor-not-allowed"
                    style={{ boxShadow: "var(--shadow-elegant)" }}
                  >
                    {uploadMutation.isPending ? (
                      <Loader2 className="w-5 h-5 animate-spin" />
                    ) : (
                      <>
                        <ScanLine className="w-4 h-4" />
                        Upload &amp; Run OCR
                        <ArrowRight className="w-4 h-4" />
                      </>
                    )}
                  </button>
                  <button
                    type="button"
                    onClick={() => navigate("/documents")}
                    className="px-6 py-3 rounded-xl font-semibold border border-border bg-card text-foreground hover:bg-muted transition-colors"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}

            {/* Nothing selected yet — right panel intentionally empty */}
            {/* No placeholder shown; the left column's step badges guide the user */}
          </div>
        </div>
      )}

      {/* Uploading spinner for OCR flow */}
      {scanStage === "uploading" && (
        <div className="flex flex-col items-center py-16 text-center">
          <Loader2 className="w-12 h-12 animate-spin text-teal mb-4" />
          <p className="text-foreground font-semibold text-lg">Uploading…</p>
          {uploadProgress > 0 && (
            <div className="w-64 mt-4">
              <div className="h-2 bg-muted rounded-full overflow-hidden">
                <div
                  className="h-full bg-teal transition-all"
                  style={{ width: `${uploadProgress}%` }}
                />
              </div>
              <p className="text-xs text-muted-foreground mt-1">{uploadProgress}%</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}