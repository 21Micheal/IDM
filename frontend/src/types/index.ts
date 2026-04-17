export interface DocumentType {
  id: string;
  name: string;
  code: string;
  reference_prefix: string;
  reference_padding?: number;
  description: string;
  icon: string;
  is_active?: boolean;
  metadata_fields: MetadataField[];
}

export interface MetadataField {
  id: string;
  label: string;
  key: string;
  field_type: "text" | "number" | "date" | "currency" | "select" | "boolean" | "textarea";
  is_required: boolean;
  is_searchable: boolean;
  select_options: string[];
  default_value: string;
  help_text: string;
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
  permissions?: string[];
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
