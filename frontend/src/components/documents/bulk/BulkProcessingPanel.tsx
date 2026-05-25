import { FileText, Loader2, ScanLine } from "lucide-react";
import type { BulkLocalPreview, BulkUploadBatch } from "./bulkUploadTypes";

type Props = {
  batch: BulkUploadBatch;
  uploadProgress?: number;
  previews?: Record<string, BulkLocalPreview>;
};

function ProcessingPreview({ preview }: { preview?: BulkLocalPreview }) {
  return (
    <div className="border border-[#C8CDD2] bg-white shadow-sm">
      <div className="border-b border-[#C8CDD2] bg-[#F5F7F8] px-3 py-2">
        <p className="text-sm font-bold text-[#1F2933]">Live document preview</p>
        <p className="truncate text-xs text-[#5E6870]">{preview?.fileName || "Waiting for first file"}</p>
      </div>
      <div className="bg-[#EDEDED] p-3">
        {preview?.url && preview.kind === "pdf" ? (
          <iframe src={preview.url} title="Processing preview" className="h-[30rem] w-full border border-[#C8CDD2] bg-white" />
        ) : preview?.url && preview.kind === "image" ? (
          <div className="flex h-[30rem] items-center justify-center overflow-auto border border-[#C8CDD2] bg-white">
            <img src={preview.url} alt="Processing preview" className="max-h-full max-w-full object-contain" />
          </div>
        ) : (
          <div className="flex h-[30rem] flex-col items-center justify-center border border-dashed border-[#C8CDD2] bg-white text-center">
            <FileText className="mb-3 h-12 w-12 text-[#5E6870]" />
            <p className="text-sm font-semibold text-[#1F2933]">Preview unavailable for this format</p>
            <p className="mt-1 max-w-xs text-xs text-[#5E6870]">OCR continues in the background.</p>
          </div>
        )}
      </div>
    </div>
  );
}

export default function BulkProcessingPanel({ batch, uploadProgress, previews = {} }: Props) {
  const ocr = batch.ocr_progress;
  const ocrDone = (ocr?.done ?? 0) + (ocr?.failed ?? 0);
  const ocrTotal = ocr?.total ?? batch.successful_uploads;
  const ocrPct = ocrTotal > 0 ? Math.round((ocrDone / ocrTotal) * 100) : 0;
  const firstPreview = Object.values(previews)[0];

  const statusLabel =
    batch.status === "uploading" ? "Uploading files…"
    : batch.status === "processing" ? "Running OCR on each document…"
    : batch.status === "pending" ? "Preparing batch…"
    : "Processing…";

  return (
    <div className="grid gap-4 lg:grid-cols-12">
      <div className="lg:col-span-7">
        <ProcessingPreview preview={firstPreview} />
      </div>
      <div className="border border-[#C8CDD2] bg-white p-8 text-center shadow-sm lg:col-span-5">
        <div className="relative mx-auto mb-6 h-20 w-20">
          <div className="absolute inset-0 bg-[#EEF6FB] animate-ping" />
          <div className="relative flex h-20 w-20 items-center justify-center bg-[#EEF6FB]">
            <ScanLine className="h-9 w-9 text-[#287EAD]" />
          </div>
        </div>
        <h2 className="mb-2 text-2xl font-bold text-[#1F2933]">{statusLabel}</h2>
        <p className="mx-auto mb-6 max-w-md text-[#5E6870]">
          {batch.document_type?.name} · {batch.successful_uploads} of {batch.total_files} uploaded
          {batch.failed_uploads > 0 && (
            <span className="text-amber-700"> · {batch.failed_uploads} failed</span>
          )}
        </p>

      {batch.status === "uploading" && uploadProgress != null && uploadProgress > 0 && (
        <div className="mx-auto mb-6 max-w-md">
          <div className="mb-1.5 flex justify-between text-xs text-[#5E6870]">
            <span>Upload progress</span>
            <span className="font-semibold text-[#1F2933]">{uploadProgress}%</span>
          </div>
          <div className="h-2.5 overflow-hidden bg-[#E1E5E8]">
            <div className="h-full bg-[#287EAD] transition-all" style={{ width: `${uploadProgress}%` }} />
          </div>
        </div>
      )}

      {batch.status === "processing" && ocrTotal > 0 && (
        <div className="mx-auto mb-6 max-w-md">
          <div className="mb-1.5 flex justify-between text-xs text-[#5E6870]">
            <span>OCR progress</span>
            <span className="font-semibold text-[#1F2933]">
              {ocrDone} / {ocrTotal} ({ocrPct}%)
            </span>
          </div>
          <div className="h-2.5 overflow-hidden bg-[#E1E5E8]">
            <div className="h-full bg-[#287EAD] transition-all" style={{ width: `${ocrPct}%` }} />
          </div>
          {(ocr?.pending ?? 0) > 0 && (
            <p className="mt-2 flex items-center justify-center gap-1 text-xs text-[#5E6870]">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              {ocr?.pending ?? 0} still processing
            </p>
          )}
        </div>
      )}

        <p className="text-sm text-[#5E6870]">
          You will review and confirm metadata for each document when OCR finishes.
        </p>
      </div>
    </div>
  );
}
