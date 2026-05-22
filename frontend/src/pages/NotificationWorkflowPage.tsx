import { useMemo } from "react";
import { useLocation, useNavigate, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, ExternalLink, GitBranch, Loader2 } from "lucide-react";
import { WorkflowVisualizer } from "@/components/notifications/workflow-visualizer";
import {
  loadWorkflowData,
  type WorkflowNotificationContext,
} from "@/components/notifications/workflow-data";
import { notificationsAPI, normalizeListResponse } from "@/services/api";
import type { Notification } from "@/types";
import {
  getDocumentIdFromLink,
  getNotificationConfig,
  inferNotificationPriority,
} from "@/components/notifications/notifications-list";

type LocationState = {
  notification?: WorkflowNotificationContext;
};

export default function NotificationWorkflowPage() {
  const { documentId = "" } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const state = location.state as LocationState | null;

  const { data: notifications = [] } = useQuery<Notification[]>({
    queryKey: ["notifications"],
    queryFn: () => notificationsAPI.list().then((response) => normalizeListResponse<Notification>(response.data)),
    staleTime: 30_000,
  });

  const notificationContext = useMemo(() => {
    if (state?.notification) return state.notification;

    const notification = notifications.find((item) => getDocumentIdFromLink(item.link) === documentId);
    if (!notification) return null;

    const config = getNotificationConfig(notification.type, notification.message);
    return {
      id: notification.id,
      title: config.label,
      message: notification.message,
      type: notification.type,
      createdAt: notification.created_at,
      priority: inferNotificationPriority(notification),
      viewDocumentLink: notification.link,
      documentId,
    } satisfies WorkflowNotificationContext;
  }, [documentId, notifications, state?.notification]);

  const { data: workflowData, isLoading } = useQuery({
    queryKey: ["notification-workflow", documentId],
    queryFn: () => loadWorkflowData(documentId),
    enabled: !!documentId,
    staleTime: 30_000,
  });

  const viewDocumentLink = notificationContext?.viewDocumentLink || `/documents/${documentId}`;

  return (
    <div className="flex min-h-[calc(100vh-4rem)] flex-col bg-slate-100/70">
      <div className="border-b border-slate-200 bg-white/95 px-4 py-4 sm:px-6">
        <div className="mx-auto flex w-full max-w-none flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex min-w-0 items-start gap-3">
            <button
              type="button"
              onClick={() => navigate(-1)}
              className="mt-0.5 inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-border text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              aria-label="Go back"
            >
              <ArrowLeft className="h-4 w-4" />
            </button>
            <div className="min-w-0">
              <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                <GitBranch className="h-3.5 w-3.5 text-slate-600" />
                Workflow status
              </div>
              <h1 className="mt-1 truncate text-xl font-semibold text-foreground">
                {workflowData?.documentTitle || notificationContext?.title || "Workflow Progress"}
              </h1>
              {notificationContext?.message && (
                <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
                  {notificationContext.message}
                </p>
              )}
            </div>
          </div>

          {documentId && (
            <button
              type="button"
              onClick={() => navigate(viewDocumentLink)}
              className="inline-flex w-fit items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
            >
              <ExternalLink className="h-4 w-4" />
              View Document
            </button>
          )}
        </div>
      </div>

      <main className="mx-auto flex w-full max-w-none flex-1 flex-col px-4 py-5 sm:px-6">
        {!documentId ? (
          <div className="flex min-h-[20rem] items-center justify-center rounded-lg border border-dashed border-border bg-muted/20 text-sm text-muted-foreground">
            No document was attached to this workflow notification.
          </div>
        ) : isLoading ? (
          <div className="flex min-h-[20rem] items-center justify-center gap-2 rounded-lg border border-dashed border-border bg-muted/20 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading workflow status...
          </div>
        ) : (
          <WorkflowVisualizer
            steps={workflowData?.steps ?? []}
            currentStep={workflowData?.currentStep ?? -1}
            documentTitle={workflowData?.documentTitle}
            submittedBy={workflowData?.submittedBy}
            submittedDate={workflowData?.submittedDate}
            fullPage
          />
        )}
      </main>
    </div>
  );
}
