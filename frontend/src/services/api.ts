import axios, { AxiosError, InternalAxiosRequestConfig } from "axios";
import { useAuthStore } from "@/store/authStore";
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
  watermark_enabled: boolean;
  watermark_text: string;
  watermark_opacity: number;
  watermark_position: "diagonal" | "center" | "footer";
  watermark_apply_to_previews: boolean;
  allow_duplicate_uploads: boolean;
  signed_file_urls_enabled: boolean;
  auto_archive_enabled: boolean;
  auto_archive_after_days: number;
  require_metadata_on_upload: boolean;
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
  console.log('Raw VITE_API_URL from import.meta.env:', rawApiUrl);
  
  if (!rawApiUrl) {
    console.log('No VITE_API_URL found, using default /api/v1');
    return "/api/v1";
  }

  const normalized = normalizeApiBase(rawApiUrl);
  console.log('Normalized API URL:', normalized);

  if (typeof window !== "undefined") {
    try {
      const parsed = new URL(normalized, window.location.origin);
      if (parsed.protocol === "http:" || parsed.protocol === "https:") {
        const finalUrl = parsed.href.replace(/\/+$|\/$/, "");
        console.log('Final resolved API URL:', finalUrl);
        return finalUrl;
      }
    } catch (error) {
      console.log('URL parsing failed, falling back to /api/v1', error);
      // fall back to proxy-friendly relative API path
    }
  }

  console.log('Using fallback /api/v1');
  return "/api/v1";
}

export const apiBaseUrl = resolveApiBaseUrl();
console.log('API Base URL resolved to:', apiBaseUrl);

export const api = axios.create({
  baseURL: apiBaseUrl,
  headers: { "Content-Type": "application/json" },
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

  delete: (id: string) => api.delete(`/documents/${id}/`),
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
    action: "approve" | "reject" | "archive" | "void",
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
};

export const searchAPI = {
  search: (payload: unknown) => api.post("/search/", payload),
};

export const workflowAPI = {
  // Templates
  listTemplates: () => api.get("/workflows/templates/"),
  getTemplate: (id: string) => api.get(`/workflows/templates/${id}/`),
  createTemplate: (data: unknown) => api.post("/workflows/templates/", data),
  updateTemplate: (id: string, data: unknown) =>
    api.put(`/workflows/templates/${id}/`, data),

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
  approveTask: (
    id: string,
    comment = "",
    signaturePlacement?: { page_number: number; x_percent: number; y_percent: number; width_percent?: number },
  ) =>
    api.post(`/workflows/tasks/${id}/approve/`, {
      comment,
      ...(signaturePlacement ? { signature_placement: signaturePlacement } : {}),
    }),
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

export const notificationsAPI = {
  list: (params?: { is_read?: boolean }) => api.get("/notifications/", { params }),
  unreadCount: () => api.get("/notifications/unread_count/"),
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
  update: (id: string, data: { name?: string; description?: string; head_id?: string | null }) =>
    api.patch(`/groups/${id}/`, data),
  delete: (id: string) => api.delete(`/groups/${id}/`),
  setPermissions: (
    id: string,
    permissions: { document_type_id: string; stage: string; action: string }[]
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

  /** PATCH /templates/{id}/ — update name, description, sections, category, tags */
  update: (id: string, data: unknown) =>
    api.patch(`/templates/${id}/`, data),

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
