// DashboardPage.tsx — Indigo Vault themed
import { useQuery } from "@tanstack/react-query";
import { api, documentsAPI, workflowAPI } from "@/services/api";
import { useAuthStore } from "@/store/authStore";
import {
  FileText, Clock, CheckCircle, GitBranch, ArrowRight,
  ChevronLeft, ChevronRight,
  Calendar, Loader2, Search, ShieldCheck,
} from "lucide-react";
import { Link } from "react-router-dom";
import StatusBadge from "@/components/documents/StatusBadge";
import { format, formatDistanceToNow } from "date-fns";
import { useState } from "react";
import type { Document, WorkflowTask } from "@/types";
import { StatCard } from "@/components/dashboard/StatCard";

const RECENT_DOCS_PAGE_SIZE = 5;
const RECENT_ACTIVITY_PAGE_SIZE = 10;
type PaginatedResponse<T> = {
  count: number;
  results: T[];
};

function getAuditPresentation(event: any) {
  const name = String(event?.event ?? "");
  if (name.startsWith("user.login")) {
    return { icon: Clock, label: "Login", tone: "bg-accent/15 text-accent-foreground border-accent/30" };
  }
  if (name.startsWith("workflow.")) {
    return { icon: GitBranch, label: "Workflow", tone: "bg-secondary text-secondary-foreground border-border" };
  }
  if (name.includes("download")) {
    return { icon: ArrowRight, label: "Access", tone: "bg-teal/15 text-teal border-teal/30" };
  }
  if (name.includes("edit") || name.includes("update") || name.includes("version")) {
    return { icon: FileText, label: "Document", tone: "bg-primary/10 text-primary border-primary/20" };
  }
  if (name.includes("delete") || name.includes("reject") || name.includes("fail")) {
    return { icon: ShieldCheck, label: "Alert", tone: "bg-destructive/10 text-destructive border-destructive/30" };
  }
  return { icon: ShieldCheck, label: "Activity", tone: "bg-muted text-muted-foreground border-border" };
}

function TaskMetaInfo({ dueAt }: { dueAt: string | null }) {
  if (!dueAt) return null;

  const dueDate = new Date(dueAt);
  const now = new Date();
  const hoursDiff = (dueDate.getTime() - now.getTime()) / (1000 * 60 * 60);

  let statusClass = "text-muted-foreground";
  let statusText = "On track";

  if (hoursDiff < 0) {
    statusClass = "text-destructive";
    statusText = "Overdue";
  } else if (hoursDiff < 24) {
    statusClass = "text-accent-foreground";
    statusText = "Due soon";
  }

  return (
    <div className="flex items-center gap-1 text-xs">
      <Calendar className="w-3 h-3" />
      <span className={statusClass}>
        {statusText} · {formatDistanceToNow(dueDate, { addSuffix: true })}
      </span>
    </div>
  );
}

export default function DashboardPage() {
  const { user } = useAuthStore();
  const [recentDocsPage, setRecentDocsPage] = useState(1);
  const [recentAuditPage, setRecentAuditPage] = useState(1);

  const { data: recentDocs, isLoading: docsLoading } = useQuery({
    queryKey: ["documents", "recent", recentDocsPage],
    queryFn: () =>
      documentsAPI.list({
        page: recentDocsPage,
        page_size: RECENT_DOCS_PAGE_SIZE,
        ordering: "-updated_at",
      }).then((r) => r.data as PaginatedResponse<Document>),
  });

  const { data: pendingCount = 0 } = useQuery({
    queryKey: ["documents", "pending", "count"],
    queryFn: () => documentsAPI.list({ status: "pending_approval", page_size: 1 }).then((r) => r.data.count ?? 0),
  });

  const { data: myTasks = [], isLoading: tasksLoading } = useQuery({
    queryKey: ["workflow", "my-tasks"],
    queryFn: () => workflowAPI.myTasks().then((r) => r.data.results ?? r.data),
  });

  const { data: recentAudit, isLoading: auditLoading } = useQuery({
    queryKey: ["audit", user?.has_admin_access ? "all" : "mine", recentAuditPage],
    queryFn: () =>
      api
        .get(user?.has_admin_access ? "/audit/" : "/audit/my-activity/", {
          params: {
            ordering: "-timestamp",
            page: recentAuditPage,
            page_size: RECENT_ACTIVITY_PAGE_SIZE,
          },
        })
        .then((r) => r.data as PaginatedResponse<Record<string, unknown>>),
  });

  const recentDocsCount = recentDocs?.count ?? 0;
  const recentAuditCount = recentAudit?.count ?? 0;
  const recentDocsPages = Math.max(1, Math.ceil(recentDocsCount / RECENT_DOCS_PAGE_SIZE));
  const recentAuditPages = Math.max(1, Math.ceil(recentAuditCount / RECENT_ACTIVITY_PAGE_SIZE));
  const totalDocuments = recentDocsCount;
  const auditTitle = user?.has_admin_access ? "Audit trail" : "My activity";
  const auditSubtitle = user?.has_admin_access
    ? "Recent activity on your document records."
    : "Recent activity on documents you own.";

  return (
    <div className="max-w-7xl mx-auto space-y-8">
      {/* Header */}
      <div className="flex flex-col gap-4 xl:flex-row xl:items-end xl:justify-between">
        <div className="space-y-2">
          <p className="text-xs font-medium uppercase tracking-[0.32em] text-muted-foreground">
            Workspace · {user?.first_name ? `Welcome, ${user.first_name}` : "East Africa"}
          </p>
          <div className="space-y-1">
            <h1 className="text-3xl sm:text-4xl font-semibold tracking-tight text-foreground">
              Document Operations
            </h1>
            <p className="max-w-2xl text-sm text-muted-foreground">
              Review recent submissions, pending approvals, and activity across your repositories.
            </p>
          </div>
        </div>

        <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
          <div className="relative w-full sm:w-96">
            <span className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-muted-foreground">
              <Search className="w-4 h-4" />
            </span>
            <input
              type="search"
              placeholder="Search documents, metadata, content..."
              className="input w-full pl-11 pr-4"
            />
          </div>
          <Link
            to="/workflow"
            className="inline-flex items-center justify-center gap-2 rounded-lg bg-primary px-5 py-2.5 text-sm font-semibold text-primary-foreground transition-colors hover:bg-primary/90"
          >
            Workflow
          </Link>
        </div>
      </div>

      {/* Key Metrics */}
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
        <StatCard title="Total Documents" value={totalDocuments} icon={FileText}    color="primary"   href="/documents" />
        <StatCard title="Pending Approval" value={pendingCount}   icon={Clock}       color="accent"    href="/documents?status=pending_approval" />
        <StatCard title="My Tasks"         value={myTasks.length} icon={GitBranch}   color="secondary" href="/workflow" />
        <StatCard title="Completed"        value="—"              icon={CheckCircle} color="teal" />
      </div>

      {/* Main Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-[minmax(0,1.75fr)_minmax(0,1fr)] gap-6">
        {/* Left column */}
        <div className="space-y-6">
          {/* Recent Documents */}
          <div
            className="bg-card rounded-xl border border-border overflow-hidden"
            style={{ boxShadow: "var(--shadow-card)" }}
          >
            <div className="px-6 py-5 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between bg-muted/40 border-b border-border">
              <div>
                <p className="text-sm font-semibold text-foreground">Recent Documents</p>
                <p className="text-sm text-muted-foreground mt-1">Latest uploads and document changes.</p>
              </div>
              <Link
                to="/documents"
                className="inline-flex items-center gap-1 text-xs font-semibold text-foreground hover:text-accent transition-colors"
              >
                View all <ArrowRight className="w-3 h-3" />
              </Link>
            </div>

            <div className="divide-y divide-border">
              {docsLoading ? (
                <div className="p-8 flex justify-center">
                  <Loader2 className="w-6 h-6 text-muted-foreground animate-spin" />
                </div>
              ) : recentDocs?.results?.length ? (
                recentDocs.results.map((doc: Document) => (
                  <Link
                    key={doc.id}
                    to={`/documents/${doc.id}`}
                    className="block px-6 py-4 hover:bg-muted/40 transition-colors"
                  >
                    <div className="flex items-center gap-4">
                      <div className="rounded-lg bg-primary/5 p-3 text-primary">
                        <FileText className="w-5 h-5" />
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-semibold text-foreground truncate">
                          {doc.title}
                        </p>
                        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground mt-1">
                          <span>{doc.reference_number}</span>
                          <span>•</span>
                          <span>{formatDistanceToNow(new Date(doc.updated_at), { addSuffix: true })}</span>
                        </div>
                      </div>
                      <StatusBadge status={doc.status} />
                    </div>
                  </Link>
                ))
              ) : (
                <div className="px-6 py-14 text-center">
                  <FileText className="mx-auto h-12 w-12 text-muted-foreground/50" />
                  <p className="mt-4 text-sm text-muted-foreground">No recent documents yet.</p>
                  <Link to="/documents/upload" className="mt-3 inline-flex text-sm font-semibold text-foreground hover:text-accent transition-colors">
                    Upload your first document →
                  </Link>
                </div>
              )}
            </div>

            {recentDocsCount > RECENT_DOCS_PAGE_SIZE && (
              <div className="flex items-center justify-between border-t border-border bg-muted/20 px-6 py-3">
                <span className="text-xs text-muted-foreground">
                  Page {recentDocsPage} of {recentDocsPages}
                </span>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setRecentDocsPage((p) => Math.max(1, p - 1))}
                    disabled={recentDocsPage === 1}
                    className="inline-flex items-center gap-1 rounded-lg border border-border bg-card px-3 py-1.5 text-xs font-medium text-foreground hover:bg-muted disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    <ChevronLeft className="w-3.5 h-3.5" /> Prev
                  </button>
                  <button
                    type="button"
                    onClick={() => setRecentDocsPage((p) => p + 1)}
                    disabled={recentDocsPage * RECENT_DOCS_PAGE_SIZE >= recentDocsCount}
                    className="inline-flex items-center gap-1 rounded-lg border border-border bg-card px-3 py-1.5 text-xs font-medium text-foreground hover:bg-muted disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    Next <ChevronRight className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
            )}
          </div>

          {/* Audit trail */}
          <div
            className="bg-card rounded-xl border border-border p-6"
            style={{ boxShadow: "var(--shadow-card)" }}
          >
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-3">
                <div className="rounded-lg bg-primary/5 p-3 text-primary">
                  <ShieldCheck className="w-5 h-5" />
                </div>
                <div>
                  <p className="text-sm font-semibold text-foreground">{auditTitle}</p>
                  <p className="text-sm text-muted-foreground">{auditSubtitle}</p>
                </div>
              </div>
              <Link
                to="/audit"
                className="text-sm font-semibold text-foreground hover:text-accent transition-colors"
              >
                View full log
              </Link>
            </div>

            <div className="mt-6 space-y-3">
              {auditLoading ? (
                <div className="rounded-lg bg-muted/40 p-6 text-center text-sm text-muted-foreground">
                  Loading activity…
                </div>
              ) : recentAudit?.results?.length ? (
                recentAudit.results.map((event: any) => {
                  const auditMeta = getAuditPresentation(event);
                  const AuditIcon = auditMeta.icon;

                  return (
                  <div key={event.id} className="rounded-lg border border-border bg-muted/30 p-4">
                    <div className="flex items-start justify-between gap-4">
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[10px] font-semibold ${auditMeta.tone}`}>
                            <AuditIcon className="w-3 h-3" />
                            {auditMeta.label}
                          </span>
                          <p className="text-sm font-semibold text-foreground truncate">
                            {event.summary || event.event}
                          </p>
                        </div>
                        <p className="text-xs text-muted-foreground mt-1">
                          {event.actor_email || "System"} · {format(new Date(event.timestamp), "dd MMM yyyy")}
                        </p>
                      </div>
                      <span className="text-[11px] font-semibold uppercase tracking-[0.24em] text-muted-foreground">
                        {format(new Date(event.timestamp), "hh:mm a")}
                      </span>
                    </div>
                    <div className="mt-3 flex items-center gap-2 text-xs text-muted-foreground">
                      <span>{formatDistanceToNow(new Date(event.timestamp), { addSuffix: true })}</span>
                      {event.object_repr && (
                        <>
                          <span>•</span>
                          <span className="truncate">{event.object_repr}</span>
                        </>
                      )}
                    </div>
                  </div>
                  );
                })
              ) : (
                <div className="rounded-lg bg-muted/40 p-6 text-center text-sm text-muted-foreground">
                  No recent audit events found.
                </div>
              )}
            </div>

            {recentAuditCount > RECENT_ACTIVITY_PAGE_SIZE && (
              <div className="mt-5 flex items-center justify-between border-t border-border pt-4">
                <span className="text-xs text-muted-foreground">
                  Page {recentAuditPage} of {recentAuditPages}
                </span>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setRecentAuditPage((p) => Math.max(1, p - 1))}
                    disabled={recentAuditPage === 1}
                    className="inline-flex items-center gap-1 rounded-lg border border-border bg-card px-3 py-1.5 text-xs font-medium text-foreground hover:bg-muted disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    <ChevronLeft className="w-3.5 h-3.5" /> Prev
                  </button>
                  <button
                    type="button"
                    onClick={() => setRecentAuditPage((p) => p + 1)}
                    disabled={recentAuditPage * RECENT_ACTIVITY_PAGE_SIZE >= recentAuditCount}
                    className="inline-flex items-center gap-1 rounded-lg border border-border bg-card px-3 py-1.5 text-xs font-medium text-foreground hover:bg-muted disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    Next <ChevronRight className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Right column */}
        <div className="space-y-6">
          <div
            className="bg-card rounded-xl border border-border p-6"
            style={{ boxShadow: "var(--shadow-card)" }}
          >
            <div className="flex items-center justify-between gap-3">
              <div className="space-y-1">
                <p className="text-sm font-semibold text-foreground">Pending tasks</p>
                <p className="text-sm text-muted-foreground">Tasks waiting for your attention.</p>
              </div>
              <div className="rounded-full bg-teal/10 px-3 py-1 text-xs font-semibold text-teal">
                {myTasks.length} open
              </div>
            </div>

            <div className="mt-6 space-y-4">
              {tasksLoading ? (
                <div className="rounded-lg bg-muted/40 p-6 text-center text-sm text-muted-foreground">
                  Loading tasks…
                </div>
              ) : myTasks.length ? (
                myTasks.slice(0, 5).map((task: WorkflowTask) => {
                  const doc = task.workflow_instance?.document;
                  return (
                    <Link
                      key={task.id}
                      to={doc?.id ? `/documents/${doc.id}` : "/workflow"}
                      className="block rounded-lg border border-border bg-muted/30 p-4 hover:bg-muted/60 transition-colors"
                    >
                      <div className="flex items-start gap-3">
                        <div className="mt-0.5 rounded-md bg-accent/15 p-2 text-accent-foreground border border-accent/40">
                          <Clock className="w-4 h-4" />
                        </div>
                        <div className="min-w-0 flex-1">
                          <p className="text-sm font-semibold text-foreground truncate">
                            {doc?.title || task.document_title || "Untitled document"}
                          </p>
                          <div className="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
                            <span>{task.step?.name}</span>
                            <span>•</span>
                            <TaskMetaInfo dueAt={task.due_at} />
                          </div>
                        </div>
                      </div>
                    </Link>
                  );
                })
              ) : (
                <div className="rounded-lg bg-muted/40 p-6 text-center text-sm text-muted-foreground">
                  You have no pending tasks right now.
                </div>
              )}
            </div>
          </div>

          {/* Storage card to match Indigo Vault aesthetic */}
          <div
            className="bg-card rounded-xl border border-border p-6"
            style={{ boxShadow: "var(--shadow-card)" }}
          >
            <p className="text-sm font-semibold text-foreground">Storage Used</p>
            <p className="text-xs text-muted-foreground mt-1">Across all repositories</p>
            <div className="mt-4 h-2 overflow-hidden rounded-full bg-muted">
              <div className="h-full rounded-full" style={{ width: "62%", background: "var(--gradient-accent)" }} />
            </div>
            <p className="mt-2 text-[11px] text-muted-foreground">312 GB of 500 GB · 62%</p>
          </div>
        </div>
      </div>
    </div>
  );
}
