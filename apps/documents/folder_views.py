"""
apps/documents/folder_views.py

ViewSets for DocumentFolder, DocumentFolderItem, DocumentFavourite.

Register in urls.py:
    router.register(r"folders",          DocumentFolderViewSet,      basename="document-folder")
    router.register(r"folder-items",     DocumentFolderItemViewSet,  basename="folder-item")
    router.register(r"favourites",       DocumentFavouriteViewSet,   basename="document-favourite")
"""
from django.db import models as db_models
from django.db import transaction
from django.shortcuts import get_object_or_404
from django.utils import timezone

from rest_framework import viewsets, status, permissions
from rest_framework.decorators import action
from rest_framework.response import Response

from .models import Document, DocumentFolder, DocumentFolderItem, DocumentFavourite, DocumentShare
from .folder_serializers import (
    DocumentFolderSerializer,
    DocumentFolderTreeSerializer,
    DocumentFolderItemSerializer,
    DocumentFavouriteSerializer,
    FolderReorderSerializer,
)


def _prune_saved_documents_no_longer_visible(user):
    """Remove expired/revoked shared shortcuts so folders never link to 404s."""
    now = timezone.now()
    stale_share_ids = DocumentShare.objects.filter(recipient=user).filter(
        db_models.Q(revoked_at__isnull=False)
        | db_models.Q(expires_at__isnull=False, expires_at__lte=now)
    ).values("document_id")
    candidate_ids = set(DocumentFavourite.objects.filter(
        user=user, document_id__in=stale_share_ids,
    ).values_list("document_id", flat=True))
    candidate_ids.update(DocumentFolderItem.objects.filter(
        folder__owner=user, document_id__in=stale_share_ids,
    ).values_list("document_id", flat=True))
    if not candidate_ids:
        return
    from .file_streaming import user_can_view_document
    docs = {doc.id: doc for doc in Document.objects.filter(id__in=candidate_ids).select_related("document_type", "uploaded_by")}
    inaccessible = [doc_id for doc_id, doc in docs.items() if not user_can_view_document(user, doc)]
    if inaccessible:
        DocumentFavourite.objects.filter(user=user, document_id__in=inaccessible).delete()
        DocumentFolderItem.objects.filter(folder__owner=user, document_id__in=inaccessible).delete()


class DocumentFolderViewSet(viewsets.ModelViewSet):
    """
    CRUD for user folders + tree endpoint + reorder.

    All operations are scoped to request.user — users can never see or
    modify each other's folders.
    """
    permission_classes = [permissions.IsAuthenticated]
    serializer_class   = DocumentFolderSerializer

    def get_queryset(self):
        if getattr(self, "action", None) in ("list", "retrieve", "documents"):
            _prune_saved_documents_no_longer_visible(self.request.user)
        return (
            DocumentFolder.objects
            .filter(owner=self.request.user)
            .annotate(
                child_count=db_models.Count("children", distinct=True),
                document_count=db_models.Count("items",    distinct=True),
            )
            .select_related("parent")
            .order_by("position", "name")
        )

    # ── Extra endpoints ────────────────────────────────────────────────────

    @action(detail=False, methods=["get"])
    def tree(self, request):
        """
        Return a recursive tree of all the user's folders.
        Always includes the system Favourites folder (auto-creating it if
        this is the user's first visit).
        """
        _prune_saved_documents_no_longer_visible(request.user)
        # Ensure Favourites exists
        DocumentFolder.get_or_create_favourites(request.user)

        roots = (
            DocumentFolder.objects
            .filter(owner=request.user, parent__isnull=True)
            .annotate(document_count=db_models.Count("items", distinct=True))
            .prefetch_related(
                db_models.Prefetch(
                    "children",
                    queryset=DocumentFolder.objects
                    .filter(owner=request.user)
                    .annotate(document_count=db_models.Count("items", distinct=True))
                    .prefetch_related(
                        db_models.Prefetch(
                            "children",
                            queryset=DocumentFolder.objects
                            .filter(owner=request.user)
                            .annotate(document_count=db_models.Count("items", distinct=True))
                            .prefetch_related("children")
                        )
                    )
                )
            )
            .order_by("position", "name")
        )
        serializer = DocumentFolderTreeSerializer(
            roots, many=True, context={"request": request}
        )
        return Response(serializer.data)

    @action(detail=False, methods=["patch"], url_path="reorder")
    def reorder(self, request):
        """
        Bulk-update position field.
        Body: { "items": [{"id": "...", "position": 0}, ...] }
        """
        serializer = FolderReorderSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        items = serializer.validated_data["items"]

        with transaction.atomic():
            for item in items:
                DocumentFolder.objects.filter(
                    id=item["id"],
                    owner=request.user,
                ).update(position=int(item.get("position", 0)))

        return Response({"detail": "Reordered."})

    @action(detail=True, methods=["get"])
    def documents(self, request, pk=None):
        """
        List documents inside a folder (paginated).
        Returns lightweight document cards — the full document detail is
        fetched via the existing /documents/{id}/ endpoint.
        """
        folder = self.get_object()
        items  = (
            DocumentFolderItem.objects
            .filter(folder=folder)
            .select_related(
                "document__document_type",
                "document__uploaded_by",
            )
            .order_by("position", "added_at")
        )
        serializer = DocumentFolderItemSerializer(
            items, many=True, context={"request": request}
        )
        return Response(serializer.data)

    @action(detail=True, methods=["post"], url_path="add-document")
    def add_document(self, request, pk=None):
        """
        Add a document to this folder.
        Body: { "document": "<uuid>" }
        """
        folder = self.get_object()
        data   = {**request.data, "folder": str(folder.id)}
        serializer = DocumentFolderItemSerializer(
            data=data, context={"request": request}
        )
        serializer.is_valid(raise_exception=True)
        serializer.save()
        return Response(serializer.data, status=status.HTTP_201_CREATED)

    @action(detail=True, methods=["delete"], url_path="remove-document/(?P<document_id>[^/.]+)")
    def remove_document(self, request, pk=None, document_id=None):
        """Remove a document from this folder."""
        folder = self.get_object()
        deleted, _ = DocumentFolderItem.objects.filter(
            folder=folder, document_id=document_id
        ).delete()
        if not deleted:
            return Response({"detail": "Document not in this folder."}, status=404)
        return Response(status=status.HTTP_204_NO_CONTENT)

    # ── Standard overrides ─────────────────────────────────────────────────

    def perform_destroy(self, instance):
        if instance.is_system:
            from rest_framework.exceptions import PermissionDenied
            raise PermissionDenied("System folders cannot be deleted.")
        instance.delete()

    def perform_update(self, serializer):
        instance = self.get_object()
        if instance.is_system:
            # Allow only color/icon/position changes on system folders
            allowed = {"color", "icon", "position"}
            if set(serializer.validated_data.keys()) - allowed:
                from rest_framework.exceptions import PermissionDenied
                raise PermissionDenied(
                    "Only color, icon, and position can be changed on system folders."
                )
        serializer.save()


class DocumentFolderItemViewSet(viewsets.ModelViewSet):
    """
    Direct CRUD on folder-document links (for drag-and-drop reordering etc.).
    Most callers use DocumentFolderViewSet.add_document instead.
    """
    permission_classes = [permissions.IsAuthenticated]
    serializer_class   = DocumentFolderItemSerializer

    def get_queryset(self):
        if getattr(self, "action", None) == "list":
            _prune_saved_documents_no_longer_visible(self.request.user)
        return (
            DocumentFolderItem.objects
            .filter(folder__owner=self.request.user)
            .select_related("document__document_type", "folder")
            .order_by("folder", "position", "added_at")
        )

    @action(detail=False, methods=["patch"], url_path="reorder")
    def reorder(self, request):
        """
        Bulk reorder items within a folder.
        Body: { "folder": "<uuid>", "items": [{"id": "<item_uuid>", "position": 0}, ...] }
        """
        folder_id = request.data.get("folder")
        items     = request.data.get("items", [])
        if not folder_id:
            return Response({"detail": "folder is required."}, status=400)

        folder = get_object_or_404(
            DocumentFolder, id=folder_id, owner=request.user
        )
        with transaction.atomic():
            for item in items:
                DocumentFolderItem.objects.filter(
                    id=item["id"], folder=folder
                ).update(position=int(item.get("position", 0)))

        return Response({"detail": "Reordered."})


class DocumentFavouriteViewSet(viewsets.ModelViewSet):
    """
    Star / un-star documents.

    POST   /favourites/              { "document": "<uuid>" }   → star
    DELETE /favourites/{id}/                                     → un-star
    POST   /favourites/toggle/       { "document": "<uuid>" }   → toggle
    POST   /favourites/{id}/access/                              → record open
    GET    /favourites/              list of starred docs
    """
    permission_classes = [permissions.IsAuthenticated]
    serializer_class   = DocumentFavouriteSerializer
    http_method_names  = ["get", "post", "delete", "head", "options"]

    def get_queryset(self):
        if getattr(self, "action", None) in ("list", "retrieve", "access"):
            _prune_saved_documents_no_longer_visible(self.request.user)
        return (
            DocumentFavourite.objects
            .filter(user=self.request.user)
            .select_related("document__document_type")
            .order_by("-added_at")
        )

    @action(detail=False, methods=["post"])
    def toggle(self, request):
        """Star if not starred, un-star if already starred."""
        doc_id = request.data.get("document")
        if not doc_id:
            return Response({"detail": "document is required."}, status=400)

        existing = DocumentFavourite.objects.filter(
            user=request.user, document_id=doc_id
        ).first()

        if existing:
            existing.delete()
            return Response({"starred": False, "detail": "Removed from favourites."})

        from .models import Document
        try:
            doc = Document.objects.get(id=doc_id)
        except Document.DoesNotExist:
            return Response({"detail": "Document not found."}, status=404)

        from .file_streaming import user_can_view_document
        if not user_can_view_document(request.user, doc):
            return Response({"detail": "Document not found."}, status=404)

        fav = DocumentFavourite.objects.create(user=request.user, document=doc)
        serializer = self.get_serializer(fav)
        return Response(
            {**serializer.data, "starred": True},
            status=status.HTTP_201_CREATED,
        )

    @action(detail=True, methods=["post"])
    def access(self, request, pk=None):
        """Record that the user opened this favourite document."""
        fav = self.get_object()
        fav.record_access()
        return Response({"detail": "Access recorded."})

    @action(detail=False, methods=["get"])
    def check(self, request):
        """
        Quick membership check.
        GET /favourites/check/?document=<uuid>
        Returns { "starred": bool, "favourite_id": "<uuid>|null" }
        """
        doc_id = request.query_params.get("document")
        if not doc_id:
            return Response({"detail": "document query param required."}, status=400)
        _prune_saved_documents_no_longer_visible(request.user)
        fav = DocumentFavourite.objects.filter(
            user=request.user, document_id=doc_id
        ).first()
        return Response({
            "starred": fav is not None,
            "favourite_id": str(fav.id) if fav else None,
        })
