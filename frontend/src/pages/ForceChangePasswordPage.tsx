/**
 * ForceChangePasswordPage.tsx
 *
 * Shown immediately after first login when must_change_password=true.
 * The user cannot navigate anywhere else until they complete this step.
 * React Router blocks all other routes via the RequirePasswordChange guard in App.tsx.
 */
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { profileAPI } from "@/services/api";
import { useAuthStore } from "@/store/authStore";
import { Lock, Eye, EyeOff, Loader2, ShieldCheck } from "lucide-react";
import { toast } from "react-toastify";

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

export default function ForceChangePasswordPage() {
  const navigate  = useNavigate();
  const { setUser } = useAuthStore();
  const [showPw, setShowPw] = useState(false);
  const [newPw, setNewPw]   = useState("");

  const { register, handleSubmit, watch, formState: { errors } } = useForm<FormData>({
    resolver: zodResolver(schema),
  });

  const mutation_pending = watch(); // triggers re-render for strength meter
  const [loading, setLoading] = useState(false);

  const onSubmit = async (values: FormData) => {
    setLoading(true);
    try {
      await profileAPI.changePassword(values.old_password, values.new_password);
      // Refresh user object so must_change_password is false in store
      const { data: me } = await import("@/services/api").then(m => m.authAPI.me());
      setUser(me);
      toast.success("Password updated. Welcome to DocVault!");
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

  return (
    <div className="min-h-screen bg-gradient-to-br from-brand-900 to-brand-700 flex items-center justify-center p-4">
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center w-14 h-14 bg-white rounded-2xl shadow-lg mb-4">
            <Lock className="w-7 h-7 text-brand-600" />
          </div>
          <h1 className="text-2xl font-bold text-white">Set your password</h1>
          <p className="text-brand-200 text-sm mt-2 max-w-xs mx-auto">
            Your account was created with a temporary password. Please set a new one to continue.
          </p>
        </div>

        <div className="card p-8 space-y-5">
          <div className="flex items-start gap-3 bg-amber-50 border border-amber-200 rounded-lg p-3">
            <ShieldCheck className="w-4 h-4 text-amber-500 flex-shrink-0 mt-0.5" />
            <p className="text-xs text-amber-700">
              This is a one-time step. Your new password must meet the requirements shown below.
            </p>
          </div>

          <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
            <div>
              <label className="label">Temporary password (from your email)</label>
              <div className="relative">
                <input
                  {...register("old_password")}
                  type={showPw ? "text" : "password"}
                  className="input pr-10"
                  placeholder="Enter the password you received"
                  autoFocus
                />
                <button
                  type="button"
                  onClick={() => setShowPw(!showPw)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
                >
                  {showPw ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
              {errors.old_password && (
                <p className="text-red-500 text-xs mt-1">{errors.old_password.message}</p>
              )}
            </div>

            <div>
              <label className="label">New password</label>
              <input
                {...register("new_password")}
                type={showPw ? "text" : "password"}
                className="input"
                placeholder="Create a strong password"
              />
              {errors.new_password && (
                <p className="text-red-500 text-xs mt-1">{errors.new_password.message}</p>
              )}

              {/* Strength checklist */}
              {newPwValue && (
                <ul className="mt-2 space-y-1">
                  {requirements.map((req) => {
                    const met = req.test(newPwValue);
                    return (
                      <li
                        key={req.label}
                        className={`flex items-center gap-2 text-xs ${met ? "text-green-600" : "text-gray-400"}`}
                      >
                        <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${met ? "bg-green-500" : "bg-gray-300"}`} />
                        {req.label}
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>

            <div>
              <label className="label">Confirm new password</label>
              <input
                {...register("confirm_password")}
                type={showPw ? "text" : "password"}
                className="input"
                placeholder="Repeat your new password"
              />
              {errors.confirm_password && (
                <p className="text-red-500 text-xs mt-1">{errors.confirm_password.message}</p>
              )}
            </div>

            <button
              type="submit"
              disabled={loading}
              className="btn-primary w-full justify-center mt-2"
            >
              {loading && <Loader2 className="w-4 h-4 animate-spin" />}
              Set password & continue
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
