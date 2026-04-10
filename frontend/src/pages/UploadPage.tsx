import { useState, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { useDropzone } from "react-dropzone";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useForm, Controller } from "react-hook-form";
import { documentsAPI, documentTypesAPI } from "@/services/api";
import { Upload, File, X, Loader2, ChevronDown } from "lucide-react";
import { toast } from "react-toastify";
import type { DocumentType, MetadataField } from "@/types";

function DynamicField({ field, register, control, errors }: {
  field: MetadataField;
  register: ReturnType<typeof useForm>["register"];
  control: ReturnType<typeof useForm>["control"];
  errors: Record<string, { message?: string }>;
}) {
  const rules = field.is_required ? { required: `${field.label} is required` } : {};

  if (field.field_type === "select") {
    return (
      <div>
        <label className="label">{field.label}{field.is_required && <span className="text-red-500 ml-1">*</span>}</label>
        <Controller
          name={`metadata.${field.key}`}
          control={control}
          rules={rules}
          render={({ field: f }) => (
            <select {...f} className="input">
              <option value="">Select…</option>
              {field.select_options.map((opt) => (
                <option key={opt} value={opt}>{opt}</option>
              ))}
            </select>
          )}
        />
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
          className="w-4 h-4 rounded border-gray-300 text-brand-600"
        />
        <label htmlFor={field.key} className="text-sm text-gray-700">{field.label}</label>
      </div>
    );
  }
  if (field.field_type === "textarea") {
    return (
      <div>
        <label className="label">{field.label}{field.is_required && <span className="text-red-500 ml-1">*</span>}</label>
        <textarea {...register(`metadata.${field.key}`, rules)} rows={3} className="input" />
      </div>
    );
  }

  const inputType = field.field_type === "date" ? "date"
    : field.field_type === "number" || field.field_type === "currency" ? "number"
    : "text";

  return (
    <div>
      <label className="label">
        {field.label}{field.is_required && <span className="text-red-500 ml-1">*</span>}
      </label>
      <input
        {...register(`metadata.${field.key}`, rules)}
        type={inputType}
        step={field.field_type === "currency" ? "0.01" : undefined}
        placeholder={field.default_value || field.help_text || ""}
        className="input"
      />
      {errors[`metadata.${field.key}`] && (
        <p className="text-red-500 text-xs mt-1">{errors[`metadata.${field.key}`]?.message}</p>
      )}
    </div>
  );
}

export default function UploadPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [droppedFile, setDroppedFile] = useState<File | null>(null);
  const [selectedTypeId, setSelectedTypeId] = useState("");

  const { data: docTypes } = useQuery({
    queryKey: ["document-types"],
    queryFn: () => documentTypesAPI.list().then((r) => r.data.results as DocumentType[]),
  });

  const selectedType = docTypes?.find((t) => t.id === selectedTypeId);

  const {
    register, handleSubmit, control, reset,
    formState: { errors },
  } = useForm();

  const onDrop = useCallback((accepted: File[]) => {
    if (accepted[0]) setDroppedFile(accepted[0]);
  }, []);

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    maxFiles: 1,
    accept: {
      "application/pdf": [".pdf"],
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document": [".docx"],
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": [".xlsx"],
      "application/msword": [".doc"],
      "image/*": [".png", ".jpg", ".jpeg"],
    },
  });

  const uploadMutation = useMutation({
    mutationFn: (formData: FormData) => documentsAPI.upload(formData),
    onSuccess: ({ data }) => {
      toast.success(`Document uploaded: ${data.reference_number}`);
      queryClient.invalidateQueries({ queryKey: ["documents"] });
      navigate(`/documents/${data.id}`);
    },
    onError: () => toast.error("Upload failed. Please check the form and try again."),
  });

  const onSubmit = (values: Record<string, unknown>) => {
    if (!droppedFile) {
      toast.error("Please select a file to upload");
      return;
    }
    const fd = new FormData();
    fd.append("file", droppedFile);
    fd.append("title", values.title as string);
    fd.append("document_type_id", selectedTypeId);
    if (values.supplier) fd.append("supplier", values.supplier as string);
    if (values.amount) fd.append("amount", values.amount as string);
    if (values.currency) fd.append("currency", values.currency as string);
    if (values.document_date) fd.append("document_date", values.document_date as string);
    if (values.metadata) fd.append("metadata", JSON.stringify(values.metadata));
    uploadMutation.mutate(fd);
  };

  return (
    <div className="max-w-2xl mx-auto space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Upload document</h1>
        <p className="text-gray-500 text-sm mt-1">
          Fill in the document details and attach your file.
        </p>
      </div>

      <form onSubmit={handleSubmit(onSubmit)} className="space-y-5">
        {/* File drop zone */}
        <div
          {...getRootProps()}
          className={`border-2 border-dashed rounded-xl p-8 text-center cursor-pointer transition-colors ${
            isDragActive
              ? "border-brand-500 bg-brand-50"
              : droppedFile
              ? "border-green-400 bg-green-50"
              : "border-gray-300 hover:border-brand-400 hover:bg-gray-50"
          }`}
        >
          <input {...getInputProps()} />
          {droppedFile ? (
            <div className="flex items-center justify-center gap-3">
              <File className="w-8 h-8 text-green-500" />
              <div className="text-left">
                <p className="font-medium text-gray-900">{droppedFile.name}</p>
                <p className="text-sm text-gray-500">
                  {(droppedFile.size / 1024 / 1024).toFixed(2)} MB
                </p>
              </div>
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); setDroppedFile(null); }}
                className="ml-auto text-gray-400 hover:text-gray-600"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
          ) : (
            <>
              <Upload className="w-10 h-10 text-gray-400 mx-auto mb-3" />
              <p className="text-sm font-medium text-gray-700">
                {isDragActive ? "Drop the file here" : "Drag & drop or click to browse"}
              </p>
              <p className="text-xs text-gray-400 mt-1">PDF, DOCX, XLSX, DOC, PNG, JPG</p>
            </>
          )}
        </div>

        {/* Document type selector */}
        <div>
          <label className="label">Document type <span className="text-red-500">*</span></label>
          <select
            value={selectedTypeId}
            onChange={(e) => { setSelectedTypeId(e.target.value); reset(); }}
            className="input"
            required
          >
            <option value="">Select document type…</option>
            {docTypes?.map((t) => (
              <option key={t.id} value={t.id}>{t.name}</option>
            ))}
          </select>
        </div>

        {selectedTypeId && (
          <>
            {/* Core fields */}
            <div>
              <label className="label">Title <span className="text-red-500">*</span></label>
              <input
                {...register("title", { required: "Title is required" })}
                className="input"
                placeholder="e.g. Acme Corp Invoice – March 2024"
              />
              {errors.title && (
                <p className="text-red-500 text-xs mt-1">{errors.title.message as string}</p>
              )}
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="label">Supplier</label>
                <input {...register("supplier")} className="input" placeholder="Supplier name" />
              </div>
              <div>
                <label className="label">Document date</label>
                <input {...register("document_date")} type="date" className="input" />
              </div>
            </div>

            <div className="grid grid-cols-3 gap-4">
              <div className="col-span-2">
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
                  <option value="USD">USD</option>
                  <option value="EUR">EUR</option>
                  <option value="GBP">GBP</option>
                  <option value="KES">KES</option>
                </select>
              </div>
            </div>

            {/* Dynamic metadata fields for this document type */}
            {selectedType?.metadata_fields?.length ? (
              <div className="card p-5 space-y-4">
                <h3 className="font-medium text-gray-900 text-sm">
                  {selectedType.name} — additional fields
                </h3>
                {[...selectedType.metadata_fields]
                  .sort((a, b) => a.order - b.order)
                  .map((field) => (
                    <DynamicField
                      key={field.id}
                      field={field}
                      register={register}
                      control={control}
                      errors={errors as Record<string, { message?: string }>}
                    />
                  ))}
              </div>
            ) : null}

            <div className="flex gap-3 pt-2">
              <button
                type="submit"
                disabled={uploadMutation.isPending}
                className="btn-primary"
              >
                {uploadMutation.isPending && <Loader2 className="w-4 h-4 animate-spin" />}
                Upload document
              </button>
              <button
                type="button"
                onClick={() => navigate("/documents")}
                className="btn-secondary"
              >
                Cancel
              </button>
            </div>
          </>
        )}
      </form>
    </div>
  );
}
