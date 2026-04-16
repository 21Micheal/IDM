import { Outlet, NavLink, useNavigate } from "react-router-dom";
import {
  LayoutDashboard, FileText, Upload, Search,
  GitBranch, ShieldCheck, Settings, LogOut,
  Bell, Users, Building2, UserCircle, Shield,
} from "lucide-react";
import { useAuthStore } from "../../store/authStore";
import { useQuery } from "@tanstack/react-query";
import { notificationsAPI } from "../../services/api";
import { FlaxemLogo } from "./FlaxemLogo";
import clsx from "clsx";

interface NavItem {
  to: string;
  icon: React.ElementType;
  label: string;
  exact?: boolean;
  roles?: string[];
}

const mainNav: NavItem[] = [
  { to: "/",                 icon: LayoutDashboard, label: "Dashboard",   exact: true },
  { to: "/documents",        icon: FileText,        label: "Documents" },
  { to: "/documents/upload", icon: Upload,          label: "Upload" },
  { to: "/search",           icon: Search,          label: "Search" },
  { to: "/workflow",         icon: GitBranch,        label: "Workflow" },
  { to: "/workflow/builder", icon: GitBranch, label: "Workflow builder", roles: ["admin"] },
];

const adminNav: NavItem[] = [
  { to: "/admin/users",       icon: Users,      label: "Users",       roles: ["admin"] },
  { to: "/admin/departments", icon: Building2,  label: "Departments", roles: ["admin"] },
  { to: "/admin/groups",      icon: Shield,     label: "Groups",      roles: ["admin"] },
  { to: "/audit",             icon: ShieldCheck, label: "Audit trail", roles: ["admin", "auditor"] },
  { to: "/admin/settings",    icon: Settings,   label: "Settings",    roles: ["admin"] },
];

export default function Layout() {
  const { user, logout } = useAuthStore();
  const navigate = useNavigate();

  const { data: notifications } = useQuery({
    queryKey: ["notifications"],
    queryFn: () => notificationsAPI.list().then((r) => r.data.results ?? r.data),
    refetchInterval: 30_000,
  });

  const unread = (notifications as { is_read: boolean }[] | undefined)
    ?.filter((n) => !n.is_read).length ?? 0;

  const visibleAdmin = adminNav.filter(
    (item) => !item.roles || (user && item.roles.includes(user.role))
  );

  return (
    <div className="flex h-screen bg-gray-50">
      {/* Sidebar - Flaxem Blue */}
      <aside className="w-60 flex-shrink-0 bg-gradient-to-b from-blue-900 to-blue-800 flex flex-col shadow-xl">
        {/* Logo Section */}
        <div className="h-16 flex items-center px-4 border-b border-blue-700">
          <FlaxemLogo variant="light" />
        </div>

        {/* Navigation */}
        <nav className="flex-1 px-3 py-4 overflow-y-auto space-y-0.5">
          {mainNav.map(({ to, icon: Icon, label, exact, roles }) => {
            // Filter navigation by roles
            if (roles && !user) return null;
            if (roles && user && !roles.includes(user.role)) return null;

            return (
              <NavLink
                key={to}
                to={to}
                end={exact}
                className={({ isActive }) =>
                  clsx(
                    "flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium transition-colors",
                    isActive
                      ? "bg-red-600 text-white shadow-md"
                      : "text-blue-100 hover:bg-blue-700 hover:text-white"
                  )
                }
              >
                <Icon className="w-4 h-4 flex-shrink-0" />
                {label}
              </NavLink>
            );
          })}

          {visibleAdmin.length > 0 && (
            <>
              <div className="pt-4 pb-1 px-3">
                <p className="text-[10px] font-semibold uppercase tracking-widest text-blue-300">
                  Administration
                </p>
              </div>
              {visibleAdmin.map(({ to, icon: Icon, label }) => (
                <NavLink
                  key={to}
                  to={to}
                  className={({ isActive }) =>
                    clsx(
                      "flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium transition-colors",
                      isActive
                        ? "bg-red-600 text-white shadow-md"
                        : "text-blue-100 hover:bg-blue-700 hover:text-white"
                    )
                  }
                >
                  <Icon className="w-4 h-4 flex-shrink-0" />
                  {label}
                </NavLink>
              ))}
            </>
          )}
        </nav>

        {/* Footer / User Profile Section */}
        <div className="p-3 border-t border-blue-700 space-y-1">
          <NavLink
            to="/profile"
            className={({ isActive }) =>
              clsx(
                "flex items-center gap-2 px-3 py-2 rounded-lg text-sm transition-colors w-full",
                isActive
                  ? "bg-blue-700 text-white"
                  : "text-blue-100 hover:bg-blue-700 hover:text-white"
              )
            }
          >
            <UserCircle className="w-4 h-4 flex-shrink-0" />
            My profile
          </NavLink>
          
          <div className="flex items-center gap-3 px-3 py-1.5">
            <div className="w-8 h-8 rounded-full bg-red-600 flex items-center justify-center text-white text-xs font-bold flex-shrink-0 border-2 border-blue-600">
              {user?.first_name?.[0]}{user?.last_name?.[0]}
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-white text-xs font-semibold truncate leading-tight">
                {user?.first_name} {user?.last_name}
              </p>
              <p className="text-blue-200 text-[10px] capitalize font-medium">{user?.role}</p>
            </div>
            <button
              onClick={() => { logout(); navigate("/login"); }}
              className="text-blue-200 hover:text-white transition-colors"
              title="Sign out"
            >
              <LogOut className="w-4 h-4" />
            </button>
          </div>
        </div>
      </aside>

      {/* Main Content Area */}
      <div className="flex-1 flex flex-col min-w-0">
        <header className="h-14 bg-white border-b border-red-600 flex items-center justify-end px-6 gap-3 flex-shrink-0 shadow-sm">
          <button
            onClick={() => navigate("/notifications")}
            className="relative text-gray-500 hover:text-blue-600 p-1 transition-colors"
            title="Notifications"
          >
            <Bell className="w-5 h-5" />
            {unread > 0 && (
              <span className="absolute -top-0.5 -right-0.5 bg-red-600 text-white text-[9px] font-bold w-4 h-4 rounded-full flex items-center justify-center">
                {unread > 9 ? "9+" : unread}
              </span>
            )}
          </button>
        </header>
        
        <main className="flex-1 overflow-y-auto p-6 bg-gray-50/50">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
