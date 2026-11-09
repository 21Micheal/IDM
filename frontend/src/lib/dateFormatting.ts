const DATE_TOKENS = ["YYYY", "MMMM", "MMM", "YY", "MM", "DD", "M", "D"] as const;

function normalizedFormat(format?: string): string {
  return String(format || "YYYY-MM-DD").trim().toUpperCase();
}

export function formatDateValue(value: unknown, format?: string): string {
  const raw = String(value ?? "");
  const match = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!match) return raw;
  const [, year, month, day] = match;
  const monthNumber = Number(month);
  const replacements: Record<string, string> = {
    YYYY: year,
    YY: year.slice(-2),
    MM: month,
    M: String(monthNumber),
    DD: day,
    D: String(Number(day)),
    MMM: new Date(Date.UTC(Number(year), monthNumber - 1, 1)).toLocaleString("en", { month: "short", timeZone: "UTC" }),
    MMMM: new Date(Date.UTC(Number(year), monthNumber - 1, 1)).toLocaleString("en", { month: "long", timeZone: "UTC" }),
  };
  const fmt = normalizedFormat(format);
  let out = "";
  for (let i = 0; i < fmt.length;) {
    const token = DATE_TOKENS.find((candidate) => fmt.startsWith(candidate, i));
    if (token) {
      out += replacements[token];
      i += token.length;
    } else {
      out += fmt[i];
      i += 1;
    }
  }
  return out;
}

export function parseFormattedDate(input: string, format?: string): string | null {
  const text = input.trim();
  if (!text) return "";
  const isoMatch = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (isoMatch) return validIsoDate(isoMatch[1], isoMatch[2], isoMatch[3]);

  const fmt = normalizedFormat(format);
  const captures: string[] = [];
  let source = "^";
  for (let i = 0; i < fmt.length;) {
    const token = DATE_TOKENS.find((candidate) => fmt.startsWith(candidate, i));
    if (token) {
      captures.push(token);
      source += token === "MMMM" || token === "MMM" ? "([A-Za-z]+)" : token === "YYYY" ? "(\\d{4})" : token === "YY" ? "(\\d{2})" : "(\\d{1,2})";
      i += token.length;
      continue;
    }
    source += fmt[i].replace(/[.*+?^$()|[\]\\]/g, "\\$&");
    i += 1;
  }
  source += "$";
  const match = text.match(new RegExp(source, "i"));
  if (!match) return null;

  let year = "";
  let month = "";
  let day = "";
  captures.forEach((token, index) => {
    const value = match[index + 1];
    if (token === "YYYY") year = value;
    else if (token === "YY") year = String(Number(value) >= 70 ? 1900 + Number(value) : 2000 + Number(value));
    else if (token === "MMM" || token === "MMMM") {
      const target = value.toLowerCase();
      const monthIndex = Array.from({ length: 12 }, (_, i) => new Date(Date.UTC(2020, i, 1)).toLocaleString("en", { month: token === "MMM" ? "short" : "long", timeZone: "UTC" }).toLowerCase()).findIndex((name) => name === target);
      if (monthIndex >= 0) month = String(monthIndex + 1);
    } else if (token === "M" || token === "MM") month = value;
    else if (token === "D" || token === "DD") day = value;
  });
  if (!year || !month || !day) return null;
  return validIsoDate(year, month.padStart(2, "0"), day.padStart(2, "0"));
}

export function formatDateTimeValue(value: unknown, format?: string): string {
  const raw = String(value ?? "");
  const match = raw.match(/^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})(?::(\d{2}))?/);
  if (!match) return raw;
  const time = match[3] && match[3] !== "00" ? `${match[2]}:${match[3]}` : match[2];
  return `${formatDateValue(match[1], format)} ${time}`;
}

export function parseFormattedDateTime(input: string, format?: string): string | null {
  const text = input.trim();
  if (!text) return "";
  const match = text.match(/^(.*?)\s+(\d{1,2}:\d{2}(?::\d{2})?)$/);
  if (!match) return null;
  const date = parseFormattedDate(match[1], format);
  if (!date) return null;
  const timeParts = match[2].split(":").map(Number);
  const [hour, minute, second = 0] = timeParts;
  if (hour > 23 || minute > 59 || second > 59) return null;
  return `${date}T${match[2]}`;
}

function validIsoDate(year: string, month: string, day: string): string | null {
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  if (
    date.getUTCFullYear() !== Number(year)
    || date.getUTCMonth() + 1 !== Number(month)
    || date.getUTCDate() !== Number(day)
  ) return null;
  return year + "-" + month + "-" + day;
}
