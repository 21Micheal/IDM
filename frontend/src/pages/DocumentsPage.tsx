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

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

// ── Bulk action toolbar ───────────────────────────────────────────────────────
function BulkToolbar({
  selectedIds,
  onAction,
  onClear,
  isLoading,
}: {
  selectedIds: string[];
  onAction: (action: string, comment?: string) => void;
  onClear: () => void;
  isLoading: boolean;
}) {
  const [rejectModal, setRejectModal] = useState(false);
  const [comment, setComment]         = useState("");

  if (selectedIds.length === 0) return null;

  return (
    <>
      <div className="flex items-center gap-3 px-4 py-3 bg-brand-50 border border-brand-200 rounded-xl">
        <span className="text-sm font-medium text-brand-700">
          {selectedIds.length} selected
        </span>
        <div className="flex gap-2 ml-2">
          <button
            onClick={() => onAction("approve")}
            disabled={isLoading}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-green-600 text-white rounded-lg hover:bg-green-700 disabled:opacity-50 transition-colors"
          >
            {isLoading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <CheckCircle className="w-3.5 h-3.5" />}
            Approve all
          </button>
          <button
            onClick={() => setRejectModal(true)}
            disabled={isLoading}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-red-600 text-white rounded-lg hover:bg-red-700 disabled:opacity-50 transition-colors"
          >
            <XCircle className="w-3.5 h-3.5" /> Reject all
          </button>
          <button
            onClick={() => onAction("archive")}
            disabled={isLoading}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 transition-colors"
          >
            <Archive className="w-3.5 h-3.5" /> Archive all
          </button>
          <button
            onClick={() => {
              if (confirm(`Void ${selectedIds.length} documents? This cannot be undone.`)) {
                onAction("void");
              }
            }}
            disabled={isLoading}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-gray-600 text-white rounded-lg hover:bg-gray-700 disabled:opacity-50 transition-colors"
          >
            <Trash2 className="w-3.5 h-3.5" /> Void all
          </button>
        </div>
        <button onClick={onClear} className="ml-auto text-brand-400 hover:text-brand-600">
          <X className="w-4 h-4" />
        </button>
      </div>

      {/* Reject comment modal */}
      {rejectModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="card w-full max-w-md p-6 space-y-4">
            <h2 className="font-semibold text-gray-900">Reject {selectedIds.length} documents</h2>
            <p className="text-sm text-gray-500">
              A rejection comment is required and will be applied to all selected documents.
            </p>
            <div>
              <label className="label">Rejection reason <span className="text-red-500">*</span></label>
              <textarea
                value={comment}
                onChange={(e) => setComment(e.target.value)}
                rows={3}
                className="input"
                placeholder="Reason for rejection…"
                autoFocus
              />
            </div>
            <div className="flex gap-3 justify-end">
              <button onClick={() => setRejectModal(false)} className="btn-secondary">Cancel</button>
              <button
                onClick={() => {
                  if (!comment.trim()) { toast.error("Comment required"); return; }
                  onAction("reject", comment.trim());
                  setRejectModal(false);
                  setComment("");
                }}
                disabled={isLoading}
                className="btn-danger"
              >
                {isLoading && <Loader2 className="w-4 h-4 animate-spin" />}
                Reject all
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────
export default function DocumentsPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [page, setPage]         = useState(1);
  const [showFilters, setFilters] = useState(false);
  const [selectedIds, setSelected] = useState<string[]>([]);
  const qc = useQueryClient();

  const statusFilter = searchParams.get("status") || "";
  const typeId       = searchParams.get("type")   || "";
  const supplier     = searchParams.get("supplier") || "";

  const { data: docTypes } = useQuery<DocumentType[]>({
    queryKey: ["document-types"],
    queryFn:  () => documentTypesAPI.list().then((r) => r.data.results ?? r.data),
  });

  const { data, isLoading } = useQuery({
    queryKey: ["documents", { page, statusFilter, typeId, supplier }],
    queryFn:  () =>
      documentsAPI.list({
        page,
        page_size: PAGE_SIZE,
        ...(statusFilter && { status: statusFilter }),
        ...(typeId      && { document_type: typeId }),
        ...(supplier    && { supplier }),
      }).then((r) => r.data),
  });

  const totalPages = Math.ceil((data?.count ?? 0) / PAGE_SIZE);
  const pageIds    = (data?.results ?? []).map((d: Document) => d.id);
  const allChecked = pageIds.length > 0 && pageIds.every((id: string) => selectedIds.includes(id));

  const toggleAll = () => {
    setSelected(allChecked ? [] : pageIds);
  };
  const toggleOne = (id: string) => {
    setSelected((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
    );
  };

  const bulkMutation = useMutation({
    mutationFn: ({ action, comment }: { action: string; comment?: string }) =>
      documentsAPI.bulkAction(selectedIds, action, comment),
    onSuccess: ({ data: result }) => {
      toast.success(`${result.succeeded} succeeded, ${result.failed} failed`);
      if (result.failed > 0) {
        const failures = result.results
          .filter((r: { success: boolean; detail?: string }) => !r.success)
          .map((r: { detail?: string }) => r.detail)
          .join("; ");
        toast.warn(`Failures: ${failures}`);
      }
      setSelected([]);
      qc.invalidateQueries({ queryKey: ["documents"] });
    },
    onError: () => toast.error("Bulk action failed"),
  });

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Documents</h1>
          <p className="text-gray-500 text-sm mt-0.5">{data?.count ?? 0} total records</p>
        </div>
        <div className="flex gap-2">
          <button onClick={() => setFilters(!showFilters)} className="btn-secondary">
            <Filter className="w-4 h-4" /> Filters
          </button>
          <Link to="/documents/upload" className="btn-primary">
            <Upload className="w-4 h-4" /> Upload
          </Link>
        </div>
      </div>

      {/* Filter bar */}
      {showFilters && (
        <div className="card p-4 grid grid-cols-1 sm:grid-cols-3 gap-3">
          <div>
            <label className="label">Status</label>
            <select
              value={statusFilter}
              onChange={(e) => { setSearchParams((p) => { p.set("status", e.target.value); return p; }); setPage(1); }}
              className="input"
            >
              <option value="">All statuses</option>
              <option value="draft">Draft</option>
              <option value="pending_approval">Pending Approval</option>
              <option value="approved">Approved</option>
              <option value="rejected">Rejected</option>
              <option value="archived">Archived</option>
            </select>
          </div>
          <div>
            <label className="label">Document type</label>
            <select
              value={typeId}
              onChange={(e) => { setSearchParams((p) => { p.set("type", e.target.value); return p; }); setPage(1); }}
              className="input"
            >
              <option value="">All types</option>
              {docTypes?.map((t) => (
                <option key={t.id} value={t.id}>{t.name}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="label">Supplier</label>
            <input
              value={supplier}
              onChange={(e) => { setSearchParams((p) => { p.set("supplier", e.target.value); return p; }); setPage(1); }}
              className="input"
              placeholder="Filter by supplier…"
            />
          </div>
        </div>
      )}

      {/* Bulk toolbar */}
      <BulkToolbar
        selectedIds={selectedIds}
        onAction={(action, comment) => bulkMutation.mutate({ action, comment })}
        onClear={() => setSelected([])}
        isLoading={bulkMutation.isPending}
      />

      {/* Table */}
      <div className="card overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-100 bg-gray-50">
                {/* Select-all checkbox */}
                <th className="px-4 py-3 w-10">
                  <button onClick={toggleAll} className="text-gray-400 hover:text-brand-600">
                    {allChecked
                      ? <CheckSquare className="w-4 h-4 text-brand-600" />
                      : <Square className="w-4 h-4" />}
                  </button>
                </th>
                <th className="text-left px-4 py-3 font-medium text-gray-500">Reference</th>
                <th className="text-left px-4 py-3 font-medium text-gray-500">Title</th>
                <th className="text-left px-4 py-3 font-medium text-gray-500">Type</th>
                <th className="text-left px-4 py-3 font-medium text-gray-500">Supplier</th>
                <th className="text-right px-4 py-3 font-medium text-gray-500">Amount</th>
                <th className="text-left px-4 py-3 font-medium text-gray-500">Date</th>
                <th className="text-left px-4 py-3 font-medium text-gray-500">Status</th>
                <th className="text-right px-4 py-3 font-medium text-gray-500">Size</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {isLoading && Array.from({ length: 6 }).map((_, i) => (
                <tr key={i}>
                  {Array.from({ length: 9 }).map((_, j) => (
                    <td key={j} className="px-4 py-3">
                      <div className="h-4 bg-gray-100 rounded animate-pulse" />
                    </td>
                  ))}
                </tr>
              ))}

              {!isLoading && data?.results?.map((doc: Document) => {
                const isSelected = selectedIds.includes(doc.id);
                return (
                  <tr
                    key={doc.id}
                    className={clsx(
                      "hover:bg-gray-50 transition-colors",
                      isSelected && "bg-brand-50"
                    )}
                  >
                    <td className="px-4 py-3">
                      <button
                        onClick={() => toggleOne(doc.id)}
                        className="text-gray-400 hover:text-brand-600"
                      >
                        {isSelected
                          ? <CheckSquare className="w-4 h-4 text-brand-600" />
                          : <Square className="w-4 h-4" />}
                      </button>
                    </td>
                    <td className="px-4 py-3">
                      <Link
                        to={`/documents/${doc.id}`}
                        className="font-mono text-xs text-brand-600 hover:underline"
                      >
                        {doc.reference_number}
                      </Link>
                    </td>
                    <td className="px-4 py-3">
                      <Link
                        to={`/documents/${doc.id}`}
                        className="font-medium text-gray-900 hover:text-brand-600 truncate max-w-[200px] block"
                      >
                        {doc.title}
                      </Link>
                    </td>
                    <td className="px-4 py-3 text-gray-500">{doc.document_type_name}</td>
                    <td className="px-4 py-3 text-gray-700">{doc.supplier || "—"}</td>
                    <td className="px-4 py-3 text-right text-gray-700">
                      {doc.amount
                        ? new Intl.NumberFormat("en-US", {
                            style: "currency", currency: doc.currency,
                          }).format(doc.amount)
                        : "—"}
                    </td>
                    <td className="px-4 py-3 text-gray-500">
                      {doc.document_date
                        ? format(new Date(doc.document_date), "dd MMM yyyy")
                        : "—"}
                    </td>
                    <td className="px-4 py-3">
                      <StatusBadge status={doc.status} />
                    </td>
                    <td className="px-4 py-3 text-right text-gray-400 text-xs">
                      {formatBytes(doc.file_size)}
                    </td>
                  </tr>
                );
              })}

              {!isLoading && !data?.results?.length && (
                <tr>
                  <td colSpan={9} className="px-4 py-12 text-center text-gray-400">
                    <FileText className="w-8 h-8 mx-auto mb-2 opacity-30" />
                    No documents found.{" "}
                    <Link to="/documents/upload" className="text-brand-600 hover:underline">
                      Upload one.
                    </Link>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        {/* Pagination */}
        {totalPages > 1 && (
          <div className="flex items-center justify-between px-4 py-3 border-t border-gray-100">
            <p className="text-sm text-gray-500">
              Page {page} of {totalPages} · {data?.count} results
            </p>
            <div className="flex gap-1">
              <button
                onClick={() => { setPage((p) => Math.max(1, p - 1)); setSelected([]); }}
                disabled={page === 1}
                className="btn-secondary px-2 py-1"
              >
                <ChevronLeft className="w-4 h-4" />
              </button>
              <button
                onClick={() => { setPage((p) => Math.min(totalPages, p + 1)); setSelected([]); }}
                disabled={page === totalPages}
                className="btn-secondary px-2 py-1"
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
