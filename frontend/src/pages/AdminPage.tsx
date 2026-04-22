import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { documentTypesAPI } from "@/services/api";
import {
  Plus, GitBranch, Trash2, Edit2, Loader2, X, Save,
  Users, Building2, Shield, Settings, ChevronRight,
  FileText, Database, Mail, Lock, Globe,
} from "lucide-react";
import { useForm, useFieldArray } from "react-hook-form";
import { toast } from "react-toastify";
import clsx from "clsx";
import type { DocumentType } from "@/types";

// ── Constants ─────────────────────────────────────────────────────────────────

const FIELD_TYPES = [
  { value: "text",     label: "Text" },
  { value: "number",   label: "Number" },
  { value: "date",     label: "Date" },
  { value: "currency", label: "Currency" },
  { value: "select",   label: "Dropdown" },
  { value: "boolean",  label: "Yes / No" },
  { value: "textarea", label: "Long text" },
];

type DocTypeFormData = {
  name: string;
  code: string;
  reference_prefix: string;
  reference_padding: number;
  description: string;
  metadata_fields: Array<{
    label: string;
    key: string;
    field_type: string;
    is_required: boolean;
    order: number;
  }>;
};

// ── Document type form (shared by create + edit) ──────────────────────────────

function DocumentTypeForm({
  defaultValues,
  onSubmit,
  onCancel,
  isPending,
  submitLabel,
}: {
  defaultValues: DocTypeFormData;
  onSubmit:      (data: DocTypeFormData) => void;
  onCancel:      () => void;
  isPending:     boolean;
  submitLabel:   string;
}) {
  const { register, control, handleSubmit } = useForm<DocTypeFormData>({ defaultValues });
  const { fields, append, remove } = useFieldArray({ control, name: "metadata_fields" });

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="space-y-5">
      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="label">Type name <span className="text-destructive">*</span></label>
          <input {...register("name", { required: true })} className="input" placeholder="e.g. Supplier Invoice" />
        </div>
        <div>
          <label className="label">Code <span className="text-destructive">*</span></label>
          <input {...register("code", { required: true })} className="input" placeholder="e.g. INV" />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="label">Reference prefix <span className="text-destructive">*</span></label>
          <input {...register("reference_prefix", { required: true })} className="input" placeholder="INV" />
        </div>
        <div>
          <label className="label">Padding digits</label>
          <input {...register("reference_padding", { valueAsNumber: true })} type="number" min={1} max={10} className="input" />
        </div>
      </div>

      <div>
        <label className="label">Description</label>
        <textarea {...register("description")} rows={2} className="input" placeholder="Brief description…" />
      </div>

      {/* Custom metadata fields */}
      <div className="border border-border rounded-xl p-4 space-y-3 bg-muted/30">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="font-semibold text-foreground text-sm">Custom metadata fields</h3>
            <p className="text-xs text-muted-foreground mt-0.5">
              Core fields (supplier, amount, date) are always present.
            </p>
          </div>
          <button
            type="button"
            onClick={() => append({ label: "", key: "", field_type: "text", is_required: false, order: fields.length })}
            className="btn-secondary text-xs px-2.5 py-1.5"
          >
            <Plus className="w-3.5 h-3.5" /> Add field
          </button>
        </div>

        {fields.map((field, index) => (
          <div key={field.id} className="grid grid-cols-12 gap-2 items-center bg-card border border-border rounded-lg p-3">
            <div className="col-span-3">
              <input
                {...register(`metadata_fields.${index}.label`)}
                className="input text-sm"
                placeholder="Label"
              />
            </div>
            <div className="col-span-3">
              <input
                {...register(`metadata_fields.${index}.key`)}
                className="input text-sm font-mono"
                placeholder="field_key"
              />
            </div>
            <div className="col-span-3">
              <select {...register(`metadata_fields.${index}.field_type`)} className="input text-sm">
                {FIELD_TYPES.map((t) => (
                  <option key={t.value} value={t.value}>{t.label}</option>
                ))}
              </select>
            </div>
            <div className="col-span-2 flex items-center gap-1.5">
              <input
                {...register(`metadata_fields.${index}.is_required`)}
                type="checkbox"
                className="w-4 h-4 rounded border-border text-accent focus:ring-ring"
              />
              <span className="text-xs text-foreground">Required</span>
            </div>
            <div className="col-span-1 flex justify-end">
              <button type="button" onClick={() => remove(index)} className="text-muted-foreground hover:text-destructive transition-colors">
                <Trash2 className="w-4 h-4" />
              </button>
            </div>
          </div>
        ))}

        {!fields.length && (
          <p className="text-xs text-muted-foreground text-center py-2">
            No custom fields configured yet.
          </p>
        )}
      </div>

      <div className="flex gap-3 pt-1">
        <button type="submit" disabled={isPending} className="btn-primary">
          {isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
          {submitLabel}
        </button>
        <button type="button" onClick={onCancel} className="btn-secondary">
          Cancel
        </button>
      </div>
    </form>
  );
}

// ── Document types tab ────────────────────────────────────────────────────────

function DocumentTypesTab() {
  const qc = useQueryClient();
  const [showCreate, setShowCreate] = useState(false);
  const [editId, setEditId]         = useState<string | null>(null);

  const { data: docTypes, isLoading } = useQuery<DocumentType[]>({
    queryKey: ["document-types"],
    queryFn:  () => documentTypesAPI.list().then((r) => r.data.results ?? r.data),
  });

  const createMutation = useMutation({
    mutationFn: (data: unknown) => documentTypesAPI.create(data),
    onSuccess: () => {
      toast.success("Document type created");
      qc.invalidateQueries({ queryKey: ["document-types"] });
      setShowCreate(false);
    },
    onError: () => toast.error("Failed to create document type"),
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, data }: { id: string; data: unknown }) =>
      documentTypesAPI.update(id, data),
    onSuccess: () => {
      toast.success("Document type updated");
      qc.invalidateQueries({ queryKey: ["document-types"] });
      setEditId(null);
    },
    onError: () => toast.error("Failed to update document type"),
  });

  const editTarget = docTypes?.find((d) => d.id === editId);

  const blankForm: DocTypeFormData = {
    name: "", code: "", reference_prefix: "",
    reference_padding: 5, description: "", metadata_fields: [],
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">{docTypes?.length ?? 0} document types configured</p>
        <button onClick={() => { setShowCreate(true); setEditId(null); }} className="btn-primary">
          <Plus className="w-4 h-4" /> New document type
        </button>
      </div>

      {/* Create form */}
      {showCreate && (
        <div className="card p-6">
          <div className="flex items-center justify-between mb-5">
            <h2 className="font-semibold text-foreground">Create document type</h2>
            <button onClick={() => setShowCreate(false)} className="text-muted-foreground hover:text-foreground">
              <X className="w-4 h-4" />
            </button>
          </div>
          <DocumentTypeForm
            defaultValues={blankForm}
            onSubmit={(v) => createMutation.mutate(v)}
            onCancel={() => setShowCreate(false)}
            isPending={createMutation.isPending}
            submitLabel="Create document type"
          />
        </div>
      )}

      {/* Edit form */}
      {editId && editTarget && (
        <div className="card p-6 border-l-4 border-l-accent">
          <div className="flex items-center justify-between mb-5">
            <h2 className="font-semibold text-foreground">Edit — {editTarget.name}</h2>
            <button onClick={() => setEditId(null)} className="text-muted-foreground hover:text-foreground">
              <X className="w-4 h-4" />
            </button>
          </div>
          <DocumentTypeForm
            defaultValues={{
              name:              editTarget.name,
              code:              editTarget.code,
              reference_prefix:  editTarget.reference_prefix,
              reference_padding: editTarget.reference_padding ?? 5,
              description:       editTarget.description ?? "",
              metadata_fields:   (editTarget.metadata_fields ?? []).map((f) => ({
                label:      f.label,
                key:        f.key ?? f.field_key,
                field_type: f.field_type,
                is_required: f.is_required,
                order:       f.order,
              })),
            }}
            onSubmit={(v) => updateMutation.mutate({ id: editId, data: v })}
            onCancel={() => setEditId(null)}
            isPending={updateMutation.isPending}
            submitLabel="Save changes"
          />
        </div>
      )}

      {/* Cards grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {isLoading && Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="card p-5 space-y-3 animate-pulse">
            <div className="h-5 bg-muted rounded w-2/3" />
            <div className="h-4 bg-muted rounded w-1/2" />
            <div className="h-4 bg-muted rounded w-3/4" />
          </div>
        ))}

        {docTypes?.map((type) => (
          <div
            key={type.id}
            className={clsx(
              "card p-5 space-y-3 transition-all",
              editId === type.id && "ring-2 ring-accent"
            )}
            style={{ boxShadow: "var(--shadow-card)" }}
          >
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <h3 className="font-semibold text-foreground truncate">{type.name}</h3>
                <p className="text-xs font-mono text-muted-foreground mt-0.5">
                  {type.reference_prefix}-{"0".repeat(type.reference_padding ?? 5)}
                </p>
              </div>
              <span className="badge bg-accent/15 text-accent flex-shrink-0">{type.code}</span>
            </div>

            {type.description && (
              <p className="text-sm text-muted-foreground line-clamp-2">{type.description}</p>
            )}

            <div className="flex items-center justify-between text-xs">
              <span className="text-muted-foreground">{type.metadata_fields?.length ?? 0} custom field{type.metadata_fields?.length !== 1 ? "s" : ""}</span>
              <span
                className={clsx(
                  "badge",
                  type.workflow_template
                    ? "bg-[hsl(var(--teal))]/15 text-[hsl(var(--teal))]"
                    : "bg-muted text-muted-foreground"
                )}
              >
                {type.workflow_template ? "Workflow ✓" : "No workflow"}
              </span>
            </div>

            <div className="flex gap-2 pt-1">
              <button
                onClick={() => { setEditId(type.id); setShowCreate(false); }}
                className="btn-secondary text-xs px-2.5 py-1"
              >
                <Edit2 className="w-3 h-3" /> Edit
              </button>
            </div>
          </div>
        ))}

        {!isLoading && !docTypes?.length && (
          <div className="col-span-3 card p-10 text-center">
            <FileText className="w-8 h-8 text-muted-foreground/40 mx-auto mb-3" />
            <p className="text-sm text-muted-foreground">No document types yet.</p>
            <button onClick={() => setShowCreate(true)} className="btn-primary mt-3">
              <Plus className="w-4 h-4" /> Create first type
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Users & Roles tab ─────────────────────────────────────────────────────────

function UsersTab() {
  const navigate = useNavigate();

  const cards = [
    {
      icon: Users,
      title: "Users",
      description: "Create and manage staff accounts, reset passwords, and assign roles.",
      action: "Manage users",
      to: "/admin/users",
    },
    {
      icon: Building2,
      title: "Departments",
      description: "Organise users into departments for document access scoping.",
      action: "Manage departments",
      to: "/admin/departments",
    },
    {
      icon: Shield,
      title: "Permission groups",
      description: "Fine-grained per-document-type permissions. Users can be in multiple groups.",
      action: "Manage groups",
      to: "/admin/groups",
    },
  ];

  return (
    <div className="grid grid-cols-1 sm:grid-cols-3 gap-5">
      {cards.map(({ icon: Icon, title, description, action, to }) => (
        <div
          key={to}
          className="card p-6 flex flex-col gap-4 hover:border-accent/40 transition-all"
          style={{ boxShadow: "var(--shadow-card)" }}
        >
          <div className="w-11 h-11 rounded-xl flex items-center justify-center bg-accent/15 text-accent">
            <Icon className="w-5 h-5" />
          </div>
          <div>
            <h3 className="font-semibold text-foreground">{title}</h3>
            <p className="text-sm text-muted-foreground mt-1">{description}</p>
          </div>
          <button
            onClick={() => navigate(to)}
            className="mt-auto flex items-center gap-1.5 text-sm font-semibold text-accent hover:text-accent/80"
          >
            {action} <ChevronRight className="w-4 h-4" />
          </button>
        </div>
      ))}
    </div>
  );
}

// ── Workflow tab ──────────────────────────────────────────────────────────────

function WorkflowTab() {
  const navigate = useNavigate();
  const { data: templates } = useQuery({
    queryKey: ["workflow-templates"],
    queryFn:  () =>
      import("@/services/api").then(({ workflowAPI }) =>
        workflowAPI.listTemplates().then((r) => r.data.results ?? r.data)
      ),
  });

  return (
    <div className="space-y-5">
      <div className="flex items-start justify-between">
        <div>
          <h2 className="font-semibold text-foreground">Workflow templates</h2>
          <p className="text-sm text-muted-foreground mt-1">
            {templates?.length ?? 0} template{templates?.length !== 1 ? "s" : ""} configured
          </p>
        </div>
        <button onClick={() => navigate("/workflow/builder")} className="btn-primary">
          <GitBranch className="w-4 h-4" /> Open workflow builder
        </button>
      </div>

      {templates?.length > 0 ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {templates.map((t: { id: string; name: string; step_count: number; description: string }) => (
            <div key={t.id} className="card p-5 flex flex-col gap-3" style={{ boxShadow: "var(--shadow-card)" }}>
              <div className="flex items-start gap-3">
                <div className="w-9 h-9 rounded-lg bg-accent/15 flex items-center justify-center flex-shrink-0">
                  <GitBranch className="w-4 h-4 text-accent" />
                </div>
                <div className="min-w-0">
                  <p className="font-semibold text-foreground truncate">{t.name}</p>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    {t.step_count} step{t.step_count !== 1 ? "s" : ""}
                  </p>
                </div>
              </div>
              {t.description && (
                <p className="text-sm text-muted-foreground line-clamp-2">{t.description}</p>
              )}
              <button
                onClick={() => navigate("/workflow/builder")}
                className="text-xs text-accent hover:text-accent/80 flex items-center gap-1 mt-auto font-semibold"
              >
                Edit in builder <ChevronRight className="w-3.5 h-3.5" />
              </button>
            </div>
          ))}
        </div>
      ) : (
        <div className="card p-10 text-center">
          <GitBranch className="w-10 h-10 text-muted-foreground/40 mx-auto mb-3" />
          <p className="font-semibold text-foreground">No workflow templates yet</p>
          <p className="text-sm text-muted-foreground mt-1">
            Create approval chains and assign them to document types.
          </p>
          <button onClick={() => navigate("/workflow/builder")} className="btn-primary mt-4">
            <Plus className="w-4 h-4" /> Open builder
          </button>
        </div>
      )}
    </div>
  );
}

// ── Settings tab ──────────────────────────────────────────────────────────────

function SettingsTab() {
  const sections = [
    {
      icon: Mail,
      title: "Email / notifications",
      description: "SMTP configuration, email templates, notification triggers.",
      status: "Configured via .env",
      tone: "teal" as const,
    },
    {
      icon: Database,
      title: "Storage",
      description: "Local filesystem storage. Configure S3 or Azure Blob via .env for production.",
      status: "Local filesystem",
      tone: "accent" as const,
    },
    {
      icon: Globe,
      title: "LDAP / Active Directory",
      description: "Sync users from your organisation's directory server.",
      status: "Not configured",
      tone: "muted" as const,
    },
    {
      icon: Lock,
      title: "Security",
      description: "JWT expiry, OTP lifetime, password strength policy, session management.",
      status: "Configured via settings.py",
      tone: "teal" as const,
    },
  ];

  const toneClass = (t: "teal" | "accent" | "muted") =>
    t === "teal"
      ? "bg-[hsl(var(--teal))]/15 text-[hsl(var(--teal))]"
      : t === "accent"
        ? "bg-accent/15 text-accent"
        : "bg-muted text-muted-foreground";

  return (
    <div className="space-y-4">
      <div className="flex items-start gap-3 px-4 py-3 bg-accent/10 border border-accent/30 rounded-xl text-sm text-foreground">
        <Settings className="w-4 h-4 mt-0.5 flex-shrink-0 text-accent" />
        <span>
          System settings are managed via environment variables and Django settings.
          This panel shows the current configuration status.
        </span>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        {sections.map(({ icon: Icon, title, description, status, tone }) => (
          <div key={title} className="card p-5 flex gap-4" style={{ boxShadow: "var(--shadow-card)" }}>
            <div className="w-10 h-10 rounded-lg bg-muted flex items-center justify-center flex-shrink-0">
              <Icon className="w-4 h-4 text-foreground" />
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-start justify-between gap-2 flex-wrap">
                <h3 className="font-semibold text-foreground text-sm">{title}</h3>
                <span className={clsx("badge text-xs", toneClass(tone))}>{status}</span>
              </div>
              <p className="text-xs text-muted-foreground mt-1">{description}</p>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Main AdminPage ─────────────────────────────────────────────────────────────

const TABS = [
  { id: "types",    label: "Document types",    icon: FileText   },
  { id: "workflow", label: "Workflow templates", icon: GitBranch  },
  { id: "users",    label: "Users & roles",      icon: Users      },
  { id: "settings", label: "Settings",           icon: Settings   },
] as const;

type TabId = typeof TABS[number]["id"];

export default function AdminPage() {
  const [activeTab, setActiveTab] = useState<TabId>("types");

  return (
    <div className="space-y-6">
      {/* Page header */}
      <div>
        <h1 className="text-2xl font-bold text-foreground tracking-tight">Administration</h1>
        <p className="text-muted-foreground text-sm mt-1">
          Manage document types, workflows, users, and system settings.
        </p>
      </div>

      {/* Tab bar */}
      <div className="border-b border-border">
        <nav className="-mb-px flex gap-0 overflow-x-auto">
          {TABS.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              onClick={() => setActiveTab(id)}
              className={clsx(
                "flex items-center gap-2 px-4 py-2.5 text-sm font-medium border-b-2 transition-colors whitespace-nowrap",
                activeTab === id
                  ? "border-accent text-accent"
                  : "border-transparent text-muted-foreground hover:text-foreground hover:border-border"
              )}
            >
              <Icon className="w-4 h-4" />
              {label}
            </button>
          ))}
        </nav>
      </div>

      {/* Tab content */}
      {activeTab === "types"    && <DocumentTypesTab />}
      {activeTab === "workflow" && <WorkflowTab />}
      {activeTab === "users"    && <UsersTab />}
      {activeTab === "settings" && <SettingsTab />}
    </div>
  );
}
