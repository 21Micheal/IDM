const MIME_FORMATS: Record<string, string> = {
  "application/pdf": "PDF",
  "application/msword": "DOC",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "DOCX",
  "application/vnd.ms-excel": "XLS",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "XLSX",
  "application/vnd.ms-powerpoint": "PPT",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": "PPTX",
  "text/plain": "TXT",
  "text/csv": "CSV",
  "image/jpeg": "JPG",
  "image/png": "PNG",
  "image/gif": "GIF",
  "image/webp": "WEBP",
  "image/tiff": "TIFF",
};

const EXTENSION_FORMATS: Record<string, string> = {
  jpeg: "JPG",
  jpg: "JPG",
  tif: "TIFF",
};

export function formatDocumentFileType(fileName?: string | null, mimeType?: string | null) {
  if (mimeType && MIME_FORMATS[mimeType]) return MIME_FORMATS[mimeType];

  const extension = fileName?.split(".").pop()?.trim().toLowerCase();
  if (extension) return EXTENSION_FORMATS[extension] ?? extension.toUpperCase();

  if (mimeType?.startsWith("image/")) return mimeType.slice(6).toUpperCase();
  if (mimeType?.startsWith("text/")) return mimeType.slice(5).toUpperCase();

  return "File";
}
