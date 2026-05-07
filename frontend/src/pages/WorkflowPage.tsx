import { useQuery } from "@tanstack/react-query";
import { workflowAPI } from "@/services/api";
import { Link } from "react-router-dom";
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
    <div className="max-w-6xl mx-auto py-10 px-6 space-y-8">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div className="flex items-center gap-3 mb-2">
          <div className="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center">
            <GitBranch className="w-5 h-5 text-primary" />
          </div>
          <div>
            <h1 className="text-2xl font-bold text-foreground tracking-tight">Workflow tasks</h1>
            <p className="text-muted-foreground text-sm">Documents waiting for your approval action.</p>
          </div>
        </div>
        <div className="inline-flex w-fit items-center gap-2 rounded-full bg-teal/10 px-3 py-1 text-xs font-semibold text-teal">
          {allTasks.length} open
        </div>
      </div>

      {isLoading && (
        <div className="flex items-center justify-center h-40">
          <Loader2 className="w-6 h-6 text-accent animate-spin" />
        </div>
      )}

      {!isLoading && !tasks?.length && (
        <div className="card p-12 text-center">
          <div className="w-14 h-14 rounded-full bg-teal/15 flex items-center justify-center mx-auto mb-4">
            <CheckCircle className="w-7 h-7 text-teal" />
          </div>
          <p className="font-semibold text-foreground">All caught up!</p>
          <p className="text-sm text-muted-foreground mt-1">No pending approval tasks.</p>
        </div>
      )}

      {!isLoading && allTasks.length > 0 && (
        <section className="rounded-xl border border-border bg-card p-4" style={{ boxShadow: "var(--shadow-card)" }}>
          <div className="mb-4 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <p className="text-sm font-semibold text-foreground">Filter approval queue</p>
              <p className="text-xs text-muted-foreground">
                {hasFilters
                  ? `${filteredTasks.length} of ${allTasks.length} tasks match.`
                  : "Narrow tasks by source, type, format, and urgency."}
              </p>
            </div>
            {hasFilters && (
              <button
                type="button"
                onClick={clearFilters}
                className="inline-flex w-fit items-center gap-2 rounded-lg border border-border bg-card px-3 py-2 text-xs font-semibold text-foreground transition-colors hover:bg-muted"
              >
                <X className="h-3.5 w-3.5" />
                Clear
              </button>
            )}
          </div>

          <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-6">
            <div className="relative xl:col-span-2">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <input
                type="search"
                value={filters.search}
                onChange={(e) => updateFilter("search", e.target.value)}
                placeholder="Search title, reference, uploader..."
                className="input h-10 w-full pl-9 text-sm"
              />
            </div>
            <select
              value={filters.documentType}
              onChange={(e) => updateFilter("documentType", e.target.value)}
              className="input h-10 text-sm"
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
              className="input h-10 text-sm"
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
              className="input h-10 text-sm"
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
              className="input h-10 text-sm"
            >
              <option value="">Any urgency</option>
              <option value="overdue">Overdue</option>
              <option value="due_soon">Due in 24h</option>
              <option value="held">On hold</option>
            </select>
          </div>

          <div className="mt-3 inline-flex items-center gap-1.5 text-xs text-muted-foreground">
            <Filter className="h-3.5 w-3.5" />
            <span>{filteredTasks.length} visible task{filteredTasks.length !== 1 ? "s" : ""}</span>
          </div>
        </section>
      )}

      <div className="space-y-3">
        {!isLoading && allTasks.length > 0 && filteredTasks.length === 0 && (
          <div className="card p-8 text-center">
            <p className="font-semibold text-foreground">No matching tasks</p>
            <p className="mt-1 text-sm text-muted-foreground">Adjust or clear filters to see more approvals.</p>
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
            <Link
              key={task.id}
              to={documentId ? `/documents/${documentId}` : "/workflow"}
              className="card p-5 flex items-start gap-4 hover:-translate-y-0.5 transition-transform hover:shadow-md"
            >
              <div className="w-10 h-10 rounded-xl bg-accent/15 flex items-center justify-center flex-shrink-0">
                <Clock className="w-5 h-5 text-accent" />
              </div>
              <div className="flex-1 min-w-0">
                <div className="min-w-0">
                  <h3 className="font-medium text-foreground hover:text-accent truncate">
                    {documentTitle}
                  </h3>
                  <p className="text-xs text-muted-foreground font-mono mt-0.5">
                    {documentRef}
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-3 mt-2 text-xs text-muted-foreground">
                  <span>Type: <span className="font-medium text-foreground">{documentType}</span></span>
                  <span>Format: <span className="font-medium text-foreground">{documentFormat}</span></span>
                  <span>Department: <span className="font-medium text-foreground">{department}</span></span>
                  <span>Step: <span className="font-medium text-foreground">{task.step.name}</span></span>
                  {uploaderName && (
                    <span>Uploader: <span className="font-medium text-foreground">{uploaderName}</span></span>
                  )}
                  {task.due_at && (
                    <span
                      className={
                        isOverdue
                          ? "text-destructive font-medium"
                          : ""
                      }
                    >
                      Due {formatDistanceToNow(new Date(task.due_at), { addSuffix: true })}
                    </span>
                  )}
                </div>
              </div>
            </Link>
          );
        })}
      </div>
    </div>
  );
}
