"""
apps/documents/urls.py

Changes from previous version
──────────────────────────────
Added WebDAV route at /documents/webdav/<document_id>/<filename>

The <filename> segment is included in the URL so Microsoft Office can
determine the file format from the path (it uses the extension).  The
actual file served is always the current version for that document_id
regardless of what name is passed.

The WebDAV path is registered BEFORE the DefaultRouter entries so it is
matched before the '' catch-all router prefix.
"""
from django.urls import path
from rest_framework.routers import DefaultRouter
from .views import DocumentViewSet, DocumentTypeViewSet
from .webdav import DocumentWebDAVView

router = DefaultRouter()
# 'types' MUST be registered before the empty-prefix catch-all.
router.register(r"types", DocumentTypeViewSet, basename="document-type")
router.register(r"",      DocumentViewSet,     basename="document")

urlpatterns = [
    # ── WebDAV endpoint for native Office editing ──────────────────────────
    # Must appear before router.urls so it isn't swallowed by the catch-all.
    path(
        "webdav/<uuid:document_id>/<str:filename>",
        DocumentWebDAVView.as_view(),
        name="document-webdav",
    ),

    *router.urls,
]