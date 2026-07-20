import type { WorkflowTask } from "@/types";
import { formatDocumentFileType } from "@/lib/documentFormat";

export type TaskUrgencyFilter = "" | "overdue" | "due_soon" | "held";

export type WorkflowTaskFilters = {
  search: string;
  documentType: string;
  department: string;
  fileFormat: string;
  urgency: TaskUrgencyFilter;
};

export type TaskFilterOption = {
  value: string;
  label: string;
  count: number;
};

type WorkflowTaskDocument = NonNullable<WorkflowTask["workflow_instance"]>["document"] & {
  department?: string | null;
  department_name?: string | null;
  uploaded_by?: {
    first_name?: string;
    last_name?: string;
    email?: string;
    department_name?: string | null;
    department?: { name?: string | null } | string | null;
  } | null;
};

export const DEFAULT_WORKFLOW_TASK_FILTERS: WorkflowTaskFilters = {
  search: "",
  documentType: "",
  department: "",
  fileFormat: "",
  urgency: "",
};

function normalize(value: unknown) {
  return String(value ?? "").trim();
}

function getTaskDocument(task: WorkflowTask): WorkflowTaskDocument | undefined {
  return task.workflow_instance?.document as WorkflowTaskDocument | undefined;
}

export function getTaskDocumentTitle(task: WorkflowTask) {
  return normalize(getTaskDocument(task)?.title || task.document_title) || "Untitled document";
}

export function getTaskDocumentReference(task: WorkflowTask) {
  return normalize(getTaskDocument(task)?.reference_number || task.document_ref);
}

export function getTaskDocumentType(task: WorkflowTask) {
  const doc = getTaskDocument(task);
  return (
    normalize(doc?.document_type_name || doc?.document_type?.name || task.document_type_name) ||
    "Unclassified"
  );
}

export function getTaskDocumentFormat(task: WorkflowTask) {
  return formatDocumentFileType(task.file_name, task.file_mime_type);
}

export function getTaskDepartment(task: WorkflowTask) {
  const doc = getTaskDocument(task);
  const uploadedByDepartment = doc?.uploaded_by?.department;
  const uploadedByDepartmentName =
    typeof uploadedByDepartment === "string"
      ? uploadedByDepartment
      : uploadedByDepartment?.name;

  return (
    normalize(
      task.document_department_name ||
        task.uploader_department_name ||
        doc?.department_name ||
        doc?.department ||
        doc?.uploaded_by?.department_name ||
        uploadedByDepartmentName,
    ) || "No department"
  );
}

export function getTaskUploaderName(task: WorkflowTask) {
  const doc = getTaskDocument(task);
  const uploadedBy = doc?.uploaded_by;
  const joinedName = normalize(`${uploadedBy?.first_name ?? ""} ${uploadedBy?.last_name ?? ""}`);
  return normalize(task.uploaded_by_name || joinedName || uploadedBy?.email);
}

export function getTaskDocumentId(task: WorkflowTask) {
  return getTaskDocument(task)?.id || task.document_id;
}

export function getTaskIsForm(task: WorkflowTask) {
  const doc = getTaskDocument(task);
  const d = doc as any;
  return Boolean(d?.metadata?.form?.sections || d?.is_form);
}

function isDueSoon(task: WorkflowTask, now = new Date()) {
  if (!task.due_at) return false;
  const dueDate = new Date(task.due_at);
  if (Number.isNaN(dueDate.getTime())) return false;
  const hoursDiff = (dueDate.getTime() - now.getTime()) / (1000 * 60 * 60);
  return hoursDiff >= 0 && hoursDiff <= 24;
}

function isOverdue(task: WorkflowTask, now = new Date()) {
  if (!task.due_at) return false;
  const dueDate = new Date(task.due_at);
  return !Number.isNaN(dueDate.getTime()) && dueDate < now;
}

function matchesUrgency(task: WorkflowTask, urgency: TaskUrgencyFilter, now = new Date()) {
  if (!urgency) return true;
  if (urgency === "held") return task.status === "held" || Boolean(task.held_until);
  if (urgency === "overdue") return isOverdue(task, now);
  if (urgency === "due_soon") return isDueSoon(task, now);
  return true;
}

function addOption(counts: Map<string, number>, value: string) {
  const label = normalize(value);
  if (!label) return;
  counts.set(label, (counts.get(label) ?? 0) + 1);
}

function mapOptions(counts: Map<string, number>): TaskFilterOption[] {
  return [...counts.entries()]
    .map(([label, count]) => ({ value: label, label, count }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

export function buildWorkflowTaskFilterOptions(tasks: WorkflowTask[]) {
  const typeCounts = new Map<string, number>();
  const departmentCounts = new Map<string, number>();
  const formatCounts = new Map<string, number>();

  tasks.forEach((task) => {
    addOption(typeCounts, getTaskDocumentType(task));
    addOption(departmentCounts, getTaskDepartment(task));
    addOption(formatCounts, getTaskDocumentFormat(task));
  });

  return {
    documentTypes: mapOptions(typeCounts),
    departments: mapOptions(departmentCounts),
    fileFormats: mapOptions(formatCounts),
  };
}

export function filterWorkflowTasks(tasks: WorkflowTask[], filters: WorkflowTaskFilters) {
  const searchTerm = filters.search.trim().toLowerCase();
  const now = new Date();

  return tasks.filter((task) => {
    const documentType = getTaskDocumentType(task);
    const department = getTaskDepartment(task);
    const fileFormat = getTaskDocumentFormat(task);

    if (filters.documentType && documentType !== filters.documentType) return false;
    if (filters.department && department !== filters.department) return false;
    if (filters.fileFormat && fileFormat !== filters.fileFormat) return false;
    if (!matchesUrgency(task, filters.urgency, now)) return false;

    if (!searchTerm) return true;

    return [
      getTaskDocumentTitle(task),
      getTaskDocumentReference(task),
      getTaskUploaderName(task),
      documentType,
      department,
      fileFormat,
      task.step?.name,
    ]
      .join(" ")
      .toLowerCase()
      .includes(searchTerm);
  });
}

export function hasWorkflowTaskFilters(filters: WorkflowTaskFilters) {
  return Boolean(
    filters.search.trim() ||
      filters.documentType ||
      filters.department ||
      filters.fileFormat ||
      filters.urgency,
  );
}
