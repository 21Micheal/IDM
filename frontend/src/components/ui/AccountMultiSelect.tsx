/**
 * AccountMultiSelect
 *
 * Searchable multi-select for SunSystems supplier accounts.
 * Visual style mirrors the SunSystems native lookup:
 *   • Blue border on the dropdown panel
 *   • Two-column rows: monospaced code column | description
 *   • Blue-filled selected rows with white text
 *   • Clean search bar at the top
 */
import React, {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { Search, X, ChevronDown, Loader2, Check } from "lucide-react";
import type { SunSystemsAccount } from "@/services/api";

interface Props {
  accounts: SunSystemsAccount[];
  value: string[];
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
  const [open, setOpen]     = useState(false);
  const [search, setSearch] = useState("");

  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef   = useRef<HTMLDivElement>(null);
  const searchRef  = useRef<HTMLInputElement>(null);
  const [style, setStyle]   = useState<React.CSSProperties>({ top: 0, left: 0, width: 320 });

  // ── Close on outside click or Escape ─────────────────────────────────────
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

  // ── Portal positioning ──────────────────────────────────────────────────
  useLayoutEffect(() => {
    if (!open || !triggerRef.current) return;
    const calc = () => {
      const r   = triggerRef.current!.getBoundingClientRect();
      const vw  = window.innerWidth;
      const vh  = window.innerHeight;
      const pad = 8;
      const w   = Math.min(500, Math.max(r.width, 320));
      let left  = r.left;
      if (left + w + pad > vw) left = r.right - w;
      left = Math.max(pad, left);
      const spaceBelow = vh - r.bottom - pad;
      const spaceAbove = r.top - pad;
      const maxH = Math.max(220, Math.min(380, spaceBelow > spaceAbove ? spaceBelow : spaceAbove));
      const top  = spaceBelow >= spaceAbove ? r.bottom + 2 : r.top - 2 - maxH;
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

  // ── Focus search on open ────────────────────────────────────────────────
  useEffect(() => {
    if (open) setTimeout(() => searchRef.current?.focus(), 30);
    else setSearch("");
  }, [open]);

  // ── Filtering ───────────────────────────────────────────────────────────
  const q = search.trim().toLowerCase();
  const filtered = q
    ? accounts.filter(
        (a) =>
          a.account_code.toLowerCase().includes(q) ||
          a.description.toLowerCase().includes(q)
      )
    : accounts;

  const isSelected  = (code: string) => value.includes(code);
  const toggle      = (code: string) =>
    onChange(isSelected(code) ? value.filter((c) => c !== code) : [...value, code]);
  const selectAll   = () => onChange(filtered.map((a) => a.account_code));
  const clearAll    = () => onChange([]);

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
      <span className="truncate">
        <span className="font-mono font-bold text-[#287EAD]">{value[0]}</span>
        {acct?.description && (
          <span className="ml-2 text-[#1F2933]">{acct.description}</span>
        )}
      </span>
    );
  } else {
    triggerLabel = (
      <span className="text-[#1F2933]">
        <span className="font-bold text-[#287EAD]">{value.length}</span>{" "}
        accounts selected
      </span>
    );
  }

  return (
    <div className={`relative w-full ${className}`}>
      {/* ── Trigger button ── */}
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
          <ChevronDown
            className={`h-4 w-4 text-[#5E6870] transition-transform ${open ? "rotate-180" : ""}`}
          />
        </div>
      </button>

      {error && <p className="mt-1 text-[10px] text-red-600">{error}</p>}

      {/* ── Dropdown portal ── */}
      {open &&
        createPortal(
          <div
            ref={panelRef}
            className="fixed z-50 flex flex-col overflow-hidden bg-white"
            style={{
              ...style,
              border: "1.5px solid #287EAD",
              boxShadow: "0 4px 16px rgba(40,126,173,0.15)",
            }}
          >
            {/* Search bar */}
            <div
              className="flex items-center gap-2 px-3 py-2"
              style={{ borderBottom: "1.5px solid #287EAD" }}
            >
              <Search className="h-4 w-4 shrink-0 text-[#287EAD]" />
              <input
                ref={searchRef}
                type="text"
                placeholder="Search by code or name…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="flex-1 bg-transparent text-[13px] text-[#1F2933] outline-none placeholder:text-[#8C969E]"
              />
              {search && (
                <button
                  type="button"
                  onClick={() => setSearch("")}
                  className="text-[#5E6870] hover:text-[#1F2933]"
                >
                  <X className="h-4 w-4" />
                </button>
              )}
            </div>

            {/* Select / clear toolbar */}
            <div
              className="flex items-center justify-between bg-[#F3F8FB] px-3 py-1.5"
              style={{ borderBottom: "1px solid #D0E6F0" }}
            >
              <span className="text-[11px] font-semibold uppercase tracking-wider text-[#5E6870]">
                {filtered.length} of {accounts.length} shown
              </span>
              <div className="flex items-center gap-4">
                <button
                  type="button"
                  onClick={selectAll}
                  className="text-[11px] font-semibold text-[#287EAD] hover:underline"
                >
                  Select all shown
                </button>
                {value.length > 0 && (
                  <button
                    type="button"
                    onClick={clearAll}
                    className="text-[11px] font-semibold text-[#5E6870] hover:text-red-600 hover:underline"
                  >
                    Clear ({value.length})
                  </button>
                )}
              </div>
            </div>

            {/* Account list */}
            <div className="flex-1 overflow-y-auto">
              {filtered.length === 0 ? (
                <p className="py-10 text-center text-[13px] text-[#5E6870]">
                  {accounts.length === 0
                    ? "No accounts loaded."
                    : "No accounts match your search."}
                </p>
              ) : (
                filtered.map((acct) => {
                  const selected = isSelected(acct.account_code);
                  return (
                    <button
                      key={acct.account_code}
                      type="button"
                      onClick={() => toggle(acct.account_code)}
                      className={`flex w-full items-center gap-0 text-left transition-colors ${
                        selected
                          ? "bg-[#EEF6FB]"
                          : "hover:bg-[#F3F8FB]"
                      }`}
                      style={{ borderBottom: "1px solid #E5EEF4", minHeight: "34px" }}
                    >
                      {/* Checkbox */}
                      <span className="flex shrink-0 items-center justify-center px-3">
                        <span
                          className={`flex h-4 w-4 items-center justify-center rounded border transition-colors ${
                            selected
                              ? "border-[#287EAD] bg-[#287EAD]"
                              : "border-[#AEB5BB] bg-white"
                          }`}
                        >
                          {selected && <Check className="h-2.5 w-2.5 text-white" />}
                        </span>
                      </span>

                      {/* Code column */}
                      <span
                        className="shrink-0 py-2 pr-4 font-mono text-[13px] font-bold text-[#287EAD]"
                        style={{ width: "88px" }}
                      >
                        {acct.account_code}
                      </span>

                      {/* Divider */}
                      <span
                        className="h-full self-stretch bg-[#E5EEF4]"
                        style={{ width: "1px" }}
                      />

                      {/* Description */}
                      <span className="min-w-0 flex-1 truncate px-4 py-2 text-[13px] text-[#1F2933]">
                        {acct.description || (
                          <span className="text-[#8C969E]">—</span>
                        )}
                      </span>
                    </button>
                  );
                })
              )}
            </div>

            {/* Footer count */}
            {value.length > 0 && (
              <div
                className="flex items-center justify-between bg-[#F3F8FB] px-4 py-2"
                style={{ borderTop: "1px solid #D0E6F0" }}
              >
                <span className="text-[12px] text-[#5E6870]">
                  <span className="font-bold text-[#287EAD]">{value.length}</span>{" "}
                  account{value.length !== 1 ? "s" : ""} selected
                </span>
                <button
                  type="button"
                  onClick={clearAll}
                  className="text-[11px] font-semibold text-[#5E6870] hover:text-red-600 hover:underline"
                >
                  Clear all
                </button>
              </div>
            )}
          </div>,
          document.body
        )}
    </div>
  );
}
