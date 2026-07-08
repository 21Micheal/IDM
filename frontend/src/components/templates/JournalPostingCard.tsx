/**
 * JournalPostingCard — SunSystems posting status for a form document.
 *
 * Shows whether the document's journal / LPO has been posted to SunSystems,
 * the returned reference number, and any error — with a Retry action for a
 * failed posting.
 *
 * The card updates **immediately** from the retry API response so the user
 * never has to refresh the page.  Structured SunSystems error messages
 * (including message code, offending field, and offending value) are formatted
 * in a dedicated block.  A collapsible "Raw response" panel is available for
 * debugging future issues.
 */
import { useState, useCallback } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle, CheckCircle2, Clock, Loader2,
  RefreshCw, Receipt, ChevronDown, ChevronUp, FileCode,
} from "lucide-react";
import { sunsystemsAPI, type JournalPosting } from "@/services/api";
import { toast } from "@/components/ui/vault-toast";

/* ─── status meta ─────────────────────────────────────────────────────────── */
const STATUS_META: Record<string, { label: string; cls: string; Icon: any }> = {
  posted:  { label: "Posted to SunSystems", cls: "border-emerald-300 bg-emerald-50 text-emerald-800", Icon: CheckCircle2 },
  failed:  { label: "Posting failed",        cls: "border-red-300   bg-red-50   text-red-800",         Icon: AlertTriangle },
  posting: { label: "Posting…",              cls: "border-sky-300   bg-sky-50   text-sky-800",          Icon: Loader2 },
  pending: { label: "Queued for posting",    cls: "border-amber-300 bg-amber-50 text-amber-900",        Icon: Clock },
  skipped: { label: "Posting not configured",cls: "border-[#C8CDD2] bg-[#F5F7F8] text-[#5E6870]",      Icon: Clock },
};

/* ─── error message parser ────────────────────────────────────────────────── */
/**
 * Parses the structured message strings emitted by our backend parser, e.g.:
 *   "[2527] A zero quantity … (field: PurchaseOrder.PurchaseOrderLine.CurrencyCode, value: USD)"
 * Returns an array of { code, text, field, value } objects for rich display.
 */
function parseErrorMessages(raw: string): { code: string; text: string; field: string; value: string }[] {
  if (!raw) return [];
  return raw.split(";").map((s) => s.trim()).filter(Boolean).map((segment) => {
    const codeMatch   = segment.match(/^\[(\d+)\]\s*/);
    const code        = codeMatch?.[1] ?? "";
    const rest        = codeMatch ? segment.slice(codeMatch[0].length) : segment;
    const ctxMatch    = rest.match(/\(([^)]+)\)\s*$/);
    const text        = ctxMatch ? rest.slice(0, rest.lastIndexOf(ctxMatch[0])).trim() : rest.trim();
    const ctx         = ctxMatch?.[1] ?? "";
    const fieldMatch  = ctx.match(/field:\s*([^,]+)/);
    const valueMatch  = ctx.match(/value:\s*(.+)/);
    return {
      code,
      text,
      field: fieldMatch?.[1]?.trim() ?? "",
      value: valueMatch?.[1]?.trim() ?? "",
    };
  });
}

/* ─── component ───────────────────────────────────────────────────────────── */
export default function JournalPostingCard({ documentId }: { documentId: string }) {
  const qc = useQueryClient();

  // Local override of posting data — set immediately from the retry response
  // so the UI updates without waiting for a background refetch.
  const [localPosting, setLocalPosting] = useState<JournalPosting | null>(null);
  const [retrying,     setRetrying]     = useState(false);
  const [showRaw,      setShowRaw]      = useState(false);

  const { data: serverPosting, isLoading } = useQuery({
    queryKey: ["sunsystems-posting", documentId],
    queryFn: () =>
      sunsystemsAPI.getPosting(documentId).then((r) => r.data).catch(() => null),
    // Poll while in-flight so the card auto-resolves when posting completes.
    refetchInterval: (q) => {
      const s = (q.state.data as JournalPosting | null)?.status;
      return s === "posting" || s === "pending" ? 3000 : false;
    },
    // Merge local override: if we have a local result, keep it until the
    // server confirms a newer state (higher attempt count or different status).
    select: (server) => {
      if (!localPosting || !server) return server;
      if (
        (server.attempts ?? 0) > (localPosting.attempts ?? 0) ||
        server.status !== localPosting.status
      ) {
        return server;   // server has newer data — discard local override
      }
      return localPosting;
    },
  });

  // The posting we actually display: prefer the local override so the UI
  // updates the moment the retry call returns.
  const posting: JournalPosting | null = localPosting ?? serverPosting ?? null;

  const onRetry = useCallback(async () => {
    setRetrying(true);
    setShowRaw(false);
    try {
      const { data: result } = await sunsystemsAPI.retryPosting(documentId);

      // ── Immediately update the displayed card from the retry response ──
      setLocalPosting(result);

      if (result.status === "posted") {
        toast.success(
          `SunSystems ${result.component === "PurchaseOrder" ? "LPO" : "journal"} ${result.journal_number || ""} posted.`
        );
      } else {
        const first = parseErrorMessages(result.error || result.message || "")[0];
        const msg   = first
          ? `[${first.code || "ERR"}] ${first.text}`
          : (result.error || result.message || "Posting failed.");
        toast.error(msg);
      }

      // Invalidate the query so a background refetch keeps the cache fresh.
      qc.invalidateQueries({ queryKey: ["sunsystems-posting", documentId] });
    } catch (e: any) {
      const detail = e?.response?.data?.detail || "Could not retry posting.";
      toast.error(detail);
    } finally {
      setRetrying(false);
    }
  }, [documentId, qc]);

  /* ── early exits ─────────────────────────────────────────────────────────── */
  if (isLoading && !posting) return null;
  if (!posting || (posting as any).status === "none") return null;

  const meta           = STATUS_META[posting.status] ?? STATUS_META.pending;
  const Icon           = meta.Icon;
  const isPO           = posting.component === "PurchaseOrder";
  const errorMessages  = parseErrorMessages(posting.error || posting.message || "");
  const hasError       = posting.status === "failed" && errorMessages.length > 0;
  const rawXml         = (posting as any).response_xml || "";

  /* ── render ──────────────────────────────────────────────────────────────── */
  return (
    <div className="border border-[#C8CDD2] bg-white shadow-sm">
      {/* header */}
      <div className="flex items-center gap-2 border-b border-[#C8CDD2] bg-[#F5F7F8] px-4 py-2.5">
        <Receipt className="h-4 w-4 text-[#287EAD]" />
        <p className="text-sm font-bold text-[#1F2933]">
          {isPO ? "SunSystems LPO" : "SunSystems Journal"}
        </p>
      </div>

      <div className="p-4 space-y-3">
        {/* ── status badge ──────────────────────────────────────────────── */}
        <div className={`flex items-center gap-2 rounded border px-3 py-2 ${meta.cls}`}>
          <Icon className={`h-4 w-4 flex-shrink-0 ${posting.status === "posting" || retrying ? "animate-spin" : ""}`} />
          <span className="text-sm font-semibold">
            {retrying ? "Retrying posting…" : meta.label}
          </span>
        </div>

        {/* ── metadata grid ─────────────────────────────────────────────── */}
        {!retrying && (
          <dl className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-xs">
            {posting.journal_number && (
              <>
                <dt className="text-[#5E6870]">{isPO ? "SunSystems reference" : "Journal number"}</dt>
                <dd className="font-mono font-semibold text-[#1F2933]">{posting.journal_number}</dd>
              </>
            )}
            {posting.business_unit && (
              <>
                <dt className="text-[#5E6870]">Business unit</dt>
                <dd className="text-[#1F2933]">{posting.business_unit}</dd>
              </>
            )}
            {posting.posted_at && (
              <>
                <dt className="text-[#5E6870]">Posted</dt>
                <dd className="text-[#1F2933]">{new Date(posting.posted_at).toLocaleString()}</dd>
              </>
            )}
            {(posting.attempts ?? 0) > 0 && (
              <>
                <dt className="text-[#5E6870]">Attempts</dt>
                <dd className="text-[#1F2933]">{posting.attempts}</dd>
              </>
            )}
          </dl>
        )}

        {/* ── structured error messages ──────────────────────────────────── */}
        {!retrying && hasError && (
          <div className="space-y-1.5">
            {errorMessages.map((e, i) => (
              <div key={i} className="rounded border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-800 space-y-0.5">
                <div className="flex items-center gap-1.5 font-semibold">
                  {e.code && (
                    <span className="bg-red-200 text-red-900 font-mono px-1 rounded text-[10px]">
                      #{e.code}
                    </span>
                  )}
                  <span>{e.text}</span>
                </div>
                {(e.field || e.value) && (
                  <div className="flex gap-3 text-[11px] text-red-600 font-mono mt-0.5">
                    {e.field && <span>field: {e.field}</span>}
                    {e.value && <span>value: {e.value}</span>}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}

        {/* plain message fallback (non-error statuses, advisory messages) */}
        {!retrying && !hasError && (posting.error || posting.message) && (
          <p className={`text-xs ${posting.status === "failed" ? "text-red-600" : "text-[#5E6870]"}`}>
            {posting.error || posting.message}
          </p>
        )}

        {/* ── actions row ───────────────────────────────────────────────── */}
        {!retrying && (
          <div className="flex items-center gap-2 flex-wrap">
            {posting.status === "failed" && (
              <button
                type="button"
                onClick={onRetry}
                disabled={retrying}
                className="inline-flex items-center gap-1.5 border border-[#287EAD] px-3 py-1.5 text-xs font-semibold text-[#287EAD] hover:bg-[#EEF6FB] disabled:opacity-50"
              >
                <RefreshCw className="h-3.5 w-3.5" />
                Retry posting
              </button>
            )}
            {rawXml && (
              <button
                type="button"
                onClick={() => setShowRaw((v) => !v)}
                className="inline-flex items-center gap-1.5 border border-[#C8CDD2] px-3 py-1.5 text-xs font-semibold text-[#5E6870] hover:bg-[#F3F5F6]"
              >
                <FileCode className="h-3.5 w-3.5" />
                {showRaw ? "Hide" : "Show"} response
                {showRaw ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
              </button>
            )}
          </div>
        )}

        {/* ── collapsible raw response ───────────────────────────────────── */}
        {showRaw && rawXml && (
          <pre className="mt-1 max-h-64 overflow-auto rounded border border-[#C8CDD2] bg-[#F8FAFB] p-3 text-[10px] leading-relaxed text-[#3D4B55] whitespace-pre-wrap break-all">
            {rawXml}
          </pre>
        )}
      </div>
    </div>
  );
}
