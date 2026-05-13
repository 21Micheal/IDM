// src/pages/LoginPage.tsx
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Loader2, Mail, RefreshCw, Lock, ArrowRight, ShieldCheck } from "lucide-react";

import { api, authAPI, documentsAPI, notificationsAPI, workflowAPI } from "@/services/api";
import { useAuthStore } from "@/store/authStore";
import { toast } from "@/components/ui/vault-toast";
import type { AuthUser } from "@/store/authStore";

const credSchema = z.object({
  email: z.string().email("Please enter a valid email address."),
  password: z.string().min(1, "Password is required."),
});

const otpSchema = z.object({
  otp: z.string().length(6, "Verification code must be 6 digits."),
});

type CredForm = z.infer<typeof credSchema>;
type OTPForm = z.infer<typeof otpSchema>;

export default function LoginPage() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { setTokens, setUser } = useAuthStore();

  const [step, setStep] = useState<"credentials" | "otp">("credentials");
  const [pendingUserId, setPendingUserId] = useState("");
  const [userEmail, setUserEmail] = useState("");
  const [loading, setLoading] = useState(false);
  const [resending, setResending] = useState(false);
  const [resendCooldown, setResendCooldown] = useState(0);

  const credForm = useForm<CredForm>({ resolver: zodResolver(credSchema) });
  const otpForm = useForm<OTPForm>({ resolver: zodResolver(otpSchema) });

  const completeLogin = async (tokenData: {
    access: string;
    refresh: string;
    must_change_password?: boolean;
    user?: AuthUser;
  }) => {
    setTokens(tokenData.access, tokenData.refresh);

    if (tokenData.user) {
      setUser(tokenData.user);
    } else {
      try {
        const { data: me } = await authAPI.me(tokenData.access);
        setUser(me);
      } catch {
        toast.warn("Signed in, but your profile could not be loaded yet.");
      }
    }

    // Warm caches
    await new Promise((resolve) => setTimeout(resolve, 100));

    await Promise.allSettled([
      qc.prefetchQuery({
        queryKey: ["documents", "recent"],
        queryFn: () => documentsAPI.list({ page_size: 5, ordering: "-created_at" }).then((r) => r.data),
      }),
      qc.prefetchQuery({
        queryKey: ["documents", "pending", "count"],
        queryFn: () => documentsAPI.list({ status: "pending_approval", page_size: 1 }).then((r) => r.data.count ?? 0),
      }),
      qc.prefetchQuery({
        queryKey: ["workflow", "my-tasks"],
        queryFn: () => workflowAPI.myTasks().then((r) => r.data.results ?? r.data),
      }),
      qc.prefetchQuery({
        queryKey: ["audit", "recent"],
        queryFn: () => api.get("/audit/", { params: { ordering: "-timestamp", page_size: 5 } }).then((r) => r.data.results ?? r.data),
      }),
      qc.prefetchQuery({
        queryKey: ["notifications"],
        queryFn: () => notificationsAPI.list().then((r) => r.data.results ?? r.data),
      }),
    ]);

    if (tokenData.must_change_password) {
      navigate("/change-password", { replace: true });
    } else {
      navigate("/", { replace: true });
    }
  };

  const onCredentials = async (values: CredForm) => {
    setLoading(true);
    try {
      const { data } = await authAPI.login(values.email, values.password);

      if (data.mfa_required) {
        setPendingUserId(data.user_id);
        setUserEmail(values.email);
        setStep("otp");
        toast.info("A 6-digit verification code has been sent to your email.");
      } else {
        await completeLogin(data);
      }
    } catch (err: any) {
      toast.error(err?.response?.data?.detail || "Invalid email or password.");
    } finally {
      setLoading(false);
    }
  };

  const onOTP = async (values: OTPForm) => {
    setLoading(true);
    try {
      const { data } = await authAPI.verifyOTP(pendingUserId, values.otp);
      await completeLogin(data);
    } catch (err: any) {
      toast.error(err?.response?.data?.detail || "Invalid or expired verification code.");
    } finally {
      setLoading(false);
    }
  };

  const resendOTP = async () => {
    if (resendCooldown > 0) return;
    setResending(true);
    try {
      await authAPI.resendOTP(pendingUserId);
      toast.success("A new verification code has been sent.");
      setResendCooldown(60);
      const timer = setInterval(() => {
        setResendCooldown((prev) => {
          if (prev <= 1) {
            clearInterval(timer);
            return 0;
          }
          return prev - 1;
        });
      }, 1000);
    } catch {
      toast.error("Unable to resend code. Please try again shortly.");
    } finally {
      setResending(false);
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-sky-50 via-sky-100 to-blue-200 flex items-center justify-center p-4">
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <div className="flex justify-center items-center gap-2">
            <div className="w-10 h-10 rounded-xl bg-sky-600 text-white flex items-center justify-center shadow-lg shadow-sky-500/30">
              <ShieldCheck className="w-6 h-6" />
            </div>
            <span className="text-2xl font-semibold text-slate-900 tracking-tight">Flaxem</span>
          </div>
          <p className="text-slate-600 text-sm mt-3">Secure Document Management System</p>
        </div>

        <div className="bg-white/90 backdrop-blur rounded-2xl shadow-xl shadow-sky-900/5 border border-white p-10">
          {step === "credentials" ? (
            <>
              <h2 className="text-2xl font-semibold text-slate-900 mb-1">Welcome back</h2>
              <p className="text-sm text-slate-500 mb-8">Sign in to your account to continue</p>

              <form onSubmit={credForm.handleSubmit(onCredentials)} className="space-y-6">
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-2">Email address</label>
                  <div className="relative">
                    <Mail className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
                    <input
                      {...credForm.register("email")}
                      type="email"
                      className="w-full pl-10 pr-3 py-3.5 bg-slate-50 border border-slate-200 rounded-xl focus:ring-2 focus:ring-sky-500 focus:border-sky-500 focus:bg-white transition-all outline-none"
                      placeholder="you@company.com"
                      autoComplete="email"
                      autoFocus
                    />
                  </div>
                  {credForm.formState.errors.email && (
                    <p className="text-red-500 text-xs mt-1.5">{credForm.formState.errors.email.message}</p>
                  )}
                </div>

                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-2">Password</label>
                  <div className="relative">
                    <Lock className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
                    <input
                      {...credForm.register("password")}
                      type="password"
                      className="w-full pl-10 pr-3 py-3.5 bg-slate-50 border border-slate-200 rounded-xl focus:ring-2 focus:ring-sky-500 focus:border-sky-500 focus:bg-white transition-all outline-none"
                      placeholder="••••••••"
                      autoComplete="current-password"
                    />
                  </div>
                  {credForm.formState.errors.password && (
                    <p className="text-red-500 text-xs mt-1.5">{credForm.formState.errors.password.message}</p>
                  )}
                </div>

                <button
                  type="submit"
                  disabled={loading}
                  className="w-full flex items-center justify-center gap-2 py-3.5 px-4 bg-sky-600 hover:bg-sky-700 text-white font-medium rounded-xl shadow-lg shadow-sky-500/30 transition-all disabled:opacity-70"
                >
                  {loading && <Loader2 className="w-4 h-4 animate-spin" />}
                  Sign in <ArrowRight className="w-4 h-4" />
                </button>
              </form>
            </>
          ) : (
            <>
              <div className="flex items-center gap-4 mb-8">
                <div className="w-12 h-12 bg-sky-100 rounded-xl flex items-center justify-center">
                  <Mail className="w-6 h-6 text-sky-600" />
                </div>
                <div>
                  <h2 className="font-semibold text-slate-900">Two-Factor Authentication</h2>
                  <p className="text-sm text-slate-500">
                    We sent a code to <span className="font-medium text-slate-700">{userEmail}</span>
                  </p>
                </div>
              </div>

              <form onSubmit={otpForm.handleSubmit(onOTP)} className="space-y-6">
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-2">Verification Code</label>
                  <input
                    {...otpForm.register("otp")}
                    className="w-full text-center text-2xl tracking-[0.5em] font-mono py-4 bg-slate-50 border border-slate-200 rounded-xl focus:ring-2 focus:ring-sky-500 focus:border-sky-500 focus:bg-white outline-none"
                    placeholder="000000"
                    maxLength={6}
                    autoFocus
                    onChange={(e) => {
                      const val = e.target.value.replace(/\D/g, "").slice(0, 6);
                      otpForm.setValue("otp", val);
                      if (val.length === 6) otpForm.handleSubmit(onOTP)();
                    }}
                  />
                  {otpForm.formState.errors.otp && (
                    <p className="text-red-500 text-xs mt-1.5">{otpForm.formState.errors.otp.message}</p>
                  )}
                </div>

                <button
                  type="submit"
                  disabled={loading}
                  className="w-full flex items-center justify-center gap-2 py-3.5 px-4 bg-sky-600 hover:bg-sky-700 text-white font-medium rounded-xl shadow-lg shadow-sky-500/30 transition-all disabled:opacity-70"
                >
                  {loading && <Loader2 className="w-4 h-4 animate-spin" />}
                  Verify & Sign In
                </button>
              </form>

              <div className="flex items-center justify-between mt-6 pt-5 border-t border-slate-100">
                <button
                  onClick={() => setStep("credentials")}
                  className="text-sm text-slate-500 hover:text-slate-700 transition-colors"
                >
                  ← Use a different account
                </button>
                <button
                  onClick={resendOTP}
                  disabled={resending || resendCooldown > 0}
                  className="flex items-center gap-1.5 text-sm font-medium text-sky-600 hover:text-sky-700 disabled:opacity-50"
                >
                  <RefreshCw className={`w-3.5 h-3.5 ${resending ? "animate-spin" : ""}`} />
                  {resendCooldown > 0 ? `Resend in ${resendCooldown}s` : "Resend Code"}
                </button>
              </div>
            </>
          )}
        </div>

        <p className="text-center text-slate-500 text-xs mt-6">
          © {new Date().getFullYear()} Flaxem Systems. All rights reserved.
        </p>
      </div>
    </div>
  );
}