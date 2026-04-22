/**
 * components/documents/DocumentViewer.tsx
 *
 * Architecture
 * \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
 * PREVIEW
 *   PDF              \u2192 PDF.js renderer
 *   Image            \u2192 <img> with zoom
 *   Office (docx/xlsx/pptx)
 *                    \u2192 Show download option + manual upload
 *                       (LibreOffice preview conversion is complex and often fails)
 *
 * EDITING \u2014 Windows + MS Office only
 *   "Open in Word/Excel/PowerPoint" button uses the ms-word:ofe|u|URL URI scheme
 *   to open the file directly in the installed Office app via WebDAV endpoint.
 *   Saves with Ctrl+S are automatically uploaded as new versions.
 *
 *   All other platforms or environments
 *     \u2192 Manual upload via UploadVersionDrawer
 *
 * LOCK MANAGEMENT
 *   Acquiring the edit lock (POST /edit_token/) is a prerequisite for editing.
 *   Lock is released when:
 *     \u2013 The user clicks "Release lock" manually
 *     \u2013 The lock expires naturally after 1 hour
 *   While locked, frontend polls for version changes every 5 s.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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

import * as pdfjsLib from "pdfjs-dist";
import type { PDFDocumentProxy } from "pdfjs-dist";

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  "pdfjs-dist/build/pdf.worker.min.mjs",
  import.meta.url
).toString();

// \u2500\u2500 Types \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

// \u2500\u2500 Constants \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

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
const OFFICE_EXTENSIONS = new Set([
  ".doc", ".docx", ".docm", ".dot", ".dotx", ".dotm", ".rtf",
  ".xls", ".xlsx", ".xlsm", ".xlsb", ".xlt", ".xltx", ".xltm",
  ".ppt", ".pptx", ".pptm", ".pps", ".ppsx", ".pot", ".potx", ".potm",
  ".odt", ".ods", ".odp",
]);
const OFFICE_APP_BY_EXTENSION: Record<string, { app: string; msScheme: string }> = {
  ".doc": { app: "Word", msScheme: "ms-word" },
  ".docx": { app: "Word", msScheme: "ms-word" },
  ".docm": { app: "Word", msScheme: "ms-word" },
  ".dot": { app: "Word", msScheme: "ms-word" },
  ".dotx": { app: "Word", msScheme: "ms-word" },
  ".dotm": { app: "Word", msScheme: "ms-word" },
  ".rtf": { app: "Word", msScheme: "ms-word" },
  ".xls": { app: "Excel", msScheme: "ms-excel" },
  ".xlsx": { app: "Excel", msScheme: "ms-excel" },
  ".xlsm": { app: "Excel", msScheme: "ms-excel" },
  ".xlsb": { app: "Excel", msScheme: "ms-excel" },
  ".xlt": { app: "Excel", msScheme: "ms-excel" },
  ".xltx": { app: "Excel", msScheme: "ms-excel" },
  ".xltm": { app: "Excel", msScheme: "ms-excel" },
  ".ppt": { app: "PowerPoint", msScheme: "ms-powerpoint" },
  ".pptx": { app: "PowerPoint", msScheme: "ms-powerpoint" },
  ".pptm": { app: "PowerPoint", msScheme: "ms-powerpoint" },
  ".pps": { app: "PowerPoint", msScheme: "ms-powerpoint" },
  ".ppsx": { app: "PowerPoint", msScheme: "ms-powerpoint" },
  ".pot": { app: "PowerPoint", msScheme: "ms-powerpoint" },
  ".potx": { app: "PowerPoint", msScheme: "ms-powerpoint" },
  ".potm": { app: "PowerPoint", msScheme: "ms-powerpoint" },
};

// \u2500\u2500 Utilities \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

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

// \u2500\u2500 EditLockBanner \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

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

// \u2500\u2500 PdfViewer \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

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
        <p className="text-sm text-gray-500">Loading PDF\u2026</p>
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

// \u2500\u2500 ImageViewer \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

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

// \u2500\u2500 OfficeEditPanel \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

/**
 * Office document preview polling:
 *
 * - Polls every 2 s (POLL_INTERVAL_MS) while status is pending/processing.
 * - Stops immediately when status becomes "done" or "failed" — no waiting
 *   for the next tick.
 * - Hard timeout at 90 s (POLL_TIMEOUT_MS); shows a timeout error after that.
 * - Progress bar is driven by wall-clock elapsed time vs the 90 s budget,
 *   capped at 95 % until the backend confirms "done" (then snaps to 100 %).
 * - Retry calls POST /trigger_preview/ (not just a cache invalidation) so
 *   the backend actually re-queues the Celery task.
 */

const POLL_INTERVAL_MS = 2_000;   // poll every 2 s
const POLL_TIMEOUT_MS  = 240_000;  // give up after 4 minutes

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

  const [lockData, setLockData]               = useState<DocumentEditTokenResponse | null>(null);
  const [versionPolling, setVersionPolling]   = useState(false);
  const [previewProgress, setPreviewProgress] = useState(0);
  const [timedOut, setTimedOut]               = useState(false);
  const previewPollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const versionPollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const startTimeRef = useRef<number | null>(null);
  // Tracks whether we are actively polling so the interval callback can
  // self-cancel without a stale-closure problem.
  const pollingRef   = useRef(false);
  const extension = getFileExtension(doc.file_name);

  const info          = OFFICE_MIME_INFO[doc.file_mime_type] ?? OFFICE_APP_BY_EXTENSION[extension] ?? { app: "Office" };
  const isLocked      = Boolean(doc.is_edit_locked);
  const lockedByMe    = isLocked && doc.edit_locked_by === user?.id;
  const lockedByOther = isLocked && !lockedByMe;
  const isWindows     = typeof navigator !== "undefined" && navigator.userAgent.includes("Windows");

  // ── Preview state (managed manually, not via React Query refetchInterval) ──
  //
  // We manage polling ourselves with setInterval so we can:
  //   1. Stop *immediately* when done arrives (not at the next tick).
  //   2. Drive the progress bar from wall-clock time.
  //   3. Enforce a hard 90 s timeout.
  //
  // React Query is still used for the initial fetch and cache sharing with
  // the parent DocumentViewer, but refetchInterval is disabled here.

  const { data: preview, refetch: refetchPreview } = useQuery<DocumentPreviewResponse>({
    queryKey: ["document-preview", doc.id],
    queryFn: () =>
      documentsAPI.previewUrl(doc.id).then((r) => ({
        ...r.data,
        url:     normalizeUrl(r.data.url)     || r.data.url,
        raw_url: r.data.raw_url ? normalizeUrl(r.data.raw_url) || r.data.raw_url : undefined,
      })),
    placeholderData: initialPreview,
    staleTime: 0,
    // Disable React Query's built-in refetch interval — we drive polling
    // ourselves so we can stop immediately on completion.
    refetchInterval: false,
    retry: false,
  });

  // ── Start / stop polling ───────────────────────────────────────────────────

  const stopPolling = useCallback(() => {
    pollingRef.current = false;
    if (previewPollRef.current) {
      clearInterval(previewPollRef.current);
      previewPollRef.current = null;
    }
  }, []);

  const startPolling = useCallback(() => {
    stopPolling();
    startTimeRef.current = Date.now();
    setTimedOut(false);
    pollingRef.current = true;

    previewPollRef.current = setInterval(async () => {
      if (!pollingRef.current) return;

      // Update progress bar from elapsed time.
      const elapsed = Date.now() - (startTimeRef.current ?? Date.now());
      setPreviewProgress(Math.min(95, (elapsed / POLL_TIMEOUT_MS) * 100));

      // Hard timeout.
      if (elapsed >= POLL_TIMEOUT_MS) {
        stopPolling();
        setTimedOut(true);
        return;
      }

      // Fetch latest status.
      try {
        const result = await refetchPreview();
        const s = result.data?.preview_status;

        if (s === "done") {
          stopPolling();
          setPreviewProgress(100);
        } else if (s === "failed") {
          stopPolling();
        }
        // pending / processing → keep polling
      } catch {
        // transient network error — keep polling
      }
    }, POLL_INTERVAL_MS);
  }, [stopPolling, refetchPreview]);

  // ── Kick off polling when status is pending/processing ────────────────────

  useEffect(() => {
    const s = preview?.preview_status;
    if (s === "pending" || s === "processing") {
      if (!pollingRef.current) {
        startPolling();
      }
    } else {
      // Terminal state — ensure polling is stopped.
      stopPolling();
      if (s === "done") setPreviewProgress(100);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preview?.preview_status]);

  // Cleanup on unmount.
  useEffect(() => () => stopPolling(), [stopPolling]);

  const isConverting  =
    !timedOut && ["pending", "processing"].includes(preview?.preview_status ?? "");
  const hasPdf        = preview?.viewer === "pdfjs" && !!preview.url;
  const previewFailed = preview?.preview_status === "failed" || timedOut;
  const webViewerUrl = useMemo(() => {
    const rawUrl = normalizeUrl(preview?.raw_url);
    if (!rawUrl) return "";
    return `https://view.officeapps.live.com/op/embed.aspx?src=${encodeURIComponent(rawUrl)}`;
  }, [preview?.raw_url]);

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

  // ── Release lock ───────────────────────────────────────────────────────────
  const releaseLock = useMutation({
    mutationFn: () => documentsAPI.releaseLock(doc.id),
    onSuccess: () => {
      stopVersionPolling();
      setLockData(null);
      toast.success("Edit lock released.");
      qc.invalidateQueries({ queryKey: ["document", doc.id] });
    },
  });

  // ── Retry preview — calls trigger_preview on the backend ──────────────────
  const retryPreviewMutation = useMutation({
    mutationFn: () => documentsAPI.triggerPreview(doc.id),
    onSuccess: () => {
      setTimedOut(false);
      setPreviewProgress(0);
      // Invalidate cache so the query re-fetches the new "pending" status,
      // then our useEffect will kick off polling again.
      qc.invalidateQueries({ queryKey: ["document-preview", doc.id] });
    },
    onError: (err: any) => {
      const msg = err?.response?.data?.detail ?? "Could not queue preview. Please try again.";
      toast.error(msg);
    },
  });

  // ── Version polling ────────────────────────────────────────────────────────
  const startVersionPolling = (baseVersion: number) => {
    setVersionPolling(true);
    if (versionPollRef.current) clearInterval(versionPollRef.current);
    versionPollRef.current = setInterval(async () => {
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
    if (versionPollRef.current) {
      clearInterval(versionPollRef.current);
      versionPollRef.current = null;
    }
  };

  // Cleanup version polling on unmount.
  useEffect(() => () => stopVersionPolling(), []);

  // \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
  // Render
  // \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

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
                  Converting {info.app} to PDF \u2014 {Math.round(previewProgress)}%
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
                    {retryPreviewMutation.isPending ? (
                      <Loader2 className="w-4 h-4 animate-spin" />
                    ) : (
                      <RefreshCw className="w-4 h-4" />
                    )}
                    Retry
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

              {webViewerUrl && (
                <div className="border border-gray-200 rounded-lg overflow-hidden">
                  <div className="px-3 py-2 border-b bg-gray-50 text-xs text-gray-600">
                    Web Office Viewer fallback
                  </div>
                  <iframe
                    src={webViewerUrl}
                    title="Office Web Preview"
                    className="w-full"
                    style={{ height: "70vh", border: 0 }}
                  />
                </div>
              )}
            </div>
          )}

          {/* No preview status yet */}
          {!isConverting && !hasPdf && !previewFailed && (
            <div className="flex flex-col items-center gap-4 py-16 text-center">
              <Loader2 className="w-10 h-10 text-gray-400 animate-spin" />
              <p className="text-sm text-gray-600">Initializing preview\u2026</p>
            </div>
          )}
        </div>
      </div>

      {/* \u2500\u2500 Edit section \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500 */}
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
                  <Clock className="w-3 h-3 animate-pulse" /> Watching for saves\u2026
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
            {/* Not locked \u2014 show acquire button */}
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
                Editing is disabled \u2014 this document is currently locked by{" "}
                <strong>{doc.edit_locked_by_name ?? "another user"}</strong>.
              </p>
            )}

            {/* Lock acquired \u2014 show MS Office option */}
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
                      Save with Ctrl+S \u2014 each save is automatically uploaded as a new version.
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
                      Watching for saves\u2026 each Ctrl+S in your editor creates a new version here.
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

// \u2500\u2500 UploadVersionDrawer \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

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

// \u2500\u2500 Main DocumentViewer \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

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
    // Keep the preview URL fresh.  10-minute staleTime means re-opening a
    // document after a conversion completes still shows the old "processing"
    // state from cache.  PDFs / images are stable once done, but Office docs
    // go through pending \u2192 processing \u2192 done transitions that must be visible
    // immediately on mount.  staleTime: 0 ensures a fresh fetch on every mount
    // while still using cached data for instant render.
    staleTime: 0,
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