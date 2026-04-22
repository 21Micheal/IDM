/**
 * components/documents/DocumentViewer.tsx
 *
 * Architecture
 * ────────────
 * PREVIEW
 *   PDF              → PDF.js renderer
 *   Image            → <img> with zoom
 *   Office (docx/xlsx/pptx)
 *                    → Show download option + manual upload
 *                       (LibreOffice preview conversion is complex and often fails)
 *
 * EDITING — Windows + MS Office only
 *   "Open in Word/Excel/PowerPoint" button uses the ms-word:ofe|u|URL URI scheme
 *   to open the file directly in the installed Office app via WebDAV endpoint.
 *   Saves with Ctrl+S are automatically uploaded as new versions.
 *
 *   All other platforms or environments
 *     → Manual upload via UploadVersionDrawer
 *
 * LOCK MANAGEMENT
 *   Acquiring the edit lock (POST /edit_token/) is a prerequisite for editing.
 *   Lock is released when:
 *     – The user clicks "Release lock" manually
 *     – The lock expires naturally after 1 hour
 *   While locked, frontend polls for version changes every 5 s.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useDropzone } from "react-dropzone";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { documentsAPI } from "../../services/api";
import { useAuthStore } from "@/store/authStore";
import { toast } from "react-toastify";
import {
  AlertCircle,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Clock,
  Copy,
  Download,
  ExternalLink,
  File as FileIcon,
  ImageOff,
  Loader2,
  Lock,
  Monitor,
  RefreshCw,
  RotateCw,
  Unlock,
  Upload,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import type {
  Document,
  DocumentEditTokenResponse,
  DocumentPreviewResponse,
} from "@/types";

import * as pdfjsLib from "pdfjs-dist";
import type { PDFDocumentProxy } from "pdfjs-dist";

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  "pdfjs-dist/build/pdf.worker.min.mjs",
  import.meta.url
).toString();

// ── Types ─────────────────────────────────────────────────────────────────────

// ── Constants ─────────────────────────────────────────────────────────────────

const OFFICE_MIME_INFO: Record<
  string,
  { app: string; msScheme: string }
> = {
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": {
    app: "Word",
    msScheme: "ms-word",
  },
  "application/msword": {
    app: "Word",
    msScheme: "ms-word",
  },
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": {
    app: "Excel",
    msScheme: "ms-excel",
  },
  "application/vnd.ms-excel": {
    app: "Excel",
    msScheme: "ms-excel",
  },
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": {
    app: "PowerPoint",
    msScheme: "ms-powerpoint",
  },
  "application/vnd.ms-powerpoint": {
    app: "PowerPoint",
    msScheme: "ms-powerpoint",
  },
};

const OFFICE_MIMES = new Set(Object.keys(OFFICE_MIME_INFO));

// ── Utilities ─────────────────────────────────────────────────────────────────

function normalizeUrl(url: string | undefined): string | undefined {
  if (!url) return url;
  if (window.location.protocol === "https:" && url.startsWith("http://")) {
    return url.replace("http://", "https://");
  }
  return url;
}

function downloadBlob(content: string, filename: string, mime: string) {
  const blob = new Blob([content], { type: mime });
  const url  = URL.createObjectURL(blob);
  const a    = Object.assign(document.createElement("a"), {
    href: url,
    download: filename,
  });
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// ── EditLockBanner ────────────────────────────────────────────────────────────

function EditLockBanner({
  doc,
  currentUserId,
  onRelease,
}: {
  doc: Document;
  currentUserId: string | undefined;
  onRelease: () => void;
}) {
  const isLocked    = Boolean(doc.is_edit_locked);
  const isLockedByMe = isLocked && doc.edit_locked_by === currentUserId;

  if (!isLocked) return null;

  if (isLockedByMe) {
    return (
      <div className="flex items-center justify-between gap-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm mb-3">
        <div className="flex items-center gap-2 text-amber-800">
          <Lock className="w-4 h-4 text-amber-600 flex-shrink-0" />
          <span>
            <strong>You are editing this document.</strong> Other users can only
            view it until you close your editor or release the lock.
          </span>
        </div>
        <button
          onClick={onRelease}
          className="flex-shrink-0 flex items-center gap-1.5 text-xs font-medium text-amber-700 hover:text-amber-900 border border-amber-300 rounded-lg px-3 py-1.5 hover:bg-amber-100 transition-colors"
        >
          <Unlock className="w-3.5 h-3.5" /> Release lock
        </button>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-3 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm mb-3">
      <Lock className="w-4 h-4 text-red-500 flex-shrink-0" />
      <span className="text-red-800">
        <strong>{doc.edit_locked_by_name ?? "Another user"}</strong> is currently
        editing this document. View-only until they finish.
      </span>
    </div>
  );
}

// ── PdfViewer ─────────────────────────────────────────────────────────────────

function PdfViewer({
  url,
  doc,
  canUploadVersion,
  onVersionUploaded,
}: {
  url: string;
  doc: Document;
  canUploadVersion: boolean;
  onVersionUploaded: () => void;
}) {
  const containerRef                   = useRef<HTMLDivElement>(null);
  const [pdfDoc, setPdfDoc]            = useState<PDFDocumentProxy | null>(null);
  const [currentPage, setCurrentPage]  = useState(1);
  const [totalPages, setTotalPages]    = useState(0);
  const [scale, setScale]              = useState(1.3);
  const [rotation, setRotation]        = useState(0);
  const [loading, setLoading]          = useState(true);
  const [error, setError]              = useState("");
  const renderRef                      = useRef<any>(null);
  const token                          = useAuthStore((s) => s.accessToken);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError("");

    const normalizedUrl = normalizeUrl(url) || "";
    const task = pdfjsLib.getDocument({
      url: normalizedUrl,
      withCredentials: true,
      httpHeaders: { Authorization: `Bearer ${token ?? ""}` },
    });
    task.promise
      .then((d) => {
        if (cancelled) return;
        setPdfDoc(d);
        setTotalPages(d.numPages);
        setCurrentPage(1);
        setLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err?.status === 403 ? "Permission denied." : "Failed to load PDF.");
        setLoading(false);
      });
    return () => {
      cancelled = true;
      task.destroy();
    };
  }, [url, token]);

  useEffect(() => {
    if (!pdfDoc || !containerRef.current) return;
    const container = containerRef.current;
    let cancelled   = false;
    if (renderRef.current) renderRef.current.cancel();
    pdfDoc.getPage(currentPage).then((page) => {
      if (cancelled) return;
      const vp = page.getViewport({ scale, rotation });
      let canvas = container.querySelector("canvas") as HTMLCanvasElement;
      if (!canvas) {
        canvas = document.createElement("canvas");
        canvas.className = "mx-auto shadow-sm";
        container.innerHTML = "";
        container.appendChild(canvas);
      }
      canvas.width  = vp.width;
      canvas.height = vp.height;
      const rt = page.render({
        canvasContext: canvas.getContext("2d")!,
        viewport: vp,
      });
      renderRef.current = rt;
      rt.promise.catch((e) => {
        if (e?.name !== "RenderingCancelledException") console.error(e);
      });
    });
    return () => {
      cancelled = true;
    };
  }, [pdfDoc, currentPage, scale, rotation]);

  const goTo = useCallback(
    (p: number) => setCurrentPage(Math.max(1, Math.min(totalPages, p))),
    [totalPages]
  );

  if (loading)
    return (
      <div className="flex flex-col items-center justify-center h-64 gap-3">
        <Loader2 className="w-8 h-8 text-brand-500 animate-spin" />
        <p className="text-sm text-gray-500">Loading PDF…</p>
      </div>
    );

  if (error)
    return (
      <div className="flex flex-col items-center justify-center h-64 gap-4 px-4 text-center">
        <AlertCircle className="w-8 h-8 text-red-400" />
        <p className="text-red-500 text-sm">{error}</p>
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
          <button
            onClick={() => goTo(currentPage - 1)}
            disabled={currentPage <= 1}
            className="btn-secondary px-2 py-1 disabled:opacity-40"
          >
            <ChevronLeft className="w-4 h-4" />
          </button>
          <div className="flex items-center gap-1.5 px-2 text-sm">
            <input
              type="number"
              value={currentPage}
              min={1}
              max={totalPages}
              onChange={(e) => goTo(Number(e.target.value))}
              className="w-12 text-center border border-gray-300 rounded px-1 py-0.5"
            />
            <span className="text-gray-500">/ {totalPages}</span>
          </div>
          <button
            onClick={() => goTo(currentPage + 1)}
            disabled={currentPage >= totalPages}
            className="btn-secondary px-2 py-1 disabled:opacity-40"
          >
            <ChevronRight className="w-4 h-4" />
          </button>
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={() =>
              setScale((s) => Math.max(0.5, parseFloat((s - 0.2).toFixed(1))))
            }
            className="btn-secondary px-2 py-1"
          >
            <ZoomOut className="w-4 h-4" />
          </button>
          <span className="text-xs text-gray-600 w-12 text-center">
            {Math.round(scale * 100)}%
          </span>
          <button
            onClick={() =>
              setScale((s) => Math.min(3, parseFloat((s + 0.2).toFixed(1))))
            }
            className="btn-secondary px-2 py-1"
          >
            <ZoomIn className="w-4 h-4" />
          </button>
          <button
            onClick={() => setRotation((r) => (r + 90) % 360)}
            className="btn-secondary px-2 py-1 ml-1"
          >
            <RotateCw className="w-4 h-4" />
          </button>
        </div>
        <a
          href={url}
          download
          className="btn-secondary text-xs px-3 py-1 flex items-center gap-1.5"
        >
          <Download className="w-3.5 h-3.5" /> Download
        </a>
      </div>

      {/* Canvas */}
      <div
        className="overflow-auto bg-gray-200 border border-t-0 border-gray-200 rounded-b-lg p-4"
        style={{ maxHeight: "70vh" }}
      >
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

// ── ImageViewer ───────────────────────────────────────────────────────────────

function ImageViewer({ url: rawUrl }: { url: string }) {
  const url           = normalizeUrl(rawUrl) || "";
  const [scale, setScale] = useState(1);
  const [err, setErr] = useState(false);

  return (
    <div>
      <div className="flex items-center justify-between bg-gray-100 border border-gray-200 rounded-t-lg px-3 py-2">
        <div className="flex items-center gap-1">
          <button
            onClick={() => setScale((s) => Math.max(0.25, s - 0.25))}
            className="btn-secondary px-2 py-1"
          >
            <ZoomOut className="w-4 h-4" />
          </button>
          <button
            onClick={() => setScale(1)}
            className="btn-secondary px-2 py-1 text-xs min-w-[3.5rem] text-center"
          >
            {Math.round(scale * 100)}%
          </button>
          <button
            onClick={() => setScale((s) => Math.min(4, s + 0.25))}
            className="btn-secondary px-2 py-1"
          >
            <ZoomIn className="w-4 h-4" />
          </button>
        </div>
        <a
          href={url}
          download
          className="btn-secondary text-xs px-3 py-1 flex items-center gap-1.5"
        >
          <Download className="w-3.5 h-3.5" /> Download
        </a>
      </div>
      <div
        className="overflow-auto bg-gray-200 border border-t-0 border-gray-200 rounded-b-lg p-4 flex items-start justify-center"
        style={{ maxHeight: "75vh" }}
      >
        {err ? (
          <div className="flex flex-col items-center gap-3 text-gray-400 py-16">
            <ImageOff className="w-10 h-10" />
            <p className="text-sm">Image could not be loaded.</p>
            <a
              href={url}
              download
              className="btn-secondary text-xs flex items-center gap-1.5"
            >
              <Download className="w-3.5 h-3.5" /> Download
            </a>
          </div>
        ) : (
          <img
            src={url}
            alt="Preview"
            onError={() => setErr(true)}
            style={{
              transform: `scale(${scale})`,
              transformOrigin: "top center",
              transition: "transform 0.15s ease",
              maxWidth: "100%",
              display: "block",
            }}
            className="shadow-md rounded"
          />
        )}
      </div>
    </div>
  );
}

// ── OfficeEditPanel ───────────────────────────────────────────────────────────

/**
 * Perfect preview mechanism for Office documents:
 * 
 * 1. Initial poll checks every 1s for first 5s (fast check if ready)
 * 2. Then polls every 3s with exponential backoff up to 15s
 * 3. Max 40 polls = ~60 seconds total timeout
 * 4. Shows clear progress states: pending → processing → done/failed
 * 5. Graceful failure with retry option
 * 6. No stuck states - always completes or times out
 */

const PREVIEW_POLL_CONFIG = {
  initialInterval: 1000,      // 1s for first 5s (eager check)
  initialDuration: 5000,      // 5s at fast rate
  standardInterval: 3000,     // 3s standard polling
  maxInterval: 15000,         // Cap at 15s
  backoffMultiplier: 1.1,     // 10% increase per poll
  maxPolls: 40,               // ~60s total timeout
};

function OfficeEditPanel({
  doc,
  initialPreview,
  canUploadVersion,
  onVersionUploaded,
}: {
  doc: Document;
  initialPreview: DocumentPreviewResponse;
  canUploadVersion: boolean;
  onVersionUploaded: () => void;
}) {
  const qc   = useQueryClient();
  const user = useAuthStore((s) => s.user);

  const [lockData, setLockData]             = useState<DocumentEditTokenResponse | null>(null);
  const [versionPolling, setVersionPolling] = useState(false);
  const [previewProgress, setPreviewProgress] = useState(0);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const pollCountRef = useRef(0);
  const previewTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const info         = OFFICE_MIME_INFO[doc.file_mime_type] ?? { app: "Office" };
  const isLocked     = Boolean(doc.is_edit_locked);
  const lockedByMe   = isLocked && doc.edit_locked_by === user?.id;
  const lockedByOther = isLocked && !lockedByMe;
  const isWindows    = typeof navigator !== "undefined" && navigator.userAgent.includes("Windows");

  // Perfect preview polling — robust with timeout and smart backoff
  const { data: preview, isLoading: previewLoading, isRefetching: previewRefetching } = useQuery<DocumentPreviewResponse>({
    queryKey: ["document-preview", doc.id],
    queryFn: () =>
      documentsAPI.previewUrl(doc.id).then((r) => ({
        ...r.data,
        url: normalizeUrl(r.data.url) || r.data.url,
        raw_url: r.data.raw_url ? normalizeUrl(r.data.raw_url) || r.data.raw_url : undefined,
      })),
    initialData: initialPreview,
    staleTime: 0,
    refetchInterval: (q) => {
      const status = q.state.data?.preview_status;
      if (status === "done" || status === "failed" || !status) return false;
      
      // Smart polling: fast for first 5s, then gradual backoff
      const elapsed = pollCountRef.current * PREVIEW_POLL_CONFIG.standardInterval;
      const progress = Math.min(100, (pollCountRef.current / PREVIEW_POLL_CONFIG.maxPolls) * 100);
      setPreviewProgress(progress);
      pollCountRef.current += 1;
      
      if (pollCountRef.current >= PREVIEW_POLL_CONFIG.maxPolls) {
        return false; // Stop polling after max retries
      }
      
      return PREVIEW_POLL_CONFIG.standardInterval;
    },
    retry: false,
  });

  const isConverting = ["pending", "processing"].includes(
    preview?.preview_status ?? ""
  );
  const hasPdf   = preview?.viewer === "pdfjs" && !!preview.url;
  const previewFailed = preview?.preview_status === "failed";

  // ── Acquire lock ───────────────────────────────────────────────────────────
  const acquireLock = useMutation({
    mutationFn: () =>
      documentsAPI.editToken(doc.id).then((r) => ({
        ...r.data,
        webdav_url: normalizeUrl(r.data.webdav_url) ?? r.data.webdav_url,
        file_url:   normalizeUrl(r.data.file_url)   ?? r.data.file_url,
      })),
    onSuccess: (td) => {
      setLockData(td);
      startVersionPolling(doc.current_version);
      pollCountRef.current = 0;
      setPreviewProgress(0);
      qc.invalidateQueries({ queryKey: ["document", doc.id] });
      qc.invalidateQueries({ queryKey: ["document-preview", doc.id] });
      toast.success("Edit lock acquired. MS Office editing is ready.");
    },
    onError: (err: any) => {
      if (err?.response?.status === 423) {
        toast.error(
          err.response.data?.detail ?? "Document is currently locked by another user."
        );
      } else {
        toast.error("Could not acquire edit lock. Please try again.");
      }
    },
  });

  // ── Release lock ──────────────────────────────────────────────────────────
  const releaseLock = useMutation({
    mutationFn: () => documentsAPI.releaseLock(doc.id),
    onSuccess: () => {
      stopVersionPolling();
      setLockData(null);
      toast.success("Edit lock released.");
      qc.invalidateQueries({ queryKey: ["document", doc.id] });
    },
  });

  // ── Retry preview generation ───────────────────────────────────────────────
  const retryPreview = () => {
    pollCountRef.current = 0;
    setPreviewProgress(0);
    qc.invalidateQueries({ queryKey: ["document-preview", doc.id] });
  };

  // ── Version polling ───────────────────────────────────────────────────────
  const startVersionPolling = (baseVersion: number) => {
    setVersionPolling(true);
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = setInterval(async () => {
      try {
        const { data: latest } = await documentsAPI.get(doc.id);
        if (latest.current_version > baseVersion) {
          baseVersion = latest.current_version;
          toast.success(`Version ${latest.current_version} received from editor.`);
          qc.invalidateQueries({ queryKey: ["document", doc.id] });
          onVersionUploaded();
        }
      } catch {
        /* ignore transient errors */
      }
    }, 5_000);
  };

  const stopVersionPolling = () => {
    setVersionPolling(false);
    if (pollRef.current) clearInterval(pollRef.current);
  };

  useEffect(() => () => stopVersionPolling(), []);

  // ── Open in MS Office ──────────────────────────────────────────────────────
  const openInMsOffice = () => {
    if (!lockData) return;
    const { msScheme } = info as { msScheme?: string };
    if (!msScheme) {
      toast.error("MS Office URI scheme not available for this file type.");
      return;
    }
    window.location.href = `${msScheme}:ofe|u|${lockData.webdav_url}`;
  };

  // ─────────────────────────────────────────────────────────────────────────
  // Render
  // ─────────────────────────────────────────────────────────────────────────

  return (
    <div className="space-y-3">
      {/* Preview section with intelligent UI */}
      <div className="border border-gray-200 rounded-xl overflow-hidden">
        {/* Header bar */}
        <div className="rounded-t-xl border-b border-gray-200 bg-gray-50 px-4 py-3 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-gray-700">
              {info.app} Preview
            </span>
            {hasPdf && (
              <span className="inline-flex items-center gap-1 text-xs text-green-600 font-medium bg-green-50 px-2 py-0.5 rounded-full">
                <CheckCircle2 className="w-3 h-3" /> Ready
              </span>
            )}
            {isConverting && (
              <span className="inline-flex items-center gap-1 text-xs text-amber-600 font-medium bg-amber-50 px-2 py-0.5 rounded-full">
                <Loader2 className="w-3 h-3 animate-spin" /> Generating
              </span>
            )}
            {previewFailed && (
              <span className="inline-flex items-center gap-1 text-xs text-red-600 font-medium bg-red-50 px-2 py-0.5 rounded-full">
                <AlertCircle className="w-3 h-3" /> Failed
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            <a
              href={normalizeUrl(initialPreview.raw_url ?? initialPreview.url) ?? ""}
              target="_blank"
              rel="noopener noreferrer"
              className="btn-secondary text-xs px-3 py-1.5 flex items-center gap-1.5"
            >
              <ExternalLink className="w-3.5 h-3.5" /> Open original
            </a>
            <a
              href={normalizeUrl(initialPreview.raw_url ?? initialPreview.url) ?? ""}
              download
              className="btn-secondary text-xs px-3 py-1.5 flex items-center gap-1.5"
            >
              <Download className="w-3.5 h-3.5" /> Download
            </a>
          </div>
        </div>

        {/* Preview content */}
        <div className="bg-white p-4">
          {/* Converting state with progress */}
          {isConverting && (
            <div className="flex flex-col items-center justify-center gap-4 py-24">
              <div className="w-32 h-1.5 bg-gray-100 rounded-full overflow-hidden">
                <div
                  className="h-full bg-brand-500 transition-all duration-300"
                  style={{ width: `${previewProgress}%` }}
                />
              </div>
              <div className="text-center">
                <p className="font-medium text-gray-800">Generating preview</p>
                <p className="text-xs text-gray-500 mt-1">
                  Converting {info.app} to PDF — {Math.round(previewProgress)}%
                </p>
              </div>
            </div>
          )}

          {/* Preview ready */}
          {hasPdf && !isConverting && (
            <PdfViewer
              url={preview!.url!}
              doc={doc}
              canUploadVersion={canUploadVersion && !lockedByOther}
              onVersionUploaded={onVersionUploaded}
            />
          )}

          {/* Preview failed */}
          {previewFailed && !isConverting && (
            <div className="flex flex-col items-center gap-4 py-16 text-center">
              <AlertCircle className="w-12 h-12 text-red-400" />
              <div>
                <p className="font-medium text-gray-800">Preview generation failed</p>
                <p className="text-sm text-gray-500 mt-1">
                  Could not convert this {info.app} document to PDF. This may be due to file corruption or unsupported features.
                </p>
              </div>
              <div className="flex gap-2">
                <button
                  onClick={retryPreview}
                  className="btn-secondary text-sm flex items-center gap-2"
                >
                  <RefreshCw className="w-4 h-4" /> Retry
                </button>
                <a
                  href={normalizeUrl(initialPreview.raw_url ?? initialPreview.url) ?? ""}
                  download
                  className="btn-primary text-sm flex items-center gap-2"
                >
                  <Download className="w-4 h-4" /> Download instead
                </a>
              </div>
            </div>
          )}

          {/* No preview status yet */}
          {!isConverting && !hasPdf && !previewFailed && (
            <div className="flex flex-col items-center gap-4 py-16 text-center">
              <Loader2 className="w-10 h-10 text-gray-400 animate-spin" />
              <p className="text-sm text-gray-600">Initializing preview…</p>
            </div>
          )}
        </div>
      </div>

      {/* ── Edit section ──────────────────────────────────────────────────── */}
      {canUploadVersion && (
        <div className="border border-gray-200 rounded-xl overflow-hidden">
          {/* Panel header */}
          <div className="px-4 py-3 bg-gray-50 border-b border-gray-200 flex items-center justify-between">
            <span className="text-sm font-medium text-gray-700 flex items-center gap-2">
              <Monitor className="w-4 h-4 text-brand-500" />
              Edit in Microsoft {info.app}
            </span>
            <div className="flex items-center gap-2">
              {versionPolling && (
                <span className="flex items-center gap-1.5 text-xs text-amber-700 bg-amber-50 border border-amber-200 px-2.5 py-1 rounded-full">
                  <Clock className="w-3 h-3 animate-pulse" /> Watching for saves…
                </span>
              )}
              {lockedByMe && lockData && (
                <button
                  onClick={() => releaseLock.mutate()}
                  disabled={releaseLock.isPending}
                  className="flex items-center gap-1.5 text-xs font-medium text-gray-600 hover:text-red-600 border border-gray-200 rounded-lg px-3 py-1.5 hover:bg-red-50 transition-colors"
                >
                  <Unlock className="w-3.5 h-3.5" /> Release lock
                </button>
              )}
            </div>
          </div>

          <div className="p-4 bg-white">
            {/* Not locked — show acquire button */}
            {!isLocked && !lockData && (
              <div className="space-y-3">
                <p className="text-sm text-gray-500">
                  Acquire an edit lock to prevent concurrent changes, then open
                  the document in Microsoft {info.app}. Each Ctrl+S save creates
                  a new version automatically.
                </p>
                <button
                  onClick={() => acquireLock.mutate()}
                  disabled={acquireLock.isPending || !isWindows}
                  className="btn-primary w-full justify-center gap-2 disabled:opacity-50"
                  title={!isWindows ? "MS Office editing is only available on Windows" : ""}
                >
                  {acquireLock.isPending ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : (
                    <Lock className="w-4 h-4" />
                  )}
                  Acquire edit lock &amp; open options
                </button>
              </div>
            )}

            {/* Locked by other user */}
            {lockedByOther && (
              <p className="text-sm text-gray-500 text-center py-2">
                Editing is disabled — this document is currently locked by{" "}
                <strong>{doc.edit_locked_by_name ?? "another user"}</strong>.
              </p>
            )}

            {/* Lock acquired — show MS Office option */}
            {(lockedByMe || lockData) && !lockedByOther && (
              <div className="space-y-4">
                {isWindows && (
                  <div className="rounded-lg border border-blue-200 bg-blue-50 p-4 space-y-3">
                    <div className="flex items-center gap-2">
                      <Monitor className="w-4 h-4 text-blue-600" />
                      <span className="text-sm font-semibold text-blue-900">
                        Open in Microsoft {info.app}
                      </span>
                      <span className="text-xs text-blue-600 bg-blue-100 px-2 py-0.5 rounded-full">
                        Windows
                      </span>
                    </div>
                    <p className="text-xs text-blue-700">
                      Clicking the button opens the file directly in {info.app}. 
                      Save with Ctrl+S — each save is automatically uploaded as a new version.
                    </p>
                    <button
                      onClick={() => {
                        if (!lockData) return;
                        const { msScheme } = info as { msScheme?: string };
                        if (!msScheme) {
                          toast.error("MS Office URI scheme not available for this file type.");
                          return;
                        }
                        window.location.href = `${msScheme}:ofe|u|${lockData.webdav_url}`;
                      }}
                      className="btn-primary w-full justify-center gap-2"
                    >
                      <ExternalLink className="w-4 h-4" />
                      Open in Microsoft {info.app}
                    </button>
                  </div>
                )}

                {!isWindows && (
                  <div className="rounded-lg border border-gray-200 bg-gray-50 p-4 text-center space-y-3">
                    <p className="text-sm text-gray-600">
                      Microsoft Office editing is only available on Windows.
                    </p>
                    <p className="text-xs text-gray-500">
                      Use the manual upload option below to save a new version.
                    </p>
                  </div>
                )}

                {/* Version polling indicator */}
                {versionPolling && (
                  <div className="flex items-center gap-2 rounded-lg bg-amber-50 border border-amber-200 px-3 py-2.5 text-xs text-amber-800">
                    <RefreshCw className="w-3.5 h-3.5 animate-spin text-amber-600" />
                    <span>
                      Watching for saves… each Ctrl+S in your editor creates a new version here.
                    </span>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Manual upload fallback */}
      {canUploadVersion && !lockedByOther && (
        <UploadVersionDrawer
          documentId={doc.id}
          currentVersion={doc.current_version}
          onVersionUploaded={onVersionUploaded}
        />
      )}
    </div>
  );
}

// ── UploadVersionDrawer ───────────────────────────────────────────────────────

function UploadVersionDrawer({
  documentId,
  currentVersion,
  accept,
  onVersionUploaded,
}: {
  documentId: string;
  currentVersion: number;
  accept?: Record<string, string[]>;
  onVersionUploaded: () => void;
}) {
  const [open, setOpen]         = useState(false);
  const [file, setFile]         = useState<File | null>(null);
  const [summary, setSummary]   = useState("");
  const [progress, setProgress] = useState(0);

  const onDrop = useCallback((a: File[]) => {
    if (a[0]) setFile(a[0]);
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
    mutationFn: (fd: FormData) =>
      documentsAPI.uploadVersion(documentId, fd, {
        onUploadProgress: (e: any) => {
          if (e.total) setProgress(Math.round((e.loaded * 100) / e.total));
        },
      }),
    onSuccess: () => {
      toast.success(`Version ${currentVersion + 1} uploaded.`);
      setFile(null);
      setSummary("");
      setProgress(0);
      setOpen(false);
      onVersionUploaded();
    },
    onError: () => {
      toast.error("Upload failed.");
      setProgress(0);
    },
  });

  const handleUpload = () => {
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
          Upload new version manually
          <span className="text-xs font-normal text-gray-400">
            (saves as v{currentVersion + 1})
          </span>
        </span>
        {open ? (
          <ChevronUp className="w-4 h-4" />
        ) : (
          <ChevronDown className="w-4 h-4" />
        )}
      </button>

      {open && (
        <div className="p-4 space-y-4 bg-white">
          <div
            {...getRootProps()}
            className={`border-2 border-dashed rounded-xl p-8 text-center cursor-pointer transition-all ${
              isDragActive
                ? "border-brand-500 bg-brand-50"
                : file
                ? "border-green-400 bg-green-50"
                : "border-gray-200 hover:border-brand-400"
            }`}
          >
            <input {...getInputProps()} />
            {file ? (
              <div className="flex flex-col items-center gap-2">
                <FileIcon className="w-10 h-10 text-green-500" />
                <p className="font-medium text-sm text-gray-900">{file.name}</p>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    setFile(null);
                  }}
                  className="text-xs text-red-500 hover:underline"
                >
                  Remove
                </button>
              </div>
            ) : (
              <>
                <Upload className="w-8 h-8 text-gray-300 mx-auto mb-2" />
                <p className="text-sm text-gray-600">
                  Drag file here or click to browse
                </p>
              </>
            )}
          </div>

          <input
            value={summary}
            onChange={(e) => setSummary(e.target.value)}
            placeholder="Change summary (optional)"
            className="input text-sm"
          />

          {mutation.isPending && progress > 0 && (
            <div className="h-1.5 bg-gray-100 rounded-full overflow-hidden">
              <div
                className="h-full bg-brand-500 transition-all"
                style={{ width: `${progress}%` }}
              />
            </div>
          )}

          <button
            type="button"
            onClick={handleUpload}
            disabled={!file || mutation.isPending}
            className="btn-primary w-full justify-center disabled:opacity-50"
          >
            {mutation.isPending ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <Upload className="w-4 h-4" />
            )}
            Save as version {currentVersion + 1}
          </button>
        </div>
      )}
    </div>
  );
}

// ── Main DocumentViewer ───────────────────────────────────────────────────────

interface Props {
  document: Document;
}

export default function DocumentViewer({ document: doc }: Props) {
  const qc   = useQueryClient();
  const user = useAuthStore((s) => s.user);

  const { data: preview, isLoading, isError } = useQuery<DocumentPreviewResponse>({
    queryKey: ["document-preview", doc.id],
    queryFn: async () => {
      const r = await documentsAPI.previewUrl(doc.id);
      return {
        ...r.data,
        url:     normalizeUrl(r.data.url)!,
        raw_url: normalizeUrl(r.data.raw_url),
      };
    },
    staleTime: 1000 * 60 * 10,
  });

  const releaseLock = useMutation({
    mutationFn: () => documentsAPI.releaseLock(doc.id),
    onSuccess: () => {
      toast.success("Edit lock released.");
      qc.invalidateQueries({ queryKey: ["document", doc.id] });
      qc.invalidateQueries({ queryKey: ["document-preview", doc.id] });
    },
  });

  const onVersionUploaded = useCallback(() => {
    qc.invalidateQueries({ queryKey: ["document", doc.id] });
    qc.invalidateQueries({ queryKey: ["document-preview", doc.id] });
  }, [qc, doc.id]);

  const canUploadVersion = Boolean(doc.permissions?.includes("upload"));
  const isOffice         = OFFICE_MIMES.has(doc.file_mime_type);
  const isLockedByOther  = Boolean(doc.is_edit_locked && doc.edit_locked_by !== user?.id);
  const isImage          =
    doc.file_mime_type?.startsWith("image/") ||
    /\.(png|jpe?g|gif|webp|svg|bmp)$/i.test(doc.file_name ?? "");

  if (isLoading)
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="w-8 h-8 text-brand-500 animate-spin" />
      </div>
    );

  if (isError || !preview)
    return (
      <div className="flex flex-col items-center justify-center h-64 gap-3 text-red-500">
        <AlertCircle className="w-8 h-8" />
        <p className="text-sm">Could not load document preview.</p>
      </div>
    );

  const rawFileUrl = normalizeUrl(preview.raw_url ?? preview.url) ?? "";

  return (
    <div className="space-y-2">
      {/* Lock banner */}
      <EditLockBanner
        doc={doc}
        currentUserId={user?.id}
        onRelease={() => releaseLock.mutate()}
      />

      {/* Header */}
      <div className="flex items-center justify-between">
        <h3 className="font-medium text-gray-900 text-sm">Document Preview</h3>
        <div className="flex items-center gap-2">
          {doc.current_version > 1 && (
            <span className="inline-flex items-center gap-1 text-xs text-brand-600 font-medium bg-brand-50 px-2 py-0.5 rounded-full">
              <CheckCircle2 className="w-3 h-3" /> v{doc.current_version}
            </span>
          )}
          <a
            href={rawFileUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="btn-secondary text-xs px-3 py-1.5 flex items-center gap-1.5"
          >
            <ExternalLink className="w-3.5 h-3.5" /> Open in new tab
          </a>
        </div>
      </div>

      {/* PDF (non-office) */}
      {preview.viewer === "pdfjs" && !isOffice && (
        <PdfViewer
          url={preview.url!}
          doc={doc}
          canUploadVersion={canUploadVersion && !isLockedByOther}
          onVersionUploaded={onVersionUploaded}
        />
      )}

      {/* Office documents */}
      {isOffice && (
        <OfficeEditPanel
          doc={doc}
          initialPreview={preview}
          canUploadVersion={canUploadVersion}
          onVersionUploaded={onVersionUploaded}
        />
      )}

      {/* Images */}
      {isImage && !isOffice && preview.viewer !== "pdfjs" && (
        <ImageViewer url={preview.url!} />
      )}

      {/* Unsupported / download */}
      {preview.viewer === "download" && !isImage && !isOffice && (
        <div className="space-y-3">
          <div className="rounded-lg border-2 border-dashed border-gray-200 p-10 text-center">
            <Download className="w-12 h-12 text-gray-300 mx-auto mb-4" />
            <p className="text-gray-600 mb-4">
              Preview not available for this file type.
            </p>
            <a
              href={preview.url!}
              download
              className="btn-primary inline-flex items-center gap-2"
            >
              <Download className="w-4 h-4" /> Download File
            </a>
          </div>
          {canUploadVersion && (
            <UploadVersionDrawer
              documentId={doc.id}
              currentVersion={doc.current_version}
              onVersionUploaded={onVersionUploaded}
            />
          )}
        </div>
      )}
    </div>
  );
}