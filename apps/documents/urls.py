"""
apps/documents/urls.py

Changes from previous version
──────────────────────────────
1. Registered three new viewsets:
     DocumentFolderViewSet       →  /documents/folders/
     DocumentFolderItemViewSet   →  /documents/folder-items/
     DocumentFavouriteViewSet    →  /documents/favourites/

2. WebDAV patterns unchanged.
"""
from django.urls import path
from rest_framework.routers import DefaultRouter
from .views import DocumentViewSet, DocumentTypeViewSet, DocTypeColorView, DMSSettingsView
from .webdav import DocumentWebDAVView
from .bulk_upload_views import BulkUploadViewSet
from .folder_views import (
    DocumentFolderViewSet,
    DocumentFolderItemViewSet,
    DocumentFavouriteViewSet,
)
from .signature_views import SignatureRequestViewSet
from .pdf_tools_views import PdfToolView

router = DefaultRouter()
router.register(r"bulk-uploads", BulkUploadViewSet, basename="bulk-upload")
router.register(r"types",        DocumentTypeViewSet,       basename="document-type")
router.register(r"folders",      DocumentFolderViewSet,     basename="document-folder")
router.register(r"folder-items", DocumentFolderItemViewSet, basename="folder-item")
router.register(r"favourites",   DocumentFavouriteViewSet,  basename="document-favourite")
router.register(r"signature-requests", SignatureRequestViewSet, basename="signature-request")
# Register documents last so its empty-prefix doesn't shadow the others
router.register(r"",             DocumentViewSet,           basename="document")

urlpatterns = [
    # Collection actions on the empty-prefix DocumentViewSet must sit before
    # router detail routes, otherwise names like "email_selected" can be read
    # as a document pk by some route orderings.
    path(
        "email_selected/",
        DocumentViewSet.as_view({"post": "email_selected"}),
        name="document-email-selected",
    ),
    path(
        "share_selected/",
        DocumentViewSet.as_view({"post": "share_selected"}),
        name="document-share-selected",
    ),
    # ── WebDAV ─────────────────────────────────────────────────────────────
    path(
        "webdav/<uuid:document_id>/",
        DocumentWebDAVView.as_view(),
        name="document-webdav-collection",
    ),
    path(
        "webdav/<uuid:document_id>/<str:filename>",
        DocumentWebDAVView.as_view(),
        name="document-webdav-legacy",
    ),
    path(
        "webdav/<uuid:document_id>/<str:token>/",
        DocumentWebDAVView.as_view(),
        name="document-webdav-token-root",
    ),
    path(
        "webdav/<uuid:document_id>/<str:token>/<path:filename>",
        DocumentWebDAVView.as_view(),
        name="document-webdav",
    ),
    path(
        "doc-type-colors/",
        DocTypeColorView.as_view(),
        name="document-type-colors",
    ),
    path(
        "settings/",
        DMSSettingsView.as_view(),
        name="document-settings",
    ),
    # In-app PDF editor server-side jobs (compress / convert). Must precede the
    # router so it isn't captured as a document <pk>.
    path(
        "pdf-tool/",
        PdfToolView.as_view(),
        name="document-pdf-tool",
    ),
    *router.urls,
]
