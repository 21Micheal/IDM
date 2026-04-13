from django.contrib import admin
from django.urls import path, include
from django.conf import settings
from django.conf.urls.static import static
from rest_framework_simplejwt.views import TokenRefreshView

urlpatterns = [
    path("admin/",              admin.site.urls),

    # Auth + user management + departments (all from accounts app)
    path("api/v1/",             include("apps.accounts.urls")),

    # Documents, types, tags
    path("api/v1/documents/",   include("apps.documents.urls")),

    # Workflows
    path("api/v1/workflows/",   include("apps.workflows.urls")),

    # Audit trail
    path("api/v1/audit/",       include("apps.audit.urls")),

    # Elasticsearch search
    path("api/v1/search/",      include("apps.search.urls")),

    # In-app notifications
    path("api/v1/notifications/", include("apps.notifications.urls")),

    # JWT refresh
    path("api/v1/token/refresh/", TokenRefreshView.as_view(), name="token_refresh"),

] + static(settings.MEDIA_URL, document_root=settings.MEDIA_ROOT)
