import { create } from "zustand";

/**
 * Ephemeral UI state for session-expiry messaging. Deliberately NOT persisted:
 * the "your session expired" notice should outlive the logout → /login redirect
 * (so the user understands why they landed there), but a full page reload starts
 * fresh and should not resurface it.
 */
interface SessionUiState {
  /** True once the user has been signed out because their session expired. */
  expiredNotice: boolean;
  showExpiredNotice: () => void;
  dismissExpiredNotice: () => void;
}

export const useSessionUiStore = create<SessionUiState>((set) => ({
  expiredNotice: false,
  showExpiredNotice: () => set({ expiredNotice: true }),
  dismissExpiredNotice: () => set({ expiredNotice: false }),
}));
