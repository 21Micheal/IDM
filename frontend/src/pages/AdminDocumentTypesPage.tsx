/**
 * pages/AdminDocumentTypesPage.tsx
 *
 * Updated: Field Key auto-fills intelligently as user types the Label
 * - lowercase
 * - spaces → single underscore
 * - removes special characters
 */

import { useEffect, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useForm, useFieldArray } from "react-hook-form";
import {
  Plus, Trash2, GripVertical, ChevronRight, Save, Loader2, X, AlertCircle,
} from "lucide-react";
import { documentApi, documentTypesAPI, normalizeListResponse } from "../services/api";
import { toast } from "@/components/ui/vault-toast";
import { cn } from "../lib/utils";
import type { DocumentType } from "@/types";
import {
  applyDocumentTypeConfigToDescription,
  deriveDocumentTypeConfig,
  stripTypeConfigMarkers,
} from "@/lib/documentTypeConfig";

// ── Constants ─────────────────────────────────────────────────────────────────

const FIELD_TYPES = [
  { value: "text",     label: "Text" },
  { value: "varchar",  label: "VARCHAR" },
  { value: "number",   label: "Number" },
  { value: "date",     label: "Date" },
  { value: "currency", label: "Currency" },
  { value: "select",   label: "Select" },
  { value: "boolean",  label: "Yes / No" },
  { value: "textarea", label: "Long text" },
];

// Default definitions for fields backed by first-class Document columns.
// They are seeded for convenience, but admins can edit/remove/re-order them per client.
const CORE_DEFAULT_FIELDS: MetadataFieldForm[] = [
  { label: "Document Name",     field_key: "title",         field_type: "text",     is_required: true,  select_options_raw: "", help_text: "Name shown to users", order: 0 },
  { label: "Supplier / Vendor", field_key: "supplier",      field_type: "text",     is_required: false, select_options_raw: "", help_text: "Business partner", order: 1 },
  { label: "Amount",            field_key: "amount",        field_type: "currency", is_required: false, select_options_raw: "", help_text: "Document total amount", order: 2 },
  { label: "Currency",          field_key: "currency",      field_type: "select",   is_required: false, select_options_raw: "KES, USD, EUR, GBP, UGX, TZS, NGN, ZAR", help_text: "ISO currency code", order: 3 },
  { label: "Document Date",     field_key: "document_date", field_type: "date",     is_required: false, select_options_raw: "", help_text: "Date on the document", order: 4 },
  { label: "Due Date",          field_key: "due_date",      field_type: "date",     is_required: false, select_options_raw: "", help_text: "Payment due date", order: 5 },
];

function coreDefaultFields() {
  return CORE_DEFAULT_FIELDS.map((field) => ({ ...field }));
}

// ── Types ─────────────────────────────────────────────────────────────────────

interface MetadataFieldForm {
  label:              string;
  field_key:          string;
  field_type:         string;
  is_required:        boolean;
  select_options_raw: string;
  help_text:          string;
  order:              number;
}

interface DocTypeForm {
  name:               string;
  code:               string;
  reference_prefix:   string;
  reference_padding:  number;
  description:        string;
  is_personal_type:   boolean;
  metadata_mode:      "admin_defined" | "user_defined";
  metadata_fields:    MetadataFieldForm[];
}

const iCls =
  "w-full text-sm border border-input rounded-lg px-3 py-2 bg-card text-foreground " +
  "placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring " +
  "focus:border-ring transition";

// ── Payload builder ───────────────────────────────────────────────────────────

function buildPayload(values: DocTypeForm) {
  const isPersonal = values.is_personal_type;
  const metadataMode = isPersonal ? "user_defined" : values.metadata_mode;
  return {
    name:              values.name,
    code:              values.code,
    reference_prefix:  values.reference_prefix,
    reference_padding: values.reference_padding,
    description:       applyDocumentTypeConfigToDescription(values.description, {
      isPersonalType: isPersonal,
      metadataMode,
    }),
    is_personal_type:  isPersonal,
    metadata_mode:     metadataMode,
    metadata_fields:   metadataMode === "admin_defined"
      ? values.metadata_fields.map((f, i) => ({
          label:         f.label,
          field_key:     f.field_key,
          field_type:    f.field_type,
          is_required:   f.is_required,
          help_text:     f.help_text,
          order:         i,
          select_options: f.field_type === "select" && f.select_options_raw
            ? f.select_options_raw.split(",").map((s) => s.trim()).filter(Boolean)
            : [],
        }))
      : [],
  };
}

/**
 * Improved Field Key generator:
 * - lowercase
 * - whitespace → single underscore
 * - remove special characters
 */
function toFieldKey(label: string): string {
  return label
    .toLowerCase()
    .trim()
    .replace(/\s+/g, "_")                    // multiple spaces → single underscore
    .replace(/[^a-z0-9_]/g, "")              // keep only letters, numbers, underscore
    .replace(/_+/g, "_")                     // prevent multiple consecutive underscores
    .replace(/^_|_$/g, "");                  // remove leading/trailing underscores
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function AdminDocumentTypesPage() {
  const qc = useQueryClient();
  const [editingId, setEditingId] = useState<string | "new" | null>(null);

  const { data: types, isLoading } = useQuery<unknown, Error, DocumentType[]>({
    queryKey: ["document-types"],
    queryFn: () => documentApi.types().then((r) => r.data as unknown),
    select: (data) => normalizeListResponse<DocumentType>(data),
  });
  const missingTypeFlags = (types ?? []).length > 0
    && (types ?? []).every(
      (t) => typeof t.is_personal_type !== "boolean" && typeof t.metadata_mode !== "string",
    );

  const form = useForm<DocTypeForm>({
    defaultValues: {
      name: "", code: "", reference_prefix: "",
      reference_padding: 5, description: "",
      is_personal_type: false, metadata_mode: "admin_defined",
      metadata_fields: [],
    },
  });

  const { fields, append, remove } = useFieldArray({
    control: form.control,
    name: "metadata_fields",
  });
  const isPersonalType = form.watch("is_personal_type");
  const metadataMode = form.watch("metadata_mode");
  const useAdminMetadata = !isPersonalType && metadataMode === "admin_defined";

  useEffect(() => {
    if (isPersonalType && form.getValues("metadata_mode") !== "user_defined") {
      form.setValue("metadata_mode", "user_defined", { shouldDirty: true });
    }
  }, [isPersonalType, form]);

  const syncFieldKeyFromLabel = (idx: number, label: string) => {
    const generatedKey = toFieldKey(label);
    const keyPath = `metadata_fields.${idx}.field_key` as const;
    const currentKey = String(form.getValues(keyPath) ?? "");

    if (currentKey !== generatedKey) {
      form.setValue(keyPath, generatedKey, {
        shouldDirty: true,
        shouldTouch: true,
        shouldValidate: true,
      });
    }
  };

  // ── Save mutation ───────────────────────────────────────────────────────────

  const saveMutation = useMutation({
    mutationFn: (values: DocTypeForm) => {
      const payload = buildPayload(values);
      return editingId === "new"
        ? documentTypesAPI.create(payload)
        : documentTypesAPI.update(editingId as string, payload);
    },
    onSuccess: (_, variables) => {
      const isNew = editingId === "new";
      toast.success(
        isNew
          ? `Document type "${variables.name}" created successfully`
          : `Document type "${variables.name}" updated successfully`
      );
      qc.invalidateQueries({ queryKey: ["document-types"] });
      setEditingId(null);
    },
    onError: (err: any) => {
      const data = err?.response?.data;
      if (data) {
        const messages = Object.entries(data)
          .map(([field, msgs]) =>
            `${field}: ${Array.isArray(msgs) ? msgs.join(", ") : String(msgs)}`
          )
          .join(" | ");
        toast.error(`Save failed — ${messages}`);
      } else {
        toast.error("Failed to save document type. Please try again.");
      }
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (type: DocumentType) => documentTypesAPI.delete(type.id),
    onSuccess: (_, type) => {
      toast.success(`Document type "${type.name}" deleted successfully`);
      qc.invalidateQueries({ queryKey: ["document-types"] });
      if (editingId === type.id) {
        setEditingId(null);
      }
    },
    onError: (err: any) => {
      const detail = err?.response?.data?.detail;
      toast.error(detail || "Failed to delete document type. Please try again.");
    },
  });

  const confirmDelete = (type: DocumentType) => {
    if (window.confirm(`Delete document type "${type.name}"? This cannot be undone.`)) {
      deleteMutation.mutate(type);
    }
  };

  // ── Open helpers ────────────────────────────────────────────────────────────

  const openNew = () => {
    form.reset({
      name: "", code: "", reference_prefix: "",
      reference_padding: 5, description: "",
      is_personal_type: false, metadata_mode: "admin_defined",
      metadata_fields: coreDefaultFields(),
    });
    setEditingId("new");
  };

  const openEdit = (type: DocumentType) => {
    form.reset({
      name:              type.name,
      code:              type.code,
      reference_prefix:  type.reference_prefix,
      reference_padding: type.reference_padding ?? 5,
      description:       stripTypeConfigMarkers(type.description ?? ""),
      is_personal_type:  deriveDocumentTypeConfig(type).isPersonalType,
      metadata_mode:     deriveDocumentTypeConfig(type).metadataMode,
      metadata_fields:   (type.metadata_fields ?? []).map((f) => ({
        label:              f.label,
        field_key:          f.key ?? f.field_key,
        field_type:         f.field_type,
        is_required:        f.is_required,
        help_text:          f.help_text ?? "",
        order:              f.order,
        select_options_raw: (f.select_options ?? []).join(", "),
      })),
    });
    setEditingId(type.id);
  };

  const addField = () => {
    append({
      label: "",
      field_key: "",
      field_type: "text",
      is_required: false,
      select_options_raw: "",
      help_text: "",
      order: fields.length,
    });
  };

  // ── Render ──────────────────────────────────────────────────────────────────

  return (
    <div className="admin-shell">
      {/* Header */}
      <div className="admin-page-header flex items-center justify-between gap-4">
        <div>
          <h1 className="admin-page-title">Document types</h1>
          <p className="admin-page-subtitle">
            Configure types, metadata fields, and reference numbering.
          </p>
          {missingTypeFlags && (
            <p className="text-xs text-amber-600 mt-2">
              Backend flags are not yet exposed; the UI is persisting personal-type settings
              through compatibility markers so your selections still apply.
            </p>
          )}
        </div>
        <button onClick={openNew} className="btn-primary">
          <Plus className="w-4 h-4" /> New document type
        </button>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">

        {!editingId && (
          <div className="space-y-2">
            {isLoading ? (
              <div className="text-muted-foreground text-sm">Loading…</div>
            ) : (types ?? []).length === 0 ? (
              <div className="text-center py-10 text-muted-foreground">
                <AlertCircle className="w-7 h-7 mx-auto mb-2 opacity-30" />
                <p className="text-sm">No document types yet.</p>
              </div>
            ) : (
              (types ?? []).map((t) => (
                <div
                  key={t.id}
                  onClick={() => openEdit(t)}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      openEdit(t);
                    }
                  }}
                  className={cn(
                    "w-full text-left p-4 rounded-xl border transition-all cursor-pointer",
                    editingId === t.id
                      ? "border-accent bg-accent/10"
                      : "border-border bg-card hover:border-accent/40"
                  )}
                >
                  <div className="flex items-center justify-between">
                    <div>
                      {(() => {
                        const typeConfig = deriveDocumentTypeConfig(t);
                        return (
                          <>
                            <p className="font-semibold text-foreground text-sm">{t.name}</p>
                            <p className="text-xs text-muted-foreground mt-0.5">
                              <span className="font-mono">{t.reference_prefix}</span>-{"0".repeat(t.reference_padding ?? 5)}
                              {" · "}
                              {typeConfig.metadataMode === "user_defined"
                                ? "user-defined metadata"
                                : `${t.metadata_fields?.length ?? 0} custom field${(t.metadata_fields?.length ?? 0) !== 1 ? "s" : ""}`}
                            </p>
                            {(typeConfig.isPersonalType || typeConfig.metadataMode === "user_defined") && (
                              <p className="text-[11px] text-accent mt-1 font-medium">
                                {typeConfig.isPersonalType ? "Personal type" : "User-defined metadata"}
                              </p>
                            )}
                          </>
                        );
                      })()}
                    </div>
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          confirmDelete(t);
                        }}
                        disabled={deleteMutation.isPending}
                        className="p-1.5 rounded-md text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors disabled:opacity-50"
                        title="Delete document type"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                      <ChevronRight className="w-4 h-4 text-muted-foreground" />
                    </div>
                  </div>
                </div>
              ))
            )}
          </div>
        )}

        {/* Editor panel */}
        {editingId && (
          <div className="lg:col-span-2 card overflow-hidden">
            <div className="flex items-center justify-between px-5 py-4 border-b border-border bg-muted/40">
              <h2 className="font-semibold text-foreground">
                {editingId === "new" ? "New document type" : "Edit document type"}
              </h2>
              <div className="flex items-center gap-2">
                {editingId !== "new" && (
                  <button
                    type="button"
                    onClick={() => {
                      const type = (types ?? []).find((t) => t.id === editingId);
                      if (type) {
                        confirmDelete(type);
                      }
                    }}
                    disabled={deleteMutation.isPending}
                    className="text-muted-foreground hover:text-destructive p-1 rounded-md hover:bg-destructive/10 disabled:opacity-50"
                    title="Delete document type"
                  >
                    {deleteMutation.isPending ? (
                      <Loader2 className="w-4 h-4 animate-spin" />
                    ) : (
                      <Trash2 className="w-4 h-4" />
                    )}
                  </button>
                )}
                <button
                  onClick={() => setEditingId(null)}
                  className="text-muted-foreground hover:text-foreground p-1 rounded-md hover:bg-muted"
                  type="button"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
            </div>

            <form
              onSubmit={form.handleSubmit((v) => saveMutation.mutate(v))}
              className="p-5 space-y-6"
            >
              {/* Basic information */}
              <section className="space-y-4">
                <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                  Basic information
                </h3>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-xs font-medium text-foreground mb-1.5">
                      Type name <span className="text-red-500">*</span>
                    </label>
                    <input
                      {...form.register("name", { required: true })}
                      placeholder="e.g. Supplier Invoice"
                      className={iCls}
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-foreground mb-1.5">
                      Code <span className="text-red-500">*</span>
                    </label>
                    <input
                      {...form.register("code", { required: true })}
                      placeholder="e.g. INV"
                      className={iCls}
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-foreground mb-1.5">
                      Reference prefix <span className="text-red-500">*</span>
                    </label>
                    <input
                      {...form.register("reference_prefix", { required: true })}
                      placeholder="INV"
                      className={iCls}
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-foreground mb-1.5">
                      Padding digits
                    </label>
                    <input
                      {...form.register("reference_padding", { valueAsNumber: true })}
                      type="number"
                      min={3}
                      max={8}
                      className={iCls}
                    />
                  </div>
                </div>
                <div>
                  <label className="block text-xs font-medium text-foreground mb-1.5">
                    Description
                  </label>
                  <textarea {...form.register("description")} rows={2} className={iCls} />
                </div>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <label className="flex items-center gap-2 text-sm text-foreground">
                    <input
                      type="checkbox"
                      {...form.register("is_personal_type")}
                      className="w-4 h-4 rounded border-border text-accent focus:ring-ring"
                    />
                    This is a personal document type
                  </label>
                  <div>
                    <label className="block text-xs font-medium text-foreground mb-1.5">
                      Metadata mode
                    </label>
                    <select
                      {...form.register("metadata_mode")}
                      disabled={isPersonalType}
                      className={cn(iCls, isPersonalType && "opacity-60 cursor-not-allowed")}
                    >
                      <option value="admin_defined">Admin-defined metadata fields</option>
                      <option value="user_defined">User-defined metadata fields</option>
                    </select>
                    <p className="mt-1 text-[11px] text-muted-foreground">
                      {isPersonalType
                        ? "Personal types let users choose optional tags, custom fields, descriptions, and free text at upload time."
                        : "Choose whether metadata comes from admin field definitions or user-defined key/value fields."}
                    </p>
                  </div>
                </div>
              </section>

              {/* Metadata fields */}
              <section className="space-y-3">
                <div className="flex items-center justify-between">
                  <div>
                    <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                      Custom metadata fields
                    </h3>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      {useAdminMetadata
                        ? "Define every field this document type should show during upload, such as supplier, dates, and amounts. The document name can come from the file name."
                        : isPersonalType
                          ? "Personal upload details are user-controlled and optional."
                          : "Disabled: users will define their own searchable fields at upload time."}
                    </p>
                  </div>
                  {useAdminMetadata && (
                    <button
                      type="button"
                      onClick={addField}
                      className="inline-flex items-center gap-1 text-xs text-accent hover:text-accent/80 font-semibold"
                    >
                      <Plus className="w-3.5 h-3.5" /> Add field
                    </button>
                  )}
                </div>

                {useAdminMetadata && fields.length === 0 && (
                  <p className="text-xs text-muted-foreground text-center py-6 border border-dashed border-border rounded-lg">
                    No custom fields yet. Click "Add field" to start.
                  </p>
                )}
                {!useAdminMetadata && (
                  <p className="text-xs text-muted-foreground text-center py-6 border border-dashed border-border rounded-lg">
                    Admin-defined metadata is disabled for this type.
                  </p>
                )}

                <div className={cn("space-y-3", !useAdminMetadata && "opacity-50 pointer-events-none select-none")}>
                  {fields.map((field, idx) => {
                    const fieldType = form.watch(`metadata_fields.${idx}.field_type`);
                    return (
                      <div
                        key={field.id}
                        className="border border-border rounded-xl p-4 space-y-3 bg-muted/40"
                      >
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-2">
                            <GripVertical className="w-4 h-4 text-muted-foreground/60" />
                            <span className="text-xs font-semibold text-foreground">
                              Field {idx + 1}
                            </span>
                          </div>
                          <button
                            type="button"
                            onClick={() => remove(idx)}
                            className="text-muted-foreground hover:text-destructive transition-colors"
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                        </div>

                        <div className="grid grid-cols-2 gap-3">
                          <div>
                            <label className="block text-xs text-muted-foreground mb-1">
                              Label <span className="text-red-500">*</span>
                            </label>
                            <input
                              {...form.register(`metadata_fields.${idx}.label`, {
                                required: true,
                                onChange: (e) => syncFieldKeyFromLabel(idx, e.target.value),
                              })}
                              placeholder="e.g. Invoice Number"
                              className={iCls}
                            />
                          </div>
                          <div>
                            <label className="block text-xs text-muted-foreground mb-1">
                              Field Key
                            </label>
                            <input
                              {...form.register(`metadata_fields.${idx}.field_key`, { required: true })}
                              placeholder="invoice_number"
                              className={cn(iCls, "font-mono text-xs bg-muted/20")}
                              readOnly
                              spellCheck={false}
                              autoComplete="off"
                              autoCapitalize="none"
                            />
                            <p className="mt-1 text-[11px] text-muted-foreground">
                              Auto-generated from the label.
                            </p>
                          </div>
                          <div>
                            <label className="block text-xs text-muted-foreground mb-1">
                              Field type
                            </label>
                            <select
                              {...form.register(`metadata_fields.${idx}.field_type`)}
                              className={iCls}
                            >
                              {FIELD_TYPES.map((t) => (
                                <option key={t.value} value={t.value}>{t.label}</option>
                              ))}
                            </select>
                          </div>
                          <div className="flex items-end pb-2">
                            <label className="flex items-center gap-2 text-xs text-foreground cursor-pointer">
                              <input
                                type="checkbox"
                                {...form.register(`metadata_fields.${idx}.is_required`)}
                                className="w-4 h-4 rounded border-border text-accent focus:ring-ring"
                              />
                              Required field
                            </label>
                          </div>
                        </div>

                        {fieldType === "select" && (
                          <div>
                            <label className="block text-xs text-muted-foreground mb-1">
                              Options <span className="text-muted-foreground/60">(comma-separated)</span>
                            </label>
                            <input
                              {...form.register(`metadata_fields.${idx}.select_options_raw`)}
                              placeholder="Pending, Paid, Overdue"
                              className={iCls}
                            />
                          </div>
                        )}

                        <div>
                          <label className="block text-xs text-muted-foreground mb-1">
                            Help text <span className="text-muted-foreground/60">(optional)</span>
                          </label>
                          <input
                            {...form.register(`metadata_fields.${idx}.help_text`)}
                            placeholder="Guidance shown to users on the upload form"
                            className={iCls}
                          />
                        </div>
                      </div>
                    );
                  })}
                </div>
              </section>

              {/* Save actions */}
              <div className="flex justify-end gap-3 pt-4 border-t border-border">
                <button
                  type="button"
                  onClick={() => setEditingId(null)}
                  className="btn-secondary"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={saveMutation.isPending}
                  className="btn-primary"
                >
                  {saveMutation.isPending ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : (
                    <Save className="w-4 h-4" />
                  )}
                  {editingId === "new" ? "Create document type" : "Save changes"}
                </button>
              </div>
            </form>
          </div>
        )}
      </div>
    </div>
  );
}
