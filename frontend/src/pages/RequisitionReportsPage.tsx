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
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import {
  FileSpreadsheet, Download, Printer, Search, X, Filter,
  CheckCircle2, Clock, AlertTriangle, TrendingUp, BarChart3,
  Building2, ClipboardList, RefreshCw, ExternalLink, Layers,
  ChevronLeft, ChevronRight, SlidersHorizontal, Loader2,
  Calendar, Mail, User, ShieldAlert, Send, BellRing,
  ArrowUpDown, Check, CheckSquare, ChevronDown, Eye,
} from "lucide-react";
import {
  ResponsiveContainer, BarChart, Bar, XAxis, YAxis,
  Tooltip as RechartsTooltip, CartesianGrid, Cell, Legend,
} from "recharts";
import { documentsAPI } from "@/services/api";
import CustomListbox from "@/components/ui/CustomListbox";
import PaymentVoucherPreviewModal from "@/components/documents/PaymentVoucherPreviewModal";
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

export interface ReportColumnDef {
  id: string;
  label: string;
  defaultVisible: boolean;
  weight: number;
}

export const FINANCIAL_REPORT_COLUMNS: ReportColumnDef[] = [
  { id: "document_reference", label: "Req Ref", defaultVisible: true, weight: 10 },
  { id: "date", label: "Date", defaultVisible: true, weight: 8 },
  { id: "department_requester", label: "Dept / Requester", defaultVisible: true, weight: 12 },
  { id: "activity_code", label: "Activity Code (Dim 10)", defaultVisible: true, weight: 9 },
  { id: "description", label: "Description", defaultVisible: true, weight: 18 },
  { id: "account_code", label: "Account Code", defaultVisible: true, weight: 9 },
  { id: "cost_centre", label: "Cost Centre", defaultVisible: true, weight: 8 },
  { id: "amount", label: "Amount", defaultVisible: true, weight: 10 },
  { id: "journal_number", label: "Journal #", defaultVisible: true, weight: 8 },
  { id: "payment_voucher", label: "Payment Voucher (PV)", defaultVisible: true, weight: 10 },
  { id: "document_status", label: "Status", defaultVisible: true, weight: 8 },
];

export const RETIREMENT_REPORT_COLUMNS: ReportColumnDef[] = [
  { id: "document_reference", label: "Req Ref", defaultVisible: true, weight: 10 },
  { id: "traveller_name", label: "Traveller", defaultVisible: true, weight: 14 },
  { id: "department", label: "Department", defaultVisible: true, weight: 10 },
  { id: "travel_dates", label: "Travel Dates", defaultVisible: true, weight: 11 },
  { id: "due_date", label: "Due Date", defaultVisible: true, weight: 8 },
  { id: "aging_status", label: "Aging Status", defaultVisible: true, weight: 12 },
  { id: "advance_amount", label: "Advance", defaultVisible: true, weight: 9 },
  { id: "retired_amount", label: "Retired / Spent", defaultVisible: true, weight: 9 },
  { id: "outstanding_amount", label: "Outstanding", defaultVisible: true, weight: 9 },
  { id: "payment_voucher", label: "Payment Voucher (PV)", defaultVisible: true, weight: 10 },
  { id: "workflow_state", label: "Workflow State", defaultVisible: true, weight: 8 },
];

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
      <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-700 border border-emerald-200 print:inline-block print:max-w-full print:whitespace-normal print:break-all print:border-none print:px-0 print:py-0 print:text-[9px]">
        <CheckCircle2 className="h-3 w-3 text-emerald-600 print:hidden" />
        <span className="font-mono print:break-all">#{journalNumber}</span>
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
  const [finHasPaymentVoucher, setFinHasPaymentVoucher] = useState<boolean | null>(null);
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
  const [retHasPaymentVoucher, setRetHasPaymentVoucher] = useState<boolean | null>(null);
  const [retPage, setRetPage] = useState(1);
  const [retPageSize, setRetPageSize] = useState(25);
  const [retSortField, setRetSortField] = useState<string>("due_date");
  const [retSortDirection, setRetSortDirection] = useState<SortDirection>("asc");

  // Export & Schedule Modals
  const [exportingCsv, setExportingCsv] = useState(false);
  const [scheduleModalOpen, setScheduleModalOpen] = useState(false);
  const [scheduleFrequency, setScheduleFrequency] = useState("weekly");
  const [scheduleRecipients, setScheduleRecipients] = useState("hods_finance");
  const [scheduleEnabled, setScheduleEnabled] = useState(false);
  const [scheduleSendingTest, setScheduleSendingTest] = useState(false);
  const [scheduleSaving, setScheduleSaving] = useState(false);

  // Payment Voucher Preview Modal state
  const [previewVoucher, setPreviewVoucher] = useState<{
    id: string;
    reference?: string;
    kind?: string;
    requisitionId?: string;
    requisitionRef?: string;
  } | null>(null);

  // Selection state for custom scoped printing
  const [selectedFinIds, setSelectedFinIds] = useState<Set<string>>(new Set());
  const [selectedRetIds, setSelectedRetIds] = useState<Set<string>>(new Set());
  const [printScope, setPrintScope] = useState<"all" | "selected" | "page">("all");
  const [printDropdownOpen, setPrintDropdownOpen] = useState(false);
  const printDropdownRef = useRef<HTMLDivElement>(null);
  const finHeaderCheckboxRef = useRef<HTMLInputElement>(null);
  const retHeaderCheckboxRef = useRef<HTMLInputElement>(null);

  // Column customization state
  const [visibleFinCols, setVisibleFinCols] = useState<Set<string>>(() => {
    try {
      const saved = localStorage.getItem("idm_report_fin_columns");
      if (saved) {
        const parsed = JSON.parse(saved);
        if (Array.isArray(parsed) && parsed.length > 0) {
          const s = new Set(parsed);
          s.add("payment_voucher");
          return s;
        }
      }
    } catch {}
    return new Set(FINANCIAL_REPORT_COLUMNS.map((c) => c.id));
  });

  const [visibleRetCols, setVisibleRetCols] = useState<Set<string>>(() => {
    try {
      const saved = localStorage.getItem("idm_report_ret_columns");
      if (saved) {
        const parsed = JSON.parse(saved);
        if (Array.isArray(parsed) && parsed.length > 0) {
          const s = new Set(parsed);
          s.add("payment_voucher");
          return s;
        }
      }
    } catch {}
    return new Set(RETIREMENT_REPORT_COLUMNS.map((c) => c.id));
  });

  const [finColDropdownOpen, setFinColDropdownOpen] = useState(false);
  const [retColDropdownOpen, setRetColDropdownOpen] = useState(false);
  const finColDropdownRef = useRef<HTMLDivElement>(null);
  const retColDropdownRef = useRef<HTMLDivElement>(null);

  const toggleFinCol = (colId: string) => {
    setVisibleFinCols((prev) => {
      const next = new Set(prev);
      if (next.has(colId)) {
        if (next.size <= 1) {
          toast.warning("At least one column must remain visible.");
          return prev;
        }
        next.delete(colId);
      } else {
        next.add(colId);
      }
      try {
        localStorage.setItem("idm_report_fin_columns", JSON.stringify(Array.from(next)));
      } catch {}
      return next;
    });
  };

  const resetFinCols = () => {
    const defaultCols = new Set(FINANCIAL_REPORT_COLUMNS.map((c) => c.id));
    setVisibleFinCols(defaultCols);
    try {
      localStorage.removeItem("idm_report_fin_columns");
    } catch {}
  };

  const selectAllFinCols = () => {
    const allCols = new Set(FINANCIAL_REPORT_COLUMNS.map((c) => c.id));
    setVisibleFinCols(allCols);
    try {
      localStorage.setItem("idm_report_fin_columns", JSON.stringify(Array.from(allCols)));
    } catch {}
  };

  const toggleRetCol = (colId: string) => {
    setVisibleRetCols((prev) => {
      const next = new Set(prev);
      if (next.has(colId)) {
        if (next.size <= 1) {
          toast.warning("At least one column must remain visible.");
          return prev;
        }
        next.delete(colId);
      } else {
        next.add(colId);
      }
      try {
        localStorage.setItem("idm_report_ret_columns", JSON.stringify(Array.from(next)));
      } catch {}
      return next;
    });
  };

  const resetRetCols = () => {
    const defaultCols = new Set(RETIREMENT_REPORT_COLUMNS.map((c) => c.id));
    setVisibleRetCols(defaultCols);
    try {
      localStorage.removeItem("idm_report_ret_columns");
    } catch {}
  };

  const selectAllRetCols = () => {
    const allCols = new Set(RETIREMENT_REPORT_COLUMNS.map((c) => c.id));
    setVisibleRetCols(allCols);
    try {
      localStorage.setItem("idm_report_ret_columns", JSON.stringify(Array.from(allCols)));
    } catch {}
  };

  const activeFinColDefs = useMemo(() => {
    return FINANCIAL_REPORT_COLUMNS.filter((col) => visibleFinCols.has(col.id));
  }, [visibleFinCols]);

  const finColTotalWeight = useMemo(() => {
    return activeFinColDefs.reduce((acc, c) => acc + c.weight, 0) || 1;
  }, [activeFinColDefs]);

  const activeRetColDefs = useMemo(() => {
    return RETIREMENT_REPORT_COLUMNS.filter((col) => visibleRetCols.has(col.id));
  }, [visibleRetCols]);

  const retColTotalWeight = useMemo(() => {
    return activeRetColDefs.reduce((acc, c) => acc + c.weight, 0) || 1;
  }, [activeRetColDefs]);

  // Print mode detection for unpaginated full print rendering
  const [isPrinting, setIsPrinting] = useState(false);

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (printDropdownRef.current && !printDropdownRef.current.contains(event.target as Node)) {
        setPrintDropdownOpen(false);
      }
      if (finColDropdownRef.current && !finColDropdownRef.current.contains(event.target as Node)) {
        setFinColDropdownOpen(false);
      }
      if (retColDropdownRef.current && !retColDropdownRef.current.contains(event.target as Node)) {
        setRetColDropdownOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  useEffect(() => {
    const handleBefore = () => setIsPrinting(true);
    const handleAfter = () => {
      setIsPrinting(false);
      setPrintScope("all");
    };
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
      has_payment_voucher: finHasPaymentVoucher === null ? undefined : finHasPaymentVoucher,
    };
  }, [
    finSearch, finStartDate, finEndDate, finAccountCode,
    finActivityCode, finStatus, finDepartment, finHasJournal, finHasPaymentVoucher,
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
      has_payment_voucher: retHasPaymentVoucher === null ? undefined : retHasPaymentVoucher,
    };
  }, [
    retSearch, retDepartment, retTraveller, retStatus,
    retAgingBucket, retStartDate, retEndDate, retIncludeReconciled, retHasPaymentVoucher,
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

  const { data: savedSchedule, isLoading: isLoadingSchedule, isError: scheduleLoadFailed } = useQuery({
    queryKey: ["retirement-report-schedule"],
    queryFn: () => documentsAPI.retirementReportSchedule().then((r) => r.data),
    enabled: scheduleModalOpen,
    staleTime: 0,
  });

  useEffect(() => {
    if (!savedSchedule) return;
    if (savedSchedule.frequency) setScheduleFrequency(savedSchedule.frequency);
    if (savedSchedule.audience) setScheduleRecipients(savedSchedule.audience);
    setScheduleEnabled(Boolean(savedSchedule.enabled));
  }, [savedSchedule]);

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

  // When printing, render based on printScope; otherwise render paginated lines
  const displayedFinancialLines = useMemo(() => {
    if (isPrinting) {
      if (printScope === "selected") {
        const filtered = sortedFinancialLines.filter((line) => selectedFinIds.has(line.id));
        return filtered.length > 0 ? filtered : sortedFinancialLines;
      }
      if (printScope === "page") {
        return paginatedFinancialLines;
      }
      return sortedFinancialLines;
    }
    return paginatedFinancialLines;
  }, [isPrinting, printScope, sortedFinancialLines, selectedFinIds, paginatedFinancialLines]);

  const totalFinancialPages = Math.ceil(sortedFinancialLines.length / finPageSize) || 1;

  // Financial Lines selection state helpers
  const allFinPageSelected = useMemo(() => {
    return paginatedFinancialLines.length > 0 && paginatedFinancialLines.every((l) => selectedFinIds.has(l.id));
  }, [paginatedFinancialLines, selectedFinIds]);

  const someFinPageSelected = useMemo(() => {
    return paginatedFinancialLines.some((l) => selectedFinIds.has(l.id));
  }, [paginatedFinancialLines, selectedFinIds]);

  useEffect(() => {
    if (finHeaderCheckboxRef.current) {
      finHeaderCheckboxRef.current.indeterminate = someFinPageSelected && !allFinPageSelected;
    }
  }, [someFinPageSelected, allFinPageSelected]);

  const toggleSelectFinRow = (id: string) => {
    setSelectedFinIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleSelectAllFinOnPage = () => {
    setSelectedFinIds((prev) => {
      if (allFinPageSelected) {
        return new Set();
      }
      const next = new Set(prev);
      paginatedFinancialLines.forEach((l) => next.add(l.id));
      return next;
    });
  };

  const handleSelectAllFilteredFin = () => {
    setSelectedFinIds(new Set(sortedFinancialLines.map((l) => l.id)));
  };

  const clearFinSelection = () => {
    setSelectedFinIds(new Set());
  };

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

  // When printing, render based on printScope; otherwise render paginated retirements
  const displayedRetirements = useMemo(() => {
    if (isPrinting) {
      if (printScope === "selected") {
        const filtered = sortedRetirements.filter((r) => selectedRetIds.has(r.id));
        return filtered.length > 0 ? filtered : sortedRetirements;
      }
      if (printScope === "page") {
        return paginatedRetirements;
      }
      return sortedRetirements;
    }
    return paginatedRetirements;
  }, [isPrinting, printScope, sortedRetirements, selectedRetIds, paginatedRetirements]);

  const totalRetirementPages = Math.ceil(sortedRetirements.length / retPageSize) || 1;

  // Retirements selection state helpers
  const allRetPageSelected = useMemo(() => {
    return paginatedRetirements.length > 0 && paginatedRetirements.every((r) => selectedRetIds.has(r.id));
  }, [paginatedRetirements, selectedRetIds]);

  const someRetPageSelected = useMemo(() => {
    return paginatedRetirements.some((r) => selectedRetIds.has(r.id));
  }, [paginatedRetirements, selectedRetIds]);

  useEffect(() => {
    if (retHeaderCheckboxRef.current) {
      retHeaderCheckboxRef.current.indeterminate = someRetPageSelected && !allRetPageSelected;
    }
  }, [someRetPageSelected, allRetPageSelected]);

  const toggleSelectRetRow = (id: string) => {
    setSelectedRetIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleSelectAllRetOnPage = () => {
    setSelectedRetIds((prev) => {
      if (allRetPageSelected) {
        return new Set();
      }
      const next = new Set(prev);
      paginatedRetirements.forEach((r) => next.add(r.id));
      return next;
    });
  };

  const handleSelectAllFilteredRet = () => {
    setSelectedRetIds(new Set(sortedRetirements.map((r) => r.id)));
  };

  const clearRetSelection = () => {
    setSelectedRetIds(new Set());
  };

  // Summaries calculation for custom selection
  const selectedFinSummary = useMemo(() => {
    const selectedLines = sortedFinancialLines.filter((l) => selectedFinIds.has(l.id));
    const total_amount = selectedLines.reduce((acc, l) => acc + (Number(l.amount) || 0), 0);
    const postedLinesList = selectedLines.filter((l) => Boolean(l.journal_number) || l.journal_status === "posted");
    const posted_lines = postedLinesList.length;
    const posted_amount = postedLinesList.reduce((acc, l) => acc + (Number(l.amount) || 0), 0);
    const distinct_activities = new Set(selectedLines.map((l) => l.activity_code).filter(Boolean)).size;
    const distinct_accounts = new Set(selectedLines.map((l) => l.account_code).filter(Boolean)).size;
    return {
      total_amount,
      total_lines: selectedLines.length,
      posted_amount,
      posted_lines,
      distinct_activities,
      distinct_accounts,
    };
  }, [sortedFinancialLines, selectedFinIds]);

  const currentFinSummary = isPrinting && printScope === "selected" ? selectedFinSummary : finSummary;

  const selectedRetSummary = useMemo(() => {
    const selectedLines = sortedRetirements.filter((r) => selectedRetIds.has(r.id));
    const total_records = selectedLines.length;
    const total_advance_amount = selectedLines.reduce((acc, r) => acc + (Number(r.advance_amount) || 0), 0);
    const total_outstanding_amount = selectedLines.reduce((acc, r) => acc + (Number(r.outstanding_amount) || 0), 0);
    const total_retired_amount = selectedLines.reduce((acc, r) => acc + (Number(r.retired_amount) || 0), 0);
    const overdueLines = selectedLines.filter((r) => (r.days_overdue || 0) > 0 && (r.outstanding_amount || 0) > 0);
    const total_overdue_records = overdueLines.length;
    const total_overdue_amount = overdueLines.reduce((acc, r) => acc + (Number(r.outstanding_amount) || 0), 0);
    const total_awaiting_finance = selectedLines.filter((r) => r.retirement_status === "submitted" || r.retirement_status === "review").length;
    const total_reconciled = selectedLines.filter((r) => r.aging_bucket === "reconciled").length;
    const average_days_aged = overdueLines.length > 0
      ? Math.round((overdueLines.reduce((acc, r) => acc + (r.days_overdue || 0), 0) / overdueLines.length) * 10) / 10
      : 0;

    const aging_totals: Record<string, { count: number; amount: number }> = {};
    for (const r of selectedLines) {
      const b = r.aging_bucket || "current";
      if (!aging_totals[b]) {
        aging_totals[b] = { count: 0, amount: 0 };
      }
      aging_totals[b].count += 1;
      aging_totals[b].amount += Number(r.outstanding_amount) || 0;
    }

    return {
      total_records,
      total_advance_amount,
      total_outstanding_amount,
      total_retired_amount,
      total_overdue_records,
      total_overdue_amount,
      total_awaiting_finance,
      total_reconciled,
      average_days_aged,
      aging_totals,
    };
  }, [sortedRetirements, selectedRetIds]);

  const currentRetSummary = isPrinting && printScope === "selected" ? selectedRetSummary : retSummary;

  const matchingFinSelectedCount = useMemo(() => {
    return sortedFinancialLines.filter((l) => selectedFinIds.has(l.id)).length;
  }, [sortedFinancialLines, selectedFinIds]);

  const matchingRetSelectedCount = useMemo(() => {
    return sortedRetirements.filter((r) => selectedRetIds.has(r.id)).length;
  }, [sortedRetirements, selectedRetIds]);

  const activeSelectedCount = activeMainTab === "financial" ? matchingFinSelectedCount : matchingRetSelectedCount;
  const totalFilteredCount = activeMainTab === "financial" ? sortedFinancialLines.length : sortedRetirements.length;
  const currentPageRowsCount = activeMainTab === "financial" ? paginatedFinancialLines.length : paginatedRetirements.length;

  // ── CSV Export ─────────────────────────────────────────────────────────────
  const generateFinCsv = (lines: RequisitionReportLine[], filenamePrefix: string) => {
    if (lines.length === 0) {
      toast.error("No lines to export.");
      return;
    }
    const colMappings: { id: string; label: string; getValue: (line: RequisitionReportLine) => string }[] = [
      { id: "document_reference", label: "Requisition Ref", getValue: (l) => l.document_reference },
      { id: "date", label: "Date", getValue: (l) => l.date },
      { id: "department_requester", label: "Dept / Requester", getValue: (l) => `${l.department || ""} / ${l.requester || ""}` },
      { id: "activity_code", label: "Activity Code (Dim 10)", getValue: (l) => l.activity_code },
      { id: "description", label: "Description", getValue: (l) => l.description },
      { id: "account_code", label: "Account Code", getValue: (l) => l.account_code },
      { id: "cost_centre", label: "Cost Centre", getValue: (l) => l.cost_centre || "" },
      { id: "amount", label: `Amount (${lines[0]?.currency || "USD"})`, getValue: (l) => String(l.amount) },
      { id: "journal_number", label: "Journal #", getValue: (l) => l.journal_number || "" },
      { id: "payment_voucher", label: "Payment Voucher (PV)", getValue: (l) => l.payment_voucher_reference || "" },
      { id: "document_status", label: "Status", getValue: (l) => l.document_status || "" },
    ];

    const activeCols = colMappings.filter((c) => visibleFinCols.has(c.id));
    const escapeCsv = (str: any) => `"${String(str ?? "").replace(/"/g, '""')}"`;
    const headers = activeCols.map((c) => escapeCsv(c.label));
    const rows = lines.map((l) => activeCols.map((c) => escapeCsv(c.getValue(l))).join(","));

    const csvContent = [headers.join(","), ...rows].join("\n");
    const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${filenamePrefix}_${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
    toast.success(`Exported ${lines.length} lines with ${activeCols.length} columns.`);
  };

  const generateRetCsv = (retirements: OutstandingRetirementLine[], filenamePrefix: string) => {
    if (retirements.length === 0) {
      toast.error("No retirements to export.");
      return;
    }
    const colMappings: { id: string; label: string; getValue: (r: OutstandingRetirementLine) => string }[] = [
      { id: "document_reference", label: "Requisition Ref", getValue: (r) => r.document_reference },
      { id: "traveller_name", label: "Traveller", getValue: (r) => `${r.traveller_name} ${r.traveller_email ? `(${r.traveller_email})` : ""}` },
      { id: "department", label: "Department", getValue: (r) => r.department },
      { id: "travel_dates", label: "Travel Dates", getValue: (r) => `${formatDateDisplay(r.departure_date)} to ${formatDateDisplay(r.return_date)}` },
      { id: "due_date", label: "Due Date", getValue: (r) => formatDateDisplay(r.due_date) },
      { id: "aging_status", label: "Aging Status", getValue: (r) => `${r.aging_bucket_label} (${r.days_overdue}d)` },
      { id: "advance_amount", label: `Advance (${retirements[0]?.currency || "USD"})`, getValue: (r) => String(r.advance_amount) },
      { id: "retired_amount", label: `Retired / Spent (${retirements[0]?.currency || "USD"})`, getValue: (r) => String(r.retired_amount) },
      { id: "outstanding_amount", label: `Outstanding (${retirements[0]?.currency || "USD"})`, getValue: (r) => String(r.outstanding_amount) },
      { id: "payment_voucher", label: "Payment Voucher (PV)", getValue: (r) => r.payment_voucher_reference || "" },
      { id: "workflow_state", label: "Workflow State", getValue: (r) => r.retirement_status_label },
    ];

    const activeCols = colMappings.filter((c) => visibleRetCols.has(c.id));
    const escapeCsv = (str: any) => `"${String(str ?? "").replace(/"/g, '""')}"`;
    const headers = activeCols.map((c) => escapeCsv(c.label));
    const rows = retirements.map((r) => activeCols.map((c) => escapeCsv(c.getValue(r))).join(","));

    const csvContent = [headers.join(","), ...rows].join("\n");
    const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${filenamePrefix}_${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
    toast.success(`Exported ${retirements.length} records with ${activeCols.length} columns.`);
  };

  const handleExportCsv = async () => {
    try {
      setExportingCsv(true);
      if (activeMainTab === "financial") {
        if (visibleFinCols.size < FINANCIAL_REPORT_COLUMNS.length) {
          generateFinCsv(sortedFinancialLines, "requisition_financial_report_custom_cols");
          return;
        }
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
        if (visibleRetCols.size < RETIREMENT_REPORT_COLUMNS.length) {
          generateRetCsv(sortedRetirements, "outstanding_retirements_aged_custom_cols");
          return;
        }
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

  const handleExportSelectedFinCsv = () => {
    const selectedLines = sortedFinancialLines.filter((l) => selectedFinIds.has(l.id));
    generateFinCsv(selectedLines, "custom_selected_financial_lines");
  };

  const handleExportSelectedRetCsv = () => {
    const selectedLines = sortedRetirements.filter((r) => selectedRetIds.has(r.id));
    generateRetCsv(selectedLines, "custom_selected_retirements");
  };

  const handlePrint = (scope: "all" | "selected" | "page" = "all") => {
    const activeSelectedSize = activeMainTab === "financial" ? selectedFinIds.size : selectedRetIds.size;
    const effectiveScope = scope === "selected" && activeSelectedSize === 0 ? "all" : scope;
    setPrintScope(effectiveScope);
    setIsPrinting(true);
    setTimeout(() => {
      window.print();
    }, 150);
  };

  const handleSendTestSchedule = async () => {
    setScheduleSendingTest(true);
    try {
      const response = await documentsAPI.sendRetirementReportScheduleTest();
      toast.success(response.data?.detail || "Test aging report sent to your account email.");
    } catch (error: any) {
      toast.error(error?.response?.data?.detail || "Could not send the test report. Check the mail service and try again.");
    } finally {
      setScheduleSendingTest(false);
    }
  };

  const handleSaveSchedule = async () => {
    setScheduleSaving(true);
    try {
      await documentsAPI.saveRetirementReportSchedule({
        frequency: scheduleFrequency,
        audience: scheduleRecipients,
        enabled: scheduleEnabled,
      });
      toast.success("Retirement report schedule saved.");
      setScheduleModalOpen(false);
    } catch (error: any) {
      toast.error(error?.response?.data?.detail || "Could not save the report schedule.");
    } finally {
      setScheduleSaving(false);
    }
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
    ...(retirementsData?.filter_options.statuses || []).map((item) => ({
      value: item.key,
      label: item.label,
    })),
  ], [retirementsData?.filter_options.statuses]);

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
                ? (printScope === "selected" || visibleFinCols.size < FINANCIAL_REPORT_COLUMNS.length
                    ? "Custom Selected Financial Lines & SunSystems GL Report"
                    : "Requisition Financial Lines & SunSystems GL Analysis Report")
                : (printScope === "selected" || visibleRetCols.size < RETIREMENT_REPORT_COLUMNS.length
                    ? "Custom Selected Travel Retirements Aging Report"
                    : "Outstanding Travel Retirements Aging Report (by Traveller & Department)")}
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
              ? `Activity: ${finActivityCode || "All"} | Account: ${finAccountCode || "All"}${
                  finStartDate || finEndDate ? ` | Raised: ${finStartDate || "Any"} to ${finEndDate || "Any"}` : ""
                } | Scope: ${
                  printScope === "selected"
                    ? `Custom Selection (${displayedFinancialLines.length} lines)`
                    : printScope === "page"
                    ? `Current Page (${displayedFinancialLines.length} lines)`
                    : `All Filtered (${sortedFinancialLines.length} lines)`
                }${finHasPaymentVoucher ? " | Payment Voucher: Only with PV" : ""}${
                  visibleFinCols.size < FINANCIAL_REPORT_COLUMNS.length
                    ? ` | Columns (${visibleFinCols.size}): ${activeFinColDefs.map((c) => c.label).join(", ")}`
                    : ""
                }`
              : `Department: ${retDepartment || "All"} | Aging: ${retAgingBucket || "All"}${
                  retStartDate || retEndDate ? ` | Raised: ${retStartDate || "Any"} to ${retEndDate || "Any"}` : ""
                } | Scope: ${
                  printScope === "selected"
                    ? `Custom Selection (${displayedRetirements.length} records)`
                    : printScope === "page"
                    ? `Current Page (${displayedRetirements.length} records)`
                    : `All Filtered (${sortedRetirements.length} records)`
                }${retHasPaymentVoucher ? " | Payment Voucher: Only with PV" : ""} | Overdue: ${currentRetSummary.total_overdue_records}${
                  visibleRetCols.size < RETIREMENT_REPORT_COLUMNS.length
                    ? ` | Columns (${visibleRetCols.size}): ${activeRetColDefs.map((c) => c.label).join(", ")}`
                    : ""
                }`}
          </span>
          <span>Currency: USD / Functional</span>
        </div>
      </div>

      {/* ── Top Header Bar with Report Actions ── */}
      <div className="border-b border-[#E2E8F0] bg-white px-6 pt-5 pb-0 shadow-2xs print:hidden">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between mb-4">
          <div>
            <div className="flex items-center gap-2">
              <span className="flex h-8 w-8 items-center justify-center rounded-none bg-[#F0F8FD] border border-[#C5E6F5] text-[#287EAD]">
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
                className="inline-flex items-center gap-1.5 rounded-none border border-[#C5E6F5] bg-[#F0F8FD] px-3 py-1.5 text-xs font-semibold text-[#0A4D68] hover:bg-[#E2F2FA] transition-colors"
                title="Configure automated scheduled reports"
              >
                <BellRing className="h-3.5 w-3.5 text-[#287EAD]" />
                Schedule Report
              </button>
            )}

            {/* Print with Custom Scope Options Dropdown */}
            <div className="relative inline-flex rounded-none shadow-2xs" ref={printDropdownRef}>
              <button
                type="button"
                onClick={() => handlePrint(activeSelectedCount > 0 ? "selected" : "all")}
                className={cn(
                  "inline-flex items-center gap-1.5 rounded-none border border-[#CBD5E1] px-3 py-1.5 text-xs font-semibold transition-colors cursor-pointer",
                  activeSelectedCount > 0
                    ? "bg-[#F0F8FD] border-[#C5E6F5] text-[#0A4D68] hover:bg-[#E2F2FA]"
                    : "bg-white text-[#334155] hover:bg-[#F8FAFC]"
                )}
                title={
                  activeSelectedCount > 0
                    ? `Print ${activeSelectedCount} selected custom rows`
                    : "Print full report"
                }
              >
                <Printer className="h-3.5 w-3.5 text-[#287EAD]" />
                <span>
                  {activeSelectedCount > 0 ? `Print (${activeSelectedCount} Selected)` : "Print"}
                </span>
              </button>
              <button
                type="button"
                onClick={() => setPrintDropdownOpen((prev) => !prev)}
                className={cn(
                  "inline-flex items-center rounded-none border border-l-0 border-[#CBD5E1] px-1.5 py-1.5 text-xs transition-colors cursor-pointer",
                  activeSelectedCount > 0
                    ? "bg-[#F0F8FD] border-[#C5E6F5] text-[#0A4D68] hover:bg-[#E2F2FA]"
                    : "bg-white text-[#64748B] hover:bg-[#F8FAFC]"
                )}
                aria-label="Print scope options"
                aria-expanded={printDropdownOpen}
              >
                <ChevronDown className="h-3.5 w-3.5" />
              </button>

              {printDropdownOpen && (
                <div className="absolute right-0 top-full z-50 mt-1 w-64 rounded-none border border-[#E2E8F0] bg-white p-1.5 shadow-lg animate-in fade-in zoom-in-95 duration-100">
                  <div className="px-2.5 py-1.5 text-[10px] font-semibold text-slate-400 uppercase tracking-wider">
                    Select Print Mode
                  </div>

                  {activeSelectedCount > 0 && (
                    <button
                      type="button"
                      onClick={() => {
                        setPrintDropdownOpen(false);
                        handlePrint("selected");
                      }}
                      className="flex w-full items-start gap-2.5 rounded-none px-2.5 py-2 text-left text-xs font-medium text-slate-700 hover:bg-[#F0F8FD] hover:text-[#0A4D68] transition-colors cursor-pointer"
                    >
                      <CheckSquare className="h-4 w-4 text-[#287EAD] shrink-0 mt-0.5" />
                      <div>
                        <div className="font-semibold text-[#0A4D68]">
                          Print Selected Rows ({activeSelectedCount})
                        </div>
                        <div className="text-[11px] text-slate-500">
                          Custom report with only the {activeSelectedCount} checked rows
                        </div>
                      </div>
                    </button>
                  )}

                  <button
                    type="button"
                    onClick={() => {
                      setPrintDropdownOpen(false);
                      handlePrint("all");
                    }}
                    className="flex w-full items-start gap-2.5 rounded-none px-2.5 py-2 text-left text-xs font-medium text-slate-700 hover:bg-slate-50 transition-colors cursor-pointer"
                  >
                    <FileSpreadsheet className="h-4 w-4 text-slate-500 shrink-0 mt-0.5" />
                    <div>
                      <div className="font-semibold text-slate-800">
                        Print All Filtered Rows ({totalFilteredCount})
                      </div>
                      <div className="text-[11px] text-slate-500">
                        Complete report matching current filters across all pages
                      </div>
                    </div>
                  </button>

                  <button
                    type="button"
                    onClick={() => {
                      setPrintDropdownOpen(false);
                      handlePrint("page");
                    }}
                    className="flex w-full items-start gap-2.5 rounded-none px-2.5 py-2 text-left text-xs font-medium text-slate-700 hover:bg-slate-50 transition-colors cursor-pointer"
                  >
                    <Layers className="h-4 w-4 text-slate-500 shrink-0 mt-0.5" />
                    <div>
                      <div className="font-semibold text-slate-800">
                        Print Current Page ({currentPageRowsCount})
                      </div>
                      <div className="text-[11px] text-slate-500">
                        Page {activeMainTab === "financial" ? finPage : retPage} only ({currentPageRowsCount} rows)
                      </div>
                    </div>
                  </button>

                  {activeSelectedCount > 0 && (
                    <div className="border-t border-slate-100 mt-1 pt-1">
                      <button
                        type="button"
                        onClick={() => {
                          setPrintDropdownOpen(false);
                          if (activeMainTab === "financial") clearFinSelection();
                          else clearRetSelection();
                        }}
                        className="w-full text-left rounded-none px-2.5 py-1.5 text-[11px] text-rose-600 hover:bg-rose-50 font-medium cursor-pointer"
                      >
                        Clear selection ({activeSelectedCount})
                      </button>
                    </div>
                  )}
                </div>
              )}
            </div>
            <button
              type="button"
              onClick={handleExportCsv}
              disabled={exportingCsv}
              className="inline-flex items-center gap-1.5 rounded-none bg-[#287EAD] px-3.5 py-1.5 text-xs font-semibold text-white shadow-xs hover:bg-[#1E6F99] transition-colors disabled:opacity-60"
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
              <div className="rounded-none border border-[#C5E6F5] bg-[#F0F8FD] p-3.5 shadow-xs print:p-2 print:rounded-none print:shadow-none print:border-slate-300">
                <div className="flex items-center justify-between text-xs font-semibold text-[#0A4D68] print:text-[10px]">
                  <span>Total Requisitions</span>
                  <span className="flex h-6 w-6 items-center justify-center rounded-none bg-[#C5E6F5] text-[#287EAD] print:hidden">
                    <TrendingUp className="h-3.5 w-3.5" />
                  </span>
                </div>
                <div className="mt-2 text-xl font-bold tabular-nums text-[#1E293B] print:mt-0.5 print:text-sm">
                  {formatCurrency(currentFinSummary.total_amount)}
                </div>
                <div className="mt-0.5 text-[11px] text-[#475569] print:text-[9px] print:mt-0">
                  Across {currentFinSummary.total_lines} lines
                </div>
              </div>

              {/* Card 2: Posted to SunSystems */}
              <div className="rounded-none border border-[#BBF7D0] bg-[#F0FDF4] p-3.5 shadow-xs print:p-2 print:rounded-none print:shadow-none print:border-slate-300">
                <div className="flex items-center justify-between text-xs font-semibold text-emerald-800 print:text-[10px]">
                  <span>Posted to SunSystems</span>
                  <span className="flex h-6 w-6 items-center justify-center rounded-none bg-emerald-100 text-emerald-700 print:hidden">
                    <CheckCircle2 className="h-3.5 w-3.5" />
                  </span>
                </div>
                <div className="mt-2 text-xl font-bold tabular-nums text-emerald-700 print:mt-0.5 print:text-sm">
                  {formatCurrency(currentFinSummary.posted_amount)}
                </div>
                <div className="mt-0.5 text-[11px] text-emerald-600 font-medium print:text-[9px] print:mt-0">
                  {currentFinSummary.posted_lines} lines posted
                </div>
              </div>

              {/* Card 3: Pending / Unposted */}
              <div className="rounded-none border border-[#FDE68A] bg-[#FFFBEB] p-3.5 shadow-xs print:p-2 print:rounded-none print:shadow-none print:border-slate-300">
                <div className="flex items-center justify-between text-xs font-semibold text-amber-800 print:text-[10px]">
                  <span>Pending / Unposted</span>
                  <span className="flex h-6 w-6 items-center justify-center rounded-none bg-amber-100 text-amber-700 print:hidden">
                    <Clock className="h-3.5 w-3.5" />
                  </span>
                </div>
                <div className="mt-2 text-xl font-bold tabular-nums text-amber-700 print:mt-0.5 print:text-sm">
                  {formatCurrency(currentFinSummary.total_amount - currentFinSummary.posted_amount)}
                </div>
                <div className="mt-0.5 text-[11px] text-amber-600 print:text-[9px] print:mt-0">
                  {currentFinSummary.total_lines - currentFinSummary.posted_lines} unposted lines
                </div>
              </div>

              {/* Card 4: Unique Activities */}
              <div className="rounded-none border border-[#DDD6FE] bg-[#F5F3FF] p-3.5 shadow-xs print:p-2 print:rounded-none print:shadow-none print:border-slate-300">
                <div className="flex items-center justify-between text-xs font-semibold text-indigo-800 print:text-[10px]">
                  <span>Unique Activities</span>
                  <span className="flex h-6 w-6 items-center justify-center rounded-none bg-indigo-100 text-indigo-700 print:hidden">
                    <Layers className="h-3.5 w-3.5" />
                  </span>
                </div>
                <div className="mt-2 text-xl font-bold tabular-nums text-indigo-900 print:mt-0.5 print:text-sm">
                  {currentFinSummary.distinct_activities}
                </div>
                <div className="mt-0.5 text-[11px] text-indigo-700 print:text-[9px] print:mt-0">
                  SunSystems Dim 10
                </div>
              </div>

              {/* Card 5: Unique Accounts */}
              <div className="rounded-none border border-[#99F6E4] bg-[#F0FDFA] p-3.5 shadow-xs print:p-2 print:rounded-none print:shadow-none print:border-slate-300">
                <div className="flex items-center justify-between text-xs font-semibold text-teal-800 print:text-[10px]">
                  <span>GL Account Codes</span>
                  <span className="flex h-6 w-6 items-center justify-center rounded-none bg-teal-100 text-teal-700 print:hidden">
                    <Building2 className="h-3.5 w-3.5" />
                  </span>
                </div>
                <div className="mt-2 text-xl font-bold tabular-nums text-teal-900 print:mt-0.5 print:text-sm">
                  {currentFinSummary.distinct_accounts}
                </div>
                <div className="mt-0.5 text-[11px] text-teal-700 print:text-[9px] print:mt-0">
                  Chart of accounts
                </div>
              </div>

              {/* Card 6: Posting Rate */}
              <div className="rounded-none border border-[#BFDBFE] bg-[#EFF6FF] p-3.5 shadow-xs print:p-2 print:rounded-none print:shadow-none print:border-slate-300">
                <div className="flex items-center justify-between text-xs font-semibold text-blue-800 print:text-[10px]">
                  <span>Posting Rate</span>
                  <span className="flex h-6 w-6 items-center justify-center rounded-none bg-blue-100 text-blue-700 print:hidden">
                    <BarChart3 className="h-3.5 w-3.5" />
                  </span>
                </div>
                <div className="mt-2 text-xl font-bold tabular-nums text-blue-900 print:mt-0.5 print:text-sm">
                  {currentFinSummary.total_lines > 0
                    ? `${Math.round((currentFinSummary.posted_lines / currentFinSummary.total_lines) * 100)}%`
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

                {/* Date Range: Raised From / To */}
                <div className="flex items-center gap-1.5 text-xs text-[#475569] border border-[#CBD5E1] bg-white px-2.5 py-1 shadow-2xs">
                  <Calendar className="h-3.5 w-3.5 text-[#287EAD]" />
                  <span className="font-semibold text-[#0A4D68]">Raised:</span>
                  <input
                    type="date"
                    value={finStartDate}
                    onChange={(e) => {
                      setFinStartDate(e.target.value);
                      setFinPage(1);
                    }}
                    aria-label="Raised from date"
                    className="border-0 bg-transparent p-0 text-xs text-[#1E293B] focus:ring-0 focus:outline-hidden"
                    title="Filter requisitions raised on or after this date"
                  />
                  <span className="text-slate-400">to</span>
                  <input
                    type="date"
                    value={finEndDate}
                    onChange={(e) => {
                      setFinEndDate(e.target.value);
                      setFinPage(1);
                    }}
                    aria-label="Raised to date"
                    className="border-0 bg-transparent p-0 text-xs text-[#1E293B] focus:ring-0 focus:outline-hidden"
                    title="Filter requisitions raised on or before this date"
                  />
                  {(finStartDate || finEndDate) && (
                    <button
                      type="button"
                      onClick={() => {
                        setFinStartDate("");
                        setFinEndDate("");
                        setFinPage(1);
                      }}
                      className="text-slate-400 hover:text-slate-600 p-0.5 cursor-pointer"
                      title="Clear date filter"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  )}
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

                {/* Payment Voucher Only Filter Checkbox */}
                <label className="flex items-center gap-1.5 text-xs text-[#0A4D68] cursor-pointer select-none rounded-none bg-[#F0F8FD] border border-[#C5E6F5] px-2.5 py-1 hover:bg-[#E2F2FA] transition-colors">
                  <input
                    type="checkbox"
                    checked={finHasPaymentVoucher === true}
                    onChange={(e) => {
                      setFinHasPaymentVoucher(e.target.checked ? true : null);
                      setFinPage(1);
                    }}
                    className="rounded border-[#CBD5E1] text-[#287EAD] focus:ring-[#287EAD]"
                  />
                  <span className="font-semibold">With Payment Voucher (PV) only</span>
                </label>

                {/* Reset Filters */}
                {(finSearch || finStartDate || finEndDate || finAccountCode || finActivityCode || finDepartment || finStatus || finHasJournal !== null || finHasPaymentVoucher !== null) && (
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
                      setFinHasPaymentVoucher(null);
                      setFinPage(1);
                    }}
                    className="inline-flex items-center gap-1 text-xs font-semibold text-[#287EAD] hover:underline cursor-pointer"
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
                  {/* Column Customizer Dropdown */}
                  <div className="relative inline-flex" ref={finColDropdownRef}>
                    <button
                      type="button"
                      onClick={() => setFinColDropdownOpen((prev) => !prev)}
                      className={cn(
                        "inline-flex items-center gap-1.5 rounded-none border px-2.5 py-1 text-xs font-semibold shadow-2xs transition-colors cursor-pointer",
                        visibleFinCols.size < FINANCIAL_REPORT_COLUMNS.length
                          ? "border-[#287EAD] bg-[#F0F8FD] text-[#0A4D68]"
                          : "border-[#CBD5E1] bg-white text-[#475569] hover:bg-[#F8FAFC]"
                      )}
                      title="Customize visible columns for report and print"
                      aria-expanded={finColDropdownOpen}
                    >
                      <SlidersHorizontal className="h-3.5 w-3.5 text-[#287EAD]" />
                      <span>Columns</span>
                      <span className={cn(
                        "px-1.5 py-0.2 text-[10px] font-bold rounded-none",
                        visibleFinCols.size < FINANCIAL_REPORT_COLUMNS.length
                          ? "bg-[#287EAD] text-white"
                          : "bg-slate-100 text-slate-600"
                      )}>
                        {visibleFinCols.size}/{FINANCIAL_REPORT_COLUMNS.length}
                      </span>
                      <ChevronDown className="h-3 w-3 text-slate-400" />
                    </button>

                    {finColDropdownOpen && (
                      <div className="absolute right-0 top-full z-50 mt-1 w-64 rounded-none border border-[#E2E8F0] bg-white p-2.5 shadow-xl animate-in fade-in zoom-in-95 duration-100">
                        <div className="flex items-center justify-between pb-2 mb-2 border-b border-slate-100">
                          <span className="text-[11px] font-bold text-slate-700 uppercase tracking-wider">
                            Visible Columns
                          </span>
                          <div className="flex items-center gap-2">
                            <button
                              type="button"
                              onClick={selectAllFinCols}
                              className="text-[10px] font-semibold text-[#287EAD] hover:underline cursor-pointer"
                            >
                              All
                            </button>
                            <span className="text-slate-300">•</span>
                            <button
                              type="button"
                              onClick={resetFinCols}
                              className="text-[10px] font-semibold text-slate-500 hover:text-slate-700 cursor-pointer"
                            >
                              Reset
                            </button>
                          </div>
                        </div>

                        <div className="max-h-60 overflow-y-auto space-y-1 pr-1">
                          {FINANCIAL_REPORT_COLUMNS.map((col) => {
                            const isChecked = visibleFinCols.has(col.id);
                            return (
                              <label
                                key={col.id}
                                className={cn(
                                  "flex items-center justify-between rounded-none px-2 py-1.5 text-xs cursor-pointer transition-colors",
                                  isChecked ? "bg-[#F0F8FD] text-[#0A4D68]" : "hover:bg-slate-50 text-slate-600"
                                )}
                              >
                                <span className="font-medium">{col.label}</span>
                                <input
                                  type="checkbox"
                                  checked={isChecked}
                                  onChange={() => toggleFinCol(col.id)}
                                  className="h-3.5 w-3.5 rounded-none border-slate-300 text-[#287EAD] focus:ring-[#287EAD] cursor-pointer"
                                />
                              </label>
                            );
                          })}
                        </div>

                        <div className="mt-2 pt-2 border-t border-slate-100 flex items-center justify-between text-[10px] text-slate-500">
                          <span>{visibleFinCols.size} columns shown in report</span>
                          <button
                            type="button"
                            onClick={() => setFinColDropdownOpen(false)}
                            className="rounded-none px-2 py-0.5 font-semibold text-[#287EAD] hover:bg-[#F0F8FD] cursor-pointer"
                          >
                            Done
                          </button>
                        </div>
                      </div>
                    )}
                  </div>

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
                      buttonClassName="h-7 border-[#CBD5E1] bg-white text-xs rounded-none"
                    />
                  </div>
                </div>
              )}
            </div>

            {/* Sub-Tab 1: Detailed Financial Lines Table */}
            {financialTab === "lines" && (
              <div className="space-y-3">
                {/* Custom Selection Bar */}
                {matchingFinSelectedCount > 0 && (
                  <div className="flex flex-wrap items-center justify-between gap-3 rounded-none border border-[#C5E6F5] bg-[#F0F8FD] px-4 py-2.5 text-xs shadow-2xs print:hidden animate-in fade-in duration-150">
                    <div className="flex items-center gap-2.5">
                      <div className="flex h-7 w-7 items-center justify-center rounded-none bg-white border border-[#C5E6F5] text-[#287EAD]">
                        <CheckSquare className="h-4 w-4" />
                      </div>
                      <div>
                        <span className="font-bold text-[#0A4D68]">
                          {matchingFinSelectedCount} of {sortedFinancialLines.length} {matchingFinSelectedCount === 1 ? "line" : "lines"} selected
                        </span>
                        <span className="ml-2 text-slate-500 font-medium">
                          (Total: <span className="font-semibold text-slate-700">{formatCurrency(selectedFinSummary.total_amount)}</span>)
                        </span>
                        {visibleFinCols.size < FINANCIAL_REPORT_COLUMNS.length && (
                          <span className="ml-2 rounded-none bg-white/80 border border-[#C5E6F5] px-1.5 py-0.5 text-[10px] text-[#0A4D68] font-medium">
                            {visibleFinCols.size} columns active
                          </span>
                        )}
                      </div>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      {matchingFinSelectedCount < sortedFinancialLines.length && (
                        <button
                          type="button"
                          onClick={handleSelectAllFilteredFin}
                          className="rounded-none border border-[#C5E6F5] bg-white px-2.5 py-1 text-xs font-semibold text-[#0A4D68] hover:bg-[#E2F2FA] transition-colors cursor-pointer"
                        >
                          Select all {sortedFinancialLines.length} filtered lines
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={clearFinSelection}
                        className="rounded-none border border-slate-200 bg-white px-2.5 py-1 text-xs font-medium text-slate-600 hover:bg-slate-50 transition-colors cursor-pointer"
                      >
                        Clear selection
                      </button>
                      <button
                        type="button"
                        onClick={() => handlePrint("selected")}
                        className="inline-flex items-center gap-1.5 rounded-none border border-[#287EAD] bg-[#287EAD] px-3 py-1 text-xs font-semibold text-white shadow-2xs hover:bg-[#1E6F99] transition-colors cursor-pointer"
                      >
                        <Printer className="h-3.5 w-3.5" />
                        Print Selected ({matchingFinSelectedCount})
                      </button>
                      <button
                        type="button"
                        onClick={handleExportSelectedFinCsv}
                        className="inline-flex items-center gap-1 rounded-none border border-[#CBD5E1] bg-white px-2.5 py-1 text-xs font-semibold text-slate-700 hover:bg-slate-50 transition-colors cursor-pointer"
                      >
                        <Download className="h-3.5 w-3.5 text-slate-500" />
                        Export Selected
                      </button>
                    </div>
                  </div>
                )}

                <div className="rounded-xl border border-[#E2E8F0] bg-white shadow-xs overflow-hidden print:overflow-visible print:border-none print:shadow-none print:w-full">
                  <div className="overflow-x-auto print:overflow-visible print:w-full">
                    <table className="w-full border-collapse text-left text-xs print:text-[9.5px] print:w-full print:table-fixed">
                      <colgroup className="hidden print:table-column-group">
                        {activeFinColDefs.map((col) => {
                          const pct = Math.round((col.weight / finColTotalWeight) * 100);
                          return <col key={col.id} style={{ width: `${pct}%` }} />;
                        })}
                      </colgroup>
                      <thead>
                        <tr className="border-b border-[#E2E8F0] bg-[#F8FAFC] text-[11px] font-semibold text-[#475569] print:bg-slate-100 print:text-[9px]">
                          <th className="w-10 px-3 py-2.5 text-center print:hidden">
                            <label className="flex items-center justify-center cursor-pointer p-1 -m-1" title="Select / deselect all lines on this page">
                              <input
                                ref={finHeaderCheckboxRef}
                                type="checkbox"
                                aria-label="Select all lines on this page"
                                checked={allFinPageSelected}
                                onChange={toggleSelectAllFinOnPage}
                                className="h-4 w-4 rounded border-slate-300 text-[#287EAD] focus:ring-[#287EAD] cursor-pointer"
                              />
                            </label>
                          </th>
                          {visibleFinCols.has("document_reference") && (
                            <th className="py-2.5 px-3 print:py-1 print:px-1 cursor-pointer hover:text-[#1E293B]" onClick={() => handleFinSort("document_reference")}>
                              <div className="flex items-center gap-1">
                                <span>Req Ref</span>
                                <ArrowUpDown className="h-3 w-3 text-[#94A3B8] print:hidden" />
                              </div>
                            </th>
                          )}
                          {visibleFinCols.has("date") && (
                            <th className="py-2.5 px-3 print:py-1 print:px-1 cursor-pointer hover:text-[#1E293B]" onClick={() => handleFinSort("date")}>
                              <div className="flex items-center gap-1">
                                <span>Date</span>
                                <ArrowUpDown className="h-3 w-3 text-[#94A3B8] print:hidden" />
                              </div>
                            </th>
                          )}
                          {visibleFinCols.has("department_requester") && (
                            <th className="py-2.5 px-3 print:py-1 print:px-1">Dept / Requester</th>
                          )}
                          {visibleFinCols.has("activity_code") && (
                            <th className="py-2.5 px-3 print:py-1 print:px-1">Activity Code (Dim 10)</th>
                          )}
                          {visibleFinCols.has("description") && (
                            <th className="py-2.5 px-3 print:py-1 print:px-1">Description</th>
                          )}
                          {visibleFinCols.has("account_code") && (
                            <th className="py-2.5 px-3 print:py-1 print:px-1">Account Code</th>
                          )}
                          {visibleFinCols.has("cost_centre") && (
                            <th className="py-2.5 px-3 print:py-1 print:px-1">Cost Centre</th>
                          )}
                          {visibleFinCols.has("amount") && (
                            <th className="py-2.5 px-3 print:py-1 print:px-1 text-right cursor-pointer hover:text-[#1E293B]" onClick={() => handleFinSort("amount")}>
                              <div className="flex items-center justify-end gap-1">
                                <span>Amount</span>
                                <ArrowUpDown className="h-3 w-3 text-[#94A3B8] print:hidden" />
                              </div>
                            </th>
                          )}
                          {visibleFinCols.has("journal_number") && (
                            <th className="py-2.5 px-3 print:py-1 print:px-1">Journal #</th>
                          )}
                          {visibleFinCols.has("payment_voucher") && (
                            <th className="py-2.5 px-3 print:py-1 print:px-1">Payment Voucher (PV)</th>
                          )}
                          {visibleFinCols.has("document_status") && (
                            <th className="py-2.5 px-3 print:py-1 print:px-1">Status</th>
                          )}
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-[#F1F5F9]">
                        {isLoadingFinancial ? (
                          <tr>
                            <td colSpan={isPrinting ? visibleFinCols.size : visibleFinCols.size + 1} className="py-12 text-center text-xs text-[#64748B]">
                              <Loader2 className="mx-auto h-6 w-6 animate-spin text-[#287EAD]" />
                              <p className="mt-2 font-medium">Loading financial lines…</p>
                            </td>
                          </tr>
                        ) : displayedFinancialLines.length === 0 ? (
                          <tr>
                            <td colSpan={isPrinting ? visibleFinCols.size : visibleFinCols.size + 1} className="py-12 text-center text-xs text-[#64748B]">
                              <FileSpreadsheet className="mx-auto h-8 w-8 text-[#9AA5B1] mb-2" />
                              <p className="text-sm font-semibold text-[#1E293B]">No requisition lines found</p>
                              <p className="mt-1 text-xs text-[#64748B]">Try clearing your search or filter criteria.</p>
                            </td>
                          </tr>
                        ) : (
                          displayedFinancialLines.map((line) => {
                            const isSelected = selectedFinIds.has(line.id);
                            return (
                              <tr
                                key={line.id}
                                className={cn(
                                  "transition-colors print:break-inside-avoid",
                                  isSelected ? "bg-[#F0F8FD] hover:bg-[#E2F2FA]" : "hover:bg-[#F8FAFC]"
                                )}
                              >
                                <td className="w-10 px-3 py-2.5 text-center print:hidden">
                                  <label className="flex items-center justify-center cursor-pointer p-1 -m-1" title="Select row">
                                    <input
                                      type="checkbox"
                                      aria-label={`Select row ${line.document_reference}`}
                                      checked={isSelected}
                                      onChange={() => toggleSelectFinRow(line.id)}
                                      className="h-4 w-4 rounded border-slate-300 text-[#287EAD] focus:ring-[#287EAD] cursor-pointer"
                                    />
                                  </label>
                                </td>
                                {visibleFinCols.has("document_reference") && (
                                  <td className="py-2.5 px-3 print:py-1 print:px-1 font-semibold text-[#287EAD] whitespace-nowrap">
                                    <Link to={`/${line.document_id || line.id}`} className="hover:underline flex items-center gap-1">
                                      {line.document_reference}
                                      <ExternalLink className="h-3 w-3 text-[#94A3B8] print:hidden" />
                                    </Link>
                                  </td>
                                )}
                                {visibleFinCols.has("date") && (
                                  <td className="py-2.5 px-3 print:py-1 print:px-1 text-[#64748B] whitespace-nowrap">{line.date}</td>
                                )}
                                {visibleFinCols.has("department_requester") && (
                                  <td className="py-2.5 px-3 print:py-1 print:px-1">
                                    <div className="font-semibold text-[#1E293B] truncate">{line.department || "—"}</div>
                                    <div className="text-[10px] text-[#64748B] truncate print:text-[8.5px]">{line.requester}</div>
                                  </td>
                                )}
                                {visibleFinCols.has("activity_code") && (
                                  <td className="py-2.5 px-3 print:py-1 print:px-1">
                                    <span className="inline-flex items-center rounded bg-[#F0F8FD] border border-[#C5E6F5] px-2 py-0.5 text-[11px] font-mono font-semibold text-[#0A4D68] print:border-none print:bg-transparent print:px-0 print:py-0 print:text-[9px]">
                                      {line.activity_code}
                                    </span>
                                  </td>
                                )}
                                {visibleFinCols.has("description") && (
                                  <td className="py-2.5 px-3 print:py-1 print:px-1 max-w-xs truncate print:max-w-none print:whitespace-normal print:line-clamp-2" title={line.description}>
                                    {line.description}
                                  </td>
                                )}
                                {visibleFinCols.has("account_code") && (
                                  <td className="py-2.5 px-3 print:py-1 print:px-1">
                                    <span className="inline-flex items-center rounded bg-slate-100 px-2 py-0.5 text-[11px] font-mono font-semibold text-[#1E293B] print:bg-transparent print:px-0 print:py-0 print:text-[9px]">
                                      {line.account_code}
                                    </span>
                                  </td>
                                )}
                                {visibleFinCols.has("cost_centre") && (
                                  <td className="py-2.5 px-3 print:py-1 print:px-1 font-mono text-slate-600">{line.cost_centre || "—"}</td>
                                )}
                                {visibleFinCols.has("amount") && (
                                  <td className="py-2.5 px-3 print:py-1 print:px-1 text-right font-bold tabular-nums text-[#1E293B]">
                                    {formatCurrency(line.amount, line.currency)}
                                  </td>
                                )}
                                {visibleFinCols.has("journal_number") && (
                                  <td className="py-2.5 px-3 print:py-1 print:px-1 whitespace-nowrap print:whitespace-normal print:break-all">
                                    <JournalStatusBadge status={line.journal_status} journalNumber={line.journal_number} />
                                  </td>
                                )}
                                {visibleFinCols.has("payment_voucher") && (
                                  <td className="py-2.5 px-3 print:py-1 print:px-1 whitespace-nowrap">
                                    {line.payment_vouchers && line.payment_vouchers.length > 0 ? (
                                      <div className="flex flex-wrap items-center gap-1.5 print:hidden">
                                        {line.payment_vouchers.map((pv, idx) => (
                                          <button
                                            key={pv.id || `${pv.reference}-${idx}`}
                                            type="button"
                                            onClick={() => setPreviewVoucher({
                                              id: pv.id,
                                              reference: pv.reference,
                                              kind: pv.kind,
                                              requisitionId: line.document_id,
                                              requisitionRef: line.document_reference,
                                            })}
                                            title={`View ${pv.kind === "imprest" ? "DSA Imprest" : pv.kind === "retirement" ? "Retirement Claim" : ""} Payment Voucher (${pv.reference})`}
                                            className={cn(
                                              "inline-flex items-center gap-1 border px-2 py-0.5 text-[11px] font-mono font-bold cursor-pointer transition-colors",
                                              pv.kind === "imprest"
                                                ? "border-[#287EAD]/40 bg-[#C5E6F5]/40 text-[#0A4D68] hover:bg-[#C5E6F5] hover:border-[#287EAD]"
                                                : pv.kind === "retirement"
                                                  ? "border-indigo-300 bg-indigo-50/90 text-indigo-900 hover:bg-indigo-100 hover:border-indigo-500"
                                                  : "border-slate-300 bg-slate-50 text-slate-800 hover:bg-slate-100",
                                            )}
                                          >
                                            <span className="text-[9px] uppercase font-sans font-extrabold px-1 py-0.2 bg-white/70 text-slate-700">
                                              {pv.kind === "imprest" ? "DSA" : pv.kind === "retirement" ? "RET" : "PV"}
                                            </span>
                                            <span>{pv.reference}</span>
                                            <Eye className="h-2.5 w-2.5 opacity-70" />
                                          </button>
                                        ))}
                                      </div>
                                    ) : line.payment_voucher_reference && line.payment_voucher_reference !== "—" ? (
                                      line.payment_voucher_id ? (
                                        <button
                                          type="button"
                                          onClick={() => setPreviewVoucher({
                                            id: line.payment_voucher_id!,
                                            reference: line.payment_voucher_reference,
                                            requisitionId: line.document_id,
                                            requisitionRef: line.document_reference,
                                          })}
                                          title="View Payment Voucher"
                                          className="inline-flex items-center gap-1 border border-[#287EAD]/30 bg-[#C5E6F5]/40 px-2 py-0.5 text-[11px] font-mono font-bold text-[#0A4D68] hover:bg-[#C5E6F5] hover:border-[#287EAD] cursor-pointer transition-colors print:hidden"
                                        >
                                          <span>{line.payment_voucher_reference}</span>
                                          <Eye className="h-2.5 w-2.5 text-[#287EAD]" />
                                        </button>
                                      ) : (
                                        <span className="inline-flex items-center border border-[#287EAD]/30 bg-[#C5E6F5]/40 px-2 py-0.5 text-[11px] font-mono font-bold text-[#0A4D68] print:hidden">
                                          {line.payment_voucher_reference}
                                        </span>
                                      )
                                    ) : (
                                      <span className="text-slate-400 print:hidden">—</span>
                                    )}
                                    <span className="hidden print:inline text-[9px] font-mono">
                                      {line.payment_vouchers && line.payment_vouchers.length > 0
                                        ? line.payment_vouchers.map(pv => `${pv.kind === "imprest" ? "DSA:" : pv.kind === "retirement" ? "RET:" : ""}${pv.reference}`).join(", ")
                                        : (line.payment_voucher_reference || "—")}
                                    </span>
                                  </td>
                                )}
                                {visibleFinCols.has("document_status") && (
                                  <td className="py-2.5 px-3 print:py-1 print:px-1">
                                    <span className="inline-flex items-center rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-medium text-[#475569] print:bg-transparent print:px-0 print:text-[9px]">
                                      {line.document_status}
                                    </span>
                                  </td>
                                )}
                              </tr>
                            );
                          })
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
                    <span>
                      End of Report • {printScope === "selected" ? `${displayedFinancialLines.length} selected lines (of ${sortedFinancialLines.length})` : `${sortedFinancialLines.length} lines total`} • IDM Financial & Requisition Management System
                    </span>
                    <span>CONFIDENTIAL</span>
                  </div>
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
              <div className="rounded-xl border border-[#E2E8F0] bg-white p-4 shadow-xs print:break-inside-avoid print:border-none print:shadow-none">
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
              <div className="rounded-none border border-[#C5E6F5] bg-[#F0F8FD] p-3.5 shadow-xs print:p-2 print:rounded-none print:shadow-none print:border-slate-300">
                <div className="flex items-center justify-between text-xs font-semibold text-[#0A4D68] print:text-[10px]">
                  <span>Outstanding Balance</span>
                  <span className="flex h-6 w-6 items-center justify-center rounded-none bg-[#C5E6F5] text-[#287EAD] print:hidden">
                    <TrendingUp className="h-3.5 w-3.5" />
                  </span>
                </div>
                <div className="mt-2 text-xl font-bold tabular-nums text-[#1E293B] print:mt-0.5 print:text-sm">
                  {formatCurrency(currentRetSummary.total_outstanding_amount)}
                </div>
                <div className="mt-0.5 text-[11px] text-[#475569] print:text-[9px] print:mt-0">
                  Across {currentRetSummary.total_records} travel forms
                </div>
              </div>

              {/* Card 2: Overdue Retirements */}
              <div className="rounded-none border border-[#FECDD3] bg-[#FFF1F2] p-3.5 shadow-xs print:p-2 print:rounded-none print:shadow-none print:border-slate-300">
                <div className="flex items-center justify-between text-xs font-semibold text-rose-800 print:text-[10px]">
                  <span>Overdue Retirements</span>
                  <span className="flex h-6 w-6 items-center justify-center rounded-none bg-rose-100 text-rose-700 print:hidden">
                    <ShieldAlert className="h-3.5 w-3.5" />
                  </span>
                </div>
                <div className="mt-2 text-xl font-bold tabular-nums text-rose-700 print:mt-0.5 print:text-sm">
                  {currentRetSummary.total_overdue_records}
                </div>
                <div className="mt-0.5 text-[11px] font-medium text-rose-600 print:text-[9px] print:mt-0">
                  {formatCurrency(currentRetSummary.total_overdue_amount)} delinquent
                </div>
              </div>

              {/* Card 3: Average Aging */}
              <div className="rounded-none border border-[#FDE68A] bg-[#FFFBEB] p-3.5 shadow-xs print:p-2 print:rounded-none print:shadow-none print:border-slate-300">
                <div className="flex items-center justify-between text-xs font-semibold text-amber-800 print:text-[10px]">
                  <span>Avg. Aging (Overdue)</span>
                  <span className="flex h-6 w-6 items-center justify-center rounded-none bg-amber-100 text-amber-700 print:hidden">
                    <Clock className="h-3.5 w-3.5" />
                  </span>
                </div>
                <div className="mt-2 text-xl font-bold tabular-nums text-amber-800 print:mt-0.5 print:text-sm">
                  {currentRetSummary.average_days_aged} days
                </div>
                <div className="mt-0.5 text-[11px] text-amber-700 print:text-[9px] print:mt-0">
                  Past return grace period
                </div>
              </div>

              {/* Card 4: Awaiting Finance Review */}
              <div className="rounded-none border border-[#99F6E4] bg-[#F0FDFA] p-3.5 shadow-xs print:p-2 print:rounded-none print:shadow-none print:border-slate-300">
                <div className="flex items-center justify-between text-xs font-semibold text-teal-800 print:text-[10px]">
                  <span>Awaiting Finance</span>
                  <span className="flex h-6 w-6 items-center justify-center rounded-none bg-teal-100 text-teal-700 print:hidden">
                    <ClipboardList className="h-3.5 w-3.5" />
                  </span>
                </div>
                <div className="mt-2 text-xl font-bold tabular-nums text-teal-800 print:mt-0.5 print:text-sm">
                  {currentRetSummary.total_awaiting_finance}
                </div>
                <div className="mt-0.5 text-[11px] text-teal-700 print:text-[9px] print:mt-0">
                  Expense review in progress
                </div>
              </div>

              {/* Card 5: Total Advance Issued */}
              <div className="rounded-none border border-[#E2E8F0] bg-[#F8FAFC] p-3.5 shadow-xs print:p-2 print:rounded-none print:shadow-none print:border-slate-300">
                <div className="flex items-center justify-between text-xs font-semibold text-slate-700 print:text-[10px]">
                  <span>Total Advance Issued</span>
                  <span className="flex h-6 w-6 items-center justify-center rounded-none bg-slate-200 text-slate-700 print:hidden">
                    <Building2 className="h-3.5 w-3.5" />
                  </span>
                </div>
                <div className="mt-2 text-xl font-bold tabular-nums text-slate-800 print:mt-0.5 print:text-sm">
                  {formatCurrency(currentRetSummary.total_advance_amount)}
                </div>
                <div className="mt-0.5 text-[11px] text-slate-500 print:text-[9px] print:mt-0">
                  {formatCurrency(currentRetSummary.total_retired_amount)} expensed
                </div>
              </div>

              {/* Card 6: Current & Reconciled */}
              <div className="rounded-none border border-[#BBF7D0] bg-[#F0FDF4] p-3.5 shadow-xs print:p-2 print:rounded-none print:shadow-none print:border-slate-300">
                <div className="flex items-center justify-between text-xs font-semibold text-emerald-800 print:text-[10px]">
                  <span>Current / Not Due</span>
                  <span className="flex h-6 w-6 items-center justify-center rounded-none bg-emerald-100 text-emerald-700 print:hidden">
                    <CheckCircle2 className="h-3.5 w-3.5" />
                  </span>
                </div>
                <div className="mt-2 text-xl font-bold tabular-nums text-emerald-800 print:mt-0.5 print:text-sm">
                  {currentRetSummary.aging_totals["current"]?.count || 0}
                </div>
                <div className="mt-0.5 text-[11px] text-emerald-700 print:text-[9px] print:mt-0">
                  {currentRetSummary.total_reconciled} reconciled
                </div>
              </div>
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

                {/* Date Range: Raised From / To */}
                <div className="flex items-center gap-1.5 text-xs text-[#475569] border border-[#CBD5E1] bg-white px-2.5 py-1 shadow-2xs">
                  <Calendar className="h-3.5 w-3.5 text-[#287EAD]" />
                  <span className="font-semibold text-[#0A4D68]">Raised:</span>
                  <input
                    type="date"
                    value={retStartDate}
                    onChange={(e) => {
                      setRetStartDate(e.target.value);
                      setRetPage(1);
                    }}
                    aria-label="Raised from date"
                    className="border-0 bg-transparent p-0 text-xs text-[#1E293B] focus:ring-0 focus:outline-hidden"
                    title="Filter travel requisitions raised on or after this date"
                  />
                  <span className="text-slate-400">to</span>
                  <input
                    type="date"
                    value={retEndDate}
                    onChange={(e) => {
                      setRetEndDate(e.target.value);
                      setRetPage(1);
                    }}
                    aria-label="Raised to date"
                    className="border-0 bg-transparent p-0 text-xs text-[#1E293B] focus:ring-0 focus:outline-hidden"
                    title="Filter travel requisitions raised on or before this date"
                  />
                  {(retStartDate || retEndDate) && (
                    <button
                      type="button"
                      onClick={() => {
                        setRetStartDate("");
                        setRetEndDate("");
                        setRetPage(1);
                      }}
                      className="text-slate-400 hover:text-slate-600 p-0.5 cursor-pointer"
                      title="Clear date filter"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  )}
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

                {/* Payment Voucher Only Filter Checkbox */}
                <label className="flex items-center gap-1.5 text-xs text-[#0A4D68] cursor-pointer select-none rounded-none bg-[#F0F8FD] border border-[#C5E6F5] px-2.5 py-1 hover:bg-[#E2F2FA] transition-colors">
                  <input
                    type="checkbox"
                    checked={retHasPaymentVoucher === true}
                    onChange={(e) => {
                      setRetHasPaymentVoucher(e.target.checked ? true : null);
                      setRetPage(1);
                    }}
                    className="rounded border-[#CBD5E1] text-[#287EAD] focus:ring-[#287EAD]"
                  />
                  <span className="font-semibold">With Payment Voucher (PV) only</span>
                </label>

                {/* Reset Filters */}
                {(retSearch || retStartDate || retEndDate || retDepartment || retTraveller || retStatus || retAgingBucket !== "all" || retIncludeReconciled || retHasPaymentVoucher !== null) && (
                  <button
                    type="button"
                    onClick={() => {
                      setRetSearch("");
                      setRetStartDate("");
                      setRetEndDate("");
                      setRetDepartment("");
                      setRetTraveller("");
                      setRetStatus("");
                      setRetAgingBucket("all");
                      setRetIncludeReconciled(false);
                      setRetHasPaymentVoucher(null);
                      setRetPage(1);
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
                  {/* Column Customizer Dropdown */}
                  <div className="relative inline-flex" ref={retColDropdownRef}>
                    <button
                      type="button"
                      onClick={() => setRetColDropdownOpen((prev) => !prev)}
                      className={cn(
                        "inline-flex items-center gap-1.5 rounded-none border px-2.5 py-1 text-xs font-semibold shadow-2xs transition-colors cursor-pointer",
                        visibleRetCols.size < RETIREMENT_REPORT_COLUMNS.length
                          ? "border-[#287EAD] bg-[#F0F8FD] text-[#0A4D68]"
                          : "border-[#CBD5E1] bg-white text-[#475569] hover:bg-[#F8FAFC]"
                      )}
                      title="Customize visible columns for report and print"
                      aria-expanded={retColDropdownOpen}
                    >
                      <SlidersHorizontal className="h-3.5 w-3.5 text-[#287EAD]" />
                      <span>Columns</span>
                      <span className={cn(
                        "px-1.5 py-0.2 text-[10px] font-bold rounded-none",
                        visibleRetCols.size < RETIREMENT_REPORT_COLUMNS.length
                          ? "bg-[#287EAD] text-white"
                          : "bg-slate-100 text-slate-600"
                      )}>
                        {visibleRetCols.size}/{RETIREMENT_REPORT_COLUMNS.length}
                      </span>
                      <ChevronDown className="h-3 w-3 text-slate-400" />
                    </button>

                    {retColDropdownOpen && (
                      <div className="absolute right-0 top-full z-50 mt-1 w-64 rounded-none border border-[#E2E8F0] bg-white p-2.5 shadow-xl animate-in fade-in zoom-in-95 duration-100">
                        <div className="flex items-center justify-between pb-2 mb-2 border-b border-slate-100">
                          <span className="text-[11px] font-bold text-slate-700 uppercase tracking-wider">
                            Visible Columns
                          </span>
                          <div className="flex items-center gap-2">
                            <button
                              type="button"
                              onClick={selectAllRetCols}
                              className="text-[10px] font-semibold text-[#287EAD] hover:underline cursor-pointer"
                            >
                              All
                            </button>
                            <span className="text-slate-300">•</span>
                            <button
                              type="button"
                              onClick={resetRetCols}
                              className="text-[10px] font-semibold text-slate-500 hover:text-slate-700 cursor-pointer"
                            >
                              Reset
                            </button>
                          </div>
                        </div>

                        <div className="max-h-60 overflow-y-auto space-y-1 pr-1">
                          {RETIREMENT_REPORT_COLUMNS.map((col) => {
                            const isChecked = visibleRetCols.has(col.id);
                            return (
                              <label
                                key={col.id}
                                className={cn(
                                  "flex items-center justify-between rounded-none px-2 py-1.5 text-xs cursor-pointer transition-colors",
                                  isChecked ? "bg-[#F0F8FD] text-[#0A4D68]" : "hover:bg-slate-50 text-slate-600"
                                )}
                              >
                                <span className="font-medium">{col.label}</span>
                                <input
                                  type="checkbox"
                                  checked={isChecked}
                                  onChange={() => toggleRetCol(col.id)}
                                  className="h-3.5 w-3.5 rounded-none border-slate-300 text-[#287EAD] focus:ring-[#287EAD] cursor-pointer"
                                />
                              </label>
                            );
                          })}
                        </div>

                        <div className="mt-2 pt-2 border-t border-slate-100 flex items-center justify-between text-[10px] text-slate-500">
                          <span>{visibleRetCols.size} columns shown in report</span>
                          <button
                            type="button"
                            onClick={() => setRetColDropdownOpen(false)}
                            className="rounded-none px-2 py-0.5 font-semibold text-[#287EAD] hover:bg-[#F0F8FD] cursor-pointer"
                          >
                            Done
                          </button>
                        </div>
                      </div>
                    )}
                  </div>

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
                      buttonClassName="h-7 border-[#CBD5E1] bg-white text-xs rounded-none"
                    />
                  </div>
                </div>
              )}
            </div>

            {/* Sub-Tab 1: Aging Register Table */}
            {retirementsTab === "register" && (
              <div className="space-y-3">
                {/* Custom Selection Bar */}
                {matchingRetSelectedCount > 0 && (
                  <div className="flex flex-wrap items-center justify-between gap-3 rounded-none border border-[#C5E6F5] bg-[#F0F8FD] px-4 py-2.5 text-xs shadow-2xs print:hidden animate-in fade-in duration-150">
                    <div className="flex items-center gap-2.5">
                      <div className="flex h-7 w-7 items-center justify-center rounded-none bg-white border border-[#C5E6F5] text-[#287EAD]">
                        <CheckSquare className="h-4 w-4" />
                      </div>
                      <div>
                        <span className="font-bold text-[#0A4D68]">
                          {matchingRetSelectedCount} of {sortedRetirements.length} {matchingRetSelectedCount === 1 ? "record" : "records"} selected
                        </span>
                        <span className="ml-2 text-slate-500 font-medium">
                          (Outstanding: <span className="font-semibold text-slate-700">{formatCurrency(selectedRetSummary.total_outstanding_amount)}</span>)
                        </span>
                        {visibleRetCols.size < RETIREMENT_REPORT_COLUMNS.length && (
                          <span className="ml-2 rounded-none bg-white/80 border border-[#C5E6F5] px-1.5 py-0.5 text-[10px] text-[#0A4D68] font-medium">
                            {visibleRetCols.size} columns active
                          </span>
                        )}
                      </div>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      {matchingRetSelectedCount < sortedRetirements.length && (
                        <button
                          type="button"
                          onClick={handleSelectAllFilteredRet}
                          className="rounded-none border border-[#C5E6F5] bg-white px-2.5 py-1 text-xs font-semibold text-[#0A4D68] hover:bg-[#E2F2FA] transition-colors cursor-pointer"
                        >
                          Select all {sortedRetirements.length} filtered records
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={clearRetSelection}
                        className="rounded-none border border-slate-200 bg-white px-2.5 py-1 text-xs font-medium text-slate-600 hover:bg-slate-50 transition-colors cursor-pointer"
                      >
                        Clear selection
                      </button>
                      <button
                        type="button"
                        onClick={() => handlePrint("selected")}
                        className="inline-flex items-center gap-1.5 rounded-none border border-[#287EAD] bg-[#287EAD] px-3 py-1 text-xs font-semibold text-white shadow-2xs hover:bg-[#1E6F99] transition-colors cursor-pointer"
                      >
                        <Printer className="h-3.5 w-3.5" />
                        Print Selected ({matchingRetSelectedCount})
                      </button>
                      <button
                        type="button"
                        onClick={handleExportSelectedRetCsv}
                        className="inline-flex items-center gap-1 rounded-none border border-[#CBD5E1] bg-white px-2.5 py-1 text-xs font-semibold text-slate-700 hover:bg-slate-50 transition-colors cursor-pointer"
                      >
                        <Download className="h-3.5 w-3.5 text-slate-500" />
                        Export Selected
                      </button>
                    </div>
                  </div>
                )}

                <div className="rounded-xl border border-[#E2E8F0] bg-white shadow-xs overflow-hidden print:overflow-visible print:border-none print:shadow-none print:w-full">
                  <div className="overflow-x-auto print:overflow-visible print:w-full">
                    <table className="w-full border-collapse text-left text-xs print:text-[9.5px] print:w-full print:table-fixed">
                      <colgroup className="hidden print:table-column-group">
                        {activeRetColDefs.map((col) => {
                          const pct = Math.round((col.weight / retColTotalWeight) * 100);
                          return <col key={col.id} style={{ width: `${pct}%` }} />;
                        })}
                      </colgroup>
                      <thead>
                        <tr className="border-b border-[#E2E8F0] bg-[#F8FAFC] text-[11px] font-semibold text-[#475569] print:bg-slate-100 print:text-[9px]">
                          <th className="w-10 px-3 py-2.5 text-center print:hidden">
                            <label className="flex items-center justify-center cursor-pointer p-1 -m-1" title="Select / deselect all retirements on this page">
                              <input
                                ref={retHeaderCheckboxRef}
                                type="checkbox"
                                aria-label="Select all retirements on this page"
                                checked={allRetPageSelected}
                                onChange={toggleSelectAllRetOnPage}
                                className="h-4 w-4 rounded border-slate-300 text-[#287EAD] focus:ring-[#287EAD] cursor-pointer"
                              />
                            </label>
                          </th>
                          {visibleRetCols.has("document_reference") && (
                            <th className="py-2.5 px-3 print:py-1 print:px-1 cursor-pointer hover:text-[#1E293B]" onClick={() => handleRetSort("document_reference")}>
                              <div className="flex items-center gap-1">
                                <span>Req Ref</span>
                                <ArrowUpDown className="h-3 w-3 text-[#94A3B8] print:hidden" />
                              </div>
                            </th>
                          )}
                          {visibleRetCols.has("traveller_name") && (
                            <th className="py-2.5 px-3 print:py-1 print:px-1 cursor-pointer hover:text-[#1E293B]" onClick={() => handleRetSort("traveller_name")}>
                              <div className="flex items-center gap-1">
                                <span>Traveller</span>
                                <ArrowUpDown className="h-3 w-3 text-[#94A3B8] print:hidden" />
                              </div>
                            </th>
                          )}
                          {visibleRetCols.has("department") && (
                            <th className="py-2.5 px-3 print:py-1 print:px-1">Department</th>
                          )}
                          {visibleRetCols.has("travel_dates") && (
                            <th className="py-2.5 px-3 print:py-1 print:px-1">Travel Dates</th>
                          )}
                          {visibleRetCols.has("due_date") && (
                            <th className="py-2.5 px-3 print:py-1 print:px-1 cursor-pointer hover:text-[#1E293B]" onClick={() => handleRetSort("due_date")}>
                              <div className="flex items-center gap-1">
                                <span>Due Date</span>
                                <ArrowUpDown className="h-3 w-3 text-[#94A3B8] print:hidden" />
                              </div>
                            </th>
                          )}
                          {visibleRetCols.has("aging_status") && (
                            <th className="py-2.5 px-3 print:py-1 print:px-1 cursor-pointer hover:text-[#1E293B]" onClick={() => handleRetSort("days_overdue")}>
                              <div className="flex items-center gap-1">
                                <span>Aging Status</span>
                                <ArrowUpDown className="h-3 w-3 text-[#94A3B8] print:hidden" />
                              </div>
                            </th>
                          )}
                          {visibleRetCols.has("advance_amount") && (
                            <th className="py-2.5 px-3 print:py-1 print:px-1 text-right cursor-pointer hover:text-[#1E293B]" onClick={() => handleRetSort("advance_amount")}>
                              <div className="flex items-center justify-end gap-1">
                                <span>Advance</span>
                                <ArrowUpDown className="h-3 w-3 text-[#94A3B8] print:hidden" />
                              </div>
                            </th>
                          )}
                          {visibleRetCols.has("retired_amount") && (
                            <th className="py-2.5 px-3 print:py-1 print:px-1 text-right">Retired / Spent</th>
                          )}
                          {visibleRetCols.has("outstanding_amount") && (
                            <th className="py-2.5 px-3 print:py-1 print:px-1 text-right cursor-pointer hover:text-[#1E293B]" onClick={() => handleRetSort("outstanding_amount")}>
                              <div className="flex items-center justify-end gap-1">
                                <span>Outstanding</span>
                                <ArrowUpDown className="h-3 w-3 text-[#94A3B8] print:hidden" />
                              </div>
                            </th>
                          )}
                          {visibleRetCols.has("payment_voucher") && (
                            <th className="py-2.5 px-3 print:py-1 print:px-1">Payment Voucher (PV)</th>
                          )}
                          {visibleRetCols.has("workflow_state") && (
                            <th className="py-2.5 px-3 print:py-1 print:px-1">Workflow State</th>
                          )}
                          <th className="py-2.5 px-3 text-center print:hidden">Action</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-[#F1F5F9]">
                        {isLoadingRetirements ? (
                          <tr>
                            <td colSpan={isPrinting ? visibleRetCols.size : visibleRetCols.size + 2} className="py-12 text-center text-xs text-[#64748B]">
                              <Loader2 className="mx-auto h-6 w-6 animate-spin text-[#287EAD]" />
                              <p className="mt-2 font-medium">Analyzing outstanding travel retirements…</p>
                            </td>
                          </tr>
                        ) : displayedRetirements.length === 0 ? (
                          <tr>
                            <td colSpan={isPrinting ? visibleRetCols.size : visibleRetCols.size + 2} className="py-12 text-center text-xs text-[#64748B]">
                              <CheckCircle2 className="mx-auto h-8 w-8 text-emerald-500 mb-2" />
                              <p className="text-sm font-semibold text-[#1E293B]">No outstanding retirements found</p>
                              <p className="mt-1 text-xs text-[#64748B]">
                                All travel advances have been retired or match the selected filters.
                              </p>
                            </td>
                          </tr>
                        ) : (
                          displayedRetirements.map((line) => {
                            const isSelected = selectedRetIds.has(line.id);
                            return (
                              <tr
                                key={line.id}
                                className={cn(
                                  "transition-colors print:break-inside-avoid",
                                  isSelected ? "bg-[#F0F8FD] hover:bg-[#E2F2FA]" : "hover:bg-[#F8FAFC]"
                                )}
                              >
                                <td className="w-10 px-3 py-2.5 text-center print:hidden">
                                  <label className="flex items-center justify-center cursor-pointer p-1 -m-1" title="Select retirement record">
                                    <input
                                      type="checkbox"
                                      aria-label={`Select retirement ${line.document_reference}`}
                                      checked={isSelected}
                                      onChange={() => toggleSelectRetRow(line.id)}
                                      className="h-4 w-4 rounded border-slate-300 text-[#287EAD] focus:ring-[#287EAD] cursor-pointer"
                                    />
                                  </label>
                                </td>
                                {visibleRetCols.has("document_reference") && (
                                  <td className="py-2.5 px-3 print:py-1 print:px-1 font-semibold text-[#287EAD] whitespace-nowrap">
                                    <Link
                                      to={`/${line.document_id || line.id}`}
                                      className="hover:underline flex items-center gap-1"
                                    >
                                      {line.document_reference}
                                      <ExternalLink className="h-3 w-3 text-[#94A3B8] print:hidden" />
                                    </Link>
                                  </td>
                                )}

                                {visibleRetCols.has("traveller_name") && (
                                  <td className="py-2.5 px-3 print:py-1 print:px-1">
                                    <div className="font-semibold text-[#1E293B] truncate">{line.traveller_name}</div>
                                    {line.traveller_email && (
                                      <div className="text-[10px] text-[#64748B] truncate print:text-[8.5px]">{line.traveller_email}</div>
                                    )}
                                  </td>
                                )}

                                {visibleRetCols.has("department") && (
                                  <td className="py-2.5 px-3 print:py-1 print:px-1">
                                    <span className="inline-flex items-center rounded-md bg-[#F1F5F9] px-2 py-0.5 text-[11px] font-medium text-[#475569] print:bg-transparent print:px-0 print:py-0 print:text-[9px]">
                                      {line.department}
                                    </span>
                                  </td>
                                )}

                                {visibleRetCols.has("travel_dates") && (
                                  <td className="py-2.5 px-3 print:py-1 print:px-1 text-[#475569] whitespace-nowrap">
                                    <div>{formatDateDisplay(line.departure_date)}</div>
                                    <div className="text-[10px] text-[#94A3B8] print:text-[8.5px]">Ret: {formatDateDisplay(line.return_date)}</div>
                                  </td>
                                )}

                                {visibleRetCols.has("due_date") && (
                                  <td className="py-2.5 px-3 print:py-1 print:px-1 whitespace-nowrap">
                                    <div className={cn(
                                      "font-medium",
                                      line.days_overdue > 0 ? "text-rose-700 font-bold" : "text-[#475569]",
                                    )}>
                                      {formatDateDisplay(line.due_date)}
                                    </div>
                                  </td>
                                )}

                                {visibleRetCols.has("aging_status") && (
                                  <td className="py-2.5 px-3 print:py-1 print:px-1 whitespace-nowrap">
                                    <AgingBadge
                                      bucket={line.aging_bucket}
                                      label={line.aging_bucket_label}
                                      days={line.days_overdue}
                                    />
                                  </td>
                                )}

                                {visibleRetCols.has("advance_amount") && (
                                  <td className="py-2.5 px-3 print:py-1 print:px-1 text-right font-medium tabular-nums text-[#475569]">
                                    {formatCurrency(line.advance_amount, line.currency)}
                                  </td>
                                )}

                                {visibleRetCols.has("retired_amount") && (
                                  <td className="py-2.5 px-3 print:py-1 print:px-1 text-right tabular-nums text-[#64748B]">
                                    {line.retired_amount > 0 ? formatCurrency(line.retired_amount, line.currency) : "—"}
                                  </td>
                                )}

                                {visibleRetCols.has("outstanding_amount") && (
                                  <td className="py-2.5 px-3 print:py-1 print:px-1 text-right font-bold tabular-nums text-[#1E293B]">
                                    <span className={cn(
                                      line.outstanding_amount > 0 && line.days_overdue > 0 ? "text-rose-700" : "text-[#1E293B]",
                                    )}>
                                      {formatCurrency(line.outstanding_amount, line.currency)}
                                    </span>
                                  </td>
                                )}

                                {visibleRetCols.has("payment_voucher") && (
                                  <td className="py-2.5 px-3 print:py-1 print:px-1 whitespace-nowrap">
                                    {line.payment_vouchers && line.payment_vouchers.length > 0 ? (
                                      <div className="flex flex-wrap items-center gap-1.5 print:hidden">
                                        {line.payment_vouchers.map((pv, idx) => (
                                          <button
                                            key={pv.id || `${pv.reference}-${idx}`}
                                            type="button"
                                            onClick={() => setPreviewVoucher({
                                              id: pv.id,
                                              reference: pv.reference,
                                              kind: pv.kind,
                                              requisitionId: line.document_id,
                                              requisitionRef: line.document_reference,
                                            })}
                                            title={`View ${pv.kind === "imprest" ? "DSA Imprest" : pv.kind === "retirement" ? "Retirement Claim" : ""} Payment Voucher (${pv.reference})`}
                                            className={cn(
                                              "inline-flex items-center gap-1 border px-2 py-0.5 text-[11px] font-mono font-bold cursor-pointer transition-colors",
                                              pv.kind === "imprest"
                                                ? "border-[#287EAD]/40 bg-[#C5E6F5]/40 text-[#0A4D68] hover:bg-[#C5E6F5] hover:border-[#287EAD]"
                                                : pv.kind === "retirement"
                                                  ? "border-indigo-300 bg-indigo-50/90 text-indigo-900 hover:bg-indigo-100 hover:border-indigo-500"
                                                  : "border-slate-300 bg-slate-50 text-slate-800 hover:bg-slate-100",
                                            )}
                                          >
                                            <span className="text-[9px] uppercase font-sans font-extrabold px-1 py-0.2 bg-white/70 text-slate-700">
                                              {pv.kind === "imprest" ? "DSA" : pv.kind === "retirement" ? "RET" : "PV"}
                                            </span>
                                            <span>{pv.reference}</span>
                                            <Eye className="h-2.5 w-2.5 opacity-70" />
                                          </button>
                                        ))}
                                      </div>
                                    ) : line.payment_voucher_reference && line.payment_voucher_reference !== "—" ? (
                                      line.payment_voucher_id ? (
                                        <button
                                          type="button"
                                          onClick={() => setPreviewVoucher({
                                            id: line.payment_voucher_id!,
                                            reference: line.payment_voucher_reference,
                                            requisitionId: line.document_id,
                                            requisitionRef: line.document_reference,
                                          })}
                                          title="View Payment Voucher"
                                          className="inline-flex items-center gap-1 border border-[#287EAD]/30 bg-[#C5E6F5]/40 px-2 py-0.5 text-[11px] font-mono font-bold text-[#0A4D68] hover:bg-[#C5E6F5] hover:border-[#287EAD] cursor-pointer transition-colors print:hidden"
                                        >
                                          <span>{line.payment_voucher_reference}</span>
                                          <Eye className="h-2.5 w-2.5 text-[#287EAD]" />
                                        </button>
                                      ) : (
                                        <span className="inline-flex items-center border border-[#287EAD]/30 bg-[#C5E6F5]/40 px-2 py-0.5 text-[11px] font-mono font-bold text-[#0A4D68] print:hidden">
                                          {line.payment_voucher_reference}
                                        </span>
                                      )
                                    ) : (
                                      <span className="text-slate-400 print:hidden">—</span>
                                    )}
                                    <span className="hidden print:inline text-[9px] font-mono">
                                      {line.payment_vouchers && line.payment_vouchers.length > 0
                                        ? line.payment_vouchers.map(pv => `${pv.kind === "imprest" ? "DSA:" : pv.kind === "retirement" ? "RET:" : ""}${pv.reference}`).join(", ")
                                        : (line.payment_voucher_reference || "—")}
                                    </span>
                                  </td>
                                )}

                                {visibleRetCols.has("workflow_state") && (
                                  <td className="py-2.5 px-3 print:py-1 print:px-1 whitespace-nowrap">
                                    <span className="text-[11px] text-[#475569] font-medium print:text-[9px]">
                                      {line.retirement_status_label}
                                    </span>
                                  </td>
                                )}

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
                            );
                          })
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
                    <span>
                      End of Report • {printScope === "selected" ? `${displayedRetirements.length} selected records (of ${sortedRetirements.length})` : `${sortedRetirements.length} retirement records total`} • IDM Financial & Requisition Management System
                    </span>
                    <span>CONFIDENTIAL</span>
                  </div>
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
              <div className="grid grid-cols-1 gap-4 lg:grid-cols-2 print:grid-cols-2">
                {/* Chart 1: Outstanding Balance by Aging Bucket */}
                <div className="rounded-xl border border-[#E2E8F0] bg-white p-4 shadow-xs print:break-inside-avoid print:border-none print:shadow-none">
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
                <div className="rounded-xl border border-[#E2E8F0] bg-white p-4 shadow-xs print:break-inside-avoid print:border-none print:shadow-none">
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
          <div className="w-full max-w-md rounded-none border border-[#C5E6F5] bg-white shadow-xl overflow-hidden">
            <div className="border-b border-[#C5E6F5] bg-[#F0F8FD] px-5 py-4 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className="flex h-7 w-7 items-center justify-center rounded-none bg-[#C5E6F5] text-[#287EAD]">
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
              {isLoadingSchedule && (
                <p className="rounded-none border border-slate-200 bg-slate-50 p-2 text-slate-600">Loading saved schedule…</p>
              )}
              {scheduleLoadFailed && (
                <p className="rounded-none border border-rose-200 bg-rose-50 p-2 text-rose-700">
                  Scheduled delivery can only be managed by an administrator.
                </p>
              )}
              {savedSchedule?.last_sent_on && (
                <p className="text-[11px] text-[#64748B]">Last sent: {formatDateDisplay(savedSchedule.last_sent_on)}</p>
              )}
              <label className="flex items-center gap-2 rounded-none border border-[#C5E6F5] bg-[#F0F8FD] p-3 font-semibold text-[#0A4D68]">
                <input
                  type="checkbox"
                  checked={scheduleEnabled}
                  onChange={(event) => setScheduleEnabled(event.target.checked)}
                  className="rounded-none border-slate-300 text-[#287EAD] focus:ring-[#287EAD]"
                />
                Enable automated delivery
              </label>
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
                        "rounded-none border px-3 py-2 text-center font-semibold capitalize transition-all cursor-pointer",
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

              <div className="rounded-none bg-slate-50 border border-slate-200 p-3 text-[11px] text-[#475569] space-y-1">
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
                disabled={scheduleSendingTest || scheduleLoadFailed}
                className="inline-flex items-center gap-1.5 rounded-none border border-[#CBD5E1] bg-white px-3 py-1.5 text-xs font-semibold text-[#334155] shadow-2xs hover:bg-[#F8FAFC] disabled:opacity-60 cursor-pointer"
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
                  className="rounded-none px-3 py-1.5 text-xs font-semibold text-[#64748B] hover:text-[#1E293B] cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={() => void handleSaveSchedule()}
                  disabled={scheduleSaving || isLoadingSchedule || scheduleLoadFailed}
                  className="inline-flex items-center gap-1.5 rounded-none bg-[#287EAD] px-4 py-1.5 text-xs font-semibold text-white shadow-xs hover:bg-[#1E6F99] cursor-pointer disabled:opacity-60 disabled:cursor-not-allowed"
                >
                  {scheduleSaving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
                  {scheduleSaving ? "Saving…" : "Save Schedule"}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
      {previewVoucher && (
        <PaymentVoucherPreviewModal
          voucherId={previewVoucher.id}
          reference={previewVoucher.reference}
          kind={previewVoucher.kind}
          requisitionId={previewVoucher.requisitionId}
          requisitionRef={previewVoucher.requisitionRef}
          onClose={() => setPreviewVoucher(null)}
        />
      )}
    </div>
  );
}
