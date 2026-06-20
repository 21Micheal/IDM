/**
 * components/documents/DocumentViewer.tsx
 *
 * Indigo Vault refresh + UI restructure
 * ─────────────────────────────────────
 * • Theming migrated to semantic HSL tokens (primary, accent, teal, destructive,
 *   muted) — no raw gray/blue/amber colors.
 * • "Open in <Editor>" is now a small, minimal inline button placed next to the
 *   version pills in the header — no more big blue card.
 * • The Office editor flow exposes a single primary action button. Lock state,
 *   install banner (Linux), and helper script blurbs are kept but compacted.
 * • UploadVersionDrawer is no longer a collapsible drawer — it renders inline
 *   below the document with a regular submit button (see UploadVersionDrawer.tsx).
 *
 * All business logic (PDF rendering, Office preview polling, lock acquisition,
 * version polling, install/open script flow, fallbacks) is unchanged.
 */

import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { documentsAPI, dmsSettingsAPI, api, apiBaseUrl, type DmsSettings } from "../../services/api";
import { useAuthStore } from "@/store/authStore";
import { toast } from "@/components/ui/vault-toast";
import {
  AlertCircle,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Clock,
  Download,
  ExternalLink,
  ImageOff,
  Loader2,
  Lock,
  RefreshCw,
  RotateCw,
  Unlock,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import type {
  Document,
  DocumentEditTokenResponse,
  DocumentPreviewResponse,
} from "@/types";

import {
  clearDocumentVersionCache,
  getCachedVersionPreview,
  getPreviewCacheKey,
  setCachedVersionPreview,
} from "@/utils/versionPreviewCache";

const UploadVersionDrawer = lazy(() =>
  import("@/components/documents/UploadVersionDrawer").then((module) => ({ default: module.UploadVersionDrawer }))
);
import type { ReactNode } from "react";
import type { PDFDocumentProxy } from "pdfjs-dist";

const pdfWorkerPath = new URL(
  "pdfjs-dist/build/pdf.worker.min.mjs",
  import.meta.url
).toString();

function getPdfjsLib() {
  return import("pdfjs-dist");
}

// ── Constants ──────────────────────────────────────────────────────────────────

const OFFICE_MIME_INFO: Record<string, { app: string; msScheme: string }> = {
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": { app: "Word", msScheme: "ms-word" },
  "application/msword": { app: "Word", msScheme: "ms-word" },
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": { app: "Excel", msScheme: "ms-excel" },
  "application/vnd.ms-excel": { app: "Excel", msScheme: "ms-excel" },
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": { app: "PowerPoint", msScheme: "ms-powerpoint" },
  "application/vnd.ms-powerpoint": { app: "PowerPoint", msScheme: "ms-powerpoint" },
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

const POLL_INTERVAL_MS        = 2_000;
const PREVIEW_DELAY_NOTICE_MS = 60_000;
const FAILED_CONFIRM_DELAY_MS = 1_500;

// ── Utilities ──────────────────────────────────────────────────────────────────

function normalizeUrl(url: string | null | undefined): string | undefined {
  if (!url) return url ?? undefined;
  // Re-host absolute API URLs onto the page origin. The backend builds file/
  // preview URLs with request.build_absolute_uri(), which leaks the proxy's
  // internal address (e.g. 127.0.0.1:8000) when the reverse proxy doesn't
  // preserve the Host header (IIS/ARR). Only OUR /api/ endpoints are rewritten,
  // so genuinely external URLs (e.g. S3) are left untouched.
  if (/^https?:\/\//i.test(url)) {
    try {
      const parsed = new URL(url);
      if (parsed.pathname.startsWith("/api/")) {
        parsed.protocol = window.location.protocol;
        parsed.host = window.location.host;
        return parsed.toString();
      }
    } catch {
      /* fall through to the scheme-only handling below */
    }
  }
  if (window.location.protocol === "https:" && url.startsWith("http://")) {
    return url.replace("http://", "https://");
  }
  return url;
}

// WebDAV URLs need different handling from normalizeUrl(). The desktop editor
// (Word/LibreOffice) must reach the backend at the SAME origin the SPA uses for
// its API calls — i.e. the backend or its WebDAV-capable reverse proxy. In dev
// the page is served by the Vite dev server (e.g. :3000) while the API lives on
// the backend (e.g. :8000); Vite's proxy does NOT forward WebDAV write methods
// (LOCK/PUT) to the ASGI backend, so rewriting the WebDAV URL onto the PAGE
// origin (as normalizeUrl does) makes the file open but every save fail with
// "object cannot be created in directory". Rewriting onto the API origin routes
// the editor straight to the backend, which speaks WebDAV. In production the API
// and page share an origin, so this collapses to the same result.
function getApiOrigin(): string | null {
  try {
    return new URL(apiBaseUrl, window.location.origin).origin;
  } catch {
    return null;
  }
}

function normalizeWebdavUrl(url: string | null | undefined): string | undefined {
  if (!url) return url ?? undefined;
  const apiOrigin = getApiOrigin();
  if (!apiOrigin) return normalizeUrl(url);
  try {
    const parsed = new URL(url, apiOrigin);
    const target = new URL(apiOrigin);
    parsed.protocol = target.protocol;
    parsed.host = target.host;
    return parsed.toString();
  } catch {
    return url;
  }
}

function getFileExtension(name?: string): string {
  if (!name) return "";
  const idx = name.lastIndexOf(".");
  return idx >= 0 ? name.slice(idx).toLowerCase() : "";
}

function WatermarkOverlay({
  settings,
  canDownload,
}: {
  settings?: DmsSettings;
  canDownload: boolean;
}) {
  if (canDownload || !settings?.watermark_enabled || !settings.watermark_apply_to_previews) return null;

  const text = settings.watermark_text?.trim() || "CONFIDENTIAL";
  const opacity = Math.max(0.01, Math.min(settings.watermark_opacity, 80) / 100);

  if (settings.watermark_position === "footer") {
    return (
      <div className="pointer-events-none absolute inset-x-0 bottom-8 z-20 flex justify-center">
        <span
          className="border border-foreground/20 bg-white/60 px-8 py-2 text-sm font-bold uppercase tracking-[0.2em] text-foreground"
          style={{ opacity }}
        >
          {text}
        </span>
      </div>
    );
  }

  if (settings.watermark_position === "center") {
    return (
      <div className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center overflow-hidden">
        <span
          className="select-none text-4xl font-bold uppercase tracking-[0.2em] text-foreground md:text-6xl"
          style={{ opacity }}
        >
          {text}
        </span>
      </div>
    );
  }

  return (
    <div className="pointer-events-none absolute inset-0 z-20 grid grid-cols-2 place-items-center overflow-hidden md:grid-cols-3">
      {Array.from({ length: 9 }).map((_, index) => (
        <span
          key={index}
          className="select-none text-2xl font-bold uppercase tracking-[0.2em] text-foreground md:text-4xl"
          style={{ opacity, transform: "rotate(-32deg)" }}
        >
          {text}
        </span>
      ))}
    </div>
  );
}

function WatermarkedPreview({
  settings,
  canDownload,
  children,
}: {
  settings?: DmsSettings;
  canDownload: boolean;
  children: ReactNode;
}) {
  return (
    <div className="relative">
      {children}
      <WatermarkOverlay settings={settings} canDownload={canDownload} />
    </div>
  );
}

// ── EditLockBanner ─────────────────────────────────────────────────────────────

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
      <div className="flex items-center justify-between gap-3 rounded-xl border border-accent/30 bg-accent/5 px-4 py-3 text-sm">
        <div className="flex items-center gap-2 text-foreground">
          <Lock className="w-4 h-4 text-accent flex-shrink-0" />
          <span>
            <strong>Locked by you.</strong> Other users can only view it until
            you close your editor or release the lock.
          </span>
        </div>
        <button
          onClick={onRelease}
          className="flex-shrink-0 inline-flex items-center gap-1.5 text-xs font-medium text-foreground border border-border rounded-lg px-3 py-1.5 hover:bg-muted transition-colors"
        >
          <Unlock className="w-3.5 h-3.5" /> Release
        </button>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-3 rounded-xl border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm">
      <Lock className="w-4 h-4 text-destructive flex-shrink-0" />
      <span className="text-foreground">
        Locked by <strong>{doc.edit_locked_by_name ?? "another user"}</strong>.
        View-only until they release it.
      </span>
    </div>
  );
}

// ── PdfViewer ──────────────────────────────────────────────────────────────────

function PdfViewer({
  url,
  // doc is not used inside PdfViewer; prefix with underscore to satisfy lint
  doc: _doc,
  canUploadVersion,
  onVersionUploaded,
}: {
  url: string | null;
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
    let task: { promise: Promise<PDFDocumentProxy>; destroy?: () => void } | null = null;

    setLoading(true);
    setError("");

    const normalizedUrl = normalizeUrl(url || "") || "";

    if (!normalizedUrl) {
      setLoading(false);
      setError("No preview URL available yet.");
      return () => { cancelled = true; };
    }

    const documentPromise = getPdfjsLib()
      .then((pdfjsLib) => {
        if (cancelled) return Promise.reject("cancelled");
        pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerPath;
        task = pdfjsLib.getDocument({
          url: normalizedUrl,
          withCredentials: true,
          httpHeaders: { Authorization: `Bearer ${token ?? ""}` },
        });
        return task.promise;
      });

    documentPromise
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
      task?.destroy?.();
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
        <Loader2 className="w-8 h-8 text-accent animate-spin" />
        <p className="text-sm text-muted-foreground">Loading PDF…</p>
      </div>
    );

  if (error)
    return (
      <div className="flex flex-col items-center justify-center h-64 gap-4 px-4 text-center">
        <AlertCircle className="w-8 h-8 text-destructive" />
        <p className="text-destructive text-sm">{error}</p>
      </div>
    );

  return (
    <div>
      {/* Toolbar */}
      <div className="flex items-center justify-between gap-2 border-b border-[#C8CDD2] bg-[#50545A] px-3 py-2 text-white">
        <div className="flex items-center gap-1">
          <button
            onClick={() => goTo(currentPage - 1)}
            disabled={currentPage <= 1}
            className="border border-white/20 bg-white/10 px-2 py-1 text-white hover:bg-white/15 disabled:opacity-40"
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
              className="w-12 border border-[#AEB5BB] bg-white px-1 py-0.5 text-center text-[#1F2933]"
            />
            <span className="text-white/75">/ {totalPages}</span>
          </div>
          <button
            onClick={() => goTo(currentPage + 1)}
            disabled={currentPage >= totalPages}
            className="border border-white/20 bg-white/10 px-2 py-1 text-white hover:bg-white/15 disabled:opacity-40"
          >
            <ChevronRight className="w-4 h-4" />
          </button>
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={() => setScale((s) => Math.max(0.5, parseFloat((s - 0.2).toFixed(1))))}
            className="border border-white/20 bg-white/10 px-2 py-1 text-white hover:bg-white/15"
          >
            <ZoomOut className="w-4 h-4" />
          </button>
          <span className="w-12 text-center text-xs text-white/75">
            {Math.round(scale * 100)}%
          </span>
          <button
            onClick={() => setScale((s) => Math.min(3, parseFloat((s + 0.2).toFixed(1))))}
            className="border border-white/20 bg-white/10 px-2 py-1 text-white hover:bg-white/15"
          >
            <ZoomIn className="w-4 h-4" />
          </button>
          <button
            onClick={() => setRotation((r) => (r + 90) % 360)}
            className="ml-1 border border-white/20 bg-white/10 px-2 py-1 text-white hover:bg-white/15"
          >
            <RotateCw className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Canvas */}
      <div
        className="overflow-auto bg-[#EDEDED] p-4"
        style={{ maxHeight: "calc(100vh - 18rem)" }}
      >
        <div ref={containerRef} className="mx-auto" />
      </div>

      {/* Upload section is rendered once below by the parent DocumentViewer. */}
      {/* canUploadVersion / onVersionUploaded intentionally unused here */}
      {void [canUploadVersion, onVersionUploaded] as unknown as null}
    </div>
  );
}

// ── ImageViewer ────────────────────────────────────────────────────────────────

function ImageViewer({
  url: rawUrl,
}: {
  url: string | null;
}) {
  const url               = normalizeUrl(rawUrl || "") || "";
  const [scale, setScale] = useState(1);
  const [err, setErr]     = useState(false);
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const token = useAuthStore((s) => s.accessToken);

  useEffect(() => {
    if (!url) {
      setBlobUrl(null);
      setErr(true);
      return;
    }
    let cancelled = false;
    let objectUrl = "";
    setErr(false);
    (async () => {
      try {
        const res = await api.get(url, {
          responseType: "blob",
          headers: token ? { Authorization: `Bearer ${token}` } : {},
        });
        if (cancelled) return;
        objectUrl = URL.createObjectURL(res.data);
        setBlobUrl(objectUrl);
      } catch {
        if (!cancelled) setErr(true);
      }
    })();
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [url, token]);

  const displayUrl = blobUrl || "";

  return (
    <div>
      <div className="flex items-center justify-between border-b border-[#C8CDD2] bg-[#50545A] px-3 py-2 text-white">
        <div className="flex items-center gap-1">
          <button
            onClick={() => setScale((s) => Math.max(0.25, s - 0.25))}
            className="border border-white/20 bg-white/10 px-2 py-1 text-white hover:bg-white/15"
          >
            <ZoomOut className="w-4 h-4" />
          </button>
          <button
            onClick={() => setScale(1)}
            className="min-w-[3.5rem] border border-white/20 bg-white/10 px-2 py-1 text-center text-xs text-white hover:bg-white/15"
          >
            {Math.round(scale * 100)}%
          </button>
          <button
            onClick={() => setScale((s) => Math.min(4, s + 0.25))}
            className="border border-white/20 bg-white/10 px-2 py-1 text-white hover:bg-white/15"
          >
            <ZoomIn className="w-4 h-4" />
          </button>
        </div>
      </div>
      <div
        className="flex items-start justify-center overflow-auto bg-[#EDEDED] p-4"
        style={{ maxHeight: "calc(100vh - 18rem)" }}
      >
        {err || !displayUrl ? (
          <div className="flex flex-col items-center gap-3 text-muted-foreground py-16">
            <ImageOff className="w-10 h-10" />
            <p className="text-sm">Image could not be loaded.</p>
          </div>
        ) : (
          <img
            src={displayUrl}
            alt="Preview"
            onError={() => setErr(true)}
            style={{
              transform: `scale(${scale})`,
              transformOrigin: "top center",
              transition: "transform 0.15s ease",
              maxWidth: "100%",
              display: "block",
            }}
            className="shadow-md"
          />
        )}
      </div>
    </div>
  );
}

// ── OfficeEditPanel ────────────────────────────────────────────────────────────

type OfficeEditPanelProps = {
  doc: Document;
  preview: DocumentPreviewResponse | undefined;
  refetchPreview: () => Promise<import("@tanstack/react-query").QueryObserverResult<DocumentPreviewResponse, Error>>;
  selectedVersionId?: string | null;
  canEditInEditor: boolean;
  onVersionUploaded: () => void;
  showHeaderOpenButton?: boolean;
  onBeforeRelease?: () => Promise<boolean>;
};

function OfficeEditPanel({
  doc,
  preview,
  refetchPreview,
  selectedVersionId,
  canEditInEditor,
  onVersionUploaded,
  showHeaderOpenButton = true,
  onBeforeRelease,
}: OfficeEditPanelProps) {
  const qc   = useQueryClient();
  const user = useAuthStore((s) => s.user);

  const [lockData, setLockData]               = useState<DocumentEditTokenResponse | null>(null);
  const [versionPolling, setVersionPolling]   = useState(false);
  const [previewProgress, setPreviewProgress] = useState(0);
  const [previewTakingLong, setPreviewTakingLong] = useState(false);
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
    setPreviewTakingLong(false);
    pollingRef.current    = true;

    previewPollRef.current = setInterval(async () => {
      if (!pollingRef.current) return;
      if (typeof document !== "undefined" && document.hidden) return;

      const elapsed = Date.now() - (startTimeRef.current ?? Date.now());
      setPreviewProgress(Math.min(95, (elapsed / PREVIEW_DELAY_NOTICE_MS) * 100));

      if (elapsed >= PREVIEW_DELAY_NOTICE_MS) {
        setPreviewTakingLong(true);
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
        // transient — keep polling
      }
    }, POLL_INTERVAL_MS);
  }, [stopPolling, refetchPreview]);

  useEffect(() => {
    const s = preview?.preview_status;
    if (s === "pending" || s === "processing") {
      clearFailedConfirmation();
      if (!pollingRef.current) startPolling();
    } else if (s === "failed") {
      stopPolling();
      if (!failedConfirmRef.current) {
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
     
  }, [preview?.preview_status]);

  useEffect(() => () => {
    stopPolling();
    if (failedConfirmRef.current) clearTimeout(failedConfirmRef.current);
  }, [stopPolling]);

  const isPreparing   = ["pending", "processing"].includes(preview?.preview_status ?? "");
  const hasPdf        = preview?.viewer === "pdfjs" && !!preview.url;
  const previewFailed = preview?.preview_status === "failed" && !isConfirmingFailed;

  // ── Lock mutations ────────────────────────────────────────────────────────

  const acquireLock = useMutation({
    mutationFn: () =>
      documentsAPI.editToken(doc.id).then((r) => ({
        ...r.data,
        webdav_url: normalizeWebdavUrl(r.data.webdav_url) ?? r.data.webdav_url,
        file_url:   normalizeUrl(r.data.file_url)   ?? r.data.file_url,
      })),
    onSuccess: (td) => {
      setLockData(td);
      startVersionPolling(doc.current_version);
      qc.invalidateQueries({ queryKey: ["document", doc.id] });
      qc.invalidateQueries({ queryKey: ["document-preview", doc.id] });
      toast.success("Locked by you. Open the document in your editor.");
    },
    onError: (err: any) => {
      if (err?.response?.status === 423) {
        toast.error(err.response.data?.detail ?? "Locked by another user.");
      } else {
        toast.error("Could not lock the document. Please try again.");
      }
    },
  });

  const releaseLock = useMutation({
    mutationFn: () => documentsAPI.releaseLock(doc.id),
    onSuccess: () => {
      stopVersionPolling();
      setLockData(null);
      toast.success("Released.");
      qc.invalidateQueries({ queryKey: ["document", doc.id] });
    },
  });

  const handleRelease = useCallback(async () => {
    if (onBeforeRelease && !(await onBeforeRelease())) return;
    releaseLock.mutate();
  }, [onBeforeRelease, releaseLock]);

  const retryPreviewMutation = useMutation({
    mutationFn: () =>
      selectedVersionId
        ? documentsAPI.triggerVersionPreview(doc.id, selectedVersionId)
        : documentsAPI.triggerPreview(doc.id),
    onSuccess: () => {
      setPreviewTakingLong(false);
      setPreviewProgress(0);
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
      if (typeof document !== "undefined" && document.hidden) return;
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

  const [handlerInstalled, setHandlerInstalled] = useState<boolean>(() => {
    try { return localStorage.getItem("docvault_handler_installed") === "1"; }
    catch { return false; }
  });
  const markHandlerInstalled = () => {
    try { localStorage.setItem("docvault_handler_installed", "1"); } catch { }
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

  const downloadInstallScript = async () => {
    try {
      const res = await documentsAPI.installScript();
      triggerBlobDownload(new Blob([res.data], { type: "text/x-shellscript" }),
        "docvault-install-opener.sh");
    } catch {
      toast.error("Could not download install script. Please try again.");
    }
  };

  const openInEditor = useCallback((data: { webdav_url: string } | null | undefined = lockData) => {
    if (!data) return;
    const { msScheme } = info as { msScheme?: string };

    if (isWindows) {
      if (!msScheme) { toast.error("No URI scheme available for this file type."); return; }
      window.location.href = `${msScheme}:ofe|u|${data.webdav_url}`;
    } else if (isLinux && handlerInstalled) {
      const webdavUrl = data.webdav_url.replace(/^https?:\/\//, (m) =>
        m === "https://" ? "vnd.sun.star.webdavs://" : "vnd.sun.star.webdav://");
      const encoded = btoa(webdavUrl).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
      window.location.href = `docvault-open://${encoded}`;
    }
  }, [handlerInstalled, info, isLinux, isWindows, lockData]);

  // Open the live document in the desktop app READ-ONLY (no lock). Available to
  // members without edit rights so they can view in Word/LibreOffice; the server
  // rejects any save attempt against a read-only token.
  const openReadOnly = useCallback(async () => {
    try {
      const r = await documentsAPI.readOnlyToken(doc.id);
      const webdav_url = normalizeWebdavUrl(r.data.webdav_url) ?? r.data.webdav_url;
      openInEditor({ webdav_url });
    } catch {
      toast.error("Could not open the document. Please try again.");
    }
  }, [doc.id, openInEditor]);

  /**
   * "Open in <App>" — Infor-style check-out behaviour:
   *   • you hold the lock        → open editable
   *   • you can edit & unlocked  → auto-check-out (lock), then open editable
   *   • locked by someone else, or no edit rights → open READ-ONLY
   */
  const handleOpenInApp = useCallback(() => {
    if (isLinux && !handlerInstalled) {
      toast.info("Run the one-time Linux install script before opening documents in the editor.");
      return;
    }
    // Fresh editable token already in hand this session → open straight away.
    if (lockData) {
      openInEditor();
      return;
    }
    // We hold the lock (e.g. after a page reload, or it was taken via the Lock
    // button) but have no editor token yet — or we can take the lock now.
    // Either way (re)acquire an editable WebDAV token, then open. acquire_lock
    // is idempotent for the current holder, so this also refreshes the lock and
    // guarantees the editor opens with a valid token it can save through.
    if (lockedByMe || (canEditInEditor && !lockedByOther)) {
      acquireLock.mutate(undefined, { onSuccess: (data) => openInEditor(data) });
      return;
    }
    openReadOnly();
  }, [acquireLock, canEditInEditor, handlerInstalled, isLinux, lockData, lockedByMe, lockedByOther, openInEditor, openReadOnly]);

  // Explicit check-out (no editor). This is what enables metadata "Edit details".
  const handleLock = useCallback(() => acquireLock.mutate(), [acquireLock]);

  const isLockedByAnyone = lockedByMe || lockedByOther;
  // Office docs that can be opened in a desktop editor on this platform.
  const canOpenInApp = Boolean(info.msScheme) && (isWindows || (isLinux && handlerInstalled));
  // Whether "Open in <app>" will be read-only for this user.
  const willOpenReadOnly = !lockedByMe && !lockData && (lockedByOther || !canEditInEditor);

  // ─────────────────────────────────────────────────────────────────────────
  // Render
  // ─────────────────────────────────────────────────────────────────────────

  return (
    <div className="space-y-3">
      {/* Minimal toolbar row — preview status + Open in editor */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[#C8CDD2] bg-white px-3 py-2">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-sm font-semibold text-[#1F2933]">{info.app} preview</span>
          {hasPdf && (
            <span className="inline-flex items-center gap-1 text-xs text-teal font-medium bg-teal/10 px-2 py-0.5 rounded-full border border-teal/20">
              <CheckCircle2 className="w-3 h-3" /> Ready
            </span>
          )}
          {isPreparing && (
            <span className="inline-flex items-center gap-1 text-xs text-accent font-medium bg-accent/10 px-2 py-0.5 rounded-full border border-accent/20">
              <Loader2 className="w-3 h-3 animate-spin" /> Preparing
            </span>
          )}
          {previewTakingLong && isPreparing && (
            <span className="inline-flex items-center gap-1 text-xs text-amber-700 font-medium bg-amber-500/10 px-2 py-0.5 rounded-full border border-amber-500/20">
              <Clock className="w-3 h-3" /> Taking longer
            </span>
          )}
          {previewFailed && (
            <span className="inline-flex items-center gap-1 text-xs text-destructive font-medium bg-destructive/10 px-2 py-0.5 rounded-full border border-destructive/20">
              <AlertCircle className="w-3 h-3" /> Failed
            </span>
          )}
          {versionPolling && (
            <span className="inline-flex items-center gap-1.5 text-xs text-accent bg-accent/10 border border-accent/20 px-2 py-0.5 rounded-full">
              <Clock className="w-3 h-3 animate-pulse" /> Watching for saves
            </span>
          )}
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          {canOpenInApp && showHeaderOpenButton && (
            <button
              onClick={handleOpenInApp}
              disabled={acquireLock.isPending}
              className="inline-flex items-center gap-1.5 bg-[#287EAD] px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-[#206D99] disabled:opacity-50"
              title={willOpenReadOnly ? `Open in ${info.app} (read-only)` : `Open in ${info.app}`}
            >
              {acquireLock.isPending
                ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                : <ExternalLink className="w-3.5 h-3.5" />}
              Open in {info.app}{willOpenReadOnly ? " (read-only)" : ""}
            </button>
          )}
          {canEditInEditor && !isLockedByAnyone && showHeaderOpenButton && (
            <button
              onClick={handleLock}
              disabled={acquireLock.isPending}
              className="inline-flex items-center gap-1.5 border border-[#287EAD] px-3 py-1.5 text-xs font-medium text-[#287EAD] transition-colors hover:bg-[#EEF6FB] disabled:opacity-50"
              title="Lock (check out) to edit this document or its details"
            >
              <Lock className="w-3.5 h-3.5" /> Lock
            </button>
          )}
          {lockedByMe && (
            <button
              onClick={handleRelease}
              disabled={releaseLock.isPending}
              className="inline-flex items-center gap-1.5 border border-[#C8CDD2] px-2.5 py-1.5 text-xs font-medium text-[#5E6870] transition-colors hover:bg-destructive/5 hover:text-destructive disabled:opacity-50"
              title="Release (check in)"
            >
              <Unlock className="w-3.5 h-3.5" /> Release
            </button>
          )}
        </div>
      </div>

      {/* Linux install one-time banner */}
      {isLinux && canOpenInApp && !lockedByOther && !handlerInstalled && (
        <div className="mx-3 space-y-2 border border-accent/30 bg-accent/5 p-3">
          <p className="text-xs font-medium text-foreground">
            One-time setup for one-click editing on Linux
          </p>
          <p className="text-xs text-muted-foreground">
            Before editing in {info.app}, run the install script once to register
            the local opener. After that, editing works from the regular button.
          </p>
          <div className="flex items-center gap-2 flex-wrap">
            <button
              onClick={downloadInstallScript}
              className="btn-secondary text-xs"
            >
              <Download className="w-3.5 h-3.5" />
              Download install script
            </button>
            <code className="rounded bg-muted border border-border px-2 py-1 font-mono text-[10px] text-foreground">
              chmod +x docvault-install-opener.sh && ./docvault-install-opener.sh
            </code>
          </div>
          <button
            onClick={markHandlerInstalled}
            className="text-[11px] text-accent hover:text-accent/80 underline"
          >
            I've already run the install script →
          </button>
        </div>
      )}

      {/* Preview body */}
      <div className="overflow-hidden border border-[#C8CDD2] bg-white">
        <div className="bg-white">
          {isPreparing && (
            <div className="flex flex-col items-center justify-center gap-4 py-24">
              <div className="h-1.5 w-32 overflow-hidden bg-[#D3D7DA]">
                <div
                  className="h-full bg-accent transition-all duration-300"
                  style={{ width: `${previewProgress}%` }}
                />
              </div>
              <div className="text-center">
                <p className="font-medium text-foreground">Preparing preview</p>
                <p className="text-xs text-muted-foreground mt-1">
                  {previewTakingLong
                    ? "This is taking longer than usual, but it is still in progress."
                    : `Almost ready — ${Math.round(previewProgress)}%`}
                </p>
              </div>
            </div>
          )}

          {hasPdf && !isPreparing && (
            <PdfViewer
              url={preview!.url}
              doc={doc}
              canUploadVersion={false /* upload section is rendered once below */}
              onVersionUploaded={onVersionUploaded}
            />
          )}

          {previewFailed && !isPreparing && (
            <div className="flex flex-col items-center gap-4 py-10 text-center">
              <AlertCircle className="w-12 h-12 text-destructive" />
              <div>
                <p className="font-medium text-foreground">
                  Preview could not be prepared
                </p>
                <p className="text-sm text-muted-foreground mt-1">
                  Try again shortly. Some documents take longer than others.
                </p>
                {preview?.preview_error && (
                  <p className="mt-2 text-xs text-destructive bg-destructive/5 border border-destructive/20 rounded p-2 text-left max-w-2xl break-words">
                    Details: {preview.preview_error}
                  </p>
                )}
              </div>
              <div className="flex gap-2">
                <button
                  onClick={() => retryPreviewMutation.mutate()}
                  disabled={retryPreviewMutation.isPending}
                  className="border border-[#C8CDD2] bg-white px-3 py-2 text-sm hover:bg-[#F5F7F8]"
                >
                  {retryPreviewMutation.isPending
                    ? <Loader2 className="w-4 h-4 animate-spin" />
                    : <RefreshCw className="w-4 h-4" />}
                  Retry
                </button>
              </div>
            </div>
          )}

          {!isPreparing && !hasPdf && !previewFailed && (
            <div className="flex flex-col items-center gap-4 py-16 text-center">
              <Loader2 className="w-10 h-10 text-muted-foreground animate-spin" />
              <p className="text-sm text-muted-foreground">Initializing preview…</p>
            </div>
          )}
        </div>
      </div>

      {/* Helper note when the file type can't be opened directly */}
      {!info.msScheme && !isLinux && canEditInEditor && !lockedByOther && (
        <div className="mx-3 border border-[#C8CDD2] bg-[#F5F7F8] px-4 py-3 text-xs text-[#5E6870]">
          One-click editing is not available for this file type. Download the
          file, edit it locally, then use <strong>Upload version manually</strong>{" "}
          below to save the new version.
        </div>
      )}

      {/* Manual upload section is rendered once below by the parent DocumentViewer. */}
    </div>
  );
}

// ── Main DocumentViewer ────────────────────────────────────────────────────────

interface Props {
  document: Document;
  /**
   * Optional action node rendered alongside the "Upload new version" button
   * in the action bar below the document (e.g. a "Submit for approval"
   * button supplied by the parent page).
   */
  submitSlot?: ReactNode;
  /**
   * Hide the upload action bar rendered beneath the preview.
   */
  hideUploadActionBar?: boolean;
  /**
   * Inform the page when the current preview links become available.
   */
  onPreviewLinksChange?: (links: {
    openInNewTabUrl: string;
    downloadHref: string;
    signedFileUrlsEnabled: boolean;
  }) => void;
  /**
   * Called when the user attempts to release (check in) the lock. Lets the
   * page resolve unsaved metadata edits first (Infor-style Save / Discard /
   * Cancel prompt). Resolve `false` to abort the release.
   */
  onBeforeRelease?: () => Promise<boolean>;
}

export default function DocumentViewer({ document: doc, submitSlot, hideUploadActionBar, onPreviewLinksChange, onBeforeRelease }: Props) {
  const qc   = useQueryClient();
  const user = useAuthStore((s) => s.user);
  const [selectedVersionId, setSelectedVersionId] = useState<string | null>(null);
  const sortedVersions = useMemo(
    () => [...(doc.versions ?? [])].sort((a, b) => a.version_number - b.version_number),
    [doc.versions],
  );

  useEffect(() => {
    setSelectedVersionId(null);
  }, [doc.id]);

  useEffect(() => {
    if (selectedVersionId && !sortedVersions.some((version) => version.id === selectedVersionId)) {
      setSelectedVersionId(null);
    }
  }, [sortedVersions, selectedVersionId]);

  const previewCacheKey = getPreviewCacheKey(doc.id, doc.current_version, selectedVersionId);
  const initialCachedPreview = getCachedVersionPreview(previewCacheKey);

  const prefetchVersionPreview = useCallback((versionId: string | null) => {
    const queryKey = ["document-preview", doc.id, versionId ?? "current", versionId ? null : doc.current_version] as const;
    if (qc.getQueryData<DocumentPreviewResponse>(queryKey)) return;

    void qc.prefetchQuery({
      queryKey,
      queryFn: async () => {
        const result = await documentsAPI.previewUrl(doc.id, versionId ?? undefined);
        const normalizedResult = {
          ...result.data,
          url: normalizeUrl(result.data.url ?? undefined) ?? result.data.url ?? null,
          raw_url: result.data.raw_url ? normalizeUrl(result.data.raw_url) : undefined,
        };
        return normalizedResult;
      },
      staleTime: 5 * 60_000,
      retry: 2,
    }).catch(() => {});
  }, [doc.id, doc.current_version, qc]);

  const { data: preview, isLoading, isError, refetch: refetchPreview } = useQuery<DocumentPreviewResponse, Error, DocumentPreviewResponse>({
    queryKey: ["document-preview", doc.id, selectedVersionId ?? "current", selectedVersionId ? null : doc.current_version],
    queryFn: async () => {
      const cached = getCachedVersionPreview(previewCacheKey);
      if (cached?.preview_status === "done" && cached.url) {
        return cached;
      }

      try {
        const r = await documentsAPI.previewUrl(doc.id, selectedVersionId ?? undefined);
        const normalizedResult = {
          ...r.data,
          url: normalizeUrl(r.data.url ?? undefined) ?? r.data.url ?? null,
          raw_url: r.data.raw_url ? normalizeUrl(r.data.raw_url) : undefined,
        };

        setCachedVersionPreview(previewCacheKey, normalizedResult);
        return normalizedResult;
      } catch (error) {
        const fallback = getCachedVersionPreview(previewCacheKey);
        if (fallback?.preview_status === "done" && fallback.url) return fallback;
        throw error;
      }
    },
    placeholderData: initialCachedPreview ?? undefined,
    staleTime: 5 * 60_000,
    retry: 2,
  });

  const releaseLock = useMutation({
    mutationFn: () => documentsAPI.releaseLock(doc.id),
    onSuccess: () => {
      toast.success("Released.");
      qc.invalidateQueries({ queryKey: ["document", doc.id] });
      qc.invalidateQueries({ queryKey: ["document-preview", doc.id] });
    },
  });

  const handleRelease = useCallback(async () => {
    if (onBeforeRelease && !(await onBeforeRelease())) return;
    releaseLock.mutate();
  }, [onBeforeRelease, releaseLock]);

  const onVersionUploaded = useCallback(() => {
    setSelectedVersionId(null);
    clearDocumentVersionCache(doc.id);
    qc.removeQueries({ queryKey: ["document-preview", doc.id] });
    qc.invalidateQueries({ queryKey: ["document", doc.id] });
    qc.invalidateQueries({ queryKey: ["document-preview", doc.id] });
  }, [qc, doc.id]);

  const canUploadVersion = Boolean(doc.permissions?.includes("upload")) || Boolean(user?.has_admin_access);
  const canEdit          = Boolean(doc.permissions?.includes("edit")) || Boolean(user?.has_admin_access);
  const canDownload      = Boolean(doc.permissions?.includes("download")) || Boolean(user?.has_admin_access);
  const { data: dmsSettings } = useQuery({
    queryKey: ["dms-settings"],
    queryFn: () => dmsSettingsAPI.get().then((r) => r.data),
    staleTime: 60_000,
  });
  const isOfficeByMime   = OFFICE_MIMES.has(doc.file_mime_type);
  const isOfficeByExt    = OFFICE_EXTENSIONS.has(getFileExtension(doc.file_name));
  const isOffice         = isOfficeByMime || isOfficeByExt;
  const isLockedByOther  = Boolean(doc.is_edit_locked && doc.edit_locked_by !== user?.id);
  const isImage          =
    doc.file_mime_type?.startsWith("image/") ||
    /\.(png|jpe?g|gif|webp|svg|bmp)$/i.test(doc.file_name ?? "");

  const onPreviewLinksChangeRef = useRef(onPreviewLinksChange);
  useEffect(() => {
    onPreviewLinksChangeRef.current = onPreviewLinksChange;
  }, [onPreviewLinksChange]);

  // Preload adjacent versions for snappier nav
  useEffect(() => {
    if (sortedVersions.length === 0) return;

    const currentIndex = selectedVersionId
      ? sortedVersions.findIndex(v => v.id === selectedVersionId)
      : sortedVersions.findIndex(v => v.version_number === doc.current_version);
    if (currentIndex === -1) return;

    const preloadVersions: string[] = [];
    if (currentIndex > 0) preloadVersions.push(sortedVersions[currentIndex - 1].id);
    if (currentIndex < sortedVersions.length - 1) preloadVersions.push(sortedVersions[currentIndex + 1].id);

    let cancelled = false;
    const preload = () => {
      preloadVersions.forEach(versionId => {
        const cacheKey = `${doc.id}-${versionId}`;
        if (!getCachedVersionPreview(cacheKey)) {
          documentsAPI.previewUrl(doc.id, versionId).then(result => {
            if (cancelled) return;
            const normalizedResult = {
              ...result.data,
              url: normalizeUrl(result.data.url ?? undefined) ?? result.data.url ?? null,
              raw_url: result.data.raw_url ? normalizeUrl(result.data.raw_url) || result.data.raw_url : undefined,
            };
            setCachedVersionPreview(cacheKey, normalizedResult);
          }).catch(() => { /* ignore preload errors */ });
        }
      });
    };

    if (typeof window !== "undefined" && "requestIdleCallback" in window) {
      const idleHandle = (window as any).requestIdleCallback(preload, { timeout: 1200 });
      return () => {
        cancelled = true;
        (window as any).cancelIdleCallback(idleHandle);
      };
    }

    const timeoutHandle = setTimeout(preload, 250);
    return () => {
      cancelled = true;
      clearTimeout(timeoutHandle);
    };
  }, [doc.id, sortedVersions, selectedVersionId, doc.current_version]);

  useEffect(() => {
    let last = 0;
    const onPrint = () => {
      const now = Date.now();
      if (now - last < 4000) return;
      last = now;
      documentsAPI.filePrintEvent(doc.id).catch(() => {});
    };
    window.addEventListener("beforeprint", onPrint);
    return () => window.removeEventListener("beforeprint", onPrint);
  }, [doc.id]);

  const openInNewTabUrl = canDownload && preview ? (normalizeUrl(preview.url ?? "") ?? "") : "";
  const downloadHref = canDownload && preview ? (normalizeUrl(preview.raw_url ?? "") ?? "") : "";
  const downloadViaAuthenticatedRequest = async () => {
    if (!downloadHref) return;
    try {
      const res = await api.get(downloadHref, { responseType: "blob" });
      const blobUrl = URL.createObjectURL(new Blob([res.data]));
      const link = document.createElement("a");
      link.href = blobUrl;
      link.download = doc.file_name || "document";
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(blobUrl), 1000);
    } catch {
      toast.error("Could not download this file.");
    }
  };

  const selectedVersion = selectedVersionId
    ? sortedVersions.find((version) => version.id === selectedVersionId) ?? null
    : null;

  useEffect(() => {
    onPreviewLinksChangeRef.current?.({
      openInNewTabUrl,
      downloadHref,
      signedFileUrlsEnabled: Boolean(preview?.signed_file_urls_enabled),
    });
  }, [openInNewTabUrl, downloadHref, preview?.signed_file_urls_enabled]);

  if (isLoading)
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="w-8 h-8 text-accent animate-spin" />
      </div>
    );

  if (isError || !preview)
    return (
      <div className="flex flex-col items-center justify-center h-64 gap-3 text-destructive">
        <AlertCircle className="w-8 h-8" />
        <p className="text-sm">Could not load document preview.</p>
      </div>
    );

  return (
    <div className="space-y-0 bg-white">
      {/* Lock banner */}
      {doc.is_edit_locked && (
        <div className="p-3 pb-0">
          <EditLockBanner
            doc={doc}
            currentUserId={user?.id}
            onRelease={handleRelease}
          />
        </div>
      )}

      {/* Header — title + version indicator + edit action */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[#C8CDD2] bg-white px-3 py-2">
        <div className="flex items-center gap-2 flex-wrap">
          <h3 className="text-sm font-semibold text-[#1F2933]">Document preview</h3>
          {selectedVersion ? (
            <span className="inline-flex items-center gap-1 text-xs text-accent font-medium bg-accent/10 border border-accent/20 px-2 py-0.5 rounded-full">
              <CheckCircle2 className="w-3 h-3" /> Previewing v{selectedVersion.version_number}
            </span>
          ) : (
            <span className="inline-flex items-center gap-1 text-xs text-teal font-medium bg-teal/10 border border-teal/20 px-2 py-0.5 rounded-full">
              <CheckCircle2 className="w-3 h-3" /> Current v{doc.current_version}
            </span>
          )}
        </div>
      </div>

      {/* Version pills */}
      {sortedVersions.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 border-b border-[#C8CDD2] bg-[#F5F7F8] px-3 py-2">
          {(!sortedVersions.some(v => v.version_number === doc.current_version)) && (
            <button
              type="button"
              onClick={() => setSelectedVersionId(null)}
              onMouseEnter={() => prefetchVersionPreview(null)}
              onFocus={() => prefetchVersionPreview(null)}
                className={`border px-2.5 py-1 text-xs transition-colors ${
                selectedVersionId === null
                  ? "border-[#287EAD] bg-white text-[#287EAD]"
                  : "border-[#C8CDD2] text-[#5E6870] hover:bg-white"
              }`}
            >
              Current
            </button>
          )}
          {sortedVersions.map((version) => {
            const isCurrentVersion = version.version_number === doc.current_version;
            const active = isCurrentVersion ? selectedVersionId === null : selectedVersionId === version.id;

            return (
              <button
                key={version.id}
                type="button"
                onClick={() => isCurrentVersion ? setSelectedVersionId(null) : setSelectedVersionId(version.id)}
                onMouseEnter={() => prefetchVersionPreview(isCurrentVersion ? null : version.id)}
                onFocus={() => prefetchVersionPreview(isCurrentVersion ? null : version.id)}
                className={`border px-2.5 py-1 text-xs transition-colors ${
                  active
                    ? isCurrentVersion
                      ? "border-[#287EAD] bg-white text-[#287EAD]"
                      : "border-[#287EAD] bg-white text-[#287EAD]"
                    : "border-[#C8CDD2] text-[#5E6870] hover:bg-white"
                }`}
                title={version.file_name}
              >
                v{version.version_number}
                {isCurrentVersion && (
                  <span className="ml-1 text-teal">★</span>
                )}
              </button>
            );
          })}
        </div>
      )}

      {/* PDF (non-office) */}
      {preview.viewer === "pdfjs" && !isOffice && (
        <WatermarkedPreview settings={dmsSettings} canDownload={canDownload}>
          <PdfViewer
            url={preview.url}
            doc={doc}
            canUploadVersion={canUploadVersion && !isLockedByOther}
            onVersionUploaded={onVersionUploaded}
          />
        </WatermarkedPreview>
      )}

      {/* Office documents */}
      {isOffice && (
        <WatermarkedPreview settings={dmsSettings} canDownload={canDownload}>
          <OfficeEditPanel
            doc={doc}
            preview={preview}
            refetchPreview={refetchPreview}
            selectedVersionId={selectedVersionId}
            canEditInEditor={canEdit}
            onVersionUploaded={onVersionUploaded}
            showHeaderOpenButton
            onBeforeRelease={onBeforeRelease}
          />
        </WatermarkedPreview>
      )}

      {/* Images */}
      {isImage && !isOffice && preview.viewer !== "pdfjs" && (
        <WatermarkedPreview settings={dmsSettings} canDownload={canDownload}>
          <ImageViewer url={preview.url} />
        </WatermarkedPreview>
      )}

      {/* Unsupported / download only */}
      {preview.viewer === "download" && !isImage && !isOffice && (
        <div className="border-2 border-dashed border-[#C8CDD2] p-10 text-center">
          <Download className="w-12 h-12 text-muted-foreground mx-auto mb-4" />
          <p className="text-foreground/80 mb-4">Preview not available for this file type.</p>
          {canDownload && preview.url && preview.signed_file_urls_enabled && (
          <a
            href={preview.url}
            download
            className="btn-primary inline-flex items-center gap-2"
          >
            <Download className="w-4 h-4" /> Download file
          </a>
          )}
          {canDownload && preview.url && !preview.signed_file_urls_enabled && (
            <button
              type="button"
              onClick={downloadViaAuthenticatedRequest}
              className="btn-primary inline-flex items-center gap-2"
            >
              <Download className="w-4 h-4" /> Download file
            </button>
          )}
          {!canDownload && (
            <p className="text-sm text-muted-foreground">You do not have permission to download this file.</p>
          )}
        </div>
      )}

      {/*
        Single action bar below the document.
        Contains "Upload new version" (button + modal) and any caller-supplied
        action (e.g. "Submit for approval"). Hidden if there's nothing to show.
      */}
      {((canUploadVersion && !isLockedByOther && !hideUploadActionBar) || submitSlot) && (
        <div className="flex flex-wrap items-center justify-end gap-2 border-t border-[#C8CDD2] px-3 py-2">
          {canUploadVersion && !isLockedByOther && !hideUploadActionBar && (
            <Suspense fallback={<div className="inline-flex h-11 items-center justify-center rounded-lg border border-border bg-card px-4 text-sm text-muted-foreground">Loading upload tools…</div>}>
              <UploadVersionDrawer
                documentId={doc.id}
                currentVersion={doc.current_version}
                maxSizeMb={doc.document_type?.max_file_size_mb}
                onVersionUploaded={onVersionUploaded}
              />
            </Suspense>
          )}
          {submitSlot}
        </div>
      )}
    </div>
  );
}
