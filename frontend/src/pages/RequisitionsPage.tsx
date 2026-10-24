/**
 * RequisitionsPage
 *
 * Requisition register — single pool query (same pattern as FormsPage):
 * every filter (search, status, department, requester, date, amount) runs
 * client-side against one STATS_POOL_SIZE-capped fetch, then paginates
 * client-side. Scoped build: the only form type is the dedicated requisition
 * form from the template editor.
 */
import { useEffect, useMemo, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { formatDistanceToNow } from "date-fns";
import { Plus, Search as SearchIcon, X, ClipboardList, Loader2, FileText } from "lucide-react";
import { documentsAPI, sunsystemsAPI } from "@/services/api";
import CustomListbox from "@/components/ui/CustomListbox";
import { cn } from "@/lib/utils";
import { getReqAmount, getReqSupplier } from "@/lib/requisitionFields";
import { useAuthStore } from "@/store/authStore";

const PAGE_SIZE = 10;
const STATS_POOL_SIZE = 500;

const STATUS_CHIPS = [
  { value: "", label: "All" },
  { value: "draft", label: "Draft" },
  { value: "pending_approval", label: "Pending approval" },
  { value: "approved", label: "Approved" },
  { value: "rejected", label: "Rejected" },
  { value: "archived", label: "Archived" },
];

function getReqDepartment(doc: any): string {
  return doc?.department_name || doc?.uploaded_by_department_name || doc?.uploaded_by?.department_name || "—";
}

function getLpoDocuments(doc: any): Array<{ id: string; reference?: string }> {
  const form = doc?.metadata?.form;
  if (Array.isArray(form?.lpo_documents)) return form.lpo_documents;
  return form?.lpo_document_id
    ? [{ id: form.lpo_document_id, reference: form.lpo_reference }]
    : [];
}

function hasPendingApproval(doc: any): boolean {
  const status = String(doc?.status || "").toLowerCase();
  return Boolean(doc?.has_pending_approval)
    || ["pending_approval", "request_pending", "on_hold"].includes(status);
}

function statusPresentation(doc: any): { label: string; className: string } {
  const key = String(doc?.status || "unknown").toLowerCase();
  const labels: Record<string, string> = {
    pending_approval: "Pending approval",
    request_pending: "Imprest request pending",
    on_hold: "On hold",
    pending_review: "Pending review",
    approved: "Approved",
    rejected: "Rejected",
    draft: "Draft",
    returned: "Returned",
    archived: "Archived",
  };
  const colors: Record<string, string> = {
    pending_approval: "text-amber-700",
    request_pending: "text-amber-700",
    on_hold: "text-amber-700",
    pending_review: "text-amber-700",
    approved: "text-emerald-700",
    rejected: "text-rose-700",
    returned: "text-amber-700",
    archived: "text-sky-700",
  };
  return {
    label: labels[key] || key.replace(/_/g, " ").replace(/\b\w/g, (char) => char.toUpperCase()),
    className: colors[key] || "text-[#5E6870]",
  };
}

function getRetirementOutcome(doc: any): { label: string; status: "exact" | "under" | "over"; amount: number | null } | null {
  const retirementStatus = doc?.form_summary?.retirement?.status;
  const variance = doc?.form_summary?.retirement_variance
    ?? doc?.metadata?.form?.retirement_variance;
  const scenario = String(variance?.scenario || "").toLowerCase();
  const parsedAmount = Number(variance?.amount);
  const amount = Number.isFinite(parsedAmount) ? Math.abs(parsedAmount) : null;
  if (scenario === "exact" || retirementStatus === "exact") return { label: "Exact", status: "exact", amount: amount ?? 0 };
  if (scenario === "under" || retirementStatus === "refund_due") return { label: "Under expenditure", status: "under", amount };
  if (scenario === "over" || retirementStatus === "top_up_due") return { label: "Over expenditure", status: "over", amount };
  return null;
}

function formatMoney(amount: number | null, currency?: string) {
  if (amount === null) return "—";
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency: currency || "KES", maximumFractionDigits: 0 }).format(amount);
  } catch {
    return `${currency ?? ""} ${amount.toLocaleString()}`.trim();
  }
}

function formatVariance(amount: number, currency?: string) {
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency: currency || "KES", maximumFractionDigits: 2 }).format(amount);
  } catch {
    return `${currency ?? ""} ${amount.toLocaleString(undefined, { maximumFractionDigits: 2 })}`.trim();
  }
}

export default function RequisitionsPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const openLpoFor = (location.state as { openLpoFor?: string } | null)?.openLpoFor;
  const user = useAuthStore((s) => s.user);
  const showDepartmentColumn = Boolean(user?.has_admin_access || (user?.group_names ?? []).includes("HOD"));
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [departmentFilter, setDepartmentFilter] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [amountMin, setAmountMin] = useState("");
  const [amountMax, setAmountMax] = useState("");
  const [page, setPage] = useState(1);

  const { data: poolData, isLoading } = useQuery({
    queryKey: ["requisitions", "pool"],
    queryFn: () =>
      documentsAPI.list({
        is_form: true,
        requisition_summary: true,
        ordering: "-created_at",
        page: 1,
        page_size: STATS_POOL_SIZE,
      }).then((r) => r.data),
    staleTime: 15_000,
    refetchInterval: openLpoFor ? 1_200 : false,
  });

  const { data: supplierAccounts } = useQuery({
    queryKey: ["sunsystems", "supplier-accounts"],
    queryFn: () => sunsystemsAPI.getAccounts({ account_type: "1" })
      .then((res) => (Array.isArray(res.data?.accounts) ? res.data.accounts : []))
      .catch(() => []),
    staleTime: 5 * 60_000,
    retry: false,
  });

  const poolRows = useMemo(() => {
    const results = ((poolData?.results ?? []) as any[]).filter((d) => Boolean(d?.metadata?.form?.sections));
    return results;
  }, [poolData]);

  useEffect(() => {
    if (!openLpoFor) return;
    const target = poolRows.find((doc: any) => doc.id === openLpoFor);
    const lpos = getLpoDocuments(target);
    if (target && lpos.length) {
      navigate(`/${target.id}`, {
        replace: true,
        state: { selectedLpoId: lpos[0].id },
      });
    }
  }, [openLpoFor, poolRows, navigate]);

  useEffect(() => {
    if (!openLpoFor) return;
    const timeout = window.setTimeout(() => {
      navigate("/list", { replace: true, state: null });
    }, 15_000);
    return () => window.clearTimeout(timeout);
  }, [openLpoFor, navigate]);

  const departmentOptions = useMemo(
    () =>
      Array.from(
        new Set(
          poolRows
            .map((d) => d?.department_name || d?.uploaded_by_department_name || d?.uploaded_by?.department_name)
            .filter(Boolean)
        )
      ).sort((a: string, b: string) => a.localeCompare(b)) as string[],
    [poolRows]
  );

  const filteredRows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return poolRows.filter((doc) => {
      if (q) {
        const title = String(doc.title || "").toLowerCase();
        const ref = String(doc.reference_number || "").toLowerCase();
        const supplier = getReqSupplier(doc, supplierAccounts).toLowerCase();
        if (!title.includes(q) && !ref.includes(q) && !supplier.includes(q)) return false;
      }
      if (statusFilter === "pending_approval") {
        if (!hasPendingApproval(doc)) return false;
      } else if (statusFilter && doc.status !== statusFilter) {
        return false;
      }
      if (departmentFilter) {
        const dept = doc?.department_name || doc?.uploaded_by_department_name || doc?.uploaded_by?.department_name;
        if (dept !== departmentFilter) return false;
      }
      if (dateFrom && new Date(doc.created_at) < new Date(dateFrom)) return false;
      if (dateTo && new Date(doc.created_at) > new Date(dateTo)) return false;
      const amt = getReqAmount(doc);
      if (amountMin && (amt === null || amt < Number(amountMin))) return false;
      if (amountMax && (amt === null || amt > Number(amountMax))) return false;
      return true;
    });
  }, [poolRows, search, statusFilter, departmentFilter, dateFrom, dateTo, amountMin, amountMax, supplierAccounts]);

  useEffect(() => {
    setPage(1);
  }, [search, statusFilter, departmentFilter, dateFrom, dateTo, amountMin, amountMax]);

  useEffect(() => {
    const requestedStatus = new URLSearchParams(location.search).get("status") || "";
    if (STATUS_CHIPS.some((chip) => chip.value === requestedStatus)) {
      setStatusFilter(requestedStatus);
    }
  }, [location.search]);

  const totalPages = Math.max(1, Math.ceil(filteredRows.length / PAGE_SIZE));
  const pageRows = useMemo(() => {
    const start = (page - 1) * PAGE_SIZE;
    return filteredRows.slice(start, start + PAGE_SIZE);
  }, [filteredRows, page]);

  const statusCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const chip of STATUS_CHIPS) {
      counts[chip.value] = !chip.value
        ? poolRows.length
        : chip.value === "pending_approval"
          ? poolRows.filter(hasPendingApproval).length
          : poolRows.filter((d) => d.status === chip.value).length;
    }
    return counts;
  }, [poolRows]);

  const activeFilterCount = [statusFilter, departmentFilter, dateFrom, dateTo, amountMin, amountMax].filter(Boolean).length;

  const clearFilters = () => {
    setSearch(""); setStatusFilter(""); setDepartmentFilter("");
    setDateFrom(""); setDateTo(""); setAmountMin(""); setAmountMax("");
    setPage(1);
  };

  return (
    <div className="mx-auto max-w-[1500px] space-y-6 p-5 lg:p-8">

      {/* ── Header ── */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-3">
          <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-[#EAF3F8] text-[#287EAD]">
            <ClipboardList className="h-6 w-6" />
          </div>
          <div>
            <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-[#287EAD]">Procurement</p>
            <h1 className="mt-0.5 text-2xl font-bold tracking-tight text-[#1F2933]">Requisitions</h1>
            <p className="mt-0.5 text-sm text-[#6E767D]">Review requests, approval progress, and purchase orders.</p>
          </div>
        </div>
        <button
          type="button"
          onClick={() => navigate("/new")}
          className="inline-flex h-10 items-center justify-center gap-2 rounded-lg bg-[#287EAD] px-4 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-[#1E6F99]"
        >
          <Plus className="h-4 w-4" /> New Requisition
        </button>
      </div>

      {/* ── Status chips ── */}
      <div className="flex flex-wrap items-center gap-2">
        {STATUS_CHIPS.map((chip) => (
          <button
            key={chip.value}
            type="button"
            onClick={() => setStatusFilter(chip.value)}
            className={cn(
              "inline-flex items-center gap-2 border px-3 py-1.5 text-xs font-semibold transition-colors",
              statusFilter === chip.value
                ? "border-[#287EAD] bg-[#287EAD] text-white"
                : "border-[#C8CDD2] bg-white text-[#5E6870] hover:border-[#287EAD] hover:text-[#287EAD]"
            )}
          >
            {chip.label}
            <span className={cn(
              "px-1.5 text-[10px] font-bold tabular-nums",
              statusFilter === chip.value ? "text-white/75" : "text-[#8C969E]"
            )}>
              {statusCounts[chip.value] ?? 0}
            </span>
          </button>
        ))}
      </div>

      {/* ── Filter bar ── */}
      <div className="flex flex-wrap items-center gap-2.5 rounded-xl border border-[#E3E8EC] bg-white p-3 shadow-sm">
        <div className="relative min-w-[240px] flex-1">
          <SearchIcon className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[#9AA5B1]" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search title, reference, supplier…"
            className="w-full rounded-md border border-[#D6DDE2] py-2 pl-9 pr-3 text-sm placeholder:text-[#9AA5B1] focus:border-[#287EAD] focus:outline-none focus:ring-2 focus:ring-[#287EAD]/10"
          />
        </div>
        <CustomListbox
          value={departmentFilter}
          onChange={setDepartmentFilter}
          options={[
            { value: "", label: "All departments" },
            ...departmentOptions.map((department) => ({ value: department, label: department })),
          ]}
          className="min-w-[180px]"
          buttonClassName="w-full rounded-md border border-[#D6DDE2] bg-white px-3 py-2 text-left text-sm text-[#1F2933]"
          ariaLabel="Filter by department"
        />
        <input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} aria-label="Created from" className="rounded-md border border-[#D6DDE2] px-3 py-2 text-sm text-[#5E6870] focus:border-[#287EAD] focus:outline-none" />
        <input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} aria-label="Created to" className="rounded-md border border-[#D6DDE2] px-3 py-2 text-sm text-[#5E6870] focus:border-[#287EAD] focus:outline-none" />
        <input value={amountMin} onChange={(e) => setAmountMin(e.target.value)} placeholder="Min amount" inputMode="numeric" className="w-32 rounded-md border border-[#D6DDE2] px-3 py-2 text-sm placeholder:text-[#9AA5B1] focus:border-[#287EAD] focus:outline-none" />
        <input value={amountMax} onChange={(e) => setAmountMax(e.target.value)} placeholder="Max amount" inputMode="numeric" className="w-32 rounded-md border border-[#D6DDE2] px-3 py-2 text-sm placeholder:text-[#9AA5B1] focus:border-[#287EAD] focus:outline-none" />
        {activeFilterCount > 0 && (
          <button type="button" onClick={clearFilters} className="inline-flex items-center gap-1 rounded-md px-2 py-2 text-xs font-medium text-rose-600 hover:bg-rose-50">
            <X className="h-3.5 w-3.5" /> Clear ({activeFilterCount})
          </button>
        )}
      </div>

      {/* ── Table ── */}
      <div className="overflow-x-auto rounded-xl border border-[#E3E8EC] bg-white shadow-sm">
        {isLoading ? (
          <div className="flex h-48 items-center justify-center">
            <Loader2 className="h-6 w-6 animate-spin text-[#287EAD]" />
          </div>
        ) : pageRows.length === 0 ? (
          <div className="flex h-48 flex-col items-center justify-center gap-3 text-center">
            <ClipboardList className="h-8 w-8 text-[#C1C7CD]" />
            <p className="text-sm text-[#5E6870]">No requisitions match the current filters.</p>
          </div>
        ) : (
          <table className="w-full min-w-[1080px] text-left text-sm">
            <thead>
              <tr className="border-b border-[#E3E8EC] bg-[#F7F9FA] text-[10px] font-bold uppercase tracking-wider text-[#6E767D]">
                <th className="px-4 py-3">#</th>
                <th className="px-4 py-3">Requisition</th>
                <th className="px-4 py-3">Supplier</th>
                <th className="px-4 py-3">Requester</th>
                {showDepartmentColumn && <th className="px-4 py-3">Department</th>}
                <th className="px-4 py-3 text-right">Amount</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3">Retirement</th>
                <th className="px-4 py-3">Outcome</th>
                <th className="px-4 py-3">LPO</th>
                <th className="px-4 py-3">Created</th>
              </tr>
            </thead>
            <tbody>
              {pageRows.map((doc: any, i: number) => (
                <tr
                  key={doc.id}
                  className="cursor-pointer border-b border-[#EEF1F3] last:border-0 transition-colors hover:bg-[#F7FAFC]"
                  onClick={() => navigate(`/${doc.id}`)}
                >
                  <td className="px-4 py-3 text-xs tabular-nums text-[#9AA5B1]">{(page - 1) * PAGE_SIZE + i + 1}</td>
                  <td className="px-4 py-3">
                    <span className="font-semibold text-[#1F2933]">{doc.reference_number || "—"}</span>
                    <span className="mt-0.5 block max-w-[230px] truncate text-[11px] font-normal text-[#8A949C]">{doc.title || "Purchase requisition"}</span>
                  </td>
                  <td className="px-4 py-3 text-xs text-[#5E6870]">{getReqSupplier(doc, supplierAccounts)}</td>
                  <td className="px-4 py-3 text-xs text-[#5E6870]">
                    {doc.uploaded_by?.full_name || doc.uploaded_by?.email || "—"}
                  </td>
                  {showDepartmentColumn && <td className="px-4 py-3 text-xs text-[#5E6870]">{getReqDepartment(doc)}</td>}
                  <td className="px-4 py-3 text-right font-mono text-xs font-semibold tabular-nums text-[#1F2933]">{formatMoney(getReqAmount(doc), doc.currency)}</td>
                  <td className="px-4 py-3">
                    {(() => {
                      const status = statusPresentation(doc);
                      return <span className={cn("text-xs font-semibold", status.className)}>{status.label}</span>;
                    })()}
                  </td>

                  {/* Travel retirement status */}
                  <td className="px-4 py-3">
                    {doc.form_summary?.retirement ? (
                      <span className={cn(
                        "text-[11px] font-semibold",
                        doc.form_summary.retirement.status === "overdue" || doc.form_summary.retirement.status === "top_up_due"
                          ? "text-red-700"
                          : doc.form_summary.retirement.status === "refund_due"
                            ? "text-amber-700"
                            : doc.form_summary.retirement.status === "exact"
                              ? "text-emerald-700"
                              : "text-[#5E6870]",
                      )} title={doc.form_summary.retirement.due_date ? `Due ${doc.form_summary.retirement.due_date}` : undefined}>
                        {doc.form_summary.retirement.label}
                      </span>
                    ) : <span className="text-[#C8CDD2]">—</span>}
                  </td>

                  {/* Retirement outcome */}
                  <td className="px-4 py-3">
                    {(() => {
                      const outcome = getRetirementOutcome(doc);
                      if (!outcome) return <span className="text-[#C8CDD2]">—</span>;
                      return (
                        <span className={cn(
                          "text-[11px] font-semibold",
                          outcome.status === "exact"
                            ? "text-emerald-700"
                            : outcome.status === "over"
                              ? "text-red-700"
                              : "text-amber-700",
                        )}>
                          {outcome.amount === null
                            ? outcome.label
                            : `${outcome.label} · ${formatVariance(outcome.amount, doc.currency)}`}
                        </span>
                      );
                    })()}
                  </td>

                  {/* LPO chips */}
                  <td className="px-4 py-3">
                    <div className="flex flex-wrap gap-1">
                      {getLpoDocuments(doc).map((lpo, index) => (
                        <button
                          key={lpo.id}
                          type="button"
                          title={`Open purchase order ${lpo.reference || index + 1}`}
                          onClick={(event) => {
                            event.stopPropagation();
                            navigate(`/${doc.id}`, { state: { selectedLpoId: lpo.id } });
                          }}
                          className="inline-flex items-center gap-1 border border-[#A7CDE3] bg-[#EEF6FB] px-2 py-0.5 text-[11px] font-semibold text-[#206D99] hover:bg-[#DDEFF9] transition-colors"
                        >
                          <FileText className="h-2.5 w-2.5" /> {lpo.reference || `LPO ${index + 1}`}
                        </button>
                      ))}
                    </div>
                  </td>

                  <td className="px-4 py-3 text-xs text-[#6E767D]">
                    {doc.created_at ? formatDistanceToNow(new Date(doc.created_at), { addSuffix: true }) : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {/* Pagination */}
        {filteredRows.length > PAGE_SIZE && (
          <div className="flex items-center justify-between border-t border-[#E4E7EB] px-5 py-2.5 text-xs text-[#5E6870]">
            <span>
              Showing {(page - 1) * PAGE_SIZE + 1}–{Math.min(page * PAGE_SIZE, filteredRows.length)} of {filteredRows.length}
            </span>
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                disabled={page <= 1}
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                className="border border-[#C8CDD2] px-3 py-1 font-medium text-[#1F2933] hover:bg-[#F5F7F8] disabled:opacity-40"
              >
                Previous
              </button>
              <span className="px-2">Page {page} of {totalPages}</span>
              <button
                type="button"
                disabled={page >= totalPages}
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                className="border border-[#C8CDD2] px-3 py-1 font-medium text-[#1F2933] hover:bg-[#F5F7F8] disabled:opacity-40"
              >
                Next
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
