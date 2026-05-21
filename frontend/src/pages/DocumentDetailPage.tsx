/**
 * pages/DocumentDetailPage.tsx
 *
 * Infor DMS layout refresh:
 * ─────────────────────────
 * • Standardized 2-panel visual grid layout:
 *   - Column 1: Details & Tabs (Left) — lg:col-span-5 (41.7% width)
 *   - Column 2: Document Viewer / Preview (Right) — lg:col-span-7 (58.3% width) for maximum preview visibility
 * • Clean Action Toolbar showing filename/size, with Download, Start Workflow, Print, Favorite, Delete.
 * • Migrated Document Activities into the Left Panel's tabs under "Audit trail" tab.
 * • Removed Checkout, Save, Save as new document, and top Recently Modified tabs.
 * • Removed AddToFolder / Document Storage bottom card.
 * • Removed Checked Out By and Checked Out Date from Properties tab.
 * • Preserved all business logic (locking, OCR polling, version restore, comments,
 *   workflow tasks, mutations) and inline editing.
 */
import { Suspense, lazy, useState, useEffect, useRef, useCallback } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { documentsAPI, workflowAPI } from "@/services/api";
const DocumentViewer = lazy(() => import("@/components/documents/DocumentViewer"));
const UploadVersionDrawer = lazy(() => import("@/components/documents/UploadVersionDrawer").then((module) => ({ default: module.UploadVersionDrawer })));
import StatusBadge from "@/components/documents/StatusBadge";
import OcrStatusBadge from "@/components/documents/OcrStatusBadge";
import { AddToFolderMenu } from "@/components/documents/AddToFolderMenu";
const MetadataEditPanel = lazy(() => import("@/components/documents/MetadataEditPanel"));
const WorkflowActionPanel = lazy(() => import("@/components/workflow/WorkflowActionPanel"));
import { format } from "date-fns";
import {
  ArrowLeft, Send, MessageSquare, ShieldCheck,
  Loader2, RotateCcw, Edit2, Lock, Info, Download,
  AlertTriangle, ScanLine, RefreshCw,
  Printer, Trash2, X, Check
} from "lucide-react";
import { toast } from "@/components/ui/vault-toast";
import { useAuthStore } from "@/store/authStore";
import type { Document, MetadataField } from "@/types";
import { clsx as cn } from "clsx";
import { QUERY_SHORT_STALE } from "@/lib/reactQueryDefaults";
import { formatDocumentFileType } from "@/lib/documentFormat";

import { StarButton } from "@/components/documents/StarButton";

import { clearDocumentVersionCache, getCachedVersionPreview, getPreviewCacheKey, setCachedVersionPreview } from "@/utils/versionPreviewCache";

const AUDIT_PAGE_SIZE = 5;

const DOCUMENT_FIELD_KEYS = ["title", "supplier", "amount", "currency", "document_date", "due_date"] as const;
type DocumentFieldKey = (typeof DOCUMENT_FIELD_KEYS)[number];
const DOCUMENT_FIELD_KEY_SET = new Set<string>(DOCUMENT_FIELD_KEYS);

function getMetadataFieldKey(field: MetadataField) {
  return field.key ?? field.field_key;
}

function isDocumentFieldKey(key: string): key is DocumentFieldKey {
  return DOCUMENT_FIELD_KEY_SET.has(key);
}

function formatBytes(b: number) {
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / 1024 / 1024).toFixed(1)} MB`;
}

function formatDateValue(value: unknown) {
  if (!value) return "—";
  const date = new Date(String(value));
  return Number.isNaN(date.getTime()) ? String(value) : format(date, "dd MMM yyyy");
}

function getDocumentFieldValue(doc: Document, key: DocumentFieldKey) {
  return doc[key];
}

function formatDocumentDetailValue(doc: Document, field: MetadataField) {
  const key = getMetadataFieldKey(field);
  const value = isDocumentFieldKey(key) ? getDocumentFieldValue(doc, key) : doc.metadata?.[key];

  if (value === null || value === undefined || value === "") return "—";

  if (field.field_type === "date") {
    return formatDateValue(value);
  }

  if (field.field_type === "currency") {
    const amount = Number(value);
    return Number.isFinite(amount)
      ? new Intl.NumberFormat("en-US", {
        style: "currency",
        currency: doc.currency || "USD",
      }).format(amount)
      : String(value);
  }

  if (field.field_type === "boolean") {
    return value ? "Yes" : "No";
  }

  return String(value);
}

function getOcrQuality(metadata: Document["metadata"] | null | undefined) {
  const ocrSuggestions = (metadata as any)?.ocr_suggestions;
  return (
    (ocrSuggestions && typeof ocrSuggestions === "object" ? ocrSuggestions.quality : null) ||
    (metadata as any)?.ocr_quality ||
    null
  );
}

function formatOcrEngine(engine: unknown) {
  return String(engine || "Unknown").replace(/_/g, " ");
}

function describeAuditEvent(event: string) {
  const normalized = event.replace(/_/g, " ").toLowerCase();
  switch (normalized) {
    case "created":
      return "was created";
    case "updated":
      return "was updated";
    case "metadata updated":
      return "metadata was updated";
    case "file uploaded":
    case "document uploaded":
      return "was uploaded";
    case "file downloaded":
    case "document downloaded":
      return "was downloaded";
    case "reviewed":
      return "was reviewed";
    case "workflow started":
      return "workflow was started";
    case "version restored":
      return "version was restored";
    default:
      return normalized;
  }
}

function normalizeUrl(url: string | null | undefined): string | undefined {
  if (!url) return url ?? undefined;
  if (window.location.protocol === "https:" && url.startsWith("http://")) {
    return url.replace("http://", "https://");
  }
  return url;
}

type TabId = "workflow" | "attributes" | "properties" | "security" | "history" | "comments" | "audit" | "edit";

type PaginatedResponse<T> = {
  count: number;
  results: T[];
};

type DocumentAuditLog = {
  id: string;
  event: string;
  summary?: string;
  actor_name?: string;
  ip_address?: string;
  timestamp: string;
};

export default function DocumentDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const user = useAuthStore((s) => s.user);

  const [activeTab, setActiveTab] = useState<TabId>("attributes");
  const [comment, setComment] = useState("");
  const [confirmRestoreId, setConfirmRestoreId] = useState<string | null>(null);
  const [auditPage, setAuditPage] = useState(1);
  const [viewerLinks, setViewerLinks] = useState({ openInNewTabUrl: "", downloadHref: "" });
  const [workflowActionCompleted, setWorkflowActionCompleted] = useState(false);
  const printFrameRef = useRef<HTMLIFrameElement | null>(null);

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const { data: doc, isLoading } = useQuery<Document>({
    queryKey: ["document", id],
    queryFn: () => documentsAPI.get(id!).then((r) => r.data),
    enabled: !!id,
    ...QUERY_SHORT_STALE,
  });

  // ── Document status polling ────────────────────────────────────────────────
  const ocrStatus = (doc as any)?.ocr_status as string | undefined;
  const ocrActive = ocrStatus === "pending" || ocrStatus === "processing";
  const previewStatus = doc?.preview_status;
  const previewActive = previewStatus === "pending" || previewStatus === "processing";

  const warmPreview = useCallback(() => {
    if (!doc?.id) return;

    import("@/components/documents/DocumentViewer");

    const cacheKey = getPreviewCacheKey(doc.id, doc.current_version);
    const cached = getCachedVersionPreview(cacheKey);
    if (cached?.preview_status === "done" && cached.url) return;

    const shouldPrefetchPdfjs = /\.(pdf|docx?|xlsx?|pptx?|odt|ods|odp)$/i.test(doc.file_name || "") || doc.file_mime_type === "application/pdf";
    if (shouldPrefetchPdfjs) {
      import("pdfjs-dist");
    }

    void qc.prefetchQuery({
      queryKey: ["document-preview", doc.id, "current", doc.current_version],
      queryFn: async () => {
        const result = await documentsAPI.previewUrl(doc.id);
        const normalizedResult = {
          ...result.data,
          url: normalizeUrl(result.data.url ?? undefined) ?? result.data.url ?? null,
          raw_url: result.data.raw_url ? normalizeUrl(result.data.raw_url) : undefined,
        };
        setCachedVersionPreview(cacheKey, normalizedResult);
        return normalizedResult;
      },
      staleTime: 5 * 60_000,
    });
  }, [doc?.file_mime_type, doc?.file_name, doc?.current_version, doc?.id, qc]);

  const prefetchVersionPreview = useCallback((versionId: string) => {
    if (!doc?.id) return;

    const cacheKey = getPreviewCacheKey(doc.id, doc.current_version, versionId);
    const cached = getCachedVersionPreview(cacheKey);
    if (cached?.preview_status === "done" && cached.url) return;

    void qc.prefetchQuery({
      queryKey: ["document-preview", doc.id, versionId, null],
      queryFn: async () => {
        const result = await documentsAPI.previewUrl(doc.id, versionId);
        const normalizedResult = {
          ...result.data,
          url: normalizeUrl(result.data.url ?? undefined) ?? result.data.url ?? null,
          raw_url: result.data.raw_url ? normalizeUrl(result.data.raw_url) : undefined,
        };
        setCachedVersionPreview(cacheKey, normalizedResult);
        return normalizedResult;
      },
      staleTime: 5 * 60_000,
    });
  }, [doc?.id, doc?.current_version, qc]);

  const handleVersionUploaded = useCallback(() => {
    if (!id) return;
    clearDocumentVersionCache(id);
    qc.invalidateQueries({ queryKey: ["document", id] });
    qc.invalidateQueries({ queryKey: ["document-preview", id] });
  }, [id, qc]);

  // Warm preview immediately
  useEffect(() => {
    if (!doc?.id) return;
    warmPreview();
  }, [doc?.id, warmPreview]);

  useEffect(() => {
    if ((!ocrActive && !previewActive) || !id) {
      if (pollRef.current) clearInterval(pollRef.current);
      return;
    }
    pollRef.current = setInterval(() => {
      if (typeof document !== "undefined" && document.hidden) return;
      qc.invalidateQueries({ queryKey: ["document", id] });
    }, previewActive ? 2_000 : 5_000);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [ocrActive, previewActive, id, qc]);

  const prevOcrRef = useRef(ocrStatus);
  useEffect(() => {
    if (prevOcrRef.current !== "done" && ocrStatus === "done") {
      toast.success("OCR complete — document text is now searchable.");
    }
    prevOcrRef.current = ocrStatus;
  }, [ocrStatus]);

  // Audit activities query
  const { data: auditLogs } = useQuery({
    queryKey: ["document-audit", id, auditPage],
    queryFn: () =>
      documentsAPI.auditTrail(id!, {
        page: auditPage,
        page_size: AUDIT_PAGE_SIZE,
      }).then((r) => r.data as PaginatedResponse<DocumentAuditLog>),
    enabled: !!id,
    ...QUERY_SHORT_STALE,
  });

  useEffect(() => {
    if (!id || !auditLogs?.count) return;

    const totalPages = Math.max(1, Math.ceil(auditLogs.count / AUDIT_PAGE_SIZE));

    if (auditPage < totalPages) {
      const nextPage = auditPage + 1;
      qc.prefetchQuery({
        queryKey: ["document-audit", id, nextPage],
        queryFn: () =>
          documentsAPI.auditTrail(id, {
            page: nextPage,
            page_size: AUDIT_PAGE_SIZE,
          }).then((r) => r.data as PaginatedResponse<DocumentAuditLog>),
        staleTime: 30_000,
      });
    }

    if (auditPage > 1) {
      const prevPage = auditPage - 1;
      qc.prefetchQuery({
        queryKey: ["document-audit", id, prevPage],
        queryFn: () =>
          documentsAPI.auditTrail(id, {
            page: prevPage,
            page_size: AUDIT_PAGE_SIZE,
          }).then((r) => r.data as PaginatedResponse<DocumentAuditLog>),
        staleTime: 30_000,
      });
    }
  }, [id, auditLogs?.count, auditPage, qc]);

  const { data: myTasks } = useQuery({
    queryKey: ["workflow", "my-tasks"],
    queryFn: () => workflowAPI.myTasks().then((r) => r.data),
    enabled: !!id,
    ...QUERY_SHORT_STALE,
  });
  const activeTask = myTasks?.find((t: { document_id: string }) => t.document_id === id);
  const activeTaskInitializedRef = useRef(false);

  useEffect(() => {
    if (!activeTaskInitializedRef.current && activeTask) {
      activeTaskInitializedRef.current = true;
      setActiveTab("workflow");
    }
  }, [activeTask]);

  useEffect(() => {
    if (!activeTask && activeTab === "workflow") {
      setActiveTab("attributes");
    }
  }, [activeTask, activeTab]);

  useEffect(() => {
    if (activeTask) {
      setWorkflowActionCompleted(false);
    }
  }, [activeTask]);

  const submitMutation = useMutation({
    mutationFn: () => documentsAPI.submit(id!),
    onSuccess: () => { toast.success("Submitted for approval"); qc.invalidateQueries({ queryKey: ["document", id] }); },
    onError: () => toast.error("Submission failed"),
  });

  const archiveMutation = useMutation({
    mutationFn: () => documentsAPI.archive(id!),
    onSuccess: () => { toast.success("Archived"); qc.invalidateQueries({ queryKey: ["document", id] }); },
  });

  const commentMutation = useMutation({
    mutationFn: (content: string) => documentsAPI.addComment(id!, content),
    onSuccess: () => { setComment(""); qc.invalidateQueries({ queryKey: ["document", id] }); },
    onError: () => toast.error("Failed to add comment"),
  });

  const restoreMutation = useMutation({
    mutationFn: (versionId: string) => documentsAPI.restoreVersion(id!, versionId),
    onSuccess: () => {
      toast.success("Version restored. All trailing versions have been discarded.");
      setConfirmRestoreId(null);
      qc.invalidateQueries({ queryKey: ["document", id] });
      qc.invalidateQueries({ queryKey: ["document-preview", id] });
      clearDocumentVersionCache(id!);
    },
    onError: () => { toast.error("Restore failed."); setConfirmRestoreId(null); },
  });

  const reOcrMutation = useMutation({
    mutationFn: () => (documentsAPI as any).reOcr(id!),
    onSuccess: () => {
      toast.info("OCR queued. Text will be updated shortly.");
      qc.invalidateQueries({ queryKey: ["document", id] });
    },
    onError: () => toast.error("Could not queue OCR. Please try again."),
  });

  if (isLoading)
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="w-8 h-8 text-primary animate-spin" />
      </div>
    );

  if (!doc) return <p className="text-muted-foreground">Document not found.</p>;

  const isPersonal = Boolean((doc as any).is_self_upload);
  const isScanned = Boolean((doc as any).is_scanned);
  const personalTags = doc.personal_tags ?? [];
  const personalMetadataEntries = Object.entries(doc.metadata ?? {}).filter(
    ([key]) => key !== "personal_tags",
  );
  const documentDetailRows = isPersonal
    ? []
    : [...(doc.document_type?.metadata_fields ?? [])]
      .sort((a, b) => a.order - b.order)
      .map((field) => ({
        key: field.id,
        label: field.label,
        value: formatDocumentDetailValue(doc, field),
      }));
  const permissions = doc.permissions ?? [];
  const hasAdminAccess = Boolean(user?.has_admin_access);
  const canViewDocument = hasAdminAccess || permissions.includes("view");
  const canEdit = hasAdminAccess || permissions.includes("edit");
  const canComment = hasAdminAccess || permissions.includes("comment");
  const canApprove = hasAdminAccess || permissions.includes("approve");
  const canArchive = hasAdminAccess || permissions.includes("archive");
  const canRestoreVersion = hasAdminAccess || permissions.includes("upload");
  const canUploadVersion = hasAdminAccess || permissions.includes("upload");
  const canReOcr = hasAdminAccess || (isScanned && permissions.includes("upload"));
  const canDownload = hasAdminAccess || permissions.includes("download");
  const ocrQuality = getOcrQuality(doc.metadata);
  const isLockedByOther = Boolean(doc.is_edit_locked && doc.edit_locked_by !== user?.id);

  const canSubmit =
    !isPersonal &&
    (doc.status === "draft" || doc.status === "rejected") &&
    canApprove;

  const canArchiveNow =
    canArchive &&
    !["archived", "void"].includes(doc.status) &&
    (isPersonal || doc.status === "approved");

  const isDraftOrRejected = doc.status === "draft" || doc.status === "rejected";
  const auditCount = auditLogs?.count ?? 0;
  const auditPages = Math.max(1, Math.ceil(auditCount / AUDIT_PAGE_SIZE));

  const tabs: { id: TabId; label: string; disabled?: boolean }[] = [
    ...(activeTask ? [{ id: "workflow" as const, label: "Workflow" }] : []),
    { id: "attributes", label: "Details" },
    { id: "properties", label: "Properties" },
    { id: "security", label: "Security" },
    { id: "history", label: `History (${doc.versions?.length ?? 0})` },
    { id: "comments", label: `Comments (${doc.comments?.length ?? 0})` },
    { id: "audit", label: "Audit trail" },
    ...(isDraftOrRejected
      ? [{ id: "edit" as const, label: "Edit details", disabled: !canEdit }]
      : []),
  ];

  const handleTabClick = (tab: { id: TabId; disabled?: boolean }) => {
    if (tab.disabled) return;
    setActiveTab(tab.id);
  };

  const handlePrintDocument = async () => {
    if (!canDownload || !doc.id) return;
    const printUrl = viewerLinks.openInNewTabUrl || viewerLinks.downloadHref;
    if (!printUrl) {
      toast.info("Document preview is not ready for printing yet.");
      return;
    }

    documentsAPI.filePrintEvent(doc.id).catch(() => {});

    const frame = printFrameRef.current;
    if (!frame) {
      window.open(printUrl, "_blank", "noopener,noreferrer");
      return;
    }

    let printed = false;
    const fallback = window.setTimeout(() => {
      if (printed) return;
      window.open(printUrl, "_blank", "noopener,noreferrer");
      toast.info("Opened the document in a new tab for printing.");
    }, 1800);

    frame.onload = () => {
      try {
        frame.contentWindow?.focus();
        frame.contentWindow?.print();
        printed = true;
        window.clearTimeout(fallback);
      } catch {
        window.open(printUrl, "_blank", "noopener,noreferrer");
      }
    };
    frame.src = printUrl;
  };

  // Grouping function for Infor DMS style Date grouping header
  const formatActivityDateHeader = (timestampStr: string) => {
    try {
      const date = new Date(timestampStr);
      const today = new Date();
      const yesterday = new Date();
      yesterday.setDate(today.getDate() - 1);

      if (date.toDateString() === today.toDateString()) {
        return "Today";
      } else if (date.toDateString() === yesterday.toDateString()) {
        return "Yesterday";
      } else {
        return format(date, "dd/MM/yyyy");
      }
    } catch {
      return "History";
    }
  };

  let lastDateHeader = "";

  return (
    <div className="space-y-4">
      <iframe ref={printFrameRef} title="Printable document" className="hidden" />

      {workflowActionCompleted && !activeTask && (
        <div className="rounded-2xl border border-border bg-muted/10 px-4 py-4 text-sm text-muted-foreground">
          <p className="font-semibold text-foreground">Workflow action complete</p>
          <p className="mt-1">This document has moved to the next stage and is no longer actionable from your current access level.</p>
        </div>
      )}
      <div className="flex flex-col xl:flex-row items-start xl:items-center justify-between gap-3 border-y border-border bg-slate-50 dark:bg-slate-950/60 px-4 py-2.5 text-xs shadow-sm">
        <div className="flex flex-col sm:flex-row sm:items-center gap-2 min-w-0">
          <button
            onClick={() => navigate(-1)}
            className="flex items-center gap-1 text-xs text-slate-500 hover:text-foreground transition-colors"
          >
            <ArrowLeft className="w-3.5 h-3.5" /> Back
          </button>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2 text-foreground">
              <h1 className="text-base font-semibold truncate max-w-[18rem]">{doc.title}</h1>
              <StatusBadge status={doc.status} />
              {isPersonal && (
                <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[10px] font-semibold bg-primary/10 text-primary border border-primary/20">
                  <Lock className="w-2.5 h-2.5" /> Personal
                </span>
              )}
              {isScanned && (
                <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[10px] font-semibold bg-teal/10 text-teal border border-teal/20">
                  <ScanLine className="w-2.5 h-2.5" /> Scanned
                </span>
              )}
              {doc.is_edit_locked && (
                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-amber-100 dark:bg-amber-950 text-amber-800 dark:text-amber-300 text-[10px] font-semibold border border-amber-200 animate-fade-in">
                  <Lock className="w-2.5 h-2.5" /> Checked Out By {doc.edit_locked_by_name || "User"}
                </span>
              )}
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-slate-500">
              <span className="font-medium truncate max-w-[16rem]">{doc.file_name}</span>
              <span>{formatBytes(doc.file_size)}</span>
              <span>{doc.current_version ? `v${doc.current_version}` : "—"}</span>
            </div>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-1.5 w-full xl:w-auto justify-start xl:justify-end font-medium text-slate-600">
          {canSubmit ? (
            <button
              onClick={() => submitMutation.mutate()}
              disabled={submitMutation.isPending}
              className="flex items-center gap-1 px-2 py-1 rounded hover:bg-primary/10 hover:text-primary text-foreground transition-colors"
              title="Submit for approval workflow"
            >
              {submitMutation.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Send className="w-3.5 h-3.5" />}
              <span>Start workflow</span>
            </button>
          ) : (
            <button disabled className="hidden sm:flex items-center gap-1 px-2 py-1 rounded opacity-40 cursor-not-allowed" title="Not eligible for submission">
              <Send className="w-3.5 h-3.5" />
              <span>Start workflow</span>
            </button>
          )}

          <AddToFolderMenu
            documentId={doc.id}
            showLabel
            className="text-muted-foreground hover:text-foreground"
          />

          <div className="flex items-center" title="Favourite document">
            <StarButton
              documentId={doc.id}
              showLabel
              className="rounded-md border-amber-200 bg-amber-50 px-2.5 py-1 text-xs font-semibold text-amber-700 hover:bg-amber-100 dark:border-amber-800/60 dark:bg-amber-950/40 dark:text-amber-300"
            />
          </div>

          <div className="w-[1px] h-4 bg-border mx-1 hidden sm:block" />

          {canDownload && viewerLinks.downloadHref ? (
            <a
              href={viewerLinks.downloadHref}
              download
              className="flex items-center gap-1 px-2 py-1 rounded hover:bg-primary/10 hover:text-primary text-foreground transition-colors"
              title="Download current document"
            >
              <Download className="w-3.5 h-3.5" />
              <span>Download</span>
            </a>
          ) : (
            <button
              disabled
              className="flex items-center gap-1 px-2 py-1 rounded opacity-40 cursor-not-allowed"
              title={canDownload ? "Preview not ready yet" : "Download permission required"}
            >
              <Download className="w-3.5 h-3.5" />
              <span>Download</span>
            </button>
          )}

          <button
            onClick={handlePrintDocument}
            disabled={!canDownload || (!viewerLinks.openInNewTabUrl && !viewerLinks.downloadHref)}
            className="flex items-center gap-1 px-2 py-1 rounded hover:bg-primary/10 hover:text-primary text-foreground transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            title={canDownload ? "Print document" : "Print permission required"}
          >
            <Printer className="w-3.5 h-3.5" />
            <span>Print</span>
          </button>

          {canUploadVersion && !isLockedByOther && (
            <Suspense fallback={<span className="inline-flex items-center gap-1 px-2 py-1 rounded bg-muted/10 text-xs text-muted-foreground">Loading…</span>}>
              <UploadVersionDrawer documentId={doc.id} currentVersion={doc.current_version} onVersionUploaded={handleVersionUploaded} />
            </Suspense>
          )}

          {canArchiveNow && (
            <button
              onClick={() => archiveMutation.mutate()}
              disabled={archiveMutation.isPending}
              className="flex items-center gap-1 px-2 py-1 rounded hover:bg-destructive/10 hover:text-destructive text-foreground transition-colors"
              title="Archive document"
            >
              {archiveMutation.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5 text-destructive" />}
              <span className="sr-only sm:not-sr-only">Delete</span>
            </button>
          )}
        </div>
      </div>

      {/* 2-Column Panel Grid rearranged: Tabs details left, large Document Viewer on the right */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start mt-1">

        {/* Column 1: Details & Properties Tabs (Left) — lg:col-span-5 (41.7% width) */}
        <div className="lg:col-span-5 space-y-3">

          {/* Tab Selection Row */}
          <div className="border-b border-border">
            <nav className="-mb-px flex gap-1 flex-wrap">
              {tabs.map((tab) => {
                const isActive = activeTab === tab.id;
                return (
                  <button
                    key={tab.id}
                    onClick={() => handleTabClick(tab)}
                    disabled={tab.disabled}
                    className={cn(
                      "px-2.5 py-2 text-xs font-semibold border-b-2 transition-all whitespace-nowrap inline-flex items-center gap-1 disabled:opacity-40 disabled:cursor-not-allowed",
                      isActive
                        ? "border-primary text-primary"
                        : "border-transparent text-muted-foreground hover:text-foreground hover:border-border"
                    )}
                  >
                    {tab.id === "edit" && <Edit2 className="w-3 h-3" />}
                    {tab.label}
                  </button>
                );
              })}
            </nav>
          </div>

          {/* Tab contents frame */}
          <div className="rounded-2xl border border-border/80 bg-background p-4 min-h-[30rem]">

            {/* WORKFLOW TAB */}
            {activeTab === "workflow" && activeTask && (
              <div className="space-y-4 animate-fade-in">
                <div className="rounded-2xl border border-border bg-background p-4">
                  <div className="mb-4 flex items-center justify-between gap-3">
                    <h3 className="text-sm font-semibold text-foreground">Workflow task actions</h3>
                    <span className="text-xs text-muted-foreground">Task controls</span>
                  </div>
                  <Suspense fallback={<div className="text-xs text-muted-foreground">Loading workflow actions…</div>}>
                    <WorkflowActionPanel task={activeTask} documentId={id!} onCompleted={() => setWorkflowActionCompleted(true)} />
                  </Suspense>
                </div>
              </div>
            )}

            {/* PROPERTIES TAB */}
            {activeTab === "properties" && (
              <div className="space-y-4 animate-fade-in">
                <div className="grid grid-cols-[140px_1fr] gap-x-4 gap-y-3.5 text-xs py-1">
                  <span className="text-muted-foreground">Document Type</span>
                  <span className="text-foreground font-semibold">{doc.document_type?.name || "—"}</span>

                  <span className="text-muted-foreground">Internal ID</span>
                  <span className="text-foreground font-mono font-semibold">{doc.reference_number || "—"}</span>

                  <span className="text-muted-foreground">Version</span>
                  <span className="text-foreground font-semibold">{doc.current_version ? `v${doc.current_version}` : "—"}</span>

                  <span className="text-muted-foreground">Modified By</span>
                  <span className="text-foreground font-semibold">
                    {doc.uploaded_by?.first_name ? `${doc.uploaded_by.first_name} ${doc.uploaded_by.last_name}` : "—"}
                  </span>

                  <span className="text-muted-foreground">Modified Date</span>
                  <span className="text-foreground">
                    {doc.updated_at ? format(new Date(doc.updated_at), "dd/MM/yyyy, HH:mm:ss") : "—"}
                  </span>

                  <span className="text-muted-foreground">Created By</span>
                  <span className="text-foreground font-semibold">
                    {doc.uploaded_by?.first_name ? `${doc.uploaded_by.first_name} ${doc.uploaded_by.last_name}` : "—"}
                  </span>

                  <span className="text-muted-foreground">Created Date</span>
                  <span className="text-foreground">
                    {doc.created_at ? format(new Date(doc.created_at), "dd/MM/yyyy, HH:mm:ss") : "—"}
                  </span>

                  <span className="text-muted-foreground">Filename</span>
                  <span className="text-foreground truncate max-w-[240px] font-mono" title={doc.file_name}>{doc.file_name || "—"}</span>

                  <span className="text-muted-foreground">Size</span>
                  <span className="text-foreground font-mono">{doc.file_size || "—"}</span>

                  <span className="text-muted-foreground">ID</span>
                  <span className="text-foreground font-mono truncate max-w-[240px]" title={doc.id}>{doc.id || "—"}</span>

                  <span className="text-muted-foreground">Format</span>
                  <span className="text-foreground">{formatDocumentFileType(doc.file_name, doc.file_mime_type)}</span>

                  <span className="text-muted-foreground">MIME Type</span>
                  <span className="text-foreground font-mono break-all">{doc.file_mime_type}</span>

                  {isScanned && (
                    <>
                      <span className="text-muted-foreground">OCR Status</span>
                      <span>
                        <OcrStatusBadge status={ocrStatus as any} showDone />
                        {!ocrStatus && <span className="text-muted-foreground">—</span>}
                      </span>
                    </>
                  )}

                  {ocrQuality && (
                    <>
                      <span className="text-muted-foreground">OCR Engine</span>
                      <span className="capitalize">{formatOcrEngine(ocrQuality.engine)}</span>

                      <span className="text-muted-foreground">OCR Confidence</span>
                      <span className="font-semibold text-teal-600 dark:text-teal-400">
                        {ocrQuality.mean_confidence ? `${ocrQuality.mean_confidence}%` : "—"}
                      </span>
                    </>
                  )}
                </div>
              </div>
            )}

            {/* ATTRIBUTES TAB */}
            {activeTab === "attributes" && (
              <div className="space-y-4 animate-fade-in">
                <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider border-b border-border pb-2">
                  Document Details
                </h3>
                {isPersonal ? (
                  <div className="space-y-4 text-sm">
                    <div>
                      <span className="text-sm font-semibold text-muted-foreground uppercase tracking-wide block mb-2">Personal tags</span>
                      {personalTags.length > 0 ? (
                        <div className="flex flex-wrap gap-1.5">
                          {personalTags.map((tag) => (
                            <span key={tag} className="badge bg-primary/10 text-primary border border-primary/20">{tag}</span>
                          ))}
                        </div>
                      ) : (
                        <span className="text-xs text-muted-foreground">—</span>
                      )}
                    </div>

                    <div className="pt-3 border-t border-border">
                      <span className="text-sm font-semibold text-muted-foreground uppercase tracking-wide block mb-2">Custom metadata</span>
                      {personalMetadataEntries.length > 0 ? (
                        <div className="grid grid-cols-[140px_1fr] gap-x-4 gap-y-3.5 text-sm">
                          {personalMetadataEntries.map(([key, val]) => (
                            <div key={key} className="contents text-sm">
                              <span className="text-muted-foreground capitalize">{key.replace(/_/g, " ")}</span>
                              <span className="text-foreground font-semibold">{String(val)}</span>
                            </div>
                          ))}
                        </div>
                      ) : (
                        <span className="text-xs text-muted-foreground">—</span>
                      )}
                    </div>
                  </div>
                ) : documentDetailRows.length > 0 ? (
                  <div className="grid grid-cols-[140px_1fr] gap-x-4 gap-y-3.5 text-sm py-1">
                    {documentDetailRows.map(({ key, label, value }) => (
                      <div key={key} className="contents">
                        <span className="text-muted-foreground">{label}</span>
                        <span className="text-foreground font-semibold">{value}</span>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="text-xs text-muted-foreground py-2">No metadata attributes found for this document type.</p>
                )}
              </div>
            )}

            {/* SECURITY TAB */}
            {activeTab === "security" && (
              <div className="space-y-4 animate-fade-in">
                <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider border-b border-border pb-2">
                  Access & Permissions
                </h3>
                <div className="rounded-xl border border-border p-4 bg-muted/10 space-y-3.5">
                  <div className="flex items-center justify-between text-xs">
                    <span className="text-muted-foreground">Your Role Access</span>
                    <span className="font-semibold text-foreground bg-primary/5 px-2 py-1 rounded border border-primary/20">
                      {hasAdminAccess ? "Administrator (Full Access)" : "Standard User"}
                    </span>
                  </div>
                  <div className="w-full h-[1px] bg-border" />
                  <div className="space-y-3">
                    {[
                      { label: "View Document Details", allowed: canViewDocument },
                      { label: "Edit / Update Metadata", allowed: canEdit },
                      { label: "Add Document Comments", allowed: canComment },
                      { label: "Download Original File", allowed: canDownload },
                      { label: "Restore Historical Versions", allowed: canRestoreVersion },
                      { label: "Archive / Delete Document", allowed: canArchive },
                    ].map(({ label, allowed }) => (
                      <div key={label} className="flex items-center justify-between text-xs">
                        <span className="text-muted-foreground">{label}</span>
                        {allowed ? (
                          <span className="inline-flex items-center gap-1 text-[10px] font-semibold text-teal bg-teal/15 px-2 py-0.5 rounded-full border border-teal/20">
                            <Check className="w-3 h-3 text-teal" /> Allowed
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1 text-[10px] font-semibold text-destructive bg-destructive/15 px-2 py-0.5 rounded-full border border-destructive/20">
                            <X className="w-3 h-3 text-destructive" /> Restricted
                          </span>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            )}

            {/* HISTORY TAB */}
            {activeTab === "history" && (
              <div className="space-y-3.5 animate-fade-in">
                <h3 className="text-xs font-bold text-muted-foreground uppercase tracking-wider border-b border-border pb-2">
                  Document Version History
                </h3>
                {(!doc.versions || doc.versions.length === 0) && (
                  <div className="text-center py-6 text-muted-foreground"><p className="text-xs">No version history available.</p></div>
                )}
                {doc.versions?.map((v) => {
                  const isCurrent = v.version_number === doc.current_version;
                  const awaitConfirm = confirmRestoreId === v.id;
                  return (
                    <div
                      key={v.id}
                      onMouseEnter={() => prefetchVersionPreview(v.id)}
                      onFocus={() => prefetchVersionPreview(v.id)}
                      className={`card p-3.5 flex flex-col gap-2 transition-colors ${isCurrent ? "border-l-4 border-l-primary bg-primary/5 dark:bg-primary/10" : "hover:bg-muted/10"
                        }`}
                    >
                      <div className="flex items-center gap-2">
                        <div
                          className={`w-6 h-6 rounded-full flex items-center justify-center text-[10px] font-bold flex-shrink-0 select-none ${isCurrent ? "bg-primary/15 text-primary border border-primary/20" : "bg-muted text-muted-foreground"
                            }`}
                        >
                          v{v.version_number}
                        </div>
                        <div className="min-w-0 flex-1">
                          <p className="text-xs font-semibold text-foreground truncate" title={v.file_name}>{v.file_name}</p>
                        </div>
                      </div>

                      <div className="text-[10px] text-muted-foreground space-y-0.5">
                        <p>{format(new Date(v.created_at), "dd MMM yyyy HH:mm")}</p>
                        <p>{v.created_by.first_name} {v.created_by.last_name}</p>
                        <p>{formatBytes(v.file_size)}</p>
                      </div>

                      {v.change_summary && <p className="text-[10px] text-foreground/85 italic bg-muted/40 p-1.5 rounded">"{v.change_summary}"</p>}

                      <div className="flex items-center gap-1.5 mt-1">
                        {canDownload && v.file_url && (
                          <a
                            href={v.file_url}
                            download={v.file_name}
                            title="Download this version"
                            className="btn-secondary text-[10px] px-2 py-1 flex items-center justify-center flex-1"
                          >
                            <Download className="w-3.5 h-3.5" />
                          </a>
                        )}
                        {!isCurrent && canRestoreVersion && (
                          awaitConfirm ? (
                            <div className="flex flex-col gap-1.5 rounded border border-primary/40 bg-primary/10 p-2 animate-pulse w-full">
                              <span className="text-[10px] text-foreground font-semibold">Restore v{v.version_number}?</span>
                              <div className="flex gap-2">
                                <button
                                  onClick={() => restoreMutation.mutate(v.id)}
                                  disabled={restoreMutation.isPending}
                                  className="text-[10px] font-bold text-primary hover:underline"
                                >
                                  {restoreMutation.isPending ? <Loader2 className="w-3 h-3 animate-spin" /> : "Confirm"}
                                </button>
                                <button
                                  onClick={() => setConfirmRestoreId(null)}
                                  className="text-[10px] text-muted-foreground hover:underline"
                                >
                                  Cancel
                                </button>
                              </div>
                            </div>
                          ) : (
                            <button
                              onClick={() => setConfirmRestoreId(v.id)}
                              className="btn-secondary text-[10px] px-2 py-1 flex items-center gap-1 flex-1 justify-center"
                              title="Restore to this version"
                            >
                              <RotateCcw className="w-3 h-3" /> Restore
                            </button>
                          )
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}

            {/* COMMENTS TAB */}
            {activeTab === "comments" && (
              <div className="space-y-4 animate-fade-in">
                <h3 className="text-xs font-bold text-muted-foreground uppercase tracking-wider border-b border-border pb-2">
                  Document Comments
                </h3>

                <div className="space-y-3 max-h-[16rem] overflow-y-auto pr-1">
                  {(!doc.comments || doc.comments.length === 0) && (
                    <div className="text-center py-4 text-muted-foreground">
                      <p className="text-xs">No comments added yet.</p>
                    </div>
                  )}
                  {doc.comments?.map((c) => (
                    <div
                      key={c.id}
                      className={`card p-2.5 ${c.is_internal ? "border-l-4 border-l-primary bg-primary/5 dark:bg-primary/10" : ""}`}
                    >
                      <div className="flex flex-col gap-0.5 mb-1 text-[10px]">
                        <span className="font-semibold text-foreground">{c.author.first_name} {c.author.last_name}</span>
                        <span className="text-muted-foreground">
                          {format(new Date(c.created_at), "dd MMM yyyy HH:mm")}
                        </span>
                      </div>
                      <p className="text-xs text-foreground/90 leading-relaxed whitespace-pre-wrap">{c.content}</p>
                    </div>
                  ))}
                </div>

                <div className="card p-2.5 space-y-2 mt-2 border border-border/80">
                  <textarea
                    value={comment}
                    onChange={(e) => setComment(e.target.value)}
                    rows={2}
                    className="input text-xs"
                    placeholder="Add a comment…"
                    disabled={!canComment}
                  />
                  <div className="flex justify-end">
                    <button
                      onClick={() => comment.trim() && commentMutation.mutate(comment.trim())}
                      disabled={!comment.trim() || commentMutation.isPending || !canComment}
                      className="btn-primary text-[10px] py-1 px-2.5 shadow-sm"
                    >
                      {commentMutation.isPending && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                      <MessageSquare className="w-3 h-3" /> Add comment
                    </button>
                  </div>
                </div>
              </div>
            )}

            {/* AUDIT TRAIL TAB */}
            {activeTab === "audit" && (
              <div className="space-y-4 animate-fade-in">
                <div className="flex items-center justify-between border-b border-border pb-2">
                  <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider">
                    Audit trail
                  </h3>
                  <button
                    onClick={() => {
                      if (auditLogs?.results?.length) {
                        const blob = new Blob([JSON.stringify(auditLogs.results, null, 2)], { type: "application/json" });
                        const url = URL.createObjectURL(blob);
                        const a = document.createElement("a");
                        a.href = url;
                        a.download = `audit-log-${doc.reference_number}.json`;
                        a.click();
                        toast.success("Audit activity trail downloaded successfully!");
                      } else {
                        toast.error("No activity trail available to download.");
                      }
                    }}
                    className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
                    title="Download activity trail (JSON)"
                  >
                    <Download className="w-3.5 h-3.5" />
                  </button>
                </div>

                {/* Date grouped audit items */}
                <div className="space-y-0.5 max-h-[26rem] overflow-y-auto pr-1">
                  {auditLogs?.results?.length ? (
                    auditLogs.results.map((log) => {
                      const currentDateHeader = formatActivityDateHeader(log.timestamp);
                      const showHeader = currentDateHeader !== lastDateHeader;
                      lastDateHeader = currentDateHeader;

                      return (
                        <div key={log.id} className="space-y-0.5">
                          {showHeader && (
                            <div className="bg-[#ededed] dark:bg-muted/80 px-3 py-1 text-[10px] font-bold text-foreground border-y border-border select-none uppercase tracking-wider mt-2.5 first:mt-0">
                              {currentDateHeader}
                            </div>
                          )}

                          <div className="py-2.5 px-3 border-b border-border bg-card hover:bg-muted/5 transition-colors space-y-1">
                            <p className="text-sm text-foreground leading-normal text-left">
                              <span className="font-semibold text-primary">{doc.reference_number}</span> {describeAuditEvent(log.event)} by <span className="font-semibold text-foreground">{log.actor_name || "System"}</span>
                            </p>
                            {log.summary && (
                              <p className="text-[10px] text-muted-foreground pl-2 border-l border-primary/20 italic whitespace-pre-wrap leading-relaxed mt-1 text-left">
                                {log.summary}
                              </p>
                            )}
                            <div className="flex flex-wrap items-center gap-1.5 pt-0.5 text-xs text-muted-foreground font-mono">
                              <ShieldCheck className="w-3 h-3 text-primary/70" />
                              <span>{log.ip_address || "System"}</span>
                              <span>·</span>
                              <span>{format(new Date(log.timestamp), "HH:mm:ss")}</span>
                            </div>
                          </div>
                        </div>
                      );
                    })
                  ) : (
                    <div className="rounded-lg border border-border bg-muted/5 px-4 py-8 text-center text-sm text-muted-foreground">
                      No activity history found for this document yet.
                    </div>
                  )}
                </div>

                {/* Compact pagination inside Audit trail tab */}
                {auditCount > AUDIT_PAGE_SIZE && (
                  <div className="flex items-center justify-between border-t border-border pt-3 mt-1.5 text-xs select-none">
                    <span className="text-[10px] text-muted-foreground">
                      Page {auditPage} of {auditPages}
                    </span>
                    <div className="flex items-center gap-1.5">
                      <button
                        type="button"
                        onClick={() => setAuditPage((current) => Math.max(1, current - 1))}
                        disabled={auditPage === 1}
                        className="btn-secondary text-[10px] px-2.5 py-1 disabled:opacity-40 disabled:cursor-not-allowed shadow-sm"
                      >
                        Prev
                      </button>
                      <button
                        type="button"
                        onClick={() => setAuditPage((current) => Math.min(auditPages, current + 1))}
                        disabled={auditPage >= auditPages}
                        className="btn-secondary text-[10px] px-2.5 py-1 disabled:opacity-40 disabled:cursor-not-allowed shadow-sm"
                      >
                        Next
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* EDIT PROPERTIES TAB */}
            {activeTab === "edit" && (
              <div className="space-y-4 animate-fade-in">
                <div className="flex items-center justify-between border-b border-border pb-2 mb-2">
                  <h3 className="text-[11px] font-bold text-muted-foreground uppercase tracking-wider">
                    Edit Properties
                  </h3>
                  <button
                    onClick={() => setActiveTab("properties")}
                    className="text-[11px] font-semibold text-muted-foreground hover:text-foreground hover:underline transition-colors"
                  >
                    Cancel
                  </button>
                </div>
                <Suspense fallback={<div className="p-4 text-xs text-muted-foreground">Loading editor…</div>}>
                  <MetadataEditPanel document={doc} onClose={() => setActiveTab("properties")} />
                </Suspense>
              </div>
            )}

          </div>
        </div>

        {/* Column 2: Document Viewer (Right) — lg:col-span-7 (58.3% width) */}
        <div className="lg:col-span-7 space-y-4">

          {/* Active Notifications / Status Banners */}
          {isPersonal && (
            <div className="rounded-xl border border-primary/20 bg-primary/5 px-4 py-3 flex items-start gap-3 text-xs text-primary shadow-sm animate-fade-in">
              <Info className="w-4 h-4 mt-0.5 flex-shrink-0 text-primary" />
              <div>
                <p className="font-semibold">Personal document</p>
                <p className="text-[10px] mt-0.5 text-primary/70">Private to you and administrators. Cannot be submitted for approval.</p>
              </div>
            </div>
          )}

          {ocrActive && (
            <div className="rounded-xl border border-teal/20 bg-teal/5 px-4 py-3 flex items-start gap-3 text-xs text-teal shadow-sm">
              <Loader2 className="w-4 h-4 mt-0.5 flex-shrink-0 animate-spin" />
              <div>
                <p className="font-semibold">Extracting text…</p>
                <p className="text-[10px] mt-0.5 text-teal/80">
                  OCR is running in the background. This page will update automatically.
                </p>
              </div>
            </div>
          )}

          {ocrStatus === "failed" && (
            <div className="rounded-xl border border-destructive/30 bg-destructive/5 px-4 py-3 flex items-start gap-3 text-xs text-destructive shadow-sm">
              <AlertTriangle className="w-4 h-4 mt-0.5 flex-shrink-0" />
              <div className="flex-1">
                <p className="font-semibold">OCR failed</p>
                <p className="text-[10px] mt-0.5 text-destructive/80">Text extraction did not complete. Search index is limited.</p>
                {canReOcr && (
                  <button
                    onClick={() => reOcrMutation.mutate()}
                    disabled={reOcrMutation.isPending}
                    className="mt-2 inline-flex items-center gap-1 text-[10px] font-semibold text-destructive hover:underline"
                  >
                    {reOcrMutation.isPending ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />}
                    Re-run OCR
                  </button>
                )}
              </div>
            </div>
          )}

          {/* Document Viewer Frame */}
          <div className="card p-3 bg-card border border-border rounded-xl shadow-elegant">
            <Suspense fallback={
              <div className="flex min-h-[24rem] items-center justify-center rounded-lg border border-border bg-card">
                <Loader2 className="w-8 h-8 text-primary animate-spin" />
              </div>
            }>
                <DocumentViewer
                  document={doc}
                  submitSlot={null}
                  hideUploadActionBar
                  onPreviewLinksChange={(links) => setViewerLinks(links)}
                />
            </Suspense>
          </div>
        </div>

      </div>
    </div>
  );
}
