import { useMemo } from "react";
import {
  AlertTriangle,
  Bell,
  CheckCheck,
  CheckCircle,
  ChevronRight,
  ClipboardCheck,
  Clock,
  Info,
  Loader2,
  PauseCircle,
  PlayCircle,
  RotateCcw,
  Share2,
  XCircle,
} from "lucide-react";
import clsx from "clsx";
import type { Notification } from "@/types";
import type { WorkflowNotificationContext } from "./workflow-data";

type Priority = "high" | "medium" | "low";

interface NotificationListProps {
  notifications: Notification[];
  isLoading?: boolean;
  onMarkRead?: (id: string) => void;
  onOpenLink?: (link: string) => void;
  onOpenWorkflow?: (detail: WorkflowNotificationContext) => void;
}

export function getNotificationConfig(type: string, message = "") {
  const normalized = message.toLowerCase();

  const invoiceApproved = normalized.includes("invoice") && normalized.includes("approved");
  const invoiceApproval = normalized.includes("invoice") && normalized.includes("approval") && !invoiceApproved;
  const documentApproval = normalized.includes("approval") && !normalized.includes("invoice");

  if (invoiceApproved) {
    return {
      icon: CheckCircle,
      color: "text-emerald-700 bg-emerald-50 border-emerald-200",
      label: "Invoice Approved",
      category: "Approved Invoice",
    };
  }

  if (invoiceApproval) {
    return {
      icon: ClipboardCheck,
      color: "text-sky-700 bg-sky-50 border-sky-200",
      label: "Invoice Approval Needed",
      category: "Invoice Approval",
    };
  }

  if (documentApproval) {
    return {
      icon: ClipboardCheck,
      color: "text-primary bg-primary/10 border-primary/20",
      label: "Approval Request",
      category: "Document Approval",
    };
  }

  switch (type) {
    case "document_shared":
      return {
        icon: Share2,
        color: "text-sky-700 bg-sky-50 border-sky-200",
        label: "Shared Document",
        category: "Shared with You",
      };
    case "task_assigned":
      return {
        icon: ClipboardCheck,
        color: "text-primary bg-primary/10 border-primary/20",
        label: "Approval Request",
        category: "Requires Approval",
      };
    case "task_sla_warning":
      return {
        icon: Clock,
        color: "text-amber-700 bg-amber-50 border-amber-200",
        label: "SLA Approaching",
        category: "Task Alert",
      };
    case "workflow_complete":
      return {
        icon: CheckCircle,
        color: "text-emerald-700 bg-emerald-50 border-emerald-200",
        label: "Workflow Complete",
        category: "Approved",
      };
    case "document_returned":
      return {
        icon: RotateCcw,
        color: "text-amber-700 bg-amber-50 border-amber-200",
        label: "Returned for Review",
        category: "Returned Document",
      };
    case "document_held":
      return {
        icon: PauseCircle,
        color: "text-orange-700 bg-orange-50 border-orange-200",
        label: "Document on Hold",
        category: "Held",
      };
    case "hold_released":
      return {
        icon: PlayCircle,
        color: "text-teal bg-teal/10 border-teal/20",
        label: "Hold Released",
        category: "Hold Released",
      };
    case "hold_ending":
      return {
        icon: Clock,
        color: "text-amber-700 bg-amber-50 border-amber-200",
        label: "Hold Ending Soon",
        category: "Hold Alert",
      };
    case "hold_expired":
      return {
        icon: Clock,
        color: "text-purple-700 bg-purple-50 border-purple-200",
        label: "Hold Expired",
        category: "Hold Expired",
      };
    case "task_overdue":
      return {
        icon: AlertTriangle,
        color: "text-destructive bg-destructive/10 border-destructive/20",
        label: "Overdue",
        category: "Urgent",
      };
    case "workflow_action":
      return {
        icon: CheckCheck,
        color: "text-muted-foreground bg-muted border-border",
        label: "Workflow Update",
        category: "Workflow",
      };
    default:
      if (normalized.includes("overdue") || normalized.includes("urgent")) {
        return {
          icon: AlertTriangle,
          color: "text-destructive bg-destructive/10 border-destructive/20",
          label: "Urgent",
          category: "Urgent",
        };
      }
      if (normalized.includes("returned") || normalized.includes("rejected") || normalized.includes("hold")) {
        return {
          icon: XCircle,
          color: "text-amber-700 bg-amber-50 border-amber-200",
          label: "Attention",
          category: "Attention",
        };
      }
      return {
        icon: Info,
        color: "text-muted-foreground bg-muted border-border",
        label: "Info",
        category: "General",
      };
  }
}

export function inferNotificationPriority(notification: Notification): Priority {
  const text = `${notification.type} ${notification.message}`.toLowerCase();
  if (text.includes("overdue") || text.includes("urgent") || text.includes("expired")) return "high";
  if (text.includes("sla") || text.includes("deadline") || text.includes("due by")) return "medium";
  if (text.includes("assigned") || text.includes("returned") || text.includes("held")) return "medium";
  return "low";
}

function shouldOpenWorkflow(notification: Notification): boolean {
  return notification.type !== "document_shared";
}

export function NotificationList({
  notifications,
  isLoading = false,
  onMarkRead,
  onOpenLink,
  onOpenWorkflow,
}: NotificationListProps) {
  const sortedNotifications = useMemo(
    () =>
      [...notifications].sort((a, b) => {
        if (a.is_read !== b.is_read) return a.is_read ? 1 : -1;
        return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
      }),
    [notifications],
  );

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="h-8 w-8 animate-spin text-[#287EAD]" />
      </div>
    );
  }

  if (sortedNotifications.length === 0) {
    return (
      <div className="border border-dashed border-[#C8CDD2] bg-[#F5F7F8] py-16 text-center">
        <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center border border-[#C8CDD2] bg-white">
          <Bell className="h-6 w-6 text-[#5E6870]" />
        </div>
        <h3 className="text-sm font-semibold text-[#1F2933]">No notifications</h3>
        <p className="mt-1 text-xs text-[#5E6870]">You are all caught up with your updates.</p>
      </div>
    );
  }

  const openNotification = (notification: Notification) => {
    const config = getNotificationConfig(notification.type, notification.message);
    const priority = inferNotificationPriority(notification);
    const detail: WorkflowNotificationContext = {
      id: notification.id,
      title: config.label,
      message: notification.message,
      type: notification.type,
      createdAt: notification.created_at,
      priority,
      viewDocumentLink: notification.link,
      documentId: getDocumentIdFromLink(notification.link),
    };
    if (!notification.is_read) onMarkRead?.(notification.id);

    if (detail.documentId && shouldOpenWorkflow(notification)) {
      onOpenWorkflow?.(detail);
      return;
    }

    if (notification.link) {
      onOpenLink?.(notification.link);
    }
  };

  return (
    <div className="divide-y divide-[#D3D7DA] border border-[#C8CDD2] bg-white">
      {sortedNotifications.map((notification) => {
        const config = getNotificationConfig(notification.type, notification.message);
        const Icon = config.icon;
        const priority = inferNotificationPriority(notification);

        return (
          <button
            key={notification.id}
            type="button"
            onClick={() => openNotification(notification)}
            className={clsx(
              "group w-full px-4 py-3 text-left transition-colors hover:bg-[#F5F7F8]",
              notification.is_read
                ? "bg-white"
                : "bg-[#EEF6FB]",
            )}
          >
            <div className="flex items-start gap-3">
              <div className={clsx("flex h-8 w-8 flex-shrink-0 items-center justify-center border bg-white text-sm", config.color)}>
                <Icon className="h-4 w-4" />
              </div>

              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-xs font-bold uppercase tracking-wider text-[#5E6870]">
                    {config.label}
                  </span>
                  {config.category && (
                    <span className="bg-[#F5F7F8] px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-[#5E6870]">
                      {config.category}
                    </span>
                  )}
                  {!notification.is_read && <span className="h-1.5 w-1.5 bg-[#287EAD]" />}
                  <span
                    className={clsx(
                      "px-1.5 py-0.5 text-[10px] font-semibold uppercase",
                      priority === "high" && "bg-red-50 text-red-700",
                      priority === "medium" && "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-400",
                      priority === "low" && "bg-[#F5F7F8] text-[#5E6870]",
                    )}
                  >
                    {priority}
                  </span>
                </div>
                <p className={clsx("mt-1 text-sm leading-snug", notification.is_read ? "text-[#5E6870]" : "font-semibold text-[#1F2933]")}>
                  {notification.message}
                </p>
                <div className="mt-1.5 text-xs text-[#5E6870]">
                  {new Date(notification.created_at).toLocaleString(undefined, {
                    dateStyle: "short",
                    timeStyle: "short",
                  })}
                </div>
              </div>

              <ChevronRight className="mt-1 h-4 w-4 flex-shrink-0 text-[#5E6870] opacity-40 transition-all group-hover:opacity-100" />
            </div>
          </button>
        );
      })}
    </div>
  );
}

export function getDocumentIdFromLink(link?: string): string | undefined {
  if (!link) return undefined;
  // Extract UUID or numeric ID from /documents/ or /tasks/ patterns
  // This ensures we get a valid ID even if the link points to a specific task
  const match = link.match(/\/(?:documents|tasks)\/([0-9a-fA-F-]{36}|[0-9]+)/);
  return match ? match[1] : undefined;
}
