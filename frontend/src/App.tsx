import { Suspense, lazy, useEffect, useState } from "react";
import { Routes, Route, Navigate, useLocation, useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { useAuthStore, applyServerSessionPolicy } from "@/store/authStore";
import { useSessionUiStore } from "@/store/sessionUiStore";
import { authAPI, api } from "@/services/api";
import { VaultToaster } from "@/components/ui/vault-toast";
import { Loader2 } from "lucide-react";
import SessionDialogs from "@/components/shared/SessionDialogs";
import type { DeploymentConfig } from "@/store/authStore";

const Layout = lazy(() => import("@/components/shared/Layout"));
const LoginPage = lazy(() => import("@/pages/LoginPage"));
const PasswordResetConfirmPage = lazy(() => import("@/pages/PasswordResetConfirmPage"));
const ForceChangePasswordPage = lazy(() => import("@/pages/ForceChangePasswordPage"));
const AnalyticsDashboardPage = lazy(() => import("@/pages/AnalyticsDashboard"));
const WorkflowPage = lazy(() => import("@/pages/WorkflowPage"));
const AdminMailboxPage = lazy(() => import("@/pages/AdminMailboxPage"));
const AdminSunSystemsPage = lazy(() => import("@/pages/AdminSunSystemsPage"));
const UsersPage = lazy(() => import("@/pages/UsersPage"));
const UserDetailPage = lazy(() => import("@/pages/UserDetailPage"));
const DepartmentsPage = lazy(() => import("@/pages/DepartmentsPage"));
const GroupsPage = lazy(() => import("@/pages/GroupsPage"));
const ProfilePage = lazy(() => import("@/pages/ProfilePage"));
const WorkflowBuilderPage = lazy(() => import("@/pages/WorkflowBuilderPage"));
const NotificationsPage = lazy(() => import("@/pages/NotificationsPage"));
const NotificationWorkflowPage = lazy(() => import("@/pages/NotificationWorkflowPage"));
const TemplatesPage = lazy(() => import("@/pages/TemplatesPage"));
const FormDetailPage = lazy(() => import("@/pages/FormDetailPage"));
const RequisitionsPage = lazy(() => import("@/pages/RequisitionsPage"));
const SuppliersPage = lazy(() => import("@/pages/SuppliersPage"));
const RequisitionDashboardPage = lazy(() => import("@/pages/RequisitionDashboardPage"));
const NewRequisitionPage = lazy(() => import("@/pages/NewRequisitionPage"));
const RequisitionFormBuilder = lazy(() => import("@/pages/RequisitionFormBuilder"));



// ── Guards ────────────────────────────────────────────────────────────────────

function RequireAuth({ children }: { children: React.ReactNode }) {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const location = useLocation();
  return isAuthenticated ? <>{children}</> : <Navigate to="/login" state={{ from: location.pathname + location.search }} replace />;
}

function AuthBootstrap({ children }: { children: React.ReactNode }) {
  const accessToken = useAuthStore((s) => s.accessToken);
  const user = useAuthStore((s) => s.user);
  const setUser = useAuthStore((s) => s.setUser);
  const setDeployment = useAuthStore((s) => s.setDeployment);
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
    Promise.all([
      authAPI.me(accessToken),
      api.get("/auth/deployment/"),
    ])
      .then(([{ data: meData }, { data: deploymentData }]) => {
        if (!cancelled) {
          applyServerSessionPolicy(meData.session_policy);
          setUser(meData);
          setDeployment(deploymentData);
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
  }, [accessToken, isSessionExpired, logout, setUser, setDeployment, user?.has_admin_access]);

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
 * Apply deployment branding to the document and CSS variables.
 */
function DeploymentBranding() {
  const deployment = useAuthStore((s) => s.deployment);

  useEffect(() => {
    if (!deployment) return;

    // Apply brand color
    document.documentElement.style.setProperty(
      '--color-brand',
      deployment.primary_color
    );

    // Set document title
    document.title = deployment.product_name;
  }, [deployment]);

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
    match: (pathname: string) => pathname.startsWith("/notifications"),
    title: "Preparing notifications",
    description: "Loading alerts, reminders, and recent workflow updates.",
  },
  {
    match: (pathname: string) => pathname.startsWith("/profile"),
    title: "Preparing profile settings",
    description: "Loading account preferences, security options, and personal details.",
  },
  {
    match: (pathname: string) => pathname.startsWith("/new"),
    title: "Preparing new requisition",
    description: "Loading requisition form template and creation tools.",
  },
  {
    match: (pathname: string) => pathname.startsWith("/list"),
    title: "Preparing requisitions list",
    description: "Loading requisitions, filters, and request summaries.",
  },
  {
    match: (pathname: string) => pathname.startsWith("/suppliers"),
    title: "Preparing suppliers",
    description: "Loading supplier records and integration details.",
  },
  {
    match: (pathname: string) => pathname.startsWith("/admin"),
    title: "Preparing administration",
    description: "Loading configuration, user controls, and system management tools.",
  },
  {
    match: (pathname: string) => pathname.startsWith("/forms/new/builder"),
    title: "Preparing form builder",
    description: "Loading template builder and field configuration tools.",
  },
];

function RouteFallback() {
  const location = useLocation();
  const content = ROUTE_FALLBACK_CONTENT.find((item) => item.match(location.pathname)) ?? {
    title: "Preparing your workspace",
    description: "Loading requisition tools, workflow, and permissions for this view.",
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
  const navigate = useNavigate();

  return (
    <AuthBootstrap>
      <>
        <SessionSync />
        <SessionGuard />
        <DeploymentBranding />
        <Suspense fallback={<RouteFallback />}>
          <Routes>
            {/* Public */}
            <Route path="/login" element={<LoginPage />} />
            <Route path="/reset-password" element={<PasswordResetConfirmPage />} />

            {/* First-login password wall — requires auth but bypasses the layout */}
            <Route
              path="/change-password"
              element={
                <RequireAuth>
                  <ForceChangePasswordPage />
                </RequireAuth>
              }
            />

            {/* Protected — requisition-only deployment */}
            <Route
              path="/"
              element={
                <RequireAuth>
                  <RequirePasswordChanged>
                    <Layout
                      brandName="REQUISITION PORTAL"
                    />
                  </RequirePasswordChanged>
                </RequireAuth>
              }
            >
              <Route index element={<RequisitionDashboardPage />} />
              <Route path="list" element={<RequisitionsPage />} />
              <Route path="new" element={<NewRequisitionPage />} />
              <Route path="suppliers" element={<SuppliersPage />} />
              <Route path="approvals" element={<WorkflowPage />} />
              <Route path="analytics" element={<AnalyticsDashboardPage />} />
              <Route path="notifications" element={<NotificationsPage />} />
              <Route path="notifications/workflow/:documentId" element={<NotificationWorkflowPage />} />
              <Route path=":id" element={<FormDetailPage />} />
              <Route path="forms/new/builder" element={<RequisitionFormBuilder />} />
              <Route path="profile" element={<ProfilePage />} />
              
              {/* Admin-only routes */}
              <Route path="admin/templates" element={<RequireAdmin><TemplatesPage /></RequireAdmin>} />
              <Route path="admin/users" element={<RequireAdmin><UsersPage /></RequireAdmin>} />
              <Route path="admin/users/:id" element={<RequireAdmin><UserDetailPage /></RequireAdmin>} />
              <Route path="admin/departments" element={<RequireAdmin><DepartmentsPage /></RequireAdmin>} />
              <Route path="admin/groups" element={<RequireAdmin><GroupsPage /></RequireAdmin>} />
              <Route path="admin/mailboxes" element={<RequireAdmin><AdminMailboxPage /></RequireAdmin>} />
              <Route path="admin/sunsystems" element={<RequireAdmin><AdminSunSystemsPage /></RequireAdmin>} />
              <Route path="workflow/builder" element={<RequireAdmin><WorkflowBuilderPage /></RequireAdmin>} />
            </Route>

            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </Suspense>
        <SessionDialogs />
        <VaultToaster />
      </>
    </AuthBootstrap>
  );
}
