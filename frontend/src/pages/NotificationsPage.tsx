import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Bell, CheckCheck, Loader2 } from "lucide-react";
import { notificationsAPI, normalizeListResponse } from "@/services/api";
import type { Notification } from "@/types";
import { NotificationList, inferNotificationPriority } from "@/components/notifications/notifications-list";
import clsx from "clsx";

type Filter = "unread" | "all" | "urgent";

export default function NotificationsPage() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [filter, setFilter] = useState<Filter>("unread");

  const { data: notifications = [], isLoading } = useQuery<Notification[]>({
    queryKey: ["notifications"],
    queryFn: () => notificationsAPI.list().then((r) => normalizeListResponse<Notification>(r.data)),
    staleTime: 30_000,
  });

  const markReadMutation = useMutation({
    mutationFn: (id: string) => notificationsAPI.markRead(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["notifications"] });
      qc.invalidateQueries({ queryKey: ["notifications", "unread-count"] });
    },
  });

  const markAllReadMutation = useMutation({
    mutationFn: () => notificationsAPI.markAllRead(),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["notifications"] });
      qc.invalidateQueries({ queryKey: ["notifications", "unread-count"] });
    },
  });

  const unreadCount = notifications.filter((notification) => !notification.is_read).length;
  const urgentCount = notifications.filter((notification) => inferNotificationPriority(notification) === "high").length;

  const visibleNotifications = useMemo(() => {
    switch (filter) {
      case "all":
        return notifications;
      case "urgent":
        return notifications.filter((notification) => inferNotificationPriority(notification) === "high");
      case "unread":
      default:
        return notifications.filter((notification) => !notification.is_read);
    }
  }, [filter, notifications]);

  const filters: { id: Filter; label: string; count: number }[] = [
    { id: "unread", label: "Unread", count: unreadCount },
    { id: "urgent", label: "Urgent", count: urgentCount },
    { id: "all", label: "All", count: notifications.length },
  ];

  return (
    <div className="mx-auto max-w-4xl px-4 py-6 sm:px-6">
      {/* Header */}
      <div className="mb-8 space-y-4">
        <div className="flex items-start gap-4">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg border border-primary/20 bg-primary/10">
            <Bell className="h-5 w-5 text-primary" />
          </div>
          <div>
            <h1 className="text-2xl font-semibold text-foreground">Notifications</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Workflow requests, document updates, and time-sensitive alerts.
            </p>
          </div>
        </div>

        {/* Filters and Actions */}
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex gap-1 rounded-lg border border-border bg-muted/30 p-1">
            {filters.map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => setFilter(item.id)}
                className={clsx(
                  "inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
                  filter === item.id
                    ? "bg-primary text-primary-foreground"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {item.label}
                <span
                  className={clsx(
                    "rounded-full px-1.5 py-0.5 text-[10px] font-medium",
                    filter === item.id ? "bg-primary-foreground/20" : "bg-muted",
                  )}
                >
                  {item.count}
                </span>
              </button>
            ))}
          </div>

          <button
            type="button"
            onClick={() => markAllReadMutation.mutate()}
            disabled={markAllReadMutation.isPending || unreadCount === 0}
            className={clsx(
              "inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-sm font-medium transition-colors",
              markAllReadMutation.isPending || unreadCount === 0
                ? "opacity-50 cursor-not-allowed text-muted-foreground"
                : "hover:bg-muted text-foreground",
            )}
          >
            {markAllReadMutation.isPending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <CheckCheck className="h-4 w-4" />
            )}
            Mark all read
          </button>
        </div>
      </div>

      {/* Notifications List */}
      <NotificationList
        notifications={visibleNotifications}
        isLoading={isLoading}
        onMarkRead={(id) => markReadMutation.mutate(id)}
        onOpenLink={(link) => navigate(link)}
      />
    </div>
  );
}
