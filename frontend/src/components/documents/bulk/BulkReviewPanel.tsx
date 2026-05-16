import { useMemo } from "react";
import { CheckCircle, Loader2, ArrowRight, Sparkles } from "lucide-react";
import type { DocumentType } from "@/types";
import type { BulkDocReviewState } from "./bulkUploadTypes";
import { countReviewDecisions } from "./bulkUploadUtils";
import BulkDocumentReviewCard from "./BulkDocumentReviewCard";

type Props = {
  documentType: DocumentType;
  reviewStates: BulkDocReviewState[];
  onChange: (states: BulkDocReviewState[]) => void;
  onSubmit: () => void;
  isSubmitting: boolean;
};

export default function BulkReviewPanel({
  documentType,
  reviewStates,
  onChange,
  onSubmit,
  isSubmitting,
}: Props) {
  const counts = useMemo(() => countReviewDecisions(reviewStates), [reviewStates]);

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

      <div className="space-y-3">
        {reviewStates.map((state, index) => (
          <BulkDocumentReviewCard
            key={state.documentId}
            state={state}
            documentType={documentType}
            onChange={(next) => updateAt(index, next)}
          />
        ))}
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
