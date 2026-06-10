/**
 * Reference sources for template `reference` / `user` form fields.
 *
 * A field's `referenceSource` (e.g. "users", "documents", "departments") maps to
 * a real backend list endpoint. A picked value is stored as a structured
 * `ReferenceValue` ({ id, label, source }) so the form/PDF/search can show a
 * human label while preserving a link to the underlying record.
 */
import {
  usersAPI,
  groupsAPI,
  departmentsAPI,
  documentsAPI,
  documentTypesAPI,
} from "@/services/api";

export type ReferenceOption = { id: string; label: string };

export type ReferenceValue = { id: string; label: string; source?: string };

type Source = {
  /** Canonical source key stored on the value. */
  key: string;
  /** Whether the backend list endpoint honours a `search` query param. */
  serverSearch: boolean;
  fetch: (search: string) => Promise<ReferenceOption[]>;
};

function unwrap(res: { data: unknown }): Record<string, unknown>[] {
  const data = res.data as { results?: unknown[] } | unknown[];
  const list = Array.isArray(data) ? data : (data?.results ?? []);
  return (list as Record<string, unknown>[]) ?? [];
}

function str(value: unknown): string {
  return value == null ? "" : String(value);
}

const SOURCES: Record<string, Source> = {
  users: {
    key: "users",
    serverSearch: true,
    fetch: async (search) =>
      unwrap(await usersAPI.list({ search, page_size: 20 })).map((u) => ({
        id: str(u.id),
        label:
          str(u.full_name) ||
          `${str(u.first_name)} ${str(u.last_name)}`.trim() ||
          str(u.email),
      })),
  },
  groups: {
    key: "groups",
    serverSearch: false,
    fetch: async () =>
      unwrap(await groupsAPI.list()).map((g) => ({ id: str(g.id), label: str(g.name) })),
  },
  departments: {
    key: "departments",
    serverSearch: false,
    fetch: async () =>
      unwrap(await departmentsAPI.list()).map((d) => ({ id: str(d.id), label: str(d.name) })),
  },
  documents: {
    key: "documents",
    serverSearch: true,
    fetch: async (search) =>
      unwrap(await documentsAPI.list({ search, page_size: 20 })).map((d) => ({
        id: str(d.id),
        label: str(d.reference_number)
          ? `${str(d.title)} (${str(d.reference_number)})`
          : str(d.title),
      })),
  },
  document_types: {
    key: "document_types",
    serverSearch: false,
    fetch: async () =>
      unwrap(await documentTypesAPI.list()).map((t) => ({ id: str(t.id), label: str(t.name) })),
  },
};

// Aliases so existing free-text source values keep resolving.
const ALIASES: Record<string, string> = {
  user: "users",
  group: "groups",
  usergroup: "groups",
  department: "departments",
  dept: "departments",
  document: "documents",
  docs: "documents",
  type: "document_types",
  types: "document_types",
  documenttype: "document_types",
  documenttypes: "document_types",
};

function normalizeKey(source: string | undefined): string {
  return (source ?? "").toLowerCase().replace(/[\s_-]+/g, "");
}

/** Resolve a (possibly free-text / aliased) source string to a known Source. */
export function resolveSource(source: string | undefined): Source | undefined {
  const norm = normalizeKey(source);
  if (!norm) return undefined;
  // Direct canonical match (after stripping separators), then aliases.
  const direct = Object.values(SOURCES).find((s) => normalizeKey(s.key) === norm);
  if (direct) return direct;
  const aliased = ALIASES[norm];
  return aliased ? SOURCES[aliased] : undefined;
}

export function isReferenceValue(value: unknown): value is ReferenceValue {
  return Boolean(
    value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      typeof (value as Record<string, unknown>).id === "string" &&
      "label" in (value as Record<string, unknown>),
  );
}

/** Best-effort display label for any stored reference value (object or legacy string). */
export function referenceLabel(value: unknown): string {
  if (isReferenceValue(value)) return value.label;
  return value == null ? "" : String(value);
}
