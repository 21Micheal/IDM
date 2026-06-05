import { Suspense, useState, useEffect, useRef, useCallback } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api, documentsAPI, workflowAPI } from "@/services/api";
import DocumentViewer from "@/components/documents/DocumentViewer";
import { UploadVersionDrawer } from "@/components/documents/UploadVersionDrawer";
import { WorkflowVisualizer } from "@/components/notifications/workflow-visualizer";
import StatusBadge from "@/components/documents/StatusBadge";
import OcrStatusBadge from "@/components/documents/OcrStatusBadge";
import { AddToFolderMenu } from "@/components/documents/AddToFolderMenu";
import MetadataEditPanel from "@/components/documents/MetadataEditPanel";
import TemplateForm, { requiredFieldLabels } from "@/components/templates/TemplateForm";
import WorkflowActionPanel from "@/components/workflow/WorkflowActionPanel";
import { format } from "date-fns";
import {
  ArrowLeft, Send, MessageSquare, ShieldCheck,
  Loader2, RotateCcw, Edit2, Lock, Info, Download,
  AlertTriangle, ScanLine, RefreshCw,
  Printer, Trash2, X, Check, Link2, Plus, ExternalLink, Columns2, Eye, EyeOff
} from "lucide-react";
import { toast } from "@/components/ui/vault-toast";
import { useAuthStore } from "@/store/authStore";
import type { Document, DocumentRelationType, DocumentRelationship, DocumentRelationshipSuggestion, MetadataField } from "@/types";
import { clsx as cn } from "clsx";
import { QUERY_SHORT_STALE } from "@/lib/reactQueryDefaults";
import { formatDocumentFileType } from "@/lib/documentFormat";
import { loadWorkflowData } from "@/components/notifications/workflow-data";

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

const RELATIONSHIP_OPTIONS: { value: DocumentRelationType; label: string; helper: string }[] = [
  { value: "supports", label: "Supports", helper: "This document provides evidence for the selected document." },
  { value: "references", label: "References", helper: "This document cites or depends on the selected document." },
  { value: "supersedes", label: "Supersedes", helper: "This document replaces the selected document." },
  { value: "linked-to", label: "Linked to", helper: "General business link between both records." },
];

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
};

export default function DocumentDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const user = useAuthStore((s) => s.user);

  const [activeTab, setActiveTab] = useState<TabId>("attributes");
  const [formEditing, setFormEditing] = useState(false);
  const [formValues, setFormValues] = useState<Record<string, unknown>>({});
  const [showFormPdf, setShowFormPdf] = useState(false);
  const [comment, setComment] = useState("");
  const [confirmRestoreId, setConfirmRestoreId] = useState<string | null>(null);
  const [auditPage, setAuditPage] = useState(1);
  const [viewerLinks, setViewerLinks] = useState({
    openInNewTabUrl: "",
    downloadHref: "",
    signedFileUrlsEnabled: false,
  });
  const [workflowActionCompleted, setWorkflowActionCompleted] = useState(false);
  const [relationshipSearch, setRelationshipSearch] = useState("");
  const [relationshipTargetId, setRelationshipTargetId] = useState("");
  const [relationshipType, setRelationshipType] = useState<DocumentRelationType>("references");
  const [relationshipNote, setRelationshipNote] = useState("");
  const [compareDocumentId, setCompareDocumentId] = useState<string | null>(null);
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

  const { data: relationshipSearchData, isFetching: relationshipSearchLoading } = useQuery({
    queryKey: ["documents", "relationship-search", relationshipSearch],
    queryFn: () =>
      documentsAPI.list({
        search: relationshipSearch,
        page_size: 8,
        is_self_upload: false,
      }).then((r) => r.data),
    enabled: relationshipSearch.trim().length >= 2,
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
    queryFn: () => loadWorkflowData(id!),
    enabled: !!id && !!doc && !(doc as any).is_self_upload,
    ...QUERY_SHORT_STALE,
  });
  const workflowStepsCount = workflowData?.steps?.length ?? 0;

  useEffect(() => {
    if (!activeTaskInitializedRef.current && activeTask) {
      activeTaskInitializedRef.current = true;
      setActiveTab("workflow");
    }
  }, [activeTask]);

  useEffect(() => {
    if (!activeTask && activeTab === "workflow" && workflowStepsCount === 0) {
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

  const updateFormMutation = useMutation({
    mutationFn: () => documentsAPI.updateForm(id!, formValues),
    onSuccess: () => {
      toast.success("Form updated.");
      setFormEditing(false);
      qc.invalidateQueries({ queryKey: ["document", id] });
    },
    onError: (err: any) =>
      toast.error(err?.response?.data?.detail || "Could not update the form."),
  });

  const addRelationshipMutation = useMutation({
    mutationFn: () =>
      documentsAPI.addRelationship(id!, {
        target_document_id: relationshipTargetId,
        relation_type: relationshipType,
        note: relationshipNote.trim(),
      }),
    onSuccess: () => {
      toast.success("Document relationship added.");
      setRelationshipSearch("");
      setRelationshipTargetId("");
      setRelationshipType("references");
      setRelationshipNote("");
      qc.invalidateQueries({ queryKey: ["document-relationships", id] });
      qc.invalidateQueries({ queryKey: ["document-audit", id] });
    },
    onError: (err: any) => {
      toast.error(err?.response?.data?.detail ?? "Could not link the selected document.");
    },
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
      toast.error(err?.response?.data?.detail ?? "Could not confirm the suggested link.");
    },
  });

  const deleteRelationshipMutation = useMutation({
    mutationFn: (relationshipId: string) => documentsAPI.deleteRelationship(id!, relationshipId),
    onSuccess: () => {
      toast.success("Document relationship removed.");
      qc.invalidateQueries({ queryKey: ["document-relationships", id] });
      qc.invalidateQueries({ queryKey: ["document-audit", id] });
    },
    onError: () => toast.error("Could not remove document relationship."),
  });

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
              The requested document is no longer available from this page. You can go back to where you came from, or continue to the document list.
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

  const relationshipSearchResults = ((relationshipSearchData?.results ?? []) as Document[])
    .filter((candidate) => candidate.id !== doc.id)
    .filter((candidate) => !relationships.some((relationship) => (
      relationship.related_document.id === candidate.id &&
      relationship.relation_type === relationshipType
    )));
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
  const selectedRelationshipTarget = relationshipSearchResults.find((candidate) => candidate.id === relationshipTargetId);
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

  // In-app form (built-template document): schema + values live on metadata.form.
  const formData = (doc.metadata as Record<string, any> | undefined)?.form as
    | { sections?: unknown[]; values?: Record<string, unknown> }
    | undefined;
  const isFormDocument = Boolean(formData?.sections);
  const formDocEditable = canEdit && ["draft", "returned"].includes(doc.status);
  const startFormEdit = () => {
    setFormValues({ ...(formData?.values ?? {}) });
    setFormEditing(true);
  };
  const saveForm = () => {
    const missing = requiredFieldLabels(formData?.sections ?? [], formValues);
    if (missing.length) { toast.error(`Please fill in: ${missing.join(", ")}`); return; }
    updateFormMutation.mutate();
  };
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
    (["draft", "rejected", "returned"].includes(doc.status)) &&
    (canApprove || doc.uploaded_by?.id === user?.id);

  const canArchiveNow =
    canArchive &&
    !["archived", "void"].includes(doc.status) &&
    (isPersonal || doc.status === "approved");

  const isDraftOrRejected = ["draft", "rejected", "returned"].includes(doc.status);
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
      ? [{ id: "edit" as const, label: "Edit details", disabled: !canEdit }]
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
    <div className="-m-6 min-h-[calc(100vh-3.5rem)] bg-[#EDEDED] text-[#1F2933]">
      <iframe ref={printFrameRef} title="Printable document" className="hidden" />

      {workflowActionCompleted && !activeTask && (
        <div className="mx-5 mt-4 border border-[#C8CDD2] bg-white px-4 py-4 text-sm text-[#5E6870]">
          <p className="font-semibold text-foreground">Workflow action complete</p>
          <p className="mt-1">This document has moved to the next stage and is no longer actionable from your current access level.</p>
        </div>
      )}
      <div className="flex min-h-[69px] flex-col gap-3 bg-[#287EAD] px-5 py-3 text-xs text-white xl:flex-row xl:items-center xl:justify-between">
        <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-center">
          <button
            onClick={() => navigate(-1)}
            className="flex h-9 items-center gap-1 border border-white/20 bg-[#206D99] px-3 text-xs text-white/85 transition-colors hover:text-white"
          >
            <ArrowLeft className="w-3.5 h-3.5" /> Back
          </button>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2 text-white">
              <h1 className="max-w-[28rem] truncate text-base font-semibold">{doc.title}</h1>
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
                  <Lock className="w-2.5 h-2.5" /> Checked Out By {doc.edit_locked_by_name || "User"}
                </span>
              )}
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-white/75">
              <span className="max-w-[20rem] truncate font-medium">{doc.file_name}</span>
              <span>{formatBytes(doc.file_size)}</span>
              <span>{doc.current_version ? `v${doc.current_version}` : "—"}</span>
              <span>{doc.reference_number}</span>
            </div>
          </div>
        </div>

        <div className="flex w-full flex-wrap items-center justify-start gap-1.5 font-medium text-white/80 xl:w-auto xl:justify-end">
          {canSubmit ? (
            <button
              onClick={() => submitMutation.mutate()}
              disabled={submitMutation.isPending}
              className="flex h-8 items-center gap-1 px-2 transition-colors hover:bg-white/10 hover:text-white disabled:opacity-50"
              title={doc.status === "returned" ? "Resubmit to resume approval" : "Submit for approval workflow"}
            >
              {submitMutation.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Send className="w-3.5 h-3.5" />}
              <span>{doc.status === "returned" ? "Resubmit" : "Start workflow"}</span>
            </button>
          ) : (
            <button disabled className="hidden h-8 cursor-not-allowed items-center gap-1 px-2 opacity-40 sm:flex" title="Not eligible for submission">
              <Send className="w-3.5 h-3.5" />
              <span>{doc.status === "returned" ? "Resubmit" : "Start workflow"}</span>
            </button>
          )}

          <AddToFolderMenu
            documentId={doc.id}
            showLabel
            className="text-white/80 hover:text-white"
          />

          <div className="flex items-center" title="Favourite document">
            <StarButton
              documentId={doc.id}
              showLabel
              className="border-white/20 bg-white/10 px-2.5 py-1 text-xs font-semibold text-white hover:bg-white/15"
            />
          </div>

          <div className="mx-1 hidden h-5 w-px bg-white/20 sm:block" />

          {canDownload && viewerLinks.downloadHref && viewerLinks.signedFileUrlsEnabled ? (
            <a
              href={viewerLinks.downloadHref}
              download
              className="flex h-8 items-center gap-1 px-2 transition-colors hover:bg-white/10 hover:text-white"
              title="Download current document"
            >
              <Download className="w-3.5 h-3.5" />
              <span>Download</span>
            </a>
          ) : canDownload && viewerLinks.downloadHref ? (
            <button
              type="button"
              onClick={handleDownloadDocument}
              className="flex h-8 items-center gap-1 px-2 transition-colors hover:bg-white/10 hover:text-white"
              title="Download current document"
            >
              <Download className="w-3.5 h-3.5" />
              <span>Download</span>
            </button>
          ) : (
            <button
              disabled
              className="flex h-8 cursor-not-allowed items-center gap-1 px-2 opacity-40"
              title={canDownload ? "Preview not ready yet" : "Download permission required"}
            >
              <Download className="w-3.5 h-3.5" />
              <span>Download</span>
            </button>
          )}

          <button
            onClick={handlePrintDocument}
            disabled={!canDownload || (!viewerLinks.openInNewTabUrl && !viewerLinks.downloadHref)}
            className="flex h-8 items-center gap-1 px-2 transition-colors hover:bg-white/10 hover:text-white disabled:cursor-not-allowed disabled:opacity-40"
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
              className="flex h-8 items-center gap-1 px-2 transition-colors hover:bg-white/10 hover:text-white disabled:opacity-50"
              title="Archive document"
            >
              {archiveMutation.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5" />}
              <span className="sr-only sm:not-sr-only">Delete</span>
            </button>
          )}
        </div>
      </div>

      {/* Enterprise workspace: preview left, document intelligence right */}
      <div className={cn(
        "grid grid-cols-1 items-start gap-4 p-4 pr-8 lg:grid-cols-12",
        compareDoc && "xl:grid-cols-12",
      )}>

        {/* Column 1: Document Viewer (Left) */}
        <div className={cn(
          "space-y-4",
          compareDoc ? "lg:col-span-8 xl:col-span-8" : activeTab === "workflow" ? "lg:col-span-6" : "lg:col-span-8",
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

          {/* In-app form (built-template document) — the form is the document; PDF below is its view */}
          {isFormDocument && (
            <div className="border border-[#C8CDD2] bg-white shadow-sm">
              <div className="flex items-center justify-between gap-3 border-b border-[#C8CDD2] bg-[#F5F7F8] px-4 py-2.5">
                <div className="flex items-center gap-2 min-w-0">
                  <p className="text-sm font-bold text-[#1F2933]">Form</p>
                  <span className="text-xs text-[#5E6870]">{formEditing ? "Editing — fill and save" : "Filled in-app"}</span>
                </div>
                <div className="flex items-center gap-2">
                  {!formEditing && (
                    <button
                      type="button"
                      onClick={() => setShowFormPdf((s) => !s)}
                      className="inline-flex items-center gap-1.5 border border-[#AEB5BB] bg-white px-2.5 py-1.5 text-xs font-semibold text-[#1F2933] hover:bg-[#F3F5F6]"
                    >
                      {showFormPdf ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                      {showFormPdf ? "Hide PDF" : "View PDF"}
                    </button>
                  )}
                  {!formEditing && formDocEditable && (
                    <button
                      type="button"
                      onClick={startFormEdit}
                      className="inline-flex items-center gap-1.5 border border-[#287EAD] px-2.5 py-1.5 text-xs font-semibold text-[#287EAD] hover:bg-[#EEF6FB]"
                    >
                      <Edit2 className="h-3.5 w-3.5" /> Edit form
                    </button>
                  )}
                  {formEditing && (
                    <>
                      <button
                        type="button"
                        onClick={() => setFormEditing(false)}
                        disabled={updateFormMutation.isPending}
                        className="inline-flex items-center gap-1.5 border border-[#AEB5BB] bg-white px-2.5 py-1.5 text-xs font-semibold text-[#1F2933] hover:bg-[#F3F5F6] disabled:opacity-50"
                      >
                        <X className="h-3.5 w-3.5" /> Cancel
                      </button>
                      <button
                        type="button"
                        onClick={saveForm}
                        disabled={updateFormMutation.isPending}
                        className="inline-flex items-center gap-1.5 bg-[#287EAD] px-3 py-1.5 text-xs font-semibold text-white hover:bg-[#1E6F99] disabled:opacity-50"
                      >
                        {updateFormMutation.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
                        Save form
                      </button>
                    </>
                  )}
                </div>
              </div>
              <div className="p-5">
                <TemplateForm
                  sections={formData?.sections ?? []}
                  values={formEditing ? formValues : (formData?.values ?? {})}
                  onChange={(k, v) => setFormValues((prev) => ({ ...prev, [k]: v }))}
                  readOnly={!formEditing}
                />
              </div>
            </div>
          )}

          <div className={cn(
            "grid gap-3",
            compareDoc && "xl:grid-cols-2",
            // For form documents the form is primary; the PDF is on-demand.
            isFormDocument && !showFormPdf && "hidden",
          )}>
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
                    Make procurement chains explicit: PO, invoice, GRN, contract, and supporting documents.
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
                      No related documents linked yet.
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
                                  onClick={() => deleteRelationshipMutation.mutate(relationship.id)}
                                  disabled={deleteRelationshipMutation.isPending}
                                  className="shrink-0 p-1 text-[#5E6870] hover:text-red-700 disabled:opacity-40"
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

                {canEdit && (
                  <div className="space-y-3 border border-[#C8CDD2] bg-[#F5F7F8] p-3">
                    <div className="flex items-center gap-2">
                      <Link2 className="h-4 w-4 text-[#287EAD]" />
                      <p className="text-sm font-bold text-[#1F2933]">Link another document</p>
                    </div>

                    <div>
                      <label className="text-sm font-semibold text-[#1F2933]">Relationship type</label>
                      <select
                        value={relationshipType}
                        onChange={(event) => {
                          setRelationshipType(event.target.value as DocumentRelationType);
                          setRelationshipTargetId("");
                        }}
                        className="mt-2 h-9 w-full border border-[#AEB5BB] bg-white px-2 text-sm text-[#1F2933] focus:outline-none focus:ring-1 focus:ring-[#287EAD]"
                      >
                        {RELATIONSHIP_OPTIONS.map((option) => (
                          <option key={option.value} value={option.value}>{option.label}</option>
                        ))}
                      </select>
                      <p className="mt-1 text-xs text-[#5E6870]">
                        {RELATIONSHIP_OPTIONS.find((option) => option.value === relationshipType)?.helper}
                      </p>
                    </div>

                    <div>
                      <label className="text-sm font-semibold text-[#1F2933]">Find document</label>
                      <input
                        value={relationshipSearch}
                        onChange={(event) => {
                          setRelationshipSearch(event.target.value);
                          setRelationshipTargetId("");
                        }}
                        placeholder="Search title, reference, supplier, or text"
                        className="mt-2 h-9 w-full border border-[#AEB5BB] bg-white px-3 text-sm text-[#1F2933] focus:outline-none focus:ring-1 focus:ring-[#287EAD]"
                      />
                    </div>

                    {relationshipSearch.trim().length >= 2 && (
                      <div className="max-h-52 overflow-y-auto border border-[#C8CDD2] bg-white">
                        {relationshipSearchLoading ? (
                          <div className="flex items-center gap-2 px-3 py-4 text-sm text-[#5E6870]">
                            <Loader2 className="h-4 w-4 animate-spin" />
                            Searching documents…
                          </div>
                        ) : relationshipSearchResults.length === 0 ? (
                          <div className="px-3 py-4 text-center text-sm text-[#5E6870]">No eligible documents found.</div>
                        ) : relationshipSearchResults.map((candidate) => (
                          <label
                            key={candidate.id}
                            className={cn(
                              "grid cursor-pointer grid-cols-[auto_1fr] gap-3 border-b border-[#D3D7DA] px-3 py-2 last:border-b-0 hover:bg-[#F5F7F8]",
                              relationshipTargetId === candidate.id && "bg-[#EEF6FB]",
                            )}
                          >
                            <input
                              type="radio"
                              name="relationship-target"
                              checked={relationshipTargetId === candidate.id}
                              onChange={() => setRelationshipTargetId(candidate.id)}
                              className="mt-1"
                            />
                            <span className="min-w-0">
                              <span className="block truncate text-sm font-semibold text-[#1F2933]">{candidate.title}</span>
                              <span className="block truncate text-xs text-[#5E6870]">
                                {candidate.reference_number} · {candidate.document_type_name || candidate.document_type?.name || "Document"}
                              </span>
                            </span>
                          </label>
                        ))}
                      </div>
                    )}

                    <div>
                      <label className="text-sm font-semibold text-[#1F2933]">Note</label>
                      <textarea
                        value={relationshipNote}
                        onChange={(event) => setRelationshipNote(event.target.value)}
                        rows={2}
                        placeholder="Optional context for this link"
                        className="mt-2 block w-full border border-[#AEB5BB] bg-white px-3 py-2 text-sm text-[#1F2933] focus:outline-none focus:ring-1 focus:ring-[#287EAD]"
                      />
                    </div>

                    <div className="flex items-center justify-between gap-3">
                      <span className="min-w-0 truncate text-xs text-[#5E6870]">
                        {selectedRelationshipTarget ? selectedRelationshipTarget.reference_number : "Select a document to link"}
                      </span>
                      <button
                        type="button"
                        onClick={() => addRelationshipMutation.mutate()}
                        disabled={!relationshipTargetId || addRelationshipMutation.isPending}
                        className="inline-flex items-center gap-2 bg-[#287EAD] px-3 py-2 text-sm font-semibold text-white hover:bg-[#206D99] disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        {addRelationshipMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
                        Add link
                      </button>
                    </div>
                  </div>
                )}
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
                                    className="inline-flex items-center gap-1 border border-[#C8CDD2] bg-white px-2.5 py-1.5 text-xs font-semibold text-[#1F2933] hover:bg-[#F5F7F8]"
                                    title="Restore to this version"
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
                              {log.summary && (
                                <p className="mt-2 whitespace-pre-wrap border-l-2 border-[#287EAD] bg-[#F5F7F8] px-2 py-1.5 text-sm leading-relaxed text-[#5E6870]">
                                  {log.summary}
                                </p>
                              )}
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
                  <button
                    onClick={() => setActiveTab("properties")}
                    className="text-sm font-semibold text-muted-foreground transition-colors hover:text-foreground hover:underline"
                  >
                    Cancel
                  </button>
                </div>
                <Suspense fallback={<div className="p-4 text-sm text-muted-foreground">Loading editor…</div>}>
                  <MetadataEditPanel document={doc} onClose={() => setActiveTab("properties")} />
                </Suspense>
              </div>
            )}

          </div>
        </div>

      </div>
    </div>
  );
}
