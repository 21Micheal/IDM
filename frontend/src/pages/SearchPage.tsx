import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { format } from "date-fns";
import {
  ChevronLeft,
  ChevronRight,
  Eye,
  FileSearch,
  FileText,
  Loader2,
  RotateCcw,
  Search,
  SlidersHorizontal,
  X,
} from "lucide-react";
import { Link, useSearchParams } from "react-router-dom";
import CustomListbox from "@/components/ui/CustomListbox";

import { documentsAPI, documentTypesAPI, normalizeListResponse, searchAPI } from "@/services/api";
import type { DocumentSearchResponse, DocumentType, SearchHit } from "@/types";
import { useDebounce } from "@/hooks/useDebounce";
import { getPreferredHighlights, highlightSearchText } from "@/lib/search";
import { formatDocumentFileType } from "@/lib/documentFormat";
import statusUtils from "@/lib/status";
import { QUERY_FIVE_MIN_STALE } from "@/lib/reactQueryDefaults";
import { WorkspaceCommandBar } from "@/components/shared/WorkspaceCommandBar";

const PAGE_SIZE = 20;

// Keep in sync with DocumentsPage — pending_approval is the list filter token;
// the search API expands any pending* value to all pending-like statuses.
const STATUS_OPTIONS = [
  "draft",
  "pending_approval",
  "approved",
  "rejected",
  "archived",
  "void",
] as const;

const FORMAT_OPTIONS = [
  { value: "pdf", label: "PDF", mimeTypes: ["application/pdf"] },
  {
    value: "word",
    label: "Word",
    mimeTypes: [
      "application/msword",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ],
  },
  {
    value: "spreadsheet",
    label: "Spreadsheet",
    mimeTypes: [
      "application/vnd.ms-excel",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "text/csv",
    ],
  },
  {
    value: "presentation",
    label: "Presentation",
    mimeTypes: [
      "application/vnd.ms-powerpoint",
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    ],
  },
  {
    value: "image",
    label: "Image",
    mimeTypes: ["image/png", "image/jpeg", "image/jpg", "image/tiff", "image/webp"],
  },
];

const SORT_OPTIONS = [
  { value: "", label: "Relevance" },
  { value: "-created_at", label: "Newest" },
  { value: "created_at", label: "Oldest" },
  { value: "-document_date", label: "Document date desc" },
  { value: "document_date", label: "Document date asc" },
  { value: "-amount", label: "Amount desc" },
  { value: "amount", label: "Amount asc" },
  { value: "reference_number", label: "Reference" },
];

const CURRENCY_OPTIONS = [
  { value: "", label: "All currencies" },
  { value: "USD", label: "USD" },
  { value: "KES", label: "KES" },
  { value: "EUR", label: "EUR" },
  { value: "GBP", label: "GBP" },
];

function statusLabel(status: string) {
  return status.replace(/_/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function statusClass(status: string) {
  switch (status) {
    case "approved":
      return "text-[#0F7A3A]";
    case "pending_approval":
    case "pending_review":
      return "text-[#9A5B00]";
    case "rejected":
      return "text-[#B42318]";
    case "archived":
      return "text-[#5E6870]";
    case "void":
      return "text-[#30363D]";
    default:
      return "text-[#2B86C5]";
  }
}

function formatDate(value: string | null) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  return format(date, "dd MMM yyyy");
}

function formatAmount(amount: number | null, currency?: string) {
  if (amount == null) return "-";
  try {
    return amount.toLocaleString("en-US", {
      style: "currency",
      currency: currency || "USD",
    });
  } catch {
    return `${currency ? `${currency} ` : ""}${amount.toLocaleString("en-US")}`;
  }
}

function buildSearchParamsFromState(state: {
  q: string;
  status: string;
  document_type: string;
  supplier: string;
  format: string;
  date_from: string;
  date_to: string;
  currency: string;
  amount_min: string;
  amount_max: string;
  sort: string;
}) {
  const nextParams = new URLSearchParams();
  if (state.q) nextParams.set("q", state.q);
  if (state.status) nextParams.set("status", state.status);
  if (state.document_type) nextParams.set("document_type", state.document_type);
  if (state.supplier) nextParams.set("supplier", state.supplier);
  if (state.format) nextParams.set("format", state.format);
  if (state.date_from) nextParams.set("date_from", state.date_from);
  if (state.date_to) nextParams.set("date_to", state.date_to);
  if (state.currency) nextParams.set("currency", state.currency);
  if (state.amount_min) nextParams.set("amount_min", state.amount_min);
  if (state.amount_max) nextParams.set("amount_max", state.amount_max);
  if (state.sort) nextParams.set("sort", state.sort);
  return nextParams;
}

export default function SearchPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  // Hydrate once from the URL (shareable links). After that filters are owned by
  // local state — writing back to the URL must not re-import and clobber edits
  // (that loop is why filters / search text used to "not stick").
  const [searchTerm, setSearchTerm] = useState(() => searchParams.get("q") ?? "");
  const [dateFrom, setDateFrom] = useState(() => searchParams.get("date_from") ?? "");
  const [dateTo, setDateTo] = useState(() => searchParams.get("date_to") ?? "");
  const [statusFilter, setStatusFilter] = useState(() => searchParams.get("status") ?? "");
  const [typeFilter, setTypeFilter] = useState(() => searchParams.get("document_type") ?? "");
  const [supplierFilter, setSupplierFilter] = useState(() => searchParams.get("supplier") ?? "");
  const [formatFilter, setFormatFilter] = useState(() => searchParams.get("format") ?? "");
  const [currencyFilter, setCurrencyFilter] = useState(() => searchParams.get("currency") ?? "");
  const [amountMin, setAmountMin] = useState(() => searchParams.get("amount_min") ?? "");
  const [amountMax, setAmountMax] = useState(() => searchParams.get("amount_max") ?? "");
  const [sort, setSort] = useState(() => searchParams.get("sort") ?? "");
  const [page, setPage] = useState(1);

  const debouncedSearchTerm = useDebounce(searchTerm, 350);
  const searchParamsString = searchParams.toString();

  const { data: documentTypes = [] } = useQuery<unknown, Error, DocumentType[]>({
    queryKey: ["document-types"],
    queryFn: () => documentTypesAPI.list().then((response) => response.data as unknown),
    select: (data) => normalizeListResponse(data) as DocumentType[],
    ...QUERY_FIVE_MIN_STALE,
  });

  const { data: supplierOptions = [] } = useQuery<string[]>({
    queryKey: ["document-suppliers"],
    queryFn: () => documentsAPI.suppliers().then((r) => r.data),
    ...QUERY_FIVE_MIN_STALE,
  });

  const supplierListOptions = useMemo(() => {
    const list = [
      { value: "", label: "All suppliers" },
      ...supplierOptions.map((s) => ({ value: s, label: s })),
    ];
    if (supplierFilter && !supplierOptions.includes(supplierFilter)) {
      list.push({ value: supplierFilter, label: supplierFilter });
    }
    return list;
  }, [supplierOptions, supplierFilter]);

  const currencyListOptions = useMemo(() => {
    const list = [...CURRENCY_OPTIONS];
    if (currencyFilter && !list.some((c) => c.value === currencyFilter)) {
      list.push({ value: currencyFilter, label: currencyFilter });
    }
    return list;
  }, [currencyFilter]);

  const selectedFormat = FORMAT_OPTIONS.find((option) => option.value === formatFilter);
  const hasActiveSearch = Boolean(
    debouncedSearchTerm ||
      statusFilter ||
      typeFilter ||
      supplierFilter ||
      formatFilter ||
      dateFrom ||
      dateTo ||
      currencyFilter ||
      amountMin ||
      amountMax,
  );

  // Same shape DocumentsPage uses: document_type is the type UUID; status is the
  // list-filter token (pending_approval expands server-side to all pending*).
  const searchPayload = useMemo(
    () => ({
      search: debouncedSearchTerm,
      filters: {
        ...(statusFilter && { status: statusFilter }),
        ...(typeFilter && { document_type: typeFilter }),
        ...(supplierFilter && { supplier: supplierFilter }),
        ...(selectedFormat && { file_mime_type: selectedFormat.mimeTypes }),
        ...(dateFrom && { date_from: dateFrom }),
        ...(dateTo && { date_to: dateTo }),
        ...(currencyFilter && { currency: currencyFilter }),
        ...(amountMin && { amount_min: amountMin }),
        ...(amountMax && { amount_max: amountMax }),
      },
      ...(sort && { ordering: sort }),
      page,
      page_size: PAGE_SIZE,
    }),
    [
      amountMax,
      amountMin,
      currencyFilter,
      dateFrom,
      dateTo,
      debouncedSearchTerm,
      page,
      selectedFormat,
      sort,
      statusFilter,
      supplierFilter,
      typeFilter,
    ],
  );

  const searchQuery = useQuery({
    queryKey: ["document-search", searchPayload],
    queryFn: () => searchAPI.search(searchPayload).then((response) => response.data as DocumentSearchResponse),
    enabled: hasActiveSearch,
  });

  // Mirror DocumentsPage: filters live in React state. Push them to the URL for
  // shareable links, but never re-import URL → state (that feedback loop cleared
  // in-progress edits and made filter changes appear broken).
  useEffect(() => {
    const nextParams = buildSearchParamsFromState({
      q: debouncedSearchTerm,
      status: statusFilter,
      document_type: typeFilter,
      supplier: supplierFilter,
      format: formatFilter,
      date_from: dateFrom,
      date_to: dateTo,
      currency: currencyFilter,
      amount_min: amountMin,
      amount_max: amountMax,
      sort,
    });

    if (searchParamsString === nextParams.toString()) return;
    setSearchParams(nextParams, { replace: true });
  }, [
    amountMax,
    amountMin,
    currencyFilter,
    dateFrom,
    dateTo,
    debouncedSearchTerm,
    formatFilter,
    searchParamsString,
    setSearchParams,
    sort,
    statusFilter,
    supplierFilter,
    typeFilter,
  ]);

  const clearFilters = () => {
    setSearchTerm("");
    setDateFrom("");
    setDateTo("");
    setStatusFilter("");
    setTypeFilter("");
    setSupplierFilter("");
    setFormatFilter("");
    setCurrencyFilter("");
    setAmountMin("");
    setAmountMax("");
    setSort("");
    setPage(1);
  };

  // Same safety net as DocumentsPage: enforce filters against the document
  // status/type/supplier fields the UI shows, matching docMatchesFilters.
  const selectedTypeName = useMemo(
    () => documentTypes.find((type) => String(type.id) === typeFilter)?.name ?? "",
    [documentTypes, typeFilter],
  );

  const filteredData: DocumentSearchResponse | null = useMemo(() => {
    if (!hasActiveSearch) return null;
    const raw = searchQuery.data;
    if (!raw) return null;

    const results = (raw.results ?? []).filter((hit) => {
      if (statusFilter && !statusUtils.statusMatchesFilter(hit.status, statusFilter)) return false;

      if (typeFilter) {
        const hitTypeId = hit.document_type_id;
        const hitType = String(hit.document_type ?? "").trim().toLowerCase();
        const matchesId = Boolean(hitTypeId && hitTypeId === typeFilter);
        const matchesName = Boolean(selectedTypeName && hitType === selectedTypeName.trim().toLowerCase());
        const matchesDirect = Boolean(hitType && hitType === typeFilter.trim().toLowerCase());
        if (!matchesId && !matchesName && !matchesDirect && selectedTypeName) {
          return false;
        }
      }

      if (supplierFilter) {
        const supplier = String(hit.supplier ?? "").toLowerCase();
        if (!supplier.includes(supplierFilter.toLowerCase())) return false;
      }

      return true;
    });

    // Keep backend total for pagination chrome; page contents are what the user sees.
    return { ...raw, results };
  }, [
    hasActiveSearch,
    searchQuery.data,
    selectedTypeName,
    statusFilter,
    supplierFilter,
    typeFilter,
  ]);

  const totalPages = filteredData ? Math.max(1, Math.ceil((filteredData.total ?? 0) / PAGE_SIZE)) : 1;
  const activeFilterCount = [
    statusFilter,
    typeFilter,
    supplierFilter,
    formatFilter,
    dateFrom,
    dateTo,
    currencyFilter,
    amountMin,
    amountMax,
  ].filter(Boolean).length;

  return (
    <div className="flex h-full flex-col bg-[#EDEDED] text-[13px] text-[#1F2933]">
      <WorkspaceCommandBar />

      <div className="scrollbar-minimal min-h-0 flex-1 overflow-y-auto px-5 pb-8 pr-0">
        <section className="border-b border-[#C8CDD2] bg-[#F7F7F7] px-4 py-3">
          {/* Primary search + quick filters row */}
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <div className="relative w-full max-w-[420px]">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[#5E6870]" />
              <input
                value={searchTerm}
                onChange={(event) => {
                  setSearchTerm(event.target.value);
                  setPage(1);
                }}
                placeholder="Search documents, references, suppliers, or content"
                className="h-9 w-full border border-[#B7BEC5] bg-white pl-9 pr-9 text-sm text-[#1F2933] placeholder:text-[#6E767D] focus:outline-none focus:border-[#2B86C5] focus:ring-1 focus:ring-[#2B86C5]/30"
                autoFocus
              />
              {searchTerm && (
                <button
                  type="button"
                  onClick={() => setSearchTerm("")}
                  className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-[#5E6870] hover:text-[#1F2933]"
                  aria-label="Clear search text"
                >
                  <X className="h-4 w-4" />
                </button>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-1">
              <CustomListbox
                value={statusFilter}
                onChange={(v) => { setStatusFilter(v); setPage(1); }}
                options={[{ value: "", label: "All statuses" }, ...STATUS_OPTIONS.map((status) => ({ value: status, label: statusLabel(status) }))]}
                buttonClassName="h-9 w-[130px] border border-[#B7BEC5] bg-white px-2 text-sm text-[#1F2933]"
                ariaLabel="Status filter"
              />
              <CustomListbox
                value={typeFilter}
                onChange={(v) => { setTypeFilter(v); setPage(1); }}
                options={[{ value: "", label: "All types" }, ...documentTypes.map((type) => ({ value: String(type.id), label: type.name }))]}
                buttonClassName="h-9 w-[140px] border border-[#B7BEC5] bg-white px-2 text-sm text-[#1F2933]"
                ariaLabel="Document type filter"
              />
              <CustomListbox
                value={supplierFilter}
                onChange={(v) => { setSupplierFilter(v); setPage(1); }}
                options={supplierListOptions}
                buttonClassName="h-9 w-[160px] border border-[#B7BEC5] bg-white px-2 text-sm text-[#1F2933]"
                ariaLabel="Supplier filter"
              />
              <CustomListbox
                value={formatFilter}
                onChange={(v) => { setFormatFilter(v); setPage(1); }}
                options={[{ value: "", label: "All formats" }, ...FORMAT_OPTIONS.map((opt) => ({ value: opt.value, label: opt.label }))]}
                buttonClassName="h-9 w-[120px] border border-[#B7BEC5] bg-white px-2 text-sm text-[#1F2933]"
                ariaLabel="Format filter"
              />
            </div>
            {activeFilterCount > 0 && (
              <span className="ml-auto inline-flex items-center gap-1.5 text-xs text-[#5E6870]">
                <SlidersHorizontal className="h-3.5 w-3.5" />
                {activeFilterCount} active filter{activeFilterCount !== 1 ? "s" : ""}
              </span>
            )}
          </div>
          <div className="grid gap-3 lg:grid-cols-[1.5fr_1.5fr_1fr_1.2fr_auto]">
            <div className="grid grid-cols-2 gap-2">
              <input
                type="date"
                value={dateFrom}
                onChange={(event) => {
                  setDateFrom(event.target.value);
                  setPage(1);
                }}
                className="h-9 border border-[#B7BEC5] bg-white px-3 text-sm focus:outline-none focus:border-[#2B86C5] focus:ring-1 focus:ring-[#2B86C5]/25"
                aria-label="From date"
              />
              <input
                type="date"
                value={dateTo}
                onChange={(event) => {
                  setDateTo(event.target.value);
                  setPage(1);
                }}
                className="h-9 border border-[#B7BEC5] bg-white px-3 text-sm focus:outline-none focus:border-[#2B86C5] focus:ring-1 focus:ring-[#2B86C5]/25"
                aria-label="To date"
              />
            </div>
            <div className="grid grid-cols-2 gap-2">
              <input
                type="number"
                min="0"
                value={amountMin}
                onChange={(event) => {
                  setAmountMin(event.target.value);
                  setPage(1);
                }}
                placeholder="Amount min"
                className="h-9 border border-[#B7BEC5] bg-white px-3 text-sm focus:outline-none focus:border-[#2B86C5] focus:ring-1 focus:ring-[#2B86C5]/25"
              />
              <input
                type="number"
                min="0"
                value={amountMax}
                onChange={(event) => {
                  setAmountMax(event.target.value);
                  setPage(1);
                }}
                placeholder="Amount max"
                className="h-9 border border-[#B7BEC5] bg-white px-3 text-sm focus:outline-none focus:border-[#2B86C5] focus:ring-1 focus:ring-[#2B86C5]/25"
              />
            </div>
            <CustomListbox
              value={currencyFilter}
              onChange={(v) => {
                setCurrencyFilter(v);
                setPage(1);
              }}
              options={currencyListOptions}
              buttonClassName="h-9 border border-[#B7BEC5] bg-white px-3 text-sm focus:outline-none focus:border-[#2B86C5] focus:ring-1 focus:ring-[#2B86C5]/25"
              ariaLabel="Currency filter"
            />
            <CustomListbox
              value={sort}
              onChange={(v) => {
                setSort(v);
                setPage(1);
              }}
              options={SORT_OPTIONS.map((opt) => ({ value: opt.value, label: opt.label }))}
              buttonClassName="h-9 border border-[#B7BEC5] bg-white px-3 text-sm focus:outline-none focus:border-[#2B86C5] focus:ring-1 focus:ring-[#2B86C5]/25"
              ariaLabel="Sort results"
            />
            <button
              type="button"
              onClick={clearFilters}
              disabled={!hasActiveSearch && !sort}
              className="inline-flex h-9 items-center justify-center gap-2 border border-[#B7BEC5] bg-white px-3 text-sm text-[#3D454D] hover:bg-[#EEF3F7] disabled:cursor-not-allowed disabled:opacity-50"
            >
              <RotateCcw className="h-4 w-4" />
              Clear
            </button>
          </div>
        </section>

        <section className="min-h-[calc(100vh-11.5rem)] border-x border-b border-[#C8CDD2] bg-[#EDEDED]">
          <div className="flex h-[50px] items-center justify-between border-b border-[#C8CDD2] bg-white px-4">
            <div className="flex items-center gap-3">
              <button
                type="button"
                className="h-9 border border-[#B9C0C6] border-t-2 border-t-[#2B8DCB] bg-white px-4 text-sm font-medium text-[#2B86C5]"
              >
                Search Results
              </button>
              {filteredData && (
                <span className="border-l border-[#C8CDD2] pl-3 text-sm font-semibold">
                  {filteredData.total} matching document{filteredData.total === 1 ? "" : "s"}
                </span>
              )}
            </div>

            {filteredData && filteredData.total > 0 && (
              <div className="flex items-center gap-2 text-sm text-[#5E6870]">
                <span>
                  Page {page} of {totalPages}
                </span>
                <button
                  type="button"
                  onClick={() => setPage((current) => Math.max(1, current - 1))}
                  disabled={page <= 1 || searchQuery.isFetching}
                  className="border border-[#B7BEC5] bg-white p-1.5 text-[#3D454D] hover:bg-[#EEF3F7] disabled:opacity-40"
                  aria-label="Previous page"
                >
                  <ChevronLeft className="h-4 w-4" />
                </button>
                <button
                  type="button"
                  onClick={() => setPage((current) => Math.min(totalPages, current + 1))}
                  disabled={page >= totalPages || searchQuery.isFetching}
                  className="border border-[#B7BEC5] bg-white p-1.5 text-[#3D454D] hover:bg-[#EEF3F7] disabled:opacity-40"
                  aria-label="Next page"
                >
                  <ChevronRight className="h-4 w-4" />
                </button>
              </div>
            )}
          </div>

          {!hasActiveSearch && (
            <div className="flex min-h-[24rem] items-center justify-center px-6">
              <div className="max-w-md text-center">
                <FileSearch className="mx-auto mb-4 h-12 w-12 text-[#8A949D]" />
                <h2 className="text-lg font-semibold text-[#1F2933]">Search across your document library</h2>
                <p className="mt-2 text-sm leading-6 text-[#5E6870]">
                  Use full text, reference, supplier, status, type, format, date, and amount filters to narrow the result set.
                </p>
              </div>
            </div>
          )}

          {hasActiveSearch && searchQuery.isLoading && (
            <div className="flex min-h-[24rem] items-center justify-center gap-3 text-[#5E6870]">
              <Loader2 className="h-5 w-5 animate-spin" />
              Searching documents
            </div>
          )}

          {hasActiveSearch && searchQuery.isError && (
            <div className="m-4 border border-[#D9A6A0] bg-[#FFF7F5] px-4 py-3 text-sm text-[#B42318]">
              Search is temporarily unavailable.
            </div>
          )}

          {filteredData && filteredData.results.length === 0 && (
            <div className="flex min-h-[24rem] items-center justify-center px-6">
              <div className="text-center">
                <FileText className="mx-auto mb-4 h-12 w-12 text-[#A8B0B7]" />
                <p className="text-sm text-[#5E6870]">No documents match your search criteria.</p>
              </div>
            </div>
          )}

          {filteredData && filteredData.results.length > 0 && (
            <div className="divide-y divide-[#D1D5D9] bg-white">
              {filteredData.results.map((hit: SearchHit) => {
                const preferredHighlights = getPreferredHighlights(hit, debouncedSearchTerm);
                const title = hit.title || hit.file_name || hit.reference_number || "Untitled document";
                const formatLabel = formatDocumentFileType(hit.file_name, hit.file_mime_type);

                return (
                  <div key={hit.id} className="grid grid-cols-[minmax(0,1fr)_180px_110px] gap-6 px-5 py-4 hover:bg-[#F7FAFC]">
                    <div className="min-w-0">
                      <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-[#5E6870]">
                        <span className="font-mono font-semibold text-[#2B86C5]">{hit.reference_number || "-"}</span>
                        <span>{hit.document_type || "Unclassified"}</span>
                        <span>{formatLabel}</span>
                        {hit.supplier && (
                          <span
                            dangerouslySetInnerHTML={{
                              __html: highlightSearchText(hit.supplier, debouncedSearchTerm),
                            }}
                          />
                        )}
                      </div>

                      <Link to={`/open/${hit.id}`} className="group inline-block max-w-full">
                        <h3 className="truncate text-base font-semibold text-[#1F2933] group-hover:text-[#2B86C5]">
                          <span
                            dangerouslySetInnerHTML={{
                              __html: highlightSearchText(title, debouncedSearchTerm),
                            }}
                          />
                        </h3>
                      </Link>

                      {preferredHighlights.length > 0 && (
                        <div className="mt-3 max-w-4xl space-y-2 border-l-2 border-[#A7CDE3] pl-3 text-sm leading-6 text-[#4B5560]">
                          {preferredHighlights.map(([field, snippet]) => (
                            <p key={field}>
                              <span
                                dangerouslySetInnerHTML={{
                                  __html: highlightSearchText(snippet, debouncedSearchTerm),
                                }}
                              />
                            </p>
                          ))}
                        </div>
                      )}
                    </div>

                    <div className="space-y-2 text-sm">
                      <div>
                        <p className="text-xs uppercase text-[#6E767D]">Status</p>
                        <p className={`font-semibold ${statusClass(hit.status)}`}>{statusLabel(hit.status)}</p>
                      </div>
                      <div>
                        <p className="text-xs uppercase text-[#6E767D]">Document date</p>
                        <p>{formatDate(hit.document_date)}</p>
                      </div>
                      <div>
                        <p className="text-xs uppercase text-[#6E767D]">Amount</p>
                        <p>{formatAmount(hit.amount, hit.currency)}</p>
                      </div>
                    </div>

                    <div className="flex items-start justify-end">
                      <Link
                        to={`/open/${hit.id}`}
                        className="inline-flex h-8 items-center gap-2 border border-[#B7BEC5] bg-white px-3 text-sm text-[#2B86C5] hover:bg-[#EEF3F7]"
                      >
                        <Eye className="h-4 w-4" />
                        View
                      </Link>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
