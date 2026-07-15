import { create } from "zustand";
import { persist } from "zustand/middleware";

// Session policy is admin-configurable (DMS settings → Security). These are the
// fallbacks used before the server policy has been fetched (e.g. the very first
// render after login, before the login/me response is applied).
const DEFAULT_SESSION_LIFETIME_MIN = 360; // absolute max session, 6h
const DEFAULT_IDLE_TIMEOUT_MIN = 30;      // sign out after inactivity; 0 disables
const DEFAULT_WARNING_MIN = 3;            // warn before expiry; 0 disables

export interface SessionPolicy {
  /** Absolute maximum session duration from sign-in, in minutes. */
  lifetimeMinutes: number;
  /** Sign out after this many minutes of inactivity. 0 disables the idle timeout. */
  idleTimeoutMinutes: number;
  /** Warn this many minutes before the session ends. 0 disables the warning. */
  warningMinutes: number;
}

const DEFAULT_POLICY: SessionPolicy = {
  lifetimeMinutes: DEFAULT_SESSION_LIFETIME_MIN,
  idleTimeoutMinutes: DEFAULT_IDLE_TIMEOUT_MIN,
  warningMinutes: DEFAULT_WARNING_MIN,
};

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
  /** Absolute expiry timestamp (ms) — when the session must end no matter what. */
  sessionExpiresAt: number | null;
  /** Last time the user interacted, used for the inactivity timeout. */
  lastActivityAt: number | null;
  sessionPolicy: SessionPolicy;
  isAuthenticated: boolean;
  setTokens: (access: string, refresh: string) => void;
  setUser: (user: AuthUser) => void;
  setSessionPolicy: (policy: Partial<SessionPolicy>) => void;
  recordActivity: () => void;
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
      lastActivityAt: null,
      sessionPolicy: DEFAULT_POLICY,
      isAuthenticated: false,
      setTokens: (access, refresh) =>
        set((state) => {
          const now = Date.now();
          const lifetimeMs = state.sessionPolicy.lifetimeMinutes * 60 * 1000;
          // Preserve the absolute deadline across token refreshes; only (re)start
          // the clock on a fresh sign-in (no live deadline yet).
          const sessionExpiresAt =
            state.sessionExpiresAt && state.sessionExpiresAt > now
              ? state.sessionExpiresAt
              : now + lifetimeMs;
          return {
            accessToken: access,
            refreshToken: refresh,
            sessionExpiresAt,
            lastActivityAt: state.lastActivityAt ?? now,
            isAuthenticated: true,
          };
        }),
      setUser: (user) => set({ user }),
      setSessionPolicy: (policy) =>
        set((state) => ({
          sessionPolicy: { ...state.sessionPolicy, ...policy },
        })),
      recordActivity: () => set({ lastActivityAt: Date.now() }),
      logout: () =>
        set({
          user: null,
          accessToken: null,
          refreshToken: null,
          sessionExpiresAt: null,
          lastActivityAt: null,
          isAuthenticated: false,
        }),
      isSessionExpired: (): boolean => {
        const { sessionExpiresAt, sessionPolicy, lastActivityAt } = get();
        const now = Date.now();
        // Absolute lifetime cap.
        if (sessionExpiresAt && sessionExpiresAt <= now) return true;
        // Inactivity (idle) timeout.
        const idleMs = sessionPolicy.idleTimeoutMinutes * 60 * 1000;
        if (idleMs > 0 && lastActivityAt && now - lastActivityAt >= idleMs) {
          return true;
        }
        return false;
      },
    }),
    { name: "dms-auth" }
  )
);

/** Server-side session policy shape, as returned by login / me / refresh. */
export interface ServerSessionPolicy {
  session_lifetime_minutes?: number;
  session_idle_timeout_minutes?: number;
  session_warning_minutes?: number;
}

/**
 * Sync the store's session policy from a server response. Call this BEFORE
 * `setTokens` on a fresh sign-in so the absolute deadline uses the configured
 * lifetime rather than the local fallback.
 */
export function applyServerSessionPolicy(policy?: ServerSessionPolicy | null): void {
  if (!policy) return;
  const next: Partial<SessionPolicy> = {};
  if (typeof policy.session_lifetime_minutes === "number") {
    next.lifetimeMinutes = policy.session_lifetime_minutes;
  }
  if (typeof policy.session_idle_timeout_minutes === "number") {
    next.idleTimeoutMinutes = policy.session_idle_timeout_minutes;
  }
  if (typeof policy.session_warning_minutes === "number") {
    next.warningMinutes = policy.session_warning_minutes;
  }
  if (Object.keys(next).length > 0) {
    useAuthStore.getState().setSessionPolicy(next);
  }
}

export const isAdmin = (user: AuthUser | null): boolean => {
  return Boolean(user?.has_admin_access);
};
