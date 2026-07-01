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
  Info,
} from "lucide-react";
import { documentsAPI } from "@/services/api";
import { toast } from "@/components/ui/vault-toast";
import type { Document } from "@/types";
import { format, formatDistanceToNow } from "date-fns";
import StatusBadge from "@/components/documents/StatusBadge";
import { WorkspaceCommandBar } from "@/components/shared/WorkspaceCommandBar";

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
    <div className="flex h-full flex-col bg-[#EDEDED] text-[13px] text-[#1F2933]">

      {/* ── Page header bar ─────────────────────────────────────────────────── */}
      <WorkspaceCommandBar
        actions={
          !isLoading && docs.length > 0 ? (
            <div className="border border-white/25 bg-white/10 px-3 py-2 text-sm font-semibold">
              {docs.length} item{docs.length !== 1 ? "s" : ""}
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
            Deleted documents — restore or permanently remove them.
          </p>
        </div>
      </WorkspaceCommandBar>

      {/* ── Body ────────────────────────────────────────────────────────────── */}
      <div className="scrollbar-minimal min-h-0 flex-1 overflow-y-auto p-5 pr-0">
        <div className="mx-auto max-w-5xl space-y-3">

          {/* Retention notice — compact */}
          <div className="flex items-start gap-2 border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
            <Info className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" />
            <span>
              Items in Trash are emptied automatically after the retention period set in{" "}
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
            <div className="overflow-hidden border border-[#C8CDD2] bg-white">
              <div className="overflow-x-auto">
                <table className="w-full text-left text-sm">
                  <thead>
                    <tr className="border-b border-[#C8CDD2] bg-[#F5F7F8] text-[11px] font-semibold uppercase tracking-wider text-[#5E6870]">
                      <th className="px-4 py-2.5">Document</th>
                      <th className="px-4 py-2.5">Type</th>
                      <th className="px-4 py-2.5">Status</th>
                      <th className="px-4 py-2.5 whitespace-nowrap">Deleted</th>
                      <th className="px-4 py-2.5 text-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[#EAEDF0]">
                    {docs.map((doc) => {
                      const busy = busyId === doc.id;
                      return (
                        <tr key={doc.id} className="transition-colors hover:bg-[#F7FAFC]">
                          {/* Document title + ref */}
                          <td className="px-4 py-2.5">
                            <div className="flex items-center gap-2 min-w-0">
                              <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center border border-[#C8CDD2] bg-[#EEF3F7]">
                                <FileText className="h-4 w-4 text-[#287EAD]" />
                              </div>
                              <div className="min-w-0">
                                <p className="truncate font-semibold text-[#1F2933]">{doc.title}</p>
                                {doc.reference_number && (
                                  <p className="truncate font-mono text-xs text-[#5E6870]">{doc.reference_number}</p>
                                )}
                              </div>
                            </div>
                          </td>

                          {/* Document type */}
                          <td className="px-4 py-2.5 text-[#1F2933]">
                            {doc.document_type_name || doc.document_type?.name || (
                              <span className="text-[#8A949D]">—</span>
                            )}
                          </td>

                          {/* Status badge */}
                          <td className="px-4 py-2.5">
                            <StatusBadge status={doc.status} />
                          </td>

                          {/* Deleted timestamp + who */}
                          <td
                            className="px-4 py-2.5 whitespace-nowrap text-xs text-[#5E6870]"
                            title={doc.deleted_at ? format(new Date(doc.deleted_at), "dd MMM yyyy HH:mm") : undefined}
                          >
                            {doc.deleted_at
                              ? `${formatDistanceToNow(new Date(doc.deleted_at))} ago`
                              : <span className="text-[#8A949D]">—</span>}
                            {doc.deleted_by_name && (
                              <span className="block text-[11px] text-[#8A949D]">by {doc.deleted_by_name}</span>
                            )}
                          </td>

                          {/* Actions — compact icon buttons */}
                          <td className="px-4 py-2.5">
                            <div className="flex items-center justify-end gap-1.5">
                              <Link
                                to={`/documents/${doc.id}`}
                                title="View"
                                aria-label="View"
                                className="flex h-8 w-8 items-center justify-center border border-[#B7BEC5] bg-white text-[#287EAD] transition-colors hover:bg-[#EEF3F7]"
                              >
                                <Eye className="h-3.5 w-3.5" />
                              </Link>

                              <button
                                type="button"
                                title="Restore"
                                aria-label="Restore"
                                disabled={busy}
                                onClick={() => restoreMutation.mutate(doc.id)}
                                className="flex h-8 w-8 items-center justify-center border border-[#B7BEC5] bg-white text-[#1F2933] transition-colors hover:bg-[#EEF3F7] disabled:opacity-50"
                              >
                                {busy && restoreMutation.isPending
                                  ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                  : <RotateCcw className="h-3.5 w-3.5" />}
                              </button>

                              <button
                                type="button"
                                title="Delete permanently"
                                aria-label="Delete permanently"
                                disabled={busy}
                                onClick={() => {
                                  if (window.confirm(`Permanently delete "${doc.title}"? This cannot be undone.`))
                                    purgeMutation.mutate(doc.id);
                                }}
                                className="flex h-8 w-8 items-center justify-center border border-[#D9A6A0] bg-[#FFF8F7] text-[#B42318] transition-colors hover:bg-[#FEECEA] disabled:opacity-50"
                              >
                                {busy && purgeMutation.isPending
                                  ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                  : <Trash2 className="h-3.5 w-3.5" />}
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
    </div>
  );
}
