/**
 * Shared runtime helpers for the template builder's three "block" constructs:
 * on-demand sections, add_block/calculate buttons, and linked tables.
 *
 * Mirrored one-for-one by `apps/templates_engine/blocks.py`. Keep the ordering
 * rules in `activeSections` identical on both sides — a section that lands in a
 * different place on the server than the client would validate or render the
 * wrong fields.
 *
 * Design contract:
 *  - The sections a document has added live in the form values under
 *    `__sections_added` (an array of section ids, in click order). No schema
 *    change; `__`-prefixed keys are the existing escape hatch.
 *  - `metadata.form.sections` always keeps ALL sections (raw) so a saved draft
 *    can still add/remove blocks. Only the "active" sections drive rendering,
 *    calculation and validation.
 *  - An `embed` table reference is materialised into a plain `table` field from
 *    its saved snapshot — the runtime never fetches the source template.
 */

export interface AnyTableRef {
  scope?: string;
  templateId?: string;
  tableKey?: string;
  mode?: string;
  sync?: string;
  displayColumn?: string;
  snapshot?: { columns?: unknown[]; takenAt?: string; minRows?: number } | null;
}

export interface AnyButtonConfig {
  action?: string;
  variant?: string;
  targetSectionId?: string;
  placement?: string;
  anchorSectionId?: string;
  targetKey?: string;
  calc?: { expression?: string; decimals?: number } | null;
}

export interface AnyField {
  id?: string;
  key?: string;
  type?: string;
  columns?: unknown[];
  minRows?: number;
  colSpan?: number;
  width?: number;
  referenceSource?: string;
  tableRef?: AnyTableRef | null;
  button?: AnyButtonConfig | null;
}

export interface AnySection {
  id?: string;
  onDemand?: boolean;
  removable?: boolean;
  fields?: AnyField[];
}

const SECTION_KEY = "__sections_added";

/** The ids in `__sections_added`, tolerant of junk, de-duplicated, order kept. */
export function addedSectionIds(values: Record<string, unknown> | null | undefined): string[] {
  const raw = values ? (values as Record<string, unknown>)[SECTION_KEY] : undefined;
  let arr: unknown[] = [];
  if (Array.isArray(raw)) {
    arr = raw;
  } else if (typeof raw === "string" && raw.trim()) {
    try {
      const parsed = JSON.parse(raw);
      arr = Array.isArray(parsed) ? parsed : raw.split(",");
    } catch {
      arr = raw.split(",");
    }
  }
  const out: string[] = [];
  for (const value of arr) {
    const id = typeof value === "string" ? value.trim() : value == null ? "" : String(value).trim();
    if (id && !out.includes(id)) out.push(id);
  }
  return out;
}

/** Borrowed columns keep ids/keys but lose SunSystems bindings. */
function cloneColumns(columns: unknown[]): unknown[] {
  return (columns ?? []).map((column) => {
    if (!column || typeof column !== "object") return column;
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { sunsystems, ...rest } = column as Record<string, unknown>;
    return { ...rest };
  });
}

/**
 * Rewrite linked tables into ordinary fields. `embed` becomes a plain `table`
 * with the snapshot's columns; with `rowPickersAsText` (the server) a
 * `row_picker` becomes plain `text` so generic reference reconciliation never
 * sees `source="table"`. Never mutates the input.
 */
export function materializeSections<S extends AnySection>(
  sections: S[] | null | undefined,
  rowPickersAsText = false,
): S[] {
  return (sections ?? []).map((section) => ({
    ...section,
    fields: (section.fields ?? []).map((field) => {
      if (field.type !== "reference" || field.referenceSource !== "table" || !field.tableRef) return field;
      const ref = field.tableRef;
      if (ref.mode === "embed") {
        return {
          ...field,
          type: "table",
          columns: cloneColumns(ref.snapshot?.columns ?? []),
          minRows: field.minRows ?? ref.snapshot?.minRows ?? 1,
          colSpan: 12,
          width: 12,
        };
      }
      if (rowPickersAsText) {
        return { ...field, type: "text", referenceSource: undefined, tableRef: undefined };
      }
      return field;
    }),
  })) as S[];
}

/** Placement for an on-demand section, read from the Button that adds it. */
function placementOf(
  sections: AnySection[],
  sectionId: string,
): { anchorId: string } {
  for (const section of sections) {
    for (const field of section.fields ?? []) {
      const button = field.button;
      if (
        field.type === "button" &&
        button?.action === "add_block" &&
        button.targetSectionId === sectionId
      ) {
        const anchorId =
          button.placement === "below_button"
            ? section.id ?? ""
            : button.placement === "after_section"
              ? button.anchorSectionId ?? ""
              : "";
        return { anchorId };
      }
    }
  }
  return { anchorId: "" };
}

/**
 * Normal sections plus the on-demand ones listed in `__sections_added`, in the
 * derived order. `end_of_form` appends; `below_button` follows the button's
 * section; `after_section` follows `anchorSectionId`; several blocks after the
 * same anchor stack in click order. A missing anchor falls back to the end.
 */
export function activeSections<S extends AnySection>(
  sections: S[] | null | undefined,
  values: Record<string, unknown> | null | undefined,
): S[] {
  const list = sections ?? [];
  const ids = addedSectionIds(values);
  const byId = new Map(list.map((section) => [section.id ?? "", section]));
  const out: S[] = list.filter((section) => !section.onDemand);
  for (const id of ids) {
    const section = byId.get(id);
    if (!section || !section.onDemand) continue;
    if (out.some((existing) => existing.id === section.id)) continue;
    const { anchorId } = placementOf(list, id);
    const index = anchorId ? out.findIndex((existing) => existing.id === anchorId) : -1;
    if (index < 0) {
      out.push(section);
      continue;
    }
    let at = index + 1;
    while (at < out.length && out[at].onDemand) at++;
    out.splice(at, 0, section);
  }
  return out;
}

/** Add `sectionId` to `__sections_added` (idempotent), preserving order. */
export function withSectionAdded(
  values: Record<string, unknown> | null | undefined,
  sectionId: string,
): string[] {
  const ids = addedSectionIds(values);
  if (!ids.includes(sectionId)) ids.push(sectionId);
  return ids;
}

/** Drop `sectionId` from `__sections_added`. */
export function withSectionRemoved(
  values: Record<string, unknown> | null | undefined,
  sectionId: string,
): string[] {
  return addedSectionIds(values).filter((id) => id !== sectionId);
}
