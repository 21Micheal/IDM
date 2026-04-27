import axios, { AxiosError, InternalAxiosRequestConfig } from "axios";
import { useAuthStore } from "@/store/authStore";
import type {
  DocumentEditTokenResponse,
  DocumentPreviewResponse,
} from "@/types";

// ── OCR suggestion types (exported for use in components) ─────────────────────

export type OcrFieldSuggestions = {
  title?: string;
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
  const currentHost = typeof window !== "undefined" ? window.location.hostname : "";
  if (currentHost === "localhost" || currentHost === "127.0.0.1" || currentHost === "::1") {
    return "/api/v1";
  }
  return normalizeApiBase(import.meta.env.VITE_API_URL ?? "/api/v1");
}

export const apiBaseUrl = resolveApiBaseUrl();

export const api = axios.create({
  baseURL: apiBaseUrl,
  headers: { "Content-Type": "application/json" },
});

// Attach JWT on every request
api.interceptors.request.use((config: InternalAxiosRequestConfig) => {
  const token = useAuthStore.getState().accessToken;
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
    if (error.response?.status === 401 && !original._retry) {
      original._retry = true;
      try {
        const refreshToken = useAuthStore.getState().refreshToken;
        const { data } = await axios.post(
          `${api.defaults.baseURL}/token/refresh/`,
          { refresh: refreshToken }
        );
        useAuthStore.getState().setTokens(data.access, refreshToken!);
        original.headers.Authorization = `Bearer ${data.access}`;
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
      headers: { "Content-Type": "multipart/form-data" },
      onUploadProgress: config?.onUploadProgress,
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
      headers: { "Content-Type": "multipart/form-data" },
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

  /** Get current preview URL. GET. Used for polling during Office→PDF conversion. */
  previewUrl: (id: string, versionId?: string) =>
    api.get<DocumentPreviewResponse>(`/documents/${id}/preview_url/`, {
      params: versionId ? { version_id: versionId } : undefined,
    }),
};

export const documentTypesAPI = {
  list: () => api.get("/documents/types/"),
  get: (id: string) => api.get(`/documents/types/${id}/`),
  create: (data: unknown) => api.post("/documents/types/", data),
  update: (id: string, data: unknown) =>
    api.patch(`/documents/types/${id}/`, data),
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
  listInstances: () => api.get("/workflows/instances/"),
  cancelInstance: (id: string) =>
    api.post(`/workflows/instances/${id}/cancel/`),

  // Tasks
  myTasks: () => api.get("/workflows/tasks/my_tasks/"),
  listTasks: (params?: Record<string, unknown>) =>
    api.get("/workflows/tasks/", { params }),
  approveTask: (id: string, comment = "") =>
    api.post(`/workflows/tasks/${id}/approve/`, { comment }),
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
  list: () => api.get("/notifications/"),
  markRead: (id: string) =>
    api.patch(`/notifications/${id}/`, { is_read: true }),
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
  toggleActive: (id: string) => api.post(`/users/${id}/toggle-active/`),
};

export const departmentsAPI = {
  list: () => api.get("/departments/"),
  create: (data: { name: string; code: string }) =>
    api.post("/departments/", data),
  update: (id: string, data: { name?: string; code?: string }) =>
    api.patch(`/departments/${id}/`, data),
  delete: (id: string) => api.delete(`/departments/${id}/`),
};

export const profileAPI = {
  changePassword: (old_password: string, new_password: string) =>
    api.post("/auth/change-password/", { old_password, new_password }),

  // MFA is now default, but we keep toggle for admin flexibility
  toggleMFA: (enable = true) => api.post("/auth/mfa/", { enable }),
};

export const groupsAPI = {
  list: () => api.get("/groups/"),
  get: (id: string) => api.get(`/groups/${id}/`),
  create: (data: { name: string; description?: string }) =>
    api.post("/groups/", data),
  update: (id: string, data: { name?: string; description?: string }) =>
    api.patch(`/groups/${id}/`, data),
  delete: (id: string) => api.delete(`/groups/${id}/`),
  setPermissions: (
    id: string,
    permissions: { document_type_id: string | null; action: string }[]
  ) => api.post(`/groups/${id}/set_permissions/`, { permissions }),
  setAdminAccess: (id: string, enabled: boolean) =>
    api.post(`/groups/${id}/set_admin_access/`, { enabled }),
  members: (id: string) => api.get(`/groups/${id}/members/`),
  addMember: (id: string, userId: string, expiresAt?: string) =>
    api.post(`/groups/${id}/add_member/`, {
      user_id: userId,
      expires_at: expiresAt ?? null,
    }),
  removeMember: (id: string, userId: string) =>
    api.post(`/groups/${id}/remove_member/`, { user_id: userId }),
};