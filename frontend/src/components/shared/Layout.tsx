import { Outlet, NavLink, useNavigate } from "react-router-dom";
import {
  LayoutDashboard, FileText, Upload, Search,
  GitBranch, ShieldCheck, Settings, LogOut,
  Bell, Users, Building2, UserCircle, Shield,
} from "lucide-react";
import { useAuthStore } from "@/store/authStore";
import { useQuery } from "@tanstack/react-query";
import { notificationsAPI } from "@/services/api";
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
  { to: "/users",       icon: Users,      label: "Users",       roles: ["admin"] },
  { to: "/departments", icon: Building2,  label: "Departments", roles: ["admin"] },
  { to: "/groups",      icon: Shield,     label: "Groups",      roles: ["admin"] },
  { to: "/audit",       icon: ShieldCheck, label: "Audit trail", roles: ["admin", "auditor"] },
  { to: "/admin",       icon: Settings,   label: "Settings",    roles: ["admin"] },
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
      {/* Sidebar */}
      <aside className="w-60 flex-shrink-0 bg-slate-900 flex flex-col shadow-xl">
        {/* Logo Section */}
        <div className="h-16 flex items-center px-5 border-b border-slate-800">
          <div className="bg-indigo-600 p-1.5 rounded-lg mr-3">
            <FileText className="w-5 h-5 text-white flex-shrink-0" />
          </div>
          <span className="text-white font-bold text-lg tracking-tight">FSE-DMS</span>
        </div>

        {/* Navigation */}
        <nav className="flex-1 px-3 py-4 overflow-y-auto space-y-0.5">
          {mainNav.map(({ to, icon: Icon, label, exact }) => (
            <NavLink
              key={to}
              to={to}
              end={exact}
              className={({ isActive }) =>
                clsx(
                  "flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium transition-colors",
                  isActive
                    ? "bg-indigo-600 text-white shadow-sm"
                    : "text-slate-400 hover:bg-slate-800 hover:text-white"
                )
              }
            >
              <Icon className="w-4 h-4 flex-shrink-0" />
              {label}
            </NavLink>
          ))}

          {visibleAdmin.length > 0 && (
            <>
              <div className="pt-4 pb-1 px-3">
                <p className="text-[10px] font-semibold uppercase tracking-widest text-slate-500">
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
                        ? "bg-indigo-600 text-white shadow-sm"
                        : "text-slate-400 hover:bg-slate-800 hover:text-white"
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
        <div className="p-3 border-t border-slate-800 space-y-1">
          <NavLink
            to="/profile"
            className={({ isActive }) =>
              clsx(
                "flex items-center gap-2 px-3 py-2 rounded-lg text-sm transition-colors w-full",
                isActive
                  ? "bg-slate-800 text-white"
                  : "text-slate-400 hover:bg-slate-800 hover:text-white"
              )
            }
          >
            <UserCircle className="w-4 h-4 flex-shrink-0" />
            My profile
          </NavLink>
          
          <div className="flex items-center gap-3 px-3 py-1.5">
            <div className="w-8 h-8 rounded-full bg-indigo-500 flex items-center justify-center text-white text-xs font-bold flex-shrink-0 border-2 border-slate-700">
              {user?.first_name?.[0]}{user?.last_name?.[0]}
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-white text-xs font-semibold truncate leading-tight">
                {user?.first_name} {user?.last_name}
              </p>
              <p className="text-slate-500 text-[10px] capitalize font-medium">{user?.role}</p>
            </div>
            <button
              onClick={() => { logout(); navigate("/login"); }}
              className="text-slate-400 hover:text-white transition-colors"
              title="Sign out"
            >
              <LogOut className="w-4 h-4" />
            </button>
          </div>
        </div>
      </aside>

      {/* Main Content Area */}
      <div className="flex-1 flex flex-col min-w-0">
        <header className="h-14 bg-white border-b border-gray-200 flex items-center justify-end px-6 gap-3 flex-shrink-0 shadow-sm">
          <button
            onClick={() => navigate("/notifications")}
            className="relative text-gray-500 hover:text-gray-700 p-1"
            title="Notifications"
          >
            <Bell className="w-5 h-5" />
            {unread > 0 && (
              <span className="absolute -top-0.5 -right-0.5 bg-red-500 text-white text-[9px] font-bold w-4 h-4 rounded-full flex items-center justify-center">
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