"""
apps/documents/folder_views.py

ViewSets for DocumentFolder, DocumentFolderItem, DocumentFavourite.

Register in urls.py:
    router.register(r"folders",          DocumentFolderViewSet,      basename="document-folder")
    router.register(r"folder-items",     DocumentFolderItemViewSet,  basename="folder-item")
    router.register(r"favourites",       DocumentFavouriteViewSet,   basename="document-favourite")
"""
from datetime import timedelta
from django.db import models as db_models
from django.db import transaction
from django.shortcuts import get_object_or_404
from django.utils import timezone

from rest_framework import viewsets, status, permissions
from rest_framework.decorators import action
from rest_framework.response import Response

from .models import (
    Document, DocumentFolder, DocumentFolderItem, DocumentFavourite, DocumentShare,
    DocumentFolderShare, DocumentFolderShareAccessRequest,
)
from .folder_serializers import (
    DocumentFolderSerializer,
    DocumentFolderTreeSerializer,
    DocumentFolderItemSerializer,
    DocumentFavouriteSerializer,
    FolderReorderSerializer,
    DocumentFolderShareSerializer,
    FolderAccessRequestSerializer,
)
from apps.accounts.models import User
from apps.notifications.models import Notification
from .folder_sharing import active_folder_shares, descendant_folder_ids, folder_shares_for_folder, shared_folder_ids


def _prune_saved_documents_no_longer_visible(user):
    """Remove expired/revoked shared shortcuts so folders never link to 404s."""
    now = timezone.now()
    stale_share_ids = DocumentShare.objects.filter(recipient=user).filter(
        db_models.Q(revoked_at__isnull=False)
        | db_models.Q(expires_at__isnull=False, expires_at__lte=now)
    ).values("document_id")
    stale_folder_shares = DocumentFolderShare.objects.filter(recipient=user).filter(
        db_models.Q(revoked_at__isnull=False)
        | db_models.Q(expires_at__isnull=False, expires_at__lte=now)
    ).values_list("folder_id", flat=True)
    from .folder_sharing import descendant_folder_ids
    stale_folder_ids = descendant_folder_ids(stale_folder_shares)
    stale_folder_doc_ids = DocumentFolderItem.objects.filter(folder_id__in=stale_folder_ids).values("document_id")
    candidate_ids = set(DocumentFavourite.objects.filter(
        user=user,
    ).filter(
        db_models.Q(document_id__in=stale_share_ids) | db_models.Q(document_id__in=stale_folder_doc_ids)
    ).values_list("document_id", flat=True))
    candidate_ids.update(DocumentFolderItem.objects.filter(
        folder__owner=user,
    ).filter(
        db_models.Q(document_id__in=stale_share_ids) | db_models.Q(document_id__in=stale_folder_doc_ids)
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
        action = getattr(self, "action", None)
        if action in ("list", "retrieve", "documents"):
            _prune_saved_documents_no_longer_visible(self.request.user)
        queryset = DocumentFolder.objects
        if action in ("retrieve", "documents", "sharing", "request_access"):
            queryset = queryset.filter(
                db_models.Q(owner=self.request.user)
                | db_models.Q(id__in=shared_folder_ids(self.request.user))
            )
        else:
            queryset = queryset.filter(owner=self.request.user)
        return (
            queryset
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

    @action(detail=False, methods=["get"], url_path="shared")
    def shared(self, request):
        """List active folder shares received by the current user."""
        shares = active_folder_shares(request.user).select_related("folder", "folder__owner", "shared_by")
        results = []
        for share in shares:
            folder = share.folder
            folder_data = DocumentFolderSerializer(folder, context={"request": request}).data
            folder_data["children"] = DocumentFolderTreeSerializer(folder, context={"request": request}).data.get("children", [])
            results.append({
                **folder_data,
                "share_id": str(share.id),
                "shared_by_name": share.shared_by.get_full_name() or share.shared_by.email,
                "shared_by_email": share.shared_by.email,
                "share_permissions": share.effective_permissions,
                "share_expires_at": share.expires_at,
            })
        return Response(results)

    @action(detail=True, methods=["post"], url_path="share")
    def share(self, request, pk=None):
        folder = self.get_object()
        if folder.owner_id != request.user.id or folder.is_system:
            return Response({"detail": "Only the owner can share a non-system folder."}, status=403)
        serializer = DocumentFolderShareSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        data = serializer.validated_data
        recipients = list(User.objects.filter(id__in=data["recipient_user_ids"], is_active=True).exclude(id=request.user.id))
        if not recipients:
            return Response({"detail": "Select at least one active recipient other than yourself."}, status=400)
        shared_by = request.user.get_full_name().strip() or request.user.email
        for recipient in recipients:
            share, _ = DocumentFolderShare.objects.update_or_create(
                folder=folder,
                recipient=recipient,
                defaults={
                    "shared_by": request.user,
                    "permissions": data["permissions"],
                    "message": data["message"].strip(),
                    "expires_at": data.get("expires_at"),
                    "revoked_at": None,
                },
            )
            DocumentFolderShareAccessRequest.objects.filter(
                folder=folder, requester=recipient, status=DocumentFolderShareAccessRequest.Status.PENDING,
            ).update(status=DocumentFolderShareAccessRequest.Status.GRANTED)
            Notification.objects.create(
                recipient=recipient,
                type="document_shared",
                message=f"{shared_by} shared the folder '{folder.name}' with you.",
                link=f"/documents/folders/{folder.id}",
            )
        return Response({"shared": len(recipients), "permissions": data["permissions"]}, status=201)

    @action(detail=True, methods=["get"], url_path="sharing")
    def sharing(self, request, pk=None):
        folder = self.get_object()
        if folder.owner_id == request.user.id:
            shares = DocumentFolderShare.objects.filter(folder=folder).select_related("recipient")
            folder_ids = descendant_folder_ids([folder.id])
            locked_docs = Document.objects.filter(
                folder_items__folder_id__in=folder_ids,
                edit_locked_by__isnull=False,
                edit_locked_at__gte=timezone.now() - timedelta(hours=1),
            ).select_related("edit_locked_by").distinct()
            editing_by_user = {}
            for document in locked_docs:
                entry = editing_by_user.setdefault(str(document.edit_locked_by_id), [])
                entry.append(document.title)
            requests = DocumentFolderShareAccessRequest.objects.filter(
                folder=folder, status=DocumentFolderShareAccessRequest.Status.PENDING,
            ).select_related("requester")
            return Response({
                "can_manage": True,
                "recipients": [{
                    "id": str(share.recipient_id),
                    "name": share.recipient.get_full_name() or share.recipient.email,
                    "email": share.recipient.email,
                    "permissions": share.effective_permissions,
                    "expires_at": share.expires_at,
                    "is_active": share.is_active,
                    "revoked_at": share.revoked_at,
                    "editing_documents": editing_by_user.get(str(share.recipient_id), []),
                } for share in shares],
                "requests": [{
                    "id": str(item.id),
                    "requester_name": item.requester.get_full_name() or item.requester.email,
                    "requester_email": item.requester.email,
                    "permissions": item.requested_permissions,
                } for item in requests],
            })
        share = folder_shares_for_folder(request.user, folder).first()
        if not share:
            return Response({"detail": "You do not have access to this folder."}, status=403)
        request_item = DocumentFolderShareAccessRequest.objects.filter(folder=share.folder, requester=request.user).order_by("-created_at").first()
        return Response({
            "can_manage": False,
            "my_share": {"permissions": share.effective_permissions, "shared_by_name": share.shared_by.get_full_name() or share.shared_by.email, "expires_at": share.expires_at},
            "my_request": {"status": request_item.status} if request_item else None,
        })

    @action(detail=True, methods=["post"], url_path="manage-share")
    def manage_share(self, request, pk=None):
        folder = self.get_object()
        if folder.owner_id != request.user.id:
            return Response({"detail": "Only the folder owner can manage its shares."}, status=403)
        share = DocumentFolderShare.objects.filter(folder=folder, recipient_id=request.data.get("recipient_id")).first()
        if not share:
            return Response({"detail": "Recipient share not found."}, status=404)
        if request.data.get("revoke"):
            share.revoked_at = timezone.now()
            share.save(update_fields=["revoked_at", "updated_at"])
            return Response({"revoked": True})
        serializer = DocumentFolderShareSerializer(data={
            "recipient_user_ids": [str(share.recipient_id)],
            "permissions": request.data.get("permissions", share.effective_permissions),
            "message": share.message,
            "expires_at": request.data.get("expires_at", share.expires_at),
        })
        serializer.is_valid(raise_exception=True)
        share.permissions = serializer.validated_data["permissions"]
        share.expires_at = serializer.validated_data.get("expires_at")
        share.save(update_fields=["permissions", "expires_at", "updated_at"])
        return Response({"permissions": share.effective_permissions, "expires_at": share.expires_at})

    @action(detail=True, methods=["post"], url_path="request-access")
    def request_access(self, request, pk=None):
        folder = self.get_object()
        share = folder_shares_for_folder(request.user, folder).first()
        if not share:
            return Response({"detail": "Only direct recipients can request additional folder permissions."}, status=403)
        serializer = FolderAccessRequestSerializer(data=request.data or {})
        serializer.is_valid(raise_exception=True)
        folder = share.folder
        existing = DocumentFolderShareAccessRequest.objects.filter(folder=folder, requester=request.user).first()
        if existing and existing.status == DocumentFolderShareAccessRequest.Status.PENDING:
            existing.requested_permissions = serializer.validated_data["permissions"]
            existing.save(update_fields=["requested_permissions", "updated_at"])
            return Response({"status": existing.status}, status=200)
        request_item, _ = DocumentFolderShareAccessRequest.objects.update_or_create(
            folder=folder,
            requester=request.user,
            defaults={"requested_permissions": serializer.validated_data["permissions"], "status": DocumentFolderShareAccessRequest.Status.PENDING},
        )
        Notification.objects.create(
            recipient=share.shared_by,
            type="document_shared",
            message=f"{request.user.get_full_name() or request.user.email} requested additional access to folder '{folder.name}'.",
            link=f"/documents/folders/{folder.id}",
        )
        return Response({"status": request_item.status}, status=201)

    @action(detail=True, methods=["post"], url_path="manage-access-request")
    def manage_access_request(self, request, pk=None):
        folder = self.get_object()
        if folder.owner_id != request.user.id:
            return Response({"detail": "Only the folder owner can manage access requests."}, status=403)
        access_request = DocumentFolderShareAccessRequest.objects.filter(
            folder=folder, id=request.data.get("request_id"), status=DocumentFolderShareAccessRequest.Status.PENDING,
        ).select_related("requester").first()
        if not access_request:
            return Response({"detail": "Pending access request not found."}, status=404)
        grant = bool(request.data.get("grant"))
        share = DocumentFolderShare.objects.filter(folder=folder, recipient=access_request.requester).first()
        if grant:
            if not share or not share.is_active:
                return Response({"detail": "The recipient's folder share has expired or been revoked."}, status=400)
            share.permissions = sorted(set(share.effective_permissions) | set(access_request.requested_permissions) | {"view"})
            share.save(update_fields=["permissions", "updated_at"])
            access_request.status = DocumentFolderShareAccessRequest.Status.GRANTED
            Notification.objects.create(recipient=access_request.requester, type="document_shared", message=f"Additional access was granted for folder '{folder.name}'.", link=f"/documents/folders/{folder.id}")
        else:
            access_request.status = DocumentFolderShareAccessRequest.Status.DECLINED
        access_request.save(update_fields=["status", "updated_at"])
        return Response({"status": access_request.status})

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
