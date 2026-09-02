/**
 * AccountMultiSelect
 *
 * Searchable, multi-select dropdown for SunSystems supplier accounts.
 * Shows account code + description, supports keyboard navigation, and
 * portals the dropdown so it escapes any overflow-hidden parent.
 */
import React, {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { Search, X, Check, ChevronDown, Loader2 } from "lucide-react";
import type { SunSystemsAccount } from "@/services/api";

interface Props {
  accounts: SunSystemsAccount[];
  value: string[];                          // selected account codes
  onChange: (codes: string[]) => void;
  isLoading?: boolean;
  error?: string | null;
  placeholder?: string;
  className?: string;
}

export default function AccountMultiSelect({
  accounts,
  value,
  onChange,
  isLoading,
  error,
  placeholder = "All accounts",
  className = "",
}: Props) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const [style, setStyle] = useState<React.CSSProperties>({ top: 0, left: 0, width: 320 });

  // ── Close on outside click ──────────────────────────────────────────────
  useEffect(() => {
    function onDown(e: MouseEvent) {
      if (!(e.target instanceof Node)) return;
      if (!triggerRef.current?.contains(e.target) && !panelRef.current?.contains(e.target)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, []);

  // ── Position the portal dropdown ────────────────────────────────────────
  useLayoutEffect(() => {
    if (!open || !triggerRef.current) return;

    const calc = () => {
      const r = triggerRef.current!.getBoundingClientRect();
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const pad = 8;
      const w = Math.min(420, Math.max(r.width, 280));
      let left = r.left;
      if (left + w + pad > vw) left = r.right - w;
      left = Math.max(pad, left);
      const spaceBelow = vh - r.bottom - pad;
      const spaceAbove = r.top - pad;
      const maxH = Math.max(200, Math.min(360, spaceBelow > spaceAbove ? spaceBelow : spaceAbove));
      const top = spaceBelow >= spaceAbove ? r.bottom + 4 : r.top - 4 - maxH;
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

  // ── Focus search when opening ───────────────────────────────────────────
  useEffect(() => {
    if (open) setTimeout(() => searchRef.current?.focus(), 30);
    else setSearch("");
  }, [open]);

  // ── Filtered list ───────────────────────────────────────────────────────
  const q = search.trim().toLowerCase();
  const filtered = q
    ? accounts.filter(
        (a) =>
          a.account_code.toLowerCase().includes(q) ||
          a.description.toLowerCase().includes(q)
      )
    : accounts;

  // ── Helpers ─────────────────────────────────────────────────────────────
  const isSelected = (code: string) => value.includes(code);

  const toggle = (code: string) => {
    if (isSelected(code)) {
      onChange(value.filter((c) => c !== code));
    } else {
      onChange([...value, code]);
    }
  };

  const selectAll = () => onChange(filtered.map((a) => a.account_code));
  const clearAll  = () => onChange([]);

  // ── Trigger label ───────────────────────────────────────────────────────
  let triggerLabel: React.ReactNode;
  if (isLoading) {
    triggerLabel = (
      <span className="flex items-center gap-1.5 text-[#5E6870]">
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        Loading accounts…
      </span>
    );
  } else if (value.length === 0) {
    triggerLabel = <span className="text-[#8C969E]">{placeholder}</span>;
  } else if (value.length === 1) {
    const acct = accounts.find((a) => a.account_code === value[0]);
    triggerLabel = (
      <span className="truncate font-medium text-[#1F2933]">
        <span className="font-mono text-[#287EAD]">{value[0]}</span>
        {acct?.description ? ` — ${acct.description}` : ""}
      </span>
    );
  } else {
    triggerLabel = (
      <span className="text-[#1F2933]">
        <span className="font-bold text-[#287EAD]">{value.length}</span> accounts selected
      </span>
    );
  }

  return (
    <div className={`relative w-full ${className}`}>
      {/* Trigger */}
      <button
        ref={triggerRef}
        type="button"
        disabled={isLoading}
        onClick={() => setOpen((v) => !v)}
        className={`flex h-9 w-full items-center justify-between gap-2 rounded border bg-white px-3 text-sm transition-colors ${
          open
            ? "border-[#287EAD] ring-1 ring-[#287EAD]"
            : "border-[#AEB5BB] hover:border-[#287EAD]"
        } ${isLoading ? "cursor-not-allowed opacity-60" : "cursor-pointer"}`}
      >
        <span className="min-w-0 flex-1 truncate text-left">{triggerLabel}</span>
        <div className="flex shrink-0 items-center gap-1">
          {value.length > 0 && !isLoading && (
            <span
              role="button"
              tabIndex={0}
              onClick={(e) => { e.stopPropagation(); clearAll(); }}
              onKeyDown={(e) => e.key === "Enter" && (e.stopPropagation(), clearAll())}
              className="flex h-4 w-4 items-center justify-center rounded-full text-[#5E6870] hover:bg-[#EEF6FB] hover:text-[#287EAD]"
            >
              <X className="h-3 w-3" />
            </span>
          )}
          <ChevronDown className={`h-4 w-4 text-[#5E6870] transition-transform ${open ? "rotate-180" : ""}`} />
        </div>
      </button>

      {/* Error */}
      {error && (
        <p className="mt-1 text-[10px] text-red-600">{error}</p>
      )}

      {/* Dropdown portal */}
      {open && createPortal(
        <div
          ref={panelRef}
          className="fixed z-50 flex flex-col overflow-hidden rounded-md border border-[#C8CDD2] bg-white shadow-lg"
          style={style}
        >
          {/* Search */}
          <div className="flex items-center gap-2 border-b border-[#E5E9EC] px-3 py-2">
            <Search className="h-3.5 w-3.5 shrink-0 text-[#5E6870]" />
            <input
              ref={searchRef}
              type="text"
              placeholder="Search by code or name…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="flex-1 bg-transparent text-sm text-[#1F2933] outline-none placeholder:text-[#8C969E]"
            />
            {search && (
              <button type="button" onClick={() => setSearch("")} className="text-[#5E6870] hover:text-[#1F2933]">
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </div>

          {/* Select / clear all bar */}
          <div className="flex items-center justify-between border-b border-[#E5E9EC] bg-[#F8F9FA] px-3 py-1.5">
            <span className="text-[10px] font-semibold uppercase tracking-wider text-[#5E6870]">
              {filtered.length} of {accounts.length} shown
            </span>
            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={selectAll}
                className="text-[10px] font-semibold text-[#287EAD] hover:underline"
              >
                Select all shown
              </button>
              {value.length > 0 && (
                <button
                  type="button"
                  onClick={clearAll}
                  className="text-[10px] font-semibold text-[#5E6870] hover:text-red-600 hover:underline"
                >
                  Clear ({value.length})
                </button>
              )}
            </div>
          </div>

          {/* Account list */}
          <div className="flex-1 overflow-y-auto">
            {filtered.length === 0 ? (
              <p className="py-8 text-center text-xs text-[#5E6870]">
                {accounts.length === 0 ? "No accounts loaded." : "No accounts match your search."}
              </p>
            ) : (
              filtered.map((acct) => {
                const selected = isSelected(acct.account_code);
                return (
                  <button
                    key={acct.account_code}
                    type="button"
                    onClick={() => toggle(acct.account_code)}
                    className={`flex w-full items-center gap-3 px-3 py-2.5 text-left transition-colors ${
                      selected
                        ? "bg-[#EEF6FB]"
                        : "hover:bg-[#F3F5F6]"
                    }`}
                  >
                    {/* Checkbox */}
                    <span className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border ${
                      selected
                        ? "border-[#287EAD] bg-[#287EAD]"
                        : "border-[#AEB5BB]"
                    }`}>
                      {selected && <Check className="h-2.5 w-2.5 text-white" />}
                    </span>

                    {/* Code + description */}
                    <span className="min-w-0 flex-1">
                      <span className="font-mono text-xs font-bold text-[#287EAD]">
                        {acct.account_code}
                      </span>
                      {acct.description && (
                        <span className="ml-2 truncate text-xs text-[#1F2933]">
                          {acct.description}
                        </span>
                      )}
                    </span>
                  </button>
                );
              })
            )}
          </div>
        </div>,
        document.body
      )}
    </div>
  );
}
