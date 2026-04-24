/**
 * components/documents/DocumentViewer.tsx
 *
 * Architecture
 * ────────────
 * PREVIEW
 *   PDF              → PDF.js renderer
 *   Image            → <img> with zoom
 *   Office (docx/xlsx/pptx)
 *                    → LibreOffice-converted PDF preview (polled until done)
 *
 * EDITING — cross-platform via WebDAV + URI schemes
 *
 *   The ms-word:ofe|u|<url>, ms-excel:, ms-powerpoint: URI schemes are
 *   handled by MS Office on Windows AND by LibreOffice on Linux / macOS
 *   (LibreOffice registers itself as the handler for these schemes at
 *   install time on all platforms).
 *
 *   Flow:
 *     1. User clicks "Acquire edit lock" → POST /edit_token/
 *     2. Backend returns a webdav_url with the token in the path:
 *        https://host/api/v1/documents/webdav/<id>/<token>/<file>
 *     3. Frontend navigates to ms-word:ofe|u|<webdav_url> (or ms-excel: etc.)
 *     4. The OS hands the URI to the registered handler (MS Office or LibreOffice).
 *     5. The editor opens the file via WebDAV, carrying the token on every
 *        request — no credential dialog appears.
 *     6. Every Ctrl+S issues a WebDAV PUT → backend creates a new version.
 *     7. Frontend polls /documents/<id>/ every 5 s and toasts on version bump.
 *
 *   Fallback (file types with no URI scheme, e.g. .odt):
 *     → Download + UploadVersionDrawer (manual re-upload)
 *
 * LOCK MANAGEMENT
 *   Lock auto-expires after 1 hour.  User can release manually at any time.
 *   While locked, the frontend polls for version bumps every 5 s.
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

import { getCachedVersionPreview, setCachedVersionPreview } from "@/utils/versionPreviewCache";

import * as pdfjsLib from "pdfjs-dist";
import type { PDFDocumentProxy } from "pdfjs-dist";

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  "pdfjs-dist/build/pdf.worker.min.mjs",
  import.meta.url
).toString();

// ── Constants ──────────────────────────────────────────────────────────────────

const OFFICE_MIME_INFO: Record<string, { app: string; msScheme: string }> = {
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
const OFFICE_EXTENSIONS = new Set([
  ".doc", ".docx", ".docm", ".dot", ".dotx", ".dotm", ".rtf",
  ".xls", ".xlsx", ".xlsm", ".xlsb", ".xlt", ".xltx", ".xltm",
  ".ppt", ".pptx", ".pptm", ".pps", ".ppsx", ".pot", ".potx", ".potm",
  ".odt", ".ods", ".odp",
]);
const OFFICE_APP_BY_EXTENSION: Record<string, { app: string; msScheme: string }> = {
  ".doc":  { app: "Word",        msScheme: "ms-word"       },
  ".docx": { app: "Word",        msScheme: "ms-word"       },
  ".docm": { app: "Word",        msScheme: "ms-word"       },
  ".dot":  { app: "Word",        msScheme: "ms-word"       },
  ".dotx": { app: "Word",        msScheme: "ms-word"       },
  ".dotm": { app: "Word",        msScheme: "ms-word"       },
  ".rtf":  { app: "Word",        msScheme: "ms-word"       },
  ".xls":  { app: "Excel",       msScheme: "ms-excel"      },
  ".xlsx": { app: "Excel",       msScheme: "ms-excel"      },
  ".xlsm": { app: "Excel",       msScheme: "ms-excel"      },
  ".xlsb": { app: "Excel",       msScheme: "ms-excel"      },
  ".xlt":  { app: "Excel",       msScheme: "ms-excel"      },
  ".xltx": { app: "Excel",       msScheme: "ms-excel"      },
  ".xltm": { app: "Excel",       msScheme: "ms-excel"      },
  ".ppt":  { app: "PowerPoint",  msScheme: "ms-powerpoint" },
  ".pptx": { app: "PowerPoint",  msScheme: "ms-powerpoint" },
  ".pptm": { app: "PowerPoint",  msScheme: "ms-powerpoint" },
  ".pps":  { app: "PowerPoint",  msScheme: "ms-powerpoint" },
  ".ppsx": { app: "PowerPoint",  msScheme: "ms-powerpoint" },
  ".pot":  { app: "PowerPoint",  msScheme: "ms-powerpoint" },
  ".potx": { app: "PowerPoint",  msScheme: "ms-powerpoint" },
  ".potm": { app: "PowerPoint",  msScheme: "ms-powerpoint" },
};

// Preview polling timings
const POLL_INTERVAL_MS        = 2_000;
const POLL_TIMEOUT_MS         = 240_000; // 4 minutes
const FAILED_CONFIRM_DELAY_MS = 1_500;

// ── Utilities ──────────────────────────────────────────────────────────────────

function normalizeUrl(url: string | undefined): string | undefined {
  if (!url) return url;
  if (window.location.protocol === "https:" && url.startsWith("http://")) {
    return url.replace("http://", "https://");
  }
  return url;
}

function getFileExtension(name?: string): string {
  if (!name) return "";
  const idx = name.lastIndexOf(".");
  return idx >= 0 ? name.slice(idx).toLowerCase() : "";
}




function EditLockBanner({
  doc,
  currentUserId,
  onRelease,
}: {
  doc: Document;
  currentUserId: string | undefined;
  onRelease: () => void;
}) {
  const isLocked     = Boolean(doc.is_edit_locked);
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

// ── PdfViewer ──────────────────────────────────────────────────────────────────

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
    return () => { cancelled = true; };
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
            onClick={() => setScale((s) => Math.max(0.5, parseFloat((s - 0.2).toFixed(1))))}
            className="btn-secondary px-2 py-1"
          >
            <ZoomOut className="w-4 h-4" />
          </button>
          <span className="text-xs text-gray-600 w-12 text-center">
            {Math.round(scale * 100)}%
          </span>
          <button
            onClick={() => setScale((s) => Math.min(3, parseFloat((s + 0.2).toFixed(1))))}
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

// ── ImageViewer ────────────────────────────────────────────────────────────────

function ImageViewer({ url: rawUrl }: { url: string }) {
  const url               = normalizeUrl(rawUrl) || "";
  const [scale, setScale] = useState(1);
  const [err, setErr]     = useState(false);

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

// ── OfficeEditPanel ────────────────────────────────────────────────────────────

function OfficeEditPanel({
  doc,
  initialPreview,
  selectedVersionId,
  canUploadVersion,
  onVersionUploaded,
}: {
  doc: Document;
  initialPreview: DocumentPreviewResponse;
  selectedVersionId?: string | null;
  canUploadVersion: boolean;
  onVersionUploaded: () => void;
}) {
  const qc   = useQueryClient();
  const user = useAuthStore((s) => s.user);

  const [lockData, setLockData]               = useState<DocumentEditTokenResponse | null>(null);
  const [versionPolling, setVersionPolling]   = useState(false);
  const [previewProgress, setPreviewProgress] = useState(0);
  const [timedOut, setTimedOut]               = useState(false);
  const [isConfirmingFailed, setIsConfirmingFailed] = useState(false);
  const previewPollRef        = useRef<ReturnType<typeof setInterval> | null>(null);
  const versionPollRef        = useRef<ReturnType<typeof setInterval> | null>(null);
  const failedConfirmRef      = useRef<ReturnType<typeof setTimeout> | null>(null);
  const startTimeRef          = useRef<number | null>(null);
  const pollingRef            = useRef(false);

  const extension = getFileExtension(doc.file_name);
  const info      = OFFICE_MIME_INFO[doc.file_mime_type] ?? OFFICE_APP_BY_EXTENSION[extension] ?? { app: "Office", msScheme: "" };

  const isLocked      = Boolean(doc.is_edit_locked);
  const lockedByMe    = isLocked && doc.edit_locked_by === user?.id;
  const lockedByOther = isLocked && !lockedByMe;

  // ── Preview query ─────────────────────────────────────────────────────────

  const { data: preview, refetch: refetchPreview } = useQuery<DocumentPreviewResponse>({
    queryKey: ["document-preview", doc.id, selectedVersionId ?? "current"],
    queryFn: async () => {
      const cacheKey = `${doc.id}-${selectedVersionId ?? "current"}`;
      const cached = getCachedVersionPreview(cacheKey);
      
      if (cached && !selectedVersionId) {
        // For current version, serve from cache if available and fresh
        return cached;
      }
      
      try {
        const result = await documentsAPI.previewUrl(doc.id, selectedVersionId ?? undefined);
        const normalizedResult = {
          ...result.data,
          url: normalizeUrl(result.data.url) || result.data.url,
          raw_url: result.data.raw_url ? normalizeUrl(result.data.raw_url) || result.data.raw_url : undefined,
        };
        
        // Cache the result for future use
        setCachedVersionPreview(cacheKey, normalizedResult);
        return normalizedResult;
      } catch (error) {
        // If API call fails, try to serve from cache as fallback
        const fallback = getCachedVersionPreview(cacheKey);
        if (fallback) return fallback;
        throw error;
      }
    },
    placeholderData: initialPreview,
    staleTime: selectedVersionId ? 30_000 : 0, // Version previews stale after 30s, current always fresh
    refetchInterval: false,
    retry: 2,
  });

  // ── Preview polling ───────────────────────────────────────────────────────

  const stopPolling = useCallback(() => {
    pollingRef.current = false;
    if (previewPollRef.current) {
      clearInterval(previewPollRef.current);
      previewPollRef.current = null;
    }
  }, []);

  const clearFailedConfirmation = useCallback(() => {
    if (failedConfirmRef.current) {
      clearTimeout(failedConfirmRef.current);
      failedConfirmRef.current = null;
    }
    setIsConfirmingFailed(false);
  }, []);

  const startPolling = useCallback(() => {
    stopPolling();
    startTimeRef.current  = Date.now();
    // NOTE: do NOT call setTimedOut(false) here.
    // Only the explicit retry action should clear the timed-out state.
    // Calling it here caused a feedback loop:
    //   timedOut=true → useEffect fires → startPolling() → setTimedOut(false)
    //   → useEffect fires again → startPolling() → ... (infinite restart)
    pollingRef.current    = true;

    previewPollRef.current = setInterval(async () => {
      if (!pollingRef.current) return;

      const elapsed = Date.now() - (startTimeRef.current ?? Date.now());
      setPreviewProgress(Math.min(95, (elapsed / POLL_TIMEOUT_MS) * 100));

      if (elapsed >= POLL_TIMEOUT_MS) {
        stopPolling();
        setTimedOut(true);
        return;
      }

      try {
        const result = await refetchPreview();
        const s = result.data?.preview_status;
        if (s === "done") {
          stopPolling();
          setPreviewProgress(100);
        } else if (s === "failed") {
          stopPolling();
        }
      } catch {
        // transient network error — keep polling
      }
    }, POLL_INTERVAL_MS);
  }, [stopPolling, refetchPreview]);

  useEffect(() => {
    const s = preview?.preview_status;
    if (s === "pending" || s === "processing") {
      clearFailedConfirmation();
      // Guard: if the user's poll timer already fired (timedOut=true) do NOT
      // restart polling automatically. The backend job may still be running,
      // but we've already shown the timeout UI. Only an explicit Retry click
      // (which resets timedOut via retryPreviewMutation.onSuccess) should
      // resume polling. Without this guard, the effect re-running because
      // `timedOut` changed would call startPolling → setTimedOut(false) → effect
      // fires again → startPolling → … causing an infinite restart loop.
      if (!pollingRef.current && !timedOut) startPolling();
    } else if (s === "failed") {
      stopPolling();
      if (!failedConfirmRef.current && !timedOut) {
        setIsConfirmingFailed(true);
        failedConfirmRef.current = setTimeout(async () => {
          failedConfirmRef.current = null;
          try {
            const result = await refetchPreview();
            if (result.data?.preview_status !== "failed") {
              setIsConfirmingFailed(false);
              return;
            }
          } catch { /* keep current state */ }
          setIsConfirmingFailed(false);
        }, FAILED_CONFIRM_DELAY_MS);
      }
    } else {
      stopPolling();
      clearFailedConfirmation();
      if (s === "done") setPreviewProgress(100);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preview?.preview_status, timedOut]);

  useEffect(() => () => {
    stopPolling();
    if (failedConfirmRef.current) clearTimeout(failedConfirmRef.current);
  }, [stopPolling]);

  const isConverting  = !timedOut && ["pending", "processing"].includes(preview?.preview_status ?? "");
  const hasPdf        = preview?.viewer === "pdfjs" && !!preview.url;
  const previewFailed = (preview?.preview_status === "failed" && !isConfirmingFailed) || timedOut;
  const activeDownloadUrl = normalizeUrl(preview?.raw_url ?? preview?.url ?? initialPreview.raw_url ?? initialPreview.url) ?? "";

  // ── Lock mutations ────────────────────────────────────────────────────────

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
      qc.invalidateQueries({ queryKey: ["document", doc.id] });
      qc.invalidateQueries({ queryKey: ["document-preview", doc.id] });
      toast.success("Edit lock acquired. Open the document in your editor.");
    },
    onError: (err: any) => {
      if (err?.response?.status === 423) {
        toast.error(err.response.data?.detail ?? "Document is currently locked by another user.");
      } else {
        toast.error("Could not acquire edit lock. Please try again.");
      }
    },
  });

  const releaseLock = useMutation({
    mutationFn: () => documentsAPI.releaseLock(doc.id),
    onSuccess: () => {
      stopVersionPolling();
      setLockData(null);
      toast.success("Edit lock released.");
      qc.invalidateQueries({ queryKey: ["document", doc.id] });
    },
  });

  // ── Retry preview ─────────────────────────────────────────────────────────

  const retryPreviewMutation = useMutation({
    mutationFn: () =>
      selectedVersionId
        ? documentsAPI.triggerVersionPreview(doc.id, selectedVersionId)
        : documentsAPI.triggerPreview(doc.id),
    onSuccess: () => {
      // Clear the timed-out flag BEFORE restarting polling so the effect
      // guard (if !timedOut) doesn't block the new poll cycle.
      setTimedOut(false);
      setPreviewProgress(0);
      // Explicitly start polling here rather than relying on the status effect,
      // because the query invalidation is async — there's a window where the
      // effect sees the old status and the timedOut guard would block it anyway.
      startPolling();
      qc.invalidateQueries({
        queryKey: ["document-preview", doc.id, selectedVersionId ?? "current"],
      });
    },
    onError: (err: any) => {
      toast.error(err?.response?.data?.detail ?? "Could not queue preview. Please try again.");
    },
  });

  // ── Version polling ───────────────────────────────────────────────────────

  const startVersionPolling = (baseVersion: number) => {
    setVersionPolling(true);
    if (versionPollRef.current) clearInterval(versionPollRef.current);
    versionPollRef.current = setInterval(async () => {
      try {
        const { data: latest } = await documentsAPI.get(doc.id);
        if (latest.current_version > baseVersion) {
          baseVersion = latest.current_version;
          toast.success(`Version ${latest.current_version} saved from editor.`);
          qc.invalidateQueries({ queryKey: ["document", doc.id] });
          onVersionUploaded();
        }
      } catch { /* ignore transient errors */ }
    }, 5_000);
  };

  const stopVersionPolling = () => {
    setVersionPolling(false);
    if (versionPollRef.current) {
      clearInterval(versionPollRef.current);
      versionPollRef.current = null;
    }
  };

  useEffect(() => () => stopVersionPolling(), []);

  // ── Platform detection ────────────────────────────────────────────────────
  const isWindows = typeof navigator !== "undefined" && /Windows/i.test(navigator.userAgent);
  const isLinux   = typeof navigator !== "undefined"
                    && /Linux/i.test(navigator.userAgent)
                    && !/Android/i.test(navigator.userAgent);

  // Persisted flag: user has run the one-time install script.
  // After install the URI scheme works and we can fire it directly.
  const [handlerInstalled, setHandlerInstalled] = useState<boolean>(() => {
    try { return localStorage.getItem("docvault_handler_installed") === "1"; }
    catch { return false; }
  });
  const markHandlerInstalled = () => {
    try { localStorage.setItem("docvault_handler_installed", "1"); } catch {}
    setHandlerInstalled(true);
  };

  // ── Download helpers ──────────────────────────────────────────────────────
  const triggerBlobDownload = (blob: Blob, filename: string) => {
    const url = URL.createObjectURL(blob);
    const a   = document.createElement("a");
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
  };

  // One-time install script — no lock, no document-specific data.
  const downloadInstallScript = async () => {
    try {
      const res = await documentsAPI.installScript();
      triggerBlobDownload(new Blob([res.data], { type: "text/x-shellscript" }),
        "docvault-install-opener.sh");
    } catch {
      toast.error("Could not download install script. Please try again.");
    }
  };

  // Per-session open script — acquires lock + embeds token.
  const downloadOpenScript = async () => {
    try {
      const res     = await documentsAPI.openScript(doc.id);
      const safeName = doc.file_name.replace(/[^a-zA-Z0-9._-]/g, "_");
      triggerBlobDownload(new Blob([res.data], { type: "text/x-shellscript" }),
        `open-${safeName}.sh`);
      qc.invalidateQueries({ queryKey: ["document", doc.id] });
      startVersionPolling(doc.current_version);
    } catch (err: any) {
      if (err?.response?.status === 423)
        toast.error(err.response.data?.detail ?? "Document is locked by another user.");
      else
        toast.error("Could not generate open script. Please try again.");
    }
  };

  // Main open action — strategy is chosen by platform + install state.
  const openInEditor = () => {
    if (!lockData) return;
    const { msScheme } = info as { msScheme?: string };

    if (isWindows) {
      // Windows: MS Office / LibreOffice URI scheme — works natively.
      if (!msScheme) { toast.error("No URI scheme available for this file type."); return; }
      window.location.href = `${msScheme}:ofe|u|${lockData.webdav_url}`;

    } else if (isLinux && handlerInstalled) {
      // Linux + handler installed: fire docvault-open:// URI scheme.
      // The installed handler decodes the payload and calls soffice directly.
      const webdavUrl = lockData.webdav_url.replace(/^https?:\/\//, (m) =>
        m === "https://" ? "vnd.sun.star.webdavs://" : "vnd.sun.star.webdav://");
      const encoded = btoa(webdavUrl).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
      window.location.href = `docvault-open://${encoded}`;

    } else {
      // Linux without handler / macOS: fall back to per-session script download.
      downloadOpenScript();
    }
  };

  // ─────────────────────────────────────────────────────────────────────────
  // Render
  // ─────────────────────────────────────────────────────────────────────────

  return (
    <div className="space-y-3">
      {/* ── Preview card ─────────────────────────────────────────────────── */}
      <div className="border border-gray-200 rounded-xl overflow-hidden">
        {/* Header */}
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
              href={activeDownloadUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="btn-secondary text-xs px-3 py-1.5 flex items-center gap-1.5"
            >
              <ExternalLink className="w-3.5 h-3.5" /> Open original
            </a>
            <a
              href={activeDownloadUrl}
              download
              className="btn-secondary text-xs px-3 py-1.5 flex items-center gap-1.5"
            >
              <Download className="w-3.5 h-3.5" /> Download
            </a>
          </div>
        </div>

        {/* Preview body */}
        <div className="bg-white p-4">
          {/* Converting */}
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
            <div className="space-y-4">
              <div className="flex flex-col items-center gap-4 py-10 text-center">
                <AlertCircle className="w-12 h-12 text-red-400" />
                <div>
                  <p className="font-medium text-gray-800">
                    {timedOut ? "Preview timed out" : "Preview generation failed"}
                  </p>
                  <p className="text-sm text-gray-500 mt-1">
                    {timedOut
                      ? "The conversion is taking longer than expected. You can retry or use web preview."
                      : `Could not convert this ${info.app} document to PDF. Trying web preview may still work.`}
                  </p>
                  {preview?.preview_error && (
                    <p className="mt-2 text-xs text-red-600 bg-red-50 border border-red-200 rounded p-2 text-left max-w-2xl break-words">
                      Conversion error: {preview.preview_error}
                    </p>
                  )}
                </div>
                <div className="flex gap-2">
                  <button
                    onClick={() => retryPreviewMutation.mutate()}
                    disabled={retryPreviewMutation.isPending}
                    className="btn-secondary text-sm flex items-center gap-2 disabled:opacity-50"
                  >
                    {retryPreviewMutation.isPending
                      ? <Loader2 className="w-4 h-4 animate-spin" />
                      : <RefreshCw className="w-4 h-4" />}
                    Retry
                  </button>
                  <a
                    href={activeDownloadUrl}
                    download
                    className="btn-primary text-sm flex items-center gap-2"
                  >
                    <Download className="w-4 h-4" /> Download instead
                  </a>
                </div>
              </div>

            </div>
          )}

          {/* Initialising */}
          {!isConverting && !hasPdf && !previewFailed && (
            <div className="flex flex-col items-center gap-4 py-16 text-center">
              <Loader2 className="w-10 h-10 text-gray-400 animate-spin" />
              <p className="text-sm text-gray-600">Initializing preview…</p>
            </div>
          )}
        </div>
      </div>

      {/* ── Edit section ─────────────────────────────────────────────────── */}
      {canUploadVersion && (
        <div className="border border-gray-200 rounded-xl overflow-hidden">
          {/* Section header */}
          <div className="px-4 py-3 bg-gray-50 border-b border-gray-200 flex items-center justify-between">
            <span className="text-sm font-medium text-gray-700 flex items-center gap-2">
              <Monitor className="w-4 h-4 text-brand-500" />
              Edit in {info.app}
            </span>
            <div className="flex items-center gap-2">
              {versionPolling && (
                <span className="flex items-center gap-1.5 text-xs text-amber-700 bg-amber-50 border border-amber-200 px-2.5 py-1 rounded-full">
                  <Clock className="w-3 h-3 animate-pulse" /> Watching for saves…
                </span>
              )}
              {(lockedByMe || lockData) && (
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

          <div className="p-4 bg-white space-y-4">
            {/* ── Locked by someone else ── */}
            {lockedByOther && (
              <div className="flex items-center gap-3 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
                <Lock className="w-4 h-4 text-red-500 flex-shrink-0" />
                <span>
                  Editing is disabled — this document is currently locked by{" "}
                  <strong>{doc.edit_locked_by_name ?? "another user"}</strong>.
                </span>
              </div>
            )}

            {/* ── Not locked — show acquire button ── */}
            {!isLocked && !lockData && (
              <div className="space-y-3">
                <p className="text-sm text-gray-500">
                  Acquire an edit lock to prevent concurrent edits, then open
                  the document in your office editor (MS Office or LibreOffice).
                  Every Ctrl+S save is automatically uploaded as a new version.
                </p>
                <button
                  onClick={() => acquireLock.mutate()}
                  disabled={acquireLock.isPending}
                  className="btn-primary w-full justify-center gap-2 disabled:opacity-50"
                >
                  {acquireLock.isPending
                    ? <Loader2 className="w-4 h-4 animate-spin" />
                    : <Lock className="w-4 h-4" />}
                  Acquire edit lock
                </button>
              </div>
            )}

            {/* ── Lock acquired — show MS Office open button ── */}
            {(lockedByMe || lockData) && !lockedByOther && lockData && (
              <div className="space-y-4">
                {/* Save-watcher indicator */}
                {versionPolling && (
                  <div className="flex items-center gap-2 rounded-lg bg-amber-50 border border-amber-200 px-3 py-2.5 text-xs text-amber-800">
                    <RefreshCw className="w-3.5 h-3.5 animate-spin text-amber-600" />
                    <span>
                      Watching for saves… each Ctrl+S in your editor creates a new version here.
                    </span>
                  </div>
                )}

                {/* ── Editor open UI ── */}
                {info.msScheme ? (
                  <div className="space-y-3">
                    {/* Linux: one-time install banner */}
                    {isLinux && !handlerInstalled && (
                      <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 space-y-2">
                        <p className="text-xs font-medium text-amber-800">
                          One-time setup for one-click editing on Linux
                        </p>
                        <p className="text-xs text-amber-700">
                          Chrome on Linux can't launch LibreOffice directly via a URI scheme.
                          Run the install script once to register a handler — after that,
                          opening documents is a single click with no terminal required.
                        </p>
                        <div className="flex items-center gap-2">
                          <button
                            onClick={downloadInstallScript}
                            className="btn-secondary text-xs flex items-center gap-1.5"
                          >
                            <Download className="w-3.5 h-3.5" />
                            Download install script
                          </button>
                          <div className="flex-1 rounded bg-amber-900/10 border border-amber-200 px-2 py-1 font-mono text-[10px] text-amber-900">
                            chmod +x docvault-install-opener.sh && ./docvault-install-opener.sh
                          </div>
                        </div>
                        <button
                          onClick={markHandlerInstalled}
                          className="text-[11px] text-amber-600 hover:text-amber-800 underline"
                        >
                          I've already run the install script →
                        </button>
                      </div>
                    )}

                    {/* Main open button */}
                    <div className="rounded-lg border border-blue-200 bg-blue-50 p-4 space-y-3">
                      <div className="flex items-center gap-2">
                        <Monitor className="w-4 h-4 text-blue-600" />
                        <span className="text-sm font-semibold text-blue-900">
                          Open in {info.app}
                        </span>
                        <span className="text-xs text-blue-500 bg-blue-100 px-2 py-0.5 rounded-full">
                          {isWindows ? "MS Office / LibreOffice" : "LibreOffice"}
                        </span>
                      </div>

                      {isWindows ? (
                        <>
                          <p className="text-xs text-blue-700">
                            Opens directly in your installed editor. Save with{" "}
                            <kbd className="px-1 py-0.5 rounded bg-blue-100 font-mono text-[10px]">Ctrl+S</kbd>{" "}
                            — each save is uploaded as a new version here.
                          </p>
                          <button onClick={openInEditor} className="btn-primary w-full justify-center gap-2">
                            <ExternalLink className="w-4 h-4" /> Open in {info.app}
                          </button>
                        </>
                      ) : isLinux && handlerInstalled ? (
                        <>
                          <p className="text-xs text-blue-700">
                            One-click open via the installed DocVault handler. Save with{" "}
                            <kbd className="px-1 py-0.5 rounded bg-blue-100 font-mono text-[10px]">Ctrl+S</kbd>{" "}
                            — each save is uploaded as a new version here.
                          </p>
                          <button onClick={openInEditor} className="btn-primary w-full justify-center gap-2">
                            <ExternalLink className="w-4 h-4" /> Open in {info.app}
                          </button>
                          <button
                            onClick={() => setHandlerInstalled(false)}
                            className="text-[11px] text-blue-400 hover:text-blue-600 underline w-full text-center"
                          >
                            Handler not working? Re-install
                          </button>
                        </>
                      ) : (
                        <>
                          <p className="text-xs text-blue-700">
                            Downloads a script that opens this document in LibreOffice.
                            Run it in a terminal — each Ctrl+S save uploads a new version here.
                          </p>
                          <button onClick={openInEditor} className="btn-primary w-full justify-center gap-2">
                            <Download className="w-4 h-4" /> Download &amp; open in {info.app}
                          </button>
                          <div className="rounded bg-blue-900/10 border border-blue-200 px-2 py-1.5 font-mono text-[10px] text-blue-900 space-y-0.5">
                            <p className="text-blue-500 font-sans text-[10px] mb-1">After downloading, run in terminal:</p>
                            <p>chmod +x open-{doc.file_name.replace(/[^a-zA-Z0-9._-]/g, "_")}.sh</p>
                            <p>./open-{doc.file_name.replace(/[^a-zA-Z0-9._-]/g, "_")}.sh</p>
                          </div>
                        </>
                      )}
                    </div>
                  </div>
                ) : (
                  /* File type has no registered URI scheme (e.g. .odt, .ods) */
                  <div className="rounded-lg border border-gray-200 bg-gray-50 p-4 text-center space-y-2">
                    <p className="text-sm text-gray-600">
                      One-click editing is not available for this file type.
                    </p>
                    <p className="text-xs text-gray-500">
                      Download the file, edit it, then use{" "}
                      <strong>Upload new version</strong> below.
                    </p>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── Manual upload fallback ────────────────────────────────────────── */}
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

// ── UploadVersionDrawer ────────────────────────────────────────────────────────

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
        {open ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
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
                  onClick={(e) => { e.stopPropagation(); setFile(null); }}
                  className="text-xs text-red-500 hover:underline"
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

// ── Main DocumentViewer ────────────────────────────────────────────────────────

interface Props {
  document: Document;
}

export default function DocumentViewer({ document: doc }: Props) {
  const qc   = useQueryClient();
  const user = useAuthStore((s) => s.user);
  const [selectedVersionId, setSelectedVersionId] = useState<string | null>(null);

  useEffect(() => {
    setSelectedVersionId(null);
  }, [doc.id]);

  useEffect(() => {
    if (selectedVersionId && !doc.versions?.some((version) => version.id === selectedVersionId)) {
      setSelectedVersionId(null);
    }
  }, [doc.versions, selectedVersionId]);

  const { data: preview, isLoading, isError } = useQuery<DocumentPreviewResponse>({
    queryKey: ["document-preview", doc.id, selectedVersionId ?? "current"],
    queryFn: async () => {
      const cacheKey = `${doc.id}-${selectedVersionId ?? "current"}`;
      const cached = getCachedVersionPreview(cacheKey);
      
      // Serve from cache if available and fresh (for both current and version previews)
      if (cached) {
        return cached;
      }
      
      try {
        const r = await documentsAPI.previewUrl(doc.id, selectedVersionId ?? undefined);
        const normalizedResult = {
          ...r.data,
          url: normalizeUrl(r.data.url)!,
          raw_url: r.data.raw_url ? normalizeUrl(r.data.raw_url) : undefined,
        };
        
        // Cache the result for future use
        setCachedVersionPreview(cacheKey, normalizedResult);
        return normalizedResult;
      } catch (error) {
        // If API call fails, try to serve from cache as fallback
        const fallback = getCachedVersionPreview(cacheKey);
        if (fallback) return fallback;
        throw error;
      }
    },
    staleTime: selectedVersionId ? 30_000 : 0, // Version previews stale after 30s, current always fresh
    retry: 2,
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
  const isOfficeByMime   = OFFICE_MIMES.has(doc.file_mime_type);
  const isOfficeByExt    = OFFICE_EXTENSIONS.has(getFileExtension(doc.file_name));
  const isOffice         = isOfficeByMime || isOfficeByExt;
  const isLockedByOther  = Boolean(doc.is_edit_locked && doc.edit_locked_by !== user?.id);
  const isImage          =
    doc.file_mime_type?.startsWith("image/") ||
    /\.(png|jpe?g|gif|webp|svg|bmp)$/i.test(doc.file_name ?? "");

  // Preload next and previous versions for smoother navigation
  // This hook must be called before any early returns to satisfy React rules
  useEffect(() => {
    if (!doc.versions || !selectedVersionId) return;
    
    const currentIndex = doc.versions.findIndex(v => v.id === selectedVersionId);
    if (currentIndex === -1) return;
    
    // Preload adjacent versions in background
    const preloadVersions = [];
    if (currentIndex > 0) preloadVersions.push(doc.versions[currentIndex - 1].id);
    if (currentIndex < doc.versions.length - 1) preloadVersions.push(doc.versions[currentIndex + 1].id);
    
    preloadVersions.forEach(versionId => {
      const cacheKey = `${doc.id}-${versionId}`;
      if (!getCachedVersionPreview(cacheKey)) {
        // Trigger background fetch without blocking UI
        documentsAPI.previewUrl(doc.id, versionId).then(result => {
          const normalizedResult = {
            ...result.data,
            url: normalizeUrl(result.data.url) || result.data.url,
            raw_url: result.data.raw_url ? normalizeUrl(result.data.raw_url) || result.data.raw_url : undefined,
          };
          setCachedVersionPreview(cacheKey, normalizedResult);
        }).catch(() => {
          // Ignore background preload errors
        });
      }
    });
  }, [doc.id, doc.versions, selectedVersionId]);

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
  const selectedVersion = selectedVersionId
    ? doc.versions?.find((version) => version.id === selectedVersionId) ?? null
    : null;

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
          {selectedVersion ? (
            <span className="inline-flex items-center gap-1 text-xs text-sky-600 font-medium bg-sky-50 px-2 py-0.5 rounded-full">
              <CheckCircle2 className="w-3 h-3" /> Previewing v{selectedVersion.version_number}
            </span>
          ) : (
            <span className="inline-flex items-center gap-1 text-xs text-brand-600 font-medium bg-brand-50 px-2 py-0.5 rounded-full">
              <CheckCircle2 className="w-3 h-3" /> Current v{doc.current_version}
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

      {doc.versions?.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          {/* Current button - only show if it's different from all version buttons */}
          {(!doc.versions.some(v => v.version_number === doc.current_version)) && (
            <button
              type="button"
              onClick={() => setSelectedVersionId(null)}
              className={`text-xs px-2.5 py-1 rounded-full border transition-colors ${
                selectedVersionId === null
                  ? "border-primary bg-primary/10 text-primary"
                  : "border-gray-200 text-gray-600 hover:bg-gray-50"
              }`}
            >
              Current
            </button>
          )}
          {doc.versions.map((version) => {
            const isCurrentVersion = version.version_number === doc.current_version;
            const active = isCurrentVersion ? selectedVersionId === null : selectedVersionId === version.id;
            
            return (
              <button
                key={version.id}
                type="button"
                onClick={() => isCurrentVersion ? setSelectedVersionId(null) : setSelectedVersionId(version.id)}
                className={`text-xs px-2.5 py-1 rounded-full border transition-colors ${
                  active
                    ? isCurrentVersion
                      ? "border-primary bg-primary/10 text-primary"
                      : "border-sky-300 bg-sky-50 text-sky-700"
                    : "border-gray-200 text-gray-600 hover:bg-gray-50"
                }`}
                title={version.file_name}
              >
                v{version.version_number}
                {isCurrentVersion && (
                  <span className="ml-1 text-primary">★</span>
                )}
              </button>
            );
          })}
        </div>
      )}

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
          selectedVersionId={selectedVersionId}
          canUploadVersion={canUploadVersion}
          onVersionUploaded={onVersionUploaded}
        />
      )}

      {/* Images */}
      {isImage && !isOffice && preview.viewer !== "pdfjs" && (
        <ImageViewer url={preview.url!} />
      )}

      {/* Unsupported / download only */}
      {preview.viewer === "download" && !isImage && !isOffice && (
        <div className="space-y-3">
          <div className="rounded-lg border-2 border-dashed border-gray-200 p-10 text-center">
            <Download className="w-12 h-12 text-gray-300 mx-auto mb-4" />
            <p className="text-gray-600 mb-4">Preview not available for this file type.</p>
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
