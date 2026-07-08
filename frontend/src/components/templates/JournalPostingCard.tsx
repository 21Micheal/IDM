/**
 * JournalPostingCard — SunSystems journal posting status for a form document.
 *
 * Shows whether the document's journal has been posted to SunSystems (which
 * happens automatically on final approval), the returned journal number, and
 * any error — with a Retry action for a failed posting.
 */
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, CheckCircle2, Clock, Loader2, RefreshCw, Receipt } from "lucide-react";
import { sunsystemsAPI, type JournalPosting } from "@/services/api";
import { toast } from "@/components/ui/vault-toast";

const STATUS_META: Record<string, { label: string; cls: string; Icon: any }> = {
  posted:  { label: "Posted to SunSystems", cls: "border-emerald-300 bg-emerald-50 text-emerald-800", Icon: CheckCircle2 },
  failed:  { label: "Posting failed",        cls: "border-red-300 bg-red-50 text-red-800",            Icon: AlertTriangle },
  posting: { label: "Posting…",              cls: "border-sky-300 bg-sky-50 text-sky-800",            Icon: Loader2 },
  pending: { label: "Queued for posting",    cls: "border-amber-300 bg-amber-50 text-amber-900",      Icon: Clock },
  skipped: { label: "Posting not configured", cls: "border-[#C8CDD2] bg-[#F5F7F8] text-[#5E6870]",     Icon: Clock },
};

export default function JournalPostingCard({ documentId }: { documentId: string }) {
  const [retrying, setRetrying] = useState(false);

  const { data, isLoading, refetch } = useQuery({
    queryKey: ["sunsystems-posting", documentId],
    queryFn: () => sunsystemsAPI.getPosting(documentId).then((r) => r.data).catch(() => null),
    // Poll while a posting is in flight so the card resolves itself.
    refetchInterval: (q) => {
      const s = (q.state.data as JournalPosting | null)?.status;
      return s === "posting" || s === "pending" ? 3000 : false;
    },
  });

  // No posting row yet (and not an error) → the form may not post a journal.
  if (isLoading) return null;
  if (!data || data.status === "none") return null;

  const meta = STATUS_META[data.status] ?? STATUS_META.pending;
  const Icon = meta.Icon;
  const isPurchaseOrder = data.component === "PurchaseOrder";

  const onRetry = async () => {
    setRetrying(true);
    try {
      const { data: posting } = await sunsystemsAPI.retryPosting(documentId);
      if (posting.status === "posted") toast.success(`SunSystems posting ${posting.journal_number || ""} completed.`);
      else toast.error(posting.error || posting.message || "Posting failed.");
      refetch();
    } catch (e: any) {
      toast.error(e?.response?.data?.detail || "Could not retry posting.");
    } finally {
      setRetrying(false);
    }
  };

  return (
    <div className="border border-[#C8CDD2] bg-white shadow-sm">
      <div className="flex items-center gap-2 border-b border-[#C8CDD2] bg-[#F5F7F8] px-4 py-2.5">
        <Receipt className="h-4 w-4 text-[#287EAD]" />
        <p className="text-sm font-bold text-[#1F2933]">{isPurchaseOrder ? "SunSystems LPO" : "SunSystems Journal"}</p>
      </div>
      <div className="p-4 space-y-3">
        <div className={`flex items-center gap-2 rounded border px-3 py-2 ${meta.cls}`}>
          <Icon className={`h-4 w-4 ${data.status === "posting" ? "animate-spin" : ""}`} />
          <span className="text-sm font-semibold">{meta.label}</span>
        </div>

        <dl className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-xs">
          {data.journal_number && (
            <>
              <dt className="text-[#5E6870]">{isPurchaseOrder ? "SunSystems reference" : "Journal number"}</dt>
              <dd className="font-mono font-semibold text-[#1F2933]">{data.journal_number}</dd>
            </>
          )}
          {data.business_unit && (
            <>
              <dt className="text-[#5E6870]">Business unit</dt>
              <dd className="text-[#1F2933]">{data.business_unit}</dd>
            </>
          )}
          {data.posted_at && (
            <>
              <dt className="text-[#5E6870]">Posted</dt>
              <dd className="text-[#1F2933]">{new Date(data.posted_at).toLocaleString()}</dd>
            </>
          )}
          {data.attempts > 0 && (
            <>
              <dt className="text-[#5E6870]">Attempts</dt>
              <dd className="text-[#1F2933]">{data.attempts}</dd>
            </>
          )}
        </dl>

        {(data.error || data.message) && (
          <p className={`text-xs ${data.status === "failed" ? "text-red-600" : "text-[#5E6870]"}`}>
            {data.error || data.message}
          </p>
        )}

        {data.status === "failed" && (
          <button
            type="button"
            onClick={onRetry}
            disabled={retrying}
            className="inline-flex items-center gap-1.5 border border-[#287EAD] px-3 py-1.5 text-xs font-semibold text-[#287EAD] hover:bg-[#EEF6FB] disabled:opacity-50"
          >
            {retrying ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
            Retry posting
          </button>
        )}
      </div>
    </div>
  );
}
