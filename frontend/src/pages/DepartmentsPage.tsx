import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { departmentsAPI, usersAPI } from "@/services/api";
import {
  Plus, Trash2, Loader2, Building2, X, UserPlus, Users, Check,
} from "lucide-react";
import { toast } from "react-toastify";
import clsx from "clsx";

interface Department {
  id: string;
  name: string;
  code: string;
  user_count: number;
}

interface User {
  id: string;
  full_name: string;
  email: string;
  job_description?: string;
}

const schema = z.object({
  name: z.string().min(2, "Min 2 characters"),
  code: z.string().min(2, "Min 2 characters").max(10, "Max 10 characters"),
});

type FormData = z.infer<typeof schema>;

function DeptForm({
  defaultValues,
  onSubmit,
  onCancel,
  isPending,
}: {
  defaultValues?: FormData;
  onSubmit: (data: FormData) => void;
  onCancel: () => void;
  isPending: boolean;
}) {
  const { register, handleSubmit, formState: { errors } } = useForm<FormData>({
    resolver: zodResolver(schema),
    defaultValues,
  });

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="flex items-start gap-3">
      <div className="flex-1">
        <input
          {...register("name")}
          className="input"
          placeholder="Department name"
          autoFocus
        />
        {errors.name && <p className="text-destructive text-xs mt-1">{errors.name.message}</p>}
      </div>
      <div className="w-32">
        <input
          {...register("code")}
          className="input uppercase"
          placeholder="Code"
        />
        {errors.code && <p className="text-destructive text-xs mt-1">{errors.code.message}</p>}
      </div>
      <button type="submit" disabled={isPending} className="btn-primary">
        {isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
        Save
      </button>
      <button type="button" onClick={onCancel} className="btn-secondary">
        <X className="w-4 h-4" />
      </button>
    </form>
  );
}

// ── Department Detail Panel ───────────────────────────────────────────────────
function DepartmentDetail({
  department,
  onClose,
}: {
  department: Department;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [userSearch, setUserSearch] = useState("");

  const { data: members = [], isLoading: membersLoading } = useQuery<User[]>({
    queryKey: ["department-members", department.id],
    queryFn: () =>
      usersAPI.list({ department: department.id }).then((r) => r.data.results ?? r.data),
  });

  const { data: allUsers = [] } = useQuery<User[]>({
    queryKey: ["users-search", userSearch],
    queryFn: () =>
      usersAPI.list({
        search: userSearch || undefined,
        page_size: 30,
        is_active: "true"
      }).then((r) => r.data.results ?? r.data),
  });

  const addMemberMutation = useMutation({
    mutationFn: (userId: string) =>
      usersAPI.update(userId, { department: department.id }),
    onSuccess: () => {
      toast.success("User added successfully");
      qc.invalidateQueries({ queryKey: ["department-members", department.id] });
      qc.invalidateQueries({ queryKey: ["departments"] });
    },
    onError: () => toast.error("Failed to add user"),
  });

  const removeMemberMutation = useMutation({
    mutationFn: (userId: string) =>
      usersAPI.update(userId, { department: null }),
    onSuccess: () => {
      toast.success("User removed from department");
      qc.invalidateQueries({ queryKey: ["department-members", department.id] });
      qc.invalidateQueries({ queryKey: ["departments"] });
    },
    onError: () => toast.error("Failed to remove user"),
  });

  const memberIds = new Set(members.map((m) => m.id));

  return (
    <div className="fixed inset-0 z-50 flex">
      <div className="flex-1 bg-foreground/40 backdrop-blur-sm" onClick={onClose} />

      <div
        className="w-full max-w-2xl bg-card flex flex-col overflow-hidden border-l border-border"
        style={{ boxShadow: "var(--shadow-elegant)" }}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-8 py-6 border-b border-border bg-muted/40">
          <div className="flex items-center gap-4">
            <div className="w-12 h-12 rounded-xl bg-accent/15 flex items-center justify-center">
              <Building2 className="w-6 h-6 text-accent" />
            </div>
            <div>
              <h2 className="font-semibold text-2xl text-foreground tracking-tight">{department.name}</h2>
              <p className="text-xs text-muted-foreground font-mono tracking-wider uppercase mt-1">Code · {department.code}</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-2 text-muted-foreground hover:text-foreground hover:bg-muted rounded-lg transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-8 space-y-10">
          {/* Members Section */}
          <div>
            <div className="flex justify-between items-center mb-5">
              <h3 className="font-semibold text-lg text-foreground flex items-center gap-2">
                <Users className="w-4 h-4 text-muted-foreground" />
                Members <span className="text-muted-foreground font-normal">({members.length})</span>
              </h3>
            </div>

            <div className="space-y-2">
              {membersLoading ? (
                <div className="text-center py-12 text-muted-foreground text-sm">Loading members…</div>
              ) : members.length === 0 ? (
                <div className="border border-dashed border-border rounded-xl p-12 text-center">
                  <Users className="w-10 h-10 text-muted-foreground/40 mx-auto mb-3" />
                  <p className="text-muted-foreground text-sm">No members in this department yet.</p>
                </div>
              ) : (
                members.map((user) => (
                  <div
                    key={user.id}
                    className="flex items-center gap-4 p-4 bg-card border border-border rounded-xl hover:border-accent/40 transition-colors group"
                  >
                    <div className="w-10 h-10 rounded-full bg-accent/15 flex items-center justify-center text-accent text-sm font-bold flex-shrink-0">
                      {user.full_name.split(" ").map((n) => n[0]).join("").slice(0, 2)}
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="font-medium text-foreground text-sm">{user.full_name}</p>
                      <p className="text-xs text-muted-foreground truncate">{user.email}</p>
                    </div>
                    <div className="flex items-center gap-3">
                      <span className="badge bg-secondary text-secondary-foreground text-xs">
                        {user.job_description || "Staff"}
                      </span>
                      <button
                        onClick={() => removeMemberMutation.mutate(user.id)}
                        className="opacity-0 group-hover:opacity-100 text-destructive hover:bg-destructive/10 p-2 rounded-lg transition-all"
                        title="Remove from department"
                      >
                        <X className="w-4 h-4" />
                      </button>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>

          {/* Add Members Section */}
          <div>
            <h3 className="font-semibold text-lg text-foreground mb-4">Add new members</h3>

            <input
              value={userSearch}
              onChange={(e) => setUserSearch(e.target.value)}
              className="input mb-4"
              placeholder="Search users by name or email…"
            />

            <div className="max-h-[420px] overflow-y-auto border border-border rounded-xl divide-y divide-border bg-card">
              {allUsers
                .filter((u) => !memberIds.has(u.id))
                .map((user) => (
                  <div
                    key={user.id}
                    className="flex items-center gap-4 p-4 hover:bg-muted/50 transition-colors"
                  >
                    <div className="w-10 h-10 rounded-full bg-muted flex items-center justify-center text-muted-foreground text-sm font-bold flex-shrink-0">
                      {user.full_name.split(" ").map((n) => n[0]).join("").slice(0, 2)}
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="font-medium text-foreground text-sm">{user.full_name}</p>
                      <p className="text-xs text-muted-foreground truncate">{user.email}</p>
                    </div>
                    <button
                      onClick={() => addMemberMutation.mutate(user.id)}
                      disabled={addMemberMutation.isPending}
                      className="btn-primary text-xs px-4 py-2"
                    >
                      <UserPlus className="w-3.5 h-3.5" /> Add
                    </button>
                  </div>
                ))}

              {allUsers.length === 0 && userSearch && (
                <div className="p-12 text-center text-muted-foreground text-sm">No users found.</div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Main DepartmentsPage ──────────────────────────────────────────────────────
export default function DepartmentsPage() {
  const qc = useQueryClient();
  const [showAdd, setShowAdd] = useState(false);
  const [selectedDept, setSelectedDept] = useState<Department | null>(null);

  const { data: departments = [], isLoading } = useQuery<Department[]>({
    queryKey: ["departments"],
    queryFn: () => departmentsAPI.list().then((r) => r.data.results ?? r.data),
  });

  const createMutation = useMutation({
    mutationFn: (data: FormData) => departmentsAPI.create(data),
    onSuccess: () => {
      toast.success("Department created successfully");
      qc.invalidateQueries({ queryKey: ["departments"] });
      setShowAdd(false);
    },
    onError: (err: any) => {
      const msg = Object.values(err?.response?.data ?? {}).flat().join(" ");
      toast.error(msg || "Failed to create department");
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => departmentsAPI.delete(id),
    onSuccess: () => {
      toast.success("Department deleted");
      qc.invalidateQueries({ queryKey: ["departments"] });
    },
    onError: (err: any) =>
      toast.error(err?.response?.data?.detail || "Cannot delete department with active users"),
  });

  return (
    <div className="max-w-6xl mx-auto">
      <div className="flex items-end justify-between mb-8">
        <div>
          <h1 className="text-3xl font-bold text-foreground tracking-tight">Departments</h1>
          <p className="text-muted-foreground mt-1.5">
            Manage departments and assign team members.
          </p>
        </div>
        <button
          onClick={() => setShowAdd(true)}
          className="btn-primary"
        >
          <Plus className="w-4 h-4" /> New department
        </button>
      </div>

      {/* Add New Department Form */}
      {showAdd && (
        <div className="card p-6 max-w-2xl mb-8">
          <h2 className="text-base font-semibold mb-4 text-foreground">Create new department</h2>
          <DeptForm
            onSubmit={(data) => createMutation.mutate(data)}
            onCancel={() => setShowAdd(false)}
            isPending={createMutation.isPending}
          />
        </div>
      )}

      {/* Departments Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
        {isLoading && Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="card p-6 animate-pulse">
            <div className="h-6 bg-muted rounded w-3/4 mb-4" />
            <div className="h-4 bg-muted rounded w-1/2" />
          </div>
        ))}

        {!isLoading && departments.map((dept) => (
          <div
            key={dept.id}
            onClick={() => setSelectedDept(dept)}
            className="card p-6 transition-all duration-200 cursor-pointer group border-border hover:border-accent/40"
            style={{ boxShadow: "var(--shadow-card)" }}
          >
            <div className="flex items-start justify-between">
              <div className="flex items-center gap-3">
                <div className="w-12 h-12 rounded-xl bg-accent/15 flex items-center justify-center flex-shrink-0">
                  <Building2 className="w-6 h-6 text-accent" />
                </div>
                <div>
                  <h3 className="font-semibold text-lg text-foreground group-hover:text-accent transition-colors">
                    {dept.name}
                  </h3>
                  <p className="text-[11px] text-muted-foreground font-mono tracking-wider uppercase mt-0.5">
                    Code · {dept.code}
                  </p>
                </div>
              </div>
            </div>

            <div className="mt-6 flex items-center justify-between">
              <div className="text-sm">
                <span className="font-semibold text-foreground">{dept.user_count}</span>
                <span className="text-muted-foreground"> active members</span>
              </div>

              <div className="opacity-0 group-hover:opacity-100 transition-all">
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    if (dept.user_count > 0) {
                      toast.error(`Cannot delete: Reassign the ${dept.user_count} user(s) first`);
                      return;
                    }
                    if (confirm(`Delete department "${dept.name}"?`)) {
                      deleteMutation.mutate(dept.id);
                    }
                  }}
                  className="text-destructive hover:bg-destructive/10 border border-destructive/30 px-3 py-1.5 rounded-lg text-xs transition-colors flex items-center gap-1.5"
                >
                  <Trash2 className="w-3.5 h-3.5" /> Delete
                </button>
              </div>
            </div>
          </div>
        ))}

        {!isLoading && !departments.length && !showAdd && (
          <div className="col-span-full py-20 text-center">
            <Building2 className="w-16 h-16 text-muted-foreground/30 mx-auto mb-5" />
            <p className="text-xl font-semibold text-foreground">No departments yet</p>
            <p className="text-muted-foreground mt-2 max-w-md mx-auto text-sm">
              Create departments to better organize your team and control document access.
            </p>
            <button
              onClick={() => setShowAdd(true)}
              className="btn-primary mt-6"
            >
              <Plus className="w-4 h-4" /> Create first department
            </button>
          </div>
        )}
      </div>

      {/* Department Detail Slide-over */}
      {selectedDept && (
        <DepartmentDetail
          department={selectedDept}
          onClose={() => setSelectedDept(null)}
        />
      )}
    </div>
  );
}
