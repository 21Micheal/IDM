/**
 * MetadataEditPanel.tsx
 *
 * Shown on DocumentDetailPage when document is in draft or rejected state.
 * Allows editing title, supplier, amount, dates, and dynamic metadata fields
 * without touching the file, reference, or document type.
 */
import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useForm, Controller } from "react-hook-form";
import { documentsAPI } from "@/services/api";
import { Edit2, Save, X, Loader2 } from "lucide-react";
import { toast } from "react-toastify";
import type { Document, MetadataField } from "@/types";

interface Props {
  document: Document;
  onClose: () => void;
}

function DynamicField({
  field,
  register,
  control,
}: {
  field: MetadataField;
  register: ReturnType<typeof useForm>["register"];
  control: ReturnType<typeof useForm>["control"];
}) {
  const rules = field.is_required ? { required: `${field.label} is required` } : {};

  if (field.field_type === "select") {
    return (
      <div>
        <label className="label">
          {field.label}{field.is_required && <span className="text-red-500 ml-1">*</span>}
        </label>
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
      <div className="flex items-center gap-2 pt-5">
        <input
          {...register(`metadata.${field.key}`)}
          type="checkbox"
          id={`meta-${field.key}`}
          className="w-4 h-4 rounded border-gray-300 text-brand-600"
        />
        <label htmlFor={`meta-${field.key}`} className="text-sm text-gray-700">
          {field.label}
        </label>
      </div>
    );
  }

  if (field.field_type === "textarea") {
    return (
      <div>
        <label className="label">{field.label}</label>
        <textarea {...register(`metadata.${field.key}`, rules)} rows={3} className="input" />
      </div>
    );
  }

  const inputType =
    field.field_type === "date" ? "date" :
    field.field_type === "number" || field.field_type === "currency" ? "number" :
    "text";

  return (
    <div>
      <label className="label">
        {field.label}{field.is_required && <span className="text-red-500 ml-1">*</span>}
      </label>
      <input
        {...register(`metadata.${field.key}`, rules)}
        type={inputType}
        step={field.field_type === "currency" ? "0.01" : undefined}
        className="input"
      />
    </div>
  );
}

export default function MetadataEditPanel({ document: doc, onClose }: Props) {
  const qc = useQueryClient();

  const { register, handleSubmit, control, formState: { errors, isDirty } } = useForm({
    defaultValues: {
      title:         doc.title,
      supplier:      doc.supplier,
      amount:        doc.amount ?? "",
      currency:      doc.currency,
      document_date: doc.document_date ?? "",
      due_date:      doc.due_date ?? "",
      metadata:      doc.metadata ?? {},
    },
  });

  const mutation = useMutation({
    mutationFn: (data: Record<string, unknown>) =>
      documentsAPI.editMetadata(doc.id, data),
    onSuccess: () => {
      toast.success("Metadata updated");
      qc.invalidateQueries({ queryKey: ["document", doc.id] });
      onClose();
    },
    onError: (err: { response?: { data?: { detail?: string } } }) =>
      toast.error(err?.response?.data?.detail ?? "Update failed"),
  });

  const onSubmit = (values: Record<string, unknown>) => {
    mutation.mutate(values);
  };

  const metadataFields = doc.document_type?.metadata_fields ?? [];

  return (
    <div className="card p-5 border-l-4 border-brand-400 space-y-5">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Edit2 className="w-4 h-4 text-brand-500" />
          <h3 className="font-semibold text-gray-900 text-sm">Edit document details</h3>
        </div>
        <button onClick={onClose} className="text-gray-400 hover:text-gray-600">
          <X className="w-4 h-4" />
        </button>
      </div>

      <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
        {/* Core fields */}
        <div>
          <label className="label">Title <span className="text-red-500">*</span></label>
          <input
            {...register("title", { required: "Title is required" })}
            className="input"
          />
          {errors.title && (
            <p className="text-red-500 text-xs mt-1">{errors.title.message as string}</p>
          )}
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="label">Supplier</label>
            <input {...register("supplier")} className="input" placeholder="Supplier name" />
          </div>
          <div>
            <label className="label">Document date</label>
            <input {...register("document_date")} type="date" className="input" />
          </div>
        </div>

        <div className="grid grid-cols-3 gap-3">
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
              {["USD", "EUR", "GBP", "KES", "ZAR", "NGN"].map((c) => (
                <option key={c} value={c}>{c}</option>
              ))}
            </select>
          </div>
        </div>

        <div>
          <label className="label">Due date</label>
          <input {...register("due_date")} type="date" className="input" />
        </div>

        {/* Dynamic metadata fields */}
        {metadataFields.length > 0 && (
          <div className="border-t border-gray-100 pt-4 space-y-4">
            <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide">
              {doc.document_type.name} fields
            </p>
            {[...metadataFields]
              .sort((a, b) => a.order - b.order)
              .map((field) => (
                <DynamicField
                  key={field.id}
                  field={field}
                  register={register}
                  control={control}
                />
              ))}
          </div>
        )}

        <div className="flex gap-3 pt-2">
          <button
            type="submit"
            disabled={mutation.isPending || !isDirty}
            className="btn-primary"
          >
            {mutation.isPending && <Loader2 className="w-4 h-4 animate-spin" />}
            <Save className="w-4 h-4" /> Save changes
          </button>
          <button type="button" onClick={onClose} className="btn-secondary">
            Cancel
          </button>
        </div>
      </form>
    </div>
  );
}
