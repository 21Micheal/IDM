import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ScanLine, Loader2, ArrowRight, Info, CheckCircle, AlertCircle,
} from "lucide-react";
import { toast } from "@/components/ui/vault-toast";
import {
  bulkUploadAPI,
  documentTypesAPI,
  normalizeListResponse,
} from "@/services/api";
import type { DocumentType } from "@/types";
import { QUERY_FIVE_MIN_STALE } from "@/lib/reactQueryDefaults";
import { deriveDocumentTypeConfig } from "@/lib/documentTypeConfig";
import BulkUploadDropzone from "@/components/documents/bulk/BulkUploadDropzone";
import BulkProcessingPanel from "@/components/documents/bulk/BulkProcessingPanel";
import BulkReviewPanel from "@/components/documents/bulk/BulkReviewPanel";
import type { BulkDocReviewState, BulkLocalPreview, BulkUploadBatch } from "@/components/documents/bulk/bulkUploadTypes";
import {
  buildReviewStateFromBatchItem,
  reviewStateToSubmitItem,
} from "@/components/documents/bulk/bulkUploadUtils";

type Stage = "select" | "processing" | "review" | "complete";

const POLL_MS = 3000;

export default function BulkScanPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const [stage, setStage] = useState<Stage>("select");
  const [selectedTypeId, setSelectedTypeId] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [batchId, setBatchId] = useState<string | null>(null);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [reviewStates, setReviewStates] = useState<BulkDocReviewState[]>([]);
  const [completedBatch, setCompletedBatch] = useState<BulkUploadBatch | null>(null);
  const [localPreviews, setLocalPreviews] = useState<Record<string, BulkLocalPreview>>({});

  const { data: docTypes = [] } = useQuery<unknown, Error, DocumentType[]>({
    queryKey: ["document-types"],
    queryFn: () => documentTypesAPI.list().then((r) => r.data as unknown),
    select: (data) => normalizeListResponse<DocumentType>(data),
    ...QUERY_FIVE_MIN_STALE,
  });

  const visibleDocTypes = useMemo(
    () => docTypes.filter((type) => !deriveDocumentTypeConfig(type).isPersonalType),
    [docTypes],
  );
  const selectedType = visibleDocTypes.find((t) => t.id === selectedTypeId);

  useEffect(() => {
    const next: Record<string, BulkLocalPreview> = {};
    const urls: string[] = [];

    for (const file of files) {
      const kind = file.type === "application/pdf" ? "pdf" : file.type.startsWith("image/") ? "image" : "other";
      const url = kind === "other" ? null : URL.createObjectURL(file);
      if (url) urls.push(url);
      next[file.name] = {
        fileName: file.name,
        url,
        kind,
        size: file.size,
      };
    }

    setLocalPreviews(next);
    return () => {
      urls.forEach((url) => URL.revokeObjectURL(url));
    };
  }, [files]);

  const { data: polledBatch } = useQuery({
    queryKey: ["bulk-upload", batchId],
    queryFn: () => bulkUploadAPI.status(batchId!).then((r) => r.data as BulkUploadBatch),
    enabled: Boolean(batchId) && (stage === "processing"),
    refetchInterval: (query) => {
      const status = (query.state.data as BulkUploadBatch | undefined)?.status;
      if (status === "review" || status === "completed" || status === "failed") {
        return false;
      }
      return POLL_MS;
    },
  });

  useEffect(() => {
    if (!polledBatch) return;
    if (polledBatch.status === "review") {
      const states = polledBatch.documents.map((doc) =>
        buildReviewStateFromBatchItem(doc, polledBatch.document_type),
      );
      setReviewStates(states);
      setStage("review");
      toast.success("OCR complete — review each document's details.");
    } else if (polledBatch.status === "failed") {
      setStage("select");
      setBatchId(null);
      toast.error("Bulk upload failed. Check your files and try again.");
    }
  }, [polledBatch]);

  const createMutation = useMutation({
    mutationFn: async () => {
      if (!selectedTypeId || files.length === 0) {
        throw new Error("Missing type or files");
      }
      const fd = new FormData();
      fd.append("document_type_id", selectedTypeId);
      fd.append("is_scanned", "true");
      files.forEach((file) => fd.append("files", file));
      const { data } = await bulkUploadAPI.create(fd, {
        onUploadProgress: (e) => {
          if (e.total) setUploadProgress(Math.round((e.loaded * 100) / e.total));
        },
      });
      return data as BulkUploadBatch;
    },
    onSuccess: (data) => {
      setUploadProgress(0);
      setBatchId(data.id);
      if (data.status === "review") {
        const states = data.documents.map((doc) =>
          buildReviewStateFromBatchItem(doc, data.document_type),
        );
        setReviewStates(states);
        setStage("review");
        toast.success("Batch ready for review.");
      } else if (data.status === "failed") {
        toast.error("No files could be uploaded.");
        setStage("select");
      } else {
        setStage("processing");
      }
    },
    onError: () => {
      toast.error("Bulk upload failed. Please try again.");
      setUploadProgress(0);
      setStage("select");
    },
  });

  const reviewMutation = useMutation({
    mutationFn: async () => {
      if (!batchId) throw new Error("No batch");
      const payload = reviewStates.map(reviewStateToSubmitItem);
      const { data } = await bulkUploadAPI.review(batchId, payload);
      return data as BulkUploadBatch;
    },
    onSuccess: (data) => {
      setCompletedBatch(data);
      setStage("complete");
      queryClient.invalidateQueries({ queryKey: ["documents"] });
      toast.success("Batch submitted successfully.");
    },
    onError: () => {
      toast.error("Could not submit the batch. Please try again.");
    },
  });

  const onStartUpload = useCallback(() => {
    if (!selectedTypeId) {
      toast.error("Please select a document type");
      return;
    }
    if (files.length === 0) {
      toast.error("Please add at least one file");
      return;
    }
    setStage("processing");
    createMutation.mutate();
  }, [selectedTypeId, files, createMutation]);

  const activeBatch = polledBatch ?? (createMutation.data as BulkUploadBatch | undefined);

  return (
    <div className="-m-6 min-h-[calc(100vh-3.5rem)] bg-[#EDEDED] text-[#1F2933]">
      <div className="flex h-[69px] items-center justify-between gap-4 bg-[#287EAD] px-5 pr-8 text-white">
        <div className="min-w-0">
          <h1 className="flex items-center gap-2 text-lg font-semibold tracking-tight">
            <ScanLine className="h-5 w-5" />
            Bulk Scan
          </h1>
          <p className="mt-0.5 text-xs text-white/75">
            Upload many documents of the same type. OCR runs on each file; you review metadata per document before submitting.
          </p>
        </div>
        <div className="hidden items-center gap-2 text-xs text-white/80 md:flex">
          <span className="border border-white/30 px-2 py-1">{selectedType?.name || "No type selected"}</span>
          <span className="border border-white/30 px-2 py-1">{files.length} file{files.length === 1 ? "" : "s"}</span>
        </div>
      </div>

      {stage === "select" && (
        <div className="grid grid-cols-1 gap-5 p-5 pr-8 lg:grid-cols-12">
          <div className="space-y-5 lg:col-span-4">
            <div className="border border-[#C8CDD2] bg-white p-5">
              <h2 className="mb-4 font-semibold text-[#1F2933]">1. Document type</h2>
              <select
                value={selectedTypeId}
                onChange={(e) => setSelectedTypeId(e.target.value)}
                className="input w-full"
              >
                <option value="">— Choose document type —</option>
                {visibleDocTypes.map((t) => (
                  <option key={t.id} value={t.id}>{t.name}</option>
                ))}
              </select>
              {selectedType?.description && (
                <p className="mt-3 text-xs text-muted-foreground">{selectedType.description}</p>
              )}
            </div>

            <div className="flex items-start gap-2 border border-[#A7CDE3] bg-[#EEF6FB] p-4 text-xs text-[#287EAD]">
              <Info className="w-4 h-4 flex-shrink-0 mt-0.5" />
              <span>
                Each file gets its own metadata from OCR. You review and approve documents individually before the batch is submitted to workflow.
              </span>
            </div>
          </div>

          <div className="space-y-5 lg:col-span-8">
            <div className="border border-[#C8CDD2] bg-white p-5">
              <h2 className="mb-4 font-semibold text-[#1F2933]">2. Files</h2>
              <BulkUploadDropzone
                files={files}
                onChange={setFiles}
                disabled={createMutation.isPending}
              />
            </div>

            <div className="flex gap-4">
              <button
                type="button"
                onClick={onStartUpload}
                disabled={createMutation.isPending || !selectedTypeId || files.length === 0}
                className="flex flex-1 items-center justify-center gap-2 bg-[#287EAD] py-3 font-semibold text-white hover:bg-[#206D99] disabled:opacity-50"
              >
                {createMutation.isPending ? (
                  <Loader2 className="w-5 h-5 animate-spin" />
                ) : (
                  <>
                    <ScanLine className="w-4 h-4" />
                    Upload &amp; scan batch
                    <ArrowRight className="w-4 h-4" />
                  </>
                )}
              </button>
              <button
                type="button"
                onClick={() => navigate("/documents")}
                className="border border-[#C8CDD2] bg-white px-6 py-3 font-semibold hover:bg-[#EEF3F7]"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {stage === "processing" && activeBatch && (
        <div className="p-5 pr-8">
          <BulkProcessingPanel batch={activeBatch} uploadProgress={uploadProgress} previews={localPreviews} />
        </div>
      )}

      {stage === "review" && selectedType && reviewStates.length > 0 && (
        <div className="p-5 pr-8">
          <BulkReviewPanel
            documentType={polledBatch?.document_type ?? selectedType}
            reviewStates={reviewStates}
            onChange={setReviewStates}
            onSubmit={() => reviewMutation.mutate()}
            isSubmitting={reviewMutation.isPending}
            previews={localPreviews}
          />
        </div>
      )}

      {stage === "complete" && completedBatch && (
        <div className="m-5 mr-8 border border-[#C8CDD2] bg-white p-10 text-center">
          <CheckCircle className="mx-auto mb-4 h-14 w-14 text-[#287EAD]" />
          <h2 className="mb-2 text-2xl font-bold text-[#1F2933]">Batch complete</h2>
          <p className="mb-6 text-[#5E6870]">
            {completedBatch.approved_count} document{completedBatch.approved_count === 1 ? "" : "s"} submitted
            {completedBatch.rejected_count > 0 && (
              <> · {completedBatch.rejected_count} skipped</>
            )}
          </p>
          <div className="flex flex-col sm:flex-row gap-3 justify-center">
            <button
              type="button"
              onClick={() => navigate("/documents")}
              className="bg-[#287EAD] px-6 py-3 font-semibold text-white hover:bg-[#206D99]"
            >
              View documents
            </button>
            <button
              type="button"
              onClick={() => {
                setStage("select");
                setBatchId(null);
                setFiles([]);
                setLocalPreviews({});
                setReviewStates([]);
                setCompletedBatch(null);
              }}
              className="border border-[#C8CDD2] bg-white px-6 py-3 font-semibold hover:bg-[#EEF3F7]"
            >
              Scan another batch
            </button>
          </div>
        </div>
      )}

      {stage === "processing" && !activeBatch && createMutation.isPending && (
        <div className="flex flex-col items-center py-16">
          <Loader2 className="mb-4 h-10 w-10 animate-spin text-[#287EAD]" />
          <p className="font-medium text-[#1F2933]">Starting batch...</p>
        </div>
      )}

      {stage === "review" && reviewStates.length === 0 && (
        <div className="m-5 mr-8 flex items-center gap-2 border border-amber-200 bg-amber-50 p-4 text-amber-700">
          <AlertCircle className="w-5 h-5" />
          No documents available for review.
        </div>
      )}
    </div>
  );
}
