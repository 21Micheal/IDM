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
  Zap,
  CheckSquare,
  Square,
} from "lucide-react";
import { sunsystemsAPI, type PaymentRunLine, type PaymentRunFilters } from "@/services/api";
import CustomListbox from "@/components/ui/CustomListbox";

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
  { value: "",  label: "All markers" },
  { value: "W", label: "W — Unallocated" },
  { value: "A", label: "A — Allocated" },
  { value: "F", label: "F — Force" },
  { value: "S", label: "S — Split" },
  { value: "T", label: "T — To be allocated" },
  { value: "P", label: "P — Paid" },
  { value: "R", label: "R — Reconciled" },
  { value: "C", label: "C — Corrections" },
];

// Full set of SunSystems allocation markers used when processing a payment run.
const PAYMENT_MARKER_OPTIONS = [
  { value: "F", label: "F — Force" },
  { value: "A", label: "A — Allocated" },
  { value: "W", label: "W — Unallocated" },
  { value: "S", label: "S — Split" },
  { value: "T", label: "T — To be allocated" },
  { value: "P", label: "P — Paid" },
  { value: "R", label: "R — Reconciled" },
  { value: "C", label: "C — Corrections" },
];

const MARKER_LABEL: Record<string, string> = Object.fromEntries(
  PAYMENT_MARKER_OPTIONS.map((o) => [o.value, o.label])
);

const DEFAULT_PAYMENT_MARKER = "F";

// Stable row key derived from journal number + line number + sort position.
function rowKey(row: { journal_number: string; journal_line_number: string }, i: number) {
  return `${row.journal_number}-${row.journal_line_number}-${i}`;
}

// ── Confirmation modal ────────────────────────────────────────────────────────

type SelectedLine = PaymentRunLine & { payment_marker: string; row_key: string };

function ConfirmPaymentModal({
  lines,
  onMarkerChange,
  onConfirm,
  onCancel,
  isProcessing,
  processError,
  processedCount,
}: {
  lines: SelectedLine[];
  onMarkerChange: (key: string, marker: string) => void;
  onConfirm: () => void;
  onCancel: () => void;
  isProcessing: boolean;
  processError: string | null;
  processedCount: number | null;
}) {
  const total = lines.reduce((s, l) => s + (parseFloat(l.transaction_amount) || 0), 0);
  const currencies = [...new Set(lines.map((l) => l.currency_code))];
  const succeeded = processedCount !== null && !processError;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/40 backdrop-blur-[2px]" onClick={!isProcessing ? onCancel : undefined} />

      {/* Panel */}
      <div className="relative flex max-h-[90vh] w-full max-w-5xl flex-col overflow-hidden border border-[#C8CDD2] bg-white shadow-2xl">
        {/* Header */}
        <div className={`flex items-center gap-3 border-b border-[#C8CDD2] px-6 py-4 text-white ${
          succeeded ? "bg-emerald-600" : "bg-[#287EAD]"
        }`}>
          {succeeded ? (
            <CheckSquare className="h-5 w-5 shrink-0" />
          ) : (
            <Zap className="h-5 w-5 shrink-0" />
          )}
          <div className="flex-1">
            <h2 className="text-base font-bold">
              {succeeded ? "Payment Run Processed" : "Confirm Payment Run"}
            </h2>
            <p className="text-xs text-white/75">
              {succeeded
                ? `${processedCount} line${processedCount !== 1 ? "s" : ""} successfully updated in SunSystems.`
                : `Review the ${lines.length} line${lines.length !== 1 ? "s" : ""} below before processing. You can still adjust the allocation marker for each line.`}
            </p>
          </div>
          {!isProcessing && (
            <button
              type="button"
              onClick={onCancel}
              className="flex h-8 w-8 items-center justify-center rounded-full text-white/80 hover:bg-white/20 hover:text-white transition-colors"
            >
              <X className="h-4 w-4" />
            </button>
          )}
        </div>

        {/* Summary bar */}
        <div className="grid grid-cols-3 divide-x divide-[#C8CDD2] border-b border-[#C8CDD2] bg-[#F3F5F6]">
          {[
            { label: "Lines selected", value: lines.length.toString() },
            { label: "Currencies", value: currencies.join(", ") || "—" },
            { label: "Total amount", value: formatAmount(total.toFixed(3)) },
          ].map(({ label, value }) => (
            <div key={label} className="px-5 py-3">
              <p className="text-[10px] font-semibold uppercase tracking-wider text-[#5E6870]">{label}</p>
              <p className="mt-0.5 text-lg font-bold tabular-nums text-[#1F2933]">{value}</p>
            </div>
          ))}
        </div>

        {/* Error banner */}
        {processError && (
          <div className="flex items-start gap-3 border-b border-red-300 bg-red-50 px-5 py-3 text-sm text-red-800">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
            <span><strong>SunSystems error:</strong> {processError}</span>
          </div>
        )}

        {/* Success state */}
        {succeeded ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-4 py-16">
            <div className="flex h-16 w-16 items-center justify-center rounded-full bg-emerald-100">
              <CheckSquare className="h-8 w-8 text-emerald-600" />
            </div>
            <p className="text-base font-bold text-[#1F2933]">
              {processedCount} line{processedCount !== 1 ? "s" : ""} updated successfully
            </p>
            <p className="max-w-sm text-center text-sm text-[#5E6870]">
              The allocation markers have been updated in SunSystems.
              Re-run the query to see the updated ledger state.
            </p>
          </div>
        ) : (
          /* Table */
          <div className="flex-1 overflow-auto">
            <table className="w-full border-collapse text-sm">
              <thead className="sticky top-0">
                <tr className="border-b border-[#C8CDD2] bg-[#F7F8F9] text-xs">
                  {["#", "Account", "Account name", "Jnl #", "Date", "Reference", "Description", "Cur", "Amount", "D/C", "Payment Marker"].map((h) => (
                    <th key={h} className="whitespace-nowrap border-r border-[#E5E9EC] px-3 py-2.5 text-left font-bold uppercase tracking-wider text-[#5E6870] last:border-r-0">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {lines.map((line, idx) => (
                  <tr
                    key={line.row_key}
                    className="border-b border-[#EDF0F2] last:border-0 hover:bg-[#F3F8FB] transition-colors"
                  >
                    <td className="border-r border-[#EDF0F2] px-3 py-2.5 text-xs font-bold text-[#5E6870]">{idx + 1}</td>
                    <td className="border-r border-[#EDF0F2] px-3 py-2.5 font-mono font-semibold text-[#287EAD]">{line.account_code}</td>
                    <td className="border-r border-[#EDF0F2] px-3 py-2.5 text-[#1F2933]">{line.account_description}</td>
                    <td className="border-r border-[#EDF0F2] px-3 py-2.5 text-center font-mono">{line.journal_number}</td>
                    <td className="border-r border-[#EDF0F2] px-3 py-2.5 whitespace-nowrap">{formatDate(line.transaction_date)}</td>
                    <td className="border-r border-[#EDF0F2] px-3 py-2.5 font-mono text-xs">{line.transaction_reference}</td>
                    <td className="max-w-[180px] truncate border-r border-[#EDF0F2] px-3 py-2.5 text-[#1F2933]" title={line.description}>{line.description}</td>
                    <td className="border-r border-[#EDF0F2] px-3 py-2.5 text-center">{line.currency_code}</td>
                    <td className="border-r border-[#EDF0F2] px-3 py-2.5 text-right tabular-nums font-semibold">{formatAmount(line.transaction_amount)}</td>
                    <td className="border-r border-[#EDF0F2] px-3 py-2.5">
                      <DebitCreditBadge value={line.debit_credit} />
                    </td>
                    <td className="px-2 py-1.5">
                      <CustomListbox
                        value={line.payment_marker}
                        onChange={(v) => onMarkerChange(line.row_key, v)}
                        options={PAYMENT_MARKER_OPTIONS}
                        disabled={isProcessing}
                        buttonClassName="h-7 rounded border border-[#287EAD] bg-white px-2 text-xs font-semibold text-[#1F2933] focus:ring-1 focus:ring-[#287EAD] cursor-pointer"
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* Footer */}
        <div className="flex items-center justify-between border-t border-[#C8CDD2] bg-[#F8F9FA] px-6 py-4">
          {succeeded ? (
            <span />
          ) : (
            <div className="text-xs text-[#5E6870]">
              Markers in use:{" "}
              {Object.entries(
                lines.reduce<Record<string, number>>((acc, l) => {
                  acc[l.payment_marker] = (acc[l.payment_marker] ?? 0) + 1;
                  return acc;
                }, {})
              ).map(([m, count]) => (
                <span key={m} className="ml-2 inline-flex items-center rounded-full bg-[#EEF6FB] px-2.5 py-0.5 text-xs font-bold text-[#287EAD]">
                  {MARKER_LABEL[m] ?? m} × {count}
                </span>
              ))}
            </div>
          )}
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={onCancel}
              disabled={isProcessing}
              className="border border-[#AEB5BB] px-5 py-2 text-sm font-semibold text-[#5E6870] hover:bg-[#F3F5F6] disabled:opacity-50 transition-colors"
            >
              {succeeded ? "Close" : "Cancel"}
            </button>
            {!succeeded && (
              <button
                id="confirm-process-payment-btn"
                type="button"
                onClick={onConfirm}
                disabled={isProcessing}
                className="inline-flex items-center gap-2 bg-[#287EAD] px-6 py-2 text-sm font-bold text-white hover:bg-[#1E6F99] disabled:opacity-60 transition-colors active:scale-95"
              >
                {isProcessing ? (
                  <RefreshCw className="h-4 w-4 animate-spin" />
                ) : (
                  <Zap className="h-4 w-4" />
                )}
                {isProcessing ? "Processing…" : "Confirm & Process Payment"}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

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
    allocation_markers: "",   // blank = all markers
    journal_number_gt: "",    // blank = no lower bound
    business_unit: "",
    budget_code: "",
  });
  const [hasQueried, setHasQueried] = useState(false);
  const [lines, setLines] = useState<PaymentRunLine[]>([]);
  const [sortCol, setSortCol] = useState<keyof PaymentRunLine>("journal_number");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");

  // ── Selection state ────────────────────────────────────────────────────────
  // selectedKeys: set of row keys that are checked.
  // rowMarkers: per-row payment allocation marker (defaults to F — Force).
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set());
  const [rowMarkers, setRowMarkers] = useState<Record<string, string>>({});
  const [showConfirmModal, setShowConfirmModal] = useState(false);

  // ── Amend markers mutation ────────────────────────────────────────────────────
  const [processedCount, setProcessedCount] = useState<number | null>(null);
  const [processError, setProcessError] = useState<string | null>(null);

  const amendMutation = useMutation({
    mutationFn: () =>
      sunsystemsAPI.amendMarkers({
        lines: selectedLines.map((l) => ({
          journal_number: l.journal_number,
          journal_line_number: l.journal_line_number,
          payment_marker: l.payment_marker,
        })),
      }).then((r) => r.data),
    onSuccess: (data) => {
      if (data.ok) {
        setProcessedCount(data.processed ?? selectedLines.length);
        setProcessError(null);
        // Clear selection so re-query shows fresh state.
        setSelectedKeys(new Set());
        setRowMarkers({});
      } else {
        setProcessError(data.error ?? "SunSystems returned an error.");
        setProcessedCount(null);
      }
    },
    onError: (err: any) => {
      setProcessError(
        err?.response?.data?.error ?? "Failed to reach SunSystems. Please try again."
      );
      setProcessedCount(null);
    },
  });

  const mutation = useMutation({
    mutationFn: () => sunsystemsAPI.paymentRun(filters).then((r) => r.data),
    onSuccess: (data) => {
      setHasQueried(true);
      setLines(data.lines ?? []);
      // Clear selection when new query results arrive.
      setSelectedKeys(new Set());
      setRowMarkers({});
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

  // ── Selection helpers ──────────────────────────────────────────────────────
  const allKeys = sorted.map((r, i) => rowKey(r, i));
  const allSelected = allKeys.length > 0 && allKeys.every((k) => selectedKeys.has(k));
  const someSelected = allKeys.some((k) => selectedKeys.has(k));

  const toggleRow = (key: string) => {
    setSelectedKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) { next.delete(key); } else { next.add(key); }
      return next;
    });
    setRowMarkers((prev) => ({
      ...prev,
      [key]: prev[key] ?? DEFAULT_PAYMENT_MARKER,
    }));
  };

  const toggleAll = () => {
    if (allSelected) {
      setSelectedKeys(new Set());
    } else {
      setSelectedKeys(new Set(allKeys));
      setRowMarkers((prev) => {
        const next = { ...prev };
        allKeys.forEach((k) => { if (!next[k]) next[k] = DEFAULT_PAYMENT_MARKER; });
        return next;
      });
    }
  };

  const setMarker = (key: string, marker: string) =>
    setRowMarkers((prev) => ({ ...prev, [key]: marker }));

  // Lines selected for payment processing, with their chosen marker.
  const selectedLines = sorted
    .map((row, i) => ({ row, key: rowKey(row, i) }))
    .filter(({ key }) => selectedKeys.has(key))
    .map(({ row, key }) => ({ ...row, payment_marker: rowMarkers[key] ?? DEFAULT_PAYMENT_MARKER, row_key: key }));

  const selectedTotal = selectedLines.reduce(
    (s, l) => s + (parseFloat(l.transaction_amount) || 0), 0
  );

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

            {/* Allocation marker — CustomListbox */}
            <div className="space-y-1.5">
              <label
                htmlFor="filter-allocation"
                className="block text-xs font-semibold uppercase tracking-wider text-[#5E6870]"
              >
                Allocation marker
              </label>
              <CustomListbox
                ariaLabel="Allocation marker"
                value={filters.allocation_markers ?? ""}
                onChange={(v) => set("allocation_markers", v)}
                options={ALLOCATION_OPTIONS}
                className="w-full"
                buttonClassName="h-9 w-full rounded border border-[#AEB5BB] bg-white px-3 text-sm text-[#1F2933] hover:border-[#287EAD] focus:border-[#287EAD] focus:ring-1 focus:ring-[#287EAD] transition-colors"
              />
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
              {selectedKeys.size > 0 && (
                <span className="inline-flex items-center gap-1 rounded bg-amber-500 px-2.5 py-0.5 text-xs font-bold text-white">
                  <CheckSquare className="h-3 w-3" />
                  {selectedKeys.size} selected
                </span>
              )}
              <p className="ml-auto text-xs text-[#5E6870]">
                Tick rows to select for payment. Click a column header to sort.
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
                    {/* Select-all checkbox */}
                    <th className="w-10 border-r border-[#E5E9EC] px-3 py-2.5 text-center">
                      <button
                        type="button"
                        onClick={toggleAll}
                        title={allSelected ? "Deselect all" : "Select all"}
                        className="flex items-center justify-center text-[#5E6870] hover:text-[#287EAD] transition-colors"
                      >
                        {allSelected ? (
                          <CheckSquare className="h-4 w-4 text-[#287EAD]" />
                        ) : someSelected ? (
                          <Square className="h-4 w-4 text-amber-500" />
                        ) : (
                          <Square className="h-4 w-4" />
                        )}
                      </button>
                    </th>
                    {TABLE_COLS.map((col) => (
                      <th
                        key={col.key}
                        onClick={() => handleSort(col.key)}
                        className="cursor-pointer select-none whitespace-nowrap border-r border-[#E5E9EC] px-3 py-2.5 text-left font-bold uppercase tracking-wider text-[#5E6870] transition-colors last:border-r-0 hover:bg-[#EEF6FB] hover:text-[#287EAD]"
                      >
                        <span className="inline-flex items-center gap-1">
                          {col.label}
                          {sortCol === col.key && (
                            <span className="text-[#287EAD]">{sortDir === "asc" ? "↑" : "↓"}</span>
                          )}
                        </span>
                      </th>
                    ))}
                    {/* Payment marker column */}
                    <th className="whitespace-nowrap border-l border-[#E5E9EC] px-3 py-2.5 text-left font-bold uppercase tracking-wider text-[#287EAD]">
                      Payment Marker
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {sorted.map((row, i) => {
                    const key = rowKey(row, i);
                    const isSelected = selectedKeys.has(key);
                    const marker = rowMarkers[key] ?? DEFAULT_PAYMENT_MARKER;
                    return (
                      <tr
                        key={key}
                        onClick={() => toggleRow(key)}
                        className={`group cursor-pointer border-b border-[#EDF0F2] transition-colors last:border-0 ${
                          isSelected
                            ? "bg-amber-50 hover:bg-amber-100"
                            : "hover:bg-[#F3F8FB]"
                        }`}
                      >
                        {/* Row checkbox */}
                        <td
                          className="w-10 border-r border-[#EDF0F2] px-3 py-2.5 text-center"
                          onClick={(e) => { e.stopPropagation(); toggleRow(key); }}
                        >
                          {isSelected ? (
                            <CheckSquare className="h-4 w-4 text-[#287EAD]" />
                          ) : (
                            <Square className="h-4 w-4 text-[#AEB5BB] group-hover:text-[#5E6870]" />
                          )}
                        </td>

                        {TABLE_COLS.map((col) => {
                          let displayValue: React.ReactNode = row[col.key] ?? "";
                          if (col.key === "transaction_date") displayValue = formatDate(row.transaction_date);
                          else if (col.key === "accounting_period") displayValue = formatPeriod(row.accounting_period);
                          else if (col.key === "transaction_amount" || col.key === "base_amount") displayValue = formatAmount(row[col.key] as string);
                          else if (col.key === "debit_credit") displayValue = <DebitCreditBadge value={row.debit_credit} />;
                          return (
                            <td
                              key={col.key}
                              className={`whitespace-nowrap border-r border-[#EDF0F2] px-3 py-2.5 text-[#1F2933] last:border-r-0 ${col.className ?? ""}`}
                            >
                              {displayValue}
                            </td>
                          );
                        })}

                        {/* Per-row payment marker selector */}
                        <td
                          className="border-l border-[#EDF0F2] px-2 py-1.5"
                          onClick={(e) => e.stopPropagation()}
                        >
                          <CustomListbox
                            value={marker}
                            onChange={(v) => setMarker(key, v)}
                            options={PAYMENT_MARKER_OPTIONS}
                            disabled={!isSelected}
                            buttonClassName={`h-7 rounded border px-2 text-xs font-semibold transition-colors ${
                              isSelected
                                ? "border-[#287EAD] bg-white text-[#1F2933]"
                                : "border-[#E5E9EC] bg-[#F7F8F9] text-[#AEB5BB]"
                            }`}
                          />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      {/* ── Sticky action bar — appears when lines are selected ── */}
      {selectedLines.length > 0 && (
        <div className="sticky bottom-0 z-20 border-t-2 border-[#287EAD] bg-white shadow-[0_-4px_24px_rgba(0,0,0,0.12)]">
          <div className="mx-auto flex max-w-screen-2xl items-center gap-6 px-6 py-4">
            {/* Selection summary */}
            <div className="flex items-center gap-3">
              <div className="flex h-9 w-9 items-center justify-center rounded-full bg-[#287EAD]">
                <CheckSquare className="h-4 w-4 text-white" />
              </div>
              <div>
                <p className="text-sm font-bold text-[#1F2933]">
                  {selectedLines.length} line{selectedLines.length !== 1 ? "s" : ""} selected
                </p>
                <p className="text-xs text-[#5E6870]">
                  Total: <span className="font-semibold tabular-nums text-[#1F2933]">{formatAmount(selectedTotal.toFixed(3))}</span>
                </p>
              </div>
            </div>

            {/* Marker breakdown pill */}
            <div className="hidden items-center gap-2 sm:flex">
              {Object.entries(
                selectedLines.reduce<Record<string, number>>((acc, l) => {
                  acc[l.payment_marker] = (acc[l.payment_marker] ?? 0) + 1;
                  return acc;
                }, {})
              ).map(([m, count]) => (
                <span
                  key={m}
                  className="inline-flex items-center gap-1 rounded-full bg-[#EEF6FB] px-3 py-1 text-xs font-bold text-[#287EAD]"
                >
                  {m} × {count}
                </span>
              ))}
            </div>

            <div className="ml-auto flex items-center gap-3">
              {/* Deselect all */}
              <button
                type="button"
                onClick={() => setSelectedKeys(new Set())}
                className="inline-flex items-center gap-1.5 text-sm text-[#5E6870] hover:text-[#1F2933] transition-colors"
              >
                <X className="h-3.5 w-3.5" />
                Deselect all
              </button>

              {/* Process Payment — opens confirmation modal */}
              <button
                id="process-payment-btn"
                type="button"
                onClick={() => setShowConfirmModal(true)}
                className="inline-flex items-center gap-2 bg-[#287EAD] px-6 py-2.5 text-sm font-bold text-white shadow-sm hover:bg-[#1E6F99] transition-colors active:scale-95"
              >
                <Zap className="h-4 w-4" />
                Process Payment ({selectedLines.length})
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Confirmation modal ── */}
      {showConfirmModal && (
        <ConfirmPaymentModal
          lines={selectedLines}
          onMarkerChange={(key, marker) => setMarker(key, marker)}
          onConfirm={() => amendMutation.mutate()}
          onCancel={() => {
            setShowConfirmModal(false);
            setProcessedCount(null);
            setProcessError(null);
            amendMutation.reset();
          }}
          isProcessing={amendMutation.isPending}
          processError={processError}
          processedCount={processedCount}
        />
      )}
    </div>
  );
}
