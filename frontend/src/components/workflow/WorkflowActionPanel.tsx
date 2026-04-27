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
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { workflowAPI } from "@/services/api";
import {
  CheckCircle, XCircle, RotateCcw, PauseCircle,
  PlayCircle, Loader2, Clock, ChevronDown, History,
} from "lucide-react";
import { toast } from "@/components/ui/vault-toast";
import { formatDistanceToNow, format } from "date-fns";
import clsx from "clsx";

// ── Types ─────────────────────────────────────────────────────────────────────
interface WorkflowTask {
  id:             string;
  status:         string;
  status_display: string;
  step:           { name: string; order: number; instructions: string; allow_approve: boolean; allow_reject: boolean; allow_return: boolean };
  assigned_to?:   { id: string; full_name: string };
  due_at?:        string;
  held_until?:    string;
  document_ref:   string;
}

interface TaskAction {
  id:             string;
  action:         string;
  action_display: string;
  actor:          { full_name: string };
  comment:        string;
  hold_hours?:    number;
  created_at:     string;
}

interface Props {
  task: WorkflowTask;
  documentId: string;
}

// ── Action colour map ─────────────────────────────────────────────────────────
const ACTION_STYLES: Record<string, string> = {
  approved:  "bg-green-50  text-green-700  border-green-200",
  rejected:  "bg-red-50    text-red-700    border-red-200",
  returned:  "bg-amber-50  text-amber-700  border-amber-200",
  held:      "bg-blue-50   text-blue-700   border-blue-200",
  released:  "bg-gray-50   text-gray-600   border-gray-200",
};

// ── History drawer ────────────────────────────────────────────────────────────
function TaskHistoryDrawer({ taskId }: { taskId: string }) {
  const [open, setOpen] = useState(false);

  const { data: actions } = useQuery<TaskAction[]>({
    queryKey: ["task-history", taskId],
    queryFn:  () => workflowAPI.taskHistory(taskId).then((r) => r.data),
    enabled:  open,
  });

  return (
    <div>
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1.5 text-xs text-gray-500 hover:text-gray-700 transition-colors"
      >
        <History className="w-3.5 h-3.5" />
        Action history
        <ChevronDown className={clsx("w-3.5 h-3.5 transition-transform", open && "rotate-180")} />
      </button>

      {open && (
        <div className="mt-3 space-y-2">
          {!actions?.length && (
            <p className="text-xs text-gray-400 py-2">No actions recorded yet.</p>
          )}
          {actions?.map((a) => (
            <div
              key={a.id}
              className={clsx(
                "flex items-start gap-3 px-3 py-2.5 rounded-lg border text-xs",
                ACTION_STYLES[a.action] ?? "bg-gray-50 text-gray-600 border-gray-200"
              )}
            >
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-semibold">{a.action_display}</span>
                  <span className="text-opacity-70">by {a.actor.full_name}</span>
                  {a.hold_hours && (
                    <span className="opacity-70">for {a.hold_hours}h</span>
                  )}
                </div>
                {a.comment && (
                  <p className="mt-1 opacity-80 line-clamp-2">{a.comment}</p>
                )}
              </div>
              <span className="flex-shrink-0 opacity-60 whitespace-nowrap">
                {format(new Date(a.created_at), "dd MMM HH:mm")}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Main panel ────────────────────────────────────────────────────────────────
export default function WorkflowActionPanel({ task, documentId }: Props) {
  const qc = useQueryClient();

  const [activeAction, setActiveAction] = useState<
    "approve" | "reject" | "return" | "hold" | null
  >(null);
  const [comment, setComment]   = useState("");
  const [holdHours, setHoldHours] = useState(24);

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["document", documentId] });
    qc.invalidateQueries({ queryKey: ["workflow", "my-tasks"] });
    qc.invalidateQueries({ queryKey: ["task-history", task.id] });
  };

  const approveMutation = useMutation({
    mutationFn: () => workflowAPI.approveTask(task.id, comment),
    onSuccess: () => { toast.success("Document approved"); invalidate(); setActiveAction(null); },
    onError:   (e: { response?: { data?: { detail?: string } } }) =>
      toast.error(e?.response?.data?.detail ?? "Approval failed"),
  });

  const rejectMutation = useMutation({
    mutationFn: () => workflowAPI.rejectTask(task.id, comment),
    onSuccess: () => { toast.success("Document rejected"); invalidate(); setActiveAction(null); },
    onError:   (e: { response?: { data?: { detail?: string } } }) =>
      toast.error(e?.response?.data?.detail ?? "Rejection failed"),
  });

  const returnMutation = useMutation({
    mutationFn: () => workflowAPI.returnForReview(task.id, comment),
    onSuccess: () => {
      toast.success("Document returned for review");
      invalidate();
      setActiveAction(null);
    },
    onError: (e: { response?: { data?: { detail?: string } } }) =>
      toast.error(e?.response?.data?.detail ?? "Return failed"),
  });

  const holdMutation = useMutation({
    mutationFn: () => workflowAPI.holdTask(task.id, comment, holdHours),
    onSuccess: () => {
      toast.success(`Document placed on hold for ${holdHours}h`);
      invalidate();
      setActiveAction(null);
    },
    onError: (e: { response?: { data?: { detail?: string } } }) =>
      toast.error(e?.response?.data?.detail ?? "Hold failed"),
  });

  const releaseMutation = useMutation({
    mutationFn: () => workflowAPI.releaseHold(task.id),
    onSuccess: () => { toast.success("Hold released"); invalidate(); },
    onError:   (e: { response?: { data?: { detail?: string } } }) =>
      toast.error(e?.response?.data?.detail ?? "Release failed"),
  });

  const isHeld     = task.status === "held";
  const isActive   = task.status === "in_progress";
  const isActionable = isHeld || isActive;
  const anyPending = approveMutation.isPending || rejectMutation.isPending ||
                     returnMutation.isPending  || holdMutation.isPending;

  const resetForm = () => { setComment(""); setHoldHours(24); setActiveAction(null); };

  return (
    <div className="card border-l-4 border-brand-500 p-5 space-y-4">
      {/* Panel header */}
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="font-semibold text-gray-900 text-sm flex items-center gap-2">
            <span
              className={clsx(
                "w-2 h-2 rounded-full flex-shrink-0",
                isHeld ? "bg-blue-400" : "bg-amber-400 animate-pulse"
              )}
            />
            {task.step.name}
          </h3>
          <p className="text-xs text-gray-500 mt-0.5">{task.status_display}</p>
        </div>
        <div className="text-right text-xs text-gray-400 flex-shrink-0">
          {isHeld && task.held_until && (
            <p className="text-blue-500 font-medium">
              Auto-releases {formatDistanceToNow(new Date(task.held_until), { addSuffix: true })}
            </p>
          )}
          {task.due_at && !isHeld && (
            <p className={new Date(task.due_at) < new Date() ? "text-red-500 font-medium" : ""}>
              Due {formatDistanceToNow(new Date(task.due_at), { addSuffix: true })}
            </p>
          )}
        </div>
      </div>

      {/* Instructions */}
      {task.step.instructions && (
        <div className="text-xs text-gray-600 bg-gray-50 rounded-lg px-3 py-2 border border-gray-100">
          <span className="font-medium text-gray-700">Instructions: </span>
          {task.step.instructions}
        </div>
      )}

      {/* Hold release — shown at top when held */}
      {isHeld && (
        <button
          onClick={() => releaseMutation.mutate()}
          disabled={releaseMutation.isPending}
          className="w-full flex items-center justify-center gap-2 px-4 py-2.5 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 disabled:opacity-50 transition-colors"
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
              className="flex items-center justify-center gap-1.5 px-3 py-2.5 bg-green-600 text-white text-sm font-medium rounded-lg hover:bg-green-700 transition-colors"
              title="Approve this document"
            >
              <CheckCircle className="w-4 h-4" /> Approve
            </button>
          )}
          {task.step?.allow_reject !== false && (
            <button
              onClick={() => setActiveAction("reject")}
              className="flex items-center justify-center gap-1.5 px-3 py-2.5 bg-red-600 text-white text-sm font-medium rounded-lg hover:bg-red-700 transition-colors"
              title="Reject this document — requires comment"
            >
              <XCircle className="w-4 h-4" /> Reject
            </button>
          )}
          {task.step?.allow_return !== false && (
            <button
              onClick={() => setActiveAction("return")}
              className="flex items-center justify-center gap-1.5 px-3 py-2.5 bg-amber-500 text-white text-sm font-medium rounded-lg hover:bg-amber-600 transition-colors"
              title="Return for review — sends back for rework"
            >
              <RotateCcw className="w-4 h-4" /> Return for review
            </button>
          )}
          <button
            onClick={() => setActiveAction("hold")}
            className="flex items-center justify-center gap-1.5 px-3 py-2.5 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 transition-colors"
            title="Pause processing and place on hold"
          >
            <PauseCircle className="w-4 h-4" /> Place on hold
          </button>
        </div>
      )}

      {/* ── Approve form ───────────────────────────────────────────────── */}
      {activeAction === "approve" && (
        <div className="space-y-3 border border-green-200 rounded-xl p-4 bg-green-50/40">
          <p className="text-sm font-medium text-green-800">Approve document</p>
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
          <div className="flex gap-2">
            <button
              onClick={() => approveMutation.mutate()}
              disabled={anyPending}
              className="flex items-center gap-1.5 px-4 py-2 bg-green-600 text-white text-sm font-medium rounded-lg hover:bg-green-700 disabled:opacity-50"
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
        <div className="space-y-3 border border-red-200 rounded-xl p-4 bg-red-50/40">
          <p className="text-sm font-medium text-red-800">Reject document</p>
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
              className="flex items-center gap-1.5 px-4 py-2 bg-red-600 text-white text-sm font-medium rounded-lg hover:bg-red-700 disabled:opacity-50"
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
        <div className="space-y-3 border border-amber-200 rounded-xl p-4 bg-amber-50/40">
          <div>
            <p className="text-sm font-medium text-amber-800">Return for review</p>
            <p className="text-xs text-amber-600 mt-0.5">
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
              className="flex items-center gap-1.5 px-4 py-2 bg-amber-500 text-white text-sm font-medium rounded-lg hover:bg-amber-600 disabled:opacity-50"
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
        <div className="space-y-3 border border-blue-200 rounded-xl p-4 bg-blue-50/40">
          <div>
            <p className="text-sm font-medium text-blue-800">Place on hold</p>
            <p className="text-xs text-blue-600 mt-0.5">
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
              <span className="text-sm text-gray-500">
                hours
                {holdHours >= 24 && (
                  <span className="ml-1 text-gray-400">
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
                      ? "bg-blue-600 text-white border-blue-600"
                      : "border-gray-300 text-gray-600 hover:border-blue-400"
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
              className="flex items-center gap-1.5 px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 disabled:opacity-50"
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
      <div className="border-t border-gray-100 pt-3">
        <TaskHistoryDrawer taskId={task.id} />
      </div>
    </div>
  );
}
