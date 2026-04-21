"""
apps/documents/urls.py

Changes from previous version
──────────────────────────────
1. Added a second WebDAV route for the bare /<id>/ path (no filename).

   LibreOffice (and some Windows Office builds) probe the *collection* URL
   before touching the file URL:
       HEAD /webdav/<id>/         <- no filename
       GET  /webdav/<id>/
   The old single-pattern required a filename, so these returned 404 —
   causing LibreOffice to abort with "cannot create in directory".

2. Changed <str:filename> to <path:filename> so filenames with spaces
   (%20) are captured correctly. <str:filename> stops at slashes.
"""
from django.urls import path
from rest_framework.routers import DefaultRouter
from .views import DocumentViewSet, DocumentTypeViewSet
from .webdav import DocumentWebDAVView

router = DefaultRouter()
router.register(r"types", DocumentTypeViewSet, basename="document-type")
router.register(r"",      DocumentViewSet,     basename="document")

urlpatterns = [
    # Bare collection URL — LibreOffice probes this before the file URL
    path(
        "webdav/<uuid:document_id>/",
        DocumentWebDAVView.as_view(),
        name="document-webdav-bare",
    ),
    # Full URL with filename — <path:> captures spaces and encoded chars
    path(
        "webdav/<uuid:document_id>/<path:filename>",
        DocumentWebDAVView.as_view(),
        name="document-webdav",
    ),
    *router.urls,
]