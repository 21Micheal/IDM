import { useState, useEffect } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useSearchParams } from "react-router-dom";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { profileAPI, documentTypesAPI } from "@/services/api";
import SignaturePanel from "@/components/profile/SignaturePanel";
import { useAuthStore } from "@/store/authStore";
import {
  Shield, Key, Smartphone,
  Loader2, Eye, EyeOff, AlertTriangle,
  Building2, Mail, Briefcase, ShieldCheck,
  Calendar, UserCheck,
  ChevronRight, Settings, Users, ArrowLeftRight,
  Bell, Monitor, Globe, FileSignature,
} from "lucide-react";
import { toast } from "@/components/ui/vault-toast";
import clsx from "clsx";

const pwSchema = z.object({
  old_password:     z.string().min(1, "Required"),
  new_password:     z.string().min(8, "Min 8 characters"),
  confirm_password: z.string(),
}).refine((d) => d.new_password === d.confirm_password, {
  message: "Passwords do not match",
  path: ["confirm_password"],
});
type PwForm = z.infer<typeof pwSchema>;
type DelegationForm = { delegate_id: string; starts_at: string; ends_at: string; comment: string; document_type_id: string | null };

interface Delegation {
  id: string;
  delegate: { id: string; full_name?: string; email: string };
  starts_at: string;
  ends_at: string;
  comment: string;
  document_type_name?: string | null;
  is_active: boolean;
  is_current: boolean;
}

interface UserOption {
  id: string;
  full_name: string;
  email: string;
}

interface DocumentTypeOption {
  id: string;
  name: string;
  code: string;
}

interface UserPreferences {
  date_format: string;
  time_format: string;
  default_page: string;
  notify_document_approvals: boolean;
  notify_document_rejected: boolean;
  notify_task_assignments: boolean;
  notify_system_announcements: boolean;
}

type ProfileTab = "settings" | "security" | "signature" | "delegation" | "preferences";

export default function ProfilePage() {
  const [searchParams] = useSearchParams();
  const user = useAuthStore((s) => s.user);
  const qc = useQueryClient();
  const [activeTab, setActiveTab] = useState<ProfileTab>("settings");
  const [showPw, setShowPw] = useState(false);
  const [showPasswordForm, setShowPasswordForm] = useState(false);
  const [delegationForm, setDelegationForm] = useState<DelegationForm>({
    delegate_id: "",
    starts_at: "",
    ends_at: "",
    comment: "",
    document_type_id: null,
  });

  // Handle URL parameter for tab navigation
  useEffect(() => {
    const tabParam = searchParams.get("tab") as ProfileTab;
    if (tabParam && ["settings", "security", "signature", "delegation", "preferences"].includes(tabParam)) {
      setActiveTab(tabParam);
    }
  }, [searchParams]);

  const { register, handleSubmit, reset, formState: { errors } } = useForm<PwForm>({
    resolver: zodResolver(pwSchema),
  });

  const changePasswordMutation = useMutation({
    mutationFn: ({ old_password, new_password }: PwForm) =>
      profileAPI.changePassword(old_password, new_password),
    onSuccess: () => {
      toast.success("Password changed successfully");
      reset();
      setShowPasswordForm(false);
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

  const { data: delegations = [] } = useQuery<Delegation[]>({
    queryKey: ["delegations", "mine"],
    queryFn: () => profileAPI.listDelegations().then((r) => r.data.results ?? r.data),
    enabled: Boolean(user),
  });

  const { data: delegationCandidates = [] } = useQuery<UserOption[]>({
    queryKey: ["delegations", "candidates"],
    queryFn: () => profileAPI.delegationCandidates().then((r) => r.data),
    enabled: Boolean(user),
  });

  const { data: documentTypes = [] } = useQuery<DocumentTypeOption[]>({
    queryKey: ["documentTypes"],
    queryFn: () => documentTypesAPI.list().then((r) => r.data.results ?? r.data),
    enabled: Boolean(user),
  });

  const { data: preferences, isLoading: preferencesLoading } = useQuery<UserPreferences>({
    queryKey: ["preferences"],
    queryFn: () => profileAPI.getPreferences().then((r) => r.data),
    enabled: Boolean(user),
  });

  const createDelegationMutation = useMutation({
    mutationFn: () => profileAPI.createDelegation(delegationForm),
    onSuccess: () => {
      toast.success("Delegation created");
      setDelegationForm({ delegate_id: "", starts_at: "", ends_at: "", comment: "", document_type_id: null });
      qc.invalidateQueries({ queryKey: ["delegations"] });
    },
    onError: (err: { response?: { data?: { detail?: string } } }) =>
      toast.error(err?.response?.data?.detail || "Failed to create delegation"),
  });

  const updatePreferencesMutation = useMutation({
    mutationFn: (data: Partial<UserPreferences>) => profileAPI.updatePreferences(data),
    onMutate: async (newData: Partial<UserPreferences>) => {
      await qc.cancelQueries({ queryKey: ["preferences"] });
      const previous = qc.getQueryData<UserPreferences>(["preferences"]);
      qc.setQueryData<UserPreferences>(["preferences"], (old) => ({ ...(old ?? {}), ...newData } as UserPreferences));
      return { previous };
    },
    onError: (err, newData, context: any) => {
      toast.error("Failed to update preferences");
      if (context?.previous) {
        qc.setQueryData(["preferences"], context.previous);
      }
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ["preferences"] });
    },
    onSuccess: () => {
      toast.success("Preferences updated");
    },
  });

  const disableDelegationMutation = useMutation({
    mutationFn: (delegationId: string) => profileAPI.updateDelegation(delegationId, { is_active: false }),
    onSuccess: () => {
      toast.success("Delegation disabled");
      qc.invalidateQueries({ queryKey: ["delegations"] });
    },
    onError: () => toast.error("Failed to disable delegation"),
  });

  const tabs = [
    { id: "settings" as const, label: "Settings", icon: Settings, description: "Account & password" },
    { id: "security" as const, label: "Security", icon: ShieldCheck, description: "MFA & authentication" },
    { id: "signature" as const, label: "Signature", icon: FileSignature, description: "E-signature" },
    { id: "delegation" as const, label: "Delegation", icon: UserCheck, description: "Out of office tasks" },
    { id: "preferences" as const, label: "Preferences", icon: Monitor, description: "Display & notifications" },
  ];

  if (!user) return null;

  return (
    <div className={clsx("mx-auto py-6 px-4 space-y-6", activeTab === "signature" ? "max-w-7xl" : "max-w-6xl")}>
      {/* Page Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground">My Profile</h1>
          <p className="text-sm text-muted-foreground mt-1">Manage your account, security, and preferences</p>
        </div>
      </div>

      <div className="grid grid-cols-12 gap-6">
        {/* Left Column - User Info (fully hidden on signature tab so right column takes full width) */}
        <div className={clsx(
          "space-y-4",
          activeTab === "signature"
            ? "hidden"
            : "col-span-12 lg:col-span-4"
        )}>
          {/* Profile Card - Unifi Style */}
          <div className="card overflow-hidden">
            {/* Profile Header with Accent */}
            <div className="bg-gradient-to-br from-primary/90 to-primary p-6 pb-12">
              <div className="flex items-center gap-4">
                <div className="w-16 h-16 rounded-xl bg-white/20 backdrop-blur flex items-center justify-center text-2xl font-bold text-white shadow-lg">
                  {user.first_name[0]}{user.last_name[0]}
                </div>
                <div className="text-white">
                  <h2 className="text-lg font-bold">{user.first_name} {user.last_name}</h2>
                  <p className="text-sm text-primary-foreground/80">{user.job_description || "Staff"}</p>
                </div>
              </div>
            </div>

            {/* Profile Details */}
            <div className="px-6 pb-6 -mt-6">
              <div className="bg-card rounded-xl border border-border p-4 space-y-3">
                {/* Department */}
                <div className="flex items-center gap-3">
                  <Building2 className="w-4 h-4 text-muted-foreground" />
                  <div>
                    <p className="text-xs text-muted-foreground">Department</p>
                    <p className="text-sm font-medium text-foreground">
                      {user.department_name || user.department?.name || "No Department"}
                    </p>
                  </div>
                </div>

                {/* Job Description */}
                <div className="flex items-center gap-3">
                  <Briefcase className="w-4 h-4 text-muted-foreground" />
                  <div>
                    <p className="text-xs text-muted-foreground">Job Description</p>
                    <p className="text-sm font-medium text-foreground">
                      {user.job_description || "—"}
                    </p>
                  </div>
                </div>

                {/* Email */}
                <div className="flex items-center gap-3">
                  <Mail className="w-4 h-4 text-muted-foreground" />
                  <div>
                    <p className="text-xs text-muted-foreground">Email</p>
                    <p className="text-sm font-medium text-foreground truncate">{user.email}</p>
                  </div>
                </div>

                {/* Role */}
                <div className="flex items-center gap-3">
                  <ShieldCheck className="w-4 h-4 text-muted-foreground" />
                  <div>
                    <p className="text-xs text-muted-foreground">Role</p>
                    <p className="text-sm font-medium text-foreground">
                      {user.has_admin_access ? "System Administrator" : "Standard User"}
                    </p>
                  </div>
                </div>

                {/* MFA Status */}
                <div className="flex items-center gap-3">
                  <Smartphone className="w-4 h-4 text-muted-foreground" />
                  <div>
                    <p className="text-xs text-muted-foreground">Multi Factor Authentication</p>
                    <div className="flex items-center gap-2 mt-0.5">
                      <span className={clsx(
                        "inline-flex items-center gap-1.5 text-xs font-medium px-2 py-0.5 rounded-full",
                        user.mfa_enabled 
                          ? "bg-teal/10 text-teal border border-teal/20" 
                          : "bg-muted text-muted-foreground border border-border"
                      )}>
                        <span className={clsx(
                          "w-1.5 h-1.5 rounded-full",
                          user.mfa_enabled ? "bg-teal" : "bg-muted-foreground"
                        )} />
                        {user.mfa_enabled ? "Enabled" : "Not enabled"}
                      </span>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* Quick Actions */}
          <div className="card p-4 space-y-2">
            <h3 className="text-sm font-semibold text-foreground mb-3 flex items-center gap-2">
              <Settings className="w-4 h-4 text-muted-foreground" />
              Quick Settings
            </h3>
            {[
              { icon: Key, label: "Change Password", action: () => { setActiveTab("settings"); setShowPasswordForm(true); }, color: "text-amber-500" },
              { icon: Shield, label: "Security Settings", action: () => setActiveTab("security"), color: "text-blue-500" },
              { icon: FileSignature, label: "E-Signature", action: () => setActiveTab("signature"), color: "text-teal-500" },
              { icon: UserCheck, label: "Manage Delegations", action: () => setActiveTab("delegation"), color: "text-emerald-500" },
              { icon: Bell, label: "Notification Preferences", action: () => setActiveTab("preferences"), color: "text-violet-500" },
            ].map((item, i) => (
              <button
                key={i}
                onClick={item.action}
                className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg hover:bg-muted/50 transition-colors group text-left"
              >
                <item.icon className={clsx("w-4 h-4 flex-shrink-0", item.color)} />
                <span className="text-sm text-foreground flex-1">{item.label}</span>
                <ChevronRight className="w-4 h-4 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity" />
              </button>
            ))}
          </div>
        </div>

        {/* Right Column - Main Content (full width on signature tab) */}
        <div className={clsx("col-span-12", activeTab === "signature" ? "lg:col-span-12" : "lg:col-span-8")}>
          {/* Tab Navigation */}
          <div className="card mb-4">
            <div className="flex border-b border-border">
              {tabs.map((tab) => (
                <button
                  key={tab.id}
                  onClick={() => setActiveTab(tab.id)}
                  className={clsx(
                    "flex-1 px-4 py-3 text-sm font-medium transition-all relative",
                    "hover:bg-muted/30",
                    activeTab === tab.id
                      ? "text-primary border-b-2 border-primary bg-primary/5"
                      : "text-muted-foreground"
                  )}
                >
                  <div className="flex items-center gap-2 justify-center">
                    <tab.icon className="w-4 h-4" />
                    <span className="hidden sm:inline">{tab.label}</span>
                  </div>
                  <p className="text-[10px] text-muted-foreground hidden md:block mt-0.5">
                    {tab.description}
                  </p>
                </button>
              ))}
            </div>
          </div>

          {/* Tab Content */}
          <div className="space-y-4">
            {/* Settings Tab */}
            {activeTab === "settings" && (
              <div className="card p-6">
                <div className="flex items-center gap-3 mb-6">
                  <div className="w-10 h-10 rounded-lg bg-amber-100 flex items-center justify-center">
                    <Key className="w-5 h-5 text-amber-600" />
                  </div>
                  <div>
                    <h3 className="text-lg font-semibold text-foreground">Change Password</h3>
                    <p className="text-sm text-muted-foreground">Update your account password</p>
                  </div>
                </div>

                {!showPasswordForm ? (
                  <div className="text-center py-8">
                    <Key className="w-16 h-16 text-muted-foreground/20 mx-auto mb-4" />
                    <p className="text-sm text-muted-foreground mb-4">Keep your account secure with a strong password</p>
                    <button
                      onClick={() => setShowPasswordForm(true)}
                      className="btn-primary"
                    >
                      Change password
                    </button>
                  </div>
                ) : (
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
                          placeholder="Enter current password"
                          autoComplete="current-password"
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

                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                      <div>
                        <label className="label">New password</label>
                        <input
                          {...register("new_password")}
                          type={showPw ? "text" : "password"}
                          className="input"
                          placeholder="Min 8 characters"
                          autoComplete="new-password"
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
                          autoComplete="new-password"
                        />
                        {errors.confirm_password && (
                          <p className="text-destructive text-xs mt-1">{errors.confirm_password.message}</p>
                        )}
                      </div>
                    </div>

                    <div className="flex items-center gap-3 pt-2">
                      <button
                        type="submit"
                        disabled={changePasswordMutation.isPending}
                        className="btn-primary"
                      >
                        {changePasswordMutation.isPending && <Loader2 className="w-4 h-4 animate-spin" />}
                        Update password
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setShowPasswordForm(false);
                          reset();
                        }}
                        className="btn-secondary"
                      >
                        Cancel
                      </button>
                    </div>
                  </form>
                )}
              </div>
            )}

            {/* Security Tab */}
            {activeTab === "security" && (
              <div className="card p-6">
                <div className="flex items-center gap-3 mb-6">
                  <div className="w-10 h-10 rounded-lg bg-blue-100 flex items-center justify-center">
                    <ShieldCheck className="w-5 h-5 text-blue-600" />
                  </div>
                  <div>
                    <h3 className="text-lg font-semibold text-foreground">Two-Factor Authentication</h3>
                    <p className="text-sm text-muted-foreground">Add an extra layer of security to your account</p>
                  </div>
                </div>

                <div className={clsx(
                  "rounded-xl border-2 p-6",
                  user.mfa_enabled ? "border-teal/30 bg-teal/[0.03]" : "border-border bg-muted/[0.3]"
                )}>
                  <div className="flex items-start justify-between">
                    <div className="flex-1">
                      <div className="flex items-center gap-3 mb-3">
                        <Smartphone className={clsx(
                          "w-6 h-6",
                          user.mfa_enabled ? "text-teal" : "text-muted-foreground"
                        )} />
                        <div>
                          <p className="font-semibold text-foreground">Email OTP Authentication</p>
                          <p className="text-sm text-muted-foreground mt-0.5">
                            One-time passwords sent to your email during login
                          </p>
                        </div>
                      </div>

                      {user.mfa_enabled && (
                        <div className="flex items-start gap-2 mt-4 p-3 bg-amber-50 border border-amber-200 rounded-lg">
                          <AlertTriangle className="w-4 h-4 text-amber-600 mt-0.5 flex-shrink-0" />
                          <p className="text-sm text-amber-700">
                            Disabling MFA reduces your account security. Only do this if you're switching authentication methods.
                          </p>
                        </div>
                      )}
                    </div>

                    <button
                      disabled={true}
                      className={clsx(
                        "px-6 py-2.5 rounded-xl text-sm font-medium transition-all flex items-center gap-2",
                        "border-2 border-muted text-muted-foreground opacity-50 cursor-not-allowed"
                      )}
                    >
                      {user.mfa_enabled ? (
                        <>
                          <Shield className="w-4 h-4" />
                          MFA Enabled
                        </>
                      ) : (
                        <>
                          <Shield className="w-4 h-4" />
                          MFA Disabled
                        </>
                      )}
                    </button>
                  </div>
                </div>
              </div>
            )}

            {activeTab === "signature" && <SignaturePanel />}


            {/* Delegation Tab */}
            {activeTab === "delegation" && (
              <div className="space-y-4">
                {/* Create Delegation */}
                <div className="card p-6">
                  <div className="flex items-center gap-3 mb-6">
                    <div className="w-10 h-10 rounded-lg bg-emerald-100 flex items-center justify-center">
                      <ArrowLeftRight className="w-5 h-5 text-emerald-600" />
                    </div>
                    <div>
                      <h3 className="text-lg font-semibold text-foreground">Out of Office Delegation</h3>
                      <p className="text-sm text-muted-foreground">Assign your workflow tasks to another user temporarily</p>
                    </div>
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
                    <div>
                      <label className="label">Delegate to</label>
                      <select
                        className="input"
                        value={delegationForm.delegate_id}
                        onChange={(e) => setDelegationForm((s) => ({ ...s, delegate_id: e.target.value }))}
                      >
                        <option value="">Select user</option>
                        {delegationCandidates.map((candidate) => (
                          <option key={candidate.id} value={candidate.id}>
                            {candidate.full_name || candidate.email}
                          </option>
                        ))}
                      </select>
                    </div>

                    <div>
                      <label className="label">Document Type Filter</label>
                      <select
                        className="input"
                        value={delegationForm.document_type_id || ""}
                        onChange={(e) => setDelegationForm((s) => ({ ...s, document_type_id: e.target.value || null }))}
                      >
                        <option value="">All Tasks</option>
                        {documentTypes.map((dt) => (
                          <option key={dt.id} value={dt.id}>
                            {dt.name} ({dt.code})
                          </option>
                        ))}
                      </select>
                      <p className="text-xs text-muted-foreground mt-1">
                        Leave empty to delegate all tasks, or select a specific document type
                      </p>
                    </div>

                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <label className="label">Start date</label>
                        <input
                          type="datetime-local"
                          className="input"
                          value={delegationForm.starts_at}
                          onChange={(e) => setDelegationForm((s) => ({ ...s, starts_at: e.target.value }))}
                        />
                      </div>
                      <div>
                        <label className="label">End date</label>
                        <input
                          type="datetime-local"
                          className="input"
                          value={delegationForm.ends_at}
                          onChange={(e) => setDelegationForm((s) => ({ ...s, ends_at: e.target.value }))}
                        />
                      </div>
                    </div>
                  </div>

                  <div className="mb-4">
                    <label className="label">Reason for delegation</label>
                    <textarea
                      className="input h-20 resize-none"
                      value={delegationForm.comment}
                      onChange={(e) => setDelegationForm((s) => ({ ...s, comment: e.target.value }))}
                      placeholder="Explain why you are delegating these tasks..."
                    />
                  </div>

                  <button
                    className="btn-primary"
                    disabled={
                      !delegationForm.delegate_id ||
                      !delegationForm.starts_at ||
                      !delegationForm.ends_at ||
                      !delegationForm.comment.trim() ||
                      createDelegationMutation.isPending
                    }
                    onClick={() => createDelegationMutation.mutate()}
                  >
                    {createDelegationMutation.isPending && <Loader2 className="w-4 h-4 animate-spin" />}
                    Create delegation
                  </button>
                </div>

                {/* Active Delegations */}
                <div className="card p-6">
                  <div className="flex items-center gap-3 mb-6">
                    <div className="w-10 h-10 rounded-lg bg-violet-100 flex items-center justify-center">
                      <UserCheck className="w-5 h-5 text-violet-600" />
                    </div>
                    <div>
                      <h3 className="text-lg font-semibold text-foreground">Active Delegations</h3>
                      <p className="text-sm text-muted-foreground">Currently active or scheduled delegations</p>
                    </div>
                  </div>

                  {!delegations.length ? (
                    <div className="text-center py-12">
                      <Users className="w-12 h-12 text-muted-foreground/20 mx-auto mb-3" />
                      <p className="text-sm font-medium text-foreground">No delegations set</p>
                      <p className="text-xs text-muted-foreground mt-1">Create a delegation when you'll be away</p>
                    </div>
                  ) : (
                    <div className="space-y-3">
                      {delegations.map((delegation) => (
                        <div
                          key={delegation.id}
                          className={clsx(
                            "flex items-start justify-between p-4 rounded-xl border transition-colors",
                            delegation.is_current
                              ? "border-teal/30 bg-teal/[0.03]"
                              : delegation.is_active
                                ? "border-border bg-card hover:border-muted-foreground/20"
                                : "border-border bg-muted/30 opacity-60"
                          )}
                        >
                          <div className="flex items-start gap-3">
                            <div className="w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center flex-shrink-0">
                              <UserCheck className="w-4 h-4 text-primary" />
                            </div>
                            <div>
                              <p className="font-medium text-foreground">
                                {delegation.delegate.full_name || delegation.delegate.email}
                              </p>
                              <div className="flex items-center gap-2 mt-1">
                                <Calendar className="w-3.5 h-3.5 text-muted-foreground" />
                                <span className="text-xs text-muted-foreground">
                                  {new Date(delegation.starts_at).toLocaleDateString()} - {new Date(delegation.ends_at).toLocaleDateString()}
                                </span>
                              </div>
                              {delegation.document_type_name && (
                                <div className="flex items-center gap-2 mt-1">
                                  <Globe className="w-3.5 h-3.5 text-muted-foreground" />
                                  <span className="text-xs text-muted-foreground">
                                    {delegation.document_type_name}
                                  </span>
                                </div>
                              )}
                              {delegation.comment && (
                                <p className="text-sm text-muted-foreground mt-2">{delegation.comment}</p>
                              )}
                            </div>
                          </div>
                          <div className="flex items-center gap-2 flex-shrink-0">
                            <span className={clsx(
                              "text-xs px-2.5 py-1 rounded-full font-medium",
                              delegation.is_current
                                ? "bg-teal/10 text-teal border border-teal/20"
                                : delegation.is_active
                                  ? "bg-blue/10 text-blue border border-blue/20"
                                  : "bg-muted text-muted-foreground border border-border"
                            )}>
                              {delegation.is_current ? "Active now" : delegation.is_active ? "Scheduled" : "Ended"}
                            </span>
                            {delegation.is_active && (
                              <button
                                onClick={() => disableDelegationMutation.mutate(delegation.id)}
                                disabled={disableDelegationMutation.isPending}
                                className="px-3 py-1.5 text-xs font-medium border border-destructive/30 text-destructive rounded-lg hover:bg-destructive/5 transition-colors"
                              >
                                {disableDelegationMutation.isPending ? (
                                  <Loader2 className="w-3 h-3 animate-spin" />
                                ) : (
                                  "End"
                                )}
                              </button>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* Preferences Tab */}
            {activeTab === "preferences" && (
              <div className="space-y-4">
                {/* Display Preferences */}
                <div className="card p-6">
                  <div className="flex items-center gap-3 mb-6">
                    <div className="w-10 h-10 rounded-lg bg-violet-100 flex items-center justify-center">
                      <Monitor className="w-5 h-5 text-violet-600" />
                    </div>
                    <div>
                      <h3 className="text-lg font-semibold text-foreground">Display Preferences</h3>
                      <p className="text-sm text-muted-foreground">Customize your viewing experience</p>
                    </div>
                  </div>

                  <div className="space-y-4">
                    <div className="flex items-center justify-between py-3 border-b border-border">
                      <div>
                        <p className="font-medium text-foreground">Date format</p>
                        <p className="text-sm text-muted-foreground">Choose how dates are displayed</p>
                      </div>
                      <select
                        className="input w-auto"
                        value={preferences?.date_format || "DD/MM/YYYY"}
                        onChange={(e) => updatePreferencesMutation.mutate({ date_format: e.target.value })}
                        disabled={preferencesLoading || updatePreferencesMutation.isPending}
                      >
                        <option value="DD/MM/YYYY">DD/MM/YYYY</option>
                        <option value="MM/DD/YYYY">MM/DD/YYYY</option>
                        <option value="YYYY-MM-DD">YYYY-MM-DD</option>
                      </select>
                    </div>

                    <div className="flex items-center justify-between py-3 border-b border-border">
                      <div>
                        <p className="font-medium text-foreground">Time format</p>
                        <p className="text-sm text-muted-foreground">12-hour or 24-hour clock</p>
                      </div>
                      <select
                        className="input w-auto"
                        value={preferences?.time_format || "12-hour"}
                        onChange={(e) => updatePreferencesMutation.mutate({ time_format: e.target.value })}
                        disabled={preferencesLoading || updatePreferencesMutation.isPending}
                      >
                        <option value="12-hour">12-hour</option>
                        <option value="24-hour">24-hour</option>
                      </select>
                    </div>

                    <div className="flex items-center justify-between py-3">
                      <div>
                        <p className="font-medium text-foreground">On launch, go to</p>
                        <p className="text-sm text-muted-foreground">Default page when you log in</p>
                      </div>
                      <select
                        className="input w-auto"
                        value={preferences?.default_page || "dashboard"}
                        onChange={(e) => updatePreferencesMutation.mutate({ default_page: e.target.value })}
                        disabled={preferencesLoading || updatePreferencesMutation.isPending}
                      >
                        <option value="dashboard">Dashboard</option>
                        <option value="my_tasks">My Tasks</option>
                        <option value="all_documents">All Documents</option>
                      </select>
                    </div>
                  </div>
                </div>

                {/* Notification Preferences */}
                <div className="card p-6">
                  <div className="flex items-center gap-3 mb-6">
                    <div className="w-10 h-10 rounded-lg bg-orange-100 flex items-center justify-center">
                      <Bell className="w-5 h-5 text-orange-600" />
                    </div>
                    <div>
                      <h3 className="text-lg font-semibold text-foreground">Email Notifications</h3>
                      <p className="text-sm text-muted-foreground">Manage your notification preferences</p>
                    </div>
                  </div>

                  <div className="space-y-4">
                    {[
                      { label: "Document approvals", description: "When a document requires your approval", key: "notify_document_approvals" },
                      { label: "Document rejected", description: "When your document is rejected", key: "notify_document_rejected" },
                      { label: "Task assignments", description: "When a task is assigned to you", key: "notify_task_assignments" },
                      { label: "System announcements", description: "Important system updates and news", key: "notify_system_announcements" },
                    ].map((item) => (
                      <div key={item.key} className="flex items-center justify-between py-3 border-b border-border last:border-0">
                        <div>
                          <p className="font-medium text-foreground">{item.label}</p>
                          <p className="text-sm text-muted-foreground">{item.description}</p>
                        </div>
                        <label className="relative inline-flex items-center cursor-pointer">
                          <input
                            type="checkbox"
                            className="sr-only peer"
                            checked={
                              preferences?.[item.key as keyof UserPreferences] === undefined
                                ? true
                                : !!preferences?.[item.key as keyof UserPreferences]
                            }
                            onChange={(e) => updatePreferencesMutation.mutate({ [item.key]: e.target.checked })}
                            disabled={preferencesLoading || updatePreferencesMutation.isPending}
                          />
                          <div className="w-11 h-6 bg-muted rounded-full peer peer-checked:bg-primary peer-checked:after:translate-x-full after:content-[''] after:absolute after:top-0.5 after:left-[2px] after:bg-white after:rounded-full after:h-5 after:w-5 after:transition-all"></div>
                        </label>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}