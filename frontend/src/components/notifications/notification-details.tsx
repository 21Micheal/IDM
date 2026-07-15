import { useQuery } from "@tanstack/react-query";
import { Calendar, ChevronLeft, ExternalLink, X } from "lucide-react";
import clsx from "clsx";
import { WorkflowVisualizer } from "./workflow-visualizer";
import { loadWorkflowData } from "./workflow-data";

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
    staleTime: 10_000,
    // Live-update the chart while the workflow is running; idle once it ends.
    refetchInterval: (query) => (query.state.data?.isActive ? 15_000 : false),
    refetchOnWindowFocus: true,
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
