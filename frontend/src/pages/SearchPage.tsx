import { useState, useEffect } from "react";
import { useMutation } from "@tanstack/react-query";
import { searchAPI } from "@/services/api";
import { Search, Loader2, FileText, X } from "lucide-react";
import { Link, useSearchParams } from "react-router-dom";
import StatusBadge from "@/components/documents/StatusBadge";
import { format } from "date-fns";
import type { DocumentStatus } from "@/types";
import { useDebounce } from "@/hooks/useDebounce";

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
  highlights: Record<string, string>;
}

export default function SearchPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [searchTerm, setSearchTerm] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [page, setPage] = useState(1);

  const debouncedSearchTerm = useDebounce(searchTerm, 350);

  const searchMutation = useMutation({
    mutationFn: (payload: any) => searchAPI.search(payload).then((r) => r.data),
  });

  useEffect(() => {
    const query = searchParams.get("q") ?? "";
    const nextDateFrom = searchParams.get("date_from") ?? "";
    const nextDateTo = searchParams.get("date_to") ?? "";
    const nextStatus = searchParams.get("status") ?? "";

    setSearchTerm(query);
    setDateFrom(nextDateFrom);
    setDateTo(nextDateTo);
    setStatusFilter(nextStatus);
    setPage(1);
  }, [searchParams]);

  const handleSearch = (newPage = 1) => {
    setPage(newPage);
    searchMutation.mutate({
      search: debouncedSearchTerm,
      filters: {
        ...(statusFilter && { status: statusFilter }),
        ...(dateFrom && { date_from: dateFrom }),
        ...(dateTo && { date_to: dateTo }),
      },
      page: newPage,
      page_size: 20,
    });
  };

  useEffect(() => {
    const nextParams = new URLSearchParams();
    if (debouncedSearchTerm) nextParams.set("q", debouncedSearchTerm);
    if (statusFilter) nextParams.set("status", statusFilter);
    if (dateFrom) nextParams.set("date_from", dateFrom);
    if (dateTo) nextParams.set("date_to", dateTo);

    const currentParams = searchParams.toString();
    const updatedParams = nextParams.toString();
    if (currentParams !== updatedParams) {
      setSearchParams(nextParams, { replace: true });
    }

    if (debouncedSearchTerm || statusFilter || dateFrom || dateTo) {
      handleSearch(1);
    } else {
      searchMutation.reset();
    }
  }, [debouncedSearchTerm, statusFilter, dateFrom, dateTo, searchParams, setSearchParams]);

  const clearFilters = () => {
    setSearchTerm("");
    setDateFrom("");
    setDateTo("");
    setStatusFilter("");
    setPage(1);
  };

  // Highlight only the searched term in the snippet
  const highlightTerm = (text: string, term: string) => {
    if (!term || !text) return text;
    const regex = new RegExp(`(${term})`, "gi");
    return text.replace(regex, '<span class="bg-yellow-200 text-yellow-800 font-medium px-0.5 rounded">$1</span>');
  };

  return (
    <div className="max-w-5xl mx-auto py-10 px-6">
      <div className="mb-10">
        <h1 className="text-4xl font-bold text-gray-900">Search Documents</h1>
        <p className="text-gray-500 mt-2 text-lg">
          Full-text search with partial word matching
        </p>
      </div>

      <div className="card p-6 mb-8">
        <div className="relative mb-6">
          <Search className="absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 text-gray-400" />
          <input
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="input pl-11 text-lg"
            placeholder="Search documents, references, suppliers, or content..."
            autoFocus
          />
          {searchTerm && (
            <button
              onClick={() => setSearchTerm("")}
              className="absolute right-4 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 p-1"
            >
              <X className="w-5 h-5" />
            </button>
          )}
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div>
            <label className="label">Status</label>
            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
              className="input"
            >
              <option value="">Any status</option>
              <option value="draft">Draft</option>
              <option value="pending_approval">Pending Approval</option>
              <option value="approved">Approved</option>
              <option value="rejected">Rejected</option>
              <option value="archived">Archived</option>
            </select>
          </div>
          <div>
            <label className="label">From Date</label>
            <input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} className="input" />
          </div>
          <div>
            <label className="label">To Date</label>
            <input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} className="input" />
          </div>
        </div>
        {(searchTerm || statusFilter || dateFrom || dateTo) && (
          <div className="mt-4 flex justify-end">
            <button
              type="button"
              onClick={clearFilters}
              className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground"
            >
              <X className="w-4 h-4" />
              Clear filters
            </button>
          </div>
        )}
      </div>

      {searchMutation.data && (
        <div className="space-y-6">
          <div className="flex justify-between items-center">
            <p className="text-sm text-gray-500">
              {searchMutation.data.total} result{searchMutation.data.total !== 1 ? "s" : ""}
              {searchTerm && <> for <span className="font-medium">"{searchTerm}"</span></>}
            </p>
            <p className="text-xs text-gray-400">Page {page}</p>
          </div>

          {searchMutation.data.results.length === 0 && (
            <div className="card p-12 text-center">
              <FileText className="w-12 h-12 text-gray-200 mx-auto mb-4" />
              <p className="text-gray-500">No documents match your search criteria.</p>
            </div>
          )}

          <div className="space-y-4">
            {searchMutation.data.results.map((hit: SearchHit) => (
              <Link
                key={hit.id}
                to={`/documents/${hit.id}`}
                className="card p-6 block hover:shadow-md transition-all group"
              >
                <div className="flex items-start justify-between gap-6">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-3 mb-2">
                      <span className="font-mono text-xs text-brand-600 font-medium">
                        {hit.reference_number}
                      </span>
                      <span className="text-xs text-gray-400">•</span>
                      <span className="text-xs text-gray-500">{hit.document_type}</span>
                    </div>

                    <h3 className="font-semibold text-lg text-gray-900 group-hover:text-brand-700 transition-colors line-clamp-2">
                      {hit.title}
                    </h3>

                    {hit.supplier && (
                      <p className="text-sm text-gray-600 mt-1">{hit.supplier}</p>
                    )}

                    {/* Only highlight the searched term - modern style */}
                    {hit.highlights && Object.keys(hit.highlights).length > 0 && (
                      <div className="mt-4 text-sm text-gray-600 border-l-2 border-brand-200 pl-4 space-y-3">
                        {Object.entries(hit.highlights).map(([field, snippet]) => (
                          <div key={field} className="italic">
                            <span className="text-xs uppercase tracking-widest text-gray-400 mr-2">
                              {field}
                            </span>
                            <span
                              dangerouslySetInnerHTML={{
                                __html: highlightTerm(snippet, searchTerm),
                              }}
                            />
                          </div>
                        ))}
                      </div>
                    )}
                  </div>

                  <div className="flex flex-col items-end gap-3 flex-shrink-0 text-right">
                    <StatusBadge status={hit.status} />
                    {hit.document_date && (
                      <div className="text-xs text-gray-500">
                        {format(new Date(hit.document_date), "dd MMM yyyy")}
                      </div>
                    )}
                    {hit.amount && (
                      <div className="font-medium text-gray-900">
                        {hit.amount.toLocaleString("en-US", {
                          style: "currency",
                          currency: "USD",
                        })}
                      </div>
                    )}
                  </div>
                </div>
              </Link>
            ))}
          </div>

          {searchMutation.data.total > page * 20 && (
            <button
              onClick={() => handleSearch(page + 1)}
              disabled={searchMutation.isPending}
              className="btn-secondary w-full py-3 mt-4"
            >
              {searchMutation.isPending ? (
                <Loader2 className="w-4 h-4 animate-spin mx-auto" />
              ) : (
                "Load more results"
              )}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

// Helper: Highlight only the searched term
const highlightTerm = (text: string, term: string): string => {
  if (!term || !text) return text || "";
  const regex = new RegExp(`(${term})`, "gi");
  return text.replace(regex, '<span class="bg-yellow-200 font-medium text-yellow-800 px-0.5 rounded">$1</span>');
};
