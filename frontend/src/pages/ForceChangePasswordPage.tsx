// src/pages/ForceChangePasswordPage.tsx
"use client";

import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Lock, Eye, EyeOff, Loader2, ShieldCheck, Check, ArrowRight, KeyRound } from "lucide-react";

import { authAPI, profileAPI } from "@/services/api";
import { useAuthStore } from "@/store/authStore";
import { toast } from "@/components/ui/vault-toast";
import { FlaxemLogo } from "@/components/shared/FlaxemLogo";

const schema = z.object({
  old_password: z.string().min(1, "Current temporary password is required"),
  new_password: z.string()
    .min(8, "At least 8 characters")
    .regex(/[A-Z]/, "Include at least one uppercase letter")
    .regex(/[0-9]/, "Include at least one number")
    .regex(/[^A-Za-z0-9]/, "Include at least one special character"),
  confirm_password: z.string(),
}).refine((d) => d.new_password === d.confirm_password, {
  message: "Passwords do not match",
  path: ["confirm_password"],
});

type FormData = z.infer<typeof schema>;

const requirements = [
  { label: "At least 8 characters", test: (v: string) => v.length >= 8 },
  { label: "One uppercase letter", test: (v: string) => /[A-Z]/.test(v) },
  { label: "One number", test: (v: string) => /[0-9]/.test(v) },
  { label: "One special character", test: (v: string) => /[^A-Za-z0-9]/.test(v) },
];

function getStrength(pw: string): { score: number; label: string; color: string } {
  const passed = requirements.filter((r) => r.test(pw)).length;
  if (!pw) return { score: 0, label: "Empty", color: "bg-slate-200" };
  if (passed <= 1) return { score: 1, label: "Weak", color: "bg-[#FF2E2E]" };
  if (passed === 2) return { score: 2, label: "Fair", color: "bg-amber-500" };
  if (passed === 3) return { score: 3, label: "Good", color: "bg-yellow-500" };
  return { score: 4, label: "Strong", color: "bg-emerald-500" };
}

export default function ForceChangePasswordPage() {
  const navigate = useNavigate();
  const { setUser } = useAuthStore();

  const [showOld, setShowOld] = useState(false);
  const [showNew, setShowNew] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [loading, setLoading] = useState(false);

  const { register, handleSubmit, watch, formState: { errors } } = useForm<FormData>({
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

      // Refresh user so must_change_password becomes false
      const { data: me } = await authAPI.me();
      setUser(me);

      toast.success("Password updated successfully! Welcome to Flaxem.");
      navigate("/", { replace: true });
    } catch (err: any) {
      const detail = err?.response?.data?.detail;
      toast.error(Array.isArray(detail) ? detail.join(" ") : detail || "Failed to update password");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex">
      {/* Left Panel - Branding */}
      <div className="hidden lg:flex lg:w-1/2 bg-gradient-to-br from-[#0066CC] via-[#0052a3] to-[#003d7a] relative overflow-hidden">
        <div className="absolute inset-0 opacity-10">
          <svg viewBox="0 0 400 400" className="w-full h-full">
            <path d="M0 100L100 50H200L100 100H0Z" fill="white"/>
            <path d="M50 150L150 100H250L150 150H50Z" fill="white"/>
            <path d="M100 200L200 150H300L200 200H100Z" fill="white"/>
            <path d="M150 250L250 200H350L250 250H150Z" fill="white"/>
          </svg>
        </div>

        <div className="relative z-10 flex flex-col justify-between p-12 w-full">
          <FlaxemLogo variant="light" className="h-14 w-auto" />

          <div className="space-y-6 max-w-md">
            <div className="inline-flex items-center gap-2 bg-white/10 backdrop-blur-sm px-4 py-2 text-xs font-medium tracking-wide rounded-full">
              <KeyRound className="w-4 h-4 text-[#FF2E2E]" />
              ONE-TIME SETUP
            </div>

            <h1 className="text-4xl font-bold text-white leading-tight">
              Secure your account
            </h1>
            <p className="text-sky-100/80 leading-relaxed">
              For your protection, please replace the temporary password with a strong, memorable one.
            </p>
          </div>

          <p className="text-sky-200/50 text-sm">
            Flaxem Systems • Secure Document Management
          </p>
        </div>
      </div>

      {/* Right Panel - Form */}
      <div className="flex-1 flex items-center justify-center p-6 lg:p-12 bg-white relative overflow-hidden">
        {/* Subtle background pattern */}
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

          <div className="space-y-8">
            <div className="relative">
              <div className="absolute -left-4 top-0 w-1 h-14 bg-gradient-to-b from-[#FF2E2E] to-[#0066CC] rounded-full"></div>
              <div className="flex items-center gap-3 mb-4">
                <div className="w-10 h-10 bg-slate-900 flex items-center justify-center">
                  <Lock className="w-5 h-5 text-white" />
                </div>
                <span className="text-xs font-semibold uppercase tracking-wider text-[#FF2E2E]">Security Required</span>
              </div>
              <h2 className="text-2xl font-bold text-slate-900 mb-2">Set your password</h2>
              <p className="text-slate-500">Create a strong password to access Flaxem DMS</p>
            </div>

            <form onSubmit={handleSubmit(onSubmit)} className="space-y-6">
              {/* Temporary Password */}
              <div className="space-y-1">
                <label className="block text-xs font-semibold uppercase tracking-wider text-slate-400 mb-2">
                  Temporary Password
                </label>
                <div className="relative group">
                  <input
                    {...register("old_password")}
                    type={showOld ? "text" : "password"}
                    className="w-full px-0 py-3 bg-transparent border-0 border-b-2 border-slate-200 text-slate-900 text-lg placeholder:text-slate-300 focus:ring-0 focus:border-[#0066CC] transition-colors outline-none peer pr-10"
                    placeholder="From your welcome email"
                    autoFocus
                  />
                  <button
                    type="button"
                    onClick={() => setShowOld((v) => !v)}
                    className="absolute right-0 top-1/2 -translate-y-1/2 text-slate-300 hover:text-slate-600 peer-focus:text-[#0066CC] transition-colors"
                  >
                    {showOld ? <EyeOff className="w-5 h-5" /> : <Eye className="w-5 h-5" />}
                  </button>
                </div>
                {errors.old_password && (
                  <p className="text-[#FF2E2E] text-sm mt-2 flex items-center gap-1">
                    <span className="w-1 h-1 rounded-full bg-[#FF2E2E]"></span>
                    {errors.old_password.message}
                  </p>
                )}
              </div>

              {/* New Password */}
              <div className="space-y-1">
                <label className="block text-xs font-semibold uppercase tracking-wider text-slate-400 mb-2">
                  New Password
                </label>
                <div className="relative group">
                  <input
                    {...register("new_password")}
                    type={showNew ? "text" : "password"}
                    className="w-full px-0 py-3 bg-transparent border-0 border-b-2 border-slate-200 text-slate-900 text-lg placeholder:text-slate-300 focus:ring-0 focus:border-[#0066CC] transition-colors outline-none peer pr-10"
                    placeholder="Create a strong password"
                  />
                  <button
                    type="button"
                    onClick={() => setShowNew((v) => !v)}
                    className="absolute right-0 top-1/2 -translate-y-1/2 text-slate-300 hover:text-slate-600 peer-focus:text-[#0066CC] transition-colors"
                  >
                    {showNew ? <EyeOff className="w-5 h-5" /> : <Eye className="w-5 h-5" />}
                  </button>
                </div>

                {/* Strength Indicator */}
                {newPwValue && (
                  <div className="mt-4">
                    <div className="flex gap-1.5 mb-2">
                      {[1, 2, 3, 4].map((i) => (
                        <div
                          key={i}
                          className={`h-1 flex-1 rounded-full transition-colors ${
                            i <= strength.score ? strength.color : "bg-slate-100"
                          }`}
                        />
                      ))}
                    </div>
                    <p className="text-xs text-slate-500">Strength: <span className="font-medium">{strength.label}</span></p>
                  </div>
                )}

                {/* Requirements */}
                <div className="mt-4 flex flex-wrap gap-2">
                  {requirements.map((req) => {
                    const met = req.test(newPwValue);
                    return (
                      <div
                        key={req.label}
                        className={`inline-flex items-center gap-1.5 px-3 py-1 text-xs rounded-full transition-colors ${
                          met 
                            ? "bg-emerald-50 text-emerald-700 border border-emerald-200" 
                            : "bg-slate-50 text-slate-400 border border-slate-100"
                        }`}
                      >
                        {met ? (
                          <Check className="w-3 h-3" strokeWidth={3} />
                        ) : (
                          <span className="w-1 h-1 rounded-full bg-current" />
                        )}
                        {req.label}
                      </div>
                    );
                  })}
                </div>

                {errors.new_password && (
                  <p className="text-[#FF2E2E] text-sm mt-2 flex items-center gap-1">
                    <span className="w-1 h-1 rounded-full bg-[#FF2E2E]"></span>
                    {errors.new_password.message}
                  </p>
                )}
              </div>

              {/* Confirm Password */}
              <div className="space-y-1">
                <label className="block text-xs font-semibold uppercase tracking-wider text-slate-400 mb-2">
                  Confirm New Password
                </label>
                <div className="relative group">
                  <input
                    {...register("confirm_password")}
                    type={showConfirm ? "text" : "password"}
                    className={`w-full px-0 py-3 bg-transparent border-0 border-b-2 text-slate-900 text-lg placeholder:text-slate-300 focus:ring-0 transition-colors outline-none peer pr-10 ${
                      matches ? "border-emerald-500" : "border-slate-200 focus:border-[#0066CC]"
                    }`}
                    placeholder="Repeat your new password"
                  />
                  <button
                    type="button"
                    onClick={() => setShowConfirm((v) => !v)}
                    className={`absolute right-0 top-1/2 -translate-y-1/2 transition-colors ${
                      matches ? "text-emerald-500" : "text-slate-300 hover:text-slate-600 peer-focus:text-[#0066CC]"
                    }`}
                  >
                    {showConfirm ? <EyeOff className="w-5 h-5" /> : <Eye className="w-5 h-5" />}
                  </button>
                </div>
                {matches && (
                  <p className="text-emerald-600 text-sm mt-2 flex items-center gap-1">
                    <Check className="w-4 h-4" strokeWidth={3} />
                    Passwords match
                  </p>
                )}
                {errors.confirm_password && (
                  <p className="text-[#FF2E2E] text-sm mt-2 flex items-center gap-1">
                    <span className="w-1 h-1 rounded-full bg-[#FF2E2E]"></span>
                    {errors.confirm_password.message}
                  </p>
                )}
              </div>

              <button
                type="submit"
                disabled={loading}
                className="group relative w-full py-4 px-6 bg-slate-900 hover:bg-slate-800 text-white font-semibold rounded-none transition-all disabled:opacity-70 disabled:cursor-not-allowed mt-8 overflow-hidden"
              >
                <span className="absolute inset-y-0 left-0 w-1 bg-[#FF2E2E] group-hover:w-2 transition-all"></span>
                <span className="relative flex items-center justify-center gap-3">
                  {loading ? (
                    <Loader2 className="w-5 h-5 animate-spin" />
                  ) : (
                    <>
                      Set Password & Continue
                      <ArrowRight className="w-5 h-5 group-hover:translate-x-1 transition-transform" />
                    </>
                  )}
                </span>
              </button>
            </form>
          </div>

          <p className="text-center text-slate-400 text-xs mt-12">
            Need help? Contact your Flaxem administrator.
          </p>
        </div>
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
