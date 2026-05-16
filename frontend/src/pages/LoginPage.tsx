// src/pages/LoginPage.tsx
"use client";

import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Loader2, Mail, RefreshCw, Lock, ArrowRight, Shield } from "lucide-react";

import { api, authAPI, documentsAPI, notificationsAPI, workflowAPI } from "@/services/api";
import { useAuthStore } from "@/store/authStore";
import { toast } from "@/components/ui/vault-toast";
import type { AuthUser } from "@/store/authStore";
import { FlaxemLogo } from "@/components/shared/FlaxemLogo";

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
    <div className="min-h-screen flex">
      {/* Left Panel - Branding */}
      <div className="hidden lg:flex lg:w-1/2 bg-gradient-to-br from-[#0066CC] via-[#0052a3] to-[#003d7a] relative overflow-hidden">
        {/* Decorative geometric shapes */}
        <div className="absolute inset-0">
          <div className="absolute top-0 left-0 w-full h-full opacity-10">
            <svg viewBox="0 0 400 400" className="w-full h-full">
              <path d="M0 100L100 50H200L100 100H0Z" fill="white"/>
              <path d="M50 150L150 100H250L150 150H50Z" fill="white"/>
              <path d="M100 200L200 150H300L200 200H100Z" fill="white"/>
              <path d="M150 250L250 200H350L250 250H150Z" fill="white"/>
              <path d="M200 300L300 250H400L300 300H200Z" fill="white"/>
            </svg>
          </div>
          <div className="absolute bottom-20 right-10 w-32 h-32 bg-[#FF2E2E]/20 rotate-12 transform"></div>
          <div className="absolute bottom-40 right-32 w-24 h-24 bg-[#FF2E2E]/15 rotate-45 transform"></div>
        </div>
        
        <div className="relative z-10 flex flex-col justify-between p-12 w-full">
          <div>
            <FlaxemLogo variant="light" className="h-14 w-auto" />
          </div>
          
          <div className="space-y-6">
            <h1 className="text-4xl font-bold text-white leading-tight text-balance">
              Document Management<br />
              <span className="text-sky-200">Made Simple</span>
            </h1>
            <p className="text-sky-100/80 text-lg max-w-md leading-relaxed">
              Secure, efficient, and intelligent document workflows for modern enterprises.
            </p>
            
            <div className="flex items-center gap-4 pt-4">
              <div className="flex items-center gap-2 text-sky-100/70 text-sm">
                <Shield className="w-4 h-4" />
                <span>Enterprise Security</span>
              </div>
              <div className="w-1 h-1 rounded-full bg-sky-300/50"></div>
              <div className="text-sky-100/70 text-sm">SOC 2 Compliant</div>
            </div>
          </div>
          
          <div className="text-sky-200/50 text-sm">
            Trusted by 500+ organizations worldwide
          </div>
        </div>
      </div>

      {/* Right Panel - Login Form */}
      <div className="flex-1 flex items-center justify-center bg-white p-6 lg:p-12 relative overflow-hidden">
        {/* Subtle brand pattern */}
        <div className="absolute inset-0 opacity-[0.02]">
          <svg className="w-full h-full" viewBox="0 0 100 100" preserveAspectRatio="none">
            <pattern id="grid" width="20" height="20" patternUnits="userSpaceOnUse">
              <path d="M0 10L10 5H20L10 10H0Z" fill="#0066CC"/>
            </pattern>
            <rect width="100%" height="100%" fill="url(#grid)" />
          </svg>
        </div>

        <div className="w-full max-w-md relative z-10">
          {/* Mobile Logo */}
          <div className="flex justify-center mb-8 lg:hidden">
            <FlaxemLogo variant="dark" className="h-12 w-auto" />
          </div>

          {step === "credentials" ? (
            <div className="space-y-8">
              <div className="relative">
                <div className="absolute -left-4 top-0 w-1 h-12 bg-gradient-to-b from-[#0066CC] to-[#FF2E2E] rounded-full"></div>
                <h2 className="text-3xl font-bold text-slate-900 mb-2">Sign in</h2>
                <p className="text-slate-500">Access your document workspace</p>
              </div>

              <form onSubmit={credForm.handleSubmit(onCredentials)} className="space-y-6">
                <div className="space-y-1">
                  <label className="block text-xs font-semibold uppercase tracking-wider text-slate-400 mb-2">
                    Email
                  </label>
                  <div className="relative group">
                    <input
                      {...credForm.register("email")}
                      type="email"
                      className="w-full px-0 py-3 bg-transparent border-0 border-b-2 border-slate-200 text-slate-900 text-lg placeholder:text-slate-300 focus:ring-0 focus:border-[#0066CC] transition-colors outline-none peer"
                      placeholder="you@company.com"
                      autoComplete="email"
                      autoFocus
                    />
                    <Mail className="absolute right-0 top-1/2 -translate-y-1/2 w-5 h-5 text-slate-300 peer-focus:text-[#0066CC] transition-colors" />
                  </div>
                  {credForm.formState.errors.email && (
                    <p className="text-[#FF2E2E] text-sm mt-2 flex items-center gap-1">
                      <span className="w-1 h-1 rounded-full bg-[#FF2E2E]"></span>
                      {credForm.formState.errors.email.message}
                    </p>
                  )}
                </div>

                <div className="space-y-1">
                  <div className="flex items-center justify-between mb-2">
                    <label className="block text-xs font-semibold uppercase tracking-wider text-slate-400">
                      Password
                    </label>
                    <button type="button" className="text-xs text-[#0066CC] hover:text-[#0052a3] font-medium transition-colors">
                      Forgot?
                    </button>
                  </div>
                  <div className="relative group">
                    <input
                      {...credForm.register("password")}
                      type="password"
                      className="w-full px-0 py-3 bg-transparent border-0 border-b-2 border-slate-200 text-slate-900 text-lg placeholder:text-slate-300 focus:ring-0 focus:border-[#0066CC] transition-colors outline-none peer"
                      placeholder="Enter your password"
                      autoComplete="current-password"
                    />
                    <Lock className="absolute right-0 top-1/2 -translate-y-1/2 w-5 h-5 text-slate-300 peer-focus:text-[#0066CC] transition-colors" />
                  </div>
                  {credForm.formState.errors.password && (
                    <p className="text-[#FF2E2E] text-sm mt-2 flex items-center gap-1">
                      <span className="w-1 h-1 rounded-full bg-[#FF2E2E]"></span>
                      {credForm.formState.errors.password.message}
                    </p>
                  )}
                </div>

                <button
                  type="submit"
                  disabled={loading}
                  className="group relative w-full py-4 px-6 bg-slate-900 hover:bg-slate-800 text-white font-semibold rounded-none transition-all disabled:opacity-70 disabled:cursor-not-allowed mt-8 overflow-hidden"
                >
                  <span className="absolute inset-y-0 left-0 w-1 bg-[#0066CC] group-hover:w-2 transition-all"></span>
                  <span className="relative flex items-center justify-center gap-3">
                    {loading ? (
                      <Loader2 className="w-5 h-5 animate-spin" />
                    ) : (
                      <>
                        Continue
                        <ArrowRight className="w-5 h-5 group-hover:translate-x-1 transition-transform" />
                      </>
                    )}
                  </span>
                </button>
              </form>

              <div className="flex items-center justify-center gap-6 pt-4">
                <div className="flex items-center gap-2 text-slate-400 text-xs">
                  <Shield className="w-4 h-4" />
                  <span>256-bit encryption</span>
                </div>
                <div className="w-px h-4 bg-slate-200"></div>
                <div className="text-slate-400 text-xs">SOC 2 Type II</div>
              </div>
            </div>
          ) : (
            <div className="space-y-8">
              <div className="relative">
                <div className="absolute -left-4 top-0 w-1 h-12 bg-gradient-to-b from-[#FF2E2E] to-[#0066CC] rounded-full"></div>
                <div className="flex items-center gap-3 mb-4">
                  <div className="w-10 h-10 bg-[#0066CC] flex items-center justify-center">
                    <Mail className="w-5 h-5 text-white" />
                  </div>
                  <span className="text-xs font-semibold uppercase tracking-wider text-[#0066CC]">Verification Required</span>
                </div>
                <h2 className="text-2xl font-bold text-slate-900 mb-2">Check your inbox</h2>
                <p className="text-slate-500">
                  We've sent a 6-digit code to{" "}
                  <span className="font-semibold text-slate-900">{userEmail}</span>
                </p>
              </div>

              <form onSubmit={otpForm.handleSubmit(onOTP)} className="space-y-6">
                <div>
                  <label className="block text-xs font-semibold uppercase tracking-wider text-slate-400 mb-4">
                    Enter Code
                  </label>
                  <input
                    {...otpForm.register("otp")}
                    className="w-full text-center text-4xl tracking-[0.5em] font-mono py-6 bg-slate-50 border-2 border-slate-200 text-slate-900 focus:border-[#0066CC] focus:bg-white outline-none transition-all"
                    placeholder="------"
                    maxLength={6}
                    autoFocus
                    onChange={(e) => {
                      const val = e.target.value.replace(/\D/g, "").slice(0, 6);
                      otpForm.setValue("otp", val);
                      if (val.length === 6) otpForm.handleSubmit(onOTP)();
                    }}
                  />
                  {otpForm.formState.errors.otp && (
                    <p className="text-[#FF2E2E] text-sm mt-2 flex items-center gap-1">
                      <span className="w-1 h-1 rounded-full bg-[#FF2E2E]"></span>
                      {otpForm.formState.errors.otp.message}
                    </p>
                  )}
                </div>

                <button
                  type="submit"
                  disabled={loading}
                  className="group relative w-full py-4 px-6 bg-slate-900 hover:bg-slate-800 text-white font-semibold rounded-none transition-all disabled:opacity-70 disabled:cursor-not-allowed overflow-hidden"
                >
                  <span className="absolute inset-y-0 left-0 w-1 bg-[#FF2E2E] group-hover:w-2 transition-all"></span>
                  <span className="relative flex items-center justify-center gap-3">
                    {loading ? (
                      <Loader2 className="w-5 h-5 animate-spin" />
                    ) : (
                      <>
                        Verify & Continue
                        <ArrowRight className="w-5 h-5 group-hover:translate-x-1 transition-transform" />
                      </>
                    )}
                  </span>
                </button>
              </form>

              <div className="flex items-center justify-between pt-4 border-t border-slate-100">
                <button
                  onClick={() => setStep("credentials")}
                  className="text-sm text-slate-500 hover:text-slate-900 transition-colors font-medium flex items-center gap-2"
                >
                  <ArrowRight className="w-4 h-4 rotate-180" />
                  Back
                </button>
                <button
                  onClick={resendOTP}
                  disabled={resending || resendCooldown > 0}
                  className="flex items-center gap-2 text-sm font-medium text-[#0066CC] hover:text-[#0052a3] disabled:text-slate-400 disabled:cursor-not-allowed transition-colors"
                >
                  <RefreshCw className={`w-4 h-4 ${resending ? "animate-spin" : ""}`} />
                  {resendCooldown > 0 ? `${resendCooldown}s` : "Resend"}
                </button>
              </div>
            </div>
          )}

          <p className="text-center text-slate-300 text-xs mt-12 tracking-wide">
            FLAXEM SYSTEMS © {new Date().getFullYear()}
          </p>
        </div>
      </div>
    </div>
  );
}