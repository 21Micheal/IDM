import type { DocumentType } from "@/types";
import type { OcrFields } from "@/lib/ocrFieldMatcher";

export type BulkUploadStatus =
  | "pending"
  | "uploading"
  | "processing"
  | "review"
  | "completed"
  | "failed";

export type BulkOcrSuggestions = {
  fields?: OcrFields | null;
  quality?: Record<string, unknown> | null;
} | null;

export type BulkUploadDocumentItem = {
  document_id: string;
  reference_number: string;
  title: string;
  file_name: string;
  document_type?: DocumentType;
  ocr_status: string;
  ocr_suggestions?: BulkOcrSuggestions;
  metadata?: Record<string, unknown>;
  supplier?: string;
  amount?: string;
  currency?: string;
  document_date?: string;
  due_date?: string;
};

export type BulkUploadBatch = {
  id: string;
  status: BulkUploadStatus;
  document_type: DocumentType;
  mode?: "same_type" | "related_set";
  shared_metadata?: Record<string, unknown>;
  total_files: number;
  successful_uploads: number;
  failed_uploads: number;
  approved_count: number;
  rejected_count: number;
  progress_percentage: number;
  documents: BulkUploadDocumentItem[];
  ocr_progress?: {
    total: number;
    done: number;
    failed: number;
    pending: number;
  };
};

export type BulkDocReviewState = {
  documentId: string;
  referenceNumber: string;
  fileName: string;
  ocrStatus: string;
  approved: boolean;
  rejected: boolean;
  expanded: boolean;
  values: Record<string, string>;
  suggestedScores: Record<string, number>;
  ocrFields?: OcrFields;
  documentTypeId?: string;
  detectedDocumentType?: string;
};

export type BulkLocalPreview = {
  fileName: string;
  url: string | null;
  kind: "pdf" | "image" | "other";
  size: number;
};

export type BulkReviewSubmitItem = {
  document_id: string;
  document_type_id?: string;
  title?: string;
  supplier?: string;
  amount?: string;
  currency?: string;
  document_date?: string;
  due_date?: string;
  quantity?: string;
  description?: string;
  uom?: string;
  metadata?: Record<string, unknown>;
  approved: boolean;
  rejected: boolean;
};
