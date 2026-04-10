import { useQuery } from "@tanstack/react-query";
import { documentsAPI, workflowAPI } from "@/services/api";
import { useAuthStore } from "@/store/authStore";
import { FileText, Clock, CheckCircle, AlertCircle, GitBranch, TrendingUp } from "lucide-react";
import { Link } from "react-router-dom";
import StatusBadge from "@/components/documents/StatusBadge";
import { formatDistanceToNow } from "date-fns";
import type { Document, WorkflowTask } from "@/types";

interface StatCardProps {
  label: string;
  value: number | string;
  icon: React.ElementType;
  color: string;
  to?: string;
}

function StatCard({ label, value, icon: Icon, color, to }: StatCardProps) {
  const inner = (
    <div className={`card p-5 flex items-center gap-4 hover:shadow-md transition-shadow`}>
      <div className={`w-12 h-12 rounded-xl flex items-center justify-center ${color}`}>
        <Icon className="w-6 h-6" />
      </div>
      <div>
        <p className="text-2xl font-bold text-gray-900">{value}</p>
        <p className="text-sm text-gray-500">{label}</p>
      </div>
    </div>
  );
  return to ? <Link to={to}>{inner}</Link> : inner;
}

export default function DashboardPage() {
  const user = useAuthStore((s) => s.user);

  const { data: allDocs } = useQuery({
    queryKey: ["documents", "dashboard"],
    queryFn: () => documentsAPI.list({ page_size: 5 }).then((r) => r.data),
  });

  const { data: pendingDocs } = useQuery({
    queryKey: ["documents", "pending"],
    queryFn: () =>
      documentsAPI
        .list({ status: "pending_approval", page_size: 100 })
        .then((r) => r.data.count),
  });

  const { data: approvedDocs } = useQuery({
    queryKey: ["documents", "approved"],
    queryFn: () =>
      documentsAPI.list({ status: "approved", page_size: 100 }).then((r) => r.data.count),
  });

  const { data: myTasks } = useQuery({
    queryKey: ["workflow", "my-tasks"],
    queryFn: () => workflowAPI.myTasks().then((r) => r.data.results),
  });

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">
          Welcome back, {user?.first_name}
        </h1>
        <p className="text-gray-500 text-sm mt-1">
          Here's what's happening with your documents today.
        </p>
      </div>

      {/* Stats grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard
          label="Total documents"
          value={allDocs?.count ?? "—"}
          icon={FileText}
          color="bg-brand-50 text-brand-600"
          to="/documents"
        />
        <StatCard
          label="Pending approval"
          value={pendingDocs ?? "—"}
          icon={Clock}
          color="bg-amber-50 text-amber-600"
          to="/documents?status=pending_approval"
        />
        <StatCard
          label="Approved"
          value={approvedDocs ?? "—"}
          icon={CheckCircle}
          color="bg-green-50 text-green-600"
          to="/documents?status=approved"
        />
        <StatCard
          label="My pending tasks"
          value={myTasks?.length ?? "—"}
          icon={GitBranch}
          color="bg-purple-50 text-purple-600"
          to="/workflow"
        />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Recent documents */}
        <div className="card">
          <div className="p-5 border-b border-gray-100 flex items-center justify-between">
            <h2 className="font-semibold text-gray-900">Recent documents</h2>
            <Link to="/documents" className="text-sm text-brand-600 hover:underline">
              View all
            </Link>
          </div>
          <ul className="divide-y divide-gray-100">
            {allDocs?.results?.map((doc: Document) => (
              <li key={doc.id}>
                <Link
                  to={`/documents/${doc.id}`}
                  className="flex items-start gap-3 px-5 py-3 hover:bg-gray-50 transition-colors"
                >
                  <FileText className="w-4 h-4 text-gray-400 mt-0.5 flex-shrink-0" />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-gray-900 truncate">{doc.title}</p>
                    <p className="text-xs text-gray-500">
                      {doc.reference_number} ·{" "}
                      {formatDistanceToNow(new Date(doc.created_at), { addSuffix: true })}
                    </p>
                  </div>
                  <StatusBadge status={doc.status} />
                </Link>
              </li>
            ))}
            {!allDocs?.results?.length && (
              <li className="px-5 py-8 text-center text-sm text-gray-400">
                No documents yet. <Link to="/documents/upload" className="text-brand-600 hover:underline">Upload one.</Link>
              </li>
            )}
          </ul>
        </div>

        {/* My workflow tasks */}
        <div className="card">
          <div className="p-5 border-b border-gray-100 flex items-center justify-between">
            <h2 className="font-semibold text-gray-900">Pending approvals</h2>
            <Link to="/workflow" className="text-sm text-brand-600 hover:underline">
              View all
            </Link>
          </div>
          <ul className="divide-y divide-gray-100">
            {myTasks?.map((task: WorkflowTask) => (
              <li key={task.id}>
                <Link
                  to={`/documents/${task.workflow_instance.document.id}`}
                  className="flex items-start gap-3 px-5 py-3 hover:bg-gray-50 transition-colors"
                >
                  <AlertCircle className="w-4 h-4 text-amber-500 mt-0.5 flex-shrink-0" />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-gray-900 truncate">
                      {task.workflow_instance.document.title}
                    </p>
                    <p className="text-xs text-gray-500">
                      {task.workflow_instance.document.reference_number} · Step: {task.step.name}
                    </p>
                  </div>
                  {task.due_at && (
                    <span className="text-xs text-gray-400">
                      Due {formatDistanceToNow(new Date(task.due_at), { addSuffix: true })}
                    </span>
                  )}
                </Link>
              </li>
            ))}
            {!myTasks?.length && (
              <li className="px-5 py-8 text-center text-sm text-gray-400">
                No pending approvals. You're all caught up!
              </li>
            )}
          </ul>
        </div>
      </div>
    </div>
  );
}
