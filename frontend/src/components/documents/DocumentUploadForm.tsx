/**
 * components/documents/DocumentUploadForm.tsx
 * Multi-step upload form:
 *  1. Drop/select file
 *  2. Select document type
 *  3. Fill standard + dynamic metadata fields
 *  4. Submit
 */
import { useState, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { useDropzone } from "react-dropzone";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useForm, Controller } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { UploadCloud, FileText, X, ChevronRight, ChevronLeft, Loader2 } from "lucide-react";
import { documentApi } from "../../services/api";
import { cn } from "../../lib/utils";
import { format } from "date-fns";

// Dynamic schema built at runtime based on required fields
function buildSchema(requiredFields: string[]) {
  const shape: Record<string, z.ZodTypeAny> = {
    title: z.string().min(1, "Title is required"),
    document_type_id: z.string().uuid("Select a document type"),
    supplier: z.string().optional(),
    amount: z.coerce.number().optional(),
    currency: z.string().default("USD"),
    document_date: z.string().optional(),
    due_date: z.string().optional(),
  };
  requiredFields.forEach((k) => {
    shape[`meta_${k}`] = z.string().min(1, `${k} is required`);
  });
  return z.object(shape);
}

const CURRENCIES = ["USD", "EUR", "GBP", "KES", "ZAR", "NGN", "GHS"];

interface MetadataField {
  id: string;
  key: string;
  label: string;
  field_type: string;
  is_required: boolean;
  select_options: string[];
  help_text: string;
}

interface DocumentType {
  id: string;
  name: string;
  code: string;
  reference_prefix: string;
  metadata_fields: MetadataField[];
}

export default function DocumentUploadForm() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [file, setFile] = useState<File | null>(null);
  const [selectedType, setSelectedType] = useState<DocumentType | null>(null);

  const { data: typesData } = useQuery({
    queryKey: ["document-types"],
    queryFn: () => documentApi.types(),
    select: (r) => r.data as DocumentType[],
  });

  const requiredMetaKeys = (selectedType?.metadata_fields ?? [])
    .filter((f) => f.is_required)
    .map((f) => f.key);

  const schema = buildSchema(requiredMetaKeys);
  const form = useForm({ resolver: zodResolver(schema) });

  const onDrop = useCallback((accepted: File[]) => {
    if (accepted[0]) { setFile(accepted[0]); setStep(2); }
  }, []);

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    maxFiles: 1,
    accept: {
      "application/pdf": [".pdf"],
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document": [".docx"],
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": [".xlsx"],
      "application/msword": [".doc"],
      "application/vnd.ms-excel": [".xls"],
      "image/*": [".png", ".jpg", ".jpeg", ".tiff"],
    },
  });

  const uploadMutation = useMutation({
    mutationFn: (formData: FormData) => documentApi.upload(formData),
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: ["documents"] });
      navigate(`/documents/${res.data.id}`);
    },
  });

  const handleSubmit = form.handleSubmit((values) => {
    if (!file || !selectedType) return;

    const fd = new FormData();
    fd.append("file", file);
    fd.append("title", values.title as string);
    fd.append("document_type_id", selectedType.id);
    if (values.supplier) fd.append("supplier", values.supplier as string);
    if (values.amount) fd.append("amount", String(values.amount));
    fd.append("currency", (values.currency as string) ?? "USD");
    if (values.document_date) fd.append("document_date", values.document_date as string);
    if (values.due_date) fd.append("due_date", values.due_date as string);

    // Gather dynamic metadata
    const metadata: Record<string, string> = {};
    selectedType.metadata_fields.forEach((f) => {
      const v = values[`meta_${f.key}` as keyof typeof values];
      if (v !== undefined && v !== "") metadata[f.key] = String(v);
    });
    fd.append("metadata", JSON.stringify(metadata));

    uploadMutation.mutate(fd);
  });

  return (
    <div className="max-w-3xl mx-auto py-8 px-4 sm:px-6 lg:px-8">
      {/* Progress */}
      <div className="flex items-center justify-center gap-4 mb-10">
        {(["File", "Type", "Details"] as const).map((label, i) => (
          <div key={label} className="flex items-center gap-2">
            <div className="flex flex-col items-center gap-1">
              <div className={cn(
                "w-9 h-9 rounded-full flex items-center justify-center text-sm font-bold transition-all",
                step > i + 1 ? "bg-emerald-500 text-white shadow-lg shadow-emerald-100" :
                step === i + 1 ? "bg-indigo-600 text-white ring-4 ring-indigo-50 shadow-lg" :
                "bg-slate-100 text-slate-400 border border-slate-200"
              )}>
                {i + 1}
              </div>
              <span className={cn("text-[11px] uppercase tracking-wider font-bold", step === i + 1 ? "text-indigo-600" : "text-slate-400")}>
                {label}
              </span>
            </div>
            {i < 2 && <div className={cn("h-px w-12 mb-4", step > i + 1 ? "bg-emerald-500" : "bg-slate-200")} />}
          </div>
        ))}
      </div>

      {/* ── Step 1: File drop ───────────────────────────────────────────────── */}
      {step === 1 && (
        <div className="bg-white rounded-2xl shadow-sm border border-slate-200 p-8">
          <h2 className="text-xl font-bold text-slate-900 mb-6 text-center">Upload your document</h2>
          <div
            {...getRootProps()}
            className={cn(
              "border-2 border-dashed rounded-xl p-12 text-center cursor-pointer transition-colors",
              isDragActive
                ? "border-indigo-500 bg-indigo-50"
                : "border-slate-200 hover:border-indigo-400 hover:bg-slate-50 bg-slate-50/50"
            )}
          >
            <input {...getInputProps()} />
            <UploadCloud className={cn("w-12 h-12 mx-auto mb-3", isDragActive ? "text-indigo-500" : "text-slate-400")} />
            <p className="text-slate-700 font-medium">
              {isDragActive ? "Drop the file here" : "Drag & drop a file here"}
            </p>
            <p className="text-slate-500 text-sm mt-1">or click to browse</p>
            <p className="text-slate-400 text-xs mt-3">
              Supports PDF, Word, Excel, and images
            </p>
          </div>
        </div>
      )}

      {/* ── Step 2: Document type selection ────────────────────────────────── */}
      {step === 2 && (
        <div className="bg-white rounded-2xl shadow-sm border border-slate-200 p-8">
          <h2 className="text-xl font-bold text-slate-900 mb-1">Select document type</h2>
          <p className="text-slate-500 text-sm mb-6">
            The type determines the metadata fields and approval workflow.
          </p>

          {/* Chosen file summary */}
          <div className="flex items-center gap-3 p-3 bg-slate-50 rounded-lg border border-slate-200 mb-5">
            <FileText className="w-5 h-5 text-slate-400 shrink-0" />
            <span className="text-sm text-slate-700 flex-1 truncate">{file?.name}</span>
            <span className="text-xs text-slate-500">{((file?.size ?? 0) / 1024).toFixed(0)} KB</span>
            <button onClick={() => { setFile(null); setStep(1); }}>
              <X className="w-4 h-4 text-slate-400 hover:text-slate-600" />
            </button>
          </div>

          <div className="grid grid-cols-2 gap-3">
            {(typesData ?? []).map((t) => (
              <button
                key={t.id}
                onClick={() => { setSelectedType(t); form.setValue("document_type_id", t.id); setStep(3); }}
                className={cn(
                  "text-left p-4 rounded-xl border transition-all hover:border-indigo-300 hover:bg-indigo-50/50",
                  selectedType?.id === t.id
                    ? "border-indigo-500 bg-indigo-50 ring-1 ring-indigo-500"
                    : "border-slate-200"
                )}
              >
                <p className="font-medium text-slate-900 text-sm">{t.name}</p>
                <p className="text-xs text-slate-500 mt-0.5">Prefix: {t.reference_prefix}-XXXXX</p>
                <p className="text-xs text-slate-400 mt-1">
                  {t.metadata_fields.length} custom field{t.metadata_fields.length !== 1 ? "s" : ""}
                </p>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* ── Step 3: Metadata form ───────────────────────────────────────────── */}
      {step === 3 && selectedType && (
        <form onSubmit={handleSubmit} className="space-y-6 bg-white rounded-2xl shadow-sm border border-slate-200 p-8">
          <div className="flex items-center justify-between mb-2">
            <h2 className="text-xl font-bold text-slate-900">Finalize details</h2>
            <span className="text-xs font-bold text-indigo-700 bg-indigo-50 border border-indigo-100 px-3 py-1 rounded-full">
              {selectedType.name}
            </span>
          </div>

          {/* Standard fields */}
          <Field label="Document title *" error={form.formState.errors.title?.message as string}>
            <input {...form.register("title")} placeholder="e.g. Acme Corp Invoice March 2024" className={inputCls} />
          </Field>

          <div className="grid grid-cols-2 gap-4">
            <Field label="Supplier / vendor">
              <input {...form.register("supplier")} placeholder="Company name" className={inputCls} />
            </Field>
            <Field label="Document date">
              <input {...form.register("document_date")} type="date" className={inputCls} />
            </Field>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <Field label="Amount">
              <input {...form.register("amount")} type="number" step="0.01" placeholder="0.00" className={inputCls} />
            </Field>
            <Field label="Currency">
              <select {...form.register("currency")} className={inputCls}>
                {CURRENCIES.map((c) => <option key={c}>{c}</option>)}
              </select>
            </Field>
          </div>

          <Field label="Due date">
            <input {...form.register("due_date")} type="date" className={inputCls} />
          </Field>

          {/* Dynamic metadata fields from document type */}
          {selectedType.metadata_fields.length > 0 && (
            <div className="border-t border-slate-200 pt-5">
              <p className="text-sm font-medium text-slate-700 mb-4">
                Additional fields for {selectedType.name}
              </p>
              <div className="space-y-4">
                {selectedType.metadata_fields.map((f) => (
                  <Field
                    key={f.id}
                    label={`${f.label}${f.is_required ? " *" : ""}`}
                    help={f.help_text}
                    error={form.formState.errors[`meta_${f.key}` as keyof typeof form.formState.errors]?.message as string}
                  >
                    {f.field_type === "select" ? (
                      <select {...form.register(`meta_${f.key}`)} className={inputCls}>
                        <option value="">Select…</option>
                        {f.select_options.map((o) => <option key={o}>{o}</option>)}
                      </select>
                    ) : f.field_type === "date" ? (
                      <input {...form.register(`meta_${f.key}`)} type="date" className={inputCls} />
                    ) : f.field_type === "boolean" ? (
                      <div className="flex gap-4">
                        <label className="flex items-center gap-2 text-sm">
                          <input {...form.register(`meta_${f.key}`)} type="radio" value="true" /> Yes
                        </label>
                        <label className="flex items-center gap-2 text-sm">
                          <input {...form.register(`meta_${f.key}`)} type="radio" value="false" /> No
                        </label>
                      </div>
                    ) : f.field_type === "textarea" ? (
                      <textarea {...form.register(`meta_${f.key}`)} rows={3} className={inputCls} />
                    ) : (
                      <input
                        {...form.register(`meta_${f.key}`)}
                        type={f.field_type === "number" || f.field_type === "currency" ? "number" : "text"}
                        className={inputCls}
                      />
                    )}
                  </Field>
                ))}
              </div>
            </div>
          )}

          {uploadMutation.isError && (
            <div className="bg-red-50 border border-red-200 text-red-700 text-sm rounded-lg px-4 py-3">
              Upload failed. Please check the form and try again.
            </div>
          )}

          <div className="flex gap-3 pt-2">
            <button
              type="button"
              onClick={() => setStep(2)}
              className="flex items-center gap-1.5 px-4 py-2 border border-slate-200 text-slate-600 text-sm rounded-lg hover:bg-slate-50"
            >
              <ChevronLeft className="w-4 h-4" /> Back
            </button>
            <button
              type="submit"
              disabled={uploadMutation.isPending}
              className="flex-1 flex items-center justify-center gap-2 py-2 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white text-sm font-medium rounded-lg transition-colors"
            >
              {uploadMutation.isPending ? (
                <><Loader2 className="w-4 h-4 animate-spin" /> Uploading…</>
              ) : (
                <><UploadCloud className="w-4 h-4" /> Upload document</>
              )}
            </button>
          </div>
        </form>
      )}
    </div>
  );
}

// ── Helpers ───────────────────────────────────────────────────────────────────
const inputCls =
  "w-full px-3 py-2 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent bg-white";

function Field({
  label, error, help, children,
}: {
  label: string; error?: string; help?: string; children: React.ReactNode;
}) {
  return (
    <div>
      <label className="block text-sm font-medium text-slate-700 mb-1">{label}</label>
      {children}
      {help && <p className="text-xs text-slate-400 mt-1">{help}</p>}
      {error && <p className="text-xs text-red-500 mt-1">{error}</p>}
    </div>
  );
}
