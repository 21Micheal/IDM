import { useState } from "react";
import { extractApiError } from "@/lib/apiError";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { departmentsAPI, usersAPI } from "@/services/api";
import {
  Plus, Trash2, Loader2, Building2, X, UserPlus, Users, Check, Crown,
} from "lucide-react";
import { toast } from "@/components/ui/vault-toast";

interface Department {
  id: string;
  name: string;
  code: string;
  head: User | null;
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
  onDepartmentUpdated,
  onClose,
}: {
  department: Department;
  onDepartmentUpdated: (department: Department) => void;
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
    onError: (err) => toast.error(extractApiError(err, "Failed to add user")),
  });

  const removeMemberMutation = useMutation({
    mutationFn: (userId: string) =>
      usersAPI.update(userId, { department: null }),
    onSuccess: () => {
      toast.success("User removed from department");
      qc.invalidateQueries({ queryKey: ["department-members", department.id] });
      qc.invalidateQueries({ queryKey: ["departments"] });
    },
    onError: (err: any) =>
      toast.error(err?.response?.data?.department?.[0] || "Failed to remove user"),
  });

  const setHeadMutation = useMutation({
    mutationFn: (headId: string | null) =>
      departmentsAPI.update(department.id, { head_id: headId }),
    onSuccess: ({ data }) => {
      toast.success(data.head ? "Department head updated" : "Department head cleared");
      onDepartmentUpdated(data);
      qc.invalidateQueries({ queryKey: ["departments"] });
      qc.invalidateQueries({ queryKey: ["groups"] });
      qc.invalidateQueries({ queryKey: ["group-members"] });
    },
    onError: (err: any) =>
      toast.error(err?.response?.data?.head_id?.[0] || "Failed to update department head"),
  });

  const memberIds = new Set(members.map((m) => m.id));
  const currentHead = department.head;

  return (
    <div className="fixed inset-0 z-50 flex">
      <div className="flex-1 bg-black/40" onClick={onClose} />

      <div className="w-full max-w-2xl bg-white flex flex-col overflow-hidden border-l border-[#C8CDD2]">
        {/* Header */}
        <div className="flex items-center justify-between px-8 py-6 border-b border-[#C8CDD2] bg-[#287EAD]">
          <div className="flex items-center gap-4">
            <div className="flex h-12 w-12 items-center justify-center border border-white/25 bg-white/10 flex-shrink-0">
              <Building2 className="w-6 h-6 text-white" />
            </div>
            <div>
              <h2 className="font-semibold text-xl text-white tracking-tight">{department.name}</h2>
              <p className="text-xs text-white/75 font-mono tracking-wider uppercase mt-1">Code · {department.code}</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-2 text-white/70 hover:text-white hover:bg-white/10 transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-8 space-y-8">
          {/* Department Head */}
          <div>
            <div className="flex justify-between items-center mb-4">
              <h3 className="font-semibold text-base text-[#1F2933] flex items-center gap-2">
                <Crown className="w-4 h-4 text-[#5E6870]" />
                Department head
              </h3>
              {currentHead && (
                <button
                  type="button"
                  onClick={() => setHeadMutation.mutate(null)}
                  disabled={setHeadMutation.isPending}
                  className="text-xs font-semibold text-[#5E6870] hover:text-red-600 transition-colors"
                >
                  Clear head
                </button>
              )}
            </div>

            {currentHead ? (
              <div className="flex items-center gap-4 p-4 bg-[#EEF6FB] border border-[#BDE3F5]">
                <div className="flex h-10 w-10 items-center justify-center border border-[#BDE3F5] bg-[#287EAD] text-white text-sm font-bold flex-shrink-0">
                  {currentHead.full_name.split(" ").map((n) => n[0]).join("").slice(0, 2)}
                </div>
                <div className="flex-1 min-w-0">
                  <p className="font-medium text-[#1F2933] text-sm">{currentHead.full_name}</p>
                  <p className="text-xs text-[#5E6870] truncate">{currentHead.email}</p>
                </div>
                <span className="border border-[#BDE3F5] bg-[#EEF6FB] text-[#287EAD] text-xs px-2 py-0.5 font-semibold">HOD</span>
              </div>
            ) : (
              <div className="border border-dashed border-[#C8CDD2] p-8 text-center">
                <Crown className="w-9 h-9 text-[#C8CDD2] mx-auto mb-3" />
                <p className="text-[#5E6870] text-sm">No department head has been set.</p>
              </div>
            )}
          </div>

          {/* Members Section */}
          <div>
            <div className="flex justify-between items-center mb-4">
              <h3 className="font-semibold text-base text-[#1F2933] flex items-center gap-2">
                <Users className="w-4 h-4 text-[#5E6870]" />
                Members <span className="text-[#5E6870] font-normal">({members.length})</span>
              </h3>
            </div>

            <div className="space-y-2">
              {membersLoading ? (
                <div className="text-center py-12 text-[#5E6870] text-sm">Loading members…</div>
              ) : members.length === 0 ? (
                <div className="border border-dashed border-[#C8CDD2] p-12 text-center">
                  <Users className="w-10 h-10 text-[#C8CDD2] mx-auto mb-3" />
                  <p className="text-[#5E6870] text-sm">No members in this department yet.</p>
                </div>
              ) : (
                members.map((user) => (
                  <div
                    key={user.id}
                    className="flex items-center gap-4 p-4 bg-white border border-[#C8CDD2] hover:border-[#287EAD]/40 transition-colors group"
                  >
                    <div className="flex h-10 w-10 items-center justify-center border border-[#C8CDD2] bg-[#EEF6FB] text-[#287EAD] text-sm font-bold flex-shrink-0">
                      {user.full_name.split(" ").map((n) => n[0]).join("").slice(0, 2)}
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="font-medium text-[#1F2933] text-sm">{user.full_name}</p>
                      <p className="text-xs text-[#5E6870] truncate">{user.email}</p>
                    </div>
                    <div className="flex items-center gap-3">
                      {currentHead?.id === user.id && (
                        <span className="border border-[#BDE3F5] bg-[#EEF6FB] text-[#287EAD] text-xs px-2 py-0.5 font-semibold">Head</span>
                      )}
                      <span className="border border-[#C8CDD2] bg-[#F5F7F8] text-[#5E6870] text-xs px-2 py-0.5">
                        {user.job_description || "Staff"}
                      </span>
                      {currentHead?.id !== user.id && (
                        <button
                          onClick={() => setHeadMutation.mutate(user.id)}
                          disabled={setHeadMutation.isPending}
                          className="opacity-0 group-hover:opacity-100 text-[#287EAD] hover:bg-[#EEF6FB] p-2 transition-all"
                          title="Set as department head"
                        >
                          <Crown className="w-4 h-4" />
                        </button>
                      )}
                      <button
                        onClick={() => removeMemberMutation.mutate(user.id)}
                        disabled={currentHead?.id === user.id}
                        className="opacity-0 group-hover:opacity-100 text-red-600 hover:bg-red-50 p-2 transition-all disabled:opacity-20"
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
            <h3 className="font-semibold text-base text-[#1F2933] mb-4">Add new members</h3>

            <input
              value={userSearch}
              onChange={(e) => setUserSearch(e.target.value)}
              className="input mb-4"
              placeholder="Search users by name or email…"
            />

            <div className="max-h-[420px] overflow-y-auto border border-[#C8CDD2] divide-y divide-[#C8CDD2] bg-white">
              {allUsers
                .filter((u) => !memberIds.has(u.id))
                .map((user) => (
                  <div
                    key={user.id}
                    className="flex items-center gap-4 p-4 hover:bg-[#F5F7F8] transition-colors"
                  >
                    <div className="flex h-10 w-10 items-center justify-center border border-[#C8CDD2] bg-[#F5F7F8] text-[#5E6870] text-sm font-bold flex-shrink-0">
                      {user.full_name.split(" ").map((n) => n[0]).join("").slice(0, 2)}
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="font-medium text-[#1F2933] text-sm">{user.full_name}</p>
                      <p className="text-xs text-[#5E6870] truncate">{user.email}</p>
                    </div>
                    <button
                      onClick={() => addMemberMutation.mutate(user.id)}
                      disabled={addMemberMutation.isPending}
                      className="inline-flex items-center gap-1.5 border border-[#287EAD] bg-[#287EAD] px-3 py-1.5 text-xs font-medium text-white hover:bg-[#206D99] transition-colors disabled:opacity-60"
                    >
                      <UserPlus className="w-3.5 h-3.5" /> Add
                    </button>
                  </div>
                ))}

              {allUsers.length === 0 && userSearch && (
                <div className="p-12 text-center text-[#5E6870] text-sm">No users found.</div>
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
      toast.error(extractApiError(err, "Cannot delete department with active users")),
  });

  return (
    <div className="admin-shell">
      <div className="admin-page-header flex items-end justify-between gap-4">
        <div>
          <h1 className="admin-page-title">Departments</h1>
          <p className="admin-page-subtitle">
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
        <div className="border border-[#C8CDD2] bg-white p-6 max-w-2xl mb-8">
          <h2 className="text-base font-semibold mb-4 text-[#1F2933]">Create new department</h2>
          <DeptForm
            onSubmit={(data) => createMutation.mutate(data)}
            onCancel={() => setShowAdd(false)}
            isPending={createMutation.isPending}
          />
        </div>
      )}

      {/* Departments Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {isLoading && Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="border border-[#C8CDD2] bg-white p-6 animate-pulse">
            <div className="h-6 bg-[#EDEDED] w-3/4 mb-4" />
            <div className="h-4 bg-[#EDEDED] w-1/2" />
          </div>
        ))}

        {!isLoading && departments.map((dept) => (
          <div
            key={dept.id}
            onClick={() => setSelectedDept(dept)}
            className="border border-[#C8CDD2] bg-white p-6 transition-colors cursor-pointer group hover:border-[#287EAD]/40 hover:bg-[#F5F7F8]"
          >
            <div className="flex items-start justify-between">
              <div className="flex items-center gap-3">
                <div className="flex h-12 w-12 items-center justify-center border border-[#C8CDD2] bg-[#EEF6FB] flex-shrink-0">
                  <Building2 className="w-6 h-6 text-[#287EAD]" />
                </div>
                <div>
                  <h3 className="font-semibold text-base text-[#1F2933] group-hover:text-[#287EAD] transition-colors">
                    {dept.name}
                  </h3>
                  <p className="text-[11px] text-[#5E6870] font-mono tracking-wider uppercase mt-0.5">
                    Code · {dept.code}
                  </p>
                </div>
              </div>
            </div>

            <div className="mt-6 flex items-center justify-between">
              <div className="text-sm">
                <span className="font-semibold text-[#1F2933]">{dept.user_count}</span>
                <span className="text-[#5E6870]"> active members</span>
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
                  className="text-red-600 hover:bg-red-50 border border-red-200 px-3 py-1.5 text-xs transition-colors flex items-center gap-1.5"
                >
                  <Trash2 className="w-3.5 h-3.5" /> Delete
                </button>
              </div>
            </div>
          </div>
        ))}

        {!isLoading && !departments.length && !showAdd && (
          <div className="col-span-full py-20 text-center">
            <Building2 className="w-16 h-16 text-[#C8CDD2] mx-auto mb-5" />
            <p className="text-xl font-semibold text-[#1F2933]">No departments yet</p>
            <p className="text-[#5E6870] mt-2 max-w-md mx-auto text-sm">
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
          onDepartmentUpdated={setSelectedDept}
          onClose={() => setSelectedDept(null)}
        />
      )}
    </div>
  );
}
