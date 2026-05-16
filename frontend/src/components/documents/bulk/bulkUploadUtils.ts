import type { DocumentType, MetadataField } from "@/types";
import { applyOcrToFields, type OcrFields } from "@/lib/ocrFieldMatcher";
import type {
  BulkDocReviewState,
  BulkReviewSubmitItem,
  BulkUploadDocumentItem,
} from "./bulkUploadTypes";

const DIRECT_KEYS = new Set([
  "title",
  "supplier",
  "amount",
  "currency",
  "document_date",
  "due_date",
  "quantity",
  "description",
  "uom",
]);

export function getMetadataFieldKey(field: MetadataField): string {
  return (field.key ?? field.field_key ?? "") as string;
}

export function documentNameFromFileName(fileName: string): string {
  if (!fileName) return "";
  return fileName.replace(/\.[^.]+$/, "") || fileName;
}

function parseOcrFields(item: BulkUploadDocumentItem): OcrFields {
  const raw = item.ocr_suggestions;
  if (!raw) return {};
  if (raw.fields) return raw.fields;
  return raw as unknown as OcrFields;
}

export function buildReviewStateFromBatchItem(
  item: BulkUploadDocumentItem,
  documentType: DocumentType,
): BulkDocReviewState {
  const values: Record<string, string> = {
    title: item.title || documentNameFromFileName(item.file_name),
    supplier: item.supplier || "",
    amount: item.amount || "",
    currency: item.currency || "KES",
    document_date: item.document_date || "",
    due_date: item.due_date || "",
  };

  const meta = item.metadata ?? {};
  for (const [key, value] of Object.entries(meta)) {
    if (value != null && value !== "") {
      values[`metadata.${key}`] = String(value);
    }
  }

  const suggestedScores: Record<string, number> = {};
  const ocrFields = parseOcrFields(item);

  const fill = (key: string, value: string | undefined, score = 4) => {
    if (!value?.trim()) return;
    const trimmed = value.trim();
    values[key] = trimmed;
    suggestedScores[key] = score;
  };

  fill("supplier", ocrFields.supplier);
  fill("amount", ocrFields.amount);
  fill("currency", ocrFields.currency);
  fill("document_date", ocrFields.document_date);
  fill("due_date", ocrFields.due_date);

  if (documentType.metadata_fields?.length) {
    const matches = applyOcrToFields(documentType.metadata_fields, ocrFields);
    for (const { field, match } of matches) {
      const metadataKey = getMetadataFieldKey(field);
      if (!metadataKey) continue;
      const path = DIRECT_KEYS.has(metadataKey)
        ? metadataKey
        : `metadata.${metadataKey}`;
      const existing = suggestedScores[path] ?? 0;
      if (match.score > existing) {
        values[path] = match.value;
        suggestedScores[path] = match.score;
      }
    }
  }

  return {
    documentId: item.document_id,
    referenceNumber: item.reference_number,
    fileName: item.file_name,
    ocrStatus: item.ocr_status,
    approved: true,
    rejected: false,
    expanded: false,
    values,
    suggestedScores,
  };
}

export function reviewStateToSubmitItem(state: BulkDocReviewState): BulkReviewSubmitItem {
  const metadata: Record<string, unknown> = {};
  const item: BulkReviewSubmitItem = {
    document_id: state.documentId,
    approved: state.approved,
    rejected: state.rejected,
  };

  for (const [key, raw] of Object.entries(state.values)) {
    const value = String(raw ?? "").trim();
    if (!value) continue;
    if (key.startsWith("metadata.")) {
      metadata[key.slice("metadata.".length)] = value;
      continue;
    }
    if (DIRECT_KEYS.has(key)) {
      (item as Record<string, unknown>)[key] = value;
    }
  }

  if (Object.keys(metadata).length > 0) {
    item.metadata = metadata;
  }

  return item;
}

export function countReviewDecisions(states: BulkDocReviewState[]) {
  return states.reduce(
    (acc, state) => {
      if (state.approved) acc.approved += 1;
      if (state.rejected) acc.rejected += 1;
      return acc;
    },
    { approved: 0, rejected: 0 },
  );
}
