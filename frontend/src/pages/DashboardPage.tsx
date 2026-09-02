// DashboardPage.tsx 
import { useQuery } from "@tanstack/react-query";
import { api, documentsAPI, searchAPI, workflowAPI } from "@/services/api";
import { useAuthStore } from "@/store/authStore";
import {
  GitBranch, ArrowRight, ChevronLeft, ChevronRight,
  Layers, Timer, ShieldCheck, ClipboardCheck,
  Calendar, FileText, Loader2, Search, Sparkles,
  FileType2, FileSpreadsheet, FileImage, FileArchive,
  TrendingDown, TrendingUp, Minus, Plus,
} from "lucide-react";
import { Link, useNavigate } from "react-router-dom";
import { formatDistanceToNow } from "date-fns";
import clsx from "clsx";
import StatusBadge from "@/components/documents/StatusBadge";
import { useEffect, useRef, useState, useMemo } from "react";
import type { Document, DocumentSearchResponse, SearchHit, WorkflowTask } from "@/types";
import { useDebounce } from "@/hooks/useDebounce";
import { highlightSearchText, getPreferredHighlights } from "@/lib/search";
import { QUERY_FIVE_MIN_STALE, QUERY_SHORT_STALE, QUERY_FOCUS_OFF } from "@/lib/reactQueryDefaults";
import { formatDocumentFileType } from "@/lib/documentFormat";
import { preloadDocumentWorkspace } from "@/lib/routePreload";
import statusUtils from "@/lib/status";
import {
  getTaskDocumentFormat,
  getTaskDocumentId,
  getTaskDocumentTitle,
} from "@/lib/workflowTaskFilters";
import { WorkspaceCommandBar } from "@/components/shared/WorkspaceCommandBar";

const RECENT_DOCS_PAGE_SIZE = 5;
const RECENT_AUDIT_PAGE_SIZE = 5;
const TREND_WINDOW_DAYS = 30;
const PERCENT_TREND_MIN_BASELINE = 20;
const PERCENT_TREND_MAX_ABS = 100;

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
  object_type?: string;
  changes?: Record<string, unknown> | null;
};

type StorageStats = {
  used_bytes: number;
  total_bytes: number;
  used_gb: number;
  total_gb: number;
  used_mb: number;
  total_mb: number;
  percentage: number;
  document_count: number;
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
    yesterday: toDateParam(addDays(today, -1)),
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
  const delta = current - previous;
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
      isPositive,
      direction: "up",
      suffix: " new",
      label,
    };
  }

  const percentChange = getPercentChange(current, previous);
  if (
    previous < PERCENT_TREND_MIN_BASELINE ||
    Math.abs(percentChange) > PERCENT_TREND_MAX_ABS
  ) {
    return {
      value: Math.abs(delta),
      isPositive,
      direction,
      suffix: Math.abs(delta) === 1 ? " doc" : " docs",
      label,
    };
  }

  return {
    value: Math.abs(percentChange),
    isPositive,
    direction,
    label,
  };
}

function getYesterdayTrendLabel(trend: StatTrend) {
  if (trend.direction === "up") return "above yesterday";
  if (trend.direction === "down") return "below yesterday";
  return "same as yesterday";
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

function getDashboardStatusTextClass(status: string): string {
  const key = status?.toLowerCase?.().replace(/\s+/g, "_") ?? "";
  if (["approved", "completed"].includes(key)) return "text-emerald-700";
  if (["pending_review", "pending_approval", "on_hold", "returned"].includes(key)) return "text-amber-700";
  if (["rejected", "void"].includes(key)) return "text-red-700";
  if (key === "archived") return "text-sky-700";
  return "text-[#3F474F]";
}

function isDashboardNeedsAttention(status: string) {
  const key = status?.toLowerCase?.().replace(/\s+/g, "_") ?? "";
  return ["pending_review", "pending_approval", "rejected", "void"].includes(key);
}

// File-type icon mapping (matches the workspace document table)
function getDocumentFileIcon(fileName?: string | null, mimeType?: string | null) {
  const source = `${fileName ?? ""} ${mimeType ?? ""}`.toLowerCase();
  if (/(xls|xlsx|csv|sheet|excel)/.test(source)) return FileSpreadsheet;
  if (/(png|jpe?g|gif|webp|svg|tif{1,2}|bmp|image)/.test(source)) return FileImage;
  if (/(zip|rar|7z|tar|gz|archive)/.test(source)) return FileArchive;
  if (/(pdf|docx?|pptx?|word|powerpoint|rtf|odt)/.test(source)) return FileType2;
  return FileText;
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
  if (name.includes("group.permission")) {
    return { icon: ShieldCheck, tone: "bg-accent/15 text-accent border-accent/30" };
  }
  if (name.includes("signature.request")) {
    return { icon: FileSignature, tone: "bg-primary/10 text-primary border-primary/20" };
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
  "user.created": "added the user",
  "user.deleted": "removed the user",
  "user.password_reset": "reset the password for",
  "user.activated": "activated the account of",
  "user.deactivated": "deactivated the account of",
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
  "group.permission_updated": "updated permissions for",
  "signature.request_created": "requested signature for",
  "signature.request_signed": "signed",
  "signature.request_completed": "completed signature request for",
  "signature.request_declined": "declined signature request for",
  "signature.request_cancelled": "cancelled signature request for",
};

const VERB_RE = /(submitted|uploaded|edited|updated|created|deleted|approved|rejected|downloaded|viewed|previewed|printed|shared|failed|queued|completed|logged in|logged out|signed in|signed out|enabled|disabled|returned|held|released|archived|added|delegated|reassigned|exported)\b/i;

// `permission.changed` is reused for a range of admin/account actions (create
// user, reset password, activate/deactivate, delete, group/role tweaks…). The
// specific action lives in `changes.action`, so translate that into a proper
// verb + target instead of the meaningless "changed permissions" fallback.
function describePermissionChange(event: DashboardAuditEvent): { verb: string; target: string } {
  const changes = (event.changes ?? {}) as Record<string, unknown>;
  const action = typeof changes.action === "string" ? changes.action : "";
  const objectType = event.object_type ?? "";
  const target = cleanAuditTitle(event.object_repr || "");

  switch (action) {
    case "created": return { verb: "added the user", target };
    case "deleted": return { verb: "removed the user", target };
    case "password_reset": return { verb: "reset the password for", target };
    case "activated": return { verb: "activated the account of", target };
    case "deactivated": return { verb: "deactivated the account of", target };
    case "reassign_active_tasks": return { verb: "reassigned active tasks from", target };
    case "duplicated_from": return { verb: "duplicated group", target };
  }
  if ("mfa" in changes) return { verb: changes.mfa ? "enabled MFA" : "disabled MFA", target: "" };
  if (objectType === "UserSignature") return { verb: "updated their signature", target: "" };
  if (objectType === "UserGroup") return { verb: "updated group", target };
  if (objectType === "User") return { verb: "updated the account of", target };
  return { verb: "updated permissions", target };
}

function formatAuditSummary(event: DashboardAuditEvent): AuditSummaryParts {
  const actor = deriveActorName(event);
  const code = String(event.event ?? "").toLowerCase();
  const summary = (event.summary || "").trim();
  const objectTitle = cleanAuditTitle(event.object_repr || "");

  if (code === "permission.changed") {
    const { verb, target } = describePermissionChange(event);
    return { actor, verb, target };
  }

  if (code === "signature.request_created" || code === "signature.request_signed" || 
      code === "signature.request_completed" || code === "signature.request_declined" || 
      code === "signature.request_cancelled") {
    const changes = (event.changes ?? {}) as Record<string, unknown>;
    const documentTitle = typeof changes.document_title === "string" ? changes.document_title : "";
    const target = cleanAuditTitle(documentTitle);
    
    const mappedVerb = EVENT_VERB_MAP[code];
    if (mappedVerb) {
      return { actor, verb: mappedVerb, target };
    }
    
    return { actor, verb: code.replace("signature.request_", ""), target };
  }

  if (code === "group.permission_updated") {
    const changes = (event.changes ?? {}) as Record<string, unknown>;
    const grantedCount = typeof changes.granted_count === "number" ? changes.granted_count : 0;
    const revokedCount = typeof changes.revoked_count === "number" ? changes.revoked_count : 0;
    const totalPermissions = typeof changes.total_permissions === "number" ? changes.total_permissions : 0;
    
    // Build detailed description from granted/revoked details
    const grantedDetails = Array.isArray(changes.granted_details) ? changes.granted_details : [];
    const revokedDetails = Array.isArray(changes.revoked_details) ? changes.revoked_details : [];
    
    let verb = "updated permissions for";
    if (grantedDetails.length > 0 || revokedDetails.length > 0) {
      const parts: string[] = [];
      
      for (const detail of grantedDetails) {
        const action = detail.action || "";
        const documentTypeName = detail.document_type_name;
        const documentTypeId = detail.document_type_id;
        const stage = detail.stage;
        
        const actionDisplay = String(action || "").replace(/_/g, " ").replace(/\b\w/g, (char) => char.toUpperCase());
        const docTypePart = documentTypeName 
          ? ` for ${documentTypeName}` 
          : documentTypeId 
            ? ` for document type ${documentTypeId}` 
            : "";
        const stagePart = stage && stage !== "any" ? ` in ${stage} stage` : "";
        
        parts.push(`granted ${actionDisplay}${docTypePart}${stagePart}`);
      }
      
      for (const detail of revokedDetails) {
        const action = detail.action || "";
        const documentTypeName = detail.document_type_name;
        const documentTypeId = detail.document_type_id;
        const stage = detail.stage;
        
        const actionDisplay = String(action || "").replace(/_/g, " ").replace(/\b\w/g, (char) => char.toUpperCase());
        const docTypePart = documentTypeName 
          ? ` for ${documentTypeName}` 
          : documentTypeId 
            ? ` for document type ${documentTypeId}` 
            : "";
        const stagePart = stage && stage !== "any" ? ` in ${stage} stage` : "";
        
        parts.push(`revoked ${actionDisplay}${docTypePart}${stagePart}`);
      }
      
      if (parts.length > 0) {
        verb = parts.join(", ");
      }
    } else {
      // Fallback to count-based description for backward compatibility
      if (grantedCount > 0 && revokedCount > 0) {
        verb = `updated permissions for (${grantedCount} granted, ${revokedCount} revoked)`;
      } else if (grantedCount > 0) {
        verb = `granted ${grantedCount} permission${grantedCount === 1 ? "" : "s"} to`;
      } else if (revokedCount > 0) {
        verb = `revoked ${revokedCount} permission${revokedCount === 1 ? "" : "s"} from`;
      }
    }
    
    return { actor, verb, target: objectTitle };
  }

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

function getTaskUrgency(dueAt: string | null): "overdue" | "urgent" | "track" {
  if (!dueAt) return "track";

  const hoursDiff = (new Date(dueAt).getTime() - Date.now()) / (1000 * 60 * 60);
  if (hoursDiff < 0) return "overdue";
  if (hoursDiff < 24) return "urgent";
  return "track";
}

function TaskMetaInfo({ dueAt }: { dueAt: string | null }) {
  if (!dueAt) return null;

  const dueDate = new Date(dueAt);
  const urgency = getTaskUrgency(dueAt);
  const statusClass =
    urgency === "overdue"
      ? "text-[#B42318]"
      : urgency === "urgent"
        ? "text-[#A16207]"
        : "text-[#6E767D]";
  const statusText = urgency === "overdue" ? "Overdue" : urgency === "urgent" ? "Due soon" : "On track";

  return (
    <span className={`inline-flex items-center gap-1 text-[11px] font-medium ${statusClass}`}>
      <Calendar className="h-3 w-3" />
      <span className={statusClass}>
        {statusText} · {formatDistanceToNow(dueDate, { addSuffix: true })}
      </span>
    </span>
  );
}

type DashboardMetricCardProps = {
  title: string;
  value: number;
  icon: typeof Layers;
  trend?: StatTrend;
  href: string;
  tone: "neutral" | "attention" | "positive" | "teal";
};

function DashboardMetricCard({ title, value, icon: Icon, trend, href, tone }: DashboardMetricCardProps) {
  const iconClass =
    tone === "attention"
      ? "text-[#A16207]"
      : tone === "positive"
        ? "text-[#0F766E]"
        : "text-[#287EAD]";
  const TrendIcon = trend?.direction === "up" ? TrendingUp : trend?.direction === "down" ? TrendingDown : Minus;
  const trendClass = trend
    ? trend.isPositive
      ? "text-[#287EAD]"
      : "text-[#B42318]"
    : "text-[#6E767D]";
  const trendValue = trend
    ? `${trend.value.toLocaleString(undefined, { maximumFractionDigits: 1 })}${trend.suffix ?? "%"}`
    : "";

  return (
    <Link
      to={href}
      className="group flex min-h-[142px] min-w-0 flex-col border border-[#C8CDD2] bg-white p-5 transition-colors hover:border-[#287EAD]/60"
    >
      <div className="flex items-start justify-between gap-3">
        <p className="truncate text-xs font-semibold uppercase tracking-[0.16em] text-[#68737B]">{title}</p>
        <Icon className={`h-5 w-5 shrink-0 ${iconClass}`} />
      </div>
      <p className="mt-4 text-3xl font-semibold tracking-tight text-[#1F2933]">{value.toLocaleString()}</p>
      {trend ? (
        <div className={`mt-2 flex min-w-0 items-center gap-1.5 text-xs font-semibold ${trendClass}`} title={trend.label}>
          <TrendIcon className="h-3.5 w-3.5 shrink-0" />
          <span className="shrink-0">{trendValue}</span>
          <span className="truncate">{trend.label}</span>
        </div>
      ) : (
        <span className="mt-2 text-xs text-[#6E767D]">No recent change</span>
      )}
    </Link>
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
  const [recentDocsFilter, setRecentDocsFilter] = useState<"all" | "attention">("all");
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
        // Most-recently-touched first (covers both new uploads and edits to
        // older documents); created_at breaks ties for stable pagination.
        ordering: "-updated_at,-created_at",
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

  const { data: approvedYesterdayCount = 0 } = useQuery({
    queryKey: ["documents", "approved", "yesterday-count", trendWindow.yesterday],
    queryFn: () =>
      documentsAPI.list({
        status: "approved",
        is_self_upload: false,
        approved_from: trendWindow.yesterday,
        approved_to: trendWindow.yesterday,
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

  // Allow strict client-side filtering of the recent documents view when
  // URL query params are present (e.g. coming from /documents?status=...).
  const urlSearchParams = useMemo(() => new URLSearchParams(window.location.search), []);
  const urlStatus = urlSearchParams.get("status") || "";
  const urlDocType = urlSearchParams.get("document_type") || "";

  const recentDocsDisplay = useMemo(() => {
    if (!recentDocs) return recentDocs;
    if (!urlStatus && !urlDocType) return recentDocs;
    const filtered = recentDocs.results.filter((doc: Document) => {
      if (urlStatus && !statusUtils.statusMatchesFilter(doc.status, urlStatus)) return false;
      if (urlDocType) {
        const docTypeName =
          typeof (doc as any).document_type === "string"
            ? (doc as any).document_type
            : (doc as any).document_type?.name ?? String((doc as any).document_type ?? "");
        if (docTypeName !== urlDocType) return false;
      }
      return true;
    });
    return { ...recentDocs, results: filtered, count: filtered.length } as PaginatedResponse<Document>;
  }, [recentDocs, urlStatus, urlDocType]);

  const filteredRecentDocsDisplay = useMemo(() => {
    if (!recentDocsDisplay || recentDocsFilter === "all") return recentDocsDisplay;
    return {
      ...recentDocsDisplay,
      results: recentDocsDisplay.results.filter((doc: Document) => isDashboardNeedsAttention(doc.status)),
    };
  }, [recentDocsDisplay, recentDocsFilter]);

  const recentDocsCount = recentDocsDisplay?.count ?? 0;
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
      document_count: 0,
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
  const showAdminRecentColumns = Boolean(user?.has_admin_access || (user?.group_names ?? []).includes("HOD"));
  const totalDocumentsTrend = buildTrend(
    documentsCreatedThisPeriod,
    documentsCreatedPreviousPeriod,
    true,
    "vs last month",
  );
  const pendingApprovalTrend = buildTrend(
    pendingCreatedThisPeriod,
    pendingCreatedPreviousPeriod,
    false,
    "vs last month",
  );
  const approvedTrendBase = buildTrend(approvedTodayCount, approvedYesterdayCount, true, "vs yesterday");
  const approvedTrend = {
    ...approvedTrendBase,
    label: getYesterdayTrendLabel(approvedTrendBase),
  };
  const dueSoonTaskCount = countDueSoonTasks(allTasks);
  const tasksTrend: StatTrend | undefined =
    dueSoonTaskCount > 0
      ? {
        value: dueSoonTaskCount,
        isPositive: false,
        direction: "flat",
        suffix: " need attention",
        label: "today",
      }
      : undefined;
  const visibleTasks = allTasks.slice(0, 4);
  const activityCardStyle = {
    minHeight: "490px",
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
    <div className="flex h-full flex-col bg-[#EDEDED] text-[#1F2933]">
      <WorkspaceCommandBar
        actions={
          <button
            type="button"
            onClick={handleDashboardSearch}
            className="inline-flex h-9 items-center justify-center gap-2 border border-white/20 bg-[#206D99] px-4 text-sm font-semibold text-white transition-colors hover:bg-[#1B5F86]"
          >
            <Search className="w-4 h-4" />
            Search
          </button>
        }
      >
        <div ref={dashboardSearchRef} className="relative ml-auto w-full min-w-0 max-w-xl">
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
                          className={`block w-full px-4 py-3 text-left transition-colors hover:bg-[#F5F7F8] ${activeDashboardResultIndex === index ? "bg-[#EEF6FB]" : ""
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

      </WorkspaceCommandBar>

      <div className="scrollbar-minimal min-h-0 flex-1 overflow-y-auto">
        <div className="w-full space-y-5 px-6 pb-12 pt-6 lg:px-8 lg:pb-14 lg:pt-8">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
            <div className="min-w-0">
              <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-[#5E6870]">Operations workspace</p>
              <h1 className="mt-1 truncate text-2xl font-semibold tracking-tight text-[#1F2933]">
                {user?.first_name ? `Welcome, ${user.first_name}` : "Document Operations"}
              </h1>
            </div>
            <Link
              to="/documents/upload"
              className="inline-flex h-10 shrink-0 items-center justify-center gap-2 bg-[#287EAD] px-4 text-sm font-bold text-white transition-colors hover:bg-[#206D99]"
            >
              <Plus className="h-4 w-4" />
              Add document
            </Link>
          </div>
          <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 xl:grid-cols-4">
            <DashboardMetricCard
              title="Total Documents"
              value={totalDocuments}
              icon={Layers}
              trend={totalDocumentsTrend}
              href="/documents"
              tone="neutral"
            />
            <DashboardMetricCard
              title="Pending Approval"
              value={pendingCount}
              icon={Timer}
              trend={pendingApprovalTrend}
              href="/documents?status=pending_approval"
              tone="attention"
            />
            <DashboardMetricCard
              title="Approved Today"
              value={approvedTodayCount}
              icon={ShieldCheck}
              trend={approvedTrend}
              href="/documents?status=approved"
              tone="positive"
            />
            <DashboardMetricCard
              title="My Tasks"
              value={myTasks.length}
              icon={ClipboardCheck}
              trend={tasksTrend}
              href="/workflow"
              tone="teal"
            />
          </div>

          {/* Recent Documents (wide) + Audit Trail w/ Storage (narrow) */}
          <div className="grid min-w-0 grid-cols-1 items-stretch gap-5 xl:grid-cols-3">
            {/* Recent Documents — clean compact rows */}
            <section
              className="flex min-w-0 flex-col overflow-hidden border border-[#C8CDD2] bg-white xl:col-span-2"
              style={activityCardStyle}
            >
              <div className="flex items-center justify-between gap-4 border-b border-[#C8CDD2] px-5 py-4">
                <div>
                  <div className="flex items-center gap-2">
                    <h2 className="text-sm font-bold text-[#1F2933]">Recent documents</h2>
                    <span className="bg-[#EEF6FB] px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-[#287EAD]">Live</span>
                  </div>
                  <p className="mt-0.5 text-xs text-[#5E6870]">Latest activity across all repositories</p>
                </div>
                <div className="flex items-center gap-3">
                  <div className="flex border border-[#C8CDD2] text-[11px]" role="group" aria-label="Recent document filter">
                    <button
                      type="button"
                      onClick={() => setRecentDocsFilter("all")}
                      className={clsx(
                        "px-2.5 py-1.5 font-semibold transition-colors",
                        recentDocsFilter === "all" ? "bg-[#50545A] text-white" : "bg-white text-[#5E6870] hover:bg-[#F5F7F8]",
                      )}
                    >
                      All
                    </button>
                    <button
                      type="button"
                      onClick={() => setRecentDocsFilter("attention")}
                      className={clsx(
                        "border-l border-[#C8CDD2] px-2.5 py-1.5 font-semibold transition-colors",
                        recentDocsFilter === "attention" ? "bg-[#FFF7E6] text-[#A16207]" : "bg-white text-[#5E6870] hover:bg-[#F5F7F8]",
                      )}
                    >
                      Needs attention
                    </button>
                  </div>
                  <Link to="/documents" className="inline-flex items-center gap-1 text-xs font-bold text-[#287EAD] transition-colors hover:text-[#206D99]">
                    View all <ArrowRight className="w-3 h-3" />
                  </Link>
                </div>
              </div>

              <div className="flex-1">
                {docsLoading ? (
                  <div className="flex h-full items-center justify-center p-10">
                    <Loader2 className="w-6 h-6 text-muted-foreground animate-spin" />
                  </div>
                ) : filteredRecentDocsDisplay?.results?.length ? (
                  <table className={`w-full table-fixed text-sm ${showAdminRecentColumns ? "min-w-[920px]" : "min-w-[640px]"}`}>
                    <thead>
                      <tr className="border-b border-[#AEB5BB] bg-[#50545A] text-left text-[11px] uppercase tracking-wider text-white">
                        <th className={`${showAdminRecentColumns ? "w-[32%]" : "w-[48%]"} px-5 py-3.5 font-medium`}>Name</th>
                        {showAdminRecentColumns && (
                          <>
                            <th className="hidden w-[16%] px-5 py-3.5 font-medium lg:table-cell">Owner</th>
                            <th className="hidden w-[16%] px-5 py-3.5 font-medium xl:table-cell">Department</th>
                          </>
                        )}
                        <th className={`${showAdminRecentColumns ? "w-[12%]" : "w-[18%]"} hidden px-5 py-3.5 font-medium md:table-cell`}>Type</th>
                        <th className={`${showAdminRecentColumns ? "w-[14%]" : "w-[22%]"} px-5 py-3.5 font-medium`}>Status</th>
                        <th className={`${showAdminRecentColumns ? "w-[10%]" : "w-[12%]"} hidden px-5 py-3.5 font-medium md:table-cell`}>Updated</th>
                      </tr>
                    </thead>
                    <tbody>
                      {filteredRecentDocsDisplay?.results.map((doc: Document) => {
                        const DocIcon = getDocumentFileIcon(doc.file_name, doc.file_mime_type);
                        return (
                          <tr
                            key={doc.id}
                            className="cursor-pointer border-t border-[#D3D7DA] transition hover:bg-[#F5F7F8]"
                            onClick={() => { preloadDocumentWorkspace(); navigate(`/documents/${doc.id}`); }}
                            onMouseEnter={preloadDocumentWorkspace}
                          >
                            <td className="max-w-0 px-5 py-4">
                              <div className="flex items-center gap-3 min-w-0">
                                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-[#287EAD]/25 bg-[#EEF6FB] text-[#287EAD]">
                                  <DocIcon className="h-4 w-4" />
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
                                <td className="hidden max-w-0 px-5 py-4 text-xs text-[#1F2933] lg:table-cell">
                                  <span className="block truncate">{getDocumentOwnerName(doc)}</span>
                                </td>
                                <td className="hidden max-w-0 px-5 py-4 text-xs text-[#5E6870] xl:table-cell">
                                  <span className="block truncate">{getDocumentDepartmentName(doc)}</span>
                                </td>
                              </>
                            )}
                            <td className="hidden px-5 py-4 text-[#5E6870] md:table-cell">
                              <span className="block truncate">
                                {formatDocumentFileType(doc.file_name, doc.file_mime_type)}
                              </span>
                            </td>
                            <td className="px-5 py-4 align-middle">
                              <span className={clsx("font-semibold", getDashboardStatusTextClass(doc.status))}>
                                {getDashboardStatusLabel(doc.status)}
                              </span>
                            </td>
                            <td className="hidden whitespace-nowrap px-5 py-4 text-[#5E6870] md:table-cell">
                              {formatDistanceToNow(new Date(doc.updated_at), { addSuffix: true })}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                ) : (
                  <div className="flex h-full flex-col items-center justify-center px-6 py-10 text-center">
                    <FileText className="mx-auto h-12 w-12 text-muted-foreground/50" />
                    <p className="mt-4 text-sm text-muted-foreground">
                      {recentDocsFilter === "attention" ? "No documents need attention on this page." : "No recent documents yet."}
                    </p>
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
            <section className="flex min-w-0 flex-col overflow-hidden border border-[#C8CDD2] bg-white p-5" style={activityCardStyle}>
              <div className="flex items-start justify-between">
                <div>
                  <h2 className="text-sm font-bold text-[#1F2933]">
                    {user?.has_admin_access ? "Audit Trail" : "Document Activity"}
                  </h2>
                  <p className="mt-0.5 text-xs text-[#5E6870]">A plain-language feed of what just happened.</p>
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
                          <div className="flex h-8 w-8 items-center justify-center rounded-full bg-[#287EAD] text-[11px] font-semibold text-white">
                            {initials}
                          </div>
                          {!isLast && <div className="absolute left-1/2 top-8 h-7 w-px -translate-x-1/2 bg-[#D5DADF]" />}
                        </div>
                        <div className="min-w-0 flex-1 pb-1">
                          <p className="text-sm leading-snug text-[#1F2933]">
                            <span className="font-semibold">{actor}</span>
                            {verb && <span className="text-[#66717A]"> {verb}</span>}
                            {target && <span className="font-semibold"> {target}</span>}
                            {!verb && !target && (
                              <span className="text-[#66717A]"> performed an action</span>
                            )}
                          </p>
                          <div className="mt-1 flex items-center gap-1.5 text-[11px] text-[#6E767D]">
                            <span className={`inline-flex h-4 w-4 items-center justify-center rounded-full border ${meta.tone}`}>
                              <Icon className="h-2.5 w-2.5" />
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
              <div className="mt-5 shrink-0 rounded-lg border border-dashed border-border bg-[#F5F7F8] p-4">
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
                  {storage.document_count > 0 && (
                    <> · {storage.document_count.toLocaleString()} document{storage.document_count === 1 ? "" : "s"}</>
                  )}
                </p>
                {storage.percentage > 80 && (
                  <p className="mt-2 text-[11px] text-destructive font-medium">
                    Approaching storage limit — consider archiving old documents.
                  </p>
                )}
              </div>
            </section>
          </div>

          {!tasksLoading && visibleTasks.length > 0 && (
            <section className="flex flex-col gap-4 border border-[#C8CDD2] bg-white p-5" aria-labelledby="recent-tasks-heading">
              <div className="flex items-center justify-between gap-3">
                <h2 id="recent-tasks-heading" className="text-xs font-bold uppercase tracking-[0.16em] text-[#5E6870]">
                  Recent tasks
                </h2>
                <Link to="/workflow" className="inline-flex items-center gap-1 text-xs font-bold text-[#287EAD] hover:text-[#206D99]">
                  View all tasks <ArrowRight className="h-3.5 w-3.5" />
                </Link>
              </div>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
                {visibleTasks.map((task: WorkflowTask) => {
                  const documentId = getTaskDocumentId(task);
                  const documentFormat = getTaskDocumentFormat(task);
                  const taskUrgency = getTaskUrgency(task.due_at);
                  const taskIconClass =
                    taskUrgency === "overdue"
                      ? "border-[#E7A9A3] bg-[#FDEDEC] text-[#B42318]"
                      : taskUrgency === "urgent"
                        ? "border-[#F1C58A] bg-[#FFF7E6] text-[#A16207]"
                        : "border-[#B7D9E9] bg-[#EEF6FB] text-[#287EAD]";
                  return (
                    <Link
                      key={task.id}
                      to={documentId ? `/documents/${documentId}` : "/workflow"}
                      className={clsx(
                        "flex min-w-0 items-start gap-3 border bg-[#F9FAFB] p-3 transition-colors hover:border-[#287EAD]/50 hover:bg-[#EEF6FB]",
                        taskUrgency === "overdue" || taskUrgency === "urgent" ? "border-[#E7D0A8]" : "border-[#E2E5E8]",
                      )}
                    >
                      <span className={`flex h-12 w-10 shrink-0 flex-col items-center justify-center border ${taskIconClass}`}>
                        <FileText className="h-4 w-4" />
                        <span className="mt-0.5 text-[9px] font-bold uppercase">{documentFormat}</span>
                      </span>
                      <span className="min-w-0 pt-0.5">
                        <span className="block truncate text-xs font-bold text-[#1F2933]">{getTaskDocumentTitle(task)}</span>
                        <span className="mt-1 block truncate text-[11px] text-[#287EAD]">
                          {task.step?.name || "Workflow task"}
                        </span>
                        <TaskMetaInfo dueAt={task.due_at} />
                      </span>
                    </Link>
                  );
                })}
              </div>
            </section>
          )}

        </div>
      </div>
    </div>
  );
}
