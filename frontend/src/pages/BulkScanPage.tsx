import { useCallback, useEffect, useMemo, useState } from "react";
import { extractApiError } from "@/lib/apiError";
import { useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ScanLine, Loader2, ArrowRight, Info, CheckCircle, AlertCircle, ArrowLeft,
} from "lucide-react";
import { documentsAPI } from "@/services/api";
import { toast } from "@/components/ui/vault-toast";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  bulkUploadAPI,
  documentTypesAPI,
  normalizeListResponse,
} from "@/services/api";
import type { DocumentType } from "@/types";
import { QUERY_FIVE_MIN_STALE } from "@/lib/reactQueryDefaults";
import CustomListbox from "@/components/ui/CustomListbox";
import { deriveDocumentTypeConfig } from "@/lib/documentTypeConfig";
import BulkUploadDropzone from "@/components/documents/bulk/BulkUploadDropzone";
import BulkProcessingPanel from "@/components/documents/bulk/BulkProcessingPanel";
import BulkReviewPanel from "@/components/documents/bulk/BulkReviewPanel";
import type { BulkDocReviewState, BulkLocalPreview, BulkUploadBatch } from "@/components/documents/bulk/bulkUploadTypes";
import {
  countNeedsManualDocs,
  primaryIdpFailureReason,
  rebuildReviewStatesFromBatch,
  reviewStateToSubmitItem,
} from "@/components/documents/bulk/bulkUploadUtils";
import IdpFailureModal, { type IdpFailureReason } from "@/components/documents/IdpFailureModal";
import { WorkspaceCommandBar } from "@/components/shared/WorkspaceCommandBar";

type Stage = "select" | "processing" | "review" | "complete";

const POLL_MS = 3000;

type BulkScanPageProps = {
  scanMode?: boolean;
  onSingleMode?: () => void;
  /**
   * Open an already-created batch (e.g. from the pending-review queue or email
   * ingestion) and jump straight to its review, instead of starting a new
   * upload. The batch is polled and, once in "review", the per-document review
   * panel renders exactly as for a freshly uploaded batch.
   */
  initialBatchId?: string;
  /**
   * When set, renders a back-navigation link inside the WorkspaceCommandBar
   * instead of a separate header bar (avoids double-bar when opened from
   * the pending-review queue).
   */
  backTo?: { label: string; path: string };
};

async function calculateFileSha256(file: File): Promise<string> {
  const buffer = await file.arrayBuffer();
  const digest = await crypto.subtle.digest("SHA-256", buffer);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export default function BulkScanPage({ scanMode = true, onSingleMode, initialBatchId, backTo }: BulkScanPageProps) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  // When opening an existing batch, start in "processing" so the status poll
  // runs and transitions to "review" on its own.
  const [stage, setStage] = useState<Stage>(initialBatchId ? "processing" : "select");
  const [selectedTypeId, setSelectedTypeId] = useState("");
  const [isRelatedSet, setIsRelatedSet] = useState(false);
  const [autoClassifyBulk, setAutoClassifyBulk] = useState(false);
  const [files, setFiles] = useState<File[]>([]);
  const [batchId, setBatchId] = useState<string | null>(initialBatchId ?? null);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [reviewStates, setReviewStates] = useState<BulkDocReviewState[]>([]);
  const [completedBatch, setCompletedBatch] = useState<BulkUploadBatch | null>(null);
  const [localPreviews, setLocalPreviews] = useState<Record<string, BulkLocalPreview>>({});
  const [duplicateDialogOpen, setDuplicateDialogOpen] = useState(false);
  const [duplicateFiles, setDuplicateFiles] = useState<File[]>([]);
  const [pendingUploadFiles, setPendingUploadFiles] = useState<File[] | null>(null);
  const [isCheckingDuplicates, setIsCheckingDuplicates] = useState(false);
  const [idpModalOpen, setIdpModalOpen] = useState(false);
  const [idpFailureReason, setIdpFailureReason] = useState<IdpFailureReason>("extraction_error");
  const [idpNeedsManualCount, setIdpNeedsManualCount] = useState(0);
  const [idpAllowRegex, setIdpAllowRegex] = useState(false);
  const [idpFallbackPending, setIdpFallbackPending] = useState(false);
  const [pendingReviewBatch, setPendingReviewBatch] = useState<BulkUploadBatch | null>(null);

  const { data: docTypes = [] } = useQuery<unknown, Error, DocumentType[]>({
    queryKey: ["document-types"],
    queryFn: () => documentTypesAPI.list().then((r) => r.data as unknown),
    select: (data) => normalizeListResponse<DocumentType>(data),
    ...QUERY_FIVE_MIN_STALE,
  });

  const visibleDocTypes = useMemo(
    // A type with no primary template may still route via amount-based rules,
    // so don't hide it here; the "no workflow" case is reported at submission.
    () => docTypes.filter((type) =>
      !deriveDocumentTypeConfig(type).isPersonalType && type.code !== "UNCLASS"
    ),
    [docTypes],
  );
  const selectedType = visibleDocTypes.find((t) => t.id === selectedTypeId);
  const isUntypedBatch = isRelatedSet || autoClassifyBulk;

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

  const enterReview = useCallback((batch: BulkUploadBatch) => {
    const needsManual = countNeedsManualDocs(batch.documents);
    const askOnFailure = false;

    if (needsManual > 0 && askOnFailure) {
      setIdpFailureReason(primaryIdpFailureReason(batch.documents) as IdpFailureReason);
      setIdpNeedsManualCount(needsManual);
      setIdpAllowRegex(Boolean(batch.idp_policy?.allow_regex_fallback));
      setPendingReviewBatch(batch);
      setIdpModalOpen(true);
      return;
    }

    const states = rebuildReviewStatesFromBatch(batch, visibleDocTypes);
    setReviewStates(states);
    setStage("review");
    if (needsManual > 0) {
      toast.warning(
        `${needsManual} document${needsManual === 1 ? "" : "s"} need manual metadata — Claude extraction was unavailable.`,
      );
    } else {
      toast.success(scanMode ? "OCR complete — review each document's details." : "Batch ready — review each document's details.");
    }
  }, [scanMode, visibleDocTypes]);

  useEffect(() => {
    if (!polledBatch) return;
    if (polledBatch.status === "review") {
      enterReview(polledBatch);
    } else if (polledBatch.status === "failed") {
      setStage("select");
      setBatchId(null);
      toast.error("Bulk upload failed. Check your files and try again.");
    }
  }, [polledBatch, enterReview]);

  const handleBatchIdpManual = useCallback(() => {
    if (!pendingReviewBatch) return;
    setIdpModalOpen(false);
    const states = rebuildReviewStatesFromBatch(pendingReviewBatch, visibleDocTypes);
    setReviewStates(states);
    setStage("review");
    setPendingReviewBatch(null);
    toast.info(`Fill metadata manually for ${idpNeedsManualCount} document${idpNeedsManualCount === 1 ? "" : "s"}.`);
  }, [pendingReviewBatch, visibleDocTypes, idpNeedsManualCount]);

  const handleBatchIdpRegex = useCallback(async () => {
    if (!pendingReviewBatch?.id) return;
    setIdpFallbackPending(true);
    try {
      const { data } = await bulkUploadAPI.ocrFallback(pendingReviewBatch.id);
      setIdpModalOpen(false);
      setPendingReviewBatch(null);
      const states = rebuildReviewStatesFromBatch(data as BulkUploadBatch, visibleDocTypes);
      setReviewStates(states);
      setStage("review");
      toast.warning("Pattern matching applied — verify every field before submitting.");
    } catch (err) {
      toast.error(extractApiError(err, "Pattern matching failed for this batch."));
    } finally {
      setIdpFallbackPending(false);
    }
  }, [pendingReviewBatch, visibleDocTypes]);

  const createMutation = useMutation({
    mutationFn: async (uploadFiles?: File[]) => {
      const effectiveFiles = uploadFiles ?? files;
      if ((!selectedTypeId && !isUntypedBatch) || effectiveFiles.length === 0) {
        throw new Error("Missing type or files");
      }
      const fd = new FormData();
      if (!isUntypedBatch) fd.append("document_type_id", selectedTypeId);
      fd.append("related_set", isUntypedBatch ? "true" : "false");
      fd.append("auto_classify", autoClassifyBulk ? "true" : "false");
      fd.append("is_scanned", scanMode ? "true" : "false");
      effectiveFiles.forEach((file) => fd.append("files", file));
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
        enterReview(data);
      } else if (data.status === "failed") {
        toast.error("No files could be uploaded.");
        setStage("select");
      } else {
        setStage("processing");
      }
    },
    onError: (err) => {
      toast.error(extractApiError(err, "Bulk upload failed. Please try again."));
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
    onError: (err) => {
      toast.error(extractApiError(err, "Could not submit the batch. Please try again."));
    },
  });

  const cancelMutation = useMutation({
    mutationFn: async () => {
      if (!batchId) throw new Error("No batch");
      const { data } = await bulkUploadAPI.cancel(batchId);
      return data as BulkUploadBatch;
    },
    onSuccess: () => {
      setStage("select");
      setBatchId(null);
      setFiles([]);
      setReviewStates([]);
      setCompletedBatch(null);
      setLocalPreviews({});
      toast.success("Review canceled and draft batch discarded.");
    },
    onError: (err) => {
      toast.error(extractApiError(err, "Could not cancel the review. Please try again."));
    },
  });

  const uploadFiles = useCallback((uploadList: File[]) => {
    setStage("processing");
    createMutation.mutate(uploadList);
  }, [createMutation]);

  const onStartUpload = useCallback(async () => {
    if (!selectedTypeId && !isUntypedBatch) {
      toast.error("Please select a document type or enable auto-classification");
      return;
    }
    if (files.length === 0) {
      toast.error("Please add at least one file");
      return;
    }

    setIsCheckingDuplicates(true);
    try {
      const checksums = await Promise.all(files.map((f) => calculateFileSha256(f)));
      const checks = await Promise.all(checksums.map((cs) =>
        documentsAPI.duplicateCheck(cs).then((r) => r.data).catch(() => null),
      ));

      const existingFiles = files.filter((_, i) => checks[i] && checks[i].exists);
      const remainingFiles = files.filter((_, i) => !(checks[i] && checks[i].exists));

      if (existingFiles.length > 0) {
        setDuplicateFiles(existingFiles);
        setPendingUploadFiles(remainingFiles);
        setDuplicateDialogOpen(true);
        return;
      }
    } catch {
      // If the advisory duplicate check fails, fall back to normal upload flow.
    } finally {
      setIsCheckingDuplicates(false);
    }

    uploadFiles(files);
  }, [selectedTypeId, isUntypedBatch, files, uploadFiles]);

  const confirmSkipDuplicates = useCallback(() => {
    if (!pendingUploadFiles || pendingUploadFiles.length === 0) {
      toast.error("No new files to upload after skipping duplicates.");
      setDuplicateDialogOpen(false);
      return;
    }

    setFiles(pendingUploadFiles);
    uploadFiles(pendingUploadFiles);
    setDuplicateDialogOpen(false);
  }, [pendingUploadFiles, uploadFiles]);

  const cancelDuplicateUpload = useCallback(() => {
    toast.info("Upload cancelled.");
    setDuplicateDialogOpen(false);
  }, []);

  const activeBatch = polledBatch ?? (createMutation.data as BulkUploadBatch | undefined);

  return (
    <>
    <IdpFailureModal
      open={idpModalOpen}
      reason={idpFailureReason}
      allowRegex={idpAllowRegex}
      pending={idpFallbackPending}
      documentCount={idpNeedsManualCount}
      onManual={handleBatchIdpManual}
      onRegex={idpAllowRegex ? handleBatchIdpRegex : undefined}
    />
    <div className="flex h-full flex-col bg-[#EDEDED] text-[#1F2933]">
      <WorkspaceCommandBar
        actions={
          <div className="hidden items-center gap-3 text-xs text-white/80 md:flex">
            <span className="border border-white/30 px-2 py-1">
              {autoClassifyBulk ? "Auto classify" : isRelatedSet ? "Related set" : selectedType?.name || "No type selected"}
            </span>
            <span className="border border-white/30 px-2 py-1">{files.length} file{files.length === 1 ? "" : "s"}</span>
          </div>
        }
      >
        {backTo ? (
          /* Opened from the review queue: show back link + page title in one bar */
          <div className="flex min-w-0 items-center gap-3">
            <button
              type="button"
              onClick={() => navigate(backTo.path)}
              className="flex shrink-0 items-center gap-1.5 rounded px-2 py-1 text-sm font-medium text-white/80 transition hover:bg-white/10 hover:text-white"
            >
              <ArrowLeft className="h-4 w-4" />
              {backTo.label}
            </button>
            <span className="text-white/30">|</span>
            <div className="min-w-0">
              <h1 className="flex items-center gap-2 text-base font-semibold tracking-tight">
                <ScanLine className="h-4 w-4 shrink-0" />
                <span className="truncate">Batch review</span>
              </h1>
            </div>
          </div>
        ) : (
          <div className="min-w-0">
            <h1 className="flex items-center gap-2 text-lg font-semibold tracking-tight">
              <ScanLine className="h-5 w-5" />
              {scanMode ? "Bulk Scan" : "Bulk Upload"}
            </h1>
            <p className="mt-0.5 text-xs text-white/75">
              {scanMode
                ? "Upload same-type batches, mixed auto-classified files, or related procurement sets. OCR runs per file before review."
                : "Upload several files, preview each one, then choose its type and details during review."}
            </p>
          </div>
        )}
      </WorkspaceCommandBar>

      <div className="scrollbar-minimal min-h-0 flex-1 overflow-y-auto">

      <Dialog open={duplicateDialogOpen} onOpenChange={setDuplicateDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Duplicate files detected</DialogTitle>
            <DialogDescription>
              Some files already exist in the system. If you continue, duplicate files will be skipped and only new files will be uploaded.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3">
            <p className="text-sm text-[#475569]">
              Found {duplicateFiles.length} duplicate file{duplicateFiles.length === 1 ? "" : "s"} out of {duplicateFiles.length + (pendingUploadFiles?.length ?? 0)} selected.
              {pendingUploadFiles && pendingUploadFiles.length > 0 ? " Duplicate files will be skipped." : ""}
            </p>
            <div className="rounded-xl border border-[#C8CDD2] bg-[#F7F8F9] p-4 text-sm text-[#1F2933] max-h-48 overflow-y-auto">
              <p className="mb-2 font-semibold">Files that already exist:</p>
              <ul className="list-disc space-y-1 pl-5">
                {duplicateFiles.slice(0, 10).map((file) => (
                  <li key={`${file.name}-${file.size}`}>{file.name}</li>
                ))}
                {duplicateFiles.length > 10 && (
                  <li className="text-muted-foreground">
                    and {duplicateFiles.length - 10} more duplicate file{duplicateFiles.length - 10 === 1 ? "" : "s"}
                  </li>
                )}
              </ul>
            </div>
            <p className="text-sm text-[#475569]">
              {pendingUploadFiles && pendingUploadFiles.length === 0
                ? "All selected files already exist, so no new files can be uploaded."
                : `Skipping ${duplicateFiles.length} duplicate file${duplicateFiles.length === 1 ? "" : "s"}.`}
            </p>
          </div>

          <DialogFooter className="mt-4 gap-2">
            <button
              type="button"
              onClick={cancelDuplicateUpload}
              className="btn-secondary"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={confirmSkipDuplicates}
              className="btn-primary"
            >
              {pendingUploadFiles && pendingUploadFiles.length === 0
                ? "Close"
                : "Skip duplicates and continue"}
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {stage === "select" && (
        <div className="grid grid-cols-1 gap-5 p-5 pr-0 lg:grid-cols-12">
          <div className="space-y-5 lg:col-span-4">
            <div className="border border-[#C8CDD2] bg-white p-5">
              <h2 className="mb-4 font-semibold text-[#1F2933]">1. Batch mode</h2>
              {onSingleMode && (
                <label className="mb-3 hidden cursor-pointer items-center gap-2 border border-[#D3D7DA] bg-[#F7F8F9] px-3 py-2 text-sm text-[#1F2933] md:hidden">
                  <input
                    type="checkbox"
                    checked
                    onChange={(event) => {
                      if (!event.target.checked) onSingleMode();
                    }}
                  />
                  Use bulk mode
                </label>
              )}
              <label className="mb-4 flex cursor-pointer items-center gap-2 text-sm text-[#1F2933]">
                <input
                  type="checkbox"
                  checked={isRelatedSet}
                  onChange={(event) => {
                    setIsRelatedSet(event.target.checked);
                    if (event.target.checked) {
                      setSelectedTypeId("");
                      setAutoClassifyBulk(false);
                    }
                  }}
                />
                Related document set
              </label>
              {scanMode && (
                <label className="mb-4 flex cursor-pointer items-center gap-2 text-sm text-[#1F2933]">
                  <input
                    type="checkbox"
                    checked={autoClassifyBulk}
                    onChange={(event) => {
                      setAutoClassifyBulk(event.target.checked);
                      if (event.target.checked) {
                        setSelectedTypeId("");
                        setIsRelatedSet(false);
                      }
                    }}
                  />
                  Auto classify document types
                </label>
              )}
              {isRelatedSet && (
                <p className="mb-3 border border-[#A7CDE3] bg-[#EEF6FB] px-3 py-2 text-xs text-[#287EAD]">
                  Use this for PO, invoice, GRN, and support files in one packet. Each document type is confirmed during review.
                </p>
              )}
              {autoClassifyBulk && (
                <p className="mb-3 border border-[#A7CDE3] bg-[#EEF6FB] px-3 py-2 text-xs text-[#287EAD]">
                  Upload mixed invoices, POs, GRNs, and other business documents. IDP will classify each file before extracting that type&apos;s metadata.
                </p>
              )}
              <CustomListbox
                value={selectedTypeId}
                onChange={(value) => {
                  setSelectedTypeId(value);
                  if (value) {
                    setAutoClassifyBulk(false);
                    setIsRelatedSet(false);
                  }
                }}
                options={[
                  { value: "", label: autoClassifyBulk
                      ? "Auto classify each document"
                      : isRelatedSet
                      ? scanMode ? "Auto classify during review" : "Choose type during review"
                      : "— Choose document type —" },
                  ...visibleDocTypes.map((t) => ({ value: t.id, label: t.name })),
                ]}
                disabled={isUntypedBatch}
                buttonClassName="input w-full disabled:bg-[#EEF3F7] disabled:text-[#7A858E]"
                ariaLabel="Document type selector"
              />
              {autoClassifyBulk ? (
                <p className="mt-3 border-t border-[#D3D7DA] pt-3 text-xs text-[#5E6870]">
                  Claude classifies each file first, then extracts using the matched document type&apos;s configured metadata fields. Uncertain files stay available for manual type selection in review.
                </p>
              ) : isRelatedSet ? (
                <p className="mt-3 border-t border-[#D3D7DA] pt-3 text-xs text-[#5E6870]">
                  {scanMode
                    ? "OCR will classify each file and extract supplier, PO reference, amount, and dates during review."
                    : "After upload, select each file to see its preview, then choose its type and fill the fields."}
                </p>
              ) : selectedType?.description && (
                <p className="mt-3 text-xs text-muted-foreground">{selectedType.description}</p>
              )}
            </div>

            <div className="flex items-start gap-2 border border-[#A7CDE3] bg-[#EEF6FB] p-4 text-xs text-[#287EAD]">
              <Info className="w-4 h-4 flex-shrink-0 mt-0.5" />
              <span>
                {autoClassifyBulk
                  ? "Mixed batches are classified per file before review. Confirm every suggested type and metadata field before submitting."
                  : isRelatedSet
                  ? scanMode
                    ? "Related sets are classified one document at a time. Confirm the suggested type and fields before the system links matching PO references."
                    : "Related uploads are reviewed one document at a time. The system links matching PO references after you confirm the details."
                  : scanMode
                    ? "Each file gets its own metadata from OCR. You review and approve documents individually before the batch is submitted to workflow."
                    : "Each file is reviewed with its preview. Fill the details before the batch is submitted to workflow."}
              </span>
            </div>

            {/* Bulk mode toggle — always visible so users know they're in bulk mode */}
            <label className="inline-flex cursor-pointer items-center gap-2 text-sm text-[#1F2933]">
              <input
                type="checkbox"
                checked
                onChange={(event) => {
                  if (!event.target.checked && onSingleMode) onSingleMode();
                }}
                className="h-4 w-4 accent-[#287EAD]"
              />
              Use bulk mode
            </label>
          </div>

          <div className="space-y-5 lg:col-span-8">
            <div className="border border-[#C8CDD2] bg-white p-5">
              <h2 className="mb-4 font-semibold text-[#1F2933]">2. Files</h2>
              <BulkUploadDropzone
                files={files}
                onChange={setFiles}
                disabled={createMutation.isPending}
                onLimitExceeded={(maxFiles) => toast.warning(`You can upload up to ${maxFiles} files in one batch. Extra files were not added.`)}
              />
            </div>

            <div className="flex flex-wrap gap-3">
              <button
                type="button"
                onClick={onStartUpload}
                disabled={createMutation.isPending || isCheckingDuplicates || (!selectedTypeId && !isUntypedBatch) || files.length === 0}
                className="inline-flex items-center justify-center gap-2 bg-[#287EAD] px-4 py-2 text-sm font-semibold text-white hover:bg-[#206D99] disabled:opacity-50"
              >
                {createMutation.isPending || isCheckingDuplicates ? (
                  <>
                    <Loader2 className="w-5 h-5 animate-spin" />
                    {isCheckingDuplicates ? "Checking files…" : "Uploading…"}
                  </>
                ) : (
                  <>
                    <ScanLine className="w-4 h-4" />
                    {autoClassifyBulk
                      ? "Upload & classify batch"
                      : isRelatedSet
                      ? scanMode ? "Upload & classify set" : "Upload related set"
                      : scanMode ? "Upload & scan batch" : "Upload batch"}
                    <ArrowRight className="w-4 h-4" />
                  </>
                )}
              </button>
              <button
                type="button"
                onClick={() => navigate("/documents")}
                className="border border-[#C8CDD2] bg-white px-4 py-2 text-sm font-semibold hover:bg-[#EEF3F7]"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {stage === "processing" && activeBatch && (
        <div className="p-5 pr-0">
          <BulkProcessingPanel
            batch={activeBatch}
            uploadProgress={uploadProgress}
            previews={localPreviews}
            scanMode={scanMode}
          />
        </div>
      )}

      {stage === "review" && (selectedType || isUntypedBatch || polledBatch?.document_type) && reviewStates.length > 0 && (
        <div className="p-5 pr-0">
          <BulkReviewPanel
            documentType={polledBatch?.document_type ?? selectedType ?? visibleDocTypes[0]}
            documentTypes={visibleDocTypes}
            isRelatedSet={isUntypedBatch || polledBatch?.mode === "related_set"}
            scanMode={scanMode}
            reviewStates={reviewStates}
            onChange={setReviewStates}
            onSubmit={() => reviewMutation.mutate()}
            onCancel={() => {
              if (window.confirm("Cancel this review and discard the draft batch?")) {
                cancelMutation.mutate();
              }
            }}
            isSubmitting={reviewMutation.isPending}
            isCancelling={cancelMutation.isPending}
            previews={localPreviews}
          />
        </div>
      )}

      {stage === "complete" && completedBatch && (
        <div className="m-5 mr-0 border border-[#C8CDD2] bg-white p-10 text-center">
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
              {scanMode ? "Scan another batch" : "Upload another batch"}
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
        <div className="m-5 mr-0 flex items-center gap-2 border border-amber-200 bg-amber-50 p-4 text-amber-700">
          <AlertCircle className="w-5 h-5" />
          No documents available for review.
        </div>
      )}
      </div>
    </div>
    </>
  );
}
