import { useQuery } from "@tanstack/react-query";
import { Calendar, ChevronLeft, ExternalLink, MessageSquare, X } from "lucide-react";
import clsx from "clsx";
import { workflowAPI, normalizeListResponse } from "@/services/api";
import { WorkflowVisualizer, type WorkflowStep } from "./workflow-visualizer";

export interface NotificationDetailData {
  id: string;
  title: string;
  message: string;
  type: string;
  createdAt: string;
  priority: "high" | "medium" | "low";
  viewDocumentLink?: string;
  documentId?: string;
}

interface NotificationDetailProps {
  notification: NotificationDetailData;
  onClose: () => void;
  onViewDocument: () => void;
}

const TYPE_STYLES: Record<string, { badge: string; label: string }> = {
  task_assigned: {
    badge: "border-primary/20 bg-primary/10 text-primary",
    label: "Approval Required",
  },
  workflow_complete: {
    badge: "border-teal/20 bg-teal/10 text-teal",
    label: "Workflow Complete",
  },
  document_returned: {
    badge: "border-amber-200 bg-amber-50 text-amber-800",
    label: "Returned",
  },
  document_held: {
    badge: "border-orange-200 bg-orange-50 text-orange-800",
    label: "On Hold",
  },
  task_overdue: {
    badge: "border-destructive/20 bg-destructive/10 text-destructive",
    label: "Overdue",
  },
};

function priorityClass(priority: NotificationDetailData["priority"]) {
  switch (priority) {
    case "high":
      return "border-destructive/20 bg-destructive/10 text-destructive";
    case "medium":
      return "border-amber-200 bg-amber-50 text-amber-800";
    default:
      return "border-border bg-muted text-muted-foreground";
  }
}

export function NotificationDetail({
  notification,
  onClose,
  onViewDocument,
}: NotificationDetailProps) {
  const typeStyle = TYPE_STYLES[notification.type] ?? {
    badge: "border-border bg-muted text-muted-foreground",
    label: notification.title,
  };
  const isWorkflowNotification = notification.type.startsWith("workflow") ||
    notification.type.startsWith("task_") ||
    notification.type.startsWith("document_") ||
    notification.type.startsWith("hold_");

  const { data: workflowData, isLoading: workflowLoading } = useQuery({
    queryKey: ["notification-workflow", notification.documentId],
    queryFn: () => loadWorkflowData(notification.documentId!),
    enabled: isWorkflowNotification && !!notification.documentId,
    staleTime: 30_000,
  });

  return (
    <div className="fixed inset-0 z-50 overflow-hidden bg-foreground/30 backdrop-blur-sm">
      <div className="absolute bottom-0 right-0 top-0 flex w-full max-w-xl flex-col border-l border-border bg-background shadow-2xl">
        <div className="border-b border-border bg-card px-5 py-4">
          <div className="mb-3 flex items-center justify-between gap-3">
            <button
              type="button"
              onClick={onClose}
              className="inline-flex items-center gap-1.5 text-sm font-medium text-muted-foreground hover:text-foreground"
            >
              <ChevronLeft className="h-4 w-4" />
              Back
            </button>
            <button
              type="button"
              onClick={onClose}
              className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
              aria-label="Close notification details"
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <span className={clsx("rounded-full border px-2.5 py-1 text-xs font-semibold", typeStyle.badge)}>
              {typeStyle.label}
            </span>
            <span className={clsx("rounded-full border px-2.5 py-1 text-xs font-semibold uppercase", priorityClass(notification.priority))}>
              {notification.priority} priority
            </span>
          </div>
          <h2 className="mt-3 text-xl font-semibold text-foreground">{notification.title}</h2>
          <p className="mt-1 flex items-center gap-1.5 text-sm text-muted-foreground">
            <Calendar className="h-4 w-4" />
            {new Date(notification.createdAt).toLocaleString(undefined, {
              dateStyle: "medium",
              timeStyle: "short",
            })}
          </p>
        </div>

        <div className="flex-1 overflow-y-auto p-5">
          <div className="rounded-lg border border-border bg-card p-4">
            <div className="flex items-start gap-3">
              <MessageSquare className="mt-0.5 h-5 w-5 flex-shrink-0 text-primary" />
              <div>
                <p className="text-sm font-semibold text-foreground">Notification details</p>
                <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
                  {notification.message}
                </p>
              </div>
            </div>
          </div>

          {isWorkflowNotification && (
            <div className="mt-5">
              <WorkflowVisualizer
                steps={workflowData?.steps ?? []}
                currentStep={workflowData?.currentStep ?? -1}
                documentTitle={workflowData?.documentTitle}
                submittedBy={workflowData?.submittedBy}
                submittedDate={workflowData?.submittedDate}
                isLoading={workflowLoading}
              />
            </div>
          )}
        </div>

        <div className="border-t border-border bg-card p-5">
          <div className="flex gap-3">
            <button
              type="button"
              onClick={onViewDocument}
              disabled={!notification.viewDocumentLink}
              className="btn-primary flex-1 justify-center disabled:opacity-40"
            >
              <ExternalLink className="h-4 w-4" />
              View document
            </button>
            <button
              type="button"
              onClick={onClose}
              className="btn-secondary justify-center"
            >
              Close
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

type WorkflowTaskRecord = {
  id?: string;
  status?: string;
  status_display?: string;
  step?: {
    name?: string;
    order?: number;
  };
  assigned_to?: {
    full_name?: string;
    first_name?: string;
    last_name?: string;
  };
  workflow_instance?: {
    document?: {
      title?: string;
      uploaded_by?: {
        full_name?: string;
        first_name?: string;
        last_name?: string;
      };
      created_at?: string;
    };
    created_at?: string;
    submitted_by?: {
      full_name?: string;
      first_name?: string;
      last_name?: string;
    };
  };
  document_title?: string;
  uploaded_by_name?: string | null;
  created_at?: string;
  due_at?: string | null;
};

type TaskHistoryRecord = {
  action?: string;
  action_display?: string;
  actor?: {
    full_name?: string;
    first_name?: string;
    last_name?: string;
  };
  comment?: string;
  created_at?: string;
};

async function loadWorkflowData(documentId: string): Promise<{
  steps: WorkflowStep[];
  currentStep: number;
  documentTitle?: string;
  submittedBy?: string;
  submittedDate?: string;
}> {
  let tasks = await workflowAPI
    .listTasks({ document: documentId })
    .then((response) => normalizeListResponse<WorkflowTaskRecord>(response.data));

  if (tasks.length === 0) {
    tasks = await workflowAPI
      .listTasks({ document_id: documentId })
      .then((response) => normalizeListResponse<WorkflowTaskRecord>(response.data));
  }

  const orderedTasks = [...tasks].sort((a, b) => (a.step?.order ?? 0) - (b.step?.order ?? 0));
  const histories = await Promise.all(
    orderedTasks.map((task) =>
      task.id
        ? workflowAPI
            .taskHistory(task.id)
            .then((response) => normalizeListResponse<TaskHistoryRecord>(response.data))
            .catch(() => [])
        : Promise.resolve([]),
    ),
  );

  const steps = orderedTasks.map<WorkflowStep>((task, index) => {
    const history = histories[index] ?? [];
    const latestAction = [...history].reverse().find((item) =>
      ["approved", "rejected", "returned", "held", "released"].includes(String(item.action ?? "").toLowerCase()),
    );
    const status = mapTaskStatus(task.status, latestAction?.action);
    const approver = formatPerson(task.assigned_to) || "Unassigned";

    return {
      id: task.id ?? `${task.step?.order ?? index}-${task.step?.name ?? "step"}`,
      name: task.step?.name ?? `Step ${index + 1}`,
      approver,
      status,
      completedAt: latestAction?.created_at
        ? new Date(latestAction.created_at).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })
        : undefined,
      comment: latestAction?.comment || undefined,
      order: task.step?.order ?? index + 1,
    };
  });

  if (!steps.some((step) => step.status === "in-progress" || step.status === "rejected")) {
    const firstPendingIndex = steps.findIndex((step) => step.status === "pending");
    if (firstPendingIndex >= 0) {
      steps[firstPendingIndex] = { ...steps[firstPendingIndex], status: "in-progress" };
    }
  }

  const currentStep = steps.findIndex((step) => step.status === "in-progress");
  const firstTask = orderedTasks[0];
  const document = firstTask?.workflow_instance?.document;
  const submittedBy =
    formatPerson(firstTask?.workflow_instance?.submitted_by) ||
    formatPerson(document?.uploaded_by) ||
    firstTask?.uploaded_by_name ||
    undefined;
  const submittedDate = firstTask?.workflow_instance?.created_at || document?.created_at || firstTask?.created_at;

  return {
    steps,
    currentStep,
    documentTitle: firstTask?.document_title || document?.title,
    submittedBy,
    submittedDate: submittedDate
      ? new Date(submittedDate).toLocaleDateString(undefined, { dateStyle: "medium" })
      : undefined,
  };
}

function mapTaskStatus(taskStatus?: string, action?: string): WorkflowStep["status"] {
  const normalizedAction = String(action ?? "").toLowerCase();
  const normalizedStatus = String(taskStatus ?? "").toLowerCase();
  if (normalizedAction === "approved" || normalizedStatus === "approved" || normalizedStatus === "completed") return "completed";
  if (normalizedAction === "rejected" || normalizedStatus === "rejected") return "rejected";
  if (["in_progress", "held"].includes(normalizedStatus)) return "in-progress";
  return "pending";
}

function formatPerson(person?: { full_name?: string; first_name?: string; last_name?: string } | null): string {
  if (!person) return "";
  if (person.full_name) return person.full_name;
  return [person.first_name, person.last_name].filter(Boolean).join(" ");
}
