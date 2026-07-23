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

import { useAuthStore, applyServerSessionPolicy } from "@/store/authStore";
import { toast } from "@/components/ui/vault-toast";
import type { AuthUser, ServerSessionPolicy } from "@/store/authStore";

import dmsLogo from "@/assets/images/FSEDMSlogo.png";

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
    session_policy?: ServerSessionPolicy;
  }) => {
    // Apply the configured session policy before starting the session clock so
    // the absolute deadline uses the admin-defined lifetime, not the fallback.
    applyServerSessionPolicy(tokenData.session_policy);
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
    <div className="min-h-screen bg-gradient-to-br from-sky-50 via-sky-100 to-blue-200 flex items-center justify-center p-4">
      <div className="w-full max-w-[440px]">
        <div className="shadow-[0_2px_6px_rgba(0,0,0,0.15)]">
          {/* Light-blue header strip so the logo is visible but still reads as part of the blue card */}
          <div className="flex justify-center px-10 pt-8 pb-6" style={{ backgroundColor: "#dff0fb" }}>
            <img
              src={dmsLogo}
              alt="Flaxem Document Management System"
              className="h-24 w-auto"
            />
          </div>

          <div
            style={{
              background:
                "var(--gradient-sidebar, linear-gradient(180deg, hsl(203 64% 42%) 0%, hsl(203 78% 34%) 100%))",
            }}
          >
          <div className="px-10 pt-8 pb-10">
            {step === "credentials" ? (
              <>
                <h2 className="text-[15px] font-semibold text-white">
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
                      className="block h-9 w-full border border-white/40 bg-white/10 px-2 text-[14px] text-white placeholder:text-white/60 focus:border-white focus:outline-none"
                    />
                    {credForm.formState.errors.email && (
                      <p className="text-[12px] text-red-200">
                        {credForm.formState.errors.email.message}
                      </p>
                    )}

                    <input
                      {...credForm.register("password")}
                      type="password"
                      autoComplete="current-password"
                      placeholder="Password"
                      className="block h-9 w-full border border-white/40 bg-white/10 px-2 text-[14px] text-white placeholder:text-white/60 focus:border-white focus:outline-none"
                    />
                    {credForm.formState.errors.password && (
                      <p className="text-[12px] text-red-200">
                        {credForm.formState.errors.password.message}
                      </p>
                    )}

                    <div className="pt-3 flex items-center justify-between">
                      <button
                        type="submit"
                        disabled={loading}
                        className="inline-flex h-9 min-w-[110px] items-center justify-center bg-white px-6 text-[14px] font-normal text-[#155a86] transition-colors hover:bg-white/90 disabled:opacity-70"
                      >
                        {loading ? (
                          <Loader2 className="h-4 w-4 animate-spin" />
                        ) : (
                          "Sign in"
                        )}
                      </button>

                      <button
                        type="button"
                        className="text-[13px] text-white/80 hover:text-white hover:underline"
                      >
                        Forgot password?
                      </button>
                    </div>
                  </form>
                </>
              ) : (
                <>
                  <h2 className="text-[15px] font-semibold text-white">
                    Verification
                  </h2>

                  <p className="mt-3 text-[13px] leading-relaxed text-white/80">
                    Enter the verification code sent to{" "}
                    <span className="font-semibold text-white">{userEmail}</span>
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
                      className="block h-11 w-full border border-white/40 bg-white/10 text-center font-mono text-[22px] tracking-[0.5em] text-white placeholder:text-white/50 focus:border-white focus:outline-none"
                    />
                    {otpForm.formState.errors.otp && (
                      <p className="text-[12px] text-red-200">
                        {otpForm.formState.errors.otp.message}
                      </p>
                    )}

                    <div className="pt-3">
                      <button
                        type="submit"
                        disabled={loading}
                        className="inline-flex h-9 min-w-[110px] items-center justify-center bg-white px-6 text-[14px] font-normal text-[#155a86] transition-colors hover:bg-white/90 disabled:opacity-70"
                      >
                        {loading ? (
                          <Loader2 className="h-4 w-4 animate-spin" />
                        ) : (
                          "Verify"
                        )}
                      </button>
                    </div>
                  </form>

                  <div className="mt-6 flex items-center justify-between border-t border-white/20 pt-4">
                    <button
                      onClick={() => setStep("credentials")}
                      className="text-[13px] text-white/80 hover:underline"
                    >
                      Back
                    </button>

                    <button
                      onClick={resendOTP}
                      disabled={resending || resendCooldown > 0}
                      className="flex items-center gap-2 text-[13px] text-white/80 hover:underline disabled:text-white/40 disabled:no-underline"
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

            <div className="px-10 pb-6 text-right text-[11px] text-white/60">
              © {new Date().getFullYear()} Flaxem
            </div>
          </div>
          </div>
        </div>
      </div>
  );
}