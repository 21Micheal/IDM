import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { FileText, Loader2 } from "lucide-react";
import { authAPI } from "@/services/api";
import { useAuthStore } from "@/store/authStore";
import { toast } from "react-toastify";

const loginSchema = z.object({
  email: z.string().email("Invalid email"),
  password: z.string().min(1, "Password required"),
});
const otpSchema = z.object({
  otp: z.string().length(6, "OTP must be 6 digits"),
});

type LoginForm = z.infer<typeof loginSchema>;
type OTPForm = z.infer<typeof otpSchema>;

export default function LoginPage() {
  const navigate = useNavigate();
  const { setTokens, setUser } = useAuthStore();
  const [step, setStep] = useState<"credentials" | "otp">("credentials");
  const [pendingUserId, setPendingUserId] = useState("");
  const [loading, setLoading] = useState(false);

  const loginForm = useForm<LoginForm>({ resolver: zodResolver(loginSchema) });
  const otpForm = useForm<OTPForm>({ resolver: zodResolver(otpSchema) });

  const onLogin = async (values: LoginForm) => {
    setLoading(true);
    try {
      const { data } = await authAPI.login(values.email, values.password);
      if (data.mfa_required) {
        setPendingUserId(data.user_id);
        setStep("otp");
      } else {
        setTokens(data.access, data.refresh);
        const { data: me } = await authAPI.me();
        setUser(me);
        navigate("/");
      }
    } catch {
      toast.error("Invalid email or password");
    } finally {
      setLoading(false);
    }
  };

  const onOTP = async (values: OTPForm) => {
    setLoading(true);
    try {
      const { data } = await authAPI.verifyOTP(pendingUserId, values.otp);
      setTokens(data.access, data.refresh);
      const { data: me } = await authAPI.me();
      setUser(me);
      navigate("/");
    } catch {
      toast.error("Invalid OTP code");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-brand-900 to-brand-700 flex items-center justify-center p-4">
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center w-14 h-14 bg-white rounded-2xl shadow-lg mb-4">
            <FileText className="w-7 h-7 text-brand-600" />
          </div>
          <h1 className="text-2xl font-bold text-white">DocVault DMS</h1>
          <p className="text-brand-200 text-sm mt-1">Secure Document Management</p>
        </div>

        <div className="card p-8">
          {step === "credentials" ? (
            <>
              <h2 className="text-lg font-semibold text-gray-900 mb-6">Sign in to your account</h2>
              <form onSubmit={loginForm.handleSubmit(onLogin)} className="space-y-4">
                <div>
                  <label className="label">Email address</label>
                  <input
                    {...loginForm.register("email")}
                    type="email"
                    className="input"
                    placeholder="you@company.com"
                    autoComplete="email"
                  />
                  {loginForm.formState.errors.email && (
                    <p className="text-red-500 text-xs mt-1">
                      {loginForm.formState.errors.email.message}
                    </p>
                  )}
                </div>
                <div>
                  <label className="label">Password</label>
                  <input
                    {...loginForm.register("password")}
                    type="password"
                    className="input"
                    placeholder="••••••••"
                    autoComplete="current-password"
                  />
                  {loginForm.formState.errors.password && (
                    <p className="text-red-500 text-xs mt-1">
                      {loginForm.formState.errors.password.message}
                    </p>
                  )}
                </div>
                <button type="submit" disabled={loading} className="btn-primary w-full justify-center mt-2">
                  {loading && <Loader2 className="w-4 h-4 animate-spin" />}
                  Sign in
                </button>
              </form>
            </>
          ) : (
            <>
              <h2 className="text-lg font-semibold text-gray-900 mb-2">Two-factor verification</h2>
              <p className="text-sm text-gray-500 mb-6">
                Enter the 6-digit code from your authenticator app.
              </p>
              <form onSubmit={otpForm.handleSubmit(onOTP)} className="space-y-4">
                <div>
                  <label className="label">OTP Code</label>
                  <input
                    {...otpForm.register("otp")}
                    className="input text-center text-2xl tracking-widest"
                    placeholder="000000"
                    maxLength={6}
                    autoFocus
                  />
                  {otpForm.formState.errors.otp && (
                    <p className="text-red-500 text-xs mt-1">
                      {otpForm.formState.errors.otp.message}
                    </p>
                  )}
                </div>
                <button type="submit" disabled={loading} className="btn-primary w-full justify-center">
                  {loading && <Loader2 className="w-4 h-4 animate-spin" />}
                  Verify
                </button>
                <button
                  type="button"
                  onClick={() => setStep("credentials")}
                  className="text-sm text-brand-600 hover:underline w-full text-center"
                >
                  Back to login
                </button>
              </form>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
