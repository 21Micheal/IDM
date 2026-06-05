// Centralized status helpers used for client-side filtering and normalization.
export function normalizeStatus(status?: string | null): string {
  return String(status ?? "").toLowerCase().trim().replace(/\s+/g, "_");
}

export function isPendingStatus(status?: string | null): boolean {
  const s = normalizeStatus(status);
  return s.includes("pending");
}

export function statusMatchesFilter(hitStatus?: string | null, filter?: string | null): boolean {
  if (!filter) return true;
  const f = normalizeStatus(filter);
  if (f.startsWith("pending")) return isPendingStatus(hitStatus);
  return normalizeStatus(hitStatus) === f;
}

const _default = {
  normalizeStatus,
  isPendingStatus,
  statusMatchesFilter,
};

export default _default;
