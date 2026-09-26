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
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { formatDistanceToNow } from "date-fns";
import { Plus, Search as SearchIcon, X, ClipboardList, Loader2 } from "lucide-react";
import { documentsAPI } from "@/services/api";
import StatusBadge from "@/components/documents/StatusBadge";
import { cn } from "@/lib/utils";

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
  return values?.supplier || values?.supplier_name || "—";
}

function formatMoney(amount: number | null, currency?: string) {
  if (amount === null) return "—";
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency: currency || "KES", maximumFractionDigits: 0 }).format(amount);
  } catch {
    return `${currency ?? ""} ${amount.toLocaleString()}`.trim();
  }
}

export default function RequisitionsPage() {
  const navigate = useNavigate();
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
      documentsAPI.list({ is_form: true, ordering: "-created_at", page: 1, page_size: STATS_POOL_SIZE }).then((r) => r.data),
    staleTime: 15_000,
  });

  const poolRows = useMemo(() => {
    const results = ((poolData?.results ?? []) as any[]).filter((d) => Boolean(d?.metadata?.form?.sections));
    return results;
  }, [poolData]);

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
        const supplier = getReqSupplier(doc).toLowerCase();
        if (!title.includes(q) && !ref.includes(q) && !supplier.includes(q)) return false;
      }
      if (statusFilter && doc.status !== statusFilter) return false;
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
  }, [poolRows, search, statusFilter, departmentFilter, dateFrom, dateTo, amountMin, amountMax]);

  useEffect(() => {
    setPage(1);
  }, [search, statusFilter, departmentFilter, dateFrom, dateTo, amountMin, amountMax]);

  const totalPages = Math.max(1, Math.ceil(filteredRows.length / PAGE_SIZE));
  const pageRows = useMemo(() => {
    const start = (page - 1) * PAGE_SIZE;
    return filteredRows.slice(start, start + PAGE_SIZE);
  }, [filteredRows, page]);

  const statusCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const chip of STATUS_CHIPS) {
      counts[chip.value] = chip.value ? poolRows.filter((d) => d.status === chip.value).length : poolRows.length;
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
    <div className="mx-auto max-w-[1400px] space-y-5 p-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-[#1F2933]">Requisitions</h1>
          <p className="mt-1 text-sm text-[#5E6870]">All purchase requisitions raised in this portal.</p>
        </div>
        <button
          type="button"
          onClick={() => navigate("/new")}
          className="inline-flex items-center gap-2 bg-[#287EAD] px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-[#1E6F99]"
        >
          <Plus className="h-4 w-4" /> New Requisition
        </button>
      </div>

      {/* Status chips */}
      <div className="flex flex-wrap items-center gap-2">
        {STATUS_CHIPS.map((chip) => (
          <button
            key={chip.value}
            type="button"
            onClick={() => setStatusFilter(chip.value)}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-medium transition-colors",
              statusFilter === chip.value
                ? "border-[#287EAD] bg-[#287EAD] text-white"
                : "border-[#E4E7EB] bg-white text-[#5E6870] hover:border-[#287EAD] hover:text-[#287EAD]"
            )}
          >
            {chip.label}
            <span className={cn("rounded-full px-1.5 text-[10px]", statusFilter === chip.value ? "bg-white/20" : "bg-[#F0F2F4]")}>
              {statusCounts[chip.value] ?? 0}
            </span>
          </button>
        ))}
      </div>

      {/* Filter bar */}
      <div className="flex flex-wrap items-center gap-2 rounded-xl border border-[#E4E7EB] bg-white p-3 shadow-sm">
        <div className="relative min-w-[220px] flex-1">
          <SearchIcon className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[#9AA5B1]" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search title, reference, supplier…"
            className="w-full rounded-lg border border-[#E4E7EB] py-2 pl-9 pr-3 text-sm focus:border-[#287EAD] focus:outline-none"
          />
        </div>
        <select
          value={departmentFilter}
          onChange={(e) => setDepartmentFilter(e.target.value)}
          className="rounded-lg border border-[#E4E7EB] px-3 py-2 text-sm focus:border-[#287EAD] focus:outline-none"
        >
          <option value="">All departments</option>
          {departmentOptions.map((d) => (
            <option key={d} value={d}>{d}</option>
          ))}
        </select>
        <input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} className="rounded-lg border border-[#E4E7EB] px-3 py-2 text-sm" />
        <input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} className="rounded-lg border border-[#E4E7EB] px-3 py-2 text-sm" />
        <input value={amountMin} onChange={(e) => setAmountMin(e.target.value)} placeholder="Min amount" inputMode="numeric" className="w-28 rounded-lg border border-[#E4E7EB] px-3 py-2 text-sm" />
        <input value={amountMax} onChange={(e) => setAmountMax(e.target.value)} placeholder="Max amount" inputMode="numeric" className="w-28 rounded-lg border border-[#E4E7EB] px-3 py-2 text-sm" />
        {activeFilterCount > 0 && (
          <button type="button" onClick={clearFilters} className="inline-flex items-center gap-1 rounded-lg px-2 py-2 text-xs font-medium text-rose-600 hover:bg-rose-50">
            <X className="h-3.5 w-3.5" /> Clear ({activeFilterCount})
          </button>
        )}
      </div>

      {/* Table */}
      <div className="overflow-hidden rounded-xl border border-[#E4E7EB] bg-white shadow-sm">
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
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-[#E4E7EB] text-xs uppercase tracking-wide text-[#5E6870]">
                <th className="px-5 py-3 font-medium">#</th>
                <th className="px-5 py-3 font-medium">Requisition</th>
                <th className="px-5 py-3 font-medium">Supplier</th>
                <th className="px-5 py-3 font-medium">Requester</th>
                <th className="px-5 py-3 font-medium">Amount</th>
                <th className="px-5 py-3 font-medium">Status</th>
                <th className="px-5 py-3 font-medium">Created</th>
              </tr>
            </thead>
            <tbody>
              {pageRows.map((doc: any, i: number) => (
                <tr
                  key={doc.id}
                  className="cursor-pointer border-b border-[#F0F2F4] last:border-0 hover:bg-[#F8FAFB]"
                  onClick={() => navigate(`/${doc.id}`)}
                >
                  <td className="px-5 py-3 text-xs text-[#9AA5B1]">{(page - 1) * PAGE_SIZE + i + 1}</td>
                  <td className="px-5 py-3 font-medium text-[#1F2933]">
                    {doc.title || doc.reference_number || "—"}
                  </td>
                  <td className="px-5 py-3 text-[#5E6870]">{getReqSupplier(doc)}</td>
                  <td className="px-5 py-3 text-[#5E6870]">
                    {doc.uploaded_by?.full_name || doc.uploaded_by?.email || "—"}
                  </td>
                  <td className="px-5 py-3 text-[#1F2933]">{formatMoney(getReqAmount(doc), doc.currency)}</td>
                  <td className="px-5 py-3"><StatusBadge status={doc.status} /></td>
                  <td className="px-5 py-3 text-[#5E6870]">
                    {doc.created_at ? formatDistanceToNow(new Date(doc.created_at), { addSuffix: true }) : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {/* Pagination */}
        {filteredRows.length > PAGE_SIZE && (
          <div className="flex items-center justify-between border-t border-[#E4E7EB] px-5 py-3 text-xs text-[#5E6870]">
            <span>
              Showing {(page - 1) * PAGE_SIZE + 1}–{Math.min(page * PAGE_SIZE, filteredRows.length)} of {filteredRows.length}
            </span>
            <div className="flex items-center gap-2">
              <button
                type="button"
                disabled={page <= 1}
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                className="rounded border border-[#E4E7EB] px-2.5 py-1 font-medium disabled:opacity-40"
              >
                Previous
              </button>
              <span>Page {page} of {totalPages}</span>
              <button
                type="button"
                disabled={page >= totalPages}
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                className="rounded border border-[#E4E7EB] px-2.5 py-1 font-medium disabled:opacity-40"
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
