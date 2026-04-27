import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { usersAPI, departmentsAPI } from "@/services/api";
import {
  Plus, Search, MoreVertical, UserCheck, UserX,
  KeyRound, Edit2, Loader2, Shield, X, Users as UsersIcon,
} from "lucide-react";
import { toast } from "@/components/ui/vault-toast";
import { format } from "date-fns";
import clsx from "clsx";

// ── Types ─────────────────────────────────────────────────────────────────────
interface Department {
  id: string;
  name: string;
  code: string;
  user_count: number;
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

// ── Schemas ───────────────────────────────────────────────────────────────────
const createSchema = z.object({
  email:      z.string().email("Invalid email"),
  first_name: z.string().min(1, "Required"),
  last_name:  z.string().min(1, "Required"),
  job_description: z.string().min(1, "Job description is required").max(255, "Job description must be 255 characters or fewer"),
  department: z.string().optional(),
});

const editSchema = z.object({
  first_name: z.string().min(1, "Required"),
  last_name:  z.string().min(1, "Required"),
  job_description: z.string().min(1, "Job description is required").max(255, "Job description must be 255 characters or fewer"),
  department: z.string().optional(),
  is_active:  z.boolean(),
});

type CreateForm = z.infer<typeof createSchema>;
type EditForm   = z.infer<typeof editSchema>;

// ── Temporary Password Modal ─────────────────────────────────────────────────
function TemporaryPasswordModal({
  temporary_password,
  onClose,
}: {
  temporary_password: string;
  onClose: () => void;
}) {
  const [copied, setCopied] = useState(false);

  const copyToClipboard = () => {
    navigator.clipboard.writeText(temporary_password);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
    toast.success("Password copied to clipboard");
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-foreground/40 backdrop-blur-sm p-4">
      <div className="card w-full max-w-md p-6 space-y-5" style={{ boxShadow: "var(--shadow-elegant)" }}>
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 bg-accent/15 rounded-xl flex items-center justify-center">
            <KeyRound className="w-5 h-5 text-accent-foreground" />
          </div>
          <div>
            <h2 className="font-semibold text-foreground text-lg">Temporary Password</h2>
            <p className="text-sm text-muted-foreground">Share this with the new user</p>
          </div>
        </div>

        <div className="bg-muted border border-border rounded-lg p-4">
          <p className="text-xs text-muted-foreground mb-1">One-time password</p>
          <div className="flex items-center justify-between bg-card border border-border rounded-md px-4 py-3 font-mono text-lg tracking-wider text-foreground">
            {temporary_password}
            <button
              onClick={copyToClipboard}
              className="text-accent-foreground hover:underline text-sm font-medium ml-3"
            >
              {copied ? "Copied ✓" : "Copy"}
            </button>
          </div>
        </div>

        <div className="text-sm text-foreground bg-accent/10 border border-accent/30 rounded-lg p-3">
          The user will be prompted to set a new strong password on their first login.<br />
          MFA (Email OTP) is enabled by default.
        </div>

        <button
          onClick={onClose}
          className="btn-primary w-full justify-center"
        >
          I have saved this password
        </button>
      </div>
    </div>
  );
}

// ── Create user modal ─────────────────────────────────────────────────────────
function CreateUserModal({
  departments,
  onClose,
}: {
  departments: Department[];
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const { register, handleSubmit, formState: { errors } } = useForm<CreateForm>({
    resolver: zodResolver(createSchema),
    defaultValues: { job_description: "" },
  });

  const [tempPassword, setTempPassword] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: (data: CreateForm) => usersAPI.create(data),
    onSuccess: (response) => {
      const tempPasswordVal = response.data.temporary_password;

      if (tempPasswordVal) {
        setTempPassword(tempPasswordVal);
      } else {
        toast.success("User created successfully");
        onClose();
      }

      qc.invalidateQueries({ queryKey: ["users"] });
    },
    onError: (err: { response?: { data?: Record<string, unknown> } }) => {
      const data = err?.response?.data ?? {};
      const detail = Object.values(data).flat().join(" ") ||
                     (data as { detail?: string }).detail ||
                     "Failed to create user";
      toast.error(detail);
    },
  });

  const handleClose = () => {
    setTempPassword(null);
    onClose();
  };

  return (
    <>
      {!tempPassword && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-foreground/40 backdrop-blur-sm p-4">
          <div className="card w-full max-w-lg p-6" style={{ boxShadow: "var(--shadow-elegant)" }}>
            <div className="flex items-center justify-between mb-5">
              <h2 className="font-semibold text-foreground text-lg">Create new user</h2>
              <button onClick={onClose} className="text-muted-foreground hover:text-foreground">
                <X className="w-5 h-5" />
              </button>
            </div>

            <form onSubmit={handleSubmit((v) => mutation.mutate(v))} className="space-y-4">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="label">First name <span className="text-destructive">*</span></label>
                  <input {...register("first_name")} className="input" placeholder="John" autoFocus />
                  {errors.first_name && <p className="text-destructive text-xs mt-1">{errors.first_name.message}</p>}
                </div>
                <div>
                  <label className="label">Last name <span className="text-destructive">*</span></label>
                  <input {...register("last_name")} className="input" placeholder="Doe" />
                  {errors.last_name && <p className="text-destructive text-xs mt-1">{errors.last_name.message}</p>}
                </div>
              </div>

              <div>
                <label className="label">Email address <span className="text-destructive">*</span></label>
                <input {...register("email")} type="email" className="input" placeholder="john@company.com" />
                {errors.email && <p className="text-destructive text-xs mt-1">{errors.email.message}</p>}
              </div>

              <div>
                <label className="label">Job description <span className="text-destructive">*</span></label>
                <textarea
                  {...register("job_description")}
                  rows={3}
                  className="input"
                  placeholder="e.g. Accounts payable officer"
                />
                {errors.job_description && <p className="text-destructive text-xs mt-1">{errors.job_description.message}</p>}
              </div>

              <div>
                <label className="label">Department</label>
                <select {...register("department")} className="input">
                  <option value="">— None —</option>
                  {departments.map((d) => (
                    <option key={d.id} value={d.id}>{d.name}</option>
                  ))}
                </select>
              </div>

              <div className="bg-accent/10 border border-accent/30 rounded-lg p-4 text-sm text-foreground">
                A strong temporary password will be automatically generated and emailed to the user.<br />
                You will also see it after creation.
              </div>

              <div className="flex gap-3 pt-2 justify-end">
                <button type="button" onClick={onClose} className="btn-secondary">Cancel</button>
                <button type="submit" disabled={mutation.isPending} className="btn-primary">
                  {mutation.isPending && <Loader2 className="w-4 h-4 animate-spin" />}
                  Create user
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {tempPassword && (
        <TemporaryPasswordModal
          temporary_password={tempPassword}
          onClose={handleClose}
        />
      )}
    </>
  );
}

// ── Edit user modal ───────────────────────────────────────────────────────────
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
  const { register, handleSubmit, formState: { errors } } = useForm<EditForm>({
    resolver: zodResolver(editSchema),
    defaultValues: {
      first_name: user.first_name,
      last_name:  user.last_name,
      job_description: user.job_description,
      department: user.department ?? undefined,
      is_active:  user.is_active,
    },
  });

  const mutation = useMutation({
    mutationFn: (data: EditForm) => usersAPI.update(user.id, data),
    onSuccess: () => {
      toast.success("User updated successfully");
      qc.invalidateQueries({ queryKey: ["users"] });
      onClose();
    },
    onError: () => toast.error("Update failed"),
  });

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-foreground/40 backdrop-blur-sm p-4">
      <div className="card w-full max-w-md p-6" style={{ boxShadow: "var(--shadow-elegant)" }}>
        <div className="flex items-center justify-between mb-5">
          <div>
            <h2 className="font-semibold text-foreground text-lg">Edit user</h2>
            <p className="text-sm text-muted-foreground">{user.email}</p>
          </div>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground">
            <X className="w-5 h-5" />
          </button>
        </div>

        <form onSubmit={handleSubmit((v) => mutation.mutate(v))} className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="label">First name</label>
              <input {...register("first_name")} className="input" />
              {errors.first_name && <p className="text-destructive text-xs mt-1">{errors.first_name.message}</p>}
            </div>
            <div>
              <label className="label">Last name</label>
              <input {...register("last_name")} className="input" />
              {errors.last_name && <p className="text-destructive text-xs mt-1">{errors.last_name.message}</p>}
            </div>
          </div>

          <div>
            <label className="label">Job description</label>
            <textarea {...register("job_description")} rows={3} className="input" />
            {errors.job_description && <p className="text-destructive text-xs mt-1">{errors.job_description.message}</p>}
          </div>

          <div>
            <label className="label">Department</label>
            <select {...register("department")} className="input">
              <option value="">— None —</option>
              {departments.map((d) => (
                <option key={d.id} value={d.id}>{d.name}</option>
              ))}
            </select>
          </div>

          <div className="flex items-center gap-2 pt-1">
            <input {...register("is_active")} type="checkbox" id="is_active" className="w-4 h-4 rounded accent-primary" />
            <label htmlFor="is_active" className="text-sm text-foreground">Account active</label>
          </div>

          <div className="flex gap-3 pt-2 justify-end">
            <button type="button" onClick={onClose} className="btn-secondary">Cancel</button>
            <button type="submit" disabled={mutation.isPending} className="btn-primary">
              {mutation.isPending && <Loader2 className="w-4 h-4 animate-spin" />}
              Save changes
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ── Row action menu ───────────────────────────────────────────────────────────
function UserActions({
  user,
  onEdit,
  onResetPassword,
  onToggleActive,
}: {
  user: User;
  onEdit: () => void;
  onResetPassword: () => void;
  onToggleActive: () => void;
}) {
  const [open, setOpen] = useState(false);

  return (
    <div className="relative">
      <button
        onClick={() => setOpen(!open)}
        className="text-muted-foreground hover:text-foreground p-1 rounded-lg hover:bg-muted transition-colors"
      >
        <MoreVertical className="w-4 h-4" />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div
            className="absolute right-0 top-8 z-20 w-48 bg-popover border border-border py-1 rounded-xl"
            style={{ boxShadow: "var(--shadow-elegant)" }}
          >
            <button
              onClick={() => { onEdit(); setOpen(false); }}
              className="flex items-center gap-2 w-full px-4 py-2.5 text-sm text-popover-foreground hover:bg-muted"
            >
              <Edit2 className="w-4 h-4" /> Edit user
            </button>
            <button
              onClick={() => { onResetPassword(); setOpen(false); }}
              className="flex items-center gap-2 w-full px-4 py-2.5 text-sm text-popover-foreground hover:bg-muted"
            >
              <KeyRound className="w-4 h-4" /> Reset password
            </button>
            <button
              onClick={() => { onToggleActive(); setOpen(false); }}
              className={clsx(
                "flex items-center gap-2 w-full px-4 py-2.5 text-sm hover:bg-muted",
                user.is_active ? "text-destructive" : "text-teal"
              )}
            >
              {user.is_active
                ? <><UserX className="w-4 h-4" /> Deactivate</>
                : <><UserCheck className="w-4 h-4" /> Activate</>
              }
            </button>
          </div>
        </>
      )}
    </div>
  );
}

// ── Main UsersPage Component ──────────────────────────────────────────────────
export default function UsersPage() {
  const qc = useQueryClient();
  const [search, setSearch] = useState("");
  const [deptFilter, setDept] = useState("");
  const [showCreate, setCreate] = useState(false);
  const [editUser, setEditUser] = useState<User | null>(null);
  const [pwResult, setPwResult] = useState<{ temporary_password: string } | null>(null);

  const { data: users, isLoading } = useQuery<User[]>({
    queryKey: ["users", { search, department: deptFilter }],
    queryFn: () =>
      usersAPI.list({
        search: search || undefined,
        department: deptFilter || undefined,
      }).then((r) => r.data.results ?? r.data),
  });

  const { data: departments } = useQuery<Department[]>({
    queryKey: ["departments"],
    queryFn: () => departmentsAPI.list().then((r) => r.data.results ?? r.data),
  });

  const resetPasswordMutation = useMutation({
    mutationFn: (id: string) => usersAPI.resetPassword(id),
    onSuccess: ({ data }) => setPwResult(data),
    onError: () => toast.error("Password reset failed"),
  });

  const toggleActiveMutation = useMutation({
    mutationFn: (id: string) => usersAPI.toggleActive(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["users"] });
      toast.success("User status updated");
    },
    onError: (err: { response?: { data?: { detail?: string } } }) =>
      toast.error(err?.response?.data?.detail || "Action failed"),
  });

  const activeCount = users?.filter((u) => u.is_active).length ?? 0;
  const mfaCount    = users?.filter((u) => u.mfa_enabled).length ?? 0;

  return (
    <div className="max-w-6xl mx-auto py-8">
      {/* Header */}
      <div className="flex items-start justify-between mb-10">
        <div>
          <div className="flex items-center gap-3 mb-2">
            <div className="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center">
              <UsersIcon className="w-5 h-5 text-primary" />
            </div>
            <h1 className="text-3xl font-bold text-foreground tracking-tight">Users</h1>
          </div>
          <p className="text-muted-foreground text-sm">
            Manage staff accounts, job descriptions, and department assignments.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <button onClick={() => setCreate(true)} className="btn-primary flex items-center gap-2">
            <Plus className="w-4 h-4" /> Add User
          </button>
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-6 mb-10">
        {[
          { label: "Total users",    value: users?.length ?? "—" },
          { label: "Active",         value: activeCount },
          { label: "Descriptions set", value: users?.filter((u) => u.job_description).length ?? "—" },
          { label: "MFA enabled",    value: mfaCount },
        ].map(({ label, value }) => (
          <div key={label} className="card p-6">
            <p className="text-3xl font-semibold text-foreground tracking-tight">{value}</p>
            <p className="text-xs uppercase tracking-wider text-muted-foreground mt-1">{label}</p>
          </div>
        ))}
      </div>

      {/* Filters */}
      <div className="flex flex-wrap gap-3 mb-6">
        <div className="relative flex-1 min-w-72">
          <Search className="absolute left-4 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by name or email..."
            className="input pl-11"
          />
        </div>
        <select
          value={deptFilter}
          onChange={(e) => setDept(e.target.value)}
          className="input w-52"
        >
          <option value="">All departments</option>
          {departments?.map((d) => (
            <option key={d.id} value={d.id}>{d.name}</option>
          ))}
        </select>
      </div>

      {/* Users Table */}
      <div className="card overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-muted/50">
                <th className="text-left px-6 py-4 font-semibold text-xs uppercase tracking-wider text-muted-foreground">User</th>
                <th className="text-left px-6 py-4 font-semibold text-xs uppercase tracking-wider text-muted-foreground">Job description</th>
                <th className="text-left px-6 py-4 font-semibold text-xs uppercase tracking-wider text-muted-foreground">Department</th>
                <th className="text-left px-6 py-4 font-semibold text-xs uppercase tracking-wider text-muted-foreground">Status</th>
                <th className="text-left px-6 py-4 font-semibold text-xs uppercase tracking-wider text-muted-foreground">MFA</th>
                <th className="text-left px-6 py-4 font-semibold text-xs uppercase tracking-wider text-muted-foreground">Last login</th>
                <th className="text-left px-6 py-4 font-semibold text-xs uppercase tracking-wider text-muted-foreground">Joined</th>
                <th className="w-12" />
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {isLoading && Array.from({ length: 6 }).map((_, i) => (
                <tr key={i}>
                  {Array.from({ length: 8 }).map((_, j) => (
                    <td key={j} className="px-6 py-4">
                      <div className="h-4 bg-muted rounded animate-pulse" />
                    </td>
                  ))}
                </tr>
              ))}

              {!isLoading && users?.map((user) => (
                <tr
                  key={user.id}
                  className={clsx(
                    "hover:bg-muted/40 transition-colors",
                    !user.is_active && "opacity-60"
                  )}
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
                  <td className="px-6 py-4">
                    <p className="text-sm text-foreground max-w-xs truncate">
                      {user.job_description || <span className="text-muted-foreground">—</span>}
                    </p>
                  </td>
                  <td className="px-6 py-4 text-muted-foreground">
                    {user.department_name ?? <span className="text-muted">—</span>}
                  </td>
                  <td className="px-6 py-4">
                    <span className={clsx(
                      "badge text-xs border",
                      user.is_active
                        ? "bg-teal/15 text-teal border-teal/30"
                        : "bg-destructive/10 text-destructive border-destructive/30"
                    )}>
                      <span className={clsx(
                        "mr-1.5 h-1.5 w-1.5 rounded-full",
                        user.is_active ? "bg-teal" : "bg-destructive"
                      )} />
                      {user.is_active ? "Active" : "Inactive"}
                    </span>
                  </td>
                  <td className="px-6 py-4">
                    <span className={clsx(
                      "badge text-xs border",
                      user.mfa_enabled
                        ? "bg-teal/15 text-teal border-teal/30"
                        : "bg-muted text-muted-foreground border-border"
                    )}>
                      <span className={clsx(
                        "mr-1.5 h-1.5 w-1.5 rounded-full",
                        user.mfa_enabled ? "bg-teal" : "bg-muted-foreground/50"
                      )} />
                      {user.mfa_enabled ? "Enabled" : "Off"}
                    </span>
                  </td>
                  <td className="px-6 py-4 text-muted-foreground text-xs">
                    {user.last_login
                      ? format(new Date(user.last_login), "dd MMM yyyy HH:mm")
                      : "Never"}
                  </td>
                  <td className="px-6 py-4 text-muted-foreground text-xs">
                    {format(new Date(user.created_at), "dd MMM yyyy")}
                  </td>
                  <td className="px-6 py-4 text-right">
                    <UserActions
                      user={user}
                      onEdit={() => setEditUser(user)}
                      onResetPassword={() => resetPasswordMutation.mutate(user.id)}
                      onToggleActive={() => toggleActiveMutation.mutate(user.id)}
                    />
                  </td>
                </tr>
              ))}

              {!isLoading && !users?.length && (
                <tr>
                  <td colSpan={8} className="px-6 py-20 text-center text-muted-foreground">
                    <div className="mx-auto w-12 h-12 rounded-full bg-muted flex items-center justify-center mb-4">
                      <Shield className="w-6 h-6 text-muted-foreground" />
                    </div>
                    No users found. Try adjusting your filters.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Modals */}
      {showCreate && (
        <CreateUserModal
          departments={departments ?? []}
          onClose={() => setCreate(false)}
        />
      )}

      {editUser && (
        <EditUserModal
          user={editUser}
          departments={departments ?? []}
          onClose={() => setEditUser(null)}
        />
      )}

      {pwResult && (
        <TemporaryPasswordModal
          temporary_password={pwResult.temporary_password}
          onClose={() => setPwResult(null)}
        />
      )}
    </div>
  );
}
