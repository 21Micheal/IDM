import { useMemo, useState } from "react";
import {
  AlertCircle,
  AlertTriangle,
  Bell,
  CheckCheck,
  CheckCircle,
  ClipboardCheck,
  Clock,
  Info,
  Loader2,
  PauseCircle,
  PlayCircle,
  RotateCcw,
  XCircle,
} from "lucide-react";
import clsx from "clsx";
import type { Notification } from "@/types";
import { NotificationDetail, type NotificationDetailData } from "./notification-details";

type Priority = "high" | "medium" | "low";

interface NotificationListProps {
  notifications: Notification[];
  isLoading?: boolean;
  onMarkRead?: (id: string) => void;
  onOpenLink?: (link: string) => void;
}

export function getNotificationConfig(type: string, message = "") {
  switch (type) {
    case "task_assigned":
      return {
        icon: ClipboardCheck,
        color: "text-primary bg-primary/10 border-primary/20",
        label: "Approval Request",
      };
    case "workflow_complete":
      return {
        icon: CheckCircle,
        color: "text-teal bg-teal/10 border-teal/20",
        label: "Workflow Complete",
      };
    case "document_returned":
      return {
        icon: RotateCcw,
        color: "text-amber-700 bg-amber-50 border-amber-200",
        label: "Returned for Review",
      };
    case "document_held":
      return {
        icon: PauseCircle,
        color: "text-orange-700 bg-orange-50 border-orange-200",
        label: "Document on Hold",
      };
    case "hold_released":
      return {
        icon: PlayCircle,
        color: "text-teal bg-teal/10 border-teal/20",
        label: "Hold Released",
      };
    case "hold_expired":
      return {
        icon: Clock,
        color: "text-purple-700 bg-purple-50 border-purple-200",
        label: "Hold Expired",
      };
    case "task_overdue":
      return {
        icon: AlertTriangle,
        color: "text-destructive bg-destructive/10 border-destructive/20",
        label: "Overdue",
      };
    case "workflow_action":
      return {
        icon: CheckCheck,
        color: "text-muted-foreground bg-muted border-border",
        label: "Workflow Update",
      };
    default: {
      const normalized = message.toLowerCase();
      if (normalized.includes("overdue") || normalized.includes("urgent")) {
        return {
          icon: AlertTriangle,
          color: "text-destructive bg-destructive/10 border-destructive/20",
          label: "Urgent",
        };
      }
      if (normalized.includes("returned") || normalized.includes("rejected") || normalized.includes("hold")) {
        return {
          icon: XCircle,
          color: "text-amber-700 bg-amber-50 border-amber-200",
          label: "Attention",
        };
      }
      return {
        icon: Info,
        color: "text-muted-foreground bg-muted border-border",
        label: "Info",
      };
    }
  }
}

export function inferNotificationPriority(notification: Notification): Priority {
  const text = `${notification.type} ${notification.message}`.toLowerCase();
  if (text.includes("overdue") || text.includes("urgent") || text.includes("expired")) return "high";
  if (text.includes("assigned") || text.includes("returned") || text.includes("held")) return "medium";
  return "low";
}

export function NotificationList({
  notifications,
  isLoading = false,
  onMarkRead,
  onOpenLink,
}: NotificationListProps) {
  const [selected, setSelected] = useState<NotificationDetailData | null>(null);

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
        <Loader2 className="w-8 h-8 text-primary animate-spin" />
      </div>
    );
  }

  if (sortedNotifications.length === 0) {
    return (
      <div className="card p-16 text-center">
        <div className="w-16 h-16 rounded-full bg-muted flex items-center justify-center mx-auto mb-4">
          <Bell className="w-8 h-8 text-muted-foreground/40" />
        </div>
        <h3 className="text-lg font-semibold text-foreground">No notifications</h3>
        <p className="text-sm text-muted-foreground mt-1">You are all caught up with your tasks and updates.</p>
      </div>
    );
  }

  const openNotification = (notification: Notification) => {
    const config = getNotificationConfig(notification.type, notification.message);
    const priority = inferNotificationPriority(notification);
    const detail: NotificationDetailData = {
      id: notification.id,
      title: config.label,
      message: notification.message,
      type: notification.type,
      createdAt: notification.created_at,
      priority,
      viewDocumentLink: notification.link,
      documentId: getDocumentIdFromLink(notification.link),
    };
    setSelected(detail);
    if (!notification.is_read) onMarkRead?.(notification.id);
  };

  return (
    <>
      <div className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-card">
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
                "group flex w-full items-start gap-4 px-5 py-4 text-left transition-colors",
                notification.is_read ? "bg-card hover:bg-muted/40" : "bg-primary/5 hover:bg-primary/10",
              )}
            >
              <div className={clsx("flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-lg border", config.color)}>
                <Icon className="h-5 w-5" />
              </div>

              <div className="min-w-0 flex-1">
                <div className="mb-1 flex flex-wrap items-center gap-2">
                  <span className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
                    {config.label}
                  </span>
                  {!notification.is_read && <span className="h-2 w-2 rounded-full bg-primary" />}
                  <span
                    className={clsx(
                      "rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase",
                      priority === "high" && "bg-destructive/10 text-destructive",
                      priority === "medium" && "bg-amber-100 text-amber-800",
                      priority === "low" && "bg-muted text-muted-foreground",
                    )}
                  >
                    {priority}
                  </span>
                </div>
                <p className={clsx("text-sm leading-relaxed", notification.is_read ? "text-muted-foreground" : "text-foreground font-medium")}>
                  {notification.message}
                </p>
                <div className="mt-2 flex items-center gap-1.5 text-xs text-muted-foreground">
                  <Clock className="h-3.5 w-3.5" />
                  {new Date(notification.created_at).toLocaleString(undefined, {
                    dateStyle: "medium",
                    timeStyle: "short",
                  })}
                </div>
              </div>

              <AlertCircle className="mt-1 h-4 w-4 flex-shrink-0 text-muted-foreground opacity-50 transition-opacity group-hover:opacity-100" />
            </button>
          );
        })}
      </div>

      {selected && (
        <NotificationDetail
          notification={selected}
          onClose={() => setSelected(null)}
          onViewDocument={() => {
            if (selected.viewDocumentLink) onOpenLink?.(selected.viewDocumentLink);
          }}
        />
      )}
    </>
  );
}

function getDocumentIdFromLink(link?: string): string | undefined {
  if (!link) return undefined;
  const match = link.match(/\/documents\/([^/?#]+)/);
  return match?.[1];
}
