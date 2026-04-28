/**
 * pages/DocumentDetailPage.tsx
 *
 * Indigo Vault refresh:
 * ─────────────────────
 * • Edit details is available directly on the page for eligible documents and
 *   opens MetadataEditPanel alongside the preview, regardless of file type.
 * • All raw gray/blue/amber/red Tailwind classes migrated to semantic HSL
 *   tokens (primary, accent, teal, destructive, muted) for consistent theming.
 *
 * All business logic (locking, OCR polling, version restore, comments,
 * workflow tasks, mutations) is unchanged.
 */
import { Suspense, lazy, useState, useEffect, useRef } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { documentsAPI, workflowAPI } from "@/services/api";
const DocumentViewer = lazy(() => import("@/components/documents/DocumentViewer"));
import StatusBadge from "@/components/documents/StatusBadge";
import OcrStatusBadge from "@/components/documents/OcrStatusBadge";
const MetadataEditPanel = lazy(() => import("@/components/documents/MetadataEditPanel"));
const WorkflowActionPanel = lazy(() => import("@/components/workflow/WorkflowActionPanel"));
import { format } from "date-fns";
import {
  ArrowLeft, Send, Archive, MessageSquare, ShieldCheck,
  Loader2, RotateCcw, Edit2, Lock, Info, Download,
  CheckCircle, AlertTriangle, ScanLine, RefreshCw,
} from "lucide-react";
import { toast } from "@/components/ui/vault-toast";
import { useAuthStore } from "@/store/authStore";
import type { Document } from "@/types";
import { clsx as cn } from "clsx";

import { clearDocumentVersionCache } from "@/utils/versionPreviewCache";

const AUDIT_PAGE_SIZE = 5;

function formatBytes(b: number) {
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / 1024 / 1024).toFixed(1)} MB`;
}

type TabId = "preview" | "versions" | "comments" | "audit" | "edit";

type PaginatedResponse<T> = {
  count: number;
  results: T[];
};

type DocumentAuditLog = {
  id: string;
  event: string;
  summary?: string;
  actor_name?: string;
  ip_address?: string;
  timestamp: string;
};

export default function DocumentDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const user = useAuthStore((s) => s.user);

  const [activeTab, setActiveTab] = useState<TabId>("preview");
  const [comment, setComment] = useState("");
  const [confirmRestoreId, setConfirmRestoreId] = useState<string | null>(null);
  const [auditPage, setAuditPage] = useState(1);

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
    if (!ocrActive || !id) {
      if (pollRef.current) clearInterval(pollRef.current);
      return;
    }
    pollRef.current = setInterval(() => {
      qc.invalidateQueries({ queryKey: ["document", id] });
    }, 5_000);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [ocrActive, id, qc]);

  const prevOcrRef = useRef(ocrStatus);
  useEffect(() => {
    if (prevOcrRef.current !== "done" && ocrStatus === "done") {
      toast.success("OCR complete — document text is now searchable.");
    }
    prevOcrRef.current = ocrStatus;
  }, [ocrStatus]);

  useEffect(() => {
    if (activeTab === "audit") {
      setAuditPage(1);
    }
  }, [activeTab, id]);

  const { data: auditLogs } = useQuery({
    queryKey: ["document-audit", id, auditPage],
    queryFn: () =>
      documentsAPI.auditTrail(id!, {
        page: auditPage,
        page_size: AUDIT_PAGE_SIZE,
      }).then((r) => r.data as PaginatedResponse<DocumentAuditLog>),
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
      toast.success("Version restored. All trailing versions have been discarded.");
      setConfirmRestoreId(null);
      qc.invalidateQueries({ queryKey: ["document", id] });
      qc.invalidateQueries({ queryKey: ["document-preview", id] });
      clearDocumentVersionCache(id!);
    },
    onError: () => { toast.error("Restore failed."); setConfirmRestoreId(null); },
  });

  const reOcrMutation = useMutation({
    mutationFn: () => (documentsAPI as any).reOcr(id!),
    onSuccess: () => {
      toast.info("OCR queued. Text will be updated shortly.");
      qc.invalidateQueries({ queryKey: ["document", id] });
    },
    onError: () => toast.error("Could not queue OCR. Please try again."),
  });

  if (isLoading)
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="w-8 h-8 text-primary animate-spin" />
      </div>
    );

  if (!doc) return <p className="text-muted-foreground">Document not found.</p>;

  const isPersonal = Boolean((doc as any).is_self_upload);
  const isScanned  = Boolean((doc as any).is_scanned);
  const personalTags = doc.personal_tags ?? [];
  const extraMetadataEntries = Object.entries(doc.metadata ?? {}).filter(
    ([key]) => key !== "personal_tags",
  );
  const permissions = doc.permissions ?? [];
  const hasAdminAccess = Boolean(user?.has_admin_access);
  const canViewDocument = hasAdminAccess || permissions.includes("view");
  const canEdit    = hasAdminAccess || permissions.includes("edit");
  const canComment = hasAdminAccess || permissions.includes("comment");
  const canApprove = hasAdminAccess || permissions.includes("approve");
  const canArchive = hasAdminAccess || permissions.includes("archive");
  const canRestoreVersion = hasAdminAccess || permissions.includes("upload");
  const canReOcr = hasAdminAccess || (isScanned && permissions.includes("upload"));

  const canSubmit =
    !isPersonal &&
    (doc.status === "draft" || doc.status === "rejected") &&
    canApprove;

  const canArchiveNow =
    canArchive &&
    !["archived", "void"].includes(doc.status) &&
    (isPersonal || doc.status === "approved");

  const isDraftOrRejected = doc.status === "draft" || doc.status === "rejected";
  const auditCount = auditLogs?.count ?? 0;
  const auditPages = Math.max(1, Math.ceil(auditCount / AUDIT_PAGE_SIZE));

  // Build the tab list. "Edit details" sits next to "Audit trail" but instead
  // of switching the panel it opens the MetadataEditPanel as a modal dialog.
  const tabs: { id: TabId; label: string; isAction?: boolean; disabled?: boolean }[] = [
    { id: "preview",  label: "Preview" },
    { id: "versions", label: `Versions (${doc.versions?.length ?? 0})` },
    { id: "comments", label: "Comments" },
    ...(canViewDocument ? [{ id: "audit" as const, label: "Audit trail" }] : []),
    ...(isDraftOrRejected
      ? [{ id: "edit" as const, label: "Edit details", isAction: true, disabled: !canEdit }]
      : []),
  ];

  const handleTabClick = (tab: { id: TabId; isAction?: boolean; disabled?: boolean }) => {
    if (tab.disabled) return;
    setActiveTab(tab.id);
  };

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <button
            onClick={() => navigate(-1)}
            className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground mb-2 transition-colors"
          >
            <ArrowLeft className="w-4 h-4" /> Back
          </button>
          <div className="flex items-center gap-3 flex-wrap">
            <h1 className="text-xl font-bold text-foreground">{doc.title}</h1>
            <StatusBadge status={doc.status} />
            {isPersonal && (
            <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold bg-primary/10 text-primary border border-primary/20">
              <Lock className="w-3 h-3" /> Personal
            </span>
          )}
          {isScanned && (
            <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold bg-teal/10 text-teal border border-teal/20">
                <ScanLine className="w-3 h-3" /> Scanned
              </span>
            )}
          </div>
          <p className="text-sm text-muted-foreground mt-1 font-mono">{doc.reference_number}</p>
        </div>
        <div className="flex gap-2 flex-shrink-0 flex-wrap justify-end">
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
          {isPersonal && (
            <div className="rounded-xl border border-primary/20 bg-primary/5 px-4 py-3 flex items-start gap-3 text-sm text-primary">
              <Info className="w-4 h-4 mt-0.5 flex-shrink-0 text-primary" />
              <div>
                <p className="font-medium">Personal document</p>
                <p className="text-xs mt-0.5 text-primary/70">Private to you and administrators. Cannot be submitted for approval.</p>
              </div>
            </div>
          )}

          {ocrActive && (
            <div className="rounded-xl border border-teal/20 bg-teal/5 px-4 py-3 flex items-start gap-3 text-sm text-teal">
              <Loader2 className="w-4 h-4 mt-0.5 flex-shrink-0 animate-spin" />
              <div>
                <p className="font-medium">Extracting text…</p>
                <p className="text-xs mt-0.5 text-teal/80">
                  OCR is running in the background. This page will update automatically when complete.
                </p>
              </div>
            </div>
          )}

          {ocrStatus === "failed" && (
            <div className="rounded-xl border border-destructive/30 bg-destructive/5 px-4 py-3 flex items-start gap-3 text-sm text-destructive">
              <AlertTriangle className="w-4 h-4 mt-0.5 flex-shrink-0" />
              <div className="flex-1">
                <p className="font-medium">OCR failed</p>
                <p className="text-xs mt-0.5 text-destructive/80">Text extraction did not complete. The document is still accessible but not fully searchable.</p>
                {canReOcr && (
                  <button
                    onClick={() => reOcrMutation.mutate()}
                    disabled={reOcrMutation.isPending}
                    className="mt-2 inline-flex items-center gap-1.5 text-xs font-medium text-destructive hover:text-destructive/80"
                  >
                    {reOcrMutation.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
                    Re-run OCR
                  </button>
                )}
              </div>
            </div>
          )}

          <div className="card p-5 space-y-3">
            <h2 className="font-semibold text-foreground text-sm">Document details</h2>
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
                  <dt className="text-muted-foreground">{label}</dt>
                  <dd className="text-foreground text-right font-medium truncate max-w-[180px]">{value}</dd>
                </div>
              ))}

              {isScanned && (
                <div className="flex justify-between gap-2 pt-2 border-t border-border">
                  <dt className="text-muted-foreground">OCR status</dt>
                  <dd>
                    <OcrStatusBadge status={ocrStatus as any} showDone />
                    {!ocrStatus && <span className="text-muted-foreground text-xs">—</span>}
                  </dd>
                </div>
              )}
            </dl>
          </div>

          {!isPersonal && activeTask && (
            <Suspense fallback={<div className="card p-5 text-sm text-muted-foreground">Loading workflow actions…</div>}>
              <WorkflowActionPanel task={activeTask} documentId={id!} />
            </Suspense>
          )}

          {extraMetadataEntries.length > 0 && (
            <div className="card p-5 space-y-2">
              <h2 className="font-semibold text-foreground text-sm">Additional metadata</h2>
              <dl className="space-y-2 text-sm">
                {extraMetadataEntries.map(([key, val]) => (
                  <div key={key} className="flex justify-between gap-2">
                    <dt className="text-muted-foreground capitalize">{key.replace(/_/g, " ")}</dt>
                    <dd className="text-foreground font-medium">{String(val)}</dd>
                  </div>
                ))}
              </dl>
            </div>
          )}

          {isPersonal && personalTags.length > 0 && (
            <div className="card p-5">
              <h2 className="font-semibold text-foreground text-sm mb-3">Personal tags</h2>
              <div className="flex flex-wrap gap-2">
                {personalTags.map((tag) => (
                  <span
                    key={tag}
                    className="badge text-xs bg-primary/10 text-primary border border-primary/20"
                  >
                    {tag}
                  </span>
                ))}
              </div>
            </div>
          )}

          {doc.tags?.length > 0 && (
            <div className="card p-5">
              <h2 className="font-semibold text-foreground text-sm mb-3">
                {isPersonal ? "Shared tags" : "Tags"}
              </h2>
              <div className="flex flex-wrap gap-2">
                {doc.tags.map((tag) => (
                  <span
                    key={tag.id}
                    className="badge text-xs"
                    style={{ backgroundColor: tag.color + "22", color: tag.color }}
                  >
                    {tag.name}
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Right tabs */}
        <div className="lg:col-span-2 space-y-4 lg:-mt-4 xl:-mt-5">
          <div className="border-b border-border">
            <nav className="-mb-px flex gap-0 flex-wrap">
              {tabs.map((tab) => {
                const isActive = activeTab === tab.id;
                return (
                  <button
                    key={tab.id}
                    onClick={() => handleTabClick(tab)}
                    disabled={tab.disabled}
                    className={cn(
                      "px-4 py-2.5 text-sm font-medium border-b-2 transition-colors whitespace-nowrap inline-flex items-center gap-1.5 disabled:opacity-50 disabled:cursor-not-allowed",
                      isActive
                        ? "border-primary text-foreground"
                        : "border-transparent text-muted-foreground hover:text-foreground hover:border-border"
                    )}
                  >
                    {tab.id === "edit" && <Edit2 className="w-3.5 h-3.5" />}
                    {tab.label}
                  </button>
                );
              })}
            </nav>
          </div>

          {(activeTab === "preview" || activeTab === "edit") && (
            <div className="flex w-full h-full gap-4">
              <div className={`${activeTab === "edit" ? "w-2/3" : "w-full"} transition-all`}>
                <Suspense fallback={<div className="flex min-h-[24rem] items-center justify-center rounded-xl border border-border bg-card"><Loader2 className="w-8 h-8 text-primary animate-spin" /></div>}>
                  <DocumentViewer
                    document={doc}
                    submitSlot={
                      !isPersonal && isDraftOrRejected && canSubmit ? (
                        <button
                          onClick={() => submitMutation.mutate()}
                          disabled={submitMutation.isPending}
                          className="btn-primary"
                        >
                          {submitMutation.isPending ? (
                            <Loader2 className="w-4 h-4 animate-spin" />
                          ) : (
                            <Send className="w-4 h-4" />
                          )}
                          Submit for approval
                        </button>
                      ) : null
                    }
                  />
                </Suspense>
              </div>
              {activeTab === "edit" && (
                <div className="w-1/3 border-l border-border bg-muted/20 backdrop-blur-sm rounded-xl shadow-sm">
                  <Suspense fallback={<div className="p-6 text-sm text-muted-foreground">Loading editor…</div>}>
                    <MetadataEditPanel document={doc} onClose={() => setActiveTab("preview")} />
                  </Suspense>
                </div>
              )}
            </div>
          )}

          {activeTab === "versions" && (
            <div className="space-y-3">
              {(!doc.versions || doc.versions.length === 0) && (
                <div className="text-center py-10 text-muted-foreground"><p>No version history available.</p></div>
              )}
              {doc.versions?.map((v) => {
                const isCurrent = v.version_number === doc.current_version;
                const awaitConfirm = confirmRestoreId === v.id;
                return (
                  <div
                    key={v.id}
                    className={`card p-4 flex items-start gap-3 ${isCurrent ? "border-l-4 border-l-primary bg-primary/5" : ""}`}
                  >
                    <div
                      className={`w-9 h-9 rounded-full flex items-center justify-center text-xs font-bold flex-shrink-0 ${
                        isCurrent ? "bg-primary/15 text-primary" : "bg-muted text-muted-foreground"
                      }`}
                    >
                      v{v.version_number}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <p className="text-sm font-medium text-foreground truncate">{v.file_name}</p>
                        {isCurrent && (
                          <span className="inline-flex items-center gap-1 text-xs font-medium text-primary bg-primary/10 px-2 py-0.5 rounded-full">
                            <CheckCircle className="w-3 h-3" /> Current
                          </span>
                        )}
                      </div>
                      <p className="text-xs text-muted-foreground mt-0.5">
                        {format(new Date(v.created_at), "dd MMM yyyy HH:mm")} · {v.created_by.first_name} {v.created_by.last_name} · {formatBytes(v.file_size)}
                      </p>
                      {v.change_summary && <p className="text-xs text-foreground/80 mt-1 italic">"{v.change_summary}"</p>}
                    </div>
                    <div className="flex items-center gap-2 flex-shrink-0">
                      <a
                        href={v.file_url ?? `/api/v1/documents/webdav/${doc.id}/${encodeURIComponent(v.file_name)}?version=${v.version_number}`}
                        download={v.file_name}
                        title="Download this version"
                        className="btn-secondary text-xs px-2 py-1 flex items-center gap-1"
                      >
                        <Download className="w-3.5 h-3.5" />
                      </a>
                      {!isCurrent && canRestoreVersion && (
                        awaitConfirm ? (
                          <div className="flex items-center gap-1.5 rounded-lg border border-primary/40 bg-primary/10 px-2.5 py-1.5">
                            <AlertTriangle className="w-3.5 h-3.5 text-primary flex-shrink-0" />
                            <span className="text-xs text-foreground">Restore v{v.version_number}?</span>
                            <button
                              onClick={() => restoreMutation.mutate(v.id)}
                              disabled={restoreMutation.isPending}
                              className="text-xs font-semibold text-primary hover:text-primary/80 ml-1"
                            >
                              {restoreMutation.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : "Yes"}
                            </button>
                            <button
                              onClick={() => setConfirmRestoreId(null)}
                              className="text-xs text-muted-foreground hover:text-foreground"
                            >
                              Cancel
                            </button>
                          </div>
                        ) : (
                          <button
                            onClick={() => setConfirmRestoreId(v.id)}
                            className="btn-secondary text-xs px-2 py-1 flex items-center gap-1"
                          >
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
                <div
                  key={c.id}
                  className={`card p-4 ${c.is_internal ? "border-l-4 border-l-primary" : ""}`}
                >
                  <div className="flex items-center gap-2 mb-2">
                    <span className="text-sm font-medium text-foreground">{c.author.first_name} {c.author.last_name}</span>
                    {c.is_internal && (
                      <span className="badge bg-primary/10 text-primary border border-primary/20 text-[10px]">
                        Internal
                      </span>
                    )}
                    <span className="text-xs text-muted-foreground ml-auto">
                      {format(new Date(c.created_at), "dd MMM yyyy HH:mm")}
                    </span>
                  </div>
                  <p className="text-sm text-foreground/90">{c.content}</p>
                </div>
              ))}
              <div className="card p-4 space-y-3">
                <textarea
                  value={comment}
                  onChange={(e) => setComment(e.target.value)}
                  rows={3}
                  className="input"
                  placeholder="Add a comment…"
                  disabled={!canComment}
                />
                <button
                  onClick={() => comment.trim() && commentMutation.mutate(comment.trim())}
                  disabled={!comment.trim() || commentMutation.isPending || !canComment}
                  className="btn-primary"
                >
                  {commentMutation.isPending && <Loader2 className="w-4 h-4 animate-spin" />}
                  <MessageSquare className="w-4 h-4" /> Add comment
                </button>
              </div>
            </div>
          )}

          {activeTab === "audit" && (
            <div className="space-y-2 max-w-2xl">
              {auditLogs?.results?.length ? (
                auditLogs.results.map((log) => (
                  <div
                    key={log.id}
                    className="inline-flex w-full max-w-2xl items-start gap-3 rounded-lg border border-border bg-card px-3 py-2"
                  >
                    <ShieldCheck className="w-4 h-4 text-primary mt-0.5 flex-shrink-0" />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm text-foreground">{log.summary || log.event}</p>
                      <p className="text-xs text-muted-foreground">
                        {log.actor_name || "System"} · {log.ip_address || "Unknown IP"} · {format(new Date(log.timestamp), "dd MMM yyyy HH:mm:ss")}
                      </p>
                    </div>
                  </div>
                ))
              ) : (
                <div className="rounded-lg border border-border bg-card px-4 py-6 text-sm text-muted-foreground">
                  No audit history found for this document yet.
                </div>
              )}

              {auditCount > AUDIT_PAGE_SIZE && (
                <div className="flex items-center justify-between border-t border-border pt-4">
                  <span className="text-xs text-muted-foreground">
                    Page {auditPage} of {auditPages}
                  </span>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => setAuditPage((current) => Math.max(1, current - 1))}
                      disabled={auditPage === 1}
                      className="btn-secondary text-xs px-3 py-1.5 disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                      Previous
                    </button>
                    <button
                      type="button"
                      onClick={() => setAuditPage((current) => Math.min(auditPages, current + 1))}
                      disabled={auditPage >= auditPages}
                      className="btn-secondary text-xs px-3 py-1.5 disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                      Next
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
