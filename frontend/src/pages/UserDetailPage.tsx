import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useParams } from "react-router-dom";
import { usersAPI, departmentsAPI, profileAPI } from "@/services/api";
import { ArrowLeft, Loader2, UserCircle } from "lucide-react";
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
  last_login: string | null;
  created_at: string;
}

interface Delegation {
  id: string;
  delegate: { id: string; full_name?: string; email: string };
  starts_at: string;
  ends_at: string;
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
  });

  const { data: users = [] } = useQuery<User[]>({
    queryKey: ["users", "all"],
    queryFn: () => usersAPI.list().then((r) => r.data.results ?? r.data),
  });

  const { data: departments = [] } = useQuery<Department[]>({
    queryKey: ["departments"],
    queryFn: () => departmentsAPI.list().then((r) => r.data.results ?? r.data),
  });

  const { data: delegations = [] } = useQuery<Delegation[]>({
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
      qc.invalidateQueries({ queryKey: ["users"] });
      qc.invalidateQueries({ queryKey: ["users", "detail", id] });
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
    mutationFn: (delegationId: string) => profileAPI.updateDelegation(delegationId, { is_active: false }),
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
      <div className="max-w-6xl mx-auto py-8 flex items-center gap-2 text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading user...
      </div>
    );
  }

  return (
    <div className="max-w-6xl mx-auto py-8 space-y-6">
      <button type="button" className="btn-secondary" onClick={() => navigate("/admin/users")}>
        <ArrowLeft className="w-4 h-4" /> Back to users
      </button>

      <div className="card p-6">
        <div className="flex items-center gap-3 mb-5">
          <UserCircle className="w-8 h-8 text-primary" />
          <div>
            <h1 className="text-2xl font-bold text-foreground">{user.full_name}</h1>
            <p className="text-sm text-muted-foreground">{user.email}</p>
          </div>
        </div>
        <p className="text-sm text-muted-foreground">
          Joined {format(new Date(user.created_at), "dd MMM yyyy")} · Last login{" "}
          {user.last_login ? format(new Date(user.last_login), "dd MMM yyyy HH:mm") : "Never"}
        </p>
      </div>

      <div className="card p-6 space-y-4">
        <h2 className="font-semibold text-foreground">User settings</h2>
        <div className="grid grid-cols-2 gap-3">
          <input className="input" value={form.first_name} onChange={(e) => setForm((s) => ({ ...s, first_name: e.target.value }))} />
          <input className="input" value={form.last_name} onChange={(e) => setForm((s) => ({ ...s, last_name: e.target.value }))} />
        </div>
        <textarea
          className="input"
          rows={3}
          value={form.job_description}
          onChange={(e) => setForm((s) => ({ ...s, job_description: e.target.value }))}
        />
        <select className="input" value={form.department} onChange={(e) => setForm((s) => ({ ...s, department: e.target.value }))}>
          <option value="">No department</option>
          {departments.map((d) => (
            <option key={d.id} value={d.id}>
              {d.name}
            </option>
          ))}
        </select>
        <label className="text-sm flex items-center gap-2">
          <input
            type="checkbox"
            checked={form.is_active}
            onChange={(e) => setForm((s) => ({ ...s, is_active: e.target.checked }))}
          />
          Account active
        </label>
        <div className="flex gap-2">
          <button className="btn-primary" onClick={() => updateMutation.mutate()} disabled={updateMutation.isPending}>
            {updateMutation.isPending && <Loader2 className="w-4 h-4 animate-spin" />} Save
          </button>
          <button className="btn-secondary" onClick={() => resetPwMutation.mutate()} disabled={resetPwMutation.isPending}>
            Reset password
          </button>
          <button className="btn-secondary" onClick={() => toggleActiveMutation.mutate()} disabled={toggleActiveMutation.isPending}>
            {user.is_active ? "Deactivate" : "Activate"}
          </button>
        </div>
      </div>

      <div className="card p-6 space-y-4">
        <h2 className="font-semibold text-foreground">Delegations</h2>
        {!delegations.length && <p className="text-sm text-muted-foreground">No delegations configured.</p>}
        {delegations.map((d) => (
          <div key={d.id} className="border border-border rounded-lg p-3 flex items-center justify-between gap-3">
            <div className="text-sm">
              <p className="font-medium text-foreground">{d.delegate.full_name || d.delegate.email}</p>
              <p className="text-muted-foreground">
                {format(new Date(d.starts_at), "dd MMM yyyy HH:mm")} to {format(new Date(d.ends_at), "dd MMM yyyy HH:mm")}
              </p>
            </div>
            <div className="flex items-center gap-2">
              <span className="badge">{d.is_current ? "Active now" : d.is_active ? "Scheduled" : "Disabled"}</span>
              {d.is_active && (
                <button className="btn-secondary" onClick={() => disableDelegationMutation.mutate(d.id)}>
                  Disable
                </button>
              )}
            </div>
          </div>
        ))}
      </div>

      <div className="card p-6 space-y-3">
        <h2 className="font-semibold text-foreground">Reassign active tasks</h2>
        <p className="text-sm text-muted-foreground">
          Reassign all active tasks currently assigned to this user to another user.
        </p>
        <div className="flex gap-3">
          <select className="input" value={reassignTo} onChange={(e) => setReassignTo(e.target.value)}>
            <option value="">Select target user</option>
            {reassignCandidates.map((candidate) => (
              <option key={candidate.id} value={candidate.id}>
                {candidate.full_name} ({candidate.email})
              </option>
            ))}
          </select>
          <button
            className="btn-primary"
            disabled={!reassignTo || reassignMutation.isPending}
            onClick={() => reassignMutation.mutate()}
          >
            {reassignMutation.isPending && <Loader2 className="w-4 h-4 animate-spin" />}
            Reassign
          </button>
        </div>
      </div>
    </div>
  );
}
