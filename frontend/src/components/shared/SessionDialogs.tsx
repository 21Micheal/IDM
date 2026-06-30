import { useEffect, useMemo, useState } from "react";
import { Clock, LogIn, ShieldAlert } from "lucide-react";
import { useAuthStore } from "@/store/authStore";
import { useSessionUiStore } from "@/store/sessionUiStore";
import { authAPI } from "@/services/api";

function formatCountdown(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

/**
 * Shown after the user has been signed out because their session expired.
 * Top-centered, blocks the page, and stays until they click OK or click
 * anywhere on the overlay.
 */
function SessionExpiredModal() {
  const expiredNotice = useSessionUiStore((s) => s.expiredNotice);
  const dismiss = useSessionUiStore((s) => s.dismissExpiredNotice);

  useEffect(() => {
    if (!expiredNotice) return;
    const onKey = () => dismiss();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [expiredNotice, dismiss]);

  if (!expiredNotice) return null;

  return (
    <div
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="session-expired-title"
      onClick={dismiss}
      className="fixed inset-0 z-[200] flex items-start justify-center bg-[#1F2933]/40 px-4 pt-[12vh]"
    >
      <div className="w-full max-w-md border border-[#C8CDD2] bg-white shadow-xl">
        <div className="flex items-start gap-3 border-b border-[#C8CDD2] bg-[#F5F7F8] px-5 py-4">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center border border-[#E3B7A7] bg-[#FBEEE9] text-[#B4532A]">
            <ShieldAlert className="h-4 w-4" />
          </div>
          <div>
            <h2 id="session-expired-title" className="text-sm font-semibold text-[#1F2933]">
              Your session has expired
            </h2>
            <p className="mt-1 text-xs leading-relaxed text-[#5E6870]">
              You have been signed out automatically. Please sign in again to continue.
            </p>
          </div>
        </div>
        <div className="flex justify-end gap-2 px-5 py-3">
          <button
            type="button"
            onClick={dismiss}
            className="inline-flex items-center gap-2 bg-[#287EAD] px-4 py-2 text-sm font-semibold text-white hover:bg-[#1E6F99]"
          >
            <LogIn className="h-4 w-4" />
            OK
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Shown a few minutes before the session ends. The idle (inactivity) window can
 * be extended in place; the absolute lifetime cap cannot, so we tell the user
 * honestly which case they're in.
 */
function SessionExpiryWarning() {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const sessionExpiresAt = useAuthStore((s) => s.sessionExpiresAt);
  const lastActivityAt = useAuthStore((s) => s.lastActivityAt);
  const idleMinutes = useAuthStore((s) => s.sessionPolicy.idleTimeoutMinutes);
  const lifetimeMinutes = useAuthStore((s) => s.sessionPolicy.lifetimeMinutes);
  const warningMinutes = useAuthStore((s) => s.sessionPolicy.warningMinutes);
  const recordActivity = useAuthStore((s) => s.recordActivity);

  const [now, setNow] = useState(() => Date.now());
  // Suppress re-showing for a deadline the user explicitly dismissed.
  const [dismissedDeadline, setDismissedDeadline] = useState<number | null>(null);

  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);

  const view = useMemo(() => {
    if (!isAuthenticated) return null;
    if (warningMinutes <= 0) return null; // admin-disabled

    const idleMs = idleMinutes > 0 ? idleMinutes * 60 * 1000 : Infinity;
    const idleDeadline =
      idleMs !== Infinity && lastActivityAt ? lastActivityAt + idleMs : Infinity;
    const absoluteDeadline = sessionExpiresAt ?? Infinity;
    const deadline = Math.min(idleDeadline, absoluteDeadline);
    if (!Number.isFinite(deadline)) return null;

    const limitedByIdle = idleDeadline <= absoluteDeadline;
    // Use the admin-configured lead, but never warn earlier than half the
    // relevant window (keeps very short idle timeouts from warning the instant
    // they begin).
    const fullWindow = limitedByIdle ? idleMs : lifetimeMinutes * 60 * 1000;
    const lead = Math.min(warningMinutes * 60 * 1000, Math.floor(fullWindow / 2));

    const remaining = deadline - now;
    const visible =
      remaining > 0 && remaining <= lead && dismissedDeadline !== deadline;
    if (!visible) return null;

    return { remaining, limitedByIdle, deadline };
  }, [
    isAuthenticated,
    idleMinutes,
    lifetimeMinutes,
    warningMinutes,
    lastActivityAt,
    sessionExpiresAt,
    now,
    dismissedDeadline,
  ]);

  if (!view) return null;

  const extend = () => {
    // Resets the inactivity clock immediately; the server revalidation also
    // refreshes the access token (via the 401-retry interceptor) if it has aged.
    recordActivity();
    authAPI.me().catch(() => {});
  };

  return (
    <div className="fixed inset-x-0 top-0 z-[150] flex justify-center px-4 pt-6">
      <div
        role="alertdialog"
        aria-modal="false"
        aria-labelledby="session-warning-title"
        className="w-full max-w-md border border-[#C8CDD2] bg-white shadow-xl"
      >
        <div className="flex items-start gap-3 border-b border-[#C8CDD2] bg-[#F5F7F8] px-5 py-4">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center border border-[#A7CDE3] bg-[#EEF6FB] text-[#287EAD]">
            <Clock className="h-4 w-4" />
          </div>
          <div>
            <h2 id="session-warning-title" className="text-sm font-semibold text-[#1F2933]">
              Your session is about to expire
            </h2>
            <p className="mt-1 text-xs leading-relaxed text-[#5E6870]">
              {view.limitedByIdle ? (
                <>
                  You will be signed out due to inactivity in{" "}
                  <span className="font-semibold text-[#1F2933]">
                    {formatCountdown(view.remaining)}
                  </span>
                  . Choose “Stay signed in” to continue working.
                </>
              ) : (
                <>
                  Your session reaches its maximum length in{" "}
                  <span className="font-semibold text-[#1F2933]">
                    {formatCountdown(view.remaining)}
                  </span>{" "}
                  and cannot be extended. Please save your work — you will need to
                  sign in again.
                </>
              )}
            </p>
          </div>
        </div>
        <div className="flex justify-end gap-2 px-5 py-3">
          <button
            type="button"
            onClick={() => setDismissedDeadline(view.deadline)}
            className="inline-flex items-center gap-2 border border-[#AEB5BB] bg-white px-3 py-2 text-sm font-semibold text-[#1F2933] hover:bg-[#EEF3F7]"
          >
            Dismiss
          </button>
          {view.limitedByIdle && (
            <button
              type="button"
              onClick={extend}
              className="inline-flex items-center gap-2 bg-[#287EAD] px-4 py-2 text-sm font-semibold text-white hover:bg-[#1E6F99]"
            >
              Stay signed in
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

/** Mounts both session dialogs. Render once, high in the tree. */
export default function SessionDialogs() {
  return (
    <>
      <SessionExpiryWarning />
      <SessionExpiredModal />
    </>
  );
}
