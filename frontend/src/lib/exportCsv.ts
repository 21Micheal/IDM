/**
 * Minimal client-side CSV export for analytics chart data.
 *
 * Columns are taken from the union of keys across all rows (order preserved from
 * the first row, then any extras). Values are stringified and quote-escaped; a
 * UTF-8 BOM is prepended so Excel opens it correctly.
 */
export function exportCsv(filename: string, rows: Array<Record<string, unknown>>): void {
  if (!rows || rows.length === 0) return;

  const columns: string[] = [];
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      if (!columns.includes(key)) columns.push(key);
    }
  }

  const escape = (value: unknown): string => {
    if (value === null || value === undefined) return "";
    const str = String(value);
    return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
  };

  const lines = [
    columns.join(","),
    ...rows.map((row) => columns.map((col) => escape(row[col])).join(",")),
  ];

  const blob = new Blob(["﻿" + lines.join("\r\n")], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename.endsWith(".csv") ? filename : `${filename}.csv`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}
