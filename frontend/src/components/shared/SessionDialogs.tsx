import { useEffect, useMemo, useState } from "react";
import { LogIn } from "lucide-react";
import { useAuthStore } from "@/store/authStore";
import { useSessionUiStore } from "@/store/sessionUiStore";
import { authAPI } from "@/services/api";

function formatCountdown(ms: number): string {
  const total   = Math.max(0, Math.ceil(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  if (minutes === 0) return `${seconds} second${seconds !== 1 ? "s" : ""}`;
  return `${minutes} minute${minutes !== 1 ? "s" : ""} ${seconds} second${seconds !== 1 ? "s" : ""}`;
}

// ── Shared wrapper — backdrop + top-anchored card ────────────────────────────
const backdropClass = "fixed inset-0 z-[200] bg-black/40 flex items-start justify-center pt-[10vh] px-4";
const cardClass     = "w-full max-w-sm border border-[#C8CDD2] bg-white shadow-2xl";

/**
 * Shown after the user has been signed out because their session expired.
 * No backdrop — floats above the page. Only the button dismisses it.
 */
function SessionExpiredModal() {
  const expiredNotice = useSessionUiStore((s) => s.expiredNotice);
  const dismiss       = useSessionUiStore((s) => s.dismissExpiredNotice);

  if (!expiredNotice) return null;

  return (
    <div className={backdropClass}>
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="session-expired-title"
        className={cardClass}
      >
        <div className="px-6 pt-5 pb-4">
          <h2 id="session-expired-title" className="text-sm font-bold text-[#1F2933]">
            Your session has expired
          </h2>
          <p className="mt-1.5 text-xs leading-relaxed text-[#5E6870]">
            You have been signed out automatically. Please sign in again to continue.
          </p>
        </div>
        <div className="flex justify-center pb-5">
          <button
            type="button"
            onClick={dismiss}
            className="inline-flex items-center gap-2 bg-[#287EAD] px-5 py-2 text-sm font-semibold text-white hover:bg-[#1E6F99] transition-colors"
          >
            <LogIn className="h-3.5 w-3.5" />
            Sign in again
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Shown a few minutes before the session ends.
 * Idle windows can be extended; the absolute lifetime cap cannot.
 */
function SessionExpiryWarning() {
  const isAuthenticated  = useAuthStore((s) => s.isAuthenticated);
  const sessionExpiresAt = useAuthStore((s) => s.sessionExpiresAt);
  const lastActivityAt   = useAuthStore((s) => s.lastActivityAt);
  const idleMinutes      = useAuthStore((s) => s.sessionPolicy.idleTimeoutMinutes);
  const lifetimeMinutes  = useAuthStore((s) => s.sessionPolicy.lifetimeMinutes);
  const warningMinutes   = useAuthStore((s) => s.sessionPolicy.warningMinutes);
  const recordActivity   = useAuthStore((s) => s.recordActivity);

  const [now, setNow]                       = useState(() => Date.now());
  const [dismissedDeadline, setDismissed]   = useState<number | null>(null);

  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);

  const view = useMemo(() => {
    if (!isAuthenticated || warningMinutes <= 0) return null;

    const idleMs           = idleMinutes > 0 ? idleMinutes * 60 * 1000 : Infinity;
    const idleDeadline     = idleMs !== Infinity && lastActivityAt ? lastActivityAt + idleMs : Infinity;
    const absoluteDeadline = sessionExpiresAt ?? Infinity;
    const deadline         = Math.min(idleDeadline, absoluteDeadline);
    if (!Number.isFinite(deadline)) return null;

    const limitedByIdle = idleDeadline <= absoluteDeadline;
    const fullWindow    = limitedByIdle ? idleMs : lifetimeMinutes * 60 * 1000;
    const lead          = Math.min(warningMinutes * 60 * 1000, Math.floor(fullWindow / 2));
    const remaining     = deadline - now;

    if (remaining <= 0 || remaining > lead || dismissedDeadline === deadline) return null;
    return { remaining, limitedByIdle, deadline };
  }, [
    isAuthenticated, idleMinutes, lifetimeMinutes, warningMinutes,
    lastActivityAt, sessionExpiresAt, now, dismissedDeadline,
  ]);

  if (!view) return null;

  const extend = () => {
    recordActivity();
    authAPI.me().catch(() => {});
    setDismissed(view.deadline);
  };

  return (
    <div className={backdropClass}>
      <div
        role="alertdialog"
        aria-modal="false"
        aria-labelledby="session-warning-title"
        className={cardClass}
      >
        <div className="px-6 pt-5 pb-4">
          <h2 id="session-warning-title" className="text-sm font-bold text-[#1F2933]">
            Your session is expiring soon
          </h2>
          <p className="mt-1.5 text-xs leading-relaxed text-[#5E6870]">
            {view.limitedByIdle ? (
              <>
                You will be logged out in{" "}
                <span className="font-semibold text-[#1F2933]">
                  {formatCountdown(view.remaining)}
                </span>
                .
              </>
            ) : (
              <>
                Your session reaches its maximum length in{" "}
                <span className="font-semibold text-[#1F2933]">
                  {formatCountdown(view.remaining)}
                </span>{" "}
                and cannot be extended. Please save your work.
              </>
            )}
          </p>
        </div>

        <div className="flex items-center justify-center gap-3 pb-5">
          <button
            type="button"
            onClick={() => setDismissed(view.deadline)}
            className="inline-flex items-center border border-[#C8CDD2] bg-white px-4 py-1.5 text-xs font-semibold text-[#5E6870] hover:bg-[#F5F7F8] transition-colors"
          >
            Dismiss
          </button>
          {view.limitedByIdle && (
            <button
              type="button"
              onClick={extend}
              className="inline-flex items-center bg-[#287EAD] px-5 py-2 text-sm font-semibold text-white hover:bg-[#1E6F99] transition-colors"
            >
              Continue session
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
