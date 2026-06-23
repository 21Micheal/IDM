// src/pages/LoginPage.tsx
"use client";

import { useState } from "react";
import { extractApiError } from "@/lib/apiError";
import { useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Loader2, RefreshCw } from "lucide-react";

import {
  api,
  authAPI,
  documentsAPI,
  notificationsAPI,
  workflowAPI,
} from "@/services/api";

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

    await Promise.allSettled([
      qc.prefetchQuery({
        queryKey: ["documents", "recent"],
        queryFn: () =>
          documentsAPI.list({ page_size: 5, ordering: "-created_at" }).then((r) => r.data),
      }),
      qc.prefetchQuery({
        queryKey: ["documents", "pending", "count"],
        queryFn: () =>
          documentsAPI.list({ status: "pending_approval", page_size: 1 }).then((r) => r.data.count ?? 0),
      }),
      qc.prefetchQuery({
        queryKey: ["workflow", "my-tasks"],
        queryFn: () => workflowAPI.myTasks().then((r) => r.data.results ?? r.data),
      }),
      qc.prefetchQuery({
        queryKey: ["audit", "recent"],
        queryFn: () =>
          api
            .get("/audit/", { params: { ordering: "-timestamp", page_size: 5 } })
            .then((r) => r.data.results ?? r.data),
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
      toast.error(extractApiError(err, "Invalid email or password."));
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
      toast.error(extractApiError(err, "Invalid or expired verification code."));
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
    <div
      className="relative min-h-screen overflow-hidden"
      style={{
        background:
          "linear-gradient(135deg, #1175c6 0%, #2389d4 45%, #3aa3e6 100%)",
      }}
    >
      {/* Background geometry — thin diagonal lines + soft circles */}
      <div className="pointer-events-none absolute inset-0 overflow-hidden">
        <svg
          className="absolute inset-0 h-full w-full"
          viewBox="0 0 1920 1080"
          preserveAspectRatio="none"
        >
          <g stroke="#ffffff" strokeOpacity="0.28" strokeWidth="1" fill="none">
            <path d="M-50 720 L1400 -50" />
            <path d="M-50 820 L1500 60" />
            <path d="M-50 980 L1700 120" />
            <path d="M200 1100 L1920 280" />
            <path d="M600 1100 L1920 520" />
          </g>
          <g stroke="#bfe3ff" strokeOpacity="0.35" strokeWidth="1" fill="none">
            <path d="M-50 760 L1450 -20" />
            <path d="M-50 900 L1600 80" />
          </g>
        </svg>

        {/* Bottom-left concentric circles */}
        <svg
          className="absolute -bottom-32 -left-32 h-[520px] w-[520px] opacity-40"
          viewBox="0 0 400 400"
          fill="none"
        >
          <circle cx="200" cy="200" r="180" stroke="#bfe3ff" strokeWidth="1" />
          <circle cx="200" cy="200" r="140" stroke="#bfe3ff" strokeWidth="1" />
          <circle cx="200" cy="200" r="100" stroke="#bfe3ff" strokeWidth="1" />
          <circle cx="200" cy="200" r="60" stroke="#bfe3ff" strokeWidth="1" />
        </svg>
        <svg
          className="absolute bottom-10 left-64 h-[260px] w-[260px] opacity-30"
          viewBox="0 0 400 400"
          fill="none"
        >
          <circle cx="200" cy="200" r="180" stroke="#ffffff" strokeWidth="1" />
          <circle cx="200" cy="200" r="120" stroke="#ffffff" strokeWidth="1" />
          <circle cx="200" cy="200" r="60" stroke="#ffffff" strokeWidth="1" />
        </svg>
      </div>

      <div className="relative z-10 flex min-h-screen items-center justify-center p-6">
        <div className="w-full max-w-[440px] bg-white shadow-[0_2px_6px_rgba(0,0,0,0.2)]">
          <div className="px-10 pt-10 pb-8">
            {/* Brand */}
            <h1 className="text-[26px] font-normal tracking-wide text-[#1a1a1a]">
              FLAXEM
            </h1>

            {step === "credentials" ? (
              <>
                <h2 className="mt-10 text-[15px] font-semibold text-[#1a1a1a]">
                  Sign in
                </h2>

                <form
                  onSubmit={credForm.handleSubmit(onCredentials)}
                  className="mt-5 space-y-3"
                >
                  <input
                    {...credForm.register("email")}
                    type="email"
                    autoComplete="email"
                    autoFocus
                    placeholder="someone@example.com"
                    className="block h-9 w-full border border-[#1175c6] bg-white px-2 text-[14px] text-[#1a1a1a] placeholder:text-[#666] focus:border-[#0a5ea3] focus:outline-none"
                  />

                  <input
                    {...credForm.register("password")}
                    type="password"
                    autoComplete="current-password"
                    placeholder="Password"
                    className="block h-9 w-full border border-[#bcbcbc] bg-white px-2 text-[14px] text-[#1a1a1a] placeholder:text-[#666] focus:border-[#1175c6] focus:outline-none"
                  />

                  <div className="pt-3">
                    <button
                      type="submit"
                      disabled={loading}
                      className="inline-flex h-9 min-w-[110px] items-center justify-center bg-[#1175c6] px-6 text-[14px] font-normal text-white transition-colors hover:bg-[#0a5ea3] disabled:opacity-70"
                    >
                      {loading ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        "Sign in"
                      )}
                    </button>
                  </div>

                  {/* <div className="pt-2">
                    <button
                      type="button"
                      className="text-[13px] text-[#1175c6] hover:underline"
                    >
                      Forgot password?
                    </button>
                  </div> */}
                </form>
              </>
            ) : (
              <>
                <h2 className="mt-10 text-[15px] font-semibold text-[#1a1a1a]">
                  Verification
                </h2>

                <p className="mt-3 text-[13px] leading-relaxed text-[#444]">
                  Enter the verification code sent to{" "}
                  <span className="font-semibold text-[#1a1a1a]">{userEmail}</span>
                </p>

                <form
                  onSubmit={otpForm.handleSubmit(onOTP)}
                  className="mt-5 space-y-3"
                >
                  <input
                    {...otpForm.register("otp")}
                    maxLength={6}
                    autoFocus
                    placeholder="------"
                    onChange={(e) => {
                      const val = e.target.value.replace(/\D/g, "").slice(0, 6);
                      otpForm.setValue("otp", val);
                      if (val.length === 6) {
                        otpForm.handleSubmit(onOTP)();
                      }
                    }}
                    className="block h-11 w-full border border-[#1175c6] bg-white text-center font-mono text-[22px] tracking-[0.5em] text-[#1a1a1a] placeholder:text-[#999] focus:border-[#0a5ea3] focus:outline-none"
                  />

                  <div className="pt-3">
                    <button
                      type="submit"
                      disabled={loading}
                      className="inline-flex h-9 min-w-[110px] items-center justify-center bg-[#1175c6] px-6 text-[14px] font-normal text-white transition-colors hover:bg-[#0a5ea3] disabled:opacity-70"
                    >
                      {loading ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        "Verify"
                      )}
                    </button>
                  </div>
                </form>

                <div className="mt-6 flex items-center justify-between border-t border-[#e5e5e5] pt-4">
                  <button
                    onClick={() => setStep("credentials")}
                    className="text-[13px] text-[#1175c6] hover:underline"
                  >
                    Back
                  </button>

                  <button
                    onClick={resendOTP}
                    disabled={resending || resendCooldown > 0}
                    className="flex items-center gap-2 text-[13px] text-[#1175c6] hover:underline disabled:text-[#999] disabled:no-underline"
                  >
                    <RefreshCw
                      className={`h-3.5 w-3.5 ${resending ? "animate-spin" : ""}`}
                    />
                    {resendCooldown > 0 ? `${resendCooldown}s` : "Resend code"}
                  </button>
                </div>
              </>
            )}
          </div>

          <div className="px-10 pb-6 text-right text-[11px] text-[#666]">
            © {new Date().getFullYear()} Flaxem
          </div>
        </div>
      </div>
    </div>
  );
}