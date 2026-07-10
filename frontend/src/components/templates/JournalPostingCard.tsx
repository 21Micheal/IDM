/**
 * JournalPostingCard — SunSystems posting status for a form document.
 *
 * Supports multi-stage posting (e.g. Stage 1 = Advance, Stage 2 = Retirement).
 * Each stage is shown as its own section. Stage N+1 is visually locked until
 * Stage N is posted. Within each stage, retry is available for failed rows,
 * and a collapsible raw-response panel aids future debugging.
 *
 * The card updates immediately from the retry API response so the user never
 * has to refresh the page. Structured SunSystems error messages (code + field)
 * are formatted in a dedicated block.
 */
import { useState, useCallback } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle, CheckCircle2, Clock, Loader2,
  RefreshCw, Receipt, ChevronDown, ChevronUp, FileCode, Lock, MessageSquare,
} from "lucide-react";
import { sunsystemsAPI, type JournalPosting } from "@/services/api";
import { toast } from "@/components/ui/vault-toast";

/* ─── status meta ─────────────────────────────────────────────────────────── */
const STATUS_META: Record<string, { label: string; cls: string; Icon: any }> = {
  posted:  { label: "Posted",             cls: "border-emerald-300 bg-emerald-50 text-emerald-800", Icon: CheckCircle2 },
  failed:  { label: "Posting failed",     cls: "border-red-300   bg-red-50   text-red-800",         Icon: AlertTriangle },
  posting: { label: "Posting…",           cls: "border-sky-300   bg-sky-50   text-sky-800",          Icon: Loader2 },
  pending: { label: "Queued",             cls: "border-amber-300 bg-amber-50 text-amber-900",        Icon: Clock },
  skipped: { label: "Not configured",     cls: "border-[#C8CDD2] bg-[#F5F7F8] text-[#5E6870]",      Icon: Clock },
};

/* ─── error message parser ────────────────────────────────────────────────── */
function parseErrorMessages(raw: string): { code: string; text: string; field: string; value: string }[] {
  if (!raw) return [];
  return raw.split(";").map((s) => s.trim()).filter(Boolean).map((segment) => {
    const codeMatch  = segment.match(/^\[(\d+)\]\s*/);
    const code       = codeMatch?.[1] ?? "";
    const rest       = codeMatch ? segment.slice(codeMatch[0].length) : segment;
    const ctxMatch   = rest.match(/\(([^)]+)\)\s*$/);
    const text       = ctxMatch ? rest.slice(0, rest.lastIndexOf(ctxMatch[0])).trim() : rest.trim();
    const ctx        = ctxMatch?.[1] ?? "";
    const fieldMatch = ctx.match(/field:\s*([^,]+)/);
    const valueMatch = ctx.match(/value:\s*(.+)/);
    return {
      code,
      text,
      field: fieldMatch?.[1]?.trim() ?? "",
      value: valueMatch?.[1]?.trim() ?? "",
    };
  });
}

/* ─── single stage row ────────────────────────────────────────────────────── */
function StageRow({
  posting,
  locked,
  onRetryDone,
  documentId,
}: {
  posting: JournalPosting;
  locked: boolean;
  onRetryDone: (updated: JournalPosting) => void;
  documentId: string;
}) {
  const [retrying, setRetrying] = useState(false);
  const [showRaw,  setShowRaw]  = useState(false);
  const [showSummary, setShowSummary] = useState(false);

  const isPO          = posting.component === "PurchaseOrder";
  const meta          = STATUS_META[posting.status] ?? STATUS_META.pending;
  const Icon          = meta.Icon;
  const errorMessages = parseErrorMessages(posting.error || posting.message || "");
  const hasError      = posting.status === "failed" && errorMessages.length > 0;
  const rawXml        = posting.response_xml || "";
  const hasSummary    = Boolean(posting.error || posting.message);
  const stageLabel    = posting.stage_label || (isPO ? "LPO" : `Stage ${posting.stage}`);

  const onRetry = useCallback(async () => {
    setRetrying(true);
    setShowRaw(false);
    try {
      const { data: result } = await sunsystemsAPI.retryPosting(documentId, posting.stage);
      onRetryDone(result);
      if (result.status === "posted") {
        toast.success(`${stageLabel} posted — ${result.journal_number || "no ref"}`);
      } else {
        const first = parseErrorMessages(result.error || result.message || "")[0];
        toast.error(first ? `[${first.code || "ERR"}] ${first.text}` : (result.error || result.message || "Posting failed."));
      }
    } catch (e: any) {
      toast.error(e?.response?.data?.detail || "Could not retry posting.");
    } finally {
      setRetrying(false);
    }
  }, [documentId, posting.stage, stageLabel, onRetryDone]);

  return (
    <div className={`space-y-3 ${locked ? "opacity-50 pointer-events-none select-none" : ""}`}>
      {/* stage label row */}
      <div className="flex items-center gap-2">
        {locked
          ? <Lock className="h-3.5 w-3.5 text-[#5E6870]" />
          : <span className="h-3.5 w-3.5 flex items-center justify-center rounded-full bg-[#287EAD] text-white text-[9px] font-bold flex-shrink-0">{posting.stage}</span>
        }
        <span className="text-xs font-semibold text-[#1F2933]">{stageLabel}</span>
        {locked && <span className="text-[10px] text-[#5E6870] ml-auto">Awaiting previous stage</span>}
      </div>

      {/* status badge */}
      <div className={`flex items-center gap-2 rounded border px-3 py-2 ${meta.cls}`}>
        <Icon className={`h-4 w-4 flex-shrink-0 ${posting.status === "posting" || retrying ? "animate-spin" : ""}`} />
        <span className="text-sm font-semibold">
          {retrying ? "Retrying…" : meta.label}
        </span>
      </div>

      {/* metadata grid */}
      {!retrying && (
        <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
          {posting.journal_number && (
            <>
              <dt className="text-sm font-medium text-[#475569]">{isPO ? "SunSystems ref" : "Journal number"}</dt>
              <dd className="font-mono font-semibold text-[#0F172A]">{posting.journal_number}</dd>
            </>
          )}
          {posting.business_unit && (
            <>
              <dt className="text-sm font-medium text-[#475569]">Business unit</dt>
              <dd className="font-semibold text-[#0F172A]">{posting.business_unit}</dd>
            </>
          )}
          {posting.posted_at && (
            <>
              <dt className="text-sm font-medium text-[#475569]">Posted</dt>
              <dd className="font-semibold text-[#0F172A]">{new Date(posting.posted_at).toLocaleString()}</dd>
            </>
          )}
          {(posting.attempts ?? 0) > 0 && (
            <>
              <dt className="text-sm font-medium text-[#475569]">Attempts</dt>
              <dd className="font-semibold text-[#0F172A]">{posting.attempts}</dd>
            </>
          )}
        </dl>
      )}

      {/* structured errors */}
      {!retrying && hasError && (
        <div className="space-y-1.5">
          {errorMessages.map((e, i) => (
            <div key={i} className="rounded border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-800 space-y-0.5">
              <div className="flex items-center gap-1.5 font-semibold">
                {e.code && <span className="bg-red-200 text-red-900 font-mono px-1 rounded text-[10px]">#{e.code}</span>}
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

      {/* action buttons */}
      {!retrying && (
        <div className="flex items-center gap-2 flex-wrap">
          {posting.status === "failed" && (
            <button
              type="button"
              onClick={onRetry}
              className="inline-flex items-center gap-1.5 border border-[#287EAD] px-3 py-1.5 text-xs font-semibold text-[#287EAD] hover:bg-[#EEF6FB]"
            >
              <RefreshCw className="h-3.5 w-3.5" />
              Retry
            </button>
          )}
          {hasSummary && (
            <button
              type="button"
              onClick={() => setShowSummary((v) => !v)}
              className="inline-flex items-center gap-1.5 border border-[#C8CDD2] px-3 py-1.5 text-xs font-semibold text-[#5E6870] hover:bg-[#F3F5F6]"
            >
              <MessageSquare className="h-3.5 w-3.5" />
              {showSummary ? "Hide summary" : "Show summary"}
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

      {showSummary && !retrying && hasSummary && (
        <div className="rounded border border-[#C8CDD2] bg-[#F8FAFB] p-3 text-sm text-[#0F172A]">
          <p>{posting.error || posting.message}</p>
        </div>
      )}

      {/* collapsible raw XML */}
      {showRaw && rawXml && (
        <pre className="max-h-64 overflow-auto rounded border border-[#C8CDD2] bg-[#F8FAFB] p-3 text-[10px] leading-relaxed text-[#3D4B55] whitespace-pre-wrap break-all">
          {rawXml}
        </pre>
      )}
    </div>
  );
}

/* ─── main card ───────────────────────────────────────────────────────────── */
export default function JournalPostingCard({ documentId }: { documentId: string }) {
  const qc = useQueryClient();
  // Local overrides keyed by stage — updated immediately from retry responses.
  const [localPostings, setLocalPostings] = useState<Record<number, JournalPosting>>({});

  const { data: serverPostings, isLoading } = useQuery({
    queryKey: ["sunsystems-postings", documentId],
    queryFn: () =>
      sunsystemsAPI.getPostings(documentId)
        .then((r) => r.data)
        .catch(() => null),
    refetchInterval: (q) => {
      const rows = q.state.data as JournalPosting[] | null;
      const hasInFlight = rows?.some((p) => p.status === "posting" || p.status === "pending");
      return hasInFlight ? 3000 : false;
    },
  });

  // Merge server data with local overrides (local wins while fresher).
  const postings: JournalPosting[] = (serverPostings ?? []).map((server) => {
    const local = localPostings[server.stage];
    if (!local) return server;
    // Discard local once server has caught up.
    if ((server.attempts ?? 0) > (local.attempts ?? 0) || server.status !== local.status) return server;
    return local;
  });

  const handleRetryDone = useCallback((updated: JournalPosting) => {
    setLocalPostings((prev) => ({ ...prev, [updated.stage]: updated }));
    qc.invalidateQueries({ queryKey: ["sunsystems-postings", documentId] });
  }, [documentId, qc]);

  /* ── early exits ──────────────────────────────────────────────────────── */
  if (isLoading && postings.length === 0) return null;
  if (postings.length === 0 || (postings[0] as any)?.status === "none") return null;

  const isPO = postings[0]?.component === "PurchaseOrder";

  /* ── render ───────────────────────────────────────────────────────────── */
  return (
    <div className="border border-[#C8CDD2] bg-white shadow-sm">
      {/* header */}
      <div className="flex items-center gap-2 border-b border-[#C8CDD2] bg-[#F5F7F8] px-4 py-2.5">
        <Receipt className="h-4 w-4 text-[#287EAD]" />
        <p className="text-sm font-bold text-[#1F2933]">
          {isPO ? "SunSystems LPO" : "SunSystems Journal"}
        </p>
        {postings.length > 1 && (
          <span className="ml-auto text-[10px] text-[#5E6870] font-medium">
            {postings.filter((p) => p.status === "posted").length}/{postings.length} stages posted
          </span>
        )}
      </div>

      <div className="p-4 divide-y divide-[#E8EAEC]">
        {postings.map((posting, idx) => {
          // A stage is locked if the previous stage hasn't been posted yet.
          const prevPosted = idx === 0 || postings[idx - 1]?.status === "posted";
          return (
            <div key={posting.id} className={idx > 0 ? "pt-4 mt-4" : ""}>
              <StageRow
                posting={localPostings[posting.stage] ?? posting}
                locked={!prevPosted}
                onRetryDone={handleRetryDone}
                documentId={documentId}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}
