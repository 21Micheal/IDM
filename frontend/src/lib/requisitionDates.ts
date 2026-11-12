type DateField = Record<string, any>;

export function requisitionStartDate(
  sections: unknown[],
  values: Record<string, unknown>,
  configuredField = "",
): string {
  const readField = (fieldKey: string): string => {
    if (fieldKey.includes(".")) {
      const [tableKey, columnKey] = fieldKey.split(".", 2);
      const rows = values[tableKey];
      const dates = (Array.isArray(rows) ? rows : [])
        .map((row) => normalizeDate((row as Record<string, unknown>)?.[columnKey]))
        .filter(Boolean)
        .sort();
      return dates[0] ?? "";
    }
    return normalizeDate(values[fieldKey]);
  };

  if (configuredField) return readField(configuredField);

  const candidates: Array<{ priority: number; date: string }> = [];
  for (const section of sections as Array<Record<string, any>>) {
    for (const field of (Array.isArray(section?.fields) ? section.fields : []) as DateField[]) {
      if (field.type === "table") {
        for (const column of (Array.isArray(field.columns) ? field.columns : []) as DateField[]) {
          const priority = datePriority(column);
          if (!priority) continue;
          for (const row of Array.isArray(values[field.key]) ? values[field.key] as Array<Record<string, unknown>> : []) {
            const date = normalizeDate(row?.[column.key]);
            if (date) candidates.push({ priority, date });
          }
        }
      } else {
        const priority = datePriority(field);
        const date = field.key ? normalizeDate(values[field.key]) : "";
        if (priority && date) candidates.push({ priority, date });
      }
    }
  }
  if (!candidates.length) return "";
  const best = Math.max(...candidates.map((candidate) => candidate.priority));
  return candidates.filter((candidate) => candidate.priority === best).map((candidate) => candidate.date).sort()[0];
}

function normalizeDate(value: unknown): string {
  const raw = String(value ?? "").trim();
  return /^\d{4}-\d{2}-\d{2}/.test(raw) ? raw.slice(0, 10) : "";
}

function datePriority(field: DateField): number {
  if (!["date", "datetime", "date_time", "calc_date"].includes(String(field.type || "").toLowerCase())) return 0;
  const label = `${field.label || ""} ${field.key || ""}`.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  if (label.includes("expected travel")) return 0;
  if (label.includes("activity start date") || label.includes("travel start date") || label.includes("workshop from")) return 100;
  if (/\bstart date\b/.test(label)) return 90;
  if (label.includes("date of travel") || /\btravel date\b/.test(label)) return 80;
  if (label.includes("departure date")) return 70;
  return 0;
}
