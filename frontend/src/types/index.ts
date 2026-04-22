export interface DocumentType {
  id: string;
  name: string;
  code: string;
  reference_prefix: string;
  reference_padding?: number;
  description: string;
  icon: string;
  is_active?: boolean;
  workflow_template?: string | null;
  workflow_template_name?: string | null;
  metadata_fields: MetadataField[];
  is_scanned?: boolean;
  ocr_status?: "pending" | "processing" | "done" | "failed" | "";
  preview_pdf?: string | null;
  preview_status?: "pending" | "processing" | "done" | "failed" | "";
  // Edit lock
  is_edit_locked?: boolean;
  edit_locked_by?: string | null; // user ID
  edit_locked_by_name?: string | null; // "First Last"
  edit_locked_at?: string | null; // ISO datetime
}

export interface MetadataField {
  id: string;
  label: string;
  field_key: string;
  key?: string; // Alias for field_key (used in some contexts)
  field_type: "text" | "number" | "date" | "currency" | "select" | "boolean" | "textarea";
  is_required: boolean;
  is_searchable?: boolean;
  select_options?: string[] | null;
  default_value?: string;
  help_text?: string;
  order: number;
}

export type DocumentStatus =
  | "draft"
  | "pending_review"
  | "pending_approval"
  | "approved"
  | "rejected"
  | "archived"
  | "void";

export interface Document {
  id: string;
  title: string;
  reference_number: string;
  document_type: DocumentType;
  document_type_name?: string;
  status: DocumentStatus;
  supplier: string;
  amount: number | null;
  currency: string;
  document_date: string | null;
  due_date: string | null;
  file: string;
  file_name: string;
  file_size: number;
  file_mime_type: string;
  metadata: Record<string, unknown>;
  tags: Tag[];
  uploaded_by: UserSummary;
  department?: string | null;
  permissions?: string[];
  is_self_upload?: boolean;
  is_scanned?: boolean;
  ocr_status?: "pending" | "processing" | "done" | "failed" | "";
  preview_pdf?: string | null;
  preview_status?: "pending" | "processing" | "done" | "failed" | "";
  edit_locked_by?: string | null;
  edit_locked_by_name?: string | null;
  edit_locked_at?: string | null;
  is_edit_locked?: boolean;
  current_version: number;
  versions: DocumentVersion[];
  comments?: DocumentComment[];
  created_at: string;
  updated_at: string;
}

export interface DocumentComment {
  id: string;
  author: UserSummary;
  content: string;
  is_internal: boolean;
  created_at: string;
  updated_at: string;
}

export interface DocumentVersion {
  id: string;
  version_number: number;
  file_name: string;
  file_size: number;
  change_summary: string;
  created_by: UserSummary;
  created_at: string;
}

export interface Tag {
  id: string;
  name: string;
  color: string;
}

export interface UserSummary {
  id: string;
  email: string;
  first_name: string;
  last_name: string;
  role: string;
}

export interface WorkflowTask {
  id: string;
  step: { name: string; order: number };
  workflow_instance?: {
    document?: { id: string; title: string; reference_number: string };
  };
  document_id?: string;
  document_title?: string;
  document_ref?: string;
  status: "pending" | "in_progress" | "approved" | "rejected";
  due_at: string | null;
}

export interface Notification {
  id: string;
  message: string;
  link: string;
  is_read: boolean;
  created_at: string;
}

export interface PaginatedResponse<T> {
  count: number;
  next: string | null;
  previous: string | null;
  results: T[];
}

export interface DocumentPreviewResponse {
  viewer: "pdfjs" | "image" | "processing" | "download";
  url: string;
  raw_url?: string;
  preview_status?: "pending" | "processing" | "done" | "failed" | "";
}

export interface DocumentEditTokenResponse {
  token: string;
  username: string;
  webdav_url: string;
  file_url: string;
  release_url: string;
  jwt_token: string;
  expires_in: number;
  doc_id: string;
  file_name: string;
  mime_type: string;
}
