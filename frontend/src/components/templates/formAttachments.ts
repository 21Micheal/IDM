/**
 * Shared helpers for collecting built-template *form* attachments before a
 * create (templates/{id}/fill) or edit (documents/{id}/update_form) request.
 *
 * File/image form fields — and file columns inside a table field — hold a
 * browser `File` object once the user picks one. Files can't be JSON-encoded,
 * so we split them out into multipart entries and leave a filename placeholder
 * in the JSON `values` (the backend writes a descriptor back in afterwards).
 *
 * Multipart field-name scheme (mirrors apps/documents/form_attachments.py):
 *   • `attachment_<field_key>`                  — a simple file/image field
 *   • `tableattachment_<table_key>~<row>~<col>` — a file cell inside a table
 */

export type FormAttachment = { field: string; file: File };

export const TABLE_SEP = "~";

function isFile(value: unknown): value is File {
  return typeof File !== "undefined" && value instanceof File;
}

/** Build the flat download key for a table file cell (matches the backend). */
export function tableAttachmentKey(tableKey: string, rowIndex: number, colKey: string): string {
  return `${tableKey}${TABLE_SEP}${rowIndex}${TABLE_SEP}${colKey}`;
}

/**
 * Returns JSON-safe `values` (every File replaced by its filename) plus the
 * multipart `attachments` to upload alongside. Existing attachment descriptors
 * (plain objects with a storage_path) are passed through untouched so the
 * backend preserves them.
 */
export function collectFormAttachments(values: Record<string, unknown>): {
  jsonValues: Record<string, unknown>;
  attachments: FormAttachment[];
} {
  const jsonValues: Record<string, unknown> = {};
  const attachments: FormAttachment[] = [];

  for (const [key, value] of Object.entries(values)) {
    if (isFile(value)) {
      attachments.push({ field: `attachment_${key}`, file: value });
      jsonValues[key] = value.name; // placeholder for the rendered view
    } else if (Array.isArray(value)) {
      // Table rows — walk each cell for file uploads.
      jsonValues[key] = value.map((row, rowIndex) => {
        if (!row || typeof row !== "object" || Array.isArray(row)) return row;
        const out: Record<string, unknown> = {};
        for (const [colKey, cell] of Object.entries(row as Record<string, unknown>)) {
          if (isFile(cell)) {
            attachments.push({
              field: `tableattachment_${tableAttachmentKey(key, rowIndex, colKey)}`,
              file: cell,
            });
            out[colKey] = cell.name; // placeholder
          } else {
            out[colKey] = cell;
          }
        }
        return out;
      });
    } else {
      jsonValues[key] = value;
    }
  }

  return { jsonValues, attachments };
}
