import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { usersAPI, departmentsAPI } from "@/services/api";
import {
  Plus, Search, MoreVertical, UserCheck, UserX,
  KeyRound, Edit2, Loader2, Shield, X, Trash2,
} from "lucide-react";
import { toast } from "react-toastify";
import { format } from "date-fns";
import clsx from "clsx";

// ── Types ─────────────────────────────────────────────────────────────────────
interface Department { id: string; name: string; code: string; user_count: number }

interface User {
  id: string; 
  email: string; 
  first_name: string; 
  last_name: string;
  full_name: string; 
  role: string; 
  role_display: string;
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
  role:       z.enum(["admin", "finance", "auditor", "viewer"]),
  department: z.string().optional(),
});

const editSchema = z.object({
  first_name: z.string().min(1, "Required"),
  last_name:  z.string().min(1, "Required"),
  role:       z.enum(["admin", "finance", "auditor", "viewer"]),
  department: z.string().optional(),
  is_active:  z.boolean(),
});

type CreateForm = z.infer<typeof createSchema>;
type EditForm   = z.infer<typeof editSchema>;

const ROLE_COLORS: Record<string, string> = {
  admin:   "bg-purple-100 text-purple-700",
  finance: "bg-blue-100 text-blue-700",
  auditor: "bg-amber-100 text-amber-700",
  viewer:  "bg-gray-100 text-gray-600",
};

// ── Temporary Password Modal (used for both create and reset) ─────────────────
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
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="card w-full max-w-md p-6 space-y-5">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 bg-amber-100 rounded-xl flex items-center justify-center">
            <KeyRound className="w-5 h-5 text-amber-600" />
          </div>
          <div>
            <h2 className="font-semibold text-gray-900 text-lg">Temporary Password</h2>
            <p className="text-sm text-gray-500">Share this with the new user</p>
          </div>
        </div>

        <div className="bg-gray-50 border border-gray-200 rounded-lg p-4">
          <p className="text-xs text-gray-500 mb-1">One-time password</p>
          <div className="flex items-center justify-between bg-white border rounded-md px-4 py-3 font-mono text-lg tracking-wider">
            {temporary_password}
            <button
              onClick={copyToClipboard}
              className="text-brand-600 hover:text-brand-700 text-sm font-medium"
            >
              {copied ? "Copied ✓" : "Copy"}
            </button>
          </div>
        </div>

        <div className="text-sm text-amber-700 bg-amber-50 border border-amber-200 rounded-lg p-3">
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
    defaultValues: { role: "viewer" },
  });

  const mutation = useMutation({
    mutationFn: (data: CreateForm) => usersAPI.create(data),
    onSuccess: (response) => {
      const tempPassword = response.data.temporary_password;
      
      if (tempPassword) {
        // Show the temporary password modal
        setTempPassword(tempPassword);
      } else {
        toast.success("User created successfully");
        onClose();
      }

      qc.invalidateQueries({ queryKey: ["users"] });
      // Do not close modal immediately if we show password modal
    },
    onError: (err: any) => {
      const detail = Object.values(err?.response?.data ?? {}).flat().join(" ") || 
                     err?.response?.data?.detail || 
                     "Failed to create user";
      toast.error(detail);
    },
  });

  const [tempPassword, setTempPassword] = useState<string | null>(null);

  const handleClose = () => {
    setTempPassword(null);
    onClose();
  };

  return (
    <>
      {!tempPassword && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="card w-full max-w-lg p-6">
            <div className="flex items-center justify-between mb-5">
              <h2 className="font-semibold text-gray-900 text-lg">Create new user</h2>
              <button onClick={onClose} className="text-gray-400 hover:text-gray-600">
                <X className="w-5 h-5" />
              </button>
            </div>

            <form onSubmit={handleSubmit((v) => mutation.mutate(v))} className="space-y-4">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="label">First name <span className="text-red-500">*</span></label>
                  <input {...register("first_name")} className="input" placeholder="John" autoFocus />
                  {errors.first_name && <p className="text-red-500 text-xs mt-1">{errors.first_name.message}</p>}
                </div>
                <div>
                  <label className="label">Last name <span className="text-red-500">*</span></label>
                  <input {...register("last_name")} className="input" placeholder="Doe" />
                  {errors.last_name && <p className="text-red-500 text-xs mt-1">{errors.last_name.message}</p>}
                </div>
              </div>

              <div>
                <label className="label">Email address <span className="text-red-500">*</span></label>
                <input {...register("email")} type="email" className="input" placeholder="john@company.com" />
                {errors.email && <p className="text-red-500 text-xs mt-1">{errors.email.message}</p>}
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="label">Role <span className="text-red-500">*</span></label>
                  <select {...register("role")} className="input">
                    <option value="viewer">Viewer</option>
                    <option value="finance">Finance staff</option>
                    <option value="auditor">Auditor</option>
                    <option value="admin">Administrator</option>
                  </select>
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
              </div>

              <div className="bg-blue-50 border border-blue-200 rounded-lg p-4 text-sm text-blue-700">
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

      {/* Temporary Password Modal after creation */}
      {tempPassword && (
        <TemporaryPasswordModal
          temporary_password={tempPassword}
          onClose={handleClose}
        />
      )}
    </>
  );
}

// ── Edit user modal (unchanged) ───────────────────────────────────────────────
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
      role:       user.role as EditForm["role"],
      department: user.department ?? undefined,
      is_active:  user.is_active,
    },
  });

  const mutation = useMutation({
    mutationFn: (data: EditForm) => usersAPI.update(user.id, data),
    onSuccess: () => {
      toast.success("User updated");
      qc.invalidateQueries({ queryKey: ["users"] });
      onClose();
    },
    onError: () => toast.error("Update failed"),
  });

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="card w-full max-w-md p-6">
        <div className="flex items-center justify-between mb-5">
          <div>
            <h2 className="font-semibold text-gray-900 text-lg">Edit user</h2>
            <p className="text-sm text-gray-500">{user.email}</p>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600">
            <X className="w-5 h-5" />
          </button>
        </div>

        <form onSubmit={handleSubmit((v) => mutation.mutate(v))} className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="label">First name</label>
              <input {...register("first_name")} className="input" />
              {errors.first_name && <p className="text-red-500 text-xs mt-1">{errors.first_name.message}</p>}
            </div>
            <div>
              <label className="label">Last name</label>
              <input {...register("last_name")} className="input" />
              {errors.last_name && <p className="text-red-500 text-xs mt-1">{errors.last_name.message}</p>}
            </div>
          </div>

          <div>
            <label className="label">Role</label>
            <select {...register("role")} className="input">
              <option value="viewer">Viewer</option>
              <option value="finance">Finance staff</option>
              <option value="auditor">Auditor</option>
              <option value="admin">Administrator</option>
            </select>
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
            <input {...register("is_active")} type="checkbox" id="is_active" className="w-4 h-4 rounded" />
            <label htmlFor="is_active" className="text-sm text-gray-700">Account active</label>
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

// ── Row action menu (unchanged) ───────────────────────────────────────────────
function UserActions({
  user,
  onEdit,
  onResetPassword,
  onToggleActive,
  onDelete,
}: {
  user: User;
  onEdit: () => void;
  onResetPassword: () => void;
  onToggleActive: () => void;
  onDelete: () => void;
}) {
  const [open, setOpen] = useState(false);

  return (
    <div className="relative">
      <button
        onClick={() => setOpen(!open)}
        className="text-gray-400 hover:text-gray-600 p-1 rounded"
      >
        <MoreVertical className="w-4 h-4" />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="absolute right-0 top-6 z-20 w-44 card py-1 shadow-lg">
            <button
              onClick={() => { onEdit(); setOpen(false); }}
              className="flex items-center gap-2 w-full px-3 py-2 text-sm text-gray-700 hover:bg-gray-50"
            >
              <Edit2 className="w-3.5 h-3.5" /> Edit user
            </button>
            <button
              onClick={() => { onResetPassword(); setOpen(false); }}
              className="flex items-center gap-2 w-full px-3 py-2 text-sm text-gray-700 hover:bg-gray-50"
            >
              <KeyRound className="w-3.5 h-3.5" /> Reset password
            </button>
            <button
              onClick={() => { onDelete(); setOpen(false); }}
              className="flex items-center gap-2 w-full px-3 py-2 text-sm text-red-600 hover:bg-red-50"
            >
              <Trash2 className="w-3.5 h-3.5" /> Delete user
            </button>
            <button
              onClick={() => { onToggleActive(); setOpen(false); }}
              className={clsx(
                "flex items-center gap-2 w-full px-3 py-2 text-sm hover:bg-gray-50",
                user.is_active ? "text-red-600" : "text-green-600"
              )}
            >
              {user.is_active
                ? <><UserX className="w-3.5 h-3.5" /> Deactivate</>
                : <><UserCheck className="w-3.5 h-3.5" /> Activate</>
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
  const [search, setSearch]       = useState("");
  const [roleFilter, setRole]     = useState("");
  const [deptFilter, setDept]     = useState("");
  const [showCreate, setCreate]   = useState(false);
  const [editUser, setEditUser]   = useState<User | null>(null);
  const [pwResult, setPwResult]   = useState<{ temporary_password: string } | null>(null);

  const { data: users, isLoading } = useQuery<User[]>({
    queryKey: ["users", { search, role: roleFilter, department: deptFilter }],
    queryFn: () =>
      usersAPI.list({
        search:     search || undefined,
        role:       roleFilter || undefined,
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
    onSuccess: (_, id) => {
      qc.invalidateQueries({ queryKey: ["users"] });
      toast.success("User status updated");
    },
    onError: (err: any) =>
      toast.error(err?.response?.data?.detail || "Action failed"),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => usersAPI.delete(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["users"] });
      toast.success("User deleted successfully");
    },
    onError: (err: any) =>
      toast.error(err?.response?.data?.detail || "Action failed"),
  });

  const activeCount = users?.filter((u) => u.is_active).length ?? 0;
  const adminCount  = users?.filter((u) => u.role === "admin").length ?? 0;
  const mfaCount    = users?.filter((u) => u.mfa_enabled).length ?? 0;

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Users & roles</h1>
          <p className="text-gray-500 text-sm mt-1">
            Manage staff accounts, roles, and department assignments.
          </p>
        </div>
        <button onClick={() => setCreate(true)} className="btn-primary">
          <Plus className="w-4 h-4" /> Add user
        </button>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        {[
          { label: "Total users",    value: users?.length ?? "—" },
          { label: "Active",         value: activeCount },
          { label: "Administrators", value: adminCount },
          { label: "MFA enabled",    value: mfaCount },
        ].map(({ label, value }) => (
          <div key={label} className="card p-4">
            <p className="text-2xl font-bold text-gray-900">{value}</p>
            <p className="text-sm text-gray-500 mt-0.5">{label}</p>
          </div>
        ))}
      </div>

      {/* Filters */}
      <div className="flex flex-wrap gap-3">
        <div className="relative flex-1 min-w-48">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by name or email…"
            className="input pl-9"
          />
        </div>
        <select
          value={roleFilter}
          onChange={(e) => setRole(e.target.value)}
          className="input w-40"
        >
          <option value="">All roles</option>
          <option value="admin">Administrator</option>
          <option value="finance">Finance staff</option>
          <option value="auditor">Auditor</option>
          <option value="viewer">Viewer</option>
        </select>
        <select
          value={deptFilter}
          onChange={(e) => setDept(e.target.value)}
          className="input w-48"
        >
          <option value="">All departments</option>
          {departments?.map((d) => (
            <option key={d.id} value={d.id}>{d.name}</option>
          ))}
        </select>
      </div>

      {/* Table - unchanged */}
      <div className="card overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-100 bg-gray-50">
                <th className="text-left px-4 py-3 font-medium text-gray-500">User</th>
                <th className="text-left px-4 py-3 font-medium text-gray-500">Role</th>
                <th className="text-left px-4 py-3 font-medium text-gray-500">Department</th>
                <th className="text-left px-4 py-3 font-medium text-gray-500">Status</th>
                <th className="text-left px-4 py-3 font-medium text-gray-500">MFA</th>
                <th className="text-left px-4 py-3 font-medium text-gray-500">Last login</th>
                <th className="text-left px-4 py-3 font-medium text-gray-500">Joined</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {isLoading && Array.from({ length: 5 }).map((_, i) => (
                <tr key={i}>
                  {Array.from({ length: 8 }).map((_, j) => (
                    <td key={j} className="px-4 py-3">
                      <div className="h-4 bg-gray-100 rounded animate-pulse" />
                    </td>
                  ))}
                </tr>
              ))}

              {!isLoading && users?.map((user) => (
                <tr
                  key={user.id}
                  className={clsx(
                    "hover:bg-gray-50 transition-colors",
                    !user.is_active && "opacity-50"
                  )}
                >
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-3">
                      <div className="w-8 h-8 rounded-full bg-brand-100 flex items-center justify-center text-brand-700 text-xs font-semibold flex-shrink-0">
                        {user.first_name[0]}{user.last_name[0]}
                      </div>
                      <div>
                        <p className="font-medium text-gray-900">{user.full_name}</p>
                        <p className="text-xs text-gray-500">{user.email}</p>
                      </div>
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <span className={clsx("badge text-xs", ROLE_COLORS[user.role] ?? "bg-gray-100 text-gray-600")}>
                      {user.role === "admin" && <Shield className="w-3 h-3 mr-1" />}
                      {user.role_display}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-gray-600">
                    {user.department_name ?? <span className="text-gray-300">—</span>}
                  </td>
                  <td className="px-4 py-3">
                    <span className={clsx(
                      "badge text-xs",
                      user.is_active ? "bg-green-100 text-green-700" : "bg-red-100 text-red-600"
                    )}>
                      {user.is_active ? "Active" : "Inactive"}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <span className={clsx(
                      "badge text-xs",
                      user.mfa_enabled ? "bg-green-100 text-green-700" : "bg-gray-100 text-gray-500"
                    )}>
                      {user.mfa_enabled ? "Enabled" : "Off"}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-gray-500 text-xs">
                    {user.last_login
                      ? format(new Date(user.last_login), "dd MMM yyyy HH:mm")
                      : "Never"}
                  </td>
                  <td className="px-4 py-3 text-gray-400 text-xs">
                    {format(new Date(user.created_at), "dd MMM yyyy")}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <UserActions
                      user={user}
                      onEdit={() => setEditUser(user)}
                      onResetPassword={() => resetPasswordMutation.mutate(user.id)}
                      onToggleActive={() => toggleActiveMutation.mutate(user.id)}
                      onDelete={() => {
                        if (confirm(`Are you sure you want to permanently delete ${user.full_name}?`)) {
                          deleteMutation.mutate(user.id);
                        }
                      }}
                    />
                  </td>
                </tr>
              ))}

              {!isLoading && !users?.length && (
                <tr>
                  <td colSpan={8} className="px-4 py-12 text-center text-gray-400">
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