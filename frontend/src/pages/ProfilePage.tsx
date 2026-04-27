import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { profileAPI } from "@/services/api";
import { useAuthStore } from "@/store/authStore";
import {
  Shield, Key, Smartphone,
  Loader2, Eye, EyeOff, AlertTriangle, UserCircle,
} from "lucide-react";
import { toast } from "@/components/ui/vault-toast";

const pwSchema = z.object({
  old_password:     z.string().min(1, "Required"),
  new_password:     z.string().min(8, "Min 8 characters"),
  confirm_password: z.string(),
}).refine((d) => d.new_password === d.confirm_password, {
  message: "Passwords do not match",
  path: ["confirm_password"],
});
type PwForm = z.infer<typeof pwSchema>;

export default function ProfilePage() {
  const user = useAuthStore((s) => s.user);
  const [showPw, setShowPw] = useState(false);

  const { register, handleSubmit, reset, formState: { errors } } = useForm<PwForm>({
    resolver: zodResolver(pwSchema),
  });

  const changePasswordMutation = useMutation({
    mutationFn: ({ old_password, new_password }: PwForm) =>
      profileAPI.changePassword(old_password, new_password),
    onSuccess: () => {
      toast.success("Password changed successfully");
      reset();
    },
    onError: (err: { response?: { data?: { detail?: string | string[] } } }) => {
      const detail = err?.response?.data?.detail;
      toast.error(Array.isArray(detail) ? detail.join(" ") : detail || "Failed to change password");
    },
  });

  const toggleMFAMutation = useMutation({
    mutationFn: (enable: boolean) => profileAPI.toggleMFA(enable),
    onSuccess: () => {
      toast.success("MFA settings updated");
      useAuthStore.setState((state) =>
        state.user
          ? { user: { ...state.user, mfa_enabled: !state.user.mfa_enabled } }
          : state
      );
    },
    onError: () => toast.error("Failed to update MFA"),
  });

  if (!user) return null;

  return (
    <div className="max-w-2xl mx-auto py-10 px-6 space-y-8">
      <div>
        <div className="flex items-center gap-3 mb-2">
          <div className="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center">
            <UserCircle className="w-5 h-5 text-primary" />
          </div>
          <h1 className="text-2xl font-bold text-foreground tracking-tight">My profile</h1>
        </div>
        <p className="text-muted-foreground text-sm">Manage your account settings and security.</p>
      </div>

      {/* Identity card */}
      <div className="card p-6">
        <div className="flex items-center gap-4 mb-5">
          <div className="w-14 h-14 rounded-full bg-primary text-primary-foreground flex items-center justify-center text-xl font-bold">
            {user.first_name[0]}{user.last_name[0]}
          </div>
          <div>
            <h2 className="text-lg font-semibold text-foreground">
              {user.first_name} {user.last_name}
            </h2>
            <p className="text-sm text-muted-foreground">{user.email}</p>
            <span className="badge bg-accent/15 text-accent-foreground mt-1">
              {user.job_description || "Staff"}
            </span>
          </div>
        </div>
        <dl className="grid grid-cols-2 gap-3 text-sm pt-5 border-t border-border">
          {[
            { label: "Job description", value: user.job_description || "—" },
            { label: "Department", value: user.department?.name ?? "—" },
            { label: "MFA",        value: user.mfa_enabled ? "Enabled" : "Not enabled" },
          ].map(({ label, value }) => (
            <div key={label}>
              <dt className="text-xs uppercase tracking-wider text-muted-foreground">{label}</dt>
              <dd className="font-medium text-foreground mt-1">{value}</dd>
            </div>
          ))}
        </dl>
      </div>

      {/* Change password */}
      <div className="card p-6">
        <div className="flex items-center gap-2 mb-5">
          <Key className="w-5 h-5 text-muted-foreground" />
          <h2 className="font-semibold text-foreground">Change password</h2>
        </div>
        <form
          onSubmit={handleSubmit((v) => changePasswordMutation.mutate(v))}
          className="space-y-4"
        >
          <div>
            <label className="label">Current password</label>
            <div className="relative">
              <input
                {...register("old_password")}
                type={showPw ? "text" : "password"}
                className="input pr-10"
                placeholder="••••••••"
              />
              <button
                type="button"
                onClick={() => setShowPw(!showPw)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              >
                {showPw ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              </button>
            </div>
            {errors.old_password && (
              <p className="text-destructive text-xs mt-1">{errors.old_password.message}</p>
            )}
          </div>
          <div>
            <label className="label">New password</label>
            <input
              {...register("new_password")}
              type={showPw ? "text" : "password"}
              className="input"
              placeholder="Min 8 characters"
            />
            {errors.new_password && (
              <p className="text-destructive text-xs mt-1">{errors.new_password.message}</p>
            )}
          </div>
          <div>
            <label className="label">Confirm new password</label>
            <input
              {...register("confirm_password")}
              type={showPw ? "text" : "password"}
              className="input"
              placeholder="Repeat new password"
            />
            {errors.confirm_password && (
              <p className="text-destructive text-xs mt-1">{errors.confirm_password.message}</p>
            )}
          </div>
          <button
            type="submit"
            disabled={changePasswordMutation.isPending}
            className="btn-primary"
          >
            {changePasswordMutation.isPending && <Loader2 className="w-4 h-4 animate-spin" />}
            Update password
          </button>
        </form>
      </div>

      {/* MFA */}
      <div className="card p-6">
        <div className="flex items-center gap-2 mb-2">
          <Smartphone className="w-5 h-5 text-muted-foreground" />
          <h2 className="font-semibold text-foreground">Two-factor authentication</h2>
          {user.mfa_enabled && (
            <span className="badge bg-teal/15 text-teal ml-auto">Enabled</span>
          )}
        </div>
        <p className="text-sm text-muted-foreground mb-5">
          Email OTP is used as your second authentication factor during login.
        </p>

        {!user.mfa_enabled && (
          <button
            onClick={() => toggleMFAMutation.mutate(true)}
            disabled={toggleMFAMutation.isPending}
            className="btn-primary"
          >
            {toggleMFAMutation.isPending && <Loader2 className="w-4 h-4 animate-spin" />}
            <Shield className="w-4 h-4" /> Enable MFA
          </button>
        )}

        {user.mfa_enabled && (
          <div className="space-y-3">
            <div className="flex items-start gap-2 bg-accent/10 border border-accent/30 rounded-lg p-3">
              <AlertTriangle className="w-4 h-4 text-accent-foreground mt-0.5 flex-shrink-0" />
              <p className="text-sm text-foreground">
                Disabling MFA reduces your account security. Only do this if you
                are switching authenticator apps.
              </p>
            </div>
            <button
              onClick={() => toggleMFAMutation.mutate(false)}
              disabled={toggleMFAMutation.isPending}
              className="btn-danger"
            >
              {toggleMFAMutation.isPending && <Loader2 className="w-4 h-4 animate-spin" />}
              Disable MFA
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
