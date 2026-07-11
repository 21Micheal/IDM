import React, { useEffect, useRef, useState } from "react";

interface Option {
  value: string;
  label: React.ReactNode;
}

interface Props {
  value: string;
  onChange: (value: string) => void;
  options: Option[];
  className?: string;
  buttonClassName?: string;
  listClassName?: string;
  optionClassName?: string;
  ariaLabel?: string;
}

export default function CustomListbox({
  value,
  onChange,
  options,
  className = "",
  buttonClassName = "",
  listClassName = "",
  optionClassName = "",
  ariaLabel,
}: Props) {
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    function onDocClick(e: MouseEvent) {
      if (!rootRef.current) return;
      if (e.target instanceof Node && !rootRef.current.contains(e.target)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, []);

  useEffect(() => {
    if (!open) setActiveIndex(null);
  }, [open]);

  useEffect(() => {
    // keep activeIndex synced to current value when opening
    if (open) {
      const idx = options.findIndex((o) => o.value === value);
      setActiveIndex(idx >= 0 ? idx : null);
    }
  }, [open, options, value]);

  // refs for options to allow scrolling the active item into view
  const optionRefs = useRef<Array<HTMLLIElement | null>>([]);

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setOpen(true);
      setActiveIndex((current) => {
        const next = current == null ? 0 : Math.min(options.length - 1, current + 1);
        return next;
      });
      return;
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setOpen(true);
      setActiveIndex((current) => {
        const next = current == null ? options.length - 1 : Math.max(0, current - 1);
        return next;
      });
      return;
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      if (open && activeIndex != null) {
        onChange(options[activeIndex].value);
        setOpen(false);
        buttonRef.current?.focus();
      } else {
        setOpen(true);
      }
      return;
    } else if (e.key === "Escape") {
      setOpen(false);
      buttonRef.current?.focus();
      return;
    }
  }

  // keep active option scrolled into view
  useEffect(() => {
    if (activeIndex != null && optionRefs.current[activeIndex]) {
      optionRefs.current[activeIndex]?.scrollIntoView({ block: "nearest" });
    }
  }, [activeIndex]);

  return (
    <div ref={rootRef} className={`relative inline-block ${className}`}>
      <button
        ref={buttonRef}
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={onKeyDown}
        className={`text-left flex items-center justify-between gap-2 ${buttonClassName}`}
      >
        <span className="truncate">
          {options.find((o) => o.value === value)?.label ?? options[0]?.label}
        </span>
        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" className="opacity-60">
          <path d="M6 9l6 6 6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      {open && (
        <ul
          role="listbox"
          tabIndex={-1}
          aria-label={ariaLabel}
          className={`absolute z-50 mt-1 w-full max-h-56 overflow-auto rounded-md border border-[#C8CDD2] bg-white py-1 shadow-sm no-scrollbar ${listClassName}`}
          onKeyDown={onKeyDown}
        >
          {options.map((opt, idx) => {
            const selected = opt.value === value;
            const active = idx === activeIndex;
            // stronger contrast for selected state, and explicit text colors for all states
            const baseText = "text-[#1F2933]";
            const selectedClasses = "bg-[#1E6F99] text-white";
            const activeClasses = "bg-[#EEF6FB] text-[#1F2933]";
            const defaultClasses = `${baseText}`;
            return (
              <li
                ref={(el) => (optionRefs.current[idx] = el)}
                key={String(opt.value) + idx}
                role="option"
                aria-selected={selected}
                onClick={() => {
                  onChange(opt.value);
                  setOpen(false);
                  buttonRef.current?.focus();
                }}
                onMouseEnter={() => setActiveIndex(idx)}
                className={`cursor-pointer px-3 py-2 text-sm ${optionClassName} ${selected ? selectedClasses : active ? activeClasses : defaultClasses}`}
              >
                <span className="truncate">{opt.label}</span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
