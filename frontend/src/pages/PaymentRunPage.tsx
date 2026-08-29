/**
 * PaymentRunPage — Query SunSystems ledger lines (Journal/Query).
 *
 * Displays a filter bar and a rich results table.  Accessible to any
 * authenticated user (not admin-only), since payment run queries are a
 * day-to-day finance operation.
 */
import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import {
  Search,
  AlertCircle,
  RefreshCw,
  CreditCard,
  TrendingUp,
  TrendingDown,
  Filter,
  X,
  Info,
  Download,
} from "lucide-react";
import { sunsystemsAPI, type PaymentRunLine, type PaymentRunFilters } from "@/services/api";

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatDate(raw: string): string {
  // SunSystems date format: DDMMYYYY
  if (!raw || raw.length !== 8) return raw;
  const d = raw.slice(0, 2);
  const m = raw.slice(2, 4);
  const y = raw.slice(4);
  return `${d}/${m}/${y}`;
}

function formatAmount(raw: string): string {
  const n = parseFloat(raw);
  if (isNaN(n)) return raw;
  return n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function formatPeriod(raw: string): string {
  // e.g. "0072003" → "07 / 2003"
  if (!raw || raw.length < 7) return raw;
  const period = raw.slice(0, 3).replace(/^0+/, "") || "0";
  const year = raw.slice(3);
  return `P${period} / ${year}`;
}

// ── Sub-components ────────────────────────────────────────────────────────────

function DebitCreditBadge({ value }: { value: string }) {
  const isCredit = value.toUpperCase() === "C";
  return (
    <span
      className={`inline-flex items-center gap-1 rounded px-2 py-0.5 text-xs font-bold ${
        isCredit
          ? "bg-emerald-50 text-emerald-700"
          : "bg-blue-50 text-blue-700"
      }`}
    >
      {isCredit ? (
        <TrendingDown className="h-3 w-3" />
      ) : (
        <TrendingUp className="h-3 w-3" />
      )}
      {isCredit ? "Credit" : "Debit"}
    </span>
  );
}

function EmptyState({ hasQueried }: { hasQueried: boolean }) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 py-20 text-[#5E6870]">
      <div className="flex h-14 w-14 items-center justify-center rounded-full bg-[#EEF6FB]">
        <CreditCard className="h-7 w-7 text-[#287EAD]" />
      </div>
      <p className="text-sm font-semibold text-[#1F2933]">
        {hasQueried ? "No ledger lines matched your filters." : "Run a query to see ledger lines."}
      </p>
      <p className="max-w-xs text-center text-xs leading-5">
        {hasQueried
          ? "Try broadening your account codes, removing the allocation marker filter, or lowering the journal number threshold."
          : "Set your filters above and click Run Query to retrieve payment run data from SunSystems."}
      </p>
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

const ALLOCATION_OPTIONS = [
  { value: "W", label: "W — Unallocated" },
  { value: "A", label: "A — Allocated" },
  { value: "P", label: "P — Part-allocated" },
  { value: "", label: "All markers" },
];

const inputCls =
  "h-9 w-full rounded border border-[#AEB5BB] bg-white px-3 text-sm text-[#1F2933] " +
  "placeholder:text-[#8C969E] outline-none focus:border-[#287EAD] focus:ring-1 focus:ring-[#287EAD] transition-colors";

const TABLE_COLS: Array<{ label: string; key: keyof PaymentRunLine; className?: string }> = [
  { label: "Account", key: "account_code", className: "font-mono font-semibold text-[#287EAD]" },
  { label: "Account name", key: "account_description" },
  { label: "Jnl #", key: "journal_number", className: "text-center font-mono" },
  { label: "Line", key: "journal_line_number", className: "text-center" },
  { label: "Date", key: "transaction_date" },
  { label: "Period", key: "accounting_period" },
  { label: "Reference", key: "transaction_reference", className: "font-mono" },
  { label: "Description", key: "description" },
  { label: "Cur", key: "currency_code", className: "text-center" },
  { label: "Txn Amount", key: "transaction_amount", className: "text-right tabular-nums" },
  { label: "Base Amount", key: "base_amount", className: "text-right tabular-nums" },
  { label: "D/C", key: "debit_credit" },
  { label: "Alloc", key: "allocation_marker", className: "text-center" },
];

export default function PaymentRunPage() {
  const [filters, setFilters] = useState<PaymentRunFilters>({
    account_codes: "64001,71001",
    allocation_markers: "W",
    journal_number_gt: "10",
    business_unit: "",
    budget_code: "",
  });
  const [hasQueried, setHasQueried] = useState(false);
  const [lines, setLines] = useState<PaymentRunLine[]>([]);
  const [sortCol, setSortCol] = useState<keyof PaymentRunLine>("journal_number");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");

  const mutation = useMutation({
    mutationFn: () => sunsystemsAPI.paymentRun(filters).then((r) => r.data),
    onSuccess: (data) => {
      setHasQueried(true);
      setLines(data.lines ?? []);
    },
  });

  const set = (key: keyof PaymentRunFilters, value: string) =>
    setFilters((f) => ({ ...f, [key]: value }));

  const handleSort = (col: keyof PaymentRunLine) => {
    if (sortCol === col) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortCol(col);
      setSortDir("asc");
    }
  };

  const sorted = [...lines].sort((a, b) => {
    const av = a[sortCol] ?? "";
    const bv = b[sortCol] ?? "";
    const cmp =
      !isNaN(parseFloat(av as string)) && !isNaN(parseFloat(bv as string))
        ? parseFloat(av as string) - parseFloat(bv as string)
        : String(av).localeCompare(String(bv));
    return sortDir === "asc" ? cmp : -cmp;
  });

  // ── Summary totals ─────────────────────────────────────────────────────────
  const totalCredit = lines
    .filter((l) => l.debit_credit.toUpperCase() === "C")
    .reduce((s, l) => s + (parseFloat(l.transaction_amount) || 0), 0);
  const totalDebit = lines
    .filter((l) => l.debit_credit.toUpperCase() === "D")
    .reduce((s, l) => s + (parseFloat(l.transaction_amount) || 0), 0);

  // ── CSV export ─────────────────────────────────────────────────────────────
  const exportCsv = () => {
    const header = TABLE_COLS.map((c) => c.label).join(",");
    const rows = sorted.map((row) =>
      TABLE_COLS.map((c) => {
        const v = row[c.key] ?? "";
        const formatted =
          c.key === "transaction_date" ? formatDate(v as string)
          : c.key === "accounting_period" ? formatPeriod(v as string)
          : String(v);
        return `"${formatted.replace(/"/g, '""')}"`;
      }).join(",")
    );
    const csv = [header, ...rows].join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `payment_run_${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const error =
    mutation.isError
      ? (mutation.error as any)?.response?.data?.error ?? "Failed to reach SunSystems."
      : (mutation.data as any)?.ok === false
      ? (mutation.data as any)?.error
      : null;

  return (
    <div className="flex min-h-screen flex-col bg-[#F3F5F6]">
      {/* ── Page header ── */}
      <div className="border-b border-[#C8CDD2] bg-white px-6 py-4 shadow-sm">
        <div className="mx-auto max-w-screen-2xl">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded bg-[#EEF6FB]">
                <CreditCard className="h-5 w-5 text-[#287EAD]" />
              </div>
              <div>
                <h1 className="text-lg font-bold text-[#1F2933]">Payment Run</h1>
                <p className="text-xs text-[#5E6870]">
                  Query unallocated ledger lines from SunSystems for payment processing.
                </p>
              </div>
            </div>
            {lines.length > 0 && (
              <button
                id="payment-run-export-csv"
                type="button"
                onClick={exportCsv}
                className="inline-flex items-center gap-2 border border-[#287EAD] px-4 py-2 text-sm font-semibold text-[#287EAD] hover:bg-[#EEF6FB] transition-colors"
              >
                <Download className="h-4 w-4" />
                Export CSV
              </button>
            )}
          </div>
        </div>
      </div>

      <div className="mx-auto w-full max-w-screen-2xl flex-1 space-y-5 px-6 py-6">
        {/* ── Filter panel ── */}
        <div className="border border-[#C8CDD2] bg-white shadow-sm">
          <div className="flex items-center gap-2 border-b border-[#C8CDD2] bg-[#F3F5F6] px-5 py-3">
            <Filter className="h-4 w-4 text-[#287EAD]" />
            <h2 className="text-sm font-bold text-[#1F2933]">Filters</h2>
            <span className="ml-auto flex items-center gap-1 text-xs text-[#5E6870]">
              <Info className="h-3.5 w-3.5" />
              All filters are optional — blank fields are omitted from the query.
            </span>
          </div>
          <div className="grid grid-cols-1 gap-4 p-5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
            {/* Account codes */}
            <div className="space-y-1.5">
              <label
                htmlFor="filter-account-codes"
                className="block text-xs font-semibold uppercase tracking-wider text-[#5E6870]"
              >
                Account codes
              </label>
              <input
                id="filter-account-codes"
                type="text"
                placeholder="e.g. 64001,71001"
                value={filters.account_codes ?? ""}
                onChange={(e) => set("account_codes", e.target.value)}
                className={inputCls}
              />
              <p className="text-[10px] text-[#8C969E]">Comma-separated account codes</p>
            </div>

            {/* Allocation marker */}
            <div className="space-y-1.5">
              <label
                htmlFor="filter-allocation"
                className="block text-xs font-semibold uppercase tracking-wider text-[#5E6870]"
              >
                Allocation marker
              </label>
              <select
                id="filter-allocation"
                value={filters.allocation_markers ?? "W"}
                onChange={(e) => set("allocation_markers", e.target.value)}
                className={inputCls}
              >
                {ALLOCATION_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </div>

            {/* Journal number GT */}
            <div className="space-y-1.5">
              <label
                htmlFor="filter-journal-gt"
                className="block text-xs font-semibold uppercase tracking-wider text-[#5E6870]"
              >
                Journal # greater than
              </label>
              <input
                id="filter-journal-gt"
                type="number"
                min={0}
                placeholder="0"
                value={filters.journal_number_gt ?? ""}
                onChange={(e) => set("journal_number_gt", e.target.value)}
                className={inputCls}
              />
            </div>

            {/* Business unit */}
            <div className="space-y-1.5">
              <label
                htmlFor="filter-bu"
                className="block text-xs font-semibold uppercase tracking-wider text-[#5E6870]"
              >
                Business unit
              </label>
              <input
                id="filter-bu"
                type="text"
                placeholder="e.g. PK1 (default from config)"
                value={filters.business_unit ?? ""}
                onChange={(e) => set("business_unit", e.target.value)}
                className={inputCls}
              />
            </div>

            {/* Budget code */}
            <div className="space-y-1.5">
              <label
                htmlFor="filter-budget"
                className="block text-xs font-semibold uppercase tracking-wider text-[#5E6870]"
              >
                Budget code
              </label>
              <input
                id="filter-budget"
                type="text"
                placeholder="e.g. A (default from config)"
                value={filters.budget_code ?? ""}
                onChange={(e) => set("budget_code", e.target.value)}
                className={inputCls}
              />
            </div>
          </div>

          <div className="flex items-center gap-3 border-t border-[#C8CDD2] bg-[#F8F9FA] px-5 py-3">
            <button
              id="payment-run-query-btn"
              type="button"
              disabled={mutation.isPending}
              onClick={() => mutation.mutate()}
              className="inline-flex items-center gap-2 bg-[#287EAD] px-6 py-2 text-sm font-semibold text-white hover:bg-[#1E6F99] disabled:opacity-60 transition-colors"
            >
              {mutation.isPending ? (
                <RefreshCw className="h-4 w-4 animate-spin" />
              ) : (
                <Search className="h-4 w-4" />
              )}
              {mutation.isPending ? "Querying…" : "Run Query"}
            </button>
            {hasQueried && !mutation.isPending && (
              <button
                type="button"
                onClick={() => {
                  setLines([]);
                  setHasQueried(false);
                  mutation.reset();
                }}
                className="inline-flex items-center gap-1.5 text-sm text-[#5E6870] hover:text-[#1F2933] transition-colors"
              >
                <X className="h-3.5 w-3.5" />
                Clear results
              </button>
            )}
          </div>
        </div>

        {/* ── Error banner ── */}
        {error && (
          <div className="flex items-start gap-3 border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-800">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        {/* ── Summary cards (only when results present) ── */}
        {lines.length > 0 && (
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            {[
              { label: "Total lines", value: lines.length.toString(), icon: CreditCard, color: "text-[#287EAD]", bg: "bg-[#EEF6FB]" },
              {
                label: "Unique accounts",
                value: new Set(lines.map((l) => l.account_code)).size.toString(),
                icon: Filter,
                color: "text-violet-600",
                bg: "bg-violet-50",
              },
              {
                label: "Total credit",
                value: formatAmount(totalCredit.toString()),
                icon: TrendingDown,
                color: "text-emerald-600",
                bg: "bg-emerald-50",
              },
              {
                label: "Total debit",
                value: formatAmount(totalDebit.toString()),
                icon: TrendingUp,
                color: "text-blue-600",
                bg: "bg-blue-50",
              },
            ].map(({ label, value, icon: Icon, color, bg }) => (
              <div key={label} className="border border-[#C8CDD2] bg-white p-4 shadow-sm">
                <div className="flex items-center gap-2">
                  <div className={`flex h-8 w-8 items-center justify-center rounded ${bg}`}>
                    <Icon className={`h-4 w-4 ${color}`} />
                  </div>
                  <p className="text-xs text-[#5E6870]">{label}</p>
                </div>
                <p className="mt-2 text-xl font-bold tabular-nums text-[#1F2933]">{value}</p>
              </div>
            ))}
          </div>
        )}

        {/* ── Results table ── */}
        <div className="border border-[#C8CDD2] bg-white shadow-sm">
          {lines.length > 0 && (
            <div className="flex items-center gap-3 border-b border-[#C8CDD2] bg-[#F3F5F6] px-5 py-3">
              <h2 className="text-sm font-bold text-[#1F2933]">Ledger Lines</h2>
              <span className="ml-1 inline-flex items-center rounded bg-[#287EAD] px-2.5 py-0.5 text-xs font-bold text-white">
                {lines.length}
              </span>
              <p className="ml-auto text-xs text-[#5E6870]">
                Click a column header to sort. Hover a row for details.
              </p>
            </div>
          )}

          {lines.length === 0 ? (
            <EmptyState hasQueried={hasQueried && !mutation.isPending} />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-sm">
                <thead>
                  <tr className="border-b border-[#C8CDD2] bg-[#F7F8F9] text-xs">
                    {TABLE_COLS.map((col) => (
                      <th
                        key={col.key}
                        onClick={() => handleSort(col.key)}
                        className="cursor-pointer select-none whitespace-nowrap border-r border-[#E5E9EC] px-3 py-2.5 text-left font-bold uppercase tracking-wider text-[#5E6870] transition-colors last:border-r-0 hover:bg-[#EEF6FB] hover:text-[#287EAD]"
                      >
                        <span className="inline-flex items-center gap-1">
                          {col.label}
                          {sortCol === col.key && (
                            <span className="text-[#287EAD]">
                              {sortDir === "asc" ? "↑" : "↓"}
                            </span>
                          )}
                        </span>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {sorted.map((row, i) => (
                    <tr
                      key={`${row.journal_number}-${row.journal_line_number}-${i}`}
                      className="group border-b border-[#EDF0F2] transition-colors last:border-0 hover:bg-[#F3F8FB]"
                    >
                      {TABLE_COLS.map((col) => {
                        let displayValue: React.ReactNode = row[col.key] ?? "";

                        if (col.key === "transaction_date") {
                          displayValue = formatDate(row.transaction_date);
                        } else if (col.key === "accounting_period") {
                          displayValue = formatPeriod(row.accounting_period);
                        } else if (col.key === "transaction_amount" || col.key === "base_amount") {
                          displayValue = formatAmount(row[col.key] as string);
                        } else if (col.key === "debit_credit") {
                          displayValue = <DebitCreditBadge value={row.debit_credit} />;
                        }

                        return (
                          <td
                            key={col.key}
                            className={`whitespace-nowrap border-r border-[#EDF0F2] px-3 py-2.5 text-[#1F2933] last:border-r-0 ${col.className ?? ""}`}
                          >
                            {displayValue}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
