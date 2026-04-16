import { useQuery } from "@tanstack/react-query";
import { documentsAPI, workflowAPI } from "@/services/api";
import { useAuthStore } from "@/store/authStore";
import { FileText, Clock, CheckCircle, GitBranch, AlertCircle, ArrowRight, TrendingUp,UploadCloud } from "lucide-react";
import { Link } from "react-router-dom";
import StatusBadge from "@/components/documents/StatusBadge";
import { formatDistanceToNow, format } from "date-fns";
import type { Document, WorkflowTask } from "@/types";
import { StatCard } from "@/components/dashboard/StatCard";


export default function DashboardPage() {
  const { user } = useAuthStore();

  const { data: recentDocs, isLoading: docsLoading } = useQuery({
    queryKey: ["documents", "recent"],
    queryFn: () => documentsAPI.list({ page_size: 5 }).then((r) => r.data),
  });

  const { data: pendingCount = 0 } = useQuery({
    queryKey: ["documents", "pending", "count"],
    queryFn: () => documentsAPI.list({ status: "pending_approval", page_size: 1 }).then((r) => r.data.count),
  });

  const { data: approvedCount = 0 } = useQuery({
    queryKey: ["documents", "approved", "count"],
    queryFn: () => documentsAPI.list({ status: "approved", page_size: 1 }).then((r) => r.data.count),
  });

  const { data: myTasks = [] } = useQuery({
    queryKey: ["workflow", "my-tasks"],
    queryFn: () => workflowAPI.myTasks().then((r) => r.data.results ?? r.data),
  });

  // Placeholder for dynamic trend data (to be replaced with real API data later)
  const trendData = {
    documents: { value: 12, isPositive: true },
    pending: { value: 8, isPositive: false },
    approved: { value: 23, isPositive: true },
  };

  return (
    <div className="space-y-8">
      {/* Welcome Section */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-slate-900 tracking-tight">
            Welcome back, {user?.first_name}
          </h1>
          <p className="text-slate-500 text-sm mt-1">
            Here's what's happening with your documents today.
          </p>
        </div>
        <Link to="/documents/upload" className="inline-flex items-center gap-2 px-4 py-2 bg-indigo-600 text-white text-sm font-medium rounded-lg shadow-sm hover:bg-indigo-700 transition-colors">
          <UploadCloud className="w-4 h-4" />
          Upload New Document
        </Link>
      </div>

      {/* Stats Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
        <StatCard
          title="Total Documents"
          value={recentDocs?.count ?? '—'}
          icon={FileText}
          trend={trendData.documents}
          color="blue"
          href="/documents"
        />
        <StatCard
          title="Pending Approval"
          value={pendingCount}
          icon={Clock}
          trend={trendData.pending}
          color="amber"
          href="/documents?status=pending_approval"
        />
        <StatCard
          title="Approved"
          value={approvedCount}
          icon={CheckCircle}
          trend={trendData.approved}
          color="green"
          href="/documents?status=approved"
        />
        <StatCard
          title="My Tasks"
          value={myTasks.length}
          icon={GitBranch}
          color="amber"
          href="/workflow"
        />
      </div>

      {/* Recent Activity & Tasks Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
        {/* Recent Documents */}
        <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
          <div className="px-6 py-4 border-b border-slate-100 flex items-center justify-between bg-slate-50/40">
            <h2 className="font-semibold text-slate-900">Recent Documents</h2>
            <Link to="/documents" className="text-sm font-medium text-indigo-600 hover:text-indigo-800 inline-flex items-center gap-1">
              View all <ArrowRight className="w-3.5 h-3.5" />
            </Link>
          </div>
          <ul className="divide-y divide-slate-100">
            {recentDocs?.results?.map((doc: Document) => (
              <li key={doc.id}>
                <Link to={`/documents/${doc.id}`} className="flex items-center gap-4 px-6 py-4 hover:bg-slate-50 transition-colors">
                  <div className="p-2 bg-slate-100 rounded-lg shrink-0">
                    <FileText className="w-5 h-5 text-slate-500" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-slate-900 truncate">{doc.title}</p>
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mt-0.5">
                      <p className="text-xs text-slate-500">{doc.reference_number}</p>
                      <p className="text-xs text-slate-400">•</p>
                      <p className="text-xs text-slate-500 capitalize">Updated {formatDistanceToNow(new Date(doc.updated_at), { addSuffix: true })}</p>
                    </div>
                  </div>
                  <StatusBadge status={doc.status} />
                </Link>
              </li>
            ))}
            {!recentDocs?.results?.length && (
              <li className="px-6 py-8 text-center text-sm text-slate-400">
                No documents yet. <Link to="/documents/upload" className="text-indigo-600 hover:underline">Upload your first document</Link>
              </li>
            )}
          </ul>
        </div>

        {/* Pending Approvals (Workflow Tasks) */}
        <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
          <div className="px-6 py-4 border-b border-slate-100 flex items-center justify-between bg-slate-50/40">
            <h2 className="font-semibold text-slate-900">Pending Approvals</h2>
            <Link to="/workflow" className="text-sm font-medium text-indigo-600 hover:text-indigo-800 inline-flex items-center gap-1">
              View all <ArrowRight className="w-3.5 h-3.5" />
            </Link>
          </div>
          <ul className="divide-y divide-slate-100">
            {myTasks.map((task: WorkflowTask) => {
              const documentId =
                task.workflow_instance?.document?.id ?? task.document_id ?? "";
              const documentTitle =
                task.workflow_instance?.document?.title ?? task.document_title ?? "Untitled";
              const documentRef =
                task.workflow_instance?.document?.reference_number ?? task.document_ref ?? "";

              return (
              <li key={task.id}>
                <Link to={documentId ? `/documents/${documentId}` : "/workflow"} className="flex items-start gap-4 px-6 py-4 hover:bg-slate-50 transition-colors">
                  <div className="p-2 bg-amber-50 rounded-lg shrink-0">
                    <AlertCircle className="w-5 h-5 text-amber-600" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-slate-900 truncate">{documentTitle}</p>
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mt-1">
                      <p className="text-xs text-slate-500">{documentRef}</p>
                      <p className="text-xs text-slate-400">•</p>
                      <p className="text-xs text-slate-500">Step: <span className="font-medium">{task.step.name}</span></p>
                    </div>
                    {task.due_at && (
                      <p className="text-xs text-amber-600 mt-1.5">
                        Due {formatDistanceToNow(new Date(task.due_at), { addSuffix: true })}
                      </p>
                    )}
                  </div>
                  <StatusBadge status="pending_approval" />
                </Link>
              </li>
              );
            })}
            {myTasks.length === 0 && (
              <li className="px-6 py-12 text-center">
                <div className="flex flex-col items-center gap-2">
                  <CheckCircle className="w-10 h-10 text-emerald-500" />
                  <p className="text-sm font-medium text-slate-700">All caught up!</p>
                  <p className="text-xs text-slate-400">No pending approvals require your action.</p>
                </div>
              </li>
            )}
          </ul>
        </div>
      </div>
    </div>
  );
}