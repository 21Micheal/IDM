/**
 * TrashPage — documents the user has soft-deleted ("Trash").
 *
 * Drafts/returned/rejected documents deleted from the Documents list land here.
 * Users can Restore them or Delete permanently. Trash is also emptied
 * automatically after the retention period configured in Admin → DMS settings.
 */
import { useMemo, useState } from "react";
import { extractApiError } from "@/lib/apiError";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import {
  Trash2,
  RotateCcw,
  Loader2,
  Eye,
  FileText,
  AlertTriangle,
  Info,
} from "lucide-react";
import { documentsAPI } from "@/services/api";
import { toast } from "@/components/ui/vault-toast";
import type { Document } from "@/types";
import { format, formatDistanceToNow } from "date-fns";
import StatusBadge from "@/components/documents/StatusBadge";

export default function TrashPage() {
  const qc = useQueryClient();
  const [busyId, setBusyId] = useState<string | null>(null);

  const params = { trash: true, page_size: 100 } as Record<string, unknown>;
  const { data, isLoading } = useQuery({
    queryKey: ["documents", "trash", params],
    queryFn: () => documentsAPI.list(params).then((r) => r.data),
  });

  const docs: Document[] = useMemo(() => data?.results ?? data ?? [], [data]);

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["documents"] });
  };

  const restoreMutation = useMutation({
    mutationFn: (id: string) => documentsAPI.restore(id),
    onMutate: (id) => setBusyId(id),
    onSuccess: () => { toast.success("Document restored."); invalidate(); },
    onError: (err: any) => toast.error(extractApiError(err, "Could not restore document.")),
    onSettled: () => setBusyId(null),
  });

  const purgeMutation = useMutation({
    mutationFn: (id: string) => documentsAPI.purge(id),
    onMutate: (id) => setBusyId(id),
    onSuccess: () => { toast.success("Permanently deleted."); invalidate(); },
    onError: (err: any) => toast.error(extractApiError(err, "Could not delete document.")),
    onSettled: () => setBusyId(null),
  });

  return (
    <div className="-m-6 min-h-[calc(100vh-3.5rem)] bg-[#EDEDED] text-[13px] text-[#1F2933]">

      {/* ── Page header bar ─────────────────────────────────────────────────── */}
      <div className="border-b border-[#206D99] bg-[#287EAD] px-6 py-4 text-white">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center border border-white/25 bg-white/10">
              <Trash2 className="h-5 w-5 text-white" />
            </div>
            <div>
              <h1 className="text-xl font-semibold">Trash</h1>
              <p className="mt-0.5 text-sm text-white/75">
                Deleted documents — restore or permanently remove them.
              </p>
            </div>
          </div>
          {!isLoading && docs.length > 0 && (
            <div className="border border-white/25 bg-white/10 px-3 py-2 text-sm font-semibold">
              {docs.length} item{docs.length !== 1 ? "s" : ""}
            </div>
          )}
        </div>
      </div>

      {/* ── Body ────────────────────────────────────────────────────────────── */}
      <div className="space-y-4 p-4 pr-8">

        {/* Retention notice */}
        <div className="flex items-start gap-2.5 border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          <Info className="mt-0.5 h-4 w-4 flex-shrink-0" />
          <span>
            Documents in Trash are emptied automatically after the retention period set in{" "}
            <strong>Admin → DMS settings</strong>. Restore anything you want to keep.
          </span>
        </div>

        {/* Content area */}
        {isLoading ? (
          <div className="flex h-48 items-center justify-center border border-[#C8CDD2] bg-white">
            <Loader2 className="h-6 w-6 animate-spin text-[#287EAD]" />
          </div>
        ) : docs.length === 0 ? (
          <div className="border border-[#C8CDD2] bg-white p-16 text-center">
            <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center border border-[#C8CDD2] bg-[#F5F7F8]">
              <Trash2 className="h-7 w-7 text-[#8A949D]" />
            </div>
            <p className="font-semibold text-[#1F2933]">Trash is empty</p>
            <p className="mt-1 text-sm text-[#5E6870]">
              Documents you delete will appear here.
            </p>
          </div>
        ) : (
          <div className="border border-[#C8CDD2] bg-white">
            {/* Tab-style header row */}
            <div className="flex h-[50px] items-center border-b border-[#C8CDD2] px-4">
              <button
                type="button"
                className="h-9 border border-[#B9C0C6] border-t-2 border-t-[#2B8DCB] bg-white px-4 text-sm font-medium text-[#2B86C5]"
              >
                Deleted Documents
              </button>
              <span className="ml-3 border-l border-[#C8CDD2] pl-3 text-sm font-semibold text-[#1F2933]">
                {docs.length} item{docs.length !== 1 ? "s" : ""}
              </span>
            </div>

            {/* Table */}
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead>
                  <tr className="border-b border-[#C8CDD2] bg-[#F5F7F8] text-xs font-semibold uppercase tracking-wider text-[#5E6870]">
                    <th className="px-4 py-3">Document</th>
                    <th className="px-4 py-3">Type</th>
                    <th className="px-4 py-3">Status</th>
                    <th className="px-4 py-3 whitespace-nowrap">Deleted</th>
                    <th className="px-4 py-3">By</th>
                    <th className="px-4 py-3 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#EAEDF0]">
                  {docs.map((doc) => {
                    const busy = busyId === doc.id;
                    return (
                      <tr
                        key={doc.id}
                        className="transition-colors hover:bg-[#F7FAFC]"
                      >
                        {/* Document title + ref */}
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-2 min-w-0">
                            <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center border border-[#C8CDD2] bg-[#EEF3F7]">
                              <FileText className="h-4 w-4 text-[#287EAD]" />
                            </div>
                            <div className="min-w-0">
                              <p className="truncate font-semibold text-[#1F2933]">
                                {doc.title}
                              </p>
                              {doc.reference_number && (
                                <p className="truncate font-mono text-xs text-[#5E6870]">
                                  {doc.reference_number}
                                </p>
                              )}
                            </div>
                          </div>
                        </td>

                        {/* Document type */}
                        <td className="px-4 py-3 text-[#1F2933]">
                          {doc.document_type_name || doc.document_type?.name || (
                            <span className="text-[#8A949D]">—</span>
                          )}
                        </td>

                        {/* Status badge */}
                        <td className="px-4 py-3">
                          <StatusBadge status={doc.status} />
                        </td>

                        {/* Deleted timestamp */}
                        <td
                          className="px-4 py-3 whitespace-nowrap text-xs text-[#5E6870]"
                          title={
                            doc.deleted_at
                              ? format(new Date(doc.deleted_at), "dd MMM yyyy HH:mm")
                              : undefined
                          }
                        >
                          {doc.deleted_at
                            ? `${formatDistanceToNow(new Date(doc.deleted_at))} ago`
                            : <span className="text-[#8A949D]">—</span>}
                        </td>

                        {/* Deleted by */}
                        <td className="px-4 py-3 max-w-[10rem] truncate text-xs text-[#5E6870]">
                          {doc.deleted_by_name || <span className="text-[#8A949D]">—</span>}
                        </td>

                        {/* Actions */}
                        <td className="px-4 py-3">
                          <div className="flex items-center justify-end gap-2">
                            {/* View */}
                            <Link
                              to={`/documents/${doc.id}`}
                              className="inline-flex h-8 items-center gap-1.5 border border-[#B7BEC5] bg-white px-3 text-xs font-medium text-[#287EAD] hover:bg-[#EEF3F7] transition-colors"
                            >
                              <Eye className="h-3.5 w-3.5" />
                              View
                            </Link>

                            {/* Restore */}
                            <button
                              type="button"
                              title="Restore document"
                              disabled={busy}
                              onClick={() => restoreMutation.mutate(doc.id)}
                              className="inline-flex h-8 items-center gap-1.5 border border-[#B7BEC5] bg-white px-3 text-xs font-medium text-[#1F2933] hover:bg-[#EEF3F7] disabled:opacity-50 transition-colors"
                            >
                              {busy && restoreMutation.isPending ? (
                                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                              ) : (
                                <RotateCcw className="h-3.5 w-3.5" />
                              )}
                              Restore
                            </button>

                            {/* Permanent delete */}
                            <button
                              type="button"
                              title="Delete permanently"
                              disabled={busy}
                              onClick={() => {
                                if (
                                  window.confirm(
                                    `Permanently delete "${doc.title}"? This cannot be undone.`,
                                  )
                                )
                                  purgeMutation.mutate(doc.id);
                              }}
                              className="inline-flex h-8 items-center gap-1.5 border border-[#D9A6A0] bg-[#FFF8F7] px-3 text-xs font-medium text-[#B42318] hover:bg-[#FEECEA] disabled:opacity-50 transition-colors"
                            >
                              {busy && purgeMutation.isPending ? (
                                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                              ) : (
                                <Trash2 className="h-3.5 w-3.5" />
                              )}
                              Delete
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
        )}
      </div>
    </div>
  );
}
