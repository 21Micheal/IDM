import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { Bell, CheckCheck, ClipboardCheck, AlertTriangle, CheckCircle, XCircle, Info, Clock, Loader2 } from "lucide-react";
import { notificationsAPI } from "@/services/api";
import type { Notification } from "@/types";
import clsx from "clsx";

const getNotificationConfig = (message: string) => {
  const msg = message.toLowerCase();
  if (msg.includes("action required") || msg.includes("approval required")) {
    return {
      icon: ClipboardCheck,
      color: "text-blue-600 bg-blue-50 border-blue-100",
      label: "Action Required",
    };
  }
  if (msg.includes("overdue") || msg.includes("expired") || msg.includes("urgent")) {
    return {
      icon: AlertTriangle,
      color: "text-destructive bg-destructive/10 border-destructive/20",
      label: "Urgent",
    };
  }
  if (msg.includes("approved") || msg.includes("complete") || msg.includes("released")) {
    return {
      icon: CheckCircle,
      color: "text-teal bg-teal/10 border-teal/20",
      label: "Update",
    };
  }
  if (msg.includes("rejected") || msg.includes("returned") || msg.includes("hold")) {
    return {
      icon: XCircle,
      color: "text-amber-600 bg-amber-50 border-amber-100",
      label: "Alert",
    };
  }
  return {
    icon: Info,
    color: "text-muted-foreground bg-muted border-border",
    label: "Info",
  };
};

export default function NotificationsPage() {
  const qc = useQueryClient();

  const { data: notifications = [], isLoading } = useQuery<Notification[]>({
    queryKey: ["notifications"],
    queryFn: () => notificationsAPI.list().then((r) => r.data.results ?? r.data),
  });

  const markReadMutation = useMutation({
    mutationFn: (id: string) => notificationsAPI.markRead(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["notifications"] }),
  });

  const markAllReadMutation = useMutation({
    mutationFn: () => notificationsAPI.markAllRead(),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["notifications"] }),
  });

  // Filter to show only unread notifications so they "disappear" once viewed
  const unreadNotifications = notifications.filter(n => !n.is_read);

  return (
    <div className="max-w-4xl mx-auto py-10 px-6 space-y-8">
      <div className="flex items-center justify-between">
        <div>
          <div className="flex items-center gap-3 mb-2">
            <div className="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center">
              <Bell className="w-5 h-5 text-primary" />
            </div>
            <h1 className="text-3xl font-bold tracking-tight text-foreground">Notifications</h1>
          </div>
          <p className="text-sm text-muted-foreground">Recent workflow actions and document updates.</p>
        </div>
        <button
          onClick={() => markAllReadMutation.mutate()}
          disabled={markAllReadMutation.isPending || unreadNotifications.length === 0}
          className="btn-secondary"
        >
          <CheckCheck className="w-4 h-4" /> Mark all as read
        </button>
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center py-20">
          <Loader2 className="w-8 h-8 text-primary animate-spin" />
        </div>
      ) : unreadNotifications.length === 0 ? (
        <div className="card p-16 text-center">
          <div className="w-16 h-16 rounded-full bg-muted flex items-center justify-center mx-auto mb-4">
            <Bell className="w-8 h-8 text-muted-foreground/40" />
          </div>
          <h3 className="text-lg font-semibold text-foreground">No new notifications</h3>
          <p className="text-sm text-muted-foreground mt-1">You're all caught up with your tasks and updates.</p>
        </div>
      ) : (
        <div className="space-y-3">
          {unreadNotifications.map((n) => {
            const config = getNotificationConfig(n.message);
            const Icon = config.icon;

            const content = (
              <div className="flex items-start gap-4">
                <div className={clsx("w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0 border", config.color)}>
                  <Icon className="w-5 h-5" />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center justify-between gap-2 mb-1">
                    <span className="text-[10px] uppercase tracking-widest font-bold text-muted-foreground opacity-70">
                      {config.label}
                    </span>
                    <span className="text-[10px] text-muted-foreground flex items-center gap-1">
                      <Clock className="w-3 h-3" />
                      {new Date(n.created_at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}
                    </span>
                  </div>
                  <p className="text-sm text-foreground leading-relaxed">{n.message}</p>
                </div>
              </div>
            );

            return (
              <div key={n.id} className="card p-0 overflow-hidden hover:shadow-md transition-all">
                <div className="bg-accent/5">
                  {n.link ? (
                    <Link
                      to={n.link}
                      onClick={() => {
                        if (!n.is_read) markReadMutation.mutate(n.id);
                      }}
                      className="block px-5 py-4 hover:bg-muted/40 transition-colors"
                    >
                      {content}
                    </Link>
                  ) : (
                    <button
                      onClick={() => {
                        if (!n.is_read) markReadMutation.mutate(n.id);
                      }}
                      className="w-full text-left px-5 py-4 hover:bg-muted/40 transition-colors"
                    >
                      {content}
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
