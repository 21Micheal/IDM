// RequisitionDashboardPage.tsx
/**
 * RequisitionDashboardPage
 *
 * Scoped, white-labeled requisition dashboard styled identically to DashboardPage.tsx:
 * - Operations workspace header banner with direct "Raise requisition" action
 * - Metric cards with trends (Total Requisitions, Pending Approval, Approved, SunSystems Suppliers)
 * - 2-Column layout: Recent Requisitions table (left, xl:col-span-2) + Live Audit Trail & ERP sync (right, xl:col-span-1)
 * - Recent tasks queue at the bottom
 */

import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { formatDistanceToNow } from "date-fns";
import clsx from "clsx";
import {
  Layers,
  Timer,
  ShieldCheck,
  ClipboardCheck,
  Plus,
  ArrowRight,
  ChevronLeft,
  ChevronRight,
  Loader2,
  FileText,
  Building2,
  TrendingUp,
  TrendingDown,
  Minus,
  GitBranch,
  FileSignature,
  Calendar,
  Wallet,
  CheckCircle2,
} from "lucide-react";
import { api, documentsAPI, sunsystemsAPI, workflowAPI } from "@/services/api";
import { useAuthStore } from "@/store/authStore";
import { QUERY_FIVE_MIN_STALE, QUERY_SHORT_STALE } from "@/lib/reactQueryDefaults";
import type { Document, WorkflowTask } from "@/types";

const RECENT_REQS_PAGE_SIZE = 5;
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
  object_type?: string;
  changes?: Record<string, unknown> | null;
};

type StatTrend = {
  value: number;
  isPositive: boolean;
  direction: "up" | "down" | "flat";
  suffix?: string;
  label?: string;
};

function getDashboardStatusLabel(status: string): string {
  return status ? status.replace(/_/g, " ").replace(/\b\w/g, (char) => char.toUpperCase()) : "Unknown";
}

function getDashboardStatusTextClass(status: string): string {
  const key = status?.toLowerCase?.().replace(/\s+/g, "_") ?? "";
  if (["approved", "completed"].includes(key)) return "text-emerald-700";
  if (["pending_review", "pending_approval", "on_hold", "returned", "request_pending"].includes(key)) return "text-amber-700";
  if (["rejected", "void"].includes(key)) return "text-red-700";
  if (key === "archived") return "text-sky-700";
  return "text-[#3F474F]";
}

function isRequisitionDoc(doc: any): boolean {
  return Boolean(doc?.metadata?.form?.sections) || doc?.document_type_name?.toLowerCase().includes("requisition");
}

function getReqAmount(doc: any): number | null {
  const requested = Number(doc?.metadata?.form?.requested_amount);
  if (Number.isFinite(requested) && requested > 0) return requested;
  const amt = Number(doc?.amount);
  if (Number.isFinite(amt) && amt > 0) return amt;
  const values = doc?.metadata?.form?.values ?? {};
  const alt = Number(values?.amount ?? values?.total ?? values?.total_amount ?? values?.requested_amount);
  return Number.isFinite(alt) && alt > 0 ? alt : null;
}

function getReqSupplier(doc: any): string {
  const values = doc?.metadata?.form?.values ?? {};
  return values?.supplier || values?.supplier_name || doc?.supplier || "—";
}

function formatMoney(amount: number | null, currency?: string) {
  if (amount === null) return "—";
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency: currency || "KES", maximumFractionDigits: 0 }).format(amount);
  } catch {
    return `${currency ?? ""} ${amount.toLocaleString()}`.trim();
  }
}

function cleanAuditTitle(rawTitle: string): string {
  return rawTitle
    .replace(/\[[^\]]+\]/g, "")
    .replace(/\bdocument\s+/gi, "")
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

const EVENT_VERB_MAP: Record<string, string> = {
  "user.login": "signed in",
  "user.logout": "signed out",
  "document.created": "raised requisition",
  "document.updated": "updated requisition",
  "document.submitted": "submitted requisition",
  "workflow.approved": "approved requisition",
  "workflow.rejected": "rejected requisition",
  "workflow.returned": "returned requisition",
  "workflow.held": "held requisition",
};

function formatAuditSummary(event: DashboardAuditEvent): { actor: string; verb: string; target: string } {
  const actor = deriveActorName(event);
  const code = String(event.event ?? "").toLowerCase();
  const objectTitle = cleanAuditTitle(event.object_repr || "");
  const verb = EVENT_VERB_MAP[code] || "updated";
  return { actor, verb, target: objectTitle };
}

function getAuditPresentation(event: any) {
  const name = String(event?.event ?? "").toLowerCase();
  if (name.includes("approve")) {
    return { icon: CheckCircle2, tone: "bg-emerald-50 text-emerald-600 border-emerald-200" };
  }
  if (name.includes("reject") || name.includes("fail")) {
    return { icon: ShieldCheck, tone: "bg-rose-50 text-rose-600 border-rose-200" };
  }
  if (name.startsWith("workflow.")) {
    return { icon: GitBranch, tone: "bg-[#EEF6FB] text-[#287EAD] border-[#287EAD]/30" };
  }
  return { icon: FileText, tone: "bg-slate-50 text-slate-600 border-slate-200" };
}

type DashboardMetricCardProps = {
  title: string;
  value: string | number;
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
        : tone === "teal"
          ? "text-[#0284C7]"
          : "text-[#287EAD]";
  const TrendIcon = trend?.direction === "up" ? TrendingUp : trend?.direction === "down" ? TrendingDown : Minus;
  const trendClass = trend
    ? trend.isPositive
      ? "text-[#287EAD]"
      : "text-[#B42318]"
    : "text-[#6E767D]";

  return (
    <Link
      to={href}
      className="group flex min-h-[142px] min-w-0 flex-col border border-[#C8CDD2] bg-white p-5 transition-colors hover:border-[#287EAD]/60"
    >
      <div className="flex items-start justify-between gap-3">
        <p className="truncate text-xs font-semibold uppercase tracking-[0.16em] text-[#68737B]">{title}</p>
        <Icon className={`h-5 w-5 shrink-0 ${iconClass}`} />
      </div>
      <p className="mt-4 text-3xl font-semibold tracking-tight text-[#1F2933]">
        {typeof value === "number" ? value.toLocaleString() : value}
      </p>
      {trend ? (
        <div className={`mt-2 flex min-w-0 items-center gap-1.5 text-xs font-semibold ${trendClass}`} title={trend.label}>
          <TrendIcon className="h-3.5 w-3.5 shrink-0" />
          <span className="shrink-0">{trend.value}%</span>
          <span className="truncate">{trend.label}</span>
        </div>
      ) : (
        <span className="mt-2 text-xs text-[#6E767D]">Active pipeline</span>
      )}
    </Link>
  );
}

export default function RequisitionDashboardPage() {
  const { user } = useAuthStore();
  const navigate = useNavigate();

  const [recentReqsPage, setRecentReqsPage] = useState(1);
  const [recentAuditPage, setRecentAuditPage] = useState(1);
  const [recentDocsFilter, setRecentDocsFilter] = useState<"all" | "attention">("all");

  // 1. Requisitions pool
  const { data: poolData, isLoading: docsLoading } = useQuery({
    queryKey: ["requisitions", "dashboard-pool", recentReqsPage],
    queryFn: () =>
      documentsAPI.list({
        is_form: true,
        ordering: "-updated_at,-created_at",
        page: 1,
        page_size: 200,
      }).then((r) => r.data),
    ...QUERY_SHORT_STALE,
  });

  const requisitionRows = useMemo(() => {
    const raw = (poolData?.results ?? []) as any[];
    return raw.filter(isRequisitionDoc);
  }, [poolData]);

  // Filtered recent rows
  const filteredRecentReqs = useMemo(() => {
    if (recentDocsFilter === "attention") {
      return requisitionRows.filter((r) =>
        ["pending_approval", "pending_review", "request_pending", "on_hold", "rejected"].includes(r.status)
      );
    }
    return requisitionRows;
  }, [requisitionRows, recentDocsFilter]);

  const recentReqsCount = filteredRecentReqs.length;
  const recentReqsPages = Math.max(1, Math.ceil(recentReqsCount / RECENT_REQS_PAGE_SIZE));
  const pagedRecentReqs = useMemo(() => {
    const start = (recentReqsPage - 1) * RECENT_REQS_PAGE_SIZE;
    return filteredRecentReqs.slice(start, start + RECENT_REQS_PAGE_SIZE);
  }, [filteredRecentReqs, recentReqsPage]);

  // 2. Metrics calculation
  const totalRequisitions = poolData?.count ?? requisitionRows.length;
  const pendingCount = useMemo(
    () =>
      requisitionRows.filter((r) =>
        ["pending_approval", "request_pending", "on_hold"].includes(r.builder_process_step || r.status)
      ).length,
    [requisitionRows]
  );
  const approvedCount = useMemo(
    () => requisitionRows.filter((r) => r.status === "approved").length,
    [requisitionRows]
  );

  // 3. Live SunSystems connection & accounts
  const { data: sunConnection } = useQuery({
    queryKey: ["sunsystems", "connection-status"],
    queryFn: () => sunsystemsAPI.getConnection().then((res) => res.data),
    staleTime: 5 * 60_000,
    retry: false,
  });

  const { data: accountsData } = useQuery({
    queryKey: ["sunsystems", "supplier-count"],
    queryFn: () => sunsystemsAPI.getAccounts({ account_type: "supplier" }).then((res) => res.data),
    staleTime: 5 * 60_000,
    retry: false,
  });
  const supplierCount = accountsData?.count ?? accountsData?.accounts?.length ?? 0;
  const isSunConnected = Boolean(sunConnection?.effective?.base_url) && !accountsData?.error;

  // 4. Audit Trail query
  const { data: recentAudit, isLoading: auditLoading } = useQuery({
    queryKey: ["audit", "requisitions", recentAuditPage],
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
  const recentAuditCount = recentAudit?.count ?? recentAudit?.results?.length ?? 0;
  const recentAuditPages = Math.max(1, Math.ceil(recentAuditCount / RECENT_AUDIT_PAGE_SIZE));

  // 5. My tasks
  const { data: myTasks = [], isLoading: tasksLoading } = useQuery({
    queryKey: ["workflow", "my-tasks"],
    queryFn: () => workflowAPI.myTasks().then((r) => r.data.results ?? r.data),
    ...QUERY_SHORT_STALE,
  });

  return (
    <div className="scrollbar-minimal min-h-0 flex-1 overflow-y-auto">
      <div className="w-full space-y-5 px-6 pb-12 pt-6 lg:px-8 lg:pb-14 lg:pt-8">
        {/* Top Operations Workspace Banner */}
        <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
          <div className="min-w-0">
            <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-[#5E6870]">
              Requisition Operations
            </p>
            <h1 className="mt-1 truncate text-2xl font-semibold tracking-tight text-[#1F2933]">
              {user?.first_name ? `Welcome, ${user.first_name}` : "Procurement Operations"}
            </h1>
          </div>
          <Link
            to="/new"
            className="inline-flex h-10 shrink-0 items-center justify-center gap-2 bg-[#287EAD] px-4 text-sm font-bold text-white transition-colors hover:bg-[#206D99]"
          >
            <Plus className="h-4 w-4" />
            Raise requisition
          </Link>
        </div>

        {/* 4 Metric Cards */}
        <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 xl:grid-cols-4">
          <DashboardMetricCard
            title="Total Requisitions"
            value={totalRequisitions}
            icon={Layers}
            href="/list"
            tone="neutral"
            trend={{ value: 12, isPositive: true, direction: "up", label: "vs last month" }}
          />
          <DashboardMetricCard
            title="Pending Approval"
            value={pendingCount}
            icon={Timer}
            href="/list?status=pending_approval"
            tone="attention"
            trend={pendingCount > 0 ? { value: pendingCount, isPositive: false, direction: "up", label: "requires action" } : undefined}
          />
          <DashboardMetricCard
            title="Approved"
            value={approvedCount}
            icon={ShieldCheck}
            href="/list?status=approved"
            tone="positive"
            trend={{ value: 8, isPositive: true, direction: "up", label: "pipeline healthy" }}
          />
          <DashboardMetricCard
            title="SunSystems Suppliers"
            value={supplierCount}
            icon={Building2}
            href="/suppliers"
            tone="teal"
          />
        </div>

        {/* 2-Column Layout: Recent Requisitions (wide) + Audit Trail w/ ERP status (narrow) */}
        <div className="grid min-w-0 grid-cols-1 items-stretch gap-5 xl:grid-cols-3">
          {/* Recent Requisitions — Table */}
          <section className="flex min-w-0 flex-col overflow-hidden border border-[#C8CDD2] bg-white xl:col-span-2">
            <div className="flex items-center justify-between gap-4 border-b border-[#C8CDD2] px-5 py-4">
              <div>
                <div className="flex items-center gap-2">
                  <h2 className="text-sm font-bold text-[#1F2933]">Recent requisitions</h2>
                  <span className="bg-[#EEF6FB] px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-[#287EAD]">
                    Live
                  </span>
                </div>
                <p className="mt-0.5 text-xs text-[#5E6870]">Latest activity across requisition pipeline</p>
              </div>

              <div className="flex items-center gap-3">
                <div className="flex border border-[#C8CDD2] text-[11px]" role="group" aria-label="Recent requisition filter">
                  <button
                    type="button"
                    onClick={() => { setRecentDocsFilter("all"); setRecentReqsPage(1); }}
                    className={clsx(
                      "px-2.5 py-1.5 font-semibold transition-colors",
                      recentDocsFilter === "all" ? "bg-[#50545A] text-white" : "bg-white text-[#5E6870] hover:bg-[#F5F7F8]"
                    )}
                  >
                    All
                  </button>
                  <button
                    type="button"
                    onClick={() => { setRecentDocsFilter("attention"); setRecentReqsPage(1); }}
                    className={clsx(
                      "border-l border-[#C8CDD2] px-2.5 py-1.5 font-semibold transition-colors",
                      recentDocsFilter === "attention" ? "bg-[#FFF7E6] text-[#A16207]" : "bg-white text-[#5E6870] hover:bg-[#F5F7F8]"
                    )}
                  >
                    Needs attention
                  </button>
                </div>
                <Link
                  to="/list"
                  className="inline-flex items-center gap-1 text-xs font-bold text-[#287EAD] transition-colors hover:text-[#206D99]"
                >
                  View all <ArrowRight className="h-3 w-3" />
                </Link>
              </div>
            </div>

            <div className="flex-1">
              {docsLoading ? (
                <div className="flex h-full items-center justify-center p-10">
                  <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
                </div>
              ) : pagedRecentReqs.length > 0 ? (
                <table className="w-full table-fixed text-sm">
                  <thead>
                    <tr className="border-b border-[#AEB5BB] bg-[#50545A] text-left text-[11px] uppercase tracking-wider text-white">
                      <th className="w-[38%] px-5 py-3.5 font-medium">Requisition</th>
                      <th className="hidden w-[20%] px-5 py-3.5 font-medium md:table-cell">Supplier</th>
                      <th className="w-[18%] px-5 py-3.5 font-medium">Amount</th>
                      <th className="w-[14%] px-5 py-3.5 font-medium">Status</th>
                      <th className="hidden w-[10%] px-5 py-3.5 font-medium lg:table-cell">Updated</th>
                    </tr>
                  </thead>
                  <tbody>
                    {pagedRecentReqs.map((doc: any) => (
                      <tr
                        key={doc.id}
                        className="cursor-pointer border-t border-[#D3D7DA] transition hover:bg-[#F5F7F8]"
                        onClick={() => navigate(`/${doc.id}`)}
                      >
                        <td className="max-w-0 px-5 py-4">
                          <div className="flex items-center gap-3 min-w-0">
                            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-[#287EAD]/25 bg-[#EEF6FB] text-[#287EAD]">
                              <FileText className="h-4 w-4" />
                            </div>
                            <div className="min-w-0 flex-1">
                              <p className="truncate font-semibold text-[#1F2933]">
                                {doc.title || doc.reference_number || "Requisition"}
                              </p>
                              <p className="truncate text-[11px] text-[#5E6870]">
                                {doc.reference_number || "REQ"} · {doc.department_name || doc.uploaded_by?.department_name || "Procurement"}
                              </p>
                            </div>
                          </div>
                        </td>
                        <td className="hidden max-w-0 px-5 py-4 text-xs text-[#5E6870] md:table-cell">
                          <span className="block truncate font-medium text-[#1F2933]">
                            {getReqSupplier(doc)}
                          </span>
                        </td>
                        <td className="px-5 py-4 font-semibold text-[#1F2933]">
                          {formatMoney(getReqAmount(doc), doc.currency)}
                        </td>
                        <td className="px-5 py-4 align-middle">
                          <span className={clsx("text-xs font-semibold", getDashboardStatusTextClass(doc.status))}>
                            {getDashboardStatusLabel(doc.status)}
                          </span>
                        </td>
                        <td className="hidden whitespace-nowrap px-5 py-4 text-xs text-[#5E6870] lg:table-cell">
                          {doc.updated_at ? formatDistanceToNow(new Date(doc.updated_at), { addSuffix: true }) : "—"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                <div className="flex h-full flex-col items-center justify-center px-6 py-10 text-center">
                  <FileText className="mx-auto h-12 w-12 text-muted-foreground/50" />
                  <p className="mt-4 text-sm text-muted-foreground">
                    {recentDocsFilter === "attention" ? "No requisitions currently need attention." : "No requisitions found yet."}
                  </p>
                  <Link
                    to="/new"
                    className="mt-3 inline-flex text-sm font-semibold text-[#287EAD] hover:text-[#206D99] transition-colors"
                  >
                    Raise your first requisition →
                  </Link>
                </div>
              )}
            </div>

            {/* Pagination Footer */}
            {recentReqsCount > RECENT_REQS_PAGE_SIZE && (
              <div className="flex shrink-0 items-center justify-between border-t border-[#C8CDD2] bg-[#F5F7F8] px-5 py-3">
                <span className="text-xs text-[#5E6870]">
                  Page {recentReqsPage} of {recentReqsPages}
                </span>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setRecentReqsPage((p) => Math.max(1, p - 1))}
                    disabled={recentReqsPage === 1}
                    className="inline-flex items-center gap-1 border border-[#C8CDD2] bg-white px-3 py-1.5 text-xs font-semibold text-[#1F2933] hover:bg-[#EEF6FB] disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    <ChevronLeft className="h-3.5 w-3.5" /> Prev
                  </button>
                  <button
                    type="button"
                    onClick={() => setRecentReqsPage((p) => p + 1)}
                    disabled={recentReqsPage * RECENT_REQS_PAGE_SIZE >= recentReqsCount}
                    className="inline-flex items-center gap-1 border border-[#C8CDD2] bg-white px-3 py-1.5 text-xs font-semibold text-[#1F2933] hover:bg-[#EEF6FB] disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    Next <ChevronRight className="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>
            )}
          </section>

          {/* Audit Trail with SunSystems ERP link merged at bottom */}
          <section className="flex min-w-0 flex-col overflow-hidden border border-[#C8CDD2] bg-white p-5">
            <div className="flex items-start justify-between">
              <div>
                <h2 className="text-sm font-bold text-[#1F2933]">
                  {user?.has_admin_access ? "Audit Trail" : "Requisition Activity"}
                </h2>
                <p className="mt-0.5 text-xs text-[#5E6870]">A plain-language feed of what just happened.</p>
              </div>
              <Link to="/audit" className="text-xs font-bold text-[#287EAD] transition-colors hover:text-[#206D99]">
                View all
              </Link>
            </div>

            <ul className="mt-5 flex-1 space-y-4">
              {auditLoading ? (
                <li className="flex h-full items-center justify-center rounded-lg bg-muted/40 p-4 text-center text-xs text-muted-foreground">
                  Loading activity…
                </li>
              ) : recentAudit?.results?.length ? (
                recentAudit.results.map((event: DashboardAuditEvent, index: number) => {
                  const meta = getAuditPresentation(event);
                  const Icon = meta.icon;
                  const isLast = index === (recentAudit.results.length - 1);
                  const initialsSource = event.actor_name || event.actor_email || "System";
                  const initials =
                    initialsSource
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
                <li className="flex h-full items-center justify-center rounded-lg bg-muted/40 p-4 text-center text-xs text-muted-foreground">
                  No recent audit events.
                </li>
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
                    <ChevronLeft className="h-3.5 w-3.5" />
                  </button>
                  <button
                    type="button"
                    onClick={() => setRecentAuditPage((p) => p + 1)}
                    disabled={recentAuditPage * RECENT_AUDIT_PAGE_SIZE >= recentAuditCount}
                    className="inline-flex items-center rounded-md border border-border bg-card p-1 text-foreground hover:bg-muted disabled:opacity-40"
                  >
                    <ChevronRight className="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>
            )}

            {/* SunSystems ERP Link Card (styled like Storage Used card) */}
            <div className="mt-5 shrink-0 rounded-lg border border-dashed border-[#C8CDD2] bg-[#F5F7F8] p-4">
              <div className="flex items-center justify-between">
                <p className="text-xs font-medium text-[#1F2933]">SunSystems ERP Status</p>
                <span className={clsx(
                  "inline-flex items-center gap-1 text-[11px] font-semibold",
                  isSunConnected ? "text-emerald-700" : "text-amber-700"
                )}>
                  <span className={clsx("h-1.5 w-1.5 rounded-full", isSunConnected ? "bg-emerald-500" : "bg-amber-500")} />
                  {isSunConnected ? "Active Link" : "Standby"}
                </span>
              </div>
              <div className="mt-2 h-2 overflow-hidden rounded-full bg-[#E2E8F0]">
                <div
                  className="h-full rounded-full transition-all duration-500 bg-[#287EAD]"
                  style={{ width: isSunConnected ? "100%" : "30%" }}
                />
              </div>
              <p className="mt-2 text-[11px] text-[#5E6870]">
                {supplierCount.toLocaleString()} live vendor{supplierCount === 1 ? "" : "s"} synced
                {sunConnection?.effective?.business_unit && ` · BU: ${sunConnection.effective.business_unit}`}
              </p>
            </div>
          </section>
        </div>

        {/* My Requisition Tasks (matching bottom tasks section) */}
        {!tasksLoading && myTasks.length > 0 && (
          <section className="flex flex-col gap-4 border border-[#C8CDD2] bg-white p-5" aria-labelledby="requisition-tasks-heading">
            <div className="flex items-center justify-between gap-3">
              <h2 id="requisition-tasks-heading" className="text-xs font-bold uppercase tracking-[0.16em] text-[#5E6870]">
                Pending Approval Tasks
              </h2>
              <Link to="/approvals" className="inline-flex items-center gap-1 text-xs font-bold text-[#287EAD] hover:text-[#206D99]">
                View all tasks <ArrowRight className="h-3.5 w-3.5" />
              </Link>
            </div>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
              {myTasks.slice(0, 4).map((task: WorkflowTask) => (
                <Link
                  key={task.id}
                  to={`/${task.document_id || ""}`}
                  className="flex min-w-0 items-start gap-3 border border-[#E2E5E8] bg-[#F9FAFB] p-3 transition-colors hover:border-[#287EAD]/50 hover:bg-[#EEF6FB]"
                >
                  <span className="flex h-12 w-10 shrink-0 flex-col items-center justify-center border border-[#B7D9E9] bg-[#EEF6FB] text-[#287EAD]">
                    <FileText className="h-4 w-4" />
                    <span className="mt-0.5 text-[9px] font-bold uppercase">REQ</span>
                  </span>
                  <span className="min-w-0 pt-0.5">
                    <span className="block truncate text-xs font-bold text-[#1F2933]">
                      {task.document_title || "Requisition"}
                    </span>
                    <span className="mt-1 block truncate text-[11px] text-[#287EAD]">
                      {task.step?.name || "Approval Step"}
                    </span>
                    {task.due_at && (
                      <span className="mt-1 inline-flex items-center gap-1 text-[11px] text-[#6E767D]">
                        <Calendar className="h-3 w-3" />
                        {formatDistanceToNow(new Date(task.due_at), { addSuffix: true })}
                      </span>
                    )}
                  </span>
                </Link>
              ))}
            </div>
          </section>
        )}
      </div>
    </div>
  );
}