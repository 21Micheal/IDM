import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { usersAPI, departmentsAPI } from "@/services/api";
import { Search, Users as UsersIcon } from "lucide-react";
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
  department_name: string | null;
  is_active: boolean;
  mfa_enabled: boolean;
  last_login: string | null;
  created_at: string;
}

export default function UsersPage() {
  const navigate = useNavigate();
  const [search, setSearch] = useState("");
  const [deptFilter, setDeptFilter] = useState("");

  const { data: users, isLoading } = useQuery<User[]>({
    queryKey: ["users", { search, department: deptFilter }],
    queryFn: () =>
      usersAPI
        .list({
          search: search || undefined,
          department: deptFilter || undefined,
        })
        .then((r) => r.data.results ?? r.data),
  });

  const { data: departments } = useQuery<Department[]>({
    queryKey: ["departments"],
    queryFn: () => departmentsAPI.list().then((r) => r.data.results ?? r.data),
  });

  return (
    <div className="max-w-6xl mx-auto py-8">
      <div className="mb-8">
        <div className="flex items-center gap-3 mb-2">
          <div className="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center">
            <UsersIcon className="w-5 h-5 text-primary" />
          </div>
          <h1 className="text-3xl font-bold text-foreground tracking-tight">Users</h1>
        </div>
        <p className="text-muted-foreground text-sm">
          Click a user to view profile, settings, delegations, and task reassignment.
        </p>
      </div>

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
        <select value={deptFilter} onChange={(e) => setDeptFilter(e.target.value)} className="input w-56">
          <option value="">All departments</option>
          {departments?.map((d) => (
            <option key={d.id} value={d.id}>
              {d.name}
            </option>
          ))}
        </select>
      </div>

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
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {isLoading &&
                Array.from({ length: 6 }).map((_, i) => (
                  <tr key={i}>
                    {Array.from({ length: 7 }).map((_, j) => (
                      <td key={j} className="px-6 py-4">
                        <div className="h-4 bg-muted rounded animate-pulse" />
                      </td>
                    ))}
                  </tr>
                ))}
              {!isLoading &&
                users?.map((user) => (
                  <tr
                    key={user.id}
                    onClick={() => navigate(`/admin/users/${user.id}`)}
                    className="cursor-pointer hover:bg-muted/40 transition-colors"
                  >
                    <td className="px-6 py-4">
                      <p className="font-medium text-foreground">{user.full_name}</p>
                      <p className="text-xs text-muted-foreground">{user.email}</p>
                    </td>
                    <td className="px-6 py-4 text-foreground">{user.job_description || "—"}</td>
                    <td className="px-6 py-4 text-muted-foreground">{user.department_name || "—"}</td>
                    <td className="px-6 py-4">
                      <span className="badge">{user.is_active ? "Active" : "Inactive"}</span>
                    </td>
                    <td className="px-6 py-4">
                      <span className="badge">{user.mfa_enabled ? "Enabled" : "Off"}</span>
                    </td>
                    <td className="px-6 py-4 text-muted-foreground text-xs">
                      {user.last_login ? format(new Date(user.last_login), "dd MMM yyyy HH:mm") : "Never"}
                    </td>
                    <td className="px-6 py-4 text-muted-foreground text-xs">
                      {format(new Date(user.created_at), "dd MMM yyyy")}
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
