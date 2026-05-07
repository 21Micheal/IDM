import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { workflowAPI } from "@/services/api";
import {
  Plus, GitBranch,
  Users, Building2, Shield, Settings, ChevronRight,
  FileText, Database, Mail, Lock, Globe,
} from "lucide-react";
import clsx from "clsx";
// ── Users tab ────────────────────────────────────────────────────────────────

function UsersTab() {
  const navigate = useNavigate();

  const cards = [
    {
      icon: FileText,
      title: "Document types",
      description: "Define document categories, metadata fields, numbering, and upload schema rules.",
      action: "Manage document types",
      to: "/admin/document-types",
    },
    {
      icon: Users,
      title: "Users",
      description: "Create and manage staff accounts, reset passwords, and capture job descriptions.",
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
    <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-5">
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
    queryFn:  () => workflowAPI.listTemplates().then((r) => r.data.results ?? r.data),
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
  { id: "workflow", label: "Workflow templates", icon: GitBranch  },
  { id: "users",    label: "Management",         icon: Users      },
  { id: "settings", label: "Settings",           icon: Settings   },
] as const;

type TabId = typeof TABS[number]["id"];

export default function AdminPage() {
  const [activeTab, setActiveTab] = useState<TabId>("users");

  return (
    <div className="space-y-6">
      {/* Page header */}
      <div>
        <h1 className="text-2xl font-bold text-foreground tracking-tight">Administration</h1>
        <p className="text-muted-foreground text-sm mt-1">
          Manage document types, workflows, users, and system settings from one place.
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
      {activeTab === "workflow" && <WorkflowTab />}
      {activeTab === "users"    && <UsersTab />}
      {activeTab === "settings" && <SettingsTab />}
    </div>
  );
}
