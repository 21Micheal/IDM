import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { departmentsAPI } from "@/services/api";
import { Plus, Edit2, Trash2, Loader2, Building2, X, Check } from "lucide-react";
import { toast } from "react-toastify";

interface Department {
  id: string;
  name: string;
  code: string;
  user_count: number;
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

export default function DepartmentsPage() {
  const qc = useQueryClient();
  const [showAdd, setShowAdd]       = useState(false);
  const [editId, setEditId]         = useState<string | null>(null);

  const { data: departments, isLoading } = useQuery<Department[]>({
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
    onError: (err: { response?: { data?: Record<string, string[]> } }) => {
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
    onError: (err: { response?: { data?: { detail?: string } } }) =>
      toast.error(err?.response?.data?.detail || "Cannot delete department"),
  });

  return (
    <div className="space-y-5 max-w-2xl">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Departments</h1>
          <p className="text-gray-500 text-sm mt-1">
            Organise users into departments for document access scoping.
          </p>
        </div>
        <button onClick={() => setShowAdd(true)} className="btn-primary">
          <Plus className="w-4 h-4" /> Add department
        </button>
      </div>

      {showAdd && (
        <div className="card p-4">
          <p className="text-sm font-medium text-gray-700 mb-3">New department</p>
          <DeptForm
            onSubmit={(data) => createMutation.mutate(data)}
            onCancel={() => setShowAdd(false)}
            isPending={createMutation.isPending}
          />
        </div>
      )}

      <div className="card divide-y divide-gray-100">
        {isLoading && Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="px-5 py-4 flex items-center gap-3 animate-pulse">
            <div className="w-8 h-8 bg-gray-100 rounded-lg" />
            <div className="flex-1 space-y-2">
              <div className="h-4 bg-gray-100 rounded w-1/3" />
              <div className="h-3 bg-gray-100 rounded w-1/4" />
            </div>
          </div>
        ))}

        {!isLoading && departments?.map((dept) => (
          <div key={dept.id} className="px-5 py-4">
            {editId === dept.id ? (
              <DeptForm
                defaultValues={{ name: dept.name, code: dept.code }}
                onSubmit={(data) => updateMutation.mutate({ id: dept.id, data })}
                onCancel={() => setEditId(null)}
                isPending={updateMutation.isPending}
              />
            ) : (
              <div className="flex items-center gap-3">
                <div className="w-9 h-9 rounded-lg bg-brand-50 flex items-center justify-center flex-shrink-0">
                  <Building2 className="w-4 h-4 text-brand-600" />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="font-medium text-gray-900">{dept.name}</p>
                  <p className="text-xs text-gray-500">
                    Code: <span className="font-mono">{dept.code}</span>
                    {" · "}
                    {dept.user_count} active {dept.user_count === 1 ? "user" : "users"}
                  </p>
                </div>
                <div className="flex gap-1">
                  <button
                    onClick={() => setEditId(dept.id)}
                    className="btn-secondary text-xs px-2 py-1"
                  >
                    <Edit2 className="w-3.5 h-3.5" />
                  </button>
                  <button
                    onClick={() => {
                      if (dept.user_count > 0) {
                        toast.error(`Reassign the ${dept.user_count} user(s) first`);
                        return;
                      }
                      deleteMutation.mutate(dept.id);
                    }}
                    className="text-gray-400 hover:text-red-500 border border-gray-300 rounded-lg px-2 py-1 text-xs transition-colors"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
            )}
          </div>
        ))}

        {!isLoading && !departments?.length && !showAdd && (
          <div className="px-5 py-12 text-center">
            <Building2 className="w-8 h-8 text-gray-200 mx-auto mb-3" />
            <p className="text-sm text-gray-500">No departments yet.</p>
            <button onClick={() => setShowAdd(true)} className="btn-primary mt-3">
              <Plus className="w-4 h-4" /> Create first department
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
