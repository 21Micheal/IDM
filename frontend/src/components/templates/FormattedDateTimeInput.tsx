import { useEffect, useRef, useState } from "react";
import { CalendarDays } from "lucide-react";
import { formatDateTimeValue, parseFormattedDateTime } from "@/lib/dateFormatting";
import DatePickerPopover from "@/components/templates/DatePickerPopover";

type Props = {
  value: string;
  onChange: (value: string) => void;
  dateFormat?: string;
  min?: string;
  max?: string;
  disabled?: boolean;
  className?: string;
  ariaLabel?: string;
};

export default function FormattedDateTimeInput({
  value, onChange, dateFormat, min, max, disabled = false,
  className = "", ariaLabel = "Date and time",
}: Props) {
  const [draft, setDraft] = useState(() => formatDateTimeValue(value, dateFormat));
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLDivElement>(null);

  useEffect(() => setDraft(formatDateTimeValue(value, dateFormat)), [value, dateFormat]);

  const accept = (text: string) => {
    const parsed = parseFormattedDateTime(text, dateFormat);
    if (parsed === null || (parsed && min && parsed < min) || (parsed && max && parsed > max)) return;
    onChange(parsed);
  };

  return (
    <div className="relative min-w-0" ref={anchorRef}>
      <input
        type="text"
        inputMode="text"
        value={draft}
        disabled={disabled}
        placeholder={(dateFormat || "YYYY-MM-DD") + " HH:mm"}
        aria-label={ariaLabel}
        autoComplete="off"
        data-template-date-input="true"
        className={className + " pr-10"}
        onChange={(event) => { setDraft(event.target.value); accept(event.target.value); }}
        onBlur={() => {
          const parsed = parseFormattedDateTime(draft, dateFormat);
          if (parsed === null || (parsed && min && parsed < min) || (parsed && max && parsed > max)) {
            setDraft(formatDateTimeValue(value, dateFormat));
          } else {
            setDraft(formatDateTimeValue(parsed, dateFormat));
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
        onSelect={(date) => {
          if (!date) {
            setDraft("");
            onChange("");
            return;
          }
          const previousTime = value.match(/[T ](\d{2}:\d{2}(?::\d{2})?)/)?.[1] || "00:00";
          let next = `${date}T${previousTime}`;
          if (min && next < min && min.startsWith(date)) next = min.slice(0, 16);
          if (max && next > max && max.startsWith(date)) next = max.slice(0, 16);
          setDraft(formatDateTimeValue(next, dateFormat));
          onChange(next);
        }}
        onClose={() => setOpen(false)}
      />
    </div>
  );
}
