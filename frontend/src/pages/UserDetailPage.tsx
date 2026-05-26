// @ts-nocheck
/**
 * UserDetailPage.tsx
 *
 * Admin view of a single user — restyled with Flaxem IDM design language.
 * All data fetching, mutations, and business logic preserved exactly.
 */
import { useEffect, useState } from "react";
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
import { toast } from "@/components/ui/vault-toast";
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

interface Delegation {
  id: string;
  delegate: { id: string; full_name?: string; email: string };
  starts_at: string;
  ends_at: string;
  comment: string;
  is_active: boolean;
  is_current: boolean;
}

export default function UserDetailPage() {
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [reassignTo, setReassignTo] = useState("");

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

  const { data: delegations = [] } = useQuery<Delegation[]>({
    queryKey: ["users", "delegations", id],
    queryFn: () => usersAPI.delegations(id).then((r) => r.data),
    enabled: Boolean(id),
    staleTime: 1000 * 60 * 2,
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
    onError: () => toast.error("Failed to update user"),
  });

  const resetPwMutation = useMutation({
    mutationFn: () => usersAPI.resetPassword(id),
    onSuccess: () => toast.success("Temporary password generated and emailed"),
    onError: () => toast.error("Failed to reset password"),
  });

  const toggleActiveMutation = useMutation({
    mutationFn: () => usersAPI.toggleActive(id),
    onSuccess: () => {
      toast.success("User status updated");
      qc.invalidateQueries({ queryKey: ["users"], exact: false });
      qc.invalidateQueries({ queryKey: ["users", "detail", id], exact: true });
    },
    onError: () => toast.error("Failed to toggle status"),
  });

  const reassignMutation = useMutation({
    mutationFn: () => usersAPI.reassignActiveTasks(id, reassignTo),
    onSuccess: (res) => {
      toast.success(res.data.detail || "Tasks reassigned");
      setReassignTo("");
    },
    onError: () => toast.error("Failed to reassign active tasks"),
  });

  const disableDelegationMutation = useMutation({
    mutationFn: (delegationId: string) =>
      profileAPI.updateDelegation(delegationId, { is_active: false }),
    onSuccess: () => {
      toast.success("Delegation disabled");
      qc.invalidateQueries({ queryKey: ["users", "delegations", id] });
      qc.invalidateQueries({ queryKey: ["delegations"] });
    },
    onError: () => toast.error("Failed to disable delegation"),
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
              <select
                className="w-full h-10 rounded-lg border border-input bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring focus:border-ring transition-colors"
                value={form.department}
                onChange={(e) =>
                  setForm((s) => ({ ...s, department: e.target.value }))
                }
              >
                <option value="">No department</option>
                {departments.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name}
                  </option>
                ))}
              </select>
            </div>

            <label className="flex items-center justify-between rounded-lg border border-border bg-muted/30 px-4 py-3">
              <div>
                <p className="text-sm font-medium text-foreground">Account active</p>
                <p className="text-xs text-muted-foreground">
                  When disabled, the user cannot sign in.
                </p>
              </div>
              <input
                type="checkbox"
                className="h-4 w-4 accent-primary"
                checked={form.is_active}
                onChange={(e) =>
                  setForm((s) => ({ ...s, is_active: e.target.checked }))
                }
              />
            </label>

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
            <select
              className="w-full h-10 rounded-lg border border-input bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring focus:border-ring transition-colors"
              value={reassignTo}
              onChange={(e) => setReassignTo(e.target.value)}
            >
              <option value="">Select target user</option>
              {reassignCandidates.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.full_name} ({c.email})
                </option>
              ))}
            </select>
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
        <header className="px-6 py-4 border-b border-border flex items-center justify-between">
          <div>
            <h2 className="font-semibold text-foreground flex items-center gap-2">
              <CalendarClock className="w-4 h-4 text-muted-foreground" />
              Delegations
            </h2>
          </div>
          <span className="text-xs text-muted-foreground">
            {delegations.length} configured
          </span>
        </header>

        <div className="p-6 space-y-3">
          {!delegations.length && (
            <div className="rounded-lg border border-dashed border-border bg-muted/20 px-6 py-10 text-center">
              <CalendarClock className="w-6 h-6 text-muted-foreground/60 mx-auto mb-2" />
              <p className="text-sm text-muted-foreground">
                No delegations configured for this user.
              </p>
            </div>
          )}

          {delegations.map((d) => {
            const status = d.is_current
              ? { label: "Active now", tone: "bg-emerald-500/10 text-emerald-600 border-emerald-500/20" }
              : d.is_active
              ? { label: "Scheduled", tone: "bg-primary/10 text-primary border-primary/20" }
              : { label: "Disabled", tone: "bg-muted text-muted-foreground border-border" };

            return (
              <div
                key={d.id}
                className="rounded-xl border border-border bg-background hover:border-muted-foreground/20 transition-colors p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3"
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <p className="font-medium text-foreground truncate">
                      {d.delegate.full_name || d.delegate.email}
                    </p>
                    <span
                      className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium border ${status.tone}`}
                    >
                      {status.label}
                    </span>
                  </div>
                  <p className="text-xs text-muted-foreground mt-1">
                    {format(new Date(d.starts_at), "dd MMM yyyy HH:mm")} →{" "}
                    {format(new Date(d.ends_at), "dd MMM yyyy HH:mm")}
                  </p>
                  {d.comment && (
                    <p className="text-xs text-muted-foreground mt-1 italic">
                      "{d.comment}"
                    </p>
                  )}
                </div>
                {d.is_active && (
                  <button
                    onClick={() => disableDelegationMutation.mutate(d.id)}
                    disabled={disableDelegationMutation.isPending}
                    className="inline-flex items-center gap-1.5 h-9 px-3 rounded-lg border border-border bg-background text-xs font-medium hover:bg-muted transition-colors disabled:opacity-70 self-start sm:self-auto"
                  >
                    <CircleSlash className="w-3.5 h-3.5" />
                    Disable
                  </button>
                )}
              </div>
            );
          })}
        </div>
      </section>
    </div>
  );
}
