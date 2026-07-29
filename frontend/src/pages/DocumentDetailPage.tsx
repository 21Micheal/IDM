import { Suspense, useState, useEffect, useRef, useCallback } from "react";
import { extractApiError } from "@/lib/apiError";
import { useParams, useNavigate } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api, documentsAPI, workflowAPI } from "@/services/api";
import DocumentViewer from "@/components/documents/DocumentViewer";
import { UploadVersionDrawer } from "@/components/documents/UploadVersionDrawer";
import { WorkflowVisualizer } from "@/components/notifications/workflow-visualizer";
// StatusBadge not used in this file
import OcrStatusBadge from "@/components/documents/OcrStatusBadge";
import { AddToFolderMenu } from "@/components/documents/AddToFolderMenu";
import MetadataEditPanel, { type MetadataSaver } from "@/components/documents/MetadataEditPanel";
import { ApprovalStagesTable } from "@/components/workflow/ApprovalStagesTable";
import WorkflowActionPanel from "@/components/workflow/WorkflowActionPanel";
import SignatureRequestPanel from "@/components/signatures/SignatureRequestPanel";
import JournalPostingCard from "@/components/templates/JournalPostingCard";
import JournalPayloadModal from "@/components/templates/JournalPayloadModal";
import { format } from "date-fns";
import {
  ArrowLeft, Send, MessageSquare, ShieldCheck,
  Loader2, RotateCcw, Edit2, Lock, Unlock, Info, Download,
  AlertTriangle, ScanLine, RefreshCw, ChevronDown, FileText,
  Printer, Trash2, X, Check, ExternalLink, Columns2, Eye, EyeOff, Archive, FileCode, MoreHorizontal, Save,
} from "lucide-react";
import { toast } from "@/components/ui/vault-toast";
import { useAuthStore } from "@/store/authStore";
import type { Document, DocumentRelationship, DocumentRelationshipSuggestion, MetadataField } from "@/types";
import { clsx as cn } from "clsx";
import { QUERY_SHORT_STALE } from "@/lib/reactQueryDefaults";
import { formatDocumentFileType } from "@/lib/documentFormat";
import { loadWorkflowData } from "@/components/notifications/workflow-data";
import { WorkspaceCommandBar } from "@/components/shared/WorkspaceCommandBar";

import { StarButton } from "@/components/documents/StarButton";

import { clearDocumentVersionCache, getCachedVersionPreview, getPreviewCacheKey, setCachedVersionPreview } from "@/utils/versionPreviewCache";

const AUDIT_PAGE_SIZE = 5;

// Keep the open document's lock state (and other server-side changes) current for
// every viewer without a manual refresh: while the detail page is focused, refetch
// on this cadence. React Query pauses the interval when the tab is backgrounded
// (refetchIntervalInBackground defaults to false), so it doesn't poll needlessly.
const LOCK_STATUS_POLL_MS = 8_000;

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

function getCommandStatusLabel(status: string) {
  return status
    ? status.replace(/_/g, " ").replace(/\b\w/g, (char) => char.toUpperCase())
    : "Unknown";
}

function getCommandStatusClass(status: string) {
  const key = status?.toLowerCase?.().replace(/\s+/g, "_") ?? "";
  if (["approved", "active", "enabled", "completed"].includes(key)) {
    return "border-emerald-200 bg-emerald-50 text-emerald-800";
  }
  if (["pending_review", "pending_approval", "on_hold", "returned"].includes(key)) {
    return "border-amber-200 bg-amber-50 text-amber-900";
  }
  if (["rejected", "void"].includes(key)) {
    return "border-red-200 bg-red-50 text-red-800";
  }
  if (key === "archived") {
    return "border-sky-200 bg-sky-50 text-sky-800";
  }
  return "border-slate-200 bg-white text-slate-800";
}

function describeAuditEvent(event: string) {
  const normalized = event.replace(/\./g, " ").replace(/_/g, " ").trim().toLowerCase();
  switch (normalized) {
    case "document created":
      return "was created";
    case "document updated":
      return "was edited";
    case "metadata updated":
      return "metadata was updated";
    case "document uploaded":
    case "file uploaded":
      return "was uploaded";
    case "document downloaded":
    case "file downloaded":
      return "was downloaded";
    case "document reviewed":
      return "was reviewed";
    case "workflow started":
      return "workflow was started";
    case "document version restored":
    case "version restored":
      return "version was restored";
    case "created":
      return "was created";
    case "updated":
      return "was edited";
    default:
      return normalized;
  }
}

type AuditMetadataEdit = {
  key: string;
  field: string;
  old: string;
  new: string;
};

function AuditMetadataEditList({ edits }: { edits: AuditMetadataEdit[] }) {
  if (!edits.length) return null;

  return (
    <ul className="mt-2 space-y-1.5 border-l-2 border-[#287EAD] bg-[#F5F7F8] px-2 py-1.5">
      {edits.map((edit) => (
        <li key={edit.key} className="text-sm leading-relaxed text-[#1F2933]">
          <span className="font-medium">{edit.field}: </span>
          {edit.old ? (
            <span className="line-through text-[#5E6870]">{edit.old}</span>
          ) : null}
          {edit.old && edit.new ? (
            <span className="mx-1.5 text-[#5E6870]">→</span>
          ) : null}
          {edit.new ? (
            <span className="font-medium text-[#1F2933]">{edit.new}</span>
          ) : edit.old ? (
            <span className="italic text-[#5E6870]">(cleared)</span>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

function describeRelationship(relationship: DocumentRelationship) {
  const label = relationship.relation_type_label || relationship.relation_type.replace(/-/g, " ");
  if (relationship.direction === "outbound") return label;
  if (relationship.relation_type === "supersedes") return "Superseded by";
  if (relationship.relation_type === "supports") return "Supported by";
  if (relationship.relation_type === "references") return "Referenced by";
  return label;
}

function normalizeUrl(url: string | null | undefined): string | undefined {
  if (!url) return url ?? undefined;
  if (window.location.protocol === "https:" && url.startsWith("http://")) {
    return url.replace("http://", "https://");
  }
  return url;
}

type TabId = "workflow" | "attributes" | "relationships" | "properties" | "security" | "history" | "comments" | "audit" | "edit";

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
  changes?: {
    metadata_edits?: AuditMetadataEdit[];
    [key: string]: unknown;
  };
};

export default function DocumentDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const user = useAuthStore((s) => s.user);

  const [activeTab, setActiveTab] = useState<TabId>("attributes");
  const [showJournalXml, setShowJournalXml] = useState(false);
  const [comment, setComment] = useState("");
  const [confirmRestoreId, setConfirmRestoreId] = useState<string | null>(null);
  const [auditPage, setAuditPage] = useState(1);
  const [viewerLinks, setViewerLinks] = useState({
    openInNewTabUrl: "",
    downloadHref: "",
    signedFileUrlsEnabled: false,
  });
  const [workflowActionCompleted, setWorkflowActionCompleted] = useState(false);
  const [compareDocumentId, setCompareDocumentId] = useState<string | null>(null);
  const [showDownloadTray, setShowDownloadTray] = useState(false);
  const [showMoreMenu, setShowMoreMenu] = useState(false);
  const [downloadingPdf, setDownloadingPdf] = useState(false);
  // Removing a confirmed link is intentional-only: a type-to-confirm dialog guards it.
  const [relationshipToRemove, setRelationshipToRemove] = useState<DocumentRelationship | null>(null);
  const [removeConfirmText, setRemoveConfirmText] = useState("");
  const downloadTrayRef = useRef<HTMLDivElement | null>(null);
  const moreMenuRef = useRef<HTMLDivElement | null>(null);
  const printFrameRef = useRef<HTMLIFrameElement | null>(null);

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const { data: doc, isLoading } = useQuery<Document>({
    queryKey: ["document", id],
    queryFn: () => documentsAPI.get(id!).then((r) => r.data),
    enabled: !!id,
    ...QUERY_SHORT_STALE,
    // Surface lock/release (and other) changes made by other users automatically.
    refetchInterval: LOCK_STATUS_POLL_MS,
  });

  // Redirect form documents to the dedicated Forms page
  useEffect(() => {
    if (doc && (doc as any).metadata?.form?.sections) {
      navigate(`/forms/${doc.id}`, { replace: true });
    }
  }, [doc, navigate]);


  // ── Global Escape key — dismiss any open overlay / tray / panel ───────────
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // Close in priority order: innermost / most recently opened first.
      if (showJournalXml)    { setShowJournalXml(false);   return; }
      if (showDownloadTray)  { setShowDownloadTray(false); return; }
      if (showMoreMenu)      { setShowMoreMenu(false);      return; }
      if (compareDocumentId) { setCompareDocumentId(null); return; }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [showJournalXml, showDownloadTray, showMoreMenu, compareDocumentId]);

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

  const handleVersionUploaded = useCallback(async () => {
    if (!id) return;
    clearDocumentVersionCache(id);
    qc.removeQueries({ queryKey: ["document-preview", id] });
    await qc.refetchQueries({ queryKey: ["document", id] });
    qc.invalidateQueries({ queryKey: ["document-preview", id] });
  }, [id, qc]);

  const handlePreviewLinksChange = useCallback((links: {
    openInNewTabUrl: string;
    downloadHref: string;
    signedFileUrlsEnabled: boolean;
  }) => {
    setViewerLinks(links);
  }, []);

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
  const hasShownOcrCompleteRef = useRef(false);
  
  useEffect(() => {
    // Initialize from localStorage to persist across page reloads
    if (!hasShownOcrCompleteRef.current && id) {
      const storageKey = `ocr-complete-shown-${id}`;
      hasShownOcrCompleteRef.current = localStorage.getItem(storageKey) === "true";
    }
  }, [id]);
  
  useEffect(() => {
    if (prevOcrRef.current !== "done" && ocrStatus === "done" && !hasShownOcrCompleteRef.current && id) {
      toast.success("OCR complete — document text is now searchable.");
      hasShownOcrCompleteRef.current = true;
      localStorage.setItem(`ocr-complete-shown-${id}`, "true");
    }
    prevOcrRef.current = ocrStatus;
  }, [ocrStatus, id]);

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

  const { data: relationships = [] } = useQuery<DocumentRelationship[]>({
    queryKey: ["document-relationships", id],
    queryFn: () => documentsAPI.relationships(id!).then((r) => r.data),
    enabled: !!id,
    ...QUERY_SHORT_STALE,
  });

  const { data: compareDoc } = useQuery<Document>({
    queryKey: ["document", compareDocumentId],
    queryFn: () => documentsAPI.get(compareDocumentId!).then((r) => r.data),
    enabled: !!compareDocumentId,
    ...QUERY_SHORT_STALE,
  });

  const { data: workflowData, isLoading: workflowDataLoading } = useQuery({
    queryKey: ["document-workflow", id],
    queryFn: () => loadWorkflowData(id!, doc?.builder_workflow_phase),
    enabled: !!id && !!doc && !(doc as any).is_self_upload,
    ...QUERY_SHORT_STALE,
    // Keep the visualizer in sync with approvals as they occur, then idle.
    refetchInterval: (query) => (query.state.data?.isActive ? 15_000 : false),
  });

  const workflowStepsCount = workflowData?.steps?.length ?? 0;

  useEffect(() => {
    if (!activeTaskInitializedRef.current && activeTask) {
      activeTaskInitializedRef.current = true;
      setActiveTab("workflow");
    }
  }, [activeTask, doc]);

  useEffect(() => {
    if (activeTab === "workflow" && !activeTask && workflowStepsCount === 0) {
      setActiveTab("attributes");
    }
  }, [activeTask, activeTab, workflowStepsCount]);

  useEffect(() => {
    if (activeTask) {
      setWorkflowActionCompleted(false);
    }
  }, [activeTask]);

  const submitMutation = useMutation({
    mutationFn: () => documentsAPI.submit(id!),
    onSuccess: () => {
      toast.success("Submitted for approval");
      qc.invalidateQueries({ queryKey: ["document", id] });
      qc.invalidateQueries({ queryKey: ["document-workflow", id] });
    },
    onError: (err) => toast.error(extractApiError(err, "Submission failed")),
  });

  const archiveMutation = useMutation({
    mutationFn: () => documentsAPI.archive(id!),
    onSuccess: () => { toast.success("Archived"); qc.invalidateQueries({ queryKey: ["document", id] }); },
  });

  const commentMutation = useMutation({
    mutationFn: (content: string) => documentsAPI.addComment(id!, content),
    onSuccess: () => { setComment(""); qc.invalidateQueries({ queryKey: ["document", id] }); },
    onError: (err) => toast.error(extractApiError(err, "Failed to add comment")),
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
    onError: (err) => { toast.error(extractApiError(err, "Restore failed.")); setConfirmRestoreId(null); },
  });

  const reOcrMutation = useMutation({
    mutationFn: () => (documentsAPI as any).reOcr(id!),
    onSuccess: () => {
      toast.info("OCR queued. Text will be updated shortly.");
      qc.invalidateQueries({ queryKey: ["document", id] });
    },
    onError: (err) => toast.error(extractApiError(err, "Could not queue OCR. Please try again.")),
  });

  const deleteMutation = useMutation({
    mutationFn: () => documentsAPI.delete(id!),
    onSuccess: () => {
      toast.success("Moved to Trash.");
      qc.invalidateQueries({ queryKey: ["documents"] });
      navigate("/documents");
    },
    onError: (err: any) =>
      toast.error(extractApiError(err, "Could not delete document.")),
  });

  const confirmRelationshipSuggestionMutation = useMutation({
    mutationFn: (suggestion: DocumentRelationshipSuggestion) =>
      documentsAPI.addRelationship(id!, {
        target_document_id: suggestion.target_document_id,
        relation_type: suggestion.relation_type,
        note: `Matched PO reference ${suggestion.matched_reference}.`,
      }),
    onSuccess: () => {
      toast.success("Suggested PO link confirmed.");
      qc.invalidateQueries({ queryKey: ["document", id] });
      qc.invalidateQueries({ queryKey: ["document-relationships", id] });
      qc.invalidateQueries({ queryKey: ["document-audit", id] });
    },
    onError: (err: any) => {
      toast.error(extractApiError(err, "Could not confirm the suggested link."));
    },
  });

  const deleteRelationshipMutation = useMutation({
    mutationFn: (relationshipId: string) => documentsAPI.deleteRelationship(id!, relationshipId),
    onSuccess: () => {
      toast.success("Document relationship removed.");
      setRelationshipToRemove(null);
      setRemoveConfirmText("");
      qc.invalidateQueries({ queryKey: ["document-relationships", id] });
      qc.invalidateQueries({ queryKey: ["document-audit", id] });
    },
    onError: (err) => toast.error(extractApiError(err, "Could not remove document relationship.")),
  });
  // Close download tray on outside click. Must stay above the early returns
  // below so hook order is stable across loading/loaded renders (React #310).
  useEffect(() => {
    if (!showDownloadTray) return;
    const handler = (e: MouseEvent) => {
      if (downloadTrayRef.current && !downloadTrayRef.current.contains(e.target as Node)) {
        setShowDownloadTray(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [showDownloadTray]);

  useEffect(() => {
    if (!showMoreMenu) return;
    const handler = (e: MouseEvent) => {
      if (moreMenuRef.current && !moreMenuRef.current.contains(e.target as Node)) {
        setShowMoreMenu(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [showMoreMenu]);

  // ── Check-in (release) coordination ──────────────────────────────────────
  // The edit panel registers a saver so that releasing the lock can flush any
  // unsaved metadata edits first (Infor-style Save / Discard / Cancel prompt).
  const metadataSaverRef = useRef<MetadataSaver | null>(null);
  const registerMetadataSaver = useCallback((s: MetadataSaver | null) => {
    metadataSaverRef.current = s;
  }, []);
  const [releasePrompt, setReleasePrompt] = useState<{ resolve: (proceed: boolean) => void } | null>(null);
  const [releaseSaving, setReleaseSaving] = useState(false);
  const confirmRelease = useCallback(async (): Promise<boolean> => {
    const saver = metadataSaverRef.current;
    if (!saver?.isDirty) return true;
    return new Promise<boolean>((resolve) => setReleasePrompt({ resolve }));
  }, []);

  if (isLoading)
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="w-8 h-8 text-primary animate-spin" />
      </div>
    );

  if (!doc) {
    const goBack = () => {
      if (window.history.length > 1) {
        navigate(-1);
      } else {
        navigate("/documents");
      }
    };

    return (
      <div className="mx-auto mt-10 max-w-xl rounded-xl border border-slate-200 bg-white p-8 text-slate-900 shadow-sm">
        <div className="flex items-start gap-3">
          <AlertTriangle className="mt-1 h-6 w-6 text-amber-500" />
          <div>
            <h2 className="text-xl font-semibold">Document not found</h2>
            <p className="mt-2 text-sm text-slate-600">
              You don't have permission to view this document. You can only access documents you've uploaded, own, or have been assigned to. If you believe this is an error, please contact your administrator.
            </p>
          </div>
        </div>
        <div className="mt-6 flex flex-col gap-3 sm:flex-row">
          <button
            type="button"
            onClick={goBack}
            className="inline-flex items-center justify-center rounded-md bg-[#287EAD] px-4 py-2 text-sm font-semibold text-white transition hover:bg-[#246d9c]"
          >
            <ArrowLeft className="mr-2 h-4 w-4" /> Go back
          </button>
          <button
            type="button"
            onClick={() => navigate("/documents")}
            className="inline-flex items-center justify-center rounded-md border border-slate-200 bg-white px-4 py-2 text-sm font-semibold text-slate-700 transition hover:bg-slate-50"
          >
            Document list
          </button>
        </div>
      </div>
    );
  }

  
  const relationshipSuggestions = (
    Array.isArray(doc.metadata?.relationship_suggestions)
      ? doc.metadata.relationship_suggestions
      : []
  ) as DocumentRelationshipSuggestion[];
  const pendingRelationshipSuggestions = relationshipSuggestions.filter((suggestion) => (
    !suggestion.auto_created &&
    suggestion.target_document_id &&
    !relationships.some((relationship) => (
      relationship.related_document.id === suggestion.target_document_id &&
      relationship.relation_type === suggestion.relation_type
    ))
  ));
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

  const budgetEnabled = Boolean((doc.metadata as any)?.sunsystems?.budget?.enabled);
  const journalEnabled = Boolean((doc.metadata as any)?.sunsystems?.journal?.enabled);
  // Extract available journal stages for multi-stage posting
  const journalStages = (doc.metadata as any)?.sunsystems?.journal?.stages as Array<{ stage: number; enabled?: boolean }> | undefined;
  const availableStages = journalStages
    ?.filter((s) => s.enabled !== false)
    .map((s) => s.stage)
    .sort((a, b) => a - b) || [1];

  const canApprove = hasAdminAccess || permissions.includes("approve");
  const canArchive = hasAdminAccess || permissions.includes("archive");
  const canRestoreVersion = hasAdminAccess || permissions.includes("upload");
  const canUploadVersion = hasAdminAccess || permissions.includes("upload");
  const canReOcr = hasAdminAccess || (isScanned && permissions.includes("upload"));
  const canDownload = hasAdminAccess || permissions.includes("download");
  const ocrQuality = getOcrQuality(doc.metadata);
  // Document-level lock state (for version upload/restore, not form editing)
  const isLockedByOther = Boolean(doc.is_edit_locked && doc.edit_locked_by !== user?.id);
  const lockedByMe = Boolean(doc.is_edit_locked && doc.edit_locked_by === user?.id);

  const isOwnerOrSubmitter = doc.uploaded_by?.id === user?.id || doc.owned_by?.id === user?.id;
  const canSubmit = !isPersonal && ["draft", "returned"].includes(doc.status) && (canApprove || isOwnerOrSubmitter);

  const submitActionLabel = doc.status === "returned" ? "Resubmit" : "Start workflow";
  const submitActionTitle = doc.status === "returned" ? "Resubmit to resume approval" : "Start approval workflow";

  const canArchiveNow =
    canArchive &&
    !["archived", "void"].includes(doc.status) &&
    (isPersonal || doc.status === "approved");
  const commandActionClass = "flex h-8 items-center gap-1 px-2 text-white/80 transition-colors hover:bg-white/10 hover:text-white disabled:cursor-not-allowed disabled:opacity-40";
  const commandActionDisabledClass = "flex h-8 cursor-not-allowed items-center gap-1 px-2 text-white/55 opacity-60";

  const isDraftOrRejected = ["draft", "rejected", "returned"].includes(doc.status);
  // Delete to Trash: creation-stage documents the user is allowed to delete.
  const canDelete = (hasAdminAccess || permissions.includes("delete"))
    && ["draft", "returned", "rejected"].includes(doc.status)
    && !doc.deleted_at;
  const auditCount = auditLogs?.count ?? 0;
  const auditPages = Math.max(1, Math.ceil(auditCount / AUDIT_PAGE_SIZE));
  const sortedDocumentVersions = [...(doc.versions ?? [])].sort((a, b) => a.version_number - b.version_number);
  const workflowAvailable = !isPersonal && (Boolean(activeTask) || workflowDataLoading || workflowStepsCount > 0);

  const tabs: { id: TabId; label: string; disabled?: boolean }[] = [
    ...(workflowAvailable ? [{ id: "workflow" as const, label: "Workflow" }] : []),
    { id: "attributes", label: "Details" },
    { id: "relationships", label: `Links (${relationships.length}${pendingRelationshipSuggestions.length ? ` + ${pendingRelationshipSuggestions.length}` : ""})` },
    { id: "properties", label: "Properties" },
    { id: "security", label: "Security" },
    { id: "history", label: `History (${sortedDocumentVersions.length})` },
    { id: "comments", label: `Comments (${doc.comments?.length ?? 0})` },
    { id: "audit", label: "Audit trail" },
    ...(isDraftOrRejected
      ? [{ id: "edit" as const, label: "Edit details", disabled: !canEdit || !lockedByMe }]
      : []),
  ];

  const handleTabClick = (tab: { id: TabId; disabled?: boolean }) => {
    if (tab.disabled) return;
    setActiveTab(tab.id);
  };

  const downloadBlobFromUrl = async (url: string, fallbackName: string) => {
    const res = await api.get(url, { responseType: "blob" });
    const disposition = String(res.headers?.["content-disposition"] ?? "");
    const match = disposition.match(/filename\*?=(?:UTF-8'')?["']?([^"';]+)["']?/i);
    const filename = match?.[1] ? decodeURIComponent(match[1]) : fallbackName;
    const blobUrl = URL.createObjectURL(new Blob([res.data]));
    const link = document.createElement("a");
    link.href = blobUrl;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(blobUrl), 1000);
  };

  const handleDownloadDocument = async () => {
    if (!canDownload || !viewerLinks.downloadHref) return;
    try {
      await downloadBlobFromUrl(viewerLinks.downloadHref, doc?.file_name || "document");
    } catch {
      toast.error("Could not download this document.");
    }
  };

  const handleDownloadAsPdf = async () => {
    if (!canDownload || !id) return;
    setDownloadingPdf(true);
    setShowDownloadTray(false);
    try {
      const res = await documentsAPI.downloadAsPdf(id);
      const disposition = String(res.headers?.["content-disposition"] ?? "");
      const match = disposition.match(/filename\*?=(?:UTF-8'')?["']?([^"';]+)["']?/i);
      const stem = (doc?.file_name || "document").replace(/\.[^.]+$/, "");
      const filename = match?.[1] ? decodeURIComponent(match[1]) : `${stem}.pdf`;
      const blobUrl = URL.createObjectURL(new Blob([res.data], { type: "application/pdf" }));
      const link = document.createElement("a");
      link.href = blobUrl;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(blobUrl), 1000);
    } catch (err: any) {
      toast.error("Could not download as PDF. The PDF preview may not be ready yet.");
    } finally {
      setDownloadingPdf(false);
    }
  };

  const getPrintableUrl = async (url: string) => {
    if (viewerLinks.signedFileUrlsEnabled) return url;
    const res = await api.get(url, { responseType: "blob" });
    return URL.createObjectURL(new Blob([res.data], {
      type: String(res.headers?.["content-type"] ?? "application/pdf"),
    }));
  };

  const handlePrintDocument = async () => {
    if (!canDownload || !doc.id) return;
    const printUrl = viewerLinks.openInNewTabUrl || viewerLinks.downloadHref;
    if (!printUrl) {
      toast.info("Document preview is not ready for printing yet.");
      return;
    }

    documentsAPI.filePrintEvent(doc.id).catch(() => {});
    let printableUrl = printUrl;
    let revokePrintableUrl = false;

    try {
      printableUrl = await getPrintableUrl(printUrl);
      revokePrintableUrl = printableUrl !== printUrl;
    } catch {
      toast.error("Could not prepare the document for printing.");
      return;
    }

    const frame = printFrameRef.current;
    if (!frame) {
      window.open(printableUrl, "_blank", "noopener,noreferrer");
      return;
    }

    let printed = false;
    const fallback = window.setTimeout(() => {
      if (printed) return;
      window.open(printableUrl, "_blank", "noopener,noreferrer");
      toast.info("Opened the document in a new tab for printing.");
    }, 1800);

    frame.onload = () => {
      try {
        frame.contentWindow?.focus();
        frame.contentWindow?.print();
        printed = true;
        window.clearTimeout(fallback);
        if (revokePrintableUrl) {
          window.setTimeout(() => URL.revokeObjectURL(printableUrl), 5000);
        }
      } catch {
        window.open(printableUrl, "_blank", "noopener,noreferrer");
      }
    };
    frame.src = printableUrl;
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
    <div className="flex h-full flex-col bg-[#EDEDED] text-[#1F2933]">
      <iframe ref={printFrameRef} title="Printable document" className="hidden" />

      {workflowActionCompleted && !activeTask && (
        <div className="fixed inset-0 z-[200] bg-black/40 flex items-start justify-center pt-[10vh] px-4">
          <div
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="workflow-complete-title"
            className="w-full max-w-sm border border-[#C8CDD2] bg-white shadow-2xl"
          >
            <div className="px-6 pt-5 pb-4">
              <h2 id="workflow-complete-title" className="text-sm font-bold text-[#1F2933]">
                Workflow action complete
              </h2>
              <p className="mt-1.5 text-xs leading-relaxed text-[#5E6870]">
                This document has moved to the next stage and is no longer actionable from your current access level.
              </p>
            </div>
            <div className="flex justify-center pb-5">
              <button
                type="button"
                onClick={() => navigate("/tasks")}
                className="inline-flex items-center bg-[#287EAD] px-5 py-2 text-sm font-semibold text-white hover:bg-[#1E6F99] transition-colors"
              >
                OK
              </button>
            </div>
          </div>
        </div>
      )}
      <WorkspaceCommandBar className="text-xs">
          <button
            onClick={() => navigate(-1)}
            className="flex h-9 shrink-0 items-center gap-1 border border-white/20 bg-[#206D99] px-3 text-xs text-white/85 transition-colors hover:text-white"
          >
            <ArrowLeft className="w-3.5 h-3.5" /> Back
          </button>
          <div className="min-w-0 overflow-hidden">
            <div className="flex min-w-0 items-center gap-2 text-white">
              <h1 className="min-w-0 max-w-[28rem] truncate text-base font-semibold">{doc.title}</h1>
              <span className={cn(
                "inline-flex items-center border px-2.5 py-0.5 text-xs font-bold shadow-sm",
                getCommandStatusClass(doc.status),
              )}>
                {getCommandStatusLabel(doc.status)}
              </span>
              {isPersonal && (
                <span className="inline-flex items-center gap-1 border border-white/25 bg-white/10 px-2.5 py-0.5 text-[10px] font-semibold text-white">
                  <Lock className="w-2.5 h-2.5" /> Personal
                </span>
              )}
              {isScanned && (
                <span className="inline-flex items-center gap-1 border border-white/25 bg-white/10 px-2.5 py-0.5 text-[10px] font-semibold text-white">
                  <ScanLine className="w-2.5 h-2.5" /> Scanned
                </span>
              )}
              {doc.is_edit_locked && (
                <span className="inline-flex animate-fade-in items-center gap-1 border border-amber-200 bg-amber-100 px-2 py-0.5 text-[10px] font-semibold text-amber-800">
                  <Lock className="w-2.5 h-2.5" /> Locked By {doc.edit_locked_by_name || "User"}
                </span>
              )}
            </div>
            <div className="mt-1 flex min-w-0 items-center gap-2 overflow-hidden whitespace-nowrap text-[11px] text-white/75">
              <span className="max-w-[20rem] shrink-0 truncate font-medium">{doc.file_name}</span>
              <span>{formatBytes(doc.file_size)}</span>
              <span>{doc.current_version ? `v${doc.current_version}` : "—"}</span>
              <span>{doc.reference_number}</span>
            </div>
          </div>

        <div className="ml-auto flex shrink-0 items-center gap-1.5 text-xs font-semibold">
          {canSubmit ? (
            <button
              onClick={() => submitMutation.mutate()}
              disabled={submitMutation.isPending}
              className={commandActionClass}
              title={submitActionTitle}
            >
              {submitMutation.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Send className="w-3.5 h-3.5" />}
              <span>{submitActionLabel}</span>
            </button>
          ) : (
            <button disabled className={cn(commandActionDisabledClass, "hidden sm:flex")} title="Not eligible for submission">
              <Send className="w-3.5 h-3.5" />
              <span>{submitActionLabel}</span>
            </button>
          )}

          <AddToFolderMenu
            documentId={doc.id}
            showLabel
            triggerClassName={commandActionClass}
          />

          <div className="flex items-center" title="Favourite document">
            <StarButton
              documentId={doc.id}
              showLabel
              size="sm"
              variant="command"
              className={commandActionClass}
            />
          </div>

          <div className="mx-1 hidden h-5 w-px bg-white/20 sm:block" />

          {/* Download split button with format tray */}
          <div ref={downloadTrayRef} className="relative" id="download-tray">
            {canDownload && viewerLinks.downloadHref ? (
              <button
                type="button"
                onClick={() => setShowDownloadTray((v) => !v)}
                className={cn(commandActionClass, showDownloadTray && "bg-white/10 text-white")}
                title="Download options"
                aria-haspopup="true"
                aria-expanded={showDownloadTray}
              >
                <Download className="w-3.5 h-3.5" />
                <span>Download</span>
                <ChevronDown className={cn("w-3 h-3 transition-transform", showDownloadTray && "rotate-180")} />
              </button>
            ) : (
              <button
                disabled
                className={commandActionDisabledClass}
                title={canDownload ? "Preview not ready yet" : "Download permission required"}
              >
                <Download className="w-3.5 h-3.5" />
                <span>Download</span>
                <ChevronDown className="w-3 h-3" />
              </button>
            )}

            {showDownloadTray && canDownload && viewerLinks.downloadHref && (
              <div
                className="absolute right-0 top-full z-50 mt-1 w-56 overflow-hidden border border-[#C8CDD2] bg-white shadow-lg"
                style={{ minWidth: "14rem" }}
              >
                <p className="border-b border-[#E3E7EA] bg-[#F5F7F8] px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-[#5E6870]">
                  Download as
                </p>
                {/* Original format — authenticated blob fetch (same approach as
                    the working merge download); carries JWT, so it works for all
                    document types regardless of signed-URL settings. */}
                <button
                  type="button"
                  onClick={() => { setShowDownloadTray(false); handleDownloadDocument(); }}
                  className="flex w-full items-center gap-2.5 px-3 py-2.5 text-sm text-[#1F2933] hover:bg-[#EEF6FB] hover:text-[#287EAD]"
                >
                  <Download className="h-4 w-4 shrink-0 text-[#5E6870]" />
                  <span className="font-medium">Original format</span>
                </button>
                {/* Download as PDF — hits the backend convert endpoint, which
                    handles office (preview PDF) and images (PIL → PDF). */}
                <button
                  type="button"
                  onClick={() => { setShowDownloadTray(false); handleDownloadAsPdf(); }}
                  disabled={downloadingPdf}
                  className="flex w-full items-center gap-2.5 px-3 py-2.5 text-sm text-[#1F2933] hover:bg-[#EEF6FB] hover:text-[#287EAD] disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {downloadingPdf
                    ? <Loader2 className="h-4 w-4 shrink-0 animate-spin text-[#5E6870]" />
                    : <FileText className="h-4 w-4 shrink-0 text-[#5E6870]" />}
                  <span className="font-medium">Download as PDF</span>
                </button>
              </div>
            )}
          </div>

          {/* Secondary actions — shown inline on wide screens, and collapsed
              into the "More" menu below xl so the bar never overflows. */}
          <button
            onClick={handlePrintDocument}
            disabled={!canDownload || (!viewerLinks.openInNewTabUrl && !viewerLinks.downloadHref)}
            className={cn(commandActionClass, "hidden xl:flex")}
            title={canDownload ? "Print document" : "Print permission required"}
          >
            <Printer className="w-3.5 h-3.5" />
            <span>Print</span>
          </button>

          {canUploadVersion && !isLockedByOther && (
            <Suspense fallback={<span className="hidden h-8 items-center px-2 text-xs text-white/70 xl:inline-flex">Loading…</span>}>
              <UploadVersionDrawer
                documentId={doc.id}
                currentVersion={doc.current_version}
                maxSizeMb={doc.document_type?.max_file_size_mb}
                onVersionUploaded={handleVersionUploaded}
                triggerClassName={cn(commandActionClass, "hidden xl:flex")}
                triggerIconClassName="w-3.5 h-3.5"
                disabled={!lockedByMe}
                triggerTitle={lockedByMe ? "Upload a new version" : "Lock the document first to upload a new version"}
              />
            </Suspense>
          )}

          {canArchiveNow && (
            <button
              onClick={() => archiveMutation.mutate()}
              disabled={archiveMutation.isPending}
              className={cn(commandActionClass, "hidden xl:flex")}
              title="Archive document"
            >
              {archiveMutation.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Archive className="w-3.5 h-3.5" />}
              <span>Archive</span>
            </button>
          )}

          {canDelete && (
            <button
              onClick={() => {
                if (window.confirm("Move this document to Trash? You can restore it later.")) deleteMutation.mutate();
              }}
              disabled={deleteMutation.isPending}
              className={cn(commandActionClass, "hidden xl:flex")}
              title="Move to Trash"
            >
              {deleteMutation.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5" />}
              <span>Delete</span>
            </button>
          )}

          <div ref={moreMenuRef} className="relative xl:hidden">
            <button
              type="button"
              onClick={() => setShowMoreMenu((v) => !v)}
              className={cn(commandActionClass, showMoreMenu && "bg-white/10 text-white")}
              title="More actions"
              aria-haspopup="true"
              aria-expanded={showMoreMenu}
            >
              <MoreHorizontal className="w-3.5 h-3.5" />
              <span className="hidden sm:inline">More</span>
            </button>

            {showMoreMenu && (
              <div className="absolute right-0 top-full z-50 mt-1 w-56 overflow-hidden border border-[#C8CDD2] bg-white shadow-lg">
                <button
                  type="button"
                  onClick={() => { setShowMoreMenu(false); handlePrintDocument(); }}
                  disabled={!canDownload || (!viewerLinks.openInNewTabUrl && !viewerLinks.downloadHref)}
                  className="flex w-full items-center gap-2.5 px-3 py-2.5 text-sm text-[#1F2933] hover:bg-[#EEF6FB] hover:text-[#287EAD] disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <Printer className="h-4 w-4 shrink-0 text-[#5E6870]" />
                  <span className="font-medium">Print</span>
                </button>

                {canUploadVersion && !isLockedByOther && (
                  <Suspense fallback={null}>
                    <UploadVersionDrawer
                      documentId={doc.id}
                      currentVersion={doc.current_version}
                      maxSizeMb={doc.document_type?.max_file_size_mb}
                      onVersionUploaded={handleVersionUploaded}
                      triggerClassName="flex w-full items-center gap-2.5 px-3 py-2.5 text-sm text-[#1F2933] hover:bg-[#EEF6FB] hover:text-[#287EAD] disabled:cursor-not-allowed disabled:opacity-50"
                      triggerIconClassName="h-4 w-4 shrink-0 text-[#5E6870]"
                      disabled={!lockedByMe}
                      triggerTitle={lockedByMe ? "Upload a new version" : "Lock the document first to upload a new version"}
                    />
                  </Suspense>
                )}

                {canArchiveNow && (
                  <button
                    type="button"
                    onClick={() => { setShowMoreMenu(false); archiveMutation.mutate(); }}
                    disabled={archiveMutation.isPending}
                    className="flex w-full items-center gap-2.5 px-3 py-2.5 text-sm text-[#1F2933] hover:bg-[#EEF6FB] hover:text-[#287EAD] disabled:opacity-50"
                  >
                    {archiveMutation.isPending ? <Loader2 className="h-4 w-4 shrink-0 animate-spin text-[#5E6870]" /> : <Archive className="h-4 w-4 shrink-0 text-[#5E6870]" />}
                    <span className="font-medium">Archive</span>
                  </button>
                )}

                {canDelete && (
                  <button
                    type="button"
                    onClick={() => {
                      setShowMoreMenu(false);
                      if (window.confirm("Move this document to Trash? You can restore it later.")) deleteMutation.mutate();
                    }}
                    disabled={deleteMutation.isPending}
                    className="flex w-full items-center gap-2.5 px-3 py-2.5 text-sm text-[#B42318] hover:bg-[#FEECEA] disabled:opacity-50"
                  >
                    {deleteMutation.isPending ? <Loader2 className="h-4 w-4 shrink-0 animate-spin" /> : <Trash2 className="h-4 w-4 shrink-0" />}
                    <span className="font-medium">Delete</span>
                  </button>
                )}
              </div>
            )}
          </div>
        </div>
      </WorkspaceCommandBar>

      {/* Enterprise workspace: preview left, document intelligence right */}
      <div className={cn(
        "scrollbar-minimal relative grid min-h-0 flex-1 grid-cols-1 items-start gap-4 overflow-y-auto p-4 lg:grid-cols-12",
        compareDoc && "xl:grid-cols-12",
        activeTask && "pb-24",
        "pr-8",
      )}>

        {/* Column 1: Document Viewer / Form (Left — expands to full-width for forms) */}
        <div className={cn(
          "space-y-4",
          compareDoc ? "lg:col-span-8 xl:col-span-8"
            : activeTab === "workflow" ? "lg:col-span-6"
            : "lg:col-span-8",
        )}>

          {/* Active Notifications / Status Banners */}
          {isPersonal && (
            <div className="flex items-start gap-3 border border-[#C8CDD2] bg-white px-4 py-3 text-xs text-[#287EAD] shadow-sm animate-fade-in">
              <Info className="mt-0.5 h-4 w-4 flex-shrink-0" />
              <div>
                <p className="font-semibold">Personal document</p>
                <p className="mt-0.5 text-[10px] text-[#5E6870]">Private to you and administrators. Cannot be submitted for approval.</p>
              </div>
            </div>
          )}

          {ocrActive && (
            <div className="flex items-start gap-3 border border-[#C8CDD2] bg-white px-4 py-3 text-xs text-[#287EAD] shadow-sm">
              <Loader2 className="mt-0.5 h-4 w-4 flex-shrink-0 animate-spin" />
              <div>
                <p className="font-semibold">Extracting text…</p>
                <p className="mt-0.5 text-[10px] text-[#5E6870]">
                  OCR is running in the background. This page will update automatically.
                </p>
              </div>
            </div>
          )}

          {ocrStatus === "failed" && (
            <div className="flex items-start gap-3 border border-destructive/30 bg-white px-4 py-3 text-xs text-destructive shadow-sm">
              <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0" />
              <div className="flex-1">
                <p className="font-semibold">OCR failed</p>
                <p className="mt-0.5 text-[10px] text-destructive/80">Text extraction did not complete. Search index is limited.</p>
                {canReOcr && (
                  <button
                    onClick={() => reOcrMutation.mutate()}
                    disabled={reOcrMutation.isPending}
                    className="mt-2 inline-flex items-center gap-1 text-[10px] font-semibold text-destructive hover:underline"
                  >
                    {reOcrMutation.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
                    Re-run OCR
                  </button>
                )}
              </div>
            </div>
          )}

          {/* Journal XML modal */}
          {showJournalXml && (
            <JournalPayloadModal
              documentId={doc.id}
              title={doc.title}
              availableStages={availableStages}
              onClose={() => setShowJournalXml(false)}
            />
          )}

          {/* ── Journal status ── */}
          {journalEnabled && (
            <div className="space-y-3">
              <JournalPostingCard
                documentId={doc.id}
                expectPosting={journalEnabled && ["request_approved", "fully_approved"].includes(doc.status)}
                watchKey={`${doc.status}:${doc.updated_at}`}
                availableStages={availableStages}
              />
            </div>
          )}

          {/* Non-form document primary viewer + optional comparison viewer */}
          <div className={cn("grid gap-3", compareDoc && "xl:grid-cols-2")}>
              <div className="border border-[#C8CDD2] bg-white shadow-sm">
                <Suspense fallback={
                  <div className="flex min-h-[32rem] items-center justify-center bg-white">
                    <Loader2 className="h-8 w-8 animate-spin text-[#287EAD]" />
                  </div>
                }>
                  <DocumentViewer
                    document={doc}
                    submitSlot={null}
                    hideUploadActionBar
                    onPreviewLinksChange={handlePreviewLinksChange}
                    onBeforeRelease={confirmRelease}
                  />
                </Suspense>
              </div>

              {compareDoc && (
                <div className="border border-[#C8CDD2] bg-white shadow-sm">
                  <div className="flex min-h-[44px] items-center justify-between gap-3 border-b border-[#C8CDD2] bg-[#F5F7F8] px-3 py-2">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-bold text-[#1F2933]" title={compareDoc.title}>{compareDoc.title}</p>
                      <p className="text-xs text-[#5E6870]">{compareDoc.reference_number} · {compareDoc.document_type?.name || compareDoc.document_type_name || "Document"}</p>
                    </div>
                    <button
                      type="button"
                      onClick={() => setCompareDocumentId(null)}
                      className="shrink-0 p-1 text-[#5E6870] hover:text-[#1F2933]"
                      title="Close concurrent preview"
                    >
                      <X className="h-4 w-4" />
                    </button>
                  </div>
                  <Suspense fallback={
                    <div className="flex min-h-[32rem] items-center justify-center bg-white">
                      <Loader2 className="h-8 w-8 animate-spin text-[#287EAD]" />
                    </div>
                  }>
                    <DocumentViewer
                      document={compareDoc}
                      submitSlot={null}
                      hideUploadActionBar
                    />
                  </Suspense>
                </div>
              )}
            </div>
        </div>

        {/* Column 2: Details & Properties Tabs (Right) */}
        <div className={cn("space-y-3", activeTab === "workflow" && !compareDoc ? "lg:col-span-6" : "lg:col-span-4")}>

          {/* Tab Selection Row */}
          <div className="border-b border-[#C8CDD2] bg-white px-3 pt-2">
            <nav className="-mb-px flex gap-1 flex-wrap">
              {tabs.map((tab) => {
                const isActive = activeTab === tab.id;
                return (
                  <button
                    key={tab.id}
                    onClick={() => handleTabClick(tab)}
                    disabled={tab.disabled}
                    className={cn(
                      "inline-flex items-center gap-1 whitespace-nowrap border-b-2 px-2.5 py-2 text-sm font-semibold transition-all disabled:cursor-not-allowed disabled:opacity-40",
                      isActive
                        ? "border-[#287EAD] text-[#287EAD]"
                        : "border-transparent text-[#5E6870] hover:border-[#C8CDD2] hover:text-[#1F2933]"
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
          <div className="min-h-[34rem] border border-[#C8CDD2] bg-white p-4 shadow-sm">

            {/* WORKFLOW TAB */}
            {activeTab === "workflow" && workflowAvailable && (
              <div className="space-y-4 animate-fade-in">
                <Suspense fallback={
                  <div className="flex min-h-[18rem] items-center justify-center border border-[#C8CDD2] bg-[#F5F7F8] text-sm text-[#5E6870]">
                    <Loader2 className="mr-2 h-4 w-4 animate-spin text-[#287EAD]" />
                    Loading workflow map...
                  </div>
                }>
                  <WorkflowVisualizer
                    steps={workflowData?.steps ?? []}
                    currentStep={workflowData?.currentStep ?? -1}
                    documentTitle={workflowData?.documentTitle || doc.title}
                    submittedBy={workflowData?.submittedBy}
                    submittedDate={workflowData?.submittedDate}
                    isLoading={workflowDataLoading}
                  />
                </Suspense>

                {activeTask && (
                  <div className="border border-[#C8CDD2] bg-[#F5F7F8] p-4">
                    <div className="mb-4 flex items-center justify-between gap-3 border-b border-[#C8CDD2] pb-3">
                      <h3 className="text-sm font-bold text-[#1F2933]">Task actions</h3>
                      <span className="text-xs font-semibold uppercase tracking-wider text-[#5E6870]">Current approver</span>
                    </div>
                    <Suspense fallback={<div className="text-sm text-muted-foreground">Loading workflow actions…</div>}>
                      <WorkflowActionPanel task={activeTask} documentId={id!} onCompleted={() => setWorkflowActionCompleted(true)} />
                    </Suspense>
                  </div>
                )}
              </div>
            )}

            {/* PROPERTIES TAB */}
            {activeTab === "properties" && (
              <div className="space-y-4 animate-fade-in">
                <div className="grid grid-cols-[140px_1fr] gap-x-4 gap-y-3.5 py-1 text-sm">
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
                        <span className="text-sm text-muted-foreground">—</span>
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
                        <span className="text-sm text-muted-foreground">—</span>
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
                  <p className="py-2 text-sm text-muted-foreground">No metadata attributes found for this document type.</p>
                )}
              </div>
            )}

            {/* RELATIONSHIPS TAB */}
            {activeTab === "relationships" && (
              <div className="space-y-4 animate-fade-in">
                <div className="border-b border-[#C8CDD2] pb-3">
                  <p className="text-sm font-bold uppercase tracking-wider text-[#5E6870]">Document relationships</p>
                  <p className="mt-1 text-sm text-[#5E6870]">
                    Links are detected automatically from the rules configured on the document type. Confirm the suggested matches to add them to the procurement chain.
                  </p>
                </div>

                {pendingRelationshipSuggestions.length > 0 && (
                  <div className="border border-[#A7C9DC] bg-[#F1F8FC]">
                    <div className="border-b border-[#C8CDD2] px-3 py-2">
                      <p className="text-sm font-bold text-[#1F2933]">Suggested PO links</p>
                      <p className="mt-0.5 text-xs text-[#5E6870]">
                        Exact PO references were found in this document. Confirm the links that belong in the procurement chain.
                      </p>
                    </div>
                    <div className="divide-y divide-[#D3D7DA] bg-white">
                      {pendingRelationshipSuggestions.map((suggestion) => (
                        <div
                          key={`${suggestion.target_document_id}-${suggestion.relation_type}`}
                          className="flex flex-col gap-3 px-3 py-3 sm:flex-row sm:items-center sm:justify-between"
                        >
                          <div className="min-w-0">
                            <div className="flex flex-wrap items-center gap-2">
                              <span className="text-xs font-bold uppercase tracking-wide text-[#287EAD]">
                                {suggestion.relation_type.replace("-", " ")}
                              </span>
                              <span className="text-xs text-[#5E6870]">
                                Matched PO {suggestion.matched_reference}
                              </span>
                            </div>
                            <p className="mt-1 truncate text-sm font-bold text-[#1F2933]" title={suggestion.target_title}>
                              {suggestion.target_title}
                            </p>
                            <p className="mt-0.5 truncate text-xs text-[#5E6870]">
                              {suggestion.target_reference_number} · {suggestion.target_document_type}
                            </p>
                          </div>
                          {canEdit && (
                            <button
                              type="button"
                              onClick={() => confirmRelationshipSuggestionMutation.mutate(suggestion)}
                              disabled={confirmRelationshipSuggestionMutation.isPending}
                              className="inline-flex shrink-0 items-center justify-center gap-2 border border-[#287EAD] bg-[#287EAD] px-3 py-2 text-sm font-semibold text-white hover:bg-[#206D99] disabled:cursor-not-allowed disabled:opacity-50"
                            >
                              {confirmRelationshipSuggestionMutation.isPending ? (
                                <Loader2 className="h-4 w-4 animate-spin" />
                              ) : (
                                <Check className="h-4 w-4" />
                              )}
                              Confirm link
                            </button>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                <div className="space-y-2">
                  {relationships.length === 0 ? (
                    <div className="border border-[#C8CDD2] bg-[#F5F7F8] px-4 py-8 text-center text-sm text-[#5E6870]">
                      No related documents yet. Matches are detected automatically from the configured rules and appear here for confirmation.
                    </div>
                  ) : (
                    <div className="divide-y divide-[#D3D7DA] border border-[#C8CDD2] bg-white">
                      {relationships.map((relationship) => {
                        const related = relationship.related_document;
                        const isComparing = compareDocumentId === related.id;
                        return (
                          <div key={relationship.id} className="p-3 hover:bg-[#F5F7F8]">
                            <div className="flex items-start justify-between gap-3">
                              <div className="min-w-0">
                                <div className="flex flex-wrap items-center gap-2">
                                  <span className="border border-[#287EAD]/25 bg-[#EEF6FB] px-2 py-0.5 text-xs font-bold text-[#287EAD]">
                                    {describeRelationship(relationship)}
                                  </span>
                                  <span className="text-xs font-semibold text-[#5E6870]">
                                    {related.document_type_name || "Document"}
                                  </span>
                                </div>
                                <p className="mt-2 truncate text-sm font-bold text-[#1F2933]" title={related.title}>
                                  {related.title}
                                </p>
                                <p className="mt-1 text-xs font-mono text-[#5E6870]">{related.reference_number}</p>
                                {relationship.note && (
                                  <p className="mt-2 border-l-2 border-[#287EAD] bg-[#F5F7F8] px-2 py-1.5 text-sm text-[#5E6870]">
                                    {relationship.note}
                                  </p>
                                )}
                              </div>
                              {canEdit && (
                                <button
                                  type="button"
                                  onClick={() => { setRelationshipToRemove(relationship); setRemoveConfirmText(""); }}
                                  className="shrink-0 p-1 text-[#5E6870] hover:text-red-700"
                                  title="Remove relationship"
                                >
                                  <X className="h-4 w-4" />
                                </button>
                              )}
                            </div>
                            <div className="mt-3 flex flex-wrap items-center gap-2">
                              <button
                                type="button"
                                onClick={() => setCompareDocumentId(isComparing ? null : related.id)}
                                className={cn(
                                  "inline-flex items-center gap-1.5 border px-2.5 py-1.5 text-xs font-semibold",
                                  isComparing
                                    ? "border-[#287EAD] bg-[#EEF6FB] text-[#287EAD]"
                                    : "border-[#C8CDD2] bg-white text-[#1F2933] hover:bg-[#EEF6FB] hover:text-[#287EAD]",
                                )}
                              >
                                <Columns2 className="h-3.5 w-3.5" />
                                {isComparing ? "Close alongside" : "View alongside"}
                              </button>
                              <button
                                type="button"
                                onClick={() => navigate(`/documents/${related.id}`)}
                                className="inline-flex items-center gap-1.5 border border-[#C8CDD2] bg-white px-2.5 py-1.5 text-xs font-semibold text-[#1F2933] hover:bg-[#F5F7F8]"
                              >
                                <ExternalLink className="h-3.5 w-3.5" />
                                Open
                              </button>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>

              </div>
            )}

            {/* SECURITY TAB */}
            {activeTab === "security" && (
              <div className="animate-fade-in space-y-4">
                <div className="border-b border-[#C8CDD2] pb-3">
                  <p className="text-sm font-bold uppercase tracking-wider text-[#5E6870]">Access control</p>
                  <p className="mt-1 text-sm text-[#5E6870]">Your effective permissions for this document.</p>
                </div>

                <div className="border border-[#C8CDD2] bg-[#F5F7F8] p-3">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <p className="text-sm font-semibold text-[#1F2933]">Role access</p>
                      <p className="mt-0.5 text-xs text-[#5E6870]">Calculated from your role and document grants.</p>
                    </div>
                    <span className="border border-[#287EAD]/25 bg-white px-2.5 py-1 text-sm font-bold text-[#287EAD]">
                      {hasAdminAccess ? "Administrator (Full Access)" : "Standard User"}
                    </span>
                  </div>
                </div>

                <div className="overflow-hidden border border-[#C8CDD2]">
                  <div className="grid grid-cols-[1fr_auto] bg-[#50545A] px-3 py-2 text-sm font-semibold text-white">
                    <span>Permission</span>
                    <span>Status</span>
                  </div>
                  <div className="divide-y divide-[#D3D7DA] bg-white">
                    {[
                      { label: "View Document Details", allowed: canViewDocument },
                      { label: "Edit / Update Metadata", allowed: canEdit },
                      { label: "Add Document Comments", allowed: canComment },
                      { label: "Download Original File", allowed: canDownload },
                      { label: "Restore Historical Versions", allowed: canRestoreVersion },
                      { label: "Archive / Delete Document", allowed: canArchive },
                    ].map(({ label, allowed }) => (
                      <div key={label} className="grid grid-cols-[1fr_auto] items-center gap-3 px-3 py-3 text-sm">
                        <span className="font-medium text-[#1F2933]">{label}</span>
                        {allowed ? (
                          <span className="inline-flex items-center gap-1 border border-emerald-200 bg-emerald-50 px-2.5 py-1 text-xs font-bold text-emerald-800">
                            <Check className="w-3 h-3 text-teal" /> Allowed
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1 border border-red-200 bg-red-50 px-2.5 py-1 text-xs font-bold text-red-800">
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
              <div className="animate-fade-in space-y-4">
                <div className="border-b border-[#C8CDD2] pb-3">
                  <p className="text-sm font-bold uppercase tracking-wider text-[#5E6870]">Version history</p>
                  <p className="mt-1 text-sm text-[#5E6870]">{sortedDocumentVersions.length} saved version{sortedDocumentVersions.length === 1 ? "" : "s"} for this document.</p>
                </div>
                {sortedDocumentVersions.length === 0 && (
                  <div className="border border-[#C8CDD2] bg-[#F5F7F8] py-8 text-center text-sm text-[#5E6870]">No version history available.</div>
                )}
                {sortedDocumentVersions.length > 0 && (
                  <div className="overflow-hidden border border-[#C8CDD2] bg-white">
                    {sortedDocumentVersions.map((v) => {
                      const isCurrent = v.version_number === doc.current_version;
                      const awaitConfirm = confirmRestoreId === v.id;
                      return (
                        <div
                          key={v.id}
                          onMouseEnter={() => prefetchVersionPreview(v.id)}
                          onFocus={() => prefetchVersionPreview(v.id)}
                          className={cn(
                            "grid grid-cols-[3rem_1fr] gap-3 border-b border-[#D3D7DA] px-3 py-3 last:border-b-0 transition-colors hover:bg-[#F5F7F8]",
                            isCurrent && "bg-[#EEF6FB]",
                          )}
                        >
                          <div className="flex flex-col items-center">
                            <div className={cn(
                              "flex h-9 w-9 select-none items-center justify-center border text-sm font-bold",
                              isCurrent ? "border-[#287EAD] bg-white text-[#287EAD]" : "border-[#C8CDD2] bg-[#F5F7F8] text-[#5E6870]",
                            )}>
                              v{v.version_number}
                            </div>
                            <div className="mt-2 h-full min-h-6 w-px bg-[#D3D7DA]" />
                          </div>
                          <div className="min-w-0 space-y-2">
                            <div className="flex items-start justify-between gap-3">
                              <div className="min-w-0">
                                <p className="truncate text-sm font-bold text-[#1F2933]" title={v.file_name}>{v.file_name}</p>
                                <p className="mt-1 text-xs text-[#5E6870]">
                                  {format(new Date(v.created_at), "dd MMM yyyy HH:mm")} · {v.created_by.first_name} {v.created_by.last_name} · {formatBytes(v.file_size)}
                                </p>
                              </div>
                              {isCurrent && (
                                <span className="shrink-0 border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-xs font-bold text-emerald-800">Current</span>
                              )}
                            </div>

                            {v.change_summary && (
                              <p className="border-l-2 border-[#287EAD] bg-[#F5F7F8] px-2 py-1.5 text-sm italic text-[#1F2933]">"{v.change_summary}"</p>
                            )}

                            <div className="flex items-center gap-2">
                              {canDownload && v.file_url && v.file_url.includes("sig=") && (
                                <a
                                  href={v.file_url}
                                  download={v.file_name}
                                  title="Download this version"
                                  className="inline-flex items-center gap-1 border border-[#C8CDD2] bg-white px-2.5 py-1.5 text-xs font-semibold text-[#1F2933] hover:bg-[#F5F7F8]"
                                >
                                  <Download className="h-3.5 w-3.5" /> Download
                                </a>
                              )}
                              {canDownload && v.file_url && !v.file_url.includes("sig=") && (
                                <button
                                  type="button"
                                  onClick={() => downloadBlobFromUrl(v.file_url!, v.file_name || "version").catch(() => {
                                    toast.error("Could not download this version.");
                                  })}
                                  title="Download this version"
                                  className="inline-flex items-center gap-1 border border-[#C8CDD2] bg-white px-2.5 py-1.5 text-xs font-semibold text-[#1F2933] hover:bg-[#F5F7F8]"
                                >
                                  <Download className="h-3.5 w-3.5" /> Download
                                </button>
                              )}
                              {!isCurrent && canRestoreVersion && (
                                awaitConfirm ? (
                                  <div className="flex items-center gap-2 border border-[#287EAD]/40 bg-[#EEF6FB] px-2.5 py-1.5">
                                    <span className="text-xs font-semibold text-[#1F2933]">Restore v{v.version_number}?</span>
                                    <button
                                      onClick={() => restoreMutation.mutate(v.id)}
                                      disabled={restoreMutation.isPending}
                                      className="text-xs font-bold text-[#287EAD] hover:underline"
                                    >
                                      {restoreMutation.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : "Confirm"}
                                    </button>
                                    <button
                                      onClick={() => setConfirmRestoreId(null)}
                                      className="text-xs text-[#5E6870] hover:underline"
                                    >
                                      Cancel
                                    </button>
                                  </div>
                                ) : (
                                  <button
                                    onClick={() => setConfirmRestoreId(v.id)}
                                    disabled={!lockedByMe}
                                    className={cn(
                                      "inline-flex items-center gap-1 border border-[#C8CDD2] bg-white px-2.5 py-1.5 text-xs font-semibold text-[#1F2933] hover:bg-[#F5F7F8]",
                                      !lockedByMe && "cursor-not-allowed opacity-50 hover:bg-white",
                                    )}
                                    title={lockedByMe ? "Restore to this version" : "Lock the document first to restore a version"}
                                  >
                                    <RotateCcw className="h-3.5 w-3.5" /> Restore
                                  </button>
                                )
                              )}
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            )}

            {/* COMMENTS TAB */}
            {activeTab === "comments" && (
              <div className="animate-fade-in space-y-4">
                <div className="border-b border-[#C8CDD2] pb-3">
                  <p className="text-sm font-bold uppercase tracking-wider text-[#5E6870]">Comments</p>
                  <p className="mt-1 text-sm text-[#5E6870]">{doc.comments?.length ?? 0} comment{(doc.comments?.length ?? 0) === 1 ? "" : "s"} on this document.</p>
                </div>

                <div className="max-h-[22rem] overflow-y-auto border border-[#C8CDD2] bg-white">
                  {(!doc.comments || doc.comments.length === 0) && (
                    <div className="px-4 py-8 text-center text-sm text-[#5E6870]">
                      No comments added yet.
                    </div>
                  )}
                  {doc.comments?.map((c) => (
                    <div
                      key={c.id}
                      className={cn(
                        "grid grid-cols-[2.5rem_1fr] gap-3 border-b border-[#D3D7DA] px-3 py-3 last:border-b-0",
                        c.is_internal ? "bg-[#EEF6FB]" : "bg-white",
                      )}
                    >
                      <div className="flex h-9 w-9 items-center justify-center border border-[#C8CDD2] bg-[#F5F7F8] text-xs font-bold uppercase text-[#287EAD]">
                        {(c.author.first_name?.[0] ?? "")}{(c.author.last_name?.[0] ?? "")}
                      </div>
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <span className="font-semibold text-[#1F2933]">{c.author.first_name} {c.author.last_name}</span>
                          <span className="text-xs text-[#5E6870]">
                            {format(new Date(c.created_at), "dd MMM yyyy HH:mm")}
                          </span>
                        </div>
                        {c.is_internal && (
                          <span className="mt-1 inline-flex border border-[#287EAD]/25 bg-white px-2 py-0.5 text-xs font-semibold text-[#287EAD]">Internal</span>
                        )}
                        <p className="mt-2 whitespace-pre-wrap text-sm leading-relaxed text-[#1F2933]">{c.content}</p>
                      </div>
                    </div>
                  ))}
                </div>

                <div className="space-y-2 border border-[#C8CDD2] bg-[#F5F7F8] p-3">
                  <label className="text-sm font-semibold text-[#1F2933]">Add comment</label>
                  <textarea
                    value={comment}
                    onChange={(e) => setComment(e.target.value)}
                    rows={3}
                    className="block w-full border border-[#AEB5BB] bg-white px-3 py-2 text-sm text-[#1F2933] focus:outline-none focus:ring-1 focus:ring-[#287EAD]"
                    placeholder="Add a comment…"
                    disabled={!canComment}
                  />
                  <div className="flex justify-end">
                    <button
                      onClick={() => comment.trim() && commentMutation.mutate(comment.trim())}
                      disabled={!comment.trim() || commentMutation.isPending || !canComment}
                      className="inline-flex items-center gap-2 bg-[#287EAD] px-3 py-2 text-sm font-semibold text-white hover:bg-[#206D99] disabled:cursor-not-allowed disabled:opacity-50"
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
              <div className="animate-fade-in space-y-4">
                <div className="flex items-center justify-between gap-3 border-b border-[#C8CDD2] pb-3">
                  <div>
                    <p className="text-sm font-bold uppercase tracking-wider text-[#5E6870]">Audit trail</p>
                    <p className="mt-1 text-sm text-[#5E6870]">{auditCount.toLocaleString()} recorded event{auditCount === 1 ? "" : "s"}.</p>
                  </div>
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
                    className="border border-[#C8CDD2] bg-white p-2 text-[#5E6870] transition-colors hover:bg-[#F5F7F8] hover:text-[#1F2933]"
                    title="Download activity trail (JSON)"
                  >
                    <Download className="h-4 w-4" />
                  </button>
                </div>

                {/* Date grouped audit items */}
                <div className="max-h-[28rem] overflow-y-auto border border-[#C8CDD2] bg-white">
                  {auditLogs?.results?.length ? (
                    auditLogs.results.map((log) => {
                      const currentDateHeader = formatActivityDateHeader(log.timestamp);
                      const showHeader = currentDateHeader !== lastDateHeader;
                      lastDateHeader = currentDateHeader;

                      return (
                        <div key={log.id}>
                          {showHeader && (
                            <div className="select-none border-b border-[#C8CDD2] bg-[#F5F7F8] px-3 py-2 text-xs font-bold uppercase tracking-wider text-[#5E6870]">
                              {currentDateHeader}
                            </div>
                          )}

                          <div className="grid grid-cols-[2rem_1fr] gap-3 border-b border-[#D3D7DA] px-3 py-3 last:border-b-0 transition-colors hover:bg-[#F5F7F8]">
                            <div className="mt-0.5 flex h-8 w-8 items-center justify-center border border-[#C8CDD2] bg-[#F5F7F8] text-[#287EAD]">
                              <ShieldCheck className="h-4 w-4" />
                            </div>
                            <div className="min-w-0">
                              <p className="text-sm leading-normal text-[#1F2933]">
                                <span className="font-bold text-[#287EAD]">{doc.reference_number}</span> {describeAuditEvent(log.event)} by <span className="font-semibold">{log.actor_name || "System"}</span>
                              </p>
                              {log.changes?.metadata_edits?.length ? (
                                <AuditMetadataEditList edits={log.changes.metadata_edits} />
                              ) : log.summary ? (
                                <p className="mt-2 whitespace-pre-wrap border-l-2 border-[#287EAD] bg-[#F5F7F8] px-2 py-1.5 text-sm leading-relaxed text-[#5E6870]">
                                  {log.summary}
                                </p>
                              ) : null}
                              <div className="mt-2 flex flex-wrap items-center gap-2 text-xs font-mono text-[#5E6870]">
                                <span>{log.ip_address || "System"}</span>
                                <span>·</span>
                                <span>{format(new Date(log.timestamp), "HH:mm:ss")}</span>
                              </div>
                            </div>
                          </div>
                        </div>
                      );
                    })
                  ) : (
                    <div className="px-4 py-8 text-center text-sm text-[#5E6870]">
                      No activity history found for this document yet.
                    </div>
                  )}
                </div>

                {/* Compact pagination inside Audit trail tab */}
                {auditCount > AUDIT_PAGE_SIZE && (
                  <div className="mt-1.5 flex select-none items-center justify-between border-t border-[#C8CDD2] pt-3 text-sm">
                    <span className="text-sm text-[#5E6870]">
                      Page {auditPage} of {auditPages}
                    </span>
                    <div className="flex items-center gap-1.5">
                      <button
                        type="button"
                        onClick={() => setAuditPage((current) => Math.max(1, current - 1))}
                        disabled={auditPage === 1}
                        className="border border-[#C8CDD2] bg-white px-3 py-1.5 text-sm font-semibold text-[#1F2933] hover:bg-[#F5F7F8] disabled:cursor-not-allowed disabled:opacity-40"
                      >
                        Prev
                      </button>
                      <button
                        type="button"
                        onClick={() => setAuditPage((current) => Math.min(auditPages, current + 1))}
                        disabled={auditPage >= auditPages}
                        className="border border-[#C8CDD2] bg-white px-3 py-1.5 text-sm font-semibold text-[#1F2933] hover:bg-[#F5F7F8] disabled:cursor-not-allowed disabled:opacity-40"
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
                  <h3 className="text-sm font-bold uppercase tracking-wider text-muted-foreground">
                    Edit Properties
                  </h3>
                </div>
                <Suspense fallback={<div className="p-4 text-sm text-muted-foreground">Loading editor…</div>}>
                  <MetadataEditPanel
                    document={doc}
                    onClose={() => setActiveTab("properties")}
                    registerSaver={registerMetadataSaver}
                  />
                </Suspense>
              </div>
            )}

          {/* Ad-hoc signature request panel — below the details so the document
              preview on the left stays uninterrupted. */}
          {(doc.document_type?.code === "SIGREQ" || doc.document_type_name === "Signature request") && (
            <Suspense fallback={null}>
              <SignatureRequestPanel documentId={id!} />
            </Suspense>
          )}
        </div>
        </div>

      </div>

      {/* Check-in: unsaved metadata edits prompt (fires on Release) */}
      {releasePrompt && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 p-4">
          <div className="w-full max-w-sm border border-[#C8CDD2] bg-white shadow-xl">
            {/* Header */}
            <div className="border-b border-[#C8CDD2] bg-[#287EAD] px-5 py-4">
              <h4 className="text-base font-semibold text-white">Save changes?</h4>
            </div>
            <div className="p-5">
              <p className="text-sm text-[#5E6870]">
                You have unsaved changes. Do you want to save them before checking in (releasing the lock)?
              </p>
              <div className="mt-5 flex justify-end gap-2">
                <button
                  type="button"
                  disabled={releaseSaving}
                  onClick={() => { releasePrompt.resolve(false); setReleasePrompt(null); }}
                  className="border border-[#C8CDD2] bg-white px-4 py-2 text-sm font-medium text-[#1F2933] hover:bg-[#F5F7F8] transition-colors disabled:opacity-50"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  disabled={releaseSaving}
                  onClick={() => { releasePrompt.resolve(true); setReleasePrompt(null); }}
                  className="border border-[#C8CDD2] bg-white px-4 py-2 text-sm font-medium text-[#1F2933] hover:bg-[#F5F7F8] transition-colors disabled:opacity-50"
                >
                  Discard
                </button>
                <button
                  type="button"
                  disabled={releaseSaving}
                  onClick={async () => {
                    const saver = metadataSaverRef.current;
                    setReleaseSaving(true);
                    let ok = true;
                    if (ok && saver?.isDirty) {
                      ok = await saver.save();
                    }
                    setReleaseSaving(false);
                    releasePrompt.resolve(ok);
                    setReleasePrompt(null);
                  }}
                  className="inline-flex items-center gap-2 bg-[#287EAD] px-4 py-2 text-sm font-medium text-white hover:bg-[#206D99] transition-colors disabled:opacity-50"
                >
                  {releaseSaving && <Loader2 className="w-4 h-4 animate-spin" />}
                  Save &amp; check in
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {relationshipToRemove && (() => {
        const related = relationshipToRemove.related_document;
        const canConfirm =
          removeConfirmText.trim().toLowerCase() === "remove" && !deleteRelationshipMutation.isPending;
        return (
          <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 p-4">
            <div className="w-full max-w-md border border-[#C8CDD2] bg-white shadow-xl">
              {/* Header */}
              <div className="flex items-center gap-3 border-b border-[#C8CDD2] bg-[#287EAD] px-5 py-4">
                <div className="flex h-9 w-9 shrink-0 items-center justify-center border border-white/25 bg-white/10">
                  <Trash2 className="h-4 w-4 text-white" />
                </div>
                <div>
                  <h4 className="text-base font-semibold text-white">Remove this link?</h4>
                  <p className="text-xs text-white/75 mt-0.5">This action cannot be undone automatically.</p>
                </div>
              </div>

              <div className="p-5 space-y-4">
                <p className="text-sm text-[#5E6870]">
                  This removes the relationship between the two documents. The system may re-suggest it later if it still matches the configured rules.
                </p>

                <div className="border border-[#C8CDD2] bg-[#F5F7F8] px-4 py-3">
                  <p className="text-xs font-semibold uppercase tracking-wide text-[#287EAD]">
                    {describeRelationship(relationshipToRemove)}
                  </p>
                  <p className="mt-1 truncate text-sm font-bold text-[#1F2933]" title={related.title}>
                    {related.title}
                  </p>
                  <p className="mt-0.5 truncate font-mono text-xs text-[#5E6870]">
                    {related.reference_number}
                  </p>
                </div>

                <div>
                  <label className="text-sm text-[#5E6870]">
                    Type <span className="font-mono font-semibold text-[#1F2933]">remove</span> to confirm
                  </label>
                  <input
                    value={removeConfirmText}
                    onChange={(e) => setRemoveConfirmText(e.target.value)}
                    className="mt-2 h-9 w-full border border-[#AEB5BB] bg-white px-3 text-sm text-[#1F2933] outline-none focus:border-[#287EAD] focus:ring-1 focus:ring-[#287EAD]"
                    placeholder="remove"
                    autoFocus
                    onKeyDown={(e) => { if (e.key === "Enter" && canConfirm) deleteRelationshipMutation.mutate(relationshipToRemove.id); }}
                  />
                </div>

                <div className="flex justify-end gap-2 pt-1 border-t border-[#C8CDD2]">
                  <button
                    type="button"
                    disabled={deleteRelationshipMutation.isPending}
                    onClick={() => { setRelationshipToRemove(null); setRemoveConfirmText(""); }}
                    className="border border-[#C8CDD2] bg-white px-4 py-2 text-sm font-medium text-[#1F2933] hover:bg-[#F5F7F8] transition-colors"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    disabled={!canConfirm}
                    onClick={() => deleteRelationshipMutation.mutate(relationshipToRemove.id)}
                    className="inline-flex items-center gap-2 bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-50 transition-colors"
                  >
                    {deleteRelationshipMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
                    Remove link
                  </button>
                </div>
              </div>
            </div>
          </div>
        );
      })()}
    </div>
  );
}
