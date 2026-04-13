/**
 * pages/AdminDocumentTypesPage.tsx
 * Admin UI for creating and editing document types with custom metadata fields.
 */
import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useForm, useFieldArray } from "react-hook-form";
import { Plus, Trash2, GripVertical, Settings, ChevronRight, Save, Loader2, X } from "lucide-react";
import { documentApi, documentTypesAPI } from "../services/api";
import { cn } from "../lib/utils";

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
  select_options_raw: string;  // comma-separated
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

export default function AdminDocumentTypesPage() {
  const qc = useQueryClient();
  const [editingId, setEditingId] = useState<string | "new" | null>(null);

  const { data: types, isLoading } = useQuery({
    queryKey: ["document-types"],
    queryFn: () => documentApi.types(),
    select: (r) => r.data as any[],
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
      // Transform metadata fields
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

  const openEdit = (type: any) => {
    form.reset({
      ...type,
      metadata_fields: (type.metadata_fields ?? []).map((f: any) => ({
        ...f,
        select_options_raw: (f.select_options ?? []).join(", "),
      })),
    });
    setEditingId(type.id);
  };

  const addField = () => {
    append({ label: "", key: "", field_type: "text", is_required: false, select_options_raw: "", help_text: "", order: fields.length });
  };

  // Auto-generate key from label
  const handleLabelChange = (index: number, label: string) => {
    form.setValue(`metadata_fields.${index}.label`, label);
    const key = label.toLowerCase().replace(/\s+/g, "_").replace(/[^a-z0-9_]/g, "");
    form.setValue(`metadata_fields.${index}.key`, key);
  };

  return (
    <div className="max-w-6xl mx-auto p-6">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-xl font-semibold text-slate-900">Document types</h1>
          <p className="text-sm text-slate-500 mt-0.5">
            Configure types, metadata fields, and reference numbering.
          </p>
        </div>
        <button
          onClick={openNew}
          className="inline-flex items-center gap-2 px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-medium rounded-lg"
        >
          <Plus className="w-4 h-4" /> New document type
        </button>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Type list */}
        <div className="space-y-2">
          {isLoading ? (
            <div className="text-slate-400 text-sm">Loading…</div>
          ) : (
            (types ?? []).map((t) => (
              <button
                key={t.id}
                onClick={() => openEdit(t)}
                className={cn(
                  "w-full text-left p-4 rounded-xl border transition-all",
                  editingId === t.id
                    ? "border-indigo-300 bg-indigo-50"
                    : "border-slate-200 bg-white hover:border-slate-300 hover:bg-slate-50"
                )}
              >
                <div className="flex items-center justify-between">
                  <div>
                    <p className="font-medium text-slate-900 text-sm">{t.name}</p>
                    <p className="text-xs text-slate-500 mt-0.5">
                      Prefix: {t.reference_prefix} · {t.metadata_fields?.length ?? 0} custom fields
                    </p>
                  </div>
                  <ChevronRight className="w-4 h-4 text-slate-400" />
                </div>
              </button>
            ))
          )}
        </div>

        {/* Editor panel */}
        {editingId && (
          <div className="lg:col-span-2 bg-white border border-slate-200 rounded-xl">
            <div className="flex items-center justify-between px-5 py-4 border-b border-slate-100">
              <h2 className="font-medium text-slate-900">
                {editingId === "new" ? "New document type" : "Edit document type"}
              </h2>
              <button onClick={() => setEditingId(null)}>
                <X className="w-4 h-4 text-slate-400 hover:text-slate-600" />
              </button>
            </div>

            <form onSubmit={form.handleSubmit((v) => saveMutation.mutate(v))} className="p-5 space-y-6">
              {/* Basic info */}
              <section className="space-y-4">
                <h3 className="text-sm font-semibold text-slate-700">Basic information</h3>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-xs font-medium text-slate-600 mb-1">Type name *</label>
                    <input {...form.register("name")} placeholder="e.g. Supplier Invoice" className={iCls} />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-slate-600 mb-1">Code *</label>
                    <input {...form.register("code")} placeholder="e.g. INV" className={iCls} />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-slate-600 mb-1">Reference prefix *</label>
                    <input {...form.register("reference_prefix")} placeholder="INV" className={iCls} />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-slate-600 mb-1">Padding digits</label>
                    <input {...form.register("reference_padding", { valueAsNumber: true })} type="number" min={3} max={8} className={iCls} />
                    <p className="text-xs text-slate-400 mt-1">
                      e.g. 5 → {form.watch("reference_prefix") || "INV"}-00001
                    </p>
                  </div>
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-600 mb-1">Description</label>
                  <textarea {...form.register("description")} rows={2} className={iCls} />
                </div>
              </section>

              {/* Metadata fields */}
              <section className="space-y-3">
                <div className="flex items-center justify-between">
                  <h3 className="text-sm font-semibold text-slate-700">Custom metadata fields</h3>
                  <button
                    type="button"
                    onClick={addField}
                    className="inline-flex items-center gap-1 text-xs text-indigo-600 hover:text-indigo-700 font-medium"
                  >
                    <Plus className="w-3.5 h-3.5" /> Add field
                  </button>
                </div>

                {fields.length === 0 && (
                  <p className="text-xs text-slate-400 text-center py-4 border border-dashed border-slate-200 rounded-lg">
                    No custom fields yet. Click "Add field" to start.
                  </p>
                )}

                <div className="space-y-3">
                  {fields.map((field, idx) => {
                    const fieldType = form.watch(`metadata_fields.${idx}.field_type`);
                    return (
                      <div key={field.id} className="border border-slate-200 rounded-xl p-4 space-y-3 bg-slate-50">
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-2">
                            <GripVertical className="w-4 h-4 text-slate-300" />
                            <span className="text-xs font-medium text-slate-600">Field {idx + 1}</span>
                          </div>
                          <button type="button" onClick={() => remove(idx)}>
                            <Trash2 className="w-4 h-4 text-slate-400 hover:text-red-500" />
                          </button>
                        </div>
                        <div className="grid grid-cols-2 gap-3">
                          <div>
                            <label className="block text-xs text-slate-500 mb-1">Label *</label>
                            <input
                              {...form.register(`metadata_fields.${idx}.label`)}
                              onChange={(e) => handleLabelChange(idx, e.target.value)}
                              placeholder="e.g. Invoice Number"
                              className={iCls}
                            />
                          </div>
                          <div>
                            <label className="block text-xs text-slate-500 mb-1">Key (auto)</label>
                            <input
                              {...form.register(`metadata_fields.${idx}.key`)}
                              placeholder="invoice_number"
                              className={cn(iCls, "font-mono text-xs text-slate-500")}
                            />
                          </div>
                          <div>
                            <label className="block text-xs text-slate-500 mb-1">Field type</label>
                            <select {...form.register(`metadata_fields.${idx}.field_type`)} className={iCls}>
                              {FIELD_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
                            </select>
                          </div>
                          <div className="flex items-end pb-1">
                            <label className="flex items-center gap-2 text-xs text-slate-600 cursor-pointer">
                              <input type="checkbox" {...form.register(`metadata_fields.${idx}.is_required`)} />
                              Required field
                            </label>
                          </div>
                        </div>
                        {fieldType === "select" && (
                          <div>
                            <label className="block text-xs text-slate-500 mb-1">Options (comma-separated)</label>
                            <input
                              {...form.register(`metadata_fields.${idx}.select_options_raw`)}
                              placeholder="Pending, Paid, Overdue"
                              className={iCls}
                            />
                          </div>
                        )}
                        <div>
                          <label className="block text-xs text-slate-500 mb-1">Help text</label>
                          <input {...form.register(`metadata_fields.${idx}.help_text`)} placeholder="Optional guidance for users" className={iCls} />
                        </div>
                      </div>
                    );
                  })}
                </div>
              </section>

              {/* Save */}
              <div className="flex justify-end gap-3 pt-2 border-t border-slate-100">
                <button type="button" onClick={() => setEditingId(null)} className="px-4 py-2 text-sm text-slate-600 hover:bg-slate-100 rounded-lg">
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={saveMutation.isPending}
                  className="inline-flex items-center gap-2 px-5 py-2 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white text-sm font-medium rounded-lg"
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

const iCls = "w-full text-sm border border-slate-200 rounded-lg px-3 py-2 bg-white focus:outline-none focus:ring-2 focus:ring-indigo-500";
