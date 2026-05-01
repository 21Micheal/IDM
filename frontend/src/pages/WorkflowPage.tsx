import { useQuery } from "@tanstack/react-query";
import { workflowAPI } from "@/services/api";
import { Link } from "react-router-dom";
import { CheckCircle, Clock, Loader2, GitBranch } from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import type { WorkflowTask } from "@/types";
import { formatDocumentFileType } from "@/lib/documentFormat";

export default function WorkflowPage() {

  const { data: tasks, isLoading } = useQuery<WorkflowTask[]>({
    queryKey: ["workflow", "my-tasks"],
    queryFn: () => workflowAPI.myTasks().then((r) => r.data.results ?? r.data),
    refetchInterval: 30_000,
  });

  return (
    <div className="max-w-4xl mx-auto py-10 px-6 space-y-8">
      <div>
        <div className="flex items-center gap-3 mb-2">
          <div className="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center">
            <GitBranch className="w-5 h-5 text-primary" />
          </div>
          <h1 className="text-2xl font-bold text-foreground tracking-tight">Workflow tasks</h1>
        </div>
        <p className="text-muted-foreground text-sm">Documents waiting for your approval action.</p>
      </div>

      {isLoading && (
        <div className="flex items-center justify-center h-40">
          <Loader2 className="w-6 h-6 text-accent animate-spin" />
        </div>
      )}

      {!isLoading && !tasks?.length && (
        <div className="card p-12 text-center">
          <div className="w-14 h-14 rounded-full bg-teal/15 flex items-center justify-center mx-auto mb-4">
            <CheckCircle className="w-7 h-7 text-teal" />
          </div>
          <p className="font-semibold text-foreground">All caught up!</p>
          <p className="text-sm text-muted-foreground mt-1">No pending approval tasks.</p>
        </div>
      )}

      <div className="space-y-3">
        {tasks?.map((task) => {
          const documentId = task.document_id;
          const documentTitle =
            task.workflow_instance?.document?.title ?? task.document_title ?? "Untitled";
          const documentRef =
            task.workflow_instance?.document?.reference_number ?? task.document_ref ?? "";
          const documentType =
            task.workflow_instance?.document?.document_type_name ??
            task.workflow_instance?.document?.document_type?.name ??
            task.document_type_name ??
            "Unclassified";
          const documentFormat = formatDocumentFileType(task.file_name, task.file_mime_type);

          const isOverdue = task.due_at && new Date(task.due_at) < new Date();

          return (
            <Link
              key={task.id}
              to={documentId ? `/documents/${documentId}` : "/workflow"}
              className="card p-5 flex items-start gap-4 hover:-translate-y-0.5 transition-transform hover:shadow-md"
            >
              <div className="w-10 h-10 rounded-xl bg-accent/15 flex items-center justify-center flex-shrink-0">
                <Clock className="w-5 h-5 text-accent-foreground" />
              </div>
              <div className="flex-1 min-w-0">
                <div className="min-w-0">
                  <h3 className="font-medium text-foreground hover:text-accent-foreground truncate">
                    {documentTitle}
                  </h3>
                  <p className="text-xs text-muted-foreground font-mono mt-0.5">
                    {documentRef}
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-3 mt-2 text-xs text-muted-foreground">
                  <span>Type: <span className="font-medium text-foreground">{documentType}</span></span>
                  <span>Format: <span className="font-medium text-foreground">{documentFormat}</span></span>
                  <span>Step: <span className="font-medium text-foreground">{task.step.name}</span></span>
                  {task.due_at && (
                    <span
                      className={
                        isOverdue
                          ? "text-destructive font-medium"
                          : ""
                      }
                    >
                      Due {formatDistanceToNow(new Date(task.due_at), { addSuffix: true })}
                    </span>
                  )}
                </div>
              </div>
            </Link>
          );
        })}
      </div>
    </div>
  );
}
