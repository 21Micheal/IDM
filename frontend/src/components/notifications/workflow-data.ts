import { normalizeListResponse, workflowAPI } from "@/services/api";
import type { WorkflowStep } from "./workflow-visualizer";

export interface WorkflowNotificationContext {
  id: string;
  title: string;
  message: string;
  type: string;
  createdAt: string;
  priority: "high" | "medium" | "low";
  viewDocumentLink?: string;
  documentId?: string;
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

export async function loadWorkflowData(documentId: string): Promise<{
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

  const meta = getWorkflowMeta(orderedTasks);
  const steps = buildApproverWorkflow(tasksWithHistory);

  return {
    steps,
    currentStep: steps.findIndex((step) => step.status === "in-progress"),
    ...meta,
  };
}

function buildApproverWorkflow(
  tasksWithHistory: Array<{ task: WorkflowTaskRecord; history: TaskHistoryRecord[] }>,
): WorkflowStep[] {
  const grouped = tasksWithHistory.reduce((map, item) => {
    const order = item.task.step?.order ?? map.size + 1;
    if (!map.has(order)) map.set(order, []);
    map.get(order)!.push(item);
    return map;
  }, new Map<number, Array<{ task: WorkflowTaskRecord; history: TaskHistoryRecord[] }>>());

  const approvers = Array.from(grouped.entries())
    .sort(([a], [b]) => a - b)
    .map(([stepOrder, items], index) => {
      const allHistory = items.flatMap((item) => item.history ?? []);
      const latestAction = latestActionForHistory(allHistory);
      const statuses = items.map((item) => mapTaskStatus(item.task.status, latestActionForHistory(item.history)?.action));
      const status: WorkflowStep["status"] = statuses.includes("rejected")
        ? "rejected"
        : statuses.includes("in-progress")
          ? "in-progress"
          : statuses.includes("completed")
            ? "completed"
            : "pending";
      const taskWithAssignee = items.find((item) => item.task.assigned_to) ?? items[0];
      const rawName = items[0].task.step?.name?.trim() || `${ordinal(index + 1)} Approver`;
      const name = rawName || `${ordinal(index + 1)} Approver`;

      return {
        id: `approver-${stepOrder}`,
        name,
        approver: formatPerson(taskWithAssignee.task.assigned_to) || "Unassigned",
        status,
        completedAt: latestAction?.created_at,
        comment: latestAction?.comment || undefined,
        order: stepOrder,
      };
    });

  const steps: WorkflowStep[] = [
    {
      id: "start",
      name: "Start",
      approver: "",
      status: "completed",
      kind: "start",
      order: 0,
      column: 0,
      lane: 0,
      next: approvers[0] ? [approvers[0].id] : ["end"],
    },
  ];

  approvers.forEach((approver, index) => {
    const column = index + 1;
    const nextApprover = approvers[index + 1];
    const mainNext = nextApprover?.id ?? "end";
    const next = [mainNext];

    if (approver.status === "rejected") {
      next.push(`${approver.id}-rejected`);
    }

    steps.push({
      ...approver,
      kind: "task",
      order: index + 1,
      column,
      lane: 0,
      next,
      description: `${ordinal(index + 1)} approval step`,
    });

    if (approver.status === "rejected") {
      steps.push({
        id: `${approver.id}-rejected`,
        name: "Rejected",
        approver: approver.approver,
        status: "rejected",
        completedAt: approver.completedAt,
        comment: approver.comment,
        order: index + 1.1,
        column,
        lane: 1,
        kind: "task",
        next: [],
        description: `Rejected at ${approver.name}`,
      });
    }
  });

  const complete = approvers.length > 0 && approvers.every((step) => step.status === "completed");
  steps.push({
    id: "end",
    name: "End",
    approver: "",
    status: complete ? "completed" : "pending",
    kind: "end",
    order: approvers.length + 1,
    column: approvers.length + 1,
    lane: 0,
    next: [],
  });

  return steps;
}

function latestActionForHistory(history: TaskHistoryRecord[]) {
  return [...history]
    .reverse()
    .find((item) =>
      ["approved", "rejected", "returned", "held", "released"].includes(
        String(item.action ?? "").toLowerCase(),
      ),
    );
}

function ordinal(value: number) {
  const mod100 = value % 100;
  if (mod100 >= 11 && mod100 <= 13) return `${value}th`;
  switch (value % 10) {
    case 1:
      return `${value}st`;
    case 2:
      return `${value}nd`;
    case 3:
      return `${value}rd`;
    default:
      return `${value}th`;
  }
}

function getWorkflowMeta(orderedTasks: WorkflowTaskRecord[]) {
  const firstTask = orderedTasks[0];
  const document = firstTask?.workflow_instance?.document;
  const submittedBy =
    formatPerson(firstTask?.workflow_instance?.submitted_by) ||
    formatPerson(document?.uploaded_by) ||
    firstTask?.uploaded_by_name ||
    undefined;
  const submittedDate = firstTask?.workflow_instance?.created_at || document?.created_at || firstTask?.created_at;

  return {
    documentTitle: firstTask?.document_title || document?.title,
    submittedBy,
    submittedDate,
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
