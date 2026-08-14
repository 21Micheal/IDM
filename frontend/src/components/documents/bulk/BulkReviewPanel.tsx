import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { CheckCircle, Loader2, ArrowRight, Sparkles, FileText } from "lucide-react";
import type { DocumentType, DocumentPreviewResponse } from "@/types";
import { documentsAPI, api } from "@/services/api";
import { useAuthStore } from "@/store/authStore";
import type { BulkDocReviewState, BulkLocalPreview } from "./bulkUploadTypes";
import { countReviewDecisions } from "./bulkUploadUtils";
import BulkDocumentReviewCard from "./BulkDocumentReviewCard";

const REVIEW_PREVIEW_HEIGHT = "h-[clamp(34rem,calc(100vh-16rem),46rem)]";

type Props = {
  documentType: DocumentType;
  documentTypes?: DocumentType[];
  isRelatedSet?: boolean;
  scanMode?: boolean;
  reviewStates: BulkDocReviewState[];
  onChange: (states: BulkDocReviewState[]) => void;
  onSubmit: () => void;
  onCancel: () => void;
  isSubmitting: boolean;
  isCancelling: boolean;
  previews?: Record<string, BulkLocalPreview>;
};

export default function BulkReviewPanel({
  documentType,
  documentTypes = [documentType],
  isRelatedSet = false,
  scanMode = true,
  reviewStates,
  onChange,
  onSubmit,
  onCancel,
  isSubmitting,
  isCancelling,
  previews = {},
}: Props) {
  const counts = useMemo(() => countReviewDecisions(reviewStates), [reviewStates]);
  const needsManualCount = useMemo(
    () => reviewStates.filter((state) => state.ocrStatus === "needs_manual").length,
    [reviewStates],
  );
  const missingTypeCount = useMemo(
    () => reviewStates.filter((state) => state.approved && isRelatedSet && !state.documentTypeId).length,
    [isRelatedSet, reviewStates],
  );
  const [selectedDocumentId, setSelectedDocumentId] = useState(reviewStates[0]?.documentId ?? "");
  const selectedState = reviewStates.find((state) => state.documentId === selectedDocumentId) ?? reviewStates[0];
  const selectedPreview = selectedState ? previews[selectedState.fileName] : undefined;
  const pdfSrc = selectedPreview?.url ? `${selectedPreview.url}#toolbar=1&navpanes=0&scrollbar=1&view=FitV` : null;

  useEffect(() => {
    if (!selectedDocumentId && reviewStates[0]) {
      setSelectedDocumentId(reviewStates[0].documentId);
    }
  }, [reviewStates, selectedDocumentId]);

  const updateAt = (index: number, next: BulkDocReviewState) => {
    const copy = [...reviewStates];
    copy[index] = next;
    onChange(copy);
  };

  const expandAll = () => {
    onChange(reviewStates.map((s) => ({ ...s, expanded: true })));
  };

  const approveAll = () => {
    onChange(reviewStates.map((s) => ({ ...s, approved: true, rejected: false })));
  };

  return (
    <div className="space-y-4">
      {needsManualCount > 0 && (
        <div className="border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          {needsManualCount} document{needsManualCount === 1 ? "" : "s"} could not be extracted by Claude.
          Fill metadata manually before approving.
        </div>
      )}
      <div className="flex flex-col gap-4 border border-[#C8CDD2] bg-white p-4 sm:flex-row sm:items-center">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center bg-[#EEF6FB]">
            <Sparkles className="h-5 w-5 text-[#287EAD]" />
          </div>
          <div>
            <h2 className="text-xl font-bold text-[#1F2933]">Review each document</h2>
            <p className="text-sm text-[#5E6870]">
              {scanMode && isRelatedSet
                ? "OCR pre-filled fields and suggested document types per file — verify each document before submitting."
                : scanMode
                  ? "OCR pre-filled fields per file — expand to verify, then submit the batch."
                  : "Select a document to view its preview, choose its type, then fill the metadata before submitting."}
            </p>
          </div>
        </div>
        <div className="sm:ml-auto flex flex-wrap gap-2">
          <button type="button" onClick={expandAll} className="text-sm font-medium text-primary hover:underline">
            Expand all
          </button>
          <span className="text-muted-foreground">·</span>
          <button type="button" onClick={approveAll} className="text-sm font-medium text-primary hover:underline">
            Include all
          </button>
        </div>
      </div>

      <div className="flex flex-wrap gap-3 text-sm">
        <span className="bg-[#DCEAF2] px-3 py-1 font-semibold text-[#287EAD]">
          {counts.approved} to submit
        </span>
        <span className="bg-white px-3 py-1 font-semibold text-[#5E6870]">
          {counts.rejected} skipped
        </span>
        <span className="bg-white px-3 py-1 text-[#5E6870]">
          {reviewStates.length} total
        </span>
        {missingTypeCount > 0 && (
          <span className="bg-amber-50 px-3 py-1 font-semibold text-amber-700">
            {missingTypeCount} need document type
          </span>
        )}
      </div>

      <div className="grid gap-4 xl:grid-cols-12">
        <div className="xl:col-span-7 2xl:col-span-8">
          <div className="sticky top-4 border border-[#C8CDD2] bg-white">
            <div className="border-b border-[#C8CDD2] bg-[#F5F7F8] px-3 py-2">
              <p className="text-sm font-bold text-[#1F2933]">Review preview</p>
              <p className="truncate text-xs text-[#5E6870]">{selectedState?.fileName || "Select a document"}</p>
            </div>
            <div className="bg-[#EDEDED] p-3">
              {pdfSrc && selectedPreview?.kind === "pdf" ? (
                <div className={`mx-auto w-full max-w-[920px] border border-[#C8CDD2] bg-white ${REVIEW_PREVIEW_HEIGHT}`}>
                  <iframe src={pdfSrc} title="Bulk review preview" className="h-full w-full bg-white" />
                </div>
              ) : selectedPreview?.url && selectedPreview.kind === "image" ? (
                <div className={`mx-auto flex w-full max-w-[920px] items-center justify-center overflow-auto border border-[#C8CDD2] bg-white ${REVIEW_PREVIEW_HEIGHT}`}>
                  <img src={selectedPreview.url} alt="Bulk review preview" className="max-h-full max-w-full object-contain" />
                </div>
              ) : selectedState?.documentId ? (
                // No local blob (e.g. batch opened from the pending-review queue
                // or email ingestion): preview the stored document by id, the
                // same way the detail/upload pages do.
                <ServerDocumentPreview documentId={selectedState.documentId} heightCls={REVIEW_PREVIEW_HEIGHT} />
              ) : (
                <div className={`mx-auto flex w-full max-w-[920px] flex-col items-center justify-center border border-dashed border-[#C8CDD2] bg-white text-center ${REVIEW_PREVIEW_HEIGHT}`}>
                  <FileText className="mb-3 h-12 w-12 text-[#5E6870]" />
                  <p className="text-sm font-semibold text-[#1F2933]">Preview unavailable for this format</p>
                  <p className="mt-1 max-w-xs text-xs text-[#5E6870]">Use the extracted fields on the left to complete review.</p>
                </div>
              )}
            </div>
          </div>
        </div>

        <div className="max-h-[calc(100vh-13rem)] space-y-3 overflow-y-auto pr-1 xl:col-span-5 2xl:col-span-4">
          {reviewStates.map((state, index) => (
            <BulkDocumentReviewCard
              key={state.documentId}
              state={state}
              documentType={documentTypes.find((type) => type.id === state.documentTypeId) ?? documentType}
              documentTypes={documentTypes}
              isRelatedSet={isRelatedSet}
              scanMode={scanMode}
              selected={selectedState?.documentId === state.documentId}
              onSelect={() => setSelectedDocumentId(state.documentId)}
              onChange={(next) => updateAt(index, next)}
            />
          ))}
        </div>
      </div>

      <div className="flex flex-col gap-3 border-t border-[#C8CDD2] pt-4 sm:flex-row sm:justify-end">
        <button
          type="button"
          onClick={onCancel}
          disabled={isCancelling || isSubmitting}
          className="inline-flex items-center justify-center gap-2 border border-[#C8CDD2] bg-white px-4 py-2 text-sm font-semibold text-[#1F2933] transition-all hover:bg-[#F7F8F9] disabled:opacity-50"
        >
          {isCancelling ? (
            <Loader2 className="w-5 h-5 animate-spin" />
          ) : (
            "Cancel review"
          )}
        </button>
        <button
          type="button"
          onClick={onSubmit}
          disabled={isSubmitting || isCancelling || reviewStates.length === 0 || missingTypeCount > 0}
          className="inline-flex items-center justify-center gap-2 bg-[#287EAD] px-4 py-2 text-sm font-semibold text-white transition-all hover:bg-[#206D99] disabled:opacity-50"
        >
          {isSubmitting ? (
            <Loader2 className="w-5 h-5 animate-spin" />
          ) : (
            <>
              <CheckCircle className="w-5 h-5" />
              Submit batch ({counts.approved} documents)
              <ArrowRight className="w-4 h-4" />
            </>
          )}
        </button>
      </div>
    </div>
  );
}

const SERVER_BOX = "mx-auto w-full max-w-[920px] border border-[#C8CDD2] bg-white";
const SERVER_BOX_CENTER =
  "mx-auto flex w-full max-w-[920px] flex-col items-center justify-center border border-dashed border-[#C8CDD2] bg-white text-center";

// Re-host absolute /api/ URLs onto the page origin (the backend builds them with
// build_absolute_uri, which can leak an internal proxy host). Mirrors the
// DocumentViewer helper.
function normalizeApiUrl(url: string): string {
  if (/^https?:\/\//i.test(url)) {
    try {
      const parsed = new URL(url);
      if (parsed.pathname.startsWith("/api/")) {
        parsed.protocol = window.location.protocol;
        parsed.host = window.location.host;
        return parsed.toString();
      }
    } catch {
      /* fall through */
    }
  }
  return url;
}

/**
 * Preview a stored document by id, used when the review card has no local file
 * blob (batches opened from the pending-review queue or created by email
 * ingestion). The file/preview endpoint requires the Authorization header, so —
 * exactly like the detail viewer — we fetch it as an authenticated blob and
 * render that object URL rather than pointing an iframe at the raw URL (which
 * would 401 unless signed file URLs are enabled).
 */
function ServerDocumentPreview({ documentId, heightCls }: { documentId: string; heightCls: string }) {
  const token = useAuthStore((s) => s.accessToken);
  const { data, isLoading } = useQuery({
    queryKey: ["bulk-review-preview", documentId],
    queryFn: () => documentsAPI.previewUrl(documentId).then((r) => r.data as DocumentPreviewResponse),
    enabled: Boolean(documentId),
    refetchInterval: (query) => {
      const d = query.state.data as DocumentPreviewResponse | undefined;
      const pending = d?.preview_status === "pending" || d?.preview_status === "processing";
      return d?.viewer === "processing" || pending ? 3000 : false;
    },
  });

  const rawUrl = data?.url ?? null;
  const viewer = data?.viewer;
  const renderable = viewer === "pdfjs" || viewer === "image";
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [blobErr, setBlobErr] = useState(false);

  useEffect(() => {
    if (!rawUrl || !renderable) {
      setBlobUrl(null);
      return;
    }
    let cancelled = false;
    let objectUrl = "";
    setBlobErr(false);
    (async () => {
      try {
        const res = await api.get(normalizeApiUrl(rawUrl), {
          responseType: "blob",
          headers: token ? { Authorization: `Bearer ${token}` } : {},
        });
        if (cancelled) return;
        objectUrl = URL.createObjectURL(res.data);
        setBlobUrl(objectUrl);
      } catch {
        if (!cancelled) setBlobErr(true);
      }
    })();
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [rawUrl, renderable, token]);

  const preparing =
    viewer === "processing" ||
    data?.preview_status === "pending" ||
    data?.preview_status === "processing";

  // Still resolving the preview URL, or fetching the blob for a renderable doc.
  if (isLoading || (renderable && !blobUrl && !blobErr)) {
    return (
      <div className={`${SERVER_BOX_CENTER} ${heightCls}`}>
        <Loader2 className="h-8 w-8 animate-spin text-[#5E6870]" />
      </div>
    );
  }

  if (viewer === "pdfjs" && blobUrl) {
    return (
      <div className={`${SERVER_BOX} ${heightCls}`}>
        <iframe
          src={`${blobUrl}#toolbar=1&navpanes=0&scrollbar=1&view=FitV`}
          title="Document preview"
          className="h-full w-full bg-white"
        />
      </div>
    );
  }

  if (viewer === "image" && blobUrl) {
    return (
      <div className={`mx-auto flex w-full max-w-[920px] items-center justify-center overflow-auto border border-[#C8CDD2] bg-white ${heightCls}`}>
        <img src={blobUrl} alt="Document preview" className="max-h-full max-w-full object-contain" />
      </div>
    );
  }

  if (preparing) {
    return (
      <div className={`${SERVER_BOX_CENTER} ${heightCls}`}>
        <Loader2 className="mb-3 h-10 w-10 animate-spin text-[#5E6870]" />
        <p className="text-sm font-semibold text-[#1F2933]">Preparing preview…</p>
        <p className="mt-1 max-w-xs text-xs text-[#5E6870]">This document is being converted for preview.</p>
      </div>
    );
  }

  return (
    <div className={`${SERVER_BOX_CENTER} ${heightCls}`}>
      <FileText className="mb-3 h-12 w-12 text-[#5E6870]" />
      <p className="text-sm font-semibold text-[#1F2933]">Preview unavailable for this format</p>
      <p className="mt-1 max-w-xs text-xs text-[#5E6870]">Use the fields on the left to complete review.</p>
    </div>
  );
}
