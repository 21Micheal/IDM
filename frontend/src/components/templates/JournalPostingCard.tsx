/**
 * JournalPostingCard — SunSystems posting status for a form document.
 *
 * Rendered as a distinct "system status" panel, visually separate from the
 * form content — compact rows, pill badges, collapsible errors.
 */
import { useState, useCallback, useEffect, useRef } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle, CheckCircle2, Clock, Loader2,
  RefreshCw, ChevronDown, FileCode, Lock, Activity,
} from "lucide-react";
import { sunsystemsAPI, type JournalPosting } from "@/services/api";
import { toast } from "@/components/ui/vault-toast";

/* ─── status config ───────────────────────────────────────────────────────── */
const STATUS: Record<string, { label: string; dot: string; text: string; Icon: any }> = {
  posted:  { label: "Posted",          dot: "bg-emerald-500", text: "text-emerald-700", Icon: CheckCircle2 },
  failed:  { label: "Failed",          dot: "bg-red-500",     text: "text-red-700",     Icon: AlertTriangle },
  posting: { label: "Posting…",        dot: "bg-sky-400 animate-pulse", text: "text-sky-700", Icon: Loader2 },
  pending: { label: "Queued",          dot: "bg-amber-400",   text: "text-amber-700",   Icon: Clock },
  skipped: { label: "Not configured",  dot: "bg-[#AEB5BB]",   text: "text-[#5E6870]",  Icon: Clock },
};

/* ─── error parser ────────────────────────────────────────────────────────── */
function parseErrors(raw: string): { code: string; text: string; field: string; value: string }[] {
  if (!raw) return [];
  return raw.split(";").map((s) => s.trim()).filter(Boolean).map((segment) => {
    const codeMatch = segment.match(/^\[(\d+)\]\s*/);
    const code      = codeMatch?.[1] ?? "";
    const rest      = codeMatch ? segment.slice(codeMatch[0].length) : segment;
    const ctxMatch  = rest.match(/\(([^)]+)\)\s*$/);
    const text      = ctxMatch ? rest.slice(0, rest.lastIndexOf(ctxMatch[0])).trim() : rest.trim();
    const ctx       = ctxMatch?.[1] ?? "";
    const fieldMatch = ctx.match(/field:\s*([^,]+)/);
    const valueMatch = ctx.match(/value:\s*(.+)/);
    return { code, text, field: fieldMatch?.[1]?.trim() ?? "", value: valueMatch?.[1]?.trim() ?? "" };
  });
}

/* ─── single stage row ────────────────────────────────────────────────────── */
function StageRow({
  posting, locked, onRetryDone, documentId,
}: {
  posting: JournalPosting;
  locked: boolean;
  onRetryDone: (updated: JournalPosting) => void;
  documentId: string;
}) {
  const [retrying, setRetrying]   = useState(false);
  const [expanded, setExpanded]   = useState(false);
  const [xmlOpen,  setXmlOpen]    = useState(false);

  const isPO          = posting.component === "PurchaseOrder";
  const cfg           = STATUS[posting.status] ?? STATUS.pending;
  const Icon          = cfg.Icon;
  const errors        = parseErrors(posting.error || posting.message || "");
  const hasFailed     = posting.status === "failed";
  const rawXml        = posting.response_xml || "";
  const stageLabel    = isPO
    ? (posting.stage_label || "LPO")
    : posting.stage === 1 ? "Initial" : posting.stage === 2 ? "Retirement" : posting.stage_label || `Stage ${posting.stage}`;

  const onRetry = useCallback(async () => {
    setRetrying(true);
    setExpanded(false);
    try {
      const { data: result } = await sunsystemsAPI.retryPosting(documentId, posting.stage);
      onRetryDone(result);
      if (result.status === "posted") {
        toast.success(`${stageLabel} posted — ${result.journal_number || "no ref"}`);
      } else {
        const first = parseErrors(result.error || result.message || "")[0];
        toast.error(first ? `[${first.code || "ERR"}] ${first.text}` : (result.error || result.message || "Posting failed."));
      }
    } catch (e: any) {
      toast.error(e?.response?.data?.detail || "Could not retry posting.");
    } finally {
      setRetrying(false);
    }
  }, [documentId, posting.stage, stageLabel, onRetryDone]);

  return (
    <div className={`${locked ? "opacity-50 pointer-events-none select-none" : ""}`}>
      {/* ── compact status row ── */}
      <div className="flex items-center gap-2 py-2 px-4 min-h-[2.25rem]">

        {/* stage number or lock */}
        {locked
          ? <Lock className="h-3 w-3 text-[#AEB5BB] shrink-0" />
          : <span className="h-4 w-4 flex items-center justify-center rounded-full bg-[#287EAD]/10 text-[#287EAD] text-[9px] font-bold shrink-0">{posting.stage}</span>
        }

        {/* stage label */}
        <span className="text-[13px] font-semibold text-[#5E6870] uppercase tracking-wide w-20 shrink-0">
          {stageLabel}
        </span>

        {/* status pill */}
        <span className={`flex items-center gap-1.5 text-[13px] font-semibold ${cfg.text}`}>
          <span className={`h-1.5 w-1.5 rounded-full shrink-0 ${cfg.dot}`} />
          {retrying ? "Retrying…" : cfg.label}
          {posting.status === "posting" && <Loader2 className="h-3 w-3 animate-spin ml-0.5" />}
        </span>

        {/* key facts — shown inline when posted */}
        {posting.journal_number && !retrying && (
          <span className="ml-2 font-mono text-[13px] text-[#287EAD] font-semibold">
            #{posting.journal_number}
          </span>
        )}
        {posting.business_unit && !retrying && (
          <span className="text-xs text-[#8C969E] border border-[#E0E4E8] bg-[#F3F5F6] px-1.5 py-0.5 rounded">
            {posting.business_unit}
          </span>
        )}
        {posting.posted_at && !retrying && (
          <span className="text-xs text-[#8C969E] ml-1">
            {new Date(posting.posted_at).toLocaleDateString()} {new Date(posting.posted_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
          </span>
        )}
        {locked && (
          <span className="ml-auto text-xs text-[#AEB5BB] italic">awaiting previous stage</span>
        )}

        {/* right-side action cluster */}
        <div className="ml-auto flex items-center gap-1.5 shrink-0">
          {(hasFailed || posting.status === "skipped") && !retrying && (
            <button
              type="button"
              onClick={onRetry}
              className="inline-flex items-center gap-1 border border-[#287EAD] px-2 py-0.5 text-xs font-semibold text-[#287EAD] hover:bg-[#EEF6FB] transition-colors"
            >
              <RefreshCw className="h-2.5 w-2.5" />
              {posting.status === "skipped" ? "Retry" : "Retry"}
            </button>
          )}
          {rawXml && (
            <button
              type="button"
              onClick={() => setXmlOpen(true)}
              className="inline-flex items-center gap-1 border border-[#C8CDD2] px-2 py-0.5 text-xs font-semibold text-[#5E6870] hover:bg-[#F3F5F6] transition-colors"
            >
              <FileCode className="h-2.5 w-2.5" /> XML
            </button>
          )}
          {hasFailed && errors.length > 0 && (
            <button
              type="button"
              onClick={() => setExpanded((v) => !v)}
              className="inline-flex items-center gap-0.5 text-xs font-semibold text-red-600 hover:text-red-800 transition-colors"
            >
              <ChevronDown className={`h-3 w-3 transition-transform ${expanded ? "rotate-180" : ""}`} />
              {expanded ? "Hide" : "Details"}
            </button>
          )}
        </div>
      </div>

      {/* ── collapsible error detail ── */}
      {hasFailed && expanded && errors.length > 0 && (
        <div className="mx-4 mb-2 border border-red-200 bg-red-50 divide-y divide-red-100">
          {errors.map((e, i) => (
            <div key={i} className="px-3 py-2 text-[13px] text-red-800 space-y-0.5">
              <div className="flex items-center gap-1.5 font-semibold">
                {e.code && <span className="font-mono bg-red-200 text-red-900 px-1 rounded text-xs">#{e.code}</span>}
                <span>{e.text}</span>
              </div>
              {(e.field || e.value) && (
                <div className="flex gap-3 text-xs text-red-600 font-mono">
                  {e.field && <span>field: {e.field}</span>}
                  {e.value && <span>value: {e.value}</span>}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* ── XML modal ── */}
      {xmlOpen && (
        <div
          className="fixed inset-0 z-[70] flex items-center justify-center bg-black/50 p-4"
          onClick={(e) => { if (e.target === e.currentTarget) setXmlOpen(false); }}
        >
          <div className="w-full max-w-lg border border-[#C8CDD2] bg-white shadow-xl">
            <div className="flex items-center justify-between gap-3 border-b border-[#C8CDD2] bg-[#50545A] px-4 py-2.5">
              <p className="text-sm font-bold text-white">{stageLabel} — SunSystems response XML</p>
              <button
                type="button"
                onClick={() => setXmlOpen(false)}
                className="flex items-center gap-1 border border-white/30 bg-white/10 px-2 py-1 text-xs font-semibold text-white hover:bg-white/20"
              >
                <ChevronDown className="h-3.5 w-3.5 rotate-90" /> Close
              </button>
            </div>
            <div className="p-4 max-h-[60vh] overflow-y-auto">
              <pre className="whitespace-pre-wrap break-all text-[13px] leading-relaxed text-[#3D4B55]">
                {rawXml}
              </pre>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/* ─── main card ───────────────────────────────────────────────────────────── */
export default function JournalPostingCard({
  documentId,
  expectPosting = false,
  watchKey,
  availableStages,
}: {
  documentId: string;
  expectPosting?: boolean;
  watchKey?: string | number | null;
  availableStages?: number[];
}) {
  const qc = useQueryClient();
  const [localPostings, setLocalPostings] = useState<Record<number, JournalPosting>>({});
  // Tracks seconds since last successful fetch for the live indicator.
  const [secondsAgo, setSecondsAgo]     = useState(0);
  const lastFetchRef                     = useRef<number>(Date.now());

  const { data: serverPostings, isLoading, isFetching, refetch } = useQuery({
    queryKey: ["sunsystems-postings", documentId, watchKey ?? ""],
    queryFn: () =>
      sunsystemsAPI.getPostings(documentId)
        .then((r) => { lastFetchRef.current = Date.now(); setSecondsAgo(0); return r.data; })
        .catch(() => [] as JournalPosting[]),
    // Always background-poll so new postings appear without a page refresh.
    // Fast-poll (3 s) when a stage is actively in-flight or we're waiting for
    // the first row; quiet-poll (15 s) otherwise.
    refetchInterval: (q) => {
      const rows = q.state.data as JournalPosting[] | undefined;
      const hasInFlight      = rows?.some((p) => p.status === "posting" || p.status === "pending");
      const waitingForFirst  = expectPosting && (!rows || rows.length === 0);
      return hasInFlight || waitingForFirst ? 3_000 : 15_000;
    },
    refetchOnWindowFocus: true,
    staleTime: 0,
  });

  // Tick the "updated X ago" counter every second.
  useEffect(() => {
    const id = setInterval(() => {
      setSecondsAgo(Math.floor((Date.now() - lastFetchRef.current) / 1000));
    }, 1000);
    return () => clearInterval(id);
  }, []);

  const agoLabel = secondsAgo < 5 ? "just now" : secondsAgo < 60 ? `${secondsAgo}s ago` : `${Math.floor(secondsAgo / 60)}m ago`;

  const postings: JournalPosting[] = (serverPostings ?? [])
    .filter((p) => p.stage >= 1000 || !availableStages || availableStages.includes(p.stage))
    .map((server) => {
      const local = localPostings[server.stage];
      if (!local) return server;
      if ((server.attempts ?? 0) > (local.attempts ?? 0) || server.status !== local.status) return server;
      return local;
    });

  const handleRetryDone = useCallback((updated: JournalPosting) => {
    setLocalPostings((prev) => ({ ...prev, [updated.stage]: updated }));
    qc.invalidateQueries({ queryKey: ["sunsystems-postings", documentId] });
  }, [documentId, qc]);

  /* ── early exits ── */
  if (isLoading && postings.length === 0) return null;
  if (postings.length === 0 || (postings[0] as any)?.status === "none") {
    if (!expectPosting) return null;
    return (
      <div className="border-l-2 border-[#287EAD] bg-[#F8FAFC] border border-[#DDE3E9]">
        <div className="flex items-center gap-2 px-4 py-2 border-b border-[#DDE3E9]">
          <Activity className="h-3.5 w-3.5 text-[#287EAD]" />
          <span className="text-xs font-bold uppercase tracking-widest text-[#287EAD]">SunSystems</span>
          <span className="ml-auto flex items-center gap-1.5 text-xs text-[#8C969E]">
            <span className="h-1.5 w-1.5 rounded-full bg-amber-400 animate-pulse" />
            Polling…
          </span>
        </div>
        <div className="flex items-center gap-2 px-4 py-3 text-xs text-[#5E6870]">
          <Loader2 className="h-3.5 w-3.5 animate-spin text-[#287EAD]" />
          Waiting for posting…
        </div>
      </div>
    );
  }

  const isPO = postings[0]?.component === "PurchaseOrder";
  const allPosted = postings.every((p) => p.status === "posted");
  const anyFailed = postings.some((p) => p.status === "failed");

  const overallDot = anyFailed
    ? "bg-red-500"
    : allPosted
      ? "bg-emerald-500"
      : "bg-amber-400 animate-pulse";

  const title = postings.some((p) => p.component === "PurchaseOrder") && postings.some((p) => p.component !== "PurchaseOrder")
    ? "SunSystems Postings"
    : isPO ? "SunSystems · LPO" : "SunSystems · Journal";

  return (
    <div className="border border-[#DDE3E9] border-l-2 border-l-[#287EAD] bg-[#F8FAFC]">
      {/* ── system header ── */}
      <div className="flex items-center gap-2.5 px-4 py-2 border-b border-[#DDE3E9]">
        <Activity className="h-3.5 w-3.5 text-[#287EAD] shrink-0" />
        <span className="text-xs font-bold uppercase tracking-widest text-[#287EAD]">System</span>
        <span className="text-[13px] font-semibold text-[#1F2933]">{title}</span>
        <span className={`ml-0.5 h-1.5 w-1.5 rounded-full shrink-0 ${overallDot}`} />
        <div className="ml-auto flex items-center gap-2">
          {postings.length > 1 && (
            <span className="text-xs text-[#8C969E]">
              {postings.filter((p) => p.status === "posted").length}/{postings.length} posted
            </span>
          )}
          {/* live indicator */}
          <span className="flex items-center gap-1 text-[11px] text-[#8C969E]">
            <span className={`h-1.5 w-1.5 rounded-full ${
              isFetching ? "bg-[#287EAD] animate-pulse" : "bg-[#C8CDD2]"
            }`} />
            {isFetching ? "Updating…" : agoLabel}
          </span>
          {/* manual refresh */}
          <button
            type="button"
            onClick={() => refetch()}
            disabled={isFetching}
            title="Refresh now"
            className="p-1 text-[#8C969E] hover:text-[#287EAD] disabled:opacity-40 transition-colors"
          >
            <RefreshCw className={`h-3 w-3 ${isFetching ? "animate-spin" : ""}`} />
          </button>
        </div>
      </div>

      {/* ── stage rows (compact, divided) ── */}
      <div className="divide-y divide-[#E8EDF2]">
        {postings.map((posting, idx) => {
          const prevJournal = [...postings.slice(0, idx)].reverse().find((row) => row.stage < 1000);
          const prevPosted  = posting.stage >= 1000 || !prevJournal || prevJournal.status === "posted";
          return (
            <StageRow
              key={posting.id}
              posting={localPostings[posting.stage] ?? posting}
              locked={!prevPosted}
              onRetryDone={handleRetryDone}
              documentId={documentId}
            />
          );
        })}
      </div>
    </div>
  );
}
