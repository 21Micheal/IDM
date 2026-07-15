/**
 * Pull the most useful human-readable message out of an Axios/DRF error.
 *
 * DRF reports validation problems in several shapes:
 *   - { detail: "..." }
 *   - { non_field_errors: ["..."] }
 *   - { <field_key>: ["..."] }            ← e.g. our per-attribute uniqueness errors
 *   - nested combinations of the above
 *
 * We walk the payload, preferring `detail`/`non_field_errors`, then fall back to
 * the first field-level message, and finally to the supplied fallback.
 */
export function extractApiError(error: unknown, fallback = "Something went wrong. Please try again."): string {
  const data = (error as { response?: { data?: unknown } })?.response?.data;
  return firstMessage(data) ?? fallback;
}

function firstMessage(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value === "string") return value.trim() || null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const message = firstMessage(item);
      if (message) return message;
    }
    return null;
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    // Surface the conventional top-level keys first…
    for (const key of ["detail", "non_field_errors"]) {
      if (key in record) {
        const message = firstMessage(record[key]);
        if (message) return message;
      }
    }
    // …then any field-specific error (uniqueness, required, etc.).
    for (const nested of Object.values(record)) {
      const message = firstMessage(nested);
      if (message) return message;
    }
  }
  return null;
}
