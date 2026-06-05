import { useState, useCallback, useEffect, useMemo, useRef, type MouseEvent, type ReactNode } from "react";
import { useLocation, useNavigate } from "react-router-dom";
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
import { documentsAPI, documentTypesAPI, normalizeListResponse, templatesAPI } from "@/services/api";
import {
  Upload, File, X, Loader2, ArrowRight, CheckCircle, Plus, Lock,
  Info, ScanLine, Sparkles, AlertCircle, ChevronRight, ShieldAlert,
  Cpu, List, FileText, Tags, LayoutTemplate, Wand2,
} from "lucide-react";
import { toast } from "@/components/ui/vault-toast";
import type { DocumentType, MetadataField } from "@/types";
import clsx from "clsx";
import { QUERY_FIVE_MIN_STALE } from "@/lib/reactQueryDefaults";
import { deriveDocumentTypeConfig } from "@/lib/documentTypeConfig";
import { applyOcrToFields, sanitizeOcrFields, type OcrFields } from "@/lib/ocrFieldMatcher";
import BulkScanPage from "@/pages/BulkScanPage";
import TemplatePreview from "@/components/templates/TemplatePreview";
import TemplateForm, { requiredFieldLabels } from "@/components/templates/TemplateForm";

// ── Types ─────────────────────────────────────────────────────────────────────

type PersonalTagField      = { value: string };
type PersonalMetadataField = { key: string; value: string };
type OcrLineItem = Record<string, string | number | null | undefined>;

type DocumentTemplateOption = {
  id: string;
  name: string;
  description?: string;
  type: "built" | "uploaded";
  document_type?: string;
  document_type_id?: string;
  file_name?: string;
  placeholders?: string[];
  sections?: unknown[];
};

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

const PREVIEW_HEIGHT = "h-[clamp(34rem,calc(100vh-15rem),46rem)]";
const PREVIEW_MIN_HEIGHT = "min-h-[clamp(34rem,calc(100vh-15rem),46rem)]";
const COMPACT_PREVIEW_HEIGHT = "h-[30rem]";
const COMPACT_PREVIEW_MIN_HEIGHT = "min-h-[30rem]";

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

function ocrString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function ocrScalar(value: unknown): string | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed || undefined;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return undefined;
}

function normalizeDateInput(value: string): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const slash = value.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (slash) {
    const [, month, day, year] = slash;
    return `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
  }
  return value;
}

const OCR_FIELD_ALIASES: Record<string, Array<keyof OcrFields>> = {
  transaction_reference: ["transaction_ref", "reference_number"],
  transaction_number: ["transaction_ref", "reference_number"],
  payment_reference: ["transaction_ref", "reference_number"],
  payment_ref: ["transaction_ref", "reference_number"],
  reference: ["reference_number"],
  reference_no: ["reference_number"],
  reference_number: ["reference_number"],
  account: ["account_code"],
  account_code: ["account_code"],
  account_number: ["account_code"],
  account_no: ["account_code"],
  vat_no: ["vat_number"],
  vat_number: ["vat_number"],
  tax_number: ["vat_number"],
  payment: ["payment_method"],
  payment_method: ["payment_method"],
  subtotal: ["subtotal"],
  sub_total: ["subtotal"],
};

function getExactOcrValueForField(field: MetadataField, fields: OcrFields): string | undefined {
  const key = getMetadataFieldKey(field).toLowerCase().trim();
  const labelKey = (field.label ?? "").toLowerCase().trim().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  const candidates = [key, labelKey]
    .flatMap((candidate) => [candidate, ...(OCR_FIELD_ALIASES[candidate] ?? [])])
    .filter(Boolean) as string[];

  for (const candidate of candidates) {
    const value = ocrScalar(fields[candidate]);
    if (value) return value;
  }
  return undefined;
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

  const wrapper = (children: ReactNode) => (
    <div className="grid gap-2 border-b border-border/60 py-3 sm:grid-cols-[minmax(160px,0.55fr)_minmax(0,1fr)] sm:items-start">
      <label className="flex min-h-9 items-center gap-1.5 text-sm font-normal text-muted-foreground">
        <span>{field.label}</span>
        {field.is_required && enforceRequired && (
          <span className="text-destructive">*</span>
        )}
        {suggested && <SuggestionPill score={suggestionScore} />}
      </label>
      <div>
        {children}
        {errMsg && <p className="text-destructive text-xs mt-1">{errMsg}</p>}
      </div>
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
      <div className="grid gap-2 border-b border-border/60 py-3 sm:grid-cols-[minmax(160px,0.55fr)_minmax(0,1fr)] sm:items-center">
        <span className="text-sm font-normal text-muted-foreground">{field.label}</span>
        <div className="flex items-center gap-2">
        <input
          {...register(fieldName)}
          type="checkbox"
          id={fieldKey}
          className="w-4 h-4 rounded border-border text-primary focus:ring-primary"
        />
        <label htmlFor={fieldKey} className="text-sm text-foreground">
          Yes
        </label>
        </div>
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
        "w-5 h-5 rounded-sm flex items-center justify-center text-[11px] font-semibold flex-shrink-0 transition-colors",
        done    ? "bg-accent text-accent-foreground"
        : active ? "bg-primary text-primary-foreground"
                 : "bg-muted text-muted-foreground border border-border",
      )}
    >
      {done ? <CheckCircle className="w-3.5 h-3.5" /> : n}
    </div>
  );
}

function DetailsTab() {
  return (
    <div className="border-b border-border">
      <div className="flex flex-wrap">
        <button
          type="button"
          className="-mb-px h-11 border border-t-2 border-border border-t-primary bg-background px-5 text-sm text-primary transition-colors"
        >
          Details
        </button>
      </div>
    </div>
  );
}

function InforFieldRow({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="grid gap-2 border-b border-border/60 py-3 sm:grid-cols-[minmax(160px,0.55fr)_minmax(0,1fr)] sm:items-start">
      <label className="flex min-h-9 items-center text-sm font-normal text-muted-foreground">
        {label}
      </label>
      <div>{children}</div>
    </div>
  );
}

function TemplateFillSection({ template, register, values, onChange }: {
  template: DocumentTemplateOption;
  register: UseFormRegister<UploadFormValues>;
  values: Record<string, unknown>;
  onChange: (key: string, val: unknown) => void;
}) {
  const placeholders = template.placeholders ?? [];
  const humanize = (key: string) =>
    key.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

  return (
    <div className="space-y-6">
      <InforFieldRow label="Document name">
        <input {...register("title")} className="input" placeholder={template.name} />
      </InforFieldRow>

      {template.type === "uploaded" ? (
        placeholders.length > 0 ? (
          <div>
            <p className="mb-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Fill template fields
            </p>
            <div className="grid gap-4 sm:grid-cols-2">
              {placeholders.map((key) => (
                <div key={key}>
                  <label className="mb-1.5 block text-xs font-semibold text-foreground">
                    {humanize(key)}
                    <span className="ml-2 font-mono text-[10px] font-normal text-muted-foreground">{`{{${key}}}`}</span>
                  </label>
                  <input
                    value={String(values[key] ?? "")}
                    onChange={(e) => onChange(key, e.target.value)}
                    className="input"
                    placeholder={`Enter ${humanize(key).toLowerCase()}`}
                  />
                </div>
              ))}
            </div>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            This template has no placeholders — a copy of the file is created for you to edit after capture.
          </p>
        )
      ) : (
        // Built templates are interactive forms — filled in-app, never in an external editor.
        <div>
          <p className="mb-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Fill in the form
          </p>
          <TemplateForm sections={template.sections ?? []} values={values} onChange={onChange} />
        </div>
      )}
    </div>
  );
}

function SelectedFileDropHint({
  file,
  isDragActive,
  onRemove,
}: {
  file: File;
  isDragActive: boolean;
  onRemove: (event: MouseEvent<HTMLButtonElement>) => void;
}) {
  return (
    <div className="mt-6 flex flex-col items-center text-center">
      <div className="relative mb-3 h-9 w-9 text-muted-foreground">
        <Upload className="h-9 w-9 stroke-[1.35]" />
      </div>
      <p className="text-sm font-semibold text-foreground">
        {isDragActive ? "Drop file here" : "Click here or drag and drop to add file"}
      </p>
      <p className="mt-2 max-w-md text-sm leading-snug text-foreground">
        The file has been selected. Press the save button to save the changes or select another file.
      </p>
      <p className="mt-2 text-xs text-muted-foreground">
        {file.name} · {(file.size / (1024 * 1024)).toFixed(2)} MB
      </p>
      <button
        type="button"
        onClick={onRemove}
        className="mt-3 inline-flex items-center gap-1 text-xs font-medium text-destructive hover:text-destructive/80"
      >
        <X className="w-3.5 h-3.5" /> Remove
      </button>
    </div>
  );
}

type CapturePreviewKind = "pdf" | "image" | "other";

function getCapturePreviewKind(file: File | null | undefined): CapturePreviewKind {
  if (!file) return "other";
  if (file.type === "application/pdf") return "pdf";
  if (file.type.startsWith("image/")) return "image";
  return "other";
}

function CapturePreviewPane({
  file,
  previewUrl,
  stateLabel,
  progress,
  compact = false,
}: {
  file: File | null;
  previewUrl: string | null;
  stateLabel?: string;
  progress?: number;
  compact?: boolean;
}) {
  const kind = getCapturePreviewKind(file);
  const previewHeight = compact ? COMPACT_PREVIEW_HEIGHT : PREVIEW_HEIGHT;
  const previewMinHeight = compact ? COMPACT_PREVIEW_MIN_HEIGHT : PREVIEW_MIN_HEIGHT;
  const pdfSrc = previewUrl ? `${previewUrl}#toolbar=1&navpanes=0&scrollbar=1&view=FitV` : null;

  return (
    <div className="border border-[#C8CDD2] bg-white">
      <div className="flex min-h-11 items-center justify-between gap-3 border-b border-[#C8CDD2] bg-[#F5F7F8] px-3 py-2">
        <div className="min-w-0">
          <p className="text-sm font-bold text-[#1F2933]">Document preview</p>
          <p className="truncate text-xs text-[#5E6870]">{file?.name || "No file selected"}</p>
        </div>
        {stateLabel && (
          <span className="shrink-0 border border-[#C8CDD2] bg-white px-2 py-1 text-[11px] font-semibold text-[#5E6870]">
            {stateLabel}
          </span>
        )}
      </div>

      {progress !== undefined && progress > 0 && (
        <div className="h-1.5 bg-[#E1E5E8]">
          <div className="h-full bg-[#287EAD] transition-all" style={{ width: `${progress}%` }} />
        </div>
      )}

      <div className={clsx("bg-[#EDEDED] p-3", previewMinHeight)}>
        {pdfSrc && kind === "pdf" ? (
          <div className={clsx("mx-auto w-full max-w-[920px] border border-[#C8CDD2] bg-white", previewHeight)}>
            <iframe
              src={pdfSrc}
              className="h-full w-full bg-white"
              title="PDF preview"
            />
          </div>
        ) : previewUrl && kind === "image" ? (
          <div className={clsx("mx-auto flex w-full max-w-[920px] items-center justify-center overflow-auto border border-[#C8CDD2] bg-white", previewHeight)}>
            <img src={previewUrl} alt="Document preview" className="max-h-full max-w-full object-contain" />
          </div>
        ) : (
          <div className={clsx("mx-auto flex w-full max-w-[920px] flex-col items-center justify-center border border-dashed border-[#C8CDD2] bg-white text-center", previewHeight)}>
            {kind === "other" && file ? <File className="mb-3 h-12 w-12 text-[#5E6870]" /> : <Upload className="mb-3 h-12 w-12 text-[#5E6870]" />}
            <p className="text-sm font-semibold text-[#1F2933]">
              {file ? "Inline preview is not available for this format" : "Select a file to preview"}
            </p>
            <p className="mt-1 max-w-xs text-xs text-[#5E6870]">
              PDF and image scans can be reviewed beside the extracted fields.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

interface UploadPageProps {
  scanOnly?: boolean;
}

export default function UploadPage({ scanOnly = false }: UploadPageProps) {
  const navigate     = useNavigate();
  const location     = useLocation();
  const queryClient  = useQueryClient();

  const [droppedFile,      setDroppedFile]      = useState<File | null>(null);
  const [selectedTypeId,   setSelectedTypeId]   = useState("");
  const [uploadProgress,   setUploadProgress]   = useState(0);
  const [isScanned,        setIsScanned]         = useState(scanOnly);
  const [pdfPreviewUrl,    setPdfPreviewUrl]     = useState<string | null>(null);
  const [bulkMode,         setBulkMode]          = useState(() => new URLSearchParams(location.search).get("mode") === "bulk");
  const [useTemplate,      setUseTemplate]       = useState(false);
  const [selectedTemplateId, setSelectedTemplateId] = useState("");

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
  const canUseTemplate = !scanOnly && !isSelfUpload && Boolean(selectedTypeId);

  const { data: typeTemplates = [] } = useQuery<unknown, Error, DocumentTemplateOption[]>({
    queryKey: ["templates", "document-type", selectedTypeId],
    queryFn: () => templatesAPI.list({ document_type_id: selectedTypeId }).then((r) => r.data as unknown),
    select: (data) => normalizeListResponse<DocumentTemplateOption>(data).map((template) => ({
      ...template,
      document_type_id: template.document_type_id || template.document_type,
    })),
    enabled: canUseTemplate && useTemplate,
    ...QUERY_FIVE_MIN_STALE,
  });
  const selectedTemplate = typeTemplates.find((template) => template.id === selectedTemplateId) ?? null;

  // Values for the selected template: Office {{placeholders}} (strings) or a built
  // form's field values (strings, booleans, table-row arrays). Filled in-app.
  const [templateValues, setTemplateValues] = useState<Record<string, unknown>>({});
  useEffect(() => { setTemplateValues({}); }, [selectedTemplateId]);

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
      setUseTemplate(false);
      setSelectedTemplateId("");
    }
  }, [selectedTypeId, reset]);

  useEffect(() => {
    if (!canUseTemplate && useTemplate) {
      setUseTemplate(false);
      setSelectedTemplateId("");
    }
  }, [canUseTemplate, useTemplate]);

  useEffect(() => {
    if (!droppedFile) return;
    const currentTitle = String(getValues("title") ?? "").trim();
    if (!currentTitle) {
      setValue("title", documentNameFromFile(droppedFile));
    }
    // Create local preview URL for PDFs and image scans so capture review is not blind.
    if (droppedFile.type === "application/pdf" || droppedFile.type.startsWith("image/")) {
      const url = URL.createObjectURL(droppedFile);
      setPdfPreviewUrl(url);
      return () => URL.revokeObjectURL(url);
    } else {
      setPdfPreviewUrl(null);
    }
  }, [droppedFile, getValues, setValue]);

  useEffect(() => { clearErrors(); }, [isSelfUpload, isScanned, clearErrors]);

  useEffect(() => {
    setBulkMode(new URLSearchParams(location.search).get("mode") === "bulk");
  }, [location.search]);

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
      const fields = sanitizeOcrFields(suggestions.fields ?? {});
      const sanitizedSuggestions = { ...suggestions, fields };
      setOcrSuggestions(sanitizedSuggestions);
      setScanStage("ocr_done");

      const scoreMap  = new Map<string, number>();

      // Store detected line items for display
      if (Array.isArray(fields.line_items) && fields.line_items.length > 0) {
        setOcrLineItems(fields.line_items as unknown as OcrLineItem[]);
      }

      // Helper — fill a named form field and record its confidence score
      const fillDirect = (key: Path<UploadFormValues>, value: unknown, score = 4) => {
        const scalar = ocrScalar(value);
        if (scalar) {
          const normalized = String(key).endsWith("_date")
            ? normalizeDateInput(scalar)
            : scalar;
          setValue(key, normalized);
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
        for (const field of selectedType.metadata_fields) {
          const metadataKey = getMetadataFieldKey(field);
          if (!metadataKey || isDirectColumnKey(metadataKey)) continue;
          const value = getExactOcrValueForField(field, fields);
          if (!value) continue;
          const formPath = `metadata.${metadataKey}` as Path<UploadFormValues>;
          const normalized = field.field_type === "date" ? normalizeDateInput(value) : value;
          setValue(formPath, normalized);
          scoreMap.set(formPath, 4);
        }

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

  const createFromTemplateMutation = useMutation({
    mutationFn: (payload: {
      templateId: string;
      title: string;
      documentTypeId: string;
      values: Record<string, unknown>;
      draftFromTemplate: boolean;
      outputFormat: "pdf" | "docx";
    }) =>
      templatesAPI.fillTemplate({
        template_id: payload.templateId,
        values: payload.values,
        output_format: payload.outputFormat,
        title: payload.title,
        document_type_id: payload.documentTypeId,
        draft_from_template: payload.draftFromTemplate,
      }),
    onSuccess: ({ data }) => {
      queryClient.invalidateQueries({ queryKey: ["documents"] });
      toast.success("Document created from template.");
      navigate(`/documents/${data.document_id}`);
    },
    onError: (err: any) => {
      const data = err?.response?.data;
      const message = data?.detail || data?.document_type_id || "Could not create document from template.";
      toast.error(Array.isArray(message) ? message.join(", ") : String(message));
    },
  });

  // ── Submit handlers ─────────────────────────────────────────────────────────

  const onUpload = async (values: Record<string, unknown>) => {
    if (!selectedTypeId) { toast.error("Please select a document type"); return; }
    if (useTemplate) {
      if (!selectedTemplate) {
        toast.error("Please select a template");
        return;
      }
      const documentValues = documentValuesFromForm(values);
      const title = documentValues.title || selectedTemplate.name;
      const isUploaded = selectedTemplate.type === "uploaded";

      // Built forms are filled in-app — enforce required fields before creating.
      if (!isUploaded) {
        const missing = requiredFieldLabels(selectedTemplate.sections ?? [], templateValues);
        if (missing.length) {
          toast.error(`Please fill in: ${missing.join(", ")}`);
          return;
        }
      }

      createFromTemplateMutation.mutate({
        templateId: selectedTemplate.id,
        title,
        documentTypeId: selectedTypeId,
        // Both Office placeholders and built form fields are filled in-app.
        values: templateValues,
        draftFromTemplate: false,
        // Office → editable Office file; built form → PDF rendering (a view of the data).
        outputFormat: isUploaded ? "docx" : "pdf",
      });
      return;
    }
    if (!droppedFile)    { toast.error("Please select a file");          return; }

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

  if (bulkMode) {
    return (
      <BulkScanPage
        scanMode={scanOnly}
        onSingleMode={() => {
          setBulkMode(false);
          navigate(scanOnly ? "/documents/scan" : "/documents/upload", { replace: true });
        }}
      />
    );
  }

  return (
    <div className="-m-6 min-h-[calc(100vh-3.5rem)] bg-[#EDEDED] text-[#1F2933]">
      <div className="flex h-[69px] items-center justify-between gap-4 bg-[#287EAD] px-5 pr-8 text-white">
        <div className="min-w-0">
          <h1 className="text-lg font-semibold tracking-tight">{scanOnly ? "Scan Document" : "Upload Document"}</h1>
          <p className="mt-0.5 text-xs text-white/75">
            {scanOnly ? "Review the file beside OCR results before saving." : "Attach a file, preview it, then complete the document details."}
          </p>
        </div>
        <div className="hidden items-center gap-3 text-xs text-white/80 md:flex">
          <label className="inline-flex cursor-pointer items-center gap-2 border border-white/30 px-2.5 py-1.5 font-semibold">
            <input
              type="checkbox"
              checked={bulkMode}
              onChange={(event) => {
                setBulkMode(event.target.checked);
                if (event.target.checked) {
                  navigate(`${scanOnly ? "/documents/scan" : "/documents/upload"}?mode=bulk`, { replace: true });
                }
              }}
              className="h-3.5 w-3.5"
            />
            Bulk mode
          </label>
          <span className="border border-white/30 px-2 py-1">{selectedType?.name || "No type selected"}</span>
          <span className="border border-white/30 px-2 py-1">
            {useTemplate ? (selectedTemplate ? "Template selected" : "Awaiting template") : droppedFile ? "File attached" : "Awaiting file"}
          </span>
        </div>
      </div>

      {/* ── OCR wait / review / submitting ──────────────────────────────── */}
      {isOcrFlow && scanStage !== "idle" && scanStage !== "uploading" && (
        <div className="grid gap-4 p-5 pr-8 lg:grid-cols-12">
          <div className="lg:col-span-7 2xl:col-span-8">
            <CapturePreviewPane
              file={droppedFile}
              previewUrl={pdfPreviewUrl}
              stateLabel={showOcrWait ? "OCR running" : showOcrFailed ? "Manual review" : "Review"}
              compact={false}
            />
          </div>

          <div className="lg:col-span-5 2xl:col-span-4">
            <div className="max-h-[calc(100vh-9rem)] overflow-y-auto border border-[#C8CDD2] bg-white">
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
            <div className="p-5">
              {/* Header */}
              <div className="flex items-start gap-3 mb-5">
                {showOcrFailed ? (
                  <div className="w-8 h-8 rounded-lg bg-amber-100 dark:bg-amber-950 flex items-center justify-center flex-shrink-0">
                    <AlertCircle className="w-4 h-4 text-amber-600 dark:text-amber-400" />
                  </div>
                ) : (
                  <div className="w-8 h-8 rounded-lg bg-teal/15 flex items-center justify-center flex-shrink-0">
                    <Sparkles className="w-4 h-4 text-teal" />
                  </div>
                )}
                <div className="flex-1 min-w-0">
                  <h2 className="text-lg font-semibold text-foreground">
                    {showOcrFailed ? "OCR could not extract text" : "Review extracted details"}
                  </h2>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    {showOcrFailed
                      ? "Please fill in the details manually and confirm."
                      : "Fields marked OCR were auto-filled — teal = confident, amber = verify carefully."}
                  </p>
                </div>
                <div className="hidden sm:flex flex-col items-end gap-1.5 flex-shrink-0">
                  {ocrQuality?.engine && <EngineBadge engine={ocrQuality.engine} />}
                  {ocrFields.reference_number && (
                    <div className="text-right">
                      <p className="text-[10px] text-muted-foreground">Detected reference</p>
                      <p className="text-xs font-mono font-semibold text-foreground">
                        {ocrFields.reference_number}
                      </p>
                    </div>
                  )}
                </div>
              </div>

              {isLowQuality && ocrQuality && <LowQualityBanner quality={ocrQuality} />}

              {/* Raw text preview */}
              {ocrFields.raw_lines && ocrFields.raw_lines.length > 0 && (
                <details className="mb-5 group">
                  <summary className="cursor-pointer list-none flex items-center gap-2 text-xs font-semibold text-muted-foreground hover:text-foreground select-none">
                    <ChevronRight className="w-3 h-3 transition-transform group-open:rotate-90" />
                    Show extracted text ({ocrFields.raw_lines.length} lines)
                  </summary>
                  <div className="mt-2 rounded-lg border border-border bg-muted/20 p-3 max-h-40 overflow-y-auto">
                    {ocrFields.raw_lines.map((line, i) => (
                      <p key={i} className="text-[11px] font-mono text-muted-foreground leading-relaxed">{line}</p>
                    ))}
                  </div>
                </details>
              )}

              <div className="space-y-5">
                {/* Line items detected from tables */}
                {ocrLineItems.length > 0 && <LineItemsPanel items={ocrLineItems} />}

                {/* Read-only info chips */}
                <OcrInfoChips fields={ocrFields} />

                {/* Admin metadata fields */}
                {hasMetadata && (
                  <div>
                    <h3 className="font-semibold text-foreground mb-3 flex items-center gap-2 text-sm">
                      <CheckCircle className="w-4 h-4 text-teal" />
                      Document Details
                    </h3>
                    <div className="space-y-2.5">
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
                <div className="sticky bottom-0 z-10 -mx-5 -mb-5 flex gap-3 border-t border-border bg-white px-5 py-4">
                  <button
                    type="button"
                    onClick={onConfirmOcr}
                    disabled={saveMutation.isPending}
                    className="inline-flex items-center justify-center gap-2 px-4 py-2 rounded-lg font-semibold bg-teal text-teal-foreground hover:bg-teal/90 transition-all disabled:opacity-50 text-sm"
                    style={{ boxShadow: "var(--shadow-elegant)" }}
                  >
                    {saveMutation.isPending ? (
                      <Loader2 className="w-4 h-4 animate-spin" />
                    ) : (
                      <>
                        <CheckCircle className="w-4 h-4" />
                        Confirm &amp; Save
                      </>
                    )}
                  </button>
                  <button
                    type="button"
                    onClick={onSkipToDocument}
                    className="px-4 py-2 rounded-lg font-semibold border border-border bg-card text-foreground hover:bg-muted transition-colors text-sm"
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
          </div>
        </div>
      )}

      {/* ── Main upload layout ─────────────────────────────────────────── */}
      {(scanStage === "idle" || scanStage === "uploading") && (
        <div className="grid grid-cols-1 gap-5 p-5 pr-8 xl:grid-cols-12">
          {/* Left column — controls */}
          <div className={clsx(droppedFile ? "order-2 xl:col-span-3" : useTemplate ? "xl:col-span-4" : "xl:col-start-2 xl:col-span-4", "space-y-4")}>
            {/* Step 1 — Document Type */}
            <div className="border border-[#C8CDD2] bg-white p-4">
              <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold text-[#1F2933]">
                <StepBadge n={1} active={!selectedTypeId} done={Boolean(selectedTypeId)} />
                Document Type
              </h2>
              <label className="mb-3 flex cursor-pointer items-center gap-2 border border-[#D3D7DA] bg-[#F7F8F9] px-3 py-2 text-sm text-[#1F2933] md:hidden">
                <input
                  type="checkbox"
                  checked={bulkMode}
                  onChange={(event) => {
                    setBulkMode(event.target.checked);
                    if (event.target.checked) {
                      navigate(`${scanOnly ? "/documents/scan" : "/documents/upload"}?mode=bulk`, { replace: true });
                    }
                  }}
                />
                Use bulk mode
              </label>
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
                <div className="mt-4 flex items-start gap-2 border border-[#A7CDE3] bg-[#EEF6FB] px-3 py-2 text-xs text-[#287EAD]">
                  <Info className="w-4 h-4 flex-shrink-0 mt-0.5" />
                  <span>
                    {isSelfUpload
                      ? "This type uploads as personal (visible to you and admins, no approval workflow)."
                      : "This type follows the workflow approval process."}
                  </span>
                </div>
              )}
              {canUseTemplate && (
                <div className="mt-4 border border-[#C8CDD2] bg-[#F7F8F9] p-3">
                  <label className="flex cursor-pointer items-center gap-2 text-sm font-semibold text-[#1F2933]">
                    <input
                      type="checkbox"
                      checked={useTemplate}
                      onChange={(event) => {
                        setUseTemplate(event.target.checked);
                        if (!event.target.checked) setSelectedTemplateId("");
                      }}
                    />
                    <LayoutTemplate className="h-4 w-4 text-[#287EAD]" />
                    Use template
                  </label>
                  {useTemplate && (
                    <div className="mt-3 space-y-2">
                      <select
                        value={selectedTemplateId}
                        onChange={(event) => setSelectedTemplateId(event.target.value)}
                        className="input w-full"
                      >
                        <option value="">Select template</option>
                        {typeTemplates.map((template) => (
                          <option key={template.id} value={template.id}>
                            {template.name} ({template.type === "uploaded" ? "Office" : "Builder"})
                          </option>
                        ))}
                      </select>
                      {typeTemplates.length === 0 && (
                        <p className="text-xs text-[#5E6870]">No active templates are configured for this document type.</p>
                      )}
                      {selectedTemplate && (
                        <p className="text-xs text-[#5E6870]">
                          {selectedTemplate.description || "A draft document will be created from this template for editing."}
                        </p>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* Step 2 — Attach File */}
            {!useTemplate && (
            <div className="border border-[#C8CDD2] bg-white p-4">
              <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold text-[#1F2933]">
                <StepBadge n={2} active={Boolean(selectedTypeId) && !droppedFile} done={Boolean(droppedFile)} />
                Attach File
              </h2>
              <div
                {...getRootProps()}
                className={clsx(
                  "cursor-pointer border border-dashed p-5 text-center transition-all",
                  isDragActive  ? "border-[#287EAD] bg-[#EEF6FB]"
                  : droppedFile
                    ? "border-[#C8CDD2] bg-[#F7F8F9]"
                    : "border-[#C8CDD2] bg-[#F7F8F9] hover:border-[#287EAD] hover:bg-white",
                )}
              >
                <input {...getInputProps()} />
                {droppedFile ? (
                  <SelectedFileDropHint
                    file={droppedFile}
                    isDragActive={isDragActive}
                    onRemove={(e) => { e.stopPropagation(); setDroppedFile(null); setPdfPreviewUrl(null); }}
                  />
                ) : (
                  <>
                    <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center text-muted-foreground">
                      <Upload className="w-8 h-8 stroke-[1.35]" />
                    </div>
                    <p className="font-semibold text-foreground">
                      {isDragActive ? "Drop here" : "Click here or drag and drop to add file"}
                    </p>
                    <p className="text-xs text-muted-foreground mt-3">
                      PDF · DOCX · XLSX · PPTX · DOC · PNG · JPG · TIFF
                    </p>
                  </>
                )}
              </div>
            </div>
            )}

            {scanOnly && (
              <div className="space-y-2 border border-[#A7CDE3] bg-white p-4">
                <h2 className="mb-2 flex items-center gap-2 text-sm font-semibold text-foreground">
                  <StepBadge n={3} active={Boolean(droppedFile)} />
                  Scan Mode (OCR)
                </h2>
                <div className="flex items-start gap-2 border border-[#A7CDE3] bg-[#EEF6FB] px-3 py-2 text-xs text-[#287EAD]">
                  <Sparkles className="w-4 h-4 flex-shrink-0 mt-0.5" />
                  <span>
                    After upload, OCR runs in the background and pre-fills details for review.
                  </span>
                </div>
              </div>
            )}
          </div>

          {/* Centre column — document preview (visible when file selected) */}
          {droppedFile && (
            <div className="order-1 xl:col-span-6">
              <CapturePreviewPane
                file={droppedFile}
                previewUrl={pdfPreviewUrl}
                stateLabel={isScanned ? "Ready to scan" : "Ready"}
                compact={false}
              />
            </div>
          )}
          {useTemplate && !droppedFile && (
            <div className="order-1 xl:col-span-5">
              <div className={clsx("flex flex-col border border-[#C8CDD2] bg-[#F7F8F9]", PREVIEW_MIN_HEIGHT)}>
                <div className="border-b border-[#C8CDD2] bg-white px-4 py-3">
                  <p className="text-sm font-semibold text-[#1F2933]">Template source</p>
                  <p className="mt-0.5 text-xs text-[#5E6870]">{selectedTemplate?.name || "Select a template"}</p>
                </div>
                {selectedTemplate ? (
                  <div className="flex-1 overflow-y-auto p-5">
                    <TemplatePreview
                      template={{
                        name: selectedTemplate.name,
                        type: selectedTemplate.type,
                        description: selectedTemplate.description,
                        file_name: selectedTemplate.file_name,
                        placeholders: selectedTemplate.placeholders,
                        sections: selectedTemplate.sections,
                      }}
                    />
                    <p className="mt-5 border-t border-[#E3E7EA] pt-3 text-xs text-[#5E6870]">
                      A draft document will be generated from this template. After creation, open it and use the normal editor to complete or adjust it.
                    </p>
                  </div>
                ) : (
                  <div className="flex h-full min-h-[30rem] flex-col items-center justify-center px-8 text-center">
                    <div className="mb-4 flex h-16 w-16 items-center justify-center border border-[#A7CDE3] bg-[#EEF6FB] text-[#287EAD]">
                      <LayoutTemplate className="h-8 w-8" />
                    </div>
                    <p className="text-base font-semibold text-[#1F2933]">Choose a template for this document type</p>
                    <p className="mt-2 max-w-md text-sm text-[#5E6870]">
                      Templates are maintained by admins and scoped to the selected document type.
                    </p>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Right column — form / OCR idle */}
          <div className={clsx(droppedFile ? "order-3 xl:col-span-3" : useTemplate ? "order-3 xl:col-span-3" : "xl:col-start-7 xl:col-span-5")}>
            {showManualForm && (
              <div
                className={clsx(
                  "w-full border bg-white",
                  isSelfUpload ? "border-[#A7CDE3]" : "border-[#C8CDD2]",
                )}
              >
                <DetailsTab />
                <div className="p-5 sm:p-6">
                  <div className="mb-5 flex items-center gap-2.5">
                    <StepBadge n={4} active />
                    <h2 className="text-base font-semibold text-foreground">
                      {isSelfUpload ? "Personal Details" : "Document Details"}
                    </h2>
                    {isSelfUpload && (
                      <span className="ml-auto inline-flex items-center gap-1 text-xs font-semibold text-primary">
                        <Lock className="w-3.5 h-3.5" /> Personal
                      </span>
                    )}
                  </div>

                  {useTemplate && selectedTemplate ? (
                    <TemplateFillSection
                      template={selectedTemplate}
                      register={register}
                      values={templateValues}
                      onChange={(key, val) => setTemplateValues((prev) => ({ ...prev, [key]: val }))}
                    />
                  ) : (
                  <>
                  {hasMetadata && (
                    <div className="mb-8">
                      <div className="grid gap-2 border-b border-border/70 py-3 sm:grid-cols-[minmax(160px,0.55fr)_minmax(0,1fr)]">
                        <span className="text-sm text-muted-foreground">Document Type</span>
                        <span className="text-sm text-foreground">{selectedType?.name}</span>
                      </div>
                      <div>
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
                        <div>
                          <InforFieldRow label="Document name">
                          <input
                            {...register("title")}
                            className="input"
                            placeholder={droppedFile?.name.replace(/\.[^.]+$/, "") || "Document name"}
                          />
                          </InforFieldRow>
                          <InforFieldRow label="Description">
                          <input
                            {...register("personal_description")}
                            className="input"
                            placeholder="Short description"
                          />
                          </InforFieldRow>
                        </div>

                        <InforFieldRow label="Document text">
                        <textarea
                          {...register("personal_text")}
                          rows={5}
                          className="input resize-y"
                          placeholder="Type notes, pasted text, reference details, or anything you want kept with this document."
                        />
                        </InforFieldRow>

                      <div className="border border-border bg-muted/20 p-4">
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
                  </>
                  )}

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

                  <div className="mt-6 flex flex-wrap gap-3 border-t border-border pt-5">
                  <button
                    type="button"
                    onClick={handleSubmit(onUpload)}
                    disabled={uploadMutation.isPending || createFromTemplateMutation.isPending || (!useTemplate && !droppedFile) || (useTemplate && !selectedTemplate)}
                    className="inline-flex items-center justify-center gap-2 rounded-sm bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground transition-all hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
                    style={{ boxShadow: "var(--shadow-elegant)" }}
                  >
                    {uploadMutation.isPending || createFromTemplateMutation.isPending ? (
                      <Loader2 className="w-5 h-5 animate-spin" />
                    ) : (
                      <>
                        {useTemplate ? <Wand2 className="w-4 h-4" /> : isSelfUpload ? <Lock className="w-4 h-4" /> : <Upload className="w-4 h-4" />}
                        {useTemplate
                          ? "Create Document"
                          : isSelfUpload ? "Save Personal Document" : "Upload Document"}
                        <ArrowRight className="w-4 h-4" />
                      </>
                    )}
                  </button>
                  <button
                    type="button"
                    onClick={() => navigate("/documents")}
                    className="rounded-sm border border-border bg-card px-4 py-2 text-sm font-semibold text-foreground transition-colors hover:bg-muted"
                  >
                    Cancel
                  </button>
                  </div>
                </div>
              </div>
            )}

            {scanOnly && showOcrIdlePanel && (
              <div
                className="flex flex-col items-center border border-[#C8CDD2] bg-white p-6 text-center"
              >
                <div className="mb-4 flex h-14 w-14 items-center justify-center bg-[#EEF6FB]">
                  <ScanLine className="h-7 w-7 text-[#287EAD]" />
                </div>
                <h3 className="mb-2 text-lg font-semibold text-[#1F2933]">OCR Scan Mode</h3>
                <p className="mb-6 max-w-sm text-sm text-[#5E6870]">
                  Upload the file and the OCR pipeline will extract text automatically.
                  You'll then review and confirm the extracted details before saving.
                </p>
                <div className="mb-6 w-full space-y-2 border border-[#C8CDD2] bg-[#F7F8F9] p-4 text-left text-sm">
                  {[
                    "Select document type and drop your file",
                    "Click Upload — OCR runs in the background",
                    "Review pre-filled details and confirm",
                  ].map((step, i) => (
                    <div key={i} className="flex items-center gap-3">
                      <span className="flex h-5 w-5 flex-shrink-0 items-center justify-center bg-[#DCEAF2] text-xs font-bold text-[#287EAD]">
                        {i + 1}
                      </span>
                      <span className="text-[#1F2933]">{step}</span>
                    </div>
                  ))}
                </div>

                {uploadMutation.isPending && uploadProgress > 0 && (
                  <div className="w-full mb-4">
                    <div className="flex justify-between text-xs text-muted-foreground mb-1.5">
                      <span>Uploading for OCR…</span>
                      <span className="font-semibold text-foreground">{uploadProgress}%</span>
                    </div>
                    <div className="h-2.5 overflow-hidden bg-[#E1E5E8]">
                      <div
                        className="h-full bg-[#287EAD] transition-all duration-300"
                        style={{ width: `${uploadProgress}%` }}
                      />
                    </div>
                  </div>
                )}

                <div className="flex flex-wrap gap-3 w-full">
                  <button
                    type="button"
                    onClick={handleSubmit(onUpload)}
                    disabled={uploadMutation.isPending || !droppedFile || !selectedTypeId}
                    className="inline-flex items-center justify-center gap-2 bg-[#287EAD] px-4 py-2 text-sm font-semibold text-white transition-all hover:bg-[#206D99] disabled:cursor-not-allowed disabled:opacity-50"
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
                    className="border border-[#C8CDD2] bg-white px-4 py-2 text-sm font-semibold text-[#1F2933] transition-colors hover:bg-[#EEF3F7]"
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
