import { useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { documentsAPI, documentTypesAPI } from "@/services/api";
import StatusBadge from "@/components/documents/StatusBadge";
import {
  FileText, Upload, Filter, ChevronLeft, ChevronRight,
  CheckCircle, XCircle, Archive, Trash2, Loader2,
  CheckSquare, Square, X,
} from "lucide-react";
import { format } from "date-fns";
import { toast } from "react-toastify";
import clsx from "clsx";
import type { Document, DocumentType } from "@/types";

const PAGE_SIZE = 20;
type BulkAction = "approve" | "reject" | "archive" | "void";

function BulkToolbar({
  selectedIds,
  onAction,
  onClear,
  isLoading,
}: {
  selectedIds: string[];
  onAction: (action: BulkAction, comment?: string) => void;
  onClear: () => void;
  isLoading: boolean;
}) {
  const [rejectModal, setRejectModal] = useState(false);
  const [comment, setComment] = useState("");

  if (selectedIds.length === 0) return null;

  return (
    <>
      <div className="sticky top-0 z-10 bg-white border-b border-gray-200 px-6 py-4 flex items-center gap-4 shadow-sm">
        <div className="flex items-center gap-3">
          <div className="text-sm font-medium text-gray-700">
            {selectedIds.length} selected
          </div>
          <div className="h-4 w-px bg-gray-300" />
        </div>

        <div className="flex gap-2">
          <button
            onClick={() => onAction("approve")}
            disabled={isLoading}
            className="flex items-center gap-2 px-5 py-2 text-sm font-medium bg-green-600 text-white rounded-2xl hover:bg-green-700 disabled:opacity-50 transition-all"
          >
            {isLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle className="w-4 h-4" />}
            Approve
          </button>

          <button
            onClick={() => setRejectModal(true)}
            disabled={isLoading}
            className="flex items-center gap-2 px-5 py-2 text-sm font-medium bg-red-600 text-white rounded-2xl hover:bg-red-700 disabled:opacity-50 transition-all"
          >
            <XCircle className="w-4 h-4" /> Reject
          </button>

          <button
            onClick={() => onAction("archive")}
            disabled={isLoading}
            className="flex items-center gap-2 px-5 py-2 text-sm font-medium bg-blue-600 text-white rounded-2xl hover:bg-blue-700 disabled:opacity-50 transition-all"
          >
            <Archive className="w-4 h-4" /> Archive
          </button>

          <button
            onClick={() => {
              if (confirm(`Void ${selectedIds.length} documents? This action cannot be undone.`)) {
                onAction("void");
              }
            }}
            disabled={isLoading}
            className="flex items-center gap-2 px-5 py-2 text-sm font-medium bg-gray-700 text-white rounded-2xl hover:bg-gray-800 disabled:opacity-50 transition-all"
          >
            <Trash2 className="w-4 h-4" /> Void
          </button>
        </div>

        <button 
          onClick={onClear} 
          className="ml-auto text-gray-400 hover:text-gray-600 p-2 rounded-xl hover:bg-gray-100 transition-colors"
        >
          <X className="w-5 h-5" />
        </button>
      </div>

      {/* Reject Modal */}
      {rejectModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="card w-full max-w-md p-6 space-y-5">
            <h2 className="font-semibold text-lg text-gray-900">Reject Selected Documents</h2>
            <p className="text-sm text-gray-500">
              Please provide a reason for rejection. This will be visible to all involved parties.
            </p>
            <textarea
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              rows={4}
              className="input"
              placeholder="Reason for rejection..."
              autoFocus
            />
            <div className="flex gap-3 justify-end">
              <button onClick={() => setRejectModal(false)} className="btn-secondary">Cancel</button>
              <button
                onClick={() => {
                  if (!comment.trim()) {
                    toast.error("Rejection reason is required");
                    return;
                  }
                  onAction("reject", comment.trim());
                  setRejectModal(false);
                  setComment("");
                }}
                disabled={isLoading}
                className="btn-danger"
              >
                Reject Documents
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

export default function DocumentsPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [page, setPage] = useState(1);
  const [showFilters, setShowFilters] = useState(false);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const qc = useQueryClient();

  const statusFilter = searchParams.get("status") || "";
  const typeId = searchParams.get("type") || "";
  const supplier = searchParams.get("supplier") || "";

  const { data: docTypes } = useQuery<DocumentType[]>({
    queryKey: ["document-types"],
    queryFn: () => documentTypesAPI.list().then((r) => r.data.results ?? r.data),
  });

  const { data, isLoading } = useQuery({
    queryKey: ["documents", { page, statusFilter, typeId, supplier }],
    queryFn: () =>
      documentsAPI.list({
        page,
        page_size: PAGE_SIZE,
        ...(statusFilter && { status: statusFilter }),
        ...(typeId && { document_type: typeId }),
        ...(supplier && { supplier }),
      }).then((r) => r.data),
  });

  const totalPages = Math.ceil((data?.count ?? 0) / PAGE_SIZE);
  const pageIds = (data?.results ?? []).map((d: Document) => d.id);
  const allChecked = pageIds.length > 0 && pageIds.every((id: string) => selectedIds.includes(id));

  const toggleAll = () => {
    setSelectedIds(allChecked ? [] : pageIds);
  };

  const toggleOne = (id: string) => {
    setSelectedIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
    );
  };

  const bulkMutation = useMutation({
    mutationFn: ({ action, comment }: { action: BulkAction; comment?: string }) =>
      documentsAPI.bulkAction(selectedIds, action, comment),
    onSuccess: ({ data: result }) => {
      const rows = (result?.results ?? []) as Array<{ status: "ok" | "error"; detail?: string }>;
      const succeeded = rows.filter((r) => r.status === "ok").length;
      const failed = rows.length - succeeded;

      toast.success(`${succeeded} documents processed successfully`);
      if (failed > 0) toast.warn(`${failed} actions failed`);

      setSelectedIds([]);
      qc.invalidateQueries({ queryKey: ["documents"] });
    },
    onError: () => toast.error("Bulk action failed"),
  });

  return (
    <div className="max-w-7xl mx-auto py-8 px-6">
      {/* Header */}
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-3xl font-bold text-gray-900">Documents</h1>
          <p className="text-gray-500 mt-1">{data?.count ?? 0} total documents</p>
        </div>
        <div className="flex gap-3">
          <button
            onClick={() => setShowFilters(!showFilters)}
            className="btn-secondary flex items-center gap-2"
          >
            <Filter className="w-4 h-4" /> Filters
          </button>
          <Link to="/documents/upload" className="btn-primary flex items-center gap-2">
            <Upload className="w-4 h-4" /> Upload Document
          </Link>
        </div>
      </div>

      {/* Filters */}
      {showFilters && (
        <div className="card p-6 grid grid-cols-1 md:grid-cols-3 gap-6 mb-8">
          <div>
            <label className="label">Status</label>
            <select
              value={statusFilter}
              onChange={(e) => {
                setSearchParams((p) => { p.set("status", e.target.value); return p; });
                setPage(1);
                setSelectedIds([]);
              }}
              className="input"
            >
              <option value="">All Statuses</option>
              <option value="draft">Draft</option>
              <option value="pending_approval">Pending Approval</option>
              <option value="approved">Approved</option>
              <option value="rejected">Rejected</option>
              <option value="archived">Archived</option>
            </select>
          </div>
          <div>
            <label className="label">Document Type</label>
            <select
              value={typeId}
              onChange={(e) => {
                setSearchParams((p) => { p.set("type", e.target.value); return p; });
                setPage(1);
                setSelectedIds([]);
              }}
              className="input"
            >
              <option value="">All Types</option>
              {docTypes?.map((t) => (
                <option key={t.id} value={t.id}>{t.name}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="label">Supplier</label>
            <input
              value={supplier}
              onChange={(e) => {
                setSearchParams((p) => { p.set("supplier", e.target.value); return p; });
                setPage(1);
                setSelectedIds([]);
              }}
              className="input"
              autoComplete="off"
              placeholder="Filter by supplier..."
            />
          </div>
        </div>
      )}

      {/* Bulk Toolbar */}
      <BulkToolbar
        selectedIds={selectedIds}
        onAction={(action, comment) => bulkMutation.mutate({ action, comment })}
        onClear={() => setSelectedIds([])}
        isLoading={bulkMutation.isPending}
      />

      {/* Documents Table */}
      <div className="card overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-100 bg-gray-50">
                <th className="px-6 py-4 w-12">
                  <button
                    onClick={toggleAll}
                    className="text-gray-400 hover:text-brand-600 transition-colors"
                  >
                    {allChecked ? (
                      <CheckSquare className="w-5 h-5 text-brand-600" />
                    ) : (
                      <Square className="w-5 h-5" />
                    )}
                  </button>
                </th>
                <th className="text-left px-6 py-4 font-medium text-gray-500">Reference</th>
                <th className="text-left px-6 py-4 font-medium text-gray-500">Title</th>
                <th className="text-left px-6 py-4 font-medium text-gray-500">Type</th>
                <th className="text-left px-6 py-4 font-medium text-gray-500">Supplier</th>
                <th className="text-right px-6 py-4 font-medium text-gray-500">Amount</th>
                <th className="text-left px-6 py-4 font-medium text-gray-500">Date</th>
                <th className="text-left px-6 py-4 font-medium text-gray-500">Status</th>
                <th className="text-right px-6 py-4 font-medium text-gray-500">Size</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {isLoading && Array.from({ length: 8 }).map((_, i) => (
                <tr key={i}>
                  {Array.from({ length: 9 }).map((_, j) => (
                    <td key={j} className="px-6 py-4">
                      <div className="h-4 bg-gray-100 rounded animate-pulse" />
                    </td>
                  ))}
                </tr>
              ))}

              {!isLoading && data?.results?.map((doc: Document) => {
                const isSelected = selectedIds.includes(doc.id);
                const formatBytes = (bytes: number): string => {
                  if (bytes === 0) return "0 B";
                  const k = 1024;
                  const sizes = ["B", "KB", "MB", "GB"];
                  const i = Math.floor(Math.log(bytes) / Math.log(k));
                  return Math.round((bytes / Math.pow(k, i)) * 100) / 100 + " " + sizes[i];
                };
                return (
                  <tr
                    key={doc.id}
                    className={clsx(
                      "hover:bg-gray-50 transition-colors",
                      isSelected && "bg-brand-50"
                    )}
                  >
                    <td className="px-6 py-4">
                      <button
                        onClick={() => toggleOne(doc.id)}
                        className="text-gray-400 hover:text-brand-600 transition-colors"
                      >
                        {isSelected ? (
                          <CheckSquare className="w-5 h-5 text-brand-600" />
                        ) : (
                          <Square className="w-5 h-5" />
                        )}
                      </button>
                    </td>
                    <td className="px-6 py-4">
                      <Link
                        to={`/documents/${doc.id}`}
                        className="font-mono text-xs text-brand-600 hover:underline"
                      >
                        {doc.reference_number}
                      </Link>
                    </td>
                    <td className="px-6 py-4">
                      <Link
                        to={`/documents/${doc.id}`}
                        className="font-medium text-gray-900 hover:text-brand-700 line-clamp-1"
                      >
                        {doc.title}
                      </Link>
                    </td>
                    <td className="px-6 py-4 text-gray-600">{doc.document_type_name || "—"}</td>
                    <td className="px-6 py-4 text-gray-700">{doc.supplier || "—"}</td>
                    <td className="px-6 py-4 text-right font-medium text-gray-700">
                      {doc.amount
                        ? new Intl.NumberFormat("en-US", {
                            style: "currency",
                            currency: doc.currency || "USD",
                          }).format(doc.amount)
                        : "—"}
                    </td>
                    <td className="px-6 py-4 text-gray-600">
                      {doc.document_date
                        ? format(new Date(doc.document_date), "dd MMM yyyy")
                        : "—"}
                    </td>
                    <td className="px-6 py-4">
                      <StatusBadge status={doc.status} />
                    </td>
                    <td className="px-6 py-4 text-right text-xs text-gray-500">
                      {formatBytes(doc.file_size)}
                    </td>
                  </tr>
                );
              })}

              {!isLoading && !data?.results?.length && (
                <tr>
                  <td colSpan={9} className="px-6 py-20 text-center">
                    <FileText className="w-12 h-12 text-gray-200 mx-auto mb-4" />
                    <p className="text-gray-500">No documents found.</p>
                    <Link to="/documents/upload" className="text-brand-600 hover:underline mt-2 inline-block">
                      Upload your first document →
                    </Link>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        {/* Pagination */}
        {totalPages > 1 && (
          <div className="flex items-center justify-between px-6 py-4 border-t border-gray-100 bg-gray-50">
            <p className="text-sm text-gray-500">
              Showing page {page} of {totalPages} • {data?.count} total documents
            </p>
            <div className="flex gap-2">
              <button
                onClick={() => {
                  setPage((p) => Math.max(1, p - 1));
                  setSelectedIds([]);
                }}
                disabled={page === 1}
                className="btn-secondary px-4 py-2 disabled:opacity-50"
              >
                <ChevronLeft className="w-4 h-4" />
              </button>
              <button
                onClick={() => {
                  setPage((p) => Math.min(totalPages, p + 1));
                  setSelectedIds([]);
                }}
                disabled={page === totalPages}
                className="btn-secondary px-4 py-2 disabled:opacity-50"
              >
                <ChevronRight className="w-4 h-4" />
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}