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
};

export type BulkReviewSubmitItem = {
  document_id: string;
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
