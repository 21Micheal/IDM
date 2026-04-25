/**
 * pages/DocumentsPage.tsx
 *
 * Indigo Vault redesign:
 *  - Semantic HSL tokens throughout
 *  - StatusBadge with dot+pill color coding
 *  - Selection checkboxes hidden on "My Documents" tab (actions live in row)
 */

import { useState } from "react";
import { Link } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { documentsAPI, documentTypesAPI, normalizeListResponse } from "@/services/api";
import {
  FileText, UploadCloud, Lock, Users, LayoutList,
  Archive, Trash2, Loader2, CheckSquare, Square, X, CheckCircle, XCircle,
  Search as SearchIcon,
} from "lucide-react";
import { format } from "date-fns";
import { cn } from "../lib/utils";
import { useDebounce } from "../hooks/useDebounce";
import { toast } from "react-toastify";
import type { Document } from "@/types";
import StatusBadge from "@/components/documents/StatusBadge";

const PAGE_SIZE = 25;
type BulkAction = "approve" | "reject" | "archive" | "void";
type Tab = "all" | "workflow" | "personal";

const TABS: { id: Tab; label: string; icon: React.ReactNode; tip: string }[] = [
  { id: "all",       label: "All Documents", icon: <LayoutList className="w-4 h-4" />, tip: "Every document you have access to" },
  { id: "workflow",  label: "Workflow",      icon: <Users className="w-4 h-4" />,      tip: "Documents going through an approval process" },
  { id: "personal",  label: "My Documents",  icon: <Lock className="w-4 h-4" />,       tip: "Your personal uploads — visible only to you and admins" },
];

const STATUS_OPTIONS = ["draft", "pending_approval", "approved", "rejected", "archived", "void"];

// ── Bulk Toolbar ────────────────────────────────────────────────────────────
function BulkToolbar({
  selectedIds, onAction, onClear, isLoading,
}: {
  selectedIds: string[];
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
        className="sticky top-0 z-10 rounded-xl border border-border bg-card px-5 py-3 flex items-center gap-3 flex-wrap"
        style={{ boxShadow: "var(--shadow-card)" }}
      >
        <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-primary/10 text-primary text-sm font-semibold">
          <span className="w-1.5 h-1.5 rounded-full bg-primary" />
          {selectedIds.length} selected
        </div>

        <div className="flex flex-wrap gap-2">
          <button
            onClick={() => onAction("approve")}
            disabled={isLoading}
            className="inline-flex items-center gap-2 px-4 py-1.5 text-sm font-medium bg-teal text-teal-foreground rounded-lg hover:opacity-90 disabled:opacity-50 transition-opacity"
          >
            {isLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle className="w-4 h-4" />}
            Approve
          </button>

          <button
            onClick={() => setRejectModal(true)}
            disabled={isLoading}
            className="inline-flex items-center gap-2 px-4 py-1.5 text-sm font-medium bg-destructive text-destructive-foreground rounded-lg hover:opacity-90 disabled:opacity-50 transition-opacity"
          >
            <XCircle className="w-4 h-4" /> Reject
          </button>

          <button
            onClick={() => onAction("archive")}
            disabled={isLoading}
            className="inline-flex items-center gap-2 px-4 py-1.5 text-sm font-medium bg-primary text-primary-foreground rounded-lg hover:opacity-90 disabled:opacity-50 transition-opacity"
          >
            <Archive className="w-4 h-4" /> Archive
          </button>

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
            ? "border-primary/20 bg-primary/10 text-primary hover:border-primary/30 hover:bg-primary/15"
            : "border-primary/20 bg-primary/10 text-primary",
        );

        if (onTagClick) {
          return (
            <button
              key={tag}
              type="button"
              onClick={() => onTagClick(tag)}
              className={chipClassName}
              aria-label={`Filter by personal tag ${tag}`}
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

export default function DocumentsPage() {
  const queryClient = useQueryClient();

  const [activeTab, setActiveTab] = useState<Tab>("workflow");
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [typeFilter, setTypeFilter] = useState("");
  const [personalTagFilter, setPersonalTagFilter] = useState("");
  const [sort, setSort] = useState<"created_at" | "document_date" | "amount" | "title" | "reference_number">("created_at");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const [page, setPage] = useState(1);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);

  const debouncedSearch = useDebounce(search, 300);

  const { data: typesData } = useQuery<unknown, Error, unknown[]>({
    queryKey: ["document-types"],
    queryFn: () => documentTypesAPI.list().then((r) => r.data as unknown),
    select: (data) => normalizeListResponse(data),
  });

  const params: Record<string, unknown> = {
    search: debouncedSearch || undefined,
    status: statusFilter || undefined,
    document_type: typeFilter || undefined,
    ordering: `${sortDir === "desc" ? "-" : ""}${sort}`,
    page,
    page_size: PAGE_SIZE,
  };

  if (activeTab === "workflow") params.is_self_upload = false;
  if (activeTab === "personal") params.is_self_upload = true;
  if (activeTab === "personal" && personalTagFilter) params.personal_tag = personalTagFilter;

  const { data, isLoading } = useQuery({
    queryKey: ["documents", activeTab, params],
    queryFn: () => documentsAPI.list(params),
    select: (r) => r.data,
    placeholderData: (prev) => prev,
  });

  const docs = data?.results ?? [];

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
    setActiveTab(tab);
    setSearch("");
    setStatusFilter("");
    setTypeFilter("");
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
    setActiveTab("personal");
    setSearch("");
    setStatusFilter("");
    setTypeFilter("");
    setPersonalTagFilter((prev) => (prev === tag ? "" : tag));
    setPage(1);
    setSelectedIds([]);
  };

  const allChecked = docs.length > 0 && docs.every((d: Document) => selectedIds.includes(d.id));
  const personalTagOptions = Array.from(new Set(
    [...docs.flatMap((doc: Document) => doc.personal_tags ?? []), personalTagFilter].filter(Boolean)
  )).sort((a, b) => a.localeCompare(b));

  // Selection only on All & Workflow tabs (Personal has inline row actions)
  const selectionEnabled = activeTab !== "personal";
  const showBulkToolbar = selectionEnabled && selectedIds.length > 0;

  // Column count helpers — keeps colSpan correct
  const baseCols = 7; // ref, title, type, supplier, amount, date, uploaded
  const totalCols =
    baseCols +
    (selectionEnabled ? 1 : 0) +     // checkbox column
    (activeTab !== "personal" ? 1 : 0) + // status column
    (activeTab === "personal" ? 1 : 0);  // actions column

  return (
    <div className="p-6 max-w-7xl mx-auto space-y-6">

      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-foreground tracking-tight">Documents</h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            Browse, filter, and act on every document in your vault.
          </p>
        </div>
        <Link
          to="/documents/upload"
          className="inline-flex items-center gap-2 px-4 py-2 bg-primary hover:opacity-90 text-primary-foreground text-sm font-medium rounded-lg transition-opacity"
          style={{ boxShadow: "var(--shadow-card)" }}
        >
          <UploadCloud className="w-4 h-4" /> Upload
        </Link>
      </div>

      {/* Tabs */}
      <div className="flex items-end gap-1 border-b border-border">
        {TABS.map((tab) => (
          <button
            key={tab.id}
            title={tab.tip}
            onClick={() => switchTab(tab.id)}
            className={cn(
              "inline-flex items-center gap-2 px-5 py-2.5 text-sm font-medium rounded-t-lg border border-transparent transition-colors -mb-px",
              activeTab === tab.id
                ? "border-border border-b-card bg-card text-primary"
                : "text-muted-foreground hover:text-foreground hover:bg-muted/50"
            )}
          >
            {tab.icon}
            {tab.label}
          </button>
        ))}
      </div>

      {/* Personal tab explainer */}
      {activeTab === "personal" && (
        <div className="flex items-start gap-3 rounded-xl border border-primary/20 bg-primary/5 px-4 py-3 text-sm text-foreground">
          <Lock className="w-4 h-4 mt-0.5 flex-shrink-0 text-primary" />
          <span>
            These documents are private to you. They are not part of any approval workflow and are visible only to you and administrators.
          </span>
        </div>
      )}

      {activeTab === "personal" && personalTagOptions.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mr-2">Filter by tag</span>
          <button
            type="button"
            onClick={() => setPersonalTagFilter("")}
            className={cn(
              "px-3 py-1.5 rounded-full text-xs font-medium border transition-colors",
              !personalTagFilter
                ? "bg-primary text-primary-foreground border-primary"
                : "bg-card text-muted-foreground border-border hover:text-foreground hover:border-primary/40",
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
                  ? "bg-primary text-primary-foreground border-primary"
                  : "bg-card text-muted-foreground border-border hover:text-foreground hover:border-primary/40",
              )}
            >
              {tag}
            </button>
          ))}
        </div>
      )}

      {/* Filters */}
      <div className="flex flex-wrap gap-3 items-center">
        <div className="relative">
          <SearchIcon className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground pointer-events-none" />
          <input
            value={search}
            onChange={(e) => { setSearch(e.target.value); setPage(1); }}
            placeholder="Search…"
            className="w-64 text-sm bg-card border border-border rounded-lg pl-9 pr-3 py-2 focus:outline-none focus:ring-2 focus:ring-primary/40 focus:border-primary transition-colors"
          />
        </div>

        {activeTab !== "personal" && (
          <select
            value={statusFilter}
            onChange={(e) => { setStatusFilter(e.target.value); setPage(1); }}
            className="text-sm bg-card border border-border rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-primary/40 focus:border-primary transition-colors"
          >
            <option value="">All statuses</option>
            {STATUS_OPTIONS.map((s) => (
              <option key={s} value={s}>{s.replace(/_/g, " ")}</option>
            ))}
          </select>
        )}

        <select
          value={typeFilter}
          onChange={(e) => { setTypeFilter(e.target.value); setPage(1); }}
          className="text-sm bg-card border border-border rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-primary/40 focus:border-primary transition-colors"
        >
          <option value="">All types</option>
          {(typesData ?? []).map((t: any) => (
            <option key={t.id} value={t.id}>{t.name}</option>
          ))}
        </select>

        {data && (
          <span className="ml-auto text-sm text-muted-foreground self-center">
            <span className="font-semibold text-foreground">{data.count.toLocaleString()}</span> document{data.count !== 1 ? "s" : ""}
          </span>
        )}
      </div>

      {/* Bulk Toolbar */}
      {showBulkToolbar && (
        <BulkToolbar
          selectedIds={selectedIds}
          onAction={(action, comment) => bulkMutation.mutate({ action, comment })}
          onClear={() => setSelectedIds([])}
          isLoading={bulkMutation.isPending}
        />
      )}

      {/* Table */}
      <div
        className="bg-card border border-border rounded-xl overflow-hidden"
        style={{ boxShadow: "var(--shadow-card)" }}
      >
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-muted/40">
                {selectionEnabled && (
                  <th className="px-6 py-3.5 w-12">
                    <button onClick={toggleAll} className="text-muted-foreground hover:text-primary transition-colors">
                      {allChecked
                        ? <CheckSquare className="w-5 h-5 text-primary" />
                        : <Square className="w-5 h-5" />}
                    </button>
                  </th>
                )}
                <th className="text-left px-6 py-3.5 font-semibold text-xs uppercase tracking-wider text-muted-foreground">Reference</th>
                <th className="text-left px-6 py-3.5 font-semibold text-xs uppercase tracking-wider text-muted-foreground">Title</th>
                <th className="text-left px-6 py-3.5 font-semibold text-xs uppercase tracking-wider text-muted-foreground">Type</th>
                <th className="text-left px-6 py-3.5 font-semibold text-xs uppercase tracking-wider text-muted-foreground">Supplier</th>
                <th className="text-right px-6 py-3.5 font-semibold text-xs uppercase tracking-wider text-muted-foreground">Amount</th>
                <th className="text-left px-6 py-3.5 font-semibold text-xs uppercase tracking-wider text-muted-foreground">Date</th>

                {activeTab !== "personal" && (
                  <th className="text-left px-6 py-3.5 font-semibold text-xs uppercase tracking-wider text-muted-foreground">Status</th>
                )}

                <th className="text-left px-6 py-3.5 font-semibold text-xs uppercase tracking-wider text-muted-foreground">Uploaded</th>

                {activeTab === "personal" && (
                  <th className="text-right px-6 py-3.5 font-semibold text-xs uppercase tracking-wider text-muted-foreground">Actions</th>
                )}
              </tr>
            </thead>

            <tbody className="divide-y divide-border">
              {isLoading ? (
                Array.from({ length: 8 }).map((_, i) => (
                  <tr key={i}>
                    {Array.from({ length: totalCols }).map((_, j) => (
                      <td key={j} className="px-6 py-4">
                        <div className="h-4 bg-muted rounded animate-pulse" />
                      </td>
                    ))}
                  </tr>
                ))
              ) : docs.length === 0 ? (
                <tr>
                  <td colSpan={totalCols} className="text-center py-16 text-muted-foreground">
                    <FileText className="w-10 h-10 mx-auto mb-3 text-muted-foreground/50" />
                    <p className="font-medium text-foreground">No documents found</p>
                    <p className="text-xs mt-1">Try adjusting your search or filters.</p>
                  </td>
                </tr>
              ) : (
                docs.map((doc: Document) => {
                  const isSelected = selectedIds.includes(doc.id);
                  const isPersonal = doc.is_self_upload === true;

                  return (
                    <tr
                      key={doc.id}
                      className={cn(
                        "hover:bg-muted/40 transition-colors group",
                        isSelected && "bg-primary/5",
                        isPersonal && activeTab === "all" && !isSelected && "bg-primary/[0.03]"
                      )}
                    >
                      {selectionEnabled && (
                        <td className="px-6 py-4">
                          <button
                            onClick={() => toggleOne(doc.id)}
                            className="text-muted-foreground hover:text-primary transition-colors"
                          >
                            {isSelected
                              ? <CheckSquare className="w-5 h-5 text-primary" />
                              : <Square className="w-5 h-5" />}
                          </button>
                        </td>
                      )}

                      <td className="px-6 py-4">
                        <div className="flex items-center gap-2">
                          <Link
                            to={`/documents/${doc.id}`}
                            className="font-mono text-xs bg-muted text-foreground px-2 py-0.5 rounded hover:bg-primary/10 hover:text-primary transition-colors"
                          >
                            {doc.reference_number}
                          </Link>
                          {activeTab === "all" && isPersonal && (
                            <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[10px] font-semibold bg-primary/10 text-primary border border-primary/20">
                              <Lock className="w-2.5 h-2.5" />
                              Personal
                            </span>
                          )}
                        </div>
                      </td>

                      <td className="px-6 py-4">
                        <div className="space-y-1">
                          <Link
                            to={`/documents/${doc.id}`}
                            className="text-foreground group-hover:text-primary font-medium truncate block transition-colors"
                          >
                            {doc.title}
                          </Link>
                          {isPersonal && doc.personal_tags?.length ? (
                            <PersonalTagChips
                              tags={doc.personal_tags}
                              onTagClick={handlePersonalTagClick}
                            />
                          ) : null}
                        </div>
                      </td>

                      <td className="px-6 py-4 text-muted-foreground whitespace-nowrap">
                        {doc.document_type_name || "—"}
                      </td>

                      <td className="px-6 py-4 text-foreground/80 max-w-[8rem] truncate">
                        {doc.supplier || "—"}
                      </td>

                      <td className="px-6 py-4 text-foreground whitespace-nowrap font-semibold tabular-nums">
                        {doc.amount
                          ? `${Number(doc.amount).toLocaleString(undefined, { minimumFractionDigits: 2 })} ${doc.currency || "USD"}`
                          : "—"}
                      </td>

                      <td className="px-6 py-4 text-muted-foreground whitespace-nowrap">
                        {doc.document_date ? format(new Date(doc.document_date), "dd MMM yyyy") : "—"}
                      </td>

                      {activeTab !== "personal" && (
                        <td className="px-6 py-4">
                          <StatusBadge status={doc.status} />
                        </td>
                      )}

                      <td className="px-6 py-4 text-muted-foreground whitespace-nowrap text-xs">
                        {format(new Date(doc.created_at), "dd MMM yyyy")}
                      </td>

                      {activeTab === "personal" && (
                        <td className="px-6 py-4">
                          <div className="flex items-center justify-end gap-1.5 opacity-0 group-hover:opacity-100 transition-opacity">
                            {!["archived", "void"].includes(doc.status) && (
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
                            <button
                              title="Delete"
                              onClick={() => {
                                if (window.confirm("Delete this personal document? This cannot be undone.")) deleteMutation.mutate(doc.id);
                              }}
                              className="p-1.5 rounded-md text-muted-foreground hover:bg-destructive/10 hover:text-destructive transition-colors"
                            >
                              <Trash2 className="w-4 h-4" />
                            </button>
                          </div>
                        </td>
                      )}
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
                className="px-3 py-1.5 text-xs bg-card border border-border rounded-lg hover:bg-muted disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              >
                Previous
              </button>
              <button
                onClick={() => setPage((p) => p + 1)}
                disabled={page * PAGE_SIZE >= data.count}
                className="px-3 py-1.5 text-xs bg-card border border-border rounded-lg hover:bg-muted disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
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
