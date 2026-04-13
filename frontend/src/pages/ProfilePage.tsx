import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { authAPI, profileAPI } from "@/services/api";
import { useAuthStore } from "@/store/authStore";
import {
  Shield, Key, Smartphone, CheckCircle,
  Loader2, Eye, EyeOff, AlertTriangle,
} from "lucide-react";
import { toast } from "react-toastify";
import { format } from "date-fns";

const pwSchema = z.object({
  old_password:     z.string().min(1, "Required"),
  new_password:     z.string().min(8, "Min 8 characters"),
  confirm_password: z.string(),
}).refine((d) => d.new_password === d.confirm_password, {
  message: "Passwords do not match",
  path: ["confirm_password"],
});
type PwForm = z.infer<typeof pwSchema>;

const ROLE_LABELS: Record<string, string> = {
  admin:   "Administrator",
  finance: "Finance staff",
  auditor: "Auditor",
  viewer:  "Viewer",
};

export default function ProfilePage() {
  const user = useAuthStore((s) => s.user);
  const [showPw, setShowPw] = useState(false);
  const [mfaStep, setMfaStep] = useState<"idle" | "qr" | "confirm" | "done">("idle");
  const [qrData, setQrData] = useState<{ qr_code: string; config_url: string } | null>(null);
  const [otpInput, setOtpInput] = useState("");
  const [disablePw, setDisablePw] = useState("");

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

  const setupMFAMutation = useMutation({
    mutationFn: () => profileAPI.setupMFA(),
    onSuccess: ({ data }) => {
      setQrData(data);
      setMfaStep("qr");
    },
    onError: () => toast.error("Could not start MFA setup"),
  });

  const confirmMFAMutation = useMutation({
    mutationFn: () => profileAPI.confirmMFA(otpInput),
    onSuccess: () => {
      toast.success("MFA enabled successfully");
      setMfaStep("done");
    },
    onError: () => toast.error("Invalid code — try again"),
  });

  const disableMFAMutation = useMutation({
    mutationFn: () => profileAPI.disableMFA(disablePw),
    onSuccess: () => {
      toast.success("MFA disabled");
      setDisablePw("");
    },
    onError: (err: { response?: { data?: { detail?: string } } }) =>
      toast.error(err?.response?.data?.detail || "Failed to disable MFA"),
  });

  if (!user) return null;

  return (
    <div className="max-w-2xl space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">My profile</h1>
        <p className="text-gray-500 text-sm mt-1">Manage your account settings and security.</p>
      </div>

      {/* Identity card */}
      <div className="card p-6">
        <div className="flex items-center gap-4 mb-5">
          <div className="w-14 h-14 rounded-full bg-brand-100 flex items-center justify-center text-brand-700 text-xl font-bold">
            {user.first_name[0]}{user.last_name[0]}
          </div>
          <div>
            <h2 className="text-lg font-semibold text-gray-900">
              {user.first_name} {user.last_name}
            </h2>
            <p className="text-sm text-gray-500">{user.email}</p>
            <span className="badge bg-brand-50 text-brand-700 mt-1">
              {ROLE_LABELS[user.role] ?? user.role}
            </span>
          </div>
        </div>
        <dl className="grid grid-cols-2 gap-3 text-sm">
          {[
            { label: "Role",       value: ROLE_LABELS[user.role] ?? user.role },
            { label: "Department", value: user.department?.name ?? "—" },
            { label: "MFA",        value: user.mfa_enabled ? "Enabled" : "Not enabled" },
          ].map(({ label, value }) => (
            <div key={label}>
              <dt className="text-gray-500">{label}</dt>
              <dd className="font-medium text-gray-900 mt-0.5">{value}</dd>
            </div>
          ))}
        </dl>
      </div>

      {/* Change password */}
      <div className="card p-6">
        <div className="flex items-center gap-2 mb-5">
          <Key className="w-5 h-5 text-gray-500" />
          <h2 className="font-semibold text-gray-900">Change password</h2>
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
                className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400"
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
              placeholder="Min 8 characters"
            />
            {errors.new_password && (
              <p className="text-red-500 text-xs mt-1">{errors.new_password.message}</p>
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
              <p className="text-red-500 text-xs mt-1">{errors.confirm_password.message}</p>
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
          <Smartphone className="w-5 h-5 text-gray-500" />
          <h2 className="font-semibold text-gray-900">Two-factor authentication</h2>
          {user.mfa_enabled && (
            <span className="badge bg-green-100 text-green-700 ml-auto">Enabled</span>
          )}
        </div>
        <p className="text-sm text-gray-500 mb-5">
          Use an authenticator app (Google Authenticator, Authy) to generate
          one-time codes at login.
        </p>

        {/* Not enabled — setup flow */}
        {!user.mfa_enabled && (
          <>
            {mfaStep === "idle" && (
              <button
                onClick={() => setupMFAMutation.mutate()}
                disabled={setupMFAMutation.isPending}
                className="btn-primary"
              >
                {setupMFAMutation.isPending && <Loader2 className="w-4 h-4 animate-spin" />}
                <Shield className="w-4 h-4" /> Enable MFA
              </button>
            )}

            {mfaStep === "qr" && qrData && (
              <div className="space-y-4">
                <p className="text-sm text-gray-700 font-medium">
                  1. Scan this QR code with your authenticator app:
                </p>
                <img
                  src={qrData.qr_code}
                  alt="MFA QR code"
                  className="w-48 h-48 border border-gray-200 rounded-lg"
                />
                <p className="text-sm text-gray-700 font-medium">
                  2. Enter the 6-digit code from your app to confirm:
                </p>
                <div className="flex gap-3 items-start">
                  <input
                    value={otpInput}
                    onChange={(e) => setOtpInput(e.target.value.replace(/\D/g, "").slice(0, 6))}
                    className="input w-36 text-center text-xl tracking-widest font-mono"
                    placeholder="000000"
                    maxLength={6}
                    autoFocus
                  />
                  <button
                    onClick={() => confirmMFAMutation.mutate()}
                    disabled={otpInput.length !== 6 || confirmMFAMutation.isPending}
                    className="btn-primary"
                  >
                    {confirmMFAMutation.isPending && <Loader2 className="w-4 h-4 animate-spin" />}
                    Verify & enable
                  </button>
                </div>
              </div>
            )}

            {mfaStep === "done" && (
              <div className="flex items-center gap-2 text-green-600">
                <CheckCircle className="w-5 h-5" />
                <span className="text-sm font-medium">
                  MFA is now active. You'll be asked for a code at your next login.
                </span>
              </div>
            )}
          </>
        )}

        {/* Already enabled — show disable option */}
        {user.mfa_enabled && (
          <div className="space-y-3">
            <div className="flex items-start gap-2 bg-amber-50 border border-amber-200 rounded-lg p-3">
              <AlertTriangle className="w-4 h-4 text-amber-500 mt-0.5 flex-shrink-0" />
              <p className="text-sm text-amber-700">
                Disabling MFA reduces your account security. Only do this if you
                are switching authenticator apps.
              </p>
            </div>
            <div className="flex gap-3 items-center">
              <input
                type="password"
                value={disablePw}
                onChange={(e) => setDisablePw(e.target.value)}
                className="input w-64"
                placeholder="Confirm with your password"
              />
              <button
                onClick={() => disableMFAMutation.mutate()}
                disabled={!disablePw || disableMFAMutation.isPending}
                className="btn-danger"
              >
                {disableMFAMutation.isPending && <Loader2 className="w-4 h-4 animate-spin" />}
                Disable MFA
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
