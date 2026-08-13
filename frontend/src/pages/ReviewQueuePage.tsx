import { useQuery } from "@tanstack/react-query";
import { useNavigate, useParams } from "react-router-dom";
import { ClipboardCheck, Mail, RefreshCw, ScanLine } from "lucide-react";
import clsx from "clsx";

import { bulkUploadAPI, normalizeListResponse, type BulkUploadSummary } from "@/services/api";
import BulkScanPage from "@/pages/BulkScanPage";

import { WorkspaceCommandBar } from "@/components/shared/WorkspaceCommandBar";

const panelCls = "border border-[#C8CDD2] bg-white";
const panelHeaderCls = "flex items-center gap-2 border-b border-[#C8CDD2] bg-[#F5F7F8] px-4 py-3";
const btnGhost =
  "inline-flex items-center gap-2 border border-[#AEB5BB] bg-white px-3 h-9 text-sm text-[#1F2933] hover:bg-[#F5F7F8] disabled:opacity-50";

const STATUS_STYLES: Record<BulkUploadSummary["status"], string> = {
  pending: "bg-[#E5E7EB] text-[#374151]",
  uploading: "bg-[#DBEAFE] text-[#1E40AF]",
  processing: "bg-[#FEF3C7] text-[#92400E]",
  review: "bg-[#DBEAFE] text-[#1E40AF]",
  completed: "bg-[#DCFCE7] text-[#166534]",
  failed: "bg-[#FEE2E2] text-[#991B1B]",
};

function ReviewQueueList() {
  const navigate = useNavigate();

  const batchesQuery = useQuery({
    queryKey: ["review-queue"],
    queryFn: () =>
      bulkUploadAPI.list().then((r) => normalizeListResponse<BulkUploadSummary>(r.data)),
    // Keep the queue fresh while batches are still being OCR'd.
    refetchInterval: (query) => {
      const batches = (query.state.data as BulkUploadSummary[] | undefined) ?? [];
      return batches.some((b) => b.status === "processing") ? 4000 : false;
    },
  });

  const batches = batchesQuery.data ?? [];

  return (
    <div className="flex h-full flex-col bg-[#EDEDED] text-[#1F2933]">
      <WorkspaceCommandBar
        actions={
          <button
            className="flex items-center gap-1.5 border border-white/30 px-3 py-1 text-xs text-white/80 transition hover:bg-white/10 hover:text-white disabled:opacity-50"
            onClick={() => batchesQuery.refetch()}
            disabled={batchesQuery.isFetching}
          >
            <RefreshCw className={clsx("h-3.5 w-3.5", batchesQuery.isFetching && "animate-spin")} />
            Refresh
          </button>
        }
      >
        <div className="min-w-0">
          <h1 className="flex items-center gap-2 text-lg font-semibold tracking-tight">
            <ClipboardCheck className="h-5 w-5" />
            Pending review
          </h1>
          <p className="mt-0.5 text-xs text-white/75">
            Batches awaiting review — from email ingestion and bulk scans.
          </p>
        </div>
      </WorkspaceCommandBar>

      <div className="scrollbar-minimal min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-5xl space-y-6 p-6">
          <section className={panelCls}>
            <div className={clsx(panelHeaderCls, "justify-between")}>
              <span className="flex items-center gap-2">
                <RefreshCw className="h-4 w-4 text-[#287EAD]" />
                <h2 className="text-sm font-semibold text-[#1F2933]">Batches</h2>
              </span>
              <button
                className={btnGhost}
                onClick={() => batchesQuery.refetch()}
                disabled={batchesQuery.isFetching}
              >
                <RefreshCw className={clsx("h-4 w-4", batchesQuery.isFetching && "animate-spin")} />
                Refresh
              </button>
            </div>
            {batches.length === 0 ? (
              <p className="p-6 text-center text-sm text-[#6E767D]">
                Nothing waiting for review.
              </p>
            ) : (
              <table className="w-full text-sm">
                <thead className="bg-[#F5F7F8] text-left text-xs uppercase tracking-wide text-[#6E767D]">
                  <tr>
                    <th className="px-4 py-2">Source</th>
                    <th className="px-4 py-2">Type</th>
                    <th className="px-4 py-2">Docs</th>
                    <th className="px-4 py-2">Status</th>
                    <th className="px-4 py-2">Received</th>
                  </tr>
                </thead>
                <tbody>
                  {batches.map((b) => {
                    const openable = b.status === "review";
                    return (
                      <tr
                        key={b.id}
                        className={clsx(
                          "border-t border-[#E5E7EB]",
                          openable
                            ? "hover:bg-[#F9FAFB] cursor-pointer"
                            : "opacity-70 cursor-default",
                        )}
                        onClick={() => openable && navigate(`/documents/review/${b.id}`)}
                      >
                        <td className="px-4 py-2">
                          <span className="inline-flex items-center gap-2 text-[#1F2933]">
                            {b.source === "email" ? (
                              <Mail className="h-4 w-4 text-[#287EAD]" />
                            ) : (
                              <ScanLine className="h-4 w-4 text-[#287EAD]" />
                            )}
                            {b.source === "email"
                              ? b.email?.subject || b.email?.sender || "Email"
                              : "Bulk scan"}
                          </span>
                        </td>
                        <td className="px-4 py-2 text-[#6E767D]">
                          {b.document_type?.code === "UNCLASS"
                            ? "Unclassified"
                            : b.document_type?.name ?? "—"}
                        </td>
                        <td className="px-4 py-2 text-[#6E767D]">
                          {b.successful_uploads}/{b.total_files}
                        </td>
                        <td className="px-4 py-2">
                          <span
                            className={clsx(
                              "rounded px-2 py-0.5 text-xs font-medium",
                              STATUS_STYLES[b.status],
                            )}
                          >
                            {b.status === "processing" ? "processing…" : b.status}
                          </span>
                        </td>
                        <td className="px-4 py-2 text-[#6E767D]">
                          {new Date(b.email?.received_at ?? b.created_at).toLocaleString()}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}

export default function ReviewQueuePage() {
  const { batchId } = useParams();

  if (batchId) {
    return (
      <BulkScanPage
        initialBatchId={batchId}
        scanMode={false}
        backTo={{ label: "Pending review", path: "/documents/review" }}
      />
    );
  }

  return <ReviewQueueList />;
}
