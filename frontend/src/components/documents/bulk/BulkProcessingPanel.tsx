import { Loader2, ScanLine } from "lucide-react";
import type { BulkUploadBatch } from "./bulkUploadTypes";

type Props = {
  batch: BulkUploadBatch;
  uploadProgress?: number;
};

export default function BulkProcessingPanel({ batch, uploadProgress }: Props) {
  const ocr = batch.ocr_progress;
  const ocrDone = (ocr?.done ?? 0) + (ocr?.failed ?? 0);
  const ocrTotal = ocr?.total ?? batch.successful_uploads;
  const ocrPct = ocrTotal > 0 ? Math.round((ocrDone / ocrTotal) * 100) : 0;

  const statusLabel =
    batch.status === "uploading" ? "Uploading files…"
    : batch.status === "processing" ? "Running OCR on each document…"
    : batch.status === "pending" ? "Preparing batch…"
    : "Processing…";

  return (
    <div className="bg-card rounded-2xl border border-teal/30 p-10 text-center" style={{ boxShadow: "var(--shadow-card)" }}>
      <div className="relative w-20 h-20 mx-auto mb-6">
        <div className="absolute inset-0 rounded-full bg-teal/10 animate-ping" />
        <div className="relative w-20 h-20 rounded-full bg-teal/15 flex items-center justify-center">
          <ScanLine className="w-9 h-9 text-teal" />
        </div>
      </div>
      <h2 className="text-2xl font-bold text-foreground mb-2">{statusLabel}</h2>
      <p className="text-muted-foreground max-w-md mx-auto mb-6">
        {batch.document_type?.name} · {batch.successful_uploads} of {batch.total_files} uploaded
        {batch.failed_uploads > 0 && (
          <span className="text-amber-600"> · {batch.failed_uploads} failed</span>
        )}
      </p>

      {batch.status === "uploading" && uploadProgress != null && uploadProgress > 0 && (
        <div className="max-w-md mx-auto mb-6">
          <div className="flex justify-between text-xs text-muted-foreground mb-1.5">
            <span>Upload progress</span>
            <span className="font-semibold text-foreground">{uploadProgress}%</span>
          </div>
          <div className="h-2.5 bg-muted rounded-full overflow-hidden">
            <div className="h-full bg-teal transition-all" style={{ width: `${uploadProgress}%` }} />
          </div>
        </div>
      )}

      {batch.status === "processing" && ocrTotal > 0 && (
        <div className="max-w-md mx-auto mb-6">
          <div className="flex justify-between text-xs text-muted-foreground mb-1.5">
            <span>OCR progress</span>
            <span className="font-semibold text-foreground">
              {ocrDone} / {ocrTotal} ({ocrPct}%)
            </span>
          </div>
          <div className="h-2.5 bg-muted rounded-full overflow-hidden">
            <div className="h-full bg-teal transition-all" style={{ width: `${ocrPct}%` }} />
          </div>
          {(ocr?.pending ?? 0) > 0 && (
            <p className="text-xs text-muted-foreground mt-2 flex items-center justify-center gap-1">
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
              {ocr?.pending ?? 0} still processing
            </p>
          )}
        </div>
      )}

      <p className="text-sm text-muted-foreground">
        You will review and confirm metadata for each document when OCR finishes.
      </p>
    </div>
  );
}
