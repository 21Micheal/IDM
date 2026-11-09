import { useEffect, useState } from "react";
import { CalendarDays } from "lucide-react";
import { formatDateValue, parseFormattedDate } from "@/lib/dateFormatting";

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
    <div className="relative">
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
      <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground">
        <CalendarDays className="h-4 w-4" />
      </span>
      <input
        type="date"
        tabIndex={-1}
        aria-hidden="true"
        data-template-date-picker="true"
        value={value}
        min={min}
        max={max}
        disabled={disabled}
        className="absolute right-0 top-0 h-full w-10 cursor-pointer opacity-0"
        onChange={(event) => {
          const next = event.target.value;
          setDraft(formatDateValue(next, dateFormat));
          onChange(next);
        }}
      />
    </div>
  );
}
