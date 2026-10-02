/**
 * ExternalPage
 *
 * Read-only browser for the SunSystems-backed lookups the form designer can
 * drop into a form: Items and Analysis Codes. Handy for checking that the
 * gateway returns what the builder expects without opening a template.
 */
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Loader2, Package, Search, Tags } from "lucide-react";
import { sunsystemsAPI } from "@/services/api";
import CustomListbox from "@/components/ui/CustomListbox";
import { ANALYSIS_DIMENSIONS, analysisDimensionName } from "@/lib/analysisDimensions";
import { cn } from "@/lib/utils";

type Tab = "items" | "analysis";

const inputCls =
  "h-9 w-full border border-[#AEB5BB] bg-white px-3 text-sm text-[#1F2933] " +
  "placeholder:text-[#8C969E] outline-none focus:border-[#287EAD] focus:ring-1 focus:ring-[#287EAD]";

function SearchBox({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder: string }) {
  return (
    <div className="relative w-full max-w-sm">
      <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[#8C969E]" />
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className={cn(inputCls, "pl-9")}
      />
    </div>
  );
}

function ResultTable({ codeLabel, nameLabel, rows, loading, error }: {
  codeLabel: string;
  nameLabel: string;
  rows: { code: string; name: string }[];
  loading: boolean;
  error?: string | null;
}) {
  return (
    <div className="overflow-hidden border border-[#E4E7EB] bg-white">
      <div className="grid grid-cols-[160px_1fr] border-b border-[#E4E7EB] bg-[#F6F7F8] text-[11px] font-semibold uppercase tracking-wider text-[#5E6870]">
        <div className="px-4 py-2.5">{codeLabel}</div>
        <div className="border-l border-[#E4E7EB] px-4 py-2.5">{nameLabel}</div>
      </div>
      {loading ? (
        <div className="flex items-center justify-center gap-2 py-16 text-sm text-[#5E6870]">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading…
        </div>
      ) : error ? (
        <p className="px-4 py-16 text-center text-sm text-red-600">{error}</p>
      ) : rows.length === 0 ? (
        <p className="px-4 py-16 text-center text-sm text-[#5E6870]">No records to show.</p>
      ) : (
        <div className="max-h-[65vh] overflow-y-auto">
          {rows.map((row) => (
            <div key={row.code} className="grid grid-cols-[160px_1fr] border-b border-[#EEF1F3] last:border-0 hover:bg-[#F3F8FB]">
              <div className="px-4 py-2.5 font-mono text-[13px] font-bold text-[#287EAD]">{row.code}</div>
              <div className="border-l border-[#EEF1F3] px-4 py-2.5 text-[13px] text-[#1F2933]">{row.name || "—"}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default function ExternalPage() {
  const [tab, setTab] = useState<Tab>("items");
  const [itemSearch, setItemSearch] = useState("");
  const [codeSearch, setCodeSearch] = useState("");
  const [dimension, setDimension] = useState(ANALYSIS_DIMENSIONS.find((d) => d.id === "04")?.id ?? "04");

  const itemsQuery = useQuery({
    queryKey: ["sunsystems", "external", "items", "page"],
    queryFn: () => sunsystemsAPI.getItems(),
    enabled: tab === "items",
    staleTime: 5 * 60_000,
  });

  const codesQuery = useQuery({
    queryKey: ["sunsystems", "external", "analysis_codes", "page", dimension],
    queryFn: () => sunsystemsAPI.getAnalysisCodes({ dimension }),
    enabled: tab === "analysis",
    staleTime: 5 * 60_000,
  });

  const items = itemsQuery.data?.data.items ?? [];
  const codes = codesQuery.data?.data.analysis_codes ?? [];

  const filteredItems = useMemo(() => {
    const q = itemSearch.trim().toLowerCase();
    const rows = items.map((it) => ({ code: it.item_code, name: it.description }));
    if (!q) return rows;
    return rows.filter((r) => r.code.toLowerCase().includes(q) || r.name.toLowerCase().includes(q));
  }, [items, itemSearch]);

  const filteredCodes = useMemo(() => {
    const q = codeSearch.trim().toLowerCase();
    const rows = codes.map((c) => ({ code: c.analysis_code, name: c.name }));
    if (!q) return rows;
    return rows.filter((r) => r.code.toLowerCase().includes(q) || r.name.toLowerCase().includes(q));
  }, [codes, codeSearch]);

  return (
    <div className="mx-auto w-full max-w-5xl p-6">
      <div className="mb-5">
        <h1 className="text-lg font-bold tracking-tight text-[#1F2933]">External Components</h1>
        <p className="mt-1 text-sm text-[#5E6870]">
          Live lookups fetched from SunSystems and available as form inputs.
        </p>
      </div>

      <div className="mb-5 flex border border-[#C8CDD2]">
        {([
          { key: "items", label: "Items", icon: Package },
          { key: "analysis", label: "Analysis Codes", icon: Tags },
        ] as const).map(({ key, label, icon: Icon }) => (
          <button
            key={key}
            type="button"
            onClick={() => setTab(key)}
            className={cn(
              "flex flex-1 items-center justify-center gap-2 px-4 py-2.5 text-sm font-semibold transition-colors",
              tab === key ? "bg-[#287EAD] text-white" : "bg-white text-[#5E6870] hover:bg-[#F3F5F6]",
            )}
          >
            <Icon className="h-4 w-4" /> {label}
          </button>
        ))}
      </div>

      {tab === "items" ? (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <SearchBox value={itemSearch} onChange={setItemSearch} placeholder="Search items by code or description…" />
            <span className="text-xs text-[#5E6870]">{filteredItems.length} item(s)</span>
          </div>
          <ResultTable
            codeLabel="Item code"
            nameLabel="Description"
            rows={filteredItems}
            loading={itemsQuery.isLoading}
            error={itemsQuery.isError ? (itemsQuery.error as Error)?.message || "Could not load items." : (itemsQuery.data?.data.error ?? null)}
          />
        </div>
      ) : (
        <div className="space-y-4">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div className="w-full max-w-sm">
              <label className="mb-1 block text-[11px] font-semibold uppercase tracking-wider text-[#5E6870]">
                Analysis dimension
              </label>
              <CustomListbox
                value={dimension}
                onChange={setDimension}
                options={ANALYSIS_DIMENSIONS.map((d) => ({ value: d.id, label: `${d.name} (${d.id})` }))}
                className={inputCls}
                buttonClassName="w-full"
                ariaLabel="Analysis dimension"
              />
            </div>
            <div className="flex items-center gap-3">
              <SearchBox value={codeSearch} onChange={setCodeSearch} placeholder="Search by code or name…" />
              <span className="whitespace-nowrap text-xs text-[#5E6870]">{filteredCodes.length} code(s)</span>
            </div>
          </div>
          <div className="text-xs text-[#5E6870]">
            Showing <span className="font-semibold text-[#1F2933]">{analysisDimensionName(dimension)}</span> codes.
          </div>
          <ResultTable
            codeLabel="Code"
            nameLabel="Name"
            rows={filteredCodes}
            loading={codesQuery.isLoading}
            error={codesQuery.isError ? (codesQuery.error as Error)?.message || "Could not load analysis codes." : (codesQuery.data?.data.error ?? null)}
          />
        </div>
      )}
    </div>
  );
}
