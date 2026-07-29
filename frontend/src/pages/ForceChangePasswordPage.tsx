// src/pages/ForceChangePasswordPage.tsx
"use client";
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { extractApiError } from "@/lib/apiError";
import { useNavigate } from "react-router-dom";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Lock, Eye, EyeOff, Loader2, Check, ArrowRight, ShieldCheck } from "lucide-react";
import { authAPI, profileAPI } from "@/services/api";
import { useAuthStore } from "@/store/authStore";
import { toast } from "@/components/ui/vault-toast";

import dmsLogo from "@/assets/images/FSEDMSlogo.png";

const schema = z
  .object({
    old_password: z.string().min(1, "Current temporary password is required"),
    new_password: z
      .string()
      .min(8, "At least 8 characters")
      .regex(/[A-Z]/, "Include at least one uppercase letter")
      .regex(/[0-9]/, "Include at least one number")
      .regex(/[^A-Za-z0-9]/, "Include at least one special character"),
    confirm_password: z.string(),
  })
  .refine((d) => d.new_password === d.confirm_password, {
    message: "Passwords do not match",
    path: ["confirm_password"],
  });

type FormData = z.infer<typeof schema>;

const requirements = [
  { label: "8+ characters", test: (v: string) => v.length >= 8 },
  { label: "Uppercase letter", test: (v: string) => /[A-Z]/.test(v) },
  { label: "Number", test: (v: string) => /[0-9]/.test(v) },
  { label: "Special character", test: (v: string) => /[^A-Za-z0-9]/.test(v) },
];

function getStrength(pw: string): { score: number; label: string; color: string } {
  const passed = requirements.filter((r) => r.test(pw)).length;
  if (!pw) return { score: 0, label: "—", color: "bg-white/30" };
  if (passed <= 1) return { score: 1, label: "Weak", color: "bg-red-400" };
  if (passed === 2) return { score: 2, label: "Fair", color: "bg-amber-400" };
  if (passed === 3) return { score: 3, label: "Good", color: "bg-sky-300" };
  return { score: 4, label: "Strong", color: "bg-emerald-400" };
}

export default function ForceChangePasswordPage() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { setUser } = useAuthStore();
  const [showOld, setShowOld] = useState(false);
  const [showNew, setShowNew] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [loading, setLoading] = useState(false);

  const {
    register,
    handleSubmit,
    watch,
    formState: { errors },
  } = useForm<FormData>({
    resolver: zodResolver(schema),
    mode: "onChange",
  });

  const newPwValue = watch("new_password") ?? "";
  const confirmValue = watch("confirm_password") ?? "";
  const strength = getStrength(newPwValue);
  const matches = confirmValue.length > 0 && confirmValue === newPwValue;

  const onSubmit = async (values: FormData) => {
    setLoading(true);
    try {
      await profileAPI.changePassword(values.old_password, values.new_password);
    } catch (err: any) {
      // The change itself failed — the temporary password still works, so let
      // the user correct and retry.
      toast.error(extractApiError(err, "Failed to update password"));
      setLoading(false);
      return;
    }

    // Password is now changed on the server. A background /auth/me refetch (e.g.
    // SessionSync's refetchOnWindowFocus) may still be in flight carrying the old
    // must_change_password=true; if it lands after we navigate it would bounce
    // the user straight back here. Cancel it and seed the cache with fresh data.
    await qc.cancelQueries({ queryKey: ["auth", "me"] });
    try {
      const { data: me } = await authAPI.me();
      qc.setQueryData(["auth", "me"], me);
      setUser(me);
    } catch {
      // Profile re-fetch failed, but the password change already succeeded.
      // Clear the flag locally so the guard doesn't send us back to this page.
      const current = useAuthStore.getState().user;
      if (current) setUser({ ...current, must_change_password: false });
    }

    toast.success("Password updated successfully! Welcome to Flaxem.");
    navigate("/", { replace: true });
    setLoading(false);
  };

  const inputBase =
    "block h-9 w-full border border-white/40 bg-white/10 px-2.5 pr-10 text-[14px] text-white placeholder:text-white/50 transition-colors focus:border-white focus:outline-none";

  return (
    <div className="min-h-screen bg-gradient-to-br from-sky-50 via-sky-100 to-blue-200 flex items-center justify-center p-4">
      <div className="w-full max-w-[500px]">
        <div className="shadow-[0_2px_6px_rgba(0,0,0,0.15)]">
          {/* Light-blue header strip — logo + context, same treatment as the login card */}
          <div className="px-10 pt-8 pb-6" style={{ backgroundColor: "#dff0fb" }}>
            <div className="flex items-start justify-between gap-4">
              <img
                src={dmsLogo}
                alt="Flaxem Document Management System"
                className="h-24 w-auto"
              />
              <span className="mt-1 inline-flex flex-shrink-0 items-center gap-1.5 border border-[#f2c46d] bg-[#fff7e6] px-2.5 py-1 text-[11px] font-semibold text-[#8a5a00]">
                <ShieldCheck className="h-3.5 w-3.5" />
                One-time setup
              </span>
            </div>
            <p className="mt-3 text-[12px] font-medium uppercase tracking-[0.18em] text-[#3F474F]">
              Account security
            </p>
          </div>

          {/* Blue gradient body — matches the sidebar gradient used across the app */}
          <div
            style={{
              background:
                "var(--gradient-sidebar, linear-gradient(180deg, hsl(203 64% 42%) 0%, hsl(203 78% 34%) 100%))",
            }}
          >
            <div className="px-10 pt-8">
              <h2 className="text-[17px] font-semibold text-white">Set a new password</h2>
              <p className="mt-2 max-w-[26rem] text-[13px] leading-5 text-white/75">
                Replace the temporary password from your welcome email before opening the document workspace.
              </p>
            </div>

            <form onSubmit={handleSubmit(onSubmit)} className="space-y-4 px-10 py-6">
              <div className="border border-white/25 bg-white/10 px-3 py-2.5 text-[12px] leading-5 text-white/80">
                Use a password that is unique to this account. You will use it for future sign-ins.
              </div>

              <div>
                <label className="mb-1.5 block text-[13px] font-semibold text-white/90">
                  Temporary password
                </label>
                <div className="relative">
                  <input
                    {...register("old_password")}
                    type={showOld ? "text" : "password"}
                    className={inputBase}
                    placeholder="From your welcome email"
                    autoComplete="current-password"
                    autoFocus
                  />
                  <button
                    type="button"
                    onClick={() => setShowOld((v) => !v)}
                    className="absolute right-2.5 top-1/2 -translate-y-1/2 p-1 text-white/60 transition-colors hover:text-white"
                    aria-label={showOld ? "Hide password" : "Show password"}
                  >
                    {showOld ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </button>
                </div>
                {errors.old_password && (
                  <p className="mt-1.5 text-xs text-red-200">{errors.old_password.message}</p>
                )}
              </div>

              <div>
                <label className="mb-1.5 block text-[13px] font-semibold text-white/90">
                  New password
                </label>
                <div className="relative">
                  <input
                    {...register("new_password")}
                    type={showNew ? "text" : "password"}
                    className={inputBase}
                    placeholder="Create a strong password"
                    autoComplete="new-password"
                  />
                  <button
                    type="button"
                    onClick={() => setShowNew((v) => !v)}
                    className="absolute right-2.5 top-1/2 -translate-y-1/2 p-1 text-white/60 transition-colors hover:text-white"
                    aria-label={showNew ? "Hide password" : "Show password"}
                  >
                    {showNew ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </button>
                </div>

                <div className="mt-3 border border-white/25 bg-white/10 p-3">
                  <div className="flex items-center gap-3">
                    <div className="flex flex-1 gap-1">
                      {[1, 2, 3, 4].map((i) => (
                        <div
                          key={i}
                          className={`h-1 flex-1 transition-colors ${
                            i <= strength.score ? strength.color : "bg-white/20"
                          }`}
                        />
                      ))}
                    </div>
                    <span className="w-12 text-right text-[11px] font-semibold text-white/80">
                      {strength.label}
                    </span>
                  </div>

                  <ul className="mt-3 grid gap-x-3 gap-y-1.5 sm:grid-cols-2">
                    {requirements.map((req) => {
                      const met = req.test(newPwValue);
                      return (
                        <li
                          key={req.label}
                          className={`flex items-center gap-1.5 text-xs ${
                            met ? "text-white" : "text-white/50"
                          }`}
                        >
                          <span
                            className={`flex h-3.5 w-3.5 items-center justify-center border ${
                              met ? "border-white bg-white/20" : "border-white/30 bg-transparent"
                            }`}
                          >
                            {met ? (
                              <Check className="h-2.5 w-2.5" strokeWidth={3} />
                            ) : (
                              <span className="h-1 w-1 bg-white/40" />
                            )}
                          </span>
                          {req.label}
                        </li>
                      );
                    })}
                  </ul>
                </div>

                {errors.new_password && (
                  <p className="mt-2 text-xs text-red-200">{errors.new_password.message}</p>
                )}
              </div>

              <div>
                <label className="mb-1.5 block text-[13px] font-semibold text-white/90">
                  Confirm new password
                </label>
                <div className="relative">
                  <input
                    {...register("confirm_password")}
                    type={showConfirm ? "text" : "password"}
                    className={`${inputBase} ${matches ? "border-white" : ""}`}
                    placeholder="Repeat your new password"
                    autoComplete="new-password"
                  />
                  <button
                    type="button"
                    onClick={() => setShowConfirm((v) => !v)}
                    className="absolute right-2.5 top-1/2 -translate-y-1/2 p-1 text-white/60 transition-colors hover:text-white"
                    aria-label={showConfirm ? "Hide password" : "Show password"}
                  >
                    {showConfirm ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </button>
                </div>
                {matches && !errors.confirm_password && (
                  <p className="mt-1.5 flex items-center gap-1 text-xs text-emerald-300">
                    <Check className="h-3 w-3" strokeWidth={3} />
                    Passwords match
                  </p>
                )}
                {errors.confirm_password && (
                  <p className="mt-1.5 text-xs text-red-200">{errors.confirm_password.message}</p>
                )}
              </div>

              <div className="flex items-center justify-between gap-3 pt-2">
                <p className="flex items-center gap-1.5 text-[11px] text-white/60">
                  <Lock className="h-3.5 w-3.5" />
                  Encrypted in transit and at rest.
                </p>
                <button
                  type="submit"
                  disabled={loading}
                  className="inline-flex h-9 min-w-[150px] items-center justify-center gap-2 bg-white px-5 text-[14px] font-normal text-[#155a86] transition-colors hover:bg-white/90 disabled:cursor-not-allowed disabled:opacity-70"
                >
                  {loading ? (
                    <>
                      <Loader2 className="h-4 w-4 animate-spin" />
                      Updating
                    </>
                  ) : (
                    <>
                      Update password
                      <ArrowRight className="h-4 w-4" />
                    </>
                  )}
                </button>
              </div>
            </form>

            <div className="border-t border-white/20 px-10 py-3 text-[12px] text-white/60">
              Need help? Contact your Flaxem administrator.
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}