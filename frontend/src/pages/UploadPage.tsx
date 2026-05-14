import { useState, useCallback, useEffect, useMemo, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { useDropzone } from "react-dropzone";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  useForm,
  useFieldArray,
  Controller,
  type Control,
  type Path,
  type UseFormRegister,
} from "react-hook-form";
import { documentsAPI, documentTypesAPI, normalizeListResponse } from "@/services/api";
import {
  Upload, File, X, Loader2, ArrowRight, CheckCircle, Plus, Lock,
  Info, ScanLine, Sparkles, AlertCircle, ChevronRight, ShieldAlert,
  Cpu, List, FileText, Tags,
} from "lucide-react";
import { toast } from "@/components/ui/vault-toast";
import type { DocumentType, MetadataField } from "@/types";
import clsx from "clsx";
import { QUERY_FIVE_MIN_STALE } from "@/lib/reactQueryDefaults";
import { deriveDocumentTypeConfig } from "@/lib/documentTypeConfig";
import { applyOcrToFields, type OcrFields } from "@/lib/ocrFieldMatcher";

// ── Types ─────────────────────────────────────────────────────────────────────

type PersonalTagField      = { value: string };
type PersonalMetadataField = { key: string; value: string };
type OcrLineItem = Record<string, string | number | null | undefined>;

type UploadFormValues = {
  title:         string;
  supplier?:     string;
  amount?:       string;
  currency?:     string;
  document_date?: string;
  due_date?:     string;
  // New line-item fields — stored in metadata when not first-class columns
  quantity?:     string;
  description?:  string;
  uom?:          string;
  metadata:      Record<string, unknown>;
  personal_description?: string;
  personal_text?: string;
  personal_tags: PersonalTagField[];
  personal_metadata_fields: PersonalMetadataField[];
};

type OcrQuality = {
  mean_confidence?:       number;
  overall_quality_ratio?: number;
  low_quality_warning?:   boolean;
  total_pages?:           number;
  low_quality_pages?:     number;
  engine?:                "paddle" | "tesseract" | "textract" | string;
};

type OcrSuggestions = {
  fields?:     OcrFields;
  quality?:    OcrQuality;
};

type ScanStage =
  | "idle"
  | "uploading"
  | "ocr_pending"
  | "ocr_processing"
  | "ocr_done"
  | "ocr_failed"
  | "submitting";

// ── Helpers ───────────────────────────────────────────────────────────────────

const DOCUMENT_FIELD_KEYS = [
  "title", "supplier", "amount", "currency", "document_date", "due_date",
  // New first-class-ish fields — passed as top-level metadata keys but handled
  // as named fields in the form so admins can map them via metadata_fields too
  "quantity", "description", "uom",
] as const;
type DocumentFieldKey = (typeof DOCUMENT_FIELD_KEYS)[number];
const DOCUMENT_FIELD_KEY_SET = new Set<string>(DOCUMENT_FIELD_KEYS);

// The six columns that the Document model stores directly (not in metadata)
const DIRECT_COLUMN_KEYS = new Set<string>([
  "title", "supplier", "amount", "currency", "document_date", "due_date",
]);

function getMetadataFieldKey(field: MetadataField): string {
  return (field.key ?? field.field_key ?? "") as string;
}

function isDocumentFieldKey(key: string): key is DocumentFieldKey {
  return DOCUMENT_FIELD_KEY_SET.has(key);
}

function isDirectColumnKey(key: string): boolean {
  return DIRECT_COLUMN_KEYS.has(key);
}

function documentNameFromFile(file: File | null | undefined): string {
  if (!file?.name) return "";
  return file.name.replace(/\.[^.]+$/, "") || file.name;
}

function getUploadFieldName(field: MetadataField): Path<UploadFormValues> {
  const key = getMetadataFieldKey(field);
  return isDocumentFieldKey(key) ? (key as Path<UploadFormValues>) : (`metadata.${key}` as Path<UploadFormValues>);
}

function getSuggestedFieldKey(field: MetadataField): string {
  const key = getMetadataFieldKey(field);
  return isDocumentFieldKey(key) ? key : `metadata.${key}`;
}

function documentValuesFromForm(values: Record<string, unknown>) {
  const metadata =
    values.metadata && typeof values.metadata === "object"
      ? (values.metadata as Record<string, unknown>)
      : {};
  return DOCUMENT_FIELD_KEYS.reduce<Record<DocumentFieldKey, string>>(
    (acc, key) => {
      acc[key] = String((values[key] ?? metadata[key] ?? "") as string).trim();
      return acc;
    },
    {
      title: "", supplier: "", amount: "", currency: "",
      document_date: "", due_date: "",
      quantity: "", description: "", uom: "",
    },
  );
}

function metadataWithoutDocumentFields(metadata: unknown): Record<string, unknown> {
  if (!metadata || typeof metadata !== "object") return {};
  return Object.entries(metadata as Record<string, unknown>).reduce<Record<string, unknown>>(
    (acc, [key, value]) => {
      if (!isDocumentFieldKey(key)) acc[key] = value;
      return acc;
    },
    {},
  );
}

async function calculateFileSha256(file: File): Promise<string> {
  const buffer = await file.arrayBuffer();
  const digest = await crypto.subtle.digest("SHA-256", buffer);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function getFieldErrorMessage(errors: Record<string, unknown>, name: string): string | undefined {
  const direct = (errors[name] as { message?: string } | undefined)?.message;
  if (direct) return String(direct);
  const nested = name.split(".").reduce<unknown>((cur, p) => (cur as Record<string, unknown>)?.[p], errors);
  return (nested as { message?: string } | undefined)?.message
    ? String((nested as { message: string }).message)
    : undefined;
}

function ocrString(value: string | string[] | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

// ── Small presentational components ──────────────────────────────────────────

function SuggestionPill({ score }: { score?: number }) {
  const isLow = score !== undefined && score <= 1;
  return (
    <span
      className={clsx(
        "inline-flex items-center gap-1 text-[10px] font-semibold px-1.5 py-0.5 rounded-full border",
        isLow
          ? "bg-amber-50 text-amber-700 border-amber-200"
          : "bg-teal/15 text-teal border-teal/25",
      )}
      title={score !== undefined ? `OCR confidence score: ${score}/4` : "OCR auto-filled"}
    >
      <Sparkles className="w-2.5 h-2.5" />
      OCR{isLow ? " ?" : ""}
    </span>
  );
}

function EngineBadge({ engine }: { engine?: string }) {
  if (!engine) return null;
  const label =
    engine === "paddle"    ? "PaddleOCR"
    : engine === "tesseract" ? "Tesseract"
    : engine === "textract"  ? "AWS Textract"
    : engine;
  return (
    <span className="inline-flex items-center gap-1 text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-muted border border-border text-muted-foreground">
      <Cpu className="w-2.5 h-2.5" />
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
        <p className="text-sm font-semibold text-amber-800">
          Low scan quality ({pct}% confident)
        </p>
        <p className="text-xs text-amber-700 mt-0.5">
          The scan may be blurry, skewed, or low-resolution. Please verify all
          pre-filled fields carefully before saving.
        </p>
      </div>
    </div>
  );
}

/** Read-only chips for detected OCR data that didn't map to a metadata field */
function OcrInfoChips({ fields }: { fields: OcrFields }) {
  const chips: { label: string; value: string }[] = [];
  if (fields.reference_number)   chips.push({ label: "Ref",           value: fields.reference_number });
  if (fields.document_type)      chips.push({ label: "Type",          value: fields.document_type });
  if (fields.account_code)       chips.push({ label: "Account",       value: fields.account_code });
  if (fields.kra_pin)            chips.push({ label: "KRA PIN",       value: fields.kra_pin });
  if (fields.vat_number)         chips.push({ label: "VAT No",        value: fields.vat_number });
  if (fields.vendor_code)        chips.push({ label: "Vendor Code",   value: fields.vendor_code });
  if (fields.cost_centre)        chips.push({ label: "Cost Centre",   value: fields.cost_centre });
  if (fields.po_reference)       chips.push({ label: "PO Ref",        value: fields.po_reference });
  if (fields.transaction_ref)    chips.push({ label: "Txn Ref",       value: fields.transaction_ref });
  if (fields.payment_method)     chips.push({ label: "Payment",       value: fields.payment_method });
  if (fields.payment_terms)      chips.push({ label: "Terms",         value: fields.payment_terms });
  if (fields.approved_by)        chips.push({ label: "Approved By",   value: fields.approved_by });
  if (fields.signed_by)          chips.push({ label: "Signed By",     value: fields.signed_by });
  if (fields.contract_value)     chips.push({ label: "Contract Value",value: fields.contract_value });
  if (fields.tax_amount)         chips.push({ label: "Tax",           value: fields.tax_amount });
  if (fields.subtotal)           chips.push({ label: "Subtotal",      value: fields.subtotal });
  if (fields.effective_date)     chips.push({ label: "Effective",     value: fields.effective_date });
  if (fields.expiry_date)        chips.push({ label: "Expires",       value: fields.expiry_date });
  if (fields.delivery_date)      chips.push({ label: "Delivery",      value: fields.delivery_date });
  if (fields.registered_address) chips.push({ label: "Address",       value: fields.registered_address });
  // New
  if (ocrString(fields.quantity)) chips.push({ label: "Qty", value: ocrString(fields.quantity)! });
  if (ocrString(fields.uom))      chips.push({ label: "UOM", value: ocrString(fields.uom)! });
  if (chips.length === 0) return null;
  return (
    <div>
      <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2">
        Additional detected information
      </p>
      <div className="flex flex-wrap gap-2">
        {chips.map(({ label, value }) => (
          <span
            key={label}
            className="inline-flex items-center gap-1.5 text-xs bg-muted border border-border rounded-full px-3 py-1"
          >
            <span className="text-muted-foreground">{label}:</span>
            <span className="font-mono font-medium text-foreground">{value}</span>
          </span>
        ))}
      </div>
    </div>
  );
}

/** Collapsible table of extracted line items */
function LineItemsPanel({ items }: { items: OcrLineItem[] }) {
  const [open, setOpen] = useState(false);
  if (!items.length) return null;
  return (
    <div className="mb-4">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-2 text-sm font-medium text-muted-foreground hover:text-foreground select-none"
      >
        <List className="w-4 h-4" />
        <span>
          {open ? "Hide" : "Show"} detected line items ({items.length})
        </span>
        <ChevronRight
          className={clsx("w-4 h-4 transition-transform", open && "rotate-90")}
        />
      </button>
      {open && (
        <div className="mt-2 overflow-x-auto rounded-xl border border-border">
          <table className="w-full text-xs">
            <thead className="bg-muted/60">
              <tr>
                {["#", "Description", "Qty", "UOM", "Unit Price", "Total"].map((h) => (
                  <th
                    key={h}
                    className="text-left px-3 py-2 font-semibold text-muted-foreground"
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {items.map((item, i) => (
                <tr key={i} className="border-t border-border even:bg-muted/20">
                  <td className="px-3 py-1.5 text-muted-foreground">{i + 1}</td>
                  <td className="px-3 py-1.5 font-medium text-foreground max-w-[240px] truncate">
                    {item.description}
                  </td>
                  <td className="px-3 py-1.5 font-mono">{item.quantity}</td>
                  <td className="px-3 py-1.5 font-mono uppercase">{item.uom}</td>
                  <td className="px-3 py-1.5 font-mono">{item.unit_price}</td>
                  <td className="px-3 py-1.5 font-mono">{item.line_total}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
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
  suggestionScore,
  name,
}: {
  field:          MetadataField;
  register:       UseFormRegister<UploadFormValues>;
  control:        Control<UploadFormValues>;
  errors:         Record<string, unknown>;
  enforceRequired: boolean;
  suggestionScore?: number;
  name?:          Path<UploadFormValues>;
}) {
  const fieldKey  = getMetadataFieldKey(field);
  const fieldName = name ?? (`metadata.${fieldKey}` as Path<UploadFormValues>);
  const rules     =
    field.is_required && enforceRequired ? { required: `${field.label} is required` } : {};
  const errMsg    = getFieldErrorMessage(errors, fieldName);
  const suggested = suggestionScore !== undefined;

  const wrapper = (children: React.ReactNode) => (
    <div>
      <label className="label flex items-center gap-1.5">
        {field.label}
        {field.is_required && enforceRequired && (
          <span className="text-destructive ml-1">*</span>
        )}
        {suggested && <SuggestionPill score={suggestionScore} />}
      </label>
      {children}
      {errMsg && <p className="text-destructive text-xs mt-1">{errMsg}</p>}
    </div>
  );

  if (field.field_type === "select") {
    return wrapper(
      <Controller
        name={fieldName}
        control={control}
        rules={rules}
        render={({ field: f }) => (
          <select {...f} value={String(f.value ?? "")} className="input">
            <option value="">Select…</option>
            {(field.select_options ?? []).map((opt) => (
              <option key={opt} value={opt}>{opt}</option>
            ))}
          </select>
        )}
      />,
    );
  }
  if (field.field_type === "boolean") {
    return (
      <div className="flex items-center gap-2">
        <input
          {...register(fieldName)}
          type="checkbox"
          id={fieldKey}
          className="w-4 h-4 rounded border-border text-primary focus:ring-primary"
        />
        <label htmlFor={fieldKey} className="text-sm text-foreground">
          {field.label}
        </label>
      </div>
    );
  }
  if (field.field_type === "textarea") {
    return wrapper(<textarea {...register(fieldName, rules)} rows={3} className="input" />);
  }
  const inputType =
    field.field_type === "date" ? "date"
    : field.field_type === "number" || field.field_type === "currency" ? "number"
    : "text";
  return wrapper(
    <input
      {...register(fieldName, rules)}
      type={inputType}
      step={field.field_type === "currency" ? "0.01" : undefined}
      placeholder={field.default_value || field.help_text || ""}
      className={clsx(
        "input",
        suggested && suggestionScore! <= 1 && "ring-1 ring-amber-400/50",
        suggested && suggestionScore! >= 2 && "ring-1 ring-teal/40",
      )}
    />,
  );
}

// ── Personal tag / metadata rows ──────────────────────────────────────────────

function PersonalTagRow({
  index, total, register, onRemove,
}: {
  index: number; total: number;
  register: UseFormRegister<UploadFormValues>; onRemove: () => void;
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
      />
      <button
        type="button"
        onClick={onRemove}
        disabled={total === 1}
        className="inline-flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full border border-border bg-card text-muted-foreground hover:text-destructive hover:border-destructive/30 hover:bg-destructive/5 disabled:opacity-40 disabled:cursor-not-allowed"
      >
        <X className="w-4 h-4" />
      </button>
    </div>
  );
}

function PersonalMetadataRow({
  index, total, register, onRemove,
}: {
  index: number; total: number;
  register: UseFormRegister<UploadFormValues>; onRemove: () => void;
}) {
  return (
    <div className="grid grid-cols-[1fr_1fr_auto] items-center gap-2 rounded-lg border border-border bg-card px-3 py-2">
      <input
        {...register(`personal_metadata_fields.${index}.key` as const)}
        className="input h-9"
        placeholder="Field name"
      />
      <input
        {...register(`personal_metadata_fields.${index}.value` as const)}
        className="input h-9"
        placeholder="Field value"
      />
      <button
        type="button"
        onClick={onRemove}
        disabled={total === 1}
        className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-border bg-card text-muted-foreground hover:text-destructive hover:border-destructive/30 hover:bg-destructive/5 disabled:opacity-40 disabled:cursor-not-allowed"
      >
        <X className="w-4 h-4" />
      </button>
    </div>
  );
}

// ── OCR polling hook ──────────────────────────────────────────────────────────

function useOcrPoller(
  documentId:    string | null,
  enabled:       boolean,
  onDone:        (suggestions: OcrSuggestions) => void,
  onFailed:      () => void,
) {
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (!enabled || !documentId) return;

    const poll = async () => {
      try {
        const { data } = await documentsAPI.ocrSuggestions(documentId);
        if (data.ocr_status === "done") {
          if (intervalRef.current) clearInterval(intervalRef.current);
          const raw = data.suggestions as Record<string, unknown> | null;
          let parsed: OcrSuggestions = {};
          if (raw && typeof raw === "object") {
            parsed = ("fields" in raw || "quality" in raw)
              ? (raw as OcrSuggestions)
              : { fields: raw as OcrFields };
          }
          onDone(parsed);
        } else if (data.ocr_status === "failed") {
          if (intervalRef.current) clearInterval(intervalRef.current);
          onFailed();
        }
      } catch { /* transient — keep polling */ }
    };

    poll();
    intervalRef.current = setInterval(poll, 3000);
    return () => { if (intervalRef.current) clearInterval(intervalRef.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [documentId, enabled]);
}

// ── OCR wait screen ───────────────────────────────────────────────────────────

function OcrWaitScreen({
  stage, fileName, rawLines, onSkip,
}: {
  stage:     "ocr_pending" | "ocr_processing";
  fileName:  string;
  rawLines?: string[];
  onSkip:    () => void;
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
              <p key={i} className="text-xs text-foreground font-mono truncate">{line}</p>
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

// ── Step badge ────────────────────────────────────────────────────────────────

function StepBadge({ n, active, done }: { n: number; active?: boolean; done?: boolean }) {
  return (
    <div
      className={clsx(
        "w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold flex-shrink-0 transition-colors",
        done    ? "bg-teal text-white"
        : active ? "bg-primary text-primary-foreground"
                 : "bg-muted text-muted-foreground",
      )}
    >
      {done ? <CheckCircle className="w-3.5 h-3.5" /> : n}
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

interface UploadPageProps {
  scanOnly?: boolean;
}

export default function UploadPage({ scanOnly = false }: UploadPageProps) {
  const navigate     = useNavigate();
  const queryClient  = useQueryClient();

  const [droppedFile,      setDroppedFile]      = useState<File | null>(null);
  const [selectedTypeId,   setSelectedTypeId]   = useState("");
  const [uploadProgress,   setUploadProgress]   = useState(0);
  const [isScanned,        setIsScanned]         = useState(scanOnly);

  const [scanStage,        setScanStage]         = useState<ScanStage>("idle");
  const [uploadedDocId,    setUploadedDocId]     = useState<string | null>(null);
  const [ocrSuggestions,   setOcrSuggestions]   = useState<OcrSuggestions | null>(null);
  // Detected line items (display-only — not editable in the form)
  const [ocrLineItems,     setOcrLineItems]      = useState<OcrLineItem[]>([]);
  // Map from form path → OCR confidence score
  const [suggestedFields,  setSuggestedFields]  = useState<Map<string, number>>(new Map());
  const [showPersonalExtras, setShowPersonalExtras] = useState(false);

  const {
    register, handleSubmit, control, reset, setValue, clearErrors, getValues,
    formState: { errors },
  } = useForm<UploadFormValues>({
    defaultValues: {
      metadata: {},
      personal_description: "",
      personal_text: "",
      personal_tags: [{ value: "" }],
      personal_metadata_fields: [{ key: "", value: "" }],
      currency: "KES",
    },
  });

  const {
    fields: personalTagFields,
    append: appendPersonalTag,
    remove: removePersonalTag,
    replace: replacePersonalTags,
  } = useFieldArray({ control, name: "personal_tags" });

  const {
    fields: personalMetadataFields,
    append: appendPersonalMetadata,
    remove: removePersonalMetadata,
    replace: replacePersonalMetadata,
  } = useFieldArray({ control, name: "personal_metadata_fields" });

  const { data: docTypes = [] } = useQuery<unknown, Error, DocumentType[]>({
    queryKey: ["document-types"],
    queryFn:  () => documentTypesAPI.list().then((r) => r.data as unknown),
    select:   (data) => normalizeListResponse<DocumentType>(data),
    ...QUERY_FIVE_MIN_STALE,
  });

  const visibleDocTypes = useMemo(
    () => scanOnly
      ? docTypes.filter((type) => !deriveDocumentTypeConfig(type).isPersonalType)
      : docTypes,
    [docTypes, scanOnly],
  );
  const selectedType = visibleDocTypes.find((t) => t.id === selectedTypeId);
  const typeConfig   = deriveDocumentTypeConfig(selectedType);
  const isSelfUpload = typeConfig.isPersonalType;
  const metadataMode = typeConfig.metadataMode;

  const isOcrFlow      = isScanned && !isSelfUpload;
  const showManualForm = !isOcrFlow && Boolean(selectedTypeId) && scanStage === "idle";
  const showOcrIdlePanel = isOcrFlow && scanStage === "idle";
  const showOcrWait    = isOcrFlow && (scanStage === "ocr_pending" || scanStage === "ocr_processing");
  const showOcrReview  = isOcrFlow && scanStage === "ocr_done";
  const showOcrFailed  = isOcrFlow && scanStage === "ocr_failed";

  const hasMetadata =
    !isSelfUpload &&
    metadataMode === "admin_defined" &&
    !!selectedType &&
    selectedType.metadata_fields.length > 0;
  const hasConfiguredDocumentNameField =
    !!selectedType?.metadata_fields?.some((field) => getMetadataFieldKey(field) === "title");

  const relaxReq = isSelfUpload || isScanned;

  // Reset form when document type changes
  useEffect(() => {
    if (selectedTypeId) {
      reset({
        metadata: {},
        personal_description: "",
        personal_text: "",
        personal_tags: [{ value: "" }],
        personal_metadata_fields: [{ key: "", value: "" }],
        currency: "KES", title: "", supplier: "", amount: "",
        document_date: "", due_date: "",
        quantity: "", description: "", uom: "",
      });
      setUploadProgress(0);
      setShowPersonalExtras(false);
    }
  }, [selectedTypeId, reset]);

  useEffect(() => {
    if (!droppedFile) return;
    const currentTitle = String(getValues("title") ?? "").trim();
    if (!currentTitle) {
      setValue("title", documentNameFromFile(droppedFile));
    }
  }, [droppedFile, getValues, setValue]);

  useEffect(() => { clearErrors(); }, [isSelfUpload, isScanned, clearErrors]);

  useEffect(() => {
    setIsScanned(scanOnly);
    if (scanOnly && selectedTypeId && !visibleDocTypes.some((type) => type.id === selectedTypeId)) {
      setSelectedTypeId("");
    }
    if (!scanOnly) {
      setScanStage("idle");
      setUploadedDocId(null);
      setOcrSuggestions(null);
      setOcrLineItems([]);
      setSuggestedFields(new Map());
    }
    replacePersonalTags([{ value: "" }]);
    replacePersonalMetadata([{ key: "", value: "" }]);
    setShowPersonalExtras(false);
  }, [scanOnly, selectedTypeId, visibleDocTypes, replacePersonalTags, replacePersonalMetadata]);

  // ── OCR poller ──────────────────────────────────────────────────────────────

  useOcrPoller(
    uploadedDocId,
    isOcrFlow && (scanStage === "ocr_pending" || scanStage === "ocr_processing"),

    // onDone — run 4-pass matcher against every admin-configured metadata field
    (suggestions) => {
      setOcrSuggestions(suggestions);
      setScanStage("ocr_done");

      const fields    = suggestions.fields ?? {};
      const scoreMap  = new Map<string, number>();

      // Store detected line items for display
      if (Array.isArray(fields.line_items) && fields.line_items.length > 0) {
        setOcrLineItems(fields.line_items as unknown as OcrLineItem[]);
      }

      // Helper — fill a named form field and record its confidence score
      const fillDirect = (key: Path<UploadFormValues>, value: string | undefined, score = 4) => {
        if (value?.trim()) {
          setValue(key, value.trim());
          scoreMap.set(key, score);
        }
      };

      // 1. Fill the six first-class Document columns (direct DB fields)
      fillDirect("supplier",      fields.supplier);
      fillDirect("amount",        fields.amount);
      fillDirect("currency",      fields.currency);
      fillDirect("document_date", fields.document_date);
      fillDirect("due_date",      fields.due_date);

      // 2. Fill the three new line-item fields
      fillDirect("quantity",    ocrString(fields.quantity));
      fillDirect("description", ocrString(fields.description));
      fillDirect("uom",         ocrString(fields.uom));

      // 3. Fill admin metadata fields using the 4-pass matcher
      if (selectedType?.metadata_fields?.length) {
        const matches = applyOcrToFields(selectedType.metadata_fields, fields);

        for (const { field, match } of matches) {
          const metadataKey = getMetadataFieldKey(field);
          if (!metadataKey) continue;

          const formPath: Path<UploadFormValues> = isDocumentFieldKey(metadataKey)
            ? (metadataKey as Path<UploadFormValues>)
            : (`metadata.${metadataKey}` as Path<UploadFormValues>);

          // Don't overwrite a higher-confidence direct fill
          const existingScore = scoreMap.get(formPath) ?? 0;
          if (match.score > existingScore) {
            setValue(formPath, match.value);
            const trackKey = isDocumentFieldKey(metadataKey)
              ? metadataKey
              : `metadata.${metadataKey}`;
            scoreMap.set(trackKey, match.score);
          }
        }
      }

      setSuggestedFields(scoreMap);

      const engine    = suggestions.quality?.engine;
      const warn      = suggestions.quality?.low_quality_warning;
      const engineLabel =
        engine === "paddle"    ? "PaddleOCR"
        : engine === "tesseract" ? "Tesseract"
        : engine === "textract"  ? "AWS Textract"
        : "";

      if (warn) {
        toast.warning("OCR complete — low scan quality detected. Please verify all fields carefully.");
      } else {
        toast.success(
          engineLabel
            ? `OCR complete (${engineLabel})! Review the extracted details below.`
            : "OCR complete! Review the extracted details below.",
        );
      }
    },

    // onFailed
    () => {
      setScanStage("ocr_failed");
      toast.warning("OCR could not extract text. Please fill in the details manually.");
    },
  );

  // ── Dropzone ────────────────────────────────────────────────────────────────

  const onDrop = useCallback((accepted: File[]) => {
    const file = accepted[0];
    if (file) setDroppedFile(file);
  }, []);

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    maxFiles: 1,
    accept: {
      "application/pdf": [".pdf"],
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document": [".docx"],
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": [".xlsx"],
      "application/msword": [".doc"],
      "application/vnd.openxmlformats-officedocument.presentationml.presentation": [".pptx"],
      "image/*": [".png", ".jpg", ".jpeg", ".tiff", ".bmp", ".webp"],
    },
  });

  // ── Mutations ───────────────────────────────────────────────────────────────

  const uploadMutation = useMutation({
    mutationFn: (fd: FormData) =>
      documentsAPI.upload(fd, {
        onUploadProgress: (e: ProgressEvent) => {
          if (e.total) setUploadProgress(Math.round((e.loaded * 100) / e.total));
        },
      }),
    onSuccess: ({ data }) => {
      setUploadProgress(0);
      if (isOcrFlow) {
        setUploadedDocId(data.id);
        setScanStage(data.ocr_status === "processing" ? "ocr_processing" : "ocr_pending");
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

  const onUpload = async (values: Record<string, unknown>) => {
    if (!droppedFile)    { toast.error("Please select a file");          return; }
    if (!selectedTypeId) { toast.error("Please select a document type"); return; }

    const personalTags = (Array.isArray(values.personal_tags) ? values.personal_tags : [])
      .map((tag) => {
        if (typeof tag === "string") return tag.trim();
        if (tag && typeof tag === "object" && "value" in tag)
          return String((tag as { value?: unknown }).value ?? "").trim();
        return "";
      })
      .filter(Boolean);

    const personalMetadataEntries = (
      Array.isArray(values.personal_metadata_fields) ? values.personal_metadata_fields : []
    )
      .map((e) => ({
        key:   String((e as { key?: unknown })?.key   ?? "").trim(),
        value: String((e as { value?: unknown })?.value ?? "").trim(),
      }))
      .filter((e) => e.key.length > 0 && e.value.length > 0);

    const personalMetadata = personalMetadataEntries.reduce<Record<string, string>>(
      (acc, e) => { acc[e.key] = e.value; return acc; }, {},
    );

    const documentValues = documentValuesFromForm(values);
    const fileDocumentName = documentNameFromFile(droppedFile) || "Uploaded document";
    const submittedDocumentName =
      isSelfUpload || hasConfiguredDocumentNameField
        ? documentValues.title || fileDocumentName
        : fileDocumentName;

    // Advisory duplicate check
    try {
      const checksum = await calculateFileSha256(droppedFile);
      const { data: duplicateInfo } = await documentsAPI.duplicateCheck(checksum);
      if (duplicateInfo.exists) {
        toast.warning(
          "You have already uploaded this document. Open the existing document instead."
        );
        return;
      }
    } catch { /* advisory — never block the upload */ }

    const fd = new FormData();
    fd.append("file",             droppedFile);
    fd.append("title",            submittedDocumentName);
    fd.append("document_type_id", selectedTypeId);
    fd.append("is_self_upload",   isSelfUpload ? "true" : "false");
    fd.append("is_scanned",       isScanned    ? "true" : "false");

    if (!isOcrFlow) {
      if (documentValues.supplier)      fd.append("supplier",      documentValues.supplier);
      if (documentValues.amount)        fd.append("amount",        documentValues.amount);
      if (documentValues.currency)      fd.append("currency",      documentValues.currency);
      if (documentValues.document_date) fd.append("document_date", documentValues.document_date);
      if (documentValues.due_date)      fd.append("due_date",      documentValues.due_date);
    }

    personalTags.forEach((tag) => fd.append("personal_tags", tag));

    const adminMetadata: Record<string, unknown> =
      !isSelfUpload && !isOcrFlow && values.metadata
        ? metadataWithoutDocumentFields(values.metadata)
        : {};

    // Include the three new scalar fields in metadata when present
    if (!isOcrFlow && !isSelfUpload) {
      if (documentValues.quantity)    adminMetadata.quantity    = documentValues.quantity;
      if (documentValues.description) adminMetadata.description = documentValues.description;
      if (documentValues.uom)         adminMetadata.uom         = documentValues.uom;
    }

    if (isSelfUpload) {
      const personalDescription = String(values.personal_description ?? "").trim();
      const personalText = String(values.personal_text ?? "").trim();
      if (personalDescription) personalMetadata.description = personalDescription;
      if (personalText) personalMetadata.personal_text = personalText;
    }

    const mergedMetadata = isSelfUpload
      ? (Object.keys(personalMetadata).length > 0 ? personalMetadata : {})
      : adminMetadata;

    if (Object.keys(mergedMetadata).length > 0) {
      fd.append("metadata", JSON.stringify(mergedMetadata));
    }

    setScanStage(isOcrFlow ? "uploading" : "idle");
    uploadMutation.mutate(fd);
  };

  const onConfirmOcr = handleSubmit((values) => {
    if (!uploadedDocId) return;
    setScanStage("submitting");
    const documentValues = documentValuesFromForm(values);
    const fileDocumentName = documentNameFromFile(droppedFile);

    const payload: Record<string, unknown> = {};
    if (hasConfiguredDocumentNameField && documentValues.title) {
      payload.title = documentValues.title;
    } else if (!hasConfiguredDocumentNameField && fileDocumentName) {
      payload.title = fileDocumentName;
    }
    if (documentValues.supplier)      payload.supplier      = documentValues.supplier;
    if (documentValues.amount)        payload.amount        = documentValues.amount;
    if (documentValues.currency)      payload.currency      = documentValues.currency;
    if (documentValues.document_date) payload.document_date = documentValues.document_date;
    if (documentValues.due_date)      payload.due_date      = documentValues.due_date;

    // Build metadata — exclude direct column keys, include new fields
    const metadataBase = metadataWithoutDocumentFields(values.metadata);
    if (documentValues.quantity)    metadataBase.quantity    = documentValues.quantity;
    if (documentValues.description) metadataBase.description = documentValues.description;
    if (documentValues.uom)         metadataBase.uom         = documentValues.uom;

    if (Object.keys(metadataBase).length > 0) payload.metadata = metadataBase;

    saveMutation.mutate({ id: uploadedDocId, payload });
  });

  const onSkipToDocument = () => {
    if (!uploadedDocId) return;
    queryClient.invalidateQueries({ queryKey: ["documents"] });
    navigate(`/documents/${uploadedDocId}`);
  };

  const ocrFields    = ocrSuggestions?.fields  ?? {};
  const ocrQuality   = ocrSuggestions?.quality;
  const isLowQuality = ocrQuality?.low_quality_warning === true;

  const getFieldScore = (field: MetadataField): number | undefined =>
    suggestedFields.get(getSuggestedFieldKey(field));

  // ── Render ──────────────────────────────────────────────────────────────────

  return (
    <div className="max-w-5xl mx-auto py-8">
      <div className="mb-8">
        <h1 className="text-3xl font-bold text-foreground tracking-tight">
          {scanOnly ? "Scan Document" : "Upload Document"}
        </h1>
        <p className="text-muted-foreground mt-1">
          {scanOnly
            ? "Select a document type, attach your scanned file, and review OCR suggestions."
            : "Select a document type, attach your file, then fill in the details."}
        </p>
      </div>

      {/* ── OCR wait / review / submitting ──────────────────────────────── */}
      {isOcrFlow && scanStage !== "idle" && scanStage !== "uploading" && (
        <div className="bg-card rounded-2xl border border-border" style={{ boxShadow: "var(--shadow-card)" }}>
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
              {/* Header */}
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
                      : "Fields marked OCR were auto-filled — teal = confident, amber = verify carefully."}
                  </p>
                </div>
                <div className="ml-auto hidden sm:flex flex-col items-end gap-1">
                  {ocrQuality?.engine && <EngineBadge engine={ocrQuality.engine} />}
                  {ocrFields.reference_number && (
                    <div className="text-right">
                      <p className="text-xs text-muted-foreground">Detected reference</p>
                      <p className="text-sm font-mono font-semibold text-foreground">
                        {ocrFields.reference_number}
                      </p>
                    </div>
                  )}
                </div>
              </div>

              {isLowQuality && ocrQuality && <LowQualityBanner quality={ocrQuality} />}

              {/* Raw text preview */}
              {ocrFields.raw_lines && ocrFields.raw_lines.length > 0 && (
                <details className="mb-6 group">
                  <summary className="cursor-pointer list-none flex items-center gap-2 text-sm font-medium text-muted-foreground hover:text-foreground select-none">
                    <ChevronRight className="w-4 h-4 transition-transform group-open:rotate-90" />
                    Show extracted text ({ocrFields.raw_lines.length} lines)
                  </summary>
                  <div className="mt-2 rounded-xl border border-border bg-muted/40 p-4 max-h-48 overflow-y-auto">
                    {ocrFields.raw_lines.map((line, i) => (
                      <p key={i} className="text-xs font-mono text-foreground leading-relaxed">{line}</p>
                    ))}
                  </div>
                </details>
              )}

              <div className="space-y-6">
                {/* Line items detected from tables */}
                {ocrLineItems.length > 0 && <LineItemsPanel items={ocrLineItems} />}

                {/* Read-only info chips */}
                <OcrInfoChips fields={ocrFields} />

                {/* Admin metadata fields */}
                {hasMetadata && (
                  <div>
                    <h3 className="font-semibold text-foreground mb-4 flex items-center gap-2">
                      <CheckCircle className="w-5 h-5 text-teal" />
                      Document Details
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
                            errors={errors as Record<string, unknown>}
                            enforceRequired={false}
                            suggestionScore={getFieldScore(field)}
                            name={getUploadFieldName(field)}
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
                        Confirm &amp; Save
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

      {/* ── Main upload layout ─────────────────────────────────────────── */}
      {(scanStage === "idle" || scanStage === "uploading") && (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-8">
          {/* Left column */}
          <div className="lg:col-span-5 space-y-6">
            {/* Step 1 — Document Type */}
            <div className="bg-card rounded-2xl border border-border p-6" style={{ boxShadow: "var(--shadow-card)" }}>
              <h2 className="font-semibold text-foreground mb-4 flex items-center gap-2">
                <StepBadge n={1} active={!selectedTypeId} done={Boolean(selectedTypeId)} />
                Document Type
              </h2>
              <select
                value={selectedTypeId}
                onChange={(e) => setSelectedTypeId(e.target.value)}
                className="input w-full"
              >
                <option value="">— Choose document type —</option>
                {visibleDocTypes.map((t) => (
                  <option key={t.id} value={t.id}>{t.name}</option>
                ))}
              </select>
              {selectedType?.description && (
                <p className="mt-3 text-xs text-muted-foreground">{selectedType.description}</p>
              )}
              {selectedType && (
                <div className="mt-4 flex items-start gap-2 text-xs text-primary bg-primary/10 border border-primary/20 rounded-lg px-3 py-2">
                  <Info className="w-4 h-4 flex-shrink-0 mt-0.5" />
                  <span>
                    {isSelfUpload
                      ? "This type uploads as personal (visible to you and admins, no approval workflow)."
                      : "This type follows the workflow approval process."}
                  </span>
                </div>
              )}
            </div>

            {/* Step 2 — Attach File */}
            <div className="bg-card rounded-2xl border border-border p-6" style={{ boxShadow: "var(--shadow-card)" }}>
              <h2 className="font-semibold text-foreground mb-4 flex items-center gap-2">
                <StepBadge n={2} active={Boolean(selectedTypeId) && !droppedFile} done={Boolean(droppedFile)} />
                Attach File
              </h2>
              <div
                {...getRootProps()}
                className={clsx(
                  "border-2 border-dashed rounded-2xl p-8 text-center cursor-pointer transition-all",
                  isDragActive  ? "border-primary bg-primary/5"
                  : droppedFile
                    ? isScanned ? "border-teal/50 bg-teal/5" : "border-primary/50 bg-primary/5"
                    : "border-border hover:border-primary/50 hover:bg-muted/40",
                )}
              >
                <input {...getInputProps()} />
                {droppedFile ? (
                  <div className="flex flex-col items-center">
                    <div className={clsx(
                      "w-12 h-12 rounded-xl flex items-center justify-center mb-3",
                      isScanned ? "bg-teal/15" : "bg-primary/10",
                    )}>
                      {isScanned
                        ? <ScanLine className="w-6 h-6 text-teal" />
                        : <File className="w-6 h-6 text-primary" />}
                    </div>
                    <p className="font-semibold text-foreground text-sm">{droppedFile.name}</p>
                    <p className="text-xs text-muted-foreground mt-1">
                      {(droppedFile.size / (1024 * 1024)).toFixed(2)} MB
                    </p>
                    <button
                      type="button"
                      onClick={(e) => { e.stopPropagation(); setDroppedFile(null); }}
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
                      PDF · DOCX · XLSX · PPTX · DOC · PNG · JPG · TIFF
                    </p>
                  </>
                )}
              </div>
            </div>

            {scanOnly && (
              <div className="bg-card rounded-2xl border border-teal/30 p-6 space-y-2" style={{ boxShadow: "var(--shadow-card)" }}>
                <h2 className="font-semibold text-foreground mb-2 flex items-center gap-2">
                  <StepBadge n={3} active={Boolean(droppedFile)} />
                  Scan Mode (OCR)
                </h2>
                <div className="flex items-start gap-2 text-xs text-teal bg-teal/10 border border-teal/20 rounded-lg px-3 py-2">
                  <Sparkles className="w-4 h-4 flex-shrink-0 mt-0.5" />
                  <span>
                    After upload, OCR runs in the background and pre-fills details for review.
                  </span>
                </div>
              </div>
            )}
          </div>

          {/* Right column */}
          <div className="lg:col-span-7">
            {showManualForm && (
              <div
                className={clsx(
                  "bg-card rounded-2xl border p-8",
                  isSelfUpload ? "border-primary/30" : "border-border",
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

                {hasMetadata && (
                  <div className="mb-8">
                    <h3 className="font-semibold text-foreground mb-4 flex items-center gap-2">
                      <CheckCircle className="w-5 h-5 text-teal" />
                      Document Details
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
                            errors={errors as Record<string, unknown>}
                            enforceRequired={!relaxReq}
                            suggestionScore={undefined}
                            name={getUploadFieldName(field)}
                          />
                        ))}
                    </div>
                  </div>
                )}

                <div className="space-y-6">
                  {isSelfUpload && (
                    <>
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
                        <div>
                          <label className="label">Document name</label>
                          <input
                            {...register("title")}
                            className="input"
                            placeholder={droppedFile?.name.replace(/\.[^.]+$/, "") || "Document name"}
                          />
                        </div>
                        <div>
                          <label className="label">Description</label>
                          <input
                            {...register("personal_description")}
                            className="input"
                            placeholder="Short description"
                          />
                        </div>
                      </div>

                      <div>
                        <label className="label">Document text</label>
                        <textarea
                          {...register("personal_text")}
                          rows={5}
                          className="input resize-y"
                          placeholder="Type notes, pasted text, reference details, or anything you want kept with this document."
                        />
                      </div>

                      <div className="rounded-xl border border-border bg-muted/30 p-4">
                        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                          <div className="flex items-start gap-3">
                            <div className="mt-0.5 flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                              <Tags className="h-4 w-4" />
                            </div>
                            <div>
                              <p className="text-sm font-semibold text-foreground">
                                Optional tags and custom fields
                              </p>
                              <p className="mt-0.5 text-xs text-muted-foreground">
                                Add extra organization only when this document needs it.
                              </p>
                            </div>
                          </div>
                          <button
                            type="button"
                            onClick={() => setShowPersonalExtras((open) => !open)}
                            className={clsx(
                              "inline-flex items-center justify-center gap-2 rounded-lg border px-3 py-2 text-sm font-semibold transition-colors",
                              showPersonalExtras
                                ? "border-primary bg-primary text-primary-foreground"
                                : "border-border bg-card text-foreground hover:bg-muted",
                            )}
                          >
                            <FileText className="h-4 w-4" />
                            {showPersonalExtras ? "Hide optional details" : "Add optional details"}
                          </button>
                        </div>

                        {showPersonalExtras && (
                          <div className="mt-5 space-y-5 border-t border-border pt-5">
                            <div>
                              <label className="label">Personal tags</label>
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

                            <div>
                              <label className="label">Custom personal fields</label>
                              <div className="space-y-2">
                                {personalMetadataFields.map((field, index) => (
                                  <PersonalMetadataRow
                                    key={field.id}
                                    index={index}
                                    total={personalMetadataFields.length}
                                    register={register}
                                    onRemove={() => removePersonalMetadata(index)}
                                  />
                                ))}
                              </div>
                              <button
                                type="button"
                                onClick={() => appendPersonalMetadata({ key: "", value: "" })}
                                className="mt-3 inline-flex items-center gap-2 text-sm font-medium text-primary hover:text-primary/80"
                              >
                                <Plus className="w-4 h-4" /> Add custom field
                              </button>
                            </div>
                          </div>
                        )}
                      </div>
                    </>
                  )}
                </div>

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

            {scanOnly && showOcrIdlePanel && (
              <div
                className="bg-card rounded-2xl border border-teal/30 p-8 flex flex-col items-center text-center"
                style={{ boxShadow: "var(--shadow-card)" }}
              >
                <div className="w-16 h-16 rounded-2xl bg-teal/10 flex items-center justify-center mb-4">
                  <ScanLine className="w-8 h-8 text-teal" />
                </div>
                <h3 className="text-lg font-semibold text-foreground mb-2">OCR Scan Mode</h3>
                <p className="text-sm text-muted-foreground max-w-sm mb-6">
                  Upload the file and the OCR pipeline will extract text automatically.
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
          </div>
        </div>
      )}

      {/* Uploading spinner (OCR flow) */}
      {scanStage === "uploading" && (
        <div className="flex flex-col items-center py-16 text-center">
          <Loader2 className="w-12 h-12 animate-spin text-teal mb-4" />
          <p className="text-foreground font-semibold text-lg">Uploading…</p>
          {uploadProgress > 0 && (
            <div className="w-64 mt-4">
              <div className="h-2 bg-muted rounded-full overflow-hidden">
                <div className="h-full bg-teal transition-all" style={{ width: `${uploadProgress}%` }} />
              </div>
              <p className="text-xs text-muted-foreground mt-1">{uploadProgress}%</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
