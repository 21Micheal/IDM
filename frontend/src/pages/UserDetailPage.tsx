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
      // Keep My Tasks in sync for the assignee (same session) without a full reload.
      // Delegation already feels instant because it creates a notification that
      // refreshes the tray; reassignment must invalidate the task list directly.
      void qc.invalidateQueries({ queryKey: ["workflow", "my-tasks"] });
      void qc.invalidateQueries({ queryKey: ["notifications"] });
      void qc.invalidateQueries({ queryKey: ["notifications", "summary"] });
      void qc.invalidateQueries({ queryKey: ["notifications", "unread-count"] });
      void qc.invalidateQueries({ queryKey: ["signature-requests"] });
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
    <div className="admin-shell space-y-4">
      {/* Back nav */}
      <button
        type="button"
        onClick={() => navigate("/admin/users")}
        className="inline-flex items-center gap-1.5 text-xs font-medium text-[#5E6870] hover:text-[#1F2933] transition-colors"
      >
        <ArrowLeft className="w-4 h-4" /> Back to users
      </button>

      {/* Identity card */}
      <div className="border border-[#C8CDD2] bg-white">
        <div className="p-6">
          <div className="flex flex-col sm:flex-row sm:items-start gap-5">
            {/* Avatar */}
            <div className="h-16 w-16 flex-shrink-0 bg-[#EEF6FB] border border-[#C8CDD2] flex items-center justify-center text-xl font-bold text-[#287EAD]">
              {initials || <UserCircle className="w-8 h-8" />}
            </div>

            {/* Name + badges + contact */}
            <div className="flex-1 min-w-0 space-y-2">
              <div className="flex flex-wrap items-center gap-2">
                <h1 className="text-xl font-bold text-[#1F2933]">{user.full_name}</h1>
                <span className={`inline-flex items-center gap-1 px-2 py-0.5 text-[11px] font-semibold border ${
                  user.is_active
                    ? "bg-emerald-50 text-emerald-700 border-emerald-200"
                    : "bg-[#F5F7F8] text-[#5E6870] border-[#C8CDD2]"
                }`}>
                  {user.is_active ? <><CheckCircle2 className="w-3 h-3" /> Active</> : <><CircleSlash className="w-3 h-3" /> Disabled</>}
                </span>
                <span className={`inline-flex items-center gap-1 px-2 py-0.5 text-[11px] font-semibold border ${
                  user.mfa_enabled
                    ? "bg-[#EEF6FB] text-[#287EAD] border-[#287EAD]/30"
                    : "bg-amber-50 text-amber-700 border-amber-200"
                }`}>
                  {user.mfa_enabled ? <><ShieldCheck className="w-3 h-3" /> MFA on</> : <><ShieldAlert className="w-3 h-3" /> MFA off</>}
                </span>
              </div>

              <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-[#5E6870]">
                <span className="inline-flex items-center gap-1.5"><Mail className="w-3.5 h-3.5 flex-shrink-0" />{user.email}</span>
                {user.department_name && (
                  <span className="inline-flex items-center gap-1.5"><Building2 className="w-3.5 h-3.5 flex-shrink-0" />{user.department_name}</span>
                )}
              </div>

              {!!user.group_names?.length && (
                <div className="flex flex-wrap items-center gap-1.5 pt-1">
                  <UsersIcon className="w-3.5 h-3.5 text-[#8C969E] flex-shrink-0" />
                  {user.group_names.map((g) => (
                    <span key={g} className="inline-flex items-center px-2 py-0.5 text-[11px] font-medium bg-[#F5F7F8] text-[#5E6870] border border-[#C8CDD2]">
                      {g}
                    </span>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* Timestamps */}
          <div className="mt-5 pt-4 border-t border-[#E4E7EB] grid sm:grid-cols-2 gap-3 text-xs text-[#5E6870]">
            <div className="flex items-center gap-2">
              <Calendar className="w-3.5 h-3.5 flex-shrink-0" />
              Joined <span className="text-[#1F2933] font-semibold">{format(new Date(user.created_at), "dd MMM yyyy")}</span>
            </div>
            <div className="flex items-center gap-2">
              <Clock className="w-3.5 h-3.5 flex-shrink-0" />
              Last login <span className="text-[#1F2933] font-semibold">
                {user.last_login ? format(new Date(user.last_login), "dd MMM yyyy HH:mm") : "Never"}
              </span>
            </div>
          </div>
        </div>
      </div>

      {/* Settings & Reassign grid */}
      <div className="grid lg:grid-cols-3 gap-4">
        {/* User settings */}
        <section className="lg:col-span-2 border border-[#C8CDD2] bg-white">
          <header className="px-5 py-3.5 border-b border-[#C8CDD2] bg-[#F5F7F8]">
            <h2 className="text-sm font-bold text-[#1F2933]">User settings</h2>
            <p className="text-[11px] text-[#5E6870] mt-0.5">Update profile details and account access.</p>
          </header>

          <div className="p-5 space-y-4">
            <div className="grid sm:grid-cols-2 gap-4">
              <div>
                <label className="block text-[11px] font-semibold text-[#5E6870] uppercase tracking-wider mb-1.5">First name</label>
                <input
                  className="w-full h-9 border border-[#C8CDD2] bg-white px-3 text-sm text-[#1F2933] focus:outline-none focus:border-[#287EAD] transition-colors"
                  value={form.first_name}
                  onChange={(e) => setForm((s) => ({ ...s, first_name: e.target.value }))}
                />
              </div>
              <div>
                <label className="block text-[11px] font-semibold text-[#5E6870] uppercase tracking-wider mb-1.5">Last name</label>
                <input
                  className="w-full h-9 border border-[#C8CDD2] bg-white px-3 text-sm text-[#1F2933] focus:outline-none focus:border-[#287EAD] transition-colors"
                  value={form.last_name}
                  onChange={(e) => setForm((s) => ({ ...s, last_name: e.target.value }))}
                />
              </div>
            </div>

            <div>
              <label className="block text-[11px] font-semibold text-[#5E6870] uppercase tracking-wider mb-1.5">Job description</label>
              <textarea
                rows={3}
                className="w-full border border-[#C8CDD2] bg-white px-3 py-2 text-sm text-[#1F2933] focus:outline-none focus:border-[#287EAD] transition-colors resize-none"
                value={form.job_description}
                onChange={(e) => setForm((s) => ({ ...s, job_description: e.target.value }))}
                placeholder="Role responsibilities, scope, etc."
              />
            </div>

            <div>
              <label className="block text-[11px] font-semibold text-[#5E6870] uppercase tracking-wider mb-1.5">Department</label>
              <CustomListbox
                value={form.department ?? ""}
                onChange={(v) => setForm((s) => ({ ...s, department: v || "" }))}
                options={[
                  { value: "", label: "No department" },
                  ...departments.map((d) => ({ value: d.id, label: d.name })),
                ]}
                buttonClassName="w-full h-9 border border-[#C8CDD2] bg-white px-3 text-sm text-[#1F2933] text-left focus:outline-none focus:border-[#287EAD] transition-colors"
                ariaLabel="Department"
              />
              <div className="flex items-center gap-3 mt-3">
                <input
                  type="checkbox"
                  className="h-4 w-4 accent-[#287EAD]"
                  checked={form.is_active}
                  onChange={(e) => setForm((s) => ({ ...s, is_active: e.target.checked }))}
                />
                <div>
                  <p className="text-xs font-semibold text-[#1F2933]">Account active</p>
                  <p className="text-[11px] text-[#5E6870]">When disabled, the user cannot sign in.</p>
                </div>
              </div>
            </div>

            <div className="flex flex-wrap gap-2 pt-1">
              <button
                onClick={() => updateMutation.mutate()}
                disabled={updateMutation.isPending}
                className="inline-flex items-center gap-1.5 h-9 px-4 bg-[#287EAD] text-white text-xs font-semibold hover:bg-[#206D99] transition-colors disabled:opacity-60"
              >
                {updateMutation.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
                Save changes
              </button>
              <button
                onClick={() => resetPwMutation.mutate()}
                disabled={resetPwMutation.isPending}
                className="inline-flex items-center gap-1.5 h-9 px-4 border border-[#C8CDD2] bg-white text-xs font-semibold text-[#1F2933] hover:bg-[#F5F7F8] transition-colors disabled:opacity-60"
              >
                {resetPwMutation.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <KeyRound className="w-3.5 h-3.5" />}
                Reset password
              </button>
              <button
                onClick={() => toggleActiveMutation.mutate()}
                disabled={toggleActiveMutation.isPending}
                className={`inline-flex items-center gap-1.5 h-9 px-4 border text-xs font-semibold transition-colors disabled:opacity-60 ${
                  user.is_active
                    ? "border-red-200 bg-red-50 text-red-700 hover:bg-red-100"
                    : "border-emerald-200 bg-emerald-50 text-emerald-700 hover:bg-emerald-100"
                }`}
              >
                {toggleActiveMutation.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Power className="w-3.5 h-3.5" />}
                {user.is_active ? "Deactivate" : "Activate"}
              </button>
            </div>
          </div>
        </section>

        {/* Reassign tasks */}
        <section className="border border-[#C8CDD2] bg-white flex flex-col">
          <header className="px-5 py-3.5 border-b border-[#C8CDD2] bg-[#F5F7F8]">
            <h2 className="text-sm font-bold text-[#1F2933] flex items-center gap-2">
              <ArrowRightLeft className="w-4 h-4 text-[#287EAD]" /> Reassign tasks
            </h2>
            <p className="text-[11px] text-[#5E6870] mt-0.5">
              Move all active workflow tasks and pending signature requests owned by this user to another active user.
            </p>
          </header>
          <div className="p-5 space-y-3 flex-1 flex flex-col">
            <CustomListbox
              value={reassignTo}
              onChange={setReassignTo}
              options={[
                { value: "", label: "Select target user" },
                ...reassignCandidates.map((c) => ({ value: c.id, label: `${c.full_name} (${c.email})` })),
              ]}
              buttonClassName="w-full h-9 border border-[#C8CDD2] bg-white px-3 text-sm text-[#1F2933] text-left focus:outline-none focus:border-[#287EAD] transition-colors"
              ariaLabel="Reassign user"
            />
            <button
              onClick={() => reassignMutation.mutate()}
              disabled={!reassignTo || reassignMutation.isPending}
              className="inline-flex items-center justify-center gap-1.5 h-9 px-4 bg-[#287EAD] text-white text-xs font-semibold hover:bg-[#206D99] transition-colors disabled:opacity-50"
            >
              {reassignMutation.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <ArrowRightLeft className="w-3.5 h-3.5" />}
              Reassign active tasks
            </button>
            <p className="text-[11px] text-[#8C969E] mt-auto pt-2">This action is logged in the audit trail.</p>
          </div>
        </section>
      </div>

      {/* Delegations */}
      <section className="border border-[#C8CDD2] bg-white">
        <header className="px-5 py-3.5 border-b border-[#C8CDD2] bg-[#F5F7F8]">
          <h2 className="text-sm font-bold text-[#1F2933] flex items-center gap-2">
            <CalendarClock className="w-4 h-4 text-[#287EAD]" /> Delegations
          </h2>
          <p className="text-[11px] text-[#5E6870] mt-0.5">
            Schedule out-of-office task delegation on behalf of {user.full_name}.
          </p>
        </header>
        <div className="p-5 space-y-5">
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

