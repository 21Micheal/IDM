/**
 * pages/AdminDocumentTypesPage.tsx
 * Admin UI for creating and editing document types with custom metadata fields.
 */
import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useForm, useFieldArray } from "react-hook-form";
import { Plus, Trash2, GripVertical, ChevronRight, Save, Loader2, X } from "lucide-react";
import { documentApi, documentTypesAPI } from "../services/api";
import { cn } from "../lib/utils";
import type { DocumentType } from "@/types";

const FIELD_TYPES = [
  { value: "text", label: "Text" },
  { value: "number", label: "Number" },
  { value: "date", label: "Date" },
  { value: "currency", label: "Currency" },
  { value: "select", label: "Select / Dropdown" },
  { value: "boolean", label: "Yes / No" },
  { value: "textarea", label: "Long text" },
];

interface MetadataFieldForm {
  label: string;
  key: string;
  field_type: string;
  is_required: boolean;
  select_options_raw: string;
  help_text: string;
  order: number;
}

interface DocTypeForm {
  name: string;
  code: string;
  reference_prefix: string;
  reference_padding: number;
  description: string;
  metadata_fields: MetadataFieldForm[];
}

const iCls =
  "w-full text-sm border border-input rounded-lg px-3 py-2 bg-card text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring focus:border-ring transition";

export default function AdminDocumentTypesPage() {
  const qc = useQueryClient();
  const [editingId, setEditingId] = useState<string | "new" | null>(null);

  const { data: types, isLoading } = useQuery<DocumentType[]>({
    queryKey: ["document-types"],
    queryFn: () => documentApi.types().then((r) => (r.data.results ?? r.data) as DocumentType[]),
  });

  const form = useForm<DocTypeForm>({
    defaultValues: {
      name: "", code: "", reference_prefix: "", reference_padding: 5,
      description: "", metadata_fields: [],
    },
  });

  const { fields, append, remove } = useFieldArray({
    control: form.control, name: "metadata_fields",
  });

  const saveMutation = useMutation({
    mutationFn: async (values: DocTypeForm) => {
      const payload = {
        ...values,
        metadata_fields: values.metadata_fields.map((f, i) => ({
          ...f,
          order: i,
          select_options: f.select_options_raw
            ? f.select_options_raw.split(",").map((s) => s.trim()).filter(Boolean)
            : [],
        })),
      };
      if (editingId === "new") {
        return documentTypesAPI.create(payload);
      }
      return documentTypesAPI.update(editingId as string, payload);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["document-types"] });
      setEditingId(null);
    },
  });

  const openNew = () => {
    form.reset({ name: "", code: "", reference_prefix: "", reference_padding: 5, description: "", metadata_fields: [] });
    setEditingId("new");
  };

  const openEdit = (type: DocumentType) => {
    form.reset({
      ...type,
      metadata_fields: (type.metadata_fields ?? []).map((f) => ({
        ...f,
        select_options_raw: (f.select_options ?? []).join(", "),
      })),
    });
    setEditingId(type.id);
  };

  const addField = () => {
    append({ label: "", key: "", field_type: "text", is_required: false, select_options_raw: "", help_text: "", order: fields.length });
  };

  const handleLabelChange = (index: number, label: string) => {
    form.setValue(`metadata_fields.${index}.label`, label);
    const key = label.toLowerCase().replace(/\s+/g, "_").replace(/[^a-z0-9_]/g, "");
    form.setValue(`metadata_fields.${index}.key`, key);
  };

  return (
    <div className="max-w-6xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-foreground tracking-tight">Document types</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Configure types, metadata fields, and reference numbering.
          </p>
        </div>
        <button
          onClick={openNew}
          className="btn-primary"
        >
          <Plus className="w-4 h-4" /> New document type
        </button>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Type list */}
        <div className="space-y-2">
          {isLoading ? (
            <div className="text-muted-foreground text-sm">Loading…</div>
          ) : (
            (types ?? []).map((t) => (
              <button
                key={t.id}
                onClick={() => openEdit(t)}
                className={cn(
                  "w-full text-left p-4 rounded-xl border transition-all",
                  editingId === t.id
                    ? "border-accent bg-accent/10"
                    : "border-border bg-card hover:border-accent/40"
                )}
                style={{ boxShadow: editingId === t.id ? "none" : "var(--shadow-card)" }}
              >
                <div className="flex items-center justify-between">
                  <div>
                    <p className="font-semibold text-foreground text-sm">{t.name}</p>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      Prefix: <span className="font-mono">{t.reference_prefix}</span> · {t.metadata_fields?.length ?? 0} custom fields
                    </p>
                  </div>
                  <ChevronRight className="w-4 h-4 text-muted-foreground" />
                </div>
              </button>
            ))
          )}
        </div>

        {/* Editor panel */}
        {editingId && (
          <div className="lg:col-span-2 card overflow-hidden">
            <div className="flex items-center justify-between px-5 py-4 border-b border-border bg-muted/40">
              <h2 className="font-semibold text-foreground">
                {editingId === "new" ? "New document type" : "Edit document type"}
              </h2>
              <button onClick={() => setEditingId(null)} className="text-muted-foreground hover:text-foreground p-1 rounded-md hover:bg-muted">
                <X className="w-4 h-4" />
              </button>
            </div>

            <form onSubmit={form.handleSubmit((v) => saveMutation.mutate(v))} className="p-5 space-y-6">
              {/* Basic info */}
              <section className="space-y-4">
                <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Basic information</h3>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-xs font-medium text-foreground mb-1.5">Type name *</label>
                    <input {...form.register("name")} placeholder="e.g. Supplier Invoice" className={iCls} />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-foreground mb-1.5">Code *</label>
                    <input {...form.register("code")} placeholder="e.g. INV" className={iCls} />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-foreground mb-1.5">Reference prefix *</label>
                    <input {...form.register("reference_prefix")} placeholder="INV" className={iCls} />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-foreground mb-1.5">Padding digits</label>
                    <input {...form.register("reference_padding", { valueAsNumber: true })} type="number" min={3} max={8} className={iCls} />
                    <p className="text-xs text-muted-foreground mt-1">
                      e.g. 5 → <span className="font-mono text-accent">{form.watch("reference_prefix") || "INV"}-00001</span>
                    </p>
                  </div>
                </div>
                <div>
                  <label className="block text-xs font-medium text-foreground mb-1.5">Description</label>
                  <textarea {...form.register("description")} rows={2} className={iCls} />
                </div>
              </section>

              {/* Metadata fields */}
              <section className="space-y-3">
                <div className="flex items-center justify-between">
                  <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Custom metadata fields</h3>
                  <button
                    type="button"
                    onClick={addField}
                    className="inline-flex items-center gap-1 text-xs text-accent hover:text-accent/80 font-semibold"
                  >
                    <Plus className="w-3.5 h-3.5" /> Add field
                  </button>
                </div>

                {fields.length === 0 && (
                  <p className="text-xs text-muted-foreground text-center py-6 border border-dashed border-border rounded-lg">
                    No custom fields yet. Click "Add field" to start.
                  </p>
                )}

                <div className="space-y-3">
                  {fields.map((field, idx) => {
                    const fieldType = form.watch(`metadata_fields.${idx}.field_type`);
                    return (
                      <div key={field.id} className="border border-border rounded-xl p-4 space-y-3 bg-muted/40">
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-2">
                            <GripVertical className="w-4 h-4 text-muted-foreground/60" />
                            <span className="text-xs font-semibold text-foreground">Field {idx + 1}</span>
                          </div>
                          <button type="button" onClick={() => remove(idx)} className="text-muted-foreground hover:text-destructive transition-colors">
                            <Trash2 className="w-4 h-4" />
                          </button>
                        </div>
                        <div className="grid grid-cols-2 gap-3">
                          <div>
                            <label className="block text-xs text-muted-foreground mb-1">Label *</label>
                            <input
                              {...form.register(`metadata_fields.${idx}.label`)}
                              onChange={(e) => handleLabelChange(idx, e.target.value)}
                              placeholder="e.g. Invoice Number"
                              className={iCls}
                            />
                          </div>
                          <div>
                            <label className="block text-xs text-muted-foreground mb-1">Key (auto)</label>
                            <input
                              {...form.register(`metadata_fields.${idx}.key`)}
                              placeholder="invoice_number"
                              className={cn(iCls, "font-mono text-xs")}
                            />
                          </div>
                          <div>
                            <label className="block text-xs text-muted-foreground mb-1">Field type</label>
                            <select {...form.register(`metadata_fields.${idx}.field_type`)} className={iCls}>
                              {FIELD_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
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
                            <label className="block text-xs text-muted-foreground mb-1">Options (comma-separated)</label>
                            <input
                              {...form.register(`metadata_fields.${idx}.select_options_raw`)}
                              placeholder="Pending, Paid, Overdue"
                              className={iCls}
                            />
                          </div>
                        )}
                        <div>
                          <label className="block text-xs text-muted-foreground mb-1">Help text</label>
                          <input {...form.register(`metadata_fields.${idx}.help_text`)} placeholder="Optional guidance for users" className={iCls} />
                        </div>
                      </div>
                    );
                  })}
                </div>
              </section>

              {/* Save */}
              <div className="flex justify-end gap-3 pt-4 border-t border-border">
                <button type="button" onClick={() => setEditingId(null)} className="btn-secondary">
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={saveMutation.isPending}
                  className="btn-primary"
                >
                  {saveMutation.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
                  Save type
                </button>
              </div>
            </form>
          </div>
        )}
      </div>
    </div>
  );
}
