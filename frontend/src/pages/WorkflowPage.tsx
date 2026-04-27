import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { workflowAPI } from "@/services/api";
import { Link } from "react-router-dom";
import { CheckCircle, XCircle, Clock, Loader2, GitBranch, RotateCcw } from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import { toast } from "react-toastify";
import type { WorkflowTask } from "@/types";

function ApprovalModal({
  task,
  action,
  onClose,
}: {
  task: WorkflowTask;
  action: "approve" | "reject" | "return";
  onClose: () => void;
}) {
  const [comment, setComment] = useState("");
  const qc = useQueryClient();

  const documentTitle =
    task.workflow_instance?.document?.title ?? task.document_title ?? "Document";
  const documentRef =
    task.workflow_instance?.document?.reference_number ?? task.document_ref ?? "";

  const mutation = useMutation({
    mutationFn: () =>
      action === "approve"
        ? workflowAPI.approveTask(task.id, comment)
        : action === "reject"
          ? workflowAPI.rejectTask(task.id, comment)
          : workflowAPI.returnForReview(task.id, comment),
    onSuccess: () => {
      toast.success(
        action === "approve"
          ? "Document approved"
          : action === "reject"
            ? "Document rejected"
            : "Document returned for review"
      );
      qc.invalidateQueries({ queryKey: ["workflow"] });
      onClose();
    },
    onError: (err: { response?: { data?: { detail?: string } } }) =>
      toast.error(err?.response?.data?.detail || "Action failed"),
  });

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-foreground/40 backdrop-blur-sm p-4">
      <div className="card w-full max-w-md p-6 space-y-4" style={{ boxShadow: "var(--shadow-elegant)" }}>
        <h2 className="font-semibold text-foreground text-lg">
          {action === "approve"
            ? "Approve document"
            : action === "reject"
              ? "Reject document"
              : "Return for review"}
        </h2>
        <p className="text-sm text-muted-foreground">
          <span className="font-medium text-foreground">{documentTitle}</span>
          <span className="text-muted-foreground ml-2 font-mono text-xs">
            {documentRef}
          </span>
        </p>
        <div>
          <label className="label">
            Comment{action !== "approve" && <span className="text-destructive ml-1">*</span>}
          </label>
          <textarea
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            rows={3}
            className="input"
            placeholder={
              action === "approve"
                ? "Optional: add a note…"
                : action === "reject"
                  ? "Reason for rejection (required)"
                  : "Explain what needs to be fixed (required)"
            }
            autoFocus
          />
        </div>
        <div className="flex gap-3 justify-end">
          <button onClick={onClose} className="btn-secondary">Cancel</button>
          <button
            onClick={() => mutation.mutate()}
            disabled={mutation.isPending || (action !== "approve" && !comment.trim())}
            className={
              action === "approve"
                ? "btn-primary"
                : action === "reject"
                  ? "btn-danger"
                  : "inline-flex items-center gap-2 rounded-lg bg-amber-500 px-4 py-2 text-sm font-medium text-white hover:bg-amber-600 disabled:opacity-50"
            }
          >
            {mutation.isPending && <Loader2 className="w-4 h-4 animate-spin" />}
            {action === "approve" ? "Approve" : action === "reject" ? "Reject" : "Return for review"}
          </button>
        </div>
      </div>
    </div>
  );
}

export default function WorkflowPage() {
  const [modal, setModal] = useState<{ task: WorkflowTask; action: "approve" | "reject" | "return" } | null>(null);

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
          const documentId =
            task.workflow_instance?.document?.id ?? task.document_id ?? "";
          const documentTitle =
            task.workflow_instance?.document?.title ?? task.document_title ?? "Untitled";
          const documentRef =
            task.workflow_instance?.document?.reference_number ?? task.document_ref ?? "";

          const isOverdue = task.due_at && new Date(task.due_at) < new Date();
          const canApprove = task.step?.allow_approve !== false;
          const canReject = task.step?.allow_reject !== false;
          const canReturn = task.step?.allow_return !== false;
          const hasTaskActions = canApprove || canReject || canReturn;

          return (
            <div key={task.id} className="card p-5 flex items-start gap-4 hover:-translate-y-0.5 transition-transform">
              <div className="w-10 h-10 rounded-xl bg-accent/15 flex items-center justify-center flex-shrink-0">
                <Clock className="w-5 h-5 text-accent-foreground" />
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <Link
                      to={documentId ? `/documents/${documentId}` : "/workflow"}
                      className="font-medium text-foreground hover:text-accent-foreground hover:underline truncate block"
                    >
                      {documentTitle}
                    </Link>
                    <p className="text-xs text-muted-foreground font-mono mt-0.5">
                      {documentRef}
                    </p>
                  </div>
                  {hasTaskActions ? (
                    <div className="flex gap-2 flex-shrink-0 flex-wrap justify-end">
                      {canApprove && (
                        <button
                          onClick={() => setModal({ task, action: "approve" })}
                          className="inline-flex items-center gap-1.5 rounded-lg bg-teal px-3 py-1.5 text-xs font-medium text-teal-foreground hover:bg-teal/90 transition-colors"
                        >
                          <CheckCircle className="w-3.5 h-3.5" /> Approve
                        </button>
                      )}
                      {canReject && (
                        <button
                          onClick={() => setModal({ task, action: "reject" })}
                          className="btn-danger text-xs px-3 py-1.5"
                        >
                          <XCircle className="w-3.5 h-3.5" /> Reject
                        </button>
                      )}
                      {canReturn && (
                        <button
                          onClick={() => setModal({ task, action: "return" })}
                          className="inline-flex items-center gap-1.5 rounded-lg bg-amber-500 px-3 py-1.5 text-xs font-medium text-white hover:bg-amber-600 transition-colors"
                        >
                          <RotateCcw className="w-3.5 h-3.5" /> Return
                        </button>
                      )}
                    </div>
                  ) : (
                    <span className="text-xs text-muted-foreground flex-shrink-0">
                      No task actions enabled
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-3 mt-2 text-xs text-muted-foreground">
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
            </div>
          );
        })}
      </div>

      {modal && (
        <ApprovalModal
          task={modal.task}
          action={modal.action}
          onClose={() => setModal(null)}
        />
      )}
    </div>
  );
}
