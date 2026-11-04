"""
apps/documents/folder_serializers.py

Serializers for DocumentFolder, DocumentFolderItem, DocumentFavourite.
"""
from rest_framework import serializers
from .models import DocumentFolder, DocumentFolderItem, DocumentFavourite, DocumentFolderShare
from .models import Document


# ── Helpers ───────────────────────────────────────────────────────────────────

MAX_FOLDER_DEPTH = 4        # 0-indexed → 5 visible levels
MAX_FOLDERS_PER_USER = 200  # safety cap


class DocumentFolderSerializer(serializers.ModelSerializer):
    """
    Flat representation.  Used for list / create / update.
    child_count and document_count are read-only annotation fields.
    """
    child_count    = serializers.IntegerField(read_only=True, default=0)
    document_count = serializers.IntegerField(read_only=True, default=0)
    parent_name    = serializers.SerializerMethodField()
    is_shared      = serializers.SerializerMethodField()
    share_permissions = serializers.SerializerMethodField()
    shared_by_name = serializers.SerializerMethodField()

    class Meta:
        model  = DocumentFolder
        fields = [
            "id", "parent", "parent_name", "name", "color", "icon",
            "is_favourites", "is_system", "position",
            "is_shared", "share_permissions", "shared_by_name",
            "child_count", "document_count",
            "created_at", "updated_at",
        ]
        read_only_fields = [
            "id", "is_favourites", "is_system",
            "child_count", "document_count",
            "created_at", "updated_at",
        ]

    def get_parent_name(self, obj):
        return obj.parent.name if obj.parent_id else None

    def _active_shares(self, obj):
        request = self.context.get("request")
        if not request or obj.owner_id == request.user.id:
            return []
        from .folder_sharing import folder_shares_for_folder
        return list(folder_shares_for_folder(request.user, obj))

    def get_is_shared(self, obj):
        return obj.owner_id != self.context.get("request").user.id if self.context.get("request") else False

    def get_share_permissions(self, obj):
        return sorted({permission for share in self._active_shares(obj) for permission in share.effective_permissions})

    def get_shared_by_name(self, obj):
        shares = self._active_shares(obj)
        return shares[0].shared_by.get_full_name() or shares[0].shared_by.email if shares else None

    # ── Validation ─────────────────────────────────────────────────────────

    def validate_parent(self, parent):
        request = self.context["request"]
        if parent is None:
            return parent
        # Must own the parent
        if parent.owner_id != request.user.id:
            raise serializers.ValidationError("Parent folder not found.")
        # Depth guard
        if parent.depth >= MAX_FOLDER_DEPTH:
            raise serializers.ValidationError(
                f"Folders can be nested at most {MAX_FOLDER_DEPTH + 1} levels deep."
            )
        return parent

    def validate_name(self, name):
        name = name.strip()
        if not name:
            raise serializers.ValidationError("Folder name cannot be blank.")
        if len(name) > 120:
            raise serializers.ValidationError("Folder name is too long (max 120 chars).")
        forbidden = set('/\\:*?"<>|')
        bad = forbidden & set(name)
        if bad:
            raise serializers.ValidationError(
                f"Folder name contains forbidden characters: {', '.join(sorted(bad))}"
            )
        return name

    def validate(self, attrs):
        request = self.context["request"]
        user    = request.user

        # Global cap
        if not self.instance:
            count = DocumentFolder.objects.filter(owner=user).count()
            if count >= MAX_FOLDERS_PER_USER:
                raise serializers.ValidationError(
                    f"You cannot create more than {MAX_FOLDERS_PER_USER} folders."
                )

        # Uniqueness check within the parent scope (the DB constraint catches races
        # but we want a readable error message)
        parent = attrs.get("parent", getattr(self.instance, "parent", None))
        name   = attrs.get("name",   getattr(self.instance, "name",   ""))
        qs = DocumentFolder.objects.filter(owner=user, parent=parent, name=name)
        if self.instance:
            qs = qs.exclude(pk=self.instance.pk)
        if qs.exists():
            raise serializers.ValidationError(
                {"name": "A folder with this name already exists at this level."}
            )
        return attrs

    def create(self, validated_data):
        validated_data["owner"] = self.context["request"].user
        return super().create(validated_data)


class DocumentFolderTreeSerializer(serializers.ModelSerializer):
    """
    Recursive tree serializer — used for the sidebar tree endpoint.
    Children are eagerly resolved one level at a time (avoids N+1 via
    prefetch_related("children") in the viewset).
    """
    children       = serializers.SerializerMethodField()
    document_count = serializers.IntegerField(read_only=True, default=0)

    class Meta:
        model  = DocumentFolder
        fields = [
            "id", "parent", "name", "color", "icon",
            "is_favourites", "is_system", "position",
            "document_count", "children",
        ]

    def get_children(self, obj):
        # Relies on prefetch_related("children") being set on the queryset
        children = obj.children.all()
        return DocumentFolderTreeSerializer(
            children, many=True, context=self.context
        ).data


class DocumentFolderItemSerializer(serializers.ModelSerializer):
    document_title          = serializers.CharField(source="document.title",            read_only=True)
    document_reference      = serializers.CharField(source="document.reference_number", read_only=True)
    document_status         = serializers.CharField(source="document.status",           read_only=True)
    document_type_name      = serializers.CharField(source="document.document_type.name", read_only=True)
    document_file_mime_type = serializers.CharField(source="document.file_mime_type",   read_only=True)
    document_file_name      = serializers.CharField(source="document.file_name",        read_only=True)
    document_updated_at     = serializers.DateTimeField(source="document.updated_at",   read_only=True)

    class Meta:
        model  = DocumentFolderItem
        fields = [
            "id", "folder", "document", "position", "added_at",
            "document_title", "document_reference", "document_status",
            "document_type_name", "document_file_mime_type", "document_file_name",
            "document_updated_at",
        ]
        read_only_fields = ["id", "added_at"]

    def validate(self, attrs):
        request = self.context["request"]
        folder  = attrs["folder"]
        doc     = attrs["document"]

        # Must own the folder
        if folder.owner_id != request.user.id:
            raise serializers.ValidationError({"folder": "Folder not found."})

        from .file_streaming import user_can_view_document
        if not user_can_view_document(request.user, doc):
            raise serializers.ValidationError({"document": "Document not found."})

        return attrs

    def create(self, validated_data):
        validated_data["added_by"] = self.context["request"].user
        instance, _ = DocumentFolderItem.objects.get_or_create(
            folder=validated_data["folder"],
            document=validated_data["document"],
            defaults={"added_by": validated_data["added_by"], "position": validated_data.get("position", 0)},
        )
        return instance


class DocumentFavouriteSerializer(serializers.ModelSerializer):
    document_title          = serializers.CharField(source="document.title",            read_only=True)
    document_reference      = serializers.CharField(source="document.reference_number", read_only=True)
    document_status         = serializers.CharField(source="document.status",           read_only=True)
    document_type_name      = serializers.CharField(source="document.document_type.name", read_only=True)
    document_file_mime_type = serializers.CharField(source="document.file_mime_type",   read_only=True)
    document_file_name      = serializers.CharField(source="document.file_name",        read_only=True)
    document_updated_at     = serializers.DateTimeField(source="document.updated_at",   read_only=True)

    class Meta:
        model  = DocumentFavourite
        fields = [
            "id", "document",
            "document_title", "document_reference", "document_status",
            "document_type_name", "document_file_mime_type", "document_file_name",
            "document_updated_at",
            "access_count", "added_at", "last_accessed",
        ]
        read_only_fields = [
            "id", "access_count", "added_at", "last_accessed",
        ]

    def validate_document(self, doc):
        request = self.context["request"]
        from .file_streaming import user_can_view_document
        if not user_can_view_document(request.user, doc):
            raise serializers.ValidationError("Document not found.")
        return doc

    def create(self, validated_data):
        validated_data["user"] = self.context["request"].user
        instance, _ = DocumentFavourite.objects.get_or_create(
            user=validated_data["user"],
            document=validated_data["document"],
        )
        return instance


class FolderReorderSerializer(serializers.Serializer):
    """Body for PATCH /folders/reorder/ — ordered list of folder IDs."""
    items = serializers.ListField(
        child=serializers.DictField(child=serializers.CharField()),
        min_length=1,
    )

    def validate_items(self, items):
        for item in items:
            if "id" not in item:
                raise serializers.ValidationError("Each item must have an 'id' field.")
        return items


class DocumentFolderShareSerializer(serializers.Serializer):
    recipient_user_ids = serializers.ListField(
        child=serializers.UUIDField(), min_length=1, max_length=100,
    )
    permissions = serializers.ListField(
        child=serializers.ChoiceField(choices=["view", "download", "comment", "edit"]),
        required=False,
        default=["view"],
    )
    message = serializers.CharField(required=False, allow_blank=True, default="", max_length=2000)
    expires_at = serializers.DateTimeField(required=False, allow_null=True)

    def validate_recipient_user_ids(self, value):
        if len(set(value)) != len(value):
            raise serializers.ValidationError("Recipient list contains duplicates.")
        return value

    def validate_permissions(self, value):
        if len(set(value)) != len(value):
            raise serializers.ValidationError("Permission list contains duplicates.")
        return sorted(set(value) | {"view"})

    def validate_expires_at(self, value):
        from django.utils import timezone
        if value is not None and value <= timezone.now():
            raise serializers.ValidationError("Expiry must be in the future.")
        return value


class FolderAccessRequestSerializer(serializers.Serializer):
    permissions = serializers.ListField(
        child=serializers.ChoiceField(choices=["download", "comment", "edit"]),
        required=False,
        default=["edit"],
        allow_empty=False,
    )

    def validate_permissions(self, value):
        if len(set(value)) != len(value):
            raise serializers.ValidationError("Permission list contains duplicates.")
        return sorted(set(value) | {"view"})
