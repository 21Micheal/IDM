import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { extractApiError } from "@/lib/apiError";
import { useMutation } from "@tanstack/react-query";
import { Upload, File as FileIcon, Loader2, X } from "lucide-react";
import { clsx } from "clsx";
import { toast } from "@/components/ui/vault-toast";

import { documentsAPI } from "@/services/api";
import {
  ACCEPTED_UPLOAD_FORMATS, SUPPORTED_FORMATS_LABEL, mbToBytes, formatBytes,
} from "@/lib/uploadFormats";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";

interface UploadVersionDrawerProps {
  documentId: string;
  currentVersion: number;
  accept?: Record<string, string[]>;
  /** Max upload size (MB) for this document's type; enforced + shown. */
  maxSizeMb?: number;
  onVersionUploaded: () => void;
  /** Optional override for the trigger button label. */
  triggerLabel?: string;
  /** Optional className applied to the trigger button. */
  triggerClassName?: string;
  /** Optional className applied to the trigger icon. */
  triggerIconClassName?: string;
  /** Disable the trigger (e.g. when the document isn't locked by the user). */
  disabled?: boolean;
  /** Tooltip shown on the trigger (e.g. why it's disabled). */
  triggerTitle?: string;
}

type DuplicateCheckResult = {
  file: File;
  exists: boolean;
  identicalToCurrent: boolean;
};

async function calculateFileSha256(file: File): Promise<string> {
  const buffer = await file.arrayBuffer();
  const digest = await crypto.subtle.digest("SHA-256", buffer);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Upload a new version of a document.
 *
 * Renders as a single regular button. Clicking it opens a modal where the user
 * picks a file and writes the change summary (comments). The summary is saved
 * together with the new version on submit.
 *
 * The exported name is kept (`UploadVersionDrawer`) so existing imports
 * across the codebase keep working.
 */
export function UploadVersionDrawer({
  documentId,
  currentVersion,
  accept,
  maxSizeMb,
  onVersionUploaded,
  triggerLabel,
  triggerClassName,
  triggerIconClassName,
  disabled = false,
  triggerTitle,
}: UploadVersionDrawerProps) {
  const [open, setOpen] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [summary, setSummary] = useState("");
  const [progress, setProgress] = useState(0);
  const [isCheckingDuplicate, setIsCheckingDuplicate] = useState(false);
  const [isIdenticalToCurrent, setIsIdenticalToCurrent] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const duplicateCheckRunRef = useRef(0);
  const duplicateCheckResultRef = useRef<DuplicateCheckResult | null>(null);

  const acceptMap = useMemo(() => accept ?? ACCEPTED_UPLOAD_FORMATS, [accept]);
  const maxBytes = mbToBytes(maxSizeMb);
  const acceptAttr = useMemo(
    () => Object.entries(acceptMap).flatMap(([mime, extensions]) => [mime, ...extensions]).join(","),
    [acceptMap]
  );

  const resetState = useCallback(() => {
    duplicateCheckRunRef.current += 1;
    duplicateCheckResultRef.current = null;
    setFile(null);
    setSummary("");
    setProgress(0);
    setIsCheckingDuplicate(false);
    setIsIdenticalToCurrent(false);
  }, []);

  const setSelectedFile = useCallback(async (nextFile: File | null) => {
    // Validate format + size (drag-drop bypasses the input's accept filter).
    if (nextFile) {
      const name = nextFile.name.toLowerCase();
      const exts = Object.values(acceptMap).flat();
      const okType = Object.keys(acceptMap).includes(nextFile.type) || exts.some((e) => name.endsWith(e));
      if (!okType) { toast.error(`Unsupported format. Allowed: ${SUPPORTED_FORMATS_LABEL}.`); return; }
      if (nextFile.size > maxBytes) { toast.error(`File is too large. The maximum is ${formatBytes(maxBytes)}.`); return; }
    }
    const checkRun = duplicateCheckRunRef.current + 1;
    duplicateCheckRunRef.current = checkRun;
    duplicateCheckResultRef.current = null;
    setFile(nextFile);
    setIsIdenticalToCurrent(false);
    if (!nextFile) {
      setIsCheckingDuplicate(false);
      return;
    }
    setProgress(0);
    setIsCheckingDuplicate(true);
    try {
      const checksum = await calculateFileSha256(nextFile);
      const { data: duplicateInfo } = await documentsAPI.duplicateCheck(checksum, documentId);
      if (duplicateCheckRunRef.current !== checkRun) return;

      const identicalToCurrent = Boolean(duplicateInfo.identical_to_current);
      duplicateCheckResultRef.current = {
        file: nextFile,
        exists: Boolean(duplicateInfo.exists),
        identicalToCurrent,
      };
      setIsIdenticalToCurrent(identicalToCurrent);
    } catch {
      if (duplicateCheckRunRef.current !== checkRun) return;
      duplicateCheckResultRef.current = null;
      setIsIdenticalToCurrent(false);
    } finally {
      if (duplicateCheckRunRef.current === checkRun) {
        setIsCheckingDuplicate(false);
      }
    }
  }, [documentId, acceptMap, maxBytes]);

  // Reset whenever the dialog closes.
  useEffect(() => {
    if (!open) resetState();
  }, [open, resetState]);

  const handleFileSelect = useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
    const nextFile = event.target.files?.[0] ?? null;
    void setSelectedFile(nextFile);
  }, [setSelectedFile]);

  const handleDrop = useCallback((event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    const nextFile = event.dataTransfer.files?.[0] ?? null;
    void setSelectedFile(nextFile);
  }, [setSelectedFile]);

  const mutation = useMutation({
    mutationFn: (formData: FormData) =>
      documentsAPI.uploadVersion(documentId, formData, {
        onUploadProgress: (e: any) => {
          if (e.total) {
            setProgress(Math.round((e.loaded * 100) / e.total));
          }
        },
      }),
    onSuccess: () => {
      toast.success(`Version ${currentVersion + 1} uploaded successfully`);
      onVersionUploaded();
      setOpen(false);
    },
    onError: (error: any) => {
      toast.error(extractApiError(error, "Upload failed"));
      setProgress(0);
    },
  });

  const handleUpload = async () => {
    if (!file) return;
    if (mutation.isPending || isCheckingDuplicate || isIdenticalToCurrent) return;

    try {
      const previousCheck = duplicateCheckResultRef.current;
      const duplicateInfo = previousCheck?.file === file
        ? {
            exists: previousCheck.exists,
            identical_to_current: previousCheck.identicalToCurrent,
          }
        : (await documentsAPI.duplicateCheck(await calculateFileSha256(file), documentId)).data;

      if (duplicateInfo.identical_to_current) {
        setIsIdenticalToCurrent(true);
        toast.error("This file is identical to the current version.");
        return;
      }
      if (duplicateInfo.exists) {
        const proceed = window.confirm(
          "This file already exists in the system. Do you want to link it to your workflow?"
        );
        if (!proceed) {
          toast.info("Upload cancelled.");
          return;
        }
      }
    } catch {
      // Duplicate pre-check is advisory; continue with upload if it fails.
    }

    const formData = new FormData();
    formData.append("file", file);
    if (summary.trim()) {
      formData.append("change_summary", summary.trim());
    }
    mutation.mutate(formData);
  };

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        disabled={disabled}
        title={triggerTitle}
        className={clsx(triggerClassName ?? "btn-secondary", disabled && "cursor-not-allowed opacity-50")}
      >
        <Upload className={triggerIconClassName ?? "w-4 h-4"} />
        {triggerLabel ?? "Upload new version"}
      </button>

      <Dialog
        open={open}
        onOpenChange={(next: boolean) => {
          // Don't allow closing while an upload is in flight.
          if (mutation.isPending) return;
          setOpen(next);
        }}
      >
        <DialogContent className="sm:max-w-lg">
          <form
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              void handleUpload();
            }}
          >
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <Upload className="w-4 h-4 text-primary" />
                Upload new version
              </DialogTitle>
              <DialogDescription>
                This will be saved as{" "}
                <span className="font-medium text-foreground">
                  v{currentVersion + 1}
                </span>
                . Add a short note describing what changed.
              </DialogDescription>
            </DialogHeader>

            <input
              ref={fileInputRef}
              type="file"
              accept={acceptAttr}
              className="hidden"
              onChange={handleFileSelect}
            />

            <div
              role="button"
              tabIndex={0}
              onClick={() => fileInputRef.current?.click()}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  fileInputRef.current?.click();
                }
              }}
              onDragOver={(e) => e.preventDefault()}
              onDrop={handleDrop}
              className={`border-2 border-dashed rounded-lg p-6 text-center cursor-pointer transition-colors ${
                file
                  ? "border-teal/70 bg-teal/5"
                  : "border-border hover:border-primary/60 hover:bg-muted/40"
              }`}
            >
              {file ? (
                <div className="flex flex-col items-center gap-2">
                  <FileIcon className="w-9 h-9 text-teal" />
                  <p className="font-medium text-sm text-foreground break-all">
                    {file.name}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {(file.size / 1024 / 1024).toFixed(2)} MB
                  </p>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      void setSelectedFile(null);
                      if (fileInputRef.current) fileInputRef.current.value = "";
                    }}
                    className="inline-flex items-center gap-1 text-xs text-destructive hover:underline mt-1"
                  >
                    <X className="w-3 h-3" /> Remove
                  </button>
                </div>
              ) : (
                <>
                  <Upload className="w-7 h-7 text-muted-foreground mx-auto mb-2" />
                  <p className="text-sm text-foreground font-medium">
                    Click to choose a file or drop it here
                  </p>
                  <p className="text-xs text-muted-foreground mt-1">
                    {SUPPORTED_FORMATS_LABEL}.
                  </p>
                  <p className="text-[11px] text-muted-foreground mt-1">
                    Max {formatBytes(maxBytes)}.
                  </p>
                </>
              )}
            </div>

            <div className="space-y-1.5">
              <label className="text-xs font-medium text-foreground">
                Change summary{" "}
                <span className="text-muted-foreground font-normal">
                  (optional)
                </span>
              </label>
              <textarea
                value={summary}
                onChange={(e) => setSummary(e.target.value)}
                placeholder="What changed in this version? e.g. updated totals on page 3, fixed signatory name…"
                className="input resize-none w-full"
                rows={3}
              />
            </div>

            {file && isCheckingDuplicate && (
              <p className="text-xs text-muted-foreground">
                Checking selected file…
              </p>
            )}

            {file && !isCheckingDuplicate && isIdenticalToCurrent && (
              <p className="text-xs text-destructive">
                This file is identical to the current version.
              </p>
            )}

            {mutation.isPending && progress > 0 && (
              <div className="space-y-1">
                <div className="h-1.5 bg-muted rounded-full overflow-hidden">
                  <div
                    className="h-full bg-primary transition-all"
                    style={{ width: `${progress}%` }}
                  />
                </div>
                <p className="text-xs text-muted-foreground text-center">
                  {progress}% uploaded
                </p>
              </div>
            )}

            <div className="flex items-center justify-end gap-2 pt-1">
              <button
                type="button"
                onClick={() => setOpen(false)}
                disabled={mutation.isPending}
                className="btn-secondary"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={!file || mutation.isPending || isCheckingDuplicate || isIdenticalToCurrent}
                className="btn-primary"
              >
                {mutation.isPending ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" />
                    Uploading…
                  </>
                ) : (
                  <>
                    <Upload className="w-4 h-4" />
                    Save as v{currentVersion + 1}
                  </>
                )}
              </button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}

// Default export for callers that do `import UploadVersionDrawer from ...`
export default UploadVersionDrawer;
