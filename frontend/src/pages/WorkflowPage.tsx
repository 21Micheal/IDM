import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { workflowAPI } from "@/services/api";
import { Link } from "react-router-dom";
import { CheckCircle, XCircle, Clock, FileText, Loader2 } from "lucide-react";
import { formatDistanceToNow, format } from "date-fns";
import { toast } from "react-toastify";
import type { WorkflowTask } from "@/types";

function ApprovalModal({
  task,
  action,
  onClose,
}: {
  task: WorkflowTask;
  action: "approve" | "reject";
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
        : workflowAPI.rejectTask(task.id, comment),
    onSuccess: () => {
      toast.success(action === "approve" ? "Document approved" : "Document rejected");
      qc.invalidateQueries({ queryKey: ["workflow"] });
      onClose();
    },
    onError: (err: { response?: { data?: { detail?: string } } }) =>
      toast.error(err?.response?.data?.detail || "Action failed"),
  });

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="card w-full max-w-md p-6 space-y-4">
        <h2 className="font-semibold text-gray-900">
          {action === "approve" ? "Approve document" : "Reject document"}
        </h2>
        <p className="text-sm text-gray-600">
          <span className="font-medium">{documentTitle}</span>
          <span className="text-gray-400 ml-2 font-mono text-xs">
            {documentRef}
          </span>
        </p>
        <div>
          <label className="label">
            Comment{action === "reject" && <span className="text-red-500 ml-1">*</span>}
          </label>
          <textarea
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            rows={3}
            className="input"
            placeholder={
              action === "approve"
                ? "Optional: add a note…"
                : "Reason for rejection (required)"
            }
            autoFocus
          />
        </div>
        <div className="flex gap-3 justify-end">
          <button onClick={onClose} className="btn-secondary">Cancel</button>
          <button
            onClick={() => mutation.mutate()}
            disabled={mutation.isPending || (action === "reject" && !comment.trim())}
            className={action === "approve" ? "btn-primary" : "btn-danger"}
          >
            {mutation.isPending && <Loader2 className="w-4 h-4 animate-spin" />}
            {action === "approve" ? "Approve" : "Reject"}
          </button>
        </div>
      </div>
    </div>
  );
}

export default function WorkflowPage() {
  const [modal, setModal] = useState<{ task: WorkflowTask; action: "approve" | "reject" } | null>(null);

  const { data: tasks, isLoading } = useQuery<WorkflowTask[]>({
    queryKey: ["workflow", "my-tasks"],
    queryFn: () => workflowAPI.myTasks().then((r) => r.data.results ?? r.data),
    refetchInterval: 30_000,
  });

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Workflow tasks</h1>
        <p className="text-gray-500 text-sm mt-1">Documents waiting for your approval action.</p>
      </div>

      {isLoading && (
        <div className="flex items-center justify-center h-40">
          <Loader2 className="w-6 h-6 text-brand-500 animate-spin" />
        </div>
      )}

      {!isLoading && !tasks?.length && (
        <div className="card p-12 text-center">
          <CheckCircle className="w-12 h-12 text-green-300 mx-auto mb-3" />
          <p className="font-medium text-gray-700">All caught up!</p>
          <p className="text-sm text-gray-400 mt-1">No pending approval tasks.</p>
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

          return (
          <div key={task.id} className="card p-5 flex items-start gap-4">
            <div className="w-10 h-10 rounded-xl bg-amber-50 flex items-center justify-center flex-shrink-0">
              <Clock className="w-5 h-5 text-amber-500" />
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-start justify-between gap-2">
                <div>
                  <Link
                    to={documentId ? `/documents/${documentId}` : "/workflow"}
                    className="font-medium text-gray-900 hover:text-brand-600 truncate block"
                  >
                    {documentTitle}
                  </Link>
                  <p className="text-xs text-gray-500 font-mono mt-0.5">
                    {documentRef}
                  </p>
                </div>
                <div className="flex gap-2 flex-shrink-0">
                  <button
                    onClick={() => setModal({ task, action: "approve" })}
                    className="btn-primary text-xs px-3 py-1.5"
                  >
                    <CheckCircle className="w-3.5 h-3.5" /> Approve
                  </button>
                  <button
                    onClick={() => setModal({ task, action: "reject" })}
                    className="btn-danger text-xs px-3 py-1.5"
                  >
                    <XCircle className="w-3.5 h-3.5" /> Reject
                  </button>
                </div>
              </div>
              <div className="flex items-center gap-3 mt-2 text-xs text-gray-500">
                <span>Step: <span className="font-medium">{task.step.name}</span></span>
                {task.due_at && (
                  <span
                    className={
                      new Date(task.due_at) < new Date()
                        ? "text-red-500 font-medium"
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
