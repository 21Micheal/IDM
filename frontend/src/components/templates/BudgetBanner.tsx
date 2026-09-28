import { AlertTriangle, Wallet } from "lucide-react";

type Props = {
  /** Amount being requested / monitored */
  amount: number | string;
  /** Configured budget. null / "" = not configured */
  budget: number | string | null;
  currency?: string;
  accountCode?: string;
};

const toNum = (v: unknown) => {
  const n = parseFloat(String(v ?? "").replace(/,/g, ""));
  return Number.isFinite(n) ? n : 0;
};
const money = (currency: string, n: number) =>
  `${currency} ${n.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;

export default function BudgetBanner({ amount, budget, currency = "KSh", accountCode }: Props) {
  const requested = toNum(amount);
  const budgetConfigured = budget !== null && budget !== "" && budget !== undefined;

  if (!budgetConfigured) {
    return null;
  }

  const budgetNum = toNum(budget);
  const remaining = budgetNum - requested;
  const over = remaining < 0;

  // Only show warning when over budget
  if (!over) {
    return null;
  }

  return (
    <div className="w-fit rounded border border-red-300 bg-red-50 px-3 py-2">
      <div className="flex items-center gap-2">
        <AlertTriangle className="h-4 w-4 text-red-600" />
        <span className="text-sm font-semibold text-red-800">
          Over budget by {money(currency, -remaining)}
        </span>
      </div>
      {accountCode && (
        <div className="mt-1 text-xs text-red-700">
          Account <b>{accountCode}</b>
        </div>
      )}
    </div>
  );
}