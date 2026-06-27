import axios, { AxiosError, InternalAxiosRequestConfig } from "axios";
import { useAuthStore, applyServerSessionPolicy } from "@/store/authStore";
import type {
  DocumentEditTokenResponse,
  DocumentPreviewResponse,
} from "@/types";

// ── OCR suggestion types (exported for use in components) ─────────────────────

export type OcrFieldSuggestions = {
  supplier?: string;
  amount?: string;
  currency?: string;
  document_date?: string;
  due_date?: string;
  reference_number?: string;
  document_type?: string;
  account_code?: string;
  cost_centre?: string;
  vendor_code?: string;
  approved_by?: string;
  payment_terms?: string;
  tax_amount?: string;
  subtotal?: string;
  payment_method?: string;
  transaction_ref?: string;
  kra_pin?: string;
  vat_number?: string;
  po_reference?: string;
  signed_by?: string;
  contract_value?: string;
  raw_lines?: string[];
};

export type OcrQualityMetrics = {
  extraction_source?: string;
  chars_per_page?: number;
  mean_confidence?: number;
  overall_quality_ratio?: number;
  low_quality_warning?: boolean;
  total_pages?: number;
  low_quality_pages?: number;
};

export type OcrSuggestionsResponse = {
  ocr_status: "pending" | "processing" | "done" | "failed" | "";
  suggestions: {
    fields?: OcrFieldSuggestions | null;
    quality?: OcrQualityMetrics | null;
  } | null;
};

export type DmsSettings = {
  organization_name: string;
  organization_address: string;
  watermark_enabled: boolean;
  watermark_text: string;
  watermark_opacity: number;
  watermark_position: "diagonal" | "center" | "footer";
  watermark_apply_to_previews: boolean;
  allow_duplicate_uploads: boolean;
  purge_trashed_duplicates_on_reupload: boolean;
  signed_file_urls_enabled: boolean;
  auto_archive_enabled: boolean;
  auto_archive_after_days: number;
  trash_auto_empty_enabled: boolean;
  trash_retention_days: number;
  rbac_single_stage: boolean;
  require_metadata_on_upload: boolean;
  session_lifetime_minutes: number;
  session_idle_timeout_minutes: number;
  updated_at?: string;
};

export function normalizeListResponse<T>(payload: unknown): T[] {
  if (Array.isArray(payload)) return payload as T[];
  if (payload && typeof payload === "object" && Array.isArray((payload as { results?: unknown[] }).results)) {
    return (payload as { results: T[] }).results;
  }
  return [];
}

function normalizeApiBase(rawBase: string): string {
  const trimmed = rawBase.replace(/\/+$/, "");
  if (trimmed.endsWith("/api/v1")) return trimmed;
  return `${trimmed}/api/v1`;
}

function resolveApiBaseUrl(): string {
  const rawApiUrl = import.meta.env.VITE_API_URL?.trim();
  if (import.meta.env.DEV) {
    console.warn('Raw VITE_API_URL from import.meta.env:', rawApiUrl);
  }
  
  if (!rawApiUrl) {
    if (import.meta.env.DEV) {
      console.warn('No VITE_API_URL found, using default /api/v1');
    }
    return "/api/v1";
  }

  const normalized = normalizeApiBase(rawApiUrl);
  if (import.meta.env.DEV) {
    console.warn('Normalized API URL:', normalized);
  }

  if (typeof window !== "undefined") {
    try {
      const parsed = new URL(normalized, window.location.origin);
      if (parsed.protocol === "http:" || parsed.protocol === "https:") {
        const finalUrl = parsed.href.replace(/\/+$|\/$/, "");
        if (import.meta.env.DEV) {
          console.warn('Final resolved API URL:', finalUrl);
        }
        return finalUrl;
      }
    } catch (error) {
      if (import.meta.env.DEV) {
        console.warn('URL parsing failed, falling back to /api/v1', error);
      }
      // fall back to proxy-friendly relative API path
    }
  }

  if (import.meta.env.DEV) {
    console.warn('Using fallback /api/v1');
  }
  return "/api/v1";
}

export const apiBaseUrl = resolveApiBaseUrl();
if (import.meta.env.DEV) {
  console.warn('API Base URL resolved to:', apiBaseUrl);
}

// A default ceiling for ordinary JSON requests. Normal calls finish in well
// under a second; this just prevents a slow/overloaded backend from leaving a
// request hanging indefinitely — which, under high traffic, would exhaust the
// browser's ~6-connections-per-host budget and stall the rest of the UI.
// Uploads and blob downloads are exempted in the request interceptor below.
const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;

export const api = axios.create({
  baseURL: apiBaseUrl,
  headers: { "Content-Type": "application/json" },
  timeout: DEFAULT_REQUEST_TIMEOUT_MS,
});

let refreshPromise: Promise<string> | null = null;

async function refreshAccessToken(): Promise<string> {
  if (!refreshPromise) {
    refreshPromise = (async () => {
      const authState = useAuthStore.getState();
      if (authState.isSessionExpired()) {
        authState.logout();
        throw new Error("Session expired");
      }

      const refreshToken = authState.refreshToken;
      if (!refreshToken) throw new Error("Missing refresh token");

      const { data } = await axios.post(
        `${api.defaults.baseURL}/token/refresh/`,
        { refresh: refreshToken }
      );
      // Pick up any admin change to the session policy on each refresh.
      applyServerSessionPolicy(data.session_policy);
      useAuthStore.getState().setTokens(data.access, data.refresh ?? refreshToken);
      return data.access as string;
    })().finally(() => {
      refreshPromise = null;
    });
  }

  return refreshPromise;
}

// Attach JWT on every request
api.interceptors.request.use((config: InternalAxiosRequestConfig) => {
  const authState = useAuthStore.getState();
  if (authState.isSessionExpired()) {
    authState.logout();
    return config;
  }

  const token = authState.accessToken;
  if (token) config.headers.Authorization = `Bearer ${token}`;

  // File uploads (FormData) and binary downloads (blob) can legitimately run
  // far longer than a JSON call — large files on slow links. Disable the
  // default timeout for them so the ceiling only ever applies to normal API
  // traffic. An explicit per-request timeout still wins if one was set.
  const isUpload = config.data instanceof FormData;
  const isBlob = config.responseType === "blob";
  if ((isUpload || isBlob) && config.timeout === DEFAULT_REQUEST_TIMEOUT_MS) {
    config.timeout = 0;
  }

  if (config.data instanceof FormData) {
    const headers = config.headers as unknown as {
      delete?: (key: string) => void;
      [key: string]: unknown;
    };
    if (typeof headers.delete === "function") {
      headers.delete("Content-Type");
      headers.delete("content-type");
    } else {
      delete headers["Content-Type"];
      delete headers["content-type"];
    }
  }
  return config;
});

// Auto-refresh on 401
api.interceptors.response.use(
  (r) => r,
  async (error: AxiosError) => {
    const original = error.config as InternalAxiosRequestConfig & {
      _retry?: boolean;
    };
    const isRefreshRequest = original.url?.includes("/token/refresh/");
    const hasAuthHeader = Boolean(original.headers?.Authorization);
    if (error.response?.status === 401 && (original._retry || isRefreshRequest) && hasAuthHeader) {
      useAuthStore.getState().logout();
      return Promise.reject(error);
    }

    if (error.response?.status === 401 && !original._retry && !isRefreshRequest) {
      original._retry = true;
      try {
        const accessToken = await refreshAccessToken();
        original.headers.Authorization = `Bearer ${accessToken}`;
        return api(original);
      } catch {
        useAuthStore.getState().logout();
      }
    }
    return Promise.reject(error);
  }
);

// ── Typed API helpers ─────────────────────────────────────────────────────────

export const authAPI = {
  login: (email: string, password: string) =>
    api.post("/auth/login/", { email, password }),

  verifyOTP: (userId: string, otp: string) =>
    api.post("/auth/verify-otp/", { user_id: userId, otp }),

  resendOTP: (userId: string) =>
    api.post("/auth/resend-otp/", { user_id: userId }),

  me: (token?: string) =>
    api.get("/auth/me/", token
      ? { headers: { Authorization: `Bearer ${token}` } }
      : undefined),
};

export const documentsAPI = {
  list: (params?: Record<string, unknown>) =>
    api.get("/documents/", { params }),

  /** Distinct supplier names across all documents the user can see. */
  suppliers: () => api.get<string[]>("/documents/suppliers/"),

  /**
   * List only the current user's personal (self-upload) documents.
   * Equivalent to /documents/?is_self_upload=true
   */
  listPersonal: (params?: Record<string, unknown>) =>
    api.get("/documents/", { params: { ...params, is_self_upload: true } }),

  /**
   * List only workflow (non-personal) documents.
   * Equivalent to /documents/?is_self_upload=false
   */
  listWorkflow: (params?: Record<string, unknown>) =>
    api.get("/documents/", { params: { ...params, is_self_upload: false } }),

  get: (id: string) => api.get(`/documents/${id}/`),

  /**
   * Upload a new document.
   *
   * The FormData MUST include:
   *   - file              (File)
   *   - title             (string)
   *   - document_type_id  (UUID string)   ← note: NOT "document_type"
   *   - is_self_upload    ("true"|"false") ← personal document flag
   *
   * Optional: supplier, amount, currency, document_date, metadata (JSON string)
   */
  upload: (
    formData: FormData,
    config?: { onUploadProgress?: (progressEvent: any) => void }
  ) =>
    api.post("/documents/", formData, {
      headers: { "Content-Type": undefined },
      onUploadProgress: config?.onUploadProgress,
    }),

  duplicateCheck: (checksum: string, documentId?: string) =>
    api.get<{
      exists: boolean;
      identical_to_current?: boolean;
      duplicates_allowed?: boolean;
      document_id?: string;
      reference_number?: string;
      uploaded_at?: string;
      uploaded_by?: string;
    }>("/documents/duplicate-check/", {
      params: {
        checksum,
        ...(documentId ? { document_id: documentId } : {}),
      },
    }),

  update: (id: string, data: Record<string, unknown>) =>
    api.patch(`/documents/${id}/`, data),

  editMetadata: (id: string, data: Record<string, unknown>) =>
    api.patch(`/documents/${id}/edit_metadata/`, data),

  /**
   * Re-fill a built-template form document in-app; regenerates its PDF view.
   * Newly attached files are sent as multipart form attachments (stored on the
   * document's metadata.form, not as new document versions).
   */
  updateForm: (
    id: string,
    values: Record<string, unknown>,
    attachments: Array<{ field: string; file: File }> = [],
  ) => {
    if (attachments.length === 0) {
      return api.post(`/documents/${id}/update_form/`, { values });
    }
    const fd = new FormData();
    fd.append("values", JSON.stringify(values));
    for (const { field, file } of attachments) {
      fd.append(field, file, file.name);
    }
    return api.post(`/documents/${id}/update_form/`, fd, {
      headers: { "Content-Type": undefined },
    });
  },

  downloadFormAttachment: (id: string, fieldKey: string) =>
    api.get(`/documents/${id}/form_attachment/${encodeURIComponent(fieldKey)}/`, {
      responseType: "blob",
    }),

  /** Move a (draft/returned/rejected) document to Trash (soft delete). */
  delete: (id: string) => api.delete(`/documents/${id}/`),
  /** Restore a document from Trash. */
  restore: (id: string) => api.post(`/documents/${id}/restore/`),
  /** Permanently delete a document that is in Trash. */
  purge: (id: string) => api.post(`/documents/${id}/purge/`),
  submit: (id: string) => api.post(`/documents/${id}/submit/`),
  archive: (id: string) => api.post(`/documents/${id}/archive/`),

  uploadVersion: (
    id: string,
    formData: FormData,
    config?: { onUploadProgress?: (progressEvent: any) => void }
  ) =>
    api.post(`/documents/${id}/upload_version/`, formData, {
      headers: { "Content-Type": undefined },
      onUploadProgress: config?.onUploadProgress,
    }),

  restoreVersion: (id: string, versionId: string) =>
    api.post(`/documents/${id}/restore_version/`, { version_id: versionId }),

  comments: (id: string) => api.get(`/documents/${id}/comments/`),
  addComment: (id: string, content: string, isInternal = false) =>
    api.post(`/documents/${id}/comments/`, {
      content,
      is_internal: isInternal,
    }),

  auditTrail: (id: string, params?: Record<string, unknown>) =>
    api.get(`/documents/${id}/audit_trail/`, { params }),

  relationships: (id: string) =>
    api.get(`/documents/${id}/relationships/`),
  addRelationship: (
    id: string,
    data: { target_document_id: string; relation_type: "supports" | "references" | "supersedes" | "linked-to"; note?: string }
  ) => api.post(`/documents/${id}/relationships/`, data),
  deleteRelationship: (id: string, relationshipId: string) =>
    api.delete(`/documents/${id}/relationships/${relationshipId}/`),

  bulkAction: (
    documentIds: string[],
    action: "approve" | "reject" | "archive" | "void" | "trash" | "restore" | "purge",
    comment = ""
  ) =>
    api.post("/documents/bulk_action/", {
      document_ids: documentIds,
      action,
      comment,
    }),

  emailSelected: (data: {
    document_ids: string[];
    recipient_user_ids?: string[];
    recipient_emails?: string[];
    attachment_mode: "separate" | "combined";
    message?: string;
  }) => api.post("/documents/email_selected/", data),

  /** Bulk-download selected documents as a ZIP of original files (returns a Blob). */
  downloadSelected: (documentIds: string[]) =>
    api.post("/documents/download_selected/", { document_ids: documentIds, format: "original" }, { responseType: "blob" }),

  /** Bulk-download selected documents as a ZIP where each file is converted to PDF (returns a Blob). */
  downloadSelectedAsPdf: (documentIds: string[]) =>
    api.post("/documents/download_selected/", { document_ids: documentIds, format: "pdf" }, { responseType: "blob" }),

  /** Bulk-download selected documents stitched into one merged PDF (returns a Blob). */
  downloadSelectedMergedPdf: (documentIds: string[]) =>
    api.post("/documents/download_selected/", { document_ids: documentIds, format: "merged_pdf" }, { responseType: "blob" }),

  /** Download a single document as PDF (original if already PDF, preview for Office, PIL-converted for images). */
  downloadAsPdf: (id: string) =>
    api.get(`/documents/${id}/download_as_pdf/`, { responseType: "blob" }),

  /** Run a server-side PDF editor job (compress / convert); returns a Blob. */
  pdfTool: (formData: FormData) =>
    api.post("/documents/pdf-tool/", formData, { responseType: "blob" }),

  shareSelected: (data: {
    document_ids: string[];
    recipient_user_ids: string[];
    access_level: "view" | "download";
    message?: string;
    expires_at?: string | null;
    notify_by_email?: boolean;
  }) => api.post("/documents/share_selected/", data),

  reOcr: (id: string) =>
    api.post(`/documents/${id}/re_ocr/`),

  /**
   * Poll after upload to get OCR-extracted field suggestions.
   *
   * Response shape (new backend):
   *   {
   *     ocr_status: "pending" | "processing" | "done" | "failed" | "",
   *     suggestions: {
   *       fields: {
   *         title?, supplier?, amount?, currency?,
   *         document_date?, due_date?, reference_number?,
   *         document_type?, account_code?, cost_centre?,
   *         vendor_code?, approved_by?, payment_terms?,
   *         tax_amount?, subtotal?, payment_method?,
   *         transaction_ref?, kra_pin?, vat_number?,
   *         po_reference?, signed_by?, contract_value?,
   *         raw_lines?: string[]
   *       } | null,
   *       quality: {
   *         mean_confidence?: number,
   *         overall_quality_ratio?: number,
   *         low_quality_warning?: boolean,
   *         total_pages?: number,
   *         low_quality_pages?: number,
   *       } | null,
   *     } | null
   *   }
   *
   * The poller in UploadPage handles both the new nested shape and the
   * legacy flat shape gracefully, so no migration is required on existing data.
   */
  ocrSuggestions: (id: string) =>
    api.get<OcrSuggestionsResponse>(`/documents/${id}/ocr_suggestions/`),

  /**
   * Explicitly (re-)trigger Office→PDF preview conversion.
   * Use for retries after failure or when preview was never queued.
   * POST — blocked when status is PROCESSING.
   */
  triggerPreview: (id: string) =>
    api.post<{ detail: string; preview_status: string }>(`/documents/${id}/trigger_preview/`),

  /** Explicitly (re-)queue a historical version preview conversion. */
  triggerVersionPreview: (id: string, versionId: string) =>
    api.post<{ detail: string; preview_status: string }>(`/documents/${id}/trigger_version_preview/`, {
      version_id: versionId,
    }),

  /** Acquire edit lock + get launcher credentials. POST. */
  editToken: (id: string) =>
    api.post<DocumentEditTokenResponse>(`/documents/${id}/edit_token/`),

  /** Get a read-only WebDAV URL to open the doc in a desktop editor — no lock. POST. */
  readOnlyToken: (id: string) =>
    api.post<{ webdav_url: string; read_only: true; doc_id: string; file_name: string; mime_type: string }>(
      `/documents/${id}/read_only_token/`,
    ),

  /**
   * Download the one-time install script that registers the docvault-open://
   * protocol handler with xdg-open and Chrome on Linux.
   * Run once per machine — no token, no document-specific data.
   */
  installScript: () =>
    api.get("/documents/install_script/", { responseType: "blob" }),

  /** Release the edit lock. POST. Called by launcher on exit, or manually. */
  releaseLock: (id: string, force = false) =>
    api.post<{ detail: string }>(`/documents/${id}/release_lock/`, { force }),

  /** Get signed preview / file URLs (never exposes anonymous /media paths). */
  previewUrl: (id: string, versionId?: string) =>
    api.get<DocumentPreviewResponse>(`/documents/${id}/preview_url/`, {
      params: versionId ? { version_id: versionId } : undefined,
    }),

  /** Compliance: log browser print dialog for this document (debounced client-side). */
  filePrintEvent: (id: string) =>
    api.post<{ ok: boolean }>(`/documents/${id}/file_print_event/`),
};

export const bulkUploadAPI = {
  create: (
    formData: FormData,
    config?: { onUploadProgress?: (progressEvent: { loaded: number; total?: number }) => void },
  ) =>
    api.post("/documents/bulk-uploads/", formData, {
      headers: { "Content-Type": undefined },
      onUploadProgress: config?.onUploadProgress,
    }),

  get: (id: string) => api.get(`/documents/bulk-uploads/${id}/`),

  status: (id: string) => api.get(`/documents/bulk-uploads/${id}/status/`),

  review: (id: string, documents: Record<string, unknown>[]) =>
    api.post(`/documents/bulk-uploads/${id}/review/`, { documents }),

  cancel: (id: string) => api.post(`/documents/bulk-uploads/${id}/cancel/`),

  // Pending-review queue: the user's batches (email ingestion + bulk scans).
  // Defaults server-side to processing/review; pass status to widen/narrow.
  list: (params?: { status?: string }) =>
    api.get<BulkUploadSummary[]>("/documents/bulk-uploads/", { params }),
};

export type BulkUploadSummary = {
  id: string;
  document_type: { id: string; name: string; code: string } | null;
  mode: "same_type" | "related_set";
  status: "pending" | "uploading" | "processing" | "review" | "completed" | "failed";
  total_files: number;
  successful_uploads: number;
  failed_uploads: number;
  created_at: string;
  updated_at: string;
  source: "email" | "scan";
  email: { sender: string; subject: string; received_at: string | null } | null;
};

export const dmsSettingsAPI = {
  get: () => api.get<DmsSettings>("/documents/settings/"),
  update: (data: Partial<DmsSettings>) =>
    api.patch<DmsSettings>("/documents/settings/", data),
};

export const documentTypesAPI = {
  list: () => api.get("/documents/types/"),
  get: (id: string) => api.get(`/documents/types/${id}/`),
  create: (data: unknown) => api.post("/documents/types/", data),
  update: (id: string, data: unknown) =>
    api.patch(`/documents/types/${id}/`, data),
  delete: (id: string) => api.delete(`/documents/types/${id}/`),
  /** Deep-clone a document type (fields + rules). Returns the new type. */
  duplicate: (id: string, data: { name: string; code: string }) =>
    api.post(`/documents/types/${id}/duplicate/`, data),
};

export const searchAPI = {
  search: (payload: unknown) => api.post("/search/", payload),
};

// ── Infor IDM migration ───────────────────────────────────────────────────────
export type MigrationConnection = {
  api_url?: string;
  token_url?: string;
  tenant?: string;
  client_id?: string;
  client_secret?: string;
  saak?: string;
  sask?: string;
  scope?: string;
  idm_path?: string;
  verify_tls?: boolean;
};

export type MigrationJobStatus =
  | "draft" | "queued" | "running" | "completed" | "partial" | "failed" | "cancelled";

export type MigrationLogEntry = {
  ion_id?: string | null;
  reference_number?: string;
  document_id?: string;
  status?: "imported" | "skipped" | "failed";
  detail?: string;
};

export type MigrationJob = {
  id: string;
  name: string;
  connection: MigrationConnection;
  source_query: string;
  target_document_type: string | null;
  target_document_type_name?: string | null;
  include_attributes: boolean;
  max_documents: number;
  status: MigrationJobStatus;
  total_items: number;
  processed_items: number;
  succeeded_items: number;
  failed_items: number;
  skipped_items: number;
  log?: MigrationLogEntry[];
  error?: string;
  created_by?: string | null;
  created_by_name?: string | null;
  created_at: string;
  updated_at: string;
  started_at?: string | null;
  finished_at?: string | null;
  has_client_secret?: boolean;
  has_sask?: boolean;
};

export type MigrationJobInput = {
  name: string;
  connection?: MigrationConnection;
  source_query?: string;
  target_document_type?: string | null;
  include_attributes?: boolean;
  max_documents?: number;
};

export const migrationAPI = {
  list: () => api.get<MigrationJob[]>("/documents/migrations/"),
  get: (id: string) => api.get<MigrationJob>(`/documents/migrations/${id}/`),
  status: (id: string) => api.get<MigrationJob>(`/documents/migrations/${id}/status/`),
  create: (data: MigrationJobInput) =>
    api.post<MigrationJob>("/documents/migrations/", data),
  update: (id: string, data: Partial<MigrationJobInput>) =>
    api.patch<MigrationJob>(`/documents/migrations/${id}/`, data),
  delete: (id: string) => api.delete(`/documents/migrations/${id}/`),
  run: (id: string) => api.post<MigrationJob>(`/documents/migrations/${id}/run/`, {}),
  testConnection: (connection: MigrationConnection) =>
    api.post<{ ok: boolean; tenant?: string; api_url?: string; detail?: string }>(
      "/documents/migrations/test_connection/",
      { connection },
    ),
  connectionDefaults: () =>
    api.get<{ connection: MigrationConnection; has_client_secret: boolean; has_sask: boolean }>(
      "/documents/migrations/connection_defaults/",
    ),
};

// ── Email ingestion (IMAP mailboxes) ──────────────────────────────────────────
export type MailboxConnection = {
  host?: string;
  port?: number;
  use_ssl?: boolean;
  username?: string;
  password?: string;
  folder?: string;
  verify_tls?: boolean;
};

export type MailboxPollStatus = "idle" | "polling" | "ok" | "error";

export type IngestedEmail = {
  id: string;
  message_id: string;
  imap_uid: number;
  sender: string;
  subject: string;
  received_at?: string | null;
  status: "imported" | "skipped" | "partial" | "failed";
  attachment_count: number;
  documents_created: number;
  detail: string;
  bulk_upload?: string | null;
  created_at: string;
};

export type Mailbox = {
  id: string;
  name: string;
  connection: MailboxConnection;
  default_document_type: string | null;
  default_document_type_name?: string | null;
  auto_classify: boolean;
  sender_supplier_map: Record<string, string>;
  sender_allowlist: string[];
  related_set_attachments: boolean;
  max_messages_per_poll: number;
  is_active: boolean;
  poll_status: MailboxPollStatus;
  last_polled_at?: string | null;
  last_error?: string;
  last_seen_uid: number;
  last_imported_count: number;
  last_skipped_count: number;
  last_failed_count: number;
  created_by?: string | null;
  created_by_name?: string | null;
  created_at: string;
  updated_at: string;
  has_password?: boolean;
  recent_emails?: IngestedEmail[] | null;
};

export type MailboxInput = {
  name: string;
  connection?: MailboxConnection;
  default_document_type?: string | null;
  auto_classify?: boolean;
  sender_supplier_map?: Record<string, string>;
  sender_allowlist?: string[];
  related_set_attachments?: boolean;
  max_messages_per_poll?: number;
  is_active?: boolean;
};

export const mailboxAPI = {
  list: () => api.get<Mailbox[]>("/documents/mailboxes/"),
  get: (id: string) => api.get<Mailbox>(`/documents/mailboxes/${id}/`),
  status: (id: string) => api.get<Mailbox>(`/documents/mailboxes/${id}/status/`),
  create: (data: MailboxInput) => api.post<Mailbox>("/documents/mailboxes/", data),
  update: (id: string, data: Partial<MailboxInput>) =>
    api.patch<Mailbox>(`/documents/mailboxes/${id}/`, data),
  delete: (id: string) => api.delete(`/documents/mailboxes/${id}/`),
  poll: (id: string) => api.post<Mailbox>(`/documents/mailboxes/${id}/poll/`, {}),
  testConnection: (connection: MailboxConnection) =>
    api.post<{ ok: boolean; host?: string; folder?: string; detail?: string }>(
      "/documents/mailboxes/test_connection/",
      { connection },
    ),
  connectionDefaults: () =>
    api.get<{ connection: MailboxConnection; has_password: boolean }>(
      "/documents/mailboxes/connection_defaults/",
    ),
};

// ── Signing payload (structurally matches SignaturePlacementResult from
// SignaturePlacementModal) — kept local so this module stays decoupled from UI.
export type SignSubmission = {
  items: unknown[];
  timezone?: string;
  useNewSignature?: boolean;
  signatureImage?: string | null;
};

/** Build the multipart body the sign / approve endpoints expect from a placement
 *  result: the placed `items`, optional `timezone`, and (only when the signer
 *  drew a one-off signature) `use_new_signature` + `signature_image`. */
function buildSignatureForm(result: SignSubmission, extra?: Record<string, string>): FormData {
  const fd = new FormData();
  fd.append("items", JSON.stringify(result.items ?? []));
  if (result.timezone) fd.append("timezone", result.timezone);
  if (result.useNewSignature && result.signatureImage) {
    fd.append("use_new_signature", "true");
    fd.append("signature_image", result.signatureImage);
  }
  for (const [k, v] of Object.entries(extra ?? {})) fd.append(k, v);
  return fd;
}

export const workflowAPI = {
  // Templates
  listTemplates: () => api.get("/workflows/templates/"),
  getTemplate: (id: string) => api.get(`/workflows/templates/${id}/`),
  createTemplate: (data: unknown) => api.post("/workflows/templates/", data),
  updateTemplate: (id: string, data: unknown) =>
    api.put(`/workflows/templates/${id}/`, data),

  deleteTemplate: (id: string) => api.delete(`/workflows/templates/${id}/`),

  duplicateTemplate: (id: string, name?: string) =>
    api.post(
      `/workflows/templates/${id}/duplicate/`,
      name ? { name } : {}
    ),

  reorderSteps: (templateId: string, stepIds: string[]) =>
    api.post(`/workflows/templates/${templateId}/reorder_steps/`, {
      step_ids: stepIds,
    }),

  // Rules
  listRules: (params?: Record<string, unknown>) =>
    api.get("/workflows/rules/", { params }),
  createRule: (data: unknown) => api.post("/workflows/rules/", data),
  updateRule: (id: string, data: unknown) =>
    api.patch(`/workflows/rules/${id}/`, data),
  deleteRule: (id: string) => api.delete(`/workflows/rules/${id}/`),

  // Instances
  listInstances: (params?: Record<string, unknown>) =>
    api.get("/workflows/instances/", { params }),
  cancelInstance: (id: string) =>
    api.post(`/workflows/instances/${id}/cancel/`),

  // Tasks
  myTasks: () => api.get("/workflows/tasks/my_tasks/"),
  listTasks: (params?: Record<string, unknown>) =>
    api.get("/workflows/tasks/", { params }),
  approveTask: (id: string, comment = "", result?: SignSubmission) =>
    result
      ? api.post(`/workflows/tasks/${id}/approve/`, buildSignatureForm(result, { comment }), {
          headers: { "Content-Type": undefined },
        })
      : api.post(`/workflows/tasks/${id}/approve/`, { comment }),
  rejectTask: (id: string, comment: string) =>
    api.post(`/workflows/tasks/${id}/reject/`, { comment }),
  returnForReview: (id: string, comment: string) =>
    api.post(`/workflows/tasks/${id}/return_for_review/`, { comment }),
  holdTask: (id: string, comment: string, holdHours: number) =>
    api.post(`/workflows/tasks/${id}/hold/`, {
      comment,
      hold_hours: holdHours,
    }),
  releaseHold: (id: string) =>
    api.post(`/workflows/tasks/${id}/release_hold/`),
  taskHistory: (id: string) => api.get(`/workflows/tasks/${id}/history/`),
};

export interface NotificationSummary {
  unread_notifications: number;
  unread_task_alerts: number;
  pending_tasks: number;
  incoming_signatures: number;
}

export const notificationsAPI = {
  list: (params?: { is_read?: boolean }) => api.get("/notifications/", { params }),
  unreadCount: () => api.get("/notifications/unread_count/"),
  // Consolidated badge counts for the app shell — one cheap request instead of
  // separately polling notifications, workflow tasks and signature requests.
  summary: () => api.get<NotificationSummary>("/notifications/summary/"),
  markRead: (id: string) =>
    api.patch(`/notifications/${id}/`, { is_read: true }),
  markUnread: (id: string) =>
    api.patch(`/notifications/${id}/`, { is_read: false }),
  markAllRead: () => api.post("/notifications/mark_all_read/"),
};

// Combined helper for compatibility with existing components
export const documentApi = {
  ...documentsAPI,
  types: documentTypesAPI.list,
};

// ── Ad-hoc signature requests ─────────────────────────────────────────────────
export const signatureRequestsAPI = {
  list: (params?: { box?: "incoming" | "sent"; document?: string }) =>
    api.get("/documents/signature-requests/", { params }),
  /** Count of requests still awaiting the current user's signature (nav badge). */
  incomingCount: () =>
    api.get<{ count: number }>("/documents/signature-requests/incoming_count/"),
  get: (id: string) => api.get(`/documents/signature-requests/${id}/`),
  create: (data: {
    file: File;
    title: string;
    message?: string;
    ordered: boolean;
    signers: string[]; // ordered user ids
  }) => {
    const fd = new FormData();
    fd.append("file", data.file, data.file.name);
    fd.append("title", data.title);
    if (data.message) fd.append("message", data.message);
    fd.append("ordered", String(data.ordered));
    fd.append("signers", JSON.stringify(data.signers));
    return api.post("/documents/signature-requests/", fd, {
      headers: { "Content-Type": undefined },
    });
  },
  sign: (id: string, result: SignSubmission) =>
    api.post(`/documents/signature-requests/${id}/sign/`, buildSignatureForm(result), {
      headers: { "Content-Type": undefined },
    }),
  decline: (id: string, reason: string) =>
    api.post(`/documents/signature-requests/${id}/decline/`, { reason }),
  cancel: (id: string) => api.post(`/documents/signature-requests/${id}/cancel/`),
};

export const usersAPI = {
  list: (params?: Record<string, unknown>) => api.get("/users/", { params }),
  get: (id: string) => api.get(`/users/${id}/`),
  create: (data: {
    email: string;
    first_name: string;
    last_name: string;
    job_description: string;
    department?: string;
    password?: string;
    confirm_password?: string;
  }) => api.post("/users/", data),
  update: (
    id: string,
    data: Partial<{
      first_name: string;
      last_name: string;
      job_description: string;
      department: string | null;
      is_active: boolean;
    }>
  ) => api.patch(`/users/${id}/`, data),
  delete: (id: string) => api.delete(`/users/${id}/`),
  resetPassword: (id: string) => api.post(`/users/${id}/reset-password/`),
  toggleActive: (id: string) => api.post(`/users/${id}/toggle_active/`),
  delegations: (id: string) => api.get(`/users/${id}/delegations/`),
  reassignActiveTasks: (id: string, toUserId: string) =>
    api.post(`/users/${id}/reassign-active-tasks/`, { to_user_id: toUserId }),
};

export const departmentsAPI = {
  list: () => api.get("/departments/"),
  create: (data: { name: string; code: string; head_id?: string | null }) =>
    api.post("/departments/", data),
  update: (id: string, data: { name?: string; code?: string; head_id?: string | null }) =>
    api.patch(`/departments/${id}/`, data),
  delete: (id: string) => api.delete(`/departments/${id}/`),
};

export const profileAPI = {
  changePassword: (old_password: string, new_password: string) =>
    api.post("/auth/change-password/", { old_password, new_password }),

  // MFA is now default, but we keep toggle for admin flexibility
  toggleMFA: (enable = true) => api.post("/auth/mfa/", { enable }),
  listDelegations: () => api.get("/delegations/"),
  createDelegation: (data: { delegate_id: string; starts_at: string; ends_at: string; comment: string; document_type_id?: string | null }) =>
    api.post("/delegations/", data),
  updateDelegation: (
    id: string,
    data: Partial<{ delegate_id: string; starts_at: string; ends_at: string; comment: string; is_active: boolean; document_type_id?: string | null }>,
  ) => api.patch(`/delegations/${id}/`, data),
  deleteDelegation: (id: string) => api.delete(`/delegations/${id}/`),
  delegationCandidates: () => api.get("/delegations/candidates/"),
  getPreferences: () => api.get("/auth/preferences/"),
  updatePreferences: (data: {
    date_format?: string;
    time_format?: string;
    default_page?: string;
    notify_document_approvals?: boolean;
    notify_document_rejected?: boolean;
    notify_task_assignments?: boolean;
    notify_system_announcements?: boolean;
  }) => api.patch("/auth/preferences/", data),
  getSignature: () => api.get("/auth/signature/"),
  saveSignature: (formData: FormData) =>
    api.post("/auth/signature/", formData, {
      headers: { "Content-Type": undefined },
    }),
  deleteSignature: () => api.delete("/auth/signature/"),
};

export const groupsAPI = {
  list: () => api.get("/groups/"),
  get: (id: string) => api.get(`/groups/${id}/`),
  create: (data: { name: string; description?: string }) =>
    api.post("/groups/", data),
  update: (id: string, data: { name?: string; description?: string; head_id?: string | null; sees_all_documents?: boolean }) =>
    api.patch(`/groups/${id}/`, data),
  delete: (id: string) => api.delete(`/groups/${id}/`),
  duplicate: (id: string, data: { name: string; description?: string }) =>
    api.post(`/groups/${id}/duplicate/`, data),
  setPermissions: (
    id: string,
    permissions: { document_type_id: string | null; stage: string; action: string }[]
  ) => api.post(`/groups/${id}/set_permissions/`, { permissions }),
  members: (id: string) => api.get(`/groups/${id}/members/`),
  addMember: (id: string, userId: string, expiresAt?: string) =>
    api.post(`/groups/${id}/add_member/`, {
      user_id: userId,
      expires_at: expiresAt ?? null,
    }),
  removeMember: (id: string, userId: string) =>
    api.post(`/groups/${id}/remove_member/`, { user_id: userId }),
};

// ── Templates API ───────────────────────────────────────────────────────────────

export type TemplateCategory =
  | "finance" | "hr" | "procurement" | "legal" | "operations" | "admin" | "other";

export type TemplateUsageRecord = {
  id: string;
  document_id: string;
  document_title: string;
  used_by: { id: string; full_name: string };
  output_format: "pdf" | "docx";
  created_at: string;
};

export const templatesAPI = {
  /**
   * GET /templates/
   * Optional params: document_type_id, type ("built"|"uploaded"), search
   */
  list: (params?: Record<string, unknown>) =>
    api.get("/templates/", { params }),

  /** GET /templates/{id}/ */
  get: (id: string) => api.get(`/templates/${id}/`),

  /**
   * POST /templates/
   * Accepts either:
   *   a) JSON body  { name, description, type: "built", document_type, tags, sections: [...] }
   *   b) FormData   with file + name + description + type: "uploaded" + document_type
   *      Backend auto-detects {{placeholders}} in the DOCX/XLSX
   */
  create: (data: unknown) =>
    api.post("/templates/", data, data instanceof FormData ? { headers: { "Content-Type": undefined } } : undefined),

  /** PATCH /templates/{id}/ — update name, description, sections, category, tags, or replace the Office file (FormData) */
  update: (id: string, data: unknown) =>
    api.patch(`/templates/${id}/`, data, data instanceof FormData ? { headers: { "Content-Type": undefined } } : undefined),

  /** DELETE /templates/{id}/ — soft delete (sets is_active=false) */
  delete: (id: string) => api.delete(`/templates/${id}/`),

  /**
   * POST /templates/{id}/duplicate/
   * Creates a copy of the template owned by the current user.
   * Response: the new template object.
   */
  duplicate: (id: string) =>
    api.post(`/templates/${id}/duplicate/`),

  /**
   * POST /templates/{id}/fill/
   * Fills a template with user-supplied values and creates a Document.
   *
   * Body:
   * {
   *   template_id:       string,
   *   values:            Record<string, unknown>,  // field_key → value
   *   output_format:     "pdf" | "docx",
   *   title:             string,
   *   document_type_id?: string,
   * }
   *
   * Response: { document_id: string }
   */
  fillTemplate: (payload: {
    template_id: string;
    values: Record<string, unknown>;
    output_format: "pdf" | "docx";
    title: string;
    document_type_id?: string;
    draft_from_template?: boolean;
  }) => api.post(`/templates/${payload.template_id}/fill/`, payload),

  fillTemplateWithAttachments: (payload: {
    template_id: string;
    values: Record<string, unknown>;
    output_format: "pdf" | "docx";
    title: string;
    document_type_id?: string;
    draft_from_template?: boolean;
    attachments: Array<{ field: string; file: File }>;
  }) => {
    const fd = new FormData();
    fd.append("values", JSON.stringify(payload.values));
    fd.append("output_format", payload.output_format);
    fd.append("title", payload.title);
    if (payload.document_type_id) fd.append("document_type_id", payload.document_type_id);
    fd.append("draft_from_template", String(Boolean(payload.draft_from_template)));
    for (const { field, file } of payload.attachments) {
      fd.append(field, file, file.name);
    }
    return api.post(`/templates/${payload.template_id}/fill/`, fd, {
      headers: { "Content-Type": undefined },
    });
  },

  /**
   * POST /documents/{id}/upload_version/
   * Upload a file as a named form attachment after a built-template document is created.
   * Sends multipart FormData: file + field_key (used as the change_summary label).
   */
  /**
   * GET /templates/{id}/placeholders/
   * For uploaded templates — returns auto-detected {{placeholder}} keys.
   * Response: { placeholders: string[] }
   */
  getPlaceholders: (id: string) =>
    api.get<{ placeholders: string[] }>(`/templates/${id}/placeholders/`),

  /**
   * GET /templates/{id}/usages/
   * Returns the 20 most recent usage records for a template.
   * Response: TemplateUsageRecord[]
   */
  getUsages: (id: string) =>
    api.get<TemplateUsageRecord[]>(`/templates/${id}/usages/`),
};

// ── Chat API ─────────────────────────────────────────────────────────────────────

export const chatAPI = {
  // Chat Rooms
  rooms: {
    list: () => api.get("/chat/rooms/"),
    get: (id: string) => api.get(`/chat/rooms/${id}/`),
    create: (data: { name?: string; room_type: string; participant_ids?: string[] }) =>
      api.post("/chat/rooms/", data),
    getDirectMessage: (userId: string) =>
      api.get(`/chat/rooms/direct_message/?user_id=${userId}`),
    markRead: (id: string) => api.post(`/chat/rooms/${id}/mark_read/`),
    getMessages: (id: string, params?: any) =>
      api.get(`/chat/rooms/${id}/messages/`, { params }),
    leave: (id: string) => api.post(`/chat/rooms/${id}/leave/`),
  },
  
  // Messages
  messages: {
    list: (roomId?: string) => api.get("/chat/messages/", { params: { room_id: roomId } }),
    create: (data: { content: string; room_id: string; message_type?: string; reply_to?: string; client_id?: string }) =>
      api.post("/chat/messages/", data),
    markRead: (messageIds: string[]) =>
      api.post("/chat/messages/mark_read/", { message_ids: messageIds }),
  },
  
  // Users
  users: {
    list: () => api.get("/chat/users/"),
  },
  
  // Unread Messages
  unread: {
    list: () => api.get("/chat/unread/"),
    count: () => api.get("/chat/unread/count/"),
  },
  
  // Notifications
  notifications: {
    list: () => api.get("/chat/notifications/"),
    markAllRead: () => api.post("/chat/notifications/mark_all_read/"),
  },
};
