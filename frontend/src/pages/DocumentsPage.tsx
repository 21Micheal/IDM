/**
 * pages/DocumentsPage.tsx
 *
 * Consolidated version with 3 tabs + Bulk Toolbar only on All & Workflow tabs
 */

import { useState } from "react";
import { Link } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { documentsAPI, documentTypesAPI } from "@/services/api";
import {
  FileText, UploadCloud, Lock, Users, LayoutList,
  Archive, Trash2, Loader2, CheckSquare, Square, X, CheckCircle, XCircle,
} from "lucide-react";
import { format } from "date-fns";
import { cn } from "../lib/utils";
import { useDebounce } from "../hooks/useDebounce";
import { toast } from "react-toastify";
import type { Document } from "@/types";

const PAGE_SIZE = 25;
type BulkAction = "approve" | "reject" | "archive" | "void";
type Tab = "all" | "workflow" | "personal";

const TABS: { id: Tab; label: string; icon: React.ReactNode; tip: string }[] = [
  {
    id: "all",
    label: "All Documents",
    icon: <LayoutList className="w-4 h-4" />,
    tip: "Every document you have access to",
  },
  {
    id: "workflow",
    label: "Workflow",
    icon: <Users className="w-4 h-4" />,
    tip: "Documents going through an approval process",
  },
  {
    id: "personal",
    label: "My Documents",
    icon: <Lock className="w-4 h-4" />,
    tip: "Your personal uploads — visible only to you and admins",
  },
];

const STATUS_STYLES: Record<string, string> = {
  draft:            "bg-slate-100 text-slate-600",
  pending_approval: "bg-blue-100 text-blue-700",
  approved:         "bg-green-100 text-green-700",
  rejected:         "bg-red-100 text-red-700",
  archived:         "bg-slate-100 text-slate-400",
  void:             "bg-red-50 text-red-400",
};

// ── Bulk Toolbar (shown only on All & Workflow tabs) ────────────────────────
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
      <div className="sticky top-0 z-10 bg-white border-b border-slate-200 px-6 py-4 flex items-center gap-4 shadow-sm">
        <div className="text-sm font-medium text-slate-700">
          {selectedIds.length} selected
        </div>

        <div className="flex gap-2">
          <button
            onClick={() => onAction("approve")}
            disabled={isLoading}
            className="flex items-center gap-2 px-5 py-2 text-sm font-medium bg-green-600 text-white rounded-lg hover:bg-green-700 disabled:opacity-50 transition-colors"
          >
            {isLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle className="w-4 h-4" />}
            Approve
          </button>

          <button
            onClick={() => setRejectModal(true)}
            disabled={isLoading}
            className="flex items-center gap-2 px-5 py-2 text-sm font-medium bg-red-600 text-white rounded-lg hover:bg-red-700 disabled:opacity-50 transition-colors"
          >
            <XCircle className="w-4 h-4" /> Reject
          </button>

          <button
            onClick={() => onAction("archive")}
            disabled={isLoading}
            className="flex items-center gap-2 px-5 py-2 text-sm font-medium bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 transition-colors"
          >
            <Archive className="w-4 h-4" /> Archive
          </button>

          <button
            onClick={() => {
              if (confirm(`Void ${selectedIds.length} documents? This cannot be undone.`)) {
                onAction("void");
              }
            }}
            disabled={isLoading}
            className="flex items-center gap-2 px-5 py-2 text-sm font-medium bg-gray-700 text-white rounded-lg hover:bg-gray-800 disabled:opacity-50 transition-colors"
          >
            <Trash2 className="w-4 h-4" /> Void
          </button>
        </div>

        <button 
          onClick={onClear} 
          className="ml-auto text-slate-400 hover:text-slate-600 p-2 rounded-lg hover:bg-slate-100 transition-colors"
        >
          <X className="w-5 h-5" />
        </button>
      </div>

      {/* Reject Modal */}
      {rejectModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="card w-full max-w-md p-6 space-y-5">
            <h2 className="font-semibold text-lg text-slate-900">Reject Selected Documents</h2>
            <p className="text-sm text-slate-500">
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
  const queryClient = useQueryClient();

  const [activeTab, setActiveTab] = useState<Tab>("workflow");
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [typeFilter, setTypeFilter] = useState("");
  const [sort, setSort] = useState<"created_at" | "document_date" | "amount" | "title" | "reference_number">("created_at");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const [page, setPage] = useState(1);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);

  const debouncedSearch = useDebounce(search, 300);

  const { data: typesData } = useQuery({
    queryKey: ["document-types"],
    queryFn: () => documentTypesAPI.list(),
    select: (r) => (r.data.results ?? r.data) as any[],
  });

  // Build params based on active tab
  const params: Record<string, unknown> = {
    search: debouncedSearch || undefined,
    status: statusFilter || undefined,
    document_type: typeFilter || undefined,
    ordering: `${sortDir === "desc" ? "-" : ""}${sort}`,
    page,
    page_size: PAGE_SIZE,
  };

  if (activeTab === "workflow") params.is_self_upload = false;
  if (activeTab === "personal") params.is_self_upload = true;

  const { data, isLoading } = useQuery({
    queryKey: ["documents", activeTab, params],
    queryFn: () => documentsAPI.list(params),
    select: (r) => r.data,
    placeholderData: (prev) => prev,
  });

  const docs = data?.results ?? [];

  // Quick actions for My Documents tab
  const archiveMutation = useMutation({
    mutationFn: (id: string) => documentsAPI.archive(id),
    onSuccess: () => {
      toast.success("Document archived.");
      queryClient.invalidateQueries({ queryKey: ["documents"] });
    },
    onError: () => toast.error("Could not archive document."),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => documentsAPI.delete(id),
    onSuccess: () => {
      toast.success("Document deleted.");
      queryClient.invalidateQueries({ queryKey: ["documents"] });
    },
    onError: () => toast.error("Could not delete document."),
  });

  // Bulk mutation (used only on All & Workflow tabs)
  const bulkMutation = useMutation({
    mutationFn: ({ action, comment }: { action: BulkAction; comment?: string }) =>
      documentsAPI.bulkAction(selectedIds, action, comment),
    onSuccess: () => {
      toast.success("Bulk action completed successfully");
      setSelectedIds([]);
      queryClient.invalidateQueries({ queryKey: ["documents"] });
    },
    onError: () => toast.error("Bulk action failed"),
  });

  // Tab switch — reset filters & pagination
  const switchTab = (tab: Tab) => {
    setActiveTab(tab);
    setSearch("");
    setStatusFilter("");
    setTypeFilter("");
    setPage(1);
    setSelectedIds([]);
  };

  const handleSort = (field: "created_at" | "document_date" | "amount" | "title" | "reference_number") => {
    if (sort === field) {
      setSortDir(sortDir === "asc" ? "desc" : "asc");
    } else {
      setSort(field);
      setSortDir("desc");
    }
    setPage(1);
  };

  const toggleAll = () => {
    const pageIds = docs.map((d: Document) => d.id);
    setSelectedIds((prev) => (prev.length === pageIds.length ? [] : pageIds));
  };

  const toggleOne = (id: string) => {
    setSelectedIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
    );
  };

  const allChecked = docs.length > 0 && docs.every((d: Document) => selectedIds.includes(d.id));

  // Show bulk toolbar only on All and Workflow tabs
  const showBulkToolbar = activeTab !== "personal" && selectedIds.length > 0;

  return (
    <div className="p-6 max-w-7xl mx-auto space-y-6">

      {/* Header */}
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold text-slate-900">Documents</h1>
        <Link
          to="/documents/upload"
          className="inline-flex items-center gap-2 px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-medium rounded-lg transition-colors"
        >
          <UploadCloud className="w-4 h-4" /> Upload
        </Link>
      </div>

      {/* Tabs */}
      <div className="flex items-end gap-1 border-b border-slate-200">
        {TABS.map((tab) => (
          <button
            key={tab.id}
            title={tab.tip}
            onClick={() => switchTab(tab.id)}
            className={cn(
              "inline-flex items-center gap-2 px-6 py-3 text-sm font-medium rounded-t-lg border border-transparent transition-colors -mb-px",
              activeTab === tab.id
                ? "border-slate-200 border-b-white bg-white text-indigo-600"
                : "text-slate-500 hover:text-slate-700 hover:bg-slate-50"
            )}
          >
            {tab.icon}
            {tab.label}
          </button>
        ))}
      </div>

      {/* Personal tab explainer */}
      {activeTab === "personal" && (
        <div className="flex items-start gap-3 rounded-xl border border-indigo-100 bg-indigo-50 px-4 py-3 text-sm text-indigo-800">
          <Lock className="w-4 h-4 mt-0.5 flex-shrink-0 text-indigo-500" />
          <span>
            These documents are private to you. They are not part of any approval workflow and are visible only to you and administrators.
          </span>
        </div>
      )}

      {/* Filters */}
      <div className="flex flex-wrap gap-3 items-center">
        <input
          value={search}
          onChange={(e) => { setSearch(e.target.value); setPage(1); }}
          placeholder="Search…"
          className="w-60 text-sm border border-slate-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-indigo-500"
        />

        {activeTab !== "personal" && (
          <select
            value={statusFilter}
            onChange={(e) => { setStatusFilter(e.target.value); setPage(1); }}
            className="text-sm border border-slate-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-indigo-500"
          >
            <option value="">All statuses</option>
            {Object.keys(STATUS_STYLES).map((s) => (
              <option key={s} value={s}>
                {s.replace(/_/g, " ")}
              </option>
            ))}
          </select>
        )}

        <select
          value={typeFilter}
          onChange={(e) => { setTypeFilter(e.target.value); setPage(1); }}
          className="text-sm border border-slate-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-indigo-500"
        >
          <option value="">All types</option>
          {(typesData ?? []).map((t: any) => (
            <option key={t.id} value={t.id}>{t.name}</option>
          ))}
        </select>

        {data && (
          <span className="ml-auto text-sm text-slate-500 self-center">
            {data.count.toLocaleString()} document{data.count !== 1 ? "s" : ""}
          </span>
        )}
      </div>

      {/* Bulk Toolbar - Only show on All & Workflow tabs */}
      {showBulkToolbar && (
        <BulkToolbar
          selectedIds={selectedIds}
          onAction={(action, comment) => bulkMutation.mutate({ action, comment })}
          onClear={() => setSelectedIds([])}
          isLoading={bulkMutation.isPending}
        />
      )}

      {/* Table */}
      <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-100 bg-slate-50">
                <th className="px-6 py-4 w-12">
                  <button onClick={toggleAll} className="text-slate-400 hover:text-indigo-600">
                    {allChecked ? <CheckSquare className="w-5 h-5 text-indigo-600" /> : <Square className="w-5 h-5" />}
                  </button>
                </th>
                <th className="text-left px-6 py-4 font-medium text-slate-500">Reference</th>
                <th className="text-left px-6 py-4 font-medium text-slate-500">Title</th>
                <th className="text-left px-6 py-4 font-medium text-slate-500">Type</th>
                <th className="text-left px-6 py-4 font-medium text-slate-500">Supplier</th>
                <th className="text-right px-6 py-4 font-medium text-slate-500">Amount</th>
                <th className="text-left px-6 py-4 font-medium text-slate-500">Date</th>

                {activeTab !== "personal" && (
                  <th className="text-left px-6 py-4 font-medium text-slate-500">Status</th>
                )}

                <th className="text-left px-6 py-4 font-medium text-slate-500">Uploaded</th>

                {activeTab === "personal" && (
                  <th className="text-right px-6 py-4 font-medium text-slate-500">Actions</th>
                )}
              </tr>
            </thead>

            <tbody className="divide-y divide-slate-100">
              {isLoading ? (
                Array.from({ length: 8 }).map((_, i) => (
                  <tr key={i}>
                    {Array.from({ length: activeTab === "personal" ? 8 : 9 }).map((_, j) => (
                      <td key={j} className="px-6 py-4">
                        <div className="h-4 bg-slate-100 rounded animate-pulse" />
                      </td>
                    ))}
                  </tr>
                ))
              ) : docs.length === 0 ? (
                <tr>
                  <td colSpan={activeTab === "personal" ? 8 : 9} className="text-center py-14 text-slate-400">
                    <FileText className="w-8 h-8 mx-auto mb-2 text-slate-300" />
                    <p className="font-medium text-slate-500">No documents found</p>
                    <p className="text-xs mt-1">Try adjusting your search or filters.</p>
                  </td>
                </tr>
              ) : (
                docs.map((doc: Document) => {
                  const isSelected = selectedIds.includes(doc.id);
                  const isPersonal = doc.is_self_upload === true;

                  return (
                    <tr
                      key={doc.id}
                      className={cn(
                        "hover:bg-slate-50 transition-colors group",
                        isSelected && "bg-indigo-50",
                        isPersonal && activeTab === "all" && "bg-indigo-50/40"
                      )}
                    >
                      <td className="px-6 py-4">
                        <button
                          onClick={() => toggleOne(doc.id)}
                          className="text-slate-400 hover:text-indigo-600"
                        >
                          {isSelected ? <CheckSquare className="w-5 h-5 text-indigo-600" /> : <Square className="w-5 h-5" />}
                        </button>
                      </td>

                      <td className="px-6 py-4">
                        <div className="flex items-center gap-2">
                          <Link
                            to={`/documents/${doc.id}`}
                            className="font-mono text-xs bg-slate-100 text-slate-600 px-1.5 py-0.5 rounded hover:bg-indigo-100 hover:text-indigo-700"
                          >
                            {doc.reference_number}
                          </Link>
                          {activeTab === "all" && isPersonal && (
                            <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-full text-xs font-medium bg-indigo-100 text-indigo-600">
                              <Lock className="w-2.5 h-2.5" />
                              Personal
                            </span>
                          )}
                        </div>
                      </td>

                      <td className="px-6 py-4">
                        <Link
                          to={`/documents/${doc.id}`}
                          className="text-slate-800 group-hover:text-indigo-600 font-medium truncate block"
                        >
                          {doc.title}
                        </Link>
                      </td>

                      <td className="px-6 py-4 text-slate-500 whitespace-nowrap">
                        {doc.document_type_name || "—"}
                      </td>

                      <td className="px-6 py-4 text-slate-600 max-w-[8rem] truncate">
                        {doc.supplier || "—"}
                      </td>

                      <td className="px-6 py-4 text-slate-700 whitespace-nowrap font-medium">
                        {doc.amount
                          ? `${Number(doc.amount).toLocaleString(undefined, { minimumFractionDigits: 2 })} ${doc.currency || "USD"}`
                          : "—"}
                      </td>

                      <td className="px-6 py-4 text-slate-500 whitespace-nowrap">
                        {doc.document_date ? format(new Date(doc.document_date), "dd MMM yyyy") : "—"}
                      </td>

                      {activeTab !== "personal" && (
                        <td className="px-6 py-4">
                          <span
                            className={cn(
                              "text-xs px-2 py-0.5 rounded-full font-medium whitespace-nowrap",
                              STATUS_STYLES[doc.status] ?? "bg-slate-100 text-slate-500"
                            )}
                          >
                            {doc.status.replace(/_/g, " ")}
                          </span>
                        </td>
                      )}

                      <td className="px-6 py-4 text-slate-400 whitespace-nowrap text-xs">
                        {format(new Date(doc.created_at), "dd MMM yyyy")}
                      </td>

                      {activeTab === "personal" && (
                        <td className="px-6 py-4">
                          <div className="flex items-center gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
                            {!["archived", "void"].includes(doc.status) && (
                              <button
                                title="Archive"
                                onClick={() => {
                                  if (window.confirm("Archive this personal document?")) archiveMutation.mutate(doc.id);
                                }}
                                className="p-1.5 rounded hover:bg-amber-100 text-slate-400 hover:text-amber-600 transition-colors"
                              >
                                <Archive className="w-4 h-4" />
                              </button>
                            )}
                            <button
                              title="Delete"
                              onClick={() => {
                                if (window.confirm("Delete this personal document? This cannot be undone.")) deleteMutation.mutate(doc.id);
                              }}
                              className="p-1.5 rounded hover:bg-red-100 text-slate-400 hover:text-red-500 transition-colors"
                            >
                              <Trash2 className="w-4 h-4" />
                            </button>
                          </div>
                        </td>
                      )}
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>

        {/* Pagination */}
        {data && data.count > PAGE_SIZE && (
          <div className="flex items-center justify-between px-4 py-3 border-t border-slate-100">
            <span className="text-xs text-slate-500">
              Showing {Math.min((page - 1) * PAGE_SIZE + 1, data.count)}–
              {Math.min(page * PAGE_SIZE, data.count)} of {data.count.toLocaleString()}
            </span>
            <div className="flex gap-2">
              <button
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                disabled={page === 1}
                className="px-3 py-1.5 text-xs border border-slate-200 rounded-lg hover:bg-slate-50 disabled:opacity-40 transition-colors"
              >
                Previous
              </button>
              <button
                onClick={() => setPage((p) => p + 1)}
                disabled={page * PAGE_SIZE >= data.count}
                className="px-3 py-1.5 text-xs border border-slate-200 rounded-lg hover:bg-slate-50 disabled:opacity-40 transition-colors"
              >
                Next
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}