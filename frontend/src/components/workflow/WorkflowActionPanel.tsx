/**
 * WorkflowActionPanel.tsx
 *
 * Shown on DocumentDetailPage when the current user has an active
 * workflow task on this document.
 *
 * Actions available:
 *   ✓ Approve
 *   ✗ Reject       (requires comment)
 *   ↩ Return       (requires comment — sends back for rework)
 *   ⏸ Hold         (requires comment + duration — auto-releases)
 *   ▶ Release hold (only shown when task is currently held)
 */
import { useState } from "react";
import { extractApiError } from "@/lib/apiError";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { documentsAPI, workflowAPI } from "@/services/api";
import {
  CheckCircle, XCircle, RotateCcw, PauseCircle,
  PlayCircle, Loader2, Clock, ChevronDown, History,
  FileSignature,
} from "lucide-react";
import { toast } from "@/components/ui/vault-toast";
import { useAuthStore } from "@/store/authStore";
import { formatDistanceToNow, format } from "date-fns";
import clsx from "clsx";
import SignaturePlacementModal, { type SignaturePlacementResult } from "@/components/signatures/SignaturePlacementModal";

// ── Types ─────────────────────────────────────────────────────────────────────
interface WorkflowTask {
  id:             string;
  status:         string;
  status_display: string;
  step:           { name: string; order: number; instructions: string; allow_approve: boolean; allow_reject: boolean; allow_return: boolean };
  requires_signature?: boolean;
  assigned_to?:   { id: string; full_name: string };
  due_at?:        string;
  held_until?:    string;
  document_ref:   string;
  document_title?: string;
}

interface TaskAction {
  id:               string;
  action:           string;
  action_display:   string;
  actor:            { full_name: string };
  comment:          string;
  hold_hours?:      number;
  return_to?:       string;
  return_to_display?: string;
  created_at:       string;
}

interface Props {
  task: WorkflowTask;
  documentId: string;
  onCompleted?: () => void;
}

type WorkflowActionKind = "approve" | "reject" | "return" | "hold" | "release";

// ── Action colour map ─────────────────────────────────────────────────────────
const ACTION_STYLES: Record<string, string> = {
  approved:  "bg-green-50  text-green-700  border-green-200",
  rejected:  "bg-red-50    text-red-700    border-red-200",
  returned:  "bg-amber-50  text-amber-700  border-amber-200",
  held:      "bg-blue-50   text-blue-700   border-blue-200",
  released:  "bg-gray-50   text-gray-600   border-gray-200",
};

// ── History drawer ────────────────────────────────────────────────────────────
function TaskHistoryDrawer({ taskId, task, currentUserId: _currentUserId }: { taskId: string; task: WorkflowTask; currentUserId: string }) {
  const [open, setOpen] = useState(false);

  const { data: actions, isLoading } = useQuery<TaskAction[]>({
    queryKey: ["task-history", taskId],
    queryFn:  () => workflowAPI.taskHistory(taskId).then((r) => r.data),
  });

  // Filter for critical actions relevant to current step
  const criticalActions = actions?.filter(a => {
    // Always show returned actions (especially if by current user)
    if (a.action === "returned") return true;
    // Show held/released actions
    if (a.action === "held" || a.action === "released") return true;
    // Show rejected actions
    if (a.action === "rejected") return true;
    // Show approved actions (most recent completion)
    if (a.action === "approved") return true;
    return false;
  }) || [];

  // Check if current user had previously returned this document
  const previousReturnByCurrentUser = actions?.find(a =>
    a.action === "returned" && a.actor.full_name === task.assigned_to?.full_name
  );

  // Only show drawer button if there's critical history or if it's been opened
  const hasCriticalHistory = criticalActions.length > 0;
  
  if (!hasCriticalHistory && !open && !previousReturnByCurrentUser) {
    return null;
  }

  return (
    <div>
      {/* Show alert if current user had previously returned this document */}
      {previousReturnByCurrentUser && (
        <div className="mb-3 flex items-start gap-2 px-3 py-2.5 rounded-lg border border-amber-200 bg-amber-50 text-xs">
          <RotateCcw className="w-4 h-4 text-amber-600 mt-0.5 flex-shrink-0" />
          <div className="flex-1">
            <p className="font-semibold text-amber-800">You previously returned this document</p>
            <p className="mt-1 text-amber-700">
              {previousReturnByCurrentUser.comment?.trim() || "No reason provided."}
            </p>
            <p className="mt-1 text-[11px] text-amber-600">
              {format(new Date(previousReturnByCurrentUser.created_at), "dd MMM HH:mm")}
            </p>
          </div>
        </div>
      )}

      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1.5 text-xs text-gray-500 hover:text-gray-700 transition-colors"
      >
        <History className="w-3.5 h-3.5" />
        Action history
        {criticalActions.length > 0 && (
          <span className="rounded-full bg-gray-100 px-1.5 py-0.5 text-[10px] font-medium text-gray-600">
            {criticalActions.length}
          </span>
        )}
        <ChevronDown className={clsx("w-3.5 h-3.5 transition-transform", open && "rotate-180")} />
      </button>

      {open && (
        <div className="mt-3 space-y-2">
          {isLoading && (
            <div className="flex items-center gap-2 text-xs text-gray-500 py-2">
              <Loader2 className="w-3 h-3 animate-spin" />
              Loading history...
            </div>
          )}
          {!isLoading && !hasCriticalHistory && (
            <p className="text-xs text-gray-400 py-2">No critical actions recorded.</p>
          )}
          {criticalActions.map((a) => {
        const extraDetail = a.action === "returned" && a.return_to_display
          ? `Returned to ${a.return_to_display}`
          : a.action === "held" && a.hold_hours
            ? `Held for ${a.hold_hours}h`
            : undefined;

        const isCurrentUserAction = a.actor.full_name === task.assigned_to?.full_name;

        return (
          <div
            key={a.id}
            className={clsx(
              "flex items-start gap-3 px-3 py-2.5 rounded-lg border text-xs",
              ACTION_STYLES[a.action] ?? "bg-gray-50 text-gray-600 border-gray-200",
              isCurrentUserAction && "ring-2 ring-offset-1 ring-amber-300"
            )}
          >
            <div className="flex-1 min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-semibold">{a.action_display}</span>
                {isCurrentUserAction && (
                  <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-medium uppercase tracking-[0.02em] text-amber-700">
                    Your action
                  </span>
                )}
                {extraDetail && (
                  <span className="rounded-full bg-white/80 px-2 py-0.5 text-[11px] font-medium uppercase tracking-[0.02em] text-slate-600 ring-1 ring-slate-200">
                    {extraDetail}
                  </span>
                )}
                <span className="text-opacity-70">by {a.actor.full_name}</span>
              </div>
              <p className="mt-1 text-sm leading-5 text-slate-700">
                {a.comment?.trim() || "No details provided."}
              </p>
            </div>
            <span className="flex-shrink-0 text-right text-[11px] text-slate-500 whitespace-nowrap">
              {format(new Date(a.created_at), "dd MMM HH:mm")}
            </span>
          </div>
        );
      })}
        </div>
      )}
    </div>
  );
}

// ── Main panel ────────────────────────────────────────────────────────────────
export default function WorkflowActionPanel({ task, documentId, onCompleted }: Props) {
  const qc = useQueryClient();
  const currentUser = useAuthStore((s) => s.user);

  const [activeAction, setActiveAction] = useState<
    "approve" | "reject" | "return" | "hold" | null
  >(null);
  const [showSignaturePlacement, setShowSignaturePlacement] = useState(false);
  // Captured signature (placement + image) from the explicit "Sign document"
  // step; applied when the approver then confirms the approval.
  const [signedResult, setSignedResult] = useState<SignaturePlacementResult | null>(null);
  const [optimisticAction, setOptimisticAction] = useState<WorkflowActionKind | null>(null);
  const [comment, setComment]   = useState("");
  const [holdHours, setHoldHours] = useState(24);

  const removeTaskFromQueues = () => {
    qc.setQueriesData<WorkflowTask[]>({ queryKey: ["workflow", "my-tasks"] }, (prev) =>
      Array.isArray(prev) ? prev.filter((item) => item.id !== task.id) : prev,
    );
  };

  const patchTaskInQueues = (patch: Partial<WorkflowTask>) => {
    qc.setQueriesData<WorkflowTask[]>({ queryKey: ["workflow", "my-tasks"] }, (prev) =>
      Array.isArray(prev)
        ? prev.map((item) => (item.id === task.id ? { ...item, ...patch } : item))
        : prev,
    );
  };

  const patchDocumentStatus = (status: string) => {
    qc.setQueryData(["document", documentId], (prev: any) =>
      prev ? { ...prev, status, updated_at: new Date().toISOString() } : prev,
    );
  };

  const refetchWorkflowState = () => {
    qc.invalidateQueries({ queryKey: ["workflow", "my-tasks"] });
    qc.invalidateQueries({ queryKey: ["document", documentId] });
    qc.invalidateQueries({ queryKey: ["document-workflow", documentId] });
    qc.invalidateQueries({ queryKey: ["notification-workflow", documentId] });
    qc.invalidateQueries({ queryKey: ["documents"] });
    qc.invalidateQueries({ queryKey: ["notifications"] });
    qc.invalidateQueries({ queryKey: ["task-history", task.id] });
    qc.invalidateQueries({ queryKey: ["documents", "pending"] });
    qc.invalidateQueries({ queryKey: ["documents", "completed"] });
    void qc.refetchQueries({ queryKey: ["document", documentId], type: "active" });
    void qc.refetchQueries({ queryKey: ["document-workflow", documentId], type: "active" });
    void qc.refetchQueries({ queryKey: ["workflow", "my-tasks"], type: "active" });
    void qc.fetchQuery({
      queryKey: ["document", documentId],
      queryFn: () => documentsAPI.get(documentId).then((r) => r.data),
    });
  };

  const beginOptimisticAction = (action: WorkflowActionKind) => {
    setOptimisticAction(action);
    if (action === "approve") {
      removeTaskFromQueues();
      patchDocumentStatus("pending_approval");
      return;
    }
    if (action === "reject") {
      removeTaskFromQueues();
      patchDocumentStatus("rejected");
      return;
    }
    if (action === "return") {
      removeTaskFromQueues();
      patchDocumentStatus("returned");
      return;
    }
    if (action === "hold") {
      patchTaskInQueues({ status: "held", status_display: "On Hold", held_until: new Date().toISOString() });
      patchDocumentStatus("on_hold");
      return;
    }
    patchTaskInQueues({ status: "in_progress", status_display: "In progress", held_until: undefined });
    patchDocumentStatus("pending_approval");
  };

  const completeAction = () => {
    setOptimisticAction(null);
    setActiveAction(null);
    setComment("");
    refetchWorkflowState();
    if (onCompleted) onCompleted();
  };

  const failAction = (message: string) => {
    setOptimisticAction(null);
    toast.error(message);
    refetchWorkflowState();
  };

  const approveMutation = useMutation({
    mutationFn: (result?: SignaturePlacementResult) => workflowAPI.approveTask(task.id, comment, result ?? undefined),
    onMutate: () => beginOptimisticAction("approve"),
    onSuccess: () => { toast.success("Document approved"); completeAction(); },
    onError:   (e: { response?: { data?: { detail?: string } } }) =>
      failAction(extractApiError(e, "Approval failed")),
  });

  const rejectMutation = useMutation({
    mutationFn: () => workflowAPI.rejectTask(task.id, comment),
    onMutate: () => beginOptimisticAction("reject"),
    onSuccess: () => { toast.success("Document rejected"); completeAction(); },
    onError:   (e: { response?: { data?: { detail?: string } } }) =>
      failAction(extractApiError(e, "Rejection failed")),
  });

  const returnMutation = useMutation({
    mutationFn: () => workflowAPI.returnForReview(task.id, comment),
    onMutate: () => beginOptimisticAction("return"),
    onSuccess: () => {
      toast.success("Document returned for review");
      completeAction();
    },
    onError: (e: { response?: { data?: { detail?: string } } }) =>
      failAction(extractApiError(e, "Return failed")),
  });

  const holdMutation = useMutation({
    mutationFn: () => workflowAPI.holdTask(task.id, comment, holdHours),
    onMutate: () => beginOptimisticAction("hold"),
    onSuccess: () => {
      toast.success(`Document placed on hold for ${holdHours}h`);
      completeAction();
    },
    onError: (e: { response?: { data?: { detail?: string } } }) =>
      failAction(extractApiError(e, "Hold failed")),
  });

  const releaseMutation = useMutation({
    mutationFn: () => workflowAPI.releaseHold(task.id),
    onMutate: () => beginOptimisticAction("release"),
    onSuccess: () => { toast.success("Hold released"); completeAction(); },
    onError:   (e: { response?: { data?: { detail?: string } } }) =>
      failAction(extractApiError(e, "Release failed")),
  });

  const isHeld     = task.status === "held";
  const isActive   = task.status === "in_progress";
  const _isActionable = isHeld || isActive;
  void _isActionable;
  const anyPending = approveMutation.isPending || rejectMutation.isPending ||
                     returnMutation.isPending  || holdMutation.isPending;

  const resetForm = () => { setComment(""); setHoldHours(24); setActiveAction(null); setSignedResult(null); };

  // Approval is the final confirm. If the step requires a signature it must be
  // captured first (via the explicit "Sign document" step), so it's applied
  // atomically with the approval — no signed version is created if they back out.
  const confirmApproval = () => {
    if (task.requires_signature && !signedResult) {
      setShowSignaturePlacement(true);
      return;
    }
    approveMutation.mutate(signedResult ?? undefined);
  };

  if (optimisticAction === "approve" || optimisticAction === "reject" || optimisticAction === "return") {
    return (
      <div className="rounded-2xl border border-border bg-background p-4">
        <div className="flex items-center gap-3 text-sm text-foreground">
          <Loader2 className="h-4 w-4 animate-spin text-primary" />
          Updating workflow state...
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-2xl border border-border bg-background p-4 space-y-4">
      {showSignaturePlacement && (
        <SignaturePlacementModal
          documentId={documentId}
          documentTitle={task.document_title}
          documentRef={task.document_ref}
          note={comment ? `Approval note: ${comment}` : undefined}
          confirmLabel="Save signature"
          onCancel={() => setShowSignaturePlacement(false)}
          onConfirm={(result) => { setSignedResult(result); setShowSignaturePlacement(false); }}
          isSubmitting={false}
        />
      )}
      {/* Panel header */}
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="font-semibold text-foreground text-sm flex items-center gap-2">
            <span
              className={clsx(
                "w-2 h-2 rounded-full flex-shrink-0",
                isHeld ? "bg-blue-400" : "bg-amber-400 animate-pulse"
              )}
            />
            {task.step.name}
          </h3>
          <p className="text-xs text-muted-foreground mt-0.5">{task.status_display}</p>
        </div>
        <div className="text-right text-xs text-muted-foreground flex-shrink-0">
          {isHeld && task.held_until && (
            <p className="text-blue-600 font-medium">
              Auto-releases {formatDistanceToNow(new Date(task.held_until), { addSuffix: true })}
            </p>
          )}
          {task.due_at && !isHeld && (
            <p className={new Date(task.due_at) < new Date() ? "text-destructive font-medium" : ""}>
              Due {formatDistanceToNow(new Date(task.due_at), { addSuffix: true })}
            </p>
          )}
        </div>
      </div>

      {/* Instructions */}
      {task.step.instructions && (
        <div className="text-xs text-muted-foreground bg-muted/20 rounded-lg px-3 py-2 border border-border">
          <span className="font-medium text-foreground">Instructions: </span>
          {task.step.instructions}
        </div>
      )}

      {task.requires_signature && (
        <div className="flex items-start gap-2 text-xs text-primary bg-primary/5 rounded-lg px-3 py-2 border border-primary/20">
          <FileSignature className="w-4 h-4 mt-0.5 flex-shrink-0" />
          <span>Approval will apply your saved e-signature to a new signed PDF version.</span>
        </div>
      )}

      {/* Hold release — shown at top when held */}
      {isHeld && (
        <button
          onClick={() => releaseMutation.mutate()}
          disabled={releaseMutation.isPending}
          className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg border border-blue-200 bg-blue-100 text-blue-800 text-sm font-medium hover:bg-blue-200 disabled:opacity-50 transition-colors"
        >
          {releaseMutation.isPending
            ? <Loader2 className="w-4 h-4 animate-spin" />
            : <PlayCircle className="w-4 h-4" />}
          Release hold early
        </button>
      )}

      {/* Action buttons — shown when task is active */}
      {isActive && !activeAction && (
        <div className="grid grid-cols-2 gap-2">
          {task.step?.allow_approve !== false && (
            <button
              onClick={() => setActiveAction("approve")}
              className="flex items-center justify-center gap-1.5 px-3 py-2.5 rounded-lg border border-teal-200 bg-teal-50 text-teal-700 text-sm font-medium hover:bg-teal-100 transition-colors"
              title="Approve this document"
            >
              <CheckCircle className="w-4 h-4" /> Approve
            </button>
          )}
          {task.step?.allow_reject !== false && (
            <button
              onClick={() => setActiveAction("reject")}
              className="flex items-center justify-center gap-1.5 px-3 py-2.5 rounded-lg border border-red-200 bg-red-50 text-red-700 text-sm font-medium hover:bg-red-100 transition-colors"
              title="Reject this document — requires comment"
            >
              <XCircle className="w-4 h-4" /> Reject
            </button>
          )}
          {task.step?.allow_return !== false && (
            <button
              onClick={() => setActiveAction("return")}
              className="flex items-center justify-center gap-1.5 px-3 py-2.5 rounded-lg border border-amber-200 bg-amber-50 text-amber-800 text-sm font-medium hover:bg-amber-100 transition-colors"
              title="Return for review — sends back for rework"
            >
              <RotateCcw className="w-4 h-4" /> Return for review
            </button>
          )}
          <button
            onClick={() => setActiveAction("hold")}
            className="flex items-center justify-center gap-1.5 px-3 py-2.5 rounded-lg border border-blue-200 bg-blue-50 text-blue-700 text-sm font-medium hover:bg-blue-100 transition-colors"
            title="Pause processing and place on hold"
          >
            <PauseCircle className="w-4 h-4" /> Place on hold
          </button>
        </div>
      )}

      {/* ── Approve form ───────────────────────────────────────────────── */}
      {activeAction === "approve" && (
        <div className="space-y-3 border border-border rounded-xl p-4 bg-muted/15">
          <p className="text-sm font-medium text-foreground">Approve document</p>
          <div>
            <label className="label text-xs">Comment (optional)</label>
            <textarea
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              rows={2}
              className="input text-sm"
              placeholder="Add an approval note…"
              autoFocus
            />
          </div>

          {/* Explicit signing step — required before approval can complete. */}
          {task.requires_signature && (
            signedResult ? (
              <div className="flex items-center justify-between gap-2 text-xs bg-green-50 text-green-700 rounded-lg px-3 py-2 border border-green-200">
                <span className="flex items-center gap-2">
                  <CheckCircle className="w-4 h-4 flex-shrink-0" />
                  Signature placed — it will be applied when you confirm.
                </span>
                <button
                  type="button"
                  onClick={() => setShowSignaturePlacement(true)}
                  className="font-medium underline hover:no-underline"
                >
                  Re-sign
                </button>
              </div>
            ) : (
              <div className="space-y-2">
                <div className="flex items-start gap-2 text-xs text-primary bg-primary/5 rounded-lg px-3 py-2 border border-primary/20">
                  <FileSignature className="w-4 h-4 mt-0.5 flex-shrink-0" />
                  <span>This step requires your signature. Sign the document first, then confirm the approval to apply it.</span>
                </div>
                <button
                  type="button"
                  onClick={() => setShowSignaturePlacement(true)}
                  className="w-full flex items-center justify-center gap-1.5 px-4 py-2 rounded-lg border border-primary bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90"
                >
                  <FileSignature className="w-4 h-4" /> Sign document
                </button>
              </div>
            )
          )}

          <div className="flex gap-2">
            <button
              onClick={confirmApproval}
              disabled={anyPending || (task.requires_signature && !signedResult)}
              title={task.requires_signature && !signedResult ? "Sign the document first" : "Confirm approval"}
              className="flex items-center gap-1.5 px-4 py-2 rounded-lg border border-primary/30 bg-primary/10 text-primary text-sm font-medium hover:bg-primary/15 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {approveMutation.isPending && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
              Confirm approval
            </button>
            <button onClick={resetForm} className="btn-secondary text-sm">Cancel</button>
          </div>
        </div>
      )}

      {/* ── Reject form ────────────────────────────────────────────────── */}
      {activeAction === "reject" && (
        <div className="space-y-3 border border-border rounded-xl p-4 bg-muted/15">
          <p className="text-sm font-medium text-foreground">Reject document</p>
          <div>
            <label className="label text-xs">Rejection reason <span className="text-red-500">*</span></label>
            <textarea
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              rows={3}
              className="input text-sm"
              placeholder="Explain why this document is being rejected…"
              autoFocus
            />
          </div>
          <div className="flex gap-2">
            <button
              onClick={() => {
                if (!comment.trim()) { toast.error("Comment required"); return; }
                rejectMutation.mutate();
              }}
              disabled={anyPending}
              className="flex items-center gap-1.5 px-4 py-2 rounded-lg border border-destructive/20 bg-destructive/10 text-destructive text-sm font-medium hover:bg-destructive/15 disabled:opacity-50"
            >
              {rejectMutation.isPending && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
              Confirm rejection
            </button>
            <button onClick={resetForm} className="btn-secondary text-sm">Cancel</button>
          </div>
        </div>
      )}

      {/* ── Return for review form ─────────────────────────────────────── */}
      {activeAction === "return" && (
        <div className="space-y-3 border border-border rounded-xl p-4 bg-muted/15">
          <div>
            <p className="text-sm font-medium text-foreground">Return for review</p>
            <p className="text-xs text-muted-foreground mt-0.5">
              The document will be sent back for rework. The uploader will be notified by email.
              If this is step 1, the workflow resets and they must resubmit from scratch.
            </p>
          </div>
          <div>
            <label className="label text-xs">What needs to be fixed? <span className="text-red-500">*</span></label>
            <textarea
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              rows={3}
              className="input text-sm"
              placeholder="Be specific — the requester will see this message…"
              autoFocus
            />
          </div>
          <div className="flex gap-2">
            <button
              onClick={() => {
                if (!comment.trim()) { toast.error("Please explain what needs to be fixed"); return; }
                returnMutation.mutate();
              }}
              disabled={anyPending}
              className="flex items-center gap-1.5 px-4 py-2 rounded-lg border border-amber-300 bg-amber-100 text-amber-800 text-sm font-medium hover:bg-amber-200 disabled:opacity-50"
            >
              {returnMutation.isPending && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
              Return document
            </button>
            <button onClick={resetForm} className="btn-secondary text-sm">Cancel</button>
          </div>
        </div>
      )}

      {/* ── Hold form ──────────────────────────────────────────────────── */}
      {activeAction === "hold" && (
        <div className="space-y-3 border border-border rounded-xl p-4 bg-muted/15">
          <div>
            <p className="text-sm font-medium text-foreground">Place on hold</p>
            <p className="text-xs text-muted-foreground mt-0.5">
              The document will be paused. It auto-resumes after the hold period.
              The requester will be notified.
            </p>
          </div>
          <div>
            <label className="label text-xs">Reason for hold <span className="text-red-500">*</span></label>
            <textarea
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              rows={2}
              className="input text-sm"
              placeholder="e.g. Awaiting supplier clarification…"
              autoFocus
            />
          </div>
          <div>
            <label className="label text-xs">Hold duration</label>
            <div className="flex items-center gap-3">
              <input
                type="number"
                min={1}
                max={720}
                value={holdHours}
                onChange={(e) => setHoldHours(Math.max(1, Math.min(720, Number(e.target.value))))}
                className="input w-28 text-sm"
              />
              <span className="text-sm text-muted-foreground">
                hours
                {holdHours >= 24 && (
                  <span className="ml-1 text-muted-foreground/70">
                    (= {Math.floor(holdHours / 24)}d{holdHours % 24 > 0 ? ` ${holdHours % 24}h` : ""})
                  </span>
                )}
              </span>
            </div>
            {/* Quick presets */}
            <div className="flex gap-1.5 mt-2 flex-wrap">
              {[4, 8, 24, 48, 72, 168].map((h) => (
                <button
                  key={h}
                  type="button"
                  onClick={() => setHoldHours(h)}
                  className={clsx(
                    "px-2 py-0.5 text-xs rounded-full border transition-colors",
                    holdHours === h
                      ? "bg-primary/10 text-primary border-primary/30"
                      : "border-gray-300 text-gray-600 hover:border-primary/70"
                  )}
                >
                  {h < 24 ? `${h}h` : `${h / 24}d`}
                </button>
              ))}
            </div>
          </div>
          <div className="flex gap-2">
            <button
              onClick={() => {
                if (!comment.trim()) { toast.error("Please provide a reason for the hold"); return; }
                holdMutation.mutate();
              }}
              disabled={anyPending}
              className="flex items-center gap-1.5 px-4 py-2 rounded-lg border border-blue-200 bg-blue-100 text-blue-800 text-sm font-medium hover:bg-blue-200 disabled:opacity-50"
            >
              {holdMutation.isPending && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
              <Clock className="w-3.5 h-3.5" />
              Confirm hold
            </button>
            <button onClick={resetForm} className="btn-secondary text-sm">Cancel</button>
          </div>
        </div>
      )}

      {/* Action history */}
      <div className="border-t border-border pt-3">
        <TaskHistoryDrawer taskId={task.id} task={task} currentUserId={currentUser?.id || ""} />
      </div>
    </div>
  );
}
