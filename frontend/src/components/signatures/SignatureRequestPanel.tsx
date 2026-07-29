/**
 * SignatureRequestPanel — shown on DocumentDetailPage when a document is part of
 * an ad-hoc "Request signature". A pending signer (whose turn it is) can Sign or
 * Decline; the requester sees progress and can Cancel; others see who's pending.
 */
import { useState } from "react";
import { extractApiError } from "@/lib/apiError";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { signatureRequestsAPI } from "@/services/api";
import { toast } from "@/components/ui/vault-toast";
import { CheckCircle2, Clock, XCircle, Loader2, FileSignature, X } from "lucide-react";
import clsx from "clsx";
import SignaturePlacementModal, { type SignaturePlacementResult } from "./SignaturePlacementModal";

interface Signer {
  id: string;
  signer: { id: string; full_name: string; email: string };
  order: number;
  status: "pending" | "signed" | "declined";
  signed_at: string | null;
  decline_reason: string;
}
interface SignatureRequestDetail {
  id: string;
  document_id: string;
  document_title: string;
  document_reference: string;
  requested_by: { id: string; full_name: string; email: string };
  ordered: boolean;
  message: string;
  status: "pending" | "completed" | "declined" | "cancelled";
  signers: Signer[];
  progress: { signed: number; total: number };
  my_signer_status: "pending" | "signed" | "declined" | null;
  can_sign: boolean;
  can_cancel: boolean;
}

const STATUS_BADGE: Record<string, string> = {
  pending:   "bg-amber-50 text-amber-700 border-amber-200",
  completed: "bg-green-50 text-green-700 border-green-200",
  declined:  "bg-red-50 text-red-700 border-red-200",
  cancelled: "bg-gray-50 text-gray-600 border-gray-200",
};

export default function SignatureRequestPanel({ documentId }: { documentId: string }) {
  const qc = useQueryClient();
  const [showSign, setShowSign] = useState(false);
  const [declining, setDeclining] = useState(false);
  const [reason, setReason] = useState("");

  const { data: req } = useQuery<SignatureRequestDetail | null>({
    queryKey: ["signature-request", documentId],
    queryFn: () => signatureRequestsAPI.list({ document: documentId }).then((r) => {
      const list = (r.data.results ?? r.data) as SignatureRequestDetail[];
      return list[0] ?? null;
    }),
  });

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["signature-request", documentId] });
    qc.invalidateQueries({ queryKey: ["document", documentId] });
    qc.invalidateQueries({ queryKey: ["notifications"] });
    // Refresh the "Awaiting my signature" list + nav badge (count) after signing.
    qc.invalidateQueries({ queryKey: ["signature-requests"] });
    qc.invalidateQueries({ queryKey: ["signature-requests", "incoming-count"] });
  };

  const signMutation = useMutation({
    mutationFn: (result: SignaturePlacementResult) => signatureRequestsAPI.sign(req!.id, result),
    onSuccess: () => { toast.success("Document signed"); setShowSign(false); refresh(); },
    onError: (e: any) => toast.error(extractApiError(e, "Could not sign")),
  });
  const declineMutation = useMutation({
    mutationFn: () => signatureRequestsAPI.decline(req!.id, reason.trim()),
    onSuccess: () => { toast.success("Signature declined"); setDeclining(false); setReason(""); refresh(); },
    onError: (e: any) => toast.error(extractApiError(e, "Could not decline")),
  });
  const cancelMutation = useMutation({
    mutationFn: () => signatureRequestsAPI.cancel(req!.id),
    onSuccess: () => { toast.success("Request cancelled"); refresh(); },
    onError: (e: any) => toast.error(extractApiError(e, "Could not cancel")),
  });

  if (!req) return null;

  return (
    <div className="rounded-2xl border border-border bg-background p-4 space-y-4">
      {showSign && (
        <SignaturePlacementModal
          documentId={documentId}
          documentTitle={req.document_title}
          documentRef={req.document_reference}
          note={req.message ? `Note from requester: ${req.message}` : undefined}
          confirmLabel="Confirm signature"
          onCancel={() => setShowSign(false)}
          onConfirm={(p) => signMutation.mutate(p)}
          isSubmitting={signMutation.isPending}
        />
      )}

      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-2">
          <FileSignature className="w-4 h-4 text-primary" />
          <div>
            <h3 className="text-sm font-semibold text-foreground">Signature request</h3>
            <p className="text-xs text-muted-foreground">
              {req.ordered ? "Sequential signing" : "Any order"} · Requested by {req.requested_by.full_name}
            </p>
          </div>
        </div>
        <span className={clsx("text-[11px] px-2 py-1 rounded-full border font-medium", STATUS_BADGE[req.status])}>
          {req.progress.signed}/{req.progress.total} signed
        </span>
      </div>

      {req.message && (
        <p className="text-xs text-muted-foreground bg-muted/20 rounded-lg px-3 py-2 border border-border">
          {req.message}
        </p>
      )}

      {/* Signers */}
      <div className="space-y-1.5">
        {req.signers.map((s, i) => (
          <div key={s.id} className="flex items-center gap-2 text-xs">
            {req.ordered && <span className="w-5 text-center text-muted-foreground">{i + 1}.</span>}
            {s.status === "signed" ? <CheckCircle2 className="w-3.5 h-3.5 text-green-600" />
              : s.status === "declined" ? <XCircle className="w-3.5 h-3.5 text-red-600" />
              : <Clock className="w-3.5 h-3.5 text-amber-500" />}
            <span className="text-foreground">{s.signer.full_name}</span>
            <span className="text-muted-foreground">
              {s.status === "signed" ? "signed" : s.status === "declined" ? `declined — ${s.decline_reason}` : "pending"}
            </span>
          </div>
        ))}
      </div>

      {/* Signer actions */}
      {req.can_sign && !declining && (
        <div className="flex gap-2">
          <button onClick={() => setShowSign(true)} className="btn-primary text-xs">
            <FileSignature className="w-3.5 h-3.5" /> Sign document
          </button>
          <button onClick={() => setDeclining(true)} className="btn-secondary text-xs text-destructive">
            Decline
          </button>
        </div>
      )}
      {req.can_sign && declining && (
        <div className="space-y-2 border border-border rounded-xl p-3 bg-muted/15">
          <label className="label text-xs">Reason for declining <span className="text-red-500">*</span></label>
          <textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={2} className="input text-sm"
            placeholder="Explain why you're declining…" autoFocus />
          <div className="flex gap-2">
            <button
              onClick={() => { if (!reason.trim()) { toast.error("Reason required"); return; } declineMutation.mutate(); }}
              disabled={declineMutation.isPending}
              className="btn-primary text-xs bg-destructive hover:bg-destructive/90"
            >
              {declineMutation.isPending && <Loader2 className="w-3 h-3 animate-spin" />} Confirm decline
            </button>
            <button onClick={() => { setDeclining(false); setReason(""); }} className="btn-secondary text-xs">
              <X className="w-3.5 h-3.5" /> Cancel
            </button>
          </div>
        </div>
      )}

      {req.my_signer_status === "signed" && req.status === "pending" && (
        <p className="text-xs text-green-700">You've signed. Waiting for the remaining signers.</p>
      )}
      {req.status === "completed" && (
        <p className="text-xs text-green-700 font-medium">All signatures collected — the document is fully signed.</p>
      )}

      {req.can_cancel && (
        <button onClick={() => cancelMutation.mutate()} disabled={cancelMutation.isPending}
          className="text-xs font-semibold text-muted-foreground hover:text-destructive transition-colors">
          {cancelMutation.isPending ? "Cancelling…" : "Cancel request"}
        </button>
      )}
    </div>
  );
}
