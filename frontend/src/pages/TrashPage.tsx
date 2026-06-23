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
import { Trash2, RotateCcw, Loader2, Eye, FileText, AlertTriangle } from "lucide-react";
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
    <div className="p-6 max-w-6xl mx-auto space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-foreground tracking-tight flex items-center gap-2">
            <Trash2 className="h-6 w-6 text-muted-foreground" /> Trash
          </h1>
          <p className="text-muted-foreground text-sm mt-1">
            Deleted documents are kept here until you restore them or they are emptied automatically.
          </p>
        </div>
      </div>

      <div className="flex items-start gap-2 rounded-lg border border-amber-300/60 bg-amber-50 px-4 py-3 text-sm text-amber-800">
        <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0" />
        <span>Documents in Trash are emptied automatically after the retention period set in Admin → DMS settings. Restore anything you want to keep.</span>
      </div>

      <div className="border border-border rounded-xl bg-card overflow-hidden">
        {isLoading ? (
          <div className="flex h-48 items-center justify-center">
            <Loader2 className="h-6 w-6 animate-spin text-accent" />
          </div>
        ) : docs.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-20 text-center">
            <Trash2 className="mb-3 h-10 w-10 text-muted-foreground/50" />
            <p className="text-sm font-semibold text-foreground">Trash is empty</p>
            <p className="mt-1 text-sm text-muted-foreground">Documents you delete will appear here.</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-border bg-muted/40 text-xs font-semibold text-muted-foreground">
                  <th className="px-4 py-3">Document</th>
                  <th className="px-4 py-3">Type</th>
                  <th className="px-4 py-3">Status</th>
                  <th className="px-4 py-3">Deleted</th>
                  <th className="px-4 py-3">By</th>
                  <th className="px-4 py-3 text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {docs.map((doc) => {
                  const busy = busyId === doc.id;
                  return (
                    <tr key={doc.id} className="border-b border-border/60 hover:bg-muted/20">
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2 min-w-0">
                          <FileText className="h-4 w-4 flex-shrink-0 text-muted-foreground" />
                          <div className="min-w-0">
                            <p className="truncate font-medium text-foreground">{doc.title}</p>
                            <p className="truncate text-xs text-muted-foreground">{doc.reference_number}</p>
                          </div>
                        </div>
                      </td>
                      <td className="px-4 py-3 text-foreground/80">{doc.document_type_name || doc.document_type?.name || "—"}</td>
                      <td className="px-4 py-3"><StatusBadge status={doc.status} /></td>
                      <td className="px-4 py-3 text-muted-foreground whitespace-nowrap text-xs"
                          title={doc.deleted_at ? format(new Date(doc.deleted_at), "dd MMM yyyy HH:mm") : ""}>
                        {doc.deleted_at ? `${formatDistanceToNow(new Date(doc.deleted_at))} ago` : "—"}
                      </td>
                      <td className="px-4 py-3 text-foreground/80 max-w-[10rem] truncate text-xs">{doc.deleted_by_name || "—"}</td>
                      <td className="px-4 py-3">
                        <div className="flex items-center justify-end gap-1.5">
                          <Link
                            to={`/documents/${doc.id}`}
                            className="inline-flex items-center gap-1.5 rounded-md border border-border bg-card px-2.5 py-1.5 text-xs font-medium text-foreground hover:border-accent/40 hover:bg-accent/10 hover:text-accent transition-colors"
                          >
                            <Eye className="h-3.5 w-3.5" /> View
                          </Link>
                          <button
                            title="Restore"
                            disabled={busy}
                            onClick={() => restoreMutation.mutate(doc.id)}
                            className="inline-flex items-center gap-1.5 rounded-md border border-border bg-card px-2.5 py-1.5 text-xs font-medium text-foreground hover:border-accent/40 hover:bg-accent/10 hover:text-accent transition-colors disabled:opacity-50"
                          >
                            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RotateCcw className="h-3.5 w-3.5" />} Restore
                          </button>
                          <button
                            title="Delete permanently"
                            disabled={busy}
                            onClick={() => {
                              if (window.confirm(`Permanently delete "${doc.title}"? This cannot be undone.`)) purgeMutation.mutate(doc.id);
                            }}
                            className="inline-flex items-center gap-1.5 rounded-md border border-destructive/40 bg-card px-2.5 py-1.5 text-xs font-medium text-destructive hover:bg-destructive/10 transition-colors disabled:opacity-50"
                          >
                            <Trash2 className="h-3.5 w-3.5" /> Delete
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
