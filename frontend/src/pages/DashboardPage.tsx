// DashboardPage.tsx — Production Enterprise DMS
import { useQuery } from "@tanstack/react-query";
import { api, documentsAPI, searchAPI, workflowAPI } from "@/services/api";
import { useAuthStore } from "@/store/authStore";
import {
  FileText, Clock, CheckCircle, GitBranch, ArrowRight,
  ChevronLeft, ChevronRight,
  Calendar, Loader2, Search, ShieldCheck, Sparkles,
} from "lucide-react";
import { Link, useNavigate } from "react-router-dom";
import StatusBadge from "@/components/documents/StatusBadge";
import { formatDistanceToNow } from "date-fns";
import { useEffect, useRef, useState, useMemo } from "react";
import type { Document, DocumentSearchResponse, SearchHit, WorkflowTask } from "@/types";
import { StatCard } from "@/components/dashboard/StatCard";
import { useDebounce } from "@/hooks/useDebounce";
import { highlightSearchText, getPreferredHighlights } from "@/lib/search";
import { QUERY_FIVE_MIN_STALE, QUERY_SHORT_STALE, QUERY_FOCUS_OFF } from "@/lib/reactQueryDefaults";
import { formatDocumentFileType } from "@/lib/documentFormat";
import { preloadDocumentWorkspace } from "@/lib/routePreload";

const RECENT_DOCS_PAGE_SIZE = 5;
const RECENT_AUDIT_PAGE_SIZE = 5;

type PaginatedResponse<T> = {
  count: number;
  results: T[];
};

type DashboardAuditEvent = {
  id: string;
  event: string;
  summary?: string;
  actor_name?: string;
  actor_email?: string;
  timestamp: string;
  object_repr?: string;
};

type StorageStats = {
  used_bytes: number;
  total_bytes: number;
  used_gb: number;
  total_gb: number;
  used_mb: number;
  total_mb: number;
  percentage: number;
};

function formatStorageAmount(bytes: number) {
  if (bytes >= 1024 ** 3) {
    return {
      value: (bytes / (1024 ** 3)).toFixed(1),
      unit: "GB used",
    };
  }
  if (bytes >= 1024 ** 2) {
    return {
      value: (bytes / (1024 ** 2)).toFixed(1),
      unit: "MB used",
    };
  }
  if (bytes >= 1024) {
    return {
      value: (bytes / 1024).toFixed(1),
      unit: "KB used",
    };
  }
  return {
    value: `${bytes}`,
    unit: "B used",
  };
}

function getAuditPresentation(event: any) {
  const name = String(event?.event ?? "");
  if (name.startsWith("user.login")) {
    return { icon: Clock, label: "Login", tone: "bg-accent/15 text-accent border-accent/30" };
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
    statusClass = "text-accent";
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
  const navigate = useNavigate();

  const [recentDocsPage, setRecentDocsPage] = useState(1);
  const [recentAuditPage, setRecentAuditPage] = useState(1);
  const [dashboardSearch, setDashboardSearch] = useState("");
  const [isDashboardSearchFocused, setIsDashboardSearchFocused] = useState(false);
  const [activeDashboardResultIndex, setActiveDashboardResultIndex] = useState(-1);

  const dashboardSearchRef = useRef<HTMLDivElement | null>(null);
  const debouncedDashboardSearch = useDebounce(dashboardSearch.trim(), 300);

  // ── Queries ───────────────────────────────────────────────────────────────

  const { data: recentDocs, isLoading: docsLoading } = useQuery({
    queryKey: ["documents", "recent", recentDocsPage],
    queryFn: () =>
      documentsAPI.list({
        page: recentDocsPage,
        page_size: RECENT_DOCS_PAGE_SIZE,
        ordering: "-updated_at",
      }).then((r) => r.data as PaginatedResponse<Document>),
    ...QUERY_SHORT_STALE,
  });

  const { data: totalDocuments = 0 } = useQuery({
    queryKey: ["documents", "count", "all"],
    queryFn: () => documentsAPI.list({ page: 1, page_size: 1 }).then((r) => r.data.count ?? 0),
    ...QUERY_SHORT_STALE,
  });

  const { data: pendingCount = 0 } = useQuery({
    queryKey: ["documents", "pending", "count"],
    queryFn: () =>
      documentsAPI.list({
        status: "pending_approval",
        is_self_upload: false,
        page: 1,
        page_size: 1,
      }).then((r) => r.data.count ?? 0),
    ...QUERY_SHORT_STALE,
  });

  const { data: completedCount = 0 } = useQuery({
    queryKey: ["documents", "completed", "count"],
    queryFn: () =>
      documentsAPI.list({
        status: "approved",
        is_self_upload: false,
        page: 1,
        page_size: 1,
      }).then((r) => r.data.count ?? 0),
    ...QUERY_SHORT_STALE,
  });

  const { data: myTasks = [], isLoading: tasksLoading } = useQuery({
    queryKey: ["workflow", "my-tasks"],
    queryFn: () => workflowAPI.myTasks().then((r) => r.data.results ?? r.data),
    ...QUERY_SHORT_STALE,
  });

  const { data: recentAudit, isLoading: auditLoading } = useQuery({
    queryKey: ["audit", user?.has_admin_access ? "all" : "mine", recentAuditPage],
    queryFn: () =>
      api
        .get(user?.has_admin_access ? "/audit/" : "/audit/my-activity/", {
          params: {
            ordering: "-timestamp",
            page: recentAuditPage,
            page_size: RECENT_AUDIT_PAGE_SIZE,
          },
        })
        .then((r) => r.data as PaginatedResponse<DashboardAuditEvent>),
    ...QUERY_SHORT_STALE,
  });

  const { data: storageStats } = useQuery<StorageStats>({
    queryKey: ["storage", "stats"],
    queryFn: () => api.get("/storage/stats/").then((res) => res.data),
    ...QUERY_FIVE_MIN_STALE,
  });

  const { data: dashboardSearchResults, isFetching: isDashboardSearchLoading } = useQuery({
    queryKey: ["dashboard", "search", debouncedDashboardSearch],
    queryFn: () =>
      searchAPI.search({
        search: debouncedDashboardSearch,
        page: 1,
        page_size: 5,
      }).then((r) => r.data as DocumentSearchResponse),
    enabled: debouncedDashboardSearch.length >= 2,
    ...QUERY_FOCUS_OFF,
  });

  // ── Computed Values ───────────────────────────────────────────────────────

  const recentDocsCount = recentDocs?.count ?? 0;
  const recentAuditCount = recentAudit?.count ?? 0;
  const recentDocsPages = Math.max(1, Math.ceil(recentDocsCount / RECENT_DOCS_PAGE_SIZE));
  const recentAuditPages = Math.max(1, Math.ceil(recentAuditCount / RECENT_AUDIT_PAGE_SIZE));

  const storage = useMemo(() => {
    if (storageStats) return storageStats;
    return {
      used_bytes: 0,
      total_bytes: 0,
      used_gb: 0,
      total_gb: 0,
      used_mb: 0,
      total_mb: 0,
      percentage: 0,
    };
  }, [storageStats]);
  const storageDisplay = useMemo(
    () => formatStorageAmount(storage.used_bytes),
    [storage.used_bytes],
  );

  const dashboardResults = dashboardSearchResults?.results ?? [];
  const dashboardResultsTotal = dashboardSearchResults?.total ?? 0;
  const showDashboardSearchPanel = isDashboardSearchFocused && dashboardSearch.trim().length > 0;
  const dashboardSearchTerm = dashboardSearch.trim();
  const hasActiveDashboardSelection =
    activeDashboardResultIndex >= 0 && activeDashboardResultIndex < dashboardResults.length;
  const visibleTasks = (myTasks as WorkflowTask[]).slice(0, 4);
  const taskGridClass =
    visibleTasks.length === 1
      ? "mt-5 grid grid-cols-1 gap-3 md:max-w-xl"
      : visibleTasks.length === 2
        ? "mt-5 grid grid-cols-1 gap-3 md:grid-cols-2"
        : "mt-5 grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-4";

  // ── Helper Functions ───────────────────────────────────────────────────────

  // Highlight only the searched term in the snippet (same as SearchPage)
  const highlightTerm = (text: string, term: string) => {
    if (!term || !text) return text;
    const escapedTerm = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const regex = new RegExp(`(${escapedTerm})`, "gi");
    return text.replace(regex, '<span class="bg-yellow-200 text-yellow-800 font-medium px-0.5 rounded">$1</span>');
  };

  // ── Handlers ──────────────────────────────────────────────────────────────

  const handleDashboardSearch = () => {
    const term = dashboardSearchTerm;
    navigate(term ? `/search?q=${encodeURIComponent(term)}` : "/search");
  };

  const handleDashboardResultOpen = (hit: SearchHit) => {
    preloadDocumentWorkspace();
    setIsDashboardSearchFocused(false);
    setActiveDashboardResultIndex(-1);
    navigate(`/documents/${hit.id}`);
  };

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (!dashboardSearchRef.current?.contains(event.target as Node)) {
        setIsDashboardSearchFocused(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  useEffect(() => {
    setActiveDashboardResultIndex(-1);
  }, [debouncedDashboardSearch]);

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="mx-auto w-full max-w-[1680px] space-y-6">
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

        <div className="flex flex-col gap-3 sm:flex-row sm:items-start">
          <div ref={dashboardSearchRef} className="relative w-full sm:w-96">
            <div className="relative">
              <span className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-muted-foreground">
                <Search className="w-4 h-4" />
              </span>
              <input
                type="search"
                placeholder="Search documents, metadata, content..."
                className="input w-full pl-11 pr-4"
                value={dashboardSearch}
                onChange={(e) => setDashboardSearch(e.target.value)}
                onFocus={() => setIsDashboardSearchFocused(true)}
                onKeyDown={(e) => {
                  if (e.key === "ArrowDown" && dashboardResults.length > 0) {
                    e.preventDefault();
                    setIsDashboardSearchFocused(true);
                    setActiveDashboardResultIndex((current) =>
                      current < dashboardResults.length - 1 ? current + 1 : 0,
                    );
                  }
                  if (e.key === "ArrowUp" && dashboardResults.length > 0) {
                    e.preventDefault();
                    setIsDashboardSearchFocused(true);
                    setActiveDashboardResultIndex((current) =>
                      current <= 0 ? dashboardResults.length - 1 : current - 1,
                    );
                  }
                  if (e.key === "Enter") {
                    e.preventDefault();
                    if (activeDashboardResultIndex >= 0 && dashboardResults[activeDashboardResultIndex]) {
                      handleDashboardResultOpen(dashboardResults[activeDashboardResultIndex]);
                      return;
                    }
                    handleDashboardSearch();
                  }
                  if (e.key === "Escape") {
                    setIsDashboardSearchFocused(false);
                    setActiveDashboardResultIndex(-1);
                  }
                }}
              />
            </div>

            {showDashboardSearchPanel && (
              <div
                className="absolute left-0 right-0 top-[calc(100%+0.5rem)] z-30 overflow-hidden rounded-xl border border-border bg-card"
                style={{ boxShadow: "var(--shadow-card)" }}
              >
                <div className="border-b border-border bg-muted/40 px-4 py-3">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <p className="text-sm font-semibold text-foreground">Quick search</p>
                      <p className="text-xs text-muted-foreground">
                        {dashboardSearch.trim().length < 2
                          ? "Type at least 2 characters to search across document text and metadata."
                          : "Open a document directly, or continue to advanced search for filters."}
                      </p>
                    </div>
                    <Sparkles className="h-4 w-4 text-accent" />
                  </div>
                </div>

                {dashboardSearch.trim().length < 2 ? (
                  <div className="px-4 py-5 text-sm text-muted-foreground">
                    Keep typing to see live matches from Elasticsearch.
                  </div>
                ) : isDashboardSearchLoading ? (
                  <div className="flex items-center justify-center px-4 py-6">
                    <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                  </div>
                ) : dashboardResults.length > 0 ? (
                  <>
                    <div className="divide-y divide-border">
                      {dashboardResults.map((hit: SearchHit, index) => {
                        return (
                          <button
                            key={hit.id}
                            type="button"
                            className={`block w-full px-4 py-3 text-left transition-colors hover:bg-muted/40 ${
                              activeDashboardResultIndex === index ? "bg-muted/50" : ""
                            }`}
                            onMouseEnter={() => setActiveDashboardResultIndex(index)}
                            onClick={() => handleDashboardResultOpen(hit)}
                          >
                            <div className="flex items-start justify-between gap-3">
                              <div className="min-w-0 flex-1">
                                <div className="mb-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                                  <span
                                    className="font-mono text-brand-600"
                                    dangerouslySetInnerHTML={{
                                      __html: highlightSearchText(hit.reference_number, dashboardSearchTerm),
                                    }}
                                  />
                                  <span>•</span>
                                  <span>{hit.document_type}</span>
                                  <span>•</span>
                                  <span>{formatDocumentFileType(hit.file_name, hit.file_mime_type)}</span>
                                </div>
                                <p
                                  className="truncate text-sm font-semibold text-foreground"
                                  dangerouslySetInnerHTML={{
                                    __html: highlightSearchText(hit.title, dashboardSearchTerm),
                                  }}
                                />
                                {hit.supplier && (
                                  <p
                                    className="mt-1 truncate text-xs text-muted-foreground"
                                    dangerouslySetInnerHTML={{
                                      __html: highlightSearchText(hit.supplier, dashboardSearchTerm),
                                    }}
                                  />
                                )}
                                {/* Show highlighted snippets like SearchPage */}
                                {hit.highlights && Object.keys(hit.highlights).length > 0 ? (
                                  <div className="mt-2 rounded-md bg-muted/40 px-2.5 py-2">
                                    <div className="line-clamp-3 text-xs leading-5 text-foreground space-y-2">
                                      {getPreferredHighlights(hit, dashboardSearchTerm).slice(0, 2).map(([field, snippet]) => (
                                        <div key={field} className="italic">
                                          <span
                                            dangerouslySetInnerHTML={{
                                              __html: highlightTerm(snippet, dashboardSearchTerm),
                                            }}
                                          />
                                        </div>
                                      ))}
                                    </div>
                                  </div>
                                ) : (
                                  // Fallback: show highlighted metadata when no content highlights available
                                  <div className="mt-2 rounded-md bg-muted/40 px-2.5 py-2">
                                    <div className="line-clamp-3 text-xs leading-5 text-foreground italic">
                                      <span
                                        dangerouslySetInnerHTML={{
                                          __html: highlightTerm(
                                            hit.supplier || hit.title || hit.reference_number,
                                            dashboardSearchTerm
                                          ),
                                        }}
                                      />
                                    </div>
                                  </div>
                                )}
                              </div>
                              <StatusBadge status={hit.status} />
                            </div>
                          </button>
                        );
                      })}
                    </div>

                    <div className="flex items-center justify-between gap-3 border-t border-border bg-muted/30 px-4 py-3">
                      <div className="space-y-1">
                        <p className="text-xs text-muted-foreground">
                          {dashboardResultsTotal} result{dashboardResultsTotal !== 1 ? "s" : ""} for "{dashboardSearchTerm}"
                        </p>
                        <p className="text-[11px] text-muted-foreground">
                          {hasActiveDashboardSelection ? "Enter to open selected result" : "Arrow keys to browse"} • Esc to close
                        </p>
                      </div>
                      <button
                        type="button"
                        onClick={handleDashboardSearch}
                        className="inline-flex items-center gap-2 text-sm font-semibold text-foreground transition-colors hover:text-accent"
                      >
                        Advanced search <ArrowRight className="h-4 w-4" />
                      </button>
                    </div>
                  </>
                ) : (
                  <div className="px-4 py-5">
                    <p className="text-sm font-medium text-foreground">No direct matches yet</p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      Try a different keyword, or open advanced search to apply filters.
                    </p>
                    <button
                      type="button"
                      onClick={handleDashboardSearch}
                      className="mt-3 inline-flex items-center gap-2 text-sm font-semibold text-foreground transition-colors hover:text-accent"
                    >
                      Search everything <ArrowRight className="h-4 w-4" />
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>

          <button
            type="button"
            onClick={handleDashboardSearch}
            className="inline-flex items-center justify-center gap-2 rounded-lg border border-border bg-card px-4 py-2.5 text-sm font-semibold text-foreground transition-colors hover:bg-muted"
          >
            <Search className="w-4 h-4" />
            Search
          </button>
        </div>
      </div>

      {/* Key Metrics */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          title="Total Documents"
          value={totalDocuments}
          icon={FileText}
          color="primary"
          trend={{ value: 4.2, isPositive: true }}
          href="/documents"
        />
        <StatCard
          title="Pending Approval"
          value={pendingCount}
          icon={Clock}
          color="accent"
          trend={{ value: 12, isPositive: false, suffix: "" }}
          href="/documents?status=pending_approval"
        />
        <StatCard
          title="Approved Today"
          value={completedCount}
          icon={CheckCircle}
          color="primary"
          trend={{ value: 8.1, isPositive: true }}
          href="/documents?status=approved"
        />
        <StatCard
          title="My Tasks"
          value={myTasks.length}
          icon={ShieldCheck}
          color="teal"
          trend={{ value: 0.4, isPositive: true }}
          href="/workflow"
        />
      </div>

      {/* Recent Documents (wide) + Audit Trail w/ Storage (narrow) */}
      <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">
        {/* Recent Documents — clean compact rows */}
        <section
          className="xl:col-span-2 rounded-xl border border-border bg-card overflow-hidden"
          style={{ boxShadow: "var(--shadow-card)" }}
        >
          <div className="flex items-center justify-between border-b border-border px-5 py-4">
            <div>
              <h2 className="text-sm font-semibold text-foreground">Recent Documents</h2>
              <p className="text-xs text-muted-foreground">Latest activity across all repositories</p>
            </div>
            <Link to="/documents" className="text-xs font-semibold text-foreground hover:text-accent transition-colors inline-flex items-center gap-1">
              View all <ArrowRight className="w-3 h-3" />
            </Link>
          </div>

          <div className="overflow-x-auto">
            {docsLoading ? (
              <div className="p-10 flex justify-center">
                <Loader2 className="w-6 h-6 text-muted-foreground animate-spin" />
              </div>
            ) : recentDocs?.results?.length ? (
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-[11px] uppercase tracking-wider text-muted-foreground">
                    <th className="px-5 py-3 font-medium">Name</th>
                    <th className="px-5 py-3 font-medium hidden md:table-cell">Type</th>
                    <th className="px-5 py-3 font-medium">Status</th>
                    <th className="px-5 py-3 font-medium hidden md:table-cell">Updated</th>
                  </tr>
                </thead>
                <tbody>
                  {recentDocs.results.map((doc: Document) => (
                    <tr
                      key={doc.id}
                      className="border-t border-border transition hover:bg-muted/40 cursor-pointer"
                      onClick={() => { preloadDocumentWorkspace(); navigate(`/documents/${doc.id}`); }}
                      onMouseEnter={preloadDocumentWorkspace}
                    >
                      <td className="px-5 py-3">
                        <div className="flex items-center gap-3 min-w-0">
                          <div className="flex h-9 w-9 items-center justify-center rounded-md bg-primary/5 text-primary shrink-0">
                            <FileText className="h-4 w-4" />
                          </div>
                          <div className="min-w-0">
                            <p className="font-medium text-foreground truncate">{doc.title}</p>
                            <p className="text-[11px] text-muted-foreground truncate">
                              {doc.reference_number} · {doc.document_type_name || doc.document_type?.name || "Unclassified"}
                            </p>
                          </div>
                        </div>
                      </td>
                      <td className="px-5 py-3 text-muted-foreground hidden md:table-cell">
                        {formatDocumentFileType(doc.file_name, doc.file_mime_type)}
                      </td>
                      <td className="px-5 py-3">
                        <StatusBadge status={doc.status} />
                      </td>
                      <td className="px-5 py-3 text-muted-foreground hidden md:table-cell">
                        {formatDistanceToNow(new Date(doc.updated_at), { addSuffix: true })}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
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
            <div className="flex items-center justify-between border-t border-border bg-muted/20 px-5 py-3">
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
        </section>

        {/* Audit Trail with Storage merged at bottom */}
        <section className="rounded-xl border border-border bg-card p-5 flex flex-col" style={{ boxShadow: "var(--shadow-card)" }}>
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-foreground">
              {user?.has_admin_access ? "Audit Trail" : "My Activity"}
            </h2>
            <span className="rounded-full bg-teal/10 px-2 py-0.5 text-[10px] font-medium text-teal">Live</span>
          </div>
          <p className="text-xs text-muted-foreground">Recent user actions</p>

          <ul className="mt-5 space-y-4 flex-1">
            {auditLoading ? (
              <li className="rounded-lg bg-muted/40 p-4 text-center text-xs text-muted-foreground">Loading activity…</li>
            ) : recentAudit?.results?.length ? (
              recentAudit.results.map((event: DashboardAuditEvent, index: number) => {
                const meta = getAuditPresentation(event);
                const Icon = meta.icon;
                const isLast = index === (recentAudit.results.length - 1);
                const initials = (event.actor_name || event.actor_email || "S")
                  .split(/[ @._-]/)
                  .filter(Boolean)
                  .slice(0, 2)
                  .map((s) => s[0]?.toUpperCase())
                  .join("") || "S";
                return (
                  <li key={event.id} className="flex gap-3">
                    <div className="relative">
                      <div className="flex h-8 w-8 items-center justify-center rounded-full bg-primary text-[11px] font-semibold text-primary-foreground">
                        {initials}
                      </div>
                      {!isLast && <div className="absolute left-1/2 top-8 h-full w-px -translate-x-1/2 bg-border" />}
                    </div>
                    <div className="flex-1 pb-1 min-w-0">
                      <p className="text-sm text-foreground truncate">
                        <span className="text-muted-foreground">{meta.label.toLowerCase()}</span>{" "}
                        <span className="font-medium">{event.summary || event.event}</span>
                      </p>
                      <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground mt-0.5">
                        <Icon className="w-3 h-3" />
                        <span>{formatDistanceToNow(new Date(event.timestamp), { addSuffix: true })}</span>
                      </div>
                    </div>
                  </li>
                );
              })
            ) : (
              <li className="rounded-lg bg-muted/40 p-4 text-center text-xs text-muted-foreground">No recent audit events.</li>
            )}
          </ul>

          {recentAuditCount > RECENT_AUDIT_PAGE_SIZE && (
            <div className="mt-4 flex items-center justify-between border-t border-border pt-3">
              <span className="text-[11px] text-muted-foreground">
                {recentAuditPage} / {recentAuditPages}
              </span>
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => setRecentAuditPage((p) => Math.max(1, p - 1))}
                  disabled={recentAuditPage === 1}
                  className="inline-flex items-center rounded-md border border-border bg-card p-1 text-foreground hover:bg-muted disabled:opacity-40"
                >
                  <ChevronLeft className="w-3.5 h-3.5" />
                </button>
                <button
                  type="button"
                  onClick={() => setRecentAuditPage((p) => p + 1)}
                  disabled={recentAuditPage * RECENT_AUDIT_PAGE_SIZE >= recentAuditCount}
                  className="inline-flex items-center rounded-md border border-border bg-card p-1 text-foreground hover:bg-muted disabled:opacity-40"
                >
                  <ChevronRight className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>
          )}

          <Link to="/audit" className="mt-3 text-xs font-semibold text-foreground hover:text-accent transition-colors text-center">
            View full log →
          </Link>

          {/* Storage merged at bottom */}
          <div className="mt-5 rounded-lg border border-dashed border-border p-4">
            <div className="flex items-center justify-between">
              <p className="text-xs font-medium text-foreground">Storage Used</p>
              <p className="text-[11px] text-muted-foreground">{storage.percentage}%</p>
            </div>
            <div className="mt-2 h-2 overflow-hidden rounded-full bg-muted">
              <div
                className="h-full rounded-full transition-all duration-500"
                style={{
                  width: `${storage.percentage}%`,
                  background: storage.percentage > 85 ? "hsl(var(--destructive))" : "var(--gradient-accent)",
                }}
              />
            </div>
            <p className="mt-2 text-[11px] text-muted-foreground">
              {storageDisplay.value} {storageDisplay.unit} of {storage.total_gb} GB
            </p>
            {storage.percentage > 80 && (
              <p className="mt-2 text-[11px] text-destructive font-medium">
                Approaching storage limit — consider archiving old documents.
              </p>
            )}
          </div>
        </section>
      </div>

      {/* Pending tasks */}
      <div className="bg-card rounded-xl border border-border p-5" style={{ boxShadow: "var(--shadow-card)" }}>
        <div className="flex items-center justify-between gap-3">
          <div className="space-y-1 min-w-0">
            <p className="text-sm font-semibold text-foreground">Pending tasks</p>
            <p className="text-sm text-muted-foreground">
              {tasksLoading
                ? "Checking tasks waiting for your attention."
                : myTasks.length
                  ? "Tasks waiting for your attention."
                  : "All clear. No tasks need your attention right now."}
            </p>
          </div>
          <div className="shrink-0 rounded-full bg-teal/10 px-3 py-1 text-xs font-semibold text-teal">
            {myTasks.length} open
          </div>
        </div>

        {tasksLoading ? (
          <div className="mt-4 rounded-lg bg-muted/40 p-4 text-sm text-muted-foreground">
            <div className="flex items-center gap-2">
              <Loader2 className="h-4 w-4 animate-spin text-accent" />
              Loading tasks...
            </div>
          </div>
        ) : visibleTasks.length ? (
          <div className={taskGridClass}>
            {visibleTasks.map((task: WorkflowTask) => {
              const doc = task.workflow_instance?.document;
              const documentType =
                doc?.document_type_name ?? doc?.document_type?.name ?? task.document_type_name ?? "Unclassified";
              const documentFormat = formatDocumentFileType(task.file_name, task.file_mime_type);
              return (
                <Link
                  key={task.id}
                  to={doc?.id ? `/documents/${doc.id}` : "/workflow"}
                  className="block rounded-lg border border-border bg-muted/30 p-4 transition-colors hover:bg-muted/60"
                >
                  <div className="flex items-start gap-3">
                    <div className="mt-0.5 rounded-md border border-accent/30 bg-accent/15 p-2 text-accent">
                      <Clock className="w-4 h-4" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-semibold text-foreground">
                        {doc?.title || task.document_title || "Untitled document"}
                      </p>
                      <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                        <span>{documentType}</span>
                        <span>•</span>
                        <span>{documentFormat}</span>
                        <span>•</span>
                        <span>{task.step?.name}</span>
                      </div>
                      <div className="mt-1"><TaskMetaInfo dueAt={task.due_at} /></div>
                    </div>
                  </div>
                </Link>
              );
            })}
          </div>
        ) : (
          <div className="mt-4 inline-flex items-center gap-2 rounded-lg border border-teal/25 bg-teal/10 px-3 py-2 text-sm font-medium text-teal">
            <CheckCircle className="h-4 w-4" />
            You have no pending tasks right now.
          </div>
        )}
      </div>
    </div>
  );
}
