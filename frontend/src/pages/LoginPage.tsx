// src/pages/LoginPage.tsx
"use client";

import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import {
  Loader2,
  Mail,
  RefreshCw,
  Lock,
  ArrowRight,
  Shield,
  Sparkles,
  CheckCircle2,
  ScanSearch,
  Workflow,
} from "lucide-react";

import {
  api,
  authAPI,
  documentsAPI,
  notificationsAPI,
  workflowAPI,
  profileAPI,
} from "@/services/api";

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

  const [step, setStep] = useState<"credentials" | "otp">(
    "credentials"
  );

  const [pendingUserId, setPendingUserId] = useState("");
  const [userEmail, setUserEmail] = useState("");
  const [loading, setLoading] = useState(false);
  const [resending, setResending] = useState(false);
  const [resendCooldown, setResendCooldown] = useState(0);

  const credForm = useForm<CredForm>({
    resolver: zodResolver(credSchema),
  });

  const otpForm = useForm<OTPForm>({
    resolver: zodResolver(otpSchema),
  });

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

    await Promise.allSettled([
      qc.prefetchQuery({
        queryKey: ["documents", "recent"],
        queryFn: () =>
          documentsAPI
            .list({ page_size: 5, ordering: "-created_at" })
            .then((r) => r.data),
      }),
      qc.prefetchQuery({
        queryKey: ["documents", "pending", "count"],
        queryFn: () =>
          documentsAPI
            .list({ status: "pending_approval", page_size: 1 })
            .then((r) => r.data.count ?? 0),
      }),
      qc.prefetchQuery({
        queryKey: ["workflow", "my-tasks"],
        queryFn: () => workflowAPI.myTasks().then((r) => r.data.results ?? r.data),
      }),
      qc.prefetchQuery({
        queryKey: ["audit", "recent"],
        queryFn: () =>
          api
            .get("/audit/", {
              params: {
                ordering: "-timestamp",
                page_size: 5,
              },
            })
            .then((r) => r.data.results ?? r.data),
      }),
      qc.prefetchQuery({
        queryKey: ["notifications"],
        queryFn: () =>
          notificationsAPI.list().then((r) => r.data.results ?? r.data),
      }),
    ]);

    if (tokenData.must_change_password) {
      navigate("/change-password", { replace: true });
      return;
    }

    // Determine landing page based on user preferences (only at login)
    try {
      const { data: prefs } = await profileAPI.getPreferences();
      const defaultPage = prefs?.default_page || "dashboard";
      const pageRoutes: Record<string, string> = {
        dashboard: "/",
        my_tasks: "/workflow",
        all_documents: "/documents",
      };
      const target = pageRoutes[defaultPage] ?? "/";
      navigate(target, { replace: true });
    } catch (err) {
      // fallback to dashboard on error
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

        toast.info(
          "A 6-digit verification code has been sent to your email."
        );
      } else {
        await completeLogin(data);
      }
    } catch (err: any) {
      toast.error(
        err?.response?.data?.detail || "Invalid email or password."
      );
    } finally {
      setLoading(false);
    }
  };

  const onOTP = async (values: OTPForm) => {
    setLoading(true);

    try {
      const { data } = await authAPI.verifyOTP(
        pendingUserId,
        values.otp
      );

      await completeLogin(data);
    } catch (err: any) {
      toast.error(
        err?.response?.data?.detail ||
          "Invalid or expired verification code."
      );
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
    <div className="relative min-h-screen overflow-hidden bg-[#071B34] text-white">
      {/* Background Geometry */}
      <div className="absolute inset-0 overflow-hidden">
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_top_left,#1E88E5_0%,transparent_35%)] opacity-50" />
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_bottom_right,#29B6F6_0%,transparent_30%)] opacity-30" />

        <div className="absolute -top-20 -left-32 h-[500px] w-[500px] rounded-full bg-[#005BBB]/40 blur-3xl" />
        <div className="absolute bottom-0 right-0 h-[400px] w-[400px] rounded-full bg-cyan-400/20 blur-3xl" />

        <svg
          className="absolute inset-0 h-full w-full opacity-[0.12]"
          viewBox="0 0 100 100"
          preserveAspectRatio="none"
        >
          <path
            d="M0 55 L100 0"
            stroke="white"
            strokeWidth="0.2"
            fill="none"
          />
          <path
            d="M0 85 L100 30"
            stroke="white"
            strokeWidth="0.2"
            fill="none"
          />
          <path
            d="M30 100 L100 20"
            stroke="white"
            strokeWidth="0.2"
            fill="none"
          />
        </svg>
      </div>

      <div className="relative z-10 flex min-h-screen items-center justify-center p-6">
        <div className="w-full max-w-lg rounded-3xl border border-white/20 bg-white/10 p-8 shadow-2xl backdrop-blur-2xl lg:p-12">
          <div className="mb-10 flex flex-col items-center text-center">
            <FlaxemLogo variant="light" className="h-14 w-auto" />

            <p className="mt-5 text-xs uppercase tracking-[0.3em] text-cyan-100/70">
              Enterprise Document Platform
            </p>
          </div>

          {step === "credentials" ? (
            <>
              <div className="text-center">
                <h2 className="text-4xl font-semibold tracking-tight text-white">
                  Sign In
                </h2>

                <p className="mt-4 text-slate-200">
                  Access your secure Flaxem workspace.
                </p>
              </div>

              <form
                onSubmit={credForm.handleSubmit(onCredentials)}
                className="mt-10 space-y-6"
              >
                <div>
                  <div className="flex h-14 items-center rounded-2xl border border-white/15 bg-white/10 px-4 transition-all focus-within:border-cyan-300 focus-within:bg-white/15">
                    <Mail className="h-5 w-5 text-cyan-200/80" />

                    <input
                      {...credForm.register("email")}
                      type="email"
                      autoComplete="email"
                      autoFocus
                      placeholder="someone@example.com"
                      className="h-full w-full bg-transparent px-4 text-white placeholder:text-slate-300 focus:outline-none"
                    />
                  </div>
                </div>

                <div>
                  <div className="mb-3 flex items-center justify-end">
                    <button
                      type="button"
                      className="text-xs text-cyan-100 hover:text-white"
                    >
                      Forgot Password?
                    </button>
                  </div>

                  <div className="flex h-14 items-center rounded-2xl border border-white/15 bg-white/10 px-4 transition-all focus-within:border-cyan-300 focus-within:bg-white/15">
                    <Lock className="h-5 w-5 text-cyan-200/80" />

                    <input
                      {...credForm.register("password")}
                      type="password"
                      autoComplete="current-password"
                      placeholder="Password"
                      className="h-full w-full bg-transparent px-4 text-white placeholder:text-slate-300 focus:outline-none"
                    />
                  </div>
                </div>

                <button
                  type="submit"
                  disabled={loading}
                  className="group flex h-14 w-full items-center justify-center gap-3 rounded-2xl bg-[#005A9E] font-semibold text-white transition-all hover:bg-[#0A68B4] disabled:opacity-70"
                >
                  {loading ? (
                    <Loader2 className="h-5 w-5 animate-spin" />
                  ) : (
                    <>
                      Sign In
                      <ArrowRight className="h-5 w-5 transition-transform group-hover:translate-x-1" />
                    </>
                  )}
                </button>
              </form>

              <div className="mt-8 flex items-center justify-center gap-2 rounded-2xl border border-white/10 bg-black/10 px-5 py-4 text-sm text-slate-200">
                <Shield className="h-4 w-4 text-cyan-300" />
                <span>Multi-factor authentication enabled</span>
              </div>
            </>
          ) : (
            <>
              <div className="text-center">
                <h2 className="text-4xl font-semibold tracking-tight text-white">
                  Verification
                </h2>

                <p className="mt-4 leading-relaxed text-slate-200">
                  Enter the verification code sent to
                  <span className="ml-1 font-semibold text-white">
                    {userEmail}
                  </span>
                </p>
              </div>

              <form
                onSubmit={otpForm.handleSubmit(onOTP)}
                className="mt-10 space-y-6"
              >
                <input
                  {...otpForm.register("otp")}
                  maxLength={6}
                  autoFocus
                  placeholder="------"
                  onChange={(e) => {
                    const val = e.target.value
                      .replace(/\D/g, "")
                      .slice(0, 6);

                    otpForm.setValue("otp", val);

                    if (val.length === 6) {
                      otpForm.handleSubmit(onOTP)();
                    }
                  }}
                  className="h-20 w-full rounded-3xl border border-white/15 bg-white/10 text-center font-mono text-5xl tracking-[0.5em] text-white placeholder:text-slate-400 focus:border-cyan-300 focus:outline-none"
                />

                <button
                  type="submit"
                  disabled={loading}
                  className="group flex h-14 w-full items-center justify-center gap-3 rounded-2xl bg-[#005A9E] font-semibold text-white transition-all hover:bg-[#0A68B4] disabled:opacity-70"
                >
                  {loading ? (
                    <Loader2 className="h-5 w-5 animate-spin" />
                  ) : (
                    <>
                      Verify
                      <ArrowRight className="h-5 w-5 transition-transform group-hover:translate-x-1" />
                    </>
                  )}
                </button>
              </form>

              <div className="mt-8 flex items-center justify-between border-t border-white/10 pt-6">
                <button
                  onClick={() => setStep("credentials")}
                  className="text-sm text-slate-200 hover:text-white"
                >
                  Back
                </button>

                <button
                  onClick={resendOTP}
                  disabled={resending || resendCooldown > 0}
                  className="flex items-center gap-2 text-sm text-cyan-100 hover:text-white disabled:text-slate-500"
                >
                  <RefreshCw
                    className={`h-4 w-4 $${
                      resending ? "animate-spin" : ""
                    }`}
                  />

                  {resendCooldown > 0
                    ? `$${resendCooldown}s`
                    : "Resend Code"}
                </button>
              </div>
            </>
          )}

          <div className="mt-10 border-t border-white/10 pt-6 text-center text-xs text-slate-300">
            FLAXEM SYSTEMS © {new Date().getFullYear()}
          </div>
        </div>
      </div>
    </div>
  );
}
