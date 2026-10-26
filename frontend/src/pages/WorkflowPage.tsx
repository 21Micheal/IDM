import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { workflowAPI, notificationsAPI, normalizeListResponse } from "@/services/api";
import { useLocation, useNavigate } from "react-router-dom";
import { AlertTriangle, CheckCircle, Clock, Filter, Loader2, Search, X } from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import type { Notification } from "@/types";
import { useEffect, useMemo, useState } from "react";
import type { WorkflowTask } from "@/types";
import {
  DEFAULT_WORKFLOW_TASK_FILTERS,
  buildWorkflowTaskFilterOptions,
  filterWorkflowTasks,
  getTaskDepartment,
  getTaskDocumentFormat,
  getTaskDocumentId,
  getTaskDocumentReference,
  getTaskDocumentTitle,
  getTaskDocumentType,
  getTaskUploaderName,
  hasWorkflowTaskFilters,
  type WorkflowTaskFilters,
} from "@/lib/workflowTaskFilters";
import CustomListbox from "@/components/ui/CustomListbox";
import WorkflowActionPanel from "@/components/workflow/WorkflowActionPanel";

function formatPaymentRunAmount(value?: string | null) {
  const n = Number(value ?? 0);
  if (!Number.isFinite(n)) return value || "-";
  return n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function formatPaymentRunDate(value?: string | null) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString();
}

function PaymentRunTransactionReview({ task }: { task: WorkflowTask }) {
  const lines = task.payment_run_lines ?? [];
  const currencies = task.payment_run_currency_codes?.join(", ") || "-";
  if (!lines.length) return null;

  return (
    <div className="border-t border-[#E5E9EC] bg-[#FBFCFD] px-4 py-3">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="text-xs font-bold uppercase tracking-wider text-[#5E6870]">Transactions selected for payment</p>
          <p className="mt-0.5 text-xs text-[#5E6870]">
            {lines.length} line{lines.length !== 1 ? "s" : ""} · {currencies} · Total {formatPaymentRunAmount(task.payment_run_total)}
          </p>
        </div>
      </div>
      <div className="max-h-72 overflow-auto border border-[#D9DEE2] bg-white">
        <table className="w-full min-w-[980px] border-collapse text-xs">
          <thead className="sticky top-0 bg-[#F3F5F6]">
            <tr className="border-b border-[#D9DEE2]">
              {["Account", "Account name", "Journal", "Line", "Date", "Reference", "Description", "Cur", "Amount", "D/C", "Marker"].map((heading) => (
                <th key={heading} className="whitespace-nowrap border-r border-[#E5E9EC] px-2.5 py-2 text-left font-bold uppercase tracking-wider text-[#5E6870] last:border-r-0">
                  {heading}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {lines.map((line, index) => (
              <tr key={`${line.journal_number ?? "journal"}-${line.journal_line_number ?? index}-${index}`} className="border-b border-[#EDF0F2] last:border-b-0">
                <td className="border-r border-[#EDF0F2] px-2.5 py-2 font-mono font-semibold text-[#287EAD]">{line.account_code || "-"}</td>
                <td className="border-r border-[#EDF0F2] px-2.5 py-2 text-[#1F2933]">{line.account_description || "-"}</td>
                <td className="border-r border-[#EDF0F2] px-2.5 py-2 font-mono">{line.journal_number || "-"}</td>
                <td className="border-r border-[#EDF0F2] px-2.5 py-2 text-center">{line.journal_line_number || "-"}</td>
                <td className="border-r border-[#EDF0F2] px-2.5 py-2 whitespace-nowrap">{formatPaymentRunDate(line.transaction_date)}</td>
                <td className="border-r border-[#EDF0F2] px-2.5 py-2 font-mono">{line.transaction_reference || "-"}</td>
                <td className="max-w-[260px] truncate border-r border-[#EDF0F2] px-2.5 py-2" title={line.description || ""}>{line.description || "-"}</td>
                <td className="border-r border-[#EDF0F2] px-2.5 py-2 text-center">{line.currency_code || "-"}</td>
                <td className="border-r border-[#EDF0F2] px-2.5 py-2 text-right font-semibold tabular-nums">{formatPaymentRunAmount(line.transaction_amount)}</td>
                <td className="border-r border-[#EDF0F2] px-2.5 py-2 text-center">{line.debit_credit || "-"}</td>
                <td className="px-2.5 py-2 text-center font-semibold">{line.payment_marker || line.allocation_marker || "-"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function PaymentRunTaskModal({
  task,
  onClose,
}: {
  task: WorkflowTask;
  onClose: () => void;
}) {
  const currencies = task.payment_run_currency_codes?.join(", ") || "-";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-4">
      <div className="flex max-h-[90vh] w-full max-w-6xl flex-col border border-[#C8CDD2] bg-white shadow-2xl">
        <div className="flex items-start justify-between gap-4 border-b border-[#C8CDD2] bg-[#F3F5F6] px-5 py-4">
          <div className="min-w-0">
            <p className="text-xs font-bold uppercase tracking-wider text-[#5E6870]">Payment run approval</p>
            <h2 className="mt-1 truncate text-lg font-bold text-[#1F2933]">
              {task.document_title || `Payment Run ${task.payment_reference ?? ""}`}
            </h2>
            <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-[#5E6870]">
              <span>Reference: <span className="font-mono font-semibold text-[#1F2933]">{task.payment_reference || task.document_ref || "-"}</span></span>
              <span>Lines: <span className="font-semibold text-[#1F2933]">{task.payment_run_lines?.length ?? 0}</span></span>
              <span>Total: <span className="font-semibold text-[#1F2933]">{formatPaymentRunAmount(task.payment_run_total)}</span></span>
              <span>Currencies: <span className="font-semibold text-[#1F2933]">{currencies}</span></span>
              <span>Step: <span className="font-semibold text-[#1F2933]">{task.step.name}</span></span>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="flex h-8 w-8 shrink-0 items-center justify-center border border-[#C8CDD2] bg-white text-[#5E6870] hover:bg-[#EDEDED] hover:text-[#1F2933]"
            aria-label="Close payment run review"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto">
          <PaymentRunTransactionReview task={task} />
        </div>

        <div className="border-t border-[#C8CDD2]">
          <WorkflowActionPanel
            task={task}
            variant="bar"
            onCompleted={onClose}
          />
        </div>
      </div>
    </div>
  );
}

function notificationTaskId(link?: string | null) {
  if (!link) return "";
  try {
    const url = new URL(link, window.location.origin);
    return url.searchParams.get("task") || url.pathname.split("/").filter(Boolean).pop() || "";
  } catch {
    const query = link.split("?")[1] || "";
    return new URLSearchParams(query).get("task") || link.split("/").filter(Boolean).pop() || "";
  }
}

export default function WorkflowPage() {
  const [filters, setFilters] = useState<WorkflowTaskFilters>(DEFAULT_WORKFLOW_TASK_FILTERS);
  const [selectedPaymentRunTask, setSelectedPaymentRunTask] = useState<WorkflowTask | null>(null);
  const navigate = useNavigate();
  const location = useLocation();

  const { data: tasks, isLoading } = useQuery<WorkflowTask[]>({
    queryKey: ["workflow", "my-tasks"],
    queryFn: () => workflowAPI.myTasks().then((r) => r.data.results ?? r.data),
    refetchInterval: 30_000,
    // Global defaults disable refetchOnMount; always revalidate when opening My Tasks
    // so reassignments/delegations show without a full page reload.
    refetchOnMount: "always",
  });

  const queryClient = useQueryClient();
  const { data: notifications = [] } = useQuery<Notification[]>({
    queryKey: ["notifications"],
    queryFn: () => notificationsAPI.list().then((r) => normalizeListResponse<Notification>(r.data)),
    staleTime: 30_000,
  });

  const markReadMutation = useMutation({
    mutationFn: (id: string) => notificationsAPI.markRead(id),
    onMutate: async (id: string) => {
      await queryClient.cancelQueries({ queryKey: ["notifications"] });
      const previous = queryClient.getQueryData<Notification[]>(["notifications"]);
      if (previous) {
        queryClient.setQueryData(["notifications"], previous.map((n) => n.id === id ? { ...n, is_read: true } : n));
      }
      return { previous };
    },
    onError: (_err, _id, context) => {
      if (context?.previous) queryClient.setQueryData(["notifications"], context.previous);
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ["notifications"] });
    },
  });

  const TASK_NOTIFICATION_TYPES = new Set(["task_assigned", "task_sla_warning", "task_overdue"]);
  const taskAlertNotifications = (notifications ?? []).filter((n) => TASK_NOTIFICATION_TYPES.has(n.type));
  // Filter task alerts to only show for tasks that are still in the user's active task list
  // This prevents stale warnings for tasks that have already been actioned
  const activeTaskIds = new Set((tasks ?? []).map((t) => t.id));
  const activeDocumentIds = new Set((tasks ?? []).map((t) => getTaskDocumentId(t)).filter(Boolean));
  const visibleTaskAlerts = taskAlertNotifications
    .filter((n) => {
      if (n.is_read || !n.link) return false;
      const targetId = notificationTaskId(n.link);
      return activeTaskIds.has(targetId) || activeDocumentIds.has(targetId);
    });
  const taskAlertsByTask = new Map<string, Notification[]>();
  for (const notification of visibleTaskAlerts) {
    const targetId = notificationTaskId(notification.link);
    const task = (tasks ?? []).find((item) => item.id === targetId || getTaskDocumentId(item) === targetId);
    if (!task) continue;
    taskAlertsByTask.set(task.id, [...(taskAlertsByTask.get(task.id) ?? []), notification]);
  }

  const allTasks = tasks ?? [];
  const overdueCount = allTasks.filter((task) => task.due_at && new Date(task.due_at) < new Date()).length;
  const openTask = (task: WorkflowTask) => {
    if (task.target_type === "payment_run" || task.payment_run_id) {
      setSelectedPaymentRunTask(task);
      return;
    }
    const documentId = getTaskDocumentId(task);
    if (documentId) navigate(`/${documentId}`);
  };
  const filterOptions = useMemo(() => buildWorkflowTaskFilterOptions(allTasks), [allTasks]);
  const filteredTasks = useMemo(
    () => filterWorkflowTasks(allTasks, filters),
    [allTasks, filters],
  );
  const hasFilters = hasWorkflowTaskFilters(filters);

  useEffect(() => {
    const taskId = new URLSearchParams(location.search).get("task");
    if (!taskId || !tasks?.length) return;
    const task = tasks.find((item) => item.id === taskId);
    if (task && (task.target_type === "payment_run" || task.payment_run_id)) {
      setSelectedPaymentRunTask(task);
    }
  }, [location.search, tasks]);

  const updateFilter = <K extends keyof WorkflowTaskFilters>(
    key: K,
    value: WorkflowTaskFilters[K],
  ) => {
    setFilters((current) => ({ ...current, [key]: value }));
  };

  const clearFilters = () => setFilters(DEFAULT_WORKFLOW_TASK_FILTERS);
  const closePaymentRunTask = () => {
    setSelectedPaymentRunTask(null);
    if (new URLSearchParams(location.search).has("task")) {
      navigate("/approvals", { replace: true });
    }
  };

  return (
    <div className="flex h-full flex-col bg-[#EDEDED]">
      <header className="flex shrink-0 flex-wrap items-center justify-between gap-3 bg-[#287EAD] px-4 py-1.5 text-white">
        <div className="flex items-center gap-2.5">
          <div className="flex h-8 w-8 items-center justify-center border border-white/25 bg-white/10">
            <CheckCircle className="h-4 w-4" />
          </div>
          <div>
            <h1 className="text-lg font-semibold leading-tight">Approvals</h1>
            <p className="text-xs text-white/75">Review and action your assigned work.</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <div className="border border-white/25 bg-white/10 px-2.5 py-1 text-xs font-semibold">
            {allTasks.length} open task{allTasks.length !== 1 ? "s" : ""}
          </div>
          {overdueCount > 0 && (
            <div className="inline-flex items-center gap-1 border border-white/25 bg-white/10 px-2.5 py-1 text-xs font-semibold">
              <AlertTriangle className="h-3.5 w-3.5" /> {overdueCount} overdue
            </div>
          )}
        </div>
      </header>

      <div className="scrollbar-minimal min-h-0 flex-1 space-y-4 overflow-y-auto p-5">
        <div className="mx-auto w-full max-w-4xl space-y-4">
        {isLoading && (
          <div className="flex h-40 items-center justify-center border border-[#C8CDD2] bg-white">
            <Loader2 className="h-6 w-6 animate-spin text-[#287EAD]" />
          </div>
        )}

        {!isLoading && !tasks?.length && (
          <div className="border border-[#C8CDD2] bg-white p-12 text-center">
            <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center border border-[#E2E7EB] bg-[#F7F9FA]">
              <CheckCircle className="h-6 w-6 text-[#68737D]" />
            </div>
            <p className="font-semibold text-[#1F2933]">All caught up</p>
            <p className="mt-1 text-sm text-[#5E6870]">No pending approval tasks.</p>
          </div>
        )}

        {!isLoading && allTasks.length > 0 && (
        <section className="border border-[#D6DDE2] bg-white p-4">
          <div className="mb-4 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <p className="text-sm font-semibold text-[#1F2933]">Filter approval queue</p>
              <p className="text-xs text-[#5E6870]">
                {hasFilters
                  ? `${filteredTasks.length} of ${allTasks.length} tasks match.`
                  : "Narrow tasks by source, type, format, and urgency."}
              </p>
            </div>
            {hasFilters && (
              <button
                type="button"
                onClick={clearFilters}
                className="inline-flex w-fit items-center gap-2 border border-[#C8CDD2] bg-white px-3 py-2 text-xs font-semibold text-[#1F2933] transition-colors hover:bg-[#F5F7F8]"
              >
                <X className="h-3.5 w-3.5" />
                Clear
              </button>
            )}
          </div>

          <div className="flex flex-wrap gap-2">
            <div className="relative w-64">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[#5E6870]" />
              <input
                type="search"
                value={filters.search}
                onChange={(e) => updateFilter("search", e.target.value)}
                placeholder="Search title, reference, uploader..."
                className="h-10 w-full border border-[#C8CDD2] bg-white pl-9 pr-3 text-sm outline-none focus:border-[#287EAD]"
              />
            </div>
            <CustomListbox
              value={filters.documentType}
              onChange={(v) => updateFilter("documentType", v)}
              options={[
                { value: "", label: "All document types" },
                ...filterOptions.documentTypes.map((option) => ({ value: option.value, label: `${option.label} (${option.count})` })),
              ]}
              buttonClassName="h-10 border border-[#C8CDD2] bg-white px-3 text-sm text-left outline-none focus:border-[#287EAD]"
              ariaLabel="Document type filter"
            />
            <CustomListbox
              value={filters.department}
              onChange={(v) => updateFilter("department", v)}
              options={[
                { value: "", label: "All departments" },
                ...filterOptions.departments.map((option) => ({ value: option.value, label: `${option.label} (${option.count})` })),
              ]}
              buttonClassName="h-10 border border-[#C8CDD2] bg-white px-3 text-sm text-left outline-none focus:border-[#287EAD]"
              ariaLabel="Department filter"
            />
            <CustomListbox
              value={filters.fileFormat}
              onChange={(v) => updateFilter("fileFormat", v)}
              options={[
                { value: "", label: "All formats" },
                ...filterOptions.fileFormats.map((option) => ({ value: option.value, label: `${option.label} (${option.count})` })),
              ]}
              buttonClassName="h-10 border border-[#C8CDD2] bg-white px-3 text-sm text-left outline-none focus:border-[#287EAD]"
              ariaLabel="File format filter"
            />
            <CustomListbox
              value={filters.urgency ?? ""}
              onChange={(v) => updateFilter("urgency", v as WorkflowTaskFilters["urgency"])}
              options={[
                { value: "", label: "Any urgency" },
                { value: "overdue", label: "Overdue" },
                { value: "due_soon", label: "Due in 24h" },
                { value: "held", label: "On hold" },
              ]}
              buttonClassName="h-10 border border-[#C8CDD2] bg-white px-3 text-sm text-left outline-none focus:border-[#287EAD]"
              ariaLabel="Urgency filter"
            />
          </div>

          <div className="mt-3 inline-flex items-center gap-1.5 text-xs text-[#5E6870]">
            <Filter className="h-3.5 w-3.5" />
            <span>{filteredTasks.length} visible task{filteredTasks.length !== 1 ? "s" : ""}</span>
          </div>
        </section>
      )}

      <div className="space-y-2">
        {!isLoading && allTasks.length > 0 && filteredTasks.length === 0 && (
          <div className="border border-[#C8CDD2] bg-white p-8 text-center">
            <p className="font-semibold text-[#1F2933]">No matching tasks</p>
            <p className="mt-1 text-sm text-[#5E6870]">Adjust or clear filters to see more approvals.</p>
          </div>
        )}

        {filteredTasks.map((task) => {
          const documentId = getTaskDocumentId(task);
          const documentTitle = getTaskDocumentTitle(task);
          const documentRef = getTaskDocumentReference(task);
          const documentType = getTaskDocumentType(task);
          const documentFormat = getTaskDocumentFormat(task);
          const department = getTaskDepartment(task);
          const uploaderName = getTaskUploaderName(task);
          const isPaymentRun = task.target_type === "payment_run" || Boolean(task.payment_run_id);

          const isOverdue = task.due_at && new Date(task.due_at) < new Date();

          return (
            <div key={task.id} className="border border-[#D6DDE2] bg-white">
              <button
                type="button"
                onClick={() => {
                  (taskAlertsByTask.get(task.id) ?? [])
                    .filter((notification) => !notification.is_read)
                    .forEach((notification) => markReadMutation.mutate(notification.id));
                  if (documentId || isPaymentRun) openTask(task);
                }}
                className="flex w-full items-start gap-4 p-4 text-left transition-colors hover:bg-[#F6FAFC]"
              >
                <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center border border-[#E2E7EB] bg-[#F7F9FA]">
                  <Clock className="h-4 w-4 text-[#68737D]" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="truncate font-semibold text-[#1F2933] hover:text-[#287EAD]">
                        {documentTitle}
                      </h3>
                      {(taskAlertsByTask.get(task.id) ?? []).map((notification) => (
                        <span
                          key={notification.id}
                          className="shrink-0 border border-[#E2E7EB] bg-[#F7F9FA] px-2 py-0.5 text-[10px] font-semibold text-[#5E6870]"
                        >
                          {notification.type === "task_overdue" ? "Overdue alert" : notification.type === "task_sla_warning" ? "Due soon alert" : "New task alert"}
                        </span>
                      ))}
                    </div>
                    <p className="mt-0.5 font-mono text-xs text-[#5E6870]">
                      {documentRef}
                    </p>
                  </div>
                  <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-[#5E6870]">
                    <span className="border border-[#E2E7EB] bg-[#F7F9FA] px-2 py-1">{documentType}</span>
                    {!isPaymentRun && <span className="border border-[#E2E7EB] bg-[#F7F9FA] px-2 py-1">{documentFormat}</span>}
                    <span className="border border-[#E2E7EB] bg-[#F7F9FA] px-2 py-1">{department}</span>
                    <span className="border border-[#E2E7EB] bg-[#F7F9FA] px-2 py-1 font-semibold text-[#1F2933]">{task.step.name}</span>
                    {task.status === "awaiting_posting" && (
                      <span className="border border-amber-200 bg-amber-50 px-2 py-1 font-semibold text-amber-800">
                        Awaiting SunSystems posting
                      </span>
                    )}
                    {uploaderName && (
                      <span>{isPaymentRun ? "Submitted by" : "Uploader"}: <span className="font-semibold text-[#1F2933]">{uploaderName}</span></span>
                    )}
                    {task.is_delegated && task.delegated_from && (
                      <span className="rounded bg-[#DCEAF2] px-1.5 py-0.5 font-semibold text-[#287EAD]">
                        Delegated from {task.delegated_from.full_name || task.delegated_from.email}
                      </span>
                    )}
                    {task.due_at && (
                      <span className={`inline-flex items-center gap-1 border px-2 py-1 font-semibold ${isOverdue ? "border-rose-200 bg-rose-50 text-rose-700" : "border-[#E2E7EB] bg-[#F7F9FA] text-[#5E6870]"}`}>
                        Due {formatDistanceToNow(new Date(task.due_at), { addSuffix: true })}
                      </span>
                    )}
                  </div>
                </div>
              </button>
            </div>
          );
        })}
      </div>
      </div>
      </div>
      {selectedPaymentRunTask && (
        <PaymentRunTaskModal
          task={selectedPaymentRunTask}
          onClose={closePaymentRunTask}
        />
      )}
    </div>
  );
}
