import { Suspense, useState, useMemo } from "react";
import { Outlet, NavLink, useNavigate, useLocation } from "react-router-dom";
import {
  LayoutDashboard,
  ClipboardList,
  PlusCircle,
  Building2,
  CheckCircle2,
  BarChart3,
  LogOut,
  ChevronLeft,
  ChevronRight,
  Bell,
  CircleUserRound,
  ExternalLink,
  ShieldCheck,
  FileText,
  GitBranch
} from "lucide-react";
import { useAuthStore } from "@/store/authStore";
import { useQuery } from "@tanstack/react-query";
import { notificationsAPI, workflowAPI, sunsystemsAPI } from "@/services/api";
import { QUERY_ONE_MINUTE_STALE } from "@/lib/reactQueryDefaults";
import { cn } from "@/lib/utils";
import { ChatLauncher } from "@/components/chat/ChatLauncher";
import dmsLogo from "@/assets/images/dmslogo4.png";

interface RequisitionLayoutProps {
  /** Optional white-label organization or brand name */
  brandName?: string;
}

export default function Layout({
  brandName = "Requisition Portal",
}: RequisitionLayoutProps) {
  const navigate = useNavigate();
  const location = useLocation();
  const { user, logout } = useAuthStore();
  const [collapsed, setCollapsed] = useState(false);

  // Notifications count
  const { data: notificationsData } = useQuery({
    queryKey: ["notifications", "unread-count"],
    queryFn: () => notificationsAPI.unreadCount().then((res) => res.data),
    ...QUERY_ONE_MINUTE_STALE,
  });
  const unreadCount = notificationsData?.count ?? 0;

  // Pending approval tasks count
  const { data: tasksData } = useQuery({
    queryKey: ["workflow-tasks", "pending"],
    queryFn: () => workflowAPI.listTasks({ status: "pending", page_size: 100 }).then((res) => res.data),
    ...QUERY_ONE_MINUTE_STALE,
  });
  const pendingApprovalsCount = tasksData?.results?.length ?? 0;

  // Live SunSystems connection status check
  const { data: sunConnection } = useQuery({
    queryKey: ["sunsystems", "connection-status"],
    queryFn: () => sunsystemsAPI.getConnection().then((res) => res.data),
    staleTime: 5 * 60_000,
    retry: false,
  });
  const isSunConnected = Boolean(sunConnection?.effective?.base_url);

  const hasAdminAccess = user?.has_admin_access;

  // Check if we're on the templates page
  const isTemplatesPage = location.pathname === "/admin/templates";

  const navItems = useMemo(
    () => [
      {
        to: "/",
        label: "Dashboard",
        icon: LayoutDashboard,
      },
      {
        to: "/list",
        label: "All Requisitions",
        icon: ClipboardList,
      },
      {
        to: "/new",
        label: "New Requisition",
        icon: PlusCircle,
        badge: "Create",
        highlight: true,
      },
      {
        to: "/approvals",
        label: "Approvals Queue",
        icon: CheckCircle2,
        count: pendingApprovalsCount,
      },
      {
        to: "/notifications",
        label: "Notifications",
        icon: Bell,
        count: unreadCount,
      },
      {
        to: "/suppliers",
        label: "SunSystems Suppliers",
        icon: Building2,
      },
      {
        to: "/analytics",
        label: "Spend Analytics",
        icon: BarChart3,
      },
      {
        to: "/profile",
        label: "Profile",
        icon: CircleUserRound,
      },
    ],
    [pendingApprovalsCount, unreadCount]
  );

  const adminNavItems = useMemo(
    () => [
      {
        to: "/admin/templates",
        label: "Templates",
        icon: FileText,
      },
      {
        to: "/forms/new/builder",
        label: "Form Builder",
        icon: FileText,
      },
      {
        to: "/admin/users",
        label: "Users",
        icon: CircleUserRound,
      },
      {
        to: "/admin/departments",
        label: "Departments",
        icon: Building2,
      },
      {
        to: "/admin/groups",
        label: "Groups",
        icon: ShieldCheck,
      },
      {
        to: "/admin/mailboxes",
        label: "Email Ingestion",
        icon: Bell,
      },
      {
        to: "/admin/sunsystems",
        label: "SunSystems",
        icon: ExternalLink,
      },
      {
        to: "/workflow/builder",
        label: "Workflow Builder",
        icon: GitBranch,
      },
    ],
    []
  );

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-[#F4F6F8] font-sans antialiased text-[#1F2933]">
      {/* ── Scoped Sidebar ── */}
      <aside
        className={cn(
          "relative flex flex-col border-r border-[#E4E7EB] bg-[#111927] text-[#9AA5B1] transition-all duration-200 z-30 select-none",
          collapsed ? "w-16" : "w-64"
        )}
      >
        {/* Brand / Logo Header */}
        <div className="flex h-16 items-center justify-between border-b border-[#1F2937] px-4">
          <div className="flex items-center gap-3 overflow-hidden">
            {!collapsed && (
              <div className="flex flex-col truncate">
                <span className="truncate text-sm font-bold tracking-tight text-white">
                  {brandName}
                </span>
                 <span className="text-[10px] font-medium uppercase tracking-wider text-[#6B7280]">
                  Procurement
                </span>
              </div>
            )}
          </div>

          <button
            type="button"
            onClick={() => setCollapsed(!collapsed)}
            className="rounded p-1 text-[#9AA5B1] hover:bg-[#1F2937] hover:text-white"
            title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          >
            {collapsed ? <ChevronRight className="h-4 w-4" /> : <ChevronLeft className="h-4 w-4" />}
          </button>
        </div>

        {/* Live SunSystems Connection Badge */}
        {!collapsed && (
          <div className="mx-3 mt-3 rounded-md bg-[#1F2937]/70 p-2 text-xs flex items-center justify-between border border-[#374151]">
            <div className="flex items-center gap-2">
              <span className={cn("h-2 w-2 rounded-full", isSunConnected ? "bg-emerald-400" : "bg-amber-400")} />
              <span className="text-[11px] text-[#D1D5DB] font-medium">SunSystems ERP</span>
            </div>
            <span className="text-[10px] font-mono text-[#9CA3AF]">
              {isSunConnected ? "Live Link" : "Standby"}
            </span>
          </div>
        )}

        {/* Navigation Links */}
        <nav className="flex-1 space-y-1.5 overflow-y-auto px-2 py-4">
          {navItems.map((item) => {
            const Icon = item.icon;
            const isActive = location.pathname === item.to || (item.to !== "/requisitions" && location.pathname.startsWith(item.to));
            return (
              <NavLink
                key={item.to}
                to={item.to}
                className={cn(
                  "group flex items-center gap-3 px-3 py-2.5 text-sm font-medium transition-colors relative",
                  isActive
                    ? "bg-[#287EAD] text-white shadow-sm"
                    : "text-[#D1D5DB] hover:bg-[#1F2937] hover:text-white",
                  item.highlight && !isActive && "text-[#54B3E5] hover:bg-[#1F2937]"
                )}
                title={collapsed ? item.label : undefined}
              >
                <Icon className={cn("h-5 w-5 shrink-0", isActive ? "text-white" : "text-[#9AA5B1] group-hover:text-white")} />
                {!collapsed && (
                  <span className="truncate flex-1">{item.label}</span>
                )}
                {!collapsed && item.count !== undefined && item.count > 0 && (
                  <span className="rounded-full bg-amber-500/20 px-2 py-0.5 text-xs font-semibold text-amber-300">
                    {item.count}
                  </span>
                )}
                {!collapsed && item.badge && !isActive && (
                  <span className="rounded bg-[#287EAD]/20 px-1.5 py-0.5 text-[10px] font-semibold text-[#54B3E5]">
                    {item.badge}
                  </span>
                )}
              </NavLink>
            );
          })}

          {/* Admin Navigation (for administrators only) */}
          {hasAdminAccess && (
            <>
              {!collapsed && (
                <div className="mt-4 px-3 py-2">
                  <p className="text-[10px] font-semibold uppercase tracking-wider text-[#6B7280]">
                    Administration
                  </p>
                </div>
              )}
              {adminNavItems.map((item) => {
                const Icon = item.icon;
                const isActive = location.pathname === item.to || (item.to !== "/workflow/builder" && location.pathname.startsWith(item.to));
                return (
                  <NavLink
                    key={item.to}
                    to={item.to}
                    className={cn(
                      "group flex items-center gap-3 px-3 py-2.5 text-sm font-medium transition-colors relative",
                      isActive
                        ? "bg-[#287EAD] text-white shadow-sm"
                        : "text-[#D1D5DB] hover:bg-[#1F2937] hover:text-white"
                    )}
                    title={collapsed ? item.label : undefined}
                  >
                    <Icon className={cn("h-5 w-5 shrink-0", isActive ? "text-white" : "text-[#9AA5B1] group-hover:text-white")} />
                    {!collapsed && (
                      <span className="truncate flex-1">{item.label}</span>
                    )}
                  </NavLink>
                );
              })}
            </>
          )}
        </nav>

        {/* Scoped Sidebar Footer */}
        <div className="border-t border-[#1F2937] p-3 space-y-2">
          <div className={cn("flex items-center gap-3 rounded-lg bg-[#1F2937]/50 p-2", collapsed && "justify-center")}>
            <CircleUserRound className="h-7 w-7 shrink-0 text-[#287EAD]" />
            {!collapsed && (
              <div className="flex-1 min-w-0">
                <p className="truncate text-xs font-semibold text-white">{user?.first_name || user?.email || "User"}</p>
                <p className="truncate text-[10px] text-[#9AA5B1]">{user?.has_admin_access ? "Administrator" : "Procurement User"}</p>
              </div>
            )}
            {!collapsed && (
              <button
                type="button"
                onClick={() => logout()}
                className="text-[#9AA5B1] hover:text-rose-400 p-1"
                title="Log out"
              >
                <LogOut className="h-4 w-4" />
              </button>
            )}
          </div>
        </div>
      </aside>

      {/* ── Main Work Area ── */}
      <div className="flex flex-1 flex-col overflow-hidden">
        {/* Top Header Bar */}
        <header className="flex h-12 shrink-0 items-center justify-between border-b border-[#E4E7EB] bg-white px-4 shadow-sm z-20">
          <div className="flex items-center gap-3">
            <img src={dmsLogo} alt={brandName} className="h-9 w-auto object-contain" />
            <h2 className="text-base font-bold tracking-tight text-[#1F2933]">
              {location.pathname.includes("/new")
                ? "New Requisition"
                : location.pathname.includes("/suppliers")
                ? "SunSystems Suppliers & Vendors"
                : location.pathname.includes("/approvals")
                ? "Requisition Approvals Queue"
                : location.pathname.includes("/analytics")
                ? "Procurement Spend Analytics"
                : location.pathname.includes("/dashboard")
                ? "Requisition Dashboard"
                : "Requisitions Register"}
            </h2>
          </div>

          <div className="flex items-center gap-3">
            {/* Templates page actions */}
            {isTemplatesPage && (
              <button
                type="button"
                onClick={() => navigate("/forms/new/builder")}
                className="inline-flex items-center gap-1.5 bg-[#287EAD] px-3 py-1 text-xs font-semibold text-white shadow-sm hover:bg-[#1E6F99] transition-colors"
              >
                <PlusCircle className="h-3 w-3" />
                New Form
              </button>
            )}

            {/* Direct Create Requisition Shortcut */}
            {!location.pathname.includes("/new") && !isTemplatesPage && (
              <button
                type="button"
                onClick={() => navigate("/new")}
                className="inline-flex items-center gap-1.5 bg-[#287EAD] px-3 py-1 text-xs font-semibold text-white shadow-sm hover:bg-[#1E6F99] transition-colors"
              >
                <PlusCircle className="h-3 w-3" />
                Raise Requisition
              </button>
            )}

            {/* Chat Launcher */}
            <ChatLauncher variant="light" />

            {/* Notification Bell */}
            <button
              type="button"
              onClick={() => navigate("/notifications")}
              className="relative rounded-full p-1.5 text-[#5E6870] hover:bg-slate-100 transition-colors"
              title="Notifications"
            >
              <Bell className="h-4 w-4" />
              {unreadCount > 0 && (
                <span className="absolute right-1 top-1 flex h-2 w-2 rounded-full bg-rose-500" />
              )}
            </button>
          </div>
        </header>

        {/* Content Outlet */}
        <main className="flex-1 overflow-y-auto bg-[#F4F6F8]">
          <Suspense
            fallback={
              <div className="flex h-64 items-center justify-center">
                <div className="h-8 w-8 animate-spin rounded-full border-4 border-[#287EAD] border-t-transparent" />
              </div>
            }
          >
            <Outlet />
          </Suspense>
        </main>
      </div>
    </div>
  );
}