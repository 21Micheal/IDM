import { useEffect, useState } from "react";
import { extractApiError } from "@/lib/apiError";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useParams } from "react-router-dom";
import { usersAPI, departmentsAPI, profileAPI } from "@/services/api";
import {
  ArrowLeft,
  Loader2,
  UserCircle,
  Mail,
  Building2,
  ShieldCheck,
  ShieldAlert,
  KeyRound,
  Power,
  Save,
  Calendar,
  Clock,
  Users as UsersIcon,
  ArrowRightLeft,
  CheckCircle2,
  CircleSlash,
  CalendarClock,
} from "lucide-react";
import CustomListbox from "@/components/ui/CustomListbox";
import { toast } from "@/components/ui/vault-toast";
import { TemporaryPasswordModal } from "@/components/users/TemporaryPasswordModal";
import {
  DelegationList,
  DelegationScheduleForm,
  type DelegationRecord,
} from "@/components/users/DelegationManager";
import { format } from "date-fns";

interface Department {
  id: string;
  name: string;
}

interface User {
  id: string;
  email: string;
  first_name: string;
  last_name: string;
  full_name: string;
  job_description: string;
  department: string | null;
  department_name: string | null;
  is_active: boolean;
  mfa_enabled: boolean;
  group_names?: string[];
  last_login: string | null;
  created_at: string;
}

export default function UserDetailPage() {
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [reassignTo, setReassignTo] = useState("");
  const [resetPassword, setResetPassword] = useState<string | null>(null);

  const { data: user, isLoading } = useQuery<User>({
    queryKey: ["users", "detail", id],
    queryFn: () => usersAPI.get(id).then((r) => r.data),
    enabled: Boolean(id),
    staleTime: 1000 * 60 * 2,
  });

  const { data: users = [] } = useQuery<User[]>({
    queryKey: ["users", "all"],
    queryFn: () => usersAPI.list().then((r) => r.data.results ?? r.data),
    staleTime: 1000 * 60 * 2,
  });

  const { data: departments = [] } = useQuery<Department[]>({
    queryKey: ["departments"],
    queryFn: () => departmentsAPI.list().then((r) => r.data.results ?? r.data),
    staleTime: 1000 * 60 * 5,
  });

  const { data: delegations = [] } = useQuery<DelegationRecord[]>({
    queryKey: ["users", "delegations", id],
    queryFn: () => usersAPI.delegations(id).then((r) => r.data),
    enabled: Boolean(id),
  });

  const [form, setForm] = useState({
    first_name: "",
    last_name: "",
    job_description: "",
    department: "",
    is_active: true,
  });

  useEffect(() => {
    if (!user) return;
    setForm({
      first_name: user.first_name,
      last_name: user.last_name,
      job_description: user.job_description || "",
      department: user.department || "",
      is_active: user.is_active,
    });
  }, [user]);

  const updateMutation = useMutation({
    mutationFn: () =>
      usersAPI.update(id, {
        ...form,
        department: form.department || null,
      }),
    onSuccess: () => {
      toast.success("User settings updated");
      qc.invalidateQueries({ queryKey: ["users"] });
      qc.invalidateQueries({ queryKey: ["users", "detail", id] });
    },
    onError: (err) => toast.error(extractApiError(err, "Failed to update user")),
  });

  const resetPwMutation = useMutation({
    mutationFn: () => usersAPI.resetPassword(id),
    onSuccess: (res: any) => {
      const temp = res?.data?.temporary_password;
      if (temp) {
        // Surface the password to the admin — outbound email may not be
        // delivered, so this is the reliable channel to hand it to the user.
        setResetPassword(temp);
      } else {
        toast.success("Temporary password generated and emailed");
      }
    },
    onError: (err) => toast.error(extractApiError(err, "Failed to reset password")),
  });

  const toggleActiveMutation = useMutation({
    mutationFn: () => usersAPI.toggleActive(id),
    onSuccess: () => {
      toast.success("User status updated");
      qc.invalidateQueries({ queryKey: ["users"], exact: false });
      qc.invalidateQueries({ queryKey: ["users", "detail", id], exact: true });
    },
    onError: (err) => toast.error(extractApiError(err, "Failed to toggle status")),
  });

  const reassignMutation = useMutation({
    mutationFn: () => usersAPI.reassignActiveTasks(id, reassignTo),
    onSuccess: (res) => {
      toast.success(res.data.detail || "Tasks reassigned");
      setReassignTo("");
    },
    onError: (err) => toast.error(extractApiError(err, "Failed to reassign active tasks")),
  });

  const disableDelegationMutation = useMutation({
    mutationFn: (delegationId: string) =>
      profileAPI.updateDelegation(delegationId, { is_active: false }),
    onSuccess: () => {
      toast.success("Delegation disabled");
      qc.invalidateQueries({ queryKey: ["users", "delegations", id] });
      qc.invalidateQueries({ queryKey: ["delegations"] });
    },
    onError: (err) => toast.error(extractApiError(err, "Failed to disable delegation")),
  });

  const dismissDelegationMutation = useMutation({
    mutationFn: (delegationId: string) =>
      profileAPI.dismissDelegation(delegationId),
    onMutate: async (delegationId) => {
      await qc.cancelQueries({ queryKey: ["users", "delegations", id] });
      const previous = qc.getQueryData<DelegationRecord[]>(["users", "delegations", id]);
      qc.setQueryData<DelegationRecord[]>(["users", "delegations", id], (old) =>
        (old ?? []).filter((d) => d.id !== delegationId)
      );
      return { previous };
    },
    onError: (err, delegationId, context: any) => {
      toast.error(extractApiError(err, "Failed to dismiss delegation"));
      if (context?.previous) {
        qc.setQueryData(["users", "delegations", id], context.previous);
      }
    },
    onSettled: () => {
      qc.refetchQueries({ queryKey: ["users", "delegations", id] });
    },
  });

  const reassignCandidates = users.filter((u) => u.id !== id && u.is_active);

  if (isLoading || !user) {
    return (
      <div className="max-w-6xl mx-auto py-12 flex items-center justify-center gap-2 text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading user...
      </div>
    );
  }

  const initials = `${user.first_name?.[0] ?? ""}${user.last_name?.[0] ?? ""}`.toUpperCase();

  return (
    <div className="admin-shell space-y-5">
      {/* Back nav */}
      <button
        type="button"
        onClick={() => navigate("/admin/users")}
        className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
      >
        <ArrowLeft className="w-4 h-4" /> Back to users
      </button>

      {/* Identity card — clean slate, no gradient */}
      <div className="overflow-hidden border border-[#C8CDD2] bg-white">
        <div className="p-6 sm:p-8">
          <div className="flex flex-col sm:flex-row sm:items-start gap-6">
            {/* Avatar */}
            <div className="h-20 w-20 sm:h-24 sm:w-24 rounded-2xl bg-muted flex items-center justify-center text-2xl font-bold text-muted-foreground flex-shrink-0">
              {initials || <UserCircle className="w-10 h-10" />}
            </div>

            {/* Name + badges + contact */}
            <div className="flex-1 min-w-0 space-y-3">
              {/* Row 1: name + status badges */}
              <div className="flex flex-wrap items-center gap-2">
                <h1 className="text-2xl sm:text-3xl font-semibold tracking-tight text-foreground">
                  {user.full_name}
                </h1>
                <span className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-[11px] font-medium border ${
                  user.is_active
                    ? "bg-emerald-500/10 text-emerald-600 border-emerald-500/20"
                    : "bg-muted text-muted-foreground border-border"
                }`}>
                  {user.is_active ? (
                    <><CheckCircle2 className="w-3 h-3" /> Active</>
                  ) : (
                    <><CircleSlash className="w-3 h-3" /> Disabled</>
                  )}
                </span>
                <span className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-[11px] font-medium border ${
                  user.mfa_enabled
                    ? "bg-primary/10 text-primary border-primary/20"
                    : "bg-amber-500/10 text-amber-600 border-amber-500/20"
                }`}>
                  {user.mfa_enabled ? (
                    <><ShieldCheck className="w-3 h-3" /> MFA on</>
                  ) : (
                    <><ShieldAlert className="w-3 h-3" /> MFA off</>
                  )}
                </span>
              </div>

              {/* Row 2: email + department */}
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted-foreground">
                <span className="inline-flex items-center gap-1.5">
                  <Mail className="w-3.5 h-3.5 flex-shrink-0" />
                  {user.email}
                </span>
                {user.department_name && (
                  <span className="inline-flex items-center gap-1.5">
                    <Building2 className="w-3.5 h-3.5 flex-shrink-0" />
                    {user.department_name}
                  </span>
                )}
              </div>

              {/* Row 3: groups — clean pills below, not overlapping */}
              {!!user.group_names?.length && (
                <div className="flex flex-wrap items-center gap-1.5 pt-1">
                  <UsersIcon className="w-3.5 h-3.5 text-muted-foreground flex-shrink-0" />
                  {user.group_names.map((g) => (
                    <span
                      key={g}
                      className="inline-flex items-center px-2 py-0.5 rounded-md text-[11px] font-medium bg-muted text-muted-foreground border border-border"
                    >
                      {g}
                    </span>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* Timestamps */}
          <div className="mt-6 pt-5 border-t border-border grid sm:grid-cols-2 gap-3 text-sm">
            <div className="flex items-center gap-2 text-muted-foreground">
              <Calendar className="w-4 h-4 flex-shrink-0" />
              Joined{" "}
              <span className="text-foreground font-medium">
                {format(new Date(user.created_at), "dd MMM yyyy")}
              </span>
            </div>
            <div className="flex items-center gap-2 text-muted-foreground">
              <Clock className="w-4 h-4 flex-shrink-0" />
              Last login{" "}
              <span className="text-foreground font-medium">
                {user.last_login
                  ? format(new Date(user.last_login), "dd MMM yyyy HH:mm")
                  : "Never"}
              </span>
            </div>
          </div>
        </div>
      </div>

      {/* Settings & Danger zone grid */}
      <div className="grid lg:grid-cols-3 gap-6">
        {/* User settings */}
        <section className="lg:col-span-2 rounded-2xl border border-border bg-card shadow-sm">
          <header className="px-6 py-4 border-b border-border">
            <h2 className="font-semibold text-foreground">User settings</h2>
            <p className="text-xs text-muted-foreground mt-0.5">
              Update profile details and account access.
            </p>
          </header>

          <div className="p-6 space-y-5">
            <div className="grid sm:grid-cols-2 gap-4">
              <div>
                <label className="block text-xs font-medium text-muted-foreground mb-1.5">
                  First name
                </label>
                <input
                  className="w-full h-10 rounded-lg border border-input bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring focus:border-ring transition-colors"
                  value={form.first_name}
                  onChange={(e) =>
                    setForm((s) => ({ ...s, first_name: e.target.value }))
                  }
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-muted-foreground mb-1.5">
                  Last name
                </label>
                <input
                  className="w-full h-10 rounded-lg border border-input bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring focus:border-ring transition-colors"
                  value={form.last_name}
                  onChange={(e) =>
                    setForm((s) => ({ ...s, last_name: e.target.value }))
                  }
                />
              </div>
            </div>

            <div>
              <label className="block text-xs font-medium text-muted-foreground mb-1.5">
                Job description
              </label>
              <textarea
                rows={3}
                className="w-full rounded-lg border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring focus:border-ring transition-colors resize-none"
                value={form.job_description}
                onChange={(e) =>
                  setForm((s) => ({ ...s, job_description: e.target.value }))
                }
                placeholder="Role responsibilities, scope, etc."
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-muted-foreground mb-1.5">
                Department
              </label>
              <CustomListbox
                value={form.department ?? ""}
                onChange={(v) => setForm((s) => ({ ...s, department: v || "" }))}
                options={[
                  { value: "", label: "No department" },
                  ...departments.map((d) => ({ value: d.id, label: d.name })),
                ]}
                buttonClassName="w-full h-10 rounded-lg border border-input bg-background px-3 text-sm text-left focus:outline-none focus:ring-2 focus:ring-ring focus:border-ring transition-colors"
                ariaLabel="Department"
              />
              <div className="flex items-center gap-3 mt-3">
                <input
                  type="checkbox"
                  className="h-4 w-4 accent-primary"
                  checked={form.is_active}
                  onChange={(e) =>
                    setForm((s) => ({ ...s, is_active: e.target.checked }))
                  }
                />
                <div>
                  <p className="text-sm font-medium text-foreground">Account active</p>
                  <p className="text-xs text-muted-foreground">
                    When disabled, the user cannot sign in.
                  </p>
                </div>
              </div>
            </div>

            <div className="flex flex-wrap gap-2 pt-2">
              <button
                onClick={() => updateMutation.mutate()}
                disabled={updateMutation.isPending}
                className="inline-flex items-center gap-2 h-10 px-4 rounded-lg bg-primary text-primary-foreground text-sm font-medium shadow-sm hover:bg-primary/90 transition-colors disabled:opacity-70"
              >
                {updateMutation.isPending ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <Save className="w-4 h-4" />
                )}
                Save changes
              </button>
              <button
                onClick={() => resetPwMutation.mutate()}
                disabled={resetPwMutation.isPending}
                className="inline-flex items-center gap-2 h-10 px-4 rounded-lg border border-border bg-background text-sm font-medium hover:bg-muted transition-colors disabled:opacity-70"
              >
                {resetPwMutation.isPending ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <KeyRound className="w-4 h-4" />
                )}
                Reset password
              </button>
              <button
                onClick={() => toggleActiveMutation.mutate()}
                disabled={toggleActiveMutation.isPending}
                className={`inline-flex items-center gap-2 h-10 px-4 rounded-lg border text-sm font-medium transition-colors disabled:opacity-70 ${
                  user.is_active
                    ? "border-destructive/30 bg-destructive/5 text-destructive hover:bg-destructive/10"
                    : "border-emerald-500/30 bg-emerald-500/5 text-emerald-600 hover:bg-emerald-500/10"
                }`}
              >
                {toggleActiveMutation.isPending ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <Power className="w-4 h-4" />
                )}
                {user.is_active ? "Deactivate" : "Activate"}
              </button>
            </div>
          </div>
        </section>

        {/* Reassign tasks */}
        <section className="rounded-2xl border border-border bg-card shadow-sm flex flex-col">
          <header className="px-6 py-4 border-b border-border">
            <h2 className="font-semibold text-foreground flex items-center gap-2">
              <ArrowRightLeft className="w-4 h-4 text-muted-foreground" />
              Reassign tasks
            </h2>
            <p className="text-xs text-muted-foreground mt-0.5">
              Move all active tasks owned by this user to another active user.
            </p>
          </header>
          <div className="p-6 space-y-3 flex-1 flex flex-col">
            <CustomListbox
              value={reassignTo}
              onChange={setReassignTo}
              options={[
                { value: "", label: "Select target user" },
                ...reassignCandidates.map((c) => ({ value: c.id, label: `${c.full_name} (${c.email})` })),
              ]}
              buttonClassName="w-full h-10 rounded-lg border border-input bg-background px-3 text-sm text-left focus:outline-none focus:ring-2 focus:ring-ring focus:border-ring transition-colors"
              ariaLabel="Reassign user"
            />
            <button
              onClick={() => reassignMutation.mutate()}
              disabled={!reassignTo || reassignMutation.isPending}
              className="inline-flex items-center justify-center gap-2 h-10 px-4 rounded-lg bg-primary text-primary-foreground text-sm font-medium shadow-sm hover:bg-primary/90 transition-colors disabled:opacity-50"
            >
              {reassignMutation.isPending ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <ArrowRightLeft className="w-4 h-4" />
              )}
              Reassign active tasks
            </button>
            <p className="text-[11px] text-muted-foreground mt-auto pt-2">
              This action is logged in the audit trail.
            </p>
          </div>
        </section>
      </div>

      {/* Delegations */}
      <section className="rounded-2xl border border-border bg-card shadow-sm">
        <header className="px-6 py-4 border-b border-border">
          <h2 className="font-semibold text-foreground flex items-center gap-2">
            <CalendarClock className="w-4 h-4 text-muted-foreground" />
            Delegations
          </h2>
          <p className="text-xs text-muted-foreground mt-1">
            Schedule out-of-office task delegation on behalf of {user.full_name}.
          </p>
        </header>

        <div className="p-6 space-y-6">
          <DelegationScheduleForm
            delegatorId={id}
            delegatorName={user.full_name}
            onCreated={() => qc.invalidateQueries({ queryKey: ["users", "delegations", id] })}
          />
          <DelegationList
            delegations={delegations}
            onDisable={(delegationId) => disableDelegationMutation.mutate(delegationId)}
            onDismiss={(delegationId) => dismissDelegationMutation.mutate(delegationId)}
            disablePending={disableDelegationMutation.isPending}
            dismissPending={dismissDelegationMutation.isPending}
            emptyMessage="No delegations configured for this user."
          />
        </div>
      </section>

      {resetPassword && (
        <TemporaryPasswordModal
          temporary_password={resetPassword}
          title="Password Reset"
          subtitle={`New temporary password for ${user.full_name}`}
          onClose={() => setResetPassword(null)}
        />
      )}
    </div>
  );
}
