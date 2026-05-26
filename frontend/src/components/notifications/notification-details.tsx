import { useQuery } from "@tanstack/react-query";
import { Calendar, ChevronLeft, ExternalLink, X } from "lucide-react";
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

function priorityClass(priority: NotificationDetailData["priority"]) {
  switch (priority) {
    case "high":
      return "border-destructive/20 bg-destructive/10 text-destructive";
    case "medium":
      return "border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-900/40 dark:bg-amber-950/30 dark:text-amber-400";
    default:
      return "border-border bg-muted text-muted-foreground";
  }
}

export function NotificationDetail({
  notification,
  onClose,
  onViewDocument,
}: NotificationDetailProps) {
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
      {/* Widened side-panel so the workflow chart has breathing room */}
      <div className="absolute bottom-0 right-0 top-0 flex w-full max-w-4xl flex-col border-l border-border bg-background shadow-2xl">
        {/* Header */}
        <div className="border-b border-border px-6 py-4">
          <div className="mb-4 flex items-center justify-between">
            <button
              type="button"
              onClick={onClose}
              className="inline-flex items-center gap-1.5 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground"
            >
              <ChevronLeft className="h-4 w-4" />
              Back
            </button>
            <button
              type="button"
              onClick={onClose}
              className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              aria-label="Close notification details"
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <span className={clsx("rounded-full border px-2 py-1 text-xs font-semibold", priorityClass(notification.priority))}>
                {notification.priority} priority
              </span>
            </div>
            <h2 className="text-lg font-semibold text-foreground">{notification.title}</h2>
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Calendar className="h-4 w-4" />
              {new Date(notification.createdAt).toLocaleString(undefined, {
                dateStyle: "medium",
                timeStyle: "short",
              })}
            </div>
          </div>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto px-6 py-4">
          <div className="space-y-5">
            {/* Message */}
            <div className="space-y-2">
              <p className="text-sm text-foreground leading-relaxed">{notification.message}</p>
            </div>

            {/* Workflow Diagram */}
            {isWorkflowNotification && (
              <div className="space-y-3 rounded-xl border border-border bg-muted/10 p-4">
                <div className="flex items-center justify-between">
                  <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                    Workflow Status
                  </h3>
                </div>
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
        </div>

        {/* Footer */}
        <div className="border-t border-border bg-muted/20 px-6 py-4">
          <div className="flex gap-2">
            <button
              type="button"
              onClick={onViewDocument}
              disabled={!notification.viewDocumentLink}
              className={clsx(
                "inline-flex w-full max-w-[220px] items-center justify-center gap-2 rounded-lg px-4 py-2 text-sm font-medium transition-colors sm:w-auto",
                notification.viewDocumentLink
                  ? "bg-primary text-primary-foreground hover:bg-primary/90"
                  : "bg-muted text-muted-foreground opacity-50 cursor-not-allowed",
              )}
            >
              <ExternalLink className="h-4 w-4" />
              View Document
            </button>
            <button
              type="button"
              onClick={onClose}
              className="inline-flex items-center justify-center rounded-lg border border-border px-4 py-2 text-sm font-medium transition-colors hover:bg-muted"
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

  const tasksWithHistory = orderedTasks.map((task, index) => ({
    task,
    history: histories[index] ?? [],
  }));

  const grouped = tasksWithHistory.reduce((map, item) => {
    const stepOrder = item.task.step?.order ?? 0;
    const stepName = item.task.step?.name?.trim() || `Step ${stepOrder || map.size + 1}`;
    const key = `${stepOrder}-${stepName}`;
    if (!map.has(key)) {
      map.set(key, {
        order: stepOrder,
        name: stepName,
        items: [item],
      });
    } else {
      map.get(key)!.items.push(item);
    }
    return map;
  }, new Map<string, { order: number; name: string; items: Array<{ task: WorkflowTaskRecord; history: TaskHistoryRecord[] }> }>());

  const latestActionForHistory = (history: TaskHistoryRecord[]) =>
    [...history]
      .reverse()
      .find((item) =>
        ["approved", "rejected", "returned", "held", "released"].includes(
          String(item.action ?? "").toLowerCase(),
        ),
      );

  // ------------------------------------------------------------------
  // Workflow diagram step-building (with dynamic gateway branching)
  // ------------------------------------------------------------------

  // Keep the grouped and initial setup mapping the same.
  const steps: WorkflowStep[] = [];

  // 0) Insert Start Event
  // NOTE: We don’t know the actual first task step id ahead of time,
  // so we patch the `next` once task steps are computed.
  const startStepId = "start";
  steps.push({
    id: startStepId,
    name: "Start",
    approver: "",
    status: "completed",
    kind: "start",
    order: 0,
    next: [],
  });

  // 1) Create task steps from grouped values + inject branch mapping.
  const taskSteps = Array.from(grouped.values())
    .sort((a, b) => a.order - b.order)
    .map<WorkflowStep>((group, index) => {
      const allHistory = group.items.flatMap((item) => item.history ?? []);
      const latestAction = latestActionForHistory(allHistory);

      const taskStatuses = group.items.map((item) =>
        mapTaskStatus(
          item.task.status,
          latestActionForHistory(item.history)?.action,
        ),
      );
      const hasReturned = taskStatuses.includes("returned");
      const hasCompleted = taskStatuses.includes("completed");
      const hasPending = taskStatuses.includes("pending");
      const status = taskStatuses.includes("rejected")
        ? "rejected"
        : taskStatuses.includes("in-progress")
          ? "in-progress"
          : hasCompleted && !hasPending
            ? "completed"
            : hasReturned
              ? "returned"
              : "pending";
      const statusDisplay =
        group.items
          .map((item) => item.task.status_display?.trim())
          .find(Boolean) || latestActionForHistory(group.items.flatMap((item) => item.history))?.action_display?.trim();

      const approver =
        group.items.find((item) => item.task.assigned_to)?.task.assigned_to ||
        group.items[0].task.assigned_to ||
        null;

      const stepId = `step-${group.order}-${group.name}`;

      // --- CRITICAL BRANCHING LOGIC INJECTION ---
      let nextNodes: string[] = [];
      let kind: WorkflowStep["kind"] = "task";

      // Replicating the flow graph based on step layout names.
      if (group.name === "Originator Notification") {
        nextNodes = ["step-1-Approver1"];
      } else if (group.name === "Approver1") {
        // Approver1 links directly into a Gateway branch splitter
        nextNodes = ["gateway-approver1"];
      } else if (group.name === "Approver1 Notification") {
        nextNodes = ["step-2-Approved"];
      } else if (group.name === "Approved") {
        nextNodes = ["step-3-Approver2"];
      } else if (group.name === "Approver2") {
        // Approver2 links directly into the second Gateway splitter
        nextNodes = ["gateway-approver2"];
      } else if (group.name === "Approver2 Notification") {
        nextNodes = ["step-4-Approved2"];
      } else if (
        group.name === "Approved2" ||
        group.name === "RejectedTwo" ||
        group.name === "Rejected"
      ) {
        // All final paths merge into the End Node
        nextNodes = ["end"];
      } else if (group.name === "Rejected1") {
        nextNodes = ["step-2-Rejected"];
      }

      return {
        id: stepId,
        name: group.name,
        approver: formatPerson(approver) || "Unassigned",
        status,
        statusDisplay,
        completedAt: latestAction?.created_at
          ? new Date(latestAction.created_at).toLocaleDateString(undefined, {
              dateStyle: "medium",
              timeStyle: "short",
            })
          : undefined,
        comment: latestAction?.comment || undefined,
        order: group.order || index + 1,
        kind,
        next: nextNodes,
      };
    });

  steps.push(...taskSteps);

  // 2) Patch Start -> first task step
  const firstTaskStep = taskSteps
    .slice()
    .sort((a, b) => a.order - b.order)[0];
  const start = steps.find((s) => s.id === startStepId);
  if (start && firstTaskStep?.id) {
    start.next = [firstTaskStep.id];
  }

  // 3) Inject Gateway 1 (After Approver1 split)
  const approver1Step = steps.find((s) => s.id === "step-1-Approver1");
  steps.push({
    id: "gateway-approver1",
    name: "Approved?",
    approver: "",
    kind: "gateway",
    status:
      approver1Step?.status === "completed" ? "completed" : "pending",
    order: 1.5,
    // Index 0 is "Yes" branch, Index 1 is "No" branch
    next: ["step-2-Approver1 Notification", "step-2-Rejected1"],
  });

  // 4) Inject Gateway 2 (After Approver2 split)
  const approver2Step = steps.find((s) => s.id === "step-3-Approver2");
  steps.push({
    id: "gateway-approver2",
    name: "Approved?",
    approver: "",
    kind: "gateway",
    status:
      approver2Step?.status === "completed" ? "completed" : "pending",
    order: 3.5,
    // Index 0 is "Yes" branch, Index 1 is "No" branch
    next: ["step-4-Approver2 Notification", "step-4-RejectedTwo"],
  });

  // 5) Insert End Event
  steps.push({
    id: "end",
    name: "End",
    approver: "",
    kind: "end",
    status:
      steps.some(
        (s) => s.status === "completed" && s.next?.includes("end"),
      )
        ? "completed"
        : "pending",
    order: 99,
    next: [],
  });

  // Make sure your "in-progress" defaults carry over seamlessly
  if (!steps.some((step) => step.status === "in-progress" || step.status === "rejected")) {
    const firstPendingIndex = steps.findIndex(
      (step) => step.status === "pending" && step.kind === "task",
    );
    if (firstPendingIndex >= 0) {
      steps[firstPendingIndex] = {
        ...steps[firstPendingIndex],
        status: "in-progress",
      };
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
  if (normalizedAction === "returned" || normalizedStatus === "returned") return "returned";
  if (normalizedAction === "held" || normalizedStatus === "held") return "on-hold";
  if (normalizedAction === "approved" || normalizedStatus === "approved" || normalizedStatus === "completed") return "completed";
  if (normalizedAction === "rejected" || normalizedStatus === "rejected") return "rejected";
  if (normalizedStatus === "in_progress") return "in-progress";
  return "pending";
}

function formatPerson(person?: { full_name?: string; first_name?: string; last_name?: string } | null): string {
  if (!person) return "";
  if (person.full_name) return person.full_name;
  return [person.first_name, person.last_name].filter(Boolean).join(" ");
}