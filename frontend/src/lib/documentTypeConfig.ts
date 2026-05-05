import type { DocumentType } from "@/types";

const PERSONAL_MARKER = "[[personal_type]]";
const USER_METADATA_MARKER = "[[user_defined_metadata]]";

export type DocumentTypeMetadataMode = "admin_defined" | "user_defined";

export type DocumentTypeConfig = {
  isPersonalType: boolean;
  metadataMode: DocumentTypeMetadataMode;
};

function hasMarker(text: string, marker: string) {
  return text.toLowerCase().includes(marker.toLowerCase());
}

export function stripTypeConfigMarkers(description: string | null | undefined): string {
  const text = (description ?? "").trim();
  return text
    .replace(new RegExp(PERSONAL_MARKER.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"), "")
    .replace(new RegExp(USER_METADATA_MARKER.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"), "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

export function deriveDocumentTypeConfig(type: Partial<DocumentType> | null | undefined): DocumentTypeConfig {
  const description = type?.description ?? "";
  const hasExplicitPersonal = typeof type?.is_personal_type === "boolean";
  const hasExplicitMetadataMode = type?.metadata_mode === "admin_defined" || type?.metadata_mode === "user_defined";

  const markerPersonal = hasMarker(description, PERSONAL_MARKER);
  const markerUserMetadata = hasMarker(description, USER_METADATA_MARKER);

  const isPersonalType = hasExplicitPersonal
    ? Boolean(type?.is_personal_type)
    : markerPersonal || /personal/i.test(type?.name ?? "");

  const metadataMode: DocumentTypeMetadataMode = hasExplicitMetadataMode
    ? (type?.metadata_mode as DocumentTypeMetadataMode)
    : (markerUserMetadata || isPersonalType ? "user_defined" : "admin_defined");

  return { isPersonalType, metadataMode };
}

export function applyDocumentTypeConfigToDescription(
  description: string | null | undefined,
  config: DocumentTypeConfig,
): string {
  const base = stripTypeConfigMarkers(description);
  const markers = [
    config.isPersonalType ? PERSONAL_MARKER : "",
    config.metadataMode === "user_defined" ? USER_METADATA_MARKER : "",
  ].filter(Boolean).join(" ");
  return [base, markers].filter(Boolean).join(" ").trim();
}
