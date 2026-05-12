import { create } from "zustand";
import { persist } from "zustand/middleware";

const SESSION_DURATION_MS = 6 * 60 * 60 * 1000;

export interface AuthUser {
  id: string;
  email: string;
  first_name: string;
  last_name: string;
  job_description?: string;
  is_staff?: boolean;
  has_admin_access?: boolean;
  group_names?: string[];
  mfa_enabled: boolean;
  must_change_password: boolean;          // ← new field
  department_name?: string | null;
  department?: { id: string; name: string };
}

export interface AuthState {
  user: AuthUser | null;
  accessToken: string | null;
  refreshToken: string | null;
  sessionExpiresAt: number | null;
  isAuthenticated: boolean;
  setTokens: (access: string, refresh: string) => void;
  setUser: (user: AuthUser) => void;
  logout: () => void;
  isSessionExpired: () => boolean;
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set, get) => ({
      user: null,
      accessToken: null,
      refreshToken: null,
      sessionExpiresAt: null,
      isAuthenticated: false,
      setTokens: (access, refresh) =>
        set((state) => ({
          accessToken: access,
          refreshToken: refresh,
          sessionExpiresAt:
            state.sessionExpiresAt && state.sessionExpiresAt > Date.now()
              ? state.sessionExpiresAt
              : Date.now() + SESSION_DURATION_MS,
          isAuthenticated: true,
        })),
      setUser: (user) => set({ user }),
      logout: () =>
        set({
          user: null,
          accessToken: null,
          refreshToken: null,
          sessionExpiresAt: null,
          isAuthenticated: false,
        }),
      isSessionExpired: (): boolean => {
        const expiresAt = get().sessionExpiresAt;
        return Boolean(expiresAt && expiresAt <= Date.now());
      },
    }),
    { name: "dms-auth" }
  )
);

export const isAdmin = (user: AuthUser | null): boolean => {
  return Boolean(user?.has_admin_access);
};
