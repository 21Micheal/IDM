import { useQuery } from "@tanstack/react-query";
import { workflowAPI } from "@/services/api";
import { useNavigate } from "react-router-dom";
import { CheckCircle, Clock, Filter, GitBranch, Loader2, Search, X } from "lucide-react";
import { formatDistanceToNow } from "date-fns";
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
  hasWorkflowTaskFilters,
  type WorkflowTaskFilters,
} from "@/lib/workflowTaskFilters";

export default function WorkflowPage() {
  const [filters, setFilters] = useState<WorkflowTaskFilters>(DEFAULT_WORKFLOW_TASK_FILTERS);
  const navigate = useNavigate();

  const { data: tasks, isLoading } = useQuery<WorkflowTask[]>({
    queryKey: ["workflow", "my-tasks"],
    queryFn: () => workflowAPI.myTasks().then((r) => r.data.results ?? r.data),
    refetchInterval: 30_000,
  });

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
    <div className="-m-6 min-h-[calc(100vh-3.5rem)] bg-[#EDEDED]">
      <div className="border-b border-[#206D99] bg-[#287EAD] px-6 py-4 text-white">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center border border-white/25 bg-white/10">
              <GitBranch className="h-5 w-5 text-white" />
            </div>
            <div>
              <h1 className="text-xl font-semibold">Workflow tasks</h1>
              <p className="mt-0.5 text-sm text-white/75">Documents waiting for your review or approval.</p>
            </div>
          </div>
          <div className="border border-white/25 bg-white/10 px-3 py-2 text-sm font-semibold">
            {allTasks.length} open
          </div>
        </div>
      </div>

      <div className="space-y-4 p-4 pr-8">
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

          <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-6">
            <div className="relative xl:col-span-2">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[#5E6870]" />
              <input
                type="search"
                value={filters.search}
                onChange={(e) => updateFilter("search", e.target.value)}
                placeholder="Search title, reference, uploader..."
                className="h-10 w-full border border-[#C8CDD2] bg-white pl-9 pr-3 text-sm outline-none focus:border-[#287EAD]"
              />
            </div>
            <select
              value={filters.documentType}
              onChange={(e) => updateFilter("documentType", e.target.value)}
              className="h-10 border border-[#C8CDD2] bg-white px-3 text-sm outline-none focus:border-[#287EAD]"
            >
              <option value="">All document types</option>
              {filterOptions.documentTypes.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label} ({option.count})
                </option>
              ))}
            </select>
            <select
              value={filters.department}
              onChange={(e) => updateFilter("department", e.target.value)}
              className="h-10 border border-[#C8CDD2] bg-white px-3 text-sm outline-none focus:border-[#287EAD]"
            >
              <option value="">All departments</option>
              {filterOptions.departments.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label} ({option.count})
                </option>
              ))}
            </select>
            <select
              value={filters.fileFormat}
              onChange={(e) => updateFilter("fileFormat", e.target.value)}
              className="h-10 border border-[#C8CDD2] bg-white px-3 text-sm outline-none focus:border-[#287EAD]"
            >
              <option value="">All formats</option>
              {filterOptions.fileFormats.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label} ({option.count})
                </option>
              ))}
            </select>
            <select
              value={filters.urgency}
              onChange={(e) => updateFilter("urgency", e.target.value as WorkflowTaskFilters["urgency"])}
              className="h-10 border border-[#C8CDD2] bg-white px-3 text-sm outline-none focus:border-[#287EAD]"
            >
              <option value="">Any urgency</option>
              <option value="overdue">Overdue</option>
              <option value="due_soon">Due in 24h</option>
              <option value="held">On hold</option>
            </select>
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

          const isOverdue = task.due_at && new Date(task.due_at) < new Date();

          return (
            <button
              key={task.id}
              type="button"
              onClick={() => {
                if (documentId) navigate(`/documents/${documentId}`);
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
