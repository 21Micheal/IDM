/**
 * components/shared/AppLayout.tsx
 * Main shell: collapsible sidebar + top bar + notification panel.
 */
import { useState, useRef, useEffect } from "react";
import { Outlet, NavLink, useNavigate } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  LayoutDashboard, Search, FileText, UploadCloud,
  Settings, Shield, Bell, LogOut, ChevronLeft, ChevronRight,
  CheckCircle, X
} from "lucide-react";
import { useAuthStore, isAdmin } from "../../store/authStore";
import { notificationApi } from "../../services/api";
import { cn } from "../../lib/utils";
import { format } from "date-fns";

const NAV = [
  { to: "/", icon: LayoutDashboard, label: "Dashboard", exact: true },
  { to: "/documents", icon: FileText, label: "Documents" },
  { to: "/documents/upload", icon: UploadCloud, label: "Upload" },
  { to: "/search", icon: Search, label: "Search" },
];

const ADMIN_NAV = [
  { to: "/admin/document-types", icon: Settings, label: "Document types" },
  { to: "/audit", icon: Shield, label: "Audit trail" },
];

export default function AppLayout() {
  const { user, logout } = useAuthStore();
  const [collapsed, setCollapsed] = useState(false);
  const [showNotif, setShowNotif] = useState(false);
  const notifRef = useRef<HTMLDivElement>(null);
  const qc = useQueryClient();

  const { data: notifData } = useQuery({
    queryKey: ["notifications"],
    queryFn: () => notificationApi.list(),
    select: (r) => r.data?.results ?? [],
    refetchInterval: 30_000,
  });

  const markReadMutation = useMutation({
    mutationFn: (id: string) => notificationApi.markRead(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["notifications"] }),
  });

  const markAllMutation = useMutation({
    mutationFn: () => notificationApi.markAllRead(),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["notifications"] }),
  });

  const unread = (notifData ?? []).filter((n: any) => !n.is_read).length;

  // Close notification panel on outside click
  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (notifRef.current && !notifRef.current.contains(e.target as Node)) {
        setShowNotif(false);
      }
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

  return (
    <div className="flex h-screen bg-slate-50 overflow-hidden">
      {/* ── Sidebar ─────────────────────────────────────────────────────────── */}
      <aside className={cn(
        "flex flex-col bg-slate-900 transition-all duration-200 shrink-0",
        collapsed ? "w-16" : "w-56"
      )}>
        {/* Logo */}
        <div className="flex items-center gap-2 px-4 py-5 border-b border-slate-800">
          <div className="w-7 h-7 rounded-lg bg-indigo-600 flex items-center justify-center shrink-0">
            <FileText className="w-4 h-4 text-white" />
          </div>
          {!collapsed && <span className="font-semibold text-white text-sm">DMS</span>}
        </div>

        {/* Navigation */}
        <nav className="flex-1 px-2 py-4 space-y-0.5 overflow-y-auto">
          {NAV.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.exact}
              className={({ isActive }) => cn(
                "flex items-center gap-3 px-3 py-2 rounded-lg text-sm transition-colors",
                isActive
                  ? "bg-indigo-600 text-white"
                  : "text-slate-400 hover:bg-slate-800 hover:text-white"
              )}
            >
              <item.icon className="w-4 h-4 shrink-0" />
              {!collapsed && <span>{item.label}</span>}
            </NavLink>
          ))}

          {isAdmin(user) && (
            <>
              {!collapsed && (
                <p className="text-xs text-slate-600 px-3 pt-4 pb-1 uppercase tracking-wider">Admin</p>
              )}
              {ADMIN_NAV.map((item) => (
                <NavLink
                  key={item.to}
                  to={item.to}
                  className={({ isActive }) => cn(
                    "flex items-center gap-3 px-3 py-2 rounded-lg text-sm transition-colors",
                    isActive
                      ? "bg-indigo-600 text-white"
                      : "text-slate-400 hover:bg-slate-800 hover:text-white"
                  )}
                >
                  <item.icon className="w-4 h-4 shrink-0" />
                  {!collapsed && <span>{item.label}</span>}
                </NavLink>
              ))}
            </>
          )}
        </nav>

        {/* User + collapse */}
        <div className="border-t border-slate-800 p-2">
          {!collapsed && (
            <div className="px-3 py-2 mb-1">
              <p className="text-sm font-medium text-white truncate">{user?.full_name}</p>
              <p className="text-xs text-slate-400 truncate">{user?.role}</p>
            </div>
          )}
          <button
            onClick={logout}
            className="w-full flex items-center gap-3 px-3 py-2 text-slate-400 hover:text-white hover:bg-slate-800 rounded-lg text-sm transition-colors"
          >
            <LogOut className="w-4 h-4 shrink-0" />
            {!collapsed && "Sign out"}
          </button>
          <button
            onClick={() => setCollapsed((v) => !v)}
            className="w-full flex items-center justify-center px-3 py-2 text-slate-600 hover:text-slate-400 rounded-lg transition-colors mt-1"
          >
            {collapsed ? <ChevronRight className="w-4 h-4" /> : <ChevronLeft className="w-4 h-4" />}
          </button>
        </div>
      </aside>

      {/* ── Main area ───────────────────────────────────────────────────────── */}
      <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
        {/* Top bar */}
        <header className="h-14 bg-white border-b border-slate-200 flex items-center justify-end px-6 gap-3 shrink-0">
          {/* Notification bell */}
          <div className="relative" ref={notifRef}>
            <button
              onClick={() => setShowNotif((v) => !v)}
              className="relative p-2 text-slate-500 hover:text-slate-700 hover:bg-slate-100 rounded-lg"
            >
              <Bell className="w-5 h-5" />
              {unread > 0 && (
                <span className="absolute top-1.5 right-1.5 w-2 h-2 bg-red-500 rounded-full" />
              )}
            </button>

            {/* Dropdown */}
            {showNotif && (
              <div className="absolute right-0 top-full mt-2 w-80 bg-white border border-slate-200 rounded-xl shadow-lg z-50">
                <div className="flex items-center justify-between px-4 py-3 border-b border-slate-100">
                  <span className="font-medium text-slate-900 text-sm">Notifications</span>
                  {unread > 0 && (
                    <button
                      onClick={() => markAllMutation.mutate()}
                      className="text-xs text-indigo-600 hover:text-indigo-700"
                    >
                      Mark all read
                    </button>
                  )}
                </div>
                <div className="max-h-80 overflow-y-auto divide-y divide-slate-100">
                  {(notifData ?? []).length === 0 ? (
                    <p className="text-center text-slate-400 text-sm py-8">No notifications</p>
                  ) : (
                    (notifData ?? []).slice(0, 10).map((n: any) => (
                      <div
                        key={n.id}
                        className={cn("px-4 py-3 flex gap-3", !n.is_read && "bg-indigo-50")}
                      >
                        <div className="flex-1 min-w-0">
                          <p className={cn("text-sm", !n.is_read ? "text-slate-900 font-medium" : "text-slate-700")}>
                            {n.title}
                          </p>
                          <p className="text-xs text-slate-500 mt-0.5 line-clamp-2">{n.message}</p>
                          <p className="text-xs text-slate-400 mt-0.5">
                            {format(new Date(n.created_at), "MMM d, HH:mm")}
                          </p>
                        </div>
                        {!n.is_read && (
                          <button
                            onClick={() => markReadMutation.mutate(n.id)}
                            className="text-indigo-400 hover:text-indigo-600 shrink-0 mt-0.5"
                          >
                            <CheckCircle className="w-4 h-4" />
                          </button>
                        )}
                      </div>
                    ))
                  )}
                </div>
              </div>
            )}
          </div>

          {/* Role badge */}
          <span className="text-xs bg-slate-100 text-slate-600 px-2.5 py-1 rounded-full font-medium capitalize">
            {user?.role}
          </span>
        </header>

        {/* Page content */}
        <main className="flex-1 overflow-y-auto">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
