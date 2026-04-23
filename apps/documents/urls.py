"""
apps/documents/urls.py

Fixes in this revision
──────────────────────────────
1. Updated WebDAV patterns to support token-in-path authentication.
   The primary route is now /webdav/<doc_id>/<token>/<filename>.
   This avoids 401 challenges in LibreOffice/MS Office.

2. Maintained legacy 2-segment and bare collection routes as fallbacks.
"""
from django.urls import path
from rest_framework.routers import DefaultRouter
from .views import DocumentViewSet, DocumentTypeViewSet
from .webdav import DocumentWebDAVView

router = DefaultRouter()
router.register(r"types", DocumentTypeViewSet, basename="document-type")
router.register(r"",      DocumentViewSet,     basename="document")

urlpatterns = [
    # Collection probe — no token, no filename (LibreOffice initial PROPFIND)
    path(
        "webdav/<uuid:document_id>/",
        DocumentWebDAVView.as_view(),
        name="document-webdav-collection",
    ),
    # Legacy 2-segment — filename only, no token (Basic-auth clients)
    path(
        "webdav/<uuid:document_id>/<str:filename>",
        DocumentWebDAVView.as_view(),
        name="document-webdav-legacy",
    ),
    # Tokenized collection path — LibreOffice probes the directory before
    # creating/saving the file.
    path(
        "webdav/<uuid:document_id>/<str:token>/",
        DocumentWebDAVView.as_view(),
        name="document-webdav-token-root",
    ),
    # ★ Primary — token + filename in path (LibreOffice / MS Office via URI scheme)
    path(
        "webdav/<uuid:document_id>/<str:token>/<path:filename>",
        DocumentWebDAVView.as_view(),
        name="document-webdav",
    ),
    *router.urls,
]