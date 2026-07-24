import { useState, useEffect } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Lock, CheckCircle2, ArrowLeft, Loader2, AlertTriangle } from "lucide-react";
import { authAPI } from "@/services/api";

import dmsLogo from "@/assets/images/FSEDMSlogo.png";

// ── Shared page wrapper — defined outside the page component so React treats
// it as a stable reference and never unmounts/remounts it on re-renders.
function PageShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-gradient-to-br from-sky-50 via-sky-100 to-blue-200 flex items-center justify-center p-4">
      <div className="w-full max-w-[440px]">
        <div className="shadow-[0_2px_6px_rgba(0,0,0,0.15)]">
          {/* Logo strip — same light-blue header as LoginPage */}
          <div
            className="flex justify-center px-10 pt-8 pb-6"
            style={{ backgroundColor: "#dff0fb" }}
          >
            <img
              src={dmsLogo}
              alt="Flaxem Document Management System"
              className="h-24 w-auto"
            />
          </div>

          {/* Gradient body — same as LoginPage */}
          <div
            style={{
              background:
                "var(--gradient-sidebar, linear-gradient(180deg, hsl(203 64% 42%) 0%, hsl(203 78% 34%) 100%))",
            }}
          >
            <div className="px-10 pt-8 pb-10">{children}</div>

            <div className="px-10 pb-6 text-right text-[11px] text-white/60">
              © {new Date().getFullYear()} Flaxem
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export default function PasswordResetConfirmPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const token = searchParams.get("token") || "";

  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [isSuccess, setIsSuccess] = useState(false);
  const [error, setError] = useState("");
  const [isTokenValid, setIsTokenValid] = useState<boolean | null>(null);

  useEffect(() => {
    if (!token) {
      setIsTokenValid(false);
    } else {
      setIsTokenValid(true);
    }
  }, [token]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!token) {
      setError("Invalid reset link. Please request a new password reset.");
      return;
    }

    if (password.length < 8) {
      setError("Password must be at least 8 characters long.");
      return;
    }

    if (password !== confirmPassword) {
      setError("Passwords do not match.");
      return;
    }

    setIsLoading(true);
    setError("");

    try {
      await authAPI.confirmPasswordReset({ token, new_password: password });
      setIsSuccess(true);
    } catch (err: any) {
      setError(
        err.response?.data?.detail ||
          "Failed to reset password. The link may be invalid or expired."
      );
    } finally {
      setIsLoading(false);
    }
  };

  // ── PageShell is defined at module level above — see comment there.

  // ── Null guard — token validity not yet determined ────────────────────────

  if (isTokenValid === null) {
    return (
      <PageShell>
        <div className="flex items-center justify-center py-4">
          <Loader2 className="h-5 w-5 animate-spin text-white/70" />
        </div>
      </PageShell>
    );
  }

  // ── Invalid / missing token ───────────────────────────────────────────────

  if (isTokenValid === false) {
    return (
      <PageShell>
        <div className="flex items-center gap-3 mb-5">
          <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full bg-red-400/30">
            <AlertTriangle className="h-4 w-4 text-red-200" />
          </div>
          <h2 className="text-[15px] font-semibold text-white">Invalid reset link</h2>
        </div>

        <p className="text-[13px] leading-relaxed text-white/80 mb-6">
          This password reset link is invalid or has expired. Please go back to
          the login page and request a new link.
        </p>

        <button
          onClick={() => navigate("/login")}
          className="inline-flex h-9 items-center justify-center gap-2 bg-white px-6 text-[14px] font-normal text-[#155a86] transition-colors hover:bg-white/90"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          Back to sign in
        </button>
      </PageShell>
    );
  }

  // ── Success ───────────────────────────────────────────────────────────────

  if (isSuccess) {
    return (
      <PageShell>
        <div className="flex items-center gap-3 mb-5">
          <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full bg-white/20">
            <CheckCircle2 className="h-4 w-4 text-white" />
          </div>
          <h2 className="text-[15px] font-semibold text-white">Password updated</h2>
        </div>

        <p className="text-[13px] leading-relaxed text-white/80 mb-6">
          Your password has been reset successfully. You can now sign in with
          your new password.
        </p>

        <button
          onClick={() => navigate("/login")}
          className="inline-flex h-9 items-center justify-center gap-2 bg-white px-6 text-[14px] font-normal text-[#155a86] transition-colors hover:bg-white/90"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          Go to sign in
        </button>
      </PageShell>
    );
  }

  // ── Password form ─────────────────────────────────────────────────────────

  return (
    <PageShell>
      <h2 className="text-[15px] font-semibold text-white">Set new password</h2>
      <p className="mt-1.5 text-[13px] leading-relaxed text-white/80">
        Enter your new password below. It must be at least 8 characters long.
      </p>

      <form onSubmit={handleSubmit} className="mt-5 space-y-3">
        <div>
          <label htmlFor="pw-new" className="block text-[12px] font-medium text-white/70 mb-1">
            New password
          </label>
          <div className="relative">
            <Lock className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-white/50" />
            <input
              id="pw-new"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Min. 8 characters"
              disabled={isLoading}
              className="block h-9 w-full border border-white/40 bg-white/10 pl-7 pr-2 text-[14px] text-white placeholder:text-white/50 focus:border-white focus:outline-none disabled:opacity-60"
            />
          </div>
        </div>

        <div>
          <label htmlFor="pw-confirm" className="block text-[12px] font-medium text-white/70 mb-1">
            Confirm new password
          </label>
          <div className="relative">
            <Lock className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-white/50" />
            <input
              id="pw-confirm"
              type="password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              placeholder="Repeat password"
              disabled={isLoading}
              className="block h-9 w-full border border-white/40 bg-white/10 pl-7 pr-2 text-[14px] text-white placeholder:text-white/50 focus:border-white focus:outline-none disabled:opacity-60"
            />
          </div>
        </div>

        {error && (
          <p className="text-[12px] text-red-200">{error}</p>
        )}

        <div className="pt-3 flex items-center justify-between">
          <button
            type="submit"
            disabled={isLoading}
            className="inline-flex h-9 min-w-[140px] items-center justify-center bg-white px-6 text-[14px] font-normal text-[#155a86] transition-colors hover:bg-white/90 disabled:opacity-70"
          >
            {isLoading ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              "Reset password"
            )}
          </button>

          <button
            type="button"
            onClick={() => navigate("/login")}
            className="text-[13px] text-white/80 hover:text-white hover:underline"
          >
            Back to sign in
          </button>
        </div>
      </form>
    </PageShell>
  );
}
