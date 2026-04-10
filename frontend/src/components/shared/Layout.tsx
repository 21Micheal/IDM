import { Outlet, NavLink, useNavigate } from "react-router-dom";
import {
  LayoutDashboard, FileText, Upload, Search, GitBranch,
  ShieldCheck, Settings, LogOut, Bell, ChevronDown,
} from "lucide-react";
import { useAuthStore } from "@/store/authStore";
import { useQuery } from "@tanstack/react-query";
import { notificationsAPI } from "@/services/api";
import clsx from "clsx";

const nav = [
  { to: "/", icon: LayoutDashboard, label: "Dashboard", exact: true },
  { to: "/documents", icon: FileText, label: "Documents" },
  { to: "/documents/upload", icon: Upload, label: "Upload" },
  { to: "/search", icon: Search, label: "Search" },
  { to: "/workflow", icon: GitBranch, label: "Workflow" },
  { to: "/audit", icon: ShieldCheck, label: "Audit", roles: ["admin", "auditor"] },
  { to: "/admin", icon: Settings, label: "Admin", roles: ["admin"] },
];

export default function Layout() {
  const { user, logout } = useAuthStore();
  const navigate = useNavigate();
  const { data: notifications } = useQuery({
    queryKey: ["notifications"],
    queryFn: () => notificationsAPI.list().then((r) => r.data.results),
    refetchInterval: 30_000,
  });

  const unread = notifications?.filter((n: { is_read: boolean }) => !n.is_read).length ?? 0;

  const visibleNav = nav.filter(
    (item) => !item.roles || (user && item.roles.includes(user.role))
  );

  return (
    <div className="flex h-screen bg-gray-50">
      {/* Sidebar */}
      <aside className="w-60 flex-shrink-0 bg-brand-900 flex flex-col">
        <div className="h-16 flex items-center px-5 border-b border-brand-700">
          <FileText className="w-6 h-6 text-brand-100 mr-2" />
          <span className="text-white font-semibold text-lg tracking-tight">DocVault</span>
        </div>
        <nav className="flex-1 px-3 py-4 space-y-1 overflow-y-auto">
          {visibleNav.map(({ to, icon: Icon, label, exact }) => (
            <NavLink
              key={to}
              to={to}
              end={exact}
              className={({ isActive }) =>
                clsx(
                  "flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium transition-colors",
                  isActive
                    ? "bg-brand-600 text-white"
                    : "text-brand-200 hover:bg-brand-800 hover:text-white"
                )
              }
            >
              <Icon className="w-4 h-4 flex-shrink-0" />
              {label}
            </NavLink>
          ))}
        </nav>
        <div className="p-4 border-t border-brand-700">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-full bg-brand-500 flex items-center justify-center text-white text-xs font-semibold">
              {user?.first_name?.[0]}{user?.last_name?.[0]}
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-white text-sm font-medium truncate">
                {user?.first_name} {user?.last_name}
              </p>
              <p className="text-brand-300 text-xs capitalize">{user?.role}</p>
            </div>
            <button
              onClick={() => { logout(); navigate("/login"); }}
              className="text-brand-300 hover:text-white transition-colors"
              title="Sign out"
            >
              <LogOut className="w-4 h-4" />
            </button>
          </div>
        </div>
      </aside>

      {/* Main content area */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Top bar */}
        <header className="h-16 bg-white border-b border-gray-200 flex items-center justify-end px-6 gap-4 flex-shrink-0">
          <button
            onClick={() => navigate("/notifications")}
            className="relative text-gray-500 hover:text-gray-700"
          >
            <Bell className="w-5 h-5" />
            {unread > 0 && (
              <span className="absolute -top-1 -right-1 bg-red-500 text-white text-[10px] font-bold w-4 h-4 rounded-full flex items-center justify-center">
                {unread > 9 ? "9+" : unread}
              </span>
            )}
          </button>
        </header>

        {/* Page outlet */}
        <main className="flex-1 overflow-y-auto p-6">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
