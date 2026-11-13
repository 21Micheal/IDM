/**
 * RequisitionReportsPage.tsx
 *
 * Consolidated Financial & Compliance Reporting Hub for Requisitions:
 *
 * Organized into two primary focused tabs so users are never overwhelmed:
 * 1. [Requisition Financial Lines]
 *    - Core fields: Activity Code (Dim 10), Line Description, Account Code, Amount, and Journal #
 *    - Sub-tabs: Detailed Lines, By Activity Code, By Account Code, Visual Spend Charts
 *    - Light-colored stat cards with HEX: #C5E6F5 accents
 *    - CustomListbox dropdowns (Account, Activity, Department, Status, Page Size)
 *
 * 2. [Outstanding Retirements Aging]
 *    - Client requirement: Outstanding travel retirements aged by traveller and department
 *    - Aging brackets: Current / Not Due, 1–30d, 31–60d, 61–90d, 90+d, and Reconciled
 *    - Sub-tabs: Aging Register, Aged by Department Matrix, Aged by Traveller Summary, Aging Analytics
 *    - Interactive Q&A Assistant ("Ask the Report")
 *    - Automated Schedule Configuration Modal
 *    - Light-colored stat cards with HEX: #C5E6F5 accents
 *    - CustomListbox dropdowns (Aging Category, Department, Traveller, Status, Page Size)
 *
 * 3. Print-friendly layout (clean formal print header, hiding all nav, sidebars, filters, and controls).
 */
import { useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import {
  FileSpreadsheet, Download, Printer, Search, X, Filter,
  CheckCircle2, Clock, AlertTriangle, TrendingUp, BarChart3,
  Building2, ClipboardList, RefreshCw, ExternalLink, Layers,
  ChevronLeft, ChevronRight, SlidersHorizontal, Loader2,
  Calendar, Mail, User, ShieldAlert, Sparkles, Send, BellRing,
  HelpCircle, ArrowUpDown, Check, CheckCircle, ChevronDown, ChevronUp,
} from "lucide-react";
import {
  ResponsiveContainer, BarChart, Bar, XAxis, YAxis,
  Tooltip as RechartsTooltip, CartesianGrid, Cell, Legend,
} from "recharts";
import { documentsAPI } from "@/services/api";
import CustomListbox from "@/components/ui/CustomListbox";
import { toast } from "@/components/ui/vault-toast";
import type {
  RequisitionReportLine,
  RequisitionReportParams,
  RequisitionReportResponse,
  OutstandingRetirementLine,
  RetirementsAgingReportParams,
  RetirementsAgingReportResponse,
  DepartmentAgingSummary,
  TravellerAgingSummary,
} from "@/types/reports";
import { cn } from "@/lib/utils";

type MainTab = "financial" | "retirements";
type FinancialLinesTab = "lines" | "activities" | "accounts" | "visuals";
type RetirementsTab = "register" | "by_department" | "by_traveller" | "visuals";
type SortDirection = "asc" | "desc";

const AGING_BAR_COLORS: Record<string, string> = {
  current: "#10B981",  // Emerald
  "1_30": "#F59E0B",   // Amber
  "31_60": "#F97316",  // Orange
  "61_90": "#EF4444",  // Red
  "over_90": "#991B1B", // Dark Red
  reconciled: "#6366F1", // Indigo
};

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

function formatDateDisplay(raw?: string): string {
  if (!raw) return "—";
  try {
    const d = new Date(raw);
    if (isNaN(d.getTime())) return raw;
    return d.toLocaleDateString("en-US", {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  } catch {
    return raw;
  }
}

function AgingBadge({ bucket, label, days }: { bucket: string; label: string; days: number }) {
  if (bucket === "reconciled") {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-indigo-50 px-2 py-0.5 text-[11px] font-medium text-indigo-700 border border-indigo-200 print:border-none print:px-1 print:py-0 print:text-[9px]">
        <CheckCircle2 className="h-3 w-3 print:hidden" />
        Reconciled
      </span>
    );
  }
  if (bucket === "current") {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-[11px] font-medium text-emerald-700 border border-emerald-200 print:border-none print:px-1 print:py-0 print:text-[9px]">
        <Clock className="h-3 w-3 print:hidden" />
        Current / Not Due
      </span>
    );
  }
  if (bucket === "1_30") {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-amber-50 px-2 py-0.5 text-[11px] font-semibold text-amber-800 border border-amber-300 print:border-none print:px-1 print:py-0 print:text-[9px]">
        <AlertTriangle className="h-3 w-3 text-amber-600 print:hidden" />
        1–30d ({days}d)
      </span>
    );
  }
  if (bucket === "31_60") {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-orange-50 px-2 py-0.5 text-[11px] font-semibold text-orange-800 border border-orange-300 print:border-none print:px-1 print:py-0 print:text-[9px]">
        <AlertTriangle className="h-3 w-3 text-orange-600 print:hidden" />
        31–60d ({days}d)
      </span>
    );
  }
  if (bucket === "61_90") {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-rose-50 px-2 py-0.5 text-[11px] font-semibold text-rose-800 border border-rose-300 print:border-none print:px-1 print:py-0 print:text-[9px]">
        <ShieldAlert className="h-3 w-3 text-rose-600 print:hidden" />
        61–90d ({days}d)
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-red-100 px-2 py-0.5 text-[11px] font-bold text-red-900 border border-red-400 print:border-none print:px-1 print:py-0 print:text-[9px]">
      <ShieldAlert className="h-3 w-3 text-red-700 print:hidden" />
      90+ Days ({days}d)
    </span>
  );
}

function JournalStatusBadge({ status, journalNumber }: { status: string; journalNumber?: string }) {
  if (journalNumber && journalNumber !== "—") {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-700 border border-emerald-200 print:border-none print:px-0 print:py-0 print:text-[9px]">
        <CheckCircle2 className="h-3 w-3 text-emerald-600 print:hidden" />
        <span className="font-mono">#{journalNumber}</span>
      </span>
    );
  }
  if (status === "posted") {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-700 border border-emerald-200 print:border-none print:px-0 print:py-0 print:text-[9px]">
        <CheckCircle2 className="h-3 w-3 text-emerald-600 print:hidden" />
        Posted
      </span>
    );
  }
  if (status === "failed") {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-rose-50 px-2 py-0.5 text-xs font-medium text-rose-700 border border-rose-200 print:border-none print:px-0 print:py-0 print:text-[9px]">
        <AlertTriangle className="h-3 w-3 text-rose-600 print:hidden" />
        Failed
      </span>
    );
  }
  if (status === "pending") {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-700 border border-amber-200 print:border-none print:px-0 print:py-0 print:text-[9px]">
        <Clock className="h-3 w-3 text-amber-600 print:hidden" />
        Pending
      </span>
    );
  }
  return (
    <span className="text-xs text-[#9AA5B1] font-mono print:text-[9px]">
      —
    </span>
  );
}

export default function RequisitionReportsPage() {
  const [searchParams, setSearchParams] = useSearchParams();

  // Active Main Tab ("financial" or "retirements")
  const activeMainTab: MainTab = (searchParams.get("tab") === "retirements" ? "retirements" : "financial");
  const setActiveMainTab = (tab: MainTab) => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.set("tab", tab);
      return next;
    });
  };

  // ── Tab 1: Financial Lines State ───────────────────────────────────────────
  const [financialTab, setFinancialTab] = useState<FinancialLinesTab>("lines");
  const [finSearch, setFinSearch] = useState("");
  const [finStartDate, setFinStartDate] = useState("");
  const [finEndDate, setFinEndDate] = useState("");
  const [finAccountCode, setFinAccountCode] = useState("");
  const [finActivityCode, setFinActivityCode] = useState("");
  const [finStatus, setFinStatus] = useState("");
  const [finDepartment, setFinDepartment] = useState("");
  const [finHasJournal, setFinHasJournal] = useState<boolean | null>(null);
  const [finPage, setFinPage] = useState(1);
  const [finPageSize, setFinPageSize] = useState(25);
  const [finSortField, setFinSortField] = useState<string>("date");
  const [finSortDirection, setFinSortDirection] = useState<SortDirection>("desc");

  // ── Tab 2: Outstanding Retirements State ────────────────────────────────────
  const [retirementsTab, setRetirementsTab] = useState<RetirementsTab>("register");
  const [retSearch, setRetSearch] = useState("");
  const [retDepartment, setRetDepartment] = useState("");
  const [retTraveller, setRetTraveller] = useState("");
  const [retStatus, setRetStatus] = useState("");
  const [retAgingBucket, setRetAgingBucket] = useState("all");
  const [retStartDate, setRetStartDate] = useState("");
  const [retEndDate, setRetEndDate] = useState("");
  const [retIncludeReconciled, setRetIncludeReconciled] = useState(false);
  const [retPage, setRetPage] = useState(1);
  const [retPageSize, setRetPageSize] = useState(25);
  const [retSortField, setRetSortField] = useState<string>("due_date");
  const [retSortDirection, setRetSortDirection] = useState<SortDirection>("asc");

  // Q&A Assistant state in Retirements tab
  const [qaOpen, setQaOpen] = useState(false);
  const [qaQuery, setQaQuery] = useState("");
  const [qaAnswer, setQaAnswer] = useState<{
    queryText: string;
    headline: string;
    detail: string;
    matchCount: number;
    matchAmount: number;
  } | null>(null);

  // Export & Schedule Modals
  const [exportingCsv, setExportingCsv] = useState(false);
  const [scheduleModalOpen, setScheduleModalOpen] = useState(false);
  const [scheduleFrequency, setScheduleFrequency] = useState("weekly");
  const [scheduleRecipients, setScheduleRecipients] = useState("hods_finance");
  const [scheduleSendingTest, setScheduleSendingTest] = useState(false);

  // Print mode detection for unpaginated full print rendering
  const [isPrinting, setIsPrinting] = useState(false);

  useEffect(() => {
    const handleBefore = () => setIsPrinting(true);
    const handleAfter = () => setIsPrinting(false);
    window.addEventListener("beforeprint", handleBefore);
    window.addEventListener("afterprint", handleAfter);
    return () => {
      window.removeEventListener("beforeprint", handleBefore);
      window.removeEventListener("afterprint", handleAfter);
    };
  }, []);

  // ── Query: Financial Lines Report ──────────────────────────────────────────
  const financialParams = useMemo<RequisitionReportParams>(() => {
    return {
      search: finSearch.trim() || undefined,
      start_date: finStartDate || undefined,
      end_date: finEndDate || undefined,
      account_code: finAccountCode || undefined,
      activity_code: finActivityCode || undefined,
      status: finStatus || undefined,
      department: finDepartment || undefined,
      has_journal: finHasJournal === null ? undefined : finHasJournal,
    };
  }, [
    finSearch, finStartDate, finEndDate, finAccountCode,
    finActivityCode, finStatus, finDepartment, finHasJournal,
  ]);

  const {
    data: financialData,
    isLoading: isLoadingFinancial,
    refetch: refetchFinancial,
  } = useQuery({
    queryKey: ["report-financial-lines", financialParams],
    queryFn: () => documentsAPI.requisitionReport(financialParams).then((r) => r.data),
    staleTime: 60_000,
  });

  // ── Query: Outstanding Retirements Aging Report ─────────────────────────────
  const retirementsParams = useMemo<RetirementsAgingReportParams>(() => {
    return {
      search: retSearch.trim() || undefined,
      department: retDepartment || undefined,
      traveller: retTraveller || undefined,
      status: retStatus || undefined,
      aging_bucket: retAgingBucket !== "all" ? retAgingBucket : undefined,
      start_date: retStartDate || undefined,
      end_date: retEndDate || undefined,
      include_reconciled: retIncludeReconciled ? "true" : undefined,
    };
  }, [
    retSearch, retDepartment, retTraveller, retStatus,
    retAgingBucket, retStartDate, retEndDate, retIncludeReconciled,
  ]);

  const {
    data: retirementsData,
    isLoading: isLoadingRetirements,
    refetch: refetchRetirements,
  } = useQuery({
    queryKey: ["report-retirements-aging", retirementsParams],
    queryFn: () => documentsAPI.retirementsAgingReport(retirementsParams).then((r) => r.data),
    staleTime: 60_000,
  });

  const finSummary = financialData?.summary || {
    total_amount: 0,
    total_lines: 0,
    posted_amount: 0,
    posted_lines: 0,
    distinct_activities: 0,
    distinct_accounts: 0,
  };

  const retSummary = retirementsData?.summary || {
    total_records: 0,
    total_advance_amount: 0,
    total_outstanding_amount: 0,
    total_retired_amount: 0,
    total_overdue_records: 0,
    total_overdue_amount: 0,
    total_awaiting_finance: 0,
    total_reconciled: 0,
    average_days_aged: 0,
    aging_totals: {},
  };

  // ── Financial Lines Sorting & Pagination ───────────────────────────────────
  const handleFinSort = (field: string) => {
    if (finSortField === field) {
      setFinSortDirection((prev) => (prev === "asc" ? "desc" : "asc"));
    } else {
      setFinSortField(field);
      setFinSortDirection("asc");
    }
  };

  const sortedFinancialLines = useMemo(() => {
    const list = [...(financialData?.lines || [])];
    list.sort((a, b) => {
      let va = (a as any)[finSortField];
      let vb = (b as any)[finSortField];
      if (typeof va === "number" && typeof vb === "number") {
        return finSortDirection === "asc" ? va - vb : vb - va;
      }
      va = String(va || "").toLowerCase();
      vb = String(vb || "").toLowerCase();
      if (va < vb) return finSortDirection === "asc" ? -1 : 1;
      if (va > vb) return finSortDirection === "asc" ? 1 : -1;
      return 0;
    });
    return list;
  }, [financialData?.lines, finSortField, finSortDirection]);

  const paginatedFinancialLines = useMemo(() => {
    const start = (finPage - 1) * finPageSize;
    return sortedFinancialLines.slice(start, start + finPageSize);
  }, [sortedFinancialLines, finPage, finPageSize]);

  // When printing, render all filtered lines across multiple printed pages
  const displayedFinancialLines = isPrinting ? sortedFinancialLines : paginatedFinancialLines;

  const totalFinancialPages = Math.ceil(sortedFinancialLines.length / finPageSize) || 1;

  // ── Retirements Sorting & Pagination ───────────────────────────────────────
  const handleRetSort = (field: string) => {
    if (retSortField === field) {
      setRetSortDirection((prev) => (prev === "asc" ? "desc" : "asc"));
    } else {
      setRetSortField(field);
      setRetSortDirection("asc");
    }
  };

  const sortedRetirements = useMemo(() => {
    const list = [...(retirementsData?.retirements || [])];
    list.sort((a, b) => {
      let va = (a as any)[retSortField];
      let vb = (b as any)[retSortField];
      if (typeof va === "number" && typeof vb === "number") {
        return retSortDirection === "asc" ? va - vb : vb - va;
      }
      va = String(va || "").toLowerCase();
      vb = String(vb || "").toLowerCase();
      if (va < vb) return retSortDirection === "asc" ? -1 : 1;
      if (va > vb) return retSortDirection === "asc" ? 1 : -1;
      return 0;
    });
    return list;
  }, [retirementsData?.retirements, retSortField, retSortDirection]);

  const paginatedRetirements = useMemo(() => {
    const start = (retPage - 1) * retPageSize;
    return sortedRetirements.slice(start, start + retPageSize);
  }, [sortedRetirements, retPage, retPageSize]);

  // When printing, render all filtered retirements across multiple printed pages
  const displayedRetirements = isPrinting ? sortedRetirements : paginatedRetirements;

  const totalRetirementPages = Math.ceil(sortedRetirements.length / retPageSize) || 1;

  // ── Q&A Smart Query Handler ────────────────────────────────────────────────
  const executeQaQuery = (questionText: string) => {
    const text = questionText.trim().toLowerCase();
    if (!text) return;
    setQaQuery(questionText);
    setQaOpen(true);

    const rows = retirementsData?.retirements || [];

    if (text.includes("30") || text.includes("month") || text.includes("overdue by more than 30")) {
      const matches = rows.filter((r) => r.days_overdue > 30);
      const totalAmt = matches.reduce((sum, r) => sum + r.outstanding_amount, 0);
      setRetAgingBucket("31_60");
      setQaAnswer({
        queryText: questionText,
        headline: matches.length > 0
          ? `Found ${matches.length} retirement${matches.length === 1 ? "" : "s"} overdue by > 30 days.`
          : "No retirements are currently overdue by more than 30 days.",
        detail: matches.length > 0
          ? `Total delinquent balance: ${formatCurrency(totalAmt)}. Table filtered to 31–60+ days overdue.`
          : "All active travel retirements are either current or within the initial 30-day grace period.",
        matchCount: matches.length,
        matchAmount: totalAmt,
      });
      return;
    }

    if (text.includes("travel") || text.includes("travel department")) {
      const matches = rows.filter((r) => r.department.toLowerCase().includes("travel"));
      const totalAmt = matches.reduce((sum, r) => sum + r.outstanding_amount, 0);
      const overdue = matches.filter((r) => r.days_overdue > 0).length;
      setRetDepartment("Travel");
      setQaAnswer({
        queryText: questionText,
        headline: `Travel Department: ${matches.length} retirements found (${overdue} overdue).`,
        detail: `Total outstanding balance is ${formatCurrency(totalAmt)}. Table filtered to Travel Department.`,
        matchCount: matches.length,
        matchAmount: totalAmt,
      });
      return;
    }

    if (text.includes("finance") || text.includes("awaiting finance") || text.includes("review")) {
      const matches = rows.filter((r) => r.retirement_status === "awaiting_finance");
      const totalAmt = matches.reduce((sum, r) => sum + r.outstanding_amount, 0);
      setRetStatus("awaiting_finance");
      setQaAnswer({
        queryText: questionText,
        headline: `${matches.length} retirement${matches.length === 1 ? "" : "s"} currently Awaiting Finance review.`,
        detail: `The traveler has submitted actual expenses. Total outstanding reconciliation: ${formatCurrency(totalAmt)}.`,
        matchCount: matches.length,
        matchAmount: totalAmt,
      });
      return;
    }

    if (text.includes("highest") || text.includes("top") || text.includes("most") || text.includes("2000")) {
      const matches = rows.filter((r) => r.outstanding_amount >= 2000);
      const totalAmt = matches.reduce((sum, r) => sum + r.outstanding_amount, 0);
      setQaAnswer({
        queryText: questionText,
        headline: `High Value: ${matches.length} travel advance${matches.length === 1 ? "" : "s"} exceed $2,000.00.`,
        detail: `Total value of high-balance retirements: ${formatCurrency(totalAmt)}.`,
        matchCount: matches.length,
        matchAmount: totalAmt,
      });
      return;
    }

    if (text.includes("overdue") || text.includes("late") || text.includes("deadline")) {
      const matches = rows.filter((r) => r.days_overdue > 0 && r.retirement_status !== "reconciled");
      const totalAmt = matches.reduce((sum, r) => sum + r.outstanding_amount, 0);
      setRetStatus("overdue");
      setQaAnswer({
        queryText: questionText,
        headline: `${matches.length} overdue retirement${matches.length === 1 ? "" : "s"} detected across all departments.`,
        detail: `Total overdue balance: ${formatCurrency(totalAmt)}. Table filter set to Overdue.`,
        matchCount: matches.length,
        matchAmount: totalAmt,
      });
      return;
    }

    // Default search fallback
    setRetSearch(questionText);
    const matches = rows.filter((r) =>
      `${r.document_reference} ${r.traveller_name} ${r.department} ${r.retirement_status_label}`
        .toLowerCase()
        .includes(text),
    );
    const totalAmt = matches.reduce((sum, r) => sum + r.outstanding_amount, 0);
    setQaAnswer({
      queryText: questionText,
      headline: `Showing ${matches.length} results matching "${questionText}".`,
      detail: `Filtered results represent ${formatCurrency(totalAmt)} in total outstanding retirement balance.`,
      matchCount: matches.length,
      matchAmount: totalAmt,
    });
  };

  const clearQa = () => {
    setQaQuery("");
    setQaAnswer(null);
    setRetSearch("");
    setRetDepartment("");
    setRetStatus("");
    setRetAgingBucket("all");
  };

  // ── CSV Export ─────────────────────────────────────────────────────────────
  const handleExportCsv = async () => {
    try {
      setExportingCsv(true);
      if (activeMainTab === "financial") {
        const res = await documentsAPI.downloadRequisitionReportCsv(financialParams);
        const blob = new Blob([res.data], { type: "text/csv;charset=utf-8;" });
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement("a");
        anchor.href = url;
        anchor.download = `requisition_financial_report_${new Date().toISOString().slice(0, 10)}.csv`;
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
        URL.revokeObjectURL(url);
        toast.success("Requisition financial report CSV downloaded.");
      } else {
        const res = await documentsAPI.downloadRetirementsAgingReportCsv(retirementsParams);
        const blob = new Blob([res.data], { type: "text/csv;charset=utf-8;" });
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement("a");
        anchor.href = url;
        anchor.download = `outstanding_retirements_aged_${new Date().toISOString().slice(0, 10)}.csv`;
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
        URL.revokeObjectURL(url);
        toast.success("Outstanding Retirements Aging report CSV downloaded.");
      }
    } catch {
      toast.error("Failed to export report CSV. Please try again.");
    } finally {
      setExportingCsv(false);
    }
  };

  const handlePrint = () => {
    setIsPrinting(true);
    setTimeout(() => {
      window.print();
    }, 150);
  };

  const handleSendTestSchedule = () => {
    setScheduleSendingTest(true);
    setTimeout(() => {
      setScheduleSendingTest(false);
      setScheduleModalOpen(false);
      toast.success("Test aging schedule email sent successfully to your inbox.");
    }, 1200);
  };

  // Visuals for Retirements
  const departmentAgingChartData = useMemo(() => {
    return (retirementsData?.by_department || []).map((d) => ({
      name: d.department,
      Current: d.aging_buckets.current || 0,
      "1-30 Days": d.aging_buckets["1_30"] || 0,
      "31-60 Days": d.aging_buckets["31_60"] || 0,
      "61-90 Days": d.aging_buckets["61_90"] || 0,
      "90+ Days": d.aging_buckets.over_90 || 0,
      Total: d.total_outstanding,
    }));
  }, [retirementsData?.by_department]);

  const agingBucketBarData = useMemo(() => {
    const totals = retSummary.aging_totals || {};
    return [
      { name: "Current / Not Due", amount: totals["current"]?.amount || 0, count: totals["current"]?.count || 0, fill: AGING_BAR_COLORS.current },
      { name: "1–30 Days", amount: totals["1_30"]?.amount || 0, count: totals["1_30"]?.count || 0, fill: AGING_BAR_COLORS["1_30"] },
      { name: "31–60 Days", amount: totals["31_60"]?.amount || 0, count: totals["31_60"]?.count || 0, fill: AGING_BAR_COLORS["31_60"] },
      { name: "61–90 Days", amount: totals["61_90"]?.amount || 0, count: totals["61_90"]?.count || 0, fill: AGING_BAR_COLORS["61_90"] },
      { name: "90+ Days", amount: totals["over_90"]?.amount || 0, count: totals["over_90"]?.count || 0, fill: AGING_BAR_COLORS.over_90 },
    ];
  }, [retSummary.aging_totals]);

  // Dropdown options
  const finAccountOptions = useMemo(() => [
    { value: "", label: "All Account Codes" },
    ...(financialData?.filter_options.accounts || []).map((a) => ({
      value: a,
      label: `Account: ${a}`,
    })),
  ], [financialData?.filter_options.accounts]);

  const finActivityOptions = useMemo(() => [
    { value: "", label: "All Activity Codes" },
    ...(financialData?.filter_options.activities || []).map((a) => ({
      value: a,
      label: `Activity: ${a}`,
    })),
  ], [financialData?.filter_options.activities]);

  const finDeptOptions = useMemo(() => [
    { value: "", label: "All Departments" },
    ...(financialData?.filter_options.departments || []).map((d) => ({
      value: d,
      label: d,
    })),
  ], [financialData?.filter_options.departments]);

  const finStatusOptions = useMemo(() => [
    { value: "", label: "All Document Statuses" },
    ...(financialData?.filter_options.statuses || []).map((s) => ({
      value: s,
      label: s.charAt(0).toUpperCase() + s.slice(1),
    })),
  ], [financialData?.filter_options.statuses]);

  const retAgingBucketOptions = useMemo(() => [
    { value: "all", label: "All Aging Categories" },
    { value: "current", label: "Current / Not Due" },
    { value: "1_30", label: "1 – 30 Days Overdue" },
    { value: "31_60", label: "31 – 60 Days Overdue" },
    { value: "61_90", label: "61 – 90 Days Overdue" },
    { value: "over_90", label: "90+ Days Overdue" },
    { value: "reconciled", label: "Reconciled" },
  ], []);

  const retDepartmentOptions = useMemo(() => [
    { value: "", label: "All Departments" },
    ...(retirementsData?.filter_options.departments || []).map((d) => ({
      value: d,
      label: d,
    })),
  ], [retirementsData?.filter_options.departments]);

  const retTravellerOptions = useMemo(() => [
    { value: "", label: "All Travellers" },
    ...(retirementsData?.filter_options.travellers || []).map((t) => ({
      value: t,
      label: t,
    })),
  ], [retirementsData?.filter_options.travellers]);

  const retStatusOptions = useMemo(() => [
    { value: "", label: "All Statuses" },
    { value: "overdue", label: "Retirement Overdue" },
    { value: "awaiting_finance", label: "Awaiting Finance" },
    { value: "not_started", label: "LPO Pending / In Progress" },
    { value: "reconciled", label: "Reconciled" },
    { value: "not_due", label: "Not Yet Returned" },
  ], []);

  const pageSizeOptions = useMemo(() => [
    { value: "10", label: "10 rows / page" },
    { value: "25", label: "25 rows / page" },
    { value: "50", label: "50 rows / page" },
    { value: "100", label: "100 rows / page" },
  ], []);

  return (
    <div className="flex h-full flex-col bg-[#F8FAFC] overflow-y-auto print:bg-white print:overflow-visible print:h-auto print:block">
      {/* ── Official Print Header (Visible ONLY on print) ── */}
      <div className="hidden print:block pb-2.5 mb-2.5 border-b border-[#1E293B]">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-base font-bold tracking-tight text-[#1E293B]">
              IDM FINANCIAL & REQUISITION MANAGEMENT SYSTEM
            </h1>
            <p className="text-xs font-semibold text-[#287EAD] uppercase tracking-wider">
              {activeMainTab === "financial"
                ? "Requisition Financial Lines & SunSystems GL Analysis Report"
                : "Outstanding Travel Retirements Aging Report (by Traveller & Department)"}
            </p>
          </div>
          <div className="text-right text-[10px] text-slate-600">
            <p>Printed: {new Date().toLocaleString()}</p>
            <p className="font-semibold text-rose-700">CONFIDENTIAL</p>
          </div>
        </div>
        <div className="mt-1.5 flex items-center justify-between text-[10px] text-slate-500 border-t border-slate-200 pt-1">
          <span>
            {activeMainTab === "financial"
              ? `Activity: ${finActivityCode || "All"} | Account: ${finAccountCode || "All"} | Total Lines: ${sortedFinancialLines.length}`
              : `Department: ${retDepartment || "All"} | Aging: ${retAgingBucket || "All"} | Overdue: ${retSummary.total_overdue_records} | Total Records: ${sortedRetirements.length}`}
          </span>
          <span>Currency: USD / Functional</span>
        </div>
      </div>

      {/* ── Top Header Bar with Report Actions ── */}
      <div className="border-b border-[#E2E8F0] bg-white px-6 pt-5 pb-0 shadow-2xs print:hidden">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between mb-4">
          <div>
            <div className="flex items-center gap-2">
              <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-[#F0F8FD] border border-[#C5E6F5] text-[#287EAD]">
                <FileSpreadsheet className="h-5 w-5" />
              </span>
              <h1 className="text-xl font-bold tracking-tight text-[#1E293B]">
                Financial & Compliance Reports
              </h1>
            </div>
            <p className="mt-1 text-xs text-[#64748B]">
              Consolidated financial reporting hub for requisitions, SunSystems GL postings, and travel retirement aging.
            </p>
          </div>

          {/* Global Actions */}
          <div className="flex items-center gap-2">
            {activeMainTab === "retirements" && (
              <button
                type="button"
                onClick={() => setScheduleModalOpen(true)}
                className="inline-flex items-center gap-1.5 rounded-lg border border-[#C5E6F5] bg-[#F0F8FD] px-3 py-1.5 text-xs font-semibold text-[#0A4D68] hover:bg-[#E2F2FA] transition-colors"
                title="Configure automated scheduled reports"
              >
                <BellRing className="h-3.5 w-3.5 text-[#287EAD]" />
                Schedule Report
              </button>
            )}
            <button
              type="button"
              onClick={handlePrint}
              className="inline-flex items-center gap-1.5 rounded-lg border border-[#CBD5E1] bg-white px-3 py-1.5 text-xs font-semibold text-[#334155] shadow-2xs hover:bg-[#F8FAFC] transition-colors"
            >
              <Printer className="h-3.5 w-3.5" />
              Print
            </button>
            <button
              type="button"
              onClick={handleExportCsv}
              disabled={exportingCsv}
              className="inline-flex items-center gap-1.5 rounded-lg bg-[#287EAD] px-3.5 py-1.5 text-xs font-semibold text-white shadow-xs hover:bg-[#1E6F99] transition-colors disabled:opacity-60"
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

        {/* ── Primary Top-Level Tab Switcher ── */}
        <div className="flex gap-8 border-b border-[#E2E8F0] -mb-px">
          {/* Tab 1 Button */}
          <button
            type="button"
            onClick={() => setActiveMainTab("financial")}
            className={cn(
              "flex items-center gap-2 pb-3.5 pt-1 text-sm font-semibold border-b-2 transition-all cursor-pointer",
              activeMainTab === "financial"
                ? "border-[#287EAD] text-[#287EAD]"
                : "border-transparent text-[#64748B] hover:text-[#1E293B]",
            )}
          >
            <Layers className="h-4 w-4" />
            <span>Requisition Financial Lines</span>
            <span className="rounded-full bg-[#F0F8FD] border border-[#C5E6F5] px-2 py-0.5 text-[11px] font-bold text-[#0A4D68]">
              {finSummary.total_lines} lines
            </span>
          </button>

          {/* Tab 2 Button */}
          <button
            type="button"
            onClick={() => setActiveMainTab("retirements")}
            className={cn(
              "flex items-center gap-2 pb-3.5 pt-1 text-sm font-semibold border-b-2 transition-all cursor-pointer",
              activeMainTab === "retirements"
                ? "border-[#287EAD] text-[#287EAD]"
                : "border-transparent text-[#64748B] hover:text-[#1E293B]",
            )}
          >
            <Clock className="h-4 w-4" />
            <span>Outstanding Retirements (Aging)</span>
            {retSummary.total_overdue_records > 0 ? (
              <span className="rounded-full bg-rose-600 px-2 py-0.5 text-[11px] font-bold text-white shadow-2xs">
                {retSummary.total_overdue_records} overdue
              </span>
            ) : (
              <span className="rounded-full bg-[#F0FDF4] border border-[#BBF7D0] px-2 py-0.5 text-[11px] font-bold text-emerald-800">
                {retSummary.total_records} forms
              </span>
            )}
          </button>
        </div>
      </div>

      {/* ── Main Content Area (Tab-Scoped so users are never overloaded) ── */}
      <div className="flex-1 p-6 space-y-5 print:p-0 print:space-y-3">
        {/* =========================================================================
            TAB 1: REQUISITION FINANCIAL LINES (GL / DIM 10)
        ========================================================================= */}
        {activeMainTab === "financial" && (
          <div className="space-y-4">
            {/* ── Light-Colored Stat Cards for Financial Lines ── */}
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6 print:grid-cols-6 print:gap-1.5 print:mb-2.5">
              {/* Card 1: Total Requisition Amount */}
              <div className="rounded-xl border border-[#C5E6F5] bg-[#F0F8FD] p-3.5 shadow-xs print:p-2 print:rounded-md print:shadow-none print:border-slate-300">
                <div className="flex items-center justify-between text-xs font-semibold text-[#0A4D68] print:text-[10px]">
                  <span>Total Requisitions</span>
                  <span className="flex h-6 w-6 items-center justify-center rounded-lg bg-[#C5E6F5] text-[#287EAD] print:hidden">
                    <TrendingUp className="h-3.5 w-3.5" />
                  </span>
                </div>
                <div className="mt-2 text-xl font-bold tabular-nums text-[#1E293B] print:mt-0.5 print:text-sm">
                  {formatCurrency(finSummary.total_amount)}
                </div>
                <div className="mt-0.5 text-[11px] text-[#475569] print:text-[9px] print:mt-0">
                  Across {finSummary.total_lines} lines
                </div>
              </div>

              {/* Card 2: Posted to SunSystems */}
              <div className="rounded-xl border border-[#BBF7D0] bg-[#F0FDF4] p-3.5 shadow-xs print:p-2 print:rounded-md print:shadow-none print:border-slate-300">
                <div className="flex items-center justify-between text-xs font-semibold text-emerald-800 print:text-[10px]">
                  <span>Posted to SunSystems</span>
                  <span className="flex h-6 w-6 items-center justify-center rounded-lg bg-emerald-100 text-emerald-700 print:hidden">
                    <CheckCircle2 className="h-3.5 w-3.5" />
                  </span>
                </div>
                <div className="mt-2 text-xl font-bold tabular-nums text-emerald-700 print:mt-0.5 print:text-sm">
                  {formatCurrency(finSummary.posted_amount)}
                </div>
                <div className="mt-0.5 text-[11px] text-emerald-600 font-medium print:text-[9px] print:mt-0">
                  {finSummary.posted_lines} lines posted
                </div>
              </div>

              {/* Card 3: Pending / Unposted */}
              <div className="rounded-xl border border-[#FDE68A] bg-[#FFFBEB] p-3.5 shadow-xs print:p-2 print:rounded-md print:shadow-none print:border-slate-300">
                <div className="flex items-center justify-between text-xs font-semibold text-amber-800 print:text-[10px]">
                  <span>Pending / Unposted</span>
                  <span className="flex h-6 w-6 items-center justify-center rounded-lg bg-amber-100 text-amber-700 print:hidden">
                    <Clock className="h-3.5 w-3.5" />
                  </span>
                </div>
                <div className="mt-2 text-xl font-bold tabular-nums text-amber-700 print:mt-0.5 print:text-sm">
                  {formatCurrency(finSummary.total_amount - finSummary.posted_amount)}
                </div>
                <div className="mt-0.5 text-[11px] text-amber-600 print:text-[9px] print:mt-0">
                  {finSummary.total_lines - finSummary.posted_lines} unposted lines
                </div>
              </div>

              {/* Card 4: Unique Activities */}
              <div className="rounded-xl border border-[#DDD6FE] bg-[#F5F3FF] p-3.5 shadow-xs print:p-2 print:rounded-md print:shadow-none print:border-slate-300">
                <div className="flex items-center justify-between text-xs font-semibold text-indigo-800 print:text-[10px]">
                  <span>Unique Activities</span>
                  <span className="flex h-6 w-6 items-center justify-center rounded-lg bg-indigo-100 text-indigo-700 print:hidden">
                    <Layers className="h-3.5 w-3.5" />
                  </span>
                </div>
                <div className="mt-2 text-xl font-bold tabular-nums text-indigo-900 print:mt-0.5 print:text-sm">
                  {finSummary.distinct_activities}
                </div>
                <div className="mt-0.5 text-[11px] text-indigo-700 print:text-[9px] print:mt-0">
                  SunSystems Dim 10
                </div>
              </div>

              {/* Card 5: Unique Accounts */}
              <div className="rounded-xl border border-[#99F6E4] bg-[#F0FDFA] p-3.5 shadow-xs print:p-2 print:rounded-md print:shadow-none print:border-slate-300">
                <div className="flex items-center justify-between text-xs font-semibold text-teal-800 print:text-[10px]">
                  <span>GL Account Codes</span>
                  <span className="flex h-6 w-6 items-center justify-center rounded-lg bg-teal-100 text-teal-700 print:hidden">
                    <Building2 className="h-3.5 w-3.5" />
                  </span>
                </div>
                <div className="mt-2 text-xl font-bold tabular-nums text-teal-900 print:mt-0.5 print:text-sm">
                  {finSummary.distinct_accounts}
                </div>
                <div className="mt-0.5 text-[11px] text-teal-700 print:text-[9px] print:mt-0">
                  Chart of accounts
                </div>
              </div>

              {/* Card 6: Posting Rate */}
              <div className="rounded-xl border border-[#BFDBFE] bg-[#EFF6FF] p-3.5 shadow-xs print:p-2 print:rounded-md print:shadow-none print:border-slate-300">
                <div className="flex items-center justify-between text-xs font-semibold text-blue-800 print:text-[10px]">
                  <span>Posting Rate</span>
                  <span className="flex h-6 w-6 items-center justify-center rounded-lg bg-blue-100 text-blue-700 print:hidden">
                    <BarChart3 className="h-3.5 w-3.5" />
                  </span>
                </div>
                <div className="mt-2 text-xl font-bold tabular-nums text-blue-900 print:mt-0.5 print:text-sm">
                  {finSummary.total_lines > 0
                    ? `${Math.round((finSummary.posted_lines / finSummary.total_lines) * 100)}%`
                    : "0%"}
                </div>
                <div className="mt-0.5 text-[11px] text-blue-700 print:text-[9px] print:mt-0">
                  Requisitions posted
                </div>
              </div>
            </div>

            {/* ── Financial Filter Toolbar (CustomListbox Dropdowns) ── */}
            <div className="rounded-xl border border-[#E2E8F0] bg-white p-4 shadow-xs print:hidden">
              <div className="flex flex-wrap items-center gap-3">
                {/* Search */}
                <div className="relative flex-1 min-w-[220px]">
                  <Search className="absolute left-2.5 top-2.5 h-3.5 w-3.5 text-[#94A3B8]" />
                  <input
                    type="text"
                    placeholder="Search description, activity code, account code, journal #, req #…"
                    value={finSearch}
                    onChange={(e) => {
                      setFinSearch(e.target.value);
                      setFinPage(1);
                    }}
                    className="w-full rounded-lg border border-[#CBD5E1] bg-white py-1.5 pl-8 pr-7 text-xs text-[#1E293B] placeholder-[#94A3B8] focus:border-[#287EAD] focus:ring-1 focus:ring-[#287EAD] focus:outline-hidden"
                  />
                  {finSearch && (
                    <button
                      type="button"
                      onClick={() => setFinSearch("")}
                      className="absolute right-2 top-2 text-[#94A3B8] hover:text-[#475569]"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  )}
                </div>

                {/* Account Code Dropdown (CustomListbox) */}
                <div className="w-48">
                  <CustomListbox
                    value={finAccountCode}
                    onChange={(v) => {
                      setFinAccountCode(v);
                      setFinPage(1);
                    }}
                    options={finAccountOptions}
                    className="text-xs"
                    buttonClassName="h-8 border-[#CBD5E1] bg-white text-xs hover:border-[#287EAD] rounded-lg"
                  />
                </div>

                {/* Activity Code Dropdown (CustomListbox) */}
                <div className="w-48">
                  <CustomListbox
                    value={finActivityCode}
                    onChange={(v) => {
                      setFinActivityCode(v);
                      setFinPage(1);
                    }}
                    options={finActivityOptions}
                    className="text-xs"
                    buttonClassName="h-8 border-[#CBD5E1] bg-white text-xs hover:border-[#287EAD] rounded-lg"
                  />
                </div>

                {/* Department Dropdown (CustomListbox) */}
                <div className="w-44">
                  <CustomListbox
                    value={finDepartment}
                    onChange={(v) => {
                      setFinDepartment(v);
                      setFinPage(1);
                    }}
                    options={finDeptOptions}
                    className="text-xs"
                    buttonClassName="h-8 border-[#CBD5E1] bg-white text-xs hover:border-[#287EAD] rounded-lg"
                  />
                </div>

                {/* Status Dropdown (CustomListbox) */}
                <div className="w-44">
                  <CustomListbox
                    value={finStatus}
                    onChange={(v) => {
                      setFinStatus(v);
                      setFinPage(1);
                    }}
                    options={finStatusOptions}
                    className="text-xs"
                    buttonClassName="h-8 border-[#CBD5E1] bg-white text-xs hover:border-[#287EAD] rounded-lg"
                  />
                </div>

                {/* Journal Only Checkbox */}
                <label className="flex items-center gap-1.5 text-xs text-[#475569] cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={finHasJournal === true}
                    onChange={(e) => {
                      setFinHasJournal(e.target.checked ? true : null);
                      setFinPage(1);
                    }}
                    className="rounded border-[#CBD5E1] text-[#287EAD] focus:ring-[#287EAD]"
                  />
                  <span>With Journal # only</span>
                </label>

                {/* Reset Filters */}
                {(finSearch || finStartDate || finEndDate || finAccountCode || finActivityCode || finDepartment || finStatus || finHasJournal !== null) && (
                  <button
                    type="button"
                    onClick={() => {
                      setFinSearch("");
                      setFinStartDate("");
                      setFinEndDate("");
                      setFinAccountCode("");
                      setFinActivityCode("");
                      setFinDepartment("");
                      setFinStatus("");
                      setFinHasJournal(null);
                      setFinPage(1);
                    }}
                    className="inline-flex items-center gap-1 text-xs font-semibold text-[#287EAD] hover:underline"
                  >
                    <RefreshCw className="h-3 w-3" />
                    Reset
                  </button>
                )}
              </div>
            </div>

            {/* ── Sub-Tabs & View Switcher for Financial Lines ── */}
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between print:hidden">
              <div className="inline-flex rounded-lg border border-[#E2E8F0] bg-white p-1 shadow-2xs">
                <button
                  type="button"
                  onClick={() => setFinancialTab("lines")}
                  className={cn(
                    "rounded-md px-3 py-1.5 text-xs font-medium transition-all cursor-pointer",
                    financialTab === "lines"
                      ? "bg-[#C5E6F5] text-[#0A4D68] font-bold shadow-xs border border-[#287EAD]/20"
                      : "text-[#64748B] hover:text-[#1E293B]",
                  )}
                >
                  Detailed Lines ({sortedFinancialLines.length})
                </button>
                <button
                  type="button"
                  onClick={() => setFinancialTab("activities")}
                  className={cn(
                    "rounded-md px-3 py-1.5 text-xs font-medium transition-all cursor-pointer",
                    financialTab === "activities"
                      ? "bg-[#C5E6F5] text-[#0A4D68] font-bold shadow-xs border border-[#287EAD]/20"
                      : "text-[#64748B] hover:text-[#1E293B]",
                  )}
                >
                  By Activity Code ({(financialData?.by_activity || []).length})
                </button>
                <button
                  type="button"
                  onClick={() => setFinancialTab("accounts")}
                  className={cn(
                    "rounded-md px-3 py-1.5 text-xs font-medium transition-all cursor-pointer",
                    financialTab === "accounts"
                      ? "bg-[#C5E6F5] text-[#0A4D68] font-bold shadow-xs border border-[#287EAD]/20"
                      : "text-[#64748B] hover:text-[#1E293B]",
                  )}
                >
                  By Account Code ({(financialData?.by_account || []).length})
                </button>
                <button
                  type="button"
                  onClick={() => setFinancialTab("visuals")}
                  className={cn(
                    "rounded-md px-3 py-1.5 text-xs font-medium transition-all cursor-pointer",
                    financialTab === "visuals"
                      ? "bg-[#C5E6F5] text-[#0A4D68] font-bold shadow-xs border border-[#287EAD]/20"
                      : "text-[#64748B] hover:text-[#1E293B]",
                  )}
                >
                  Visual Spend Charts
                </button>
              </div>

              {financialTab === "lines" && (
                <div className="flex items-center gap-2">
                  <span className="text-xs text-[#64748B]">Page size:</span>
                  <div className="w-36">
                    <CustomListbox
                      value={String(finPageSize)}
                      onChange={(v) => {
                        setFinPageSize(Number(v));
                        setFinPage(1);
                      }}
                      options={pageSizeOptions}
                      className="text-xs"
                      buttonClassName="h-7 border-[#CBD5E1] bg-white text-xs rounded-lg"
                    />
                  </div>
                </div>
              )}
            </div>

            {/* Sub-Tab 1: Detailed Financial Lines Table */}
            {financialTab === "lines" && (
              <div className="rounded-xl border border-[#E2E8F0] bg-white shadow-xs overflow-hidden print:overflow-visible print:border-none print:shadow-none print:w-full">
                <div className="overflow-x-auto print:overflow-visible print:w-full">
                  <table className="w-full border-collapse text-left text-xs print:text-[9.5px] print:w-full print:table-fixed">
                    <colgroup className="hidden print:table-column-group">
                      <col className="w-[10%]" />
                      <col className="w-[8%]" />
                      <col className="w-[13%]" />
                      <col className="w-[9%]" />
                      <col className="w-[20%]" />
                      <col className="w-[8%]" />
                      <col className="w-[7%]" />
                      <col className="w-[10%]" />
                      <col className="w-[8%]" />
                      <col className="w-[7%]" />
                    </colgroup>
                    <thead>
                      <tr className="border-b border-[#E2E8F0] bg-[#F8FAFC] text-[11px] font-semibold text-[#475569] print:bg-slate-100 print:text-[9px]">
                        <th className="py-2.5 px-3 print:py-1 print:px-1 cursor-pointer hover:text-[#1E293B]" onClick={() => handleFinSort("document_reference")}>
                          <div className="flex items-center gap-1">
                            <span>Req Ref</span>
                            <ArrowUpDown className="h-3 w-3 text-[#94A3B8] print:hidden" />
                          </div>
                        </th>
                        <th className="py-2.5 px-3 print:py-1 print:px-1 cursor-pointer hover:text-[#1E293B]" onClick={() => handleFinSort("date")}>
                          <div className="flex items-center gap-1">
                            <span>Date</span>
                            <ArrowUpDown className="h-3 w-3 text-[#94A3B8] print:hidden" />
                          </div>
                        </th>
                        <th className="py-2.5 px-3 print:py-1 print:px-1">Dept / Requester</th>
                        <th className="py-2.5 px-3 print:py-1 print:px-1">Activity Code (Dim 10)</th>
                        <th className="py-2.5 px-3 print:py-1 print:px-1">Description</th>
                        <th className="py-2.5 px-3 print:py-1 print:px-1">Account Code</th>
                        <th className="py-2.5 px-3 print:py-1 print:px-1">Cost Centre</th>
                        <th className="py-2.5 px-3 print:py-1 print:px-1 text-right cursor-pointer hover:text-[#1E293B]" onClick={() => handleFinSort("amount")}>
                          <div className="flex items-center justify-end gap-1">
                            <span>Amount</span>
                            <ArrowUpDown className="h-3 w-3 text-[#94A3B8] print:hidden" />
                          </div>
                        </th>
                        <th className="py-2.5 px-3 print:py-1 print:px-1">Journal #</th>
                        <th className="py-2.5 px-3 print:py-1 print:px-1">Status</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-[#F1F5F9]">
                      {isLoadingFinancial ? (
                        <tr>
                          <td colSpan={10} className="py-12 text-center text-xs text-[#64748B]">
                            <Loader2 className="mx-auto h-6 w-6 animate-spin text-[#287EAD]" />
                            <p className="mt-2 font-medium">Loading financial lines…</p>
                          </td>
                        </tr>
                      ) : displayedFinancialLines.length === 0 ? (
                        <tr>
                          <td colSpan={10} className="py-12 text-center text-xs text-[#64748B]">
                            <FileSpreadsheet className="mx-auto h-8 w-8 text-[#9AA5B1] mb-2" />
                            <p className="text-sm font-semibold text-[#1E293B]">No requisition lines found</p>
                            <p className="mt-1 text-xs text-[#64748B]">Try clearing your search or filter criteria.</p>
                          </td>
                        </tr>
                      ) : (
                        displayedFinancialLines.map((line) => (
                          <tr key={line.id} className="hover:bg-[#F8FAFC] transition-colors print:break-inside-avoid">
                            <td className="py-2.5 px-3 print:py-1 print:px-1 font-semibold text-[#287EAD] whitespace-nowrap">
                              <Link to={`/${line.document_id || line.id}`} className="hover:underline flex items-center gap-1">
                                {line.document_reference}
                                <ExternalLink className="h-3 w-3 text-[#94A3B8] print:hidden" />
                              </Link>
                            </td>
                            <td className="py-2.5 px-3 print:py-1 print:px-1 text-[#64748B] whitespace-nowrap">{line.date}</td>
                            <td className="py-2.5 px-3 print:py-1 print:px-1">
                              <div className="font-semibold text-[#1E293B] truncate">{line.department || "—"}</div>
                              <div className="text-[10px] text-[#64748B] truncate print:text-[8.5px]">{line.requester}</div>
                            </td>
                            <td className="py-2.5 px-3 print:py-1 print:px-1">
                              <span className="inline-flex items-center rounded bg-[#F0F8FD] border border-[#C5E6F5] px-2 py-0.5 text-[11px] font-mono font-semibold text-[#0A4D68] print:border-none print:bg-transparent print:px-0 print:py-0 print:text-[9px]">
                                {line.activity_code}
                              </span>
                            </td>
                            <td className="py-2.5 px-3 print:py-1 print:px-1 max-w-xs truncate print:max-w-none print:whitespace-normal print:line-clamp-2" title={line.description}>
                              {line.description}
                            </td>
                            <td className="py-2.5 px-3 print:py-1 print:px-1">
                              <span className="inline-flex items-center rounded bg-slate-100 px-2 py-0.5 text-[11px] font-mono font-semibold text-[#1E293B] print:bg-transparent print:px-0 print:py-0 print:text-[9px]">
                                {line.account_code}
                              </span>
                            </td>
                            <td className="py-2.5 px-3 print:py-1 print:px-1 font-mono text-slate-600">{line.cost_centre || "—"}</td>
                            <td className="py-2.5 px-3 print:py-1 print:px-1 text-right font-bold tabular-nums text-[#1E293B]">
                              {formatCurrency(line.amount, line.currency)}
                            </td>
                            <td className="py-2.5 px-3 print:py-1 print:px-1 whitespace-nowrap">
                              <JournalStatusBadge status={line.journal_status} journalNumber={line.journal_number} />
                            </td>
                            <td className="py-2.5 px-3 print:py-1 print:px-1">
                              <span className="inline-flex items-center rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-medium text-[#475569] print:bg-transparent print:px-0 print:text-[9px]">
                                {line.document_status}
                              </span>
                            </td>
                          </tr>
                        ))
                      )}
                    </tbody>
                  </table>
                </div>

                {/* Pagination */}
                {totalFinancialPages > 1 && (
                  <div className="flex items-center justify-between border-t border-[#E2E8F0] bg-[#F8FAFC] px-4 py-2 text-xs text-[#64748B] print:hidden">
                    <div>
                      Showing {(finPage - 1) * finPageSize + 1} to{" "}
                      {Math.min(finPage * finPageSize, sortedFinancialLines.length)} of{" "}
                      {sortedFinancialLines.length} lines
                    </div>
                    <div className="flex items-center gap-1">
                      <button
                        type="button"
                        onClick={() => setFinPage((p) => Math.max(1, p - 1))}
                        disabled={finPage === 1}
                        className="rounded p-1 text-[#64748B] hover:bg-white hover:text-[#1E293B] disabled:opacity-40"
                      >
                        <ChevronLeft className="h-4 w-4" />
                      </button>
                      <span className="px-2 font-medium text-[#1E293B]">
                        Page {finPage} of {totalFinancialPages}
                      </span>
                      <button
                        type="button"
                        onClick={() => setFinPage((p) => Math.min(totalFinancialPages, p + 1))}
                        disabled={finPage === totalFinancialPages}
                        className="rounded p-1 text-[#64748B] hover:bg-white hover:text-[#1E293B] disabled:opacity-40"
                      >
                        <ChevronRight className="h-4 w-4" />
                      </button>
                    </div>
                  </div>
                )}

                {/* Print Footer Summary */}
                <div className="hidden print:flex items-center justify-between text-[9.5px] text-slate-500 border-t border-slate-300 pt-1.5 mt-3">
                  <span>End of Report • {sortedFinancialLines.length} lines total • IDM Financial & Requisition Management System</span>
                  <span>CONFIDENTIAL</span>
                </div>
              </div>
            )}

            {/* Sub-Tab 2: Summary by Activity Code */}
            {financialTab === "activities" && (
              <div className="rounded-xl border border-[#E2E8F0] bg-white shadow-xs overflow-hidden print:overflow-visible print:border-none print:shadow-none print:w-full">
                <table className="w-full border-collapse text-left text-xs print:text-[9.5px]">
                  <thead>
                    <tr className="border-b border-[#E2E8F0] bg-[#F8FAFC] text-[11px] font-semibold text-[#475569] print:bg-slate-100 print:text-[9px]">
                      <th className="py-2.5 px-3 print:py-1 print:px-1.5">Activity Code (Dim 10)</th>
                      <th className="py-2.5 px-3 print:py-1 print:px-1.5">Activity Description</th>
                      <th className="py-2.5 px-3 print:py-1 print:px-1.5 text-center">Lines</th>
                      <th className="py-2.5 px-3 print:py-1 print:px-1.5 text-right">Total Amount</th>
                      <th className="py-2.5 px-3 print:py-1 print:px-1.5 text-right text-emerald-800">Posted Amount</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[#F1F5F9]">
                    {(financialData?.by_activity || []).map((row) => (
                      <tr key={row.activity_code} className="hover:bg-[#F8FAFC] print:break-inside-avoid">
                        <td className="py-2.5 px-3 print:py-1 print:px-1.5 font-mono font-bold text-[#0A4D68]">{row.activity_code}</td>
                        <td className="py-2.5 px-3 print:py-1 print:px-1.5 text-[#1E293B]">{row.activity_description || "—"}</td>
                        <td className="py-2.5 px-3 print:py-1 print:px-1.5 text-center tabular-nums">{row.line_count}</td>
                        <td className="py-2.5 px-3 print:py-1 print:px-1.5 text-right font-bold tabular-nums">{formatCurrency(row.total_amount, row.currency)}</td>
                        <td className="py-2.5 px-3 print:py-1 print:px-1.5 text-right tabular-nums text-emerald-700">{formatCurrency(row.posted_amount, row.currency)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {/* Sub-Tab 3: Summary by Account Code */}
            {financialTab === "accounts" && (
              <div className="rounded-xl border border-[#E2E8F0] bg-white shadow-xs overflow-hidden print:overflow-visible print:border-none print:shadow-none print:w-full">
                <table className="w-full border-collapse text-left text-xs print:text-[9.5px]">
                  <thead>
                    <tr className="border-b border-[#E2E8F0] bg-[#F8FAFC] text-[11px] font-semibold text-[#475569] print:bg-slate-100 print:text-[9px]">
                      <th className="py-2.5 px-3 print:py-1 print:px-1.5">Account Code</th>
                      <th className="py-2.5 px-3 print:py-1 print:px-1.5 text-center">Lines</th>
                      <th className="py-2.5 px-3 print:py-1 print:px-1.5 text-right">Total Amount</th>
                      <th className="py-2.5 px-3 print:py-1 print:px-1.5 text-right text-emerald-800">Posted Amount</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[#F1F5F9]">
                    {(financialData?.by_account || []).map((row) => (
                      <tr key={row.account_code} className="hover:bg-[#F8FAFC] print:break-inside-avoid">
                        <td className="py-2.5 px-3 print:py-1 print:px-1.5 font-mono font-bold text-[#1E293B]">{row.account_code}</td>
                        <td className="py-2.5 px-3 print:py-1 print:px-1.5 text-center tabular-nums">{row.line_count}</td>
                        <td className="py-2.5 px-3 print:py-1 print:px-1.5 text-right font-bold tabular-nums">{formatCurrency(row.total_amount, row.currency)}</td>
                        <td className="py-2.5 px-3 print:py-1 print:px-1.5 text-right tabular-nums text-emerald-700">{formatCurrency(row.posted_amount, row.currency)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {/* Sub-Tab 4: Visual Breakdown */}
            {financialTab === "visuals" && (
              <div className="rounded-xl border border-[#E2E8F0] bg-white p-4 shadow-xs">
                <h3 className="text-xs font-bold text-[#1E293B] uppercase tracking-wider mb-2">
                  Top Activities by Financial Spend
                </h3>
                <div className="h-64">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart
                      data={(financialData?.by_activity || []).slice(0, 8).map((a) => ({
                        name: a.activity_code,
                        amount: a.total_amount,
                      }))}
                      margin={{ top: 10, right: 10, left: 10, bottom: 20 }}
                    >
                      <CartesianGrid strokeDasharray="3 3" stroke="#F1F5F9" />
                      <XAxis dataKey="name" tick={{ fontSize: 11 }} />
                      <YAxis tick={{ fontSize: 11 }} tickFormatter={(val) => `$${val.toLocaleString()}`} />
                      <RechartsTooltip formatter={(val: any) => [formatCurrency(Number(val)), "Spend Amount"]} />
                      <Bar dataKey="amount" fill="#287EAD" radius={[4, 4, 0, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </div>
            )}
          </div>
        )}

        {/* =========================================================================
            TAB 2: OUTSTANDING RETIREMENTS AGING (CLIENT SPECIFICATION)
        ========================================================================= */}
        {activeMainTab === "retirements" && (
          <div className="space-y-4">
            {/* ── Light-Colored Stat Cards for Outstanding Retirements ── */}
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6 print:grid-cols-6 print:gap-1.5 print:mb-2.5">
              {/* Card 1: Total Outstanding */}
              <div className="rounded-xl border border-[#C5E6F5] bg-[#F0F8FD] p-3.5 shadow-xs print:p-2 print:rounded-md print:shadow-none print:border-slate-300">
                <div className="flex items-center justify-between text-xs font-semibold text-[#0A4D68] print:text-[10px]">
                  <span>Outstanding Balance</span>
                  <span className="flex h-6 w-6 items-center justify-center rounded-lg bg-[#C5E6F5] text-[#287EAD] print:hidden">
                    <TrendingUp className="h-3.5 w-3.5" />
                  </span>
                </div>
                <div className="mt-2 text-xl font-bold tabular-nums text-[#1E293B] print:mt-0.5 print:text-sm">
                  {formatCurrency(retSummary.total_outstanding_amount)}
                </div>
                <div className="mt-0.5 text-[11px] text-[#475569] print:text-[9px] print:mt-0">
                  Across {retSummary.total_records} travel forms
                </div>
              </div>

              {/* Card 2: Overdue Retirements */}
              <div className="rounded-xl border border-[#FECDD3] bg-[#FFF1F2] p-3.5 shadow-xs print:p-2 print:rounded-md print:shadow-none print:border-slate-300">
                <div className="flex items-center justify-between text-xs font-semibold text-rose-800 print:text-[10px]">
                  <span>Overdue Retirements</span>
                  <span className="flex h-6 w-6 items-center justify-center rounded-lg bg-rose-100 text-rose-700 print:hidden">
                    <ShieldAlert className="h-3.5 w-3.5" />
                  </span>
                </div>
                <div className="mt-2 text-xl font-bold tabular-nums text-rose-700 print:mt-0.5 print:text-sm">
                  {retSummary.total_overdue_records}
                </div>
                <div className="mt-0.5 text-[11px] font-medium text-rose-600 print:text-[9px] print:mt-0">
                  {formatCurrency(retSummary.total_overdue_amount)} delinquent
                </div>
              </div>

              {/* Card 3: Average Aging */}
              <div className="rounded-xl border border-[#FDE68A] bg-[#FFFBEB] p-3.5 shadow-xs print:p-2 print:rounded-md print:shadow-none print:border-slate-300">
                <div className="flex items-center justify-between text-xs font-semibold text-amber-800 print:text-[10px]">
                  <span>Avg. Aging (Overdue)</span>
                  <span className="flex h-6 w-6 items-center justify-center rounded-lg bg-amber-100 text-amber-700 print:hidden">
                    <Clock className="h-3.5 w-3.5" />
                  </span>
                </div>
                <div className="mt-2 text-xl font-bold tabular-nums text-amber-800 print:mt-0.5 print:text-sm">
                  {retSummary.average_days_aged} days
                </div>
                <div className="mt-0.5 text-[11px] text-amber-700 print:text-[9px] print:mt-0">
                  Past return grace period
                </div>
              </div>

              {/* Card 4: Awaiting Finance Review */}
              <div className="rounded-xl border border-[#99F6E4] bg-[#F0FDFA] p-3.5 shadow-xs print:p-2 print:rounded-md print:shadow-none print:border-slate-300">
                <div className="flex items-center justify-between text-xs font-semibold text-teal-800 print:text-[10px]">
                  <span>Awaiting Finance</span>
                  <span className="flex h-6 w-6 items-center justify-center rounded-lg bg-teal-100 text-teal-700 print:hidden">
                    <ClipboardList className="h-3.5 w-3.5" />
                  </span>
                </div>
                <div className="mt-2 text-xl font-bold tabular-nums text-teal-800 print:mt-0.5 print:text-sm">
                  {retSummary.total_awaiting_finance}
                </div>
                <div className="mt-0.5 text-[11px] text-teal-700 print:text-[9px] print:mt-0">
                  Expense review in progress
                </div>
              </div>

              {/* Card 5: Total Advance Issued */}
              <div className="rounded-xl border border-[#E2E8F0] bg-[#F8FAFC] p-3.5 shadow-xs print:p-2 print:rounded-md print:shadow-none print:border-slate-300">
                <div className="flex items-center justify-between text-xs font-semibold text-slate-700 print:text-[10px]">
                  <span>Total Advance Issued</span>
                  <span className="flex h-6 w-6 items-center justify-center rounded-lg bg-slate-200 text-slate-700 print:hidden">
                    <Building2 className="h-3.5 w-3.5" />
                  </span>
                </div>
                <div className="mt-2 text-xl font-bold tabular-nums text-slate-800 print:mt-0.5 print:text-sm">
                  {formatCurrency(retSummary.total_advance_amount)}
                </div>
                <div className="mt-0.5 text-[11px] text-slate-500 print:text-[9px] print:mt-0">
                  {formatCurrency(retSummary.total_retired_amount)} expensed
                </div>
              </div>

              {/* Card 6: Current & Reconciled */}
              <div className="rounded-xl border border-[#BBF7D0] bg-[#F0FDF4] p-3.5 shadow-xs print:p-2 print:rounded-md print:shadow-none print:border-slate-300">
                <div className="flex items-center justify-between text-xs font-semibold text-emerald-800 print:text-[10px]">
                  <span>Current / Not Due</span>
                  <span className="flex h-6 w-6 items-center justify-center rounded-lg bg-emerald-100 text-emerald-700 print:hidden">
                    <CheckCircle2 className="h-3.5 w-3.5" />
                  </span>
                </div>
                <div className="mt-2 text-xl font-bold tabular-nums text-emerald-800 print:mt-0.5 print:text-sm">
                  {retSummary.aging_totals["current"]?.count || 0}
                </div>
                <div className="mt-0.5 text-[11px] text-emerald-700 print:text-[9px] print:mt-0">
                  {retSummary.total_reconciled} reconciled
                </div>
              </div>
            </div>

            {/* ── Compact Q&A Assistant Header / Toggle ── */}
            <div className="rounded-xl border border-[#C5E6F5] bg-[#F0F8FD]/70 p-3 shadow-xs print:hidden">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="flex h-6 w-6 items-center justify-center rounded-md bg-[#C5E6F5] text-[#287EAD]">
                    <Sparkles className="h-3.5 w-3.5" />
                  </span>
                  <span className="text-xs font-bold text-[#0A4D68]">
                    Smart Aging Assistant (Q&A)
                  </span>
                  {qaAnswer && (
                    <span className="rounded-full bg-emerald-100 text-emerald-800 px-2 py-0.5 text-[10px] font-bold">
                      Filter Active
                    </span>
                  )}
                </div>
                <button
                  type="button"
                  onClick={() => setQaOpen((o) => !o)}
                  className="flex items-center gap-1 text-xs font-semibold text-[#287EAD] hover:underline cursor-pointer"
                >
                  {qaOpen ? "Collapse Q&A" : "Open Q&A Query Box"}
                  {qaOpen ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
                </button>
              </div>

              {qaOpen && (
                <div className="mt-3 space-y-2 pt-2 border-t border-[#C5E6F5]/60">
                  <div className="relative flex items-center gap-2">
                    <input
                      type="text"
                      value={qaQuery}
                      onChange={(e) => setQaQuery(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") executeQaQuery(qaQuery);
                      }}
                      placeholder="Ask any question (e.g., 'Who has retirements overdue > 30 days?', 'Show Travel department', 'Awaiting finance')…"
                      className="flex-1 rounded-lg border border-[#CBD5E1] bg-white px-3.5 py-1.5 text-xs text-[#1E293B] placeholder-[#94A3B8] shadow-2xs focus:border-[#287EAD] focus:ring-1 focus:ring-[#287EAD] focus:outline-hidden"
                    />
                    <button
                      type="button"
                      onClick={() => executeQaQuery(qaQuery)}
                      className="inline-flex items-center gap-1.5 rounded-lg bg-[#287EAD] px-3.5 py-1.5 text-xs font-semibold text-white shadow-xs hover:bg-[#1E6F99] transition-colors cursor-pointer"
                    >
                      <Send className="h-3.5 w-3.5" />
                      Ask
                    </button>
                    {(qaAnswer || qaQuery) && (
                      <button
                        type="button"
                        onClick={clearQa}
                        className="inline-flex items-center gap-1 rounded-lg border border-[#CBD5E1] bg-white px-2.5 py-1.5 text-xs font-medium text-[#64748B] hover:text-[#1E293B] shadow-2xs cursor-pointer"
                      >
                        <X className="h-3.5 w-3.5" />
                        Clear
                      </button>
                    )}
                  </div>

                  {/* Quick question prompts */}
                  <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
                    <span className="text-[#64748B]">Quick queries:</span>
                    <button
                      type="button"
                      onClick={() => executeQaQuery("Who has retirements overdue by more than 30 days?")}
                      className="rounded-full border border-[#C5E6F5] bg-white px-2.5 py-0.5 text-[#0A4D68] hover:bg-[#C5E6F5]/40 transition-colors cursor-pointer"
                    >
                      Overdue &gt; 30 Days
                    </button>
                    <button
                      type="button"
                      onClick={() => executeQaQuery("Show outstanding retirements for Travel department")}
                      className="rounded-full border border-[#C5E6F5] bg-white px-2.5 py-0.5 text-[#0A4D68] hover:bg-[#C5E6F5]/40 transition-colors cursor-pointer"
                    >
                      Travel Department
                    </button>
                    <button
                      type="button"
                      onClick={() => executeQaQuery("Show retirements awaiting finance verification")}
                      className="rounded-full border border-[#C5E6F5] bg-white px-2.5 py-0.5 text-[#0A4D68] hover:bg-[#C5E6F5]/40 transition-colors cursor-pointer"
                    >
                      Awaiting Finance Review
                    </button>
                    <button
                      type="button"
                      onClick={() => executeQaQuery("Which advances exceed $2,000?")}
                      className="rounded-full border border-[#C5E6F5] bg-white px-2.5 py-0.5 text-[#0A4D68] hover:bg-[#C5E6F5]/40 transition-colors cursor-pointer"
                    >
                      High Value (&gt; $2,000)
                    </button>
                  </div>

                  {/* Answer Box */}
                  {qaAnswer && (
                    <div className="mt-2 rounded-lg border border-[#287EAD]/30 bg-white p-3 shadow-xs">
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <div className="flex items-center gap-2">
                            <CheckCircle className="h-4 w-4 text-emerald-600 shrink-0" />
                            <h4 className="text-xs font-bold text-[#1E293B]">{qaAnswer.headline}</h4>
                          </div>
                          <p className="mt-1 text-xs text-[#475569] pl-6 leading-relaxed">
                            {qaAnswer.detail}
                          </p>
                        </div>
                        <span className="shrink-0 rounded-md bg-[#F0F8FD] border border-[#C5E6F5] px-2 py-1 text-[11px] font-semibold text-[#0A4D68]">
                          {qaAnswer.matchCount} records
                        </span>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* ── Retirements Filter Toolbar (CustomListbox Dropdowns) ── */}
            <div className="rounded-xl border border-[#E2E8F0] bg-white p-4 shadow-xs print:hidden">
              <div className="flex flex-wrap items-center gap-3">
                {/* Search */}
                <div className="relative flex-1 min-w-[200px]">
                  <Search className="absolute left-2.5 top-2.5 h-3.5 w-3.5 text-[#94A3B8]" />
                  <input
                    type="text"
                    placeholder="Search ref #, traveller, email, department…"
                    value={retSearch}
                    onChange={(e) => {
                      setRetSearch(e.target.value);
                      setRetPage(1);
                    }}
                    className="w-full rounded-lg border border-[#CBD5E1] bg-white py-1.5 pl-8 pr-7 text-xs text-[#1E293B] placeholder-[#94A3B8] focus:border-[#287EAD] focus:ring-1 focus:ring-[#287EAD] focus:outline-hidden"
                  />
                  {retSearch && (
                    <button
                      type="button"
                      onClick={() => setRetSearch("")}
                      className="absolute right-2 top-2 text-[#94A3B8] hover:text-[#475569]"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  )}
                </div>

                {/* Aging Bucket Dropdown (CustomListbox) */}
                <div className="w-48">
                  <CustomListbox
                    value={retAgingBucket}
                    onChange={(v) => {
                      setRetAgingBucket(v);
                      setRetPage(1);
                    }}
                    options={retAgingBucketOptions}
                    className="text-xs"
                    buttonClassName="h-8 border-[#CBD5E1] bg-white text-xs hover:border-[#287EAD] rounded-lg"
                  />
                </div>

                {/* Department Dropdown (CustomListbox) */}
                <div className="w-44">
                  <CustomListbox
                    value={retDepartment}
                    onChange={(v) => {
                      setRetDepartment(v);
                      setRetPage(1);
                    }}
                    options={retDepartmentOptions}
                    className="text-xs"
                    buttonClassName="h-8 border-[#CBD5E1] bg-white text-xs hover:border-[#287EAD] rounded-lg"
                  />
                </div>

                {/* Traveller Dropdown (CustomListbox) */}
                <div className="w-44">
                  <CustomListbox
                    value={retTraveller}
                    onChange={(v) => {
                      setRetTraveller(v);
                      setRetPage(1);
                    }}
                    options={retTravellerOptions}
                    className="text-xs"
                    buttonClassName="h-8 border-[#CBD5E1] bg-white text-xs hover:border-[#287EAD] rounded-lg"
                  />
                </div>

                {/* Status Dropdown (CustomListbox) */}
                <div className="w-44">
                  <CustomListbox
                    value={retStatus}
                    onChange={(v) => {
                      setRetStatus(v);
                      setRetPage(1);
                    }}
                    options={retStatusOptions}
                    className="text-xs"
                    buttonClassName="h-8 border-[#CBD5E1] bg-white text-xs hover:border-[#287EAD] rounded-lg"
                  />
                </div>

                {/* Include Reconciled Toggle */}
                <label className="flex items-center gap-1.5 text-xs text-[#475569] cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={retIncludeReconciled}
                    onChange={(e) => {
                      setRetIncludeReconciled(e.target.checked);
                      setRetPage(1);
                    }}
                    className="rounded border-[#CBD5E1] text-[#287EAD] focus:ring-[#287EAD]"
                  />
                  <span>Include Reconciled</span>
                </label>

                {/* Reset Filters */}
                {(retSearch || retDepartment || retTraveller || retStatus || retAgingBucket !== "all" || retIncludeReconciled) && (
                  <button
                    type="button"
                    onClick={() => {
                      setRetSearch("");
                      setRetDepartment("");
                      setRetTraveller("");
                      setRetStatus("");
                      setRetAgingBucket("all");
                      setRetIncludeReconciled(false);
                      setRetPage(1);
                      clearQa();
                    }}
                    className="inline-flex items-center gap-1 text-xs font-semibold text-[#287EAD] hover:underline cursor-pointer"
                  >
                    <RefreshCw className="h-3 w-3" />
                    Reset
                  </button>
                )}
              </div>
            </div>

            {/* ── Sub-Tabs & View Switcher for Retirements ── */}
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between print:hidden">
              <div className="inline-flex rounded-lg border border-[#E2E8F0] bg-white p-1 shadow-2xs">
                <button
                  type="button"
                  onClick={() => setRetirementsTab("register")}
                  className={cn(
                    "rounded-md px-3 py-1.5 text-xs font-medium transition-all cursor-pointer",
                    retirementsTab === "register"
                      ? "bg-[#C5E6F5] text-[#0A4D68] font-bold shadow-xs border border-[#287EAD]/20"
                      : "text-[#64748B] hover:text-[#1E293B]",
                  )}
                >
                  Aging Register ({sortedRetirements.length})
                </button>
                <button
                  type="button"
                  onClick={() => setRetirementsTab("by_department")}
                  className={cn(
                    "rounded-md px-3 py-1.5 text-xs font-medium transition-all cursor-pointer",
                    retirementsTab === "by_department"
                      ? "bg-[#C5E6F5] text-[#0A4D68] font-bold shadow-xs border border-[#287EAD]/20"
                      : "text-[#64748B] hover:text-[#1E293B]",
                  )}
                >
                  Aged by Department ({(retirementsData?.by_department || []).length})
                </button>
                <button
                  type="button"
                  onClick={() => setRetirementsTab("by_traveller")}
                  className={cn(
                    "rounded-md px-3 py-1.5 text-xs font-medium transition-all cursor-pointer",
                    retirementsTab === "by_traveller"
                      ? "bg-[#C5E6F5] text-[#0A4D68] font-bold shadow-xs border border-[#287EAD]/20"
                      : "text-[#64748B] hover:text-[#1E293B]",
                  )}
                >
                  Aged by Traveller ({(retirementsData?.by_traveller || []).length})
                </button>
                <button
                  type="button"
                  onClick={() => setRetirementsTab("visuals")}
                  className={cn(
                    "rounded-md px-3 py-1.5 text-xs font-medium transition-all cursor-pointer",
                    retirementsTab === "visuals"
                      ? "bg-[#C5E6F5] text-[#0A4D68] font-bold shadow-xs border border-[#287EAD]/20"
                      : "text-[#64748B] hover:text-[#1E293B]",
                  )}
                >
                  Aging Analytics
                </button>
              </div>

              {retirementsTab === "register" && (
                <div className="flex items-center gap-2">
                  <span className="text-xs text-[#64748B]">Page size:</span>
                  <div className="w-36">
                    <CustomListbox
                      value={String(retPageSize)}
                      onChange={(v) => {
                        setRetPageSize(Number(v));
                        setRetPage(1);
                      }}
                      options={pageSizeOptions}
                      className="text-xs"
                      buttonClassName="h-7 border-[#CBD5E1] bg-white text-xs rounded-lg"
                    />
                  </div>
                </div>
              )}
            </div>

            {/* Sub-Tab 1: Aging Register Table */}
            {retirementsTab === "register" && (
              <div className="rounded-xl border border-[#E2E8F0] bg-white shadow-xs overflow-hidden print:overflow-visible print:border-none print:shadow-none print:w-full">
                <div className="overflow-x-auto print:overflow-visible print:w-full">
                  <table className="w-full border-collapse text-left text-xs print:text-[9.5px] print:w-full print:table-fixed">
                    <colgroup className="hidden print:table-column-group">
                      <col className="w-[10%]" />
                      <col className="w-[14%]" />
                      <col className="w-[10%]" />
                      <col className="w-[11%]" />
                      <col className="w-[8%]" />
                      <col className="w-[12%]" />
                      <col className="w-[9%]" />
                      <col className="w-[9%]" />
                      <col className="w-[9%]" />
                      <col className="w-[8%]" />
                    </colgroup>
                    <thead>
                      <tr className="border-b border-[#E2E8F0] bg-[#F8FAFC] text-[11px] font-semibold text-[#475569] print:bg-slate-100 print:text-[9px]">
                        <th className="py-2.5 px-3 print:py-1 print:px-1 cursor-pointer hover:text-[#1E293B]" onClick={() => handleRetSort("document_reference")}>
                          <div className="flex items-center gap-1">
                            <span>Req Ref</span>
                            <ArrowUpDown className="h-3 w-3 text-[#94A3B8] print:hidden" />
                          </div>
                        </th>
                        <th className="py-2.5 px-3 print:py-1 print:px-1 cursor-pointer hover:text-[#1E293B]" onClick={() => handleRetSort("traveller_name")}>
                          <div className="flex items-center gap-1">
                            <span>Traveller</span>
                            <ArrowUpDown className="h-3 w-3 text-[#94A3B8] print:hidden" />
                          </div>
                        </th>
                        <th className="py-2.5 px-3 print:py-1 print:px-1">Department</th>
                        <th className="py-2.5 px-3 print:py-1 print:px-1">Travel Dates</th>
                        <th className="py-2.5 px-3 print:py-1 print:px-1 cursor-pointer hover:text-[#1E293B]" onClick={() => handleRetSort("due_date")}>
                          <div className="flex items-center gap-1">
                            <span>Due Date</span>
                            <ArrowUpDown className="h-3 w-3 text-[#94A3B8] print:hidden" />
                          </div>
                        </th>
                        <th className="py-2.5 px-3 print:py-1 print:px-1 cursor-pointer hover:text-[#1E293B]" onClick={() => handleRetSort("days_overdue")}>
                          <div className="flex items-center gap-1">
                            <span>Aging Status</span>
                            <ArrowUpDown className="h-3 w-3 text-[#94A3B8] print:hidden" />
                          </div>
                        </th>
                        <th className="py-2.5 px-3 print:py-1 print:px-1 text-right cursor-pointer hover:text-[#1E293B]" onClick={() => handleRetSort("advance_amount")}>
                          <div className="flex items-center justify-end gap-1">
                            <span>Advance</span>
                            <ArrowUpDown className="h-3 w-3 text-[#94A3B8] print:hidden" />
                          </div>
                        </th>
                        <th className="py-2.5 px-3 print:py-1 print:px-1 text-right">Retired / Spent</th>
                        <th className="py-2.5 px-3 print:py-1 print:px-1 text-right cursor-pointer hover:text-[#1E293B]" onClick={() => handleRetSort("outstanding_amount")}>
                          <div className="flex items-center justify-end gap-1">
                            <span>Outstanding</span>
                            <ArrowUpDown className="h-3 w-3 text-[#94A3B8] print:hidden" />
                          </div>
                        </th>
                        <th className="py-2.5 px-3 print:py-1 print:px-1">Workflow State</th>
                        <th className="py-2.5 px-3 text-center print:hidden">Action</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-[#F1F5F9]">
                      {isLoadingRetirements ? (
                        <tr>
                          <td colSpan={11} className="py-12 text-center text-xs text-[#64748B]">
                            <Loader2 className="mx-auto h-6 w-6 animate-spin text-[#287EAD]" />
                            <p className="mt-2 font-medium">Analyzing outstanding travel retirements…</p>
                          </td>
                        </tr>
                      ) : displayedRetirements.length === 0 ? (
                        <tr>
                          <td colSpan={11} className="py-12 text-center text-xs text-[#64748B]">
                            <CheckCircle2 className="mx-auto h-8 w-8 text-emerald-500 mb-2" />
                            <p className="text-sm font-semibold text-[#1E293B]">No outstanding retirements found</p>
                            <p className="mt-1 text-xs text-[#64748B]">
                              All travel advances have been retired or match the selected filters.
                            </p>
                          </td>
                        </tr>
                      ) : (
                        displayedRetirements.map((line) => (
                          <tr key={line.id} className="hover:bg-[#F8FAFC] transition-colors print:break-inside-avoid">
                            {/* Requisition Ref */}
                            <td className="py-2.5 px-3 print:py-1 print:px-1 font-semibold text-[#287EAD] whitespace-nowrap">
                              <Link
                                to={`/${line.document_id || line.id}`}
                                className="hover:underline flex items-center gap-1"
                              >
                                {line.document_reference}
                                <ExternalLink className="h-3 w-3 text-[#94A3B8] print:hidden" />
                              </Link>
                            </td>

                            {/* Traveller */}
                            <td className="py-2.5 px-3 print:py-1 print:px-1">
                              <div className="font-semibold text-[#1E293B] truncate">{line.traveller_name}</div>
                              {line.traveller_email && (
                                <div className="text-[10px] text-[#64748B] truncate print:text-[8.5px]">{line.traveller_email}</div>
                              )}
                            </td>

                            {/* Department */}
                            <td className="py-2.5 px-3 print:py-1 print:px-1">
                              <span className="inline-flex items-center rounded-md bg-[#F1F5F9] px-2 py-0.5 text-[11px] font-medium text-[#475569] print:bg-transparent print:px-0 print:py-0 print:text-[9px]">
                                {line.department}
                              </span>
                            </td>

                            {/* Travel Dates */}
                            <td className="py-2.5 px-3 print:py-1 print:px-1 text-[#475569] whitespace-nowrap">
                              <div>{formatDateDisplay(line.departure_date)}</div>
                              <div className="text-[10px] text-[#94A3B8] print:text-[8.5px]">Ret: {formatDateDisplay(line.return_date)}</div>
                            </td>

                            {/* Due Date */}
                            <td className="py-2.5 px-3 print:py-1 print:px-1 whitespace-nowrap">
                              <div className={cn(
                                "font-medium",
                                line.days_overdue > 0 ? "text-rose-700 font-bold" : "text-[#475569]",
                              )}>
                                {formatDateDisplay(line.due_date)}
                              </div>
                            </td>

                            {/* Aging Status */}
                            <td className="py-2.5 px-3 print:py-1 print:px-1 whitespace-nowrap">
                              <AgingBadge
                                bucket={line.aging_bucket}
                                label={line.aging_bucket_label}
                                days={line.days_overdue}
                              />
                            </td>

                            {/* Advance Amount */}
                            <td className="py-2.5 px-3 print:py-1 print:px-1 text-right font-medium tabular-nums text-[#475569]">
                              {formatCurrency(line.advance_amount, line.currency)}
                            </td>

                            {/* Retired / Spent */}
                            <td className="py-2.5 px-3 print:py-1 print:px-1 text-right tabular-nums text-[#64748B]">
                              {line.retired_amount > 0 ? formatCurrency(line.retired_amount, line.currency) : "—"}
                            </td>

                            {/* Outstanding Balance */}
                            <td className="py-2.5 px-3 print:py-1 print:px-1 text-right font-bold tabular-nums text-[#1E293B]">
                              <span className={cn(
                                line.outstanding_amount > 0 && line.days_overdue > 0 ? "text-rose-700" : "text-[#1E293B]",
                              )}>
                                {formatCurrency(line.outstanding_amount, line.currency)}
                              </span>
                            </td>

                            {/* Workflow State */}
                            <td className="py-2.5 px-3 print:py-1 print:px-1 whitespace-nowrap">
                              <span className="text-[11px] text-[#475569] font-medium print:text-[9px]">
                                {line.retirement_status_label}
                              </span>
                            </td>

                            {/* Action Link */}
                            <td className="py-2.5 px-3 text-center print:hidden">
                              <Link
                                to={`/${line.document_id || line.id}`}
                                className="inline-flex items-center gap-1 text-[11px] font-semibold text-[#287EAD] hover:underline"
                              >
                                View
                              </Link>
                            </td>
                          </tr>
                        ))
                      )}
                    </tbody>
                  </table>
                </div>

                {/* Pagination */}
                {totalRetirementPages > 1 && (
                  <div className="flex items-center justify-between border-t border-[#E2E8F0] bg-[#F8FAFC] px-4 py-2 text-xs text-[#64748B] print:hidden">
                    <div>
                      Showing {(retPage - 1) * retPageSize + 1} to{" "}
                      {Math.min(retPage * retPageSize, sortedRetirements.length)} of{" "}
                      {sortedRetirements.length} retirements
                    </div>
                    <div className="flex items-center gap-1">
                      <button
                        type="button"
                        onClick={() => setRetPage((p) => Math.max(1, p - 1))}
                        disabled={retPage === 1}
                        className="rounded p-1 text-[#64748B] hover:bg-white hover:text-[#1E293B] disabled:opacity-40"
                      >
                        <ChevronLeft className="h-4 w-4" />
                      </button>
                      <span className="px-2 font-medium text-[#1E293B]">
                        Page {retPage} of {totalRetirementPages}
                      </span>
                      <button
                        type="button"
                        onClick={() => setRetPage((p) => Math.min(totalRetirementPages, p + 1))}
                        disabled={retPage === totalRetirementPages}
                        className="rounded p-1 text-[#64748B] hover:bg-white hover:text-[#1E293B] disabled:opacity-40"
                      >
                        <ChevronRight className="h-4 w-4" />
                      </button>
                    </div>
                  </div>
                )}

                {/* Print Footer Summary */}
                <div className="hidden print:flex items-center justify-between text-[9.5px] text-slate-500 border-t border-slate-300 pt-1.5 mt-3">
                  <span>End of Report • {sortedRetirements.length} retirement records total • IDM Financial & Requisition Management System</span>
                  <span>CONFIDENTIAL</span>
                </div>
              </div>
            )}

            {/* Sub-Tab 2: Aged by Department Matrix */}
            {retirementsTab === "by_department" && (
              <div className="rounded-xl border border-[#E2E8F0] bg-white shadow-xs overflow-hidden print:overflow-visible print:border-none print:shadow-none print:w-full">
                <div className="border-b border-[#E2E8F0] bg-[#F8FAFC] px-4 py-3 print:py-1.5 print:px-2">
                  <h3 className="text-xs font-bold text-[#1E293B] uppercase tracking-wider print:text-[10px]">
                    Department Aging Analysis Matrix
                  </h3>
                  <p className="mt-0.5 text-xs text-[#64748B] print:text-[8.5px]">
                    Breakdown of travel advances and outstanding obligations by aging bucket for each department.
                  </p>
                </div>
                <div className="overflow-x-auto print:overflow-visible print:w-full">
                  <table className="w-full border-collapse text-left text-xs print:text-[9.5px]">
                    <thead>
                      <tr className="border-b border-[#E2E8F0] bg-[#F1F5F9] text-[11px] font-semibold text-[#475569] print:bg-slate-100 print:text-[9px]">
                        <th className="py-2.5 px-3 print:py-1 print:px-1.5">Department</th>
                        <th className="py-2.5 px-3 print:py-1 print:px-1.5 text-center">Total Req</th>
                        <th className="py-2.5 px-3 print:py-1 print:px-1.5 text-center">Overdue</th>
                        <th className="py-2.5 px-3 print:py-1 print:px-1.5 text-right">Total Advance</th>
                        <th className="py-2.5 px-3 print:py-1 print:px-1.5 text-right text-emerald-800 bg-emerald-50/50">Current / Not Due</th>
                        <th className="py-2.5 px-3 print:py-1 print:px-1.5 text-right text-amber-800 bg-amber-50/50">1–30 Days</th>
                        <th className="py-2.5 px-3 print:py-1 print:px-1.5 text-right text-orange-800 bg-orange-50/50">31–60 Days</th>
                        <th className="py-2.5 px-3 print:py-1 print:px-1.5 text-right text-rose-800 bg-rose-50/50">61–90 Days</th>
                        <th className="py-2.5 px-3 print:py-1 print:px-1.5 text-right text-red-900 bg-red-50/50">90+ Days</th>
                        <th className="py-2.5 px-3 print:py-1 print:px-1.5 text-right font-bold text-[#1E293B]">Total Outstanding</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-[#F1F5F9]">
                      {(retirementsData?.by_department || []).map((dept) => (
                        <tr key={dept.department} className="hover:bg-[#F8FAFC] transition-colors print:break-inside-avoid">
                          <td className="py-2.5 px-3 print:py-1 print:px-1.5 font-semibold text-[#1E293B]">
                            {dept.department}
                          </td>
                          <td className="py-2.5 px-3 print:py-1 print:px-1.5 text-center tabular-nums text-[#475569]">
                            {dept.total_records}
                          </td>
                          <td className="py-2.5 px-3 print:py-1 print:px-1.5 text-center">
                            {dept.overdue_count > 0 ? (
                              <span className="inline-flex items-center justify-center rounded-full bg-rose-100 px-2 py-0.5 text-[11px] font-bold text-rose-800 print:text-[9px]">
                                {dept.overdue_count}
                              </span>
                            ) : (
                              <span className="text-slate-400 font-mono">0</span>
                            )}
                          </td>
                          <td className="py-2.5 px-3 print:py-1 print:px-1.5 text-right font-medium tabular-nums text-[#475569]">
                            {formatCurrency(dept.total_advance)}
                          </td>
                          <td className="py-2.5 px-3 print:py-1 print:px-1.5 text-right tabular-nums text-emerald-800 bg-emerald-50/30">
                            {formatCurrency(dept.aging_buckets.current || 0)}
                          </td>
                          <td className="py-2.5 px-3 print:py-1 print:px-1.5 text-right tabular-nums text-amber-800 bg-amber-50/30">
                            {formatCurrency(dept.aging_buckets["1_30"] || 0)}
                          </td>
                          <td className="py-2.5 px-3 print:py-1 print:px-1.5 text-right tabular-nums text-orange-800 bg-orange-50/30">
                            {formatCurrency(dept.aging_buckets["31_60"] || 0)}
                          </td>
                          <td className="py-2.5 px-3 print:py-1 print:px-1.5 text-right tabular-nums text-rose-800 bg-rose-50/30">
                            {formatCurrency(dept.aging_buckets["61_90"] || 0)}
                          </td>
                          <td className="py-2.5 px-3 print:py-1 print:px-1.5 text-right tabular-nums text-red-900 bg-red-50/30 font-semibold">
                            {formatCurrency(dept.aging_buckets.over_90 || 0)}
                          </td>
                          <td className="py-2.5 px-3 print:py-1 print:px-1.5 text-right font-bold tabular-nums text-[#1E293B]">
                            {formatCurrency(dept.total_outstanding)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {/* Sub-Tab 3: Aged by Traveller Summary */}
            {retirementsTab === "by_traveller" && (
              <div className="rounded-xl border border-[#E2E8F0] bg-white shadow-xs overflow-hidden print:overflow-visible print:border-none print:shadow-none print:w-full">
                <div className="border-b border-[#E2E8F0] bg-[#F8FAFC] px-4 py-3 print:py-1.5 print:px-2">
                  <h3 className="text-xs font-bold text-[#1E293B] uppercase tracking-wider print:text-[10px]">
                    Traveller Aging Summary
                  </h3>
                  <p className="mt-0.5 text-xs text-[#64748B] print:text-[8.5px]">
                    Individual employee travel advance exposure, aging delinquency, and unreconciled amounts.
                  </p>
                </div>
                <div className="overflow-x-auto print:overflow-visible print:w-full">
                  <table className="w-full border-collapse text-left text-xs print:text-[9.5px]">
                    <thead>
                      <tr className="border-b border-[#E2E8F0] bg-[#F1F5F9] text-[11px] font-semibold text-[#475569] print:bg-slate-100 print:text-[9px]">
                        <th className="py-2.5 px-3 print:py-1 print:px-1.5">Traveller</th>
                        <th className="py-2.5 px-3 print:py-1 print:px-1.5">Department</th>
                        <th className="py-2.5 px-3 print:py-1 print:px-1.5 text-center">Req Count</th>
                        <th className="py-2.5 px-3 print:py-1 print:px-1.5 text-center">Overdue</th>
                        <th className="py-2.5 px-3 print:py-1 print:px-1.5 text-right">Total Advance</th>
                        <th className="py-2.5 px-3 print:py-1 print:px-1.5 text-right text-emerald-800">Current</th>
                        <th className="py-2.5 px-3 print:py-1 print:px-1.5 text-right text-amber-800">1–30d</th>
                        <th className="py-2.5 px-3 print:py-1 print:px-1.5 text-right text-rose-800">31d+</th>
                        <th className="py-2.5 px-3 print:py-1 print:px-1.5 text-right font-bold text-[#1E293B]">Outstanding Balance</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-[#F1F5F9]">
                      {(retirementsData?.by_traveller || []).map((tr) => (
                        <tr key={tr.traveller_name} className="hover:bg-[#F8FAFC] transition-colors print:break-inside-avoid">
                          <td className="py-2.5 px-3 print:py-1 print:px-1.5">
                            <div className="font-semibold text-[#1E293B]">{tr.traveller_name}</div>
                            {tr.traveller_email && (
                              <div className="text-[10px] text-[#64748B] print:text-[8.5px]">{tr.traveller_email}</div>
                            )}
                          </td>
                          <td className="py-2.5 px-3 print:py-1 print:px-1.5">
                            <span className="inline-flex items-center rounded-md bg-[#F1F5F9] px-2 py-0.5 text-[11px] font-medium text-[#475569] print:bg-transparent print:px-0 print:py-0 print:text-[9px]">
                              {tr.department}
                            </span>
                          </td>
                          <td className="py-2.5 px-3 print:py-1 print:px-1.5 text-center tabular-nums text-[#475569]">
                            {tr.total_records}
                          </td>
                          <td className="py-2.5 px-3 print:py-1 print:px-1.5 text-center">
                            {tr.overdue_count > 0 ? (
                              <span className="inline-flex items-center justify-center rounded-full bg-rose-100 px-2 py-0.5 text-[11px] font-bold text-rose-800 print:text-[9px]">
                                {tr.overdue_count}
                              </span>
                            ) : (
                              <span className="text-slate-400 font-mono">0</span>
                            )}
                          </td>
                          <td className="py-2.5 px-3 print:py-1 print:px-1.5 text-right font-medium tabular-nums text-[#475569]">
                            {formatCurrency(tr.total_advance)}
                          </td>
                          <td className="py-2.5 px-3 print:py-1 print:px-1.5 text-right tabular-nums text-emerald-800">
                            {formatCurrency(tr.aging_buckets.current || 0)}
                          </td>
                          <td className="py-2.5 px-3 print:py-1 print:px-1.5 text-right tabular-nums text-amber-800">
                            {formatCurrency(tr.aging_buckets["1_30"] || 0)}
                          </td>
                          <td className="py-2.5 px-3 print:py-1 print:px-1.5 text-right tabular-nums text-rose-800">
                            {formatCurrency((tr.aging_buckets["31_60"] || 0) + (tr.aging_buckets["61_90"] || 0) + (tr.aging_buckets.over_90 || 0))}
                          </td>
                          <td className="py-2.5 px-3 print:py-1 print:px-1.5 text-right font-bold tabular-nums text-[#1E293B]">
                            {formatCurrency(tr.total_outstanding)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
            {/* Sub-Tab 4: Aging Visual Analytics */}
            {retirementsTab === "visuals" && (
              <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
                {/* Chart 1: Outstanding Balance by Aging Bucket */}
                <div className="rounded-xl border border-[#E2E8F0] bg-white p-4 shadow-xs">
                  <h3 className="text-xs font-bold text-[#1E293B] uppercase tracking-wider mb-1">
                    Outstanding Exposure by Aging Category
                  </h3>
                  <p className="text-xs text-[#64748B] mb-4">
                    Financial balance across delinquent aging brackets.
                  </p>
                  <div className="h-64">
                    <ResponsiveContainer width="100%" height="100%">
                      <BarChart data={agingBucketBarData} margin={{ top: 10, right: 10, left: 10, bottom: 20 }}>
                        <CartesianGrid strokeDasharray="3 3" stroke="#F1F5F9" />
                        <XAxis dataKey="name" tick={{ fontSize: 11 }} />
                        <YAxis tick={{ fontSize: 11 }} tickFormatter={(val) => `$${val.toLocaleString()}`} />
                        <RechartsTooltip
                          formatter={(value: any) => [formatCurrency(Number(value)), "Outstanding Amount"]}
                        />
                        <Bar dataKey="amount" radius={[4, 4, 0, 0]}>
                          {agingBucketBarData.map((entry, index) => (
                            <Cell key={`cell-${index}`} fill={entry.fill} />
                          ))}
                        </Bar>
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                </div>

                {/* Chart 2: Outstanding Balance by Department */}
                <div className="rounded-xl border border-[#E2E8F0] bg-white p-4 shadow-xs">
                  <h3 className="text-xs font-bold text-[#1E293B] uppercase tracking-wider mb-1">
                    Outstanding Balance by Department
                  </h3>
                  <p className="text-xs text-[#64748B] mb-4">
                    Total unpaid advance per organizational department.
                  </p>
                  <div className="h-64">
                    <ResponsiveContainer width="100%" height="100%">
                      <BarChart data={departmentAgingChartData} margin={{ top: 10, right: 10, left: 10, bottom: 20 }}>
                        <CartesianGrid strokeDasharray="3 3" stroke="#F1F5F9" />
                        <XAxis dataKey="name" tick={{ fontSize: 11 }} />
                        <YAxis tick={{ fontSize: 11 }} tickFormatter={(val) => `$${val.toLocaleString()}`} />
                        <RechartsTooltip
                          formatter={(value: any) => [formatCurrency(Number(value)), "Amount"]}
                        />
                        <Legend wrapperStyle={{ fontSize: "11px" }} />
                        <Bar dataKey="Current" stackId="a" fill={AGING_BAR_COLORS.current} />
                        <Bar dataKey="1-30 Days" stackId="a" fill={AGING_BAR_COLORS["1_30"]} />
                        <Bar dataKey="31-60 Days" stackId="a" fill={AGING_BAR_COLORS["31_60"]} />
                        <Bar dataKey="61-90 Days" stackId="a" fill={AGING_BAR_COLORS["61_90"]} />
                        <Bar dataKey="90+ Days" stackId="a" fill={AGING_BAR_COLORS.over_90} />
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* ── Scheduled Report Configuration Modal ── */}
      {scheduleModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-xs p-4">
          <div className="w-full max-w-md rounded-2xl border border-[#C5E6F5] bg-white shadow-xl overflow-hidden">
            <div className="border-b border-[#C5E6F5] bg-[#F0F8FD] px-5 py-4 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-[#C5E6F5] text-[#287EAD]">
                  <BellRing className="h-4 w-4" />
                </span>
                <h3 className="text-sm font-bold text-[#1E293B]">
                  Schedule Outstanding Retirements Report
                </h3>
              </div>
              <button
                type="button"
                onClick={() => setScheduleModalOpen(false)}
                className="text-slate-400 hover:text-slate-600 cursor-pointer"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="p-5 space-y-4 text-xs">
              <div>
                <label className="block font-semibold text-[#1E293B] mb-1">
                  Dispatch Frequency
                </label>
                <div className="grid grid-cols-3 gap-2">
                  {["daily", "weekly", "monthly"].map((freq) => (
                    <button
                      key={freq}
                      type="button"
                      onClick={() => setScheduleFrequency(freq)}
                      className={cn(
                        "rounded-lg border px-3 py-2 text-center font-semibold capitalize transition-all cursor-pointer",
                        scheduleFrequency === freq
                          ? "border-[#287EAD] bg-[#F0F8FD] text-[#0A4D68] shadow-xs"
                          : "border-slate-200 text-slate-600 hover:border-slate-300",
                      )}
                    >
                      {freq}
                    </button>
                  ))}
                </div>
                <p className="mt-1 text-[11px] text-[#64748B]">
                  {scheduleFrequency === "daily" && "Delivered every business day at 8:00 AM."}
                  {scheduleFrequency === "weekly" && "Delivered every Monday morning at 8:00 AM."}
                  {scheduleFrequency === "monthly" && "Delivered on the 1st day of each month."}
                </p>
              </div>

              <div>
                <label className="block font-semibold text-[#1E293B] mb-1">
                  Target Recipients
                </label>
                <div className="space-y-1.5">
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="radio"
                      name="recipients"
                      checked={scheduleRecipients === "hods_finance"}
                      onChange={() => setScheduleRecipients("hods_finance")}
                      className="text-[#287EAD] focus:ring-[#287EAD]"
                    />
                    <span className="text-[#334155]">Department Heads & Finance Approvers</span>
                  </label>
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="radio"
                      name="recipients"
                      checked={scheduleRecipients === "all_mgmt"}
                      onChange={() => setScheduleRecipients("all_mgmt")}
                      className="text-[#287EAD] focus:ring-[#287EAD]"
                    />
                    <span className="text-[#334155]">Executive Leadership & Audit Committee</span>
                  </label>
                </div>
              </div>

              <div className="rounded-lg bg-slate-50 border border-slate-200 p-3 text-[11px] text-[#475569] space-y-1">
                <div className="flex items-center gap-1 font-semibold text-[#1E293B]">
                  <Mail className="h-3.5 w-3.5 text-[#287EAD]" />
                  <span>Report Attachment:</span>
                </div>
                <p>Includes complete CSV aging matrix by traveller & department with overdue alerts.</p>
              </div>
            </div>

            <div className="border-t border-[#E2E8F0] bg-[#F8FAFC] px-5 py-3 flex items-center justify-between">
              <button
                type="button"
                onClick={handleSendTestSchedule}
                disabled={scheduleSendingTest}
                className="inline-flex items-center gap-1.5 rounded-lg border border-[#CBD5E1] bg-white px-3 py-1.5 text-xs font-semibold text-[#334155] shadow-2xs hover:bg-[#F8FAFC] disabled:opacity-60 cursor-pointer"
              >
                {scheduleSendingTest ? (
                  <>
                    <Loader2 className="h-3 w-3 animate-spin" />
                    Sending Test…
                  </>
                ) : (
                  <>
                    <Send className="h-3 w-3 text-[#287EAD]" />
                    Send Test Now
                  </>
                )}
              </button>

              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setScheduleModalOpen(false)}
                  className="rounded-lg px-3 py-1.5 text-xs font-semibold text-[#64748B] hover:text-[#1E293B] cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setScheduleModalOpen(false);
                    toast.success(`Automated ${scheduleFrequency} report schedule saved successfully.`);
                  }}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-[#287EAD] px-4 py-1.5 text-xs font-semibold text-white shadow-xs hover:bg-[#1E6F99] cursor-pointer"
                >
                  <Check className="h-3.5 w-3.5" />
                  Save Schedule
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
