import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { documentTypesAPI, workflowAPI } from "@/services/api";
import { Plus, Settings, GitBranch, Trash2, Edit2, Loader2, ChevronDown, ChevronUp } from "lucide-react";
import { useForm, useFieldArray } from "react-hook-form";
import { toast } from "react-toastify";
import type { DocumentType } from "@/types";

const FIELD_TYPES = [
  { value: "text", label: "Text" },
  { value: "number", label: "Number" },
  { value: "date", label: "Date" },
  { value: "currency", label: "Currency" },
  { value: "select", label: "Dropdown" },
  { value: "boolean", label: "Yes/No" },
  { value: "textarea", label: "Long text" },
];

function DocumentTypeForm({ onDone }: { onDone: () => void }) {
  const qc = useQueryClient();
  const { register, control, handleSubmit, watch, formState: { errors } } = useForm({
    defaultValues: {
      name: "",
      code: "",
      reference_prefix: "",
      reference_padding: 5,
      description: "",
      metadata_fields: [] as Array<{
        label: string; key: string; field_type: string;
        is_required: boolean; order: number;
      }>,
    },
  });

  const { fields, append, remove } = useFieldArray({ control, name: "metadata_fields" });

  const mutation = useMutation({
    mutationFn: (data: unknown) => documentTypesAPI.create(data),
    onSuccess: () => {
      toast.success("Document type created");
      qc.invalidateQueries({ queryKey: ["document-types"] });
      onDone();
    },
    onError: () => toast.error("Failed to create document type"),
  });

  return (
    <form onSubmit={handleSubmit((v) => mutation.mutate(v))} className="space-y-5">
      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="label">Type name <span className="text-red-500">*</span></label>
          <input {...register("name", { required: true })} className="input" placeholder="e.g. Supplier Invoice" />
        </div>
        <div>
          <label className="label">Code <span className="text-red-500">*</span></label>
          <input {...register("code", { required: true })} className="input" placeholder="e.g. INV" />
        </div>
      </div>
      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="label">Reference prefix <span className="text-red-500">*</span></label>
          <input {...register("reference_prefix", { required: true })} className="input" placeholder="INV" />
        </div>
        <div>
          <label className="label">Ref. padding digits</label>
          <input {...register("reference_padding", { valueAsNumber: true })} type="number" min={1} max={10} className="input" />
        </div>
      </div>
      <div>
        <label className="label">Description</label>
        <textarea {...register("description")} rows={2} className="input" placeholder="Brief description…" />
      </div>

      {/* Dynamic metadata fields */}
      <div className="border border-gray-200 rounded-lg p-4 space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="font-medium text-gray-800 text-sm">Custom metadata fields</h3>
          <button
            type="button"
            onClick={() => append({ label: "", key: "", field_type: "text", is_required: false, order: fields.length })}
            className="btn-secondary text-xs px-2 py-1"
          >
            <Plus className="w-3.5 h-3.5" /> Add field
          </button>
        </div>
        {fields.map((field, index) => (
          <div key={field.id} className="grid grid-cols-12 gap-2 items-center bg-gray-50 rounded-lg p-3">
            <div className="col-span-3">
              <input {...register(`metadata_fields.${index}.label`)} className="input text-sm" placeholder="Label" />
            </div>
            <div className="col-span-3">
              <input {...register(`metadata_fields.${index}.key`)} className="input text-sm" placeholder="field_key" />
            </div>
            <div className="col-span-3">
              <select {...register(`metadata_fields.${index}.field_type`)} className="input text-sm">
                {FIELD_TYPES.map((t) => (
                  <option key={t.value} value={t.value}>{t.label}</option>
                ))}
              </select>
            </div>
            <div className="col-span-2 flex items-center gap-1.5">
              <input {...register(`metadata_fields.${index}.is_required`)} type="checkbox" className="w-4 h-4 rounded" />
              <span className="text-xs text-gray-600">Required</span>
            </div>
            <div className="col-span-1 flex justify-end">
              <button type="button" onClick={() => remove(index)} className="text-gray-400 hover:text-red-500">
                <Trash2 className="w-4 h-4" />
              </button>
            </div>
          </div>
        ))}
        {!fields.length && (
          <p className="text-xs text-gray-400 text-center py-3">
            No custom fields yet. Common core fields (supplier, amount, date) are always included.
          </p>
        )}
      </div>

      <div className="flex gap-3">
        <button type="submit" disabled={mutation.isPending} className="btn-primary">
          {mutation.isPending && <Loader2 className="w-4 h-4 animate-spin" />}
          Create document type
        </button>
        <button type="button" onClick={onDone} className="btn-secondary">Cancel</button>
      </div>
    </form>
  );
}

export default function AdminPage() {
  const [showNewTypeForm, setShowNewTypeForm] = useState(false);
  const [activeTab, setActiveTab] = useState<"types" | "workflows" | "users">("types");

  const { data: docTypes, isLoading } = useQuery<DocumentType[]>({
    queryKey: ["document-types"],
    queryFn: () => documentTypesAPI.list().then((r) => r.data.results),
  });

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Administration</h1>
        <p className="text-gray-500 text-sm mt-1">
          Manage document types, workflows, and system settings.
        </p>
      </div>

      {/* Tab bar */}
      <div className="border-b border-gray-200">
        <nav className="-mb-px flex gap-0">
          {[
            { id: "types", label: "Document types" },
            { id: "workflows", label: "Workflow templates" },
            { id: "users", label: "Users & roles" },
          ].map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id as typeof activeTab)}
              className={`px-4 py-2.5 text-sm font-medium border-b-2 transition-colors ${
                activeTab === tab.id
                  ? "border-brand-500 text-brand-600"
                  : "border-transparent text-gray-500 hover:text-gray-700"
              }`}
            >
              {tab.label}
            </button>
          ))}
        </nav>
      </div>

      {activeTab === "types" && (
        <div className="space-y-4">
          <div className="flex justify-between items-center">
            <p className="text-sm text-gray-600">{docTypes?.length ?? 0} document types configured</p>
            <button onClick={() => setShowNewTypeForm(!showNewTypeForm)} className="btn-primary">
              <Plus className="w-4 h-4" />
              {showNewTypeForm ? "Cancel" : "New document type"}
            </button>
          </div>

          {showNewTypeForm && (
            <div className="card p-6">
              <h2 className="font-semibold text-gray-900 mb-5">Create document type</h2>
              <DocumentTypeForm onDone={() => setShowNewTypeForm(false)} />
            </div>
          )}

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {isLoading &&
              Array.from({ length: 6 }).map((_, i) => (
                <div key={i} className="card p-5 space-y-3 animate-pulse">
                  <div className="h-5 bg-gray-100 rounded w-2/3" />
                  <div className="h-4 bg-gray-100 rounded w-1/2" />
                  <div className="h-4 bg-gray-100 rounded w-3/4" />
                </div>
              ))}
            {docTypes?.map((type) => (
              <div key={type.id} className="card p-5 space-y-3">
                <div className="flex items-start justify-between">
                  <div>
                    <h3 className="font-semibold text-gray-900">{type.name}</h3>
                    <p className="text-xs font-mono text-gray-500 mt-0.5">
                      {type.reference_prefix}-{"0".repeat(type.reference_padding ?? 5)}
                    </p>
                  </div>
                  <span className="badge bg-brand-50 text-brand-700">{type.code}</span>
                </div>
                {type.description && (
                  <p className="text-sm text-gray-500 line-clamp-2">{type.description}</p>
                )}
                <div className="text-xs text-gray-400">
                  {type.metadata_fields?.length ?? 0} custom field{type.metadata_fields?.length !== 1 ? "s" : ""}
                </div>
                <div className="flex gap-2 pt-1">
                  <button className="btn-secondary text-xs px-2 py-1">
                    <Edit2 className="w-3 h-3" /> Edit
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {activeTab === "workflows" && (
        <div className="card p-8 text-center">
          <GitBranch className="w-10 h-10 text-gray-200 mx-auto mb-3" />
          <p className="font-medium text-gray-700">Workflow builder</p>
          <p className="text-sm text-gray-400 mt-1">
            Create multi-step approval chains and assign them to document types.
          </p>
          <button className="btn-primary mt-4">
            <Plus className="w-4 h-4" /> Create workflow template
          </button>
        </div>
      )}

      {activeTab === "users" && (
        <div className="card p-8 text-center">
          <Settings className="w-10 h-10 text-gray-200 mx-auto mb-3" />
          <p className="font-medium text-gray-700">User management</p>
          <p className="text-sm text-gray-400 mt-1">
            Manage users, roles, departments, and LDAP sync settings.
          </p>
        </div>
      )}
    </div>
  );
}
