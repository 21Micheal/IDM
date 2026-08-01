/**
 * Layout.tsx (updated)
 *
 * Changes from previous version
 * ──────────────────────────────
 * 1. FolderTree component injected into the sidebar below the main nav.
 * 2. The sidebar's nav scroll area is split so the FolderTree sits in a
 *    dedicated collapsible section that doesn't push admin links off-screen.
 * 3. All existing nav logic, group collapsing, and admin section are unchanged.
 *
 * Forms-area changes (this pass)
 * ────────────────────────────────
 * 4. New "Forms" top-level nav item pointing at /forms (the dedicated Forms
 *    landing page — see FormsPage.tsx / FormDetailPage.tsx). Placed right
 *    under the Documents group since forms are still document records under
 *    the hood, just presented through their own workspace. There's no
 *    "/forms/new" route — creating a form is a modal (NewFormModal) launched
 *    from FormsPage itself, not a separate page.
 * 5. `isFullWidthByDefaultRoute` now also recognises /forms/:id (a single
 *    form's workspace), mirroring exactly how /documents/:id is already
 *    handled — it opens with the sidebar collapsed by default, same as a
 *    single document's workspace does. /forms itself (the list/report page)
 *    is a normal page and does NOT get this treatment.
 * 6. `usesWorkspaceCommandBar` no longer includes /forms — FormsPage builds
 *    its own regular in-page header instead of the app-wide blue command bar,
 *    so Layout renders its standard header (search/notifications/profile) for
 *    that route, same as any other ordinary page. /forms/:id is still listed,
 *    since FormDetailPage supplies its own full-bleed header (same pattern as
 *    DocumentDetailPage on /documents/:id).
 */

import { Suspense, lazy, useEffect, useRef, useState } from "react";
import { Outlet, NavLink, useNavigate, useLocation } from "react-router-dom";
import {
  LayoutDashboard, FileText, Upload, Search,
  Workflow, Settings, LogOut,
  Bell, Users, Building2, UserRoundCog, Shield,
  ChevronDown, ChevronRight, ChevronLeft, Archive, ScanLine, Loader2, UserCheck, Monitor, Lock, History, Trash2,
  BellRing, CircleUserRound, ClipboardCheck, Inbox, ArrowRight, FileSignature, LayoutTemplate, Database,
  Plug, ClipboardList,
} from "lucide-react";
import { useAuthStore } from "../../store/authStore";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { notificationsAPI, workflowAPI } from "../../services/api";
import { FlaxemLogo } from "./FlaxemLogo";
import { QUERY_ONE_MINUTE_STALE } from "@/lib/reactQueryDefaults";
import { preloadCommonRoutes, preloadRouteForPath } from "@/lib/routePreload";
import { FolderTree } from "@/components/folders/FolderTree";
import clsx from "clsx";

const ChatLauncher = lazy(() =>
  import("@/components/chat/ChatLauncher").then((module) => ({ default: module.ChatLauncher })),
);

const TASK_NOTIFICATION_TYPES = new Set(["task_assigned", "task_sla_warning", "task_overdue"]);

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

// Content-heavy routes that open with the sidebar collapsed (full-width canvas)
// by default. The user can still toggle the sidebar back open on these pages.
function isFullWidthByDefaultRoute(pathname: string): boolean {
  if (pathname === "/admin/templates" || pathname === "/workflow/builder" || pathname === "/forms/new") return true;

  // Single-document workspace: /documents/:id (not the upload/scan/review/etc.)
  const docSeg = pathname.split("/")[2] ?? "";
  const isDocumentWorkspace =
    pathname.startsWith("/documents/") &&
    Boolean(docSeg) &&
    !["upload", "scan", "review", "trash", "folders"].includes(docSeg) &&
    !pathname.slice("/documents/".length).includes("/");

  // Single-form workspace: /forms/:id — same pattern as above. (There's no
  // /forms/new route to exclude; creating a form is a modal on /forms itself.)
  const formSeg = pathname.split("/")[2] ?? "";
  const isFormWorkspace =
    pathname.startsWith("/forms/") &&
    Boolean(formSeg) &&
    !pathname.slice("/forms/".length).includes("/");

  return isDocumentWorkspace || isFormWorkspace;
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
      { to: "/documents/review",          icon: ClipboardCheck, label: "Pending review" },
      { to: "/documents/trash",           icon: Trash2,   label: "Trash" },
      { to: "/search",                    icon: Search,   label: "Search" },
    ],
  } as NavGroup,
  { to: "/forms", icon: ClipboardList, label: "Forms" } as NavLeaf,
  { to: "/personal-documents", icon: Lock, label: "Personal documents" } as NavLeaf,
  { to: "/request-signature", icon: FileSignature, label: "Request signature" } as NavLeaf,
  {
    to: "/workflow",
    icon: Workflow,
    label: "My tasks",
  } as NavLeaf,
  { to: "/audit", icon: History, label: "Audit trail" } as NavLeaf,
  {
    icon: UserRoundCog,
    label: "Profile",
    prefix: "/profile",
    children: [
      { to: "/profile?tab=settings", icon: Settings, label: "Settings" },
      { to: "/profile?tab=delegation", icon: UserCheck, label: "Delegation" },
      { to: "/profile?tab=signature", icon: FileSignature, label: "E-Signature" },
      { to: "/profile?tab=preferences", icon: Monitor, label: "Preferences" },
    ],
  } as NavGroup,
];

const adminNav: NavLeaf[] = [
  { to: "/admin/document-types", icon: FileText,  label: "Document types", allowedRoles: ["admin"] },
  { to: "/admin/templates",      icon: LayoutTemplate, label: "Templates", allowedRoles: ["admin"] },
  { to: "/admin/users",       icon: Users,     label: "Users",       allowedRoles: ["admin"] },
  { to: "/admin/departments", icon: Building2, label: "Departments", allowedRoles: ["admin"] },
  { to: "/admin/groups",      icon: Shield,    label: "Groups",      allowedRoles: ["admin"] },
  { to: "/admin/settings",    icon: Settings,  label: "Settings",    allowedRoles: ["admin"] },
  { to: "/admin/migration",   icon: Database,  label: "IDM Migration", allowedRoles: ["admin"] },
  { to: "/admin/mailboxes",   icon: Inbox,     label: "Email Ingestion", allowedRoles: ["admin"] },
  { to: "/admin/sunsystems",  icon: Plug,      label: "SunSystems", allowedRoles: ["admin"] },
  { to: "/workflow/builder", icon: Settings, label: "Workflow Builder", allowedRoles: ["admin"] },
];

// ── SidebarGroup ──────────────────────────────────────────────────────────────

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
    <div className="nav-section-item">
      <button
        onClick={() => setOpen(!open)}
        className={clsx(
          "group flex w-full items-center gap-3 border-l-2 px-3 py-2 text-sm font-semibold transition-colors",
          isGroupActive
            ? "border-[#287EAD] bg-[#E9F3F8] text-[#1F2933]"
            : "border-transparent text-[#3D454D] hover:border-[#9ABFD4] hover:bg-[#EEF3F7] hover:text-[#1F2933]"
        )}
      >
        <group.icon className={clsx("h-4 w-4 flex-shrink-0", isGroupActive ? "text-[#287EAD]" : "text-[#6E767D] group-hover:text-[#287EAD]")} />
        <span className="flex-1 text-left">{group.label}</span>
        {open
          ? <ChevronDown className="h-3.5 w-3.5 flex-shrink-0 text-[#6E767D]" />
          : <ChevronRight className="h-3.5 w-3.5 flex-shrink-0 text-[#6E767D]" />}
      </button>

      {open && (
        <div className="ml-5 border-l border-[#CDD3D8] py-1">
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
                    "group flex items-center gap-2.5 border-l-2 px-3 py-1.5 text-sm transition-colors",
                    isChildActive
                      ? "border-[#287EAD] bg-white text-[#1F2933]"
                      : "border-transparent text-[#4B5560] hover:border-[#A7CDE3] hover:bg-[#F5F7F8] hover:text-[#1F2933]"
                  )
                }
              >
                <Icon className={clsx("h-3.5 w-3.5 flex-shrink-0", isChildActive ? "text-[#287EAD]" : "text-[#7C8790] group-hover:text-[#287EAD]")} />
                <span className="flex-1">{label}</span>
                {badgeValue ? (
                  <span
                    className={clsx(
                      "ml-auto inline-flex min-w-[1.25rem] items-center justify-center px-1.5 py-0.5 text-[10px] font-bold text-white",
                      to === "/workflow" || to === "/notifications" ? "bg-red-700" : "bg-[#287EAD]"
                    )}
                  >
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

function ProfileMenu({ variant = "light" }: { variant?: "light" | "blue" }) {
  const { user, logout } = useAuthStore();
  const _navigate = useNavigate();
  void _navigate;
  const [open, setOpen] = useState(false);
  const buttonClassName = variant === "blue"
    ? "flex h-9 w-9 items-center justify-center text-white/85 transition-colors hover:bg-white/10 hover:text-white"
    : "flex h-9 w-9 items-center justify-center border border-[#C8CDD2] bg-white text-[#5E6870] transition-colors hover:bg-[#EEF6FB] hover:text-[#287EAD]";

  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" || event.key === "Esc") {
        setOpen(false);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [open]);

  return (
    <div className="relative">
      <button
        onClick={() => setOpen(!open)}
        className={buttonClassName}
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
              onClick={() => { setOpen(false); _navigate("/profile"); }}
              className="flex w-full items-center gap-2 px-4 py-2 text-sm text-[#1F2933] transition-colors hover:bg-[#F5F7F8]"
            >
              <CircleUserRound className="w-4 h-4 text-[#5E6870]" />
              My profile
            </button>
            <button
              onClick={() => { logout(); _navigate("/login"); }}
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

function NotificationsTray({
  notifications,
  tasks,
  attentionCount,
  variant = "light",
}: {
  notifications?: { id: string; type: string; message: string; link?: string; is_read: boolean; created_at: string }[];
  tasks: unknown[];
  attentionCount: number;
  variant?: "light" | "blue";
}) {
  const _navigate = useNavigate();
  void _navigate;
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);

  // The tray's list data is no longer polled (badge counts come from the
  // summary endpoint), so refresh it whenever the user opens the tray.
  useEffect(() => {
    if (!open) return;
    queryClient.invalidateQueries({ queryKey: ["notifications"] });
    queryClient.invalidateQueries({ queryKey: ["workflow", "my-tasks"] });
  }, [open, queryClient]);
  const markReadMutation = useMutation({
    mutationFn: (id: string) => notificationsAPI.markRead(id),
    onMutate: async (id: string) => {
      await queryClient.cancelQueries({ queryKey: ["notifications"] });
      const previousNotifications = queryClient.getQueryData<{ id: string; type: string; message: string; link?: string; is_read: boolean; created_at: string }[]>(["notifications"]);
      if (previousNotifications) {
        queryClient.setQueryData(["notifications"], previousNotifications.map((notification) =>
          notification.id === id ? { ...notification, is_read: true } : notification,
        ));
      }
      return { previousNotifications };
    },
    onError: (_err, _id, context) => {
      if (context?.previousNotifications) {
        queryClient.setQueryData(["notifications"], context.previousNotifications);
      }
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ["notifications"] });
      queryClient.invalidateQueries({ queryKey: ["notifications", "unread-count"] });
    },
  });
  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" || event.key === "Esc") {
        setOpen(false);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [open]);
  const noticeNotifications = (notifications ?? [])
    .filter((notification) => !TASK_NOTIFICATION_TYPES.has(notification.type));
  const taskAlertNotifications = (notifications ?? [])
    .filter((notification) => TASK_NOTIFICATION_TYPES.has(notification.type));
  const visibleNotifications = noticeNotifications
    .filter((notification) => !notification.is_read)
    .slice(0, 5);
  const visibleTaskAlerts = taskAlertNotifications
    .filter((notification) => !notification.is_read)
    .slice(0, 3);
  const noticeUnreadCount = noticeNotifications.filter((notification) => !notification.is_read).length;
  const taskAlertUnreadCount = taskAlertNotifications.filter((notification) => !notification.is_read).length;
  const visibleTasks = tasks.slice(0, 5) as {
    id?: string;
    document_title?: string;
    document_ref?: string;
    step?: { name?: string };
    due_at?: string | null;
    workflow_instance?: { document?: { title?: string; reference_number?: string } };
  }[];
  // attentionCount (the bell badge) is supplied by the parent from the summary
  // endpoint; the per-section counts below come from the lists shown when open.

  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" || event.key === "Esc") {
        setOpen(false);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [open]);

  const openNotification = (notification: { id: string; link?: string; is_read: boolean }) => {
    setOpen(false);
    if (!notification.is_read) {
      markReadMutation.mutate(notification.id);
    }
    _navigate(notification.link || "/notifications");
  };

  const openTasks = () => {
    setOpen(false);
    _navigate("/workflow");
  };
  const buttonClassName = variant === "blue"
    ? "relative flex h-9 w-9 items-center justify-center text-white/85 transition-colors hover:bg-white/10 hover:text-white"
    : "relative flex h-9 w-9 items-center justify-center border border-[#C8CDD2] bg-white text-[#5E6870] transition-colors hover:bg-[#EEF6FB] hover:text-[#287EAD]";

  return (
    <div className="relative">
      <button
        onClick={() => setOpen((value) => !value)}
        className={buttonClassName}
        title="Notifications and tasks"
        aria-label="Open notifications and tasks tray"
      >
        <BellRing className="h-5 w-5" />
        {attentionCount > 0 && (
          <span className="absolute -right-1 -top-1 flex h-4 min-w-[16px] items-center justify-center bg-red-700 px-1 text-[9px] font-bold text-white">
            {attentionCount > 9 ? "9+" : attentionCount}
          </span>
        )}
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-20" onClick={() => setOpen(false)} />
          <div className="absolute right-0 top-11 z-30 w-[380px] overflow-hidden border border-[#C8CDD2] bg-white shadow-2xl">
            <div className="border-b border-[#C8CDD2] bg-[#287EAD] px-4 py-3 text-white">
              <p className="text-sm font-bold">Notifications & tasks</p>
              <p className="mt-0.5 text-xs text-white/75">Separate updates from assigned work.</p>
            </div>

            <div className="grid grid-cols-2 border-b border-[#C8CDD2] bg-[#F5F7F8] text-sm">
              <button
                type="button"
                onClick={() => { setOpen(false); _navigate("/notifications"); }}
                className="flex items-center justify-between border-r border-[#C8CDD2] px-4 py-3 text-left font-semibold text-[#1F2933] hover:bg-[#EEF6FB]"
              >
                <span className="inline-flex items-center gap-2">
                  <Inbox className="h-4 w-4 text-[#287EAD]" />
                  Notices
                </span>
                <span className="font-bold text-[#287EAD]">{noticeUnreadCount}</span>
              </button>
              <button
                type="button"
                onClick={openTasks}
                className="flex items-center justify-between px-4 py-3 text-left font-semibold text-[#1F2933] hover:bg-[#EEF6FB]"
              >
                <span className="inline-flex items-center gap-2">
                  <ClipboardCheck className="h-4 w-4 text-[#287EAD]" />
                  Tasks
                </span>
                <span className="font-bold text-[#287EAD]">{tasks.length + taskAlertUnreadCount}</span>
              </button>
            </div>

            <div className="grid max-h-[430px] grid-cols-1 divide-y divide-[#C8CDD2] overflow-y-auto">
              <section className="p-3">
                <div className="mb-2 flex items-center justify-between">
                  <p className="text-xs font-bold uppercase tracking-wider text-[#5E6870]">Notifications</p>
                  <button onClick={() => { setOpen(false); _navigate("/notifications"); }} className="text-xs font-bold text-[#287EAD] hover:text-[#206D99]">
                    View all
                  </button>
                </div>
                {visibleNotifications.length === 0 ? (
                  <div className="border border-dashed border-[#C8CDD2] bg-[#F5F7F8] px-3 py-5 text-center text-sm text-[#5E6870]">
                    No unread updates.
                  </div>
                ) : (
                  <div className="space-y-1">
                    {visibleNotifications.map((notification) => (
                      <button
                        key={notification.id}
                        type="button"
                        onClick={() => openNotification(notification)}
                        className="block w-full border border-transparent px-3 py-2 text-left hover:border-[#C8CDD2] hover:bg-[#F5F7F8]"
                      >
                        <p className="line-clamp-2 text-sm font-semibold text-[#1F2933]">{notification.message}</p>
                        <p className="mt-1 text-xs text-[#5E6870]">
                          {new Date(notification.created_at).toLocaleString(undefined, { dateStyle: "short", timeStyle: "short" })}
                        </p>
                      </button>
                    ))}
                  </div>
                )}
              </section>

              <section className="p-3">
                <div className="mb-2 flex items-center justify-between">
                  <p className="text-xs font-bold uppercase tracking-wider text-[#5E6870]">Tasks</p>
                  <button onClick={openTasks} className="inline-flex items-center gap-1 text-xs font-bold text-[#287EAD] hover:text-[#206D99]">
                    Open queue <ArrowRight className="h-3.5 w-3.5" />
                  </button>
                </div>
                {visibleTaskAlerts.length > 0 && (
                  <div className="mb-2 space-y-1">
                    {visibleTaskAlerts.map((notification) => (
                      <button
                        key={notification.id}
                        type="button"
                        onClick={() => openNotification(notification)}
                        className="block w-full border border-amber-200 bg-amber-50 px-3 py-2 text-left hover:bg-amber-100"
                      >
                        <p className="line-clamp-2 text-sm font-bold text-amber-900">{notification.message}</p>
                      </button>
                    ))}
                  </div>
                )}
                {visibleTasks.length === 0 ? (
                  <div className="border border-dashed border-[#C8CDD2] bg-[#F5F7F8] px-3 py-5 text-center text-sm text-[#5E6870]">
                    No active tasks.
                  </div>
                ) : (
                  <div className="space-y-1">
                    {visibleTasks.map((task, index) => {
                      const title = task.document_title || task.workflow_instance?.document?.title || "Workflow task";
                      const ref = task.document_ref || task.workflow_instance?.document?.reference_number || task.step?.name || "";
                      return (
                        <button
                          key={task.id || `${title}-${index}`}
                          type="button"
                          onClick={openTasks}
                          className="block w-full border border-[#C8CDD2] bg-white px-3 py-2 text-left hover:bg-[#EEF6FB]"
                        >
                          <p className="truncate text-sm font-bold text-[#1F2933]">{title}</p>
                          <p className="mt-1 truncate text-xs text-[#5E6870]">{ref}</p>
                        </button>
                      );
                    })}
                  </div>
                )}
              </section>
            </div>
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
    <div className="flex min-h-[18rem] items-center justify-center border border-border bg-card">
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
    <div className="border-t border-[#C8CDD2] bg-[#F7F8F9] p-3">
      <div className="flex items-center gap-3 border border-[#D7DCE0] bg-white px-2 py-2">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center bg-[#287EAD] text-xs font-bold text-white">
          {initials}
        </div>
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold text-[#1F2933]">
            {user?.first_name} {user?.last_name}
          </p>
          <p className="truncate text-[11px] capitalize text-[#5E6870]">
            {user?.job_description || "Staff"}
          </p>
        </div>
      </div>
    </div>
  );
}

export function WorkspaceHeaderActions({ variant = "light" }: { variant?: "light" | "blue" }) {
  const [idleReady, setIdleReady] = useState(false);

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

  const { data: summary } = useQuery({
    queryKey: ["notifications", "summary"],
    queryFn: () => notificationsAPI.summary().then((r) => r.data),
    refetchInterval: 60_000,
    enabled: idleReady,
    ...QUERY_ONE_MINUTE_STALE,
  });

  const { data: notifications } = useQuery({
    queryKey: ["notifications"],
    queryFn: () => notificationsAPI.list().then((r) => r.data.results ?? r.data),
    enabled: idleReady,
    ...QUERY_ONE_MINUTE_STALE,
  });

  const { data: myTasks = [] } = useQuery({
    queryKey: ["workflow", "my-tasks"],
    queryFn: () => workflowAPI.myTasks().then((r) => r.data.results ?? r.data),
    enabled: idleReady,
    ...QUERY_ONE_MINUTE_STALE,
  });

  const trayAttentionCount =
    (summary?.unread_notifications ?? 0) +
    (summary?.unread_task_alerts ?? 0) +
    (summary?.pending_tasks ?? 0);
  const isBlue = variant === "blue";

  return (
    <div className="flex shrink-0 items-center gap-2">
      {idleReady ? (
        <Suspense fallback={null}>
          <ChatLauncher variant={variant} />
        </Suspense>
      ) : null}
      <NotificationsTray
        notifications={notifications as any}
        tasks={myTasks as unknown[]}
        attentionCount={trayAttentionCount}
        variant={variant}
      />
      {!isBlue && <div className="mx-1 h-6 w-px bg-[#C8CDD2]" />}
      <ProfileMenu variant={variant} />
    </div>
  );
}

// ── Layout ────────────────────────────────────────────────────────────────────

export default function Layout() {
  const { user } = useAuthStore();
  const _navigate = useNavigate();
  void _navigate;
  const location = useLocation();
  const mainRef = useRef<HTMLElement | null>(null);
  const hasAdminAccess = Boolean(user?.has_admin_access);
  const [idleReady, setIdleReady] = useState(false);
  // ── NEW: folder panel toggle ──────────────────────────────────────────────
  const [_foldersExpanded, _setFoldersExpanded] = useState(true);
  void _foldersExpanded; void _setFoldersExpanded;

  // ── Sidebar collapse. `collapsePref` is the user's remembered choice for
  // regular pages (persisted). The effective collapsed state is DERIVED during
  // render — not stored in an effect — so a navigation paints the new page at
  // the correct width on the first frame (one smooth slide, no snap-then-slide).
  const [collapsePref, setCollapsePref] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    try { return window.localStorage.getItem("sidebarCollapsed") === "1"; } catch { return false; }
  });
  // A manual toggle is remembered against the path it was made on, so it applies
  // for that visit but never leaks onto the next page.
  const [sidebarOverride, setSidebarOverride] = useState<{ path: string; collapsed: boolean } | null>(null);
  useEffect(() => {
    try { window.localStorage.setItem("sidebarCollapsed", collapsePref ? "1" : "0"); } catch { /* ignore */ }
  }, [collapsePref]);

  const routeDefaultCollapsed = isFullWidthByDefaultRoute(location.pathname) ? true : collapsePref;
  const sidebarCollapsed =
    sidebarOverride && sidebarOverride.path === location.pathname
      ? sidebarOverride.collapsed
      : routeDefaultCollapsed;

  const toggleSidebar = () => {
    const next = !sidebarCollapsed;
    setSidebarOverride({ path: location.pathname, collapsed: next });
    // On regular pages the toggle is also the lasting preference; on the
    // collapse-by-default routes it's only an override for the current visit.
    if (!isFullWidthByDefaultRoute(location.pathname)) setCollapsePref(next);
  };

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

  // All sidebar/bell badge counts come from a single consolidated endpoint that
  // runs on every authenticated page. This is the app's constant background
  // load multiplier, so it's one cheap COUNT request (not three row-fetching
  // polls) every 60s. (react-query pauses it while the tab is backgrounded.)
  const { data: summary } = useQuery({
    queryKey: ["notifications", "summary"],
    queryFn: () => notificationsAPI.summary().then((r) => r.data),
    refetchInterval: 60_000,
    enabled: idleReady,
    ...QUERY_ONE_MINUTE_STALE,
  });

  // The notification + task *lists* only feed the expanded tray, so they're no
  // longer polled — they load once and the tray refetches them when opened.
  const { data: notifications } = useQuery({
    queryKey: ["notifications"],
    queryFn: () => notificationsAPI.list().then((r) => r.data.results ?? r.data),
    enabled: idleReady,
    ...QUERY_ONE_MINUTE_STALE,
  });

  const { data: myTasks = [] } = useQuery({
    queryKey: ["workflow", "my-tasks"],
    queryFn: () => workflowAPI.myTasks().then((r) => r.data.results ?? r.data),
    enabled: idleReady,
    ...QUERY_ONE_MINUTE_STALE,
  });

  const unread = summary?.unread_notifications ?? 0;
  const pendingTasksCount = summary?.pending_tasks ?? 0;
  const signatureCount = summary?.incoming_signatures ?? 0;
  const documentsRouteSegment = location.pathname.split("/")[2] ?? "";
  const formsRouteSegment = location.pathname.split("/")[2] ?? "";
  const usesWorkspaceCommandBar =
    location.pathname === "/" ||
    location.pathname === "/notifications" ||
    location.pathname === "/search" ||
    location.pathname === "/analytics" ||
    location.pathname === "/workflow" ||
    location.pathname === "/audit" ||
    location.pathname === "/admin/templates" ||
    location.pathname === "/documents" ||
    location.pathname === "/documents/upload" ||
    location.pathname === "/documents/scan" ||
    location.pathname === "/documents/trash" ||
    (
      location.pathname.startsWith("/documents/") &&
      Boolean(documentsRouteSegment) &&
      !["upload", "scan", "review", "trash", "folders"].includes(documentsRouteSegment) &&
      !location.pathname.slice("/documents/".length).includes("/")
    ) ||
    // /forms/new — the template picker and fill experience both get the
    // full-bleed treatment (same as /forms/:id — they both supply their own
    // blue header).
    location.pathname === "/forms/new" ||
    // /forms (the list page) is intentionally NOT here — it uses Layout's
    // normal header. Only a single form's workspace (/forms/:id) supplies
    // its own header, same as /documents/:id does.
    (
      location.pathname.startsWith("/forms/") &&
      Boolean(formsRouteSegment) &&
      !location.pathname.slice("/forms/".length).includes("/")
    );
  // Bell badge: every unread notification (notices + task alerts) plus pending
  // tasks — mirrors what the tray used to sum from the now-unpolled lists.
  const trayAttentionCount =
    (summary?.unread_notifications ?? 0) +
    (summary?.unread_task_alerts ?? 0) +
    (summary?.pending_tasks ?? 0);

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
    <div
      className="relative flex h-screen bg-background text-foreground"
      style={{ "--app-sidebar-width": sidebarCollapsed ? "0px" : "270px" } as React.CSSProperties}
    >

      {/* ── Sidebar ────────────────────────────────────────────────────── */}
      <aside
        className={clsx(
          "flex flex-shrink-0 flex-col overflow-hidden bg-[#F2F3F4] text-[#1F2933]",
          sidebarCollapsed ? "w-0 border-r-0" : "w-[270px]",
          !sidebarCollapsed && !usesWorkspaceCommandBar && "border-r border-[#C8CDD2]",
        )}
      >
        {/* Logo */}
        <div className="flex h-[69px] items-center border-b border-[#206D99] bg-[#287EAD] px-4">
          <div className="flex items-center gap-3">
            <FlaxemLogo variant="light" />
          </div>
        </div>

        {/* Nav — scrollable, two sections split by a divider */}
        <nav className="scrollbar-minimal flex-1 overflow-y-auto">
          {/* ── Primary nav ─────────────────────────────────────────────── */}
          <div className="space-y-0.5 px-2 py-3">
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
              const badgeValue = to === "/notifications" ? unread
                : to === "/workflow" ? pendingTasksCount
                : to === "/request-signature" ? (signatureCount || undefined)
                : undefined;
              return (
                <NavLink
                  key={to}
                  to={to}
                  end={exact}
                  onMouseEnter={() => warmRoute(to)}
                  onFocus={() => warmRoute(to)}
                  className={({ isActive }) =>
                    clsx(
                      "group flex items-center gap-3 border-l-2 px-3 py-2 text-sm font-semibold transition-colors",
                      isActive
                        ? "border-[#287EAD] bg-white text-[#1F2933]"
                        : "border-transparent text-[#3D454D] hover:border-[#9ABFD4] hover:bg-[#EEF3F7] hover:text-[#1F2933]"
                    )
                  }
                >
                  {({ isActive }) => (
                    <>
                      <Icon className={clsx("h-4 w-4 flex-shrink-0", isActive ? "text-[#287EAD]" : "text-[#6E767D] group-hover:text-[#287EAD]")} />
                      <span className="flex-1">{label}</span>
                          {badgeValue ? (
                            <span
                              className={clsx(
                                "inline-flex min-w-[1.25rem] items-center justify-center px-1.5 py-0.5 text-[10px] font-bold text-white",
                                to === "/workflow" || to === "/notifications" || to === "/request-signature" ? "bg-red-700" : "bg-[#287EAD]"
                              )}
                            >
                              {badgeValue}
                            </span>
                          ) : null}
                    </>
                  )}
                </NavLink>
              );
            })}
          </div>

          {/* ── Folder tree section ─────────────────────────────────────── */}
          <div className="border-t border-[#C8CDD2] pb-2">
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
            <div className="space-y-0.5 border-t border-[#C8CDD2] px-2 py-3">
              <div className="px-3 pb-1 pt-0">
                <p className="text-[10px] font-bold uppercase tracking-widest text-[#6E767D]">
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
                      "group flex items-center gap-3 border-l-2 px-3 py-2 text-sm font-semibold transition-colors",
                      isActive
                        ? "border-[#287EAD] bg-white text-[#1F2933]"
                        : "border-transparent text-[#3D454D] hover:border-[#9ABFD4] hover:bg-[#EEF3F7] hover:text-[#1F2933]"
                    )
                  }
                >
                  {({ isActive }) => (
                    <>
                      <Icon className={clsx("h-4 w-4 flex-shrink-0", isActive ? "text-[#287EAD]" : "text-[#6E767D] group-hover:text-[#287EAD]")} />
                      <span>{label}</span>
                    </>
                  )}
                </NavLink>
              ))}
            </div>
          )}
        </nav>

        <SidebarProfile />
      </aside>

      {/* ── Sidebar collapse / expand toggle ─────────────────────────────
          Sits on the sidebar↔content boundary and slides with it. Collapsing
          drops the sidebar to 0 width so the workspace spans the full width. */}
      <button
        type="button"
        onClick={toggleSidebar}
        className={clsx(
          "absolute top-1/2 z-40 flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-full border border-[#C8CDD2] bg-white text-[#5E6870] shadow-md transition-[background-color,color,border-color] duration-200 ease-in-out hover:border-[#287EAD] hover:bg-[#EEF6FB] hover:text-[#287EAD]",
          sidebarCollapsed ? "left-0" : "left-[258px]",
        )}
        title={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
        aria-label={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
        aria-expanded={!sidebarCollapsed}
      >
        {sidebarCollapsed ? <ChevronRight className="h-4 w-4" /> : <ChevronLeft className="h-4 w-4" />}
      </button>

      {/* ── Main area (unchanged) ──────────────────────────────────── */}
      <div className="flex-1 flex flex-col min-w-0">
        {!usesWorkspaceCommandBar && (
          <header className="flex h-14 flex-shrink-0 items-center justify-end gap-2 border-b border-[#C8CDD2] bg-white px-6">
            {idleReady ? (
              <Suspense fallback={null}>
                <ChatLauncher />
              </Suspense>
            ) : null}
            <NotificationsTray
              notifications={notifications as any}
              tasks={myTasks as unknown[]}
              attentionCount={trayAttentionCount}
            />
            <div className="mx-1 h-6 w-px bg-[#C8CDD2]" />
            <ProfileMenu />
          </header>
        )}

        <main
          ref={mainRef}
          className={clsx(
            "scrollbar-minimal flex-1 overflow-y-auto bg-background",
            usesWorkspaceCommandBar ? "p-0" : "p-6",
          )}
        >
          <Suspense fallback={<ContentFallback />}>
            <Outlet />
          </Suspense>
        </main>
      </div>
    </div>
  );
}
