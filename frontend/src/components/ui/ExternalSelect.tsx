/**
 * ExternalSelect
 *
 * Generic searchable lookup for records fetched from SunSystems. One control
 * serves every External source the form designer offers (items today, analysis
 * codes next) so we do not need a bespoke field type per entity.
 *
 * The caller passes a `source` key; the registry below maps it to a fetcher and
 * normalises the response into { code, description, meta }. The visual style
 * mirrors AccountMultiSelect (blue-bordered panel, monospaced code column,
 * search bar) so the two lookups feel like one family.
 */
import React, {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { Search, X, ChevronDown, Loader2, Check } from "lucide-react";
import { sunsystemsAPI } from "@/services/api";
import { useQuery } from "@tanstack/react-query";

export interface ExternalRecord {
  code: string;
  description: string;
  /** Optional third column (e.g. item type). */
  meta?: string;
  /** Extra source fields used for autofill, e.g. { unit: "EA" } for items. */
  data?: Record<string, string>;
}

export interface ExternalSourceDef {
  value: string;
  label: string;
  noun: string;
  plural: string;
  /** Some sources (analysis codes) are fetched one dimension at a time. */
  needsDimension?: boolean;
  fetch: (params: { dimension?: string }) => Promise<ExternalRecord[]>;
}

/* Single source of truth for the External sources the designer can pick. Add a
 * new entry here (and the matching backend view) to offer another entity. */
export const EXTERNAL_SOURCES: ExternalSourceDef[] = [
  {
    value: "items",
    label: "Items",
    noun: "item",
    plural: "items",
    fetch: () =>
      sunsystemsAPI.getItems().then((r) =>
        (r.data.items ?? []).map((it) => ({
          code: it.item_code,
          description: it.description,
          data: { unit: it.base_item_unit ?? "", item_type: it.item_type ?? "" },
        })),
      ),
  },
  {
    value: "analysis_codes",
    label: "Analysis Codes",
    noun: "analysis code",
    plural: "analysis codes",
    needsDimension: true,
    fetch: ({ dimension }) =>
      dimension
        ? sunsystemsAPI.getAnalysisCodes({ dimension }).then((r) =>
            (r.data.analysis_codes ?? []).map((c) => ({
              code: c.analysis_code,
              description: c.name,
              data: { dimension_id: c.analysis_dimension_id },
            })),
          )
        : Promise.resolve([]),
  },
];

export function externalSourceDef(source: string | undefined): ExternalSourceDef | undefined {
  return EXTERNAL_SOURCES.find((s) => s.value === source);
}

interface Props {
  source: string;
  /** Required by dimension-scoped sources such as analysis codes. */
  dimension?: string;
  value: string[] | string;
  onChange: (value: string[] | string) => void;
  multi?: boolean;
  disabled?: boolean;
  compact?: boolean;
  placeholder?: string;
  className?: string;
  /** Show only the code in the box and put the record's (long) name under it.
   * Ignored for multi-select, where the count is more useful. */
  showSelectedName?: boolean;
  /** Called with the full record whenever a value is picked (not cleared).
   * Used to auto-fill sibling fields, e.g. an item's BaseItemUnit. */
  onSelectRecord?: (record: ExternalRecord) => void;
}

export default function ExternalSelect({
  source,
  dimension,
  value,
  onChange,
  multi = false,
  disabled = false,
  compact = false,
  placeholder,
  className = "",
  showSelectedName = false,
  onSelectRecord,
}: Props) {
  const def = externalSourceDef(source);
  const needsDimension = !!def?.needsDimension && !dimension;
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");

  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const [style, setStyle] = useState<React.CSSProperties>({ top: 0, left: 0, width: 320 });

  const { data: records, isLoading, isError, error } = useQuery({
    queryKey: ["sunsystems", "external", source, dimension ?? ""],
    queryFn: () => (def ? def.fetch({ dimension }) : Promise.resolve([])),
    enabled: !!def && !needsDimension,
    staleTime: 5 * 60_000,
  });

  const rows = records ?? [];
  const valueArray = Array.isArray(value) ? value : value ? [value] : [];

  /* ── Close on outside click or Escape ─────────────────────────────────── */
  useEffect(() => {
    function onDown(e: MouseEvent) {
      if (!(e.target instanceof Node)) return;
      if (
        !triggerRef.current?.contains(e.target) &&
        !panelRef.current?.contains(e.target)
      ) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, []);

  /* ── Portal positioning ────────────────────────────────────────────────── */
  useLayoutEffect(() => {
    if (!open || !triggerRef.current) return;
    const calc = () => {
      const r = triggerRef.current!.getBoundingClientRect();
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const pad = 8;
      const w = Math.min(500, Math.max(r.width, 300));
      let left = r.left;
      if (left + w + pad > vw) left = r.right - w;
      left = Math.max(pad, left);
      const spaceBelow = vh - r.bottom - pad;
      const spaceAbove = r.top - pad;
      const maxH = Math.max(200, Math.min(360, spaceBelow > spaceAbove ? spaceBelow : spaceAbove));
      const top = spaceBelow >= spaceAbove ? r.bottom + 2 : r.top - 2 - maxH;
      setStyle({ top, left, width: w, maxHeight: maxH });
    };
    calc();
    window.addEventListener("resize", calc);
    window.addEventListener("scroll", calc, true);
    return () => {
      window.removeEventListener("resize", calc);
      window.removeEventListener("scroll", calc, true);
    };
  }, [open]);

  useEffect(() => {
    if (open) setTimeout(() => searchRef.current?.focus(), 30);
    else setSearch("");
  }, [open]);

  const byCode = useMemo(() => {
    const m = new Map<string, ExternalRecord>();
    for (const r of rows) m.set(r.code, r);
    return m;
  }, [rows]);

  const q = search.trim().toLowerCase();
  const filtered = q
    ? rows.filter(
        (r) =>
          r.code.toLowerCase().includes(q) ||
          r.description.toLowerCase().includes(q) ||
          (r.meta ?? "").toLowerCase().includes(q),
      )
    : rows;

  const isSelected = (code: string) => valueArray.includes(code);
  const labelFor = (code: string) => {
    const rec = byCode.get(code);
    return rec?.description ? `${code} — ${rec.description}` : code;
  };

  const toggle = (code: string) => {
    const rec = byCode.get(code);
    if (multi) {
      if (!isSelected(code) && rec) onSelectRecord?.(rec);
      const next = isSelected(code)
        ? valueArray.filter((c) => c !== code)
        : [...valueArray, code];
      onChange(next);
    } else {
      if (rec) onSelectRecord?.(rec);
      onChange(code);
      setOpen(false);
    }
  };

  const selectAll = () => {
    const all = Array.from(new Set([...valueArray, ...filtered.map((r) => r.code)]));
    onChange(all);
  };
  const clearAll = () => onChange(multi ? [] : "");

  const noun = def ? (multi ? def.plural : def.noun) : "record";
  const displayPlaceholder = placeholder ?? (def ? `Select ${noun}…` : "Select…");
  const selectedName = valueArray.length === 1 ? (byCode.get(valueArray[0])?.description ?? "") : "";
  const showNameOutside = showSelectedName && !multi && valueArray.length === 1 && !!selectedName;

  let triggerText: React.ReactNode;
  if (valueArray.length === 0) {
    triggerText = <span className="text-[#8C969E]">{displayPlaceholder}</span>;
  } else if (valueArray.length === 1) {
    triggerText = <span className="truncate text-[#1F2933]">{showNameOutside ? valueArray[0] : labelFor(valueArray[0])}</span>;
  } else {
    triggerText = (
      <span className="truncate text-[#1F2933]">
        <span className="font-semibold text-[#287EAD]">{valueArray.length}</span> {def?.plural ?? "items"} selected
      </span>
    );
  }

  const heightCls = compact ? "min-h-[32px] px-2 py-1 text-xs" : "min-h-[40px] px-3 py-2 text-sm";

  return (
    <div className={`relative ${className}`}>
      <button
        ref={triggerRef}
        type="button"
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
        className={`flex w-full items-center justify-between gap-2 border border-[#AEB5BB] bg-white text-left outline-none transition-colors focus:border-[#287EAD] focus:ring-2 focus:ring-[#287EAD]/15 disabled:cursor-not-allowed disabled:bg-slate-50 disabled:text-slate-400 ${heightCls}`}
      >
        <span className="flex min-w-0 items-center gap-1.5">{triggerText}</span>
        <ChevronDown className="h-3.5 w-3.5 flex-shrink-0 text-[#5E6870]" />
      </button>
      {showNameOutside && (
        <p className="mt-1 break-words text-xs leading-snug text-[#5E6870]" title={selectedName}>
          {selectedName}
        </p>
      )}

      {open && !disabled && createPortal(
        <div
          ref={panelRef}
          className="fixed z-[120] flex flex-col overflow-hidden rounded-md border bg-white shadow-2xl"
          style={{ ...style, borderColor: "#287EAD" }}
        >
          <div className="flex items-center gap-2 border-b border-[#D0E6F0] px-3 py-2">
            <Search className="h-4 w-4 flex-shrink-0 text-[#5E6870]" />
            <input
              ref={searchRef}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={`Search ${def?.plural ?? "records"}…`}
              className="min-w-0 flex-1 bg-transparent text-[13px] text-[#1F2933] outline-none placeholder:text-[#8C969E]"
            />
            {search && (
              <button type="button" onClick={() => setSearch("")} className="text-[#5E6870] hover:text-[#1F2933]">
                <X className="h-4 w-4" />
              </button>
            )}
          </div>

          <div className="flex items-center justify-between border-b border-[#D0E6F0] bg-[#F3F8FB] px-3 py-1.5">
            <span className="text-[11px] font-semibold uppercase tracking-wider text-[#5E6870]">
              {isLoading ? "Loading…" : `${filtered.length} of ${rows.length} shown`}
            </span>
            <div className="flex items-center gap-4">
              {multi && rows.length > 0 && (
                <button type="button" onClick={selectAll} className="text-[11px] font-semibold text-[#287EAD] hover:underline">
                  Select all shown
                </button>
              )}
              {valueArray.length > 0 && (
                <button type="button" onClick={clearAll} className="text-[11px] font-semibold text-[#5E6870] hover:text-red-600 hover:underline">
                  Clear ({valueArray.length})
                </button>
              )}
            </div>
          </div>

          <div className="flex-1 overflow-y-auto">
            {isLoading ? (
              <div className="flex items-center justify-center gap-2 py-10 text-[13px] text-[#5E6870]">
                <Loader2 className="h-4 w-4 animate-spin" /> Loading {def?.plural ?? "records"}…
              </div>
            ) : isError ? (
              <p className="px-4 py-10 text-center text-[13px] text-red-600">
                {(error as Error)?.message || `Could not load ${def?.plural ?? "records"}.`}
              </p>
            ) : !def ? (
              <p className="px-4 py-10 text-center text-[13px] text-[#5E6870]">
                This External source is not available yet.
              </p>
            ) : needsDimension ? (
              <p className="px-4 py-10 text-center text-[13px] text-[#5E6870]">
                Choose an analysis dimension in the field settings first.
              </p>
            ) : filtered.length === 0 ? (
              <p className="px-4 py-10 text-center text-[13px] text-[#5E6870]">
                {rows.length === 0 ? `No ${def.plural} returned.` : "Nothing matches your search."}
              </p>
            ) : (
              filtered.map((rec) => {
                const selected = isSelected(rec.code);
                return (
                  <button
                    key={rec.code}
                    type="button"
                    onClick={() => toggle(rec.code)}
                    className={`flex w-full items-center text-left transition-colors ${selected ? "bg-[#EEF6FB]" : "hover:bg-[#F3F8FB]"}`}
                    style={{ borderBottom: "1px solid #E5EEF4", minHeight: "34px" }}
                  >
                    <span className="flex shrink-0 items-center justify-center px-3">
                      <span className={`flex h-4 w-4 items-center justify-center rounded border transition-colors ${selected ? "border-[#287EAD] bg-[#287EAD]" : "border-[#AEB5BB] bg-white"}`}>
                        {selected && (multi ? <Check className="h-2.5 w-2.5 text-white" /> : <span className="h-1.5 w-1.5 rounded-full bg-white" />)}
                      </span>
                    </span>
                    <span className="shrink-0 py-2 pr-4 font-mono text-[13px] font-bold text-[#287EAD]" style={{ width: "110px" }}>
                      {rec.code}
                    </span>
                    <span className="h-full self-stretch bg-[#E5EEF4]" style={{ width: "1px" }} />
                    <span className="min-w-0 flex-1 truncate px-4 py-2 text-[13px] text-[#1F2933]">
                      {rec.description || <span className="text-[#8C969E]">—</span>}
                    </span>
                  </button>
                );
              })
            )}
          </div>

          {multi && valueArray.length > 0 && (
            <div className="flex items-center justify-between border-t border-[#D0E6F0] bg-[#F3F8FB] px-4 py-2">
              <span className="text-[12px] text-[#5E6870]">
                <span className="font-bold text-[#287EAD]">{valueArray.length}</span> {def?.plural ?? "items"} selected
              </span>
            </div>
          )}
        </div>,
        document.body,
      )}
    </div>
  );
}
