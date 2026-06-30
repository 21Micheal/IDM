/**
 * BudgetBanner — live SunSystems budget availability while a form is filled.
 *
 * Keeps the user "always aware" of available budget: whenever the relevant
 * amount/account fields change, it asks the backend (which talks to SunSystems,
 * or a stub until a real budget-inquiry is wired) and shows remaining budget and
 * whether the entered amount fits.
 *
 * Resolution of the budget mapping is server-side: pass `templateId` (+ inline
 * `mapping` if previewing) for a new form, or `documentId` for a saved form.
 */
import { useEffect, useRef, useState } from "react";
import { AlertTriangle, CheckCircle2, Loader2, Wallet } from "lucide-react";
import { sunsystemsAPI, type BudgetResult } from "@/services/api";

type Props = {
  values: Record<string, unknown>;
  templateId?: string;
  documentId?: string;
  /** Compiled budget mapping (builder/fill). When absent the server resolves it. */
  mapping?: Record<string, unknown> | null;
  /** Form schema — lets the check see builder default values the user hasn't
   *  typed over yet (only touched fields are otherwise in `values`). */
  sections?: unknown[];
  /** Skip entirely when the form has no budget check configured. */
  enabled?: boolean;
};

function money(currency: string, amount: string) {
  return `${currency} ${Number(amount || 0).toLocaleString()}`;
}

/* Overlay builder default values for fields the user hasn't touched, so a budget
 * amount/account bound to a default-bearing field is seen by the live check. */
function withSchemaDefaults(sections: unknown[] | undefined, values: Record<string, unknown>) {
  const out: Record<string, unknown> = { ...values };
  for (const s of (sections ?? []) as Array<{ fields?: Array<Record<string, any>> }>) {
    for (const f of s.fields ?? []) {
      const key = f.key ?? f.id;
      if (!key) continue;
      const cur = out[key];
      const empty = cur == null || (typeof cur === "string" && cur.trim() === "");
      if (empty && f.defaultValue != null && f.defaultValue !== "") out[key] = f.defaultValue;
    }
  }
  return out;
}

export default function BudgetBanner({ values, templateId, documentId, mapping, sections, enabled = true }: Props) {
  const [result, setResult] = useState<BudgetResult | null>(null);
  const [loading, setLoading] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Effective values include builder defaults for untouched fields.
  const effectiveValues = withSchemaDefaults(sections, values ?? {});
  // Re-run only when values actually change, debounced.
  const valuesKey = JSON.stringify(effectiveValues);

  useEffect(() => {
    if (!enabled) return;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(async () => {
      setLoading(true);
      try {
        const { data } = await sunsystemsAPI.budgetCheck({
          template_id: templateId,
          document_id: documentId,
          values: effectiveValues,
          mapping: mapping ?? undefined,
        });
        setResult(data);
      } catch {
        setResult(null);
      } finally {
        setLoading(false);
      }
    }, 500);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [valuesKey, enabled, templateId, documentId]);

  if (!enabled) return null;
  // Nothing usable yet (no account/amount resolved) — stay quiet.
  if (!result || !result.available) {
    if (loading) {
      return (
        <div className="flex items-center gap-2 rounded border border-[#C8CDD2] bg-[#F5F7F8] px-3 py-2 text-xs text-[#5E6870]">
          <Loader2 className="h-3.5 w-3.5 animate-spin" /> Checking SunSystems budget…
        </div>
      );
    }
    return null;
  }

  const ok = result.ok;
  const tone = ok
    ? "border-emerald-300 bg-emerald-50 text-emerald-800"
    : result.mode === "block"
      ? "border-red-300 bg-red-50 text-red-800"
      : "border-amber-300 bg-amber-50 text-amber-900";
  const Icon = ok ? CheckCircle2 : AlertTriangle;

  return (
    <div className={`rounded border px-3 py-2.5 ${tone}`}>
      <div className="flex items-center gap-2">
        {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Icon className="h-4 w-4" />}
        <span className="text-sm font-semibold">
          {ok ? "Within budget" : result.mode === "block" ? "Over budget — cannot submit" : "Over budget"}
        </span>
        {result.stub && (
          <span className="ml-1 rounded bg-black/5 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide opacity-70">
            preview
          </span>
        )}
      </div>
      <div className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
        <span className="inline-flex items-center gap-1"><Wallet className="h-3 w-3" /> Account <b>{result.account || "—"}</b></span>
        <span>Remaining <b>{money(result.currency, result.remaining)}</b></span>
        <span>Requested <b>{money(result.currency, result.requested)}</b></span>
        {!ok && <span>Over by <b>{money(result.currency, result.over_by)}</b></span>}
      </div>
    </div>
  );
}
