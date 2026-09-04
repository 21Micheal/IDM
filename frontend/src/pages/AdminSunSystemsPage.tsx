import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Activity, AlertCircle, CheckCircle2, ChevronDown, ChevronUp,
  Copy, FileCode, Loader2, Plug, RefreshCw, Save, ShieldCheck, X, XCircle,
} from "lucide-react";
import {
  sunsystemsAPI,
  type JournalPostingRecord,
  type PaymentRunRecord,
  type SunSystemsConnection,
} from "@/services/api";
import { toast } from "@/components/ui/vault-toast";

// ── helpers ──────────────────────────────────────────────────────────────────

const TABS = ["Connection", "Activity Monitor"] as const;
type Tab = (typeof TABS)[number];

const inputCls =
  "h-10 w-full border border-[#AEB5BB] bg-white px-3 text-sm text-[#1F2933] " +
  "placeholder:text-[#8C969E] outline-none focus:border-[#287EAD] focus:ring-1 focus:ring-[#287EAD]";

const FIELDS: Array<{
  key: keyof SunSystemsConnection; label: string; placeholder?: string; mono?: boolean; help?: string;
}> = [
  { key: "base_url", label: "Gateway base URL", placeholder: "http://host:81/sunsystems-connect/wsdl", mono: true, help: "SecurityProvider and ComponentExecutor WSDLs sit under it." },
  { key: "security_path", label: "SecurityProvider path", placeholder: "SecurityProvider", mono: true },
  { key: "executor_path", label: "ComponentExecutor path", placeholder: "ComponentExecutor", mono: true },
  { key: "username", label: "Username", placeholder: "service account user" },
  { key: "password", label: "Password", placeholder: "••••••••" },
  { key: "business_unit", label: "Default business unit", placeholder: "e.g. PK1", help: "Used when a template doesn't set its own." },
  { key: "budget_code", label: "Default budget code", placeholder: "e.g. A" },
];

const STATUS_META: Record<string, { label: string; dot: string; text: string; bg: string }> = {
  posted: { label: "Posted",     dot: "bg-emerald-500", text: "text-emerald-700", bg: "bg-emerald-50" },
  paid:   { label: "Paid",       dot: "bg-emerald-500", text: "text-emerald-700", bg: "bg-emerald-50" },
  failed: { label: "Failed",     dot: "bg-red-500",     text: "text-red-700",     bg: "bg-red-50"     },
  pending:{ label: "Pending",    dot: "bg-amber-400",   text: "text-amber-700",   bg: "bg-amber-50"   },
  posting:{ label: "Posting…",   dot: "bg-blue-400 animate-pulse", text: "text-blue-700", bg: "bg-blue-50" },
  processing:{ label: "Processing…", dot: "bg-blue-400 animate-pulse", text: "text-blue-700", bg: "bg-blue-50" },
  skipped:{ label: "Skipped",   dot: "bg-[#AEB5BB]",   text: "text-[#5E6870]",   bg: "bg-[#F3F5F6]" },
  pending_approval:{ label: "Pending approval", dot: "bg-amber-400", text: "text-amber-700", bg: "bg-amber-50" },
  approved:{ label: "Approved",  dot: "bg-emerald-400", text: "text-emerald-700", bg: "bg-emerald-50" },
};

function StatusBadge({ status }: { status: string }) {
  const m = STATUS_META[status] ?? { label: status, dot: "bg-gray-400", text: "text-gray-700", bg: "bg-gray-50" };
  return (
    <span className={`inline-flex items-center gap-1.5 rounded px-2 py-0.5 text-xs font-semibold ${m.bg} ${m.text}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${m.dot}`} />
      {m.label}
    </span>
  );
}

function fmt(iso: string | null) {
  if (!iso) return "—";
  return new Date(iso).toLocaleString();
}

// ── XML viewer modal ─────────────────────────────────────────────────────────

function XmlViewerModal({
  title, xml, onClose,
}: {
  title: string;
  xml: string;
  onClose: () => void;
}) {
  const [copied, setCopied] = useState(false);

  // Pretty-print XML by adding indentation
  function prettyXml(raw: string) {
    try {
      const PADDING = "  ";
      let indent = 0;
      return raw
        .replace(/(>)(<)(\/?)/g, "$1\n$2$3")
        .split("\n")
        .map((line) => {
          if (line.match(/^<\/\w/)) indent -= 1;
          const out = PADDING.repeat(Math.max(0, indent)) + line.trim();
          if (line.match(/^<\w[^>]*[^/]>.*$/)) indent += 1;
          return out;
        })
        .join("\n");
    } catch {
      return raw;
    }
  }

  const pretty = prettyXml(xml);

  function copy() {
    navigator.clipboard.writeText(xml).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/50 backdrop-blur-[2px]" onClick={onClose} />
      <div className="relative flex max-h-[85vh] w-full max-w-4xl flex-col overflow-hidden border border-[#C8CDD2] bg-[#1E2630] shadow-2xl">
        {/* Header */}
        <div className="flex items-center gap-3 border-b border-[#2E3A45] bg-[#1A2229] px-5 py-3">
          <FileCode className="h-4 w-4 shrink-0 text-[#287EAD]" />
          <span className="flex-1 text-sm font-bold text-white">{title}</span>
          <button onClick={copy}
            className="flex items-center gap-1.5 rounded border border-[#2E3A45] bg-[#243040] px-2.5 py-1 text-[11px] font-semibold text-[#8CB8D0] hover:border-[#287EAD] hover:text-white transition-colors">
            <Copy className="h-3 w-3" />
            {copied ? "Copied!" : "Copy XML"}
          </button>
          <button onClick={onClose}
            className="flex h-7 w-7 items-center justify-center rounded text-[#5E6870] hover:bg-[#2E3A45] hover:text-white transition-colors">
            <X className="h-4 w-4" />
          </button>
        </div>
        {/* XML body */}
        <div className="flex-1 overflow-auto">
          <pre className="p-5 text-[12px] leading-relaxed text-[#A8C5D4] font-mono whitespace-pre-wrap break-all">
            {pretty || <span className="text-[#5E6870] italic">No response XML available.</span>}
          </pre>
        </div>
      </div>
    </div>
  );
}

// ── Connection tab ────────────────────────────────────────────────────────────

function ConnectionTab() {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ["sunsystems-connection"],
    queryFn: () => sunsystemsAPI.getConnection().then((r) => r.data),
  });

  const [form, setForm] = useState<SunSystemsConnection>({});
  const [verifyTls, setVerifyTls] = useState(true);
  const [clearPassword, setClearPassword] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; detail?: string } | null>(null);

  useEffect(() => {
    if (data) {
      setForm({ ...data.connection });
      setVerifyTls(data.connection.verify_tls ?? data.effective.verify_tls ?? true);
      setClearPassword(false);
    }
  }, [data]);

  const set = (key: keyof SunSystemsConnection, v: string) => setForm((f) => ({ ...f, [key]: v }));
  const payload = (): SunSystemsConnection => ({ ...form, password: clearPassword ? "" : form.password, verify_tls: verifyTls, clear_password: clearPassword });

  const saveMut = useMutation({
    mutationFn: () => sunsystemsAPI.updateConnection(payload()).then((r) => r.data),
    onSuccess: () => { toast.success("SunSystems connection saved."); qc.invalidateQueries({ queryKey: ["sunsystems-connection"] }); },
    onError: () => toast.error("Could not save the connection."),
  });
  const testMut = useMutation({
    mutationFn: () => sunsystemsAPI.testConnection(payload()).then((r) => r.data),
    onSuccess: (res) => { setTestResult(res); if (res.ok) toast.success("Connected — token acquired."); else toast.error(res.detail || "Connection failed."); },
    onError: () => { setTestResult({ ok: false, detail: "Request failed." }); toast.error("Could not reach the server."); },
  });

  const eff = data?.effective;
  if (isLoading) return <div className="flex items-center gap-2 p-8 text-sm text-[#5E6870]"><Loader2 className="h-4 w-4 animate-spin" /> Loading…</div>;

  return (
    <div className="space-y-5">
      <div className="border border-[#C8CDD2] bg-white shadow-sm">
        <div className="border-b border-[#C8CDD2] bg-[#F3F5F6] px-5 py-3">
          <h2 className="text-sm font-bold text-[#1F2933]">Connection</h2>
          <p className="mt-0.5 text-xs text-[#5E6870]">Leave a field blank to fall back to its <code>SUNSYSTEMS_*</code> environment default.</p>
        </div>
        <div className="space-y-4 p-5">
          {FIELDS.map((f) => (
            <div key={f.key} className="space-y-1.5">
              <label className="text-xs font-semibold uppercase tracking-wider text-[#5E6870]">{f.label}</label>
              <input
                type={f.key === "password" ? "password" : "text"}
                autoComplete={f.key === "password" ? "new-password" : "off"}
                value={(form[f.key] as string) ?? ""}
                onChange={(e) => set(f.key, e.target.value)}
                placeholder={f.placeholder}
                className={f.mono ? `${inputCls} font-mono` : inputCls}
              />
              {f.help && <p className="text-[10px] text-[#8C969E]">{f.help}</p>}
              {eff && eff[f.key] && !form[f.key] && (
                <p className="text-[10px] text-[#8C969E]">Using env default: <span className="font-mono">{String(eff[f.key])}</span></p>
              )}
              {f.key === "password" && data?.has_password && (
                <label className="flex cursor-pointer items-center gap-2 pt-1 text-xs text-[#5E6870]">
                  <input type="checkbox" checked={clearPassword} onChange={(e) => setClearPassword(e.target.checked)} className="h-3.5 w-3.5 accent-[#287EAD]" />
                  Clear saved password and use the environment default
                </label>
              )}
            </div>
          ))}
          <label className="flex cursor-pointer items-center gap-2.5 text-sm text-[#1F2933]">
            <input type="checkbox" checked={verifyTls} onChange={(e) => setVerifyTls(e.target.checked)} className="h-4 w-4 accent-[#287EAD]" />
            Verify TLS certificate
          </label>
        </div>
      </div>

      {testResult && (
        <div className={`flex items-start gap-2 border px-4 py-3 text-sm ${testResult.ok ? "border-emerald-300 bg-emerald-50 text-emerald-800" : "border-red-300 bg-red-50 text-red-800"}`}>
          {testResult.ok ? <CheckCircle2 className="mt-0.5 h-4 w-4" /> : <XCircle className="mt-0.5 h-4 w-4" />}
          <span>{testResult.ok ? "Connected — SecurityProvider returned a token." : testResult.detail}</span>
        </div>
      )}

      <div className="flex items-center justify-between">
        <button type="button" onClick={() => { setTestResult(null); testMut.mutate(); }} disabled={testMut.isPending}
          className="inline-flex items-center gap-2 border border-[#287EAD] px-4 py-2 text-sm font-semibold text-[#287EAD] hover:bg-[#EEF6FB] disabled:opacity-60">
          {testMut.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldCheck className="h-4 w-4" />}
          Test connection
        </button>
        <button type="button" onClick={() => saveMut.mutate()} disabled={saveMut.isPending}
          className="inline-flex items-center gap-2 bg-[#287EAD] px-5 py-2 text-sm font-semibold text-white hover:bg-[#1E6F99] disabled:opacity-60">
          {saveMut.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
          Save connection
        </button>
      </div>
    </div>
  );
}

// ── Posting row ───────────────────────────────────────────────────────────────

function PostingRow({
  p, onRetry, onViewXml,
}: {
  p: JournalPostingRecord;
  onRetry: (id: string, stage: number) => void;
  onViewXml: (title: string, xml: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const hasXml = !!(p.response_xml || p.request_xml);
  return (
    <>
      <tr className={`border-b border-[#EDF0F2] text-sm transition-colors hover:bg-[#F3F8FB] ${p.status === "failed" ? "bg-red-50/40" : ""}`}>
        <td className="px-4 py-2.5">
          <p className="font-mono text-xs font-bold text-[#287EAD]">{p.document_reference ?? "—"}</p>
          <p className="truncate max-w-[180px] text-[11px] text-[#5E6870]" title={p.document_title}>{p.document_title || "—"}</p>
        </td>
        <td className="px-4 py-2.5 text-[#5E6870] text-xs">{p.stage}{p.stage_label ? ` — ${p.stage_label}` : ""}</td>
        <td className="px-4 py-2.5"><StatusBadge status={p.status} /></td>
        <td className="px-4 py-2.5 font-mono text-xs">{p.component}/{p.method}</td>
        <td className="px-4 py-2.5 font-mono text-xs text-[#287EAD]">{p.journal_number || "—"}</td>
        <td className="px-4 py-2.5 text-xs text-[#5E6870]">{fmt(p.updated_at)}</td>
        <td className="px-4 py-2.5">
          <div className="flex items-center gap-2">
            {p.status === "failed" && (
              <button onClick={() => onRetry(p.document_id!, p.stage)}
                className="inline-flex items-center gap-1 rounded bg-[#287EAD] px-2 py-1 text-[11px] font-semibold text-white hover:bg-[#1E6F99]">
                <RefreshCw className="h-3 w-3" /> Retry
              </button>
            )}
            {hasXml && (
              <button
                onClick={() => onViewXml(
                  `${p.document_reference ?? p.document_id} — Stage ${p.stage} Response`,
                  p.response_xml || p.request_xml,
                )}
                title="View SunSystems response XML"
                className="inline-flex items-center gap-1 rounded border border-[#C8CDD2] px-2 py-1 text-[11px] font-semibold text-[#5E6870] hover:border-[#287EAD] hover:text-[#287EAD] transition-colors">
                <FileCode className="h-3 w-3" /> XML
              </button>
            )}
            {(p.error || p.message) && (
              <button onClick={() => setOpen((v) => !v)} className="text-[#5E6870] hover:text-[#1F2933]">
                {open ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
              </button>
            )}
          </div>
        </td>
      </tr>
      {open && (p.error || p.message) && (
        <tr className="border-b border-[#EDF0F2] bg-[#FAFBFC]">
          <td colSpan={7} className="px-6 pb-3 pt-1">
            {p.error && (
              <div className="flex items-start gap-2 rounded border border-red-200 bg-red-50 p-3 text-xs text-red-800">
                <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                <pre className="whitespace-pre-wrap break-all font-mono">{p.error}</pre>
              </div>
            )}
            {p.message && !p.error && (
              <p className="text-xs text-[#5E6870]">{p.message}</p>
            )}
          </td>
        </tr>
      )}
    </>
  );
}

// ── Payment run row ───────────────────────────────────────────────────────────

function PayRunRow({
  r, onViewXml,
}: {
  r: PaymentRunRecord;
  onViewXml: (title: string, xml: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const hasXml = !!(r.response_xml || r.request_xml);
  return (
    <>
      <tr className={`border-b border-[#EDF0F2] text-sm transition-colors hover:bg-[#F3F8FB] ${r.status === "failed" ? "bg-red-50/40" : r.status === "processing" ? "bg-blue-50/30" : ""}`}>
        <td className="px-4 py-2.5 font-mono text-xs font-bold text-[#287EAD]">{r.payment_reference}</td>
        <td className="px-4 py-2.5"><StatusBadge status={r.status} /></td>
        <td className="px-4 py-2.5 text-xs text-[#5E6870]">{r.line_count} lines</td>
        <td className="px-4 py-2.5 text-xs font-semibold tabular-nums">{Number(r.total_amount).toLocaleString(undefined, { minimumFractionDigits: 2 })} {r.currency_codes?.join("/")}</td>
        <td className="px-4 py-2.5 text-xs text-[#5E6870]">{r.submitted_by_name ?? "—"}</td>
        <td className="px-4 py-2.5 text-xs text-[#5E6870]">{fmt(r.updated_at)}</td>
        <td className="px-4 py-2.5">
          <div className="flex items-center gap-2">
            {hasXml && (
              <button
                onClick={() => onViewXml(
                  `${r.payment_reference} — SunSystems Response`,
                  r.response_xml || r.request_xml,
                )}
                title="View SunSystems response XML"
                className="inline-flex items-center gap-1 rounded border border-[#C8CDD2] px-2 py-1 text-[11px] font-semibold text-[#5E6870] hover:border-[#287EAD] hover:text-[#287EAD] transition-colors">
                <FileCode className="h-3 w-3" /> XML
              </button>
            )}
            {r.error && (
              <button onClick={() => setOpen((v) => !v)} className="text-[#5E6870] hover:text-[#1F2933]">
                {open ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
              </button>
            )}
          </div>
        </td>
      </tr>
      {open && r.error && (
        <tr className="border-b border-[#EDF0F2] bg-[#FAFBFC]">
          <td colSpan={7} className="px-6 pb-3 pt-1">
            <div className="flex items-start gap-2 rounded border border-red-200 bg-red-50 p-3 text-xs text-red-800">
              <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <pre className="whitespace-pre-wrap break-all font-mono">{r.error}</pre>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

// ── Activity Monitor tab ──────────────────────────────────────────────────────

const POSTING_STATUS_FILTERS = [
  { value: "", label: "All" },
  { value: "failed", label: "Failed" },
  { value: "posted", label: "Posted" },
  { value: "pending", label: "Pending" },
  { value: "skipped", label: "Skipped" },
];
const PAYRUN_STATUS_FILTERS = [
  { value: "", label: "All" },
  { value: "failed", label: "Failed" },
  { value: "processing", label: "Processing" },
  { value: "pending_approval", label: "Pending approval" },
  { value: "approved", label: "Approved" },
  { value: "paid", label: "Paid" },
];

function ActivityTab() {
  const [postingStatus, setPostingStatus] = useState("failed");
  const [payRunStatus,  setPayRunStatus]  = useState("failed");
  const [retrying, setRetrying] = useState<string | null>(null);
  const [xmlModal, setXmlModal]  = useState<{ title: string; xml: string } | null>(null);

  function openXml(title: string, xml: string) {
    setXmlModal({ title, xml });
  }

  const postingsQ = useQuery({
    queryKey: ["sunsystems-postings-list", postingStatus],
    queryFn: () => sunsystemsAPI.getPostingsList({ status: postingStatus || undefined, limit: 200 }).then((r) => r.data),
    refetchInterval: 30_000,
  });

  const payrunsQ = useQuery({
    queryKey: ["sunsystems-payruns", payRunStatus],
    queryFn: () => sunsystemsAPI.getPaymentRuns({ status: payRunStatus || undefined }).then((r) => r.data),
    refetchInterval: 30_000,
  });

  const postings: JournalPostingRecord[] = postingsQ.data?.postings ?? [];
  const payruns:  PaymentRunRecord[]     = payrunsQ.data?.payment_runs ?? [];

  const failedPostings = postings.filter((p) => p.status === "failed").length;
  const failedPayruns  = payruns.filter((r)  => r.status  === "failed" || r.status === "processing").length;

  async function handleRetry(documentId: string, stage: number) {
    setRetrying(`${documentId}-${stage}`);
    try {
      await sunsystemsAPI.retryPosting(documentId, stage);
      toast.success("Retry queued.");
      postingsQ.refetch();
    } catch {
      toast.error("Retry failed.");
    } finally {
      setRetrying(null);
    }
  }

  const thCls = "px-4 py-2.5 text-left text-[10px] font-bold uppercase tracking-wider text-[#5E6870] bg-[#F3F5F6] border-b border-[#C8CDD2]";

  return (
    <div className="space-y-6">
      {/* XML viewer modal */}
      {xmlModal && (
        <XmlViewerModal
          title={xmlModal.title}
          xml={xmlModal.xml}
          onClose={() => setXmlModal(null)}
        />
      )}

      {/* Summary pills */}
      <div className="flex gap-3">
        {[
          { label: "Failed postings",      count: failedPostings, color: failedPostings > 0 ? "bg-red-600" : "bg-emerald-600" },
          { label: "Failed/processing runs", count: failedPayruns, color: failedPayruns > 0 ? "bg-red-600" : "bg-emerald-600" },
        ].map(({ label, count, color }) => (
          <div key={label} className="flex items-center gap-2 rounded border border-[#C8CDD2] bg-white px-4 py-2 shadow-sm">
            <span className={`flex h-6 w-6 items-center justify-center rounded-full text-xs font-bold text-white ${color}`}>{count}</span>
            <span className="text-sm font-medium text-[#1F2933]">{label}</span>
          </div>
        ))}
        <button onClick={() => { postingsQ.refetch(); payrunsQ.refetch(); }}
          className="ml-auto flex items-center gap-1.5 rounded border border-[#C8CDD2] bg-white px-3 py-2 text-xs font-semibold text-[#5E6870] hover:border-[#287EAD] hover:text-[#287EAD]">
          <RefreshCw className={`h-3.5 w-3.5 ${postingsQ.isFetching || payrunsQ.isFetching ? "animate-spin" : ""}`} />
          Refresh
        </button>
      </div>

      {/* Journal postings panel */}
      <div className="border border-[#C8CDD2] bg-white shadow-sm">
        <div className="flex items-center justify-between border-b border-[#C8CDD2] bg-[#F3F5F6] px-5 py-3">
          <div>
            <h2 className="text-sm font-bold text-[#1F2933]">Journal Postings</h2>
            <p className="mt-0.5 text-xs text-[#5E6870]">SunSystems document journal postings across all workflows.</p>
          </div>
          <div className="flex gap-1">
            {POSTING_STATUS_FILTERS.map(({ value, label }) => (
              <button key={value} onClick={() => setPostingStatus(value)}
                className={`rounded px-2.5 py-1 text-xs font-semibold transition-colors ${postingStatus === value ? "bg-[#287EAD] text-white" : "text-[#5E6870] hover:bg-[#EEF6FB] hover:text-[#287EAD]"}`}>
                {label}
              </button>
            ))}
          </div>
        </div>
        {postingsQ.isLoading ? (
          <div className="flex items-center gap-2 p-6 text-sm text-[#5E6870]"><Loader2 className="h-4 w-4 animate-spin" /> Loading…</div>
        ) : postings.length === 0 ? (
          <div className="flex items-center gap-2 p-6 text-sm text-[#5E6870]"><CheckCircle2 className="h-4 w-4 text-emerald-500" /> No {postingStatus || ""} postings found.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse">
              <thead>
                <tr>
                  {["Document", "Stage", "Status", "Component", "Journal #", "Updated", ""].map((h) => (
                    <th key={h} className={thCls}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {postings.map((p) => (
                  <PostingRow key={p.id} p={p} onRetry={handleRetry} onViewXml={openXml} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Payment runs panel */}
      <div className="border border-[#C8CDD2] bg-white shadow-sm">
        <div className="flex items-center justify-between border-b border-[#C8CDD2] bg-[#F3F5F6] px-5 py-3">
          <div>
            <h2 className="text-sm font-bold text-[#1F2933]">Payment Runs</h2>
            <p className="mt-0.5 text-xs text-[#5E6870]">Supplier payment batches — approval and SunSystems processing status.</p>
          </div>
          <div className="flex gap-1">
            {PAYRUN_STATUS_FILTERS.map(({ value, label }) => (
              <button key={value} onClick={() => setPayRunStatus(value)}
                className={`rounded px-2.5 py-1 text-xs font-semibold transition-colors ${payRunStatus === value ? "bg-[#287EAD] text-white" : "text-[#5E6870] hover:bg-[#EEF6FB] hover:text-[#287EAD]"}`}>
                {label}
              </button>
            ))}
          </div>
        </div>
        {payrunsQ.isLoading ? (
          <div className="flex items-center gap-2 p-6 text-sm text-[#5E6870]"><Loader2 className="h-4 w-4 animate-spin" /> Loading…</div>
        ) : payruns.length === 0 ? (
          <div className="flex items-center gap-2 p-6 text-sm text-[#5E6870]"><CheckCircle2 className="h-4 w-4 text-emerald-500" /> No {payRunStatus || ""} payment runs found.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse">
              <thead>
                <tr>
                  {["Reference", "Status", "Lines", "Total", "Submitted by", "Updated", ""].map((h) => (
                    <th key={h} className={thCls}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {payruns.map((r) => (
                  <PayRunRow key={r.id} r={r} onViewXml={openXml} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Page root ─────────────────────────────────────────────────────────────────

export default function AdminSunSystemsPage() {
  const [tab, setTab] = useState<Tab>("Connection");

  return (
    <div className="mx-auto max-w-5xl space-y-5 p-8">
      {/* Header */}
      <div className="flex items-center gap-3">
        <div className="flex h-10 w-10 items-center justify-center rounded bg-[#EEF6FB] text-[#287EAD]">
          <Plug className="h-5 w-5" />
        </div>
        <div>
          <h1 className="text-lg font-bold text-[#1F2933]">SunSystems Integration</h1>
          <p className="text-xs text-[#5E6870]">Connection settings and real-time posting activity monitor.</p>
        </div>
      </div>

      {/* Tab bar */}
      <div className="flex border-b border-[#C8CDD2]">
        {TABS.map((t) => (
          <button key={t} onClick={() => setTab(t)}
            className={`flex items-center gap-2 px-5 py-2.5 text-sm font-semibold transition-colors -mb-px border-b-2 ${
              tab === t
                ? "border-[#287EAD] text-[#287EAD]"
                : "border-transparent text-[#5E6870] hover:text-[#1F2933]"
            }`}>
            {t === "Activity Monitor" && <Activity className="h-4 w-4" />}
            {t}
          </button>
        ))}
      </div>

      {tab === "Connection"       && <ConnectionTab />}
      {tab === "Activity Monitor" && <ActivityTab />}
    </div>
  );
}
