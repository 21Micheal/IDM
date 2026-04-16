import { useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { documentsAPI } from "@/services/api";
import DocumentViewer from "@/components/documents/DocumentViewer";
import StatusBadge from "@/components/documents/StatusBadge";
import MetadataEditPanel from "@/components/documents/MetadataEditPanel";
import { format } from "date-fns";
import {
  ArrowLeft, Send, Archive, History, MessageSquare,
  ShieldCheck, Loader2, RotateCcw, ChevronDown, ChevronUp, Edit2,
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
  const [activeTab, setActiveTab] = useState<"preview" | "versions" | "comments" | "audit">("preview");
  const [comment, setComment] = useState("");
  const [showEdit, setShowEdit] = useState(false);

  const { data: doc, isLoading } = useQuery<Document>({
    queryKey: ["document", id],
    queryFn: () => documentsAPI.get(id!).then((r) => r.data),
    enabled: !!id,
  });

  const { data: auditLogs } = useQuery({
    queryKey: ["document-audit", id],
    queryFn: () => documentsAPI.auditTrail(id!).then((r) => r.data),
    enabled: activeTab === "audit" && !!id,
  });

  const submitMutation = useMutation({
    mutationFn: () => documentsAPI.submit(id!),
    onSuccess: () => { 
      toast.success("Submitted for approval"); 
      qc.invalidateQueries({ queryKey: ["document", id] }); 
    },
    onError: () => toast.error("Submission failed"),
  });

  const archiveMutation = useMutation({
    mutationFn: () => documentsAPI.archive(id!),
    onSuccess: () => { 
      toast.success("Archived"); 
      qc.invalidateQueries({ queryKey: ["document", id] }); 
    },
  });

  const commentMutation = useMutation({
    mutationFn: (content: string) => documentsAPI.addComment(id!, content),
    onSuccess: () => { 
      setComment(""); 
      qc.invalidateQueries({ queryKey: ["document", id] }); 
    },
    onError: () => toast.error("Failed to add comment"),
  });

  const restoreMutation = useMutation({
    mutationFn: (versionId: string) => documentsAPI.restoreVersion(id!, versionId),
    onSuccess: () => { 
      toast.success("Version restored"); 
      qc.invalidateQueries({ queryKey: ["document", id] }); 
    },
  });

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="w-8 h-8 text-brand-500 animate-spin" />
      </div>
    );
  }

  if (!doc) return <p className="text-gray-500">Document not found.</p>;

  // Permission checks
  const canView = true; // We already reached here
  const permissions = doc.permissions ?? [];
  const canEdit = user?.role === "admin" || permissions.includes("edit") || false;
  const canComment = user?.role === "admin" || permissions.includes("comment") || false;
  const canApprove = user?.role === "admin" || permissions.includes("approve") || false;
  const canArchive = user?.role === "admin" || permissions.includes("archive") || false;
  const canRestoreVersion = user?.role === "admin" || permissions.includes("upload") || false;

  const canSubmit = (doc.status === "draft" || doc.status === "rejected") && canApprove;

  const tabs = [
    { id: "preview", label: "Preview" },
    { id: "versions", label: `Versions (${doc.versions?.length ?? 0})` },
    { id: "comments", label: "Comments" },
    ...(user?.role === "admin" || user?.role === "auditor"
      ? [{ id: "audit", label: "Audit trail" }]
      : []),
  ];

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <button
            onClick={() => navigate(-1)}
            className="flex items-center gap-1 text-sm text-gray-500 hover:text-gray-700 mb-2"
          >
            <ArrowLeft className="w-4 h-4" /> Back
          </button>
          <div className="flex items-center gap-3 flex-wrap">
            <h1 className="text-xl font-bold text-gray-900">{doc.title}</h1>
            <StatusBadge status={doc.status} />
          </div>
          <p className="text-sm text-gray-500 mt-1 font-mono">{doc.reference_number}</p>
        </div>
        
        <div className="flex gap-2 flex-shrink-0 flex-wrap justify-end">
          {(doc.status === "draft" || doc.status === "rejected") && (
            <button
              onClick={() => setShowEdit(!showEdit)}
              className="btn-secondary"
              disabled={!canEdit}
            >
              <Edit2 className="w-4 h-4" />
              {showEdit ? "Cancel" : "Edit details"}
            </button>
          )}

          {(doc.status === "draft" || doc.status === "rejected") && canSubmit && (
            <button
              onClick={() => submitMutation.mutate()}
              disabled={submitMutation.isPending || !canSubmit}
              className="btn-primary"
            >
              {submitMutation.isPending && <Loader2 className="w-4 h-4 animate-spin" />}
              <Send className="w-4 h-4" /> Submit for approval
            </button>
          )}

          {doc.status === "approved" && canArchive && (
            <button
              onClick={() => archiveMutation.mutate()}
              disabled={archiveMutation.isPending}
              className="btn-secondary"
            >
              <Archive className="w-4 h-4" /> Archive
            </button>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
        {/* Left: metadata */}
        <div className="space-y-4">
          <div className="card p-5 space-y-3">
            <h2 className="font-semibold text-gray-900 text-sm">Document details</h2>
            <dl className="space-y-2 text-sm">
              {[
                { label: "Type", value: doc.document_type?.name },
                { label: "Supplier", value: doc.supplier || "—" },
                {
                  label: "Amount",
                  value: doc.amount
                    ? new Intl.NumberFormat("en-US", {
                        style: "currency",
                        currency: doc.currency,
                      }).format(doc.amount)
                    : "—",
                },
                {
                  label: "Date",
                  value: doc.document_date
                    ? format(new Date(doc.document_date), "dd MMM yyyy")
                    : "—",
                },
                {
                  label: "Due date",
                  value: doc.due_date
                    ? format(new Date(doc.due_date), "dd MMM yyyy")
                    : "—",
                },
                { label: "Version", value: `v${doc.current_version}` },
                { label: "File", value: doc.file_name },
                {
                  label: "Size",
                  value: formatBytes(doc.file_size),
                },
                {
                  label: "Uploaded by",
                  value: `${doc.uploaded_by?.first_name} ${doc.uploaded_by?.last_name}`,
                },
                {
                  label: "Created",
                  value: format(new Date(doc.created_at), "dd MMM yyyy HH:mm"),
                },
              ].map(({ label, value }) => (
                <div key={label} className="flex justify-between gap-2">
                  <dt className="text-gray-500">{label}</dt>
                  <dd className="text-gray-900 text-right font-medium truncate max-w-[180px]">{value}</dd>
                </div>
              ))}
            </dl>
          </div>

          {showEdit && (
            <MetadataEditPanel
              document={doc}
              onClose={() => setShowEdit(false)}
            />
          )}

          {/* Dynamic metadata */}
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

          {/* Tags */}
          {doc.tags?.length > 0 && (
            <div className="card p-5">
              <h2 className="font-semibold text-gray-900 text-sm mb-3">Tags</h2>
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

        {/* Right: tabs */}
        <div className="lg:col-span-2 space-y-4">
          {/* Tab bar */}
          <div className="border-b border-gray-200">
            <nav className="-mb-px flex gap-0">
              {tabs.map((tab) => (
                <button
                  key={tab.id}
                  onClick={() => setActiveTab(tab.id as typeof activeTab)}
                  className={`px-4 py-2.5 text-sm font-medium border-b-2 transition-colors whitespace-nowrap ${
                    activeTab === tab.id
                      ? "border-brand-500 text-brand-600"
                      : "border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300"
                  }`}
                >
                  {tab.label}
                </button>
              ))}
            </nav>
          </div>

          {activeTab === "preview" && <DocumentViewer documentId={id!} />}

          {activeTab === "versions" && (
            <div className="space-y-3">
              {doc.versions?.map((v) => (
                <div key={v.id} className="card p-4 flex items-start gap-3">
                  <div className="w-8 h-8 rounded-full bg-brand-50 flex items-center justify-center text-brand-600 text-xs font-bold flex-shrink-0">
                    v{v.version_number}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-gray-900">{v.file_name}</p>
                    <p className="text-xs text-gray-500">
                      {format(new Date(v.created_at), "dd MMM yyyy HH:mm")} ·{" "}
                      {v.created_by.first_name} {v.created_by.last_name}
                    </p>
                    {v.change_summary && (
                      <p className="text-xs text-gray-600 mt-1">{v.change_summary}</p>
                    )}
                  </div>
                  {v.version_number !== doc.current_version && canRestoreVersion && (
                    <button
                      onClick={() => restoreMutation.mutate(v.id)}
                      className="btn-secondary text-xs px-2 py-1"
                    >
                      <RotateCcw className="w-3 h-3" /> Restore
                    </button>
                  )}
                  {v.version_number === doc.current_version && (
                    <span className="badge bg-green-100 text-green-700">Current</span>
                  )}
                </div>
              ))}
            </div>
          )}

          {activeTab === "comments" && (
            <div className="space-y-4">
              {doc.comments?.map((c) => (
                <div key={c.id} className={`card p-4 ${c.is_internal ? "border-l-4 border-amber-400" : ""}`}>
                  <div className="flex items-center gap-2 mb-2">
                    <span className="text-sm font-medium text-gray-900">
                      {c.author.first_name} {c.author.last_name}
                    </span>
                    {c.is_internal && (
                      <span className="badge bg-amber-50 text-amber-700 text-[10px]">Internal</span>
                    )}
                    <span className="text-xs text-gray-400 ml-auto">
                      {format(new Date(c.created_at), "dd MMM yyyy HH:mm")}
                    </span>
                  </div>
                  <p className="text-sm text-gray-700">{c.content}</p>
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
            <div className="space-y-2">
              {auditLogs?.map((log: any) => (
                <div key={log.id} className="card p-3 flex items-start gap-3">
                  <ShieldCheck className="w-4 h-4 text-brand-500 mt-0.5 flex-shrink-0" />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm text-gray-900">{log.event}</p>
                    <p className="text-xs text-gray-500">
                      {log.actor_name} · {log.ip_address} ·{" "}
                      {format(new Date(log.timestamp), "dd MMM yyyy HH:mm:ss")}
                    </p>
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