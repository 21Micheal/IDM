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
  login: (email: string, password: string) =>
    api.post("/auth/login/", { email, password }),
  verifyOTP: (userId: string, otp: string) =>
    api.post("/auth/verify-otp/", { user_id: userId, otp }),
  me: () => api.get("/auth/me/"),
  setupMFA: () => api.post("/auth/mfa/setup/"),
  confirmMFA: (token: string) => api.post("/auth/mfa/confirm/", { token }),
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
