/**
 * components/documents/DocumentViewer.tsx
 *
 * Versioning additions (this revision)
 * ─────────────────────────────────────
 * Interface change
 *   • Accepts `document: Document` (full object) instead of `documentId +
 *     mimeType`.  The parent passes doc so we get permissions, version count,
 *     filename and mime type without extra fetches.
 *
 * PDF versioning
 *   • "Upload new version" collapsible drawer below the PDF canvas.
 *   • Drag-and-drop PDF onto the drawer or click to browse.
 *   • Optional change-summary field.
 *   • Calls POST /documents/{id}/upload_version/.
 *   • On success: invalidates the document query + fires a toast.
 *
 * Office-document versioning (Word / Excel / PowerPoint)
 *   • "Open in [App]" button launches the ms-word / ms-excel / ms-powerpoint
 *     URI scheme pointing at the WebDAV endpoint with the JWT token in the
 *     query string so Office can authenticate without custom headers.
 *   • After launch a 5-second polling loop watches doc.current_version.
 *     When it increments the loop stops and a success toast fires.
 *   • "Upload version manually" drawer is always available as a fallback
 *     for users without Office installed or on Linux.
 *
 * Image viewer        — unchanged from previous version.
 * Google Docs Viewer  — unchanged (dev-URL warning, loading state, retry).
 * PdfViewer canvas    — unchanged.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useDropzone } from "react-dropzone";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { documentsAPI } from "../../services/api";
import { useAuthStore } from "@/store/authStore";
import { toast } from "react-toastify";
import {
  AlertCircle, ChevronDown, ChevronLeft, ChevronRight, ChevronUp,
  CheckCircle2, Clock, Download, ExternalLink, File as FileIcon,
  ImageOff, Loader2, MonitorPlay, RefreshCw, RotateCw, Upload,
  ZoomIn, ZoomOut,
} from "lucide-react";
import type { Document } from "@/types";

// ── PDF.js ────────────────────────────────────────────────────────────────────
import * as pdfjsLib from "pdfjs-dist";
import type { PDFDocumentProxy } from "pdfjs-dist";

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  "pdfjs-dist/build/pdf.worker.min.mjs",
  import.meta.url
).toString();

// ── Types ─────────────────────────────────────────────────────────────────────
interface PreviewData {
  viewer: "pdfjs" | "google_docs" | "download";
  url: string;
}

// ── Office MIME → app metadata ────────────────────────────────────────────────
const OFFICE_META: Record<
  string,
  { scheme: string; label: string; bgClass: string }
> = {
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": {
    scheme: "ms-word", label: "Word", bgClass: "bg-blue-600 hover:bg-blue-700",
  },
  "application/msword": {
    scheme: "ms-word", label: "Word", bgClass: "bg-blue-600 hover:bg-blue-700",
  },
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": {
    scheme: "ms-excel", label: "Excel", bgClass: "bg-green-600 hover:bg-green-700",
  },
  "application/vnd.ms-excel": {
    scheme: "ms-excel", label: "Excel", bgClass: "bg-green-600 hover:bg-green-700",
  },
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": {
    scheme: "ms-powerpoint", label: "PowerPoint", bgClass: "bg-orange-500 hover:bg-orange-600",
  },
};

// ── URL helpers ───────────────────────────────────────────────────────────────
function extractRawUrl(gdocUrl: string): string {
  try {
    return new URL(gdocUrl).searchParams.get("url") ?? gdocUrl;
  } catch { return gdocUrl; }
}

function isLocalUrl(gdocUrl: string): boolean {
  const raw = extractRawUrl(gdocUrl);
  try {
    const { hostname } = new URL(raw);
    return (
      hostname === "localhost" ||
      hostname === "127.0.0.1" ||
      hostname === "::1" ||
      hostname.endsWith(".local")
    );
  } catch { return false; }
}

// ─────────────────────────────────────────────────────────────────────────────
// UploadVersionDrawer
// ─────────────────────────────────────────────────────────────────────────────
interface UploadVersionDrawerProps {
  documentId: string;
  currentVersion: number;
  accept?: Record<string, string[]>;
  onVersionUploaded: () => void;
}

function UploadVersionDrawer({
  documentId, currentVersion, accept, onVersionUploaded,
}: UploadVersionDrawerProps) {
  const [open, setOpen]       = useState(false);
  const [file, setFile]       = useState<File | null>(null);
  const [summary, setSummary] = useState("");
  const [progress, setProgress] = useState(0);

  const onDrop = useCallback((accepted: File[]) => {
    if (accepted[0]) setFile(accepted[0]);
  }, []);

  const defaultAccept: Record<string, string[]> = accept ?? {
    "application/pdf": [".pdf"],
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": [".docx"],
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": [".xlsx"],
    "application/msword": [".doc"],
    "application/vnd.ms-excel": [".xls"],
    "application/vnd.openxmlformats-officedocument.presentationml.presentation": [".pptx"],
    "image/*": [".png", ".jpg", ".jpeg"],
  };

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop, maxFiles: 1, accept: defaultAccept,
  });

  const mutation = useMutation({
    mutationFn: (fd: FormData) =>
      documentsAPI.uploadVersion(documentId, fd, {
        onUploadProgress: (e: any) => {
          if (e.total) setProgress(Math.round((e.loaded * 100) / e.total));
        },
      }),
    onSuccess: () => {
      toast.success(`Version ${currentVersion + 1} uploaded.`);
      setFile(null); setSummary(""); setProgress(0); setOpen(false);
      onVersionUploaded();
    },
    onError: () => { toast.error("Upload failed. Please try again."); setProgress(0); },
  });

  const submit = () => {
    if (!file) return;
    const fd = new FormData();
    fd.append("file", file);
    if (summary.trim()) fd.append("change_summary", summary.trim());
    mutation.mutate(fd);
  };

  return (
    <div className="border border-gray-200 rounded-xl overflow-hidden mt-3">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center justify-between px-4 py-3 bg-gray-50 hover:bg-gray-100 transition-colors text-sm font-medium text-gray-700"
      >
        <span className="flex items-center gap-2">
          <Upload className="w-4 h-4 text-brand-500" />
          Upload new version
          <span className="text-xs font-normal text-gray-400">
            (saves as v{currentVersion + 1})
          </span>
        </span>
        {open ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
      </button>

      {open && (
        <div className="p-4 space-y-4 bg-white">
          <div
            {...getRootProps()}
            className={`border-2 border-dashed rounded-xl p-8 text-center cursor-pointer transition-all ${
              isDragActive ? "border-brand-500 bg-brand-50"
              : file ? "border-green-400 bg-green-50"
              : "border-gray-200 hover:border-brand-400 hover:bg-gray-50"
            }`}
          >
            <input {...getInputProps()} />
            {file ? (
              <div className="flex flex-col items-center gap-2">
                <FileIcon className="w-10 h-10 text-green-500" />
                <p className="font-medium text-gray-900 text-sm">{file.name}</p>
                <p className="text-xs text-gray-500">{(file.size / (1024 * 1024)).toFixed(2)} MB</p>
                <button type="button" onClick={(e) => { e.stopPropagation(); setFile(null); }}
                  className="text-xs text-red-500 hover:underline">Remove</button>
              </div>
            ) : (
              <>
                <Upload className="w-8 h-8 text-gray-300 mx-auto mb-2" />
                <p className="text-sm text-gray-600">
                  {isDragActive ? "Drop here…" : "Drag the updated file here, or click to browse"}
                </p>
              </>
            )}
          </div>

          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">
              Change summary <span className="text-gray-400">(optional)</span>
            </label>
            <input value={summary} onChange={(e) => setSummary(e.target.value)}
              placeholder="e.g. Updated payment terms in clause 4"
              className="input text-sm" />
          </div>

          {mutation.isPending && progress > 0 && (
            <div>
              <div className="flex justify-between text-xs text-gray-500 mb-1">
                <span>Uploading…</span><span>{progress}%</span>
              </div>
              <div className="h-1.5 bg-gray-100 rounded-full overflow-hidden">
                <div className="h-full bg-brand-500 transition-all duration-200"
                  style={{ width: `${progress}%` }} />
              </div>
            </div>
          )}

          <button type="button" onClick={submit}
            disabled={!file || mutation.isPending}
            className="btn-primary w-full justify-center disabled:opacity-50">
            {mutation.isPending
              ? <Loader2 className="w-4 h-4 animate-spin" />
              : <Upload className="w-4 h-4" />}
            Save as version {currentVersion + 1}
          </button>
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// PdfViewer
// ─────────────────────────────────────────────────────────────────────────────
function PdfViewer({
  url, doc, canUploadVersion, onVersionUploaded,
}: {
  url: string; doc: Document;
  canUploadVersion: boolean; onVersionUploaded: () => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [pdfDoc, setPdfDoc]           = useState<PDFDocumentProxy | null>(null);
  const [currentPage, setCurrentPage] = useState(1);
  const [totalPages, setTotalPages]   = useState(0);
  const [scale, setScale]             = useState(1.3);
  const [rotation, setRotation]       = useState(0);
  const [loading, setLoading]         = useState(true);
  const [error, setError]             = useState("");
  const renderRef                     = useRef<any>(null);
  const token                         = useAuthStore((s) => s.accessToken);

  useEffect(() => {
    let cancelled = false;
    setLoading(true); setError("");
    const task = pdfjsLib.getDocument({
      url, withCredentials: true,
      httpHeaders: { Authorization: `Bearer ${token ?? ""}` },
    });
    task.promise.then((d) => {
      if (cancelled) return;
      setPdfDoc(d); setTotalPages(d.numPages); setCurrentPage(1); setLoading(false);
    }).catch((err) => {
      if (cancelled) return;
      setError(err?.status === 403
        ? "You do not have permission to view this document."
        : "Failed to load PDF.");
      setLoading(false);
    });
    return () => { cancelled = true; task.destroy(); };
  }, [url, token]);

  useEffect(() => {
    if (!pdfDoc || !containerRef.current) return;
    const container = containerRef.current;
    let cancelled = false;
    if (renderRef.current) renderRef.current.cancel();
    pdfDoc.getPage(currentPage).then((page) => {
      if (cancelled) return;
      const vp = page.getViewport({ scale, rotation });
      let canvas = container.querySelector("canvas") as HTMLCanvasElement;
      if (!canvas) {
        canvas = document.createElement("canvas");
        canvas.className = "mx-auto shadow-sm";
        container.innerHTML = ""; container.appendChild(canvas);
      }
      const ctx = canvas.getContext("2d")!;
      canvas.width = vp.width; canvas.height = vp.height;
      const rt = page.render({ canvasContext: ctx, viewport: vp });
      renderRef.current = rt;
      rt.promise.catch((e) => {
        if (e?.name !== "RenderingCancelledException") console.error(e);
      });
    });
    return () => { cancelled = true; };
  }, [pdfDoc, currentPage, scale, rotation]);

  const goTo = useCallback(
    (p: number) => setCurrentPage(Math.max(1, Math.min(totalPages, p))),
    [totalPages]
  );

  if (loading) return (
    <div className="flex flex-col items-center justify-center h-64 gap-3">
      <Loader2 className="w-8 h-8 text-brand-500 animate-spin" />
      <p className="text-sm text-gray-500">Loading PDF…</p>
    </div>
  );

  if (error) return (
    <div className="flex flex-col items-center justify-center h-64 gap-4 text-center px-4">
      <AlertCircle className="w-8 h-8 text-red-400" />
      <p className="text-red-500 text-sm font-medium">{error}</p>
      <a href={url} download className="btn-secondary inline-flex items-center gap-2">
        <Download className="w-4 h-4" /> Download
      </a>
    </div>
  );

  return (
    <div>
      {/* Toolbar */}
      <div className="flex items-center justify-between gap-2 bg-gray-100 border border-gray-200 rounded-t-lg px-3 py-2">
        <div className="flex items-center gap-1">
          <button onClick={() => goTo(currentPage - 1)} disabled={currentPage <= 1}
            className="btn-secondary px-2 py-1 disabled:opacity-40">
            <ChevronLeft className="w-4 h-4" />
          </button>
          <div className="flex items-center gap-1.5 px-2 text-sm">
            <input type="number" value={currentPage} min={1} max={totalPages}
              onChange={(e) => goTo(Number(e.target.value))}
              className="w-12 text-center border border-gray-300 rounded px-1 py-0.5" />
            <span className="text-gray-500">/ {totalPages}</span>
          </div>
          <button onClick={() => goTo(currentPage + 1)} disabled={currentPage >= totalPages}
            className="btn-secondary px-2 py-1 disabled:opacity-40">
            <ChevronRight className="w-4 h-4" />
          </button>
        </div>
        <div className="flex items-center gap-1">
          <button onClick={() => setScale((s) => Math.max(0.5, parseFloat((s - 0.2).toFixed(1))))}
            className="btn-secondary px-2 py-1"><ZoomOut className="w-4 h-4" /></button>
          <span className="text-xs text-gray-600 w-12 text-center">{Math.round(scale * 100)}%</span>
          <button onClick={() => setScale((s) => Math.min(3, parseFloat((s + 0.2).toFixed(1))))}
            className="btn-secondary px-2 py-1"><ZoomIn className="w-4 h-4" /></button>
          <button onClick={() => setRotation((r) => (r + 90) % 360)}
            className="btn-secondary px-2 py-1 ml-1"><RotateCw className="w-4 h-4" /></button>
        </div>
        <a href={url} download className="btn-secondary text-xs px-3 py-1 flex items-center gap-1.5">
          <Download className="w-3.5 h-3.5" /> Download
        </a>
      </div>

      {/* Canvas */}
      <div className="overflow-auto bg-gray-200 border border-t-0 border-gray-200 rounded-b-lg p-4"
        style={{ maxHeight: "70vh" }}>
        <div ref={containerRef} className="mx-auto" />
      </div>

      {canUploadVersion && (
        <UploadVersionDrawer
          documentId={doc.id}
          currentVersion={doc.current_version}
          accept={{ "application/pdf": [".pdf"] }}
          onVersionUploaded={onVersionUploaded}
        />
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// OfficeEditPanel — native desktop editing via WebDAV URI scheme
// ─────────────────────────────────────────────────────────────────────────────
function OfficeEditPanel({
  doc, previewUrl, canUploadVersion, onVersionUploaded,
}: {
  doc: Document; previewUrl: string;
  canUploadVersion: boolean; onVersionUploaded: () => void;
}) {
  const qc          = useQueryClient();
  const token       = useAuthStore((s) => s.accessToken);
  const [editing, setEditing]         = useState(false);
  const [versionAtLaunch, setVersionAtLaunch] = useState(0);
  const [reloadKey, setReloadKey]     = useState(0);
  const [iframeLoading, setIframeLoading] = useState(true);
  const [showFallback, setShowFallback]   = useState(false);
  const fallbackTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pollRef       = useRef<ReturnType<typeof setInterval> | null>(null);

  const officeInfo = OFFICE_META[doc.file_mime_type] ?? null;

  // Build WebDAV URL: /api/v1/documents/webdav/<id>/<filename>?token=<jwt>
  const apiBase   = (import.meta.env.VITE_API_URL ?? "/api/v1").replace(/\/$/, "");
  const webdavUrl = `${window.location.origin}${apiBase}/documents/webdav/${doc.id}/${encodeURIComponent(doc.file_name)}?token=${token ?? ""}`;
  const officeUri = officeInfo ? `${officeInfo.scheme}:ofe|u|${webdavUrl}` : null;
  const rawUrl    = extractRawUrl(previewUrl);
  const isDev     = isLocalUrl(previewUrl);

  // Poll for version bump after editor launch
  const startPolling = (baseVersion: number) => {
    setVersionAtLaunch(baseVersion);
    setEditing(true);
    pollRef.current = setInterval(async () => {
      try {
        const { data } = await documentsAPI.get(doc.id);
        if (data.current_version > baseVersion) {
          stopPolling();
          toast.success(`Version ${data.current_version} saved from ${officeInfo?.label ?? "editor"}.`);
          qc.invalidateQueries({ queryKey: ["document", doc.id] });
          qc.invalidateQueries({ queryKey: ["document-preview", doc.id] });
          onVersionUploaded();
        }
      } catch { /* ignore transient errors */ }
    }, 5_000);
  };

  const stopPolling = () => {
    setEditing(false);
    if (pollRef.current) clearInterval(pollRef.current);
  };

  useEffect(() => () => {
    if (pollRef.current) clearInterval(pollRef.current);
    if (fallbackTimer.current) clearTimeout(fallbackTimer.current);
  }, []);

  const handleIframeLoad = () => {
    setIframeLoading(false);
    if (fallbackTimer.current) clearTimeout(fallbackTimer.current);
    fallbackTimer.current = setTimeout(() => setShowFallback(true), 6_000);
  };

  return (
    <div className="space-y-3">
      {/* Action bar */}
      <div className="rounded-xl border border-gray-200 bg-gray-50 p-4 space-y-3">
        <div className="flex flex-wrap items-center gap-3">
          {/* Open in desktop Office */}
          {officeUri && canUploadVersion && (
            <a
              href={officeUri}
              onClick={() => startPolling(doc.current_version)}
              className={`inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-semibold text-white transition-colors ${officeInfo?.bgClass}`}
            >
              <MonitorPlay className="w-4 h-4" />
              Open &amp; Edit in {officeInfo?.label}
            </a>
          )}
          <a href={rawUrl} target="_blank" rel="noopener noreferrer"
            className="btn-secondary text-sm flex items-center gap-2">
            <ExternalLink className="w-4 h-4" /> Open original
          </a>
          <a href={rawUrl} download className="btn-secondary text-sm flex items-center gap-2">
            <Download className="w-4 h-4" /> Download
          </a>
        </div>

        {/* Editing / polling status */}
        {editing && (
          <div className="flex items-center justify-between gap-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm">
            <div className="flex items-center gap-2 text-amber-800">
              <Clock className="w-4 h-4 animate-pulse text-amber-500" />
              <span>
                Waiting for you to save in {officeInfo?.label}…
                <span className="ml-1 text-amber-600 text-xs">(checking every 5 s)</span>
              </span>
            </div>
            <button onClick={stopPolling}
              className="text-xs text-amber-700 hover:underline flex-shrink-0">Cancel</button>
          </div>
        )}

        {/* Dev-mode notice */}
        {isDev && canUploadVersion && (
          <div className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2.5 text-xs text-amber-800">
            <AlertCircle className="w-4 h-4 flex-shrink-0 mt-0.5 text-amber-600" />
            <span>
              <strong>Development note:</strong> WebDAV URL targets{" "}
              <code className="bg-amber-100 px-1 rounded">localhost</code>. Desktop
              Office on this machine can still reach it; the read-only preview below
              will be blank (Google cannot reach localhost). Both will work correctly
              in production.
            </span>
          </div>
        )}
      </div>

      {/* Read-only in-browser preview (Google Docs) */}
      {!isDev && (
        <div className="rounded-xl border border-gray-200 overflow-hidden">
          <div className="flex items-center justify-between bg-gray-100 px-3 py-2">
            <span className="text-xs text-gray-500 font-medium">
              Read-only preview — use "Open &amp; Edit in {officeInfo?.label}" to make changes
            </span>
            <button onClick={() => { setReloadKey((k) => k + 1); setIframeLoading(true); setShowFallback(false); }}
              className="flex items-center gap-1 text-xs text-gray-500 hover:text-gray-700">
              <RefreshCw className="w-3.5 h-3.5" /> Reload
            </button>
          </div>
          <div className="relative bg-gray-50" style={{ height: "65vh" }}>
            {iframeLoading && (
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-gray-50 z-10">
                <Loader2 className="w-8 h-8 text-brand-500 animate-spin" />
                <p className="text-sm text-gray-500">Loading document preview…</p>
              </div>
            )}
            <iframe key={reloadKey} src={previewUrl} className="w-full h-full border-0"
              title="Read-only document preview" onLoad={handleIframeLoad}
              sandbox="allow-scripts allow-same-origin allow-popups allow-forms allow-popups-to-escape-sandbox" />
          </div>
          {!iframeLoading && showFallback && (
            <div className="flex items-center gap-3 border-t border-gray-200 bg-gray-50 px-4 py-2.5 text-sm text-gray-600">
              <AlertCircle className="w-4 h-4 text-amber-500 flex-shrink-0" />
              <span>Having trouble with the preview?</span>
              <button onClick={() => { setReloadKey((k) => k + 1); setIframeLoading(true); setShowFallback(false); }}
                className="ml-auto flex items-center gap-1 text-brand-600 hover:text-brand-700 font-medium text-sm">
                <RefreshCw className="w-3.5 h-3.5" /> Retry
              </button>
              <a href={rawUrl} download
                className="flex items-center gap-1 text-brand-600 hover:text-brand-700 font-medium text-sm">
                <Download className="w-3.5 h-3.5" /> Download
              </a>
            </div>
          )}
        </div>
      )}

      {/* Manual upload fallback */}
      {canUploadVersion && (
        <UploadVersionDrawer
          documentId={doc.id}
          currentVersion={doc.current_version}
          onVersionUploaded={onVersionUploaded}
        />
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// ImageViewer
// ─────────────────────────────────────────────────────────────────────────────
function ImageViewer({ url }: { url: string }) {
  const [scale, setScale]     = useState(1);
  const [imgError, setImgError] = useState(false);
  return (
    <div>
      <div className="flex items-center justify-between bg-gray-100 border border-gray-200 rounded-t-lg px-3 py-2">
        <div className="flex items-center gap-1">
          <button onClick={() => setScale((s) => Math.max(0.25, s - 0.25))} className="btn-secondary px-2 py-1">
            <ZoomOut className="w-4 h-4" />
          </button>
          <button onClick={() => setScale(1)} className="btn-secondary px-2 py-1 text-xs min-w-[3.5rem] text-center">
            {Math.round(scale * 100)}%
          </button>
          <button onClick={() => setScale((s) => Math.min(4, s + 0.25))} className="btn-secondary px-2 py-1">
            <ZoomIn className="w-4 h-4" />
          </button>
        </div>
        <a href={url} download className="btn-secondary text-xs px-3 py-1 flex items-center gap-1.5">
          <Download className="w-3.5 h-3.5" /> Download
        </a>
      </div>
      <div className="overflow-auto bg-gray-200 border border-t-0 border-gray-200 rounded-b-lg p-4 flex items-start justify-center"
        style={{ maxHeight: "75vh" }}>
        {imgError ? (
          <div className="flex flex-col items-center gap-3 text-gray-400 py-16">
            <ImageOff className="w-10 h-10" />
            <p className="text-sm">Image could not be loaded.</p>
            <a href={url} download className="btn-secondary text-xs flex items-center gap-1.5">
              <Download className="w-3.5 h-3.5" /> Download
            </a>
          </div>
        ) : (
          <img src={url} alt="Preview" onError={() => setImgError(true)}
            style={{ transform: `scale(${scale})`, transformOrigin: "top center", transition: "transform 0.15s ease", maxWidth: "100%", display: "block" }}
            className="shadow-md rounded" />
        )}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Standalone GoogleDocsViewer (for non-Office google_docs fallback)
// ─────────────────────────────────────────────────────────────────────────────
function GoogleDocsViewer({ url }: { url: string }) {
  const [loading, setLoading]         = useState(true);
  const [showFallback, setShowFallback] = useState(false);
  const [key, setKey]                 = useState(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const rawUrl = extractRawUrl(url);
  const isDev  = isLocalUrl(url);

  useEffect(() => { setLoading(true); setShowFallback(false); }, [url, key]);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  if (isDev) return (
    <div className="rounded-xl border-2 border-dashed border-amber-200 bg-amber-50 p-8 text-center">
      <AlertCircle className="w-10 h-10 text-amber-400 mx-auto mb-3" />
      <p className="font-semibold text-amber-800 mb-1">Office preview unavailable in development</p>
      <p className="text-sm text-amber-700 max-w-md mx-auto mb-5">
        Google Docs Viewer requires a public URL. This works correctly in production.
      </p>
      <a href={rawUrl} download className="btn-primary inline-flex items-center gap-2">
        <Download className="w-4 h-4" /> Download File
      </a>
    </div>
  );

  return (
    <div>
      <div className="flex items-center justify-between bg-gray-100 border border-gray-200 rounded-t-lg px-3 py-2">
        <span className="text-xs text-gray-500">Read-only preview via Google Docs Viewer</span>
        <div className="flex gap-2">
          <button onClick={() => setKey((k) => k + 1)} className="btn-secondary text-xs px-2 py-1 flex items-center gap-1">
            <RefreshCw className="w-3.5 h-3.5" /> Reload
          </button>
          <a href={rawUrl} target="_blank" rel="noopener noreferrer" className="btn-secondary text-xs px-2 py-1 flex items-center gap-1">
            <ExternalLink className="w-3.5 h-3.5" /> Open
          </a>
          <a href={rawUrl} download className="btn-secondary text-xs px-2 py-1 flex items-center gap-1">
            <Download className="w-3.5 h-3.5" /> Download
          </a>
        </div>
      </div>
      <div className="relative border border-t-0 border-gray-200 rounded-b-lg overflow-hidden bg-gray-50" style={{ height: "75vh" }}>
        {loading && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-gray-50 z-10">
            <Loader2 className="w-8 h-8 text-brand-500 animate-spin" />
            <p className="text-sm text-gray-500">Loading document preview…</p>
          </div>
        )}
        <iframe key={key} src={url} className="w-full h-full border-0" title="Document viewer"
          onLoad={() => { setLoading(false); timer.current = setTimeout(() => setShowFallback(true), 6_000); }}
          sandbox="allow-scripts allow-same-origin allow-popups allow-forms allow-popups-to-escape-sandbox" />
      </div>
      {!loading && showFallback && (
        <div className="mt-2 flex items-center gap-3 rounded-lg border border-gray-200 bg-gray-50 px-4 py-2.5 text-sm text-gray-600">
          <AlertCircle className="w-4 h-4 text-amber-500 flex-shrink-0" />
          <span>Having trouble viewing?</span>
          <button onClick={() => setKey((k) => k + 1)}
            className="ml-auto flex items-center gap-1 text-brand-600 hover:text-brand-700 font-medium">
            <RefreshCw className="w-3.5 h-3.5" /> Try again
          </button>
          <a href={rawUrl} download className="flex items-center gap-1 text-brand-600 hover:text-brand-700 font-medium">
            <Download className="w-3.5 h-3.5" /> Download
          </a>
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Main DocumentViewer
// ─────────────────────────────────────────────────────────────────────────────
interface Props {
  document: Document;
}

export default function DocumentViewer({ document: doc }: Props) {
  const qc = useQueryClient();

  const { data: preview, isLoading, isError } = useQuery<PreviewData>({
    queryKey: ["document-preview", doc.id],
    queryFn: () => documentsAPI.previewUrl(doc.id).then((r) => r.data),
    staleTime: 1000 * 60 * 10,
  });

  const onVersionUploaded = useCallback(() => {
    qc.invalidateQueries({ queryKey: ["document", doc.id] });
    qc.invalidateQueries({ queryKey: ["document-preview", doc.id] });
  }, [qc, doc.id]);

  const canUploadVersion = Boolean((doc as any).permissions?.includes("upload"));
  const isOfficeDoc      = Boolean(OFFICE_META[doc.file_mime_type]);
  const isImage          = doc.file_mime_type?.startsWith("image/") ||
    /\.(png|jpe?g|gif|webp|svg|bmp)$/i.test(doc.file_name ?? "");

  if (isLoading) return (
    <div className="flex items-center justify-center h-64">
      <Loader2 className="w-8 h-8 text-brand-500 animate-spin" />
    </div>
  );

  if (isError || !preview) return (
    <div className="flex flex-col items-center justify-center h-64 gap-3 text-red-500">
      <AlertCircle className="w-8 h-8" />
      <p className="text-sm">Could not load document preview.</p>
    </div>
  );

  const rawFileUrl = preview.viewer === "google_docs"
    ? extractRawUrl(preview.url)
    : preview.url;

  return (
    <div className="space-y-3">
      {/* Header row */}
      <div className="flex items-center justify-between">
        <h3 className="font-medium text-gray-900 text-sm">Document Preview</h3>
        <div className="flex items-center gap-2">
          {doc.current_version > 1 && (
            <span className="inline-flex items-center gap-1 text-xs text-brand-600 font-medium bg-brand-50 px-2 py-0.5 rounded-full">
              <CheckCircle2 className="w-3 h-3" />
              Version {doc.current_version}
            </span>
          )}
          <a href={rawFileUrl} target="_blank" rel="noopener noreferrer"
            className="btn-secondary text-xs px-3 py-1.5 flex items-center gap-1.5">
            <ExternalLink className="w-3.5 h-3.5" /> Open in new tab
          </a>
        </div>
      </div>

      {/* PDF */}
      {preview.viewer === "pdfjs" && (
        <PdfViewer url={preview.url} doc={doc}
          canUploadVersion={canUploadVersion} onVersionUploaded={onVersionUploaded} />
      )}

      {/* Office documents — native edit panel */}
      {preview.viewer === "google_docs" && isOfficeDoc && (
        <OfficeEditPanel doc={doc} previewUrl={preview.url}
          canUploadVersion={canUploadVersion} onVersionUploaded={onVersionUploaded} />
      )}

      {/* Non-Office google_docs (rare fallback) */}
      {preview.viewer === "google_docs" && !isOfficeDoc && (
        <GoogleDocsViewer url={preview.url} />
      )}

      {/* Images */}
      {isImage && preview.viewer !== "pdfjs" && (
        <ImageViewer url={preview.url} />
      )}

      {/* Unsupported format */}
      {preview.viewer === "download" && !isImage && (
        <div className="space-y-3">
          <div className="rounded-lg border-2 border-dashed border-gray-200 p-10 text-center">
            <Download className="w-12 h-12 text-gray-300 mx-auto mb-4" />
            <p className="text-gray-600 mb-4">Preview not available for this file type.</p>
            <a href={preview.url} download className="btn-primary inline-flex items-center gap-2">
              <Download className="w-4 h-4" /> Download File
            </a>
          </div>
          {canUploadVersion && (
            <UploadVersionDrawer documentId={doc.id} currentVersion={doc.current_version}
              onVersionUploaded={onVersionUploaded} />
          )}
        </div>
      )}
    </div>
  );
}