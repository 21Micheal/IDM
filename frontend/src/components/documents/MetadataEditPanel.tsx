/**
 * MetadataEditPanel.tsx
 *
 * Shown on DocumentDetailPage when document is in draft or rejected state.
 * Allows editing metadata fields without touching the file, reference, or
 * document type. Admin-defined document details are rendered from the
 * document type metadata fields only.
 */
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import {
  useForm,
  useFieldArray,
  Controller,
  type Control,
  type FieldErrors,
  type Path,
  type UseFormRegister,
} from "react-hook-form";
import { documentsAPI } from "@/services/api";
import { Edit2, Save, X, Loader2, Plus } from "lucide-react";
import { toast } from "@/components/ui/vault-toast";
import type { Document, MetadataField } from "@/types";
import { extractApiError } from "@/lib/apiError";

/** Imperative handle the page uses to flush unsaved edits before check-in. */
export type MetadataSaver = {
  isDirty: boolean;
  /** Validate + save; resolves true on success, false on validation/save error. */
  save: () => Promise<boolean>;
};

interface Props {
  document: Document;
  onClose: () => void;
  /**
   * Lets the parent page reach in to check dirty state and save before the
   * document lock is released (check-in). Registered while mounted, cleared on
   * unmount.
   */
  registerSaver?: (saver: MetadataSaver | null) => void;
}

type MetadataEditValues = {
  title: string;
  supplier: string;
  amount: string | number;
  currency: string;
  document_date: string;
  due_date: string;
  metadata: Record<string, unknown>;
  personal_tags: { value: string }[];
  personal_metadata_fields: { key: string; value: string }[];
};

const DOCUMENT_FIELD_KEYS = ["title", "supplier", "amount", "currency", "document_date", "due_date"] as const;
type DocumentFieldKey = (typeof DOCUMENT_FIELD_KEYS)[number];
const DOCUMENT_FIELD_KEY_SET = new Set<string>(DOCUMENT_FIELD_KEYS);

function getMetadataFieldKey(field: MetadataField) {
  return field.key ?? field.field_key;
}

function isDocumentFieldKey(key: string): key is DocumentFieldKey {
  return DOCUMENT_FIELD_KEY_SET.has(key);
}

function getEditFieldName(field: MetadataField): Path<MetadataEditValues> {
  const key = getMetadataFieldKey(field);
  return isDocumentFieldKey(key) ? key : (`metadata.${key}` as Path<MetadataEditValues>);
}

function metadataWithoutDocumentFields(metadata: unknown) {
  if (!metadata || typeof metadata !== "object") return {};
  return Object.entries(metadata as Record<string, unknown>).reduce<Record<string, unknown>>((acc, [key, value]) => {
    if (!isDocumentFieldKey(key)) {
      acc[key] = value;
    }
    return acc;
  }, {});
}

function getFieldErrorMessage(errors: FieldErrors<MetadataEditValues>, name: string) {
  const directMessage = errors[name as keyof MetadataEditValues]?.message;
  if (directMessage) return String(directMessage);

  const nestedError = name
    .split(".")
    .reduce<any>((current, part) => current?.[part], errors);
  return nestedError?.message ? String(nestedError.message) : undefined;
}

function DynamicField({
  field,
  register,
  control,
  errors,
  name,
}: {
  field: MetadataField;
  register: UseFormRegister<MetadataEditValues>;
  control: Control<MetadataEditValues>;
  errors: FieldErrors<MetadataEditValues>;
  name?: Path<MetadataEditValues>;
}) {
  const fieldKey = getMetadataFieldKey(field);
  const fieldName = name ?? (`metadata.${fieldKey}` as Path<MetadataEditValues>);
  const rules = field.is_required ? { required: `${field.label} is required` } : {};
  const requiredMark = field.is_required ? <span className="text-red-500 ml-1">*</span> : null;
  const errMsg = getFieldErrorMessage(errors, fieldName);

  const wrapper = (children: ReactNode) => (
    <div>
      <label className="label">
        {field.label}
        {requiredMark}
      </label>
      {children}
      {errMsg && <p className="text-red-500 text-xs mt-1">{errMsg}</p>}
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
            {(field.select_options || []).map((opt) => (
              <option key={opt} value={opt}>{opt}</option>
            ))}
          </select>
        )}
      />
    );
  }

  if (field.field_type === "boolean") {
    return (
      <div>
        <div className="flex items-center gap-2 pt-5">
          <input
            {...register(fieldName, rules)}
            type="checkbox"
            id={`meta-${fieldKey}`}
            className="w-4 h-4 rounded border-border text-primary"
          />
          <label htmlFor={`meta-${fieldKey}`} className="text-sm text-foreground">
            {field.label}
            {requiredMark}
          </label>
        </div>
        {errMsg && <p className="text-red-500 text-xs mt-1">{errMsg}</p>}
      </div>
    );
  }

  if (field.field_type === "textarea") {
    return wrapper(<textarea {...register(fieldName, rules)} rows={3} className="input" />);
  }

  const inputType =
    field.field_type === "date" ? "date" :
    field.field_type === "number" || field.field_type === "currency" ? "number" :
    "text";

  return wrapper(
    <input
      {...register(fieldName, rules)}
      type={inputType}
      step={field.field_type === "currency" ? "0.01" : undefined}
      className="input"
    />
  );
}

export default function MetadataEditPanel({ document: doc, onClose, registerSaver }: Props) {
  const qc = useQueryClient();
  const initialPersonalMetadataEntries = Object.entries(doc.metadata ?? {}).map(([key, value]) => ({
    key,
    value: String(value ?? ""),
  }));

  const { register, handleSubmit, control, formState: { errors, isDirty } } = useForm<MetadataEditValues>({
    defaultValues: {
      title:         doc.title,
      supplier:      doc.supplier,
      amount:        doc.amount ?? "",
      currency:      doc.currency,
      document_date: doc.document_date ?? "",
      due_date:      doc.due_date ?? "",
      metadata:      metadataWithoutDocumentFields(doc.metadata),
      personal_tags: (doc.personal_tags ?? []).length > 0
        ? (doc.personal_tags ?? []).map((tag) => ({ value: tag }))
        : [{ value: "" }],
      personal_metadata_fields: initialPersonalMetadataEntries.length > 0
        ? initialPersonalMetadataEntries
        : [{ key: "", value: "" }],
    },
  });
  const {
    fields: personalTagFields,
    append: appendPersonalTag,
    remove: removePersonalTag,
  } = useFieldArray({ control, name: "personal_tags" });
  const {
    fields: personalMetadataFields,
    append: appendPersonalMetadataField,
    remove: removePersonalMetadataField,
  } = useFieldArray({ control, name: "personal_metadata_fields" });
  const metadataFields = doc.is_self_upload ? [] : (doc.document_type?.metadata_fields ?? []);

  const mutation = useMutation({
    mutationFn: (data: Record<string, unknown>) =>
      documentsAPI.editMetadata(doc.id, data),
    onSuccess: () => {
      toast.success("Metadata updated");
      qc.invalidateQueries({ queryKey: ["document", doc.id] });
      qc.invalidateQueries({ queryKey: ["document-preview", doc.id] });
      onClose();
    },
    onError: (err) => toast.error(extractApiError(err, "Update failed")),
  });

  // The document is already checked out (locked) by the time this panel opens —
  // the lock is taken explicitly via the viewer's Lock button, not here.
  // Closing with unsaved edits still prompts Save / Discard.
  const [showDiscardPrompt, setShowDiscardPrompt] = useState(false);
  const requestClose = () => {
    if (isDirty) setShowDiscardPrompt(true);
    else onClose();
  };

  const buildPayload = (values: MetadataEditValues): Record<string, unknown> => {
    const personalTags = (values.personal_tags ?? [])
      .map((tag) => tag.value.trim())
      .filter(Boolean);
    const personalMetadata = (values.personal_metadata_fields ?? [])
      .map((item) => ({ key: item.key.trim(), value: item.value.trim() }))
      .filter((item) => item.key.length > 0 && item.value.length > 0)
      .reduce<Record<string, string>>((acc, item) => {
        acc[item.key] = item.value;
        return acc;
      }, {});
    const payload: Record<string, unknown> = doc.is_self_upload
      ? { ...values }
      : { metadata: metadataWithoutDocumentFields(values.metadata) };
    if (doc.is_self_upload) {
      payload.personal_tags = personalTags;
      payload.metadata = personalMetadata;
      delete payload.personal_metadata_fields;
    } else {
      metadataFields.forEach((field) => {
        const key = getMetadataFieldKey(field);
        if (isDocumentFieldKey(key)) {
          payload[key] = values[key];
        }
      });
    }
    if (payload.amount === "" || payload.amount === null || payload.amount === undefined) {
      delete payload.amount;
    }
    if (payload.document_date === "") {
      delete payload.document_date;
    }
    if (payload.due_date === "") {
      delete payload.due_date;
    }
    return payload;
  };

  const onSubmit = (values: MetadataEditValues) => mutation.mutate(buildPayload(values));

  // Expose dirty state + an async save to the page so it can flush unsaved
  // edits when the user releases (checks in) the document.
  useEffect(() => {
    if (!registerSaver) return;
    const save = () =>
      new Promise<boolean>((resolve) => {
        handleSubmit(
          async (values) => {
            try {
              await mutation.mutateAsync(buildPayload(values));
              resolve(true);
            } catch {
              resolve(false);
            }
          },
          () => resolve(false), // validation errors → don't release
        )();
      });
    registerSaver({ isDirty, save });
    return () => registerSaver(null);
  });

  return (
    <div className="h-full overflow-y-auto p-4 space-y-5">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Edit2 className="w-4 h-4 text-primary" />
          <h3 className="font-semibold text-foreground text-sm">Edit document details</h3>
        </div>
        <button type="button" onClick={requestClose} className="text-muted-foreground hover:text-foreground">
          <X className="w-4 h-4" />
        </button>
      </div>

      <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
        {doc.is_self_upload && (
          <div>
            <label className="label">Personal tags</label>
            <div className="space-y-2">
              {personalTagFields.map((field, index) => (
                <div key={field.id} className="flex items-center gap-2">
                  <input
                    {...register(`personal_tags.${index}.value` as const)}
                    className="input flex-1"
                    placeholder={`Tag ${index + 1}`}
                  />
                  <button
                    type="button"
                    onClick={() => removePersonalTag(index)}
                    disabled={personalTagFields.length === 1}
                    className="p-2 rounded-lg border border-border text-muted-foreground hover:text-destructive hover:bg-destructive/5 disabled:opacity-40 disabled:cursor-not-allowed"
                    title="Remove tag"
                  >
                    <X className="w-4 h-4" />
                  </button>
                </div>
              ))}
            </div>
            <button
              type="button"
              onClick={() => appendPersonalTag({ value: "" })}
              className="mt-3 inline-flex items-center gap-2 text-sm font-medium text-primary hover:text-primary/80"
            >
              <Plus className="w-4 h-4" /> Add another tag
            </button>
            <p className="text-xs text-muted-foreground mt-1">
              Optional. Add tags only when they help you organize this document.
            </p>
          </div>
        )}

        {doc.is_self_upload && (
          <div>
            <label className="label">Custom personal fields</label>
            <p className="text-xs text-muted-foreground mb-2">
              Add your own searchable key/value metadata fields.
            </p>
            <div className="space-y-2">
              {personalMetadataFields.map((field, index) => (
                <div key={field.id} className="grid grid-cols-[1fr_1fr_auto] items-center gap-2">
                  <input
                    {...register(`personal_metadata_fields.${index}.key` as const)}
                    className="input"
                    placeholder="Field name (e.g. project)"
                  />
                  <input
                    {...register(`personal_metadata_fields.${index}.value` as const)}
                    className="input"
                    placeholder="Field value"
                  />
                  <button
                    type="button"
                    onClick={() => removePersonalMetadataField(index)}
                    disabled={personalMetadataFields.length === 1}
                    className="p-2 rounded-lg border border-border text-muted-foreground hover:text-destructive hover:bg-destructive/5 disabled:opacity-40 disabled:cursor-not-allowed"
                    title="Remove custom field"
                  >
                    <X className="w-4 h-4" />
                  </button>
                </div>
              ))}
            </div>
            <button
              type="button"
              onClick={() => appendPersonalMetadataField({ key: "", value: "" })}
              className="mt-3 inline-flex items-center gap-2 text-sm font-medium text-primary hover:text-primary/80"
            >
              <Plus className="w-4 h-4" /> Add custom field
            </button>
          </div>
        )}

        {/* Dynamic metadata fields */}
        {metadataFields.length > 0 && (
          <div className="border-t border-border pt-4 space-y-4">
            <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
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
                  errors={errors}
                  name={getEditFieldName(field)}
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
          <button type="button" onClick={requestClose} className="btn-secondary">
            Cancel
          </button>
        </div>
      </form>

      {showDiscardPrompt && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-foreground/40 backdrop-blur-sm p-4">
          <div className="w-full max-w-sm rounded-2xl border border-border bg-card p-6 shadow-elegant">
            <h4 className="text-base font-semibold text-foreground">Unsaved changes</h4>
            <p className="mt-2 text-sm text-muted-foreground">
              You have unsaved metadata changes. Save them before releasing the lock, or discard them?
            </p>
            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => { setShowDiscardPrompt(false); onClose(); }}
                className="btn-secondary"
              >
                Discard
              </button>
              <button
                type="button"
                disabled={mutation.isPending}
                onClick={() => { setShowDiscardPrompt(false); handleSubmit(onSubmit)(); }}
                className="btn-primary"
              >
                {mutation.isPending && <Loader2 className="w-4 h-4 animate-spin" />}
                Save changes
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
