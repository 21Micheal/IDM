/**
 * pages/DocumentListPage.tsx
 * Paginated document list with quick filters and sortable columns.
 */
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { FileText, UploadCloud, SortAsc, SortDesc } from "lucide-react";
import { documentApi } from "../services/api";
import { format } from "date-fns";
import { cn } from "../lib/utils";
import { useDebounce } from "../hooks/useDebounce";

const STATUS_STYLES: Record<string, string> = {
  draft: "bg-slate-100 text-slate-600",
  pending_review: "bg-yellow-100 text-yellow-700",
  pending_approval: "bg-blue-100 text-blue-700",
  approved: "bg-green-100 text-green-700",
  rejected: "bg-red-100 text-red-700",
  archived: "bg-slate-100 text-slate-400",
  void: "bg-red-50 text-red-400",
};

type SortField = "created_at" | "document_date" | "amount" | "title" | "reference_number";

export default function DocumentListPage() {
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [typeFilter, setTypeFilter] = useState("");
  const [sort, setSort] = useState<SortField>("created_at");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const [page, setPage] = useState(1);
  const debouncedSearch = useDebounce(search, 300);

  const { data: typesData } = useQuery({
    queryKey: ["document-types"],
    queryFn: () => documentApi.types(),
    select: (r) => r.data as any[],
  });

  const params = {
    search: debouncedSearch || undefined,
    status: statusFilter || undefined,
    document_type: typeFilter || undefined,
    ordering: `${sortDir === "desc" ? "-" : ""}${sort}`,
    page,
    page_size: 25,
  };

  const { data, isLoading } = useQuery({
    queryKey: ["documents", params],
    queryFn: () => documentApi.list(params),
    select: (r) => r.data,
    placeholderData: (prev) => prev,
  });

  const docs = data?.results ?? [];

  const handleSort = (field: SortField) => {
    if (sort === field) setSortDir((d) => d === "asc" ? "desc" : "asc");
    else { setSort(field); setSortDir("desc"); }
    setPage(1);
  };

  const SortIcon = ({ field }: { field: SortField }) => {
    if (sort !== field) return null;
    return sortDir === "desc"
      ? <SortDesc className="w-3.5 h-3.5 inline ml-1" />
      : <SortAsc className="w-3.5 h-3.5 inline ml-1" />;
  };

  return (
    <div className="p-6 max-w-7xl mx-auto space-y-5">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold text-slate-900">All documents</h1>
        <Link
          to="/documents/upload"
          className="inline-flex items-center gap-2 px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-medium rounded-lg"
        >
          <UploadCloud className="w-4 h-4" /> Upload
        </Link>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap gap-3">
        <input
          value={search}
          onChange={(e) => { setSearch(e.target.value); setPage(1); }}
          placeholder="Search…"
          className="w-60 text-sm border border-slate-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-indigo-500"
        />
        <select
          value={statusFilter}
          onChange={(e) => { setStatusFilter(e.target.value); setPage(1); }}
          className="text-sm border border-slate-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-indigo-500"
        >
          <option value="">All statuses</option>
          {Object.keys(STATUS_STYLES).map((s) => (
            <option key={s} value={s}>{s.replace(/_/g, " ")}</option>
          ))}
        </select>
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
            {data.count.toLocaleString()} document{data.count !== 1 ? "s" : ""}
          </span>
        )}
      </div>

      {/* Table */}
      <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-100 bg-slate-50">
                {[
                  { label: "Reference", field: "reference_number" as SortField },
                  { label: "Title", field: "title" as SortField },
                  { label: "Type", field: null },
                  { label: "Supplier", field: null },
                  { label: "Amount", field: "amount" as SortField },
                  { label: "Date", field: "document_date" as SortField },
                  { label: "Status", field: null },
                  { label: "Uploaded", field: "created_at" as SortField },
                ].map(({ label, field }) => (
                  <th
                    key={label}
                    onClick={field ? () => handleSort(field) : undefined}
                    className={cn(
                      "px-4 py-3 text-left text-xs font-semibold text-slate-500 uppercase tracking-wider whitespace-nowrap",
                      field && "cursor-pointer hover:text-slate-700"
                    )}
                  >
                    {label}
                    {field && <SortIcon field={field} />}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {isLoading ? (
                [...Array(8)].map((_, i) => (
                  <tr key={i}>
                    {[...Array(8)].map((_, j) => (
                      <td key={j} className="px-4 py-3">
                        <div className="h-4 bg-slate-100 rounded animate-pulse" />
                      </td>
                    ))}
                  </tr>
                ))
              ) : docs.length === 0 ? (
                <tr>
                  <td colSpan={8} className="text-center py-12 text-slate-400">
                    <FileText className="w-8 h-8 mx-auto mb-2 text-slate-300" />
                    No documents found.
                  </td>
                </tr>
              ) : (
                docs.map((doc: any) => (
                  <tr key={doc.id} className="hover:bg-slate-50 transition-colors group">
                    <td className="px-4 py-3">
                      <Link
                        to={`/documents/${doc.id}`}
                        className="font-mono text-xs bg-slate-100 text-slate-600 px-1.5 py-0.5 rounded hover:bg-indigo-100 hover:text-indigo-700"
                      >
                        {doc.reference_number}
                      </Link>
                    </td>
                    <td className="px-4 py-3 max-w-xs">
                      <Link
                        to={`/documents/${doc.id}`}
                        className="text-slate-800 group-hover:text-indigo-600 font-medium truncate block"
                      >
                        {doc.title}
                      </Link>
                    </td>
                    <td className="px-4 py-3 text-slate-500 whitespace-nowrap">{doc.document_type_name}</td>
                    <td className="px-4 py-3 text-slate-600 max-w-32 truncate">{doc.supplier || "—"}</td>
                    <td className="px-4 py-3 text-slate-700 whitespace-nowrap font-medium">
                      {doc.amount
                        ? `${Number(doc.amount).toLocaleString(undefined, { minimumFractionDigits: 2 })} ${doc.currency}`
                        : "—"}
                    </td>
                    <td className="px-4 py-3 text-slate-500 whitespace-nowrap">
                      {doc.document_date ? format(new Date(doc.document_date), "dd MMM yyyy") : "—"}
                    </td>
                    <td className="px-4 py-3">
                      <span className={cn("text-xs px-2 py-0.5 rounded-full font-medium whitespace-nowrap",
                        STATUS_STYLES[doc.status] ?? "bg-slate-100 text-slate-500")}>
                        {doc.status.replace(/_/g, " ")}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-slate-400 whitespace-nowrap text-xs">
                      {format(new Date(doc.created_at), "dd MMM yyyy")}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        {/* Pagination */}
        {data && data.count > 25 && (
          <div className="flex items-center justify-between px-4 py-3 border-t border-slate-100">
            <span className="text-xs text-slate-500">
              Showing {Math.min((page - 1) * 25 + 1, data.count)}–{Math.min(page * 25, data.count)} of {data.count}
            </span>
            <div className="flex gap-2">
              <button
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                disabled={page === 1}
                className="px-3 py-1.5 text-xs border border-slate-200 rounded-lg hover:bg-slate-50 disabled:opacity-40"
              >
                Previous
              </button>
              <button
                onClick={() => setPage((p) => p + 1)}
                disabled={page * 25 >= data.count}
                className="px-3 py-1.5 text-xs border border-slate-200 rounded-lg hover:bg-slate-50 disabled:opacity-40"
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
