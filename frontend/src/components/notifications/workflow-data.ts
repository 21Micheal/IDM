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
  execution_lane?: string;
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
    job_description?: string;
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
  node_id?: string | null;
  order: number;
  name: string;
  status_label?: string;
  step_type?: string;
  assignee_type?: string;
  assignee_group_name?: string | null;
  assignee_user_name?: string | null;
  assignee_user_auto?: boolean;
  notify_user_name?: string | null;
  notify_email?: string;
  instructions?: string;
  post_lpo_after_approval?: boolean;
};

type WorkflowTemplateRecord = {
  id: string;
  name: string;
  definition?: unknown;
  steps?: WorkflowTemplateStepRecord[];
};

/** Display order for procurement and its retirement sub-process. */
export const PROCUREMENT_PHASE_ORDER: WorkflowPhase[] = ["requisition", "request", "rfq", "lpo", "retirement"];

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
  step?: { parallel_lane?: string };
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

function parallelImprestOrdersFromDefinition(definition: unknown): Set<number> {
  if (!definition || typeof definition !== "object") return new Set();
  const def = definition as { version?: number; blocks?: DefinitionBlock[] };
  if (def.version !== 2 || !Array.isArray(def.blocks)) return new Set();
  const orders = new Set<number>();
  let counter = 0;
  const walk = (blocks: DefinitionBlock[] | undefined) => {
    for (const block of blocks ?? []) {
      if (block.kind === "approval" || block.kind === "notification") {
        counter += 1;
        if (block.kind === "approval" && block.step?.parallel_lane === "imprest_request") orders.add(counter);
      } else if (block.kind === "if_else") {
        for (const branch of block.branches ?? []) walk(branch.blocks);
        walk(block.else_blocks);
      } else if (block.kind === "switch") {
        for (const item of block.cases ?? []) walk(item.blocks);
        walk(block.default_blocks);
      }
    }
  };
  walk(def.blocks);
  return orders;
}

type WorkflowInstanceRecord = {
  id: string;
  status?: string;
  current_step_order?: number | null;
  imprest_request_status?: string;
  imprest_request_current_step_order?: number | null;
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
    job_description?: string;
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

  // Prefer the document phase, which is the current sequential procurement
  // stage, and use the instance only while the document metadata catches up.
  const effectivePhase = workflowPhase ?? (instance?.phase as WorkflowPhase | undefined) ?? null;

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

  const meta = getWorkflowMeta(orderedTasks.filter((task) => task.execution_lane !== "imprest_request"), instance);
  const steps = buildApproverWorkflow(
    tasksWithHistory,
    template?.steps ?? [],
    effectivePhase,
    template?.definition,
    instance?.current_step_order,
    instance?.imprest_request_current_step_order,
    instance?.imprest_request_status,
  );

  // The workflow is still "live" (worth polling) while at least one stage is
  // running or yet to be reached, and it hasn't ended in a rejection.
  const taskSteps = steps.filter((step) => !step.kind || step.kind === "task");
  const hasActiveTask = orderedTasks.some((task) => ["in_progress", "held", "awaiting_posting"].includes(String(task.status)));
  const isActive = instance?.status === "in_progress"
    || instance?.imprest_request_status === "in_progress"
    || hasActiveTask
    || taskSteps.some((step) =>
      step.status === "in-progress" ||
      step.status === "on-hold" ||
      step.status === "returned",
    );

  return {
    steps,
    currentStep: (() => {
      const activeMain = steps.findIndex((step) => step.executionLane !== "imprest_request" && (step.status === "in-progress" || step.status === "on-hold"));
      return activeMain >= 0 ? activeMain : steps.findIndex((step) => step.status === "in-progress" || step.status === "on-hold");
    })(),
    isActive,
    ...meta,
  };
}

function buildApproverWorkflow(
  tasksWithHistory: Array<{ task: WorkflowTaskRecord; history: TaskHistoryRecord[] }>,
  templateSteps: WorkflowTemplateStepRecord[] = [],
  workflowPhase?: WorkflowPhase | null,
  templateDefinition?: unknown,
  currentStepOrder?: number | null,
  imprestRequestCurrentStepOrder?: number | null,
  imprestRequestStatus?: string,
): WorkflowStep[] {
  const grouped = tasksWithHistory.reduce((map, item) => {
    const order = item.task.step?.order ?? map.size + 1;
    if (!map.has(order)) map.set(order, []);
    map.get(order)!.push(item);
    return map;
  }, new Map<number, Array<{ task: WorkflowTaskRecord; history: TaskHistoryRecord[] }>>());

  // Phase split for branched templates: order -> phase. Orphaned task rows are
  // reconciled with the current mirror below before phase filtering is applied.
  const phaseMap = phaseOrdersFromDefinition(templateDefinition);
  const orderPhase = new Map<number, string>();
  const sequentialRequestCase = workflowPhase === "request" && Boolean(phaseMap?.request);
  const parallelImprestOrders = sequentialRequestCase
    ? new Set<number>()
    : parallelImprestOrdersFromDefinition(templateDefinition);
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

  // Repair display for older task rows that still point at mirror steps parked
  // by previous workflow saves. The active instance cursor gives the current
  // step; completed rows can be matched to an unfilled step by their name.
  if (templateSteps.length > 0) {
    const validOrders = new Set(sourceStepsRaw.map((step) => step.order));
    const orphanGroups = [...grouped.entries()]
      .filter(([order]) => !validOrders.has(order))
      .sort(([a], [b]) => a - b);
    for (const [orphanOrder, items] of orphanGroups) {
      const active = items.some(({ task }) => ["in_progress", "held", "awaiting_posting"].includes(String(task.status)));
      const isImprestLane = parallelImprestOrders.has(orphanOrder)
        || items.some(({ task }) => task.execution_lane === "imprest_request");
      const laneCursor = isImprestLane ? imprestRequestCurrentStepOrder : currentStepOrder;
      const activeTarget = active && laneCursor && validOrders.has(laneCursor)
        ? laneCursor
        : undefined;
      const orphanName = items[0]?.task.step?.name?.trim().toLowerCase();
      const nameTarget = sourceStepsRaw.find((step) =>
        step.name?.trim().toLowerCase() === orphanName && !grouped.has(step.order),
      )?.order;
      const targetOrder = activeTarget ?? nameTarget;
      if (!targetOrder || targetOrder === orphanOrder) continue;
      grouped.set(targetOrder, [...(grouped.get(targetOrder) ?? []), ...items]);
      grouped.delete(orphanOrder);
    }
  }

  const sourceSteps = phaseMap
    ? sourceStepsRaw.filter((step) => orderPhase.has(step.order) || parallelImprestOrders.has(step.order))
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
    const approvalActions = allHistory
      .filter((action) => String(action.action ?? "").toLowerCase() === "approved")
      .sort((a, b) => Date.parse(String(a.created_at ?? "")) - Date.parse(String(b.created_at ?? "")));
    const latestApprovalAction = approvalActions[approvalActions.length - 1];
    const latestTaskItem = [...items]
      .filter((item) => item.task.acted_at)
      .sort((a, b) => Date.parse(String(b.task.acted_at)) - Date.parse(String(a.task.acted_at)))[0];
    const statuses = items.map((item) => mapTaskStatus(
      item.task.status,
      latestActionForHistory(item.history)?.action,
      item.task.acted_at,
    ));
    const lane = !sequentialRequestCase && (
      parallelImprestOrders.has(stepOrder)
      || items.some(({ task }) => task.execution_lane === "imprest_request")
    );
    const laneNotRequired = lane && ["not_required", "cancelled"].includes(String(imprestRequestStatus ?? ""))
      && !items.length;
    const rawStatus: WorkflowStep["status"] = laneNotRequired
      ? "skipped"
      : items.length ? resolveStepStatus(statuses) : "pending";
    // Future tasks may already carry a provisional auto-selected approver.
    // Show that assignee only after the step becomes active or has been acted
    // on; before then, show the configured group instead of a stale person.
    const taskWithAssignee = rawStatus === "pending"
      ? undefined
      : rawStatus === "in-progress" || rawStatus === "on-hold"
        ? items.find((item) => ["in_progress", "held", "awaiting_posting"].includes(String(item.task.status)))
        : [...items]
            .filter((item) => ["approved", "rejected", "returned", "notified"].includes(String(item.task.status)))
            .sort((a, b) => Date.parse(String(b.task.acted_at ?? "")) - Date.parse(String(a.task.acted_at ?? "")))[0];
    const rawName = templateStep.name?.trim() || items[0]?.task.step?.name?.trim() || `${ordinal(index + 1)} Approver`;
    const name = isNotification ? (rawName || "Notification") : (rawName || `${ordinal(index + 1)} Approver`);

    const recipientLabel = templateStep.notify_user_name
      || items[0]?.task.step?.notify_user_name
      || templateStep.notify_email
      || items[0]?.task.step?.notify_email
      || "Recipient";

    const configuredApprover = templateStep.assignee_user_auto
      ? templateStep.assignee_group_name || formatAssigneeType(templateStep.assignee_type)
      : templateStep.assignee_user_name
        || templateStep.assignee_group_name
        || formatAssigneeType(templateStep.assignee_type);
    const approver = isNotification
      ? recipientLabel
      : latestApprovalAction?.actor
        ? formatPerson(latestApprovalAction.actor) || configuredApprover || "Unassigned"
      : templateStep.assignee_type === "group_all"
        ? configuredApprover || "All group members"
        : (formatPerson(taskWithAssignee?.task.assigned_to) || configuredApprover || "Unassigned");

    return {
      id: isNotification ? `notification-${stepOrder}` : `approver-${stepOrder}`,
      stepOrder,
      index,
      phase: orderPhase.get(stepOrder),
      executionLane: lane ? "imprest_request" as const : undefined,
      isNotification,
      name,
      approver,
      approverFullName: latestApprovalAction?.actor
        ? formatPerson(latestApprovalAction.actor)
        : formatPerson(taskWithAssignee?.task.assigned_to),
      approverPosition: latestApprovalAction?.actor
        ? latestApprovalAction.actor.job_description || ""
        : taskWithAssignee?.task.assigned_to?.job_description || "",
      rawStatus,
      hasTasks: items.length > 0,
      completedAt: latestTaskItem?.task.acted_at || latestAction?.created_at || undefined,
      comment: latestTaskItem?.task.comment || latestAction?.comment || undefined,
      description: isNotification
        ? "Automated notification step"
        : (templateStep.instructions || `${ordinal(index + 1)} approval step`),
      postLpoAfterApproval: Boolean(templateStep.post_lpo_after_approval),
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

  const terminatedLanes = new Set<string>();
  const resolved = base.map((step) => {
    let status: WorkflowStep["status"] = step.rawStatus;
    const laneKey = step.executionLane === "imprest_request" ? "imprest_request" : "main";
    if (terminatedLanes.has(laneKey) && !step.hasTasks) status = "skipped";
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
    if (status === "rejected") terminatedLanes.add(laneKey);
    return { ...step, status };
  });

  // ── Pass 3: compose human-readable status text from each step's position ────
  const approvers = resolved.map((step, index) => {
    const previous = step.executionLane === "imprest_request"
      ? [...resolved.slice(0, index)].reverse().find((candidate) => candidate.executionLane === "imprest_request")
      : [...resolved.slice(0, index)].reverse().find((candidate) => candidate.executionLane !== "imprest_request");
    return {
      id: step.id,
      name: step.name,
      approver: step.approver,
      approverFullName: step.approverFullName,
      approverPosition: step.approverPosition,
      status: step.status,
      phase: step.phase,
      executionLane: step.executionLane,
      statusDisplay: step.executionLane === "imprest_request" && step.status === "skipped" && !step.hasTasks
        ? "Not required"
        : step.executionLane === "imprest_request" && step.status === "pending" && !previous
          ? "Starts after requisition approval"
        : describeStatus({
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

function mapTaskStatus(taskStatus?: string, action?: string, actedAt?: string | null): WorkflowStep["status"] {
  const normalizedStatus = String(taskStatus ?? "").toLowerCase();
  // The persisted task state is authoritative. Histories can lag immediately
  // after an action, so an older action must never overwrite the current state.
  if (normalizedStatus === "notified") return "completed";
  if (["approved", "completed"].includes(normalizedStatus)) return "completed";
  if (normalizedStatus === "rejected") return "rejected";
  if (normalizedStatus === "returned") return "returned";
  if (normalizedStatus === "held") return "on-hold";
  // The generator task stays in the actor's queue while SunSystems posts and
  // the LPO is built. Its approval action is already complete during that
  // hold, so show the approval as completed in the stage table.
  if (normalizedStatus === "awaiting_posting") {
    return String(action ?? "").toLowerCase() === "approved" || Boolean(actedAt)
      ? "completed"
      : "in-progress";
  }
  if (normalizedStatus === "in_progress") return "in-progress";
  if (normalizedStatus === "skipped") return "skipped";
  const normalizedAction = String(action ?? "").toLowerCase();
  if (normalizedAction === "notified") return "completed";
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
