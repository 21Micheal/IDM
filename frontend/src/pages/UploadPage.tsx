/**
 * pages/UploadPage.tsx
 *
 * Changes from previous version
 * ──────────────────────────────
 * 1. "Scanned document" toggle (independent from Personal mode).
 *    - Sets is_scanned=true in FormData.
 *    - OCR info strip explains background processing.
 *    - Relaxes required-metadata enforcement (user may not have details ready).
 *    - Images dropped auto-enable + lock the toggle.
 *    - Submit label changes to "Upload & Run OCR".
 *
 * 2. Auto-detect image drop: image/* files auto-set isScanned=true + lock toggle.
 *
 * 3. Remove-file clears the auto-scan lock.
 */
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

function DynamicField({ field, register, control, errors, enforceRequired }: {
  field: MetadataField;
  register: ReturnType<typeof useForm>["register"];
  control: ReturnType<typeof useForm>["control"];
  errors: Record<string, { message?: string }>;
  enforceRequired: boolean;
}) {
  const rules = field.is_required && enforceRequired ? { required: `${field.label} is required` } : {};
  const optionalHint = field.is_required && !enforceRequired
    ? <span className="text-gray-400 ml-1 text-xs">(optional)</span> : null;

  if (field.field_type === "select") {
    return (
      <div>
        <label className="label">{field.label}{field.is_required && enforceRequired && <span className="text-red-500 ml-1">*</span>}{optionalHint}</label>
        <Controller name={`metadata.${field.key}`} control={control} rules={rules}
          render={({ field: f }) => (
            <select {...f} className="input">
              <option value="">Select…</option>
              {field.select_options.map((opt) => <option key={opt} value={opt}>{opt}</option>)}
            </select>
          )} />
        {errors[`metadata.${field.key}`] && <p className="text-red-500 text-xs mt-1">{errors[`metadata.${field.key}`]?.message}</p>}
      </div>
    );
  }
  if (field.field_type === "boolean") {
    return (
      <div className="flex items-center gap-2">
        <input {...register(`metadata.${field.key}`)} type="checkbox" id={field.key} className="w-4 h-4 rounded border-gray-300 text-brand-600" />
        <label htmlFor={field.key} className="text-sm text-gray-700">{field.label}</label>
      </div>
    );
  }
  if (field.field_type === "textarea") {
    return (
      <div>
        <label className="label">{field.label}{field.is_required && enforceRequired && <span className="text-red-500 ml-1">*</span>}{optionalHint}</label>
        <textarea {...register(`metadata.${field.key}`, rules)} rows={3} className="input" />
        {errors[`metadata.${field.key}`] && <p className="text-red-500 text-xs mt-1">{errors[`metadata.${field.key}`]?.message}</p>}
      </div>
    );
  }
  const inputType = field.field_type === "date" ? "date" : (field.field_type === "number" || field.field_type === "currency") ? "number" : "text";
  return (
    <div>
      <label className="label">{field.label}{field.is_required && enforceRequired && <span className="text-red-500 ml-1">*</span>}{optionalHint}</label>
      <input {...register(`metadata.${field.key}`, rules)} type={inputType} step={field.field_type === "currency" ? "0.01" : undefined}
        placeholder={field.default_value || field.help_text || ""} className="input" />
      {errors[`metadata.${field.key}`] && <p className="text-red-500 text-xs mt-1">{errors[`metadata.${field.key}`]?.message}</p>}
    </div>
  );
}

function ToggleSwitch({ checked, onChange, id, disabled = false }: {
  checked: boolean; onChange: (v: boolean) => void; id: string; disabled?: boolean;
}) {
  return (
    <button type="button" id={id} role="switch" aria-checked={checked} disabled={disabled}
      onClick={() => !disabled && onChange(!checked)}
      className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2 disabled:opacity-60 disabled:cursor-not-allowed ${checked ? "bg-brand-600" : "bg-gray-300"}`}>
      <span className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${checked ? "translate-x-6" : "translate-x-1"}`} />
    </button>
  );
}

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
  const selectedType = docTypes.find((t) => t.id === selectedTypeId);
  const { register, handleSubmit, control, reset, formState: { errors } } = useForm();

  useEffect(() => {
    if (selectedTypeId) { reset({ metadata: {} }); setDroppedFile(null); setUploadProgress(0); }
  }, [selectedTypeId, reset]);
  useEffect(() => { reset(undefined, { keepValues: true, keepErrors: false }); }, [isSelfUpload, isScanned, reset]);

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
      onUploadProgress: (e: any) => { if (e.total) setUploadProgress(Math.round((e.loaded * 100) / e.total)); },
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
  const hasMetadata = selectedType && selectedType.metadata_fields.length > 0;
  const relaxReq    = isSelfUpload || isScanned;

  return (
    <div className="max-w-6xl mx-auto py-8">
      <div className="mb-10">
        <h1 className="text-3xl font-bold text-gray-900">Upload New Document</h1>
        <p className="text-gray-500 mt-2">Choose type → Fill details → Upload file</p>
      </div>

      {/* Workflow / Personal toggle */}
      <div className={`mb-5 rounded-2xl border-2 p-5 transition-colors ${isSelfUpload ? "border-brand-200 bg-brand-50" : "border-gray-200 bg-white"}`}>
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-start gap-4">
            <div className={`mt-0.5 w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0 ${isSelfUpload ? "bg-brand-100" : "bg-gray-100"}`}>
              {isSelfUpload ? <Lock className="w-5 h-5 text-brand-600" /> : <Users className="w-5 h-5 text-gray-500" />}
            </div>
            <div>
              <div className="flex items-center gap-2 mb-1">
                <span className="font-semibold text-gray-900">{isSelfUpload ? "Personal Document" : "Workflow Document"}</span>
                {isSelfUpload && <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-brand-100 text-brand-700">Private</span>}
              </div>
              <p className="text-sm text-gray-600 max-w-lg">
                {isSelfUpload ? "For your records only. Not submitted for approval. Visible only to you and administrators."
                  : "Follows the approval workflow for its document type."}
              </p>
            </div>
          </div>
          <div className="flex flex-col items-end gap-1.5 flex-shrink-0">
            <label htmlFor="self-upload-toggle" className="text-xs font-medium text-gray-500 cursor-pointer">Personal document</label>
            <ToggleSwitch id="self-upload-toggle" checked={isSelfUpload} onChange={setIsSelfUpload} />
          </div>
        </div>
        {isSelfUpload && (
          <div className="mt-4 flex items-start gap-2 text-xs text-brand-700 bg-brand-100 rounded-lg px-3 py-2.5">
            <Info className="w-4 h-4 flex-shrink-0 mt-0.5" />
            <span>Required metadata fields are optional for personal documents.</span>
          </div>
        )}
      </div>

      {/* Scanned / OCR toggle */}
      <div className={`mb-8 rounded-2xl border-2 p-5 transition-colors ${isScanned ? "border-teal-200 bg-teal-50" : "border-gray-200 bg-white"}`}>
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-start gap-4">
            <div className={`mt-0.5 w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0 ${isScanned ? "bg-teal-100" : "bg-gray-100"}`}>
              <ScanLine className={`w-5 h-5 ${isScanned ? "text-teal-600" : "text-gray-500"}`} />
            </div>
            <div>
              <div className="flex items-center gap-2 mb-1">
                <span className="font-semibold text-gray-900">{isScanned ? "Scanned Document" : "Digital Document"}</span>
                {isScanned && <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-teal-100 text-teal-700">OCR enabled</span>}
                {imageAutoScanned && <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-gray-100 text-gray-500">Auto-detected</span>}
              </div>
              <p className="text-sm text-gray-600 max-w-lg">
                {isScanned ? "Text will be extracted via OCR so this document is fully searchable."
                  : "Enable for scanned paper documents, photos, or image files."}
              </p>
            </div>
          </div>
          <div className="flex flex-col items-end gap-1.5 flex-shrink-0">
            <label htmlFor="scan-toggle" className="text-xs font-medium text-gray-500 cursor-pointer">Scanned / image doc</label>
            <ToggleSwitch id="scan-toggle" checked={isScanned} onChange={setIsScanned} disabled={imageAutoScanned} />
          </div>
        </div>
        {isScanned && (
          <div className="mt-4 flex items-start gap-2 text-xs text-teal-700 bg-teal-100 rounded-lg px-3 py-2.5">
            <ScanLine className="w-4 h-4 flex-shrink-0 mt-0.5" />
            <span>
              OCR runs in the background after upload. The document is immediately accessible;
              searchable text appears within seconds. Required metadata is optional until OCR completes.
            </span>
          </div>
        )}
      </div>

      {/* Step layout */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-8">
        <div className="lg:col-span-4">
          <div className="card p-6 sticky top-6">
            <div className="flex items-center gap-2 mb-4">
              <div className="w-6 h-6 rounded-full bg-brand-100 flex items-center justify-center">
                <span className="text-brand-600 text-sm font-semibold">1</span>
              </div>
              <h2 className="text-lg font-semibold text-gray-900">Select Document Type</h2>
            </div>
            <select value={selectedTypeId} onChange={(e) => setSelectedTypeId(e.target.value)} className="input w-full" required>
              <option value="">— Choose document type —</option>
              {docTypes.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
            {selectedType && (
              <div className="mt-6 p-4 bg-gray-50 rounded-lg text-sm">
                <p className="font-medium text-gray-900 mb-1">About this type</p>
                <p className="text-gray-600">{selectedType.description || "No description available."}</p>
              </div>
            )}
          </div>
        </div>

        <div className="lg:col-span-8">
          <div className={`card p-8 transition-colors ${isScanned ? "ring-2 ring-teal-200" : isSelfUpload ? "ring-2 ring-brand-200" : ""}`}>
            <div className="flex items-center gap-2 mb-6">
              <div className="w-6 h-6 rounded-full bg-brand-100 flex items-center justify-center">
                <span className="text-brand-600 text-sm font-semibold">2</span>
              </div>
              <h2 className="text-xl font-semibold text-gray-900">Fill Details &amp; Upload</h2>
              {isScanned && <span className="ml-auto inline-flex items-center gap-1 text-xs font-medium text-teal-600"><ScanLine className="w-3.5 h-3.5" /> OCR</span>}
              {!isScanned && isSelfUpload && <span className="ml-auto inline-flex items-center gap-1 text-xs font-medium text-brand-600"><Lock className="w-3.5 h-3.5" /> Personal</span>}
            </div>

            {showForm && hasMetadata && (
              <div className="mb-10">
                <h3 className="font-medium text-gray-900 mb-5 flex items-center gap-2">
                  <CheckCircle className="w-5 h-5 text-green-500" /> Additional Information
                </h3>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                  {[...selectedType!.metadata_fields].sort((a, b) => a.order - b.order).map((field) => (
                    <DynamicField key={field.id} field={field} register={register} control={control}
                      errors={errors as Record<string, { message?: string }>} enforceRequired={!relaxReq} />
                  ))}
                </div>
              </div>
            )}

            {showForm && (
              <div className="mb-10">
                <h3 className="font-medium text-gray-900 mb-4">Basic Information</h3>
                <div className="space-y-6">
                  <div>
                    <label className="label">Document Title <span className="text-red-500">*</span></label>
                    <input {...register("title", { required: "Title is required" })} className="input" placeholder="e.g. Acme Corp Invoice March 2026" />
                    {errors.title && <p className="text-red-500 text-xs mt-1">{String(errors.title.message)}</p>}
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

            {showForm && (
              <div className="mb-8">
                <h3 className="font-medium text-gray-900 mb-4 flex items-center gap-2">
                  <CheckCircle className="w-5 h-5 text-green-500" /> 3. Attach File
                </h3>
                <div {...getRootProps()} className={`border-2 border-dashed rounded-2xl p-12 text-center cursor-pointer transition-all ${
                  isDragActive ? "border-brand-500 bg-brand-50" : droppedFile ? "border-green-400 bg-green-50" : "border-gray-300 hover:border-brand-400 hover:bg-gray-50"
                }`}>
                  <input {...getInputProps()} />
                  {droppedFile ? (
                    <div className="flex flex-col items-center">
                      <File className="w-12 h-12 text-green-500 mb-3" />
                      <p className="font-medium text-gray-900">{droppedFile.name}</p>
                      <p className="text-sm text-gray-500 mt-1">{(droppedFile.size / (1024 * 1024)).toFixed(2)} MB</p>
                      {imageAutoScanned && (
                        <span className="mt-2 text-xs text-teal-600 bg-teal-50 px-2 py-0.5 rounded-full">
                          Image file — OCR will run automatically
                        </span>
                      )}
                      <button type="button" onClick={(e) => { e.stopPropagation(); setDroppedFile(null); setImageAutoScanned(false); if (!isScanned || imageAutoScanned) setIsScanned(false); }}
                        className="mt-4 text-red-500 hover:text-red-600 text-sm flex items-center gap-1">
                        <X className="w-4 h-4" /> Remove file
                      </button>
                    </div>
                  ) : (
                    <>
                      <Upload className="w-12 h-12 text-gray-400 mx-auto mb-4" />
                      <p className="text-lg font-medium text-gray-700">{isDragActive ? "Drop the file here" : "Drag & drop your document"}</p>
                      <p className="text-gray-500 mt-1">or click to browse</p>
                      <p className="text-xs text-gray-400 mt-4">PDF, DOCX, XLSX, DOC · Images (PNG, JPG, TIFF, WebP)</p>
                    </>
                  )}
                </div>
              </div>
            )}

            {uploadMutation.isPending && uploadProgress > 0 && (
              <div className="mb-6">
                <div className="flex justify-between text-xs text-gray-500 mb-1.5">
                  <span>{isScanned ? "Uploading for OCR…" : isSelfUpload ? "Saving personal document…" : "Uploading…"}</span>
                  <span>{uploadProgress}%</span>
                </div>
                <div className="h-2.5 bg-gray-100 rounded-full overflow-hidden">
                  <div className="h-full bg-brand-600 transition-all duration-300 ease-out" style={{ width: `${uploadProgress}%` }} />
                </div>
              </div>
            )}

            {showForm && (
              <div className="flex gap-4 pt-6 border-t border-gray-100">
                <button type="button" onClick={handleSubmit(onSubmit)}
                  disabled={uploadMutation.isPending || !droppedFile}
                  className={`flex-1 flex items-center justify-center gap-2 text-base py-3 rounded-xl font-semibold transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${
                    isScanned ? "bg-teal-600 hover:bg-teal-700 text-white" : isSelfUpload ? "bg-brand-600 hover:bg-brand-700 text-white" : "btn-primary"
                  }`}>
                  {uploadMutation.isPending ? <Loader2 className="w-5 h-5 animate-spin" />
                    : isScanned ? <ScanLine className="w-4 h-4" /> : isSelfUpload ? <Lock className="w-4 h-4" /> : <Upload className="w-4 h-4" />}
                  {!uploadMutation.isPending && (isScanned ? "Upload & Run OCR" : isSelfUpload ? "Save Personal Document" : "Upload Document")}
                  {!uploadMutation.isPending && <ArrowRight className="w-4 h-4" />}
                </button>
                <button type="button" onClick={() => navigate("/documents")} className="btn-secondary px-8 py-3">Cancel</button>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}