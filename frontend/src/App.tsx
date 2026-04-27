import { Suspense, lazy, useEffect, useState } from "react";
import { Routes, Route, Navigate, useLocation } from "react-router-dom";
import { useAuthStore } from "@/store/authStore";
import { authAPI } from "@/services/api";
import { VaultToaster } from "@/components/ui/vault-toast";
import { FlaxemLogo } from "@/components/shared/FlaxemLogo";

const Layout = lazy(() => import("@/components/shared/Layout"));
const LoginPage = lazy(() => import("@/pages/LoginPage"));
const ForceChangePasswordPage = lazy(() => import("@/pages/ForceChangePasswordPage"));
const DashboardPage = lazy(() => import("@/pages/DashboardPage"));
const DocumentsPage = lazy(() => import("@/pages/DocumentsPage"));
const DocumentDetailPage = lazy(() => import("@/pages/DocumentDetailPage"));
const UploadPage = lazy(() => import("@/pages/UploadPage"));
const SearchPage = lazy(() => import("@/pages/SearchPage"));
const WorkflowPage = lazy(() => import("@/pages/WorkflowPage"));
const AdminPage = lazy(() => import("@/pages/AdminPage"));
const AdminDocumentTypesPage = lazy(() => import("@/pages/AdminDocumentTypesPage"));
const AuditPage = lazy(() => import("@/pages/AuditPage"));
const UsersPage = lazy(() => import("@/pages/UsersPage"));
const DepartmentsPage = lazy(() => import("@/pages/DepartmentsPage"));
const GroupsPage = lazy(() => import("@/pages/GroupsPage"));
const ProfilePage = lazy(() => import("@/pages/ProfilePage"));
const WorkflowBuilderPage = lazy(() => import("@/pages/WorkflowBuilderPage"));
const NotificationsPage = lazy(() => import("@/pages/NotificationsPage"));

// ── Guards ────────────────────────────────────────────────────────────────────

function RequireAuth({ children }: { children: React.ReactNode }) {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  return isAuthenticated ? <>{children}</> : <Navigate to="/login" replace />;
}

function AuthBootstrap({ children }: { children: React.ReactNode }) {
  const accessToken = useAuthStore((s) => s.accessToken);
  const user = useAuthStore((s) => s.user);
  const setUser = useAuthStore((s) => s.setUser);
  const [ready, setReady] = useState(!accessToken || user?.has_admin_access !== undefined);

  useEffect(() => {
    let cancelled = false;

    if (!accessToken) {
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
          setUser(data);
        }
      })
      .catch(() => {
        // If the token is stale, the response interceptor will log the user out.
      })
      .finally(() => {
        if (!cancelled) {
          setReady(true);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [accessToken, setUser, user?.has_admin_access]);

  if (!ready) return null;
  return <>{children}</>;
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
    match: (pathname: string) => pathname.startsWith("/documents/upload"),
    title: "Preparing upload workspace",
    description: "Loading document intake, metadata capture, and OCR tools.",
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
        <FlaxemLogo className="h-12 w-auto" variant="dark" />
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

              {/* Documents */}
              <Route path="documents"        element={<DocumentsPage />} />
              <Route path="documents/upload" element={<UploadPage />} />
              <Route path="documents/:id"    element={<DocumentDetailPage />} />

              {/* Search */}
              <Route path="search"    element={<SearchPage />} />

              {/* Workflow */}
              <Route path="workflow"  element={<WorkflowPage />} />
              <Route path="workflow/builder" element={  <RequireAdmin> <WorkflowBuilderPage />  </RequireAdmin>  }/>

              {/* Notifications */}
              <Route path="notifications" element={<NotificationsPage />} />

              {/* Audit */}
              <Route path="audit"     element={<AuditPage />} />

              {/* Profile — every user */}
              <Route path="profile"   element={<ProfilePage />} />

              {/* Admin-only */}
              <Route path="admin/users"           element={<RequireAdmin><UsersPage /></RequireAdmin>} />
              <Route path="admin/settings"        element={<RequireAdmin><AdminPage /></RequireAdmin>} />
              <Route path="admin/document-types"  element={<RequireAdmin><AdminDocumentTypesPage /></RequireAdmin>} />
              <Route path="admin/departments"     element={<RequireAdmin><DepartmentsPage /></RequireAdmin>} />
              <Route path="admin/groups"          element={<RequireAdmin><GroupsPage /></RequireAdmin>} />
            </Route>

            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </Suspense>
        <VaultToaster />
      </>
    </AuthBootstrap>
  );
}
