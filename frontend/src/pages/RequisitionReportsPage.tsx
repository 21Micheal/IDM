/**
 * RequisitionReportsPage.tsx
 *
 * Comprehensive financial reporting for Requisition forms:
 * Activity Code, Description, Account Code, Amount, and Journal Number.
 * Includes executive summary KPIs, multi-criteria filtering, grouping by
 * Activity and Account, visual charts, and Excel/CSV and Print exports.
 */
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import {
  FileSpreadsheet, Download, Printer, Search, X, Filter,
  CheckCircle2, Clock, AlertTriangle, TrendingUp, BarChart3,
  PieChart as PieChartIcon, Building2, ClipboardList, RefreshCw,
  ExternalLink, Layers, ChevronLeft, ChevronRight,
  ArrowUpDown, SlidersHorizontal, PlusCircle, Check, Loader2,
} from "lucide-react";
import {
  ResponsiveContainer, BarChart, Bar, XAxis, YAxis,
  Tooltip as RechartsTooltip, CartesianGrid, Cell, PieChart, Pie,
} from "recharts";
import { documentsAPI } from "@/services/api";
import { toast } from "@/components/ui/vault-toast";
import type {
  RequisitionReportLine,
  RequisitionReportParams,
  RequisitionReportResponse,
} from "@/types/reports";
import { cn } from "@/lib/utils";

type ActiveTab = "lines" | "activities" | "accounts" | "visuals";
type SortDirection = "asc" | "desc";

const CHART_COLORS = [
  "#287EAD", "#0D9488", "#6366F1", "#F59E0B",
  "#EC4899", "#8B5CF6", "#10B981", "#3B82F6",
  "#F97316", "#14B8A6",
];

function formatCurrency(amount: number, currency: string = "USD"): string {
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: currency || "USD",
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(amount);
  } catch {
    return `${currency} ${amount.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  }
}

function statusBadge(statusStr: string) {
  const s = String(statusStr || "").toLowerCase();
  if (s.includes("approved")) {
    return (
      <span className="inline-flex items-center gap-1 rounded bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-700 border border-emerald-200">
        <CheckCircle2 className="h-3 w-3" /> Approved
      </span>
    );
  }
  if (s.includes("reject")) {
    return (
      <span className="inline-flex items-center gap-1 rounded bg-rose-50 px-2 py-0.5 text-xs font-medium text-rose-700 border border-rose-200">
        <X className="h-3 w-3" /> Rejected
      </span>
    );
  }
  if (s.includes("pending") || s.includes("review") || s.includes("hold")) {
    return (
      <span className="inline-flex items-center gap-1 rounded bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-700 border border-amber-200">
        <Clock className="h-3 w-3" /> Pending
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 rounded bg-slate-50 px-2 py-0.5 text-xs font-medium text-slate-600 border border-slate-200">
      {statusStr || "Draft"}
    </span>
  );
}

function journalBadge(journalNumber: string, journalStatus: string) {
  const hasJnl = journalNumber && journalNumber !== "—";
  if (hasJnl) {
    return (
      <span className="inline-flex items-center gap-1 rounded bg-[#EBF5FA] px-2 py-0.5 font-mono text-xs font-semibold text-[#287EAD] border border-[#BCE1F5]">
        <Check className="h-3 w-3 text-emerald-600" />
        #{journalNumber}
      </span>
    );
  }
  if (journalStatus === "pending") {
    return (
      <span className="inline-flex items-center gap-1 rounded bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-700">
        <Clock className="h-3 w-3" /> Posting
      </span>
    );
  }
  if (journalStatus === "failed") {
    return (
      <span className="inline-flex items-center gap-1 rounded bg-rose-50 px-2 py-0.5 text-xs font-medium text-rose-700">
        <AlertTriangle className="h-3 w-3" /> Failed
      </span>
    );
  }
  return (
    <span className="text-xs text-[#9AA5B1] font-mono">
      —
    </span>
  );
}

export default function RequisitionReportsPage() {
  const [activeTab, setActiveTab] = useState<ActiveTab>("lines");

  // Filters
  const [search, setSearch] = useState("");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [accountCode, setAccountCode] = useState("");
  const [activityCode, setActivityCode] = useState("");
  const [status, setStatus] = useState("");
  const [department, setDepartment] = useState("");
  const [hasJournal, setHasJournal] = useState(false);

  // Sorting
  const [sortField, setSortField] = useState<keyof RequisitionReportLine>("date");
  const [sortDirection, setSortDirection] = useState<SortDirection>("desc");

  // Pagination
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);

  const queryParams: RequisitionReportParams = useMemo(() => {
    const p: RequisitionReportParams = {};
    if (search.trim()) p.search = search.trim();
    if (startDate) p.start_date = startDate;
    if (endDate) p.end_date = endDate;
    if (accountCode) p.account_code = accountCode;
    if (activityCode) p.activity_code = activityCode;
    if (status) p.status = status;
    if (department) p.department = department;
    if (hasJournal) p.has_journal = "true";
    return p;
  }, [search, startDate, endDate, accountCode, activityCode, status, department, hasJournal]);

  const { data, isLoading, isFetching, refetch } = useQuery<RequisitionReportResponse>({
    queryKey: ["requisition-financial-report", queryParams],
    queryFn: () => documentsAPI.requisitionReport(queryParams).then((r) => r.data),
    staleTime: 30_000,
  });

  const summary = data?.summary ?? {
    total_amount: 0,
    total_lines: 0,
    posted_amount: 0,
    posted_lines: 0,
    distinct_activities: 0,
    distinct_accounts: 0,
  };

  const lines = data?.lines ?? [];
  const filterOptions = data?.filter_options ?? {
    accounts: [],
    activities: [],
    departments: [],
    statuses: [],
  };

  const hasActiveFilters = Boolean(
    search || startDate || endDate || accountCode || activityCode || status || department || hasJournal
  );

  const handleResetFilters = () => {
    setSearch("");
    setStartDate("");
    setEndDate("");
    setAccountCode("");
    setActivityCode("");
    setStatus("");
    setDepartment("");
    setHasJournal(false);
    setPage(1);
  };

  const handleSort = (field: keyof RequisitionReportLine) => {
    if (sortField === field) {
      setSortDirection((prev) => (prev === "asc" ? "desc" : "asc"));
    } else {
      setSortField(field);
      setSortDirection("asc");
    }
    setPage(1);
  };

  // Sorted lines
  const sortedLines = useMemo(() => {
    const list = [...lines];
    list.sort((a, b) => {
      let aVal = a[sortField];
      let bVal = b[sortField];
      if (typeof aVal === "number" && typeof bVal === "number") {
        return sortDirection === "asc" ? aVal - bVal : bVal - aVal;
      }
      const aStr = String(aVal || "").toLowerCase();
      const bStr = String(bVal || "").toLowerCase();
      return sortDirection === "asc" ? aStr.localeCompare(bStr) : bStr.localeCompare(aStr);
    });
    return list;
  }, [lines, sortField, sortDirection]);

  // Paginated lines
  const paginatedLines = useMemo(() => {
    const start = (page - 1) * pageSize;
    return sortedLines.slice(start, start + pageSize);
  }, [sortedLines, page, pageSize]);

  const totalPages = Math.ceil(sortedLines.length / pageSize) || 1;

  // Chart data
  const activityChartData = useMemo(() => {
    return (data?.by_activity || []).slice(0, 10).map((item) => ({
      name: item.activity_code,
      description: item.activity_description || item.activity_code,
      amount: item.total_amount,
      count: item.line_count,
    }));
  }, [data?.by_activity]);

  const accountChartData = useMemo(() => {
    return (data?.by_account || []).slice(0, 8).map((item) => ({
      name: item.account_code,
      amount: item.total_amount,
      count: item.line_count,
    }));
  }, [data?.by_account]);

  const [exportingCsv, setExportingCsv] = useState(false);

  const handlePrint = () => {
    window.print();
  };

  const handleExportCsv = async () => {
    try {
      setExportingCsv(true);
      const res = await documentsAPI.downloadRequisitionReportCsv(queryParams);
      const blob = new Blob([res.data], { type: "text/csv;charset=utf-8;" });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `requisition_financial_report_${new Date().toISOString().slice(0, 10)}.csv`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
      toast.success("Requisition report CSV downloaded successfully.");
    } catch {
      toast.error("Failed to export requisition report CSV.");
    } finally {
      setExportingCsv(false);
    }
  };

  return (
    <div className="flex h-full flex-col bg-[#F8FAFC] overflow-y-auto print:bg-white print:overflow-visible">
      {/* ── Top Header & Actions ── */}
      <div className="border-b border-[#E2E8F0] bg-white px-6 py-5 shadow-xs print:border-none print:px-0">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <div className="flex items-center gap-2">
              <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-[#EBF5FA] text-[#287EAD]">
                <FileSpreadsheet className="h-5 w-5" />
              </span>
              <h1 className="text-xl font-bold tracking-tight text-[#1E293B]">
                Requisition Financial Reports
              </h1>
            </div>
            <p className="mt-1 text-xs text-[#64748B]">
              Detailed breakdown of expenditure lines: Activity code, Description, Account code, Amount, and Journal number.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2 print:hidden">
            <button
              type="button"
              onClick={() => refetch()}
              disabled={isFetching}
              className="inline-flex items-center gap-1.5 rounded border border-[#CBD5E1] bg-white px-3 py-1.5 text-xs font-medium text-[#475569] shadow-xs hover:bg-[#F1F5F9] transition-colors"
            >
              <RefreshCw className={cn("h-3.5 w-3.5", isFetching && "animate-spin")} />
              Refresh
            </button>
            <button
              type="button"
              onClick={handlePrint}
              className="inline-flex items-center gap-1.5 rounded border border-[#CBD5E1] bg-white px-3 py-1.5 text-xs font-medium text-[#475569] shadow-xs hover:bg-[#F1F5F9] transition-colors"
            >
              <Printer className="h-3.5 w-3.5" />
              Print
            </button>
            <button
              type="button"
              onClick={handleExportCsv}
              disabled={exportingCsv}
              className="inline-flex items-center gap-1.5 rounded bg-[#287EAD] px-3.5 py-1.5 text-xs font-semibold text-white shadow-xs hover:bg-[#1E6F99] transition-colors disabled:opacity-60"
            >
              {exportingCsv ? (
                <>
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  Exporting…
                </>
              ) : (
                <>
                  <Download className="h-3.5 w-3.5" />
                  Export CSV
                </>
              )}
            </button>
          </div>
        </div>

        {/* ── KPI Metric Cards ── */}
        <div className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6 print:grid-cols-3">
          <div className="rounded-lg border border-[#E2E8F0] bg-white p-3 shadow-2xs">
            <div className="flex items-center justify-between text-xs text-[#64748B]">
              <span>Total Requisition</span>
              <TrendingUp className="h-3.5 w-3.5 text-[#287EAD]" />
            </div>
            <div className="mt-1.5 text-lg font-bold tabular-nums text-[#1E293B]">
              {formatCurrency(summary.total_amount)}
            </div>
            <div className="mt-0.5 text-[11px] text-[#64748B]">
              Across {summary.total_lines} lines
            </div>
          </div>

          <div className="rounded-lg border border-[#E2E8F0] bg-white p-3 shadow-2xs">
            <div className="flex items-center justify-between text-xs text-[#64748B]">
              <span>Posted to SunSystems</span>
              <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" />
            </div>
            <div className="mt-1.5 text-lg font-bold tabular-nums text-emerald-700">
              {formatCurrency(summary.posted_amount)}
            </div>
            <div className="mt-0.5 text-[11px] text-emerald-600 font-medium">
              {summary.posted_lines} lines posted
            </div>
          </div>

          <div className="rounded-lg border border-[#E2E8F0] bg-white p-3 shadow-2xs">
            <div className="flex items-center justify-between text-xs text-[#64748B]">
              <span>Pending / Unposted</span>
              <Clock className="h-3.5 w-3.5 text-amber-600" />
            </div>
            <div className="mt-1.5 text-lg font-bold tabular-nums text-amber-700">
              {formatCurrency(summary.total_amount - summary.posted_amount)}
            </div>
            <div className="mt-0.5 text-[11px] text-amber-600">
              {summary.total_lines - summary.posted_lines} unposted lines
            </div>
          </div>

          <div className="rounded-lg border border-[#E2E8F0] bg-white p-3 shadow-2xs">
            <div className="flex items-center justify-between text-xs text-[#64748B]">
              <span>Unique Activities</span>
              <Layers className="h-3.5 w-3.5 text-[#6366F1]" />
            </div>
            <div className="mt-1.5 text-lg font-bold tabular-nums text-[#1E293B]">
              {summary.distinct_activities}
            </div>
            <div className="mt-0.5 text-[11px] text-[#64748B]">
              Dim 10 codes
            </div>
          </div>

          <div className="rounded-lg border border-[#E2E8F0] bg-white p-3 shadow-2xs">
            <div className="flex items-center justify-between text-xs text-[#64748B]">
              <span>Unique Accounts</span>
              <Building2 className="h-3.5 w-3.5 text-[#0D9488]" />
            </div>
            <div className="mt-1.5 text-lg font-bold tabular-nums text-[#1E293B]">
              {summary.distinct_accounts}
            </div>
            <div className="mt-0.5 text-[11px] text-[#64748B]">
              GL Account codes
            </div>
          </div>

          <div className="rounded-lg border border-[#E2E8F0] bg-white p-3 shadow-2xs">
            <div className="flex items-center justify-between text-xs text-[#64748B]">
              <span>Posting Rate</span>
              <BarChart3 className="h-3.5 w-3.5 text-[#8B5CF6]" />
            </div>
            <div className="mt-1.5 text-lg font-bold tabular-nums text-[#1E293B]">
              {summary.total_lines > 0
                ? `${Math.round((summary.posted_lines / summary.total_lines) * 100)}%`
                : "0%"}
            </div>
            <div className="mt-0.5 text-[11px] text-[#64748B]">
              Journal posted
            </div>
          </div>
        </div>
      </div>

      {/* ── Main Workspace ── */}
      <div className="flex-1 p-6 space-y-4 print:p-0 print:space-y-2">
        {/* ── Filter Toolbar ── */}
        <div className="rounded-lg border border-[#E2E8F0] bg-white p-4 shadow-2xs print:hidden">
          <div className="flex flex-wrap items-center gap-3">
            {/* Search */}
            <div className="relative flex-1 min-w-[220px]">
              <Search className="absolute left-2.5 top-2.5 h-3.5 w-3.5 text-[#94A3B8]" />
              <input
                type="text"
                placeholder="Search description, activity code, account code, journal #, req #…"
                value={search}
                onChange={(e) => {
                  setSearch(e.target.value);
                  setPage(1);
                }}
                className="w-full rounded border border-[#CBD5E1] bg-white py-1.5 pl-8 pr-7 text-xs text-[#1E293B] placeholder-[#94A3B8] focus:border-[#287EAD] focus:ring-1 focus:ring-[#287EAD] focus:outline-hidden"
              />
              {search && (
                <button
                  type="button"
                  onClick={() => setSearch("")}
                  className="absolute right-2 top-2 text-[#94A3B8] hover:text-[#475569]"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              )}
            </div>

            {/* Date From */}
            <div className="flex items-center gap-1.5 text-xs text-[#64748B]">
              <span>From:</span>
              <input
                type="date"
                value={startDate}
                onChange={(e) => {
                  setStartDate(e.target.value);
                  setPage(1);
                }}
                className="rounded border border-[#CBD5E1] bg-white px-2 py-1 text-xs text-[#1E293B] focus:border-[#287EAD] focus:ring-1 focus:ring-[#287EAD] focus:outline-hidden"
              />
            </div>

            {/* Date To */}
            <div className="flex items-center gap-1.5 text-xs text-[#64748B]">
              <span>To:</span>
              <input
                type="date"
                value={endDate}
                onChange={(e) => {
                  setEndDate(e.target.value);
                  setPage(1);
                }}
                className="rounded border border-[#CBD5E1] bg-white px-2 py-1 text-xs text-[#1E293B] focus:border-[#287EAD] focus:ring-1 focus:ring-[#287EAD] focus:outline-hidden"
              />
            </div>

            {/* Account Code Select */}
            <select
              value={accountCode}
              onChange={(e) => {
                setAccountCode(e.target.value);
                setPage(1);
              }}
              className="rounded border border-[#CBD5E1] bg-white px-2.5 py-1 text-xs text-[#1E293B] focus:border-[#287EAD] focus:ring-1 focus:ring-[#287EAD] focus:outline-hidden"
            >
              <option value="">All Account Codes</option>
              {filterOptions.accounts.map((acct) => (
                <option key={acct} value={acct}>
                  Account: {acct}
                </option>
              ))}
            </select>

            {/* Activity Code Select */}
            <select
              value={activityCode}
              onChange={(e) => {
                setActivityCode(e.target.value);
                setPage(1);
              }}
              className="rounded border border-[#CBD5E1] bg-white px-2.5 py-1 text-xs text-[#1E293B] focus:border-[#287EAD] focus:ring-1 focus:ring-[#287EAD] focus:outline-hidden"
            >
              <option value="">All Activity Codes</option>
              {filterOptions.activities.map((act) => (
                <option key={act} value={act}>
                  Activity: {act}
                </option>
              ))}
            </select>

            {/* Department Select */}
            {filterOptions.departments.length > 0 && (
              <select
                value={department}
                onChange={(e) => {
                  setDepartment(e.target.value);
                  setPage(1);
                }}
                className="rounded border border-[#CBD5E1] bg-white px-2.5 py-1 text-xs text-[#1E293B] focus:border-[#287EAD] focus:ring-1 focus:ring-[#287EAD] focus:outline-hidden"
              >
                <option value="">All Departments</option>
                {filterOptions.departments.map((dept) => (
                  <option key={dept} value={dept}>
                    {dept}
                  </option>
                ))}
              </select>
            )}

            {/* Status Select */}
            <select
              value={status}
              onChange={(e) => {
                setStatus(e.target.value);
                setPage(1);
              }}
              className="rounded border border-[#CBD5E1] bg-white px-2.5 py-1 text-xs text-[#1E293B] focus:border-[#287EAD] focus:ring-1 focus:ring-[#287EAD] focus:outline-hidden"
            >
              <option value="">All Statuses</option>
              {filterOptions.statuses.map((st) => (
                <option key={st} value={st}>
                  {st.charAt(0).toUpperCase() + st.slice(1).replace(/_/g, " ")}
                </option>
              ))}
            </select>

            {/* Journal Posted Toggle */}
            <label className="flex items-center gap-1.5 text-xs text-[#475569] cursor-pointer select-none">
              <input
                type="checkbox"
                checked={hasJournal}
                onChange={(e) => {
                  setHasJournal(e.target.checked);
                  setPage(1);
                }}
                className="h-3.5 w-3.5 rounded border-[#CBD5E1] text-[#287EAD] focus:ring-[#287EAD]"
              />
              <span>With Journal # only</span>
            </label>

            {/* Reset */}
            {hasActiveFilters && (
              <button
                type="button"
                onClick={handleResetFilters}
                className="inline-flex items-center gap-1 rounded bg-[#F1F5F9] px-2.5 py-1 text-xs font-medium text-[#475569] hover:bg-[#E2E8F0] transition-colors"
              >
                <X className="h-3 w-3" />
                Clear filters
              </button>
            )}
          </div>
        </div>

        {/* ── View Navigation Tabs ── */}
        <div className="flex items-center justify-between border-b border-[#E2E8F0] bg-white px-4 pt-1 rounded-t-lg print:hidden">
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => setActiveTab("lines")}
              className={cn(
                "inline-flex items-center gap-2 border-b-2 px-3 py-2.5 text-xs font-semibold transition-colors",
                activeTab === "lines"
                  ? "border-[#287EAD] text-[#287EAD]"
                  : "border-transparent text-[#64748B] hover:text-[#1E293B]"
              )}
            >
              <ClipboardList className="h-3.5 w-3.5" />
              Detailed Lines ({summary.total_lines})
            </button>
            <button
              type="button"
              onClick={() => setActiveTab("activities")}
              className={cn(
                "inline-flex items-center gap-2 border-b-2 px-3 py-2.5 text-xs font-semibold transition-colors",
                activeTab === "activities"
                  ? "border-[#287EAD] text-[#287EAD]"
                  : "border-transparent text-[#64748B] hover:text-[#1E293B]"
              )}
            >
              <Layers className="h-3.5 w-3.5" />
              Summary by Activity ({summary.distinct_activities})
            </button>
            <button
              type="button"
              onClick={() => setActiveTab("accounts")}
              className={cn(
                "inline-flex items-center gap-2 border-b-2 px-3 py-2.5 text-xs font-semibold transition-colors",
                activeTab === "accounts"
                  ? "border-[#287EAD] text-[#287EAD]"
                  : "border-transparent text-[#64748B] hover:text-[#1E293B]"
              )}
            >
              <Building2 className="h-3.5 w-3.5" />
              Summary by Account ({summary.distinct_accounts})
            </button>
            <button
              type="button"
              onClick={() => setActiveTab("visuals")}
              className={cn(
                "inline-flex items-center gap-2 border-b-2 px-3 py-2.5 text-xs font-semibold transition-colors",
                activeTab === "visuals"
                  ? "border-[#287EAD] text-[#287EAD]"
                  : "border-transparent text-[#64748B] hover:text-[#1E293B]"
              )}
            >
              <BarChart3 className="h-3.5 w-3.5" />
              Visual Breakdown
            </button>
          </div>

          <div className="text-xs text-[#94A3B8]">
            {isFetching ? (
              <span className="flex items-center gap-1 text-[#287EAD]">
                <Loader2 className="h-3 w-3 animate-spin" /> Updating…
              </span>
            ) : (
              <span>{summary.total_lines} lines matched</span>
            )}
          </div>
        </div>

        {/* ── Tab Content ── */}
        {isLoading ? (
          <div className="flex min-h-[300px] flex-col items-center justify-center rounded-b-lg border border-[#E2E8F0] bg-white p-12 text-center shadow-2xs">
            <Loader2 className="h-8 w-8 animate-spin text-[#287EAD]" />
            <p className="mt-3 text-sm font-medium text-[#475569]">Generating financial requisition report…</p>
          </div>
        ) : lines.length === 0 ? (
          <div className="flex min-h-[340px] flex-col items-center justify-center rounded-b-lg border border-dashed border-[#CBD5E1] bg-white p-12 text-center shadow-2xs">
            <span className="flex h-12 w-12 items-center justify-center rounded-full bg-[#F1F5F9] text-[#94A3B8]">
              <FileSpreadsheet className="h-6 w-6" />
            </span>
            <h3 className="mt-3 text-sm font-bold text-[#1E293B]">
              {hasActiveFilters ? "No matching requisition lines found" : "No requisition records in database"}
            </h3>
            <p className="mt-1 max-w-md text-xs text-[#64748B]">
              {hasActiveFilters
                ? "Try adjusting or clearing your search filters to view more requisition lines."
                : "Raise a new requisition form in the portal to generate financial reporting lines with Activity codes, Account codes, Descriptions, Amounts, and Journal numbers."}
            </p>
            <div className="mt-4 flex gap-2">
              {hasActiveFilters ? (
                <button
                  type="button"
                  onClick={handleResetFilters}
                  className="inline-flex items-center gap-1.5 rounded bg-[#287EAD] px-3.5 py-1.5 text-xs font-semibold text-white shadow-xs hover:bg-[#1E6F99]"
                >
                  <X className="h-3.5 w-3.5" /> Clear Filters
                </button>
              ) : (
                <Link
                  to="/new"
                  className="inline-flex items-center gap-1.5 rounded bg-[#287EAD] px-4 py-2 text-xs font-semibold text-white shadow-xs hover:bg-[#1E6F99]"
                >
                  <PlusCircle className="h-4 w-4" /> Create New Requisition
                </Link>
              )}
            </div>
          </div>
        ) : (
          <>
            {/* ── TAB 1: Detailed Lines ── */}
            {activeTab === "lines" && (
              <div className="rounded-b-lg border border-[#E2E8F0] bg-white shadow-2xs overflow-hidden">
                <div className="overflow-x-auto">
                  <table className="w-full border-collapse text-left text-xs">
                    <thead>
                      <tr className="border-b border-[#E2E8F0] bg-[#F8FAFC] text-[11px] font-semibold text-[#475569] uppercase tracking-wider">
                        <th
                          className="px-3.5 py-2.5 cursor-pointer hover:bg-[#F1F5F9]"
                          onClick={() => handleSort("document_reference")}
                        >
                          <span className="flex items-center gap-1">
                            Req # <ArrowUpDown className="h-3 w-3 text-[#94A3B8]" />
                          </span>
                        </th>
                        <th
                          className="px-3.5 py-2.5 cursor-pointer hover:bg-[#F1F5F9]"
                          onClick={() => handleSort("date")}
                        >
                          <span className="flex items-center gap-1">
                            Date <ArrowUpDown className="h-3 w-3 text-[#94A3B8]" />
                          </span>
                        </th>
                        <th className="px-3.5 py-2.5">Dept / Requester</th>
                        <th
                          className="px-3.5 py-2.5 cursor-pointer hover:bg-[#F1F5F9]"
                          onClick={() => handleSort("activity_code")}
                        >
                          <span className="flex items-center gap-1 text-[#287EAD]">
                            Activity Code <ArrowUpDown className="h-3 w-3 text-[#94A3B8]" />
                          </span>
                        </th>
                        <th
                          className="px-3.5 py-2.5 cursor-pointer hover:bg-[#F1F5F9]"
                          onClick={() => handleSort("description")}
                        >
                          <span className="flex items-center gap-1">
                            Description <ArrowUpDown className="h-3 w-3 text-[#94A3B8]" />
                          </span>
                        </th>
                        <th
                          className="px-3.5 py-2.5 cursor-pointer hover:bg-[#F1F5F9]"
                          onClick={() => handleSort("account_code")}
                        >
                          <span className="flex items-center gap-1 text-[#0D9488]">
                            Account Code <ArrowUpDown className="h-3 w-3 text-[#94A3B8]" />
                          </span>
                        </th>
                        <th className="px-3.5 py-2.5">Cost Centre</th>
                        <th
                          className="px-3.5 py-2.5 text-right cursor-pointer hover:bg-[#F1F5F9]"
                          onClick={() => handleSort("amount")}
                        >
                          <span className="flex items-center justify-end gap-1">
                            Amount <ArrowUpDown className="h-3 w-3 text-[#94A3B8]" />
                          </span>
                        </th>
                        <th
                          className="px-3.5 py-2.5 cursor-pointer hover:bg-[#F1F5F9]"
                          onClick={() => handleSort("journal_number")}
                        >
                          <span className="flex items-center gap-1 text-[#6366F1]">
                            Journal # <ArrowUpDown className="h-3 w-3 text-[#94A3B8]" />
                          </span>
                        </th>
                        <th className="px-3.5 py-2.5 text-center">Status</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-[#F1F5F9] text-[#1E293B]">
                      {paginatedLines.map((line) => (
                        <tr key={line.id} className="hover:bg-[#F8FAFC] transition-colors">
                          {/* Requisition # */}
                          <td className="px-3.5 py-2.5 font-medium whitespace-nowrap">
                            <Link
                              to={`/${line.document_id}`}
                              className="font-semibold text-[#287EAD] hover:underline inline-flex items-center gap-1"
                            >
                              {line.document_reference}
                              <ExternalLink className="h-2.5 w-2.5 text-[#94A3B8]" />
                            </Link>
                          </td>

                          {/* Date */}
                          <td className="px-3.5 py-2.5 text-[#64748B] whitespace-nowrap">
                            {line.date || "—"}
                          </td>

                          {/* Dept / Requester */}
                          <td className="px-3.5 py-2.5 max-w-[160px] truncate" title={`${line.department} • ${line.requester}`}>
                            <div className="font-medium text-[#1E293B] truncate">{line.department}</div>
                            <div className="text-[11px] text-[#64748B] truncate">{line.requester}</div>
                          </td>

                          {/* Activity Code */}
                          <td className="px-3.5 py-2.5 whitespace-nowrap">
                            {line.activity_code && line.activity_code !== "—" ? (
                              <div title={line.activity_description}>
                                <span className="inline-block rounded bg-[#EFF6FF] px-2 py-0.5 font-mono text-[11px] font-bold text-[#1D4ED8] border border-[#BFDBFE]">
                                  {line.activity_code}
                                </span>
                                {line.activity_description && line.activity_description !== "—" && (
                                  <div className="text-[10px] text-[#64748B] truncate max-w-[150px]">
                                    {line.activity_description}
                                  </div>
                                )}
                              </div>
                            ) : (
                              <span className="text-[#94A3B8]">—</span>
                            )}
                          </td>

                          {/* Description */}
                          <td className="px-3.5 py-2.5 max-w-[240px]">
                            <div className="font-medium text-[#1E293B] line-clamp-2" title={line.description}>
                              {line.description}
                            </div>
                            {line.table_name && (
                              <span className="text-[10px] text-[#94A3B8]">
                                {line.table_name}
                              </span>
                            )}
                          </td>

                          {/* Account Code */}
                          <td className="px-3.5 py-2.5 whitespace-nowrap">
                            {line.account_code && line.account_code !== "—" ? (
                              <span className="inline-block rounded bg-[#F0FDF4] px-2 py-0.5 font-mono text-[11px] font-bold text-[#15803D] border border-[#BBF7D0]">
                                {line.account_code}
                              </span>
                            ) : (
                              <span className="text-[#94A3B8]">—</span>
                            )}
                          </td>

                          {/* Cost Centre */}
                          <td className="px-3.5 py-2.5 text-[#64748B] whitespace-nowrap">
                            {line.cost_centre || "—"}
                          </td>

                          {/* Amount */}
                          <td className="px-3.5 py-2.5 text-right font-bold tabular-nums text-[#0F172A] whitespace-nowrap">
                            {formatCurrency(line.amount, line.currency)}
                          </td>

                          {/* Journal Number */}
                          <td className="px-3.5 py-2.5 whitespace-nowrap">
                            {journalBadge(line.journal_number, line.journal_status)}
                          </td>

                          {/* Status */}
                          <td className="px-3.5 py-2.5 text-center whitespace-nowrap">
                            {statusBadge(line.document_status)}
                          </td>
                        </tr>
                      ))}
                    </tbody>

                    {/* Table Grand Total Footer */}
                    <tfoot>
                      <tr className="border-t-2 border-[#CBD5E1] bg-[#F8FAFC] font-semibold text-[#1E293B]">
                        <td colSpan={7} className="px-3.5 py-2.5 text-right text-xs uppercase tracking-wide">
                          Total of Filtered Lines ({summary.total_lines}):
                        </td>
                        <td className="px-3.5 py-2.5 text-right font-bold text-sm text-[#0F172A] tabular-nums">
                          {formatCurrency(summary.total_amount)}
                        </td>
                        <td colSpan={2} className="px-3.5 py-2.5 text-xs text-emerald-700 font-medium">
                          Posted: {formatCurrency(summary.posted_amount)}
                        </td>
                      </tr>
                    </tfoot>
                  </table>
                </div>

                {/* ── Pagination ── */}
                <div className="flex flex-col gap-3 border-t border-[#E2E8F0] bg-white px-4 py-3 sm:flex-row sm:items-center sm:justify-between print:hidden">
                  <div className="flex items-center gap-2 text-xs text-[#64748B]">
                    <span>Show</span>
                    <select
                      value={pageSize}
                      onChange={(e) => {
                        setPageSize(Number(e.target.value));
                        setPage(1);
                      }}
                      className="rounded border border-[#CBD5E1] bg-white px-2 py-0.5 text-xs text-[#1E293B] focus:border-[#287EAD]"
                    >
                      <option value={10}>10</option>
                      <option value={20}>20</option>
                      <option value={50}>50</option>
                      <option value={100}>100</option>
                    </select>
                    <span>per page • Showing {Math.min((page - 1) * pageSize + 1, sortedLines.length)} to {Math.min(page * pageSize, sortedLines.length)} of {sortedLines.length}</span>
                  </div>

                  <div className="flex items-center gap-1.5">
                    <button
                      type="button"
                      disabled={page <= 1}
                      onClick={() => setPage((p) => Math.max(p - 1, 1))}
                      className="inline-flex h-7 w-7 items-center justify-center rounded border border-[#CBD5E1] bg-white text-[#475569] disabled:opacity-40 hover:bg-[#F1F5F9]"
                    >
                      <ChevronLeft className="h-4 w-4" />
                    </button>
                    <span className="px-2 text-xs font-medium text-[#475569]">
                      Page {page} of {totalPages}
                    </span>
                    <button
                      type="button"
                      disabled={page >= totalPages}
                      onClick={() => setPage((p) => Math.min(p + 1, totalPages))}
                      className="inline-flex h-7 w-7 items-center justify-center rounded border border-[#CBD5E1] bg-white text-[#475569] disabled:opacity-40 hover:bg-[#F1F5F9]"
                    >
                      <ChevronRight className="h-4 w-4" />
                    </button>
                  </div>
                </div>
              </div>
            )}

            {/* ── TAB 2: Group by Activity Code ── */}
            {activeTab === "activities" && (
              <div className="rounded-b-lg border border-[#E2E8F0] bg-white shadow-2xs overflow-hidden">
                <div className="overflow-x-auto">
                  <table className="w-full border-collapse text-left text-xs">
                    <thead>
                      <tr className="border-b border-[#E2E8F0] bg-[#F8FAFC] text-[11px] font-semibold text-[#475569] uppercase tracking-wider">
                        <th className="px-4 py-3">Activity Code</th>
                        <th className="px-4 py-3">Activity Description</th>
                        <th className="px-4 py-3 text-center">Line Count</th>
                        <th className="px-4 py-3 text-right">Total Amount</th>
                        <th className="px-4 py-3 text-right">Posted Amount</th>
                        <th className="px-4 py-3 text-right">% of Total</th>
                        <th className="px-4 py-3 w-40">Share</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-[#F1F5F9]">
                      {(data?.by_activity || []).map((item) => {
                        const pct = summary.total_amount > 0 ? (item.total_amount / summary.total_amount) * 100 : 0;
                        return (
                          <tr key={item.activity_code} className="hover:bg-[#F8FAFC] transition-colors">
                            <td className="px-4 py-3 font-mono font-bold text-[#1D4ED8] whitespace-nowrap">
                              <span className="rounded bg-[#EFF6FF] px-2 py-0.5 border border-[#BFDBFE]">
                                {item.activity_code || "—"}
                              </span>
                            </td>
                            <td className="px-4 py-3 text-[#334155] max-w-[280px]">
                              {item.activity_description || "—"}
                            </td>
                            <td className="px-4 py-3 text-center font-medium text-[#475569] tabular-nums">
                              {item.line_count}
                            </td>
                            <td className="px-4 py-3 text-right font-bold tabular-nums text-[#0F172A]">
                              {formatCurrency(item.total_amount, item.currency)}
                            </td>
                            <td className="px-4 py-3 text-right font-medium text-emerald-700 tabular-nums">
                              {formatCurrency(item.posted_amount, item.currency)}
                            </td>
                            <td className="px-4 py-3 text-right font-medium tabular-nums text-[#475569]">
                              {pct.toFixed(1)}%
                            </td>
                            <td className="px-4 py-3">
                              <div className="h-2 w-full rounded-full bg-[#E2E8F0] overflow-hidden">
                                <div
                                  className="h-full rounded-full bg-[#287EAD]"
                                  style={{ width: `${Math.min(pct, 100)}%` }}
                                />
                              </div>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                    <tfoot>
                      <tr className="border-t-2 border-[#CBD5E1] bg-[#F8FAFC] font-semibold text-[#1E293B]">
                        <td colSpan={2} className="px-4 py-3 text-right text-xs uppercase tracking-wide">
                          Total ({summary.distinct_activities} Activities):
                        </td>
                        <td className="px-4 py-3 text-center text-xs tabular-nums">
                          {summary.total_lines}
                        </td>
                        <td className="px-4 py-3 text-right text-sm font-bold tabular-nums">
                          {formatCurrency(summary.total_amount)}
                        </td>
                        <td className="px-4 py-3 text-right text-xs font-semibold text-emerald-700 tabular-nums">
                          {formatCurrency(summary.posted_amount)}
                        </td>
                        <td colSpan={2} className="px-4 py-3 text-right text-xs text-[#64748B]">
                          100.0%
                        </td>
                      </tr>
                    </tfoot>
                  </table>
                </div>
              </div>
            )}

            {/* ── TAB 3: Group by Account Code ── */}
            {activeTab === "accounts" && (
              <div className="rounded-b-lg border border-[#E2E8F0] bg-white shadow-2xs overflow-hidden">
                <div className="overflow-x-auto">
                  <table className="w-full border-collapse text-left text-xs">
                    <thead>
                      <tr className="border-b border-[#E2E8F0] bg-[#F8FAFC] text-[11px] font-semibold text-[#475569] uppercase tracking-wider">
                        <th className="px-4 py-3">Account Code</th>
                        <th className="px-4 py-3 text-center">Line Count</th>
                        <th className="px-4 py-3 text-right">Total Amount</th>
                        <th className="px-4 py-3 text-right">Posted to SunSystems</th>
                        <th className="px-4 py-3 text-right">% of Total</th>
                        <th className="px-4 py-3 w-40">Share</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-[#F1F5F9]">
                      {(data?.by_account || []).map((item) => {
                        const pct = summary.total_amount > 0 ? (item.total_amount / summary.total_amount) * 100 : 0;
                        return (
                          <tr key={item.account_code} className="hover:bg-[#F8FAFC] transition-colors">
                            <td className="px-4 py-3 font-mono font-bold text-[#15803D] whitespace-nowrap">
                              <span className="rounded bg-[#F0FDF4] px-2 py-0.5 border border-[#BBF7D0]">
                                {item.account_code || "—"}
                              </span>
                            </td>
                            <td className="px-4 py-3 text-center font-medium text-[#475569] tabular-nums">
                              {item.line_count}
                            </td>
                            <td className="px-4 py-3 text-right font-bold tabular-nums text-[#0F172A]">
                              {formatCurrency(item.total_amount, item.currency)}
                            </td>
                            <td className="px-4 py-3 text-right font-medium text-emerald-700 tabular-nums">
                              {formatCurrency(item.posted_amount, item.currency)}
                            </td>
                            <td className="px-4 py-3 text-right font-medium tabular-nums text-[#475569]">
                              {pct.toFixed(1)}%
                            </td>
                            <td className="px-4 py-3">
                              <div className="h-2 w-full rounded-full bg-[#E2E8F0] overflow-hidden">
                                <div
                                  className="h-full rounded-full bg-[#0D9488]"
                                  style={{ width: `${Math.min(pct, 100)}%` }}
                                />
                              </div>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                    <tfoot>
                      <tr className="border-t-2 border-[#CBD5E1] bg-[#F8FAFC] font-semibold text-[#1E293B]">
                        <td className="px-4 py-3 text-right text-xs uppercase tracking-wide">
                          Total ({summary.distinct_accounts} Accounts):
                        </td>
                        <td className="px-4 py-3 text-center text-xs tabular-nums">
                          {summary.total_lines}
                        </td>
                        <td className="px-4 py-3 text-right text-sm font-bold tabular-nums">
                          {formatCurrency(summary.total_amount)}
                        </td>
                        <td className="px-4 py-3 text-right text-xs font-semibold text-emerald-700 tabular-nums">
                          {formatCurrency(summary.posted_amount)}
                        </td>
                        <td colSpan={2} className="px-4 py-3 text-right text-xs text-[#64748B]">
                          100.0%
                        </td>
                      </tr>
                    </tfoot>
                  </table>
                </div>
              </div>
            )}

            {/* ── TAB 4: Visual Breakdown ── */}
            {activeTab === "visuals" && (
              <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
                {/* Spend by Activity Code Chart */}
                <div className="rounded-lg border border-[#E2E8F0] bg-white p-5 shadow-2xs">
                  <div className="flex items-center justify-between border-b border-[#F1F5F9] pb-3">
                    <div>
                      <h3 className="text-sm font-bold text-[#1E293B]">Top Activities by Spend</h3>
                      <p className="text-[11px] text-[#64748B]">Total requisition expenditure by Activity Code (Dim 10)</p>
                    </div>
                    <Layers className="h-4 w-4 text-[#287EAD]" />
                  </div>
                  <div className="mt-4 h-[280px] w-full">
                    {activityChartData.length > 0 ? (
                      <ResponsiveContainer width="100%" height="100%">
                        <BarChart data={activityChartData} margin={{ top: 10, right: 10, left: 10, bottom: 30 }}>
                          <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#E2E8F0" />
                          <XAxis
                            dataKey="name"
                            angle={-30}
                            textAnchor="end"
                            interval={0}
                            tick={{ fontSize: 10, fill: "#64748B" }}
                          />
                          <YAxis
                            tick={{ fontSize: 10, fill: "#64748B" }}
                            tickFormatter={(val) => `$${val >= 1000 ? `${(val / 1000).toFixed(0)}k` : val}`}
                          />
                          <RechartsTooltip
                            formatter={(value: any) => [formatCurrency(Number(value)), "Spend"]}
                            labelFormatter={(lbl) => `Activity Code: ${lbl}`}
                          />
                          <Bar dataKey="amount" radius={[4, 4, 0, 0]}>
                            {activityChartData.map((_, index) => (
                              <Cell key={`cell-${index}`} fill={CHART_COLORS[index % CHART_COLORS.length]} />
                            ))}
                          </Bar>
                        </BarChart>
                      </ResponsiveContainer>
                    ) : (
                      <div className="flex h-full items-center justify-center text-xs text-[#94A3B8]">
                        No activity data available
                      </div>
                    )}
                  </div>
                </div>

                {/* Spend by Account Code Chart */}
                <div className="rounded-lg border border-[#E2E8F0] bg-white p-5 shadow-2xs">
                  <div className="flex items-center justify-between border-b border-[#F1F5F9] pb-3">
                    <div>
                      <h3 className="text-sm font-bold text-[#1E293B]">Spend by Account Code</h3>
                      <p className="text-[11px] text-[#64748B]">General Ledger account distribution</p>
                    </div>
                    <Building2 className="h-4 w-4 text-[#0D9488]" />
                  </div>
                  <div className="mt-4 h-[280px] w-full">
                    {accountChartData.length > 0 ? (
                      <ResponsiveContainer width="100%" height="100%">
                        <BarChart data={accountChartData} margin={{ top: 10, right: 10, left: 10, bottom: 30 }}>
                          <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#E2E8F0" />
                          <XAxis
                            dataKey="name"
                            angle={-30}
                            textAnchor="end"
                            interval={0}
                            tick={{ fontSize: 10, fill: "#64748B" }}
                          />
                          <YAxis
                            tick={{ fontSize: 10, fill: "#64748B" }}
                            tickFormatter={(val) => `$${val >= 1000 ? `${(val / 1000).toFixed(0)}k` : val}`}
                          />
                          <RechartsTooltip
                            formatter={(value: any) => [formatCurrency(Number(value)), "Spend"]}
                            labelFormatter={(lbl) => `Account: ${lbl}`}
                          />
                          <Bar dataKey="amount" fill="#0D9488" radius={[4, 4, 0, 0]}>
                            {accountChartData.map((_, index) => (
                              <Cell key={`acct-cell-${index}`} fill={CHART_COLORS[(index + 3) % CHART_COLORS.length]} />
                            ))}
                          </Bar>
                        </BarChart>
                      </ResponsiveContainer>
                    ) : (
                      <div className="flex h-full items-center justify-center text-xs text-[#94A3B8]">
                        No account data available
                      </div>
                    )}
                  </div>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

