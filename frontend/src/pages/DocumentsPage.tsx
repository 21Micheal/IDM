import { useEffect, useMemo, useState, useRef } from "react";
import { extractApiError } from "@/lib/apiError";
import statusUtils from "@/lib/status";
import { Link, useSearchParams } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { documentsAPI, documentTypesAPI, normalizeListResponse, usersAPI } from "@/services/api";
import {
  FileText, UploadCloud, Lock, LayoutList,
  Archive, Trash2, Loader2, CheckSquare, Square, X, CheckCircle, XCircle,
  Search as SearchIcon, SlidersHorizontal, Eye,
  Rows3, LayoutGrid, Plus, ChevronDown,
  List, Mail, Send, Share2, Download, ArrowUp, ArrowDown,
} from "lucide-react";
import { format } from "date-fns";
import { cn } from "../lib/utils";
import { useDebounce } from "../hooks/useDebounce";
import { vaultToast as toast } from "@/components/ui/vault-toast";
import type { Document } from "@/types";
import StatusBadge from "@/components/documents/StatusBadge";
import { QUERY_FIVE_MIN_STALE, QUERY_SHORT_STALE } from "@/lib/reactQueryDefaults";
import { formatDocumentFileType } from "@/lib/documentFormat";
import { preloadDocumentWorkspace } from "@/lib/routePreload";

const PAGE_SIZE = 10;
type BulkAction = "approve" | "reject" | "archive" | "void" | "trash";

const STATUS_OPTIONS = ["draft", "pending_approval", "approved", "rejected", "archived", "void"];

type EmailAttachmentMode = "separate" | "combined";
type ShareAccessLevel = "view" | "download";

type EmailRecipientUser = {
  id: string;
  email: string;
  first_name?: string;
  last_name?: string;
  full_name?: string;
  job_description?: string;
  department_name?: string | null;
};

// ── Bulk Toolbar ────────────────────────────────────────────────────────────
function BulkToolbar({
  selectedIds, availableActions, onAction, onClear, isLoading,
}: {
  selectedIds: string[];
  availableActions: BulkAction[];
  onAction: (action: BulkAction, comment?: string) => void;
  onClear: () => void;
  isLoading: boolean;
}) {
  const [rejectModal, setRejectModal] = useState(false);
  const [comment, setComment] = useState("");

  if (selectedIds.length === 0) return null;

  return (
    <>
      <div
        className="sticky top-0 z-10 rounded-xl border border-accent/30 bg-card px-5 py-3 flex items-center gap-3 flex-wrap"
        style={{ boxShadow: "var(--shadow-elegant)" }}
      >
        <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-accent/15 text-accent text-sm font-semibold">
          <span className="w-1.5 h-1.5 rounded-full bg-accent" />
          {selectedIds.length} selected
        </div>

        <div className="flex flex-wrap gap-2">
          {availableActions.includes("approve") && (
            <button
              onClick={() => onAction("approve")}
              disabled={isLoading}
              className="inline-flex items-center gap-2 px-4 py-1.5 text-sm font-medium bg-teal text-teal-foreground rounded-lg hover:opacity-90 disabled:opacity-50 transition-opacity"
            >
              {isLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle className="w-4 h-4" />}
              Approve
            </button>
          )}

          {availableActions.includes("reject") && (
            <button
              onClick={() => setRejectModal(true)}
              disabled={isLoading}
              className="inline-flex items-center gap-2 px-4 py-1.5 text-sm font-medium bg-destructive text-destructive-foreground rounded-lg hover:opacity-90 disabled:opacity-50 transition-opacity"
            >
              <XCircle className="w-4 h-4" /> Reject
            </button>
          )}

          {availableActions.includes("archive") && (
            <button
              onClick={() => onAction("archive")}
              disabled={isLoading}
              className="inline-flex items-center gap-2 px-4 py-1.5 text-sm font-medium bg-primary text-primary-foreground rounded-lg hover:opacity-90 disabled:opacity-50 transition-opacity"
            >
              <Archive className="w-4 h-4" /> Archive
            </button>
          )}

          {availableActions.includes("trash") && (
            <button
              onClick={() => {
                if (confirm(`Move ${selectedIds.length} document${selectedIds.length === 1 ? "" : "s"} to Trash? You can restore them later.`)) {
                  onAction("trash");
                }
              }}
              disabled={isLoading}
              className="inline-flex items-center gap-2 px-4 py-1.5 text-sm font-medium bg-destructive text-destructive-foreground rounded-lg hover:opacity-90 disabled:opacity-50 transition-opacity"
            >
              <Trash2 className="w-4 h-4" /> Delete
            </button>
          )}

          {availableActions.includes("void") && (
            <button
              onClick={() => {
                if (confirm(`Void ${selectedIds.length} documents? This cannot be undone.`)) {
                  onAction("void");
                }
              }}
              disabled={isLoading}
              className="inline-flex items-center gap-2 px-4 py-1.5 text-sm font-medium bg-foreground text-background rounded-lg hover:opacity-90 disabled:opacity-50 transition-opacity"
            >
              <Trash2 className="w-4 h-4" /> Void
            </button>
          )}
        </div>

        <button
          onClick={onClear}
          className="ml-auto text-muted-foreground hover:text-foreground p-2 rounded-lg hover:bg-muted transition-colors"
        >
          <X className="w-5 h-5" />
        </button>
      </div>

      {/* Reject Modal */}
      {rejectModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-foreground/40 backdrop-blur-sm p-4">
          <div
            className="w-full max-w-md p-6 space-y-5 bg-card rounded-2xl border border-border"
            style={{ boxShadow: "var(--shadow-elegant)" }}
          >
            <div>
              <h2 className="font-semibold text-lg text-foreground">Reject Selected Documents</h2>
              <p className="text-sm text-muted-foreground mt-1">
                Provide a reason. This will be visible to all involved parties.
              </p>
            </div>
            <textarea
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              rows={4}
              className="input"
              placeholder="Reason for rejection..."
              autoFocus
            />
            <div className="flex gap-3 justify-end">
              <button onClick={() => setRejectModal(false)} className="btn-secondary">Cancel</button>
              <button
                onClick={() => {
                  if (!comment.trim()) {
                    toast.error("Rejection reason is required");
                    return;
                  }
                  onAction("reject", comment.trim());
                  setRejectModal(false);
                  setComment("");
                }}
                disabled={isLoading}
                className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium bg-destructive text-destructive-foreground rounded-lg hover:opacity-90 disabled:opacity-50 transition-opacity"
              >
                Reject Documents
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function PersonalTagChips({
  tags,
  onTagClick,
}: {
  tags: string[];
  onTagClick?: (tag: string) => void;
}) {
  if (tags.length === 0) return null;

  return (
    <div className="flex flex-wrap gap-1.5">
      {tags.map((tag) => {
        const chipClassName = cn(
          "inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-semibold transition-colors",
          onTagClick
            ? "border-accent/20 bg-accent/10 text-accent hover:border-accent/30 hover:bg-accent/15 cursor-pointer"
            : "border-accent/20 bg-accent/10 text-accent",
        );

        if (onTagClick) {
          return (
            <button
              key={tag}
              type="button"
              onClick={() => onTagClick(tag)}
              className={chipClassName}
            >
              {tag}
            </button>
          );
        }

        return (
          <span key={tag} className={chipClassName}>
            {tag}
          </span>
        );
      })}
    </div>
  );
}

function getPersonalDescription(doc: Document): string {
  const directDesc = doc.description;
  if (typeof directDesc === "string" && directDesc.trim()) return directDesc.trim();

  const metaDesc = doc.metadata?.description;
  if (typeof metaDesc === "string" && metaDesc.trim()) return metaDesc.trim();

  return "";
}

function getUserDisplayName(user: EmailRecipientUser): string {
  const fullName = user.full_name || [user.first_name, user.last_name].filter(Boolean).join(" ").trim();
  return fullName || user.email;
}

function getDocumentTypeLabel(doc: Document): string {
  return doc.document_type_name || doc.document_type?.name || "";
}

function getDocumentStatusLabel(status: string): string {
  return status
    ? status.replace(/_/g, " ").replace(/\b\w/g, (char) => char.toUpperCase())
    : "Unknown";
}

function getDocumentStatusTextClass(status: string): string {
  const key = status?.toLowerCase?.().replace(/\s+/g, "_") ?? "";
  if (["approved", "active", "enabled", "completed"].includes(key)) return "text-emerald-700";
  if (["pending_review", "pending_approval", "on_hold", "returned"].includes(key)) return "text-amber-700";
  if (["rejected", "void"].includes(key)) return "text-red-700";
  if (key === "archived") return "text-sky-700";
  return "text-[#5E6870]";
}

function formatInforDateTime(value?: string | null): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return format(date, "MM/dd/yyyy, HH:mm:ss");
}

function DocumentPreviewTile({ doc, large = false }: { doc: Document; large?: boolean }) {
  const typeLabel = getDocumentTypeLabel(doc).toLowerCase();
  const isInvoice = typeLabel.includes("invoice") || doc.title.toLowerCase().includes("inv");
  const isPurchaseOrder = typeLabel.includes("purchase") || doc.title.toLowerCase().includes("po-");

  if (isInvoice || isPurchaseOrder) {
    return (
      <div className={cn("bg-white p-2 text-[#1F2933]", large ? "h-full w-full" : "h-full w-full")}>
        <div className="mb-2 flex items-start justify-between gap-2">
          <div>
            <div className="h-1.5 w-12 bg-[#303846]" />
            <div className="mt-1 h-1 w-8 bg-[#C7CCD1]" />
          </div>
          <div className="text-right text-[7px] font-bold uppercase text-[#303846]">
            {isInvoice ? "Invoice" : "PO"}
          </div>
        </div>
        <div className="mb-2 grid grid-cols-2 gap-1">
          <div className="h-5 bg-[#F2F4F5]" />
          <div className="h-5 bg-[#F2F4F5]" />
        </div>
        <div className="space-y-1">
          <div className="h-1.5 w-full bg-[#303846]" />
          <div className="h-1.5 w-11/12 bg-[#E3E7EA]" />
          <div className="h-1.5 w-10/12 bg-[#E3E7EA]" />
          <div className="h-1.5 w-full bg-[#E3E7EA]" />
          <div className="h-1.5 w-9/12 bg-[#E3E7EA]" />
        </div>
        <div className="mt-3 ml-auto h-1.5 w-12 bg-[#C7CCD1]" />
        <div className="mt-1 ml-auto h-1.5 w-16 bg-[#C7CCD1]" />
      </div>
    );
  }

  return (
    <div className="h-full w-full bg-white px-3 py-4 text-[6px] leading-none text-[#445E9D]">
      <div className="space-y-1">
        {Array.from({ length: large ? 18 : 14 }).map((_, index) => (
          <div
            key={index}
            className={cn(
              "h-px bg-current",
              index % 5 === 0 ? "w-5/12" : index % 3 === 0 ? "w-8/12" : "w-3/12",
              index > 7 && "ml-8",
            )}
          />
        ))}
      </div>
    </div>
  );
}

interface DocumentsPageProps {
  personalOnly?: boolean;
}

/** Reorderable list of documents to be stitched into one PDF (top = first).
 *  Shared by the "share in email" combined mode and the merge-download modal. */
function StitchOrderList({
  order,
  docs,
  onMove,
}: {
  order: string[];
  docs: Document[];
  onMove: (index: number, dir: -1 | 1) => void;
}) {
  return (
    <div className="border border-[#C8CDD2] bg-[#F9FAFB] p-2">
      <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-[#5E6870]">
        Merge order — top appears first
      </p>
      <ul className="space-y-1">
        {order.map((docId, idx) => {
          const d = docs.find((x) => x.id === docId);
          return (
            <li key={docId} className="flex items-center gap-2 border border-[#E3E7EA] bg-white px-2 py-1.5 text-sm">
              <span className="w-5 flex-shrink-0 text-center text-xs font-semibold text-[#5E6870]">{idx + 1}</span>
              <span className="flex-1 truncate text-[#1F2933]" title={d?.title}>{d?.title ?? docId}</span>
              <button type="button" onClick={() => onMove(idx, -1)} disabled={idx === 0}
                      className="p-1 text-[#5E6870] hover:text-[#287EAD] disabled:opacity-30" title="Move up">
                <ArrowUp className="h-3.5 w-3.5" />
              </button>
              <button type="button" onClick={() => onMove(idx, 1)} disabled={idx === order.length - 1}
                      className="p-1 text-[#5E6870] hover:text-[#287EAD] disabled:opacity-30" title="Move down">
                <ArrowDown className="h-3.5 w-3.5" />
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export default function DocumentsPage({ personalOnly = false }: DocumentsPageProps) {
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const statusFromUrl = searchParams.get("status");
  const normalizedStatusFromUrl = STATUS_OPTIONS.includes(statusFromUrl ?? "") ? (statusFromUrl ?? "") : "";
  const isArchiveView = normalizedStatusFromUrl === "archived";

  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState(normalizedStatusFromUrl);
  const [typeFilter, setTypeFilter] = useState("");
  const [supplierFilter, setSupplierFilter] = useState("");
  const [personalTagFilter, setPersonalTagFilter] = useState("");
  const [sort, setSort] = useState<"created_at" | "document_date" | "amount" | "title" | "reference_number">("created_at");
  const [sortDir, _setSortDir] = useState<"asc" | "desc">("desc");
  void _setSortDir;
  const [page, setPage] = useState(1);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [showFilters, setShowFilters] = useState(false);
  const [emailModalOpen, setEmailModalOpen] = useState(false);
  const [emailRecipientIds, setEmailRecipientIds] = useState<string[]>([]);
  const [emailRecipientSearch, setEmailRecipientSearch] = useState("");
  const [emailExtraRecipients, setEmailExtraRecipients] = useState("");
  const [emailAttachmentMode, setEmailAttachmentMode] = useState<EmailAttachmentMode>("separate");
  // Order in which documents are stitched into the merged PDF ("combined" mode).
  const [emailDocOrder, setEmailDocOrder] = useState<string[]>([]);
  const [emailMessage, setEmailMessage] = useState("");
  const [shareModalOpen, setShareModalOpen] = useState(false);
  const [shareRecipientIds, setShareRecipientIds] = useState<string[]>([]);
  const [shareRecipientSearch, setShareRecipientSearch] = useState("");
  const [shareAccessLevel, setShareAccessLevel] = useState<ShareAccessLevel>("view");
  const [shareExpiresAt, setShareExpiresAt] = useState("");
  const [shareNotifyByEmail, setShareNotifyByEmail] = useState(false);
  const [shareMessage, setShareMessage] = useState("");
  const [showBulkDownloadTray, setShowBulkDownloadTray] = useState(false);
  const bulkDownloadTrayRef = useRef<HTMLDivElement | null>(null);
  // Merge-download modal: reorder the documents before stitching into one PDF.
  const [mergeModalOpen, setMergeModalOpen] = useState(false);
  const [mergeDocOrder, setMergeDocOrder] = useState<string[]>([]);

  // ── View mode (table / card / thumbnails) — Infor-style layout switcher ────
  type ViewMode = "table" | "card" | "thumbnails";
  const viewStorageKey = personalOnly ? "documents:viewMode:personal" : "documents:viewMode:all";
  const [viewMode, setViewMode] = useState<ViewMode>(() => {
    if (typeof window === "undefined") return "table";
    const stored = window.localStorage.getItem(viewStorageKey);
    return stored === "card" || stored === "thumbnails" || stored === "table" ? stored : "table";
  });
  useEffect(() => {
    if (typeof window !== "undefined") {
      window.localStorage.setItem(viewStorageKey, viewMode);
    }
  }, [viewMode, viewStorageKey]);
  // Archived view always uses the table layout — switcher is hidden.
  const effectiveView: ViewMode = isArchiveView ? "table" : viewMode;
  const showLayoutSwitcher = !isArchiveView;

  const debouncedSearch = useDebounce(search, 300);

  useEffect(() => {
    setStatusFilter(normalizedStatusFromUrl);
    if (normalizedStatusFromUrl === "archived" || personalOnly) {
      setSearch("");
      setTypeFilter("");
      setSupplierFilter("");
      setPersonalTagFilter("");
    }
    setPage(1);
    setSelectedIds([]);
  }, [normalizedStatusFromUrl, personalOnly]);

  const clearUrlStatusFilter = () => {
    if (!searchParams.has("status")) return;
    const nextParams = new URLSearchParams(searchParams);
    nextParams.delete("status");
    setSearchParams(nextParams, { replace: true });
  };

  const { data: typesData } = useQuery<unknown, Error, unknown[]>({
    queryKey: ["document-types"],
    queryFn: () => documentTypesAPI.list().then((r) => r.data as unknown),
    select: (data) => normalizeListResponse(data),
    enabled: !isArchiveView && !personalOnly,
    ...QUERY_FIVE_MIN_STALE,
  });

  const { data: usersData } = useQuery<unknown, Error, EmailRecipientUser[]>({
    queryKey: ["users", "document-action-recipients"],
    queryFn: () => usersAPI.list({ page_size: 500 }).then((r) => r.data as unknown),
    select: (response) => normalizeListResponse(response) as EmailRecipientUser[],
    enabled: emailModalOpen || shareModalOpen,
    ...QUERY_FIVE_MIN_STALE,
  });

  const params: Record<string, unknown> = {
    search: isArchiveView ? undefined : debouncedSearch || undefined,
    status: isArchiveView ? "archived" : personalOnly ? undefined : statusFilter || undefined,
    document_type: isArchiveView || personalOnly ? undefined : typeFilter || undefined,
    supplier: isArchiveView || personalOnly ? undefined : supplierFilter || undefined,
    ordering: `${sortDir === "desc" ? "-" : ""}${sort}`,
    page,
    page_size: PAGE_SIZE,
  };

  if (!isArchiveView) params.is_self_upload = personalOnly;
  if (!isArchiveView && personalOnly && personalTagFilter) params.personal_tag = personalTagFilter;

  const { data, isLoading } = useQuery({
    queryKey: ["documents", "list", params],
    queryFn: () => documentsAPI.list(params),
    select: (r) => r.data,
    ...QUERY_SHORT_STALE,
    staleTime: personalOnly ? 0 : QUERY_SHORT_STALE.staleTime,
    refetchOnMount: personalOnly ? "always" : true,
  });

  const rawDocs = data?.results ?? [];

  function docMatchesFilters(doc: Document) {
    if (statusFilter && !statusUtils.statusMatchesFilter(doc.status, statusFilter)) return false;

    if (typeFilter) {
      const docTypeId = typeof (doc as any).document_type === "string"
        ? (doc as any).document_type
        : (doc as any).document_type?.id ?? String((doc as any).document_type ?? "");
      if (docTypeId !== typeFilter) return false;
    }

    if (supplierFilter) {
      const supplier = (doc.supplier || "").toLowerCase();
      if (!supplier.includes(supplierFilter.toLowerCase())) return false;
    }

    if (personalTagFilter) {
      const tags: string[] = (doc.personal_tags ?? []).map(String);
      if (!tags.includes(personalTagFilter)) return false;
    }

    return true;
  }

  const filteredResults = useMemo(() => rawDocs.filter(docMatchesFilters), [rawDocs, statusFilter, typeFilter, supplierFilter, personalTagFilter]);

  const docs = filteredResults;
  const supplierOptions = useMemo<string[]>(() => {
    const currentPageSuppliers = docs
      .map((doc: Document) => doc.supplier as string | null | undefined)
      .filter((value: string | null | undefined): value is string => typeof value === "string" && value.length > 0);
    return Array.from(new Set(currentPageSuppliers));
  }, [docs]);

  // Prefetch adjacent pages
  useEffect(() => {
    const totalCount = data?.count ?? 0;
    if (!totalCount) return;
    const totalPages = Math.ceil(totalCount / PAGE_SIZE);
    const baseParams: Record<string, unknown> = {
      search: isArchiveView ? undefined : debouncedSearch || undefined,
      status: isArchiveView ? "archived" : personalOnly ? undefined : statusFilter || undefined,
      document_type: isArchiveView || personalOnly ? undefined : typeFilter || undefined,
      supplier: isArchiveView || personalOnly ? undefined : supplierFilter || undefined,
      ordering: `${sortDir === "desc" ? "-" : ""}${sort}`,
      page_size: PAGE_SIZE,
    };
    if (!isArchiveView) baseParams.is_self_upload = personalOnly;
    if (!isArchiveView && personalOnly && personalTagFilter) baseParams.personal_tag = personalTagFilter;

    if (page < totalPages) {
      queryClient.prefetchQuery({
        queryKey: ["documents", "list", { ...baseParams, page: page + 1 }],
        queryFn: () => documentsAPI.list({ ...baseParams, page: page + 1 }),
        staleTime: 30_000,
      });
    }
    if (page > 1) {
      queryClient.prefetchQuery({
        queryKey: ["documents", "list", { ...baseParams, page: page - 1 }],
        queryFn: () => documentsAPI.list({ ...baseParams, page: page - 1 }),
        staleTime: 30_000,
      });
    }
  }, [data?.count, queryClient, debouncedSearch, statusFilter, typeFilter, supplierFilter, sort, sortDir, page, personalTagFilter, isArchiveView, personalOnly]);

  const archiveMutation = useMutation({
    mutationFn: (id: string) => documentsAPI.archive(id),
    onSuccess: () => {
      toast.success("Document archived.");
      queryClient.invalidateQueries({ queryKey: ["documents"] });
    },
    onError: (err) => toast.error(extractApiError(err, "Could not archive document.")),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => documentsAPI.delete(id),
    onSuccess: () => {
      toast.success(personalOnly ? "Document deleted." : "Moved to Trash.");
      queryClient.invalidateQueries({ queryKey: ["documents"] });
    },
    onError: (err: any) =>
      toast.error(extractApiError(err, "Could not delete document.")),
  });

  const TRASHABLE_STATUSES = ["draft", "returned", "rejected"];

  const bulkMutation = useMutation({
    mutationFn: ({ action, comment }: { action: BulkAction; comment?: string }) =>
      documentsAPI.bulkAction(selectedIds, action, comment),
    onSuccess: (_data, variables) => {
      toast.success(variables.action === "trash" ? "Moved to Trash." : "Bulk action completed successfully");
      setSelectedIds([]);
      queryClient.invalidateQueries({ queryKey: ["documents"] });
    },
    onError: (err) => toast.error(extractApiError(err, "Bulk action failed")),
  });

  const emailSelectedMutation = useMutation({
    mutationFn: () => {
      const recipientEmails = emailExtraRecipients
        .split(/[,\n;]/)
        .map((email) => email.trim())
        .filter(Boolean);

      return documentsAPI.emailSelected({
        // Stitching honours the chosen order; separate attachments use selection order.
        document_ids: emailAttachmentMode === "combined" && emailDocOrder.length ? emailDocOrder : selectedIds,
        recipient_user_ids: emailRecipientIds,
        recipient_emails: recipientEmails,
        attachment_mode: emailAttachmentMode,
        message: emailMessage.trim(),
      });
    },
    onSuccess: (response) => {
      const attached = response.data?.attached ?? selectedIds.length;
      toast.success(`${attached} document${attached === 1 ? "" : "s"} sent by email.`);
      setEmailModalOpen(false);
      setEmailRecipientIds([]);
      setEmailRecipientSearch("");
      setEmailExtraRecipients("");
      setEmailAttachmentMode("separate");
      setEmailMessage("");
      setSelectedIds([]);
    },
    onError: (err: any) => {
      toast.error(extractApiError(err, "Could not send selected documents."));
    },
  });

  const downloadSelectedMutation = useMutation({
    mutationFn: () => documentsAPI.downloadSelected(selectedIds),
    onSuccess: (response) => {
      const blob = new Blob([response.data], { type: "application/zip" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "documents.zip";
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      toast.success(`Downloaded ${selectedIds.length} document${selectedIds.length === 1 ? "" : "s"} as ZIP.`);
    },
    onError: (err) => toast.error(extractApiError(err, "Could not download the selected documents.")),
  });

  const downloadSelectedAsPdfMutation = useMutation({
    mutationFn: () => documentsAPI.downloadSelectedAsPdf(selectedIds),
    onSuccess: (response) => {
      const blob = new Blob([response.data], { type: "application/zip" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "documents-pdf.zip";
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      toast.success(`Downloaded ${selectedIds.length} document${selectedIds.length === 1 ? "" : "s"} as PDF ZIP.`);
    },
    onError: (err) => toast.error(extractApiError(err, "Could not download the selected documents as PDF.")),
  });

  const downloadSelectedMergedPdfMutation = useMutation({
    mutationFn: (orderedIds: string[]) => documentsAPI.downloadSelectedMergedPdf(orderedIds),
    onSuccess: (response, orderedIds) => {
      const blob = new Blob([response.data], { type: "application/pdf" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "documents-merged.pdf";
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      setMergeModalOpen(false);
      toast.success(`Downloaded ${orderedIds.length} document${orderedIds.length === 1 ? "" : "s"} as merged PDF.`);
    },
    onError: (err) => toast.error(extractApiError(err, "Could not create merged PDF. Ensure selected documents have PDF previews.")),
  });

  const moveMergeDoc = (index: number, dir: -1 | 1) => {
    setMergeDocOrder((prev) => {
      const next = [...prev];
      const target = index + dir;
      if (target < 0 || target >= next.length) return prev;
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  };

  // Close bulk-download tray on outside click
  useEffect(() => {
    if (!showBulkDownloadTray) return;
    const handler = (e: MouseEvent) => {
      if (bulkDownloadTrayRef.current && !bulkDownloadTrayRef.current.contains(e.target as Node)) {
        setShowBulkDownloadTray(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [showBulkDownloadTray]);

  // Keep the stitch order aligned with the current selection while the email modal is open.
  useEffect(() => {
    if (!emailModalOpen) return;
    setEmailDocOrder((prev) => {
      const kept = prev.filter((docId) => selectedIds.includes(docId));
      const added = selectedIds.filter((docId) => !kept.includes(docId));
      return [...kept, ...added];
    });
  }, [emailModalOpen, selectedIds]);

  // Same for the merge-download modal.
  useEffect(() => {
    if (!mergeModalOpen) return;
    setMergeDocOrder((prev) => {
      const kept = prev.filter((docId) => selectedIds.includes(docId));
      const added = selectedIds.filter((docId) => !kept.includes(docId));
      return [...kept, ...added];
    });
  }, [mergeModalOpen, selectedIds]);

  const moveStitchDoc = (index: number, dir: -1 | 1) => {
    setEmailDocOrder((prev) => {
      const next = [...prev];
      const target = index + dir;
      if (target < 0 || target >= next.length) return prev;
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  };

  const shareSelectedMutation = useMutation({
    mutationFn: () =>
      documentsAPI.shareSelected({
        document_ids: selectedIds,
        recipient_user_ids: shareRecipientIds,
        access_level: shareAccessLevel,
        expires_at: shareExpiresAt ? new Date(shareExpiresAt).toISOString() : null,
        notify_by_email: shareNotifyByEmail,
        message: shareMessage.trim(),
      }),
    onSuccess: (response) => {
      const sharedCount = response.data?.shared ?? selectedIds.length * shareRecipientIds.length;
      toast.success(`${sharedCount} document share${sharedCount === 1 ? "" : "s"} created.`);
      setShareModalOpen(false);
      setShareRecipientIds([]);
      setShareRecipientSearch("");
      setShareAccessLevel("view");
      setShareExpiresAt("");
      setShareNotifyByEmail(false);
      setShareMessage("");
      setSelectedIds([]);
      queryClient.invalidateQueries({ queryKey: ["documents"] });
    },
    onError: (err: any) => {
      toast.error(extractApiError(err, "Could not share selected documents."));
    },
  });


  const toggleAll = () => {
    const pageIds = docs.map((d: Document) => d.id);
    setSelectedIds((prev) => (prev.length === pageIds.length ? [] : pageIds));
  };

  const toggleOne = (id: string) => {
    setSelectedIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
    );
  };

  const handlePersonalTagClick = (tag: string) => {
    clearUrlStatusFilter();
    setSearch("");
    setStatusFilter("");
    setTypeFilter("");
    setSupplierFilter("");
    setPersonalTagFilter((prev) => (prev === tag ? "" : tag));
    setPage(1);
    setSelectedIds([]);
  };

  const allChecked = docs.length > 0 && docs.every((d: Document) => selectedIds.includes(d.id));
  const personalTagOptions = Array.from(new Set(
    [...docs.flatMap((doc: Document) => doc.personal_tags ?? []), personalTagFilter].filter(Boolean)
  )).sort((a, b) => a.localeCompare(b));

  const selectionEnabled = !isArchiveView && !personalOnly;
  const showBulkToolbar = selectionEnabled && selectedIds.length > 0;

  const availableBulkActions: BulkAction[] = showBulkToolbar
    ? docs
        .filter((doc: Document) => selectedIds.includes(doc.id))
        .reduce((commonActions: BulkAction[], doc: Document) => {
          const docActions = doc.available_bulk_actions || [];
          return commonActions.filter(action => docActions.includes(action));
        }, ["approve", "reject", "archive", "void", "trash"] as BulkAction[])
    : [];

  const totalCols = personalOnly
    ? 7 // Reference, name, description, tags, uploaded, uploaded by, actions
    : 5 + (selectionEnabled ? 1 : 0) + (!isArchiveView ? 1 : 0);

  const activeFilterCount = personalOnly
    ? 0
    : [statusFilter, typeFilter, supplierFilter].filter(Boolean).length;

  const filteredEmailUsers = (usersData ?? []).filter((user) => {
    const query = emailRecipientSearch.trim().toLowerCase();
    if (!query) return true;
    return [
      getUserDisplayName(user),
      user.email,
      user.job_description,
      user.department_name ?? "",
    ].some((value) => value?.toLowerCase().includes(query));
  });

  const extraRecipientCount = emailExtraRecipients
    .split(/[,\n;]/)
    .map((email) => email.trim())
    .filter(Boolean).length;
  const emailRecipientCount = emailRecipientIds.length + extraRecipientCount;

  const filteredShareUsers = (usersData ?? []).filter((user) => {
    const query = shareRecipientSearch.trim().toLowerCase();
    if (!query) return true;
    return [
      getUserDisplayName(user),
      user.email,
      user.job_description,
      user.department_name ?? "",
    ].some((value) => value?.toLowerCase().includes(query));
  });

  if (!isArchiveView && !personalOnly) {
    // Show the client-side filtered total so UI reflects exact active filters
    const matchingCount = docs.length;

    return (
      <div className="-m-6 flex h-[calc(100vh-3.5rem)] min-h-[42rem] overflow-hidden bg-[#EDEDED] text-[13px] text-[#1F2933]">
        <div className="flex w-[70px] shrink-0 flex-col border-r border-[#C8CDD2] bg-[#F3F3F3]">
          <div className="h-[69px] border-b border-[#C8CDD2] bg-[#2C7FAE]" />
          <div className="flex-1" />
        </div>

        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex h-[69px] shrink-0 items-center gap-3 bg-[#287EAD] px-5 text-white">
            <div className="relative min-w-[220px] max-w-[340px] flex-1">
              <SearchIcon className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[#5E6870]" />
              <input
                value={search}
                onChange={(event) => {
                  setSearch(event.target.value);
                  setPage(1);
                }}
                placeholder="Search documents"
                className="h-9 w-full border border-[#AEB5BB] bg-white pl-9 pr-3 text-sm text-[#1F2933] placeholder:text-[#6E767D] focus:outline-none focus:ring-1 focus:ring-white/70"
              />
            </div>

            <select
              value={statusFilter}
              onChange={(event) => {
                clearUrlStatusFilter();
                setStatusFilter(event.target.value);
                setPage(1);
              }}
              className="h-9 w-[150px] border border-[#AEB5BB] bg-white px-2 text-sm text-[#1F2933] focus:outline-none focus:ring-1 focus:ring-white/70"
            >
              <option value="">All statuses</option>
              {STATUS_OPTIONS.map((status) => (
                <option key={status} value={status}>{status.replace(/_/g, " ")}</option>
              ))}
            </select>

            <select
              value={typeFilter}
              onChange={(event) => {
                setTypeFilter(event.target.value);
                setPage(1);
              }}
              className="h-9 w-[160px] border border-[#AEB5BB] bg-white px-2 text-sm text-[#1F2933] focus:outline-none focus:ring-1 focus:ring-white/70"
            >
              <option value="">All types</option>
              {(typesData ?? []).map((type: any) => (
                <option key={type.id} value={type.id}>{type.name}</option>
              ))}
            </select>

            <select
              value={supplierFilter}
              onChange={(event) => {
                setSupplierFilter(event.target.value);
                setPage(1);
              }}
              className="h-9 w-[170px] border border-[#AEB5BB] bg-white px-2 text-sm text-[#1F2933] focus:outline-none focus:ring-1 focus:ring-white/70"
            >
              <option value="">All suppliers</option>
              {supplierOptions.map((supplier) => (
                <option key={supplier} value={supplier}>{supplier}</option>
              ))}
            </select>

            {(search || statusFilter || typeFilter || supplierFilter) && (
              <button
                type="button"
                onClick={() => {
                  clearUrlStatusFilter();
                  setSearch("");
                  setStatusFilter("");
                  setTypeFilter("");
                  setSupplierFilter("");
                  setPage(1);
                }}
                className="h-9 px-3 text-sm text-white/80 hover:text-white"
              >
                Clear
              </button>
            )}

            <div className="ml-auto flex items-center gap-6 text-sm text-white/80">
              <Link to="/documents/upload" className="inline-flex items-center gap-2 hover:text-white">
                <Plus className="h-5 w-5" />
                Add Document
              </Link>
            </div>
          </div>

          <div className="flex min-h-0 flex-1 pr-4">
            <section className="flex min-w-0 flex-1 flex-col">
              <div className="flex h-[66px] shrink-0 items-end border-b border-[#C8CDD2] bg-[#EDEDED] pl-4">
                <button
                  type="button"
                  className="h-9 border border-[#B9C0C6] border-t-[#2B8DCB] border-t-2 bg-white px-4 text-sm text-[#2B86C5]"
                >
                  All Documents
                </button>
              </div>

              <div className="flex h-[60px] shrink-0 items-center border-b border-[#C8CDD2] bg-white px-5">
                <label className="inline-flex items-center gap-2 text-[#3F474F]">
                  <input
                    type="checkbox"
                    checked={allChecked}
                    onChange={toggleAll}
                    className="h-3.5 w-3.5 border-[#AEB5BB]"
                  />
                  Select all
                </label>
                <div className="mx-4 h-6 w-px bg-[#C8CDD2]" />
                <span className="font-semibold text-[#1F2933]">
                  {isLoading ? "Loading documents" : `${matchingCount.toLocaleString()} matching documents`}
                </span>
                <div className="ml-auto flex items-center gap-5 text-xs text-[#5E6870]">
                  <label className="inline-flex items-center gap-2">
                    <span>Sort Results</span>
                    <select
                      value={sort}
                      onChange={(event) => {
                        setSort(event.target.value as typeof sort);
                        setPage(1);
                      }}
                      className="border-0 bg-transparent py-1 pr-6 text-xs text-[#5E6870] focus:outline-none"
                    >
                      <option value="created_at">Created Date</option>
                      <option value="title">Title</option>
                      <option value="reference_number">Reference</option>
                      <option value="document_date">Document Date</option>
                      <option value="amount">Amount</option>
                    </select>
                  </label>
                </div>
              </div>

              {selectedIds.length > 0 && (
                <div className="flex min-h-[48px] shrink-0 flex-wrap items-center gap-3 border-b border-[#C8CDD2] bg-[#F5F7F8] px-5 py-2">
                  <span className="font-semibold text-[#1F2933]">
                    {selectedIds.length} selected
                  </span>
                  <button
                    type="button"
                    onClick={() => setShareModalOpen(true)}
                    className="inline-flex items-center gap-2 border border-[#C8CDD2] bg-white px-3 py-1.5 text-sm font-semibold text-[#1F2933] hover:bg-[#EEF6FB] hover:text-[#287EAD]"
                  >
                    <Share2 className="h-4 w-4" />
                    Share in app
                  </button>
                  <button
                    type="button"
                    onClick={() => setEmailModalOpen(true)}
                    className="inline-flex items-center gap-2 border border-[#C8CDD2] bg-white px-3 py-1.5 text-sm font-semibold text-[#1F2933] hover:bg-[#EEF6FB] hover:text-[#287EAD]"
                  >
                    <Mail className="h-4 w-4" />
                    Send to email
                  </button>
                  {/* Bulk download split button */}
                  <div ref={bulkDownloadTrayRef} className="relative">
                    <button
                      type="button"
                      onClick={() => setShowBulkDownloadTray((v) => !v)}
                      disabled={downloadSelectedMutation.isPending || downloadSelectedAsPdfMutation.isPending || downloadSelectedMergedPdfMutation.isPending}
                      className="inline-flex items-center gap-2 border border-[#C8CDD2] bg-white px-3 py-1.5 text-sm font-semibold text-[#1F2933] hover:bg-[#EEF6FB] hover:text-[#287EAD] disabled:cursor-not-allowed disabled:opacity-40"
                      title="Download selected documents"
                      aria-haspopup="true"
                      aria-expanded={showBulkDownloadTray}
                    >
                      {(downloadSelectedMutation.isPending || downloadSelectedAsPdfMutation.isPending || downloadSelectedMergedPdfMutation.isPending)
                        ? <Loader2 className="h-4 w-4 animate-spin" />
                        : <Download className="h-4 w-4" />}
                      Download
                      <ChevronDown className={cn("h-3.5 w-3.5 transition-transform", showBulkDownloadTray && "rotate-180")} />
                    </button>

                    {showBulkDownloadTray && (
                      <div className="absolute left-0 top-full z-50 mt-1 w-60 overflow-hidden rounded border border-[#C8CDD2] bg-white shadow-lg">
                        <p className="border-b border-[#E3E7EA] bg-[#F5F7F8] px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-[#5E6870]">
                          Download as
                        </p>
                        {/* Original files ZIP */}
                        <button
                          type="button"
                          onClick={() => { setShowBulkDownloadTray(false); downloadSelectedMutation.mutate(); }}
                          disabled={downloadSelectedMutation.isPending}
                          className="flex w-full items-center gap-2.5 px-3 py-2.5 text-sm text-[#1F2933] hover:bg-[#EEF6FB] hover:text-[#287EAD] disabled:opacity-50"
                        >
                          <Download className="h-4 w-4 shrink-0 text-[#5E6870]" />
                          <div className="text-left">
                            <p className="font-medium">ZIP (original files)</p>
                            <p className="text-[11px] text-[#5E6870]">Original formats bundled in a ZIP</p>
                          </div>
                        </button>
                        {/* PDF ZIP */}
                        <button
                          type="button"
                          onClick={() => { setShowBulkDownloadTray(false); downloadSelectedAsPdfMutation.mutate(); }}
                          disabled={downloadSelectedAsPdfMutation.isPending}
                          className="flex w-full items-center gap-2.5 px-3 py-2.5 text-sm text-[#1F2933] hover:bg-[#EEF6FB] hover:text-[#287EAD] disabled:opacity-50"
                        >
                          <FileText className="h-4 w-4 shrink-0 text-[#5E6870]" />
                          <div className="text-left">
                            <p className="font-medium">ZIP (PDF versions)</p>
                            <p className="text-[11px] text-[#5E6870]">All files converted to PDF, in a ZIP</p>
                          </div>
                        </button>
                        {/* Merged PDF — only useful for multiple */}
                        <button
                          type="button"
                          onClick={() => { setShowBulkDownloadTray(false); setMergeModalOpen(true); }}
                          disabled={downloadSelectedMergedPdfMutation.isPending}
                          className="flex w-full items-center gap-2.5 border-t border-[#E3E7EA] px-3 py-2.5 text-sm text-[#1F2933] hover:bg-[#EEF6FB] hover:text-[#287EAD] disabled:opacity-50"
                        >
                          <FileText className="h-4 w-4 shrink-0 text-[#287EAD]" />
                          <div className="text-left">
                            <p className="font-medium text-[#287EAD]">Merged PDF</p>
                            <p className="text-[11px] text-[#5E6870]">Reorder, then stitch into one PDF</p>
                          </div>
                        </button>
                      </div>
                    )}
                  </div>
                  <button
                    type="button"
                    onClick={() => bulkMutation.mutate({ action: "archive" })}
                    disabled={!availableBulkActions.includes("archive") || bulkMutation.isPending}
                    className="inline-flex items-center gap-2 border border-[#C8CDD2] bg-white px-3 py-1.5 text-sm font-semibold text-[#1F2933] hover:bg-[#EEF6FB] hover:text-[#287EAD] disabled:cursor-not-allowed disabled:opacity-40"
                    title={availableBulkActions.includes("archive") ? "Archive selected documents" : "Only approved documents can be archived"}
                  >
                    {bulkMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Archive className="h-4 w-4" />}
                    Archive
                  </button>
                  {availableBulkActions.includes("trash") && (
                    <button
                      type="button"
                      onClick={() => {
                        if (window.confirm(`Move ${selectedIds.length} document${selectedIds.length === 1 ? "" : "s"} to Trash? You can restore ${selectedIds.length === 1 ? "it" : "them"} later.`)) {
                          bulkMutation.mutate({ action: "trash" });
                        }
                      }}
                      disabled={bulkMutation.isPending}
                      className="inline-flex items-center gap-2 border border-red-300 bg-white px-3 py-1.5 text-sm font-semibold text-red-600 hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-40"
                      title="Move selected documents to Trash"
                    >
                      {bulkMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
                      Delete
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => setSelectedIds([])}
                    className="ml-auto inline-flex items-center gap-2 px-3 py-1.5 text-sm font-semibold text-[#5E6870] hover:text-[#1F2933]"
                  >
                    <X className="h-4 w-4" />
                    Clear selection
                  </button>
                </div>
              )}

              <div className="min-h-0 flex-1 overflow-auto bg-[#EDEDED]">
                {effectiveView === "table" && (
                  <table className="w-full min-w-[1260px] border-collapse bg-white text-sm">
                    <thead className="sticky top-0 z-[1]">
                      <tr className="h-[39px] border-b border-[#AEB5BB] bg-[#50545A] text-left text-xs font-semibold text-white">
                        <th className="w-[50px] border-r border-[#858A90] px-4 py-3" />
                        <th className="w-[60px] border-r border-[#858A90] px-4 py-3" />
                        <th className="border-r border-[#858A90] px-3 py-3">Title</th>
                        <th className="border-r border-[#858A90] px-3 py-3">Document Type</th>
                        <th className="border-r border-[#858A90] px-3 py-3">Format</th>
                        <th className="border-r border-[#858A90] px-3 py-3">Status</th>
                        <th className="border-r border-[#858A90] px-3 py-3">Created By</th>
                        <th className="border-r border-[#858A90] px-3 py-3">Created Date</th>
                        <th className="border-r border-[#858A90] px-3 py-3">Modified Date</th>
                        <th className="w-[90px] px-3 py-3">View</th>
                      </tr>
                    </thead>
                    <tbody>
                      {isLoading ? (
                        Array.from({ length: 6 }).map((_, rowIndex) => (
                          <tr key={rowIndex} className="h-[44px] border-b border-[#D3D7DA]">
                            {Array.from({ length: 10 }).map((_, cellIndex) => (
                              <td key={cellIndex} className="border-r border-[#D3D7DA] px-3">
                                <div className="h-3 w-2/3 animate-pulse bg-[#E1E5E8]" />
                              </td>
                            ))}
                          </tr>
                        ))
                      ) : docs.length === 0 ? (
                        <tr>
                          <td colSpan={10} className="py-20 text-center text-[#5E6870]">
                            No documents found
                          </td>
                        </tr>
                      ) : (
                        docs.map((doc: Document) => {
                          const isSelected = selectedIds.includes(doc.id);
                          const typeLabel = getDocumentTypeLabel(doc);
                          const formatLabel = formatDocumentFileType(doc.file_name, doc.file_mime_type);

                          return (
                            <tr
                              key={doc.id}
                              className={cn(
                                "h-[45px] border-b border-[#D3D7DA] bg-white hover:bg-[#F5F7F8]",
                                isSelected && "bg-[#E7F2FA]",
                              )}
                            >
                              <td className="border-r border-[#D3D7DA] px-4">
                                <input
                                  type="checkbox"
                                  checked={isSelected}
                                  onChange={() => toggleOne(doc.id)}
                                  className="h-3.5 w-3.5 border-[#AEB5BB]"
                                />
                              </td>
                              <td className="border-r border-[#D3D7DA]" />
                              <td className="border-r border-[#D3D7DA] px-3">
                                <Link
                                  to={`/documents/${doc.id}`}
                                  onMouseEnter={preloadDocumentWorkspace}
                                  onFocus={preloadDocumentWorkspace}
                                  className="font-semibold text-[#2B86C5] hover:underline"
                                >
                                  {doc.title}
                                </Link>
                              </td>
                              <td className="border-r border-[#D3D7DA] px-3">{typeLabel}</td>
                              <td className="border-r border-[#D3D7DA] px-3">
                                <span className="font-semibold text-[#3F474F]">{formatLabel}</span>
                              </td>
                              <td className="border-r border-[#D3D7DA] px-3">
                                <span className={cn("font-semibold", getDocumentStatusTextClass(doc.status))}>
                                  {getDocumentStatusLabel(doc.status)}
                                </span>
                              </td>
                              <td className="border-r border-[#D3D7DA] px-3">
                                {doc.uploaded_by?.full_name || doc.uploaded_by?.email || ""}
                              </td>
                              <td className="border-r border-[#D3D7DA] px-3">{formatInforDateTime(doc.created_at)}</td>
                              <td className="border-r border-[#D3D7DA] px-3">{formatInforDateTime(doc.updated_at)}</td>
                              <td className="px-3">
                                <Link
                                  to={`/documents/${doc.id}`}
                                  onMouseEnter={preloadDocumentWorkspace}
                                  onFocus={preloadDocumentWorkspace}
                                  className="font-semibold text-[#2B86C5] hover:underline"
                                >
                                  View
                                </Link>
                              </td>
                            </tr>
                          );
                        })
                      )}
                    </tbody>
                  </table>
                )}

                {effectiveView === "card" && (
                  <div className="divide-y divide-[#D3D7DA] bg-white">
                    {isLoading ? (
                      Array.from({ length: 5 }).map((_, index) => (
                        <div key={index} className="flex h-[154px] gap-8 px-5 py-4">
                          <div className="h-[123px] w-[89px] animate-pulse bg-[#E1E5E8]" />
                          <div className="flex-1 space-y-3 pt-2">
                            <div className="h-4 w-40 animate-pulse bg-[#E1E5E8]" />
                            <div className="h-3 w-28 animate-pulse bg-[#E1E5E8]" />
                            <div className="h-3 w-32 animate-pulse bg-[#E1E5E8]" />
                          </div>
                        </div>
                      ))
                    ) : docs.length === 0 ? (
                      <div className="py-20 text-center text-[#5E6870]">No documents found</div>
                    ) : (
                      docs.map((doc: Document) => {
                        const isSelected = selectedIds.includes(doc.id);
                        const typeLabel = getDocumentTypeLabel(doc);
                        const formatLabel = formatDocumentFileType(doc.file_name, doc.file_mime_type);

                        return (
                          <div
                            key={doc.id}
                            role="button"
                            tabIndex={0}
                            onClick={() => toggleOne(doc.id)}
                            onKeyDown={(event) => {
                              if (event.key === "Enter" || event.key === " ") {
                                event.preventDefault();
                                toggleOne(doc.id);
                              }
                            }}
                            className={cn(
                              "grid min-h-[118px] cursor-pointer grid-cols-[34px_96px_minmax(280px,1fr)_minmax(190px,0.55fr)] gap-3 px-4 py-3 transition-colors hover:bg-[#F4F8FB] hover:shadow-[inset_3px_0_0_#2B86C5]",
                              isSelected && "bg-[#E6F1FB] shadow-[inset_3px_0_0_#2B86C5]",
                            )}
                          >
                            <div className="pt-1">
                              <input
                                type="checkbox"
                                checked={isSelected}
                                onClick={(event) => event.stopPropagation()}
                                onChange={() => toggleOne(doc.id)}
                                className="h-3.5 w-3.5 border-[#AEB5BB]"
                              />
                            </div>
                            <Link
                              to={`/documents/${doc.id}`}
                              onMouseEnter={preloadDocumentWorkspace}
                              onFocus={preloadDocumentWorkspace}
                              onClick={(event) => event.stopPropagation()}
                              className="h-[92px] w-[68px] border border-[#D3D7DA] bg-white"
                            >
                              <DocumentPreviewTile doc={doc} />
                            </Link>
                            <div className="min-w-0 text-sm">
                              <Link
                                to={`/documents/${doc.id}`}
                                onMouseEnter={preloadDocumentWorkspace}
                                onFocus={preloadDocumentWorkspace}
                                onClick={(event) => event.stopPropagation()}
                                className="block truncate text-base font-semibold text-[#2B86C5] hover:underline"
                              >
                                {doc.title}
                              </Link>
                              <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-[#5E6870]">
                                {typeLabel && <span className="font-semibold text-[#3F474F]">{typeLabel}</span>}
                                <span className="border border-[#D3D7DA] bg-[#F5F7F8] px-1.5 py-0.5 font-semibold uppercase text-[#3F474F]">
                                  {formatLabel}
                                </span>
                              </div>
                              <div className="mt-2">
                                <p className={cn("font-semibold", getDocumentStatusTextClass(doc.status))}>
                                  {getDocumentStatusLabel(doc.status)}
                                </p>
                              </div>
                              <p className="mt-2 truncate text-[#5E6870]">
                                Created by <span className="font-semibold text-[#1F2933]">{doc.uploaded_by?.full_name || doc.uploaded_by?.email || ""}</span>
                              </p>
                            </div>
                            <div className="pt-1 text-sm">
                              {formatInforDateTime(doc.created_at) && (
                                <div>
                                  <p className="text-[#5E6870]">Created</p>
                                  <p className="font-semibold">{formatInforDateTime(doc.created_at)}</p>
                                </div>
                              )}
                              {formatInforDateTime(doc.updated_at) && (
                                <div className="mt-2">
                                  <p className="text-[#5E6870]">Modified</p>
                                  <p className="font-semibold">{formatInforDateTime(doc.updated_at)}</p>
                                </div>
                              )}
                              <Link
                                to={`/documents/${doc.id}`}
                                onMouseEnter={preloadDocumentWorkspace}
                                onFocus={preloadDocumentWorkspace}
                                onClick={(event) => event.stopPropagation()}
                                className="mt-3 inline-flex border border-[#C8CDD2] bg-white px-3 py-1.5 text-sm font-semibold text-[#2B86C5] hover:bg-[#F5F7F8] hover:underline"
                              >
                                <Eye className="mr-1.5 h-4 w-4" />
                                View
                              </Link>
                            </div>
                          </div>
                        );
                      })
                    )}
                  </div>
                )}

                {effectiveView === "thumbnails" && (
                  <div className="grid auto-rows-max grid-cols-[repeat(auto-fill,190px)] gap-7 p-7">
                    {isLoading ? (
                      Array.from({ length: 6 }).map((_, index) => (
                        <div key={index} className="h-[212px] animate-pulse border border-[#D3D7DA] bg-white" />
                      ))
                    ) : docs.length === 0 ? (
                      <div className="col-span-full py-20 text-center text-[#5E6870]">No documents found</div>
                    ) : (
                      docs.map((doc: Document) => {
                        const isSelected = selectedIds.includes(doc.id);
                        const typeLabel = getDocumentTypeLabel(doc);
                        const formatLabel = formatDocumentFileType(doc.file_name, doc.file_mime_type);
                        return (
                          <div
                            key={doc.id}
                            className={cn(
                              "min-h-[268px] border border-[#C9CED3] bg-white",
                              isSelected && "outline outline-2 outline-[#2B86C5]",
                            )}
                          >
                            <div className="flex h-[38px] items-center gap-2 border-b border-[#C9CED3] px-2">
                              <input
                                type="checkbox"
                                checked={isSelected}
                                onChange={() => toggleOne(doc.id)}
                                className="h-3.5 w-3.5 border-[#AEB5BB]"
                              />
                              <Link
                                to={`/documents/${doc.id}`}
                                onMouseEnter={preloadDocumentWorkspace}
                                onFocus={preloadDocumentWorkspace}
                                className="truncate font-semibold text-[#2B86C5] hover:underline"
                                title={doc.title}
                              >
                                {doc.title}
                              </Link>
                            </div>
                            <Link
                              to={`/documents/${doc.id}`}
                              onMouseEnter={preloadDocumentWorkspace}
                              onFocus={preloadDocumentWorkspace}
                              className="mx-auto mt-2 block h-[160px] w-[114px] border border-[#D3D7DA]"
                            >
                              <DocumentPreviewTile doc={doc} large />
                            </Link>
                            <div className="space-y-1 px-3 py-2 text-xs">
                              <p className="truncate text-[#5E6870]" title={typeLabel || "Unclassified"}>
                                {typeLabel || "Unclassified"}
                              </p>
                              <p className="font-semibold text-[#3F474F]">{formatLabel}</p>
                              <p className={cn("font-semibold", getDocumentStatusTextClass(doc.status))}>
                                {getDocumentStatusLabel(doc.status)}
                              </p>
                              <Link
                                to={`/documents/${doc.id}`}
                                onMouseEnter={preloadDocumentWorkspace}
                                onFocus={preloadDocumentWorkspace}
                                className="inline-flex items-center font-semibold text-[#2B86C5] hover:underline"
                              >
                                <Eye className="mr-1 h-3.5 w-3.5" />
                                View
                              </Link>
                            </div>
                          </div>
                        );
                      })
                    )}
                  </div>
                )}
              </div>

              <div className="flex h-[46px] shrink-0 items-center border-t border-[#C8CDD2] bg-white px-5">
                {data && data.count > PAGE_SIZE ? (
                  <div className="flex items-center gap-3 text-xs text-[#5E6870]">
                    <button
                      onClick={() => setPage((p) => Math.max(1, p - 1))}
                      disabled={page === 1}
                      className="border border-[#C8CDD2] px-3 py-1 disabled:opacity-40"
                    >
                      Previous
                    </button>
                    <span>
                      {Math.min((page - 1) * PAGE_SIZE + 1, data.count)}-{Math.min(page * PAGE_SIZE, data.count)} of {data.count.toLocaleString()}
                    </span>
                    <button
                      onClick={() => setPage((p) => p + 1)}
                      disabled={page * PAGE_SIZE >= data.count}
                      className="border border-[#C8CDD2] px-3 py-1 disabled:opacity-40"
                    >
                      Next
                    </button>
                  </div>
                ) : null}
                <div className="ml-auto flex items-center gap-3 text-[#6E767D]">
                  <button
                    type="button"
                    title="List"
                    aria-pressed={effectiveView === "table"}
                    onClick={() => setViewMode("table")}
                    className={cn("p-1 hover:text-[#1F2933]", effectiveView === "table" && "text-[#1F2933]")}
                  >
                    <List className="h-4 w-4" />
                  </button>
                  <button
                    type="button"
                    title="Card"
                    aria-pressed={effectiveView === "card"}
                    onClick={() => setViewMode("card")}
                    className={cn("p-1 hover:text-[#1F2933]", effectiveView === "card" && "text-[#1F2933]")}
                  >
                    <Rows3 className="h-4 w-4" />
                  </button>
                  <button
                    type="button"
                    title="Thumbnails"
                    aria-pressed={effectiveView === "thumbnails"}
                    onClick={() => setViewMode("thumbnails")}
                    className={cn("p-1 hover:text-[#1F2933]", effectiveView === "thumbnails" && "text-[#1F2933]")}
                  >
                    <LayoutGrid className="h-4 w-4" />
                  </button>
                </div>
              </div>
            </section>
          </div>
        </div>

        {shareModalOpen && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
            <div className="w-full max-w-3xl border border-[#C8CDD2] bg-white shadow-2xl">
              <div className="flex items-center justify-between border-b border-[#C8CDD2] bg-[#287EAD] px-5 py-3 text-white">
                <div>
                  <h2 className="text-base font-semibold">Share selected documents</h2>
                  <p className="text-xs text-white/75">
                    {selectedIds.length} document{selectedIds.length === 1 ? "" : "s"} selected
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setShareModalOpen(false)}
                  className="p-1 text-white/75 hover:text-white"
                  aria-label="Close share dialog"
                >
                  <X className="h-5 w-5" />
                </button>
              </div>

              <div className="grid gap-5 p-5 md:grid-cols-[1.1fr_0.9fr]">
                <div className="space-y-3">
                  <div>
                    <label className="text-sm font-semibold text-[#1F2933]">People</label>
                    <div className="relative mt-2">
                      <SearchIcon className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[#6E767D]" />
                      <input
                        value={shareRecipientSearch}
                        onChange={(event) => setShareRecipientSearch(event.target.value)}
                        placeholder="Search users by name, email, or department"
                        className="h-9 w-full border border-[#AEB5BB] bg-white pl-9 pr-3 text-sm text-[#1F2933] focus:outline-none focus:ring-1 focus:ring-[#287EAD]"
                      />
                    </div>
                  </div>

                  <div className="max-h-72 overflow-y-auto border border-[#C8CDD2]">
                    {filteredShareUsers.length === 0 ? (
                      <div className="px-3 py-8 text-center text-sm text-[#5E6870]">
                        No users found.
                      </div>
                    ) : (
                      filteredShareUsers.map((user) => {
                        const checked = shareRecipientIds.includes(user.id);
                        return (
                          <label
                            key={user.id}
                            className={cn(
                              "grid cursor-pointer grid-cols-[auto_1fr] gap-3 border-b border-[#D3D7DA] px-3 py-2 last:border-b-0 hover:bg-[#F5F7F8]",
                              checked && "bg-[#EEF6FB]",
                            )}
                          >
                            <input
                              type="checkbox"
                              checked={checked}
                              onChange={() => {
                                setShareRecipientIds((prev) =>
                                  prev.includes(user.id)
                                    ? prev.filter((id) => id !== user.id)
                                    : [...prev, user.id],
                                );
                              }}
                              className="mt-1 h-3.5 w-3.5 border-[#AEB5BB]"
                            />
                            <span className="min-w-0">
                              <span className="block truncate text-sm font-semibold text-[#1F2933]">
                                {getUserDisplayName(user)}
                              </span>
                              <span className="block truncate text-xs text-[#5E6870]">
                                {user.email}
                                {user.department_name ? ` · ${user.department_name}` : ""}
                              </span>
                            </span>
                          </label>
                        );
                      })
                    )}
                  </div>
                </div>

                <div className="space-y-4">
                  <div>
                    <label className="text-sm font-semibold text-[#1F2933]">Access</label>
                    <div className="mt-2 space-y-2">
                      <label className="flex cursor-pointer gap-3 border border-[#C8CDD2] bg-white p-3 hover:bg-[#F5F7F8]">
                        <input
                          type="radio"
                          name="share-access"
                          value="view"
                          checked={shareAccessLevel === "view"}
                          onChange={() => setShareAccessLevel("view")}
                          className="mt-1"
                        />
                        <span>
                          <span className="block text-sm font-semibold text-[#1F2933]">View only</span>
                          <span className="text-xs text-[#5E6870]">Recipients can open the document in IDM.</span>
                        </span>
                      </label>
                      <label className="flex cursor-pointer gap-3 border border-[#C8CDD2] bg-white p-3 hover:bg-[#F5F7F8]">
                        <input
                          type="radio"
                          name="share-access"
                          value="download"
                          checked={shareAccessLevel === "download"}
                          onChange={() => setShareAccessLevel("download")}
                          className="mt-1"
                        />
                        <span>
                          <span className="block text-sm font-semibold text-[#1F2933]">View and download</span>
                          <span className="text-xs text-[#5E6870]">Recipients can also download the file.</span>
                        </span>
                      </label>
                    </div>
                  </div>

                  <div>
                    <label className="text-sm font-semibold text-[#1F2933]">Expiry</label>
                    <input
                      type="datetime-local"
                      value={shareExpiresAt}
                      onChange={(event) => setShareExpiresAt(event.target.value)}
                      className="mt-2 h-9 w-full border border-[#AEB5BB] px-3 text-sm text-[#1F2933] focus:outline-none focus:ring-1 focus:ring-[#287EAD]"
                    />
                  </div>

                  <label className="flex cursor-pointer items-center gap-2 text-sm font-semibold text-[#1F2933]">
                    <input
                      type="checkbox"
                      checked={shareNotifyByEmail}
                      onChange={(event) => setShareNotifyByEmail(event.target.checked)}
                      className="h-3.5 w-3.5 border-[#AEB5BB]"
                    />
                    Also notify by email
                  </label>

                  <div>
                    <label className="text-sm font-semibold text-[#1F2933]">Message</label>
                    <textarea
                      value={shareMessage}
                      onChange={(event) => setShareMessage(event.target.value)}
                      rows={4}
                      placeholder="Optional note shown with the share notification"
                      className="mt-2 block w-full border border-[#AEB5BB] px-3 py-2 text-sm text-[#1F2933] focus:outline-none focus:ring-1 focus:ring-[#287EAD]"
                    />
                  </div>

                  <div className="border border-[#C8CDD2] bg-[#F5F7F8] px-3 py-2 text-sm text-[#5E6870]">
                    {shareRecipientIds.length} recipient{shareRecipientIds.length === 1 ? "" : "s"} · {selectedIds.length} document{selectedIds.length === 1 ? "" : "s"}
                  </div>
                </div>
              </div>

              <div className="flex items-center justify-end gap-2 border-t border-[#C8CDD2] bg-[#F5F7F8] px-5 py-3">
                <button
                  type="button"
                  onClick={() => setShareModalOpen(false)}
                  className="border border-[#C8CDD2] bg-white px-4 py-2 text-sm font-semibold text-[#1F2933] hover:bg-[#EEF6FB]"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={() => shareSelectedMutation.mutate()}
                  disabled={shareSelectedMutation.isPending || selectedIds.length === 0 || shareRecipientIds.length === 0}
                  className="inline-flex items-center gap-2 bg-[#287EAD] px-4 py-2 text-sm font-semibold text-white hover:bg-[#206D99] disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {shareSelectedMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Share2 className="h-4 w-4" />}
                  Share
                </button>
              </div>
            </div>
          </div>
        )}

        {mergeModalOpen && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
            <div className="w-full max-w-md border border-[#C8CDD2] bg-white shadow-2xl">
              <div className="flex items-center justify-between border-b border-[#C8CDD2] bg-[#287EAD] px-5 py-3 text-white">
                <div>
                  <h2 className="text-base font-semibold">Merge &amp; download PDF</h2>
                  <p className="text-xs text-white/75">
                    {mergeDocOrder.length} document{mergeDocOrder.length === 1 ? "" : "s"} — drag order top-first
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setMergeModalOpen(false)}
                  className="p-1 text-white/75 hover:text-white"
                  aria-label="Close merge dialog"
                >
                  <X className="h-5 w-5" />
                </button>
              </div>
              <div className="space-y-4 p-5">
                {mergeDocOrder.length > 1 ? (
                  <StitchOrderList order={mergeDocOrder} docs={docs} onMove={moveMergeDoc} />
                ) : (
                  <p className="text-sm text-[#5E6870]">
                    Select more than one document to choose the merge order.
                  </p>
                )}
                <div className="flex justify-end gap-2">
                  <button
                    type="button"
                    onClick={() => setMergeModalOpen(false)}
                    className="border border-[#AEB5BB] bg-white px-4 py-2 text-sm font-semibold text-[#1F2933] hover:bg-[#F3F5F6]"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={() => downloadSelectedMergedPdfMutation.mutate(mergeDocOrder)}
                    disabled={downloadSelectedMergedPdfMutation.isPending || mergeDocOrder.length === 0}
                    className="inline-flex items-center gap-2 bg-[#287EAD] px-4 py-2 text-sm font-semibold text-white hover:bg-[#206D99] disabled:opacity-50"
                  >
                    {downloadSelectedMergedPdfMutation.isPending
                      ? <Loader2 className="h-4 w-4 animate-spin" />
                      : <FileText className="h-4 w-4" />}
                    Download merged PDF
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}

        {emailModalOpen && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
            <div className="w-full max-w-3xl border border-[#C8CDD2] bg-white shadow-2xl">
              <div className="flex items-center justify-between border-b border-[#C8CDD2] bg-[#287EAD] px-5 py-3 text-white">
                <div>
                  <h2 className="text-base font-semibold">Send selected documents</h2>
                  <p className="text-xs text-white/75">
                    {selectedIds.length} document{selectedIds.length === 1 ? "" : "s"} selected
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setEmailModalOpen(false)}
                  className="p-1 text-white/75 hover:text-white"
                  aria-label="Close email dialog"
                >
                  <X className="h-5 w-5" />
                </button>
              </div>

              <div className="grid gap-5 p-5 md:grid-cols-[1.1fr_0.9fr]">
                <div className="space-y-3">
                  <div>
                    <label className="text-sm font-semibold text-[#1F2933]">Recipients</label>
                    <div className="relative mt-2">
                      <SearchIcon className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[#6E767D]" />
                      <input
                        value={emailRecipientSearch}
                        onChange={(event) => setEmailRecipientSearch(event.target.value)}
                        placeholder="Search users by name, email, or department"
                        className="h-9 w-full border border-[#AEB5BB] bg-white pl-9 pr-3 text-sm text-[#1F2933] focus:outline-none focus:ring-1 focus:ring-[#287EAD]"
                      />
                    </div>
                  </div>

                  <div className="max-h-64 overflow-y-auto border border-[#C8CDD2]">
                    {filteredEmailUsers.length === 0 ? (
                      <div className="px-3 py-8 text-center text-sm text-[#5E6870]">
                        No users found.
                      </div>
                    ) : (
                      filteredEmailUsers.map((user) => {
                        const checked = emailRecipientIds.includes(user.id);
                        return (
                          <label
                            key={user.id}
                            className={cn(
                              "grid cursor-pointer grid-cols-[auto_1fr] gap-3 border-b border-[#D3D7DA] px-3 py-2 last:border-b-0 hover:bg-[#F5F7F8]",
                              checked && "bg-[#EEF6FB]",
                            )}
                          >
                            <input
                              type="checkbox"
                              checked={checked}
                              onChange={() => {
                                setEmailRecipientIds((prev) =>
                                  prev.includes(user.id)
                                    ? prev.filter((id) => id !== user.id)
                                    : [...prev, user.id],
                                );
                              }}
                              className="mt-1 h-3.5 w-3.5 border-[#AEB5BB]"
                            />
                            <span className="min-w-0">
                              <span className="block truncate text-sm font-semibold text-[#1F2933]">
                                {getUserDisplayName(user)}
                              </span>
                              <span className="block truncate text-xs text-[#5E6870]">
                                {user.email}
                                {user.department_name ? ` · ${user.department_name}` : ""}
                              </span>
                            </span>
                          </label>
                        );
                      })
                    )}
                  </div>

                  <div>
                    <label className="text-sm font-semibold text-[#1F2933]">Additional email addresses</label>
                    <textarea
                      value={emailExtraRecipients}
                      onChange={(event) => setEmailExtraRecipients(event.target.value)}
                      rows={2}
                      placeholder="name@example.com, another@example.com"
                      className="mt-2 block w-full border border-[#AEB5BB] px-3 py-2 text-sm text-[#1F2933] focus:outline-none focus:ring-1 focus:ring-[#287EAD]"
                    />
                  </div>
                </div>

                <div className="space-y-4">
                  <div>
                    <label className="text-sm font-semibold text-[#1F2933]">Attachment handling</label>
                    <div className="mt-2 space-y-2">
                      <label className="flex cursor-pointer gap-3 border border-[#C8CDD2] bg-white p-3 hover:bg-[#F5F7F8]">
                        <input
                          type="radio"
                          name="attachment-mode"
                          value="separate"
                          checked={emailAttachmentMode === "separate"}
                          onChange={() => setEmailAttachmentMode("separate")}
                          className="mt-1"
                        />
                        <span>
                          <span className="block text-sm font-semibold text-[#1F2933]">Separate attachments</span>
                          <span className="text-xs text-[#5E6870]">Each selected document is attached individually.</span>
                        </span>
                      </label>
                      <label className="flex cursor-pointer gap-3 border border-[#C8CDD2] bg-white p-3 hover:bg-[#F5F7F8]">
                        <input
                          type="radio"
                          name="attachment-mode"
                          value="combined"
                          checked={emailAttachmentMode === "combined"}
                          onChange={() => setEmailAttachmentMode("combined")}
                          className="mt-1"
                        />
                        <span>
                          <span className="block text-sm font-semibold text-[#1F2933]">Stitch into one PDF</span>
                          <span className="text-xs text-[#5E6870]">Selected documents are merged into a single PDF in the order below.</span>
                        </span>
                      </label>
                    </div>

                    {emailAttachmentMode === "combined" && emailDocOrder.length > 1 && (
                      <div className="mt-2">
                        <StitchOrderList order={emailDocOrder} docs={docs} onMove={moveStitchDoc} />
                      </div>
                    )}
                  </div>

                  <div>
                    <label className="text-sm font-semibold text-[#1F2933]">Message</label>
                    <textarea
                      value={emailMessage}
                      onChange={(event) => setEmailMessage(event.target.value)}
                      rows={5}
                      placeholder="Optional note to include in the email"
                      className="mt-2 block w-full border border-[#AEB5BB] px-3 py-2 text-sm text-[#1F2933] focus:outline-none focus:ring-1 focus:ring-[#287EAD]"
                    />
                  </div>

                  <div className="border border-[#C8CDD2] bg-[#F5F7F8] px-3 py-2 text-sm text-[#5E6870]">
                    {emailRecipientCount} recipient{emailRecipientCount === 1 ? "" : "s"} · {selectedIds.length} document{selectedIds.length === 1 ? "" : "s"}
                  </div>
                </div>
              </div>

              <div className="flex items-center justify-end gap-2 border-t border-[#C8CDD2] bg-[#F5F7F8] px-5 py-3">
                <button
                  type="button"
                  onClick={() => setEmailModalOpen(false)}
                  className="border border-[#C8CDD2] bg-white px-4 py-2 text-sm font-semibold text-[#1F2933] hover:bg-[#EEF6FB]"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={() => emailSelectedMutation.mutate()}
                  disabled={emailSelectedMutation.isPending || selectedIds.length === 0 || emailRecipientCount === 0}
                  className="inline-flex items-center gap-2 bg-[#287EAD] px-4 py-2 text-sm font-semibold text-white hover:bg-[#206D99] disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {emailSelectedMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
                  Send email
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className={cn("p-6 max-w-7xl mx-auto space-y-6", isArchiveView && "max-w-6xl")}>

      {/* Header */}
      {isArchiveView ? (
        <div
          className="overflow-hidden rounded-xl border border-border bg-card"
          style={{ boxShadow: "var(--shadow-card)" }}
        >
          <div className="flex items-center justify-between gap-4 border-b border-border bg-muted/40 px-5 py-4">
            <div className="flex items-center gap-3">
              <div className="flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-lg border border-border bg-background text-muted-foreground">
                <Archive className="h-5 w-5" />
              </div>
              <div>
                <h1 className="text-2xl font-semibold tracking-tight text-foreground">Archived documents</h1>
                <p className="mt-0.5 text-sm text-muted-foreground">
                  Stored records that are no longer active in document workflows.
                </p>
              </div>
            </div>
            {data && (
              <div className="rounded-lg border border-border bg-background px-4 py-2 text-right">
                <p className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">Archive count</p>
                <p className="text-xl font-semibold tabular-nums text-foreground">{data.count.toLocaleString()}</p>
              </div>
            )}
          </div>
        </div>
      ) : personalOnly ? (
        <div className="flex items-center justify-between">
          <div>
            <div className="mb-2 inline-flex items-center gap-2 rounded-full border border-primary/20 bg-primary/5 px-3 py-1 text-xs font-semibold text-primary">
              <Lock className="h-3.5 w-3.5" />
              Personal vault
            </div>
            <h1 className="text-2xl font-bold text-foreground tracking-tight">Personal documents</h1>
            <p className="text-sm text-muted-foreground mt-1">
              Documents you control outside the approval workflow.
            </p>
          </div>
          <Link
            to="/documents/upload"
            className="inline-flex items-center gap-2 px-5 py-2.5 text-sm font-medium rounded-lg transition-all bg-primary text-primary-foreground hover:bg-primary/90"
            style={{ boxShadow: "var(--shadow-elegant)" }}
          >
            <UploadCloud className="w-4 h-4" /> Upload Personal Document
          </Link>
        </div>
      ) : (
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-foreground tracking-tight">Documents</h1>
            <p className="text-sm text-muted-foreground mt-1">
              Browse, filter, and act on every document in your vault.
            </p>
          </div>
          <Link
            to="/documents/upload"
            className="inline-flex items-center gap-2 px-5 py-2.5 text-sm font-medium rounded-lg transition-all bg-primary text-primary-foreground hover:bg-primary/90"
            style={{
              boxShadow: "var(--shadow-elegant)",
            }}
          >
            <UploadCloud className="w-4 h-4" /> Upload Document
          </Link>
        </div>
      )}


      {/* Personal tab explainer */}
      {!isArchiveView && personalOnly && (
        <div className="flex items-start gap-3 rounded-xl border border-primary/20 bg-primary/5 px-4 py-3 text-sm text-foreground">
          <Lock className="w-4 h-4 mt-0.5 flex-shrink-0 text-primary" />
          <span>
            These documents are private to you. They are not part of any approval workflow and are visible only to you and administrators.
          </span>
        </div>
      )}

      {/* Personal tag filters */}
      {!isArchiveView && personalOnly && personalTagOptions.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mr-2">Tags</span>
          <button
            type="button"
            onClick={() => setPersonalTagFilter("")}
            className={cn(
              "px-3 py-1.5 rounded-full text-xs font-medium border transition-colors",
              !personalTagFilter
                ? "bg-accent text-accent-foreground border-accent"
                : "bg-card text-muted-foreground border-border hover:text-foreground hover:border-accent/40",
            )}
          >
            All
          </button>
          {personalTagOptions.map((tag) => (
            <button
              key={tag}
              type="button"
              onClick={() => setPersonalTagFilter(tag === personalTagFilter ? "" : tag)}
              className={cn(
                "px-3 py-1.5 rounded-full text-xs font-medium border transition-colors",
                personalTagFilter === tag
                  ? "bg-accent text-accent-foreground border-accent"
                  : "bg-card text-muted-foreground border-border hover:text-foreground hover:border-accent/40",
              )}
            >
              {tag}
            </button>
          ))}
        </div>
      )}

      {/* Filters */}
      {!isArchiveView && (
        <div className="space-y-3">
          <div className="flex flex-wrap gap-3 items-center">
            <div className="relative flex-1 max-w-xs">
              <SearchIcon className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground pointer-events-none" />
              <input
                value={search}
                onChange={(e) => { setSearch(e.target.value); setPage(1); }}
                placeholder="Search documents…"
                className="w-full text-sm bg-card border border-border rounded-lg pl-9 pr-3 py-2.5 focus:outline-none focus:ring-2 focus:ring-accent/40 focus:border-accent transition-colors"
              />
            </div>

            {!personalOnly && (
              <button
                onClick={() => setShowFilters(!showFilters)}
                className={cn(
                  "inline-flex items-center gap-2 px-4 py-2.5 text-sm font-medium rounded-lg border transition-colors",
                  showFilters || activeFilterCount > 0
                    ? "border-accent/40 bg-accent/10 text-accent"
                    : "border-border bg-card text-muted-foreground hover:text-foreground hover:border-border"
                )}
              >
                <SlidersHorizontal className="w-4 h-4" />
                Filters
                {activeFilterCount > 0 && (
                  <span className="ml-1 inline-flex items-center justify-center w-5 h-5 rounded-full bg-accent text-accent-foreground text-[10px] font-bold">
                    {activeFilterCount}
                  </span>
                )}
              </button>
            )}

            {data && (
              <span className="ml-auto text-sm text-muted-foreground self-center">
                <span className="font-semibold text-foreground">{data.count.toLocaleString()}</span> document{data.count !== 1 ? "s" : ""}
              </span>
            )}
          </div>

          {/* Expanded filter row */}
          {showFilters && !personalOnly && (
            <div
              className="flex flex-wrap gap-3 items-center rounded-xl border border-border bg-muted/30 px-4 py-3"
              style={{ boxShadow: "var(--shadow-card)" }}
            >
              <div className="space-y-1">
                <label className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">Status</label>
                <select
                  value={statusFilter}
                  onChange={(e) => { clearUrlStatusFilter(); setStatusFilter(e.target.value); setPage(1); }}
                  className="block text-sm bg-card border border-border rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-accent/40 focus:border-accent transition-colors min-w-[140px]"
                >
                  <option value="">All statuses</option>
                  {STATUS_OPTIONS.map((s) => (
                    <option key={s} value={s}>{s.replace(/_/g, " ")}</option>
                  ))}
                </select>
              </div>

              <div className="space-y-1">
                <label className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">Type</label>
                <select
                  value={typeFilter}
                  onChange={(e) => { setTypeFilter(e.target.value); setPage(1); }}
                  className="block text-sm bg-card border border-border rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-accent/40 focus:border-accent transition-colors min-w-[140px]"
                >
                  <option value="">All types</option>
                  {(typesData ?? []).map((t: any) => (
                    <option key={t.id} value={t.id}>{t.name}</option>
                  ))}
                </select>
              </div>

              <div className="space-y-1">
                <label className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">Supplier</label>
                <select
                  value={supplierFilter}
                  onChange={(e) => { setSupplierFilter(e.target.value); setPage(1); }}
                  className="block text-sm bg-card border border-border rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-accent/40 focus:border-accent transition-colors min-w-[160px]"
                >
                  <option value="">All suppliers</option>
                  {supplierOptions.map((s) => (
                    <option key={s} value={s}>{s}</option>
                  ))}
                </select>
              </div>

              {activeFilterCount > 0 && (
                <button
                  onClick={() => {
                    clearUrlStatusFilter();
                    setStatusFilter("");
                    setTypeFilter("");
                    setSupplierFilter("");
                    setPage(1);
                  }}
                  className="self-end inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-destructive hover:bg-destructive/10 rounded-lg transition-colors"
                >
                  <X className="w-3.5 h-3.5" />
                  Clear all
                </button>
              )}
            </div>
          )}
        </div>
      )}

      {/* Bulk Toolbar */}
      {showBulkToolbar && (
        <BulkToolbar
          selectedIds={selectedIds}
          availableActions={availableBulkActions}
          onAction={(action, comment) => bulkMutation.mutate({ action, comment })}
          onClear={() => setSelectedIds([])}
          isLoading={bulkMutation.isPending}
        />
      )}

      {/* Results surface — Infor-style flat list, no centered card chrome */}
      <div
        className={cn(
          "bg-white border-t border-b border-[#D6DBE0]",
          isArchiveView && "bg-[#F4F6F8]"
        )}
      >
        {effectiveView === "table" && (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-[#D6DBE0] bg-[#F4F6F8]">
                {selectionEnabled && (
                  <th className="px-4 py-3 w-12">
                    <button onClick={toggleAll} className="text-muted-foreground hover:text-accent transition-colors" title="Select all on page">
                      {allChecked
                        ? <CheckSquare className="w-4 h-4 text-accent" />
                        : <Square className="w-4 h-4" />}
                    </button>
                  </th>
                )}
                <th className="text-left px-4 py-3 font-semibold text-[11px] uppercase tracking-wider text-[#5A6470]">Reference</th>
                <th className="text-left px-4 py-3 font-semibold text-[11px] uppercase tracking-wider text-[#5A6470]">Document Name</th>

                {personalOnly && (
                  <>
                    <th className="text-left px-4 py-3 font-semibold text-[11px] uppercase tracking-wider text-[#5A6470]">Description</th>
                    <th className="text-left px-4 py-3 font-semibold text-[11px] uppercase tracking-wider text-[#5A6470]">Tags</th>
                  </>
                )}

                {!personalOnly && !isArchiveView && (
                  <th className="text-left px-4 py-3 font-semibold text-[11px] uppercase tracking-wider text-[#5A6470]">Status</th>
                )}

                <th className="text-left px-4 py-3 font-semibold text-[11px] uppercase tracking-wider text-[#5A6470]">Uploaded</th>
                <th className="text-left px-4 py-3 font-semibold text-[11px] uppercase tracking-wider text-[#5A6470]">Uploaded By</th>

                <th className="text-right px-4 py-3 font-semibold text-[11px] uppercase tracking-wider text-[#5A6470]">Actions</th>
              </tr>
            </thead>

            <tbody className="divide-y divide-border">
              {isLoading ? (
                Array.from({ length: 6 }).map((_, i) => (
                  <tr key={i}>
                    {Array.from({ length: totalCols }).map((_, j) => (
                      <td key={j} className="px-4 py-3.5">
                        <div className="h-4 bg-muted rounded-md animate-pulse" />
                      </td>
                    ))}
                  </tr>
                ))
              ) : docs.length === 0 ? (
                <tr>
                  <td colSpan={totalCols} className="text-center py-20 text-muted-foreground">
                    {isArchiveView ? (
                      <Archive className="w-12 h-12 mx-auto mb-4 text-muted-foreground/30" />
                    ) : (
                      <FileText className="w-12 h-12 mx-auto mb-4 text-muted-foreground/30" />
                    )}
                    <p className="font-semibold text-foreground text-base">
                      {isArchiveView ? "No archived documents" : "No documents found"}
                    </p>
                    <p className="text-sm mt-1.5 text-muted-foreground max-w-sm mx-auto">
                      {isArchiveView ? "Archived documents will appear here once records are moved out of active use." : "Try adjusting your search or filters to find what you're looking for."}
                    </p>
                  </td>
                </tr>
              ) : (
                docs.map((doc: Document) => {
                  const isSelected = selectedIds.includes(doc.id);
                  const personalDescription = getPersonalDescription(doc);

                  return (
                    <tr
                      key={doc.id}
                      className={cn(
                        "hover:bg-muted/40 transition-colors group",
                        isSelected && "bg-accent/5",
                        isArchiveView && "bg-muted/[0.18] hover:bg-muted/40"
                      )}
                    >
                      {selectionEnabled && (
                        <td className="px-4 py-3.5">
                          <button
                            onClick={() => toggleOne(doc.id)}
                            className={cn(
                              "transition-all",
                              isSelected ? "text-accent opacity-100" : "text-muted-foreground opacity-0 group-hover:opacity-100"
                            )}
                          >
                            {isSelected ? <CheckSquare className="w-4 h-4" /> : <Square className="w-4 h-4" />}
                          </button>
                        </td>
                      )}

                      <td className="px-4 py-3.5">
                        <div className="flex items-center gap-2">
                          <Link
                            to={`/documents/${doc.id}`}
                            onMouseEnter={preloadDocumentWorkspace}
                            onFocus={preloadDocumentWorkspace}
                            className="font-mono text-xs bg-muted/60 text-foreground px-2 py-0.5 rounded-md hover:bg-accent/10 hover:text-accent transition-colors"
                          >
                            {doc.reference_number}
                          </Link>
                          {isArchiveView && (
                            <span className="inline-flex items-center gap-1 rounded-full border border-border bg-background px-1.5 py-0.5 text-[10px] font-semibold text-muted-foreground">
                              <Archive className="h-2.5 w-2.5" />
                              Archived
                            </span>
                          )}
                        </div>
                      </td>

                      <td className="px-4 py-3.5">
                        <div className="space-y-1">
                          <Link
                            to={`/documents/${doc.id}`}
                            onMouseEnter={preloadDocumentWorkspace}
                            onFocus={preloadDocumentWorkspace}
                            className="text-foreground group-hover:text-accent font-medium truncate block transition-colors max-w-[200px]"
                          >
                            {doc.title}
                          </Link>
                          <span className="inline-flex items-center rounded-md border border-border bg-muted/40 px-2 py-0.5 text-[10px] font-semibold uppercase text-muted-foreground tracking-wide">
                            {formatDocumentFileType(doc.file_name, doc.file_mime_type)}
                          </span>
                        </div>
                      </td>

                      {personalOnly && (
                        <>
                          <td className="px-4 py-3.5 text-xs text-foreground/80 max-w-[16rem]">
                            {personalDescription ? (
                              <span className="line-clamp-2">{personalDescription}</span>
                            ) : (
                              <span className="text-muted-foreground">—</span>
                            )}
                          </td>
                          <td className="px-4 py-3.5 min-w-[12rem]">
                            {doc.personal_tags?.length ? (
                              <PersonalTagChips
                                tags={doc.personal_tags}
                                onTagClick={isArchiveView ? undefined : handlePersonalTagClick}
                              />
                            ) : (
                              <span className="text-xs text-muted-foreground">—</span>
                            )}
                          </td>
                        </>
                      )}

                      {!personalOnly && !isArchiveView && (
                        <td className="px-4 py-3.5">
                          <StatusBadge status={doc.status} />
                        </td>
                      )}

                      <td className="px-4 py-3.5 text-muted-foreground whitespace-nowrap text-xs">
                        {format(new Date(doc.created_at), "dd MMM yyyy")}
                      </td>

                      <td className="px-4 py-3.5 text-foreground/80 max-w-[8rem] truncate text-xs">
                        {doc.uploaded_by?.full_name || doc.uploaded_by?.email || "—"}
                      </td>

                      <td className="px-4 py-3.5">
                        <div className="flex items-center justify-end gap-1.5">
                          <Link
                            to={`/documents/${doc.id}`}
                            onMouseEnter={preloadDocumentWorkspace}
                            onFocus={preloadDocumentWorkspace}
                            className="inline-flex items-center gap-1.5 rounded-md border border-border bg-card px-2.5 py-1.5 text-xs font-medium text-foreground hover:border-accent/40 hover:bg-accent/10 hover:text-accent transition-colors"
                          >
                            <Eye className="w-3.5 h-3.5" />
                            View
                          </Link>
                          {personalOnly && !["archived", "void"].includes(doc.status) && (
                            <button
                              title="Archive"
                              onClick={() => {
                                if (window.confirm("Archive this personal document?")) archiveMutation.mutate(doc.id);
                              }}
                              className="p-1.5 rounded-md text-muted-foreground hover:bg-accent/15 hover:text-accent transition-colors"
                            >
                              <Archive className="w-4 h-4" />
                            </button>
                          )}
                          {personalOnly && (
                            <button
                              title="Delete"
                              onClick={() => {
                                if (window.confirm("Delete this personal document? This cannot be undone.")) deleteMutation.mutate(doc.id);
                              }}
                              className="p-1.5 rounded-md text-muted-foreground hover:bg-destructive/10 hover:text-destructive transition-colors"
                            >
                              <Trash2 className="w-4 h-4" />
                            </button>
                          )}
                          {!personalOnly && !isArchiveView
                            && TRASHABLE_STATUSES.includes(doc.status)
                            && (doc.permissions?.includes("delete") ?? false) && (
                            <button
                              title="Move to Trash"
                              onClick={() => {
                                if (window.confirm("Move this document to Trash? You can restore it later.")) deleteMutation.mutate(doc.id);
                              }}
                              className="p-1.5 rounded-md text-muted-foreground hover:bg-destructive/10 hover:text-destructive transition-colors"
                            >
                              <Trash2 className="w-4 h-4" />
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
        )}

        {/* Card view (Infor-style) ─────────────────────────────────────────── */}
        {effectiveView === "card" && (
          <div className="divide-y divide-[#D6DBE0]">
            {isLoading ? (
              Array.from({ length: 5 }).map((_, i) => (
                <div key={i} className="flex items-start gap-4 px-5 py-4">
                  <div className="h-24 w-20 bg-muted rounded-md animate-pulse flex-shrink-0" />
                  <div className="flex-1 space-y-2">
                    <div className="h-4 w-1/3 bg-muted rounded animate-pulse" />
                    <div className="h-3 w-1/2 bg-muted rounded animate-pulse" />
                    <div className="h-3 w-1/4 bg-muted rounded animate-pulse" />
                  </div>
                </div>
              ))
            ) : docs.length === 0 ? (
              <div className="text-center py-20 text-muted-foreground">
                <FileText className="w-12 h-12 mx-auto mb-4 text-muted-foreground/30" />
                <p className="font-semibold text-foreground text-base">No documents found</p>
                <p className="text-sm mt-1.5 text-muted-foreground max-w-sm mx-auto">
                  Try adjusting your search or filters to find what you're looking for.
                </p>
              </div>
            ) : (
              docs.map((doc: Document) => {
                const isSelected = selectedIds.includes(doc.id);
                const personalDescription = getPersonalDescription(doc);
                const formatLabel = formatDocumentFileType(doc.file_name, doc.file_mime_type);
                return (
                  <div
                    key={doc.id}
                    role={selectionEnabled ? "button" : undefined}
                    tabIndex={selectionEnabled ? 0 : undefined}
                    onClick={() => {
                      if (selectionEnabled) toggleOne(doc.id);
                    }}
                    onKeyDown={(event) => {
                      if (!selectionEnabled) return;
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        toggleOne(doc.id);
                      }
                    }}
                    className={cn(
                      "group flex items-start gap-3 px-4 py-3 transition-colors hover:bg-[#F4F8FB] hover:shadow-[inset_3px_0_0_#2B86C5]",
                      selectionEnabled && "cursor-pointer",
                      isSelected && "bg-[#E6F1FB] shadow-[inset_3px_0_0_#2B86C5]",
                    )}
                  >
                    {selectionEnabled && (
                      <button
                        onClick={(event) => {
                          event.stopPropagation();
                          toggleOne(doc.id);
                        }}
                        className={cn(
                          "mt-1 transition-all",
                          isSelected ? "text-accent opacity-100" : "text-muted-foreground opacity-0 group-hover:opacity-100"
                        )}
                      >
                        {isSelected ? <CheckSquare className="w-4 h-4" /> : <Square className="w-4 h-4" />}
                      </button>
                    )}

                    {/* Thumbnail placeholder */}
                    <Link
                      to={`/documents/${doc.id}`}
                      onMouseEnter={preloadDocumentWorkspace}
                      onFocus={preloadDocumentWorkspace}
                      onClick={(event) => event.stopPropagation()}
                      className="flex h-20 w-16 flex-shrink-0 items-center justify-center border border-border bg-muted/30 text-muted-foreground transition-colors hover:border-accent/40 hover:text-accent"
                    >
                      <FileText className="h-7 w-7" />
                    </Link>

                    <div className="min-w-0 flex-1 space-y-2">
                      {/* Title + reference */}
                      <div>
                        <Link
                          to={`/documents/${doc.id}`}
                          onMouseEnter={preloadDocumentWorkspace}
                          onFocus={preloadDocumentWorkspace}
                          onClick={(event) => event.stopPropagation()}
                          className="block truncate font-semibold text-[#1E2B3A] transition-colors group-hover:text-[#0072CE]"
                        >
                          {doc.title}
                        </Link>
                        <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px]">
                          <span className="border border-[#D6DBE0] bg-[#F4F6F8] px-2 py-0.5 font-mono text-[#1E2B3A]">
                            {doc.reference_number}
                          </span>
                          <span className="font-semibold uppercase text-[#3F474F]">{formatLabel}</span>
                          {!personalOnly && !isArchiveView && (
                            <span className={cn("font-semibold", getDocumentStatusTextClass(doc.status))}>
                              {getDocumentStatusLabel(doc.status)}
                            </span>
                          )}
                        </div>
                      </div>

                      <div className="grid grid-cols-2 gap-x-5 gap-y-2 text-xs md:grid-cols-3">
                        <div>
                          <div className="text-[10px] font-semibold uppercase tracking-widest text-[#5A6470] mb-1">Uploaded</div>
                          <div className="text-[#1E2B3A]">{format(new Date(doc.created_at), "dd MMM yyyy")}</div>
                        </div>
                        <div>
                          <div className="text-[10px] font-semibold uppercase tracking-widest text-[#5A6470] mb-1">Uploaded by</div>
                          <div className="text-[#1E2B3A] truncate">{doc.uploaded_by?.full_name || doc.uploaded_by?.email || "—"}</div>
                        </div>
                      </div>

                      {personalOnly && (
                        <div className="space-y-2 pt-1">
                          {personalDescription && (
                            <p className="text-xs text-[#1E2B3A]/80 line-clamp-2">{personalDescription}</p>
                          )}
                          {doc.personal_tags?.length ? (
                            <PersonalTagChips tags={doc.personal_tags} onTagClick={handlePersonalTagClick} />
                          ) : null}
                        </div>
                      )}
                    </div>

                    <div className="flex items-center gap-1.5">
                      <Link
                        to={`/documents/${doc.id}`}
                        onMouseEnter={preloadDocumentWorkspace}
                        onFocus={preloadDocumentWorkspace}
                        onClick={(event) => event.stopPropagation()}
                        className="inline-flex items-center gap-1.5 border border-border bg-card px-2.5 py-1.5 text-xs font-medium text-foreground transition-colors hover:border-accent/40 hover:bg-accent/10 hover:text-accent"
                      >
                        <Eye className="w-3.5 h-3.5" /> View
                      </Link>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        )}

        {/* Thumbnails view (Infor-style) ────────────────────────────────────── */}
        {effectiveView === "thumbnails" && (
          <div className="p-5">
            {isLoading ? (
              <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-4">
                {Array.from({ length: 10 }).map((_, i) => (
                  <div key={i} className="border border-border rounded-lg p-3 space-y-3">
                    <div className="h-3 w-2/3 bg-muted rounded animate-pulse" />
                    <div className="aspect-[3/4] bg-muted rounded animate-pulse" />
                  </div>
                ))}
              </div>
            ) : docs.length === 0 ? (
              <div className="text-center py-20 text-muted-foreground">
                <FileText className="w-12 h-12 mx-auto mb-4 text-muted-foreground/30" />
                <p className="font-semibold text-foreground text-base">No documents found</p>
              </div>
            ) : (
              <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-4">
                {docs.map((doc: Document) => {
                  const isSelected = selectedIds.includes(doc.id);
                  return (
                    <div
                      key={doc.id}
                      className={cn(
                        "border border-border rounded-lg bg-card hover:border-accent/40 transition-colors group flex flex-col",
                        isSelected && "border-accent/60 bg-accent/5",
                      )}
                    >
                      <div className="flex items-center gap-2 px-3 py-2 border-b border-border">
                        {selectionEnabled && (
                          <button
                            onClick={() => toggleOne(doc.id)}
                            className={cn(
                              "transition-all",
                              isSelected ? "text-accent" : "text-muted-foreground hover:text-accent"
                            )}
                          >
                            {isSelected ? <CheckSquare className="w-4 h-4" /> : <Square className="w-4 h-4" />}
                          </button>
                        )}
                        <Link
                          to={`/documents/${doc.id}`}
                          onMouseEnter={preloadDocumentWorkspace}
                          onFocus={preloadDocumentWorkspace}
                          className="text-xs font-semibold text-accent truncate flex-1"
                          title={doc.title}
                        >
                          {doc.reference_number}
                        </Link>
                      </div>
                      <Link
                        to={`/documents/${doc.id}`}
                        onMouseEnter={preloadDocumentWorkspace}
                        onFocus={preloadDocumentWorkspace}
                        className="flex-1 aspect-[3/4] flex items-center justify-center bg-muted/20 text-muted-foreground group-hover:text-accent transition-colors"
                      >
                        <FileText className="w-12 h-12" />
                      </Link>
                      <div className="px-3 py-2 text-[11px] text-muted-foreground truncate" title={doc.title}>
                        {doc.title}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {/* Pagination */}
        {data && data.count > PAGE_SIZE && (
          <div className="flex items-center justify-between px-5 py-3 border-t border-[#D6DBE0] bg-[#F4F6F8]">
            <span className="text-xs text-muted-foreground">
              Showing <span className="font-semibold text-foreground">{Math.min((page - 1) * PAGE_SIZE + 1, data.count)}</span>–
              <span className="font-semibold text-foreground">{Math.min(page * PAGE_SIZE, data.count)}</span> of {data.count.toLocaleString()}
            </span>
            <div className="flex gap-2">
              <button
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                disabled={page === 1}
                className="px-4 py-1.5 text-xs font-medium bg-card border border-border rounded-lg hover:bg-muted disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              >
                Previous
              </button>
              <button
                onClick={() => setPage((p) => p + 1)}
                disabled={page * PAGE_SIZE >= data.count}
                className="px-4 py-1.5 text-xs font-medium bg-card border border-border rounded-lg hover:bg-muted disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              >
                Next
              </button>
            </div>
          </div>
        )}

        {/* Layout switcher (Infor-style icons, bottom-right) ───────────────── */}
        {showLayoutSwitcher && (
          <div className="flex items-center justify-end gap-1 px-3 py-2 border-t border-[#D6DBE0] bg-[#F4F6F8]">
            <span className="text-[10px] font-semibold uppercase tracking-widest text-[#5A6470] mr-2">
              Layout
            </span>
            {([
              { id: "table" as const, icon: Rows3, label: "List" },
              { id: "card" as const, icon: LayoutList, label: "Card" },
              { id: "thumbnails" as const, icon: LayoutGrid, label: "Thumbnails" },
            ]).map(({ id, icon: Icon, label }) => (
              <button
                key={id}
                type="button"
                title={label}
                aria-label={`Switch to ${label} view`}
                aria-pressed={effectiveView === id}
                onClick={() => setViewMode(id)}
                className={cn(
                  "p-1.5 rounded-sm transition-colors",
                  effectiveView === id
                    ? "bg-[#0072CE] text-white"
                    : "text-[#5A6470] hover:text-[#1E2B3A] hover:bg-[#E6EAEE]",
                )}
              >
                <Icon className="w-4 h-4" />
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
