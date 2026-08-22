import { useDropzone } from "react-dropzone";
import { Upload, File, X, Files } from "lucide-react";
import clsx from "clsx";

const ACCEPT = {
  "application/pdf": [".pdf"],
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": [".docx"],
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": [".xlsx"],
  "application/msword": [".doc"],
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": [".pptx"],
  "image/*": [".png", ".jpg", ".jpeg", ".tiff", ".bmp", ".webp"],
};

type Props = {
  files: File[];
  onChange: (files: File[]) => void;
  maxFiles?: number;
  disabled?: boolean;
  onLimitExceeded?: (maxFiles: number) => void;
};

export default function BulkUploadDropzone({
  files,
  onChange,
  maxFiles = 50,
  disabled = false,
  onLimitExceeded,
}: Props) {
  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop: (accepted, rejected) => {
      const availableSlots = Math.max(maxFiles - files.length, 0);
      if (rejected.some((item) => item.errors.some((error) => error.code === "too-many-files")) || accepted.length > availableSlots) {
        onLimitExceeded?.(maxFiles);
      }
      const merged = [...files, ...accepted.slice(0, availableSlots)];
      onChange(merged);
    },
    maxFiles,
    disabled,
    accept: ACCEPT,
  });

  const totalMb = files.reduce((sum, f) => sum + f.size, 0) / (1024 * 1024);

  return (
    <div className="space-y-3">
      <div
        {...getRootProps()}
        className={clsx(
          "border border-dashed p-8 text-center transition-all",
          disabled && "opacity-50 cursor-not-allowed",
          !disabled && "cursor-pointer",
          isDragActive ? "border-[#287EAD] bg-[#EEF6FB]"
            : files.length ? "border-[#A7CDE3] bg-[#EEF6FB]"
            : "border-[#C8CDD2] bg-[#F7F8F9] hover:border-[#287EAD] hover:bg-white",
        )}
      >
        <input {...getInputProps()} />
        <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center bg-[#DCEAF2] text-[#287EAD]">
          {files.length ? <Files className="w-6 h-6" /> : <Upload className="w-6 h-6" />}
        </div>
        <p className="font-semibold text-foreground">
          {isDragActive ? "Drop files here" : "Drag & drop multiple files"}
        </p>
        <p className="text-sm text-muted-foreground mt-1">or click to browse (up to {maxFiles})</p>
        <p className="text-xs text-muted-foreground/70 mt-3">
          PDF · DOCX · XLSX · images — same document type for the whole batch
        </p>
      </div>

      {files.length > 0 && (
        <div className="max-h-56 space-y-2 overflow-y-auto border border-[#C8CDD2] bg-[#F7F8F9] p-3">
          <div className="flex items-center justify-between text-xs text-muted-foreground px-1">
            <span>{files.length} file{files.length === 1 ? "" : "s"} selected</span>
            <span>{totalMb.toFixed(2)} MB total</span>
          </div>
          {files.map((file, index) => (
            <div
              key={`${file.name}-${file.size}-${index}`}
              className="flex items-center gap-2 border border-[#C8CDD2] bg-white px-3 py-2"
            >
              <File className="w-4 h-4 text-[#287EAD] flex-shrink-0" />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-foreground truncate">{file.name}</p>
                <p className="text-xs text-muted-foreground">
                  {(file.size / (1024 * 1024)).toFixed(2)} MB
                </p>
              </div>
              <button
                type="button"
                disabled={disabled}
                onClick={() => onChange(files.filter((_, i) => i !== index))}
                className="text-muted-foreground hover:text-destructive p-1"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          ))}
          <button
            type="button"
            disabled={disabled}
            onClick={() => onChange([])}
            className="text-xs text-destructive hover:underline px-1"
          >
            Clear all
          </button>
        </div>
      )}
    </div>
  );
}
