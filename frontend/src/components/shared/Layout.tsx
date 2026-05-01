import { Suspense, lazy, useEffect, useRef, useState } from "react";
import { Outlet, NavLink, useNavigate, useLocation } from "react-router-dom";
import {
  LayoutDashboard, FileText, Upload, Search,
  GitBranch, ShieldCheck, Settings, LogOut,
  Bell, Users, Building2, UserCircle, Shield,
  ChevronDown, ChevronRight, Archive, ScanLine, Loader2,
} from "lucide-react";
import { useAuthStore } from "../../store/authStore";
import { useQuery } from "@tanstack/react-query";
import { notificationsAPI, workflowAPI } from "../../services/api";
import { FlaxemLogo } from "./FlaxemLogo";
import { QUERY_SHORT_STALE } from "@/lib/reactQueryDefaults";
import { preloadCommonRoutes, preloadRouteForPath } from "@/lib/routePreload";
import clsx from "clsx";

const ChatLauncher = lazy(() =>
  import("@/components/chat/ChatLauncher").then((module) => ({ default: module.ChatLauncher })),
);

// ── Types ─────────────────────────────────────────────────────────────────────

interface NavLeaf {
  to: string;
  icon: React.ElementType;
  label: string;
  exact?: boolean;
  allowedRoles?: string[];
}

interface NavGroup {
  icon: React.ElementType;
  label: string;
  prefix: string;          // any route starting with this is "active"
  allowedRoles?: string[];
  children: NavLeaf[];
}

type NavEntry = NavLeaf | NavGroup;

function isGroup(entry: NavEntry): entry is NavGroup {
  return "children" in entry;
}

function navTarget(to: string) {
  const [pathname, rawSearch] = to.split("?");
  return {
    pathname,
    search: rawSearch ? `?${rawSearch}` : "",
  };
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
      { to: "/documents?status=archived", icon: Archive, label: "Archived" },
      { to: "/documents/upload", icon: Upload,   label: "Upload" },
      { to: "/documents/scan",   icon: ScanLine, label: "Scan" },
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
      { to: "/workflow/builder", icon: Settings,  label: "Builder", allowedRoles: ["admin"] },
    ],
  } as NavGroup,

  { to: "/audit", icon: ShieldCheck, label: "Audit trail" } as NavLeaf,
];

const adminNav: NavLeaf[] = [
  { to: "/admin/users",       icon: Users,       label: "Users",       allowedRoles: ["admin"] },
  { to: "/admin/departments", icon: Building2,   label: "Departments", allowedRoles: ["admin"] },
  { to: "/admin/groups",      icon: Shield,      label: "Groups",      allowedRoles: ["admin"] },
  { to: "/admin/settings",             icon: Settings,    label: "Settings",    allowedRoles: ["admin"] },
];

// ── NavGroup component ────────────────────────────────────────────────────────

function SidebarGroup({
  group,
  userAccess,
  taskCount,
  onWarmRoute,
}: {
  group: NavGroup;
  userAccess?: string;
  taskCount?: number;
  onWarmRoute?: (to: string) => void;
}) {
  const location = useLocation();
  const isGroupActive = location.pathname.startsWith(group.prefix);
  const [open, setOpen] = useState(isGroupActive);

  // Filter children by admin access
  const visibleChildren = group.children.filter(
    (child) => !child.allowedRoles || (userAccess && child.allowedRoles.includes(userAccess))
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
            ? "bg-sidebar-accent text-sidebar-accent-foreground"
            : "text-sidebar-foreground hover:bg-sidebar-accent/50"
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
        <div className="mt-0.5 ml-4 pl-3 border-l border-sidebar-border space-y-0.5">
          {visibleChildren.map(({ to, icon: Icon, label, exact }) => {
            const badgeValue = to === "/workflow" ? taskCount : undefined;
            const target = navTarget(to);
            const isChildActive =
              location.pathname === target.pathname &&
              (target.search ? location.search === target.search : !location.search);

            return (
              <NavLink
                key={to}
                to={to}
                end={exact}
                onMouseEnter={() => onWarmRoute?.(to)}
                onFocus={() => onWarmRoute?.(to)}
                className={() =>
                  clsx(
                    "flex items-center gap-2.5 px-3 py-1.5 rounded-lg text-sm transition-all duration-200",
                    isChildActive
                      ? "bg-sidebar-primary text-sidebar-primary-foreground shadow-sm"
                      : "text-sidebar-foreground hover:bg-sidebar-accent/50"
                  )
                }
              >
                <Icon className="w-3.5 h-3.5 flex-shrink-0" />
                <span className="flex-1">{label}</span>
                {badgeValue ? (
                  <span className="ml-auto inline-flex items-center justify-center rounded-full bg-sidebar-ring px-2 py-0.5 text-[10px] font-bold text-white shadow-sm">
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
        className="flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-muted transition-colors"
      >
        <div className="w-7 h-7 rounded-full bg-primary flex items-center justify-center text-primary-foreground text-xs font-bold flex-shrink-0">
          {user?.first_name?.[0]}{user?.last_name?.[0]}
        </div>
        <div className="text-left hidden sm:block">
          <p className="text-xs font-semibold text-foreground leading-tight">
            {user?.first_name} {user?.last_name}
          </p>
          <p className="text-[10px] text-muted-foreground capitalize">{user?.job_description || "Staff"}</p>
        </div>
        <ChevronDown className={clsx("w-3.5 h-3.5 text-muted-foreground transition-transform", open && "rotate-180")} />
      </button>

      {open && (
        <>
          {/* Backdrop */}
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          {/* Dropdown */}
          <div className="absolute right-0 top-10 z-20 w-48 bg-card rounded-xl shadow-lg border border-border py-1 overflow-hidden">
            <div className="px-4 py-2.5 border-b border-border">
              <p className="text-xs font-semibold text-foreground">
                {user?.first_name} {user?.last_name}
              </p>
              <p className="text-[11px] text-muted-foreground">{user?.email}</p>
            </div>
            <button
              onClick={() => { setOpen(false); navigate("/profile"); }}
              className="flex items-center gap-2 w-full px-4 py-2 text-sm text-foreground hover:bg-muted transition-colors"
            >
              <UserCircle className="w-4 h-4 text-muted-foreground" />
              My profile
            </button>
            <button
              onClick={() => { logout(); navigate("/login"); }}
              className="flex items-center gap-2 w-full px-4 py-2 text-sm text-destructive hover:bg-destructive/10 transition-colors"
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

function ContentFallback() {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const timer = setTimeout(() => setVisible(true), 180);
    return () => clearTimeout(timer);
  }, []);

  if (!visible) return null;

  return (
    <div className="flex min-h-[18rem] items-center justify-center rounded-xl border border-border bg-card">
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        <span>Loading page...</span>
      </div>
    </div>
  );
}

// ── Layout ────────────────────────────────────────────────────────────────────

export default function Layout() {
  const { user } = useAuthStore();
  const navigate = useNavigate();
  const location = useLocation();
  const mainRef = useRef<HTMLElement | null>(null);
  const hasAdminAccess = Boolean(user?.has_admin_access);
  const [idleReady, setIdleReady] = useState(false);

  useEffect(() => {
    let fallbackTimer: ReturnType<typeof setTimeout> | null = null;
    let idleHandle: number | null = null;
    const markReady = () => setIdleReady(true);

    if (typeof window !== "undefined" && "requestIdleCallback" in window) {
      idleHandle = (window as any).requestIdleCallback(markReady, { timeout: 1500 });
      fallbackTimer = setTimeout(markReady, 1600);
      return () => {
        if (idleHandle !== null) {
          (window as any).cancelIdleCallback(idleHandle);
        }
        if (fallbackTimer) clearTimeout(fallbackTimer);
      };
    }

    fallbackTimer = setTimeout(markReady, 500);
    return () => {
      if (fallbackTimer) clearTimeout(fallbackTimer);
    };
  }, []);

  const { data: notifications } = useQuery({
    queryKey: ["notifications"],
    queryFn: () => notificationsAPI.list().then((r) => r.data.results ?? r.data),
    refetchInterval: 30_000,
    enabled: idleReady,
    ...QUERY_SHORT_STALE,
  });

  const { data: myTasks = [] } = useQuery({
    queryKey: ["workflow", "my-tasks"],
    queryFn: () => workflowAPI.myTasks().then((r) => r.data.results ?? r.data),
    refetchInterval: 30_000,
    enabled: idleReady,
    ...QUERY_SHORT_STALE,
  });

  const unread = (notifications as { is_read: boolean }[] | undefined)
    ?.filter((n) => !n.is_read).length ?? 0;

  const pendingTasksCount = (myTasks as unknown[]).length;

  useEffect(() => {
    mainRef.current?.scrollTo({ top: 0, behavior: "auto" });
  }, [location.pathname]);

  const visibleAdmin = adminNav.filter(
    (item) => !item.allowedRoles || hasAdminAccess
  );
  const warmRoute = (to: string) => preloadRouteForPath(navTarget(to).pathname);

  useEffect(() => {
    if (!idleReady) return;
    preloadCommonRoutes();
  }, [idleReady]);

  return (
    <div className="flex h-screen bg-background text-foreground">

      {/* ── Sidebar ────────────────────────────────────────────────────── */}
      <aside className="w-64 flex-shrink-0 bg-sidebar text-sidebar-foreground flex flex-col shadow-2xl">

        {/* Logo */}
        <div className="h-16 flex items-center px-4 border-b border-sidebar-border">
          <FlaxemLogo variant="light" />
        </div>

        {/* Nav */}
        <nav className="flex-1 px-3 py-4 overflow-y-auto space-y-0.5">

          {/* Main nav — flat items and groups */}
          {mainNav.map((entry) => {
            if (isGroup(entry)) {
              // Check if the whole group should be hidden by admin access
              if (entry.allowedRoles && !hasAdminAccess) return null;
              return (
                <SidebarGroup
                  key={entry.prefix}
                  group={entry}
                  userAccess={hasAdminAccess ? "admin" : undefined}
                  taskCount={pendingTasksCount}
                  onWarmRoute={warmRoute}
                />
              );
            }

            // Flat NavLeaf
            const { to, icon: Icon, label, exact, allowedRoles } = entry;
            if (allowedRoles && !hasAdminAccess) return null;

            const badgeValue = to === "/notifications" ? unread : undefined;

            return (
              <NavLink
                key={to}
                to={to}
                end={exact}
                onMouseEnter={() => warmRoute(to)}
                onFocus={() => warmRoute(to)}
                className={({ isActive }) =>
                  clsx(
                    "flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium transition-all duration-200",
                    isActive
                      ? "bg-sidebar-primary text-sidebar-primary-foreground shadow-md ring-1 ring-white/10"
                      : "text-sidebar-foreground hover:bg-sidebar-accent/50"
                  )
                }
              >
                <Icon className="w-4 h-4 flex-shrink-0" />
                <span className="flex-1">{label}</span>
                {badgeValue ? (
                  <span className="inline-flex items-center justify-center rounded-full bg-sidebar-ring px-2 py-0.5 text-[10px] font-bold text-white shadow-sm">
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
                <p className="text-[10px] font-semibold uppercase tracking-widest text-sidebar-foreground/60">
                  Administration
                </p>
              </div>
              {visibleAdmin.map(({ to, icon: Icon, label }) => (
                <NavLink
                  key={to}
                  to={to}
                  onMouseEnter={() => warmRoute(to)}
                  onFocus={() => warmRoute(to)}
                  className={({ isActive }) =>
                    clsx(
                      "flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium transition-colors",
                      isActive
                        ? "bg-sidebar-primary text-sidebar-primary-foreground shadow-md"
                        : "text-sidebar-foreground hover:bg-sidebar-accent/50"
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
        <header
          className="h-14 bg-card border-b border-border flex items-center justify-end px-6 gap-3 flex-shrink-0"
          style={{ boxShadow: "var(--shadow-card)" }}
        >
          <button
            onClick={() => navigate("/notifications")}
            className="relative text-muted-foreground hover:text-foreground p-1.5 rounded-md hover:bg-muted transition-colors"
            title="Notifications"
          >
            <Bell className="w-5 h-5" />
            {unread > 0 && (
              <span className="absolute -top-0.5 -right-0.5 bg-destructive text-destructive-foreground text-[9px] font-bold w-4 h-4 rounded-full flex items-center justify-center">
                {unread > 9 ? "9+" : unread}
              </span>
            )}
          </button>

          <div className="w-px h-6 bg-border" />

          <ProfileMenu />
        </header>

        <main className="flex-1 overflow-y-auto p-6 bg-background">
          <Suspense fallback={<ContentFallback />}>
            <Outlet />
          </Suspense>
        </main>
      </div>

      {/* Floating chat — mounted after initial page settles */}
      {idleReady ? (
        <Suspense fallback={null}>
          <ChatLauncher />
        </Suspense>
      ) : null}
    </div>
  );
}
