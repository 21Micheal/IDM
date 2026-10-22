# Procurement Deployment Configuration Guide

This document explains how to configure the IDM application for a procurement deployment, including how to add or remove features from a deployment.

## Overview

The procurement deployment is a white-labeled version of IDM that exposes only requisition-related functionality. All other DMS features (documents, search, audit, etc.) are removed from the routing and navigation to prevent access even if users attempt to modify URLs.

## Current Procurement Deployment Scope

The procurement deployment includes the following features:

### Lightweight Container Configuration

For production deployments of the procurement system, use the lightweight docker-compose configuration that excludes OCR and Office conversion services:

```bash
# Start the procurement deployment (lightweight, no OCR)
docker compose -f docker-compose.procurement.yml up --build
```

**Excluded services** (to reduce resource usage):
- `celery_ocr` - PaddleOCR/Tesseract text extraction
- `celery_preview` - Office document preview generation (LibreOffice)

**Kept services**:
- `celery_worker` - General tasks (indexing, notifications)
- Document viewer - For viewing supplier invoices/PDFs
- Elasticsearch - Full-text search
- All core backend functionality
- Form builder and requisition workflows

This configuration significantly reduces memory and CPU requirements while maintaining all essential procurement functionality. Users can still view supplier invoices and PDFs, but automated OCR extraction and Office document conversion are not available.

### Core Features

### Core Features
- **Requisition Dashboard** (`/`) - Main landing page
- **Requisitions List** (`/list`) - View and manage requisitions
- **New Requisition** (`/new`) - Create new requisitions using dynamic form templates
- **Suppliers** (`/suppliers`) - Supplier management and SunSystems integration
- **Approvals** (`/approvals`) - Workflow approval queue
- **Analytics** (`/analytics`) - Requisition analytics and reporting
- **Notifications** (`/notifications`) - Task notifications and workflow alerts
- **Profile** (`/profile`) - User profile settings

### Administration Features (Admin Only)
- **Templates** (`/admin/templates`) - Form template management
- **Form Builder** (`/forms/new/builder`) - Create requisition form templates
- **Users** (`/admin/users`) - User management
- **Departments** (`/admin/departments`) - Department management
- **Groups** (`/admin/groups`) - Group management
- **Mailboxes** (`/admin/mailboxes`) - Email ingestion configuration
- **SunSystems** (`/admin/sunsystems`) - SunSystems integration settings
- **Workflow Builder** (`/workflow/builder`) - Workflow routing configuration

### Excluded Features
The following DMS features are **not available** in the procurement deployment:
- Document management (`/documents`)
- Document upload/scan (`/documents/upload`, `/documents/scan`)
- Document review queue (`/documents/review`)
- Personal documents (`/personal-documents`)
- Forms (`/forms`, `/forms/new`)
- Signature requests (`/request-signature`)
- Payment run (`/payment-run`)
- Search (`/search`)
- Audit trail (`/audit`)
- Admin settings (`/admin/settings`)
- Document types (`/admin/document-types`)
- IDM migration (`/admin/migration`)

## Adding a Feature to the Procurement Deployment

To add a feature to the procurement deployment:

### 1. Add the Page Import

In `frontend/src/App.tsx`, add a lazy import for the page component:

```typescript
const YourPage = lazy(() => import("@/pages/YourPage"));
```

### 2. Add the Route

In the protected route section (`/`), add the route:

```typescript
<Route path="your-feature" element={<YourPage />} />
```

For admin-only features, wrap with `RequireAdmin`:

```typescript
<Route path="admin/your-feature" element={<RequireAdmin><YourPage /></RequireAdmin>} />
```

### 3. Add Navigation (Optional)

If the feature should appear in the sidebar, add it to `frontend/src/components/shared/Layout.tsx`:

```typescript
{
  label: "Your Feature",
  icon: YourIcon,
  path: "/your-feature",
  module: "your_module", // Optional: for deployment-based filtering
}
```

### 4. Update Route Fallback (Optional)

Add a fallback message in `ROUTE_FALLBACK_CONTENT` in `frontend/src/App.tsx`:

```typescript
{
  match: (pathname: string) => pathname.startsWith("/your-feature"),
  title: "Preparing your feature",
  description: "Loading your feature tools and data.",
}
```

## Removing a Feature from the Procurement Deployment

To remove a feature from the procurement deployment:

### 1. Remove the Route

In `frontend/src/App.tsx`, remove the route from the protected section:

```typescript
// Remove this line:
<Route path="your-feature" element={<YourPage />} />
```

### 2. Remove the Import (Optional)

If the component is no longer used anywhere, remove the lazy import:

```typescript
// Remove this line:
const YourPage = lazy(() => import("@/pages/YourPage"));
```

### 3. Remove Navigation

In `frontend/src/components/shared/Layout.tsx`, remove the navigation item from the sidebar.

### 4. Remove Route Fallback (Optional)

Remove the corresponding entry from `ROUTE_FALLBACK_CONTENT` in `frontend/src/App.tsx`.

## Backend API Scope Enforcement

The frontend routing changes prevent UI access, but backend APIs should also enforce deployment scope. This is handled through:

### Deployment Model

The `ClientDeployment` model in `apps/accounts/models.py` defines:
- `deployment_mode`: Current deployment mode (`full`, `procurement`, `forms_only`, `custom`)
- `enabled_modules`: JSON field listing enabled modules
- `primary_color`: Brand color
- `product_name`: Product name for branding

### Deployment Permission Class

The `DeploymentScopePermission` class in `apps/documents/permissions.py` can be used to enforce API scope based on deployment mode.

Example usage in a view:

```python
from apps.documents.permissions import DeploymentScopePermission

class YourAPIView(APIView):
    permission_classes = [DeploymentScopePermission]
    required_modules = ['your_module']  # Only allow if this module is enabled
```

## Database Configuration

To set the deployment mode in the database:

```bash
# Using PostgreSQL
pg exec idm-backend-1 python manage.py shell

>>> from apps.accounts.models import ClientDeployment
>>> deployment = ClientDeployment.objects.get_or_create(id=1)[0]
>>> deployment.deployment_mode = 'procurement'
>>> deployment.enabled_modules = ['forms', 'workflow', 'suppliers', 'notifications']
>>> deployment.primary_color = '#0f172a'
>>> deployment.product_name = 'REQUISITION PORTAL'
>>> deployment.save()
```

## Frontend Branding

The deployment branding is applied through the `DeploymentBranding` component in `frontend/src/App.tsx`:

- Sets the CSS variable `--color-brand` for the primary color
- Sets the document title to the product name

## Creating a New Deployment

To create a new deployment with a different feature set:

### 1. Copy the Procurement Route Structure

Create a new route section in `frontend/src/App.tsx` with a different base path:

```typescript
<Route
  path="/your-deployment"
  element={
    <RequireAuth>
      <RequirePasswordChanged>
        <Layout brandName="YOUR DEPLOYMENT" />
      </RequirePasswordChanged>
    </RequireAuth>
  }
>
  {/* Add your deployment-specific routes */}
</Route>
```

### 2. Create a Deployment-Specific Layout (Optional)

If the deployment needs a different layout structure, create a new Layout component (e.g., `YourDeploymentLayout.tsx`) and use it instead of the shared Layout.

### 3. Configure Database

Set the deployment mode and enabled modules in the database as shown above.

### 4. Add Route Guard (Optional)

To enforce deployment-specific access based on the database configuration, add a guard component:

```typescript
function RequireDeploymentMode({ allowedModes, children }: { allowedModes: string[], children: React.ReactNode }) {
  const deployment = useAuthStore((s) => s.deployment);
  if (!deployment || !allowedModes.includes(deployment.deployment_mode)) {
    return <Navigate to="/" replace />;
  }
  return <>{children}</>;
}
```

Use it around your deployment routes:

```typescript
<Route
  path="/your-deployment"
  element={
    <RequireAuth>
      <RequirePasswordChanged>
        <RequireDeploymentMode allowedModes={['your_mode']}>
          <Layout brandName="YOUR DEPLOYMENT" />
        </RequireDeploymentMode>
      </RequirePasswordChanged>
    </RequireAuth>
  }
>
  {/* Routes */}
</Route>
```

## Testing Deployment Changes

After modifying the deployment configuration:

1. **Clear browser cache** - Hard refresh (Ctrl+Shift+R or Cmd+Shift+R)
2. **Sign out and sign back in** - To trigger a fresh deployment config fetch
3. **Test URL manipulation** - Attempt to access removed features by URL to confirm they redirect
4. **Verify navigation** - Check that only intended features appear in the sidebar
5. **Test admin access** - Verify admin-only features are properly restricted

## Important Notes

- **Always remove routes, don't just hide them** - Users can modify URLs to access hidden routes
- **Backend enforcement is critical** - Frontend routing is a UX convenience, not a security boundary
- **Test both authenticated and unauthenticated states** - Ensure the login flow works correctly
- **Consider data dependencies** - Removing a feature may leave orphaned data in the database
- **Document custom deployments** - Create a similar guide for any new deployment configurations

## Troubleshooting

### Feature still accessible via URL

- Check that the route was actually removed from `frontend/src/App.tsx`
- Verify the route isn't defined in a parent Route component
- Clear browser cache and hard refresh

### Navigation item missing

- Check that the navigation item was added to `Layout.tsx`
- Verify the path matches the route exactly
- Check for conditional rendering based on user roles or modules

### Branding not applying

- Verify the deployment configuration in the database
- Check the browser console for errors in the `DeploymentBranding` component
- Ensure the deployment endpoint `/auth/deployment/` is returning data

### Admin features not visible

- Verify the user has `has_admin_access: true`
- Check that admin routes are wrapped with `RequireAdmin`
- Clear the auth store state by signing out and back in
