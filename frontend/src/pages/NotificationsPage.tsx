import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Bell, CheckCheck, Loader2 } from "lucide-react";
import { notificationsAPI, normalizeListResponse } from "@/services/api";
import type { Notification } from "@/types";
import { NotificationList, inferNotificationPriority } from "@/components/notifications/notifications-list";
import clsx from "clsx";

type Filter = "unread" | "all" | "urgent";
const TASK_NOTIFICATION_TYPES = new Set(["task_assigned", "task_sla_warning", "task_overdue"]);

export default function NotificationsPage() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [filter, setFilter] = useState<Filter>("unread");

  const { data: allNotifications = [], isLoading } = useQuery<Notification[]>({
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

  const notifications = useMemo(
    () => allNotifications.filter((notification) => !TASK_NOTIFICATION_TYPES.has(notification.type)),
    [allNotifications],
  );
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
    <div className="-m-6 min-h-[calc(100vh-3.5rem)] bg-[#EDEDED]">
      <div className="border-b border-[#206D99] bg-[#287EAD] px-6 py-4 text-white">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center border border-white/25 bg-white/10">
              <Bell className="h-5 w-5 text-white" />
            </div>
            <div>
              <h1 className="text-xl font-semibold">Notifications</h1>
              <p className="mt-0.5 text-sm text-white/75">
                Document updates, shared items, and operational alerts.
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <div className="flex border border-white/25 bg-white/10">
              {filters.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => setFilter(item.id)}
                  className={clsx(
                    "inline-flex items-center gap-2 border-r border-white/20 px-3 py-2 text-sm font-semibold last:border-r-0",
                    filter === item.id ? "bg-white text-[#1F2933]" : "text-white hover:bg-white/15",
                  )}
                >
                  {item.label}
                  <span className={clsx("text-xs", filter === item.id ? "text-[#287EAD]" : "text-white/75")}>
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
                "inline-flex items-center gap-2 border border-white/25 px-3 py-2 text-sm font-semibold transition-colors",
                markAllReadMutation.isPending || unreadCount === 0
                  ? "cursor-not-allowed text-white/45"
                  : "text-white hover:bg-white/15",
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
      </div>

      <div className="p-4 pr-8">
        <NotificationList
          notifications={visibleNotifications}
          isLoading={isLoading}
          onMarkRead={(id) => markReadMutation.mutate(id)}
          onOpenLink={(link) => navigate(link)}
          onOpenWorkflow={(detail) => {
            if (!detail.documentId) return;
            navigate(`/notifications/workflow/${detail.documentId}`, {
              state: { notification: detail },
            });
          }}
        />
      </div>
    </div>
  );
}
