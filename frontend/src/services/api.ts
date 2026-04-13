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
    const original = error.config as InternalAxiosRequestConfig & { _retry?: boolean };
    if (error.response?.status === 401 && !original._retry) {
      original._retry = true;
      try {
        const refreshToken = useAuthStore.getState().refreshToken;
        const { data } = await axios.post(`${api.defaults.baseURL}/token/refresh/`, {
          refresh: refreshToken,
        });
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
  login:     (email: string, password: string) =>
    api.post("/auth/login/", { email, password }),

  verifyOTP: (userId: string, otp: string) =>
    api.post("/auth/verify-otp/", { user_id: userId, otp }),

  resendOTP: (userId: string) =>
    api.post("/auth/resend-otp/", { user_id: userId }),

  me: () => api.get("/auth/me/"),
};


export const documentsAPI = {
  list: (params?: Record<string, unknown>) => api.get("/documents/", { params }),
  get: (id: string) => api.get(`/documents/${id}/`),
  upload: (formData: FormData) =>
    api.post("/documents/", formData, { headers: { "Content-Type": "multipart/form-data" } }),
  update: (id: string, data: Record<string, unknown>) => api.patch(`/documents/${id}/`, data),
  delete: (id: string) => api.delete(`/documents/${id}/`),
  submit: (id: string) => api.post(`/documents/${id}/submit/`),
  archive: (id: string) => api.post(`/documents/${id}/archive/`),
  previewUrl: (id: string) => api.get(`/documents/${id}/preview_url/`),
  uploadVersion: (id: string, formData: FormData) =>
    api.post(`/documents/${id}/upload_version/`, formData, {
      headers: { "Content-Type": "multipart/form-data" },
    }),
  restoreVersion: (id: string, versionId: string) =>
    api.post(`/documents/${id}/restore_version/`, { version_id: versionId }),
  comments: (id: string) => api.get(`/documents/${id}/comments/`),
  addComment: (id: string, content: string, isInternal = false) =>
    api.post(`/documents/${id}/comments/`, { content, is_internal: isInternal }),
  auditTrail: (id: string) => api.get(`/documents/${id}/audit_trail/`),
};

export const documentTypesAPI = {
  list: () => api.get("/documents/types/"),
  get: (id: string) => api.get(`/documents/types/${id}/`),
  create: (data: unknown) => api.post("/documents/types/", data),
  update: (id: string, data: unknown) => api.patch(`/documents/types/${id}/`, data),
};
export const searchAPI = {
  search: (payload: unknown) => api.post("/search/", payload),
};

export const workflowAPI = {
  myTasks: () => api.get("/workflows/tasks/?status=in_progress"),
  approveTask: (id: string, comment = "") =>
    api.post(`/workflows/tasks/${id}/approve/`, { comment }),
  rejectTask: (id: string, comment: string) =>
    api.post(`/workflows/tasks/${id}/reject/`, { comment }),
  templates: () => api.get("/workflows/templates/"),
  createTemplate: (data: unknown) => api.post("/workflows/templates/", data),
};

export const notificationsAPI = {
  list: () => api.get("/notifications/"),
  markRead: (id: string) => api.patch(`/notifications/${id}/`, { is_read: true }),
  markAllRead: () => api.post("/notifications/mark-all-read/"),
};

// Combined helper for compatibility with existing components
export const documentApi = {
  ...documentsAPI,
  types: documentTypesAPI.list,
};
/**
 * ADD THESE BLOCKS to the bottom of frontend/src/services/api.ts
 * (keep everything already in the file — just append these exports)
 */

export const usersAPI = {
  list: (params?: Record<string, unknown>) =>
    api.get("/users/", { params }),

  get: (id: string) =>
    api.get(`/users/${id}/`),

  create: (data: {
    email: string;
    first_name: string;
    last_name: string;
    role: string;
    department?: string;
    password?: string;
    confirm_password?: string;
  }) => api.post("/users/", data),

  update: (id: string, data: Partial<{
    first_name: string;
    last_name: string;
    role: string;
    department: string | null;
    is_active: boolean;
  }>) => api.patch(`/users/${id}/`, data),

  resetPassword: (id: string) =>
    api.post(`/users/${id}/reset-password/`),

  toggleActive: (id: string) =>
    api.post(`/users/${id}/toggle-active/`),
};

export const departmentsAPI = {
  list: () =>
    api.get("/departments/"),

  create: (data: { name: string; code: string }) =>
    api.post("/departments/", data),

  update: (id: string, data: { name?: string; code?: string }) =>
    api.patch(`/departments/${id}/`, data),

  delete: (id: string) =>
    api.delete(`/departments/${id}/`),
};

export const profileAPI = {
  changePassword: (old_password: string, new_password: string) =>
    api.post("/auth/change-password/", { old_password, new_password }),

  // MFA is now default, but we keep toggle for admin flexibility
  toggleMFA: (enable: boolean = true) =>
    api.post("/auth/mfa/", { enable }),
};

// export const profileAPI = {
//   changePassword: (old_password: string, new_password: string) =>
//     api.post("/auth/change-password/", { old_password, new_password }),

//   setupMFA: () =>
//     api.post("/auth/mfa/setup/"),

//   confirmMFA: (token: string) =>
//     api.post("/auth/mfa/confirm/", { token }),

//   disableMFA: (password: string) =>
//     api.post("/auth/mfa/disable/", { password }),
// };

export const groupsAPI = {
  list: () =>
    api.get("/groups/"),

  get: (id: string) =>
    api.get(`/groups/${id}/`),

  create: (data: { name: string; description?: string }) =>
    api.post("/groups/", data),

  update: (id: string, data: { name?: string; description?: string }) =>
    api.patch(`/groups/${id}/`, data),

  delete: (id: string) =>
    api.delete(`/groups/${id}/`),

  setPermissions: (
    id: string,
    permissions: { document_type_id: string | null; action: string }[]
  ) => api.post(`/groups/${id}/set_permissions/`, { permissions }),

  members:      (id: string) => api.get(`/groups/${id}/members/`),
  addMember:    (id: string, userId: string, expiresAt?: string) =>
    api.post(`/groups/${id}/add_member/`, { user_id: userId, expires_at: expiresAt ?? null }),
  removeMember: (id: string, userId: string) =>
    api.post(`/groups/${id}/remove_member/`, { user_id: userId }),
};