import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { searchAPI } from "@/services/api";
import { Search, Loader2, FileText } from "lucide-react";
import { Link } from "react-router-dom";
import StatusBadge from "@/components/documents/StatusBadge";
import { format } from "date-fns";
import type { DocumentStatus } from "@/types";

interface SearchHit {
  id: string;
  score: number;
  title: string;
  reference_number: string;
  document_type: string;
  supplier: string;
  amount: number | null;
  status: DocumentStatus;
  document_date: string | null;
  highlights: Record<string, string[]>;
}

export default function SearchPage() {
  const [query, setQuery] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [page, setPage] = useState(1);

  const searchMutation = useMutation({
    mutationFn: (payload: object) => searchAPI.search(payload).then((r) => r.data),
  });

  const handleSearch = (p = 1) => {
    setPage(p);
    searchMutation.mutate({
      query,
      filters: {
        ...(statusFilter && { status: statusFilter }),
        ...(dateFrom && { date_from: dateFrom }),
        ...(dateTo && { date_to: dateTo }),
      },
      page: p,
      page_size: 20,
    });
  };

  return (
    <div className="space-y-6 max-w-4xl">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Full-text search</h1>
        <p className="text-gray-500 text-sm mt-1">
          Search across document titles, references, suppliers, and file content.
        </p>
      </div>

      {/* Search bar */}
      <div className="card p-4 space-y-3">
        <div className="flex gap-2">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleSearch()}
              className="input pl-9"
              placeholder="Search documents, references, suppliers…"
              autoFocus
            />
          </div>
          <button onClick={() => handleSearch()} className="btn-primary px-6" disabled={searchMutation.isPending}>
            {searchMutation.isPending ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <Search className="w-4 h-4" />
            )}
            Search
          </button>
        </div>

        {/* Filters */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 pt-1">
          <div>
            <label className="label text-xs">Status</label>
            <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} className="input text-sm">
              <option value="">Any status</option>
              <option value="draft">Draft</option>
              <option value="pending_approval">Pending Approval</option>
              <option value="approved">Approved</option>
              <option value="rejected">Rejected</option>
              <option value="archived">Archived</option>
            </select>
          </div>
          <div>
            <label className="label text-xs">Date from</label>
            <input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} className="input text-sm" />
          </div>
          <div>
            <label className="label text-xs">Date to</label>
            <input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} className="input text-sm" />
          </div>
        </div>
      </div>

      {/* Results */}
      {searchMutation.data && (
        <div className="space-y-3">
          <p className="text-sm text-gray-500">
            {searchMutation.data.total} result{searchMutation.data.total !== 1 ? "s" : ""}{" "}
            {query && <>for <span className="font-medium text-gray-700">"{query}"</span></>}
          </p>

          {searchMutation.data.results.length === 0 && (
            <div className="card p-10 text-center">
              <FileText className="w-10 h-10 text-gray-200 mx-auto mb-3" />
              <p className="text-gray-500">No documents match your search.</p>
            </div>
          )}

          {searchMutation.data.results.map((hit: SearchHit) => (
            <Link
              key={hit.id}
              to={`/documents/${hit.id}`}
              className="card p-4 block hover:shadow-md transition-shadow"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap mb-1">
                    <span className="font-mono text-xs text-brand-600">{hit.reference_number}</span>
                    <span className="text-xs text-gray-400">·</span>
                    <span className="text-xs text-gray-500">{hit.document_type}</span>
                  </div>
                  <h3 className="font-medium text-gray-900 truncate">{hit.title}</h3>
                  {hit.supplier && (
                    <p className="text-sm text-gray-500 mt-0.5">{hit.supplier}</p>
                  )}
                  {/* Highlighted snippets */}
                  {hit.highlights?.extracted_text?.map((snippet, i) => (
                    <p
                      key={i}
                      className="text-xs text-gray-500 mt-1 line-clamp-2"
                      dangerouslySetInnerHTML={{ __html: `…${snippet}…` }}
                    />
                  ))}
                </div>
                <div className="flex flex-col items-end gap-2 flex-shrink-0">
                  <StatusBadge status={hit.status} />
                  {hit.document_date && (
                    <span className="text-xs text-gray-400">
                      {format(new Date(hit.document_date), "dd MMM yyyy")}
                    </span>
                  )}
                  {hit.amount && (
                    <span className="text-sm font-medium text-gray-700">
                      {hit.amount.toLocaleString("en-US", { style: "currency", currency: "USD" })}
                    </span>
                  )}
                </div>
              </div>
            </Link>
          ))}

          {/* Load more */}
          {searchMutation.data.total > page * 20 && (
            <button
              onClick={() => handleSearch(page + 1)}
              className="btn-secondary w-full justify-center"
            >
              Load more results
            </button>
          )}
        </div>
      )}
    </div>
  );
}
