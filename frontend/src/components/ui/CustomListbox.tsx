import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

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
  disabled?: boolean;
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
  disabled = false,
}: Props) {
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const [popoverStyle, setPopoverStyle] = useState<React.CSSProperties>({
    top: 0,
    left: 0,
    width: 224,
    maxHeight: 224,
  });
  const rootRef = useRef<HTMLDivElement | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const popoverRef = useRef<HTMLUListElement | null>(null);

  useEffect(() => {
    function onDocClick(e: MouseEvent) {
      if (!(e.target instanceof Node)) return;

      const clickedButton = rootRef.current?.contains(e.target);
      const clickedPopover = popoverRef.current?.contains(e.target);

      if (!clickedButton && !clickedPopover) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, []);

  useEffect(() => {
    if (!open) setActiveIndex(null);
  }, [open]);

  // Calculate viewport-aware positioning for the portaled popover.
  useLayoutEffect(() => {
    if (!open || !buttonRef.current) return;

    const updatePosition = () => {
      if (!buttonRef.current) return;

      const buttonRect = buttonRef.current.getBoundingClientRect();
      const viewportWidth = window.innerWidth;
      const viewportHeight = window.innerHeight;
      const padding = 8;
      const gap = 4;
      const preferredWidth = 320;
      const maxDropdownWidth = Math.min(480, Math.max(160, viewportWidth - padding * 2));
      const width = Math.min(
        maxDropdownWidth,
        Math.max(Math.ceil(buttonRect.width), Math.min(preferredWidth, maxDropdownWidth))
      );

      let left = buttonRect.left;
      if (left + width + padding > viewportWidth) {
        left = buttonRect.right - width;
      }
      left = Math.max(padding, Math.min(left, viewportWidth - width - padding));

      const spaceBelow = viewportHeight - buttonRect.bottom - gap - padding;
      const spaceAbove = buttonRect.top - gap - padding;
      const shouldOpenAbove = spaceBelow < 180 && spaceAbove > spaceBelow;
      const availableHeight = shouldOpenAbove ? spaceAbove : spaceBelow;
      const maxHeight = Math.max(120, Math.min(320, availableHeight));
      const top = shouldOpenAbove
        ? Math.max(padding, buttonRect.top - gap - maxHeight)
        : Math.min(buttonRect.bottom + gap, viewportHeight - padding - maxHeight);

      setPopoverStyle({
        top,
        left,
        width,
        maxHeight,
      });
    };

    updatePosition();
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    
    return () => {
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
    };
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
    if (disabled) return;
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
    <div ref={rootRef} className={`relative inline-block w-full max-w-full ${className}`}>
      <button
        ref={buttonRef}
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        disabled={disabled}
        onClick={() => !disabled && setOpen((v) => !v)}
        onKeyDown={onKeyDown}
        className={`text-left flex max-w-full min-w-0 items-center justify-between gap-2 ${buttonClassName} ${disabled ? "cursor-not-allowed opacity-60" : ""}`}
      >
        <span className="min-w-0 truncate">
          {options.find((o) => o.value === value)?.label ?? options[0]?.label}
        </span>
        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" className="shrink-0 opacity-60">
          <path d="M6 9l6 6 6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      {open &&
        createPortal(
          <ul
            ref={popoverRef}
            role="listbox"
            tabIndex={-1}
            aria-label={ariaLabel}
            className={`fixed z-50 overflow-y-auto overflow-x-hidden rounded-md border border-[#C8CDD2] bg-white py-1 shadow-sm ${listClassName}`}
            onKeyDown={onKeyDown}
            style={popoverStyle}
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
                className={`cursor-pointer px-3 py-2 text-sm leading-snug ${optionClassName} ${selected ? selectedClasses : active ? activeClasses : defaultClasses}`}
              >
                <span className="block break-words">{opt.label}</span>
              </li>
            );
          })}
          </ul>,
          document.body
        )}
    </div>
  );
}
