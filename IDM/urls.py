from django.contrib import admin
from django.urls import path, include
from django.conf import settings
from django.conf.urls.static import static
from rest_framework_simplejwt.views import TokenRefreshView

urlpatterns = [
    path("admin/", admin.site.urls),
    path("api/v1/auth/", include("apps.accounts.urls")),
    path("api/v1/documents/", include("apps.documents.urls")),
    path("api/v1/workflows/", include("apps.workflows.urls")),
    path("api/v1/audit/", include("apps.audit.urls")),
    path("api/v1/search/", include("apps.search.urls")),
    path("api/v1/notifications/", include("apps.notifications.urls")),
    path("api/v1/token/refresh/", TokenRefreshView.as_view(), name="token_refresh"),
] + static(settings.MEDIA_URL, document_root=settings.MEDIA_ROOT)
