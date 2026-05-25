import { useEffect, useMemo, useState } from "react";
import { CheckCircle, Loader2, ArrowRight, Sparkles, FileText } from "lucide-react";
import type { DocumentType } from "@/types";
import type { BulkDocReviewState, BulkLocalPreview } from "./bulkUploadTypes";
import { countReviewDecisions } from "./bulkUploadUtils";
import BulkDocumentReviewCard from "./BulkDocumentReviewCard";

type Props = {
  documentType: DocumentType;
  reviewStates: BulkDocReviewState[];
  onChange: (states: BulkDocReviewState[]) => void;
  onSubmit: () => void;
  isSubmitting: boolean;
  previews?: Record<string, BulkLocalPreview>;
};

export default function BulkReviewPanel({
  documentType,
  reviewStates,
  onChange,
  onSubmit,
  isSubmitting,
  previews = {},
}: Props) {
  const counts = useMemo(() => countReviewDecisions(reviewStates), [reviewStates]);
  const [selectedDocumentId, setSelectedDocumentId] = useState(reviewStates[0]?.documentId ?? "");
  const selectedState = reviewStates.find((state) => state.documentId === selectedDocumentId) ?? reviewStates[0];
  const selectedPreview = selectedState ? previews[selectedState.fileName] : undefined;

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
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center gap-4">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-teal/15 flex items-center justify-center">
            <Sparkles className="w-5 h-5 text-teal" />
          </div>
          <div>
            <h2 className="text-xl font-bold text-foreground">Review each document</h2>
            <p className="text-sm text-muted-foreground">
              OCR pre-filled fields per file — expand to verify, then submit the batch.
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
        <span className="rounded-full bg-teal/15 text-teal px-3 py-1 font-semibold">
          {counts.approved} to submit
        </span>
        <span className="rounded-full bg-muted text-muted-foreground px-3 py-1 font-semibold">
          {counts.rejected} skipped
        </span>
        <span className="rounded-full bg-muted text-muted-foreground px-3 py-1">
          {reviewStates.length} total
        </span>
      </div>

      <div className="grid gap-4 xl:grid-cols-12">
        <div className="space-y-3 xl:col-span-4">
          {reviewStates.map((state, index) => (
            <BulkDocumentReviewCard
              key={state.documentId}
              state={state}
              documentType={documentType}
              selected={selectedState?.documentId === state.documentId}
              onSelect={() => setSelectedDocumentId(state.documentId)}
              onChange={(next) => updateAt(index, next)}
            />
          ))}
        </div>

        <div className="xl:col-span-8">
          <div className="sticky top-4 border border-[#C8CDD2] bg-white shadow-sm">
            <div className="border-b border-[#C8CDD2] bg-[#F5F7F8] px-3 py-2">
              <p className="text-sm font-bold text-[#1F2933]">Review preview</p>
              <p className="truncate text-xs text-[#5E6870]">{selectedState?.fileName || "Select a document"}</p>
            </div>
            <div className="bg-[#EDEDED] p-3">
              {selectedPreview?.url && selectedPreview.kind === "pdf" ? (
                <iframe src={selectedPreview.url} title="Bulk review preview" className="h-[calc(100vh-220px)] w-full border border-[#C8CDD2] bg-white" />
              ) : selectedPreview?.url && selectedPreview.kind === "image" ? (
                <div className="flex h-[calc(100vh-220px)] items-center justify-center overflow-auto border border-[#C8CDD2] bg-white">
                  <img src={selectedPreview.url} alt="Bulk review preview" className="max-h-full max-w-full object-contain" />
                </div>
              ) : (
                <div className="flex h-[calc(100vh-220px)] flex-col items-center justify-center border border-dashed border-[#C8CDD2] bg-white text-center">
                  <FileText className="mb-3 h-12 w-12 text-[#5E6870]" />
                  <p className="text-sm font-semibold text-[#1F2933]">Preview unavailable for this format</p>
                  <p className="mt-1 max-w-xs text-xs text-[#5E6870]">Use the extracted fields on the left to complete review.</p>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      <div className="flex gap-4 pt-4 border-t border-border">
        <button
          type="button"
          onClick={onSubmit}
          disabled={isSubmitting || reviewStates.length === 0}
          className="flex-1 flex items-center justify-center gap-2 text-base py-3 rounded-xl font-semibold bg-teal text-teal-foreground hover:bg-teal/90 transition-all disabled:opacity-50"
          style={{ boxShadow: "var(--shadow-elegant)" }}
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
