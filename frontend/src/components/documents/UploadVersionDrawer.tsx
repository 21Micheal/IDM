import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Upload, File as FileIcon, Loader2, X } from "lucide-react";
import { toast } from "@/components/ui/vault-toast";

import { documentsAPI } from "@/services/api";
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
  onVersionUploaded: () => void;
  /** Optional override for the trigger button label. */
  triggerLabel?: string;
  /** Optional className applied to the trigger button. */
  triggerClassName?: string;
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
  onVersionUploaded,
  triggerLabel,
  triggerClassName,
}: UploadVersionDrawerProps) {
  const [open, setOpen] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [summary, setSummary] = useState("");
  const [progress, setProgress] = useState(0);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const acceptMap = accept ?? {
    "application/pdf": [".pdf"],
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": [".docx"],
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": [".xlsx"],
    "application/vnd.openxmlformats-officedocument.presentationml.presentation": [".pptx"],
    "application/msword": [".doc"],
    "application/vnd.ms-excel": [".xls"],
    "application/vnd.ms-powerpoint": [".ppt"],
  };
  const acceptAttr = useMemo(
    () => Object.entries(acceptMap).flatMap(([mime, extensions]) => [mime, ...extensions]).join(","),
    [acceptMap]
  );

  const resetState = useCallback(() => {
    setFile(null);
    setSummary("");
    setProgress(0);
  }, []);

  const setSelectedFile = useCallback((nextFile: File | null) => {
    setFile(nextFile);
    if (nextFile) setProgress(0);
  }, []);

  // Reset whenever the dialog closes.
  useEffect(() => {
    if (!open) resetState();
  }, [open, resetState]);

  const handleFileSelect = useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
    const nextFile = event.target.files?.[0] ?? null;
    setSelectedFile(nextFile);
  }, [setSelectedFile]);

  const handleDrop = useCallback((event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    const nextFile = event.dataTransfer.files?.[0] ?? null;
    setSelectedFile(nextFile);
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
      toast.error(error?.response?.data?.detail || "Upload failed");
      setProgress(0);
    },
  });

  const handleUpload = () => {
    if (!file) return;
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
        className={triggerClassName ?? "btn-secondary"}
      >
        <Upload className="w-4 h-4" />
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
              handleUpload();
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
                      setSelectedFile(null);
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
                    PDF, Word, Excel, and PowerPoint files are supported.
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
                disabled={!file || mutation.isPending}
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
