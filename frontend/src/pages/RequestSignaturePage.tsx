/**
 * RequestSignaturePage — ad-hoc "Request signature" flow.
 *   • Request: upload a PDF, pick signers (a one-off committee), choose ordered
 *     or unordered signing, send.
 *   • Awaiting my signature: requests where I still need to sign.
 *   • Sent by me: my requests + their progress.
 */
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { signatureRequestsAPI, usersAPI } from "@/services/api";
import { toast } from "@/components/ui/vault-toast";
import {
  FileSignature, Upload, X, Loader2, Plus, ArrowUp, ArrowDown, Search,
  CheckCircle2, Clock, XCircle, ChevronRight,
} from "lucide-react";
import clsx from "clsx";

type Tab = "request" | "incoming" | "sent";

interface UserLite { id: string; full_name: string; email: string }
interface SignatureRequestRow {
  id: string;
  document_id: string;
  document_title: string;
  document_reference: string;
  requested_by: UserLite;
  ordered: boolean;
  status: "pending" | "completed" | "declined" | "cancelled";
  progress: { signed: number; total: number };
  my_signer_status: string | null;
  created_at: string;
}

const STATUS_BADGE: Record<string, string> = {
  pending:   "bg-amber-50 text-amber-700 border-amber-200",
  completed: "bg-green-50 text-green-700 border-green-200",
  declined:  "bg-red-50 text-red-700 border-red-200",
  cancelled: "bg-gray-50 text-gray-600 border-gray-200",
};

// ── Signer add control ──────────────────────────────────────────────────────────
function SignerPicker({ exclude, onAdd }: { exclude: Set<string>; onAdd: (u: UserLite) => void }) {
  const [search, setSearch] = useState("");
  const [open, setOpen] = useState(false);
  const { data: users = [] } = useQuery<UserLite[]>({
    queryKey: ["signer-search", search],
    queryFn: () => usersAPI.list({ search: search || undefined, page_size: 10 }).then((r) => r.data.results ?? r.data),
    enabled: open,
  });
  const visible = users.filter((u) => !exclude.has(u.id));
  return (
    <div className="relative">
      <div className="flex items-center gap-2 input">
        <Search className="w-4 h-4 text-muted-foreground" />
        <input
          value={search}
          onChange={(e) => { setSearch(e.target.value); setOpen(true); }}
          onFocus={() => setOpen(true)}
          placeholder="Search people to add as signers…"
          className="flex-1 bg-transparent outline-none text-sm"
        />
      </div>
      {open && (
        <div className="absolute z-20 mt-1 w-full rounded-md border border-border bg-card shadow-lg max-h-56 overflow-y-auto">
          {visible.length === 0 && <div className="px-3 py-2 text-xs text-muted-foreground">No matches.</div>}
          {visible.map((u) => (
            <button key={u.id} type="button"
              onClick={() => { onAdd(u); setSearch(""); setOpen(false); }}
              className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-muted/60">
              <Plus className="w-3.5 h-3.5 text-primary" />
              <span className="text-foreground">{u.full_name}</span>
              <span className="text-xs text-muted-foreground">{u.email}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Create form ─────────────────────────────────────────────────────────────────
function RequestForm({ onCreated }: { onCreated: (documentId: string) => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState("");
  const [message, setMessage] = useState("");
  const [ordered, setOrdered] = useState(false);
  const [signers, setSigners] = useState<UserLite[]>([]);

  const create = useMutation({
    mutationFn: () => signatureRequestsAPI.create({
      file: file as File,
      title: title.trim() || (file?.name ?? "Signature request"),
      message: message.trim() || undefined,
      ordered,
      signers: signers.map((s) => s.id),
    }),
    onSuccess: (r) => { toast.success("Signature request sent"); onCreated(r.data.document_id); },
    onError: (e: any) => toast.error(e?.response?.data?.detail ?? "Could not send request"),
  });

  const move = (i: number, dir: -1 | 1) => {
    setSigners((prev) => {
      const next = [...prev];
      const j = i + dir;
      if (j < 0 || j >= next.length) return prev;
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });
  };

  const submit = () => {
    if (!file) { toast.error("Upload a PDF document"); return; }
    if (!file.name.toLowerCase().endsWith(".pdf")) { toast.error("Only PDF documents can be signed"); return; }
    if (signers.length === 0) { toast.error("Add at least one signer"); return; }
    create.mutate();
  };

  return (
    <div className="max-w-2xl space-y-5">
      {/* Upload */}
      <div>
        <label className="label">Document (PDF) <span className="text-destructive">*</span></label>
        {file ? (
          <div className="flex items-center gap-2 rounded-lg border border-border bg-muted/20 px-3 py-2.5">
            <FileSignature className="w-4 h-4 text-primary" />
            <span className="flex-1 truncate text-sm">{file.name}</span>
            <button onClick={() => setFile(null)} className="text-muted-foreground hover:text-destructive"><X className="w-4 h-4" /></button>
          </div>
        ) : (
          <label className="flex cursor-pointer flex-col items-center gap-2 rounded-lg border-2 border-dashed border-border bg-muted/20 py-6 text-sm text-muted-foreground hover:border-primary/50">
            <Upload className="w-5 h-5" />
            <span>Click to upload a PDF</span>
            <input type="file" accept="application/pdf,.pdf" className="sr-only"
              onChange={(e) => { const f = e.target.files?.[0]; if (f) { setFile(f); if (!title) setTitle(f.name.replace(/\.pdf$/i, "")); } }} />
          </label>
        )}
      </div>

      <div>
        <label className="label">Title</label>
        <input value={title} onChange={(e) => setTitle(e.target.value)} className="input" placeholder="e.g. Board resolution" />
      </div>
      <div>
        <label className="label">Message to signers (optional)</label>
        <textarea value={message} onChange={(e) => setMessage(e.target.value)} rows={2} className="input" placeholder="Add context for the signers…" />
      </div>

      {/* Signers */}
      <div>
        <label className="label">Signers <span className="text-destructive">*</span></label>
        <SignerPicker exclude={new Set(signers.map((s) => s.id))} onAdd={(u) => setSigners((p) => [...p, u])} />
        {signers.length > 0 && (
          <div className="mt-2 space-y-1.5">
            {signers.map((s, i) => (
              <div key={s.id} className="flex items-center gap-2 rounded-lg border border-border bg-card px-3 py-2">
                {ordered && <span className="w-5 text-center text-xs font-semibold text-muted-foreground">{i + 1}</span>}
                <span className="flex-1 text-sm text-foreground">{s.full_name}</span>
                <span className="text-xs text-muted-foreground">{s.email}</span>
                {ordered && (
                  <>
                    <button onClick={() => move(i, -1)} disabled={i === 0} className="p-1 text-muted-foreground hover:text-foreground disabled:opacity-30"><ArrowUp className="w-3.5 h-3.5" /></button>
                    <button onClick={() => move(i, 1)} disabled={i === signers.length - 1} className="p-1 text-muted-foreground hover:text-foreground disabled:opacity-30"><ArrowDown className="w-3.5 h-3.5" /></button>
                  </>
                )}
                <button onClick={() => setSigners((p) => p.filter((x) => x.id !== s.id))} className="p-1 text-muted-foreground hover:text-destructive"><X className="w-3.5 h-3.5" /></button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Order */}
      <label className="flex items-start gap-3 rounded-xl border border-border bg-card p-4 cursor-pointer">
        <input type="checkbox" checked={ordered} onChange={(e) => setOrdered(e.target.checked)} className="mt-0.5 h-4 w-4 accent-[#287EAD]" />
        <div>
          <p className="text-sm font-semibold text-foreground">Sign in order</p>
          <p className="text-xs text-muted-foreground mt-0.5">
            Signers are notified one at a time, in the order above. Leave off to let anyone sign in any order.
          </p>
        </div>
      </label>

      <button onClick={submit} disabled={create.isPending} className="btn-primary">
        {create.isPending && <Loader2 className="w-4 h-4 animate-spin" />}
        <FileSignature className="w-4 h-4" /> Send signature request
      </button>
    </div>
  );
}

// ── Request list ────────────────────────────────────────────────────────────────
function RequestList({ box }: { box: "incoming" | "sent" }) {
  const navigate = useNavigate();
  const { data: rows = [], isLoading } = useQuery<SignatureRequestRow[]>({
    queryKey: ["signature-requests", box],
    queryFn: () => signatureRequestsAPI.list({ box }).then((r) => r.data.results ?? r.data),
  });

  if (isLoading) return <div className="space-y-2">{[1, 2].map((i) => <div key={i} className="h-16 bg-muted rounded-lg animate-pulse" />)}</div>;
  if (rows.length === 0) {
    return (
      <div className="text-center py-16 text-muted-foreground">
        <FileSignature className="w-12 h-12 mx-auto mb-3 opacity-40" />
        <p className="text-sm">{box === "incoming" ? "Nothing awaiting your signature." : "You haven't requested any signatures yet."}</p>
      </div>
    );
  }
  return (
    <div className="space-y-3">
      {rows.map((req) => (
        <button key={req.id} onClick={() => navigate(`/documents/${req.document_id}`)}
          className="w-full flex items-center gap-3 rounded-xl border border-border bg-card px-4 py-3 hover:border-accent/40 transition-colors text-left">
          {req.status === "completed" ? <CheckCircle2 className="w-5 h-5 text-green-600" />
            : req.status === "declined" ? <XCircle className="w-5 h-5 text-red-600" />
            : <Clock className="w-5 h-5 text-amber-500" />}
          <div className="flex-1 min-w-0">
            <p className="text-sm font-semibold text-foreground truncate">{req.document_title}</p>
            <p className="text-xs text-muted-foreground">
              {box === "incoming" ? `From ${req.requested_by.full_name}` : `${req.ordered ? "Sequential" : "Any order"}`}
              {" · "}{req.document_reference}
            </p>
          </div>
          <span className={clsx("text-[11px] px-2 py-1 rounded-full border font-medium", STATUS_BADGE[req.status])}>
            {req.progress.signed}/{req.progress.total} signed
          </span>
          {box === "incoming" && req.my_signer_status === "pending" && (
            <span className="text-[11px] px-2 py-1 rounded-full bg-primary/10 text-primary font-medium">Sign</span>
          )}
          <ChevronRight className="w-4 h-4 text-muted-foreground" />
        </button>
      ))}
    </div>
  );
}

export default function RequestSignaturePage() {
  const [tab, setTab] = useState<Tab>("request");
  const navigate = useNavigate();
  const qc = useQueryClient();

  const tabs: { id: Tab; label: string }[] = [
    { id: "request", label: "Request signature" },
    { id: "incoming", label: "Awaiting my signature" },
    { id: "sent", label: "Sent by me" },
  ];

  return (
    <div className="admin-shell">
      <div className="admin-page-header">
        <h1 className="admin-page-title">Request signature</h1>
        <p className="admin-page-subtitle">Collect e-signatures from specific people — no workflow, no document type.</p>
      </div>

      <div className="border-b border-border mb-6">
        <nav className="-mb-px flex gap-6">
          {tabs.map((t) => (
            <button key={t.id} onClick={() => setTab(t.id)}
              className={clsx("px-1 py-3 text-sm font-medium border-b-2 transition-colors",
                tab === t.id ? "border-accent text-accent" : "border-transparent text-muted-foreground hover:text-foreground")}>
              {t.label}
            </button>
          ))}
        </nav>
      </div>

      {tab === "request" && (
        <RequestForm onCreated={(documentId) => {
          qc.invalidateQueries({ queryKey: ["signature-requests", "sent"] });
          navigate(`/documents/${documentId}`);
        }} />
      )}
      {tab === "incoming" && <RequestList box="incoming" />}
      {tab === "sent" && <RequestList box="sent" />}
    </div>
  );
}
