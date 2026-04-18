import { useState } from "react";
import { Outlet, NavLink, useNavigate, useLocation } from "react-router-dom";
import {
  LayoutDashboard, FileText, Upload, Search,
  GitBranch, ShieldCheck, Settings, LogOut,
  Bell, Users, Building2, UserCircle, Shield,
  ChevronDown, ChevronRight,
} from "lucide-react";
import { useAuthStore } from "../../store/authStore";
import { useQuery } from "@tanstack/react-query";
import { notificationsAPI, workflowAPI } from "../../services/api";
import { FlaxemLogo } from "./FlaxemLogo";
import clsx from "clsx";

// ── Types ─────────────────────────────────────────────────────────────────────

interface NavLeaf {
  to: string;
  icon: React.ElementType;
  label: string;
  exact?: boolean;
  roles?: string[];
}

interface NavGroup {
  icon: React.ElementType;
  label: string;
  prefix: string;          // any route starting with this is "active"
  roles?: string[];
  children: NavLeaf[];
}

type NavEntry = NavLeaf | NavGroup;

function isGroup(entry: NavEntry): entry is NavGroup {
  return "children" in entry;
}

// ── Navigation structure ──────────────────────────────────────────────────────

const mainNav: NavEntry[] = [
  {
    to: "/",
    icon: LayoutDashboard,
    label: "Dashboard",
    exact: true,
  } as NavLeaf,
  {
    to: "/notifications",
    icon: Bell,
    label: "Notifications",
  } as NavLeaf,

  // Documents group
  {
    icon: FileText,
    label: "Documents",
    prefix: "/documents",
    children: [
      { to: "/documents",        icon: FileText, label: "All documents" },
      { to: "/documents/upload", icon: Upload,   label: "Upload" },
      { to: "/search",           icon: Search,   label: "Search" },
    ],
  } as NavGroup,

  // Workflow group
  {
    icon: GitBranch,
    label: "Workflow",
    prefix: "/workflow",
    children: [
      { to: "/workflow",         icon: GitBranch, label: "My tasks" },
      { to: "/workflow/builder", icon: Settings,  label: "Builder", roles: ["admin"] },
    ],
  } as NavGroup,

  { to: "/audit", icon: ShieldCheck, label: "Audit trail" } as NavLeaf,
];

const adminNav: NavLeaf[] = [
  { to: "/admin/users",       icon: Users,       label: "Users",       roles: ["admin"] },
  { to: "/admin/departments", icon: Building2,   label: "Departments", roles: ["admin"] },
  { to: "/admin/groups",      icon: Shield,      label: "Groups",      roles: ["admin"] },
  { to: "/admin/settings",             icon: Settings,    label: "Settings",    roles: ["admin"] },
];

// ── NavGroup component ────────────────────────────────────────────────────────

function SidebarGroup({
  group,
  userRole,
  taskCount,
}: {
  group: NavGroup;
  userRole?: string;
  taskCount?: number;
}) {
  const location = useLocation();
  const isGroupActive = location.pathname.startsWith(group.prefix);
  const [open, setOpen] = useState(isGroupActive);

  // Filter children by role
  const visibleChildren = group.children.filter(
    (child) => !child.roles || (userRole && child.roles.includes(userRole))
  );

  if (visibleChildren.length === 0) return null;

  return (
    <div>
      {/* Group toggle button */}
      <button
        onClick={() => setOpen(!open)}
        className={clsx(
          "w-full flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium transition-colors",
          isGroupActive
            ? "text-white bg-slate-700"
            : "text-blue-100 hover:bg-slate-700 hover:text-white"
        )}
      >
        <group.icon className="w-4 h-4 flex-shrink-0" />
        <span className="flex-1 text-left">{group.label}</span>
        {open
          ? <ChevronDown className="w-3.5 h-3.5 flex-shrink-0 opacity-60" />
          : <ChevronRight className="w-3.5 h-3.5 flex-shrink-0 opacity-60" />}
      </button>

      {/* Children */}
      {open && (
        <div className="mt-0.5 ml-4 pl-3 border-l border-blue-600 space-y-0.5">
          {visibleChildren.map(({ to, icon: Icon, label, exact }) => {
            const badgeValue = to === "/workflow" ? taskCount : undefined;
            return (
              <NavLink
                key={to}
                to={to}
                end={exact}
                className={({ isActive }) =>
                  clsx(
                    "flex items-center gap-2.5 px-3 py-1.5 rounded-lg text-sm transition-colors",
                    isActive
                      ? "bg-red-600 text-white shadow-sm"
                      : "text-blue-200 hover:bg-slate-700 hover:text-white"
                  )
                }
              >
                <Icon className="w-3.5 h-3.5 flex-shrink-0" />
                <span className="flex-1">{label}</span>
                {badgeValue ? (
                  <span className="ml-auto inline-flex items-center justify-center rounded-full bg-white/10 px-2 py-0.5 text-[11px] font-semibold text-blue-100">
                    {badgeValue}
                  </span>
                ) : null}
              </NavLink>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ── User profile dropdown in topbar ──────────────────────────────────────────

function ProfileMenu() {
  const { user, logout } = useAuthStore();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);

  return (
    <div className="relative">
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-gray-100 transition-colors"
      >
        <div className="w-7 h-7 rounded-full bg-red-600 flex items-center justify-center text-white text-xs font-bold flex-shrink-0">
          {user?.first_name?.[0]}{user?.last_name?.[0]}
        </div>
        <div className="text-left hidden sm:block">
          <p className="text-xs font-semibold text-gray-800 leading-tight">
            {user?.first_name} {user?.last_name}
          </p>
          <p className="text-[10px] text-gray-500 capitalize">{user?.role}</p>
        </div>
        <ChevronDown className={clsx("w-3.5 h-3.5 text-gray-400 transition-transform", open && "rotate-180")} />
      </button>

      {open && (
        <>
          {/* Backdrop */}
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          {/* Dropdown */}
          <div className="absolute right-0 top-10 z-20 w-48 bg-white rounded-xl shadow-lg border border-gray-100 py-1 overflow-hidden">
            <div className="px-4 py-2.5 border-b border-gray-50">
              <p className="text-xs font-semibold text-gray-900">
                {user?.first_name} {user?.last_name}
              </p>
              <p className="text-[11px] text-gray-500">{user?.email}</p>
            </div>
            <button
              onClick={() => { setOpen(false); navigate("/profile"); }}
              className="flex items-center gap-2 w-full px-4 py-2 text-sm text-gray-700 hover:bg-gray-50 transition-colors"
            >
              <UserCircle className="w-4 h-4 text-gray-400" />
              My profile
            </button>
            <button
              onClick={() => { logout(); navigate("/login"); }}
              className="flex items-center gap-2 w-full px-4 py-2 text-sm text-red-600 hover:bg-red-50 transition-colors"
            >
              <LogOut className="w-4 h-4" />
              Sign out
            </button>
          </div>
        </>
      )}
    </div>
  );
}

// ── Layout ────────────────────────────────────────────────────────────────────

export default function Layout() {
  const { user } = useAuthStore();
  const navigate = useNavigate();

  const { data: notifications } = useQuery({
    queryKey: ["notifications"],
    queryFn: () => notificationsAPI.list().then((r) => r.data.results ?? r.data),
    refetchInterval: 30_000,
  });

  const { data: myTasks = [] } = useQuery({
    queryKey: ["workflow", "my-tasks"],
    queryFn: () => workflowAPI.myTasks().then((r) => r.data.results ?? r.data),
    refetchInterval: 30_000,
  });

  const unread = (notifications as { is_read: boolean }[] | undefined)
    ?.filter((n) => !n.is_read).length ?? 0;

  const pendingTasksCount = (myTasks as unknown[]).length;

  const visibleAdmin = adminNav.filter(
    (item) => !item.roles || (user && item.roles.includes(user.role))
  );

  return (
    <div className="flex h-screen bg-slate-100">

      {/* ── Sidebar ────────────────────────────────────────────────────── */}
      <aside className="w-64 flex-shrink-0 bg-slate-950 text-slate-100 flex flex-col shadow-2xl">

        {/* Logo */}
        <div className="h-16 flex items-center px-4 border-b border-blue-700">
          <FlaxemLogo variant="light" />
        </div>

        {/* Nav */}
        <nav className="flex-1 px-3 py-4 overflow-y-auto space-y-0.5">

          {/* Main nav — flat items and groups */}
          {mainNav.map((entry) => {
            if (isGroup(entry)) {
              // Check if the whole group should be hidden by role
              if (entry.roles && (!user || !entry.roles.includes(user.role))) return null;
              return (
                <SidebarGroup
                  key={entry.prefix}
                  group={entry}
                  userRole={user?.role}
                  taskCount={pendingTasksCount}
                />
              );
            }

            // Flat NavLeaf
            const { to, icon: Icon, label, exact, roles } = entry;
            if (roles && (!user || !roles.includes(user.role))) return null;

            const badgeValue = to === "/notifications" ? unread : undefined;

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
                      : "text-blue-100 hover:bg-slate-700 hover:text-white"
                  )
                }
              >
                <Icon className="w-4 h-4 flex-shrink-0" />
                <span className="flex-1">{label}</span>
                {badgeValue ? (
                  <span className="inline-flex items-center justify-center rounded-full bg-white/10 px-2 py-0.5 text-[11px] font-semibold text-blue-100">
                    {badgeValue}
                  </span>
                ) : null}
              </NavLink>
            );
          })}

          {/* Administration section */}
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
                        : "text-blue-100 hover:bg-slate-700 hover:text-white"
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
        {/* No footer — profile is in the topbar */}
      </aside>

      {/* ── Main area ──────────────────────────────────────────────────── */}
      <div className="flex-1 flex flex-col min-w-0">

        {/* Topbar */}
        <header className="h-14 bg-white border-b border-slate-200 flex items-center justify-end px-6 gap-3 flex-shrink-0 shadow-sm">

          {/* Notification bell */}
          <button
            onClick={() => navigate("/notifications")}
            className="relative text-gray-500 hover:text-blue-600 p-1.5 rounded-lg hover:bg-gray-100 transition-colors"
            title="Notifications"
          >
            <Bell className="w-5 h-5" />
            {unread > 0 && (
              <span className="absolute -top-0.5 -right-0.5 bg-red-600 text-white text-[9px] font-bold w-4 h-4 rounded-full flex items-center justify-center">
                {unread > 9 ? "9+" : unread}
              </span>
            )}
          </button>

          {/* Divider */}
          <div className="w-px h-6 bg-gray-200" />

          {/* Profile dropdown */}
          <ProfileMenu />
        </header>

        {/* Page content */}
        <main className="flex-1 overflow-y-auto p-6 bg-slate-100">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
