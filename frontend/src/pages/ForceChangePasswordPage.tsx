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
import { FlaxemLogo } from "@/components/shared/FlaxemLogo";

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
    "w-full h-11 rounded-md border border-slate-200 bg-white px-3 pr-10 text-sm text-slate-900 placeholder:text-slate-400 shadow-sm transition focus:border-sky-500 focus:ring-2 focus:ring-sky-500/20 focus:outline-none";

  return (
    <div className="min-h-screen bg-gradient-to-br from-sky-50 via-sky-100 to-blue-100 flex items-center justify-center p-4">
      <div className="w-full max-w-md">
        {/* Logo */}
        <div className="flex justify-center mb-8">
          <FlaxemLogo variant="dark" className="h-10 w-auto" />
        </div>

        {/* Status pill */}
        <div className="mb-6 flex justify-center">
          <span className="inline-flex items-center gap-1.5 rounded-full border border-amber-200 bg-amber-50 px-3 py-1 text-[11px] font-medium uppercase tracking-wide text-amber-700">
            <ShieldCheck className="w-3.5 h-3.5" />
            One-time setup
          </span>
        </div>

        {/* Card */}
        <div className="rounded-xl border border-slate-200 bg-white shadow-xl shadow-sky-900/10 overflow-hidden">
          <div className="px-8 pt-8 pb-6 border-b border-slate-100">
            <h1 className="text-xl font-semibold text-slate-900">Set a new password</h1>
            <p className="mt-1.5 text-sm text-slate-500">
              Replace the temporary password from your welcome email with a strong one.
            </p>
          </div>

          <form onSubmit={handleSubmit(onSubmit)} className="px-8 py-6 space-y-5">
            {/* Temporary Password */}
            <div>
              <label className="mb-1.5 block text-sm font-medium text-slate-700">
                Temporary password
              </label>
              <div className="relative">
                <input
                  {...register("old_password")}
                  type={showOld ? "text" : "password"}
                  className={inputBase}
                  placeholder="From your welcome email"
                  autoFocus
                />
                <button
                  type="button"
                  onClick={() => setShowOld((v) => !v)}
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 p-1 text-slate-400 hover:text-slate-600"
                  aria-label={showOld ? "Hide password" : "Show password"}
                >
                  {showOld ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
              {errors.old_password && (
                <p className="mt-1.5 text-xs text-red-600">{errors.old_password.message}</p>
              )}
            </div>

            {/* New Password */}
            <div>
              <label className="mb-1.5 block text-sm font-medium text-slate-700">
                New password
              </label>
              <div className="relative">
                <input
                  {...register("new_password")}
                  type={showNew ? "text" : "password"}
                  className={inputBase}
                  placeholder="Create a strong password"
                />
                <button
                  type="button"
                  onClick={() => setShowNew((v) => !v)}
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 p-1 text-slate-400 hover:text-slate-600"
                  aria-label={showNew ? "Hide password" : "Show password"}
                >
                  {showNew ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>

              {/* Strength + requirements */}
              <div className="mt-3 space-y-2.5">
                <div className="flex items-center gap-3">
                  <div className="flex gap-1 flex-1">
                    {[1, 2, 3, 4].map((i) => (
                      <div
                        key={i}
                        className={`h-1 flex-1 rounded-full transition-colors ${
                          i <= strength.score ? strength.color : "bg-slate-100"
                        }`}
                      />
                    ))}
                  </div>
                  <span className="text-[11px] font-medium text-slate-500 w-12 text-right">
                    {strength.label}
                  </span>
                </div>
                <ul className="grid grid-cols-2 gap-x-3 gap-y-1.5">
                  {requirements.map((req) => {
                    const met = req.test(newPwValue);
                    return (
                      <li
                        key={req.label}
                        className={`flex items-center gap-1.5 text-xs ${
                          met ? "text-emerald-600" : "text-slate-400"
                        }`}
                      >
                        <span
                          className={`flex h-3.5 w-3.5 items-center justify-center rounded-full ${
                            met ? "bg-emerald-100" : "bg-slate-100"
                          }`}
                        >
                          {met ? (
                            <Check className="h-2.5 w-2.5" strokeWidth={3} />
                          ) : (
                            <span className="h-1 w-1 rounded-full bg-slate-300" />
                          )}
                        </span>
                        {req.label}
                      </li>
                    );
                  })}
                </ul>
              </div>

              {errors.new_password && (
                <p className="mt-2 text-xs text-red-600">{errors.new_password.message}</p>
              )}
            </div>

            {/* Confirm Password */}
            <div>
              <label className="mb-1.5 block text-sm font-medium text-slate-700">
                Confirm new password
              </label>
              <div className="relative">
                <input
                  {...register("confirm_password")}
                  type={showConfirm ? "text" : "password"}
                  className={`${inputBase} ${
                    matches ? "border-emerald-400 focus:border-emerald-500 focus:ring-emerald-500/20" : ""
                  }`}
                  placeholder="Repeat your new password"
                />
                <button
                  type="button"
                  onClick={() => setShowConfirm((v) => !v)}
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 p-1 text-slate-400 hover:text-slate-600"
                  aria-label={showConfirm ? "Hide password" : "Show password"}
                >
                  {showConfirm ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
              {matches && !errors.confirm_password && (
                <p className="mt-1.5 flex items-center gap-1 text-xs text-emerald-600">
                  <Check className="h-3 w-3" strokeWidth={3} />
                  Passwords match
                </p>
              )}
              {errors.confirm_password && (
                <p className="mt-1.5 text-xs text-red-600">{errors.confirm_password.message}</p>
              )}
            </div>

            <button
              type="submit"
              disabled={loading}
              className="mt-2 inline-flex h-11 w-full items-center justify-center gap-2 rounded-md bg-slate-900 px-4 text-sm font-medium text-white shadow-sm transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-70"
            >
              {loading ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Updating…
                </>
              ) : (
                <>
                  Update password
                  <ArrowRight className="h-4 w-4" />
                </>
              )}
            </button>
          </form>

          <div className="flex items-center gap-2 border-t border-slate-100 bg-slate-50/60 px-8 py-3.5 text-xs text-slate-500 rounded-b-xl">
            <Lock className="h-3.5 w-3.5" />
            Your password is encrypted and never shared.
          </div>
        </div>

        <p className="mt-6 text-center text-xs text-slate-500">
          Need help? Contact your Flaxem administrator.
        </p>
      </div>
    </div>
  );
}

// /**
//  * ForceChangePasswordPage.tsx
//  *
//  * Shown immediately after first login when must_change_password=true.
//  * The user cannot navigate anywhere else until they complete this step.
//  * React Router blocks all other routes via the RequirePasswordChange guard in App.tsx.
//  */
// import { useState } from "react";
// import { useNavigate } from "react-router-dom";
// import { useForm } from "react-hook-form";
// import { zodResolver } from "@hookform/resolvers/zod";
// import { z } from "zod";
// import { authAPI, profileAPI } from "@/services/api";
// import { useAuthStore } from "@/store/authStore";
// import { Lock, Eye, EyeOff, Loader2, ShieldCheck } from "lucide-react";
// import { toast } from "@/components/ui/vault-toast";

// const schema = z.object({
//   old_password:     z.string().min(1, "Current (temporary) password required"),
//   new_password:     z.string()
//     .min(8,  "At least 8 characters")
//     .regex(/[A-Z]/,    "Include at least one uppercase letter")
//     .regex(/[0-9]/,    "Include at least one number")
//     .regex(/[^A-Za-z0-9]/, "Include at least one special character"),
//   confirm_password: z.string(),
// }).refine((d) => d.new_password === d.confirm_password, {
//   message: "Passwords do not match",
//   path: ["confirm_password"],
// });

// type FormData = z.infer<typeof schema>;

// const requirements = [
//   { label: "At least 8 characters",      test: (v: string) => v.length >= 8 },
//   { label: "One uppercase letter",        test: (v: string) => /[A-Z]/.test(v) },
//   { label: "One number",                  test: (v: string) => /[0-9]/.test(v) },
//   { label: "One special character",       test: (v: string) => /[^A-Za-z0-9]/.test(v) },
// ];

// export default function ForceChangePasswordPage() {
//   const navigate  = useNavigate();
//   const { setUser } = useAuthStore();
//   const [showPw, setShowPw] = useState(false);
//   const [newPw, setNewPw]   = useState("");

//   const { register, handleSubmit, watch, formState: { errors } } = useForm<FormData>({
//     resolver: zodResolver(schema),
//   });

//   const mutation_pending = watch(); // triggers re-render for strength meter
//   const [loading, setLoading] = useState(false);

//   const onSubmit = async (values: FormData) => {
//     setLoading(true);
//     try {
//       await profileAPI.changePassword(values.old_password, values.new_password);
//       // Refresh user object so must_change_password is false in store
//       const { data: me } = await authAPI.me();
//       setUser(me);
//       toast.success("Password updated. Welcome to DocVault!");
//       navigate("/", { replace: true });
//     } catch (err: unknown) {
//       const detail = (err as { response?: { data?: { detail?: string | string[] } } })
//         ?.response?.data?.detail;
//       toast.error(Array.isArray(detail) ? detail.join(" ") : detail || "Failed to update password");
//     } finally {
//       setLoading(false);
//     }
//   };

//   const newPwValue = watch("new_password") ?? "";

//   return (
//     <div className="min-h-screen bg-gradient-to-br from-brand-900 to-brand-700 flex items-center justify-center p-4">
//       <div className="w-full max-w-md">
//         <div className="text-center mb-8">
//           <div className="inline-flex items-center justify-center w-14 h-14 bg-white rounded-2xl shadow-lg mb-4">
//             <Lock className="w-7 h-7 text-brand-600" />
//           </div>
//           <h1 className="text-2xl font-bold text-white">Set your password</h1>
//           <p className="text-brand-200 text-sm mt-2 max-w-xs mx-auto">
//             Your account was created with a temporary password. Please set a new one to continue.
//           </p>
//         </div>

//         <div className="card p-8 space-y-5">
//           <div className="flex items-start gap-3 bg-amber-50 border border-amber-200 rounded-lg p-3">
//             <ShieldCheck className="w-4 h-4 text-amber-500 flex-shrink-0 mt-0.5" />
//             <p className="text-xs text-amber-700">
//               This is a one-time step. Your new password must meet the requirements shown below.
//             </p>
//           </div>

//           <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
//             <div>
//               <label className="label">Temporary password (from your email)</label>
//               <div className="relative">
//                 <input
//                   {...register("old_password")}
//                   type={showPw ? "text" : "password"}
//                   className="input pr-10"
//                   placeholder="Enter the password you received"
//                   autoFocus
//                 />
//                 <button
//                   type="button"
//                   onClick={() => setShowPw(!showPw)}
//                   className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
//                 >
//                   {showPw ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
//                 </button>
//               </div>
//               {errors.old_password && (
//                 <p className="text-red-500 text-xs mt-1">{errors.old_password.message}</p>
//               )}
//             </div>

//             <div>
//               <label className="label">New password</label>
//               <input
//                 {...register("new_password")}
//                 type={showPw ? "text" : "password"}
//                 className="input"
//                 placeholder="Create a strong password"
//               />
//               {errors.new_password && (
//                 <p className="text-red-500 text-xs mt-1">{errors.new_password.message}</p>
//               )}

//               {/* Strength checklist */}
//               {newPwValue && (
//                 <ul className="mt-2 space-y-1">
//                   {requirements.map((req) => {
//                     const met = req.test(newPwValue);
//                     return (
//                       <li
//                         key={req.label}
//                         className={`flex items-center gap-2 text-xs ${met ? "text-green-600" : "text-gray-400"}`}
//                       >
//                         <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${met ? "bg-green-500" : "bg-gray-300"}`} />
//                         {req.label}
//                       </li>
//                     );
//                   })}
//                 </ul>
//               )}
//             </div>

//             <div>
//               <label className="label">Confirm new password</label>
//               <input
//                 {...register("confirm_password")}
//                 type={showPw ? "text" : "password"}
//                 className="input"
//                 placeholder="Repeat your new password"
//               />
//               {errors.confirm_password && (
//                 <p className="text-red-500 text-xs mt-1">{errors.confirm_password.message}</p>
//               )}
//             </div>

//             <button
//               type="submit"
//               disabled={loading}
//               className="btn-primary w-full justify-center mt-2"
//             >
//               {loading && <Loader2 className="w-4 h-4 animate-spin" />}
//               Set password & continue
//             </button>
//           </form>
//         </div>
//       </div>
//     </div>
//   );
// }
