/**
 * Single source of truth for supported upload formats, shared by the upload page
 * and the "upload new version" drop-zone so the two never drift apart.
 *
 * Matches what the backend can store, preview and OCR: PDF, Office (Word / Excel
 * / PowerPoint) and common image types.
 */

// react-dropzone `accept` map: MIME type → file extensions.
export const ACCEPTED_UPLOAD_FORMATS: Record<string, string[]> = {
  "application/pdf": [".pdf"],
  // Word
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": [".docx"],
  "application/msword": [".doc"],
  // Excel
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": [".xlsx"],
  "application/vnd.ms-excel": [".xls"],
  // PowerPoint
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": [".pptx"],
  "application/vnd.ms-powerpoint": [".ppt"],
  // Images
  "image/png": [".png"],
  "image/jpeg": [".jpg", ".jpeg"],
  "image/tiff": [".tiff", ".tif"],
  "image/bmp": [".bmp"],
  "image/webp": [".webp"],
};

/** Comma-joined `accept` attribute for a plain <input type="file">. */
export const ACCEPTED_UPLOAD_ATTR = Object.entries(ACCEPTED_UPLOAD_FORMATS)
  .flatMap(([mime, exts]) => [mime, ...exts])
  .join(",");

/** Human-readable summary for help text. */
export const SUPPORTED_FORMATS_LABEL =
  "PDF, Word, Excel, PowerPoint and images (PNG, JPG, TIFF, BMP, WebP)";

export const DEFAULT_MAX_FILE_SIZE_MB = 25;

export function mbToBytes(mb: number | null | undefined): number {
  return (mb ?? DEFAULT_MAX_FILE_SIZE_MB) * 1024 * 1024;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
