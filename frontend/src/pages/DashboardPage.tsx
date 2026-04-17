// DashboardPage.tsx - Centered, Minimal & Professional Version
import { useQuery } from "@tanstack/react-query";
import { documentsAPI, workflowAPI } from "@/services/api";
import { useAuthStore } from "@/store/authStore";
import { 
  FileText, Clock, CheckCircle, GitBranch, ArrowRight, 
  UploadCloud, Bell, Calendar, Loader2
} from "lucide-react";
import { Link } from "react-router-dom";
import StatusBadge from "@/components/documents/StatusBadge";
import { formatDistanceToNow } from "date-fns";
import type { Document, WorkflowTask } from "@/types";
import { StatCard } from "@/components/dashboard/StatCard";

// Helper for task priority display
function TaskMetaInfo({ dueAt }: { dueAt: string | null }) {
  if (!dueAt) return null;
  
  const dueDate = new Date(dueAt);
  const now = new Date();
  const hoursDiff = (dueDate.getTime() - now.getTime()) / (1000 * 60 * 60);
  
  let statusClass = "text-slate-500";
  let statusText = "On track";
  
  if (hoursDiff < 0) {
    statusClass = "text-red-600";
    statusText = "Overdue";
  } else if (hoursDiff < 24) {
    statusClass = "text-amber-600";
    statusText = "Due soon";
  }
  
  return (
    <div className="flex items-center gap-1 text-xs">
      <Calendar className="w-3 h-3" />
      <span className={statusClass}>
        {statusText} · {formatDistanceToNow(dueDate, { addSuffix: true })}
      </span>
    </div>
  );
}

export default function DashboardPage() {
  const { user } = useAuthStore();

  // Core data queries
  const { data: recentDocs, isLoading: docsLoading } = useQuery({
    queryKey: ["documents", "recent"],
    queryFn: () => documentsAPI.list({ page_size: 5, ordering: "-created_at" }).then((r) => r.data),
  });

  const { data: pendingCount = 0 } = useQuery({
    queryKey: ["documents", "pending", "count"],
    queryFn: () => documentsAPI.list({ status: "pending_approval", page_size: 1 }).then((r) => r.data.count ?? 0),
  });

  const { data: myTasks = [], isLoading: tasksLoading } = useQuery({
    queryKey: ["workflow", "my-tasks"],
    queryFn: () => workflowAPI.myTasks().then((r) => r.data.results ?? r.data),
  });

  const totalDocuments = recentDocs?.count ?? 0;

  return (
    <div className="max-w-5xl mx-auto px-4 py-8 space-y-8">
      {/* Header Section */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-slate-800 tracking-tight">
            Dashboard
          </h1>
          <p className="text-sm text-slate-500 mt-1">
            Welcome back, {user?.first_name || "User"}.
          </p>
        </div>
        
        <Link 
          to="/documents/upload" 
          className="inline-flex items-center gap-2 px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-medium rounded-lg transition-colors shadow-sm w-full sm:w-auto justify-center"
        >
          <UploadCloud className="w-4 h-4" />
          Upload Document
        </Link>
      </div>

      {/* Key Metrics Row */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard
          title="Total Documents"
          value={totalDocuments}
          icon={FileText}
          color="blue"
          href="/documents"
        />
        <StatCard
          title="Pending Approval"
          value={pendingCount}
          icon={Clock}
          color="amber"
          href="/documents?status=pending_approval"
        />
        <StatCard
          title="My Tasks"
          value={myTasks.length}
          icon={GitBranch}
          color="purple"
          href="/workflow"
        />
        <StatCard
          title="Completed"
          value="—"
          icon={CheckCircle}
          color="green"
        />
      </div>

      {/* Main Content Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        
        {/* Recent Documents Panel */}
        <div className="bg-white rounded-xl border border-slate-200 overflow-hidden shadow-sm">
          <div className="px-5 py-3 border-b border-slate-100 bg-slate-50/40 flex items-center justify-between">
            <h2 className="font-medium text-sm text-slate-700">Recent Documents</h2>
            <Link 
              to="/documents" 
              className="text-xs font-medium text-indigo-600 hover:text-indigo-700 flex items-center gap-1"
            >
              View all <ArrowRight className="w-3 h-3" />
            </Link>
          </div>

          <div className="divide-y divide-slate-100">
            {docsLoading ? (
              <div className="p-8 flex justify-center">
                <Loader2 className="w-6 h-6 text-slate-400 animate-spin" />
              </div>
            ) : recentDocs?.results?.length ? (
              recentDocs.results.map((doc: Document) => (
                <Link 
                  key={doc.id} 
                  to={`/documents/${doc.id}`}
                  className="block px-5 py-3 hover:bg-slate-50 transition-colors"
                >
                  <div className="flex items-center gap-3">
                    <div className="p-2 bg-slate-100 rounded-lg">
                      <FileText className="w-4 h-4 text-slate-500" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-slate-800 truncate">
                        {doc.title}
                      </p>
                      <div className="flex items-center gap-2 text-xs text-slate-400 mt-0.5">
                        <span>{doc.reference_number}</span>
                        <span>•</span>
                        <span>{formatDistanceToNow(new Date(doc.updated_at), { addSuffix: true })}</span>
                      </div>
                    </div>
                    <StatusBadge status={doc.status} />
                  </div>
                </Link>
              ))
            ) : (
              <div className="px-5 py-12 text-center">
                <FileText className="w-10 h-10 text-slate-200 mx-auto mb-2" />
                <p className="text-sm text-slate-500">No documents yet</p>
                <Link to="/documents/upload" className="text-xs text-indigo-600 hover:underline mt-1 inline-block">
                  Upload your first document →
                </Link>
              </div>
            )}
          </div>
        </div>

        {/* My Tasks Panel */}
        <div className="bg-white rounded-xl border border-slate-200 overflow-hidden shadow-sm">
          <div className="px-5 py-3 border-b border-slate-100 bg-slate-50/40 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Bell className="w-4 h-4 text-slate-500" />
              <h2 className="font-medium text-sm text-slate-700">Pending Tasks</h2>
            </div>
            <Link 
              to="/workflow" 
              className="text-xs font-medium text-indigo-600 hover:text-indigo-700 flex items-center gap-1"
            >
              View all <ArrowRight className="w-3 h-3" />
            </Link>
          </div>

          <div className="divide-y divide-slate-100">
            {tasksLoading ? (
              <div className="p-8 flex justify-center">
                <Loader2 className="w-6 h-6 text-slate-400 animate-spin" />
              </div>
            ) : myTasks.length ? (
              myTasks.slice(0, 5).map((task: WorkflowTask) => {
                const doc = task.workflow_instance?.document;
                return (
                  <Link
                    key={task.id}
                    to={doc?.id ? `/documents/${doc.id}` : "/workflow"}
                    className="block px-5 py-3 hover:bg-slate-50 transition-colors"
                  >
                    <div className="flex items-start gap-3">
                      <div className="p-2 bg-amber-50 rounded-lg mt-0.5">
                        <Clock className="w-4 h-4 text-amber-600" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium text-slate-800 truncate">
                          {doc?.title || task.document_title || "Untitled Document"}
                        </p>
                        <p className="text-xs text-slate-500 mt-0.5">
                          Step: <span className="font-medium text-slate-700">{task.step?.name}</span>
                        </p>
                        <TaskMetaInfo dueAt={task.due_at} />
                      </div>
                    </div>
                  </Link>
                );
              })
            ) : (
              <div className="px-5 py-12 text-center">
                <div className="w-10 h-10 rounded-full bg-emerald-50 flex items-center justify-center mx-auto mb-2">
                  <CheckCircle className="w-5 h-5 text-emerald-600" />
                </div>
                <p className="text-sm font-medium text-slate-600">All caught up</p>
                <p className="text-xs text-slate-400 mt-1">No pending tasks</p>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}