import { Routes, Route, Navigate } from "react-router-dom";
import { useAuthStore } from "@/store/authStore";
import Layout from "@/components/shared/Layout";
import LoginPage from "@/pages/LoginPage";
import ForceChangePasswordPage from "@/pages/ForceChangePasswordPage";
import DashboardPage from "@/pages/DashboardPage";
import DocumentsPage from "@/pages/DocumentsPage";
import DocumentDetailPage from "@/pages/DocumentDetailPage";
import UploadPage from "@/pages/UploadPage";
import SearchPage from "@/pages/SearchPage";
import WorkflowPage from "@/pages/WorkflowPage";
import AdminPage from "@/pages/AdminPage";
import AuditPage from "@/pages/AuditPage";
import UsersPage from "@/pages/UsersPage";
import DepartmentsPage from "@/pages/DepartmentsPage";
import GroupsPage from "@/pages/GroupsPage";
import ProfilePage from "@/pages/ProfilePage";

// ── Guards ────────────────────────────────────────────────────────────────────

function RequireAuth({ children }: { children: React.ReactNode }) {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  return isAuthenticated ? <>{children}</> : <Navigate to="/login" replace />;
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
  if (user.role !== "admin") return <Navigate to="/" replace />;
  return <>{children}</>;
}

// ── App ───────────────────────────────────────────────────────────────────────

export default function App() {
  return (
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

        {/* Audit */}
        <Route path="audit"     element={<AuditPage />} />

        {/* Profile — every user */}
        <Route path="profile"   element={<ProfilePage />} />

        {/* Admin-only */}
        <Route path="users"       element={<RequireAdmin><UsersPage /></RequireAdmin>} />
        <Route path="departments" element={<RequireAdmin><DepartmentsPage /></RequireAdmin>} />
        <Route path="groups"      element={<RequireAdmin><GroupsPage /></RequireAdmin>} />
        <Route path="admin"       element={<RequireAdmin><AdminPage /></RequireAdmin>} />
      </Route>

      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
