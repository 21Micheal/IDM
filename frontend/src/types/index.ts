export interface DocumentType {
  id: string;
  name: string;
  code: string;
  reference_prefix: string;
  reference_padding?: number;
  description: string;
  icon: string;
  is_active?: boolean;
  is_personal_type?: boolean;
  metadata_mode?: "admin_defined" | "user_defined";
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
  field_type: "text" | "varchar" | "number" | "date" | "currency" | "select" | "boolean" | "textarea";
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
  description?: string;
  file: string;
  file_name: string;
  file_size: number;
  file_mime_type: string;
  metadata: Record<string, unknown>;
  tags: Tag[];
  personal_tags?: string[];
  uploaded_by: UserSummary;
  department?: string | null;
  department_name?: string | null;
  uploaded_by_department_name?: string | null;
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
  available_bulk_actions?: string[];
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
  file_url?: string;
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
  full_name?: string;
  job_description?: string;
  is_staff?: boolean;
  has_admin_access?: boolean;
  group_names?: string[];
  department_name?: string | null;
}

export interface WorkflowTask {
  id: string;
  step: {
    name: string;
    order: number;
    instructions?: string;
    allow_approve?: boolean;
    allow_reject?: boolean;
    allow_return?: boolean;
  };
  workflow_instance?: {
    document?: {
      id: string;
      title: string;
      reference_number: string;
      document_type_name?: string;
      document_type?: DocumentType;
      department?: string | null;
      department_name?: string | null;
      uploaded_by?: UserSummary;
    };
  };
  document_id?: string;
  document_title?: string;
  document_ref?: string;
  document_type_name?: string;
  document_department_name?: string | null;
  uploaded_by_name?: string | null;
  uploader_department_name?: string | null;
  file_name?: string;
  file_mime_type?: string;
  status: "pending" | "in_progress" | "approved" | "rejected" | "returned" | "held" | "skipped";
  due_at: string | null;
  held_until?: string | null;
  status_display?: string;
}

export interface Notification {
  id: string;
  type: "task_assigned" | "workflow_complete" | "document_returned" | "document_held" | "hold_released" | "hold_expired" | "task_overdue" | "workflow_action";
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

export interface SearchHit {
  id: string;
  score: number;
  title: string;
  reference_number: string;
  document_type: string;
  file_name?: string;
  file_mime_type?: string;
  supplier: string;
  amount: number | null;
  status: DocumentStatus;
  document_date: string | null;
  highlights: Record<string, string>;
}

export interface DocumentSearchResponse {
  total: number;
  results: SearchHit[];
}

export interface DocumentPreviewResponse {
  viewer: "pdfjs" | "image" | "processing" | "download";
  url: string | null;
  raw_url?: string | null;
  preview_status?: "pending" | "processing" | "done" | "failed" | "";
  preview_error?: string;
}

export interface DocumentEditTokenResponse {
  token: string;
  username: string;
  webdav_url: string;
  file_url: string | null;
  release_url: string;
  jwt_token: string;
  expires_in: number;
  doc_id: string;
  file_name: string;
  mime_type: string;
}


// folder types

export interface DocumentFolder {
  id: string;
  parent: string | null;
  parent_name: string | null;
  name: string;
  color: string;
  icon: string;
  is_favourites: boolean;
  is_system: boolean;
  position: number;
  child_count: number;
  document_count: number;
  created_at: string;
  updated_at: string;
  // Only present in tree response
  children?: DocumentFolder[];
}

export interface DocumentFolderItem {
  id: string;
  folder: string;
  document: string;
  position: number;
  added_at: string;
  document_title: string;
  document_reference: string;
  document_status: string;
  document_type_name: string;
  document_file_mime_type: string;
  document_file_name: string;
  document_updated_at: string;
}

export interface DocumentFavourite {
  id: string;
  document: string;
  document_title: string;
  document_reference: string;
  document_status: string;
  document_type_name: string;
  document_file_mime_type: string;
  document_file_name: string;
  document_updated_at: string;
  access_count: number;
  added_at: string;
  last_accessed: string | null;
}

export interface FavouriteCheckResult {
  starred: boolean;
  favourite_id: string | null;
}
