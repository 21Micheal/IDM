import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { FileText, Loader2, Mail, RefreshCw } from "lucide-react";
import { authAPI } from "@/services/api";
import { useAuthStore } from "@/store/authStore";
import { toast } from "react-toastify";

const credSchema = z.object({
  email:    z.string().email("Invalid email"),
  password: z.string().min(1, "Password required"),
});
const otpSchema = z.object({
  otp: z.string().length(6, "Code must be 6 digits"),
});

type CredForm = z.infer<typeof credSchema>;
type OTPForm  = z.infer<typeof otpSchema>;

export default function LoginPage() {
  const navigate = useNavigate();
  const { setTokens, setUser } = useAuthStore();

  const [step, setStep]             = useState<"credentials" | "otp">("credentials");
  const [pendingUserId, setUserId]  = useState("");
  const [userEmail, setUserEmail]   = useState("");
  const [loading, setLoading]       = useState(false);
  const [resending, setResending]   = useState(false);
  const [resendCooldown, setCooldown] = useState(0);

  const credForm = useForm<CredForm>({ resolver: zodResolver(credSchema) });
  const otpForm  = useForm<OTPForm>({ resolver: zodResolver(otpSchema) });

  // ── Step 1: credentials ────────────────────────────────────────────────────
  const onCredentials = async (values: CredForm) => {
    setLoading(true);
    try {
      const { data } = await authAPI.login(values.email, values.password);

      if (data.mfa_required) {
        setUserId(data.user_id);
        setUserEmail(values.email);
        setStep("otp");
        toast.info("A 6-digit code has been sent to your email.");
        return;
      }

      // No MFA — tokens issued directly
      await finishLogin(data);
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { detail?: string } } })
        ?.response?.data?.detail;
      toast.error(msg || "Invalid email or password");
    } finally {
      setLoading(false);
    }
  };

  // ── Step 2: OTP verify ─────────────────────────────────────────────────────
  const onOTP = async (values: OTPForm) => {
    setLoading(true);
    try {
      const { data } = await authAPI.verifyOTP(pendingUserId, values.otp);
      await finishLogin(data);
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { detail?: string } } })
        ?.response?.data?.detail;
      toast.error(msg || "Invalid or expired code");
    } finally {
      setLoading(false);
    }
  };

  // ── Shared finish ──────────────────────────────────────────────────────────
  const finishLogin = async (tokenData: {
    access: string;
    refresh: string;
    must_change_password?: boolean;
  }) => {
    setTokens(tokenData.access, tokenData.refresh);
    const { data: me } = await authAPI.me();
    setUser(me);

    if (tokenData.must_change_password) {
      navigate("/change-password", { replace: true });
    } else {
      navigate("/", { replace: true });
    }
  };

  // ── Resend OTP ─────────────────────────────────────────────────────────────
  const resendOTP = async () => {
    if (resendCooldown > 0) return;
    setResending(true);
    try {
      await authAPI.resendOTP(pendingUserId);
      toast.success("New code sent — check your email.");
      // 60-second cooldown
      setCooldown(60);
      const timer = setInterval(() => {
        setCooldown((c) => {
          if (c <= 1) { clearInterval(timer); return 0; }
          return c - 1;
        });
      }, 1000);
    } catch {
      toast.error("Could not resend code. Try again shortly.");
    } finally {
      setResending(false);
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-brand-900 to-brand-700 flex items-center justify-center p-4">
      <div className="w-full max-w-md">
        {/* Logo */}
        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center w-14 h-14 bg-white rounded-2xl shadow-lg mb-4">
            <FileText className="w-7 h-7 text-brand-600" />
          </div>
          <h1 className="text-2xl font-bold text-white">DocVault</h1>
          <p className="text-brand-200 text-sm mt-1">Secure Document Management</p>
        </div>

        <div className="card p-8">
          {/* ── Credentials step ───────────────────────────────────────────── */}
          {step === "credentials" && (
            <>
              <h2 className="text-lg font-semibold text-gray-900 mb-6">Sign in to your account</h2>
              <form onSubmit={credForm.handleSubmit(onCredentials)} className="space-y-4">
                <div>
                  <label className="label">Email address</label>
                  <input
                    {...credForm.register("email")}
                    type="email"
                    className="input"
                    placeholder="you@company.com"
                    autoComplete="email"
                    autoFocus
                  />
                  {credForm.formState.errors.email && (
                    <p className="text-red-500 text-xs mt-1">
                      {credForm.formState.errors.email.message}
                    </p>
                  )}
                </div>
                <div>
                  <label className="label">Password</label>
                  <input
                    {...credForm.register("password")}
                    type="password"
                    className="input"
                    placeholder="••••••••"
                    autoComplete="current-password"
                  />
                  {credForm.formState.errors.password && (
                    <p className="text-red-500 text-xs mt-1">
                      {credForm.formState.errors.password.message}
                    </p>
                  )}
                </div>
                <button
                  type="submit"
                  disabled={loading}
                  className="btn-primary w-full justify-center mt-2"
                >
                  {loading && <Loader2 className="w-4 h-4 animate-spin" />}
                  Sign in
                </button>
              </form>
            </>
          )}

          {/* ── OTP step ───────────────────────────────────────────────────── */}
          {step === "otp" && (
            <>
              <div className="flex items-center gap-3 mb-5">
                <div className="w-10 h-10 bg-brand-50 rounded-xl flex items-center justify-center">
                  <Mail className="w-5 h-5 text-brand-600" />
                </div>
                <div>
                  <h2 className="font-semibold text-gray-900">Check your email</h2>
                  <p className="text-sm text-gray-500">We sent a 6-digit code to</p>
                  <p className="text-sm font-medium text-gray-700">{userEmail}</p>
                </div>
              </div>

              <form onSubmit={otpForm.handleSubmit(onOTP)} className="space-y-4">
                <div>
                  <label className="label">Verification code</label>
                  <input
                    {...otpForm.register("otp")}
                    className="input text-center text-3xl tracking-[0.5em] font-mono"
                    placeholder="000000"
                    maxLength={6}
                    inputMode="numeric"
                    autoFocus
                    onChange={(e) => {
                      // Auto-submit when 6 digits entered
                      const val = e.target.value.replace(/\D/g, "").slice(0, 6);
                      otpForm.setValue("otp", val);
                      if (val.length === 6) {
                        otpForm.handleSubmit(onOTP)();
                      }
                    }}
                  />
                  {otpForm.formState.errors.otp && (
                    <p className="text-red-500 text-xs mt-1">
                      {otpForm.formState.errors.otp.message}
                    </p>
                  )}
                </div>

                <button
                  type="submit"
                  disabled={loading}
                  className="btn-primary w-full justify-center"
                >
                  {loading && <Loader2 className="w-4 h-4 animate-spin" />}
                  Verify & sign in
                </button>
              </form>

              {/* Resend + back */}
              <div className="flex items-center justify-between mt-4 pt-4 border-t border-gray-100">
                <button
                  type="button"
                  onClick={() => setStep("credentials")}
                  className="text-sm text-gray-500 hover:text-gray-700"
                >
                  ← Use a different account
                </button>
                <button
                  type="button"
                  onClick={resendOTP}
                  disabled={resending || resendCooldown > 0}
                  className="flex items-center gap-1.5 text-sm text-brand-600 hover:text-brand-700 disabled:opacity-50"
                >
                  <RefreshCw className={`w-3.5 h-3.5 ${resending ? "animate-spin" : ""}`} />
                  {resendCooldown > 0 ? `Resend in ${resendCooldown}s` : "Resend code"}
                </button>
              </div>
            </>
          )}
        </div>

        <p className="text-center text-brand-300 text-xs mt-6">
          DocVault Enterprise Document Management
        </p>
      </div>
    </div>
  );
}
