/**
 * FormsPage
 *
 * Dedicated landing page for "Forms" (built-template documents filled in-app —
 * imprest requests, retirements, etc.) — separated out from the generic
 * Documents area per the July 2026 forms rework.
 *
 * This revision fixes three bugs from the previous pass:
 *
 *   1. Stat cards (and the status chips) were computed from `allRows`, which
 *      is only the CURRENT PAGE of the paginated table query (PAGE_SIZE=25).
 *      Any pending-approval or ready-for-retirement form sitting on page 2+
 *      simply never got counted — "doesn't recognise pending approvals" was
 *      this, not a logic bug in isPendingApproval itself. Fixed by adding a
 *      separate, unpaginated "stats pool" query (`page_size: 500`, no
 *      status/search filter) that the cards/chips/filter-option lists are
 *      now computed from, independent of the table's own pagination. 500 is
 *      a practical cap, not a real fix — once forms comfortably exceed that,
 *      ask the backend for a real `/forms/summary/`-style aggregate endpoint
 *      instead of computing this client-side at all.
 *
 *   2. "Ready for retirement" also matched `builder_workflow_phase ===
 *      "retirement" && status === "approved"` in addition to
 *      `can_submit_retirement`. That phase+status combo isn't unique to
 *      "awaiting retirement submission" — it also matches a retirement
 *      that's already been submitted-and-approved (fully closed out), so it
 *      double-counted. `can_submit_retirement` is the backend's own,
 *      already-correct answer to "is this specific thing true right now" —
 *      trust it alone.
 *
 *   3. There are two distinct approval stages per form — request and
 *      retirement (see builder_workflow_phase) — but the old "All document
 *      types" filter offered document TYPES, which is useless here (every
 *      form is document type Imprest). Replaced with a "Request / Retirement"
 *      form-stage filter, since that's the distinction that actually varies
 *      form-to-form. The "Pending Approval" card/count is now scoped to the
 *      REQUEST stage only, to stay a distinct, non-overlapping number from
 *      the Ready-for-Retirement card (a request-stage-pending form is never
 *      also ready for retirement, and vice versa).
 *
 * Other notes carried over from pass 1 (still true):
 *   - `documentsAPI.list({ is_form: true, ... })` — `is_form` isn't a real
 *     backend filter yet; this page also filters client-side on
 *     `metadata.form.sections` as a safety net regardless.
 *   - "Over/Under expenditure" (retirement variance) reads
 *     `metadata.form.retirement_variance`, which the backend doesn't
 *     populate yet — pending the shared apps/sunsystems mapping/posting
 *     files. Renders "—" until then.
 *   - RBAC relies entirely on the backend's existing document-list scoping.
 */

import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { extractApiError } from "@/lib/apiError";
import { documentsAPI } from "@/services/api";
import { format } from "date-fns";
import { cn } from "@/lib/utils";
import {
  Plus, Search as SearchIcon, Eye, X, TrendingUp, TrendingDown, FileWarning,
  ClipboardCheck, Wallet, FileStack,
} from "lucide-react";
import CustomListbox from "@/components/ui/CustomListbox";
import StatusBadge from "@/components/documents/StatusBadge";
import { StatCard } from "@/components/dashboard/StatCard";
import NewFormModal from "@/components/templates/FormUploadPage";

// ── Local helpers ─────────────────────────────────────────────────────────────

const PAGE_SIZE = 25;
// The pool used ONLY for stat cards / chip counts / filter-option lists, kept
// independent of the table's own pagination (see fix #1 above). Not a true
// "fetch everything" — a practical cap until there's a real backend summary.
const STATS_POOL_SIZE = 500;

const STATUS_CHIPS: { value: string; label: string }[] = [
  { value: "", label: "All" },
  { value: "draft", label: "Draft" },
  { value: "pending_approval", label: "Pending approval" },
  { value: "returned", label: "Returned" },
  { value: "approved", label: "Approved" },
  { value: "rejected", label: "Rejected" },
  { value: "archived", label: "Archived" },
];

const PHASE_OPTIONS: { value: string; label: string }[] = [
  { value: "", label: "All form types" },
  { value: "request", label: "Imprest Request" },
  { value: "retirement", label: "Imprest Retirement" },
];

function isFormDocument(doc: any): boolean {
  return Boolean(doc?.metadata?.form?.sections);
}

function getFormValues(doc: any): Record<string, unknown> {
  return doc?.metadata?.form?.values ?? {};
}

const DESCRIPTION_KEYS = ["description", "purpose", "purpose_of_travel", "reason", "details", "activity"];
function getFormDescription(doc: any): string {
  const values = getFormValues(doc);
  for (const key of DESCRIPTION_KEYS) {
    const v = values[key];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return doc.description || "—";
}

// Same field precedence DashboardPage.getDocumentDepartmentName() already
// uses — kept identical so "department" means the same thing everywhere.
function getFormDepartment(doc: any): string {
  return doc?.department_name || doc?.uploaded_by_department_name || doc?.uploaded_by?.department_name || "—";
}

function getFormRequester(doc: any): string {
  return doc?.uploaded_by?.full_name || doc?.uploaded_by?.email || doc?.owned_by?.full_name || "—";
}

function getFormAmount(doc: any): number | null {
  const amt = Number(doc?.amount);
  if (Number.isFinite(amt) && amt > 0) return amt;
  const values = getFormValues(doc);
  const alt = Number((values as any)?.amount ?? (values as any)?.total ?? (values as any)?.total_amount);
  return Number.isFinite(alt) && alt > 0 ? alt : null;
}

/** Imprest retirement variance — see backend TODO note at the top of this
 * file. Reads a field the backend doesn't populate yet; stays "—" until then. */
function getFormVariance(doc: any): { amount: number; kind: "over" | "under" } | null {
  const v = doc?.metadata?.form?.retirement_variance;
  if (!v || typeof v !== "object") return null;
  const amount = Number(v.amount);
  if (!Number.isFinite(amount) || amount === 0) return null;
  return { amount: Math.abs(amount), kind: v.kind === "under" || amount < 0 ? "under" : "over" };
}

// A form has exactly two approval stages — request and retirement — tracked
// by builder_workflow_phase. Absent/undefined means it hasn't reached the
// retirement stage yet, i.e. it's still a "request" form.
function getFormPhase(doc: any): "request" | "retirement" {
  return doc?.builder_workflow_phase === "retirement" ? "retirement" : "request";
}

// The backend already computes exactly this ("can this document's retirement
// be submitted right now") — trust it alone. Layering on a
// phase+status guess double-counted retirements that were already submitted
// (and therefore no longer "ready" to submit).
function isReadyForRetirement(doc: any): boolean {
  return Boolean(doc.can_submit_retirement);
}

// Pending-approval, REQUEST STAGE ONLY — kept disjoint from "ready for
// retirement" and from a retirement that's itself pending approval, so the
// three stat cards never overlap.
const REQUEST_PENDING_STATUSES = ["pending_approval", "request_pending", "on_hold"];
function isPendingRequestApproval(doc: any): boolean {
  if (getFormPhase(doc) === "retirement") return false;
  const step = doc.builder_process_step || doc.status;
  return REQUEST_PENDING_STATUSES.includes(step);
}

function formatMoney(amount: number | null, currency?: string) {
  if (amount === null) return "—";
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency: currency || "KES" }).format(amount);
  } catch {
    return `${currency ?? ""} ${amount.toLocaleString()}`.trim();
  }
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function FormsPage() {
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [phaseFilter, setPhaseFilter] = useState("");
  const [departmentFilter, setDepartmentFilter] = useState("");
  const [requesterFilter, setRequesterFilter] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [amountMin, setAmountMin] = useState("");
  const [amountMax, setAmountMax] = useState("");
  const [page, setPage] = useState(1);
  const [showNewFormModal, setShowNewFormModal] = useState(false);

  // ── Table query — paginated, respects the server-side filters ─────────────
  const { data, isLoading, error } = useQuery({
    queryKey: ["forms", "list", { search, statusFilter, page }],
    queryFn: () =>
      documentsAPI.list({
        is_form: true,
        search: search || undefined,
        status: statusFilter || undefined,
        ordering: "-created_at",
        page,
        page_size: PAGE_SIZE,
      }).then((r) => r.data),
    staleTime: 15_000,
  });

  const allRows = useMemo(() => {
    const results = (data?.results ?? []) as any[];
    return results.filter(isFormDocument);
  }, [data]);

  // ── Stats pool — a separate, larger, unfiltered fetch used ONLY for the
  // stat cards, status chip counts, and department/requester option lists.
  // Independent of the table's pagination/status filter/search — see fix #1
  // in the file header for why that separation matters.
  const { data: statsData } = useQuery({
    queryKey: ["forms", "stats-pool"],
    queryFn: () =>
      documentsAPI.list({
        is_form: true,
        ordering: "-created_at",
        page: 1,
        page_size: STATS_POOL_SIZE,
      }).then((r) => r.data),
    staleTime: 30_000,
  });
  const statsRows = useMemo(() => {
    const results = (statsData?.results ?? []) as any[];
    return results.filter(isFormDocument);
  }, [statsData]);

  const departmentOptions = useMemo(
    () => Array.from(new Set(statsRows.map(getFormDepartment).filter((d) => d !== "—"))).sort((a, b) => a.localeCompare(b)),
    [statsRows],
  );
  const requesterOptions = useMemo(() => {
    const map = new Map<string, string>();
    statsRows.forEach((doc) => {
      const id = doc.uploaded_by?.id;
      if (id) map.set(id, getFormRequester(doc));
    });
    return Array.from(map.entries());
  }, [statsRows]);

  const filteredRows = useMemo(() => {
    return allRows.filter((doc) => {
      if (phaseFilter && getFormPhase(doc) !== phaseFilter) return false;
      if (departmentFilter && getFormDepartment(doc) !== departmentFilter) return false;
      if (requesterFilter && doc.uploaded_by?.id !== requesterFilter) return false;
      if (dateFrom && new Date(doc.document_date || doc.created_at) < new Date(dateFrom)) return false;
      if (dateTo && new Date(doc.document_date || doc.created_at) > new Date(dateTo)) return false;
      const amt = getFormAmount(doc);
      if (amountMin && (amt === null || amt < Number(amountMin))) return false;
      if (amountMax && (amt === null || amt > Number(amountMax))) return false;
      return true;
    });
  }, [allRows, phaseFilter, departmentFilter, requesterFilter, dateFrom, dateTo, amountMin, amountMax]);

  // Status chip counts — from the stats pool, not the paginated table.
  const statusCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const chip of STATUS_CHIPS) {
      counts[chip.value] = chip.value ? statsRows.filter((d) => d.status === chip.value).length : statsRows.length;
    }
    return counts;
  }, [statsRows]);

  // Stat cards — also from the stats pool. "Total forms" prefers the
  // server's own matching count (true total, not capped by STATS_POOL_SIZE)
  // and falls back to what we actually fetched if that's ever missing.
  const totalFormsCount = statsData?.count ?? statsRows.length;
  const pendingCount = useMemo(() => statsRows.filter(isPendingRequestApproval).length, [statsRows]);
  const readyForRetirementCount = useMemo(() => statsRows.filter(isReadyForRetirement).length, [statsRows]);

  const activeFilterCount = [statusFilter, phaseFilter, departmentFilter, requesterFilter, dateFrom, dateTo, amountMin, amountMax]
    .filter(Boolean).length;

  const clearFilters = () => {
    setSearch(""); setStatusFilter(""); setPhaseFilter(""); setDepartmentFilter("");
    setRequesterFilter(""); setDateFrom(""); setDateTo(""); setAmountMin(""); setAmountMax("");
    setPage(1);
  };

  return (
    <div className="mx-auto max-w-[1400px] space-y-5 p-6">
      {/* ── Header ── */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-[#1F2933]">Forms</h1>
          <p className="mt-1 text-sm text-[#5E6870]">Imprest, retirement, and other in-app forms — separate from general documents.</p>
        </div>
        <button
          type="button"
          onClick={() => setShowNewFormModal(true)}
          className="inline-flex items-center gap-2 bg-[#287EAD] px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-[#1E6F99]"
        >
          <Plus className="h-4 w-4" /> New Form
        </button>
      </div>

      {/* ── Stat cards ── */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <StatCard
          title="Total Forms"
          value={totalFormsCount}
          icon={FileStack}
          color="primary"
          href="#"
        />
        <StatCard
          title="Pending Approval"
          value={pendingCount}
          icon={ClipboardCheck}
          color="accent"
          href="#"
        />
        <StatCard
          title="Ready for Retirement"
          value={readyForRetirementCount}
          icon={Wallet}
          color="teal"
          href="#"
        />
      </div>

      {/* ── Filters ── */}
      <div className="space-y-3 border border-[#C8CDD2] bg-white p-4">
        {/* Status quick filters */}
        <div className="flex flex-wrap items-center gap-1.5">
          {STATUS_CHIPS.map((chip) => (
            <button
              key={chip.value || "all"}
              type="button"
              onClick={() => { setStatusFilter(chip.value); setPage(1); }}
              className={cn(
                "inline-flex items-center gap-1.5 border px-2.5 py-1 text-xs font-semibold transition-colors",
                statusFilter === chip.value
                  ? "border-[#287EAD] bg-[#EEF6FB] text-[#287EAD]"
                  : "border-[#C8CDD2] bg-white text-[#5E6870] hover:border-[#287EAD]/50 hover:text-[#1F2933]",
              )}
            >
              {chip.label}
              <span className={cn(
                "px-1.5 py-0.5 text-[10px] font-bold",
                statusFilter === chip.value ? "bg-[#287EAD] text-white" : "bg-[#F0F2F4] text-[#5E6870]",
              )}>
                {statusCounts[chip.value] ?? 0}
              </span>
            </button>
          ))}
        </div>

        <div className="flex flex-wrap items-center gap-3 border-t border-[#EEF0F2] pt-3">
          <div className="relative min-w-[220px] max-w-[320px] flex-1">
            <SearchIcon className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[#5E6870]" />
            <input
              value={search}
              onChange={(e) => { setSearch(e.target.value); setPage(1); }}
              placeholder="Search forms by title…"
              className="h-9 w-full border border-[#AEB5BB] bg-white pl-9 pr-3 text-sm text-[#1F2933] placeholder:text-[#8C969E] focus:outline-none focus:ring-1 focus:ring-[#287EAD]"
            />
          </div>
          <CustomListbox
            value={phaseFilter}
            onChange={setPhaseFilter}
            options={PHASE_OPTIONS}
            buttonClassName="h-9 w-[190px] border border-[#AEB5BB] bg-white px-2 text-sm text-[#1F2933]"
            ariaLabel="Form type filter"
          />
          <CustomListbox
            value={departmentFilter}
            onChange={setDepartmentFilter}
            options={[{ value: "", label: "All departments" }, ...departmentOptions.map((d) => ({ value: d, label: d }))]}
            buttonClassName="h-9 w-[170px] border border-[#AEB5BB] bg-white px-2 text-sm text-[#1F2933]"
            ariaLabel="Department filter"
          />
          <CustomListbox
            value={requesterFilter}
            onChange={setRequesterFilter}
            options={[{ value: "", label: "All requesters" }, ...requesterOptions.map(([id, name]) => ({ value: id, label: name }))]}
            buttonClassName="h-9 w-[180px] border border-[#AEB5BB] bg-white px-2 text-sm text-[#1F2933]"
            ariaLabel="Requester filter"
          />
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-1.5 text-xs text-[#5E6870]">
            From
            <input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)}
              className="h-8 border border-[#AEB5BB] bg-white px-2 text-xs text-[#1F2933]" />
          </label>
          <label className="flex items-center gap-1.5 text-xs text-[#5E6870]">
            To
            <input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)}
              className="h-8 border border-[#AEB5BB] bg-white px-2 text-xs text-[#1F2933]" />
          </label>
          <label className="flex items-center gap-1.5 text-xs text-[#5E6870]">
            Amount min
            <input type="number" value={amountMin} onChange={(e) => setAmountMin(e.target.value)}
              className="h-8 w-24 border border-[#AEB5BB] bg-white px-2 text-xs text-[#1F2933]" />
          </label>
          <label className="flex items-center gap-1.5 text-xs text-[#5E6870]">
            Amount max
            <input type="number" value={amountMax} onChange={(e) => setAmountMax(e.target.value)}
              className="h-8 w-24 border border-[#AEB5BB] bg-white px-2 text-xs text-[#1F2933]" />
          </label>
          {activeFilterCount > 0 && (
            <button type="button" onClick={clearFilters}
              className="inline-flex items-center gap-1 text-xs font-semibold text-[#287EAD] hover:text-[#1E6F99]">
              <X className="h-3.5 w-3.5" /> Clear filters ({activeFilterCount})
            </button>
          )}
          <span className="ml-auto text-xs text-[#5E6870]">
            {isLoading ? "Loading…" : `${filteredRows.length} of ${allRows.length} loaded forms`}
          </span>
        </div>
      </div>

      {/* ── Summary report table ── */}
      <div className="overflow-hidden border border-[#C8CDD2] bg-white">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[1100px] text-sm">
            <thead>
              <tr className="border-b border-[#AEB5BB] bg-[#50545A] text-left text-xs font-semibold text-white">
                <th className="border-r border-[#858A90] px-3 py-3">Reference</th>
                <th className="border-r border-[#858A90] px-3 py-3">Requester</th>
                <th className="border-r border-[#858A90] px-3 py-3">Department</th>
                <th className="border-r border-[#858A90] px-3 py-3">Description</th>
                <th className="border-r border-[#858A90] px-3 py-3">Date</th>
                <th className="border-r border-[#858A90] px-3 py-3">Amount</th>
                <th className="border-r border-[#858A90] px-3 py-3">Approval status</th>
                <th className="border-r border-[#858A90] px-3 py-3">Variance</th>
                <th className="w-16 px-3 py-3">View</th>
              </tr>
            </thead>
            <tbody>
              {isLoading ? (
                Array.from({ length: 6 }).map((_, i) => (
                  <tr key={i} className="h-[44px] border-b border-[#D3D7DA]">
                    {Array.from({ length: 9 }).map((__, j) => (
                      <td key={j} className="border-r border-[#D3D7DA] px-3">
                        <div className="h-3 w-2/3 animate-pulse bg-[#E1E5E8]" />
                      </td>
                    ))}
                  </tr>
                ))
              ) : error ? (
                <tr>
                  <td colSpan={9} className="py-16 text-center text-red-600">
                    {extractApiError(error, "Could not load forms.")}
                  </td>
                </tr>
              ) : filteredRows.length === 0 ? (
                <tr>
                  <td colSpan={9} className="py-20 text-center text-[#5E6870]">
                    <FileWarning className="mx-auto mb-3 h-10 w-10 text-[#AEB5BB]" />
                    No forms match the current filters.
                  </td>
                </tr>
              ) : (
                filteredRows.map((doc) => {
                  const variance = getFormVariance(doc);
                  const amount = getFormAmount(doc);
                  return (
                    <tr key={doc.id} className="h-[46px] border-b border-[#D3D7DA] bg-white hover:bg-[#F5F7F8]">
                      <td className="border-r border-[#D3D7DA] px-3">
                        <Link to={`/forms/${doc.id}`} className="font-mono text-xs font-semibold text-[#2B86C5] hover:underline">
                          {doc.reference_number}
                        </Link>
                      </td>
                      <td className="border-r border-[#D3D7DA] px-3">{getFormRequester(doc)}</td>
                      <td className="border-r border-[#D3D7DA] px-3">{getFormDepartment(doc)}</td>
                      <td className="max-w-[240px] truncate border-r border-[#D3D7DA] px-3" title={getFormDescription(doc)}>
                        {getFormDescription(doc)}
                      </td>
                      <td className="border-r border-[#D3D7DA] px-3 whitespace-nowrap">
                        {format(new Date(doc.document_date || doc.created_at), "dd MMM yyyy")}
                      </td>
                      <td className="border-r border-[#D3D7DA] px-3 font-mono">{formatMoney(amount, doc.currency)}</td>
                      <td className="border-r border-[#D3D7DA] px-3"><StatusBadge status={doc.status} /></td>
                      <td className="border-r border-[#D3D7DA] px-3">
                        {variance ? (
                          <span className={cn(
                            "inline-flex items-center gap-1 px-1.5 py-0.5 text-[11px] font-semibold",
                            variance.kind === "over" ? "bg-red-50 text-red-700" : "bg-amber-50 text-amber-700",
                          )}>
                            {variance.kind === "over" ? <TrendingUp className="h-3 w-3" /> : <TrendingDown className="h-3 w-3" />}
                            {variance.kind === "over" ? "Over" : "Under"} {formatMoney(variance.amount, doc.currency)}
                          </span>
                        ) : (
                          <span className="text-[#AEB5BB]">—</span>
                        )}
                      </td>
                      <td className="px-3">
                        <Link to={`/forms/${doc.id}`} className="inline-flex items-center gap-1 font-semibold text-[#2B86C5] hover:underline">
                          <Eye className="h-3.5 w-3.5" /> View
                        </Link>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>

        {data && data.count > PAGE_SIZE && (
          <div className="flex items-center justify-between border-t border-[#C8CDD2] bg-[#F5F7F8] px-4 py-2.5 text-xs text-[#5E6870]">
            <span>
              Page {page} of {Math.max(1, Math.ceil(data.count / PAGE_SIZE))} · {data.count.toLocaleString()} total forms on server
              (filters above narrow what's already loaded on this page — status/search are sent server-side, the rest filter client-side).
            </span>
            <div className="flex items-center gap-2">
              <button onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page === 1}
                className="border border-[#C8CDD2] bg-white px-3 py-1 disabled:opacity-40">Previous</button>
              <button onClick={() => setPage((p) => p + 1)} disabled={page * PAGE_SIZE >= data.count}
                className="border border-[#C8CDD2] bg-white px-3 py-1 disabled:opacity-40">Next</button>
            </div>
          </div>
        )}
      </div>

      {showNewFormModal && <NewFormModal onClose={() => setShowNewFormModal(false)} />}
    </div>
  );
}