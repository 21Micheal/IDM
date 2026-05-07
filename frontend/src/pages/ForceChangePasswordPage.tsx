/**
 * ForceChangePasswordPage.tsx
 *
 * Shown immediately after first login when must_change_password=true.
 * Logic preserved — UI updated with modern split-screen Flaxem branding.
 */
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { api, authAPI, profileAPI } from "@/services/api";
import { useAuthStore } from "@/store/authStore";
import { Lock, Eye, EyeOff, Loader2, ShieldCheck, KeyRound, Check, ArrowRight } from "lucide-react";
import { vaultToast as toast } from "@/components/ui/vault-toast";
import { FlaxemLogo } from "@/components/shared/FlaxemLogo";

const schema = z.object({
  old_password:     z.string().min(1, "Current (temporary) password required"),
  new_password:     z.string()
    .min(8,  "At least 8 characters")
    .regex(/[A-Z]/,    "Include at least one uppercase letter")
    .regex(/[0-9]/,    "Include at least one number")
    .regex(/[^A-Za-z0-9]/, "Include at least one special character"),
  confirm_password: z.string(),
}).refine((d) => d.new_password === d.confirm_password, {
  message: "Passwords do not match",
  path: ["confirm_password"],
});

type FormData = z.infer<typeof schema>;

const requirements = [
  { label: "At least 8 characters",      test: (v: string) => v.length >= 8 },
  { label: "One uppercase letter",        test: (v: string) => /[A-Z]/.test(v) },
  { label: "One number",                  test: (v: string) => /[0-9]/.test(v) },
  { label: "One special character",       test: (v: string) => /[^A-Za-z0-9]/.test(v) },
];

function getStrength(pw: string): { score: number; label: string; tone: string } {
  const passed = requirements.filter((r) => r.test(pw)).length;
  if (!pw) return { score: 0, label: "Empty", tone: "bg-muted" };
  if (passed <= 1) return { score: 1, label: "Weak", tone: "bg-destructive" };
  if (passed === 2) return { score: 2, label: "Fair", tone: "bg-amber-500" };
  if (passed === 3) return { score: 3, label: "Good", tone: "bg-yellow-500" };
  return { score: 4, label: "Strong", tone: "bg-emerald-500" };
}

export default function ForceChangePasswordPage() {
  const navigate  = useNavigate();
  const { setUser } = useAuthStore();
  const [showOld, setShowOld] = useState(false);
  const [showNew, setShowNew] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);

  const { register, handleSubmit, watch, formState: { errors } } = useForm<FormData>({
    resolver: zodResolver(schema),
  });

  const [loading, setLoading] = useState(false);

  const onSubmit = async (values: FormData) => {
    setLoading(true);
    try {
      await profileAPI.changePassword(values.old_password, values.new_password);
      
      // Refresh user object so must_change_password becomes false
      const { data: me } = await authAPI.me();
      setUser(me);

      toast.success("Password updated. Welcome to Flaxem IDM!");
      navigate("/", { replace: true });
    } catch (err: unknown) {
      const detail = (err as { response?: { data?: { detail?: string | string[] } } })
        ?.response?.data?.detail;
      toast.error(Array.isArray(detail) ? detail.join(" ") : detail || "Failed to update password");
    } finally {
      setLoading(false);
    }
  };

  const newPwValue = watch("new_password") ?? "";
  const confirmValue = watch("confirm_password") ?? "";
  const strength = getStrength(newPwValue);
  const matches = confirmValue.length > 0 && confirmValue === newPwValue;

  return (
    <div className="min-h-screen grid lg:grid-cols-[1.05fr_1fr] bg-background">
      {/* Brand panel */}
      <aside
        className="relative hidden lg:flex flex-col justify-between p-12 text-white overflow-hidden"
        style={{ background: "var(--gradient-sidebar)" }}
      >
        <div className="absolute -top-32 -right-32 h-96 w-96 rounded-full bg-accent/20 blur-3xl pointer-events-none" />
        <div className="absolute -bottom-40 -left-20 h-[28rem] w-[28rem] rounded-full bg-primary/30 blur-3xl pointer-events-none" />
        <div
          className="absolute inset-0 opacity-[0.06] pointer-events-none"
          style={{
            backgroundImage:
              "linear-gradient(to right, white 1px, transparent 1px), linear-gradient(to bottom, white 1px, transparent 1px)",
            backgroundSize: "44px 44px",
          }}
        />

        <div className="relative z-10">
          <FlaxemLogo variant="light" className="h-10" />
        </div>

        <div className="relative z-10 max-w-md space-y-6">
          <span className="inline-flex items-center gap-2 rounded-full bg-white/10 px-3 py-1 text-xs font-medium ring-1 ring-white/15 backdrop-blur-sm">
            <KeyRound className="h-3.5 w-3.5 text-accent" />
            One-time setup
          </span>
          <h1 className="text-4xl font-semibold leading-tight tracking-tight">
            Secure your account before you continue.
          </h1>
          <p className="text-white/70 leading-relaxed">
            For your safety, replace the temporary password we emailed you with a strong, memorable one.
            You'll use this every time you sign in to Flaxem IDM.
          </p>

          <div className="rounded-xl border border-white/10 bg-white/5 p-5 backdrop-blur-sm">
            <div className="flex items-center gap-3 mb-3">
              <div className="h-9 w-9 rounded-lg bg-accent/20 ring-1 ring-accent/40 flex items-center justify-center">
                <ShieldCheck className="h-5 w-5 text-accent" />
              </div>
              <p className="font-medium">Strong password tips</p>
            </div>
            <ul className="space-y-1.5 text-sm text-white/75">
              <li>• Use a unique passphrase you don't reuse elsewhere.</li>
              <li>• Mix letters, numbers, and a symbol.</li>
              <li>• Avoid names, dates, or dictionary words.</li>
            </ul>
          </div>
        </div>

        <p className="relative z-10 text-xs text-white/50">
          © {new Date().getFullYear()} Flaxem Systems · Reliable Financial Solutions
        </p>
      </aside>

      {/* Form panel */}
      <main className="flex items-center justify-center p-6 sm:p-10">
        <div className="w-full max-w-md">
          <div className="lg:hidden flex justify-center mb-8">
            <FlaxemLogo variant="dark" className="h-9" />
          </div>

          <div className="rounded-2xl border border-border bg-card shadow-[var(--shadow-elegant)] p-8">
            <div className="flex items-center gap-3 mb-6">
              <div className="h-11 w-11 rounded-xl bg-primary/10 ring-1 ring-primary/15 flex items-center justify-center">
                <Lock className="h-5 w-5 text-primary" />
              </div>
              <div>
                <h2 className="text-xl font-semibold tracking-tight text-foreground">Set your password</h2>
                <p className="text-xs text-muted-foreground">Required to continue to Flaxem IDM</p>
              </div>
            </div>

            <form onSubmit={handleSubmit(onSubmit)} className="space-y-5">
              {/* Temporary password */}
              <div>
                <label className="block text-sm font-medium text-foreground mb-1.5">
                  Temporary password
                </label>
                <div className="relative">
                  <input
                    {...register("old_password")}
                    type={showOld ? "text" : "password"}
                    className="w-full h-11 rounded-lg border border-input bg-background pl-3 pr-10 text-sm focus:outline-none focus:ring-2 focus:ring-ring focus:border-ring transition-colors"
                    placeholder="From your welcome email"
                    autoFocus
                  />
                  <button
                    type="button"
                    onClick={() => setShowOld((v) => !v)}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                    aria-label={showOld ? "Hide password" : "Show password"}
                  >
                    {showOld ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                </div>
                {errors.old_password && (
                  <p className="text-destructive text-xs mt-1.5">{errors.old_password.message}</p>
                )}
              </div>

              {/* New password */}
              <div>
                <label className="block text-sm font-medium text-foreground mb-1.5">New password</label>
                <div className="relative">
                  <input
                    {...register("new_password")}
                    type={showNew ? "text" : "password"}
                    className="w-full h-11 rounded-lg border border-input bg-background pl-3 pr-10 text-sm focus:outline-none focus:ring-2 focus:ring-ring focus:border-ring transition-colors"
                    placeholder="Create a strong password"
                  />
                  <button
                    type="button"
                    onClick={() => setShowNew((v) => !v)}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                    aria-label={showNew ? "Hide password" : "Show password"}
                  >
                    {showNew ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                </div>

                {/* Strength meter */}
                {newPwValue && (
                  <div className="mt-3">
                    <div className="flex gap-1.5">
                      {[1, 2, 3, 4].map((i) => (
                        <div
                          key={i}
                          className={`h-1.5 flex-1 rounded-full transition-colors ${
                            i <= strength.score ? strength.tone : "bg-muted"
                          }`}
                        />
                      ))}
                    </div>
                    <p className="mt-1.5 text-xs text-muted-foreground">
                      Strength: <span className="font-medium text-foreground">{strength.label}</span>
                    </p>
                  </div>
                )}

                {/* Requirements grid */}
                <ul className="mt-3 grid grid-cols-2 gap-y-1.5 gap-x-3">
                  {requirements.map((req) => {
                    const met = req.test(newPwValue);
                    return (
                      <li
                        key={req.label}
                        className={`flex items-center gap-1.5 text-xs ${
                          met ? "text-emerald-600" : "text-muted-foreground"
                        }`}
                      >
                        <span
                          className={`flex h-3.5 w-3.5 items-center justify-center rounded-full ${
                            met ? "bg-emerald-500/15" : "bg-muted"
                          }`}
                        >
                          {met ? (
                            <Check className="h-2.5 w-2.5 text-emerald-600" strokeWidth={3} />
                          ) : (
                            <span className="h-1 w-1 rounded-full bg-muted-foreground/50" />
                          )}
                        </span>
                        {req.label}
                      </li>
                    );
                  })}
                </ul>

                {errors.new_password && (
                  <p className="text-destructive text-xs mt-2">{errors.new_password.message}</p>
                )}
              </div>

              {/* Confirm */}
              <div>
                <label className="block text-sm font-medium text-foreground mb-1.5">Confirm new password</label>
                <div className="relative">
                  <input
                    {...register("confirm_password")}
                    type={showConfirm ? "text" : "password"}
                    className={`w-full h-11 rounded-lg border bg-background pl-3 pr-10 text-sm focus:outline-none focus:ring-2 focus:ring-ring transition-colors ${
                      matches ? "border-emerald-500/60 focus:border-emerald-500" : "border-input focus:border-ring"
                    }`}
                    placeholder="Repeat your new password"
                  />
                  <button
                    type="button"
                    onClick={() => setShowConfirm((v) => !v)}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                    aria-label={showConfirm ? "Hide password" : "Show password"}
                  >
                    {showConfirm ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                </div>
                {matches && (
                  <p className="text-emerald-600 text-xs mt-1.5 flex items-center gap-1">
                    <Check className="w-3 h-3" strokeWidth={3} /> Passwords match
                  </p>
                )}
                {errors.confirm_password && (
                  <p className="text-destructive text-xs mt-1.5">{errors.confirm_password.message}</p>
                )}
              </div>

              <button
                type="submit"
                disabled={loading}
                className="w-full inline-flex items-center justify-center gap-2 h-11 px-4 rounded-lg bg-primary text-primary-foreground font-medium shadow-sm hover:bg-primary/90 transition-colors disabled:opacity-70"
              >
                {loading ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <>Set password & continue <ArrowRight className="w-4 h-4" /></>
                )}
              </button>
            </form>
          </div>

          <p className="text-center text-muted-foreground text-xs mt-6">
            Need help? Contact your Flaxem administrator.
          </p>
        </div>
      </main>
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
