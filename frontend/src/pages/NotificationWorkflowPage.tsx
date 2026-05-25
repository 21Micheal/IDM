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
    <div className="-m-6 flex min-h-[calc(100vh-3.5rem)] flex-col bg-[#EDEDED]">
      <div className="border-b border-[#206D99] bg-[#287EAD] px-6 py-4 text-white">
        <div className="mx-auto flex w-full max-w-none flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex min-w-0 items-start gap-3">
            <button
              type="button"
              onClick={() => navigate(-1)}
              className="mt-0.5 inline-flex h-9 w-9 shrink-0 items-center justify-center border border-white/25 bg-white/10 text-white transition-colors hover:bg-white/15"
              aria-label="Go back"
            >
              <ArrowLeft className="h-4 w-4" />
            </button>
            <div className="min-w-0">
              <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-white/70">
                <GitBranch className="h-3.5 w-3.5 text-white/80" />
                Workflow status
              </div>
              <h1 className="mt-1 truncate text-xl font-semibold text-white">
                {workflowData?.documentTitle || notificationContext?.title || "Workflow Progress"}
              </h1>
              {notificationContext?.message && (
                <p className="mt-1 max-w-3xl text-sm text-white/75">
                  {notificationContext.message}
                </p>
              )}
            </div>
          </div>

          {documentId && (
            <button
              type="button"
              onClick={() => navigate(viewDocumentLink)}
              className="inline-flex w-fit items-center gap-2 border border-white/25 bg-white px-4 py-2 text-sm font-semibold text-[#1F2933] transition-colors hover:bg-[#EEF6FB]"
            >
              <ExternalLink className="h-4 w-4" />
              View Document
            </button>
          )}
        </div>
      </div>

      <main className="mx-auto flex w-full max-w-none flex-1 flex-col p-4 pr-8">
        {!documentId ? (
          <div className="flex min-h-[20rem] items-center justify-center border border-dashed border-[#C8CDD2] bg-[#F5F7F8] text-sm text-[#5E6870]">
            No document was attached to this workflow notification.
          </div>
        ) : isLoading ? (
          <div className="flex min-h-[20rem] items-center justify-center gap-2 border border-dashed border-[#C8CDD2] bg-[#F5F7F8] text-sm text-[#5E6870]">
            <Loader2 className="h-4 w-4 animate-spin text-[#287EAD]" />
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
