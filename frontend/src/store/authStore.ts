import { create } from "zustand";
import { persist } from "zustand/middleware";

export type UserRole = "admin" | "finance" | "auditor" | "viewer";

export interface AuthUser {
  id: string;
  email: string;
  first_name: string;
  last_name: string;
  role: UserRole;
  mfa_enabled: boolean;
  must_change_password: boolean;          // ← new field
  department?: { id: string; name: string };
}

interface AuthState {
  user: AuthUser | null;
  accessToken: string | null;
  refreshToken: string | null;
  isAuthenticated: boolean;
  setTokens: (access: string, refresh: string) => void;
  setUser: (user: AuthUser) => void;
  logout: () => void;
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set) => ({
      user: null,
      accessToken: null,
      refreshToken: null,
      isAuthenticated: false,
      setTokens: (access, refresh) =>
        set({ accessToken: access, refreshToken: refresh, isAuthenticated: true }),
      setUser: (user) => set({ user }),
      logout: () =>
        set({ user: null, accessToken: null, refreshToken: null, isAuthenticated: false }),
    }),
    { name: "dms-auth" }
  )
);

export const isAdmin = (user: AuthUser | null): boolean => {
  return user?.role === "admin";
};
