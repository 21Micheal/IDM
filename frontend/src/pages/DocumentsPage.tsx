/**
 * pages/DocumentsPage.tsx
 *
 * Indigo Vault redesign:
 *  - Semantic HSL tokens throughout
 *  - StatusBadge with dot+pill color coding
 *  - Reusable workflow/all and personal-only document library modes
 *  - Workflow filters stay out of the personal document library
 */

import { useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { documentsAPI, documentTypesAPI, normalizeListResponse } from "@/services/api";
import {
  FileText, UploadCloud, Lock, Users, LayoutList,
  Archive, Trash2, Loader2, CheckSquare, Square, X, CheckCircle, XCircle,
  Search as SearchIcon, SlidersHorizontal, Eye,
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
type BulkAction = "approve" | "reject" | "archive" | "void";
type Tab = "all" | "workflow";

const TABS: { id: Tab; label: string; icon: React.ReactNode; tip: string }[] = [
  { id: "all",       label: "All Documents", icon: <LayoutList className="w-4 h-4" />, tip: "Every workflow document you have access to" },
  { id: "workflow",  label: "Workflow",      icon: <Users className="w-4 h-4" />,      tip: "Documents going through an approval process" },
];

const STATUS_OPTIONS = ["draft", "pending_approval", "approved", "rejected", "archived", "void"];

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

interface DocumentsPageProps {
  personalOnly?: boolean;
}

export default function DocumentsPage({ personalOnly = false }: DocumentsPageProps) {
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const statusFromUrl = searchParams.get("status");
  const normalizedStatusFromUrl = STATUS_OPTIONS.includes(statusFromUrl ?? "") ? (statusFromUrl ?? "") : "";
  const isArchiveView = normalizedStatusFromUrl === "archived";

  const [activeTab, setActiveTab] = useState<Tab>("workflow");
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState(normalizedStatusFromUrl);
  const [typeFilter, setTypeFilter] = useState("");
  const [supplierFilter, setSupplierFilter] = useState("");
  const [personalTagFilter, setPersonalTagFilter] = useState("");
  const [sort, setSort] = useState<"created_at" | "document_date" | "amount" | "title" | "reference_number">("created_at");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const [page, setPage] = useState(1);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [showFilters, setShowFilters] = useState(false);

  const debouncedSearch = useDebounce(search, 300);

  useEffect(() => {
    setStatusFilter(normalizedStatusFromUrl);
    if (normalizedStatusFromUrl) {
      setActiveTab(normalizedStatusFromUrl === "archived" ? "all" : "workflow");
    }
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
    queryKey: ["documents", activeTab, params],
    queryFn: () => documentsAPI.list(params),
    select: (r) => r.data,
    ...QUERY_SHORT_STALE,
    staleTime: personalOnly ? 0 : QUERY_SHORT_STALE.staleTime,
    refetchOnMount: personalOnly ? "always" : true,
  });

  const docs = data?.results ?? [];
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
        queryKey: ["documents", activeTab, { ...baseParams, page: page + 1 }],
        queryFn: () => documentsAPI.list({ ...baseParams, page: page + 1 }),
        staleTime: 30_000,
      });
    }
    if (page > 1) {
      queryClient.prefetchQuery({
        queryKey: ["documents", activeTab, { ...baseParams, page: page - 1 }],
        queryFn: () => documentsAPI.list({ ...baseParams, page: page - 1 }),
        staleTime: 30_000,
      });
    }
  }, [data?.count, queryClient, activeTab, debouncedSearch, statusFilter, typeFilter, supplierFilter, sort, sortDir, page, personalTagFilter, isArchiveView, personalOnly]);

  const archiveMutation = useMutation({
    mutationFn: (id: string) => documentsAPI.archive(id),
    onSuccess: () => {
      toast.success("Document archived.");
      queryClient.invalidateQueries({ queryKey: ["documents"] });
    },
    onError: () => toast.error("Could not archive document."),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => documentsAPI.delete(id),
    onSuccess: () => {
      toast.success("Document deleted.");
      queryClient.invalidateQueries({ queryKey: ["documents"] });
    },
    onError: () => toast.error("Could not delete document."),
  });

  const bulkMutation = useMutation({
    mutationFn: ({ action, comment }: { action: BulkAction; comment?: string }) =>
      documentsAPI.bulkAction(selectedIds, action, comment),
    onSuccess: () => {
      toast.success("Bulk action completed successfully");
      setSelectedIds([]);
      queryClient.invalidateQueries({ queryKey: ["documents"] });
    },
    onError: () => toast.error("Bulk action failed"),
  });

  const switchTab = (tab: Tab) => {
    clearUrlStatusFilter();
    setActiveTab(tab);
    setSearch("");
    setStatusFilter("");
    setTypeFilter("");
    setSupplierFilter("");
    setPersonalTagFilter("");
    setPage(1);
    setSelectedIds([]);
  };

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
        }, ["approve", "reject", "archive", "void"] as BulkAction[])
    : [];

  const totalCols = personalOnly
    ? 7 // Reference, name, description, tags, uploaded, uploaded by, actions
    : 5 + (selectionEnabled ? 1 : 0) + (!isArchiveView ? 1 : 0);

  const activeFilterCount = personalOnly
    ? 0
    : [statusFilter, typeFilter, supplierFilter].filter(Boolean).length;

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

      {/* Tabs */}
      {!isArchiveView && !personalOnly && (
        <div className="flex items-end gap-0.5 border-b border-border">
          {TABS.map((tab) => (
            <button
              key={tab.id}
              title={tab.tip}
              onClick={() => switchTab(tab.id)}
              className={cn(
                "inline-flex items-center gap-2 px-5 py-2.5 text-sm font-medium rounded-t-lg border border-transparent transition-all -mb-px",
                activeTab === tab.id
                  ? "border-border border-b-card bg-card text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground hover:bg-muted/50"
              )}
            >
              {tab.icon}
              {tab.label}
            </button>
          ))}
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

      {/* Table */}
      <div
        className={cn(
          "bg-card border border-border rounded-xl overflow-hidden",
          isArchiveView && "border-muted-foreground/20 bg-muted/10"
        )}
        style={{ boxShadow: "var(--shadow-card)" }}
      >
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-muted/30">
                {selectionEnabled && (
                  <th className="px-4 py-3 w-12">
                    <button onClick={toggleAll} className="text-muted-foreground hover:text-accent transition-colors">
                      {allChecked
                        ? <CheckSquare className="w-4.5 h-4.5 text-accent" />
                        : <Square className="w-4.5 h-4.5" />}
                    </button>
                  </th>
                )}
                <th className="text-left px-4 py-3 font-semibold text-[11px] uppercase tracking-wider text-muted-foreground">Reference</th>
                <th className="text-left px-4 py-3 font-semibold text-[11px] uppercase tracking-wider text-muted-foreground">Document Name</th>

                {personalOnly && (
                  <>
                    <th className="text-left px-4 py-3 font-semibold text-[11px] uppercase tracking-wider text-muted-foreground">Description</th>
                    <th className="text-left px-4 py-3 font-semibold text-[11px] uppercase tracking-wider text-muted-foreground">Tags</th>
                  </>
                )}

                {!personalOnly && !isArchiveView && (
                  <th className="text-left px-4 py-3 font-semibold text-[11px] uppercase tracking-wider text-muted-foreground">Status</th>
                )}

                <th className="text-left px-4 py-3 font-semibold text-[11px] uppercase tracking-wider text-muted-foreground">Uploaded</th>
                <th className="text-left px-4 py-3 font-semibold text-[11px] uppercase tracking-wider text-muted-foreground">Uploaded By</th>

                <th className="text-right px-4 py-3 font-semibold text-[11px] uppercase tracking-wider text-muted-foreground">Actions</th>
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
                            className="text-muted-foreground hover:text-accent transition-colors"
                          >
                            {isSelected
                              ? <CheckSquare className="w-4.5 h-4.5 text-accent" />
                              : <Square className="w-4.5 h-4.5" />}
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
                        </div>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>

        {/* Pagination */}
        {data && data.count > PAGE_SIZE && (
          <div className="flex items-center justify-between px-5 py-3 border-t border-border bg-muted/20">
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
      </div>
    </div>
  );
}
