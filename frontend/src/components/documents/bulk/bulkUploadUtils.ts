import type { DocumentType, MetadataField } from "@/types";
import { applyOcrToFields, sanitizeOcrFields, type OcrFields } from "@/lib/ocrFieldMatcher";
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

const DOCUMENT_REFERENCE_ALIASES: Record<string, Array<keyof OcrFields>> = {
  invoice_number: ["reference_number"],
  invoice_no: ["reference_number"],
  inv_number: ["reference_number"],
  inv_no: ["reference_number"],
  grn_number: ["reference_number"],
  grn_no: ["reference_number"],
  goods_receipt_number: ["reference_number"],
  receipt_number: ["reference_number"],
  receipt_no: ["reference_number"],
  reference_number: ["reference_number"],
  reference_no: ["reference_number"],
  document_number: ["reference_number"],
  document_no: ["reference_number"],
  transaction_reference: ["transaction_ref", "reference_number"],
  transaction_number: ["transaction_ref", "reference_number"],
  transaction_ref: ["transaction_ref"],
  payment_reference: ["transaction_ref"],
  payment_ref: ["transaction_ref"],
};

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
  if (raw.fields != null) return sanitizeOcrFields(raw.fields);
  return sanitizeOcrFields(raw as unknown as OcrFields);
}

export function countNeedsManualDocs(items: BulkUploadDocumentItem[]): number {
  return items.filter((item) => item.ocr_status === "needs_manual").length;
}

export function primaryIdpFailureReason(items: BulkUploadDocumentItem[]): string {
  for (const item of items) {
    if (item.ocr_status !== "needs_manual") continue;
    const reason = item.ocr_suggestions?.quality?.fallback_reason;
    if (typeof reason === "string" && reason.trim()) return reason;
  }
  return "extraction_error";
}

export function rebuildReviewStatesFromBatch(
  batch: { documents: BulkUploadDocumentItem[]; document_type: DocumentType; mode?: string },
  documentTypes: DocumentType[],
): BulkDocReviewState[] {
  return batch.documents.map((doc) =>
    buildReviewStateFromBatchItem(
      doc,
      doc.document_type ?? batch.document_type,
      documentTypes,
      batch.mode === "related_set",
    ),
  );
}

export function buildReviewStateFromBatchItem(
  item: BulkUploadDocumentItem,
  documentType: DocumentType,
  documentTypes: DocumentType[] = [documentType],
  isRelatedSet = false,
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
  const detectedDocumentType = ocrFields.document_type ? String(ocrFields.document_type).trim() : "";
  const resolvedDocumentType = isRelatedSet
    ? resolveDocumentType(detectedDocumentType || item.file_name, documentTypes)
    : documentType;

  // The document type embedded in the batch item can carry an empty
  // metadata_fields list, which would make applyOcrValuesToDocumentType skip
  // every admin field (reference numbers, etc.). Prefer the full type from the
  // live document-types list, matching what the review form renders.
  const targetTypeId = resolvedDocumentType?.id ?? item.document_type?.id ?? documentType.id;
  const fullDocumentType =
    documentTypes.find(
      (type) => type.id === targetTypeId && (type.metadata_fields?.length ?? 0) > 0,
    ) ?? resolvedDocumentType ?? documentType;

  const fill = (key: string, value: string | number | undefined, score = 4) => {
    if (value == null) return;
    const strValue = String(value);
    if (!strValue.trim()) return;
    values[key] = strValue.trim();
    suggestedScores[key] = score;
  };

  fill("supplier", ocrFields.supplier);
  fill("amount", ocrFields.amount);
  fill("currency", ocrFields.currency);
  fill("document_date", ocrFields.document_date);
  fill("due_date", ocrFields.due_date);
  // Fill new line-item fields from OCR data
  fill("quantity", ocrFields.quantity ? String(ocrFields.quantity) : undefined);
  fill("description", ocrFields.description ? String(ocrFields.description) : undefined);
  fill("uom", ocrFields.uom ? String(ocrFields.uom) : undefined);

  applyOcrValuesToDocumentType(values, suggestedScores, ocrFields, fullDocumentType);

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
    ocrFields,
    documentTypeId: isRelatedSet
      ? (resolvedDocumentType?.id ?? "")
      : (item.document_type?.id ?? documentType.id),
    detectedDocumentType,
  };
}

export function applyOcrValuesToDocumentType(
  values: Record<string, string>,
  suggestedScores: Record<string, number>,
  ocrFields: OcrFields | undefined,
  documentType: DocumentType,
) {
  if (!ocrFields || !documentType.metadata_fields?.length) return;

  for (const field of documentType.metadata_fields) {
    const metadataKey = getMetadataFieldKey(field);
    if (!metadataKey) continue;
    const path = DIRECT_KEYS.has(metadataKey)
      ? metadataKey
      : `metadata.${metadataKey}`;
    const exact = getContextualOcrValueForField(field, ocrFields, documentType);
    if (!exact) continue;
    values[path] = exact;
    suggestedScores[path] = 4;
  }

  const matches = applyOcrToFields(documentType.metadata_fields, ocrFields);
  for (const { field, match } of matches) {
    const metadataKey = getMetadataFieldKey(field);
    if (!metadataKey) continue;
    const path = DIRECT_KEYS.has(metadataKey)
      ? metadataKey
      : `metadata.${metadataKey}`;
    const existing = suggestedScores[path] ?? 0;
    if (match.score > existing || !String(values[path] ?? "").trim()) {
      values[path] = match.value;
      suggestedScores[path] = match.score;
    }
  }
}

function getContextualOcrValueForField(
  field: MetadataField,
  ocrFields: OcrFields,
  documentType: DocumentType,
): string | undefined {
  const key = normalizeFieldIdentifier(getMetadataFieldKey(field));
  const label = normalizeFieldIdentifier(field.label ?? "");
  const candidates = new Set([key, label].filter(Boolean));

  const aliases: Array<keyof OcrFields> = [];
  const asksForPoNumber = [...candidates].some((candidate) =>
    /^(po|lpo|purchase_order)_(number|no|ref|reference)$/.test(candidate)
    || candidate === "purchase_order"
  );

  if (asksForPoNumber) {
    aliases.push(
      ...(isPurchaseOrderType(documentType)
        ? (["reference_number", "po_reference"] as Array<keyof OcrFields>)
        : (["po_reference"] as Array<keyof OcrFields>)),
    );
  }

  for (const candidate of candidates) {
    aliases.push(...(DOCUMENT_REFERENCE_ALIASES[candidate] ?? []));
    if (candidate in ocrFields) {
      aliases.push(candidate as keyof OcrFields);
    }
  }

  for (const alias of aliases) {
    const value = ocrFields[alias];
    if (value == null || Array.isArray(value) || typeof value === "object") continue;
    const scalar = String(value).trim();
    if (scalar) return scalar;
  }
  return undefined;
}

function normalizeFieldIdentifier(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function isPurchaseOrderType(documentType: DocumentType) {
  const haystack = `${documentType.name} ${documentType.code} ${documentType.description ?? ""}`.toLowerCase();
  return /\b(po|lpo)\b/.test(haystack) || haystack.includes("purchase order");
}

export function resolveDocumentType(label: string, documentTypes: DocumentType[]): DocumentType | undefined {
  const normalized = expandDocumentTypeAliases(normalizeTypeLabel(label));
  if (!normalized) return undefined;
  return documentTypes
    .filter((type) => type.code !== "UNCLASS")
    .map((type) => {
      const haystack = expandDocumentTypeAliases(normalizeTypeLabel(`${type.name} ${type.code} ${type.description ?? ""}`));
      const typeName = expandDocumentTypeAliases(normalizeTypeLabel(type.name));
      let score = 0;
      if (haystack.includes(normalized) || normalized.includes(typeName)) score += 5;
      for (const token of normalized.split(" ").filter((part) => part.length > 2)) {
        if (haystack.includes(token)) score += 1;
      }
      return { type, score };
    })
    .filter((candidate) => candidate.score > 0)
    .sort((a, b) => b.score - a.score)[0]?.type;
}

function expandDocumentTypeAliases(value: string) {
  return value
    .replace(/\bpo\b/g, "purchase order po")
    .replace(/\blpo\b/g, "local purchase order lpo")
    .replace(/\bgrn\b/g, "goods received note goods receipt grn")
    .replace(/\bdn\b/g, "delivery note dn");
}

function normalizeTypeLabel(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\b(doc|document|file|tax)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function reviewStateToSubmitItem(state: BulkDocReviewState): BulkReviewSubmitItem {
  const metadata: Record<string, unknown> = {};
  const item: BulkReviewSubmitItem = {
    document_id: state.documentId,
    approved: state.approved,
    rejected: state.rejected,
  };
  if (state.documentTypeId) {
    item.document_type_id = state.documentTypeId;
  }

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
