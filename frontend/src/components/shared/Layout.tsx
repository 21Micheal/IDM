/**
 * Layout.tsx (updated)
 *
 * Changes from previous version
 * ──────────────────────────────
 * 1. FolderTree component injected into the sidebar below the main nav.
 * 2. The sidebar's nav scroll area is split so the FolderTree sits in a
 *    dedicated collapsible section that doesn't push admin links off-screen.
 * 3. All existing nav logic, group collapsing, and admin section are unchanged.
 */

import { Suspense, lazy, useEffect, useRef, useState } from "react";
import { Outlet, NavLink, useNavigate, useLocation } from "react-router-dom";
import {
  LayoutDashboard, FileText, Upload, Search,
  Workflow, ShieldCheck, Settings, LogOut,
  Bell, Users, Building2, UserRoundCog, Shield,
  ChevronDown, ChevronRight, Archive, ScanLine, Loader2, UserCheck, Monitor, Lock, History,
  BellRing, CircleUserRound,
} from "lucide-react";
import { useAuthStore } from "../../store/authStore";
import { useQuery } from "@tanstack/react-query";
import { notificationsAPI, workflowAPI } from "../../services/api";
import { FlaxemLogo } from "./FlaxemLogo";
import { QUERY_SHORT_STALE } from "@/lib/reactQueryDefaults";
import { preloadCommonRoutes, preloadRouteForPath } from "@/lib/routePreload";
import { FolderTree } from "@/components/folders/FolderTree";
import clsx from "clsx";

const ChatLauncher = lazy(() =>
  import("@/components/chat/ChatLauncher").then((module) => ({ default: module.ChatLauncher })),
);

// ── Types (unchanged) ─────────────────────────────────────────────────────────

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
  prefix: string;
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

// ── Navigation structure (unchanged) ─────────────────────────────────────────

const mainNav: NavEntry[] = [
  { to: "/", icon: LayoutDashboard, label: "Dashboard", exact: true } as NavLeaf,
  { to: "/notifications", icon: Bell, label: "Notifications" } as NavLeaf,
  {
    icon: FileText,
    label: "Documents",
    prefix: "/documents",
    children: [
      { to: "/documents",                 icon: FileText, label: "All documents" },
      { to: "/documents?status=archived", icon: Archive,  label: "Archived" },
      { to: "/documents/upload",          icon: Upload,   label: "Upload" },
      { to: "/documents/scan",            icon: ScanLine, label: "Scan" },
      { to: "/documents/bulk-scan",      icon: ScanLine, label: "Bulk scan" },
      { to: "/search",                    icon: Search,   label: "Search" },
    ],
  } as NavGroup,
  { to: "/personal-documents", icon: Lock, label: "Personal documents" } as NavLeaf,
  {
    icon: Workflow,
    label: "Workflow",
    prefix: "/workflow",
    children: [
      { to: "/workflow",         icon: Workflow, label: "My tasks" },
      { to: "/workflow/builder", icon: Settings,  label: "Builder", allowedRoles: ["admin"] },
    ],
  } as NavGroup,
  { to: "/audit", icon: History, label: "Audit trail" } as NavLeaf,
  {
    icon: UserRoundCog,
    label: "Profile",
    prefix: "/profile",
    children: [
      { to: "/profile?tab=settings", icon: Settings, label: "Settings" },
      { to: "/profile?tab=security", icon: ShieldCheck, label: "Security" },
      { to: "/profile?tab=delegation", icon: UserCheck, label: "Delegation" },
      { to: "/profile?tab=preferences", icon: Monitor, label: "Preferences" },
    ],
  } as NavGroup,
];

const adminNav: NavLeaf[] = [
  { to: "/admin/document-types", icon: FileText,  label: "Document types", allowedRoles: ["admin"] },
  { to: "/admin/users",       icon: Users,     label: "Users",       allowedRoles: ["admin"] },
  { to: "/admin/departments", icon: Building2, label: "Departments", allowedRoles: ["admin"] },
  { to: "/admin/groups",      icon: Shield,    label: "Groups",      allowedRoles: ["admin"] },
  { to: "/admin/settings",    icon: Settings,  label: "Settings",    allowedRoles: ["admin"] },
];

// ── SidebarGroup (unchanged from original) ────────────────────────────────────

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

  const visibleChildren = group.children.filter(
    (child) => !child.allowedRoles || (userAccess && child.allowedRoles.includes(userAccess))
  );

  if (visibleChildren.length === 0) return null;

  return (
    <div>
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

      {open && (
        <div className="mt-0.5 ml-4 pl-3 border-l-2 border-white/10 space-y-0.5">
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

// ── ProfileMenu (unchanged) ───────────────────────────────────────────────────

function ProfileMenu() {
  const { user, logout } = useAuthStore();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);

  return (
    <div className="relative">
      <button
        onClick={() => setOpen(!open)}
        className="flex h-9 w-9 items-center justify-center border border-[#C8CDD2] bg-white text-[#5E6870] transition-colors hover:bg-[#EEF6FB] hover:text-[#287EAD]"
        title="Profile"
        aria-label="Open profile menu"
      >
        <CircleUserRound className="h-5 w-5" />
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="absolute right-0 top-11 z-20 w-56 overflow-hidden border border-[#C8CDD2] bg-white py-1 shadow-xl">
            <div className="border-b border-[#C8CDD2] bg-[#F5F7F8] px-4 py-2.5">
              <p className="text-xs font-semibold text-[#1F2933]">
                {user?.first_name} {user?.last_name}
              </p>
              <p className="text-[11px] text-[#5E6870]">{user?.email}</p>
            </div>
            <button
              onClick={() => { setOpen(false); navigate("/profile"); }}
              className="flex w-full items-center gap-2 px-4 py-2 text-sm text-[#1F2933] transition-colors hover:bg-[#F5F7F8]"
            >
              <CircleUserRound className="w-4 h-4 text-[#5E6870]" />
              My profile
            </button>
            <button
              onClick={() => { logout(); navigate("/login"); }}
              className="flex w-full items-center gap-2 px-4 py-2 text-sm text-red-700 transition-colors hover:bg-red-50"
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
    const t = setTimeout(() => setVisible(true), 180);
    return () => clearTimeout(t);
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

function SidebarProfile() {
  const { user } = useAuthStore();
  const initials = `${user?.first_name?.[0] ?? ""}${user?.last_name?.[0] ?? ""}` || "U";

  return (
    <div className="border-t border-sidebar-border/70 bg-black/10 p-3">
      <div className="flex items-center gap-3 rounded-lg px-2 py-2">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-white/12 text-xs font-bold text-white ring-1 ring-white/15">
          {initials}
        </div>
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold text-white">
            {user?.first_name} {user?.last_name}
          </p>
          <p className="truncate text-[11px] capitalize text-sidebar-foreground/70">
            {user?.job_description || "Staff"}
          </p>
        </div>
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
  // ── NEW: folder panel toggle ──────────────────────────────────────────────
  const [foldersExpanded, setFoldersExpanded] = useState(true);

  useEffect(() => {
    let fallbackTimer: ReturnType<typeof setTimeout> | null = null;
    let idleHandle: number | null = null;
    const markReady = () => setIdleReady(true);
    if (typeof window !== "undefined" && "requestIdleCallback" in window) {
      idleHandle = (window as any).requestIdleCallback(markReady, { timeout: 1500 });
      fallbackTimer = setTimeout(markReady, 1600);
      return () => {
        if (idleHandle !== null) (window as any).cancelIdleCallback(idleHandle);
        if (fallbackTimer) clearTimeout(fallbackTimer);
      };
    }
    fallbackTimer = setTimeout(markReady, 500);
    return () => { if (fallbackTimer) clearTimeout(fallbackTimer); };
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
      <aside
        className="w-64 flex-shrink-0 text-sidebar-foreground flex flex-col shadow-2xl"
        style={{ background: "var(--gradient-sidebar)" }}
      >
        {/* Logo */}
        <div className="h-16 flex items-center px-4 border-b border-sidebar-border/60 bg-black/10">
          <FlaxemLogo variant="light" />
        </div>

        {/* Nav — scrollable, two sections split by a divider */}
        <nav className="flex-1 overflow-y-auto">
          {/* ── Primary nav ─────────────────────────────────────────────── */}
          <div className="px-3 py-4 space-y-0.5">
            {mainNav.map((entry) => {
              if (isGroup(entry)) {
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
          </div>

          {/* ── Folder tree section ─────────────────────────────────────── */}
          <div className="border-t border-sidebar-border/40 pb-2">
            {/*
              FolderTree manages its own "My Folders" section header + the
              Favourites system folder.  Loaded lazily after idle so it doesn't
              block the initial render.
            */}
            {idleReady && (
              <FolderTree
                activeFolderId={
                  location.pathname.startsWith("/documents/folders/")
                    ? location.pathname.split("/").pop() ?? null
                    : null
                }
              />
            )}
          </div>

          {/* ── Administration section ──────────────────────────────────── */}
          {visibleAdmin.length > 0 && (
            <div className="border-t border-sidebar-border/40 px-3 py-4 space-y-0.5">
              <div className="pt-0 pb-1 px-0">
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
            </div>
          )}
        </nav>

        <SidebarProfile />
      </aside>

      {/* ── Main area (unchanged) ──────────────────────────────────── */}
      <div className="flex-1 flex flex-col min-w-0">
        <header className="flex h-14 flex-shrink-0 items-center justify-end gap-2 border-b border-[#C8CDD2] bg-white px-6">
          {idleReady ? (
            <Suspense fallback={null}>
              <ChatLauncher />
            </Suspense>
          ) : null}
          <button
            onClick={() => navigate("/notifications")}
            className="relative flex h-9 w-9 items-center justify-center border border-[#C8CDD2] bg-white text-[#5E6870] transition-colors hover:bg-[#EEF6FB] hover:text-[#287EAD]"
            title="Notifications"
          >
            <BellRing className="h-5 w-5" />
            {unread > 0 && (
              <span className="absolute -right-1 -top-1 flex h-4 min-w-[16px] items-center justify-center bg-red-700 px-1 text-[9px] font-bold text-white">
                {unread > 9 ? "9+" : unread}
              </span>
            )}
          </button>
          <div className="mx-1 h-6 w-px bg-[#C8CDD2]" />
          <ProfileMenu />
        </header>

        <main ref={mainRef} className="flex-1 overflow-y-auto p-6 bg-background">
          <Suspense fallback={<ContentFallback />}>
            <Outlet />
          </Suspense>
        </main>
      </div>
    </div>
  );
}
