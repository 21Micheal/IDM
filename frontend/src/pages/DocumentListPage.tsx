/**
 * pages/DocumentListPage.tsx
 *
 * Changes from previous version
 * ──────────────────────────────
 * 1. Three-tab layout: "All Documents" | "Workflow" | "My Documents"
 *    - All:       no is_self_upload filter (admin/auditor view of everything)
 *    - Workflow:  is_self_upload=false  (approval queue; hides personal docs)
 *    - Personal:  is_self_upload=true   (uploader's own private documents)
 *
 * 2. Self-upload rows in the "All" tab get a subtle Lock pill so admins can
 *    tell at a glance which documents are personal vs. workflow.
 *
 * 3. "My Documents" tab replaces the Status column with an "Actions" column
 *    showing Archive and Delete quick-actions (no Submit button — personal
 *    docs cannot enter a workflow).
 *
 * 4. Filters and pagination reset when switching tabs.
 *
 * 5. Empty states are tab-aware.
 */
import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import {
  FileText, UploadCloud, SortAsc, SortDesc, Lock, Users, LayoutList,
  Archive, Trash2,
} from "lucide-react";
import { documentsAPI, documentTypesAPI } from "../services/api";
import { format } from "date-fns";
import { cn } from "../lib/utils";
import { useDebounce } from "../hooks/useDebounce";
import { toast } from "react-toastify";

// ── Status badge styles ────────────────────────────────────────────────────────

const STATUS_STYLES: Record<string, string> = {
  draft:            "bg-slate-100 text-slate-600",
  pending_review:   "bg-yellow-100 text-yellow-700",
  pending_approval: "bg-blue-100 text-blue-700",
  approved:         "bg-green-100 text-green-700",
  rejected:         "bg-red-100 text-red-700",
  archived:         "bg-slate-100 text-slate-400",
  void:             "bg-red-50 text-red-400",
};

// ── Types ──────────────────────────────────────────────────────────────────────

type SortField =
  | "created_at"
  | "document_date"
  | "amount"
  | "title"
  | "reference_number";

type Tab = "all" | "workflow" | "personal";

const TABS: { id: Tab; label: string; icon: React.ReactNode; tip: string }[] = [
  {
    id: "all",
    label: "All Documents",
    icon: <LayoutList className="w-4 h-4" />,
    tip: "Every document you have access to",
  },
  {
    id: "workflow",
    label: "Workflow",
    icon: <Users className="w-4 h-4" />,
    tip: "Documents going through an approval process",
  },
  {
    id: "personal",
    label: "My Documents",
    icon: <Lock className="w-4 h-4" />,
    tip: "Your personal uploads — visible only to you and admins",
  },
];

// ── SortIcon helper ────────────────────────────────────────────────────────────

function SortIcon({
  field,
  sort,
  sortDir,
}: {
  field: SortField;
  sort: SortField;
  sortDir: "asc" | "desc";
}) {
  if (sort !== field) return null;
  return sortDir === "desc" ? (
    <SortDesc className="w-3.5 h-3.5 inline ml-1" />
  ) : (
    <SortAsc className="w-3.5 h-3.5 inline ml-1" />
  );
}

// ── DocumentListPage ───────────────────────────────────────────────────────────

export default function DocumentListPage() {
  const queryClient = useQueryClient();

  const [activeTab, setActiveTab] = useState<Tab>("workflow");
  const [search, setSearch]       = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [typeFilter, setTypeFilter]     = useState("");
  const [sort, setSort]           = useState<SortField>("created_at");
  const [sortDir, setSortDir]     = useState<"asc" | "desc">("desc");
  const [page, setPage]           = useState(1);

  const debouncedSearch = useDebounce(search, 300);

  // ── Document types for the filter dropdown ─────────────────────────────────
  const { data: typesData } = useQuery({
    queryKey: ["document-types"],
    queryFn: () => documentTypesAPI.list(),
    select: (r) => (r.data.results ?? r.data) as any[],
  });

  // ── Build query params driven by active tab ────────────────────────────────
  const params: Record<string, unknown> = {
    search:        debouncedSearch || undefined,
    status:        statusFilter || undefined,
    document_type: typeFilter || undefined,
    ordering:      `${sortDir === "desc" ? "-" : ""}${sort}`,
    page,
    page_size:     25,
  };

  if (activeTab === "workflow") params.is_self_upload = false;
  if (activeTab === "personal") params.is_self_upload = true;

  const { data, isLoading } = useQuery({
    queryKey: ["documents", params],
    queryFn: () => documentsAPI.list(params),
    select: (r) => r.data,
    placeholderData: (prev) => prev,
  });

  const docs = data?.results ?? [];

  // ── Quick-action mutations (My Documents tab) ──────────────────────────────
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

  // ── Tab switch — reset filters & pagination ────────────────────────────────
  const switchTab = (tab: Tab) => {
    setActiveTab(tab);
    setSearch("");
    setStatusFilter("");
    setTypeFilter("");
    setPage(1);
  };

  // ── Sort handler ───────────────────────────────────────────────────────────
  const handleSort = (field: SortField) => {
    if (sort === field) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else { setSort(field); setSortDir("desc"); }
    setPage(1);
  };

  // ── Column definitions (vary by tab) ──────────────────────────────────────
  type ColDef = { label: string; field: SortField | null };
  const workflowColumns: ColDef[] = [
    { label: "Reference",  field: "reference_number" },
    { label: "Title",      field: "title"            },
    { label: "Type",       field: null               },
    { label: "Supplier",   field: null               },
    { label: "Amount",     field: "amount"           },
    { label: "Date",       field: "document_date"    },
    { label: "Status",     field: null               },
    { label: "Uploaded",   field: "created_at"       },
  ];
  const personalColumns: ColDef[] = [
    { label: "Reference",  field: "reference_number" },
    { label: "Title",      field: "title"            },
    { label: "Type",       field: null               },
    { label: "Supplier",   field: null               },
    { label: "Amount",     field: "amount"           },
    { label: "Date",       field: "document_date"    },
    { label: "Uploaded",   field: "created_at"       },
    { label: "Actions",    field: null               },
  ];
  const allColumns: ColDef[] = [
    { label: "Reference",  field: "reference_number" },
    { label: "Title",      field: "title"            },
    { label: "Type",       field: null               },
    { label: "Supplier",   field: null               },
    { label: "Amount",     field: "amount"           },
    { label: "Date",       field: "document_date"    },
    { label: "Status",     field: null               },
    { label: "Uploaded",   field: "created_at"       },
  ];

  const columns =
    activeTab === "personal"
      ? personalColumns
      : activeTab === "all"
      ? allColumns
      : workflowColumns;

  const colSpan = columns.length;

  // ── Empty state copy ───────────────────────────────────────────────────────
  const emptyMessages: Record<Tab, { heading: string; sub: string }> = {
    all: {
      heading: "No documents found",
      sub: "Try adjusting your search or filters.",
    },
    workflow: {
      heading: "No workflow documents found",
      sub: "Upload a document to start the approval process.",
    },
    personal: {
      heading: "No personal documents yet",
      sub: "Upload a document and toggle \"Personal document\" to save it here.",
    },
  };

  return (
    <div className="p-6 max-w-7xl mx-auto space-y-5">

      {/* ── Header ──────────────────────────────────────────────────────────── */}
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold text-slate-900">Documents</h1>
        <Link
          to="/documents/upload"
          className="inline-flex items-center gap-2 px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-medium rounded-lg transition-colors"
        >
          <UploadCloud className="w-4 h-4" /> Upload
        </Link>
      </div>

      {/* ── Tabs ────────────────────────────────────────────────────────────── */}
      <div className="flex items-end gap-1 border-b border-slate-200">
        {TABS.map((tab) => (
          <button
            key={tab.id}
            title={tab.tip}
            onClick={() => switchTab(tab.id)}
            className={cn(
              "inline-flex items-center gap-2 px-4 py-2.5 text-sm font-medium rounded-t-lg border border-transparent transition-colors -mb-px",
              activeTab === tab.id
                ? "border-slate-200 border-b-white bg-white text-indigo-600"
                : "text-slate-500 hover:text-slate-700 hover:bg-slate-50"
            )}
          >
            {tab.icon}
            {tab.label}
            {/* Live count badge */}
            {activeTab === tab.id && data && (
              <span className="ml-1 inline-flex items-center justify-center px-1.5 py-0.5 text-xs font-semibold rounded-full bg-indigo-100 text-indigo-700">
                {data.count.toLocaleString()}
              </span>
            )}
          </button>
        ))}
      </div>

      {/* ── Filters ─────────────────────────────────────────────────────────── */}
      <div className="flex flex-wrap gap-3 items-center">
        <input
          value={search}
          onChange={(e) => { setSearch(e.target.value); setPage(1); }}
          placeholder="Search…"
          className="w-60 text-sm border border-slate-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-indigo-500"
        />

        {/* Status filter — hidden in personal tab (all personal docs use draft by default) */}
        {activeTab !== "personal" && (
          <select
            value={statusFilter}
            onChange={(e) => { setStatusFilter(e.target.value); setPage(1); }}
            className="text-sm border border-slate-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-indigo-500"
          >
            <option value="">All statuses</option>
            {Object.keys(STATUS_STYLES).map((s) => (
              <option key={s} value={s}>
                {s.replace(/_/g, " ")}
              </option>
            ))}
          </select>
        )}

        <select
          value={typeFilter}
          onChange={(e) => { setTypeFilter(e.target.value); setPage(1); }}
          className="text-sm border border-slate-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-indigo-500"
        >
          <option value="">All types</option>
          {(typesData ?? []).map((t: any) => (
            <option key={t.id} value={t.id}>{t.name}</option>
          ))}
        </select>

        {data && (
          <span className="ml-auto text-sm text-slate-500 self-center">
            {data.count.toLocaleString()} document
            {data.count !== 1 ? "s" : ""}
          </span>
        )}
      </div>

      {/* ── Personal tab explainer banner ───────────────────────────────────── */}
      {activeTab === "personal" && (
        <div className="flex items-start gap-3 rounded-xl border border-indigo-100 bg-indigo-50 px-4 py-3 text-sm text-indigo-800">
          <Lock className="w-4 h-4 mt-0.5 flex-shrink-0 text-indigo-500" />
          <span>
            These documents are private to you. They are not part of any
            approval workflow and are visible only to you and administrators.
          </span>
        </div>
      )}

      {/* ── Table ───────────────────────────────────────────────────────────── */}
      <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-100 bg-slate-50">
                {columns.map(({ label, field }) => (
                  <th
                    key={label}
                    onClick={field ? () => handleSort(field) : undefined}
                    className={cn(
                      "px-4 py-3 text-left text-xs font-semibold text-slate-500 uppercase tracking-wider whitespace-nowrap",
                      field && "cursor-pointer hover:text-slate-700"
                    )}
                  >
                    {label}
                    {field && (
                      <SortIcon field={field} sort={sort} sortDir={sortDir} />
                    )}
                  </th>
                ))}
              </tr>
            </thead>

            <tbody className="divide-y divide-slate-100">
              {isLoading ? (
                // Skeleton rows
                [...Array(8)].map((_, i) => (
                  <tr key={i}>
                    {[...Array(colSpan)].map((_, j) => (
                      <td key={j} className="px-4 py-3">
                        <div className="h-4 bg-slate-100 rounded animate-pulse" />
                      </td>
                    ))}
                  </tr>
                ))
              ) : docs.length === 0 ? (
                <tr>
                  <td colSpan={colSpan} className="text-center py-14 text-slate-400">
                    <FileText className="w-8 h-8 mx-auto mb-2 text-slate-300" />
                    <p className="font-medium text-slate-500">
                      {emptyMessages[activeTab].heading}
                    </p>
                    <p className="text-xs mt-1">
                      {emptyMessages[activeTab].sub}
                    </p>
                  </td>
                </tr>
              ) : (
                docs.map((doc: any) => (
                  <tr
                    key={doc.id}
                    className={cn(
                      "hover:bg-slate-50 transition-colors group",
                      // Subtle tint on personal rows in the "All" tab
                      activeTab === "all" && doc.is_self_upload && "bg-indigo-50/40"
                    )}
                  >
                    {/* Reference */}
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-1.5">
                        <Link
                          to={`/documents/${doc.id}`}
                          className="font-mono text-xs bg-slate-100 text-slate-600 px-1.5 py-0.5 rounded hover:bg-indigo-100 hover:text-indigo-700"
                        >
                          {doc.reference_number}
                        </Link>
                        {/* Personal badge — visible in "all" tab only */}
                        {activeTab === "all" && doc.is_self_upload && (
                          <span
                            title="Personal document"
                            className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-full text-xs font-medium bg-indigo-100 text-indigo-600"
                          >
                            <Lock className="w-2.5 h-2.5" />
                            Personal
                          </span>
                        )}
                      </div>
                    </td>

                    {/* Title */}
                    <td className="px-4 py-3 max-w-xs">
                      <Link
                        to={`/documents/${doc.id}`}
                        className="text-slate-800 group-hover:text-indigo-600 font-medium truncate block"
                      >
                        {doc.title}
                      </Link>
                    </td>

                    {/* Type */}
                    <td className="px-4 py-3 text-slate-500 whitespace-nowrap">
                      {doc.document_type_name}
                    </td>

                    {/* Supplier */}
                    <td className="px-4 py-3 text-slate-600 max-w-[8rem] truncate">
                      {doc.supplier || "—"}
                    </td>

                    {/* Amount */}
                    <td className="px-4 py-3 text-slate-700 whitespace-nowrap font-medium">
                      {doc.amount
                        ? `${Number(doc.amount).toLocaleString(undefined, {
                            minimumFractionDigits: 2,
                          })} ${doc.currency}`
                        : "—"}
                    </td>

                    {/* Date */}
                    <td className="px-4 py-3 text-slate-500 whitespace-nowrap">
                      {doc.document_date
                        ? format(new Date(doc.document_date), "dd MMM yyyy")
                        : "—"}
                    </td>

                    {/* Status (workflow + all tabs) OR Uploaded (personal tab) */}
                    {activeTab !== "personal" ? (
                      <td className="px-4 py-3">
                        <span
                          className={cn(
                            "text-xs px-2 py-0.5 rounded-full font-medium whitespace-nowrap",
                            STATUS_STYLES[doc.status] ?? "bg-slate-100 text-slate-500"
                          )}
                        >
                          {doc.status.replace(/_/g, " ")}
                        </span>
                      </td>
                    ) : null}

                    {/* Uploaded */}
                    <td className="px-4 py-3 text-slate-400 whitespace-nowrap text-xs">
                      {format(new Date(doc.created_at), "dd MMM yyyy")}
                    </td>

                    {/* Quick actions — personal tab only */}
                    {activeTab === "personal" && (
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
                          {/* Archive — only if not already archived/void */}
                          {!["archived", "void"].includes(doc.status) && (
                            <button
                              title="Archive"
                              onClick={() => {
                                if (
                                  window.confirm(
                                    "Archive this personal document?"
                                  )
                                )
                                  archiveMutation.mutate(doc.id);
                              }}
                              className="p-1.5 rounded hover:bg-amber-100 text-slate-400 hover:text-amber-600 transition-colors"
                            >
                              <Archive className="w-4 h-4" />
                            </button>
                          )}
                          {/* Delete (soft — marks void) */}
                          <button
                            title="Delete"
                            onClick={() => {
                              if (
                                window.confirm(
                                  "Delete this personal document? This cannot be undone."
                                )
                              )
                                deleteMutation.mutate(doc.id);
                            }}
                            className="p-1.5 rounded hover:bg-red-100 text-slate-400 hover:text-red-500 transition-colors"
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                        </div>
                      </td>
                    )}
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        {/* ── Pagination ───────────────────────────────────────────────────── */}
        {data && data.count > 25 && (
          <div className="flex items-center justify-between px-4 py-3 border-t border-slate-100">
            <span className="text-xs text-slate-500">
              Showing{" "}
              {Math.min((page - 1) * 25 + 1, data.count)}–
              {Math.min(page * 25, data.count)} of{" "}
              {data.count.toLocaleString()}
            </span>
            <div className="flex gap-2">
              <button
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                disabled={page === 1}
                className="px-3 py-1.5 text-xs border border-slate-200 rounded-lg hover:bg-slate-50 disabled:opacity-40 transition-colors"
              >
                Previous
              </button>
              <button
                onClick={() => setPage((p) => p + 1)}
                disabled={page * 25 >= data.count}
                className="px-3 py-1.5 text-xs border border-slate-200 rounded-lg hover:bg-slate-50 disabled:opacity-40 transition-colors"
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