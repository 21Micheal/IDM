import { useState } from "react";
import { extractApiError } from "@/lib/apiError";
import { useNavigate } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { usersAPI, departmentsAPI } from "@/services/api";
import {
  Plus, Search, Loader2, X, Users as UsersIcon,
} from "lucide-react";
import CustomListbox from "@/components/ui/CustomListbox";
import { toast } from "@/components/ui/vault-toast";
import { TemporaryPasswordModal } from "@/components/users/TemporaryPasswordModal";
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

// ── Create User Modal ────────────────────────────────────────────────────────
function CreateUserModal({
  departments,
  onClose,
}: {
  departments: Department[];
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const { register, handleSubmit, formState: { errors }, reset, watch, setValue } = useForm<CreateForm>({
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
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="bg-white w-full max-w-lg border border-[#C8CDD2] shadow-xl">
            {/* Header */}
            <div className="flex items-center justify-between border-b border-[#C8CDD2] px-6 py-5 bg-[#F5F7F8]">
              <h2 className="text-lg font-semibold text-[#1F2933]">Create New User</h2>
              <button onClick={onClose} className="p-1.5 text-[#5E6870] hover:text-[#1F2933] hover:bg-[#EDEDED] transition-colors">
                <X className="w-5 h-5" />
              </button>
            </div>

            <form onSubmit={handleSubmit((v) => mutation.mutate(v))} className="p-6 space-y-5">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-[#1F2933] mb-1.5">First Name *</label>
                  <input {...register("first_name")} className="input" placeholder="John" autoFocus />
                  {errors.first_name && <p className="text-destructive text-xs mt-1">{errors.first_name.message}</p>}
                </div>
                <div>
                  <label className="block text-sm font-medium text-[#1F2933] mb-1.5">Last Name *</label>
                  <input {...register("last_name")} className="input" placeholder="Doe" />
                  {errors.last_name && <p className="text-destructive text-xs mt-1">{errors.last_name.message}</p>}
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium text-[#1F2933] mb-1.5">Email Address *</label>
                <input {...register("email")} type="email" className="input" placeholder="john@company.com" />
                {errors.email && <p className="text-destructive text-xs mt-1">{errors.email.message}</p>}
              </div>

              <div>
                <label className="block text-sm font-medium text-[#1F2933] mb-1.5">Job Description *</label>
                <textarea {...register("job_description")} rows={3} className="input" placeholder="e.g. Accounts Payable Officer" />
                {errors.job_description && <p className="text-destructive text-xs mt-1">{errors.job_description.message}</p>}
              </div>

              <div>
                <label className="block text-sm font-medium text-[#1F2933] mb-1.5">Department</label>
                  <CustomListbox
                    value={watch("department") ?? ""}
                    onChange={(v) => setValue("department", v || "")}
                    options={[
                      { value: "", label: "— None —" },
                      ...departments.map((d) => ({ value: d.id, label: d.name })),
                    ]}
                    buttonClassName="input"
                    ariaLabel="Department"
                  />
              </div>
              <button type="submit" disabled={mutation.isPending} className="inline-flex w-full items-center justify-center gap-2 bg-[#287EAD] px-5 py-2.5 font-medium text-white transition-colors hover:bg-[#206D99] disabled:opacity-60">
                {mutation.isPending && <Loader2 className="w-4 h-4 animate-spin" />}
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
  const { register, handleSubmit, formState: { errors: _errors }, watch, setValue } = useForm<EditForm>({
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
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="bg-white w-full max-w-md border border-[#C8CDD2] shadow-xl">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-[#C8CDD2] px-6 py-5 bg-[#F5F7F8]">
          <div>
            <h2 className="text-lg font-semibold text-[#1F2933]">Edit User</h2>
            <p className="text-sm text-[#5E6870]">{user.email}</p>
          </div>
          <button onClick={onClose} className="p-1.5 text-[#5E6870] hover:text-[#1F2933] hover:bg-[#EDEDED] transition-colors">
            <X className="w-5 h-5" />
          </button>
        </div>

        <form onSubmit={handleSubmit((v) => mutation.mutate(v))} className="p-6 space-y-5">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-[#1F2933] mb-1.5">First Name</label>
              <input {...register("first_name")} className="input" />
            </div>
            <div>
              <label className="block text-sm font-medium text-[#1F2933] mb-1.5">Last Name</label>
              <input {...register("last_name")} className="input" />
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-[#1F2933] mb-1.5">Job Description</label>
            <textarea {...register("job_description")} rows={3} className="input" />
          </div>

          <div>
            <label className="block text-sm font-medium text-[#1F2933] mb-1.5">Department</label>
              <CustomListbox
                value={watch("department") ?? ""}
                onChange={(v) => setValue("department", v || "")}
                options={[
                  { value: "", label: "— None —" },
                  ...departments.map((d) => ({ value: d.id, label: d.name })),
                ]}
                buttonClassName="input"
                ariaLabel="Department"
              />
            </div>
          <div className="flex items-center gap-3">
            <input {...register("is_active")} type="checkbox" className="w-4 h-4 accent-[#287EAD]" />
            <label className="text-sm font-medium text-[#1F2933]">Account is active</label>
          </div>

          <div className="flex gap-3 pt-2 border-t border-[#C8CDD2]">
            <button type="button" onClick={onClose} className="flex-1 border border-[#C8CDD2] px-4 py-2.5 text-sm font-medium text-[#1F2933] hover:bg-[#F5F7F8] transition-colors">Cancel</button>
            <button type="submit" disabled={mutation.isPending} className="flex-1 inline-flex items-center justify-center gap-2 bg-[#287EAD] px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-[#206D99] disabled:opacity-60">
              {mutation.isPending && <Loader2 className="animate-spin w-4 h-4" />} Save Changes
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
        <CustomListbox
          value={deptFilter}
          onChange={setDeptFilter}
          options={[
            { value: "", label: "All Departments" },
            ...departments.map((d) => ({ value: d.id, label: d.name })),
          ]}
          buttonClassName="input w-64 text-left"
          ariaLabel="Department filter"
        />
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
                      {/* Square initials avatar — squire style */}
                      <div className="flex h-9 w-9 items-center justify-center border border-[#C8CDD2] bg-[#EEF6FB] text-[#287EAD] text-sm font-semibold flex-shrink-0">
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
    </div>
  );
}
