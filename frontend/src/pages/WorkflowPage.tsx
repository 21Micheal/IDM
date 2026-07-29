import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { workflowAPI, notificationsAPI, normalizeListResponse } from "@/services/api";
import { useNavigate } from "react-router-dom";
import { CheckCircle, Clock, Filter, GitBranch, Loader2, Search, X } from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import type { Notification } from "@/types";
import { useMemo, useState } from "react";
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
  getTaskIsForm,
  hasWorkflowTaskFilters,
  type WorkflowTaskFilters,
} from "@/lib/workflowTaskFilters";
import { WorkspaceCommandBar } from "@/components/shared/WorkspaceCommandBar";
import CustomListbox from "@/components/ui/CustomListbox";

export default function WorkflowPage() {
  const [filters, setFilters] = useState<WorkflowTaskFilters>(DEFAULT_WORKFLOW_TASK_FILTERS);
  const navigate = useNavigate();

  const { data: tasks, isLoading } = useQuery<WorkflowTask[]>({
    queryKey: ["workflow", "my-tasks"],
    queryFn: () => workflowAPI.myTasks().then((r) => r.data.results ?? r.data),
    refetchInterval: 30_000,
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
  const visibleTaskAlerts = taskAlertNotifications
    .filter((n) => !n.is_read && n.link && activeTaskIds.has(n.link.split("/").pop() || ""))
    .slice(0, 5);

  const allTasks = tasks ?? [];
  const filterOptions = useMemo(() => buildWorkflowTaskFilterOptions(allTasks), [allTasks]);
  const filteredTasks = useMemo(
    () => filterWorkflowTasks(allTasks, filters),
    [allTasks, filters],
  );
  const hasFilters = hasWorkflowTaskFilters(filters);

  const updateFilter = <K extends keyof WorkflowTaskFilters>(
    key: K,
    value: WorkflowTaskFilters[K],
  ) => {
    setFilters((current) => ({ ...current, [key]: value }));
  };

  const clearFilters = () => setFilters(DEFAULT_WORKFLOW_TASK_FILTERS);

  return (
    <div className="flex h-full flex-col bg-[#EDEDED]">
      <WorkspaceCommandBar
        actions={
          <div className="border border-white/25 bg-white/10 px-3 py-2 text-sm font-semibold">
            {allTasks.length} open
          </div>
        }
      >
        <div className="flex h-10 w-10 items-center justify-center border border-white/25 bg-white/10">
          <GitBranch className="h-5 w-5 text-white" />
        </div>
        <div>
          <h1 className="text-xl font-semibold">Workflow tasks</h1>
          <p className="mt-0.5 text-sm text-white/75">Documents waiting for your review or approval.</p>
        </div>
      </WorkspaceCommandBar>

      <div className="scrollbar-minimal min-h-0 flex-1 space-y-4 overflow-y-auto p-5 pr-0">
        {isLoading && (
          <div className="flex h-40 items-center justify-center border border-[#C8CDD2] bg-white">
            <Loader2 className="h-6 w-6 animate-spin text-[#287EAD]" />
          </div>
        )}

        {!isLoading && !tasks?.length && (
          <div className="border border-[#C8CDD2] bg-white p-12 text-center">
            <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center border border-emerald-200 bg-emerald-50">
              <CheckCircle className="h-7 w-7 text-emerald-700" />
            </div>
            <p className="font-semibold text-[#1F2933]">All caught up</p>
            <p className="mt-1 text-sm text-[#5E6870]">No pending approval tasks.</p>
          </div>
        )}

        {!isLoading && allTasks.length > 0 && (
        <section className="border border-[#C8CDD2] bg-white p-4">
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
        {visibleTaskAlerts.length > 0 && (
          <section className="border border-amber-200 bg-amber-50 p-4">
            <div className="mb-2 flex items-center justify-between">
              <p className="text-sm font-bold text-amber-900">Task alerts</p>
              <p className="text-xs text-amber-900">{taskAlertNotifications.length} total</p>
            </div>
            <div className="space-y-2">
              {visibleTaskAlerts.map((notification) => (
                <button
                  key={notification.id}
                  type="button"
                  onClick={() => {
                    if (!notification.is_read) markReadMutation.mutate(notification.id);
                    navigate(notification.link || "/workflow");
                  }}
                  className="block w-full border border-amber-200 bg-amber-50 px-3 py-2 text-left hover:bg-amber-100"
                >
                  <p className="line-clamp-2 text-sm font-bold text-amber-900">{notification.message}</p>
                  <p className="mt-1 text-xs text-amber-800">{new Date(notification.created_at).toLocaleString()}</p>
                </button>
              ))}
            </div>
          </section>
        )}
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
          const isForm = getTaskIsForm(task);

          const isOverdue = task.due_at && new Date(task.due_at) < new Date();

          return (
            <button
              key={task.id}
              type="button"
              onClick={() => {
                if (documentId) {
                  navigate(isForm ? `/forms/${documentId}` : `/documents/${documentId}`);
                }
              }}
              className="flex w-full items-start gap-4 border border-[#C8CDD2] bg-white p-4 text-left transition-colors hover:bg-[#F5F7F8]"
            >
              <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center border border-[#C8CDD2] bg-[#EEF6FB]">
                <Clock className="h-5 w-5 text-[#287EAD]" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="min-w-0">
                  <h3 className="truncate font-semibold text-[#1F2933] hover:text-[#287EAD]">
                    {documentTitle}
                  </h3>
                  <p className="mt-0.5 font-mono text-xs text-[#5E6870]">
                    {documentRef}
                  </p>
                </div>
                <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-[#5E6870]">
                  <span>Type: <span className="font-semibold text-[#1F2933]">{documentType}</span></span>
                  <span>Format: <span className="font-semibold text-[#1F2933]">{documentFormat}</span></span>
                  <span>Department: <span className="font-semibold text-[#1F2933]">{department}</span></span>
                  <span>Step: <span className="font-semibold text-[#1F2933]">{task.step.name}</span></span>
                  {uploaderName && (
                    <span>Uploader: <span className="font-semibold text-[#1F2933]">{uploaderName}</span></span>
                  )}
                  {task.is_delegated && task.delegated_from && (
                    <span className="rounded bg-[#DCEAF2] px-1.5 py-0.5 font-semibold text-[#287EAD]">
                      Delegated from {task.delegated_from.full_name || task.delegated_from.email}
                    </span>
                  )}
                  {task.due_at && (
                    <span
                      className={
                        isOverdue
                          ? "font-semibold text-red-700"
                          : ""
                      }
                    >
                      Due {formatDistanceToNow(new Date(task.due_at), { addSuffix: true })}
                    </span>
                  )}
                </div>
              </div>
            </button>
          );
        })}
      </div>
      </div>
    </div>
  );
}
