import { useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { documentsAPI, documentTypesAPI } from "@/services/api";
import StatusBadge from "@/components/documents/StatusBadge";
import { FileText, Upload, Filter, ChevronLeft, ChevronRight } from "lucide-react";
import { format } from "date-fns";
import type { Document, DocumentType } from "@/types";

const PAGE_SIZE = 20;

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export default function DocumentsPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [page, setPage] = useState(1);
  const [showFilters, setShowFilters] = useState(false);

  const status = searchParams.get("status") || "";
  const typeId = searchParams.get("type") || "";
  const supplier = searchParams.get("supplier") || "";

  const { data: docTypes } = useQuery({
    queryKey: ["document-types"],
    queryFn: () => documentTypesAPI.list().then((r) => r.data.results as DocumentType[]),
  });

  const { data, isLoading } = useQuery({
    queryKey: ["documents", { page, status, typeId, supplier }],
    queryFn: () =>
      documentsAPI
        .list({
          page,
          page_size: PAGE_SIZE,
          ...(status && { status }),
          ...(typeId && { document_type: typeId }),
          ...(supplier && { supplier }),
        })
        .then((r) => r.data),
  });

  const totalPages = Math.ceil((data?.count ?? 0) / PAGE_SIZE);

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Documents</h1>
          <p className="text-gray-500 text-sm mt-0.5">{data?.count ?? 0} total records</p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => setShowFilters(!showFilters)}
            className="btn-secondary"
          >
            <Filter className="w-4 h-4" />
            Filters
          </button>
          <Link to="/documents/upload" className="btn-primary">
            <Upload className="w-4 h-4" />
            Upload
          </Link>
        </div>
      </div>

      {/* Filter bar */}
      {showFilters && (
        <div className="card p-4 grid grid-cols-1 sm:grid-cols-3 gap-3">
          <div>
            <label className="label">Status</label>
            <select
              value={status}
              onChange={(e) => { setSearchParams(p => { p.set("status", e.target.value); return p; }); setPage(1); }}
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
              onChange={(e) => { setSearchParams(p => { p.set("type", e.target.value); return p; }); setPage(1); }}
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
              onChange={(e) => { setSearchParams(p => { p.set("supplier", e.target.value); return p; }); setPage(1); }}
              className="input"
              placeholder="Search supplier…"
            />
          </div>
        </div>
      )}

      {/* Table */}
      <div className="card overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-100 bg-gray-50">
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
              {isLoading &&
                Array.from({ length: 6 }).map((_, i) => (
                  <tr key={i}>
                    {Array.from({ length: 8 }).map((_, j) => (
                      <td key={j} className="px-4 py-3">
                        <div className="h-4 bg-gray-100 rounded animate-pulse" />
                      </td>
                    ))}
                  </tr>
                ))}
              {!isLoading && data?.results?.map((doc: Document) => (
                <tr key={doc.id} className="hover:bg-gray-50 transition-colors">
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
                      className="text-gray-900 font-medium hover:text-brand-600 truncate max-w-[200px] block"
                    >
                      {doc.title}
                    </Link>
                  </td>
                  <td className="px-4 py-3 text-gray-500">{doc.document_type_name}</td>
                  <td className="px-4 py-3 text-gray-700">{doc.supplier || "—"}</td>
                  <td className="px-4 py-3 text-right text-gray-700">
                    {doc.amount
                      ? new Intl.NumberFormat("en-US", {
                          style: "currency",
                          currency: doc.currency,
                        }).format(doc.amount)
                      : "—"}
                  </td>
                  <td className="px-4 py-3 text-gray-500">
                    {doc.document_date ? format(new Date(doc.document_date), "dd MMM yyyy") : "—"}
                  </td>
                  <td className="px-4 py-3">
                    <StatusBadge status={doc.status} />
                  </td>
                  <td className="px-4 py-3 text-right text-gray-400 text-xs">
                    {formatBytes(doc.file_size)}
                  </td>
                </tr>
              ))}
              {!isLoading && !data?.results?.length && (
                <tr>
                  <td colSpan={8} className="px-4 py-12 text-center text-gray-400">
                    <FileText className="w-8 h-8 mx-auto mb-2 opacity-30" />
                    No documents found. Adjust your filters or{" "}
                    <Link to="/documents/upload" className="text-brand-600 hover:underline">
                      upload one
                    </Link>.
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
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                disabled={page === 1}
                className="btn-secondary px-2 py-1"
              >
                <ChevronLeft className="w-4 h-4" />
              </button>
              <button
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
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
