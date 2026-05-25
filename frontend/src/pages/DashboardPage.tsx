// DashboardPage.tsx — Production Enterprise DMS
import { useQuery } from "@tanstack/react-query";
import { api, documentsAPI, searchAPI, workflowAPI } from "@/services/api";
import { useAuthStore } from "@/store/authStore";
import {
  GitBranch, ArrowRight, ChevronLeft, ChevronRight,
  Layers, Timer, ShieldCheck, ClipboardCheck,
  Calendar, FileText, Inbox, ListChecks, Loader2, Search, Sparkles,
  Filter, X, Hourglass, BarChart3, UploadCloud,
} from "lucide-react";
import { Link, useNavigate } from "react-router-dom";
import { formatDistanceToNow } from "date-fns";
import clsx from "clsx";
import StatusBadge from "@/components/documents/StatusBadge";
import { useEffect, useRef, useState, useMemo } from "react";
import type { Document, DocumentSearchResponse, SearchHit, WorkflowTask } from "@/types";
import { StatCard } from "@/components/dashboard/StatCard";
import { useDebounce } from "@/hooks/useDebounce";
import { highlightSearchText, getPreferredHighlights } from "@/lib/search";
import { QUERY_FIVE_MIN_STALE, QUERY_SHORT_STALE, QUERY_FOCUS_OFF } from "@/lib/reactQueryDefaults";
import { formatDocumentFileType } from "@/lib/documentFormat";
import { preloadDocumentWorkspace } from "@/lib/routePreload";
import {
  DEFAULT_WORKFLOW_TASK_FILTERS,
  buildWorkflowTaskFilterOptions,
  filterWorkflowTasks,
  getTaskDepartment,
  getTaskDocumentFormat,
  getTaskDocumentId,
  getTaskDocumentTitle,
  getTaskDocumentType,
  getTaskUploaderName,
  hasWorkflowTaskFilters,
  type WorkflowTaskFilters,
} from "@/lib/workflowTaskFilters";

const RECENT_DOCS_PAGE_SIZE = 5;
const RECENT_AUDIT_PAGE_SIZE = 5;
const TREND_WINDOW_DAYS = 30;

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

type StatTrend = {
  value: number;
  isPositive: boolean;
  direction: "up" | "down" | "flat";
  suffix?: string;
  label?: string;
};

function addDays(date: Date, days: number) {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function toDateParam(date: Date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function getDashboardTrendWindow() {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  return {
    today: toDateParam(today),
    currentFrom: toDateParam(addDays(today, -(TREND_WINDOW_DAYS - 1))),
    currentTo: toDateParam(today),
    previousFrom: toDateParam(addDays(today, -(TREND_WINDOW_DAYS * 2 - 1))),
    previousTo: toDateParam(addDays(today, -TREND_WINDOW_DAYS)),
  };
}

function getPercentChange(current: number, previous: number) {
  if (!Number.isFinite(current) || !Number.isFinite(previous)) return 0.0;
  if (previous === 0) return 0.0;
  return Math.round(((current - previous) / previous) * 1000) / 10;
}

function buildTrend(
  current: number,
  previous: number,
  positiveWhenIncrease: boolean,
  label: string,
): StatTrend {
  const direction =
    current > previous ? "up" : current < previous ? "down" : "flat";
  const isPositive =
    direction === "flat" ||
    (positiveWhenIncrease ? direction === "up" : direction === "down");

  if (current === 0 && previous === 0) {
    return {
      value: 0.0,
      isPositive: true,
      direction: "flat",
      label,
    };
  }

  if (previous === 0) {
    return {
      value: current,
      isPositive: true,
      direction: "up",
      suffix: " new",
      label,
    };
  }

  return {
    value: getPercentChange(current, previous),
    isPositive,
    direction,
    label,
  };
}

function countDueSoonTasks(tasks: WorkflowTask[]) {
  const now = Date.now();
  const tomorrow = now + 24 * 60 * 60 * 1000;

  return tasks.filter((task) => {
    if (!task.due_at) return false;
    const dueAt = new Date(task.due_at).getTime();
    return Number.isFinite(dueAt) && dueAt <= tomorrow;
  }).length;
}

function getDocumentOwnerName(doc: Document) {
  const owner = doc.uploaded_by;
  const fullName = owner?.full_name || [owner?.first_name, owner?.last_name].filter(Boolean).join(" ").trim();
  return fullName || owner?.email || "—";
}

function getDocumentDepartmentName(doc: Document) {
  return (
    doc.department_name ||
    doc.uploaded_by_department_name ||
    doc.uploaded_by?.department_name ||
    "—"
  );
}

function getDashboardStatusLabel(status: string): string {
  return status ? status.replace(/_/g, " ").replace(/\b\w/g, (char) => char.toUpperCase()) : "Unknown";
}

function getDashboardStatusClass(status: string): string {
  const key = status?.toLowerCase?.().replace(/\s+/g, "_") ?? "";
  if (["approved", "completed"].includes(key)) return "text-emerald-700";
  if (["pending_review", "pending_approval"].includes(key)) return "text-amber-700";
  if (["rejected", "void"].includes(key)) return "text-red-700";
  if (key === "archived") return "text-sky-700";
  return "text-[#3F474F]";
}

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
  const name = String(event?.event ?? "").toLowerCase();
  if (name.includes("login") || name.includes("logout") || name.startsWith("user.")) {
    return { icon: ShieldCheck, tone: "bg-accent/15 text-accent border-accent/30" };
  }
  if (name.startsWith("workflow.") || name.includes("approve") || name.includes("reject") || name.includes("submit")) {
    return { icon: GitBranch, tone: "bg-primary/10 text-primary border-primary/20" };
  }
  if (name.includes("download") || name.includes("view") || name.includes("share")) {
    return { icon: ArrowRight, tone: "bg-teal/15 text-teal border-teal/30" };
  }
  if (name.includes("upload") || name.includes("create") || name.includes("edit") || name.includes("update") || name.includes("version")) {
    return { icon: FileText, tone: "bg-primary/10 text-primary border-primary/20" };
  }
  if (name.includes("delete") || name.includes("fail") || name.includes("error")) {
    return { icon: ShieldCheck, tone: "bg-destructive/10 text-destructive border-destructive/30" };
  }
  return { icon: ShieldCheck, tone: "bg-muted text-muted-foreground border-border" };
}

type AuditSummaryParts = {
  actor: string;
  verb: string;
  target: string;
};

function cleanAuditTitle(rawTitle: string): string {
  return rawTitle
    .replace(/\[[^\]]+\]/g, "")
    .replace(/\bdocument\s+/ig, "")
    .replace(/\s+/g, " ")
    .trim();
}

function shortenName(fullName: string): string {
  const parts = fullName.split(/\s+/).filter(Boolean);
  if (parts.length === 0) return fullName;
  if (parts.length === 1) return parts[0];
  return `${parts[0][0]}. ${parts[parts.length - 1]}`;
}

function deriveActorName(event: DashboardAuditEvent): string {
  if (event.actor_name && event.actor_name.trim()) return shortenName(event.actor_name.trim());
  if (event.actor_email) {
    const local = event.actor_email.split("@")[0];
    return shortenName(local.replace(/[._-]+/g, " "));
  }
  return "System";
}

// Map raw event codes to clean, human verbs.
const EVENT_VERB_MAP: Record<string, string> = {
  "user.login": "signed in",
  "user.logout": "signed out",
  "user.login_failed": "failed to sign in",
  "user.password_changed": "changed their password",
  "user.created": "was added",
  "user.updated": "updated their profile",
  "document.created": "uploaded",
  "document.bulk_uploaded": "bulk uploaded",
  "document.bulk_reviewed": "reviewed",
  "document.updated": "updated",
  "document.edited": "edited",
  "document.deleted": "deleted",
  "document.downloaded": "downloaded",
  "document.viewed": "viewed",
  "document.previewed": "previewed",
  "document.printed": "printed",
  "document.ocr_queued": "queued OCR for",
  "document.ocr_completed": "completed OCR for",
  "document.ocr_failed": "failed OCR for",
  "document.preview_queued": "queued preview for",
  "document.edit_lock_acquired": "started editing",
  "document.edit_lock_released": "stopped editing",
  "document.shared": "shared",
  "document.archived": "archived",
  "document.version_uploaded": "added a new version of",
  "document.version_restored": "restored",
  "document.version_preview_queued": "queued version preview for",
  "document.submitted": "submitted",
  "workflow.approved": "approved",
  "workflow.rejected": "rejected",
  "workflow.returned": "returned",
  "workflow.held": "put on hold",
  "workflow.released": "released",
  "workflow.cancelled": "cancelled the workflow for",
  "workflow.delegated": "delegated tasks to",
  "workflow.reassigned": "reassigned tasks to",
  "audit.exported": "exported",
};

const VERB_RE = /(submitted|uploaded|edited|updated|created|deleted|approved|rejected|downloaded|viewed|previewed|printed|shared|failed|queued|completed|logged in|logged out|signed in|signed out|enabled|disabled|returned|held|released|archived|added|delegated|reassigned|exported)\b/i;

function formatAuditSummary(event: DashboardAuditEvent): AuditSummaryParts {
  const actor = deriveActorName(event);
  const code = String(event.event ?? "").toLowerCase();
  const summary = (event.summary || "").trim();
  const objectTitle = cleanAuditTitle(event.object_repr || "");

  const mappedVerb = EVENT_VERB_MAP[code];
  if (mappedVerb) {
    return { actor, verb: mappedVerb, target: objectTitle };
  }

  if (summary) {
    const match = summary.match(VERB_RE);
    if (match) {
      const verb = match[1].toLowerCase();
      const after = summary.slice(match.index! + match[0].length).trim();
      const target = objectTitle || cleanAuditTitle(after);
      return { actor, verb, target };
    }
    return { actor, verb: "", target: objectTitle || cleanAuditTitle(summary) };
  }

  const action = code.split(".").pop() || code;
  const verb = action.replace(/_/g, " ").trim();
  return { actor, verb, target: objectTitle };
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
  const [taskFilters, setTaskFilters] = useState<WorkflowTaskFilters>(DEFAULT_WORKFLOW_TASK_FILTERS);
  const [metricsEnabled, setMetricsEnabled] = useState(false);

  const dashboardSearchRef = useRef<HTMLDivElement | null>(null);
  const debouncedDashboardSearch = useDebounce(dashboardSearch.trim(), 300);
  const trendWindow = useMemo(() => getDashboardTrendWindow(), []);

  useEffect(() => {
    const timer = window.setTimeout(() => setMetricsEnabled(true), 600);
    return () => window.clearTimeout(timer);
  }, []);

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
    enabled: metricsEnabled,
    ...QUERY_FIVE_MIN_STALE,
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
    enabled: metricsEnabled,
    ...QUERY_FIVE_MIN_STALE,
  });

  const { data: approvedTodayCount = 0 } = useQuery({
    queryKey: ["documents", "approved", "today-count", trendWindow.today],
    queryFn: () =>
      documentsAPI.list({
        status: "approved",
        is_self_upload: false,
        approved_from: trendWindow.today,
        page: 1,
        page_size: 1,
      }).then((r) => r.data.count ?? 0),
    enabled: metricsEnabled,
    ...QUERY_FIVE_MIN_STALE,
  });

  const { data: documentsCreatedThisPeriod = 0 } = useQuery({
    queryKey: ["documents", "created-count", trendWindow.currentFrom, trendWindow.currentTo],
    queryFn: () =>
      documentsAPI.list({
        created_from: trendWindow.currentFrom,
        created_to: trendWindow.currentTo,
        page: 1,
        page_size: 1,
      }).then((r) => r.data.count ?? 0),
    enabled: metricsEnabled,
    ...QUERY_FIVE_MIN_STALE,
  });

  const { data: documentsCreatedPreviousPeriod = 0 } = useQuery({
    queryKey: ["documents", "created-count", trendWindow.previousFrom, trendWindow.previousTo],
    queryFn: () =>
      documentsAPI.list({
        created_from: trendWindow.previousFrom,
        created_to: trendWindow.previousTo,
        page: 1,
        page_size: 1,
      }).then((r) => r.data.count ?? 0),
    enabled: metricsEnabled,
    ...QUERY_FIVE_MIN_STALE,
  });

  const { data: pendingCreatedThisPeriod = 0 } = useQuery({
    queryKey: ["documents", "pending", "created-count", trendWindow.currentFrom, trendWindow.currentTo],
    queryFn: () =>
      documentsAPI.list({
        status: "pending_approval",
        is_self_upload: false,
        created_from: trendWindow.currentFrom,
        created_to: trendWindow.currentTo,
        page: 1,
        page_size: 1,
      }).then((r) => r.data.count ?? 0),
    enabled: metricsEnabled,
    ...QUERY_FIVE_MIN_STALE,
  });

  const { data: pendingCreatedPreviousPeriod = 0 } = useQuery({
    queryKey: ["documents", "pending", "created-count", trendWindow.previousFrom, trendWindow.previousTo],
    queryFn: () =>
      documentsAPI.list({
        status: "pending_approval",
        is_self_upload: false,
        created_from: trendWindow.previousFrom,
        created_to: trendWindow.previousTo,
        page: 1,
        page_size: 1,
      }).then((r) => r.data.count ?? 0),
    enabled: metricsEnabled,
    ...QUERY_FIVE_MIN_STALE,
  });

  const { data: approvedThisPeriod = 0 } = useQuery({
    queryKey: ["documents", "approved", "approved-count", trendWindow.currentFrom, trendWindow.currentTo],
    queryFn: () =>
      documentsAPI.list({
        status: "approved",
        is_self_upload: false,
        approved_from: trendWindow.currentFrom,
        approved_to: trendWindow.currentTo,
        page: 1,
        page_size: 1,
      }).then((r) => r.data.count ?? 0),
    enabled: metricsEnabled,
    ...QUERY_FIVE_MIN_STALE,
  });

  const { data: approvedPreviousPeriod = 0 } = useQuery({
    queryKey: ["documents", "approved", "approved-count", trendWindow.previousFrom, trendWindow.previousTo],
    queryFn: () =>
      documentsAPI.list({
        status: "approved",
        is_self_upload: false,
        approved_from: trendWindow.previousFrom,
        approved_to: trendWindow.previousTo,
        page: 1,
        page_size: 1,
      }).then((r) => r.data.count ?? 0),
    enabled: metricsEnabled,
    ...QUERY_FIVE_MIN_STALE,
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
    enabled: metricsEnabled,
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
  const allTasks = myTasks as WorkflowTask[];
  const hasOpenTasks = allTasks.length > 0;
  const showAdminRecentColumns = Boolean(user?.has_admin_access);
  const totalDocumentsTrend = buildTrend(
    documentsCreatedThisPeriod,
    documentsCreatedPreviousPeriod,
    true,
    `Documents created in the last ${TREND_WINDOW_DAYS} days vs previous ${TREND_WINDOW_DAYS} days`,
  );
  const pendingApprovalTrend = buildTrend(
    pendingCreatedThisPeriod,
    pendingCreatedPreviousPeriod,
    false,
    `Pending approvals created in the last ${TREND_WINDOW_DAYS} days vs previous ${TREND_WINDOW_DAYS} days`,
  );
  const approvedTrend = buildTrend(
    approvedThisPeriod,
    approvedPreviousPeriod,
    true,
    `Documents approved in the last ${TREND_WINDOW_DAYS} days vs previous ${TREND_WINDOW_DAYS} days`,
  );
  const dueSoonTaskCount = countDueSoonTasks(allTasks);
  const tasksTrend: StatTrend | undefined =
    dueSoonTaskCount > 0
      ? {
          value: dueSoonTaskCount,
          isPositive: false,
          direction: "flat",
          suffix: " due",
          label: "Tasks due within 24 hours or overdue",
        }
      : undefined;
  const taskFilterOptions = useMemo(() => buildWorkflowTaskFilterOptions(allTasks), [allTasks]);
  const filteredTasks = useMemo(
    () => filterWorkflowTasks(allTasks, taskFilters),
    [allTasks, taskFilters],
  );
  const hasTaskFilters = hasWorkflowTaskFilters(taskFilters);
  const visibleTasks = filteredTasks.slice(0, hasTaskFilters ? 8 : 4);
  const taskGridClass =
    visibleTasks.length === 1
      ? "mt-4 grid grid-cols-1 gap-3 md:max-w-xl"
      : visibleTasks.length === 2
        ? "mt-4 grid grid-cols-1 gap-3 md:grid-cols-2"
        : "mt-4 grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-4";
  const activityCardStyle = {
    minHeight: "440px",
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

  const updateTaskFilter = <K extends keyof WorkflowTaskFilters>(
    key: K,
    value: WorkflowTaskFilters[K],
  ) => {
    setTaskFilters((current) => ({ ...current, [key]: value }));
  };

  const clearTaskFilters = () => setTaskFilters(DEFAULT_WORKFLOW_TASK_FILTERS);

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
    <div className="-m-6 min-h-[calc(100vh-3.5rem)] bg-[#EDEDED] text-[#1F2933]">
      <div className="flex min-h-[69px] flex-col gap-3 bg-[#287EAD] px-5 py-3 text-white xl:flex-row xl:items-center xl:justify-between">
        <div className="min-w-0">
          <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-white/70">Operations workspace</p>
          <h1 className="mt-1 text-xl font-semibold tracking-tight">
            {user?.first_name ? `Welcome, ${user.first_name}` : "Document Operations"}
          </h1>
        </div>

        <div className="flex min-w-0 flex-1 flex-col gap-2 xl:max-w-3xl xl:flex-row xl:items-start">
          <div ref={dashboardSearchRef} className="relative min-w-0 flex-1">
            <div className="relative">
              <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[#5E6870]">
                <Search className="w-4 h-4" />
              </span>
              <input
                type="search"
                placeholder="Search documents, metadata, content..."
                className="h-9 w-full border border-[#AEB5BB] bg-white pl-9 pr-3 text-sm text-[#1F2933] placeholder:text-[#6E767D] focus:outline-none focus:ring-1 focus:ring-white/70"
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
                className="absolute left-0 right-0 top-[calc(100%+0.5rem)] z-30 overflow-hidden border border-[#C8CDD2] bg-white text-[#1F2933] shadow-2xl"
              >
                <div className="border-b border-[#C8CDD2] bg-[#F5F7F8] px-4 py-3">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <p className="text-sm font-semibold text-[#1F2933]">Quick search</p>
                      <p className="text-xs text-[#5E6870]">
                        {dashboardSearch.trim().length < 2
                          ? "Type at least 2 characters to search across document text and metadata."
                          : "Open a document directly, or continue to advanced search for filters."}
                      </p>
                    </div>
                    <Sparkles className="h-4 w-4 text-[#287EAD]" />
                  </div>
                </div>

                {dashboardSearch.trim().length < 2 ? (
                  <div className="px-4 py-5 text-sm text-[#5E6870]">
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
                        const preferredHighlights = getPreferredHighlights(hit, dashboardSearchTerm).slice(0, 2);

                        return (
                          <button
                            key={hit.id}
                            type="button"
                            className={`block w-full px-4 py-3 text-left transition-colors hover:bg-[#F5F7F8] ${
                              activeDashboardResultIndex === index ? "bg-[#EEF6FB]" : ""
                            }`}
                            onMouseEnter={() => setActiveDashboardResultIndex(index)}
                            onClick={() => handleDashboardResultOpen(hit)}
                          >
                            <div className="flex items-start justify-between gap-3">
                              <div className="min-w-0 flex-1">
                                <div className="mb-1 flex flex-wrap items-center gap-2 text-xs text-[#5E6870]">
                                  <span
                                    className="font-mono text-[#287EAD]"
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
                                  className="truncate text-sm font-semibold text-[#1F2933]"
                                  dangerouslySetInnerHTML={{
                                    __html: highlightSearchText(String(hit.title || ""), dashboardSearchTerm),
                                  }}
                                />
                                {hit.supplier && (
                                  <p
                                    className="mt-1 truncate text-xs text-[#5E6870]"
                                    dangerouslySetInnerHTML={{
                                      __html: highlightSearchText(hit.supplier, dashboardSearchTerm),
                                    }}
                                  />
                                )}
                                {preferredHighlights.length > 0 ? (
                                  <div className="mt-2 bg-[#F5F7F8] px-2.5 py-2">
                                    <div className="line-clamp-3 space-y-2 text-xs leading-5 text-[#1F2933]">
                                      {preferredHighlights.map(([field, snippet]) => (
                                        <div key={field} className="italic">
                                          <span
                                            dangerouslySetInnerHTML={{
                                              __html: highlightSearchText(snippet, dashboardSearchTerm),
                                            }}
                                          />
                                        </div>
                                      ))}
                                    </div>
                                  </div>
                                ) : (
                                  <div className="mt-2 bg-[#F5F7F8] px-2.5 py-2">
                                    <div className="line-clamp-3 text-xs italic leading-5 text-[#1F2933]">
                                      <span
                                        dangerouslySetInnerHTML={{
                                          __html: highlightSearchText(
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

                    <div className="flex items-center justify-between gap-3 border-t border-[#C8CDD2] bg-[#F5F7F8] px-4 py-3">
                      <div className="space-y-1">
                        <p className="text-xs text-[#5E6870]">
                          {dashboardResultsTotal} result{dashboardResultsTotal !== 1 ? "s" : ""} for "{dashboardSearchTerm}"
                        </p>
                        <p className="text-[11px] text-[#5E6870]">
                          {hasActiveDashboardSelection ? "Enter to open selected result" : "Arrow keys to browse"} • Esc to close
                        </p>
                      </div>
                      <button
                        type="button"
                        onClick={handleDashboardSearch}
                        className="inline-flex items-center gap-2 text-sm font-semibold text-[#287EAD] transition-colors hover:text-[#206D99]"
                      >
                        Advanced search <ArrowRight className="h-4 w-4" />
                      </button>
                    </div>
                  </>
                ) : (
                  <div className="px-4 py-5">
                    <p className="text-sm font-medium text-[#1F2933]">No direct matches yet</p>
                    <p className="mt-1 text-xs text-[#5E6870]">
                      Try a different keyword, or open advanced search to apply filters.
                    </p>
                    <button
                      type="button"
                      onClick={handleDashboardSearch}
                      className="mt-3 inline-flex items-center gap-2 text-sm font-semibold text-[#287EAD] transition-colors hover:text-[#206D99]"
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
            className="inline-flex h-9 items-center justify-center gap-2 border border-white/20 bg-[#206D99] px-4 text-sm font-semibold text-white transition-colors hover:bg-[#1B5F86]"
          >
            <Search className="w-4 h-4" />
            Search
          </button>
        </div>
      </div>

      <div className="space-y-4 p-4 pr-8">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <StatCard
            title="Total Documents"
            value={totalDocuments}
            icon={Layers}
            color="primary"
            trend={totalDocumentsTrend}
            href="/documents"
          />
          <StatCard
            title="Pending Approval"
            value={pendingCount}
            icon={Timer}
            color="accent"
            trend={pendingApprovalTrend}
            href="/documents?status=pending_approval"
          />
          <StatCard
            title="Approved Today"
            value={approvedTodayCount}
            icon={ShieldCheck}
            color="primary"
            trend={approvedTrend}
            href="/documents?status=approved"
          />
          <StatCard
            title="My Tasks"
            value={myTasks.length}
            icon={ClipboardCheck}
            color="teal"
            trend={tasksTrend}
            href="/workflow"
          />
        </div>

        <div className="grid grid-cols-1 gap-3 xl:grid-cols-[1fr_360px]">
          <section className="border border-[#C8CDD2] bg-white">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[#C8CDD2] px-4 py-3">
              <div>
                <h2 className="text-sm font-bold text-[#1F2933]">Work queue</h2>
                <p className="text-sm text-[#5E6870]">
                  {tasksLoading
                    ? "Checking tasks waiting for your attention."
                    : hasOpenTasks
                      ? hasTaskFilters
                        ? `${filteredTasks.length} of ${allTasks.length} tasks match your filters.`
                        : "Tasks waiting for your attention."
                      : "All clear. No tasks need your attention right now."}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <span className="inline-flex items-center gap-1.5 border border-[#287EAD]/25 bg-[#EEF6FB] px-2.5 py-1 text-xs font-bold text-[#287EAD]">
                  <Inbox className="h-3.5 w-3.5" />
                  {allTasks.length} open
                </span>
                <Link
                  to="/workflow"
                  className="inline-flex items-center gap-1 border border-[#C8CDD2] bg-white px-3 py-1.5 text-xs font-bold text-[#1F2933] hover:bg-[#F5F7F8]"
                >
                  View queue <ArrowRight className="h-3.5 w-3.5" />
                </Link>
              </div>
            </div>

            {hasOpenTasks && (
              <div className="border-b border-[#C8CDD2] bg-[#F5F7F8] p-3">
                <div className="grid grid-cols-1 gap-2 md:grid-cols-2 xl:grid-cols-6">
                  <div className="relative xl:col-span-2">
                    <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[#5E6870]" />
                    <input
                      type="search"
                      value={taskFilters.search}
                      onChange={(e) => updateTaskFilter("search", e.target.value)}
                      placeholder="Find title, reference, uploader..."
                      className="h-9 w-full border border-[#AEB5BB] bg-white pl-9 pr-3 text-sm text-[#1F2933] focus:outline-none focus:ring-1 focus:ring-[#287EAD]"
                    />
                  </div>
                  <select value={taskFilters.documentType} onChange={(e) => updateTaskFilter("documentType", e.target.value)} className="h-9 border border-[#AEB5BB] bg-white px-2 text-sm text-[#1F2933]">
                    <option value="">All document types</option>
                    {taskFilterOptions.documentTypes.map((option) => <option key={option.value} value={option.value}>{option.label} ({option.count})</option>)}
                  </select>
                  <select value={taskFilters.department} onChange={(e) => updateTaskFilter("department", e.target.value)} className="h-9 border border-[#AEB5BB] bg-white px-2 text-sm text-[#1F2933]">
                    <option value="">All departments</option>
                    {taskFilterOptions.departments.map((option) => <option key={option.value} value={option.value}>{option.label} ({option.count})</option>)}
                  </select>
                  <select value={taskFilters.fileFormat} onChange={(e) => updateTaskFilter("fileFormat", e.target.value)} className="h-9 border border-[#AEB5BB] bg-white px-2 text-sm text-[#1F2933]">
                    <option value="">All formats</option>
                    {taskFilterOptions.fileFormats.map((option) => <option key={option.value} value={option.value}>{option.label} ({option.count})</option>)}
                  </select>
                  <select value={taskFilters.urgency} onChange={(e) => updateTaskFilter("urgency", e.target.value as WorkflowTaskFilters["urgency"])} className="h-9 border border-[#AEB5BB] bg-white px-2 text-sm text-[#1F2933]">
                    <option value="">Any urgency</option>
                    <option value="overdue">Overdue</option>
                    <option value="due_soon">Due in 24h</option>
                    <option value="held">On hold</option>
                  </select>
                </div>
                <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-xs text-[#5E6870]">
                  <div className="inline-flex items-center gap-1.5">
                    <Filter className="h-3.5 w-3.5" />
                    <span>{filteredTasks.length} matching task{filteredTasks.length !== 1 ? "s" : ""}</span>
                  </div>
                  {hasTaskFilters && (
                    <button type="button" onClick={clearTaskFilters} className="inline-flex items-center gap-1 font-bold text-[#287EAD] hover:text-[#206D99]">
                      <X className="h-3.5 w-3.5" />
                      Clear filters
                    </button>
                  )}
                </div>
              </div>
            )}

            <div className="p-4">
              {tasksLoading ? (
                <div className="flex items-center gap-2 border border-[#C8CDD2] bg-[#F5F7F8] p-4 text-sm text-[#5E6870]">
                  <Loader2 className="h-4 w-4 animate-spin text-[#287EAD]" />
                  Loading tasks...
                </div>
              ) : visibleTasks.length ? (
                <div className={taskGridClass}>
                  {visibleTasks.map((task: WorkflowTask) => {
                    const documentId = getTaskDocumentId(task);
                    const documentType = getTaskDocumentType(task);
                    const documentFormat = getTaskDocumentFormat(task);
                    const department = getTaskDepartment(task);
                    const uploaderName = getTaskUploaderName(task);
                    return (
                      <Link
                        key={task.id}
                        to={documentId ? `/documents/${documentId}` : "/workflow"}
                        className="block border border-[#C8CDD2] bg-white p-3 transition-colors hover:bg-[#F5F7F8]"
                      >
                        <div className="flex items-start gap-3">
                          <div className="mt-0.5 border border-[#287EAD]/25 bg-[#EEF6FB] p-2 text-[#287EAD]">
                            <Hourglass className="w-4 h-4" />
                          </div>
                          <div className="min-w-0 flex-1">
                            <p className="truncate text-sm font-bold text-[#1F2933]">{getTaskDocumentTitle(task)}</p>
                            <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-[#5E6870]">
                              <span>{documentType}</span><span>•</span><span>{documentFormat}</span><span>•</span><span>{task.step?.name}</span>
                            </div>
                            <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-[#5E6870]">
                              <span>{department}</span>
                              {uploaderName && <><span>•</span><span>{uploaderName}</span></>}
                            </div>
                            <div className="mt-1"><TaskMetaInfo dueAt={task.due_at} /></div>
                          </div>
                        </div>
                      </Link>
                    );
                  })}
                </div>
              ) : hasOpenTasks ? (
                <div className="border border-dashed border-[#C8CDD2] bg-[#F5F7F8] px-4 py-5 text-sm text-[#5E6870]">No tasks match the selected filters.</div>
              ) : (
                <div className="flex items-center gap-3 border border-[#C8CDD2] bg-[#F5F7F8] p-4 text-sm text-[#5E6870]">
                  <ListChecks className="h-5 w-5 text-[#287EAD]" />
                  No active workflow tasks assigned to you.
                </div>
              )}
            </div>
          </section>

          <section className="border border-[#C8CDD2] bg-white">
            <div className="border-b border-[#C8CDD2] px-4 py-3">
              <h2 className="text-sm font-bold text-[#1F2933]">Manager analytics</h2>
              <p className="text-sm text-[#5E6870]">Dashboard stays operational; analytics now has a dedicated workspace.</p>
            </div>
            {user?.has_admin_access ? (
              <div className="space-y-4 p-4">
                <div className="grid grid-cols-2 gap-3">
                  <div className="border border-[#C8CDD2] bg-[#F5F7F8] p-3">
                    <BarChart3 className="h-5 w-5 text-[#287EAD]" />
                    <p className="mt-3 text-xs font-semibold uppercase tracking-wider text-[#5E6870]">Approval health</p>
                    <p className="mt-1 text-lg font-bold text-[#1F2933]">{pendingCount}</p>
                  </div>
                  <div className="border border-[#C8CDD2] bg-[#F5F7F8] p-3">
                    <UploadCloud className="h-5 w-5 text-[#287EAD]" />
                    <p className="mt-3 text-xs font-semibold uppercase tracking-wider text-[#5E6870]">Documents</p>
                    <p className="mt-1 text-lg font-bold text-[#1F2933]">{totalDocuments}</p>
                  </div>
                </div>
                <Link to="/analytics" className="inline-flex w-full items-center justify-center gap-2 bg-[#287EAD] px-4 py-2 text-sm font-bold text-white hover:bg-[#206D99]">
                  Open analytics <ArrowRight className="h-4 w-4" />
                </Link>
              </div>
            ) : (
              <div className="p-4 text-sm text-[#5E6870]">
                Analytics is available to managers and administrators.
              </div>
            )}
          </section>
        </div>

      {/* Recent Documents (wide) + Audit Trail w/ Storage (narrow) */}
      <div className="grid min-w-0 grid-cols-1 items-stretch gap-3 xl:grid-cols-3">
        {/* Recent Documents — clean compact rows */}
        <section
          className="flex min-w-0 flex-col overflow-hidden border border-[#C8CDD2] bg-white xl:col-span-2"
          style={activityCardStyle}
        >
          <div className="flex items-center justify-between border-b border-[#C8CDD2] px-4 py-3">
            <div>
              <h2 className="text-sm font-bold text-[#1F2933]">Recent documents</h2>
              <p className="text-sm text-[#5E6870]">Latest activity across all repositories</p>
            </div>
            <Link to="/documents" className="inline-flex items-center gap-1 text-xs font-bold text-[#287EAD] transition-colors hover:text-[#206D99]">
              View all <ArrowRight className="w-3 h-3" />
            </Link>
          </div>

          <div className="flex-1">
            {docsLoading ? (
              <div className="flex h-full items-center justify-center p-10">
                <Loader2 className="w-6 h-6 text-muted-foreground animate-spin" />
              </div>
            ) : recentDocs?.results?.length ? (
              <table className={`w-full table-fixed text-sm ${showAdminRecentColumns ? "min-w-[920px]" : "min-w-[640px]"}`}>
                <thead>
                  <tr className="border-b border-[#AEB5BB] bg-[#50545A] text-left text-[11px] uppercase tracking-wider text-white">
                    <th className={`${showAdminRecentColumns ? "w-[32%]" : "w-[48%]"} px-5 py-3 font-medium`}>Name</th>
                    {showAdminRecentColumns && (
                      <>
                        <th className="hidden w-[16%] px-5 py-3 font-medium lg:table-cell">Owner</th>
                        <th className="hidden w-[16%] px-5 py-3 font-medium xl:table-cell">Department</th>
                      </>
                    )}
                    <th className={`${showAdminRecentColumns ? "w-[12%]" : "w-[18%]"} hidden px-5 py-3 font-medium md:table-cell`}>Type</th>
                    <th className={`${showAdminRecentColumns ? "w-[14%]" : "w-[22%]"} px-5 py-3 font-medium`}>Status</th>
                    <th className={`${showAdminRecentColumns ? "w-[10%]" : "w-[12%]"} hidden px-5 py-3 font-medium md:table-cell`}>Updated</th>
                  </tr>
                </thead>
                <tbody>
                  {recentDocs.results.map((doc: Document) => (
                    <tr
                      key={doc.id}
                      className="cursor-pointer border-t border-[#D3D7DA] transition hover:bg-[#F5F7F8]"
                      onClick={() => { preloadDocumentWorkspace(); navigate(`/documents/${doc.id}`); }}
                      onMouseEnter={preloadDocumentWorkspace}
                    >
                      <td className="max-w-0 px-5 py-3">
                        <div className="flex items-center gap-3 min-w-0">
                          <div className="flex h-9 w-9 shrink-0 items-center justify-center border border-[#287EAD]/25 bg-[#EEF6FB] text-[#287EAD]">
                            <FileText className="h-4 w-4" />
                          </div>
                          <div className="min-w-0 flex-1">
                            <p className="truncate font-semibold text-[#1F2933]">{doc.title}</p>
                            <p className="truncate text-[11px] text-[#5E6870]">
                              {doc.reference_number} · {doc.document_type_name || doc.document_type?.name || "Unclassified"}
                            </p>
                          </div>
                        </div>
                      </td>
                      {showAdminRecentColumns && (
                        <>
                          <td className="hidden max-w-0 px-5 py-3 text-xs text-[#1F2933] lg:table-cell">
                            <span className="block truncate">{getDocumentOwnerName(doc)}</span>
                          </td>
                          <td className="hidden max-w-0 px-5 py-3 text-xs text-[#5E6870] xl:table-cell">
                            <span className="block truncate">{getDocumentDepartmentName(doc)}</span>
                          </td>
                        </>
                      )}
                      <td className="hidden px-5 py-3 text-[#5E6870] md:table-cell">
                        <span className="block truncate">
                          {formatDocumentFileType(doc.file_name, doc.file_mime_type)}
                        </span>
                      </td>
                      <td className="px-5 py-3 align-middle">
                        <span className={clsx("font-semibold", getDashboardStatusClass(doc.status))}>
                          {getDashboardStatusLabel(doc.status)}
                        </span>
                      </td>
                      <td className="hidden whitespace-nowrap px-5 py-3 text-[#5E6870] md:table-cell">
                        {formatDistanceToNow(new Date(doc.updated_at), { addSuffix: true })}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <div className="flex h-full flex-col items-center justify-center px-6 py-10 text-center">
                <FileText className="mx-auto h-12 w-12 text-muted-foreground/50" />
                <p className="mt-4 text-sm text-muted-foreground">No recent documents yet.</p>
                <Link to="/documents/upload" className="mt-3 inline-flex text-sm font-semibold text-foreground hover:text-accent transition-colors">
                  Upload your first document →
                </Link>
              </div>
            )}
          </div>

          {recentDocsCount > RECENT_DOCS_PAGE_SIZE && (
            <div className="flex shrink-0 items-center justify-between border-t border-[#C8CDD2] bg-[#F5F7F8] px-5 py-3">
              <span className="text-xs text-[#5E6870]">
                Page {recentDocsPage} of {recentDocsPages}
              </span>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setRecentDocsPage((p) => Math.max(1, p - 1))}
                  disabled={recentDocsPage === 1}
                  className="inline-flex items-center gap-1 border border-[#C8CDD2] bg-white px-3 py-1.5 text-xs font-semibold text-[#1F2933] hover:bg-[#EEF6FB] disabled:cursor-not-allowed disabled:opacity-40"
                >
                  <ChevronLeft className="w-3.5 h-3.5" /> Prev
                </button>
                <button
                  type="button"
                  onClick={() => setRecentDocsPage((p) => p + 1)}
                  disabled={recentDocsPage * RECENT_DOCS_PAGE_SIZE >= recentDocsCount}
                  className="inline-flex items-center gap-1 border border-[#C8CDD2] bg-white px-3 py-1.5 text-xs font-semibold text-[#1F2933] hover:bg-[#EEF6FB] disabled:cursor-not-allowed disabled:opacity-40"
                >
                  Next <ChevronRight className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>
          )}
        </section>

        {/* Audit Trail with Storage merged at bottom */}
        <section className="flex min-w-0 flex-col overflow-hidden border border-[#C8CDD2] bg-white p-4" style={activityCardStyle}>
          <div className="flex items-start justify-between">
            <div>
              <h2 className="text-sm font-bold text-[#1F2933]">
                {user?.has_admin_access ? "Audit Trail" : "Document Activity"}
              </h2>
              <p className="text-sm text-[#5E6870]">A plain-language feed of what just happened.</p>
            </div>
            <Link to="/audit" className="text-xs font-bold text-[#287EAD] transition-colors hover:text-[#206D99]">
              View all
            </Link>
          </div>

          <ul className="mt-5 flex-1 space-y-4">
            {auditLoading ? (
              <li className="flex h-full items-center justify-center rounded-lg bg-muted/40 p-4 text-center text-xs text-muted-foreground">Loading activity…</li>
            ) : recentAudit?.results?.length ? (
              recentAudit.results.map((event: DashboardAuditEvent, index: number) => {
                const meta = getAuditPresentation(event);
                const Icon = meta.icon;
                const isLast = index === (recentAudit.results.length - 1);
                const initialsSource = event.actor_name || event.actor_email || "System";
                const initials = initialsSource
                  .split(/[ @._-]/)
                  .filter(Boolean)
                  .slice(0, 2)
                  .map((s) => s[0]?.toUpperCase())
                  .join("") || "S";
                const { actor, verb, target } = formatAuditSummary(event);
                return (
                  <li key={event.id} className="flex gap-3">
                    <div className="relative">
                      <div className="flex h-8 w-8 items-center justify-center rounded-full bg-primary text-[11px] font-semibold text-primary-foreground">
                        {initials}
                      </div>
                      {!isLast && <div className="absolute left-1/2 top-8 h-full w-px -translate-x-1/2 bg-border" />}
                    </div>
                    <div className="flex-1 pb-1 min-w-0">
                      <p className="text-sm text-foreground leading-snug">
                        <span className="font-medium text-foreground">{actor}</span>
                        {verb && <span className="text-muted-foreground"> {verb}</span>}
                        {target && <span className="font-medium text-foreground"> {target}</span>}
                        {!verb && !target && (
                          <span className="text-muted-foreground"> performed an action</span>
                        )}
                      </p>
                      <div className="mt-1 flex items-center gap-1.5 text-[11px] text-muted-foreground">
                        <span className={`inline-flex h-4 w-4 items-center justify-center rounded-full border ${meta.tone}`}>
                          <Icon className="w-2.5 h-2.5" />
                        </span>
                        <span>{formatDistanceToNow(new Date(event.timestamp), { addSuffix: true })}</span>
                      </div>
                    </div>
                  </li>
                );
              })
            ) : (
              <li className="flex h-full items-center justify-center rounded-lg bg-muted/40 p-4 text-center text-xs text-muted-foreground">No recent audit events.</li>
            )}
          </ul>

          {recentAuditCount > RECENT_AUDIT_PAGE_SIZE && (
            <div className="mt-4 flex shrink-0 items-center justify-between border-t border-border pt-3">
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

          {/* Storage merged at bottom */}
          <div className="mt-4 shrink-0 rounded-lg border border-dashed border-border p-3">
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

      </div>
    </div>
  );
}
