import { useEffect, useMemo, useState } from "react";
import { CheckCircle, Loader2, ArrowRight, Sparkles, FileText } from "lucide-react";
import type { DocumentType } from "@/types";
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
  isSubmitting: boolean;
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
  isSubmitting,
  previews = {},
}: Props) {
  const counts = useMemo(() => countReviewDecisions(reviewStates), [reviewStates]);
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
        <div className="max-h-[calc(100vh-13rem)] space-y-3 overflow-y-auto pr-1 xl:col-span-4">
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

        <div className="xl:col-span-8">
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
      </div>

      <div className="flex gap-4 border-t border-[#C8CDD2] pt-4">
        <button
          type="button"
          onClick={onSubmit}
          disabled={isSubmitting || reviewStates.length === 0 || missingTypeCount > 0}
          className="flex flex-1 items-center justify-center gap-2 bg-[#287EAD] py-3 text-base font-semibold text-white transition-all hover:bg-[#206D99] disabled:opacity-50"
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
