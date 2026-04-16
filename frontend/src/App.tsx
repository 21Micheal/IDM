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
import AdminDocumentTypesPage from "@/pages/AdminDocumentTypesPage";
import AuditPage from "@/pages/AuditPage";
import UsersPage from "@/pages/UsersPage";
import DepartmentsPage from "@/pages/DepartmentsPage";
import GroupsPage from "@/pages/GroupsPage";
import ProfilePage from "@/pages/ProfilePage";
import WorkflowBuilderPage from "@/pages/WorkflowBuilderPage";
import NotificationsPage from "@/pages/NotificationsPage";

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
  );
}
