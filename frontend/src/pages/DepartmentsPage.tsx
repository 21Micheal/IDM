import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { departmentsAPI, usersAPI } from "@/services/api";
import {
  Plus, Edit2, Trash2, Loader2, Building2, X, UserPlus, Users, Check,
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
  role: string;
  role_display?: string;
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
        {errors.name && <p className="text-red-500 text-xs mt-1">{errors.name.message}</p>}
      </div>
      <div className="w-32">
        <input
          {...register("code")}
          className="input uppercase"
          placeholder="Code"
        />
        {errors.code && <p className="text-red-500 text-xs mt-1">{errors.code.message}</p>}
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
    enabled: !!userSearch || true,
  });

  const addMemberMutation = useMutation({
    mutationFn: (userId: string) =>
      usersAPI.update(userId, { department: department.id }),
    onSuccess: () => {
      toast.success("User added to department");
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
    <div className="fixed inset-0 z-40 flex">
      <div className="flex-1 bg-black/40" onClick={onClose} />
      
      <div className="w-full max-w-2xl bg-white shadow-2xl flex flex-col overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-brand-50 flex items-center justify-center">
              <Building2 className="w-5 h-5 text-brand-600" />
            </div>
            <div>
              <h2 className="font-semibold text-gray-900 text-lg">{department.name}</h2>
              <p className="text-sm text-gray-500 font-mono">Code: {department.code}</p>
            </div>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-6 space-y-8">
          {/* Members Section */}
          <div>
            <div className="flex items-center justify-between mb-4">
              <h3 className="font-medium text-gray-900 flex items-center gap-2">
                <Users className="w-4 h-4" />
                Members ({members.length})
              </h3>
            </div>

            <div className="space-y-2">
              {membersLoading ? (
                <div className="text-center py-8 text-gray-400">Loading members...</div>
              ) : members.length === 0 ? (
                <div className="text-center py-8 text-gray-400">
                  No members in this department yet.
                </div>
              ) : (
                members.map((user) => (
                  <div
                    key={user.id}
                    className="flex items-center gap-3 p-3 rounded-lg border border-gray-100 hover:bg-gray-50 group"
                  >
                    <div className="w-8 h-8 rounded-full bg-brand-100 flex items-center justify-center text-brand-700 text-xs font-semibold flex-shrink-0">
                      {user.full_name.split(" ").map((n) => n[0]).join("").slice(0, 2)}
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="font-medium text-gray-900">{user.full_name}</p>
                      <p className="text-xs text-gray-500 truncate">{user.email}</p>
                    </div>
                    <button
                      onClick={() => removeMemberMutation.mutate(user.id)}
                      className="opacity-0 group-hover:opacity-100 text-red-500 hover:text-red-600 transition-all p-1"
                      title="Remove from department"
                    >
                      <X className="w-4 h-4" />
                    </button>
                  </div>
                ))
              )}
            </div>
          </div>

          {/* Add Members Section */}
          <div>
            <h3 className="font-medium text-gray-900 mb-3">Add members</h3>
            <input
              value={userSearch}
              onChange={(e) => setUserSearch(e.target.value)}
              className="input mb-3"
              placeholder="Search users by name or email..."
            />

            <div className="max-h-80 overflow-y-auto border border-gray-100 rounded-lg divide-y divide-gray-100">
              {allUsers
                .filter((u) => !memberIds.has(u.id))
                .map((user) => (
                  <div
                    key={user.id}
                    className="flex items-center gap-3 p-3 hover:bg-gray-50"
                  >
                    <div className="w-8 h-8 rounded-full bg-gray-100 flex items-center justify-center text-gray-600 text-xs font-semibold flex-shrink-0">
                      {user.full_name.split(" ").map((n) => n[0]).join("").slice(0, 2)}
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-gray-900">{user.full_name}</p>
                      <p className="text-xs text-gray-500 truncate">{user.email}</p>
                    </div>
                    <button
                      onClick={() => addMemberMutation.mutate(user.id)}
                      disabled={addMemberMutation.isPending}
                      className="btn-primary text-xs px-3 py-1 flex items-center gap-1"
                    >
                      <UserPlus className="w-3.5 h-3.5" /> Add
                    </button>
                  </div>
                ))}
              {allUsers.length === 0 && userSearch && (
                <div className="p-6 text-center text-gray-400">No users found.</div>
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
  const [editId, setEditId] = useState<string | null>(null);
  const [selectedDept, setSelectedDept] = useState<Department | null>(null);

  const { data: departments = [], isLoading } = useQuery<Department[]>({
    queryKey: ["departments"],
    queryFn: () => departmentsAPI.list().then((r) => r.data.results ?? r.data),
  });

  const createMutation = useMutation({
    mutationFn: (data: FormData) => departmentsAPI.create(data),
    onSuccess: () => {
      toast.success("Department created");
      qc.invalidateQueries({ queryKey: ["departments"] });
      setShowAdd(false);
    },
    onError: (err: any) => {
      const msg = Object.values(err?.response?.data ?? {}).flat().join(" ");
      toast.error(msg || "Failed to create department");
    },
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, data }: { id: string; data: FormData }) =>
      departmentsAPI.update(id, data),
    onSuccess: () => {
      toast.success("Department updated");
      qc.invalidateQueries({ queryKey: ["departments"] });
      setEditId(null);
    },
    onError: () => toast.error("Update failed"),
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
    <div className="space-y-5 max-w-4xl">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Departments</h1>
          <p className="text-gray-500 text-sm mt-1">
            Organise users into departments. Click a department to manage its members.
          </p>
        </div>
        <button onClick={() => setShowAdd(true)} className="btn-primary">
          <Plus className="w-4 h-4" /> Add department
        </button>
      </div>

      {/* Add New Form */}
      {showAdd && (
        <div className="card p-5">
          <p className="text-sm font-medium text-gray-700 mb-3">New department</p>
          <DeptForm
            onSubmit={(data) => createMutation.mutate(data)}
            onCancel={() => setShowAdd(false)}
            isPending={createMutation.isPending}
          />
        </div>
      )}

      {/* Departments List */}
      <div className="card divide-y divide-gray-100">
        {isLoading && Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="px-6 py-5 flex items-center gap-4 animate-pulse">
            <div className="w-9 h-9 bg-gray-100 rounded-lg" />
            <div className="flex-1 space-y-2">
              <div className="h-4 bg-gray-100 rounded w-2/3" />
              <div className="h-3 bg-gray-100 rounded w-1/3" />
            </div>
          </div>
        ))}

        {!isLoading && departments.map((dept) => (
          <div
            key={dept.id}
            className="px-6 py-5 hover:bg-gray-50 transition-colors cursor-pointer group"
            onClick={() => setSelectedDept(dept)}
          >
            <div className="flex items-center gap-4">
              <div className="w-9 h-9 rounded-lg bg-brand-50 flex items-center justify-center flex-shrink-0">
                <Building2 className="w-4 h-4 text-brand-600" />
              </div>

              <div className="flex-1 min-w-0">
                <p className="font-medium text-gray-900 group-hover:text-brand-700 transition-colors">
                  {dept.name}
                </p>
                <p className="text-xs text-gray-500">
                  Code: <span className="font-mono uppercase">{dept.code}</span>
                  {" · "}
                  {dept.user_count} active {dept.user_count === 1 ? "user" : "users"}
                </p>
              </div>

              <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-all">
                <button
                  onClick={(e) => { e.stopPropagation(); setEditId(dept.id); }}
                  className="btn-secondary text-xs px-2 py-1"
                >
                  <Edit2 className="w-3.5 h-3.5" />
                </button>
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
                  className="text-gray-400 hover:text-red-500 border border-gray-200 rounded-lg px-2 py-1 text-xs transition-colors"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>

            {/* Inline Edit Form */}
            {editId === dept.id && (
              <div className="mt-4 pt-4 border-t border-gray-100">
                <DeptForm
                  defaultValues={{ name: dept.name, code: dept.code }}
                  onSubmit={(data) => updateMutation.mutate({ id: dept.id, data })}
                  onCancel={() => setEditId(null)}
                  isPending={updateMutation.isPending}
                />
              </div>
            )}
          </div>
        ))}

        {!isLoading && !departments.length && !showAdd && (
          <div className="px-6 py-16 text-center">
            <Building2 className="w-10 h-10 text-gray-200 mx-auto mb-3" />
            <p className="text-gray-500">No departments created yet.</p>
            <button onClick={() => setShowAdd(true)} className="btn-primary mt-4">
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