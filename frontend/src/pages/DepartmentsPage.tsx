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
      <div className="flex-1 bg-black/60" onClick={onClose} />
      
      <div className="w-full max-w-2xl bg-white shadow-2xl flex flex-col overflow-hidden rounded-l-3xl">
        {/* Header */}
        <div className="flex items-center justify-between px-8 py-6 border-b border-gray-100 bg-gray-50">
          <div className="flex items-center gap-4">
            <div className="w-12 h-12 rounded-2xl bg-brand-100 flex items-center justify-center">
              <Building2 className="w-6 h-6 text-brand-600" />
            </div>
            <div>
              <h2 className="font-semibold text-2xl text-gray-900">{department.name}</h2>
              <p className="text-sm text-gray-500 font-mono tracking-wider">CODE • {department.code}</p>
            </div>
          </div>
          <button 
            onClick={onClose} 
            className="p-3 text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded-full transition-colors"
          >
            <X className="w-6 h-6" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-8 space-y-12">
          {/* Members Section */}
          <div>
            <div className="flex justify-between items-center mb-6">
              <h3 className="font-semibold text-xl text-gray-900 flex items-center gap-3">
                <Users className="w-5 h-5" />
                Members ({members.length})
              </h3>
            </div>

            <div className="space-y-3">
              {membersLoading ? (
                <div className="text-center py-12 text-gray-400">Loading members...</div>
              ) : members.length === 0 ? (
                <div className="border border-dashed border-gray-200 rounded-2xl p-12 text-center">
                  <Users className="w-12 h-12 text-gray-300 mx-auto mb-3" />
                  <p className="text-gray-500">No members in this department yet.</p>
                </div>
              ) : (
                members.map((user) => (
                  <div
                    key={user.id}
                    className="flex items-center gap-4 p-5 bg-white border border-gray-100 rounded-2xl hover:border-gray-200 group"
                  >
                    <div className="w-11 h-11 rounded-2xl bg-brand-100 flex items-center justify-center text-brand-700 text-base font-semibold flex-shrink-0">
                      {user.full_name.split(" ").map((n) => n[0]).join("").slice(0, 2)}
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="font-medium text-gray-900">{user.full_name}</p>
                      <p className="text-sm text-gray-500 truncate">{user.email}</p>
                    </div>
                    <div className="flex items-center gap-3">
                      <span className="badge text-xs px-3 py-1">
                        {user.role_display || user.role}
                      </span>
                      <button
                        onClick={() => removeMemberMutation.mutate(user.id)}
                        className="opacity-0 group-hover:opacity-100 text-red-500 hover:text-red-600 p-2 rounded-xl hover:bg-red-50 transition-all"
                        title="Remove from department"
                      >
                        <X className="w-5 h-5" />
                      </button>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>

          {/* Add Members Section */}
          <div>
            <h3 className="font-semibold text-xl text-gray-900 mb-5">Add New Members</h3>
            
            <input
              value={userSearch}
              onChange={(e) => setUserSearch(e.target.value)}
              className="input mb-5"
              placeholder="Search users by name or email..."
            />

            <div className="max-h-[420px] overflow-y-auto border border-gray-100 rounded-2xl divide-y divide-gray-100">
              {allUsers
                .filter((u) => !memberIds.has(u.id))
                .map((user) => (
                  <div
                    key={user.id}
                    className="flex items-center gap-4 p-5 hover:bg-gray-50 transition-colors"
                  >
                    <div className="w-11 h-11 rounded-2xl bg-gray-100 flex items-center justify-center text-gray-600 text-base font-semibold flex-shrink-0">
                      {user.full_name.split(" ").map((n) => n[0]).join("").slice(0, 2)}
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="font-medium text-gray-900">{user.full_name}</p>
                      <p className="text-sm text-gray-500 truncate">{user.email}</p>
                    </div>
                    <button
                      onClick={() => addMemberMutation.mutate(user.id)}
                      disabled={addMemberMutation.isPending}
                      className="btn-primary text-sm px-6 py-2.5 flex items-center gap-2"
                    >
                      <UserPlus className="w-4 h-4" /> Add
                    </button>
                  </div>
                ))}

              {allUsers.length === 0 && userSearch && (
                <div className="p-12 text-center text-gray-400">No users found.</div>
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
    <div className="max-w-6xl mx-auto py-10">
      <div className="flex items-end justify-between mb-10">
        <div>
          <h1 className="text-4xl font-bold text-gray-900">Departments</h1>
          <p className="text-gray-500 mt-2 text-lg">
            Manage departments and assign team members
          </p>
        </div>
        <button 
          onClick={() => setShowAdd(true)} 
          className="btn-primary flex items-center gap-2 px-6 py-3"
        >
          <Plus className="w-5 h-5" /> New Department
        </button>
      </div>

      {/* Add New Department Form */}
      {showAdd && (
        <div className="card p-8 max-w-lg mx-auto mb-10">
          <h2 className="text-xl font-semibold mb-6">Create New Department</h2>
          <DeptForm
            onSubmit={(data) => createMutation.mutate(data)}
            onCancel={() => setShowAdd(false)}
            isPending={createMutation.isPending}
          />
        </div>
      )}

      {/* Departments Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        {isLoading && Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="card p-8 animate-pulse">
            <div className="h-8 bg-gray-100 rounded-xl w-3/4 mb-4" />
            <div className="h-4 bg-gray-100 rounded w-1/2" />
          </div>
        ))}

        {!isLoading && departments.map((dept) => (
          <div
            key={dept.id}
            onClick={() => setSelectedDept(dept)}
            className="card p-8 hover:shadow-xl transition-all duration-300 cursor-pointer group border border-transparent hover:border-brand-100"
          >
            <div className="flex items-start justify-between">
              <div className="flex items-center gap-4">
                <div className="w-14 h-14 rounded-2xl bg-brand-100 flex items-center justify-center flex-shrink-0">
                  <Building2 className="w-7 h-7 text-brand-600" />
                </div>
                <div>
                  <h3 className="font-semibold text-2xl text-gray-900 group-hover:text-brand-700 transition-colors">
                    {dept.name}
                  </h3>
                  <p className="text-sm text-gray-500 font-mono mt-0.5">CODE • {dept.code}</p>
                </div>
              </div>
            </div>

            <div className="mt-8 flex items-center justify-between">
              <div className="text-sm">
                <span className="font-medium text-gray-900">{dept.user_count}</span>
                <span className="text-gray-500"> active members</span>
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
                  className="text-red-600 hover:bg-red-50 border border-red-200 px-5 py-2 rounded-xl text-sm transition-colors flex items-center gap-1"
                >
                  <Trash2 className="w-4 h-4" /> Delete
                </button>
              </div>
            </div>
          </div>
        ))}

        {!isLoading && !departments.length && !showAdd && (
          <div className="col-span-full py-24 text-center">
            <Building2 className="w-20 h-20 text-gray-200 mx-auto mb-6" />
            <p className="text-2xl font-medium text-gray-600">No departments yet</p>
            <p className="text-gray-500 mt-3 max-w-md mx-auto">
              Create departments to better organize your team and control document access.
            </p>
            <button 
              onClick={() => setShowAdd(true)} 
              className="btn-primary mt-8"
            >
              <Plus className="w-5 h-5 mr-2" /> Create First Department
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