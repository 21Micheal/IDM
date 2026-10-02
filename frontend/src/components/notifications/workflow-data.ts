import { normalizeListResponse, workflowAPI } from "@/services/api";
import type { WorkflowStep } from "./workflow-visualizer";

/** All phases the workflow engine can assign to a document instance. */
export type WorkflowPhase =
  | "request"
  | "retirement"
  | "requisition"
  | "rfq"
  | "lpo"
  | "payment_run";

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
    template?: string;
    name?: string;
    order?: number;
    status_label?: string;
    step_type?: string;
    notify_user_name?: string | null;
    notify_email?: string;
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
  acted_at?: string | null;
  comment?: string;
  due_at?: string | null;
};

type WorkflowTemplateStepRecord = {
  id?: string;
  order: number;
  name: string;
  status_label?: string;
  step_type?: string;
  assignee_type?: string;
  assignee_group_name?: string | null;
  assignee_user_name?: string | null;
  notify_user_name?: string | null;
  notify_email?: string;
  instructions?: string;
};

type WorkflowTemplateRecord = {
  id: string;
  name: string;
  definition?: unknown;
  steps?: WorkflowTemplateStepRecord[];
};

/** Ordered procurement stages. Kept in sync with the backend's
 *  ``PROCUREMENT_WORKFLOW_STAGES``. */
export const PROCUREMENT_PHASE_ORDER: WorkflowPhase[] = ["requisition", "rfq", "lpo"];

export const PHASE_LABELS: Record<string, string> = {
  requisition: "Requisition",
  rfq: "RFQ",
  lpo: "LPO",
  request: "Request",
  retirement: "Retirement",
  payment_run: "Payment Run",
};

type DefinitionBlock = {
  kind?: string;
  field_id?: string;
  values?: string[];
  label?: string;
  blocks?: DefinitionBlock[];
  cases?: Array<{ values?: string[]; label?: string; blocks?: DefinitionBlock[] }>;
  default_blocks?: DefinitionBlock[];
  branches?: Array<{ blocks?: DefinitionBlock[] }>;
  else_blocks?: DefinitionBlock[];
};

/**
 * Map each phase in a branched definition to the step orders that belong to it.
 *
 * The flat ``WorkflowStep`` mirror keeps every case's steps in document order
 * (a switch on ``context.phase`` flattens to lpo, rfq, requisition — not the
 * lifecycle order).  This walks the definition the same way the backend's
 * ``flatten_steps`` does and tags each counted step with the phase of the case it
 * came from, so the UI can show only the stages of the active phase.
 *
 * Returns ``null`` for legacy/linear templates where no phase split exists.
 */
export function phaseOrdersFromDefinition(definition: unknown): Record<string, number[]> | null {
  if (!definition || typeof definition !== "object") return null;
  const def = definition as { version?: number; blocks?: DefinitionBlock[] };
  if (def.version !== 2 || !Array.isArray(def.blocks)) return null;
  if (!def.blocks.some((b) => b?.kind === "switch" && b?.field_id === "context.phase")) {
    return null;
  }

  const result: Record<string, number[]> = {};
  let counter = 0;

  const walk = (blocks: DefinitionBlock[] | undefined, phase: string | null) => {
    for (const block of blocks ?? []) {
      const kind = block?.kind;
      if (kind === "approval" || kind === "notification") {
        counter += 1;
        if (phase) (result[phase] ??= []).push(counter);
      } else if (kind === "switch") {
        const isPhaseSwitch = block.field_id === "context.phase";
        for (const caseBlock of block.cases ?? []) {
          const casePhase = isPhaseSwitch
            ? (String((caseBlock.values ?? [])[0] ?? caseBlock.label ?? "").trim().toLowerCase() || null)
            : phase;
          walk(caseBlock.blocks, casePhase);
        }
        walk(block.default_blocks, isPhaseSwitch ? null : phase);
      } else if (kind === "if_else") {
        for (const branch of block.branches ?? []) walk(branch.blocks, phase);
        walk(block.else_blocks, phase);
      }
    }
  };

  walk(def.blocks, null);
  return Object.keys(result).length ? result : null;
}

type WorkflowInstanceRecord = {
  id: string;
  status?: string;
  document?: string;
  template?: string;
  phase?: WorkflowPhase | string;
  started_at?: string;
  started_by?: {
    full_name?: string;
    first_name?: string;
    last_name?: string;
  };
  tasks?: WorkflowTaskRecord[];
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

export async function loadWorkflowData(documentId: string, workflowPhase?: WorkflowPhase | null): Promise<{
  steps: WorkflowStep[];
  currentStep: number;
  isActive: boolean;
  documentTitle?: string;
  submittedBy?: string;
  submittedDate?: string;
}> {
  const instances = await workflowAPI
    .listInstances({ document: documentId })
    .then((response) => normalizeListResponse<WorkflowInstanceRecord>(response.data))
    .catch(() => []);
  const phaseMatches = (row: WorkflowInstanceRecord) =>
    !workflowPhase || !row.phase || row.phase === workflowPhase;
  const instance =
    instances.find((row) => row.status === "in_progress" && phaseMatches(row)) ??
    instances.find(phaseMatches) ??
    instances.find((row) => row.status === "in_progress") ??
    instances[0];

  // Use the instance's own phase field as the authoritative source. This prevents
  // a stale or missing caller-supplied phase from causing the retirement instance's
  // completed steps to show "Approved" instead of "Fully approved" (or vice-versa).
  const effectivePhase = (instance?.phase as WorkflowPhase | undefined) ?? workflowPhase ?? null;

  const template = instance?.template
    ? await workflowAPI
        .getTemplate(instance.template)
        .then((response) => response.data as WorkflowTemplateRecord)
        .catch(() => undefined)
    : undefined;

  let tasks = [...(instance?.tasks ?? [])];
  if (instance?.template) {
    tasks = tasks.filter((task) => !task.step?.template || task.step.template === instance.template);
  }

  if (tasks.length === 0) {
    tasks = await workflowAPI
      .listTasks({ document: documentId })
      .then((response) => normalizeListResponse<WorkflowTaskRecord>(response.data));
  }

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

  const meta = getWorkflowMeta(orderedTasks, instance);
  const steps = buildApproverWorkflow(
    tasksWithHistory,
    template?.steps ?? [],
    effectivePhase,
    template?.definition,
  );

  // The workflow is still "live" (worth polling) while at least one stage is
  // running or yet to be reached, and it hasn't ended in a rejection.
  const taskSteps = steps.filter((step) => !step.kind || step.kind === "task");
  const isActive = orderedTasks.length > 0
    && taskSteps.some((step) =>
      step.status === "in-progress" ||
      step.status === "on-hold" ||
      step.status === "returned" ||
      step.status === "pending",
    );

  return {
    steps,
    currentStep: steps.findIndex((step) => step.status === "in-progress" || step.status === "on-hold"),
    isActive,
    ...meta,
  };
}

function buildApproverWorkflow(
  tasksWithHistory: Array<{ task: WorkflowTaskRecord; history: TaskHistoryRecord[] }>,
  templateSteps: WorkflowTemplateStepRecord[] = [],
  workflowPhase?: WorkflowPhase | null,
  templateDefinition?: unknown,
): WorkflowStep[] {
  const grouped = tasksWithHistory.reduce((map, item) => {
    const order = item.task.step?.order ?? map.size + 1;
    if (!map.has(order)) map.set(order, []);
    map.get(order)!.push(item);
    return map;
  }, new Map<number, Array<{ task: WorkflowTaskRecord; history: TaskHistoryRecord[] }>>());

  // Phase split for branched templates: order -> phase.  Orphaned mirror rows
  // (steps kept for FK history but no longer in the definition) have no phase
  // and are dropped so they never appear in the table.
  const phaseMap = phaseOrdersFromDefinition(templateDefinition);
  const orderPhase = new Map<number, string>();
  if (phaseMap) {
    for (const [phaseName, orders] of Object.entries(phaseMap)) {
      for (const order of orders) orderPhase.set(order, phaseName);
    }
  }

  const sourceStepsRaw = templateSteps.length > 0
    ? [...templateSteps].sort((a, b) => a.order - b.order)
    : Array.from(grouped.keys())
        .sort((a, b) => a - b)
        .map<WorkflowTemplateStepRecord>((order) => ({
          order,
          name: grouped.get(order)?.[0]?.task.step?.name?.trim() || "",
          status_label: grouped.get(order)?.[0]?.task.step?.status_label,
          assignee_type: undefined,
          assignee_group_name: undefined,
          assignee_user_name: undefined,
          instructions: undefined,
        }));
  const sourceSteps = phaseMap
    ? sourceStepsRaw.filter((step) => orderPhase.has(step.order))
    : sourceStepsRaw;

  // ── Pass 1: derive each step's raw status from its own tasks ────────────────
  // A step only has tasks once the engine has reached it, so a step with no
  // tasks simply hasn't started yet → "pending" (upcoming).
  const base = sourceSteps.map((templateStep, index) => {
    const stepOrder = templateStep.order;
    const items = grouped.get(stepOrder) ?? [];
    const isNotification = templateStep.step_type === "notification"
      || items.some((item) => item.task.step?.step_type === "notification");
    const allHistory = items.flatMap((item) => item.history ?? []);
    const latestAction = latestActionForHistory(allHistory);
    const statuses = items.map((item) => mapTaskStatus(item.task.status, latestActionForHistory(item.history)?.action));
    const rawStatus: WorkflowStep["status"] = items.length ? resolveStepStatus(statuses) : "pending";
    const taskWithAssignee = items.find((item) => item.task.assigned_to) ?? items[0];
    const rawName = templateStep.name?.trim() || items[0]?.task.step?.name?.trim() || `${ordinal(index + 1)} Approver`;
    const name = isNotification ? (rawName || "Notification") : (rawName || `${ordinal(index + 1)} Approver`);

    const recipientLabel = templateStep.notify_user_name
      || items[0]?.task.step?.notify_user_name
      || templateStep.notify_email
      || items[0]?.task.step?.notify_email
      || "Recipient";

    const approver = isNotification
      ? recipientLabel
      : (
        formatPerson(taskWithAssignee?.task.assigned_to) ||
        templateStep.assignee_user_name ||
        templateStep.assignee_group_name ||
        formatAssigneeType(templateStep.assignee_type) ||
        "Unassigned"
      );

    return {
      id: isNotification ? `notification-${stepOrder}` : `approver-${stepOrder}`,
      stepOrder,
      index,
      phase: orderPhase.get(stepOrder),
      isNotification,
      name,
      approver,
      rawStatus,
      hasTasks: items.length > 0,
      completedAt: latestAction?.created_at || items.find((item) => item.task.acted_at)?.task.acted_at || undefined,
      comment: latestAction?.comment || items.find((item) => item.task.comment)?.task.comment || undefined,
      description: isNotification
        ? "Automated notification step"
        : (templateStep.instructions || `${ordinal(index + 1)} approval step`),
    };
  });

  // ── Pass 2: once a step is rejected the workflow stops; later steps that
  // never received a task are unreachable rather than merely "pending". ────────
  // A phase that never produced a task (e.g. RFQ on a Travel requisition) is
  // shown as skipped rather than an upcoming approval.
  const phaseHasTasks = new Map<string, boolean>();
  for (const item of tasksWithHistory) {
    const phase = orderPhase.get(item.task.step?.order ?? -1);
    if (phase) phaseHasTasks.set(phase, true);
  }

  const phaseIndex = (value?: string | null) =>
    value ? PROCUREMENT_PHASE_ORDER.indexOf(value as WorkflowPhase) : -1;
  const currentPhaseIndex = phaseIndex(workflowPhase);

  let terminated = false;
  const resolved = base.map((step) => {
    let status: WorkflowStep["status"] = step.rawStatus;
    if (terminated && !step.hasTasks) status = "skipped";
    const stepPhaseIndex = phaseIndex(step.phase);
    if (
      step.phase
      && stepPhaseIndex >= 0
      && currentPhaseIndex >= 0
      && stepPhaseIndex < currentPhaseIndex
      && !phaseHasTasks.get(step.phase)
    ) {
      status = "skipped";
    }
    if (status === "rejected") terminated = true;
    return { ...step, status };
  });

  // ── Pass 3: compose human-readable status text from each step's position ────
  const approvers = resolved.map((step, index) => {
    const previous = index > 0 ? resolved[index - 1] : undefined;
    return {
      id: step.id,
      name: step.name,
      approver: step.approver,
      status: step.status,
      phase: step.phase,
      statusDisplay: describeStatus({
        status: step.status,
        isNotification: step.isNotification,
        stepName: step.name,
        previousName: previous?.name,
        previousIsNotification: previous?.isNotification,
        // Use the step's own phase so a completed Requisition step reads
        // "Requisition Approved" even while the document is in the RFQ stage.
        workflowPhase: (step.phase as WorkflowPhase | undefined) ?? workflowPhase,
      }),
      completedAt: step.completedAt,
      comment: step.comment,
      order: step.stepOrder,
      description: step.description,
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
      description: approver.description || `${ordinal(index + 1)} approval step`,
      statusDisplay: approver.statusDisplay,
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

/**
 * Turn a step's status (plus its position in the chain) into the label shown on
 * the card. The current stage reads "In progress", finished stages read
 * "Approved"/"Notification sent", and upcoming stages read
 * "Awaiting <preceding stage> approval" so it's clear what they're blocked on.
 */
function describeStatus({
  status,
  isNotification,
  stepName,
  previousName,
  previousIsNotification,
  workflowPhase,
}: {
  status: WorkflowStep["status"];
  isNotification: boolean;
  stepName?: string;
  previousName?: string;
  previousIsNotification?: boolean;
  workflowPhase?: WorkflowPhase | null;
}): string {
  // Human-readable labels per procurement/document phase
  const phaseApprovedLabel: Record<string, string> = {
    requisition: "Requisition Approved",
    rfq: "RFQ Approved",
    lpo: "LPO Approved",
    retirement: "Fully Approved",
    request: "Approved",
  };
  const phaseRejectedLabel: Record<string, string> = {
    requisition: "Requisition Rejected",
    rfq: "RFQ Rejected",
    lpo: "LPO Rejected",
    retirement: "Retirement Rejected",
    request: "Rejected",
  };
  const approvedLabel = (workflowPhase && phaseApprovedLabel[workflowPhase]) ?? "Approved";
  const rejectedLabel = (workflowPhase && phaseRejectedLabel[workflowPhase]) ?? "Rejected";

  switch (status) {
    case "completed":
      return isNotification ? "Notification sent" : approvedLabel;
    case "in-progress":
      return isNotification ? "Sending notification" : (stepName ? `Pending \u2014 ${stripApproval(stepName)}` : "Pending review");
    case "on-hold":
      return "On hold";
    case "rejected":
      return rejectedLabel;
    case "returned":
      return "Returned for review";
    case "skipped":
      return "Not reached";
    case "pending":
    default:
      if (!previousName) {
        return isNotification ? "Pending notification" : "Awaiting submission";
      }
      if (isNotification) {
        return `Pending — sends after ${previousName}`;
      }
      return previousIsNotification
        ? `Awaiting ${previousName}`
        : `Awaiting ${stripApproval(previousName)} approval`;
  }
}

/** Strip a redundant trailing "approval" word so we don't produce
 *  "Awaiting Manager Approval approval" when the step is already named
 *  something like "Manager Approval" or "Finance approval". */
function stripApproval(name: string): string {
  return name.replace(/\s+approval\s*$/i, "").trim();
}

function resolveStepStatus(statuses: WorkflowStep["status"][]): WorkflowStep["status"] {
  if (statuses.includes("rejected")) return "rejected";
  if (statuses.includes("on-hold")) return "on-hold";
  if (statuses.includes("in-progress")) return "in-progress";

  const hasReturned = statuses.includes("returned");
  const hasCompleted = statuses.includes("completed");
  const hasPending = statuses.includes("pending");

  if (hasCompleted && !hasPending) return "completed";
  if (hasReturned) return "returned";
  return "pending";
}

function latestActionForHistory(history: TaskHistoryRecord[]) {
  return [...history]
    .reverse()
    .find((item) =>
      ["approved", "rejected", "returned", "held", "released", "notified"].includes(
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

function getWorkflowMeta(orderedTasks: WorkflowTaskRecord[], instance?: WorkflowInstanceRecord) {
  const firstTask = orderedTasks[0];
  const document = firstTask?.workflow_instance?.document;
  const submittedBy =
    formatPerson(firstTask?.workflow_instance?.submitted_by) ||
    formatPerson(instance?.started_by) ||
    formatPerson(document?.uploaded_by) ||
    firstTask?.uploaded_by_name ||
    undefined;
  const submittedDate = firstTask?.workflow_instance?.created_at || instance?.started_at || document?.created_at || firstTask?.created_at;

  return {
    documentTitle: firstTask?.document_title || document?.title,
    submittedBy,
    submittedDate,
  };
}

function mapTaskStatus(taskStatus?: string, action?: string): WorkflowStep["status"] {
  const normalizedAction = String(action ?? "").toLowerCase();
  const normalizedStatus = String(taskStatus ?? "").toLowerCase();
  if (normalizedAction === "notified" || normalizedStatus === "notified") return "completed";
  if (normalizedAction === "approved" || normalizedStatus === "approved" || normalizedStatus === "completed") return "completed";
  if (normalizedAction === "rejected" || normalizedStatus === "rejected") return "rejected";
  if (normalizedAction === "returned" || normalizedStatus === "returned") return "returned";
  if (normalizedAction === "held" || normalizedStatus === "held") return "on-hold";
  if (normalizedStatus === "in_progress") return "in-progress";
  if (normalizedStatus === "skipped") return "skipped";
  return "pending";
}

function formatAssigneeType(assigneeType?: string) {
  switch (assigneeType) {
    case "group_all":
      return "All group members";
    case "group_any":
      return "Any group member";
    case "group_specific":
      return "Specific approver";
    default:
      return "";
  }
}

function formatPerson(person?: { full_name?: string; first_name?: string; last_name?: string } | null): string {
  if (!person) return "";
  if (person.full_name) return person.full_name;
  return [person.first_name, person.last_name].filter(Boolean).join(" ");
}
