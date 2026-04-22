import React, { useCallback, useState } from "react";
import { useDropzone } from "react-dropzone";
import { useMutation } from "@tanstack/react-query";
import { Upload, ChevronDown, ChevronUp, File as FileIcon, Loader2 } from "lucide-react";
import { toast } from "react-toastify";

import { documentsAPI } from "@/services/api";

interface UploadVersionDrawerProps {
  documentId: string;
  currentVersion: number;
  accept?: Record<string, string[]>;
  onVersionUploaded: () => void;
}

export function UploadVersionDrawer({
  documentId,
  currentVersion,
  accept,
  onVersionUploaded,
}: UploadVersionDrawerProps) {
  const [open, setOpen] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [summary, setSummary] = useState("");
  const [progress, setProgress] = useState(0);

  const onDrop = useCallback((files: File[]) => {
    if (files[0]) setFile(files[0]);
  }, []);

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    maxFiles: 1,
    accept: accept ?? {
      "application/pdf": [".pdf"],
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document": [".docx"],
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": [".xlsx"],
      "application/vnd.openxmlformats-officedocument.presentationml.presentation": [".pptx"],
      "application/msword": [".doc"],
      "application/vnd.ms-excel": [".xls"],
      "application/vnd.ms-powerpoint": [".ppt"],
    },
  });

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
      setFile(null);
      setSummary("");
      setProgress(0);
      setOpen(false);
      onVersionUploaded();
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
    <div className="border border-gray-200 rounded-lg overflow-hidden mt-4">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center justify-between px-4 py-3 bg-gray-50 hover:bg-gray-100 transition-colors text-sm font-medium text-gray-700"
      >
        <span className="flex items-center gap-2">
          <Upload className="w-4 h-4 text-blue-600" />
          Upload new version
          <span className="text-xs font-normal text-gray-500">
            (saves as v{currentVersion + 1})
          </span>
        </span>
        {open ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
      </button>

      {open && (
        <div className="p-4 space-y-4 bg-white">
          <div
            {...getRootProps()}
            className={`border-2 border-dashed rounded-lg p-8 text-center cursor-pointer transition-all ${
              isDragActive
                ? "border-blue-500 bg-blue-50"
                : file
                  ? "border-green-400 bg-green-50"
                  : "border-gray-200 hover:border-blue-400"
            }`}
          >
            <input {...getInputProps()} />
            {file ? (
              <div className="flex flex-col items-center gap-2">
                <FileIcon className="w-10 h-10 text-green-500" />
                <p className="font-medium text-sm text-gray-900">{file.name}</p>
                <p className="text-xs text-gray-500">
                  {(file.size / 1024 / 1024).toFixed(2)} MB
                </p>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    setFile(null);
                  }}
                  className="text-xs text-red-600 hover:underline mt-2"
                >
                  Remove
                </button>
              </div>
            ) : (
              <>
                <Upload className="w-8 h-8 text-gray-300 mx-auto mb-2" />
                <p className="text-sm text-gray-600">Drag file here or click to browse</p>
              </>
            )}
          </div>

          <textarea
            value={summary}
            onChange={(e) => setSummary(e.target.value)}
            placeholder="Change summary (optional) — describe what changed in this version"
            className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm resize-none"
            rows={2}
          />

          {mutation.isPending && progress > 0 && (
            <div className="space-y-2">
              <div className="h-2 bg-gray-100 rounded-full overflow-hidden">
                <div
                  className="h-full bg-blue-600 transition-all"
                  style={{ width: `${progress}%` }}
                />
              </div>
              <p className="text-xs text-gray-500 text-center">{progress}% uploaded</p>
            </div>
          )}

          <button
            type="button"
            onClick={handleUpload}
            disabled={!file || mutation.isPending}
            className="w-full px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors flex items-center justify-center gap-2 text-sm font-medium"
          >
            {mutation.isPending ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                Uploading...
              </>
            ) : (
              <>
                <Upload className="w-4 h-4" />
                Save as version {currentVersion + 1}
              </>
            )}
          </button>
        </div>
      )}
    </div>
  );
}
