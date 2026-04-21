import { useState, useCallback, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { useDropzone } from "react-dropzone";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useForm, Controller } from "react-hook-form";
import { documentsAPI, documentTypesAPI } from "@/services/api";
import {
  Upload, File, X, Loader2, ArrowRight, CheckCircle,
  Lock, Users, Info, ScanLine,
} from "lucide-react";
import { toast } from "react-toastify";
import type { DocumentType, MetadataField } from "@/types";
import clsx from "clsx";

// ── Dynamic metadata field ────────────────────────────────────────────────────

function DynamicField({ field, register, control, errors, enforceRequired }: {
  field: MetadataField;
  register: ReturnType<typeof useForm>["register"];
  control: ReturnType<typeof useForm>["control"];
  errors: Record<string, { message?: string }>;
  enforceRequired: boolean;
}) {
  const rules = field.is_required && enforceRequired ? { required: `${field.label} is required` } : {};
  const requiredMark = field.is_required && enforceRequired
    ? <span className="text-destructive ml-1">*</span> : null;
  const optionalHint = field.is_required && !enforceRequired
    ? <span className="text-muted-foreground ml-1 text-xs">(optional)</span> : null;
  const errMsg = errors[`metadata.${field.key}`]?.message;

  if (field.field_type === "select") {
    return (
      <div>
        <label className="label">{field.label}{requiredMark}{optionalHint}</label>
        <Controller name={`metadata.${field.key}`} control={control} rules={rules}
          render={({ field: f }) => (
            <select {...f} className="input">
              <option value="">Select…</option>
              {field.select_options.map((opt) => <option key={opt} value={opt}>{opt}</option>)}
            </select>
          )} />
        {errMsg && <p className="text-destructive text-xs mt-1">{errMsg}</p>}
      </div>
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
        <label htmlFor={field.key} className="text-sm text-foreground">{field.label}</label>
      </div>
    );
  }
  if (field.field_type === "textarea") {
    return (
      <div>
        <label className="label">{field.label}{requiredMark}{optionalHint}</label>
        <textarea {...register(`metadata.${field.key}`, rules)} rows={3} className="input" />
        {errMsg && <p className="text-destructive text-xs mt-1">{errMsg}</p>}
      </div>
    );
  }
  const inputType = field.field_type === "date"
    ? "date"
    : (field.field_type === "number" || field.field_type === "currency") ? "number" : "text";
  return (
    <div>
      <label className="label">{field.label}{requiredMark}{optionalHint}</label>
      <input
        {...register(`metadata.${field.key}`, rules)}
        type={inputType}
        step={field.field_type === "currency" ? "0.01" : undefined}
        placeholder={field.default_value || field.help_text || ""}
        className="input"
      />
      {errMsg && <p className="text-destructive text-xs mt-1">{errMsg}</p>}
    </div>
  );
}

// ── Toggle ────────────────────────────────────────────────────────────────────

function ToggleSwitch({ checked, onChange, id, disabled = false, tone = "primary" }: {
  checked: boolean;
  onChange: (v: boolean) => void;
  id: string;
  disabled?: boolean;
  tone?: "primary" | "teal";
}) {
  return (
    <button
      type="button"
      id={id}
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => !disabled && onChange(!checked)}
      className={clsx(
        "relative inline-flex h-6 w-11 items-center rounded-full transition-colors",
        "focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
        "disabled:opacity-60 disabled:cursor-not-allowed",
        checked
          ? tone === "teal" ? "bg-teal" : "bg-primary"
          : "bg-muted-foreground/30",
      )}
    >
      <span
        className={clsx(
          "inline-block h-4 w-4 transform rounded-full bg-card shadow transition-transform",
          checked ? "translate-x-6" : "translate-x-1",
        )}
      />
    </button>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function UploadPage() {
  const navigate    = useNavigate();
  const queryClient = useQueryClient();
  const [droppedFile, setDroppedFile]           = useState<File | null>(null);
  const [selectedTypeId, setSelectedTypeId]     = useState("");
  const [uploadProgress, setUploadProgress]     = useState(0);
  const [isSelfUpload, setIsSelfUpload]         = useState(false);
  const [isScanned, setIsScanned]               = useState(false);
  const [imageAutoScanned, setImageAutoScanned] = useState(false);

  const { data: docTypes = [] } = useQuery<DocumentType[]>({
    queryKey: ["document-types"],
    queryFn: () => documentTypesAPI.list().then((r) => r.data.results ?? r.data),
  });
  const selectedType = docTypes?.find((t) => t.id === selectedTypeId);
  const { register, handleSubmit, control, reset, clearErrors, formState: { errors } } = useForm();

  // Reset metadata + file only when document type actually changes.
  useEffect(() => {
    if (selectedTypeId) {
      reset({ metadata: {} });
      setDroppedFile(null);
      setUploadProgress(0);
    }
  }, [selectedTypeId, reset]);

  // Just clear stale validation errors when the requirement mode flips.
  // Previously this called `reset(undefined, …)` which throws in some RHF
  // versions and was the root cause of the blank page on navigation.
  useEffect(() => {
    clearErrors();
  }, [isSelfUpload, isScanned, clearErrors]);

  const onDrop = useCallback((accepted: File[]) => {
    const file = accepted[0];
    if (!file) return;
    setDroppedFile(file);
    const isImage = file.type.startsWith("image/");
    if (isImage) { setIsScanned(true); setImageAutoScanned(true); }
    else { setImageAutoScanned(false); }
  }, []);

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop, maxFiles: 1,
    accept: {
      "application/pdf": [".pdf"],
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document": [".docx"],
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": [".xlsx"],
      "application/msword": [".doc"],
      "image/*": [".png", ".jpg", ".jpeg", ".tiff", ".bmp", ".webp"],
    },
  });

  const uploadMutation = useMutation({
    mutationFn: (fd: FormData) => documentsAPI.upload(fd, {
      onUploadProgress: (e: { loaded: number; total?: number }) => {
        if (e.total) setUploadProgress(Math.round((e.loaded * 100) / e.total));
      },
    }),
    onSuccess: ({ data }) => {
      const msg = isScanned ? "Queued for OCR" : isSelfUpload ? "Personal document saved" : "Document uploaded";
      toast.success(`${msg}: ${data.reference_number}`);
      queryClient.invalidateQueries({ queryKey: ["documents"] });
      navigate(`/documents/${data.id}`);
      setUploadProgress(0);
    },
    onError: () => { toast.error("Upload failed. Please try again."); setUploadProgress(0); },
  });

  const onSubmit = (values: Record<string, unknown>) => {
    if (!droppedFile) { toast.error("Please select a file"); return; }
    if (!selectedTypeId) { toast.error("Please select a document type"); return; }
    const fd = new FormData();
    fd.append("file", droppedFile);
    fd.append("title", values.title as string);
    fd.append("document_type_id", selectedTypeId);
    fd.append("is_self_upload", isSelfUpload ? "true" : "false");
    fd.append("is_scanned", isScanned ? "true" : "false");
    if (values.supplier) fd.append("supplier", values.supplier as string);
    if (values.amount) fd.append("amount", values.amount as string);
    if (values.currency) fd.append("currency", values.currency as string);
    if (values.document_date) fd.append("document_date", values.document_date as string);
    if (values.metadata && Object.keys(values.metadata as object).length > 0)
      fd.append("metadata", JSON.stringify(values.metadata));
    uploadMutation.mutate(fd);
  };

  const showForm    = Boolean(selectedTypeId);
  const hasMetadata = !!selectedType && selectedType.metadata_fields.length > 0;
  const relaxReq    = isSelfUpload || isScanned;

  return (
    <div className="max-w-6xl mx-auto py-8">
      {/* ── Header ──────────────────────────────────────────────────────── */}
      <div className="mb-8">
        <h1 className="text-3xl font-bold text-foreground tracking-tight">Upload New Document</h1>
        <p className="text-muted-foreground mt-2">Choose type → Fill details → Upload file</p>
      </div>

      {/* ── Workflow / Personal toggle ──────────────────────────────────── */}
      <div
        className={clsx(
          "mb-5 rounded-2xl border p-5 transition-colors",
          isSelfUpload ? "border-primary/30 bg-primary/5" : "border-border bg-card",
        )}
        style={{ boxShadow: "var(--shadow-card)" }}
      >
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-start gap-4">
            <div className={clsx(
              "mt-0.5 w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0",
              isSelfUpload ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground",
            )}>
              {isSelfUpload ? <Lock className="w-5 h-5" /> : <Users className="w-5 h-5" />}
            </div>
            <div>
              <div className="flex items-center gap-2 mb-1">
                <span className="font-semibold text-foreground">
                  {isSelfUpload ? "Personal Document" : "Workflow Document"}
                </span>
                {isSelfUpload && (
                  <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[11px] font-semibold bg-primary/15 text-primary border border-primary/30">
                    <span className="w-1.5 h-1.5 rounded-full bg-primary" /> Private
                  </span>
                )}
              </div>
              <p className="text-sm text-muted-foreground max-w-lg">
                {isSelfUpload
                  ? "For your records only. Not submitted for approval. Visible only to you and administrators."
                  : "Follows the approval workflow for its document type."}
              </p>
            </div>
          </div>
          <div className="flex flex-col items-end gap-1.5 flex-shrink-0">
            <label htmlFor="self-upload-toggle" className="text-xs font-medium text-muted-foreground cursor-pointer">
              Personal document
            </label>
            <ToggleSwitch id="self-upload-toggle" checked={isSelfUpload} onChange={setIsSelfUpload} />
          </div>
        </div>
        {isSelfUpload && (
          <div className="mt-4 flex items-start gap-2 text-xs text-primary bg-primary/10 border border-primary/20 rounded-lg px-3 py-2.5">
            <Info className="w-4 h-4 flex-shrink-0 mt-0.5" />
            <span>Required metadata fields are optional for personal documents.</span>
          </div>
        )}
      </div>

      {/* ── Scanned / OCR toggle ────────────────────────────────────────── */}
      <div
        className={clsx(
          "mb-8 rounded-2xl border p-5 transition-colors",
          isScanned ? "border-teal/30 bg-teal/5" : "border-border bg-card",
        )}
        style={{ boxShadow: "var(--shadow-card)" }}
      >
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-start gap-4">
            <div className={clsx(
              "mt-0.5 w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0",
              isScanned ? "bg-teal text-teal-foreground" : "bg-muted text-muted-foreground",
            )}>
              <ScanLine className="w-5 h-5" />
            </div>
            <div>
              <div className="flex items-center gap-2 mb-1">
                <span className="font-semibold text-foreground">
                  {isScanned ? "Scanned Document" : "Digital Document"}
                </span>
                {isScanned && (
                  <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[11px] font-semibold bg-teal/15 text-teal border border-teal/30">
                    <span className="w-1.5 h-1.5 rounded-full bg-teal" /> OCR enabled
                  </span>
                )}
                {imageAutoScanned && (
                  <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium bg-muted text-muted-foreground border border-border">
                    Auto-detected
                  </span>
                )}
              </div>
              <p className="text-sm text-muted-foreground max-w-lg">
                {isScanned
                  ? "Text will be extracted via OCR so this document is fully searchable."
                  : "Enable for scanned paper documents, photos, or image files."}
              </p>
            </div>
          </div>
          <div className="flex flex-col items-end gap-1.5 flex-shrink-0">
            <label htmlFor="scan-toggle" className="text-xs font-medium text-muted-foreground cursor-pointer">
              Scanned / image doc
            </label>
            <ToggleSwitch
              id="scan-toggle"
              checked={isScanned}
              onChange={setIsScanned}
              disabled={imageAutoScanned}
              tone="teal"
            />
          </div>
        </div>
        {isScanned && (
          <div className="mt-4 flex items-start gap-2 text-xs text-teal bg-teal/10 border border-teal/20 rounded-lg px-3 py-2.5">
            <ScanLine className="w-4 h-4 flex-shrink-0 mt-0.5" />
            <span>
              OCR runs in the background after upload. The document is immediately accessible;
              searchable text appears within seconds. Required metadata is optional until OCR completes.
            </span>
          </div>
        )}
      </div>

      {/* ── Step layout ─────────────────────────────────────────────────── */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-8">
        {/* Step 1 */}
        <div className="lg:col-span-4">
          <div
            className="bg-card rounded-2xl border border-border p-6 sticky top-6"
            style={{ boxShadow: "var(--shadow-card)" }}
          >
            <div className="flex items-center gap-2.5 mb-4">
              <div className="w-7 h-7 rounded-full bg-primary text-primary-foreground flex items-center justify-center text-sm font-bold">
                1
              </div>
              <h2 className="text-lg font-semibold text-foreground">Select Document Type</h2>
            </div>
            <select
              value={selectedTypeId}
              onChange={(e) => setSelectedTypeId(e.target.value)}
              className="input w-full"
              required
            >
              <option value="">— Choose document type —</option>
              {docTypes.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
            {selectedType && (
              <div className="mt-6 p-4 bg-muted/50 border border-border rounded-lg text-sm">
                <p className="font-semibold text-foreground mb-1">About this type</p>
                <p className="text-muted-foreground">{selectedType.description || "No description available."}</p>
              </div>
            )}
          </div>
        </div>

        {/* Step 2 */}
        <div className="lg:col-span-8">
          <div
            className={clsx(
              "bg-card rounded-2xl border p-8 transition-colors",
              isScanned ? "border-teal/30 ring-1 ring-teal/20"
                : isSelfUpload ? "border-primary/30 ring-1 ring-primary/20"
                : "border-border",
            )}
            style={{ boxShadow: "var(--shadow-card)" }}
          >
            <div className="flex items-center gap-2.5 mb-6">
              <div className="w-7 h-7 rounded-full bg-primary text-primary-foreground flex items-center justify-center text-sm font-bold">
                2
              </div>
              <h2 className="text-xl font-semibold text-foreground">Fill Details &amp; Upload</h2>
              {isScanned && (
                <span className="ml-auto inline-flex items-center gap-1 text-xs font-semibold text-teal">
                  <ScanLine className="w-3.5 h-3.5" /> OCR
                </span>
              )}
              {!isScanned && isSelfUpload && (
                <span className="ml-auto inline-flex items-center gap-1 text-xs font-semibold text-primary">
                  <Lock className="w-3.5 h-3.5" /> Personal
                </span>
              )}
            </div>

            {/* Metadata */}
            {showForm && hasMetadata && (
              <div className="mb-10">
                <h3 className="font-semibold text-foreground mb-5 flex items-center gap-2">
                  <CheckCircle className="w-5 h-5 text-teal" /> Additional Information
                </h3>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                  {[...selectedType!.metadata_fields].sort((a, b) => a.order - b.order).map((field) => (
                    <DynamicField
                      key={field.id}
                      field={field}
                      register={register}
                      control={control}
                      errors={errors as Record<string, { message?: string }>}
                      enforceRequired={!relaxReq}
                    />
                  ))}
                </div>
              </div>
            )}

            {/* Basic */}
            {showForm && (
              <div className="mb-10">
                <h3 className="font-semibold text-foreground mb-4">Basic Information</h3>
                <div className="space-y-6">
                  <div>
                    <label className="label">Document Title <span className="text-destructive">*</span></label>
                    <input
                      {...register("title", { required: "Title is required" })}
                      className="input"
                      placeholder="e.g. Acme Corp Invoice March 2026"
                    />
                    {errors.title && (
                      <p className="text-destructive text-xs mt-1">{String(errors.title.message)}</p>
                    )}
                  </div>
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
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                    <div className="md:col-span-2">
                      <label className="label">Amount</label>
                      <input {...register("amount")} type="number" step="0.01" className="input" placeholder="0.00" />
                    </div>
                    <div>
                      <label className="label">Currency</label>
                      <select {...register("currency")} className="input">
                        <option value="USD">USD</option><option value="EUR">EUR</option>
                        <option value="GBP">GBP</option><option value="KES">KES</option>
                      </select>
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* File */}
            {showForm && (
              <div className="mb-8">
                <h3 className="font-semibold text-foreground mb-4 flex items-center gap-2">
                  <CheckCircle className="w-5 h-5 text-teal" /> 3. Attach File
                </h3>
                <div
                  {...getRootProps()}
                  className={clsx(
                    "border-2 border-dashed rounded-2xl p-12 text-center cursor-pointer transition-all",
                    isDragActive
                      ? "border-primary bg-primary/5"
                      : droppedFile
                        ? "border-teal/50 bg-teal/5"
                        : "border-border hover:border-primary/50 hover:bg-muted/40",
                  )}
                >
                  <input {...getInputProps()} />
                  {droppedFile ? (
                    <div className="flex flex-col items-center">
                      <div className="w-12 h-12 rounded-xl bg-teal/15 flex items-center justify-center mb-3">
                        <File className="w-6 h-6 text-teal" />
                      </div>
                      <p className="font-semibold text-foreground">{droppedFile.name}</p>
                      <p className="text-sm text-muted-foreground mt-1">
                        {(droppedFile.size / (1024 * 1024)).toFixed(2)} MB
                      </p>
                      {imageAutoScanned && (
                        <span className="mt-2 inline-flex items-center gap-1.5 text-xs text-teal bg-teal/10 border border-teal/30 px-2 py-0.5 rounded-full">
                          <span className="w-1.5 h-1.5 rounded-full bg-teal" />
                          Image file — OCR will run automatically
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
                        className="mt-4 text-destructive hover:text-destructive/80 text-sm flex items-center gap-1"
                      >
                        <X className="w-4 h-4" /> Remove file
                      </button>
                    </div>
                  ) : (
                    <>
                      <div className="w-14 h-14 rounded-2xl bg-muted text-muted-foreground mx-auto mb-4 flex items-center justify-center">
                        <Upload className="w-7 h-7" />
                      </div>
                      <p className="text-lg font-semibold text-foreground">
                        {isDragActive ? "Drop the file here" : "Drag & drop your document"}
                      </p>
                      <p className="text-muted-foreground mt-1">or click to browse</p>
                      <p className="text-xs text-muted-foreground/80 mt-4">
                        PDF, DOCX, XLSX, DOC · Images (PNG, JPG, TIFF, WebP)
                      </p>
                    </>
                  )}
                </div>
              </div>
            )}

            {/* Progress */}
            {uploadMutation.isPending && uploadProgress > 0 && (
              <div className="mb-6">
                <div className="flex justify-between text-xs text-muted-foreground mb-1.5">
                  <span>
                    {isScanned ? "Uploading for OCR…"
                      : isSelfUpload ? "Saving personal document…"
                      : "Uploading…"}
                  </span>
                  <span className="font-semibold text-foreground">{uploadProgress}%</span>
                </div>
                <div className="h-2.5 bg-muted rounded-full overflow-hidden">
                  <div
                    className={clsx(
                      "h-full transition-all duration-300 ease-out",
                      isScanned ? "bg-teal" : "bg-primary",
                    )}
                    style={{ width: `${uploadProgress}%` }}
                  />
                </div>
              </div>
            )}

            {/* Actions */}
            {showForm && (
              <div className="flex gap-4 pt-6 border-t border-border">
                <button
                  type="button"
                  onClick={handleSubmit(onSubmit)}
                  disabled={uploadMutation.isPending || !droppedFile}
                  className={clsx(
                    "flex-1 flex items-center justify-center gap-2 text-base py-3 rounded-xl font-semibold transition-all",
                    "disabled:opacity-50 disabled:cursor-not-allowed",
                    isScanned
                      ? "bg-teal text-teal-foreground hover:bg-teal/90"
                      : isSelfUpload
                        ? "bg-primary text-primary-foreground hover:bg-primary/90"
                        : "bg-primary text-primary-foreground hover:bg-primary/90",
                  )}
                  style={{ boxShadow: "var(--shadow-elegant)" }}
                >
                  {uploadMutation.isPending
                    ? <Loader2 className="w-5 h-5 animate-spin" />
                    : isScanned ? <ScanLine className="w-4 h-4" />
                    : isSelfUpload ? <Lock className="w-4 h-4" />
                    : <Upload className="w-4 h-4" />}
                  {!uploadMutation.isPending &&
                    (isScanned ? "Upload & Run OCR"
                      : isSelfUpload ? "Save Personal Document"
                      : "Upload Document")}
                  {!uploadMutation.isPending && <ArrowRight className="w-4 h-4" />}
                </button>
                <button
                  type="button"
                  onClick={() => navigate("/documents")}
                  className="px-8 py-3 rounded-xl font-semibold border border-border bg-card text-foreground hover:bg-muted transition-colors"
                >
                  Cancel
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
