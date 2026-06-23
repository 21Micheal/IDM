import { useState } from "react";
import { extractApiError } from "@/lib/apiError";
import { useNavigate } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { usersAPI, departmentsAPI } from "@/services/api";
import {
  Plus, Search, KeyRound, Loader2, X, Users as UsersIcon,
} from "lucide-react";
import { toast } from "@/components/ui/vault-toast";
import { format } from "date-fns";
import clsx from "clsx";

// ── Types ─────────────────────────────────────────────────────────────────────
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
  department?: string | null;
  department_name: string | null;
  is_active: boolean;
  mfa_enabled: boolean;
  last_login: string | null;
  created_at: string;
  admin_source?: "account" | "group" | null;
}

// ── Schemas ───────────────────────────────────────────────────────────────────
const createSchema = z.object({
  email: z.string().email("Invalid email"),
  first_name: z.string().min(1, "Required"),
  last_name: z.string().min(1, "Required"),
  job_description: z.string().min(1, "Job description is required").max(255),
  department: z.string().optional(),
});

const editSchema = z.object({
  first_name: z.string().min(1, "Required"),
  last_name: z.string().min(1, "Required"),
  job_description: z.string().min(1, "Job description is required").max(255),
  department: z.string().optional(),
  is_active: z.boolean(),
});

type CreateForm = z.infer<typeof createSchema>;
type EditForm = z.infer<typeof editSchema>;

// ── Temporary Password Modal ─────────────────────────────────────────────────
function TemporaryPasswordModal({
  temporary_password,
  onClose,
}: {
  temporary_password: string;
  onClose: () => void;
}) {
  const [copied, setCopied] = useState(false);

  const copyToClipboard = async () => {
    // navigator.clipboard only exists in a secure context (HTTPS or localhost).
    // Over plain HTTP on a LAN IP it's undefined, so fall back to execCommand.
    let ok = false;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(temporary_password);
        ok = true;
      } else {
        const ta = document.createElement("textarea");
        ta.value = temporary_password;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.focus();
        ta.select();
        ok = document.execCommand("copy");
        document.body.removeChild(ta);
      }
    } catch {
      ok = false;
    }
    if (ok) {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
      toast.success("Password copied to clipboard");
    } else {
      toast.error("Couldn't copy automatically — select and copy it manually.");
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
      <div className="bg-card w-full max-w-md rounded-2xl shadow-xl p-8 space-y-6">
        <div className="flex items-center gap-4">
          <div className="w-12 h-12 bg-accent/10 rounded-2xl flex items-center justify-center">
            <KeyRound className="w-6 h-6 text-accent" />
          </div>
          <div>
            <h2 className="text-xl font-semibold">Temporary Password</h2>
            <p className="text-sm text-muted-foreground">Share this with the new user</p>
          </div>
        </div>

        <div className="bg-muted border border-border rounded-xl p-5">
          <p className="text-xs text-muted-foreground mb-2">One-time password</p>
          <div className="flex items-center justify-between bg-card border border-border rounded-lg px-5 py-4 font-mono text-xl tracking-widest">
            {temporary_password}
            <button
              onClick={copyToClipboard}
              className="text-sm font-medium text-primary hover:underline"
            >
              {copied ? "✓ Copied" : "Copy"}
            </button>
          </div>
        </div>

        <div className="text-sm bg-accent/5 border border-accent/20 rounded-xl p-4">
          The user will be prompted to set a new strong password on first login.<br />
          MFA is enabled by default.
        </div>

        <button onClick={onClose} className="btn-primary w-full">
          I have saved this password
        </button>
      </div>
    </div>
  );
}

// ── Create User Modal ────────────────────────────────────────────────────────
function CreateUserModal({
  departments,
  onClose,
}: {
  departments: Department[];
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const { register, handleSubmit, formState: { errors }, reset } = useForm<CreateForm>({
    resolver: zodResolver(createSchema),
  });

  const [tempPassword, setTempPassword] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: (data: CreateForm) => usersAPI.create(data),
    onSuccess: (response) => {
      const tempPass = response.data.temporary_password;
      if (tempPass) {
        setTempPassword(tempPass);
      } else {
        toast.success("User created successfully");
        onClose();
      }
      qc.invalidateQueries({ queryKey: ["users"] });
    },
    onError: (err: any) => {
      const detail = extractApiError(err, "Failed to create user");
      toast.error(detail);
    },
  });

  const handleClose = () => {
    setTempPassword(null);
    reset();
    onClose();
  };

  return (
    <>
      {!tempPassword && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
          <div className="bg-card w-full max-w-lg rounded-2xl shadow-xl p-8">
            <div className="flex justify-between items-center mb-6">
              <h2 className="text-2xl font-semibold">Create New User</h2>
              <button onClick={onClose} className="text-muted-foreground hover:text-foreground">
                <X className="w-5 h-5" />
              </button>
            </div>

            <form onSubmit={handleSubmit((v) => mutation.mutate(v))} className="space-y-5">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium mb-1.5">First Name *</label>
                  <input {...register("first_name")} className="input" placeholder="John" autoFocus />
                  {errors.first_name && <p className="text-destructive text-xs mt-1">{errors.first_name.message}</p>}
                </div>
                <div>
                  <label className="block text-sm font-medium mb-1.5">Last Name *</label>
                  <input {...register("last_name")} className="input" placeholder="Doe" />
                  {errors.last_name && <p className="text-destructive text-xs mt-1">{errors.last_name.message}</p>}
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium mb-1.5">Email Address *</label>
                <input {...register("email")} type="email" className="input" placeholder="john@company.com" />
                {errors.email && <p className="text-destructive text-xs mt-1">{errors.email.message}</p>}
              </div>

              <div>
                <label className="block text-sm font-medium mb-1.5">Job Description *</label>
                <textarea {...register("job_description")} rows={3} className="input" placeholder="e.g. Accounts Payable Officer" />
                {errors.job_description && <p className="text-destructive text-xs mt-1">{errors.job_description.message}</p>}
              </div>

              <div>
                <label className="block text-sm font-medium mb-1.5">Department</label>
                <select {...register("department")} className="input">
                  <option value="">— None —</option>
                  {departments.map((d) => (
                    <option key={d.id} value={d.id}>{d.name}</option>
                  ))}
                </select>
              </div>

              <button type="submit" disabled={mutation.isPending} className="btn-primary w-full">
                {mutation.isPending && <Loader2 className="w-4 h-4 animate-spin mr-2" />}
                Create User
              </button>
            </form>
          </div>
        </div>
      )}

      {tempPassword && <TemporaryPasswordModal temporary_password={tempPassword} onClose={handleClose} />}
    </>
  );
}

// ── Edit User Modal ──────────────────────────────────────────────────────────
function EditUserModal({
  user,
  departments,
  onClose,
}: {
  user: User;
  departments: Department[];
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const { register, handleSubmit, formState: { errors: _errors } } = useForm<EditForm>({
    resolver: zodResolver(editSchema),
    defaultValues: {
      first_name: user.first_name,
      last_name: user.last_name,
      job_description: user.job_description,
      department: user.department ?? undefined,
      is_active: user.is_active,
    },
  });
  void _errors;

  const mutation = useMutation({
    mutationFn: (data: EditForm) => usersAPI.update(user.id, data),
    onSuccess: () => {
      toast.success("User updated successfully");
      qc.invalidateQueries({ queryKey: ["users"] });
      onClose();
    },
    onError: (err) => toast.error(extractApiError(err, "Failed to update user")),
  });

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
      <div className="bg-card w-full max-w-md rounded-2xl shadow-xl p-8">
        <div className="flex justify-between mb-6">
          <div>
            <h2 className="text-xl font-semibold">Edit User</h2>
            <p className="text-sm text-muted-foreground">{user.email}</p>
          </div>
          <button onClick={onClose}><X className="w-5 h-5" /></button>
        </div>

        <form onSubmit={handleSubmit((v) => mutation.mutate(v))} className="space-y-5">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium mb-1.5">First Name</label>
              <input {...register("first_name")} className="input" />
            </div>
            <div>
              <label className="block text-sm font-medium mb-1.5">Last Name</label>
              <input {...register("last_name")} className="input" />
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium mb-1.5">Job Description</label>
            <textarea {...register("job_description")} rows={3} className="input" />
          </div>

          <div>
            <label className="block text-sm font-medium mb-1.5">Department</label>
            <select {...register("department")} className="input">
              <option value="">— None —</option>
              {departments.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
            </select>
          </div>

          <div className="flex items-center gap-3">
            <input {...register("is_active")} type="checkbox" className="w-5 h-5 accent-primary" />
            <label className="text-sm font-medium">Account is active</label>
          </div>

          <div className="flex gap-3 pt-4">
            <button type="button" onClick={onClose} className="btn-secondary flex-1">Cancel</button>
            <button type="submit" disabled={mutation.isPending} className="btn-primary flex-1">
              {mutation.isPending && <Loader2 className="animate-spin mr-2" />} Save Changes
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ── Main UsersPage ───────────────────────────────────────────────────────────
export default function UsersPage() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [search, setSearch] = useState("");
  const [deptFilter, setDeptFilter] = useState("");
  const [showCreate, setShowCreate] = useState(false);
  const [editUser, setEditUser] = useState<User | null>(null);
  const [pwResult, setPwResult] = useState<{ temporary_password: string } | null>(null);

  const prefetchUserDetail = (userId: string) => {
    qc.prefetchQuery({
      queryKey: ["users", "detail", userId],
      queryFn: () => usersAPI.get(userId).then((r) => r.data),
      staleTime: 1000 * 60 * 2,
    });
    qc.prefetchQuery({
      queryKey: ["users", "delegations", userId],
      queryFn: () => usersAPI.delegations(userId).then((r) => r.data),
      staleTime: 1000 * 60 * 2,
    });
  };

  const { data: users = [], isLoading } = useQuery<User[]>({
    queryKey: ["users", { search, department: deptFilter }],
    queryFn: () =>
      usersAPI.list({
        search: search || undefined,
        department: deptFilter || undefined,
      }).then((r) => r.data.results ?? r.data),
    staleTime: 1000 * 60 * 2,
  });

  const { data: departments = [] } = useQuery<Department[]>({
    queryKey: ["departments"],
    queryFn: () => departmentsAPI.list().then((r) => r.data.results ?? r.data),
    staleTime: 1000 * 60 * 5,
  });

  const _resetPasswordMutation = useMutation<unknown, unknown, string>({
    mutationFn: (id: string) => usersAPI.resetPassword(id),
    onSuccess: (res: any) => setPwResult(res.data),
    onError: (err) => toast.error(extractApiError(err, "Password reset failed")),
  });
  void _resetPasswordMutation;

  const _toggleActiveMutation = useMutation({
    mutationFn: (id: string) => usersAPI.toggleActive(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["users"] });
      toast.success("User status updated");
    },
    onError: (err) => toast.error(extractApiError(err, "Failed to update status")),
  });
  void _toggleActiveMutation;

  return (
    <div className="admin-shell">
      <div className="admin-page-header flex items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-3 mb-2">
            <div className="flex h-10 w-10 items-center justify-center bg-[#EEF6FB]">
              <UsersIcon className="h-5 w-5 text-[#287EAD]" />
            </div>
            <h1 className="admin-page-title">User Management</h1>
          </div>
          <p className="admin-page-subtitle">Manage team members, permissions, and access.</p>
        </div>

        <button
          onClick={() => setShowCreate(true)}
          className="inline-flex items-center gap-2 bg-[#287EAD] px-5 py-2.5 font-medium text-white transition-colors hover:bg-[#206D99]"
        >
          <Plus className="w-4 h-4" />
          Add User
        </button>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap gap-3 mb-6">
        <div className="relative flex-1 min-w-80">
          <Search className="absolute left-4 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by name or email..."
            className="input pl-11 w-full"
          />
        </div>
        <select
          value={deptFilter}
          onChange={(e) => setDeptFilter(e.target.value)}
          className="input w-64"
        >
          <option value="">All Departments</option>
          {departments.map((d) => (
            <option key={d.id} value={d.id}>{d.name}</option>
          ))}
        </select>
      </div>

      {/* Table */}
      <div className="card overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-muted/50">
                <th className="text-left px-6 py-4 font-semibold text-xs uppercase tracking-wider text-muted-foreground">User</th>
                <th className="text-left px-6 py-4 font-semibold text-xs uppercase tracking-wider text-muted-foreground">Job Description</th>
                <th className="text-left px-6 py-4 font-semibold text-xs uppercase tracking-wider text-muted-foreground">Department</th>
                <th className="text-left px-6 py-4 font-semibold text-xs uppercase tracking-wider text-muted-foreground">Access</th>
                <th className="text-left px-6 py-4 font-semibold text-xs uppercase tracking-wider text-muted-foreground">Status</th>
                <th className="text-left px-6 py-4 font-semibold text-xs uppercase tracking-wider text-muted-foreground">MFA</th>
                <th className="text-left px-6 py-4 font-semibold text-xs uppercase tracking-wider text-muted-foreground">Last Login</th>
                <th className="text-left px-6 py-4 font-semibold text-xs uppercase tracking-wider text-muted-foreground">Joined</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {isLoading ? (
                Array.from({ length: 6 }).map((_, i) => (
                  <tr key={i}>
                    {Array.from({ length: 8 }).map((_, j) => (
                      <td key={j} className="px-6 py-4"><div className="h-4 bg-muted rounded animate-pulse" /></td>
                    ))}
                  </tr>
                ))
              ) : users.map((user) => (
                <tr
                  key={user.id}
                  className="hover:bg-muted/50 transition-colors cursor-pointer group"
                  onMouseEnter={() => prefetchUserDetail(user.id)}
                  onClick={() => navigate(`/admin/users/${user.id}`)}
                >
                  <td className="px-6 py-4">
                    <div className="flex items-center gap-3">
                      <div className="w-9 h-9 rounded-full bg-primary text-primary-foreground flex items-center justify-center text-sm font-semibold flex-shrink-0">
                        {user.first_name[0]}{user.last_name[0]}
                      </div>
                      <div>
                        <p className="font-medium text-foreground">{user.full_name}</p>
                        <p className="text-xs text-muted-foreground">{user.email}</p>
                      </div>
                    </div>
                  </td>
                  <td className="px-6 py-4 text-foreground">{user.job_description || "—"}</td>
                  <td className="px-6 py-4 text-muted-foreground">{user.department_name || "—"}</td>
                  <td className="px-6 py-4">
                    {user.admin_source ? (
                      <span
                        className="badge text-xs border bg-primary/10 text-primary border-primary/30"
                        title={user.admin_source === "group"
                          ? "Admin via membership in the Administrators group"
                          : "Admin granted on the user account (staff/superuser)"}
                      >
                        Admin
                        <span className="ml-1 font-normal opacity-70">
                          · {user.admin_source === "group" ? "via group" : "account"}
                        </span>
                      </span>
                    ) : (
                      <span className="text-xs text-muted-foreground">Member</span>
                    )}
                  </td>
                  <td className="px-6 py-4">
                    <span className={clsx(
                      "badge text-xs border",
                      user.is_active ? "bg-teal/15 text-teal border-teal/30" : "bg-destructive/10 text-destructive border-destructive/30"
                    )}>
                      {user.is_active ? "Active" : "Inactive"}
                    </span>
                  </td>
                  <td className="px-6 py-4">
                    <span className={clsx(
                      "badge text-xs border",
                      user.mfa_enabled ? "bg-teal/15 text-teal border-teal/30" : "bg-muted text-muted-foreground border-border"
                    )}>
                      {user.mfa_enabled ? "Enabled" : "Off"}
                    </span>
                  </td>
                  <td className="px-6 py-4 text-xs text-muted-foreground">
                    {user.last_login ? format(new Date(user.last_login), "dd MMM yyyy HH:mm") : "Never"}
                  </td>
                  <td className="px-6 py-4 text-xs text-muted-foreground">
                    {format(new Date(user.created_at), "dd MMM yyyy")}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Modals */}
      {showCreate && <CreateUserModal departments={departments} onClose={() => setShowCreate(false)} />}
      {editUser && <EditUserModal user={editUser} departments={departments} onClose={() => setEditUser(null)} />}
      {pwResult && <TemporaryPasswordModal temporary_password={pwResult.temporary_password} onClose={() => setPwResult(null)} />}
    </div>
  );
}
