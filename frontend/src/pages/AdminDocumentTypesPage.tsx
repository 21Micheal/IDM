import { useEffect, useMemo, useState } from "react";
import { extractApiError } from "@/lib/apiError";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useForm, useFieldArray, Controller } from "react-hook-form";
import CustomListbox from "@/components/ui/CustomListbox";
import {
  AlertCircle, Copy, FileText, GripVertical, Link2, Loader2, Plus,
  Save, Search, Shield, Trash2, X,
} from "lucide-react";
import { documentApi, documentTypesAPI, normalizeListResponse } from "../services/api";
import { toast } from "@/components/ui/vault-toast";
import { cn } from "../lib/utils";
import type { DocumentRelationType, DocumentRelationshipRule, DocumentType } from "@/types";
import {
  applyDocumentTypeConfigToDescription,
  deriveDocumentTypeConfig,
  stripTypeConfigMarkers,
} from "@/lib/documentTypeConfig";

const FIELD_TYPES = [
  { value: "text", label: "Text" },
  { value: "varchar", label: "VARCHAR" },
  { value: "number", label: "Number" },
  { value: "date", label: "Date" },
  { value: "currency", label: "Currency" },
  { value: "select", label: "Select" },
  { value: "boolean", label: "Yes / No" },
  { value: "textarea", label: "Long text" },
];

const RELATIONSHIP_TYPES: Array<{ value: DocumentRelationType; label: string }> = [
  { value: "references", label: "References" },
  { value: "supports", label: "Supports" },
  { value: "supersedes", label: "Supersedes" },
  { value: "linked-to", label: "Linked to" },
];

const CORE_DEFAULT_FIELDS: MetadataFieldForm[] = [
  { label: "Supplier / Vendor", field_key: "supplier", field_type: "text", is_required: false, is_unique: false, select_options_raw: "", help_text: "Business partner", order: 0 },
  { label: "Amount", field_key: "amount", field_type: "currency", is_required: false, is_unique: false, select_options_raw: "", help_text: "Document total amount", order: 1 },
  { label: "Currency", field_key: "currency", field_type: "select", is_required: false, is_unique: false, select_options_raw: "KES, USD, EUR, GBP, UGX, TZS, NGN, ZAR", help_text: "ISO currency code", order: 2 },
  { label: "Document Date", field_key: "document_date", field_type: "date", is_required: false, is_unique: false, select_options_raw: "", help_text: "Date on the document", order: 3 },
  { label: "Due Date", field_key: "due_date", field_type: "date", is_required: false, is_unique: false, select_options_raw: "", help_text: "Payment due date", order: 4 },
];

const STANDARD_REFERENCE_FIELDS = [
  { key: "reference_number", label: "Document reference / number" },
  { key: "po_number", label: "PO Number" },
  { key: "transaction_reference", label: "Transaction Reference" },
  { key: "supplier", label: "Supplier / Vendor" },
  { key: "amount", label: "Amount" },
  { key: "document_date", label: "Document Date" },
];

type TabId = "general" | "attributes" | "relationships" | "security";

interface MetadataFieldForm {
  label: string;
  field_key: string;
  field_type: string;
  is_required: boolean;
  is_unique: boolean;
  select_options_raw: string;
  help_text: string;
  order: number;
}

interface RelationshipRuleForm {
  target_document_type: string;
  relation_type: DocumentRelationType;
  source_field_key: string;
  target_field_key: string;
  match_operator: "equals";
  description: string;
  is_active: boolean;
  require_confirmation: boolean;
}

interface DocTypeForm {
  name: string;
  code: string;
  reference_prefix: string;
  reference_padding: number;
  title_field: string;
  description: string;
  is_personal_type: boolean;
  metadata_mode: "admin_defined" | "user_defined";
  max_file_size_mb: number;
  metadata_fields: MetadataFieldForm[];
  relationship_rules: RelationshipRuleForm[];
}

const inputCls = "h-9 w-full border border-[#AEB5BB] bg-white px-3 text-sm text-[#1F2933] outline-none focus:border-[#287EAD] focus:ring-1 focus:ring-[#287EAD]";
const textAreaCls = "w-full border border-[#AEB5BB] bg-white px-3 py-2 text-sm text-[#1F2933] outline-none focus:border-[#287EAD] focus:ring-1 focus:ring-[#287EAD]";

function coreDefaultFields() {
  return CORE_DEFAULT_FIELDS.map((field) => ({ ...field }));
}

function toFieldKey(label: string): string {
  return label
    .toLowerCase()
    .trim()
    .replace(/\s+/g, "_")
    .replace(/[^a-z0-9_]/g, "")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "");
}

function buildPayload(values: DocTypeForm) {
  const isPersonal = values.is_personal_type;
  const metadataMode = isPersonal ? "user_defined" : values.metadata_mode;
  return {
    name: values.name,
    code: values.code,
    reference_prefix: values.reference_prefix,
    reference_padding: values.reference_padding,
    title_field: values.title_field || "filename",
    description: applyDocumentTypeConfigToDescription(values.description, {
      isPersonalType: isPersonal,
      metadataMode,
    }),
    is_personal_type: isPersonal,
    metadata_mode: metadataMode,
    max_file_size_mb: values.max_file_size_mb || 25,
    metadata_fields: metadataMode === "admin_defined"
      ? values.metadata_fields.map((field, index) => ({
          label: field.label,
          field_key: field.field_key,
          field_type: field.field_type,
          is_required: field.is_required,
          is_unique: field.is_unique,
          help_text: field.help_text,
          order: index,
          select_options: field.field_type === "select" && field.select_options_raw
            ? field.select_options_raw.split(",").map((item) => item.trim()).filter(Boolean)
            : [],
        }))
      : [],
    relationship_rules: values.relationship_rules
      .filter((rule) => rule.target_document_type && rule.source_field_key && rule.target_field_key)
      .map((rule) => ({
        ...rule,
        description: rule.description || `${rule.source_field_key} equals ${rule.target_field_key}`,
      })),
  };
}

function fieldOptions(type?: DocumentType | null) {
  const configured = (type?.metadata_fields ?? []).map((field) => ({
    key: field.key ?? field.field_key,
    label: field.label,
  }));
  const merged = [...STANDARD_REFERENCE_FIELDS, ...configured];
  const seen = new Set<string>();
  return merged.filter((field) => {
    if (!field.key || seen.has(field.key)) return false;
    seen.add(field.key);
    return true;
  });
}

export default function AdminDocumentTypesPage() {
  const qc = useQueryClient();
  const [editingId, setEditingId] = useState<string | "new" | null>(null);
  const [activeTab, setActiveTab] = useState<TabId>("general");
  const [search, setSearch] = useState("");

  // ── Duplicate dialog state ────────────────────────────────────────────────
  const [duplicateDialogOpen, setDuplicateDialogOpen] = useState(false);
  const [duplicateName, setDuplicateName] = useState("");
  const [duplicateCode, setDuplicateCode] = useState("");

  const { data: types = [], isLoading } = useQuery<unknown, Error, DocumentType[]>({
    queryKey: ["document-types"],
    queryFn: () => documentApi.types().then((response) => response.data as unknown),
    select: (data) => normalizeListResponse<DocumentType>(data),
  });

  const form = useForm<DocTypeForm>({
    defaultValues: {
      name: "", code: "", reference_prefix: "", reference_padding: 5,
      title_field: "filename",
      description: "", is_personal_type: false, metadata_mode: "admin_defined",
      max_file_size_mb: 25,
      metadata_fields: [], relationship_rules: [],
    },
  });

  const { fields: metadataFields, append: appendMetadataField, remove: removeMetadataField } = useFieldArray({
    control: form.control,
    name: "metadata_fields",
  });
  const { fields: relationshipRules, append: appendRelationshipRule, remove: removeRelationshipRule } = useFieldArray({
    control: form.control,
    name: "relationship_rules",
  });

  const isPersonalType = form.watch("is_personal_type");
  const metadataMode = form.watch("metadata_mode");
  const useAdminMetadata = !isPersonalType && metadataMode === "admin_defined";
  const watchedRules = form.watch("relationship_rules");
  const selectedType = types.find((type) => type.id === editingId) ?? null;
  const filteredTypes = useMemo(
    () => types.filter((type) => `${type.name} ${type.code}`.toLowerCase().includes(search.toLowerCase())),
    [types, search],
  );

  useEffect(() => {
    if (isPersonalType && form.getValues("metadata_mode") !== "user_defined") {
      form.setValue("metadata_mode", "user_defined", { shouldDirty: true });
    }
  }, [isPersonalType, form]);

  const saveMutation = useMutation({
    mutationFn: (values: DocTypeForm) => {
      const payload = buildPayload(values);
      return editingId === "new"
        ? documentTypesAPI.create(payload)
        : documentTypesAPI.update(editingId as string, payload);
    },
    onSuccess: (_, values) => {
      toast.success(editingId === "new" ? `Document type "${values.name}" created.` : `Document type "${values.name}" updated.`);
      qc.invalidateQueries({ queryKey: ["document-types"] });
      if (editingId === "new") setEditingId(null);
    },
    onError: (err: any) => {
      const data = err?.response?.data;
      const message = data
        ? Object.entries(data).map(([field, msgs]) => `${field}: ${Array.isArray(msgs) ? msgs.join(", ") : String(msgs)}`).join(" | ")
        : "Failed to save document type.";
      toast.error(message);
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (type: DocumentType) => documentTypesAPI.delete(type.id),
    onSuccess: (_, type) => {
      toast.success(`Document type "${type.name}" deleted.`);
      qc.invalidateQueries({ queryKey: ["document-types"] });
      if (editingId === type.id) setEditingId(null);
    },
    onError: (err: any) => toast.error(extractApiError(err, "Failed to delete document type.")),
  });

  const duplicateMutation = useMutation({
    mutationFn: ({ id, name, code }: { id: string; name: string; code: string }) =>
      documentTypesAPI.duplicate(id, { name, code }),
    onSuccess: (response) => {
      const newType = response.data as DocumentType;
      toast.success(`Document type "${newType.name}" created as a duplicate.`);
      qc.invalidateQueries({ queryKey: ["document-types"] });
      setDuplicateDialogOpen(false);
      // Auto-open the new type for editing once the list refreshes
      setTimeout(() => openEdit(newType), 300);
    },
    onError: (err: any) => {
      const data = err?.response?.data;
      const message = data
        ? Object.entries(data).map(([field, msgs]) =>
            `${field}: ${Array.isArray(msgs) ? msgs.join(", ") : String(msgs)}`
          ).join(" | ")
        : "Failed to duplicate document type.";
      toast.error(message);
    },
  });

  const openDuplicateDialog = (type: DocumentType) => {
    const baseCode = type.code.toUpperCase().replace(/[^A-Z0-9]/g, "_");
    setDuplicateName(`Copy of ${type.name}`);
    setDuplicateCode(`${baseCode}_COPY`.slice(0, 20));
    setDuplicateDialogOpen(true);
  };

  const openNew = () => {
    form.reset({
      name: "", code: "", reference_prefix: "", reference_padding: 5,
      title_field: "filename",
      description: "", is_personal_type: false, metadata_mode: "admin_defined",
      metadata_fields: coreDefaultFields(), relationship_rules: [],
    });
    setEditingId("new");
    setActiveTab("general");
  };

  const openEdit = (type: DocumentType) => {
    const config = deriveDocumentTypeConfig(type);
    form.reset({
      name: type.name,
      code: type.code,
      reference_prefix: type.reference_prefix,
      reference_padding: type.reference_padding ?? 5,
      title_field: type.title_field || "filename",
      description: stripTypeConfigMarkers(type.description ?? ""),
      is_personal_type: config.isPersonalType,
      metadata_mode: config.metadataMode,
      max_file_size_mb: type.max_file_size_mb ?? 25,
      metadata_fields: (type.metadata_fields ?? []).map((field) => ({
        label: field.label,
        field_key: field.key ?? field.field_key,
        field_type: field.field_type,
        is_required: field.is_required,
        is_unique: field.is_unique ?? false,
        help_text: field.help_text ?? "",
        order: field.order,
        select_options_raw: (field.select_options ?? []).join(", "),
      })),
      relationship_rules: (type.relationship_rules ?? []).map((rule: DocumentRelationshipRule) => ({
        target_document_type: rule.target_document_type,
        relation_type: rule.relation_type,
        source_field_key: rule.source_field_key,
        target_field_key: rule.target_field_key,
        match_operator: rule.match_operator ?? "equals",
        description: rule.description ?? "",
        is_active: rule.is_active,
        require_confirmation: rule.require_confirmation ?? true,
      })),
    });
    setEditingId(type.id);
    setActiveTab("general");
  };

  const addMetadataField = () => {
    appendMetadataField({
      label: "", field_key: "", field_type: "text", is_required: false, is_unique: false,
      select_options_raw: "", help_text: "", order: metadataFields.length,
    });
  };

  const addRelationshipRule = () => {
    const target = types.find((type) => type.id !== editingId);
    appendRelationshipRule({
      target_document_type: target?.id ?? "",
      relation_type: "references",
      source_field_key: "po_number",
      target_field_key: "po_number",
      match_operator: "equals",
      description: "",
      is_active: true,
      require_confirmation: true,
    });
  };

  const tabs: Array<{ id: TabId; label: string; icon: typeof FileText }> = [
    { id: "general", label: "General", icon: FileText },
    { id: "attributes", label: `Details (${metadataFields.length})`, icon: GripVertical },
    { id: "relationships", label: `Related documents (${relationshipRules.length})`, icon: Link2 },
    { id: "security", label: "Security", icon: Shield },
  ];

  return (
    <>
    <div className="min-h-[calc(100vh-4rem)] bg-[#EEF0F2]">
      <div className="border-b border-[#1E6F99] bg-[#287EAD] px-6 py-4 text-white">
        <div className="flex items-center justify-between gap-4">
          <div>
            <h1 className="text-xl font-semibold">Document Type</h1>
            <p className="text-sm text-white/75">Configure metadata, references, and document linking behavior.</p>
          </div>
          <div className="flex items-center gap-2">
            <button type="button" onClick={openNew} className="inline-flex items-center gap-2 border border-white/25 px-3 py-2 text-sm hover:bg-white/10">
              <Plus className="h-4 w-4" /> New Document Type
            </button>
            <button
              type="button"
              onClick={form.handleSubmit((values) => saveMutation.mutate(values))}
              disabled={!editingId || saveMutation.isPending}
              className="inline-flex items-center gap-2 border border-white/25 px-3 py-2 text-sm hover:bg-white/10 disabled:opacity-45"
            >
              {saveMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
              Save Changes
            </button>
          </div>
        </div>
      </div>

      <div className="grid min-h-[calc(100vh-9rem)] grid-cols-[290px_1fr]">
        <aside className="border-r border-[#C8CDD2] bg-[#F6F7F8]">
          <div className="border-b border-[#C8CDD2] p-3">
            <div className="flex h-9 items-center gap-2 border border-[#C8CDD2] bg-white px-2">
              <Search className="h-4 w-4 text-[#5E6870]" />
              <input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Type search term here"
                className="h-full min-w-0 flex-1 bg-transparent text-sm outline-none"
              />
            </div>
          </div>
          <div className="divide-y divide-[#D3D7DA]">
            {isLoading ? (
              <div className="p-4 text-sm text-[#5E6870]">Loading…</div>
            ) : filteredTypes.length === 0 ? (
              <div className="p-6 text-center text-sm text-[#5E6870]">
                <AlertCircle className="mx-auto mb-2 h-5 w-5 opacity-50" />
                No document types found.
              </div>
            ) : filteredTypes.map((type) => (
              <button
                key={type.id}
                type="button"
                onClick={() => openEdit(type)}
                className={cn(
                  "block w-full px-4 py-3 text-left text-sm transition-colors",
                  editingId === type.id ? "bg-[#348FBE] font-semibold text-white" : "bg-[#F6F7F8] text-[#1F2933] hover:bg-white",
                )}
              >
                <span className="block truncate">{type.name}</span>
                <span className={cn("mt-1 block truncate text-xs", editingId === type.id ? "text-white/75" : "text-[#5E6870]")}>
                  {type.code} · {(type.metadata_fields ?? []).length} details
                </span>
              </button>
            ))}
          </div>
        </aside>

        <main className="p-6">
          {!editingId ? (
            <div className="border border-[#C8CDD2] bg-white p-10 text-center text-sm text-[#5E6870]">
              Select a document type from the list or create a new one.
            </div>
          ) : (
            <form onSubmit={form.handleSubmit((values) => saveMutation.mutate(values))} className="space-y-5">
              <div className="h-10 bg-[#348FBE]" />

              <div className="flex items-center justify-between border border-[#C8CDD2] bg-white px-4 py-3">
                <div>
                  <p className="text-sm font-semibold text-[#1F2933]">
                    {editingId === "new" ? "New document type" : form.watch("name") || selectedType?.name}
                  </p>
                  <p className="text-xs text-[#5E6870]">Changes are saved only when you click Save Changes.</p>
                </div>
                <div className="flex items-center gap-2 text-sm">
                  {editingId !== "new" && selectedType && (
                    <>
                      <button
                        type="button"
                        onClick={() => openDuplicateDialog(selectedType)}
                        className="inline-flex items-center gap-1.5 px-2 py-1 text-[#5E6870] hover:text-[#287EAD]"
                      >
                        <Copy className="h-4 w-4" /> Duplicate
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          if (window.confirm(`Delete document type "${selectedType.name}"?`)) deleteMutation.mutate(selectedType);
                        }}
                        className="inline-flex items-center gap-1.5 px-2 py-1 text-[#5E6870] hover:text-red-700"
                      >
                        <Trash2 className="h-4 w-4" /> Delete
                      </button>
                    </>
                  )}
                  <button type="button" onClick={() => setEditingId(null)} className="p-1 text-[#5E6870] hover:text-[#1F2933]">
                    <X className="h-4 w-4" />
                  </button>
                </div>
              </div>

              <div className="border-b border-[#C8CDD2]">
                <div className="flex">
                  {tabs.map((tab) => {
                    const Icon = tab.icon;
                    return (
                      <button
                        key={tab.id}
                        type="button"
                        onClick={() => setActiveTab(tab.id)}
                        className={cn(
                          "inline-flex items-center gap-2 border border-b-0 border-[#C8CDD2] px-4 py-2 text-sm",
                          activeTab === tab.id ? "bg-white text-[#287EAD]" : "bg-[#EEF0F2] text-[#1F2933] hover:bg-white",
                        )}
                      >
                        <Icon className="h-4 w-4" />
                        {tab.label}
                      </button>
                    );
                  })}
                </div>
              </div>

              {activeTab === "general" && (
                <section className="max-w-5xl space-y-6 bg-[#EEF0F2] px-4 py-3">
                  <div className="grid max-w-3xl grid-cols-[220px_1fr] gap-x-6 gap-y-4 text-sm">

                    {/* Display name ─ what users see everywhere */}
                    <label className="pt-2 text-[#5E6870]">Display name</label>
                    <div>
                      <input
                        {...form.register("name", { required: true })}
                        className={inputCls}
                        placeholder="e.g. Supplier Invoice"
                      />
                      <p className="mt-1.5 text-xs text-[#8C969E]">Human-readable name shown throughout the system</p>
                    </div>

                    {/* Code ─ short machine identifier */}
                    <label className="pt-2 text-[#5E6870]">Code</label>
                    <div>
                      <input
                        {...form.register("code", { required: true })}
                        className={cn(inputCls, "font-mono")}
                        placeholder="e.g. INV"
                      />
                      <p className="mt-1.5 text-xs text-[#8C969E]">Unique short system identifier used in logs and file storage paths</p>
                    </div>

                    {/* Reference prefix ─ prefix for auto-generated IDs */}
                    <label className="pt-2 text-[#5E6870]">Reference prefix</label>
                    <div>
                      <input
                        {...form.register("reference_prefix", { required: true })}
                        className={cn(inputCls, "font-mono tracking-widest uppercase")}
                        placeholder="e.g. INV"
                      />
                      <p className="mt-1.5 text-xs text-[#8C969E]">
                        Prefix used when generating document IDs —{" "}
                        <span className="font-mono font-semibold">INV</span> → <span className="font-mono">INV-00001</span>,{" "}
                        <span className="font-mono">INV-00002</span> …
                      </p>
                    </div>

                    {/* Reference padding ─ zero-padding width */}
                    <label className="pt-2 text-[#5E6870]">Reference padding</label>
                    <div>
                      <input
                        {...form.register("reference_padding", { valueAsNumber: true })}
                        type="number" min={3} max={8}
                        className={inputCls}
                      />
                      <p className="mt-1.5 text-xs text-[#8C969E]">Digits in the numeric part of IDs (3–8) — 5 → 00001 · 4 → 0001</p>
                    </div>

                    {/* Max file size ─ per document type */}
                    <label className="pt-2 text-[#5E6870]">Max file size (MB)</label>
                    <div>
                      <input
                        {...form.register("max_file_size_mb", { valueAsNumber: true })}
                        type="number" min={1} max={500}
                        className={inputCls}
                      />
                      <p className="mt-1.5 text-xs text-[#8C969E]">Largest upload allowed for this type (including new versions). Default 25 MB.</p>
                    </div>

                    {/* Document title ─ which source names documents of this type */}
                    <label className="pt-2 text-[#5E6870]">Document title</label>
                    <div>
                      <Controller
                        name="title_field"
                        control={form.control}
                        render={({ field: f }) => (
                          <CustomListbox
                            value={String(f.value ?? "filename")}
                            onChange={f.onChange}
                            options={[
                              { value: "filename", label: "File name (default)" },
                              ...fieldOptions({ ...(selectedType ?? {} as DocumentType), metadata_fields: form.watch("metadata_fields") as any }).map((field) => ({ value: field.key, label: field.label })),
                            ]}
                            buttonClassName={inputCls}
                            ariaLabel="Document title"
                          />
                        )}
                      />
                      <p className="mt-1.5 text-xs text-[#8C969E]">How documents of this type are named — by default the uploaded file name; or pick a field like Document Name, Supplier, or Reference Number</p>
                    </div>

                    <label className="pt-2 text-[#5E6870]">Description</label>
                    <textarea {...form.register("description")} rows={3} className={textAreaCls} />
                  </div>

                  <div className="border-t border-[#C8CDD2] pt-5">
                    <div className="space-y-3 text-sm text-[#1F2933]">
                      <label className="flex items-center gap-2">
                        <input type="checkbox" {...form.register("is_personal_type")} />
                        Personal document type
                      </label>
                      <label className="flex items-center gap-2">
                        <input type="checkbox" checked readOnly />
                        Text searchable
                      </label>
                      <div className="max-w-xs">
                        <label className="mb-1 block text-xs text-[#5E6870]">Metadata mode</label>
                        <Controller
                          name="metadata_mode"
                          control={form.control}
                          render={({ field: f }) => (
                            <CustomListbox
                              value={String(f.value ?? "admin_defined")}
                              onChange={f.onChange}
                              options={[
                                { value: "admin_defined", label: "Admin-defined attributes" },
                                { value: "user_defined", label: "User-defined attributes" },
                              ]}
                              buttonClassName={inputCls}
                              ariaLabel="Metadata mode"
                              disabled={isPersonalType}
                            />
                          )}
                        />
                      </div>
                    </div>
                  </div>
                </section>
              )}

              {activeTab === "attributes" && (
                <section className="grid grid-cols-[minmax(360px,560px)_1fr] gap-6">
                  <div className="border border-[#A7CDE3] bg-[#EEF6FB] p-4 text-sm text-[#287EAD] lg:col-span-2">
                    Claude extraction reads these admin-defined details from the database and tries to fill each field during scan.
                    Use clear labels (e.g. &quot;Goods Receipt note number&quot;) so the model can map visible document values to the right key.
                  </div>
                  <div className="border border-[#C8CDD2] bg-white">
                    <div className="flex items-center justify-between border-b border-[#C8CDD2] px-4 py-3">
                      <p className="text-sm font-semibold text-[#1F2933]">Details</p>
                      <button type="button" onClick={addMetadataField} disabled={!useAdminMetadata} className="p-1 text-[#287EAD] disabled:opacity-40">
                        <Plus className="h-4 w-4" />
                      </button>
                    </div>
                    <div className="max-h-[520px] overflow-auto">
                      {!useAdminMetadata ? (
                        <div className="p-5 text-sm text-[#5E6870]">Admin-defined metadata is disabled for this type.</div>
                      ) : metadataFields.length === 0 ? (
                        <div className="p-5 text-sm text-[#5E6870]">No details configured.</div>
                      ) : metadataFields.map((field, index) => (
                        <div key={field.id} className="border-b border-[#D3D7DA] p-3">
                          <div className="mb-3 flex items-center justify-between">
                            <div className="flex items-center gap-2 text-sm font-semibold text-[#1F2933]">
                              <GripVertical className="h-4 w-4 text-[#5E6870]" />
                              {form.watch(`metadata_fields.${index}.label`) || `Detail ${index + 1}`}
                            </div>
                            <button type="button" onClick={() => removeMetadataField(index)} className="text-[#5E6870] hover:text-red-700">
                              <Trash2 className="h-4 w-4" />
                            </button>
                          </div>
                          <div className="grid grid-cols-2 gap-3">
                            <input
                              {...form.register(`metadata_fields.${index}.label`, {
                                required: true,
                                onChange: (event) => form.setValue(`metadata_fields.${index}.field_key`, toFieldKey(event.target.value), { shouldDirty: true }),
                              })}
                              className={inputCls}
                              placeholder="Detail label"
                            />
                            <input {...form.register(`metadata_fields.${index}.field_key`, { required: true })} className={cn(inputCls, "font-mono text-xs")} readOnly />
                            <Controller
                              name={`metadata_fields.${index}.field_type`}
                              control={form.control}
                              render={({ field: f }) => (
                                <CustomListbox
                                  value={String(f.value ?? "text")}
                                  onChange={f.onChange}
                                  options={FIELD_TYPES.map((type) => ({ value: type.value, label: type.label }))}
                                  buttonClassName={inputCls}
                                  ariaLabel="Metadata field type"
                                />
                              )}
                            />
                            <label className="flex items-center gap-2 text-sm text-[#1F2933]">
                              <input type="checkbox" {...form.register(`metadata_fields.${index}.is_required`)} />
                              Required
                            </label>
                            <label className="col-span-2 flex items-center gap-2 text-sm text-[#1F2933]">
                              <input type="checkbox" {...form.register(`metadata_fields.${index}.is_unique`)} />
                              <span>
                                Unique
                                <span className="ml-1 text-xs text-[#8C969E]">— value can&apos;t match any other document of this type (e.g. a reference number)</span>
                              </span>
                            </label>
                          </div>
                          {form.watch(`metadata_fields.${index}.field_type`) === "select" && (
                            <input {...form.register(`metadata_fields.${index}.select_options_raw`)} className={cn(inputCls, "mt-3")} placeholder="Options, comma-separated" />
                          )}
                          <input {...form.register(`metadata_fields.${index}.help_text`)} className={cn(inputCls, "mt-3")} placeholder="Help text" />
                        </div>
                      ))}
                    </div>
                  </div>
                </section>
              )}

              {activeTab === "relationships" && (
                <section className="grid grid-cols-[minmax(360px,560px)_minmax(300px,420px)] gap-6">
                  <div className="border border-[#C8CDD2] bg-white">
                    <div className="flex items-center justify-between border-b border-[#C8CDD2] px-4 py-3">
                      <div>
                        <p className="text-sm font-semibold text-[#1F2933]">Items in bundle</p>
                        <p className="mt-1 text-xs text-[#5E6870]">Define how this type discovers related documents.</p>
                      </div>
                      <button type="button" onClick={addRelationshipRule} className="p-1 text-[#287EAD]">
                        <Plus className="h-4 w-4" />
                      </button>
                    </div>
                    <div className="divide-y divide-[#D3D7DA]">
                      {relationshipRules.length === 0 ? (
                        <div className="p-5 text-sm text-[#5E6870]">No related document rules configured.</div>
                      ) : relationshipRules.map((rule, index) => {
                        const target = types.find((type) => type.id === watchedRules?.[index]?.target_document_type);
                        return (
                          <div key={rule.id} className="bg-white p-3">
                            <div className="flex items-center justify-between">
                              <div>
                                <p className="text-sm font-semibold text-[#1F2933]">
                                  {target?.name || "Select target type"}
                                </p>
                                <p className="mt-1 text-xs text-[#5E6870]">
                                  {watchedRules?.[index]?.source_field_key || "source field"} = {watchedRules?.[index]?.target_field_key || "target field"}
                                </p>
                              </div>
                              <button type="button" onClick={() => removeRelationshipRule(index)} className="text-[#5E6870] hover:text-red-700">
                                <Trash2 className="h-4 w-4" />
                              </button>
                            </div>
                            <div className="mt-3 grid grid-cols-2 gap-3">
                              <Controller
                                name={`relationship_rules.${index}.target_document_type`}
                                control={form.control}
                                render={({ field: f }) => (
                                  <CustomListbox
                                    value={String(f.value ?? "")}
                                    onChange={f.onChange}
                                    options={[
                                      { value: "", label: "Target document type" },
                                      ...types.filter((type) => type.id !== editingId).map((type) => ({ value: type.id, label: type.name })),
                                    ]}
                                    buttonClassName={inputCls}
                                    ariaLabel="Relationship target document type"
                                  />
                                )}
                              />
                              <Controller
                                name={`relationship_rules.${index}.relation_type`}
                                control={form.control}
                                render={({ field: f }) => (
                                  <CustomListbox
                                    value={String(f.value ?? RELATIONSHIP_TYPES[0].value)}
                                    onChange={f.onChange}
                                    options={RELATIONSHIP_TYPES.map((type) => ({ value: type.value, label: type.label }))}
                                    buttonClassName={inputCls}
                                    ariaLabel="Relationship type"
                                  />
                                )}
                              />
                              <Controller
                                name={`relationship_rules.${index}.source_field_key`}
                                control={form.control}
                                render={({ field: f }) => (
                                  <CustomListbox
                                    value={String(f.value ?? "")}
                                    onChange={f.onChange}
                                    options={fieldOptions({ ...(selectedType ?? {} as DocumentType), metadata_fields: form.watch("metadata_fields") as any }).map((field) => ({ value: field.key, label: field.label }))}
                                    buttonClassName={inputCls}
                                    ariaLabel="Relationship source field"
                                  />
                                )}
                              />
                              <Controller
                                name={`relationship_rules.${index}.target_field_key`}
                                control={form.control}
                                render={({ field: f }) => (
                                  <CustomListbox
                                    value={String(f.value ?? "")}
                                    onChange={f.onChange}
                                    options={fieldOptions(target).map((field) => ({ value: field.key, label: field.label }))}
                                    buttonClassName={inputCls}
                                    ariaLabel="Relationship target field"
                                  />
                                )}
                              />
                              <Controller
                                name={`relationship_rules.${index}.match_operator`}
                                control={form.control}
                                render={({ field: f }) => (
                                  <CustomListbox
                                    value={String(f.value ?? "equals")}
                                    onChange={f.onChange}
                                    options={[{ value: "equals", label: "= Equal" }]}
                                    buttonClassName={inputCls}
                                    ariaLabel="Match operator"
                                  />
                                )}
                              />
                              <label className="flex items-center gap-2 text-sm text-[#1F2933]">
                                <input type="checkbox" {...form.register(`relationship_rules.${index}.is_active`)} />
                                Active
                              </label>
                              <label className="col-span-2 flex items-center gap-2 text-sm text-[#1F2933]">
                                <input type="checkbox" {...form.register(`relationship_rules.${index}.require_confirmation`)} />
                                Require user confirmation before linking
                              </label>
                            </div>
                            <input {...form.register(`relationship_rules.${index}.description`)} className={cn(inputCls, "mt-3")} placeholder="Description shown with suggestions" />
                          </div>
                        );
                      })}
                    </div>
                  </div>
                  <div className="border border-[#C8CDD2] bg-white p-4 text-sm text-[#5E6870]">
                    <p className="font-semibold text-[#1F2933]">How matching works</p>
                    <p className="mt-2">
                      When OCR or manual metadata contains the configured source field, the system looks for target documents where the target field has the same value.
                    </p>
                    <p className="mt-2">
                      Matches are presented as suggested links on the document detail page. Users confirm them before the relationship is created.
                    </p>
                  </div>
                </section>
              )}

              {activeTab === "security" && (
                <section className="max-w-4xl space-y-4">
                  <div className="border border-[#C8CDD2] bg-white p-6">
                    <p className="text-sm font-semibold text-[#1F2933]">Security model</p>
                    <p className="mt-2 text-sm text-[#5E6870]">
                      Access rights are granted in Permission groups. This document type only
                      determines which lifecycle stages are available for those grants.
                    </p>
                  </div>
                  <div className="grid gap-4 md:grid-cols-3">
                    {[
                      { title: "Creation", statuses: "Draft, Returned", actions: "Upload, edit, submit, comment" },
                      { title: "For approval", statuses: "Pending approval", actions: "View, comment, approve" },
                      { title: "After approval", statuses: "Approved, Rejected, Archived", actions: "View, download, archive" },
                    ].map((stage) => (
                      <div key={stage.title} className="border border-[#C8CDD2] bg-white p-4">
                        <p className="text-sm font-semibold text-[#1F2933]">{stage.title}</p>
                        <p className="mt-2 text-xs font-semibold uppercase tracking-wide text-[#5E6870]">Statuses</p>
                        <p className="mt-1 text-sm text-[#1F2933]">{stage.statuses}</p>
                        <p className="mt-3 text-xs font-semibold uppercase tracking-wide text-[#5E6870]">Typical grants</p>
                        <p className="mt-1 text-sm text-[#1F2933]">{stage.actions}</p>
                      </div>
                    ))}
                  </div>
                  <div className="border border-[#A7CDE3] bg-[#EEF6FB] p-4 text-sm text-[#287EAD]">
                    Configure who receives these rights in <span className="font-semibold">Admin → Groups</span>.
                    Rules are explicit per document type and stage, so permissions do not overlap.
                  </div>
                </section>
              )}
            </form>
          )}
        </main>
      </div>
    </div>

    {/* ── Duplicate document type dialog ─────────────────────────────────── */}
    {duplicateDialogOpen && selectedType && (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm">
        <div className="w-full max-w-md border border-[#C8CDD2] bg-white shadow-xl">
          {/* Header */}
          <div className="flex items-center justify-between border-b border-[#C8CDD2] bg-[#287EAD] px-5 py-3">
            <div className="flex items-center gap-2 text-white">
              <Copy className="h-4 w-4" />
              <span className="text-sm font-semibold">Duplicate document type</span>
            </div>
            <button
              type="button"
              onClick={() => setDuplicateDialogOpen(false)}
              className="text-white/70 hover:text-white"
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          {/* Body */}
          <div className="space-y-4 p-5 text-sm">
            <p className="text-[#5E6870]">
              A full copy of <span className="font-semibold text-[#1F2933]">{selectedType.name}</span> will be
              created — including all attributes and relationship rules.
              Adjust the name and code below before confirming.
            </p>

            <div className="space-y-3">
              <div>
                <label className="mb-1 block text-xs font-medium text-[#5E6870]">New name</label>
                <input
                  value={duplicateName}
                  onChange={(e) => setDuplicateName(e.target.value)}
                  className={inputCls}
                  placeholder="e.g. Copy of Supplier Invoice"
                  autoFocus
                />
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-[#5E6870]">Code</label>
                <input
                  value={duplicateCode}
                  onChange={(e) => setDuplicateCode(e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, "").slice(0, 20))}
                  className={`${inputCls} font-mono tracking-widest uppercase`}
                  placeholder="e.g. INV_COPY"
                  maxLength={20}
                />
                <p className="mt-1 text-xs text-[#8C969E]">Unique short identifier — max 20 characters, A–Z, 0–9, underscore.</p>
              </div>
            </div>
          </div>

          {/* Footer */}
          <div className="flex items-center justify-end gap-2 border-t border-[#C8CDD2] px-5 py-3">
            <button
              type="button"
              onClick={() => setDuplicateDialogOpen(false)}
              disabled={duplicateMutation.isPending}
              className="px-4 py-2 text-sm text-[#5E6870] hover:text-[#1F2933] disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={!duplicateName.trim() || !duplicateCode.trim() || duplicateMutation.isPending}
              onClick={() =>
                duplicateMutation.mutate({
                  id: selectedType.id,
                  name: duplicateName.trim(),
                  code: duplicateCode.trim(),
                })
              }
              className="inline-flex items-center gap-2 bg-[#287EAD] px-4 py-2 text-sm font-medium text-white hover:bg-[#1E6F99] disabled:opacity-50"
            >
              {duplicateMutation.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Copy className="h-4 w-4" />
              )}
              Duplicate
            </button>
          </div>
        </div>
      </div>
    )}
    </>
  );
}
