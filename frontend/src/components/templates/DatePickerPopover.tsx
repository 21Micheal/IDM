import { useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { ChevronLeft, ChevronRight } from "lucide-react";

type Props = {
  open: boolean;
  anchorRef: RefObject<HTMLDivElement>;
  value?: string;
  min?: string;
  max?: string;
  onSelect: (isoDate: string) => void;
  onClose: () => void;
};

const pad = (value: number) => String(value).padStart(2, "0");
const toIso = (date: Date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
const fromIso = (value?: string) => {
  const match = String(value || "").match(/^(\d{4})-(\d{2})-(\d{2})/);
  return match ? new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3])) : null;
};
const monthStart = (date: Date) => new Date(date.getFullYear(), date.getMonth(), 1);
const monthId = (date: Date) => date.getFullYear() * 12 + date.getMonth();

export default function DatePickerPopover({ open, anchorRef, value, min, max, onSelect, onClose }: Props) {
  const popoverRef = useRef<HTMLDivElement>(null);
  const [viewedMonth, setViewedMonth] = useState(() => monthStart(fromIso(value) || fromIso(min) || new Date()));
  const [position, setPosition] = useState({ top: 0, left: 0, width: 288, maxHeight: 320 });
  const minDate = fromIso(min);
  const maxDate = fromIso(max);

  useEffect(() => {
    if (!open) return;
    setViewedMonth(monthStart(fromIso(value) || fromIso(min) || new Date()));
  }, [open, value, min]);

  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const anchor = anchorRef.current;
      if (!anchor) return;
      const rect = anchor.getBoundingClientRect();
      const padding = 8;
      const gap = 4;
      const width = Math.min(288, window.innerWidth - padding * 2);
      const left = Math.max(padding, Math.min(rect.left, window.innerWidth - width - padding));
      const spaceBelow = window.innerHeight - rect.bottom - gap - padding;
      const spaceAbove = rect.top - gap - padding;
      const openAbove = spaceBelow < 300 && spaceAbove > spaceBelow;
      const height = Math.min(320, window.innerHeight - padding * 2);
      const top = openAbove
        ? Math.max(padding, rect.top - gap - height)
        : Math.min(rect.bottom + gap, window.innerHeight - padding - height);
      setPosition({ top, left, width, maxHeight: height });
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open, anchorRef]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (popoverRef.current?.contains(target) || anchorRef.current?.contains(target)) return;
      onClose();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open, anchorRef, onClose]);

  const days = useMemo(() => {
    const first = monthStart(viewedMonth);
    const mondayOffset = (first.getDay() + 6) % 7;
    const start = new Date(first.getFullYear(), first.getMonth(), 1 - mondayOffset);
    return Array.from({ length: 42 }, (_, index) => new Date(start.getFullYear(), start.getMonth(), start.getDate() + index));
  }, [viewedMonth]);
  if (!open || typeof document === "undefined") return null;

  const selectedIso = String(value || "").slice(0, 10);
  const minIso = minDate ? toIso(minDate) : "";
  const maxIso = maxDate ? toIso(maxDate) : "";
  const previousMonth = new Date(viewedMonth.getFullYear(), viewedMonth.getMonth() - 1, 1);
  const nextMonth = new Date(viewedMonth.getFullYear(), viewedMonth.getMonth() + 1, 1);
  const previousDisabled = Boolean(minDate && monthId(new Date(previousMonth.getFullYear(), previousMonth.getMonth() + 1, 0)) < monthId(minDate));
  const nextDisabled = Boolean(maxDate && monthId(nextMonth) > monthId(maxDate));

  return createPortal(
    <div
      ref={popoverRef}
      role="dialog"
      aria-label="Choose date"
      className="fixed z-[500] rounded-md border border-[#C8CDD2] bg-white p-2 shadow-sm"
      style={{ top: position.top, left: position.left, width: position.width, maxHeight: position.maxHeight }}
    >
      <div className="-mx-2 -mt-2 mb-1 flex h-11 items-center justify-between gap-2 rounded-t-md bg-[#C5E6F5] px-2">
        <button type="button" aria-label="Previous month" disabled={previousDisabled}
          onClick={() => setViewedMonth(previousMonth)}
          className="flex h-8 w-8 items-center justify-center rounded-md text-[#1F2933] hover:bg-[#EEF6FB] disabled:cursor-not-allowed disabled:text-[#AEB5BB]">
          <ChevronLeft className="h-4 w-4" strokeWidth={1.8} />
        </button>
        <div className="text-sm font-semibold text-[#1F2933]">
          {viewedMonth.toLocaleDateString("en", { month: "long", year: "numeric" })}
        </div>
        <button type="button" aria-label="Next month" disabled={nextDisabled}
          onClick={() => setViewedMonth(nextMonth)}
          className="flex h-8 w-8 items-center justify-center rounded-md text-[#1F2933] hover:bg-[#EEF6FB] disabled:cursor-not-allowed disabled:text-[#AEB5BB]">
          <ChevronRight className="h-4 w-4" strokeWidth={1.8} />
        </button>
      </div>
      <div className="grid grid-cols-7 border-b border-[#E5E9EC] pb-1 text-center text-[11px] font-medium text-[#687782]">
        {Array.from({ length: 7 }, (_, index) => {
          const day = new Date(2024, 0, 1 + index);
          return <div key={index} className="py-1">{day.toLocaleDateString("en", { weekday: "short" }).slice(0, 2)}</div>;
        })}
      </div>
      <div className="grid grid-cols-7 text-center">
        {days.map((day) => {
          const iso = toIso(day);
          const disabled = (minIso && iso < minIso) || (maxIso && iso > maxIso);
          const selected = iso === selectedIso;
          const today = iso === toIso(new Date());
          const inMonth = day.getMonth() === viewedMonth.getMonth();
          return (
            <button key={iso} type="button" disabled={Boolean(disabled)} aria-pressed={selected}
              aria-label={day.toLocaleDateString("en", { dateStyle: "full" })}
              onClick={() => { onSelect(iso); onClose(); }}
              className={`mx-auto my-0.5 flex h-8 w-8 items-center justify-center rounded-md text-[13px] transition-colors disabled:cursor-not-allowed disabled:text-[#C8CDD2] ${selected ? "bg-[#1E6F99] font-semibold text-white" : today ? "border border-[#1E6F99] font-semibold text-[#1E6F99]" : inMonth ? "text-[#1F2933] hover:bg-[#EEF6FB]" : "text-[#AEB5BB] hover:bg-[#F5F8FA]"}`}>
              {day.getDate()}
            </button>
          );
        })}
      </div>
      <div className="mt-1 flex justify-between border-t border-[#E5E9EC] pt-1">
        <button type="button" onClick={() => { onSelect(""); onClose(); }} className="rounded px-2 py-1 text-xs font-medium text-[#1E6F99] hover:bg-[#EEF6FB]">Clear</button>
        <button type="button" onClick={onClose} className="rounded px-2 py-1 text-xs font-medium text-[#1F2933] hover:bg-[#EEF6FB]">Close</button>
      </div>
    </div>,
    document.body,
  );
}
