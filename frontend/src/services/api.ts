import axios, { AxiosError, InternalAxiosRequestConfig } from "axios";
import { useAuthStore } from "@/store/authStore";

export const api = axios.create({
  baseURL: import.meta.env.VITE_API_URL ?? "/api/v1",
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

  me: () => api.get("/auth/me/"),
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

  previewUrl: (id: string) => api.get(`/documents/${id}/preview_url/`),

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

  auditTrail: (id: string) => api.get(`/documents/${id}/audit_trail/`),

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
};

export const documentTypesAPI = {
  list: () => api.get("/documents/types/"),
  get: (id: string) => api.get(`/documents/types/${id}/`),
  create: (data: unknown) => api.post("/documents/types/", data),
  update: (id: string, data: unknown) =>
    api.patch(`/documents/types/${id}/`, data),
};

export const rolesAPI = {
  list: () => api.get("/roles/"),
  create: (data: { code: string; name: string; description?: string }) =>
    api.post("/roles/", data),
  update: (id: string, data: { name?: string; description?: string; is_active?: boolean }) =>
    api.patch(`/roles/${id}/`, data),
  delete: (id: string) => api.delete(`/roles/${id}/`),
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
    role: string;
    department?: string;
    password?: string;
    confirm_password?: string;
  }) => api.post("/users/", data),
  update: (
    id: string,
    data: Partial<{
      first_name: string;
      last_name: string;
      role: string;
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
  members: (id: string) => api.get(`/groups/${id}/members/`),
  addMember: (id: string, userId: string, expiresAt?: string) =>
    api.post(`/groups/${id}/add_member/`, {
      user_id: userId,
      expires_at: expiresAt ?? null,
    }),
  removeMember: (id: string, userId: string) =>
    api.post(`/groups/${id}/remove_member/`, { user_id: userId }),
};