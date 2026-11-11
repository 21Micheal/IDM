import { useEffect, useRef, useState } from "react";
import { CalendarDays } from "lucide-react";
import { formatDateValue, parseFormattedDate } from "@/lib/dateFormatting";
import DatePickerPopover from "@/components/templates/DatePickerPopover";

type Props = {
  value: string;
  onChange: (isoDate: string) => void;
  dateFormat?: string;
  min?: string;
  max?: string;
  disabled?: boolean;
  className?: string;
  ariaLabel?: string;
};

export default function FormattedDateInput({
  value,
  onChange,
  dateFormat,
  min,
  max,
  disabled = false,
  className = "",
  ariaLabel = "Date",
}: Props) {
  const [draft, setDraft] = useState(() => formatDateValue(value, dateFormat));
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setDraft(formatDateValue(value, dateFormat));
  }, [value, dateFormat]);

  const accept = (text: string) => {
    const parsed = parseFormattedDate(text, dateFormat);
    if (parsed === null) return;
    if (parsed && min && parsed < min) return;
    if (parsed && max && parsed > max) return;
    onChange(parsed);
  };

  return (
    <div className="relative min-w-0" ref={anchorRef}>
      <input
        type="text"
        inputMode="numeric"
        value={draft}
        disabled={disabled}
        placeholder={dateFormat || "YYYY-MM-DD"}
        aria-label={ariaLabel}
        autoComplete="off"
        data-template-date-input="true"
        className={className + " pr-10"}
        onChange={(event) => {
          setDraft(event.target.value);
          accept(event.target.value);
        }}
        onBlur={() => {
          const parsed = parseFormattedDate(draft, dateFormat);
          if (parsed === null || (parsed && min && parsed < min) || (parsed && max && parsed > max)) {
            setDraft(formatDateValue(value, dateFormat));
          } else {
            setDraft(formatDateValue(parsed, dateFormat));
            if (parsed !== value) onChange(parsed);
          }
        }}
      />
      <button type="button" disabled={disabled} aria-label={`Choose ${ariaLabel.toLowerCase()}`}
        aria-expanded={open} onClick={() => setOpen((current) => !current)}
        className="absolute right-0 top-0 flex h-full w-10 items-center justify-center rounded-r-md text-muted-foreground hover:text-[#287EAD] disabled:cursor-not-allowed">
        <CalendarDays className="h-4 w-4" />
      </button>
      <DatePickerPopover
        open={open}
        anchorRef={anchorRef}
        value={value}
        min={min}
        max={max}
        onSelect={(next) => {
          setDraft(formatDateValue(next, dateFormat));
          onChange(next);
        }}
        onClose={() => setOpen(false)}
      />
    </div>
  );
}
