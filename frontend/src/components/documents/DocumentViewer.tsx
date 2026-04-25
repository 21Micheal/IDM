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

import { useCallback, useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { documentsAPI } from "../../services/api";
import { useAuthStore } from "@/store/authStore";
import { toast } from "react-toastify";
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
  getCachedVersionPreview,
  setCachedVersionPreview,
} from "@/utils/versionPreviewCache";

import { UploadVersionDrawer } from "@/components/documents/UploadVersionDrawer";
import type { ReactNode } from "react";

import * as pdfjsLib from "pdfjs-dist";
import type { PDFDocumentProxy } from "pdfjs-dist";

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  "pdfjs-dist/build/pdf.worker.min.mjs",
  import.meta.url
).toString();

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
const POLL_TIMEOUT_MS         = 240_000;
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

function getPreviewCacheKey(
  documentId: string,
  currentVersion: number,
  versionId?: string | null,
): string {
  return versionId
    ? `${documentId}-${versionId}`
    : `${documentId}-current-v${currentVersion}`;
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
            <strong>You are editing this document.</strong> Other users can only
            view it until you close your editor or release the lock.
          </span>
        </div>
        <button
          onClick={onRelease}
          className="flex-shrink-0 inline-flex items-center gap-1.5 text-xs font-medium text-foreground border border-border rounded-lg px-3 py-1.5 hover:bg-muted transition-colors"
        >
          <Unlock className="w-3.5 h-3.5" /> Release lock
        </button>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-3 rounded-xl border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm">
      <Lock className="w-4 h-4 text-destructive flex-shrink-0" />
      <span className="text-foreground">
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
        <Loader2 className="w-8 h-8 text-accent animate-spin" />
        <p className="text-sm text-muted-foreground">Loading PDF…</p>
      </div>
    );

  if (error)
    return (
      <div className="flex flex-col items-center justify-center h-64 gap-4 px-4 text-center">
        <AlertCircle className="w-8 h-8 text-destructive" />
        <p className="text-destructive text-sm">{error}</p>
        <a href={url} download className="btn-secondary inline-flex items-center gap-2">
          <Download className="w-4 h-4" /> Download
        </a>
      </div>
    );

  return (
    <div>
      {/* Toolbar */}
      <div className="flex items-center justify-between gap-2 bg-muted border border-border rounded-t-lg px-3 py-2">
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
              className="w-12 text-center border border-input bg-card rounded px-1 py-0.5 text-foreground"
            />
            <span className="text-muted-foreground">/ {totalPages}</span>
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
          <span className="text-xs text-muted-foreground w-12 text-center">
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
        className="overflow-auto bg-muted/60 border border-t-0 border-border rounded-b-lg p-4"
        style={{ maxHeight: "70vh" }}
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

function ImageViewer({ url: rawUrl }: { url: string }) {
  const url               = normalizeUrl(rawUrl) || "";
  const [scale, setScale] = useState(1);
  const [err, setErr]     = useState(false);

  return (
    <div>
      <div className="flex items-center justify-between bg-muted border border-border rounded-t-lg px-3 py-2">
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
        className="overflow-auto bg-muted/60 border border-t-0 border-border rounded-b-lg p-4 flex items-start justify-center"
        style={{ maxHeight: "75vh" }}
      >
        {err ? (
          <div className="flex flex-col items-center gap-3 text-muted-foreground py-16">
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
    queryKey: ["document-preview", doc.id, selectedVersionId ?? "current", selectedVersionId ? null : doc.current_version],
    queryFn: async () => {
      const cacheKey = getPreviewCacheKey(doc.id, doc.current_version, selectedVersionId);
      const cached = getCachedVersionPreview(cacheKey);

      if (cached && !selectedVersionId) {
        return cached;
      }

      try {
        const result = await documentsAPI.previewUrl(doc.id, selectedVersionId ?? undefined);
        const normalizedResult = {
          ...result.data,
          url: normalizeUrl(result.data.url) || result.data.url,
          raw_url: result.data.raw_url ? normalizeUrl(result.data.raw_url) || result.data.raw_url : undefined,
        };

        setCachedVersionPreview(cacheKey, normalizedResult);
        return normalizedResult;
      } catch (error) {
        const fallback = getCachedVersionPreview(cacheKey);
        if (fallback) return fallback;
        throw error;
      }
    },
    placeholderData: initialPreview,
    staleTime: selectedVersionId ? 30_000 : 0,
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
        // transient — keep polling
      }
    }, POLL_INTERVAL_MS);
  }, [stopPolling, refetchPreview]);

  useEffect(() => {
    const s = preview?.preview_status;
    if (s === "pending" || s === "processing") {
      clearFailedConfirmation();
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

  const retryPreviewMutation = useMutation({
    mutationFn: () =>
      selectedVersionId
        ? documentsAPI.triggerVersionPreview(doc.id, selectedVersionId)
        : documentsAPI.triggerPreview(doc.id),
    onSuccess: () => {
      setTimedOut(false);
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

  const openInEditor = () => {
    if (!lockData) return;
    const { msScheme } = info as { msScheme?: string };

    if (isWindows) {
      if (!msScheme) { toast.error("No URI scheme available for this file type."); return; }
      window.location.href = `${msScheme}:ofe|u|${lockData.webdav_url}`;
    } else if (isLinux && handlerInstalled) {
      const webdavUrl = lockData.webdav_url.replace(/^https?:\/\//, (m) =>
        m === "https://" ? "vnd.sun.star.webdavs://" : "vnd.sun.star.webdav://");
      const encoded = btoa(webdavUrl).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
      window.location.href = `docvault-open://${encoded}`;
    }
  };

  /**
   * One-click handler used by the minimal "Open in <App>" button.
   * If we don't yet have a lock we acquire it first, then open the editor
   * once the mutation resolves.
   */
  const handleOpenClick = () => {
    if (lockedByOther) return;
    if (isLinux && !handlerInstalled) {
      toast.info("Run the one-time Linux install script before starting document editing.");
      return;
    }
    if (lockData) {
      openInEditor();
      return;
    }
    acquireLock.mutate(undefined, {
      onSuccess: () => {
        // openInEditor is called after lockData is set; defer to next tick
        setTimeout(() => openInEditor(), 0);
      },
    });
  };

  const canShowOpenButton = canUploadVersion && !lockedByOther;
  const openLabel = lockData || lockedByMe
    ? `Open in ${info.app}`
    : `Edit in ${info.app}`;

  // ─────────────────────────────────────────────────────────────────────────
  // Render
  // ─────────────────────────────────────────────────────────────────────────

  return (
    <div className="space-y-3">
      {/* Minimal toolbar row — preview status + Open in editor */}
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-sm font-medium text-foreground">{info.app} preview</span>
          {hasPdf && (
            <span className="inline-flex items-center gap-1 text-xs text-teal font-medium bg-teal/10 px-2 py-0.5 rounded-full border border-teal/20">
              <CheckCircle2 className="w-3 h-3" /> Ready
            </span>
          )}
          {isConverting && (
            <span className="inline-flex items-center gap-1 text-xs text-accent font-medium bg-accent/10 px-2 py-0.5 rounded-full border border-accent/20">
              <Loader2 className="w-3 h-3 animate-spin" /> Generating
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
          <a
            href={activeDownloadUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="btn-secondary text-xs px-3 py-1.5"
          >
            <ExternalLink className="w-3.5 h-3.5" /> Open original
          </a>
          <a
            href={activeDownloadUrl}
            download
            className="btn-secondary text-xs px-3 py-1.5"
          >
            <Download className="w-3.5 h-3.5" /> Download
          </a>
          {canShowOpenButton && (
            <button
              onClick={handleOpenClick}
              disabled={acquireLock.isPending}
              className="inline-flex items-center gap-1.5 rounded-md bg-accent text-accent-foreground text-xs font-medium px-3 py-1.5 hover:bg-accent/90 disabled:opacity-50 transition-colors"
              title={openLabel}
            >
              {acquireLock.isPending
                ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                : <ExternalLink className="w-3.5 h-3.5" />}
              {openLabel}
            </button>
          )}
          {(lockedByMe || lockData) && (
            <button
              onClick={() => releaseLock.mutate()}
              disabled={releaseLock.isPending}
              className="inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground hover:text-destructive border border-border rounded-md px-2.5 py-1.5 hover:bg-destructive/5 transition-colors"
            >
              <Unlock className="w-3.5 h-3.5" /> Release lock
            </button>
          )}
        </div>
      </div>

      {/* Locked-by-other notice */}
      {lockedByOther && (
        <div className="flex items-center gap-3 rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-foreground">
          <Lock className="w-4 h-4 text-destructive flex-shrink-0" />
          <span>
            Editing is disabled — this document is currently locked by{" "}
            <strong>{doc.edit_locked_by_name ?? "another user"}</strong>.
          </span>
        </div>
      )}

      {/* Linux install one-time banner */}
      {isLinux && canShowOpenButton && !handlerInstalled && (
        <div className="rounded-lg border border-accent/30 bg-accent/5 p-3 space-y-2">
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
      <div className="card overflow-hidden">
        <div className="bg-card p-4">
          {isConverting && (
            <div className="flex flex-col items-center justify-center gap-4 py-24">
              <div className="w-32 h-1.5 bg-muted rounded-full overflow-hidden">
                <div
                  className="h-full bg-accent transition-all duration-300"
                  style={{ width: `${previewProgress}%` }}
                />
              </div>
              <div className="text-center">
                <p className="font-medium text-foreground">Generating preview</p>
                <p className="text-xs text-muted-foreground mt-1">
                  Converting {info.app} to PDF — {Math.round(previewProgress)}%
                </p>
              </div>
            </div>
          )}

          {hasPdf && !isConverting && (
            <PdfViewer
              url={preview!.url!}
              doc={doc}
              canUploadVersion={false /* upload section is rendered once below */}
              onVersionUploaded={onVersionUploaded}
            />
          )}

          {previewFailed && !isConverting && (
            <div className="flex flex-col items-center gap-4 py-10 text-center">
              <AlertCircle className="w-12 h-12 text-destructive" />
              <div>
                <p className="font-medium text-foreground">
                  {timedOut ? "Preview timed out" : "Preview generation failed"}
                </p>
                <p className="text-sm text-muted-foreground mt-1">
                  {timedOut
                    ? "The conversion is taking longer than expected. You can retry or download the file."
                    : `Could not convert this ${info.app} document to PDF.`}
                </p>
                {preview?.preview_error && (
                  <p className="mt-2 text-xs text-destructive bg-destructive/5 border border-destructive/20 rounded p-2 text-left max-w-2xl break-words">
                    Conversion error: {preview.preview_error}
                  </p>
                )}
              </div>
              <div className="flex gap-2">
                <button
                  onClick={() => retryPreviewMutation.mutate()}
                  disabled={retryPreviewMutation.isPending}
                  className="btn-secondary text-sm"
                >
                  {retryPreviewMutation.isPending
                    ? <Loader2 className="w-4 h-4 animate-spin" />
                    : <RefreshCw className="w-4 h-4" />}
                  Retry
                </button>
                <a href={activeDownloadUrl} download className="btn-primary text-sm">
                  <Download className="w-4 h-4" /> Download instead
                </a>
              </div>
            </div>
          )}

          {!isConverting && !hasPdf && !previewFailed && (
            <div className="flex flex-col items-center gap-4 py-16 text-center">
              <Loader2 className="w-10 h-10 text-muted-foreground animate-spin" />
              <p className="text-sm text-muted-foreground">Initializing preview…</p>
            </div>
          )}
        </div>
      </div>

      {/* Helper note when the file type can't be opened directly */}
      {!info.msScheme && !isLinux && canUploadVersion && !lockedByOther && (
        <div className="rounded-lg border border-border bg-muted/40 px-4 py-3 text-xs text-muted-foreground">
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
}

export default function DocumentViewer({ document: doc, submitSlot }: Props) {
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
    queryKey: ["document-preview", doc.id, selectedVersionId ?? "current", selectedVersionId ? null : doc.current_version],
    queryFn: async () => {
      const cacheKey = getPreviewCacheKey(doc.id, doc.current_version, selectedVersionId);
      const cached = getCachedVersionPreview(cacheKey);
      
      // For current version, serve from cache if available and fresh
      // For version previews, only serve from cache if it's a successful preview
      if (cached) {
        const isSuccessfulPreview = cached.preview_status !== "failed";
        const isCurrentVersion = !selectedVersionId;
        
        if (isCurrentVersion || isSuccessfulPreview) {
          return cached;
        }
        // If it's a failed version preview, don't serve from cache - allow retry
      }
      
      try {
        const r = await documentsAPI.previewUrl(doc.id, selectedVersionId ?? undefined);
        const normalizedResult = {
          ...r.data,
          url: normalizeUrl(r.data.url)!,
          raw_url: r.data.raw_url ? normalizeUrl(r.data.raw_url) : undefined,
        };
        
        setCachedVersionPreview(cacheKey, normalizedResult);
        return normalizedResult;
      } catch (error) {
        // If API call fails, try to serve from cache as fallback
        const fallback = getCachedVersionPreview(cacheKey);
        if (fallback) return fallback;
        throw error;
      }
    },
    placeholderData: (previousData) => previousData,
    staleTime: selectedVersionId ? 30_000 : 0,
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
    setSelectedVersionId(null);
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

  // Preload adjacent versions for snappier nav
  useEffect(() => {
    if (!doc.versions || !selectedVersionId) return;

    const currentIndex = doc.versions.findIndex(v => v.id === selectedVersionId);
    if (currentIndex === -1) return;

    const preloadVersions = [];
    if (currentIndex > 0) preloadVersions.push(doc.versions[currentIndex - 1].id);
    if (currentIndex < doc.versions.length - 1) preloadVersions.push(doc.versions[currentIndex + 1].id);

    preloadVersions.forEach(versionId => {
      const cacheKey = `${doc.id}-${versionId}`;
      if (!getCachedVersionPreview(cacheKey)) {
        documentsAPI.previewUrl(doc.id, versionId).then(result => {
          const normalizedResult = {
            ...result.data,
            url: normalizeUrl(result.data.url) || result.data.url,
            raw_url: result.data.raw_url ? normalizeUrl(result.data.raw_url) || result.data.raw_url : undefined,
          };
          setCachedVersionPreview(cacheKey, normalizedResult);
        }).catch(() => { /* ignore preload errors */ });
      }
    });
  }, [doc.id, doc.versions, selectedVersionId]);

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

  const rawFileUrl = normalizeUrl(preview.raw_url ?? preview.url) ?? "";
  const selectedVersion = selectedVersionId
    ? doc.versions?.find((version) => version.id === selectedVersionId) ?? null
    : null;

  return (
    <div className="space-y-3">
      {/* Lock banner */}
      <EditLockBanner
        doc={doc}
        currentUserId={user?.id}
        onRelease={() => releaseLock.mutate()}
      />

      {/* Header — title + version indicator + open-in-new-tab */}
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="flex items-center gap-2 flex-wrap">
          <h3 className="font-medium text-foreground text-sm">Document preview</h3>
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
        <a
          href={rawFileUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="btn-secondary text-xs px-3 py-1.5"
        >
          <ExternalLink className="w-3.5 h-3.5" /> Open in new tab
        </a>
      </div>

      {/* Version pills */}
      {doc.versions?.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          {(!doc.versions.some(v => v.version_number === doc.current_version)) && (
            <button
              type="button"
              onClick={() => setSelectedVersionId(null)}
              className={`text-xs px-2.5 py-1 rounded-full border transition-colors ${
                selectedVersionId === null
                  ? "border-accent bg-accent/10 text-accent"
                  : "border-border text-muted-foreground hover:bg-muted"
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
                      ? "border-teal bg-teal/10 text-teal"
                      : "border-accent bg-accent/10 text-accent"
                    : "border-border text-muted-foreground hover:bg-muted"
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
        <div className="card p-10 text-center border-2 border-dashed">
          <Download className="w-12 h-12 text-muted-foreground mx-auto mb-4" />
          <p className="text-foreground/80 mb-4">Preview not available for this file type.</p>
          <a
            href={preview.url!}
            download
            className="btn-primary inline-flex items-center gap-2"
          >
            <Download className="w-4 h-4" /> Download file
          </a>
        </div>
      )}

      {/*
        Single action bar below the document.
        Contains "Upload new version" (button + modal) and any caller-supplied
        action (e.g. "Submit for approval"). Hidden if there's nothing to show.
      */}
      {((canUploadVersion && !isLockedByOther) || submitSlot) && (
        <div className="flex flex-wrap items-center justify-end gap-2 pt-2 border-t border-border">
          {canUploadVersion && !isLockedByOther && (
            <UploadVersionDrawer
              documentId={doc.id}
              currentVersion={doc.current_version}
              onVersionUploaded={onVersionUploaded}
            />
          )}
          {submitSlot}
        </div>
      )}
    </div>
  );
}
