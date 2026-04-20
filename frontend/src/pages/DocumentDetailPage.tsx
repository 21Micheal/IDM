/**
 * pages/DocumentDetailPage.tsx
 *
 * Changes from previous version
 * ──────────────────────────────
 * 1. OCR status badge in the sidebar document-details card (next to Version).
 *
 * 2. OCR processing banner: when ocr_status === "processing" or "pending" an
 *    info strip appears at the top of the sidebar explaining text is being
 *    extracted. Auto-polls every 5 s and dismisses when status becomes "done".
 *
 * 3. "Re-run OCR" button (admin only, or uploader of scanned doc) visible when
 *    ocr_status === "failed". Calls POST /documents/{id}/re_ocr/.
 *
 * 4. OCR polling: useEffect starts a 5 s interval when status is pending or
 *    processing. Clears on unmount or when status resolves.
 *
 * 5. DocumentViewer now receives full document object (from previous revision).
 *
 * All other logic (self-upload, versioning, workflow panel) is unchanged.
 */
import { useState, useEffect, useRef } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { documentsAPI, workflowAPI } from "@/services/api";
import DocumentViewer from "@/components/documents/DocumentViewer";
import StatusBadge from "@/components/documents/StatusBadge";
import OcrStatusBadge from "@/components/documents/OcrStatusBadge";
import MetadataEditPanel from "@/components/documents/MetadataEditPanel";
import WorkflowActionPanel from "@/components/workflow/WorkflowActionPanel";
import { format } from "date-fns";
import {
  ArrowLeft, Send, Archive, MessageSquare, ShieldCheck,
  Loader2, RotateCcw, Edit2, Lock, Info, Download,
  CheckCircle, AlertTriangle, ScanLine, RefreshCw,
} from "lucide-react";
import { toast } from "react-toastify";
import { useAuthStore } from "@/store/authStore";
import type { Document } from "@/types";

function formatBytes(b: number) {
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / 1024 / 1024).toFixed(1)} MB`;
}

export default function DocumentDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const user = useAuthStore((s) => s.user);

  const [activeTab, setActiveTab]   = useState<"preview" | "versions" | "comments" | "audit">("preview");
  const [comment, setComment]       = useState("");
  const [showEdit, setShowEdit]     = useState(false);
  const [confirmRestoreId, setConfirmRestoreId] = useState<string | null>(null);

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const { data: doc, isLoading } = useQuery<Document>({
    queryKey: ["document", id],
    queryFn: () => documentsAPI.get(id!).then((r) => r.data),
    enabled: !!id,
  });

  // ── OCR status polling ─────────────────────────────────────────────────────
  const ocrStatus = (doc as any)?.ocr_status as string | undefined;
  const ocrActive = ocrStatus === "pending" || ocrStatus === "processing";

  useEffect(() => {
    if (!ocrActive || !id) { if (pollRef.current) clearInterval(pollRef.current); return; }

    pollRef.current = setInterval(() => {
      qc.invalidateQueries({ queryKey: ["document", id] });
    }, 5_000);

    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [ocrActive, id, qc]);

  // Show toast when OCR completes
  const prevOcrRef = useRef(ocrStatus);
  useEffect(() => {
    if (prevOcrRef.current !== "done" && ocrStatus === "done") {
      toast.success("OCR complete — document text is now searchable.");
    }
    prevOcrRef.current = ocrStatus;
  }, [ocrStatus]);

  const { data: auditLogs } = useQuery({
    queryKey: ["document-audit", id],
    queryFn: () => documentsAPI.auditTrail(id!).then((r) => r.data),
    enabled: activeTab === "audit" && !!id,
  });

  const { data: myTasks } = useQuery({
    queryKey: ["workflow", "my-tasks"],
    queryFn: () => workflowAPI.myTasks().then((r) => r.data),
    enabled: !!id,
  });
  const activeTask = myTasks?.find((t: { document_id: string }) => t.document_id === id);

  const submitMutation = useMutation({
    mutationFn: () => documentsAPI.submit(id!),
    onSuccess: () => { toast.success("Submitted for approval"); qc.invalidateQueries({ queryKey: ["document", id] }); },
    onError: () => toast.error("Submission failed"),
  });

  const archiveMutation = useMutation({
    mutationFn: () => documentsAPI.archive(id!),
    onSuccess: () => { toast.success("Archived"); qc.invalidateQueries({ queryKey: ["document", id] }); },
  });

  const commentMutation = useMutation({
    mutationFn: (content: string) => documentsAPI.addComment(id!, content),
    onSuccess: () => { setComment(""); qc.invalidateQueries({ queryKey: ["document", id] }); },
    onError: () => toast.error("Failed to add comment"),
  });

  const restoreMutation = useMutation({
    mutationFn: (versionId: string) => documentsAPI.restoreVersion(id!, versionId),
    onSuccess: () => {
      toast.success("Version restored.");
      setConfirmRestoreId(null);
      qc.invalidateQueries({ queryKey: ["document", id] });
      qc.invalidateQueries({ queryKey: ["document-preview", id] });
    },
    onError: () => { toast.error("Restore failed."); setConfirmRestoreId(null); },
  });

  // Re-run OCR mutation
  const reOcrMutation = useMutation({
    mutationFn: () => (documentsAPI as any).reOcr(id!),
    onSuccess: () => {
      toast.info("OCR queued. Text will be updated shortly.");
      qc.invalidateQueries({ queryKey: ["document", id] });
    },
    onError: () => toast.error("Could not queue OCR. Please try again."),
  });

  if (isLoading) return (
    <div className="flex items-center justify-center h-64">
      <Loader2 className="w-8 h-8 text-primary animate-spin" />
    </div>
  );

  if (!doc) return <p className="text-gray-500">Document not found.</p>;

  const isPersonal = Boolean((doc as any).is_self_upload);
  const isScanned  = Boolean((doc as any).is_scanned);
  const permissions = doc.permissions ?? [];
  const canEdit    = user?.role === "admin" || permissions.includes("edit");
  const canComment = user?.role === "admin" || permissions.includes("comment");
  const canApprove = user?.role === "admin" || permissions.includes("approve");
  const canArchive = user?.role === "admin" || permissions.includes("archive");
  const canRestoreVersion = user?.role === "admin" || permissions.includes("upload");
  const canReOcr = user?.role === "admin" || (isScanned && permissions.includes("upload"));

  const canSubmit =
    !isPersonal &&
    (doc.status === "draft" || doc.status === "rejected") &&
    canApprove;

  const canArchiveNow =
    canArchive &&
    !["archived", "void"].includes(doc.status) &&
    (isPersonal || doc.status === "approved");

  const isDraftOrRejected = doc.status === "draft" || doc.status === "rejected";

  const tabs = [
    { id: "preview",  label: "Preview" },
    { id: "versions", label: `Versions (${doc.versions?.length ?? 0})` },
    { id: "comments", label: "Comments" },
    ...(user?.role === "admin" || user?.role === "auditor"
      ? [{ id: "audit", label: "Audit trail" }] : []),
  ];

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <button onClick={() => navigate(-1)} className="flex items-center gap-1 text-sm text-gray-500 hover:text-gray-700 mb-2">
            <ArrowLeft className="w-4 h-4" /> Back
          </button>
          <div className="flex items-center gap-3 flex-wrap">
            <h1 className="text-xl font-bold text-gray-900">{doc.title}</h1>
            <StatusBadge status={doc.status} />
            {isPersonal && (
              <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold bg-primary/10 text-primary">
                <Lock className="w-3 h-3" /> Personal
              </span>
            )}
            {isScanned && (
              <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold bg-teal-100 text-teal-700">
                <ScanLine className="w-3 h-3" /> Scanned
              </span>
            )}
          </div>
          <p className="text-sm text-gray-500 mt-1 font-mono">{doc.reference_number}</p>
        </div>
        <div className="flex gap-2 flex-shrink-0 flex-wrap justify-end">
          {isDraftOrRejected && (
            <button onClick={() => setShowEdit(!showEdit)} className="btn-secondary" disabled={!canEdit}>
              <Edit2 className="w-4 h-4" /> {showEdit ? "Cancel" : "Edit details"}
            </button>
          )}
          {!isPersonal && isDraftOrRejected && canSubmit && (
            <button onClick={() => submitMutation.mutate()} disabled={submitMutation.isPending} className="btn-primary">
              {submitMutation.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
              Submit for approval
            </button>
          )}
          {canArchiveNow && (
            <button onClick={() => archiveMutation.mutate()} disabled={archiveMutation.isPending} className="btn-secondary">
              {archiveMutation.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Archive className="w-4 h-4" />}
              Archive
            </button>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
        {/* Sidebar */}
        <div className="space-y-4">
          {/* Personal notice */}
          {isPersonal && (
            <div className="rounded-xl border border-primary/20 bg-primary/5 px-4 py-3 flex items-start gap-3 text-sm text-primary">
              <Info className="w-4 h-4 mt-0.5 flex-shrink-0 text-primary" />
              <div>
                <p className="font-medium">Personal document</p>
                <p className="text-xs mt-0.5 text-primary/70">Private to you and administrators. Cannot be submitted for approval.</p>
              </div>
            </div>
          )}

          {/* OCR active banner */}
          {ocrActive && (
            <div className="rounded-xl border border-teal-200 bg-teal-50 px-4 py-3 flex items-start gap-3 text-sm text-teal-800">
              <Loader2 className="w-4 h-4 mt-0.5 flex-shrink-0 text-teal-500 animate-spin" />
              <div>
                <p className="font-medium">Extracting text…</p>
                <p className="text-xs mt-0.5 text-teal-600">
                  OCR is running in the background. This page will update automatically when complete.
                </p>
              </div>
            </div>
          )}

          {/* OCR failed banner + re-run button */}
          {ocrStatus === "failed" && (
            <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 flex items-start gap-3 text-sm text-red-800">
              <AlertTriangle className="w-4 h-4 mt-0.5 flex-shrink-0 text-red-500" />
              <div className="flex-1">
                <p className="font-medium">OCR failed</p>
                <p className="text-xs mt-0.5 text-red-600">Text extraction did not complete. The document is still accessible but not fully searchable.</p>
                {canReOcr && (
                  <button onClick={() => reOcrMutation.mutate()} disabled={reOcrMutation.isPending}
                    className="mt-2 flex items-center gap-1.5 text-xs font-medium text-red-700 hover:text-red-900">
                    {reOcrMutation.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
                    Re-run OCR
                  </button>
                )}
              </div>
            </div>
          )}

          <div className="card p-5 space-y-3">
            <h2 className="font-semibold text-gray-900 text-sm">Document details</h2>
            <dl className="space-y-2 text-sm">
              {[
                { label: "Type",    value: doc.document_type?.name },
                { label: "Supplier", value: doc.supplier || "—" },
                { label: "Amount",  value: doc.amount ? new Intl.NumberFormat("en-US", { style: "currency", currency: doc.currency }).format(doc.amount) : "—" },
                { label: "Date",    value: doc.document_date ? format(new Date(doc.document_date), "dd MMM yyyy") : "—" },
                { label: "Due date", value: doc.due_date ? format(new Date(doc.due_date), "dd MMM yyyy") : "—" },
                { label: "Version", value: `v${doc.current_version}` },
                { label: "File",    value: doc.file_name },
                { label: "Size",    value: formatBytes(doc.file_size) },
                { label: "Uploaded by", value: `${doc.uploaded_by?.first_name} ${doc.uploaded_by?.last_name}` },
                { label: "Created", value: format(new Date(doc.created_at), "dd MMM yyyy HH:mm") },
              ].map(({ label, value }) => (
                <div key={label} className="flex justify-between gap-2">
                  <dt className="text-gray-500">{label}</dt>
                  <dd className="text-gray-900 text-right font-medium truncate max-w-[180px]">{value}</dd>
                </div>
              ))}

              {/* OCR status row — only for scanned docs */}
              {isScanned && (
                <div className="flex justify-between gap-2 pt-1 border-t border-gray-100">
                  <dt className="text-gray-500">OCR status</dt>
                  <dd>
                    <OcrStatusBadge status={ocrStatus as any} showDone />
                    {!ocrStatus && <span className="text-gray-400 text-xs">—</span>}
                  </dd>
                </div>
              )}
            </dl>
          </div>

          {showEdit && <MetadataEditPanel document={doc} onClose={() => setShowEdit(false)} />}
          {!isPersonal && activeTask && <WorkflowActionPanel task={activeTask} documentId={id!} />}

          {doc.metadata && Object.keys(doc.metadata).length > 0 && (
            <div className="card p-5 space-y-2">
              <h2 className="font-semibold text-gray-900 text-sm">Additional metadata</h2>
              <dl className="space-y-2 text-sm">
                {Object.entries(doc.metadata).map(([key, val]) => (
                  <div key={key} className="flex justify-between gap-2">
                    <dt className="text-gray-500 capitalize">{key.replace(/_/g, " ")}</dt>
                    <dd className="text-gray-900 font-medium">{String(val)}</dd>
                  </div>
                ))}
              </dl>
            </div>
          )}

          {doc.tags?.length > 0 && (
            <div className="card p-5">
              <h2 className="font-semibold text-gray-900 text-sm mb-3">Tags</h2>
              <div className="flex flex-wrap gap-2">
                {doc.tags.map((tag) => (
                  <span key={tag.id} className="badge text-xs"
                    style={{ backgroundColor: tag.color + "22", color: tag.color }}>
                    {tag.name}
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Right tabs */}
        <div className="lg:col-span-2 space-y-4">
          <div className="border-b border-gray-200">
            <nav className="-mb-px flex gap-0">
              {tabs.map((tab) => (
                <button key={tab.id} onClick={() => setActiveTab(tab.id as typeof activeTab)}
                  className={`px-4 py-2.5 text-sm font-medium border-b-2 transition-colors whitespace-nowrap ${
                    activeTab === tab.id ? "border-primary text-primary" : "border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300"
                  }`}>
                  {tab.label}
                </button>
              ))}
            </nav>
          </div>

          {activeTab === "preview" && <DocumentViewer document={doc} />}

          {activeTab === "versions" && (
            <div className="space-y-3">
              {(!doc.versions || doc.versions.length === 0) && (
                <div className="text-center py-10 text-gray-400"><p>No version history available.</p></div>
              )}
              {doc.versions?.map((v) => {
                const isCurrent = v.version_number === doc.current_version;
                const awaitConfirm = confirmRestoreId === v.id;
                return (
                  <div key={v.id} className={`card p-4 flex items-start gap-3 ${isCurrent ? "border-l-4 border-primary bg-primary/5" : ""}`}>
                    <div className={`w-9 h-9 rounded-full flex items-center justify-center text-xs font-bold flex-shrink-0 ${isCurrent ? "bg-primary/20 text-primary" : "bg-gray-100 text-gray-500"}`}>
                      v{v.version_number}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <p className="text-sm font-medium text-gray-900 truncate">{v.file_name}</p>
                        {isCurrent && (
                          <span className="inline-flex items-center gap-1 text-xs font-medium text-primary bg-primary/10 px-2 py-0.5 rounded-full">
                            <CheckCircle className="w-3 h-3" /> Current
                          </span>
                        )}
                      </div>
                      <p className="text-xs text-gray-500 mt-0.5">
                        {format(new Date(v.created_at), "dd MMM yyyy HH:mm")} · {v.created_by.first_name} {v.created_by.last_name} · {formatBytes(v.file_size)}
                      </p>
                      {v.change_summary && <p className="text-xs text-gray-600 mt-1 italic">"{v.change_summary}"</p>}
                    </div>
                    <div className="flex items-center gap-2 flex-shrink-0">
                      <a href={`/api/v1/documents/webdav/${doc.id}/${encodeURIComponent(v.file_name)}?version=${v.version_number}`}
                        download={v.file_name} title="Download this version"
                        className="btn-secondary text-xs px-2 py-1 flex items-center gap-1">
                        <Download className="w-3.5 h-3.5" />
                      </a>
                      {!isCurrent && canRestoreVersion && (
                        awaitConfirm ? (
                          <div className="flex items-center gap-1.5 rounded-lg border border-amber-200 bg-amber-50 px-2.5 py-1.5">
                            <AlertTriangle className="w-3.5 h-3.5 text-amber-500 flex-shrink-0" />
                            <span className="text-xs text-amber-800">Restore v{v.version_number}?</span>
                            <button onClick={() => restoreMutation.mutate(v.id)} disabled={restoreMutation.isPending}
                              className="text-xs font-semibold text-amber-700 hover:text-amber-900 ml-1">
                              {restoreMutation.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : "Yes"}
                            </button>
                            <button onClick={() => setConfirmRestoreId(null)} className="text-xs text-gray-400 hover:text-gray-600">Cancel</button>
                          </div>
                        ) : (
                          <button onClick={() => setConfirmRestoreId(v.id)}
                            className="btn-secondary text-xs px-2 py-1 flex items-center gap-1">
                            <RotateCcw className="w-3 h-3" /> Restore
                          </button>
                        )
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {activeTab === "comments" && (
            <div className="space-y-4">
              {doc.comments?.map((c) => (
                <div key={c.id} className={`card p-4 ${c.is_internal ? "border-l-4 border-amber-400" : ""}`}>
                  <div className="flex items-center gap-2 mb-2">
                    <span className="text-sm font-medium text-gray-900">{c.author.first_name} {c.author.last_name}</span>
                    {c.is_internal && <span className="badge bg-amber-50 text-amber-700 text-[10px]">Internal</span>}
                    <span className="text-xs text-gray-400 ml-auto">{format(new Date(c.created_at), "dd MMM yyyy HH:mm")}</span>
                  </div>
                  <p className="text-sm text-gray-700">{c.content}</p>
                </div>
              ))}
              <div className="card p-4 space-y-3">
                <textarea value={comment} onChange={(e) => setComment(e.target.value)} rows={3} className="input"
                  placeholder="Add a comment…" disabled={!canComment} />
                <button onClick={() => comment.trim() && commentMutation.mutate(comment.trim())}
                  disabled={!comment.trim() || commentMutation.isPending || !canComment} className="btn-primary">
                  {commentMutation.isPending && <Loader2 className="w-4 h-4 animate-spin" />}
                  <MessageSquare className="w-4 h-4" /> Add comment
                </button>
              </div>
            </div>
          )}

          {activeTab === "audit" && (
            <div className="space-y-2">
              {auditLogs?.map((log: any) => (
                <div key={log.id} className="card p-3 flex items-start gap-3">
                  <ShieldCheck className="w-4 h-4 text-primary mt-0.5 flex-shrink-0" />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm text-gray-900">{log.event}</p>
                    <p className="text-xs text-gray-500">{log.actor_name} · {log.ip_address} · {format(new Date(log.timestamp), "dd MMM yyyy HH:mm:ss")}</p>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}