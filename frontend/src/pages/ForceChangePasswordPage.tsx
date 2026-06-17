// src/pages/ForceChangePasswordPage.tsx
"use client";
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Lock, Eye, EyeOff, Loader2, Check, ArrowRight, ShieldCheck } from "lucide-react";
import { authAPI, profileAPI } from "@/services/api";
import { useAuthStore } from "@/store/authStore";
import { toast } from "@/components/ui/vault-toast";

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
  if (!pw) return { score: 0, label: "—", color: "bg-slate-200" };
  if (passed <= 1) return { score: 1, label: "Weak", color: "bg-red-500" };
  if (passed === 2) return { score: 2, label: "Fair", color: "bg-amber-500" };
  if (passed === 3) return { score: 3, label: "Good", color: "bg-sky-500" };
  return { score: 4, label: "Strong", color: "bg-emerald-500" };
}

export default function ForceChangePasswordPage() {
  const navigate = useNavigate();
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
      const { data: me } = await authAPI.me();
      setUser(me);
      toast.success("Password updated successfully! Welcome to Flaxem.");
      navigate("/", { replace: true });
    } catch (err: any) {
      const detail = err?.response?.data?.detail;
      toast.error(
        Array.isArray(detail) ? detail.join(" ") : detail || "Failed to update password"
      );
    } finally {
      setLoading(false);
    }
  };

  const inputBase =
    "block h-9 w-full border border-[#bcbcbc] bg-white px-2.5 pr-10 text-[14px] text-[#1a1a1a] placeholder:text-[#666] transition-colors focus:border-[#1175c6] focus:outline-none";

  return (
    <div
      className="relative min-h-screen overflow-hidden"
      style={{
        background:
          "linear-gradient(135deg, #1175c6 0%, #2389d4 45%, #3aa3e6 100%)",
      }}
    >
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
        <div className="w-full max-w-[500px] bg-white shadow-[0_2px_6px_rgba(0,0,0,0.22)]">
          <div className="border-b border-[#d6d6d6] px-10 pb-6 pt-9">
            <div className="flex items-start justify-between gap-4">
              <div>
                <h1 className="text-[26px] font-normal tracking-wide text-[#1a1a1a]">
                  FLAXEM
                </h1>
                <p className="mt-1 text-[12px] font-medium uppercase tracking-[0.18em] text-[#5E6870]">
                  Account security
                </p>
              </div>
              <span className="inline-flex items-center gap-1.5 border border-[#f2c46d] bg-[#fff7e6] px-2.5 py-1 text-[11px] font-semibold text-[#8a5a00]">
                <ShieldCheck className="h-3.5 w-3.5" />
                One-time setup
              </span>
            </div>

            <h2 className="mt-9 text-[17px] font-semibold text-[#1a1a1a]">
              Set a new password
            </h2>
            <p className="mt-2 max-w-[26rem] text-[13px] leading-5 text-[#5E6870]">
              Replace the temporary password from your welcome email before opening the document workspace.
            </p>
          </div>

          <form onSubmit={handleSubmit(onSubmit)} className="space-y-4 px-10 py-6">
            <div className="border border-[#c8cdd2] bg-[#f7f8f9] px-3 py-2.5 text-[12px] leading-5 text-[#3F474F]">
              Use a password that is unique to this account. You will use it for future sign-ins.
            </div>

            <div>
              <label className="mb-1.5 block text-[13px] font-semibold text-[#3F474F]">
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
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 p-1 text-[#6B737B] transition-colors hover:text-[#1F2933]"
                  aria-label={showOld ? "Hide password" : "Show password"}
                >
                  {showOld ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
              {errors.old_password && (
                <p className="mt-1.5 text-xs text-[#c2410c]">{errors.old_password.message}</p>
              )}
            </div>

            <div>
              <label className="mb-1.5 block text-[13px] font-semibold text-[#3F474F]">
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
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 p-1 text-[#6B737B] transition-colors hover:text-[#1F2933]"
                  aria-label={showNew ? "Hide password" : "Show password"}
                >
                  {showNew ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>

              <div className="mt-3 border border-[#d6d6d6] bg-white p-3">
                <div className="flex items-center gap-3">
                  <div className="flex flex-1 gap-1">
                    {[1, 2, 3, 4].map((i) => (
                      <div
                        key={i}
                        className={`h-1 flex-1 transition-colors ${
                          i <= strength.score ? strength.color : "bg-[#e3e7ea]"
                        }`}
                      />
                    ))}
                  </div>
                  <span className="w-12 text-right text-[11px] font-semibold text-[#5E6870]">
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
                          met ? "text-[#287EAD]" : "text-[#6B737B]"
                        }`}
                      >
                        <span
                          className={`flex h-3.5 w-3.5 items-center justify-center border ${
                            met ? "border-[#287EAD] bg-[#e5f3fb]" : "border-[#c8cdd2] bg-[#f7f8f9]"
                          }`}
                        >
                          {met ? (
                            <Check className="h-2.5 w-2.5" strokeWidth={3} />
                          ) : (
                            <span className="h-1 w-1 bg-[#aeb5bb]" />
                          )}
                        </span>
                        {req.label}
                      </li>
                    );
                  })}
                </ul>
              </div>

              {errors.new_password && (
                <p className="mt-2 text-xs text-[#c2410c]">{errors.new_password.message}</p>
              )}
            </div>

            <div>
              <label className="mb-1.5 block text-[13px] font-semibold text-[#3F474F]">
                Confirm new password
              </label>
              <div className="relative">
                <input
                  {...register("confirm_password")}
                  type={showConfirm ? "text" : "password"}
                  className={`${inputBase} ${
                    matches ? "border-[#287EAD] focus:border-[#287EAD]" : ""
                  }`}
                  placeholder="Repeat your new password"
                  autoComplete="new-password"
                />
                <button
                  type="button"
                  onClick={() => setShowConfirm((v) => !v)}
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 p-1 text-[#6B737B] transition-colors hover:text-[#1F2933]"
                  aria-label={showConfirm ? "Hide password" : "Show password"}
                >
                  {showConfirm ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
              {matches && !errors.confirm_password && (
                <p className="mt-1.5 flex items-center gap-1 text-xs text-[#287EAD]">
                  <Check className="h-3 w-3" strokeWidth={3} />
                  Passwords match
                </p>
              )}
              {errors.confirm_password && (
                <p className="mt-1.5 text-xs text-[#c2410c]">{errors.confirm_password.message}</p>
              )}
            </div>

            <div className="flex items-center justify-between gap-3 pt-2">
              <p className="flex items-center gap-1.5 text-[11px] text-[#5E6870]">
                <Lock className="h-3.5 w-3.5" />
                Encrypted in transit and at rest.
              </p>
              <button
                type="submit"
                disabled={loading}
                className="inline-flex h-9 min-w-[150px] items-center justify-center gap-2 bg-[#1175c6] px-5 text-[14px] font-normal text-white transition-colors hover:bg-[#0a5ea3] disabled:cursor-not-allowed disabled:opacity-70"
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

          <div className="border-t border-[#d6d6d6] bg-[#f7f8f9] px-10 py-3 text-[12px] text-[#5E6870]">
            Need help? Contact your Flaxem administrator.
          </div>
        </div>
      </div>
    </div>
  );
}
