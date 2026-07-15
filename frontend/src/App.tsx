import { Suspense, lazy, useEffect, useState } from "react";
import { Routes, Route, Navigate, useLocation } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { useAuthStore, applyServerSessionPolicy } from "@/store/authStore";
import { useSessionUiStore } from "@/store/sessionUiStore";
import { authAPI } from "@/services/api";
import { VaultToaster } from "@/components/ui/vault-toast";
import { Loader2 } from "lucide-react";

const SessionDialogs = lazy(() => import("@/components/shared/SessionDialogs"));

const Layout = lazy(() => import("@/components/shared/Layout"));
const LoginPage = lazy(() => import("@/pages/LoginPage"));
const ForceChangePasswordPage = lazy(() => import("@/pages/ForceChangePasswordPage"));
const DashboardPage = lazy(() => import("@/pages/DashboardPage"));
const AnalyticsDashboardPage = lazy(() => import("@/pages/AnalyticsDashboard"));
const DocumentsPage = lazy(() => import("@/pages/DocumentsPage"));
const TrashPage = lazy(() => import("@/pages/TrashPage"));
const DocumentDetailPage = lazy(() => import("@/pages/DocumentDetailPage"));
const UploadPage = lazy(() => import("@/pages/UploadPage"));
const RequestSignaturePage = lazy(() => import("@/pages/RequestSignaturePage"));
const SearchPage = lazy(() => import("@/pages/SearchPage"));
const WorkflowPage = lazy(() => import("@/pages/WorkflowPage"));
const AdminPage = lazy(() => import("@/pages/AdminPage"));
const AdminDocumentTypesPage = lazy(() => import("@/pages/AdminDocumentTypesPage"));
const AdminMigrationPage = lazy(() => import("@/pages/AdminMigrationPage"));
const AdminMailboxPage = lazy(() => import("@/pages/AdminMailboxPage"));
const AdminSunSystemsPage = lazy(() => import("@/pages/AdminSunSystemsPage"));
const ReviewQueuePage = lazy(() => import("@/pages/ReviewQueuePage"));
const AuditPage = lazy(() => import("@/pages/AuditPage"));
const UsersPage = lazy(() => import("@/pages/UsersPage"));
const UserDetailPage = lazy(() => import("@/pages/UserDetailPage"));
const DepartmentsPage = lazy(() => import("@/pages/DepartmentsPage"));
const GroupsPage = lazy(() => import("@/pages/GroupsPage"));
const ProfilePage = lazy(() => import("@/pages/ProfilePage"));
const WorkflowBuilderPage = lazy(() => import("@/pages/WorkflowBuilderPage"));
const NotificationsPage = lazy(() => import("@/pages/NotificationsPage"));
const NotificationWorkflowPage = lazy(() => import("@/pages/NotificationWorkflowPage"));
const FolderPage = lazy(() => import("@/pages/FolderPage"));
const TemplatesPage = lazy(() => import("@/pages/TemplatesPage"));

// ── Guards ────────────────────────────────────────────────────────────────────

function RequireAuth({ children }: { children: React.ReactNode }) {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  return isAuthenticated ? <>{children}</> : <Navigate to="/login" replace />;
}

function AuthBootstrap({ children }: { children: React.ReactNode }) {
  const accessToken = useAuthStore((s) => s.accessToken);
  const user = useAuthStore((s) => s.user);
  const setUser = useAuthStore((s) => s.setUser);
  const logout = useAuthStore((s) => s.logout);
  const isSessionExpired = useAuthStore((s) => s.isSessionExpired);
  const [ready, setReady] = useState(!accessToken || user?.has_admin_access !== undefined);

  useEffect(() => {
    let cancelled = false;

    if (!accessToken || isSessionExpired()) {
      if (accessToken) {
        // We had a session and it has lapsed (e.g. tab reopened after the idle
        // window) — surface the "expired" notice, not a silent bounce to login.
        useSessionUiStore.getState().showExpiredNotice();
        logout();
      }
      setReady(true);
      return () => {
        cancelled = true;
      };
    }

    if (user?.has_admin_access !== undefined) {
      setReady(true);
      return () => {
        cancelled = true;
      };
    }

    setReady(false);
    authAPI.me(accessToken)
      .then(({ data }) => {
        if (!cancelled) {
          applyServerSessionPolicy(data.session_policy);
          setUser(data);
        }
      })
      .catch(() => {
        if (!cancelled) {
          logout();
        }
      })
      .finally(() => {
        if (!cancelled) {
          setReady(true);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [accessToken, isSessionExpired, logout, setUser, user?.has_admin_access]);

  if (!ready) return <RouteFallback />;
  return <>{children}</>;
}

/**
 * Background session sync. Re-fetches the current user so privilege/group
 * changes (e.g. being added to or removed from the Administrators group) take
 * effect without a manual sign-out: revalidates on window focus and on a short
 * interval, then updates the auth store in place. The backend already enforces
 * permissions per request — this keeps the UI (menus, role label, guards) in
 * sync. Self-disables when unauthenticated, so it's safe to mount globally.
 */
function SessionSync() {
  const accessToken = useAuthStore((s) => s.accessToken);
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const isSessionExpired = useAuthStore((s) => s.isSessionExpired);
  const setUser = useAuthStore((s) => s.setUser);

  const enabled = isAuthenticated && !!accessToken && !isSessionExpired();

  const { data } = useQuery({
    queryKey: ["auth", "me"],
    queryFn: () => authAPI.me(accessToken as string).then((res) => res.data),
    enabled,
    // Revalidates privilege/group changes. These are rare, so a 2-minute poll
    // (plus an on-focus refetch, deduped by staleTime) keeps the UI in sync
    // without every client hammering /auth/me each minute under load.
    refetchOnWindowFocus: true,
    refetchInterval: 120_000,
    staleTime: 60_000,
  });

  useEffect(() => {
    if (data) {
      applyServerSessionPolicy(data.session_policy);
      setUser(data);
    }
  }, [data, setUser]);

  return null;
}

/**
 * Enforces the configurable session policy on the client:
 *  - tracks genuine user interaction to drive the inactivity (idle) timeout, and
 *  - on a short interval, signs the user out once the absolute lifetime or the
 *    idle window has elapsed — even when no network request is in flight.
 * The backend pins each refresh token to the same absolute lifetime, so this is
 * a UX layer on top of a server-enforced cap, not the sole gate.
 */
function SessionGuard() {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const recordActivity = useAuthStore((s) => s.recordActivity);
  const logout = useAuthStore((s) => s.logout);

  useEffect(() => {
    if (!isAuthenticated) return;

    const endSession = () => {
      if (!useAuthStore.getState().isAuthenticated) return;
      // Raise the expiry notice before clearing auth so the modal shows over the
      // login page the user is about to be redirected to.
      useSessionUiStore.getState().showExpiredNotice();
      logout();
    };

    // Throttle activity writes — we only need ~per-30s resolution for the timer.
    let lastRecorded = Date.now();
    const onActivity = () => {
      const now = Date.now();
      if (now - lastRecorded > 30_000) {
        lastRecorded = now;
        recordActivity();
      }
    };
    const events: Array<keyof WindowEventMap> = [
      "mousemove",
      "mousedown",
      "keydown",
      "scroll",
      "touchstart",
      "click",
    ];
    events.forEach((e) => window.addEventListener(e, onActivity, { passive: true }));

    // Returning to a tab that sat idle past the timeout should sign out at once.
    if (useAuthStore.getState().isSessionExpired()) endSession();

    const interval = window.setInterval(() => {
      if (useAuthStore.getState().isSessionExpired()) endSession();
    }, 15_000);

    return () => {
      events.forEach((e) => window.removeEventListener(e, onActivity));
      window.clearInterval(interval);
    };
  }, [isAuthenticated, recordActivity, logout]);

  return null;
}

/**
 * If the user has logged in but must change their password,
 * redirect them to the change-password page and block everything else.
 */
function RequirePasswordChanged({ children }: { children: React.ReactNode }) {
  const user = useAuthStore((s) => s.user);
  if (user?.must_change_password) {
    return <Navigate to="/change-password" replace />;
  }
  return <>{children}</>;
}

function RequireAdmin({ children }: { children: React.ReactNode }) {
  const user = useAuthStore((s) => s.user);
  if (!user) return <Navigate to="/login" replace />;
  if (!user.has_admin_access) return <Navigate to="/" replace />;
  return <>{children}</>;
}

/** Analytics is open to admins and department heads (HOD group members). */
function RequireAnalytics({ children }: { children: React.ReactNode }) {
  const user = useAuthStore((s) => s.user);
  if (!user) return <Navigate to="/login" replace />;
  const allowed = user.has_admin_access || (user.group_names ?? []).includes("HOD");
  if (!allowed) return <Navigate to="/" replace />;
  return <>{children}</>;
}

const ROUTE_FALLBACK_CONTENT = [
  {
    match: (pathname: string) => pathname === "/login",
    title: "Preparing sign-in",
    description: "Loading authentication checks and secure access controls.",
  },
  {
    match: (pathname: string) => pathname === "/change-password",
    title: "Preparing password update",
    description: "Loading your account safeguards for this required step.",
  },
  {
    match: (pathname: string) => pathname.startsWith("/personal-documents"),
    title: "Preparing personal documents",
    description: "Loading your private uploads, tags, and personal notes.",
  },
  {
    match: (pathname: string) => pathname.startsWith("/documents/upload"),
    title: "Preparing upload workspace",
    description: "Loading document intake and metadata capture tools.",
  },
  {
    match: (pathname: string) => pathname.startsWith("/documents/bulk-scan"),
    title: "Preparing bulk scan",
    description: "Loading batch OCR intake and per-document review tools.",
  },
  {
    match: (pathname: string) => pathname.startsWith("/documents/scan"),
    title: "Preparing scan workspace",
    description: "Loading OCR intake, extraction pipeline, and scan review tools.",
  },
  {
    match: (pathname: string) => pathname.startsWith("/documents/"),
    title: "Preparing document workspace",
    description: "Loading the selected file, version history, and review actions.",
  },
  {
    match: (pathname: string) => pathname === "/documents",
    title: "Preparing document library",
    description: "Loading folders, filters, and the latest document records.",
  },
  {
    match: (pathname: string) => pathname.startsWith("/workflow/builder"),
    title: "Preparing workflow builder",
    description: "Loading routing rules, approval steps, and template settings.",
  },
  {
    match: (pathname: string) => pathname.startsWith("/workflow"),
    title: "Preparing workflow queue",
    description: "Loading approval tasks, handoffs, and current workflow status.",
  },
  {
    match: (pathname: string) => pathname.startsWith("/search"),
    title: "Preparing search workspace",
    description: "Loading indexed records, filters, and retrieval tools.",
  },
  {
    match: (pathname: string) => pathname.startsWith("/notifications"),
    title: "Preparing notifications",
    description: "Loading alerts, reminders, and recent workflow updates.",
  },
  {
    match: (pathname: string) => pathname.startsWith("/audit"),
    title: "Preparing audit trail",
    description: "Loading activity history, controls, and trace records.",
  },
  {
    match: (pathname: string) => pathname.startsWith("/profile"),
    title: "Preparing profile settings",
    description: "Loading account preferences, security options, and personal details.",
  },
  {
    match: (pathname: string) => pathname.startsWith("/admin"),
    title: "Preparing administration",
    description: "Loading configuration, user controls, and system management tools.",
  },
];

function RouteFallback() {
  const location = useLocation();
  const content = ROUTE_FALLBACK_CONTENT.find((item) => item.match(location.pathname)) ?? {
    title: "Preparing your workspace",
    description: "Loading documents, workflow tools, and permissions for this view.",
  };

  return (
    <div className="min-h-screen bg-background px-6 py-10">
      <div className="mx-auto flex min-h-[calc(100vh-5rem)] max-w-md flex-col items-center justify-center text-center">
        <div className="inline-flex h-12 w-12 items-center justify-center rounded-full border border-border bg-card">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </div>
        <p className="mt-6 text-sm font-semibold text-foreground">{content.title}</p>
        <p className="mt-2 text-sm leading-6 text-muted-foreground">{content.description}</p>
      </div>
    </div>
  );
}

// ── App ───────────────────────────────────────────────────────────────────────

export default function App() {
  return (
    <AuthBootstrap>
      <>
        <SessionSync />
        <SessionGuard />
        <Suspense fallback={<RouteFallback />}>
          <Routes>
            {/* Public */}
            <Route path="/login" element={<LoginPage />} />

            {/* First-login password wall — requires auth but bypasses the layout */}
            <Route
              path="/change-password"
              element={
                <RequireAuth>
                  <ForceChangePasswordPage />
                </RequireAuth>
              }
            />

            {/* Protected — all regular pages */}
            <Route
              path="/"
              element={
                <RequireAuth>
                  <RequirePasswordChanged>
                    <Layout />
                  </RequirePasswordChanged>
                </RequireAuth>
              }
            >
              <Route index element={<DashboardPage />} />
              <Route path="analytics" element={<RequireAnalytics><AnalyticsDashboardPage /></RequireAnalytics>} />

              {/* Documents */}
              <Route path="documents"        element={<DocumentsPage />} />
              <Route path="documents/trash"  element={<TrashPage />} />
              <Route path="personal-documents" element={<DocumentsPage personalOnly />} />
              <Route path="documents/upload" element={<UploadPage />} />
              <Route path="documents/scan"   element={<UploadPage scanOnly />} />
              <Route path="documents/bulk-upload" element={<Navigate to="/documents/upload?mode=bulk" replace />} />
              <Route path="documents/bulk-scan" element={<Navigate to="/documents/scan?mode=bulk" replace />} />
              {/* Review queue — must precede documents/:id so "review" isn't read as an id. */}
              <Route path="documents/review" element={<ReviewQueuePage />} />
              <Route path="documents/review/:batchId" element={<ReviewQueuePage />} />
              <Route path="documents/:id"    element={<DocumentDetailPage />} />
              <Route path="documents/folders/:folderId" element={<FolderPage />} />
              <Route path="request-signature" element={<RequestSignaturePage />} />

              <Route path="templates" element={<Navigate to="/admin/templates" replace />} />

              {/* Search */}
              <Route path="search"    element={<SearchPage />} />

              {/* Workflow */}
              <Route path="workflow"  element={<WorkflowPage />} />
              <Route path="workflow/builder" element={  <RequireAdmin> <WorkflowBuilderPage />  </RequireAdmin>  }/>

              {/* Notifications */}
              <Route path="notifications" element={<NotificationsPage />} />
              <Route path="notifications/workflow/:documentId" element={<NotificationWorkflowPage />} />

              {/* Audit */}
              <Route path="audit"     element={<AuditPage />} />

              {/* Profile — every user */}
              <Route path="profile"   element={<ProfilePage />} />

              {/* Admin-only */}
              <Route path="admin/users"           element={<RequireAdmin><UsersPage /></RequireAdmin>} />
              <Route path="admin/users/:id"       element={<RequireAdmin><UserDetailPage /></RequireAdmin>} />
              <Route path="admin/settings"        element={<RequireAdmin><AdminPage /></RequireAdmin>} />
              <Route path="admin/document-types"  element={<RequireAdmin><AdminDocumentTypesPage /></RequireAdmin>} />
              <Route path="admin/templates"       element={<RequireAdmin><TemplatesPage /></RequireAdmin>} />
              <Route path="admin/departments"     element={<RequireAdmin><DepartmentsPage /></RequireAdmin>} />
              <Route path="admin/groups"          element={<RequireAdmin><GroupsPage /></RequireAdmin>} />
              <Route path="admin/migration"       element={<RequireAdmin><AdminMigrationPage /></RequireAdmin>} />
              <Route path="admin/mailboxes"       element={<RequireAdmin><AdminMailboxPage /></RequireAdmin>} />
              <Route path="admin/sunsystems"      element={<RequireAdmin><AdminSunSystemsPage /></RequireAdmin>} />
            </Route>

            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </Suspense>
        <Suspense fallback={null}>
          <SessionDialogs />
        </Suspense>
        <VaultToaster />
      </>
    </AuthBootstrap>
  );
}
