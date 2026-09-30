import { Suspense, useState, useMemo, useEffect, useRef } from "react";
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
  FileText,
  ShieldCheck,
  GitBranch,
  ChevronDown,
  Settings,
  PenTool,
  UserCheck,
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
    refetchInterval: 30_000,
    refetchOnWindowFocus: true,
  });
  const unreadCount = notificationsData?.count ?? 0;

  // Pending approval tasks count
  const { data: myTasks = [] } = useQuery({
    queryKey: ["workflow", "my-tasks"],
    queryFn: () => workflowAPI.myTasks().then((res) => res.data.results ?? res.data),
    ...QUERY_ONE_MINUTE_STALE,
    refetchInterval: 30_000,
    refetchOnWindowFocus: true,
  });
  const pendingApprovalsCount = myTasks.length;

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

  // Profile group (nested in sidebar + repeated in the header user menu)
  const profileItems = useMemo(
    () => [
      { tab: "delegation", label: "Delegations", icon: UserCheck },
      { tab: "signature", label: "Signatures", icon: PenTool },
      { tab: "settings", label: "Settings", icon: Settings },
    ],
    []
  );
  // Profile sections are tabs inside ProfilePage, driven by ?tab=
  const rawProfileTab = new URLSearchParams(location.search).get("tab");
  const activeProfileTab = !rawProfileTab || rawProfileTab === "security" ? "settings" : rawProfileTab;
  // Exact match for "/", otherwise the path itself or any child path.
  // (A bare startsWith("/") matched every route and kept Dashboard always active.)
  const isPathActive = (to: string) =>
    to === "/"
      ? location.pathname === "/"
      : location.pathname === to || location.pathname.startsWith(`${to}/`);

  const isProfileRoute = isPathActive("/profile");
  const [profileOpen, setProfileOpen] = useState(isProfileRoute);
  useEffect(() => {
    if (isProfileRoute) setProfileOpen(true);
  }, [isProfileRoute]);

  // Header user menu (tray)
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const userMenuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!userMenuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (userMenuRef.current && !userMenuRef.current.contains(e.target as Node)) {
        setUserMenuOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setUserMenuOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [userMenuOpen]);
  useEffect(() => {
    setUserMenuOpen(false);
  }, [location.pathname]);

  const displayName = user?.first_name || user?.email || "User";
  const roleLabel = user?.has_admin_access ? "Administrator" : "Procurement User";

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
            const isActive = isPathActive(item.to);
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

          {/* Profile (nested) */}
          {collapsed ? (
            <NavLink
              to="/profile"
              title="Profile"
              className={cn(
                "group flex items-center gap-3 px-3 py-2.5 text-sm font-medium transition-colors",
                isProfileRoute
                  ? "bg-[#287EAD] text-white shadow-sm"
                  : "text-[#D1D5DB] hover:bg-[#1F2937] hover:text-white"
              )}
            >
              <CircleUserRound className={cn("h-5 w-5 shrink-0", isProfileRoute ? "text-white" : "text-[#9AA5B1] group-hover:text-white")} />
            </NavLink>
          ) : (
            <div>
              <button
                type="button"
                onClick={() => setProfileOpen((o) => !o)}
                aria-expanded={profileOpen}
                className={cn(
                  "group flex w-full items-center gap-3 px-3 py-2.5 text-sm font-medium transition-colors",
                  isProfileRoute && !profileOpen
                    ? "bg-[#287EAD] text-white shadow-sm"
                    : "text-[#D1D5DB] hover:bg-[#1F2937] hover:text-white"
                )}
              >
                <CircleUserRound className={cn("h-5 w-5 shrink-0", isProfileRoute && !profileOpen ? "text-white" : "text-[#9AA5B1] group-hover:text-white")} />
                <span className="flex-1 truncate text-left">Profile</span>
                <ChevronDown className={cn("h-4 w-4 shrink-0 transition-transform", profileOpen && "rotate-180")} />
              </button>
              {profileOpen && (
                <div className="ml-5 mt-1 space-y-1 border-l border-[#1F2937] pl-2">
                  {profileItems.map((item) => {
                    const Icon = item.icon;
                    const isActive = isProfileRoute && activeProfileTab === item.tab;
                    return (
                      <NavLink
                        key={item.tab}
                        to={`/profile?tab=${item.tab}`}
                        className={cn(
                          "group flex items-center gap-3 px-3 py-2 text-[13px] font-medium transition-colors",
                          isActive
                            ? "bg-[#287EAD] text-white shadow-sm"
                            : "text-[#D1D5DB] hover:bg-[#1F2937] hover:text-white"
                        )}
                      >
                        <Icon className="h-4 w-4 shrink-0" />
                        <span className="truncate">{item.label}</span>
                      </NavLink>
                    );
                  })}
                </div>
              )}
            </div>
          )}

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
                const isActive = isPathActive(item.to);
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
              <>
                <button
                  type="button"
                  onClick={() => navigate("/admin/templates/new-document")}
                  className="inline-flex items-center gap-1.5 border border-[#287EAD] bg-white px-3 py-1 text-xs font-semibold text-[#287EAD] shadow-sm hover:bg-[#EEF3F7] transition-colors"
                >
                  <FileText className="h-3 w-3" />
                  New Document
                </button>
                <button
                  type="button"
                  onClick={() => navigate("/forms/new/builder")}
                  className="inline-flex items-center gap-1.5 bg-[#287EAD] px-3 py-1 text-xs font-semibold text-white shadow-sm hover:bg-[#1E6F99] transition-colors"
                >
                  <PlusCircle className="h-3 w-3" />
                  New Form
                </button>
              </>
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

            {/* User menu */}
            <div ref={userMenuRef} className="relative">
              <button
                type="button"
                onClick={() => setUserMenuOpen((o) => !o)}
                aria-haspopup="menu"
                aria-expanded={userMenuOpen}
                className="flex items-center gap-2 rounded px-2 py-1 text-[#1F2933] hover:bg-slate-100 transition-colors"
              >
                <CircleUserRound className="h-6 w-6 text-[#287EAD]" />
                <span className="hidden max-w-[10rem] truncate text-xs font-semibold sm:inline">{displayName}</span>
                <ChevronDown className={cn("h-3.5 w-3.5 text-[#5E6870] transition-transform", userMenuOpen && "rotate-180")} />
              </button>

              {userMenuOpen && (
                <div
                  role="menu"
                  className="absolute right-0 top-full z-50 mt-1 w-60 border border-[#E4E7EB] bg-white shadow-lg"
                >
                  <div className="border-b border-[#E4E7EB] px-3 py-2.5">
                    <p className="truncate text-sm font-semibold text-[#1F2933]">{displayName}</p>
                    {user?.email && user.email !== displayName && (
                      <p className="truncate text-xs text-[#5E6870]">{user.email}</p>
                    )}
                    <p className="mt-0.5 text-[10px] font-medium uppercase tracking-wider text-[#6B7280]">{roleLabel}</p>
                  </div>
                  <div className="py-1">
                    <NavLink
                      to="/profile"
                      role="menuitem"
                      className="flex items-center gap-2.5 px-3 py-2 text-sm text-[#1F2933] hover:bg-[#EEF3F7]"
                    >
                      <CircleUserRound className="h-4 w-4 text-[#5E6870]" />
                      Profile
                    </NavLink>
                  </div>
                  <div className="border-t border-[#E4E7EB] py-1">
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        setUserMenuOpen(false);
                        logout();
                      }}
                      className="flex w-full items-center gap-2.5 px-3 py-2 text-sm text-rose-600 hover:bg-rose-50"
                    >
                      <LogOut className="h-4 w-4" />
                      Sign out
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>
        </header>

        {/* Content Outlet */}
        <main className="flex min-h-0 flex-1 flex-col overflow-y-auto bg-[#F4F6F8]">
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