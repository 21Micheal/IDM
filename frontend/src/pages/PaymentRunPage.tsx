/**
 * PaymentRunPage — Query SunSystems ledger lines (Journal/Query).
 *
 * Displays a filter bar and a rich results table.  Accessible to any
 * authenticated user (not admin-only), since payment run queries are a
 * day-to-day finance operation.
 */
import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import {
  Search, AlertCircle, RefreshCw, CreditCard, TrendingUp, TrendingDown,
  Filter, X, Info, Download, Zap, CheckSquare, Square, Lock, History, Eye,
} from "lucide-react";
import { sunsystemsAPI, type PaymentRunLine, type PaymentRunFilters, type SunSystemsAccount, type PaymentRunRecord, type AmendMarkerLine } from "@/services/api";
import CustomListbox from "@/components/ui/CustomListbox";
import AccountMultiSelect from "@/components/ui/AccountMultiSelect";

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

function formatDateTime(raw?: string | null): string {
  if (!raw) return "";
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return raw;
  return d.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
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
  { value: "W", label: "Unallocated (blank / W)" },
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

const PAGE_TABS = ["Payment Query", "Recent Runs"] as const;
type PageTab = (typeof PAGE_TABS)[number];

function rowKey(row: { journal_number: string; journal_line_number: string }, i: number) {
  return `${row.journal_number}-${row.journal_line_number}-${i}`;
}

function paymentRunStatusLabel(run: PaymentRunRecord): string {
  if (run.status_display?.trim()) return run.status_display.trim();
  if (run.status === "pending_approval") {
    return run.current_step_status_label?.trim()
      || run.current_step_name?.trim()
      || "Pending approval";
  }
  if (run.status === "approved" || run.status === "processing") return "Processing payment";
  if (run.status === "rejected") return "Rejected";
  if (run.status === "paid") return "Paid";
  if (run.status === "failed") return "Failed";
  return run.status.replace(/_/g, " ");
}

/** True when a processing run has gone stale (verification retries exhausted). */
function isPaymentRunStuck(run: PaymentRunRecord): boolean {
  if (run.status !== "processing") return false;
  const updated = new Date(run.updated_at).getTime();
  if (Number.isNaN(updated)) return true;
  // Celery re-verifies with ≤30s gaps; treat as stuck only after that window goes quiet.
  return Date.now() - updated > 90 * 1000;
}

function LinesSnapshotModal({
  run,
  onClose,
}: {
  run: PaymentRunRecord;
  onClose: () => void;
}) {
  const lines = Array.isArray(run.lines) ? run.lines : [];
  const currencies = [...new Set(lines.map((l) => l.currency_code).filter(Boolean))];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/40 backdrop-blur-[2px]" onClick={onClose} />
      <div className="relative z-10 flex max-h-[85vh] w-full max-w-5xl flex-col overflow-hidden border border-[#C8CDD2] bg-white shadow-xl">
        <div className="flex items-start justify-between gap-3 border-b border-[#C8CDD2] bg-[#F3F5F6] px-5 py-4">
          <div>
            <h3 className="text-base font-bold text-[#1F2933]">Payment run lines</h3>
            <p className="mt-0.5 text-xs text-[#5E6870]">
              Snapshot of transactions submitted with{" "}
              <span className="font-mono font-semibold text-[#287EAD]">{run.payment_reference}</span>
              {currencies.length > 0 ? ` · ${currencies.join(", ")}` : ""}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded border border-[#C8CDD2] p-1.5 text-[#5E6870] hover:bg-white"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="border-b border-[#EDF0F2] bg-white px-5 py-3 text-xs text-[#5E6870]">
          <span className="font-semibold text-[#1F2933]">{lines.length}</span> line{lines.length !== 1 ? "s" : ""}
          {" · "}
          Total{" "}
          <span className="font-semibold tabular-nums text-[#1F2933]">{formatAmount(run.total_amount)}</span>
          {" · "}
          Status{" "}
          <span className="font-semibold text-[#1F2933]">{paymentRunStatusLabel(run)}</span>
          {" · "}
          Approvals{" "}
          <span className="font-semibold text-[#1F2933]">{run.approval_count}/{run.required_approvals}</span>
        </div>

        <div className="min-h-0 flex-1 overflow-auto">
          {lines.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-2 py-16 text-[#5E6870]">
              <Info className="h-8 w-8 text-[#AEB5BB]" />
              <p className="text-sm font-semibold">No line snapshot stored for this run.</p>
            </div>
          ) : (
            <table className="w-full border-collapse text-xs">
              <thead className="sticky top-0 bg-[#F7F8F9]">
                <tr className="border-b border-[#C8CDD2] text-[10px] uppercase tracking-wider text-[#5E6870]">
                  {["Account", "Jnl #", "Line", "Date", "Reference", "Description", "Cur", "Txn amount", "Base", "D/C", "Marker"].map((h) => (
                    <th key={h} className="whitespace-nowrap border-r border-[#E5E9EC] px-3 py-2 text-left font-bold last:border-r-0">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {lines.map((line: AmendMarkerLine, idx: number) => (
                  <tr key={`${line.journal_number}-${line.journal_line_number}-${idx}`} className="border-b border-[#EDF0F2] last:border-0 hover:bg-[#F3F8FB]">
                    <td className="border-r border-[#EDF0F2] px-3 py-2 font-mono text-[#1F2933]">
                      {line.account_code || "—"}
                      {line.account_description ? (
                        <div className="text-[10px] text-[#8C969E]">{line.account_description}</div>
                      ) : null}
                    </td>
                    <td className="border-r border-[#EDF0F2] px-3 py-2 tabular-nums">{line.journal_number}</td>
                    <td className="border-r border-[#EDF0F2] px-3 py-2 tabular-nums">{line.journal_line_number}</td>
                    <td className="border-r border-[#EDF0F2] px-3 py-2">{formatDate(line.transaction_date || "")}</td>
                    <td className="border-r border-[#EDF0F2] px-3 py-2 font-mono">{line.transaction_reference || "—"}</td>
                    <td className="max-w-[220px] truncate border-r border-[#EDF0F2] px-3 py-2" title={line.description || ""}>
                      {line.description || "—"}
                    </td>
                    <td className="border-r border-[#EDF0F2] px-3 py-2">{line.currency_code || "—"}</td>
                    <td className="border-r border-[#EDF0F2] px-3 py-2 text-right tabular-nums font-semibold">
                      {formatAmount(line.transaction_amount || "0")}
                    </td>
                    <td className="border-r border-[#EDF0F2] px-3 py-2 text-right tabular-nums">
                      {formatAmount(line.base_amount || "0")}
                    </td>
                    <td className="border-r border-[#EDF0F2] px-3 py-2 text-center">
                      <DebitCreditBadge value={line.debit_credit || ""} />
                    </td>
                    <td className="px-3 py-2 text-center font-mono">
                      {line.payment_marker || line.allocation_marker || "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        <div className="flex justify-end border-t border-[#C8CDD2] bg-[#F7F8F9] px-5 py-3">
          <button
            type="button"
            onClick={onClose}
            className="border border-[#C8CDD2] bg-white px-4 py-2 text-sm font-semibold text-[#1F2933] hover:bg-[#F3F5F6]"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
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
  paymentRun,
  approvalError,
}: {
  lines: SelectedLine[];
  onMarkerChange: (key: string, marker: string) => void;
  onConfirm: () => void;
  onCancel: () => void;
  isProcessing: boolean;
  processError: string | null;
  processedCount: number | null;
  paymentRun: PaymentRunRecord | null;
  approvalError: string | null;
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
              {succeeded ? "Payment Run Submitted" : "Confirm Payment Run"}
            </h2>
            <p className="text-xs text-white/75">
              {succeeded
                ? `${processedCount} line${processedCount !== 1 ? "s" : ""} marked in SunSystems and submitted for approval.`
                : `Review the ${lines.length} line${lines.length !== 1 ? "s" : ""} below before submission. You can still adjust the allocation marker for each line.`}
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
        {approvalError && (
          <div className="flex items-start gap-3 border-b border-red-300 bg-red-50 px-5 py-3 text-sm text-red-800">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
            <span><strong>Payment run error:</strong> {approvalError}</span>
          </div>
        )}

        {/* Success state */}
        {succeeded ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-4 py-16">
            <div className="flex h-16 w-16 items-center justify-center rounded-full bg-emerald-100">
              <CheckSquare className="h-8 w-8 text-emerald-600" />
            </div>
            <p className="text-base font-bold text-[#1F2933]">
              {paymentRun?.payment_reference ?? "Payment run"} submitted successfully
            </p>
            <p className="max-w-sm text-center text-sm text-[#5E6870]">
              The allocation markers have been updated in SunSystems. The payment will post automatically after the final workflow approver.
            </p>
            {paymentRun && (
              <div className="w-full max-w-xl border border-[#C8CDD2] bg-[#F8F9FA] p-4 text-sm">
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <p className="text-[10px] font-semibold uppercase tracking-wider text-[#5E6870]">Reference</p>
                    <p className="font-mono font-bold text-[#1F2933]">{paymentRun.payment_reference}</p>
                  </div>
                  <div>
                    <p className="text-[10px] font-semibold uppercase tracking-wider text-[#5E6870]">Workflow</p>
                    <p className="font-bold text-[#1F2933]">Submitted for approval</p>
                  </div>
                  <div>
                    <p className="text-[10px] font-semibold uppercase tracking-wider text-[#5E6870]">SunSystems call</p>
                    <p className="font-mono font-bold text-[#1F2933]">{paymentRun.component}/{paymentRun.method}</p>
                  </div>
                  <div>
                    <p className="text-[10px] font-semibold uppercase tracking-wider text-[#5E6870]">Status</p>
                    <p className="font-bold capitalize text-[#1F2933]">
                      {paymentRunStatusLabel(paymentRun)}
                    </p>
                  </div>
                </div>
              </div>
            )}
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
                {isProcessing ? "Submitting…" : "Submit for Approval"}
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
  const [activeTab, setActiveTab] = useState<PageTab>("Payment Query");
  const [filters, setFilters] = useState<PaymentRunFilters>({
    account_codes: "",    // driven by selectedAccountCodes below
    allocation_markers: "",   // blank = all markers
    journal_number_gt: "",    // blank = no lower bound
    business_unit: "",
    budget_code: "",
  });
  const [hasQueried, setHasQueried] = useState(false);
  const [lines, setLines] = useState<PaymentRunLine[]>([]);
  const [sortCol, setSortCol] = useState<keyof PaymentRunLine>("journal_number");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");

  // ── Supplier accounts (fetched once from SunSystems) ──────────────────────
  const [selectedAccountCodes, setSelectedAccountCodes] = useState<string[]>([]);

  const accountsQuery = useQuery({
    queryKey: ["sunsystems-accounts"],
    queryFn: () => sunsystemsAPI.getAccounts().then((r) => r.data),
    staleTime: 5 * 60 * 1000, // cache for 5 minutes
  });
  const accounts: SunSystemsAccount[] = accountsQuery.data?.accounts ?? [];

  const paymentRunsQuery = useQuery({
    queryKey: ["sunsystems-payment-runs"],
    queryFn: () => sunsystemsAPI.getPaymentRuns().then((r) => r.data),
    staleTime: 5 * 1000,
    refetchInterval: (query) => {
      const runs = query.state.data?.payment_runs ?? [];
      // Poll while payment is in flight so Paid appears without a manual refresh.
      const inFlight = runs.some(
        (r) => r.status === "approved" || r.status === "processing",
      );
      return inFlight ? 3000 : false;
    },
  });
  const paymentRuns = paymentRunsQuery.data?.payment_runs ?? [];

  // ── Selection state ────────────────────────────────────────────────────────
  // selectedKeys: set of row keys that are checked.
  // rowMarkers: per-row payment allocation marker (defaults to F — Force).
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set());
  const [rowMarkers, setRowMarkers] = useState<Record<string, string>>({});
  const [showConfirmModal, setShowConfirmModal] = useState(false);

  // ── Amend markers mutation ────────────────────────────────────────────────────
  const [processedCount, setProcessedCount] = useState<number | null>(null);
  const [processError, setProcessError] = useState<string | null>(null);
  const [currentPaymentRun, setCurrentPaymentRun] = useState<PaymentRunRecord | null>(null);
  const [approvalError, setApprovalError] = useState<string | null>(null);
  const [finalProcessError, setFinalProcessError] = useState<string | null>(null);
  const [retryError, setRetryError] = useState<string | null>(null);
  const [linesSnapshotRun, setLinesSnapshotRun] = useState<PaymentRunRecord | null>(null);

  const amendMutation = useMutation({
    mutationFn: () =>
      sunsystemsAPI.amendMarkers({
        lines: selectedLines.map((l) => ({
          account_code: l.account_code,
          account_description: l.account_description,
          accounting_period: l.accounting_period,
          transaction_date: l.transaction_date,
          journal_number: l.journal_number,
          journal_line_number: l.journal_line_number,
          transaction_reference: l.transaction_reference,
          description: l.description,
          base_amount: l.base_amount,
          conversion_rate: l.conversion_rate,
          currency_code: l.currency_code,
          transaction_amount: l.transaction_amount,
          debit_credit: l.debit_credit,
          allocation_marker: l.allocation_marker,
          payment_marker: l.payment_marker,
        })),
        business_unit: filters.business_unit,
        budget_code: filters.budget_code,
      }).then((r) => r.data),
    onSuccess: (data) => {
      if (data.ok) {
        setProcessedCount(data.processed ?? selectedLines.length);
        setCurrentPaymentRun(data.payment_run ?? null);
        setProcessError(null);
        setApprovalError(data.workflow_error ?? null);
        setFinalProcessError(null);
        // Clear selection so re-query shows fresh state.
        setSelectedKeys(new Set());
        setRowMarkers({});
        paymentRunsQuery.refetch();
      } else {
        setProcessError(data.error ?? "SunSystems returned an error.");
        setProcessedCount(null);
        setCurrentPaymentRun(null);
      }
    },
    onError: (err: any) => {
      setProcessError(
        err?.response?.data?.error ?? "Failed to reach SunSystems. Please try again."
      );
      setProcessedCount(null);
      setCurrentPaymentRun(null);
    },
  });

  const processPaymentMutation = useMutation({
    mutationFn: (paymentRunId: string) =>
      sunsystemsAPI.processPaymentRun(paymentRunId).then((r) => r.data),
    onSuccess: (data) => {
      if (data.payment_run) {
        if (!currentPaymentRun || currentPaymentRun.id === data.payment_run.id) {
          setCurrentPaymentRun(data.payment_run);
        }
      }
      setRetryError(data.ok === false ? data.error ?? "SunSystems returned an error." : null);
      paymentRunsQuery.refetch();
    },
    onError: (err: any) => {
      const payload = err?.response?.data;
      setRetryError(payload?.error ?? payload?.detail ?? "Payment processing failed.");
      if (payload?.payment_run) setCurrentPaymentRun(payload.payment_run);
      paymentRunsQuery.refetch();
    },
  });

  const mutation = useMutation({
    mutationFn: () =>
      sunsystemsAPI.paymentRun({
        ...filters,
        account_codes: selectedAccountCodes.join(","),
      }).then((r) => r.data),
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
  const selectableKeys = allKeys.filter((k, i) => !sorted[i].already_submitted);
  const allSelected = selectableKeys.length > 0 && selectableKeys.every((k) => selectedKeys.has(k));
  const someSelected = selectableKeys.some((k) => selectedKeys.has(k));

  const toggleRow = (key: string) => {
    const row = sorted.find((_, i) => rowKey(sorted[i], i) === key);
    if (row?.already_submitted) return; // Prevent selecting already-submitted rows
    
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
      const selectableKeys = allKeys.filter((k, i) => !sorted[i].already_submitted);
      setSelectedKeys(new Set(selectableKeys));
      setRowMarkers((prev) => {
        const next = { ...prev };
        selectableKeys.forEach((k) => { if (!next[k]) next[k] = DEFAULT_PAYMENT_MARKER; });
        return next;
      });
    }
  };

  const setMarker = (key: string, marker: string) =>
    setRowMarkers((prev) => ({ ...prev, [key]: marker }));

  // Lines selected for payment processing, with their chosen marker.
  const selectedLines = sorted
    .map((row, i) => ({ row, key: rowKey(row, i) }))
    .filter(({ key, row }) => selectedKeys.has(key) && !row.already_submitted)
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

      {/* ── Tab bar ── */}
      <div className="border-b border-[#C8CDD2] bg-white">
        <div className="mx-auto max-w-screen-2xl px-6">
          <div className="flex">
            {PAGE_TABS.map((tab) => (
              <button key={tab} onClick={() => setActiveTab(tab)}
                className={`flex items-center gap-2 px-5 py-3 text-sm font-semibold transition-colors -mb-px border-b-2 ${
                  activeTab === tab ? "border-[#287EAD] text-[#287EAD]" : "border-transparent text-[#5E6870] hover:text-[#1F2933]"
                }`}>
                {tab === "Recent Runs" && <History className="h-4 w-4" />}
                {tab}
                {tab === "Recent Runs" && paymentRuns.length > 0 && (
                  <span className="rounded-full bg-[#287EAD] px-1.5 py-0.5 text-[10px] font-bold text-white leading-none">{paymentRuns.length}</span>
                )}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* ── Recent Runs tab ── */}
      {activeTab === "Recent Runs" && (
        <div className="mx-auto w-full max-w-screen-2xl flex-1 px-6 py-6">
          <div className="border border-[#C8CDD2] bg-white shadow-sm">
            <div className="flex items-center gap-3 border-b border-[#C8CDD2] bg-[#F3F5F6] px-5 py-3">
              <History className="h-4 w-4 text-[#287EAD]" />
              <h2 className="text-sm font-bold text-[#1F2933]">Recent Payment Runs</h2>
              <span className="rounded bg-[#287EAD] px-2.5 py-0.5 text-xs font-bold text-white">{paymentRuns.length}</span>
              <button type="button" onClick={() => paymentRunsQuery.refetch()} disabled={paymentRunsQuery.isFetching}
                className="ml-auto inline-flex items-center gap-1.5 text-xs font-semibold text-[#5E6870] hover:text-[#287EAD] disabled:opacity-60">
                <RefreshCw className={`h-3.5 w-3.5 ${paymentRunsQuery.isFetching ? "animate-spin" : ""}`} />
                Refresh
              </button>
            </div>
            
            {/* Retry error banner */}
            {retryError && (
              <div className="flex items-start gap-3 border-b border-red-300 bg-red-50 px-5 py-3 text-sm text-red-800">
                <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                <span><strong>Retry error:</strong> {retryError}</span>
                <button
                  type="button"
                  onClick={() => setRetryError(null)}
                  className="ml-auto text-red-600 hover:text-red-800"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
            )}
            
            {paymentRuns.length === 0 ? (
              <div className="flex flex-col items-center justify-center gap-2 py-16 text-[#5E6870]">
                <History className="h-8 w-8 text-[#AEB5BB]" />
                <p className="text-sm font-semibold">No payment runs yet.</p>
                <p className="text-xs">Submitted payment runs will appear here.</p>
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full border-collapse text-sm">
                  <thead>
                    <tr className="border-b border-[#C8CDD2] bg-[#F7F8F9] text-xs">
                      {["Reference", "Submitted by", "Submitted", "Lines", "Amount", "Status", "Approvals", "Action"].map((h) => (
                        <th key={h} className="whitespace-nowrap border-r border-[#E5E9EC] px-3 py-2.5 text-left font-bold uppercase tracking-wider text-[#5E6870] last:border-r-0">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {paymentRuns.map((run) => {
                      const statusMeta: Record<string, string> = {
                        pending_approval: "bg-amber-50 text-amber-700 border-amber-200",
                        rejected: "bg-orange-50 text-orange-700 border-orange-200",
                        approved: "bg-blue-50 text-blue-700 border-blue-200",
                        processing: "bg-amber-50 text-amber-700 border-amber-200",
                        paid: "bg-emerald-50 text-emerald-700 border-emerald-200",
                        failed: "bg-red-50 text-red-700 border-red-200",
                      };
                      const badge = statusMeta[run.status] ?? "bg-[#F3F5F6] text-[#5E6870] border-[#C8CDD2]";
                      const statusLabel = paymentRunStatusLabel(run);
                      return (
                        <tr key={run.id} className={`border-b border-[#EDF0F2] last:border-0 hover:bg-[#F3F8FB] ${
                          run.status === "failed" ? "bg-red-50/30" : run.status === "processing" ? "bg-amber-50/30" : ""
                        }`}>
                          <td className="border-r border-[#EDF0F2] px-3 py-2.5 font-mono font-bold text-[#287EAD]">{run.payment_reference}</td>
                          <td className="border-r border-[#EDF0F2] px-3 py-2.5 text-xs text-[#5E6870]">{run.submitted_by_name ?? "—"}</td>
                          <td className="border-r border-[#EDF0F2] px-3 py-2.5 text-xs text-[#5E6870]">{formatDateTime(run.submitted_at)}</td>
                          <td className="border-r border-[#EDF0F2] px-3 py-2.5 text-center">
                            <button
                              type="button"
                              onClick={() => setLinesSnapshotRun(run)}
                              className="inline-flex items-center gap-1.5 rounded border border-[#C8CDD2] bg-white px-2 py-1 text-xs font-semibold text-[#287EAD] hover:bg-[#EEF6FB]"
                              title="View submitted transaction lines"
                            >
                              <Eye className="h-3.5 w-3.5" />
                              <span className="tabular-nums">{run.line_count}</span>
                            </button>
                          </td>
                          <td className="border-r border-[#EDF0F2] px-3 py-2.5 text-right tabular-nums font-semibold">{formatAmount(run.total_amount)}</td>
                          <td className="border-r border-[#EDF0F2] px-3 py-2.5">
                            <span className={`inline-flex max-w-[220px] items-center rounded border px-2 py-0.5 text-xs font-semibold ${badge}`} title={statusLabel}>
                              <span className="truncate">{statusLabel}</span>
                            </span>
                          </td>
                          <td className="border-r border-[#EDF0F2] px-3 py-2.5 text-center text-xs text-[#5E6870]">
                            <span className="tabular-nums font-semibold text-[#1F2933]">
                              {run.approval_count}/{run.required_approvals}
                            </span>
                            {run.current_step_name && run.status === "pending_approval" ? (
                              <div className="mt-0.5 text-[10px] text-[#8C969E] truncate max-w-[140px] mx-auto" title={run.current_step_name}>
                                {run.current_step_name}
                              </div>
                            ) : null}
                          </td>
                          <td className="px-3 py-2.5">
                            {run.status === "failed" ? (
                              <button type="button" onClick={() => processPaymentMutation.mutate(run.id)}
                                disabled={processPaymentMutation.isPending}
                                className="inline-flex items-center gap-1.5 bg-[#287EAD] px-3 py-1.5 text-xs font-bold text-white hover:bg-[#1E6F99] disabled:opacity-60">
                                {processPaymentMutation.isPending ? <RefreshCw className="h-3.5 w-3.5 animate-spin" /> : <CreditCard className="h-3.5 w-3.5" />}
                                Retry Payment
                              </button>
                            ) : run.status === "rejected" ? (
                              <button type="button" onClick={() => processPaymentMutation.mutate(run.id)}
                                disabled={processPaymentMutation.isPending}
                                className="inline-flex items-center gap-1.5 bg-emerald-600 px-3 py-1.5 text-xs font-bold text-white hover:bg-emerald-700 disabled:opacity-60">
                                {processPaymentMutation.isPending ? <RefreshCw className="h-3.5 w-3.5 animate-spin" /> : <CreditCard className="h-3.5 w-3.5" />}
                                Retry
                              </button>
                            ) : run.status === "processing" ? (
                              isPaymentRunStuck(run) ? (
                                <button type="button" onClick={() => processPaymentMutation.mutate(run.id)}
                                  disabled={processPaymentMutation.isPending}
                                  className="inline-flex items-center gap-1.5 bg-amber-600 px-3 py-1.5 text-xs font-bold text-white hover:bg-amber-700 disabled:opacity-60">
                                  {processPaymentMutation.isPending ? <RefreshCw className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
                                  Retry (Stuck)
                                </button>
                              ) : (
                                <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-amber-700">
                                  <RefreshCw className="h-3.5 w-3.5 animate-spin" />
                                  Confirming payment…
                                </span>
                              )
                            ) : run.status === "pending_approval" ? (
                              <span className="text-xs font-semibold text-[#287EAD]">
                                {run.current_step_name ? `Awaiting ${run.current_step_name}` : "Awaiting approvers"}
                              </span>
                            ) : run.status === "approved" ? (
                              <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-blue-600">
                                <RefreshCw className="h-3.5 w-3.5 animate-spin" />
                                Processing payment…
                              </span>
                            ) : (
                              <span className="text-xs text-[#8C969E]">—</span>
                            )}
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
      )}

      {/* ── Payment Query tab ── */}
      {activeTab === "Payment Query" && (
        <div className="mx-auto w-full max-w-screen-2xl flex-1 px-6 py-6">
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
            {/* Account codes — searchable multi-select from SunSystems */}
            <div className="space-y-1.5 xl:col-span-2">
              <label className="block text-xs font-semibold uppercase tracking-wider text-[#5E6870]">
                Supplier accounts
              </label>
              <AccountMultiSelect
                accounts={accounts}
                value={selectedAccountCodes}
                onChange={setSelectedAccountCodes}
                isLoading={accountsQuery.isLoading}
                error={
                  accountsQuery.isError
                    ? "Could not load accounts from SunSystems."
                    : null
                }
                placeholder="All suppliers (no filter)"
              />
              <p className="text-[10px] text-[#8C969E]">
                {accounts.length > 0
                  ? `${accounts.length} suppliers loaded — select one or more, or leave blank for all.`
                  : accountsQuery.isLoading
                  ? "Fetching from SunSystems…"
                  : "Leave blank to query all account codes."}
              </p>
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
        {approvalError && !showConfirmModal && (
          <div className="flex items-start gap-3 border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-800">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>{approvalError}</span>
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
                        title={allSelected ? "Deselect all" : "Select all (excludes already-submitted)"}
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
                    {/* Status column */}
                    <th className="whitespace-nowrap border-r border-[#E5E9EC] px-3 py-2.5 text-left font-bold uppercase tracking-wider text-[#5E6870]">
                      Status
                    </th>
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
                    const isAlreadySubmitted = row.already_submitted === true;
                    return (
                      <tr
                        key={key}
                        onClick={() => !isAlreadySubmitted && toggleRow(key)}
                        className={`group border-b border-[#EDF0F2] transition-colors last:border-0 ${
                          isAlreadySubmitted
                            ? "bg-gray-50 cursor-not-allowed opacity-60"
                            : isSelected
                            ? "bg-amber-50 hover:bg-amber-100 cursor-pointer"
                            : "hover:bg-[#F3F8FB] cursor-pointer"
                        }`}
                      >
                        {/* Row checkbox */}
                        <td
                          className="w-10 border-r border-[#EDF0F2] px-3 py-2.5 text-center"
                          onClick={(e) => { e.stopPropagation(); if (!isAlreadySubmitted) toggleRow(key); }}
                        >
                          {isAlreadySubmitted ? (
                            <Lock className="h-4 w-4 text-gray-400" />
                          ) : isSelected ? (
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
                          else if (col.key === "allocation_marker") {
                            const marker = String(row.allocation_marker ?? "").trim();
                            displayValue = marker ? (
                              marker
                            ) : (
                              <span className="text-[#AEB5BB]" title="Not allocated in SunSystems">—</span>
                            );
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
                        
                        {/* Status column for already-submitted indicator */}
                        <td className="border-r border-[#EDF0F2] px-3 py-2.5 text-center">
                          {isAlreadySubmitted ? (
                            <div className="flex items-center justify-center gap-1.5 text-xs text-gray-500">
                              <Lock className="h-3 w-3" />
                              <span className="font-medium">Submitted</span>
                            </div>
                          ) : (
                            <span className="text-xs text-gray-400">—</span>
                          )}
                        </td>


                        {/* Per-row payment marker selector */}
                        <td
                          className="border-l border-[#EDF0F2] px-2 py-1.5"
                          onClick={(e) => e.stopPropagation()}
                        >
                          {isAlreadySubmitted ? (
                            <div className="flex items-center gap-1.5 text-xs text-gray-500">
                              <Lock className="h-3 w-3" />
                              <span className="font-medium">{row.existing_payment_ref || "Submitted"}</span>
                            </div>
                          ) : (
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
                          )}
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
      )}

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

              {/* Submit for approval — opens confirmation modal */}
              <button
                id="process-payment-btn"
                type="button"
                onClick={() => setShowConfirmModal(true)}
                className="inline-flex items-center gap-2 bg-[#287EAD] px-6 py-2.5 text-sm font-bold text-white shadow-sm hover:bg-[#1E6F99] transition-colors active:scale-95"
              >
                <Zap className="h-4 w-4" />
                Submit for Approval ({selectedLines.length})
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
            setCurrentPaymentRun(null);
            setApprovalError(null);
            amendMutation.reset();
            processPaymentMutation.reset();
          }}
          isProcessing={amendMutation.isPending}
          processError={processError}
          processedCount={processedCount}
          paymentRun={currentPaymentRun}
          approvalError={approvalError}
        />
      )}

      {linesSnapshotRun && (
        <LinesSnapshotModal
          run={linesSnapshotRun}
          onClose={() => setLinesSnapshotRun(null)}
        />
      )}
    </div>
  );
}
