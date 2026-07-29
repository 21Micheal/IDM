/**
 * TrashPage — Gmail-style document management with bulk actions and advanced filters.
 *
 * Features:
 * - Multi-select with "Select All" checkbox + floating bulk action toolbar
 * - Advanced filters: date range, document type, status, keyword search
 * - Filter badges with quick removal
 * - Modern enterprise UI with square corners matching admin shell
 * - Smooth interactions and visual feedback
 */
import { useMemo, useState, useCallback } from "react";
import { extractApiError } from "@/lib/apiError";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import {
  Trash2,
  RotateCcw,
  Loader2,
  Eye,
  FileText,
  Info,
  X,
  CheckSquare,
  Square,
  Search,
} from "lucide-react";
import { documentsAPI } from "@/services/api";
import { toast } from "@/components/ui/vault-toast";
import type { Document } from "@/types";
import { format, formatDistanceToNow } from "date-fns";
import StatusBadge from "@/components/documents/StatusBadge";
import { WorkspaceCommandBar } from "@/components/shared/WorkspaceCommandBar";
import CustomListbox from "@/components/ui/CustomListbox";

interface FilterState {
  search: string;
  documentType: string;
  status: string;
  dateFrom: string;
  dateTo: string;
}

export default function TrashPage() {
  const qc = useQueryClient();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [isBulkBusy, setIsBulkBusy] = useState<"restore" | "purge" | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [page, setPage] = useState(1);
  const PAGE_SIZE = 20;
  const [filters, setFilters] = useState<FilterState>({
    search: "",
    documentType: "",
    status: "",
    dateFrom: "",
    dateTo: "",
  });

  const params = { trash: true, page_size: 500 } as Record<string, unknown>;
  const { data, isLoading } = useQuery({
    queryKey: ["documents", "trash", params],
    queryFn: () => documentsAPI.list(params).then((r) => r.data),
  });

  const docs: Document[] = useMemo(() => data?.results ?? data ?? [], [data]);

  // Get unique document types and statuses for filter dropdowns
  const documentTypes = useMemo(
    () => [...new Set(docs.map((d) => d.document_type_name || d.document_type?.name).filter(Boolean))],
    [docs]
  );
  const statuses = useMemo(() => [...new Set(docs.map((d) => d.status).filter(Boolean))], [docs]);

  // Filter documents based on active filters
  const filteredDocs = useMemo(() => {
    return docs.filter((doc) => {
      if (filters.search) {
        const q = filters.search.toLowerCase();
        if (!doc.title?.toLowerCase().includes(q) && !doc.reference_number?.toLowerCase().includes(q))
          return false;
      }
      if (filters.documentType) {
        const docType = doc.document_type_name || doc.document_type?.name;
        if (docType !== filters.documentType) return false;
      }
      if (filters.status && doc.status !== filters.status) return false;
      if (filters.dateFrom && doc.deleted_at && new Date(doc.deleted_at) < new Date(filters.dateFrom)) return false;
      if (filters.dateTo && doc.deleted_at && new Date(doc.deleted_at) > new Date(filters.dateTo)) return false;
      return true;
    });
  }, [docs, filters]);

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["documents"] });
  };

  const restoreMutation = useMutation({
    mutationFn: (id: string) => documentsAPI.restore(id),
    onMutate: (id) => setBusyId(id),
    onSuccess: () => {
      toast.success("Document restored.");
      invalidate();
      setSelectedIds((prev) => {
        const next = new Set(prev);
        next.delete(busyId!);
        return next;
      });
    },
    onError: (err: any) => toast.error(extractApiError(err, "Could not restore document.")),
    onSettled: () => setBusyId(null),
  });

  const purgeMutation = useMutation({
    mutationFn: (id: string) => documentsAPI.purge(id),
    onMutate: (id) => setBusyId(id),
    onSuccess: () => {
      toast.success("Permanently deleted.");
      invalidate();
      setSelectedIds((prev) => {
        const next = new Set(prev);
        next.delete(busyId!);
        return next;
      });
    },
    onError: (err: any) => toast.error(extractApiError(err, "Could not delete document.")),
    onSettled: () => setBusyId(null),
  });

  // Bulk restore — calls /documents/bulk_action/ with action=restore
  const handleBulkRestore = useCallback(async () => {
    if (isBulkBusy || selectedIds.size === 0) return;
    setIsBulkBusy("restore");
    try {
      await documentsAPI.bulkAction(Array.from(selectedIds), "restore");
      toast.success(`${selectedIds.size} document${selectedIds.size !== 1 ? "s" : ""} restored.`);
      setSelectedIds(new Set());
      invalidate();
    } catch (err: any) {
      toast.error(extractApiError(err, "Bulk restore failed. Some documents may not have been restored."));
    } finally {
      setIsBulkBusy(null);
    }
  }, [selectedIds, isBulkBusy]);

  // Bulk permanent delete — calls /documents/bulk_action/ with action=purge
  const handleBulkDelete = useCallback(async () => {
    if (isBulkBusy || selectedIds.size === 0) return;
    if (!window.confirm(`Permanently delete ${selectedIds.size} item${selectedIds.size !== 1 ? "s" : ""}? This cannot be undone.`)) return;
    setIsBulkBusy("purge");
    try {
      await documentsAPI.bulkAction(Array.from(selectedIds), "purge");
      toast.success(`${selectedIds.size} document${selectedIds.size !== 1 ? "s" : ""} permanently deleted.`);
      setSelectedIds(new Set());
      invalidate();
    } catch (err: any) {
      toast.error(extractApiError(err, "Bulk delete failed. Some documents may not have been removed."));
    } finally {
      setIsBulkBusy(null);
    }
  }, [selectedIds, isBulkBusy]);

  // Toggle selection
  const toggleSelection = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }, []);

  // Select/deselect all
  const toggleSelectAll = useCallback(() => {
    if (selectedIds.size === filteredDocs.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(filteredDocs.map((d) => d.id)));
    }
  }, [filteredDocs, selectedIds.size]);

  // Clear filters
  const clearFilters = useCallback(() => {
    setFilters({ search: "", documentType: "", status: "", dateFrom: "", dateTo: "" });
  }, []);

  const hasActiveFilters =
    filters.search || filters.documentType || filters.status || filters.dateFrom || filters.dateTo;

  // Reset to page 1 whenever filters change
  const setFiltersAndReset = (f: FilterState) => { setFilters(f); setPage(1); };

  const totalPages = Math.ceil(filteredDocs.length / PAGE_SIZE);
  const pagedDocs = filteredDocs.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  return (
    <div className="flex h-full flex-col bg-[#F8FAFC] text-[14px] text-[#0F172A]">
      {/* ── Page header bar ─────────────────────────────────────────────────── */}
      <WorkspaceCommandBar
        actions={
          !isLoading && filteredDocs.length > 0 ? (
            <div className="border border-[#D5DCE3] bg-white px-3 py-2 text-sm font-semibold text-[#0F172A]">
              {filteredDocs.length} item{filteredDocs.length !== 1 ? "s" : ""}
            </div>
          ) : null
        }
      >
        <div className="flex h-10 w-10 items-center justify-center border border-white/25 bg-white/10">
          <Trash2 className="h-5 w-5 text-white" />
        </div>
        <div>
          <h1 className="text-xl font-semibold">Trash</h1>
          <p className="mt-0.5 text-sm text-white/75">
            Manage deleted documents — restore or permanently remove them.
          </p>
        </div>
      </WorkspaceCommandBar>

      {/* ── Body ────────────────────────────────────────────────────────────── */}
      <div className="scrollbar-minimal min-h-0 flex-1 overflow-y-auto p-5 pr-0">
        <div className="mx-auto max-w-7xl space-y-4">
          {/* Retention notice */}
          <div className="flex items-start gap-2 border border-[#FCD34D] bg-[#FFFBEB] px-4 py-3 text-xs text-[#92400E]">
            <Info className="mt-0.5 h-4 w-4 flex-shrink-0" />
            <span>
              Items in Trash are emptied automatically after the retention period set in{" "}
              <strong>Admin → DMS settings</strong>. Restore anything you want to keep.
            </span>
          </div>

          {/* Filters + Search — single inline row */}
          {!isLoading && docs.length > 0 && (
            <div className="border border-[#E2E8F0] bg-white px-4 py-3 space-y-2">
              <div className="flex flex-wrap items-center gap-2">
                {/* Search */}
                <div className="relative flex-1 min-w-[180px]">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-[#94A3B8] pointer-events-none" />
                  <input
                    type="text"
                    placeholder="Search by title or ref…"
                    value={filters.search}
                    onChange={(e) => setFiltersAndReset({ ...filters, search: e.target.value })}
                    className="w-full pl-8 pr-3 h-8 border border-[#D5DCE3] bg-white text-[#0F172A] placeholder-[#94A3B8] text-xs focus:outline-none focus:border-[#0D7BA8] transition-colors"
                  />
                </div>

                {/* Document Type */}
                <CustomListbox
                  value={filters.documentType}
                  onChange={(v) => setFiltersAndReset({ ...filters, documentType: v })}
                  options={[
                    { value: "", label: "All document types" },
                    ...documentTypes.map((t) => ({ value: t, label: t })),
                  ]}
                  buttonClassName="h-8 border border-[#D5DCE3] bg-white px-2 text-xs text-[#0F172A] min-w-[150px]"
                  ariaLabel="Filter by document type"
                />

                {/* Status */}
                <CustomListbox
                  value={filters.status}
                  onChange={(v) => setFiltersAndReset({ ...filters, status: v })}
                  options={[
                    { value: "", label: "All statuses" },
                    ...statuses.map((s) => ({ value: s, label: s })),
                  ]}
                  buttonClassName="h-8 border border-[#D5DCE3] bg-white px-2 text-xs text-[#0F172A] min-w-[130px]"
                  ariaLabel="Filter by status"
                />

                {/* Date From */}
                <div className="flex items-center gap-1.5">
                  <span className="text-[10px] font-semibold uppercase tracking-wider text-[#64748B] whitespace-nowrap">From</span>
                  <input
                    type="date"
                    value={filters.dateFrom}
                    onChange={(e) => setFiltersAndReset({ ...filters, dateFrom: e.target.value })}
                    className="h-8 border border-[#D5DCE3] bg-white px-2 text-xs text-[#0F172A] focus:outline-none focus:border-[#0D7BA8]"
                  />
                </div>

                {/* Date To */}
                <div className="flex items-center gap-1.5">
                  <span className="text-[10px] font-semibold uppercase tracking-wider text-[#64748B] whitespace-nowrap">To</span>
                  <input
                    type="date"
                    value={filters.dateTo}
                    onChange={(e) => setFiltersAndReset({ ...filters, dateTo: e.target.value })}
                    className="h-8 border border-[#D5DCE3] bg-white px-2 text-xs text-[#0F172A] focus:outline-none focus:border-[#0D7BA8]"
                  />
                </div>

                {/* Clear all */}
                {hasActiveFilters && (
                  <button
                    type="button"
                    onClick={clearFilters}
                    className="flex items-center gap-1 h-8 px-2 text-xs text-[#0D7BA8] hover:text-[#0A5F7F] font-medium border border-[#0D7BA8]/30 hover:bg-[#EBF8FD] transition-colors"
                  >
                    <X className="h-3 w-3" /> Clear
                  </button>
                )}
              </div>

              {/* Active filter badges */}
              {hasActiveFilters && (
                <div className="flex flex-wrap gap-1.5 items-center pt-1 border-t border-[#F1F5F9]">
                  {filters.search && (
                    <span className="inline-flex items-center gap-1 bg-[#EBF8FD] border border-[#BCC5CF] px-2 py-0.5 text-[11px]">
                      <span className="text-[#0F172A]">Search: <strong>{filters.search}</strong></span>
                      <button type="button" onClick={() => setFiltersAndReset({ ...filters, search: "" })} className="ml-0.5 text-[#64748B] hover:text-[#0F172A]"><X className="h-2.5 w-2.5" /></button>
                    </span>
                  )}
                  {filters.documentType && (
                    <span className="inline-flex items-center gap-1 bg-[#EBF8FD] border border-[#BCC5CF] px-2 py-0.5 text-[11px]">
                      <span className="text-[#0F172A]">Type: <strong>{filters.documentType}</strong></span>
                      <button type="button" onClick={() => setFiltersAndReset({ ...filters, documentType: "" })} className="ml-0.5 text-[#64748B] hover:text-[#0F172A]"><X className="h-2.5 w-2.5" /></button>
                    </span>
                  )}
                  {filters.status && (
                    <span className="inline-flex items-center gap-1 bg-[#EBF8FD] border border-[#BCC5CF] px-2 py-0.5 text-[11px]">
                      <span className="text-[#0F172A]">Status: <strong>{filters.status}</strong></span>
                      <button type="button" onClick={() => setFiltersAndReset({ ...filters, status: "" })} className="ml-0.5 text-[#64748B] hover:text-[#0F172A]"><X className="h-2.5 w-2.5" /></button>
                    </span>
                  )}
                  {filters.dateFrom && (
                    <span className="inline-flex items-center gap-1 bg-[#EBF8FD] border border-[#BCC5CF] px-2 py-0.5 text-[11px]">
                      <span className="text-[#0F172A]">From: <strong>{filters.dateFrom}</strong></span>
                      <button type="button" onClick={() => setFiltersAndReset({ ...filters, dateFrom: "" })} className="ml-0.5 text-[#64748B] hover:text-[#0F172A]"><X className="h-2.5 w-2.5" /></button>
                    </span>
                  )}
                  {filters.dateTo && (
                    <span className="inline-flex items-center gap-1 bg-[#EBF8FD] border border-[#BCC5CF] px-2 py-0.5 text-[11px]">
                      <span className="text-[#0F172A]">To: <strong>{filters.dateTo}</strong></span>
                      <button type="button" onClick={() => setFiltersAndReset({ ...filters, dateTo: "" })} className="ml-0.5 text-[#64748B] hover:text-[#0F172A]"><X className="h-2.5 w-2.5" /></button>
                    </span>
                  )}
                </div>
              )}
            </div>
          )}

          {/* Content area */}
          {isLoading ? (
            <div className="flex h-64 items-center justify-center border border-[#E2E8F0] bg-white">
              <Loader2 className="h-6 w-6 animate-spin text-[#0D7BA8]" />
            </div>
          ) : filteredDocs.length === 0 ? (
            <div className="border border-[#E2E8F0] bg-white p-16 text-center">
              <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center border border-[#E2E8F0] bg-[#F8FAFC]">
                <Trash2 className="h-8 w-8 text-[#94A3B8]" />
              </div>
              <p className="font-semibold text-[#0F172A]">
                {docs.length === 0 ? "Trash is empty" : "No documents match your filters"}
              </p>
              <p className="mt-1 text-sm text-[#64748B]">
                {docs.length === 0
                  ? "Documents you delete will appear here."
                  : "Try adjusting your filter criteria."}
              </p>
              {hasActiveFilters && (
                <button
                  type="button"
                  onClick={clearFilters}
                  className="mt-3 text-sm text-[#0D7BA8] hover:text-[#0A5F7F] font-medium"
                >
                  Clear filters
                </button>
              )}
            </div>
          ) : (
            <>
              <div className="overflow-hidden border border-[#E2E8F0] bg-white">
                <div className="overflow-x-auto">
                <table className="w-full text-left text-sm">
                  <thead>
                    <tr className="border-b border-[#E2E8F0] bg-[#F8FAFC] text-[11px] font-bold uppercase tracking-wider text-[#0F172A]">
                      {/* Checkbox header */}
                      <th className="w-12 px-4 py-3">
                        <button
                          type="button"
                          onClick={toggleSelectAll}
                          className="flex items-center justify-center"
                          title={selectedIds.size === filteredDocs.length ? "Deselect all" : "Select all"}
                        >
                          {selectedIds.size === filteredDocs.length ? (
                            <CheckSquare className="h-4 w-4 text-[#0D7BA8]" />
                          ) : (
                            <Square className="h-4 w-4 text-[#94A3B8]" />
                          )}
                        </button>
                      </th>
                      <th className="px-4 py-3">Document</th>
                      <th className="px-4 py-3">Type</th>
                      <th className="px-4 py-3">Status</th>
                      <th className="px-4 py-3 whitespace-nowrap">Deleted</th>
                      <th className="px-4 py-3 text-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[#F1F5F9]">
                    {pagedDocs.map((doc) => {
                      const busy = busyId === doc.id;
                      const isSelected = selectedIds.has(doc.id);
                      return (
                        <tr
                          key={doc.id}
                          className={`transition-colors ${isSelected ? "bg-[#EBF8FD]" : "hover:bg-[#F8FAFC]"
                            }`}
                        >
                          {/* Checkbox */}
                          <td className="w-12 px-4 py-3">
                            <button
                              type="button"
                              onClick={() => toggleSelection(doc.id)}
                              className="flex items-center justify-center"
                            >
                              {isSelected ? (
                                <CheckSquare className="h-4 w-4 text-[#0D7BA8]" />
                              ) : (
                                <Square className="h-4 w-4 text-[#D5DCE3]" />
                              )}
                            </button>
                          </td>

                          {/* Document title + ref */}
                          <td className="px-4 py-3">
                            <div className="flex items-center gap-2 min-w-0">
                              <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center border border-[#D5DCE3] bg-[#EBF8FD]">
                                <FileText className="h-4 w-4 text-[#0D7BA8]" />
                              </div>
                              <div className="min-w-0">
                                <p className="truncate font-semibold text-[#0F172A]">{doc.title}</p>
                                {doc.reference_number && (
                                  <p className="truncate font-mono text-xs text-[#64748B]">
                                    {doc.reference_number}
                                  </p>
                                )}
                              </div>
                            </div>
                          </td>

                          {/* Document type */}
                          <td className="px-4 py-3 text-[#0F172A]">
                            {doc.document_type_name || doc.document_type?.name || (
                              <span className="text-[#94A3B8]">—</span>
                            )}
                          </td>

                          {/* Status badge */}
                          <td className="px-4 py-3">
                            <StatusBadge status={doc.status} />
                          </td>

                          {/* Deleted timestamp + who */}
                          <td
                            className="px-4 py-3 whitespace-nowrap text-xs text-[#64748B]"
                            title={
                              doc.deleted_at ? format(new Date(doc.deleted_at), "dd MMM yyyy HH:mm") : undefined
                            }
                          >
                            {doc.deleted_at
                              ? `${formatDistanceToNow(new Date(doc.deleted_at))} ago`
                              : <span className="text-[#94A3B8]">—</span>}
                            {doc.deleted_by_name && (
                              <span className="block text-[11px] text-[#94A3B8]">by {doc.deleted_by_name}</span>
                            )}
                          </td>

                          {/* Actions — compact icon buttons */}
                          <td className="px-4 py-3">
                            <div className="flex items-center justify-end gap-1">
                              <Link
                                to={`/documents/${doc.id}`}
                                title="View"
                                aria-label="View"
                                className="flex h-8 w-8 items-center justify-center border border-[#D5DCE3] bg-white text-[#0D7BA8] transition-colors hover:bg-[#EBF8FD]"
                              >
                                <Eye className="h-3.5 w-3.5" />
                              </Link>

                              <button
                                type="button"
                                title="Restore"
                                aria-label="Restore"
                                disabled={busy}
                                onClick={() => restoreMutation.mutate(doc.id)}
                                className="flex h-8 w-8 items-center justify-center border border-[#D5DCE3] bg-white text-[#0F172A] transition-colors hover:bg-[#EBF8FD] disabled:opacity-50"
                              >
                                {busy && restoreMutation.isPending ? (
                                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                ) : (
                                  <RotateCcw className="h-3.5 w-3.5" />
                                )}
                              </button>

                              <button
                                type="button"
                                title="Delete permanently"
                                aria-label="Delete permanently"
                                disabled={busy}
                                onClick={() => {
                                  if (
                                    window.confirm(
                                      `Permanently delete "${doc.title}"? This cannot be undone.`
                                    )
                                  )
                                    purgeMutation.mutate(doc.id);
                                }}
                                className="flex h-8 w-8 items-center justify-center border border-[#EF4444] bg-[#FEF2F2] text-[#DC2626] transition-colors hover:bg-[#FEE2E2] disabled:opacity-50"
                              >
                                {busy && purgeMutation.isPending ? (
                                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                ) : (
                                  <Trash2 className="h-3.5 w-3.5" />
                                )}
                              </button>
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                </div>
              </div>

            {/* Pagination */}
            {totalPages > 1 && (
              <div className="flex items-center justify-between border border-[#E2E8F0] bg-white px-4 py-2.5">
                <span className="text-xs text-[#64748B]">
                  Showing {(page - 1) * PAGE_SIZE + 1}–{Math.min(page * PAGE_SIZE, filteredDocs.length)} of {filteredDocs.length}
                </span>
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    onClick={() => setPage((p) => Math.max(1, p - 1))}
                    disabled={page === 1}
                    className="h-7 px-2.5 text-xs border border-[#D5DCE3] bg-white text-[#0F172A] hover:bg-[#F8FAFC] disabled:opacity-40 transition-colors"
                  >
                    ← Prev
                  </button>
                  {Array.from({ length: totalPages }, (_, i) => i + 1)
                    .filter((p) => p === 1 || p === totalPages || Math.abs(p - page) <= 1)
                    .reduce<(number | "...")[]>((acc, p, i, arr) => {
                      if (i > 0 && (p as number) - (arr[i - 1] as number) > 1) acc.push("...");
                      acc.push(p);
                      return acc;
                    }, [])
                    .map((p, i) =>
                      p === "..." ? (
                        <span key={`el-${i}`} className="px-1 text-xs text-[#94A3B8]">…</span>
                      ) : (
                        <button
                          key={p}
                          type="button"
                          onClick={() => setPage(p as number)}
                          className={`h-7 w-7 text-xs border transition-colors ${
                            page === p
                              ? "border-[#0D7BA8] bg-[#0D7BA8] text-white"
                              : "border-[#D5DCE3] bg-white text-[#0F172A] hover:bg-[#F8FAFC]"
                          }`}
                        >
                          {p}
                        </button>
                      )
                    )}
                  <button
                    type="button"
                    onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                    disabled={page === totalPages}
                    className="h-7 px-2.5 text-xs border border-[#D5DCE3] bg-white text-[#0F172A] hover:bg-[#F8FAFC] disabled:opacity-40 transition-colors"
                  >
                    Next →
                  </button>
                </div>
              </div>
            )}
            </>
          )}
        </div>
      </div>

      {/* ── Floating Bulk Action Toolbar (Gmail-style) ─────────────────────── */}
      {selectedIds.size > 0 && (
        <div className="border-t border-[#E2E8F0] bg-white shadow-lg px-6 py-4 flex items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <CheckSquare className="h-5 w-5 text-[#0D7BA8]" />
            <span className="font-semibold text-[#0F172A]">
              {selectedIds.size} item{selectedIds.size !== 1 ? "s" : ""} selected
            </span>
            <button
              type="button"
              onClick={() => setSelectedIds(new Set())}
              className="text-sm text-[#64748B] hover:text-[#0F172A] ml-2"
            >
              Clear
            </button>
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={handleBulkRestore}
              disabled={selectedIds.size === 0 || isBulkBusy !== null}
              className="flex items-center gap-1.5 px-3 py-2 border border-[#D5DCE3] bg-white text-[#0F172A] hover:bg-[#F8FAFC] transition-colors disabled:opacity-50 font-medium text-sm"
            >
              {isBulkBusy === "restore"
                ? <Loader2 className="h-4 w-4 animate-spin" />
                : <RotateCcw className="h-4 w-4" />}
              Restore Selected
            </button>
            <button
              type="button"
              onClick={handleBulkDelete}
              disabled={selectedIds.size === 0 || isBulkBusy !== null}
              className="flex items-center gap-1.5 px-3 py-2 border border-[#EF4444] bg-[#FEF2F2] text-[#DC2626] hover:bg-[#FEE2E2] transition-colors disabled:opacity-50 font-medium text-sm"
            >
              {isBulkBusy === "purge"
                ? <Loader2 className="h-4 w-4 animate-spin" />
                : <Trash2 className="h-4 w-4" />}
              Delete Permanently
            </button>
          </div>
        </div>
      )}
    </div>
  );
}