"""
apps/documents/serializers.py

Changes from previous version
──────────────────────────────
1. DocumentListSerializer  — exposes `is_self_upload` flag.
2. DocumentDetailSerializer — exposes `is_self_upload` flag.
3. DocumentUploadSerializer — accepts `is_self_upload` on POST;
   relaxes required-metadata validation for self-upload docs
   (the uploader may not know the formal metadata schema).
4. DocumentMetadataEditSerializer — no change.
5. DocumentBulkActionSerializer  — no change.
"""
from rest_framework import serializers
from .models import Document, DocumentType, MetadataField, DocumentVersion, DocumentComment, Tag
from apps.accounts.serializers import UserSummarySerializer
from apps.accounts.models import GroupAction


class TagSerializer(serializers.ModelSerializer):
    class Meta:
        model  = Tag
        fields = ["id", "name", "color"]


class MetadataFieldSerializer(serializers.ModelSerializer):
    class Meta:
        model  = MetadataField
        fields = [
            "id", "label", "key", "field_type", "is_required",
            "is_searchable", "select_options", "default_value", "help_text", "order",
        ]


class DocumentTypeSerializer(serializers.ModelSerializer):
    metadata_fields        = MetadataFieldSerializer(many=True, read_only=True)
    workflow_template_name = serializers.CharField(
        source="workflow_template.name", read_only=True, default=None
    )

    class Meta:
        model  = DocumentType
        fields = [
            "id", "name", "code", "reference_prefix", "reference_padding",
            "description", "icon", "is_active",
            "workflow_template", "workflow_template_name",
            "metadata_fields",
        ]


class DocumentVersionSerializer(serializers.ModelSerializer):
    created_by = UserSummarySerializer(read_only=True)

    class Meta:
        model  = DocumentVersion
        fields = [
            "id", "version_number", "file_name", "file_size",
            "change_summary", "created_by", "created_at",
        ]


class DocumentCommentSerializer(serializers.ModelSerializer):
    author = UserSummarySerializer(read_only=True)

    class Meta:
        model        = DocumentComment
        fields       = ["id", "author", "content", "is_internal", "created_at", "updated_at"]
        read_only_fields = ["id", "author", "created_at", "updated_at"]


class DocumentListSerializer(serializers.ModelSerializer):
    """Lightweight — list views only."""
    document_type_name = serializers.CharField(source="document_type.name", read_only=True)
    uploaded_by        = UserSummarySerializer(read_only=True)
    tags               = TagSerializer(many=True, read_only=True)
    permissions        = serializers.SerializerMethodField()

    class Meta:
        model  = Document
        fields = [
            "id", "title", "reference_number",
            "document_type", "document_type_name",
            "status", "supplier", "amount", "currency", "document_date",
            "file_name", "file_size", "file_mime_type",
            "uploaded_by", "tags", "permissions",
            "is_self_upload",                           # ← new
            "current_version", "created_at", "updated_at",
        ]

    def get_permissions(self, obj):
        request = self.context.get("request")
        user = getattr(request, "user", None)
        if not user or not user.is_authenticated:
            return []
        if user.is_admin:
            return [choice[0] for choice in GroupAction.choices]
        # Self-upload docs: owner gets a fixed permission set
        if obj.is_self_upload and obj.uploaded_by_id == user.id:
            return [
                GroupAction.VIEW.value,
                GroupAction.EDIT.value,
                GroupAction.UPLOAD.value,
                GroupAction.DELETE.value,
                GroupAction.DOWNLOAD.value,
                GroupAction.COMMENT.value,
                GroupAction.ARCHIVE.value,
            ]
        return sorted(user.get_all_permissions_for_doctype(str(obj.document_type_id)))


class DocumentDetailSerializer(serializers.ModelSerializer):
    """Full detail — used for GET /documents/{id}/"""
    document_type    = DocumentTypeSerializer(read_only=True)
    document_type_id = serializers.PrimaryKeyRelatedField(
        queryset=DocumentType.objects.filter(is_active=True),
        source="document_type", write_only=True,
    )
    uploaded_by = UserSummarySerializer(read_only=True)
    tags        = TagSerializer(many=True, read_only=True)
    tag_ids     = serializers.PrimaryKeyRelatedField(
        queryset=Tag.objects.all(), many=True, source="tags",
        write_only=True, required=False,
    )
    versions    = DocumentVersionSerializer(many=True, read_only=True)
    comments    = serializers.SerializerMethodField()
    permissions = serializers.SerializerMethodField()

    class Meta:
        model  = Document
        fields = [
            "id", "title", "reference_number",
            "document_type", "document_type_id",
            "status", "supplier", "amount", "currency",
            "document_date", "due_date",
            "file", "file_name", "file_size", "file_mime_type", "checksum",
            "metadata",
            "tags", "tag_ids",
            "department",
            "uploaded_by",
            "is_self_upload",                           # ← new
            "current_version", "versions", "comments", "permissions",
            "created_at", "updated_at",
        ]
        read_only_fields = [
            "id", "reference_number", "file_name", "file_size", "file_mime_type",
            "checksum", "uploaded_by", "is_self_upload",
            "current_version", "created_at", "updated_at",
        ]

    def get_comments(self, obj):
        request = self.context.get("request")
        qs      = obj.comments.all()
        if request and not (request.user.is_admin or request.user.is_auditor):
            qs = qs.filter(is_internal=False)
        return DocumentCommentSerializer(qs, many=True, context=self.context).data

    def get_permissions(self, obj):
        request = self.context.get("request")
        user = getattr(request, "user", None)
        if not user or not user.is_authenticated:
            return []
        if user.is_admin:
            return [choice[0] for choice in GroupAction.choices]
        if obj.is_self_upload and obj.uploaded_by_id == user.id:
            return [
                GroupAction.VIEW.value,
                GroupAction.EDIT.value,
                GroupAction.UPLOAD.value,
                GroupAction.DELETE.value,
                GroupAction.DOWNLOAD.value,
                GroupAction.COMMENT.value,
                GroupAction.ARCHIVE.value,
            ]
        return sorted(user.get_all_permissions_for_doctype(str(obj.document_type_id)))

    def validate_metadata(self, value):
        # Self-upload docs bypass required-metadata enforcement.
        # The is_self_upload flag arrives in initial_data (it's part of the
        # upload form), not in validated_data yet at this point.
        is_self_upload = (
            str(self.initial_data.get("is_self_upload", "")).lower() in ("true", "1", "yes")
        )
        if is_self_upload:
            return value

        doc_type_id = self.initial_data.get("document_type_id")
        if not doc_type_id:
            return value
        try:
            doc_type = DocumentType.objects.get(pk=doc_type_id)
        except DocumentType.DoesNotExist:
            return value
        missing = [
            f.key for f in doc_type.metadata_fields.filter(is_required=True)
            if not value.get(f.key)
        ]
        if missing:
            raise serializers.ValidationError(
                f"Required metadata fields missing: {', '.join(missing)}"
            )
        return value


class DocumentMetadataEditSerializer(serializers.ModelSerializer):
    """
    Used for PATCH /documents/{id}/edit_metadata/
    """
    tag_ids = serializers.PrimaryKeyRelatedField(
        queryset=Tag.objects.all(), many=True, source="tags",
        write_only=True, required=False,
    )

    class Meta:
        model  = Document
        fields = [
            "title", "supplier", "amount", "currency",
            "document_date", "due_date", "metadata", "tag_ids",
        ]

    def update(self, instance, validated_data):
        tags = validated_data.pop("tags", None)
        for attr, value in validated_data.items():
            setattr(instance, attr, value)
        instance.save()
        if tags is not None:
            instance.tags.set(tags)
        return instance


class DocumentUploadSerializer(serializers.ModelSerializer):
    """
    Used for POST /documents/ (initial upload).
    Creates both the Document and a DocumentVersion(v1) atomically.

    Self-upload:
      • Pass is_self_upload=true in the form data.
      • Required metadata fields are NOT enforced (personal docs have no schema).
      • Workflow is never triggered for self-upload docs (enforced in the view).
    """
    document_type_id = serializers.PrimaryKeyRelatedField(
        queryset=DocumentType.objects.filter(is_active=True),
        source="document_type",
    )
    file    = serializers.FileField()
    tag_ids = serializers.PrimaryKeyRelatedField(
        queryset=Tag.objects.all(), many=True, source="tags", required=False
    )
    is_self_upload = serializers.BooleanField(default=False)   # ← new

    class Meta:
        model  = Document
        fields = [
            "title", "document_type_id", "file",
            "supplier", "amount", "currency",
            "document_date", "due_date",
            "metadata", "tag_ids", "department",
            "is_self_upload",                               # ← new
        ]

    def validate_metadata(self, value):
        # Bypass required-metadata validation for personal uploads.
        if self.initial_data.get("is_self_upload") in (True, "true", "1", "yes"):
            return value

        doc_type_id = self.initial_data.get("document_type_id")
        if not doc_type_id:
            return value
        try:
            doc_type = DocumentType.objects.get(pk=doc_type_id)
        except DocumentType.DoesNotExist:
            return value
        missing = [
            f.key for f in doc_type.metadata_fields.filter(is_required=True)
            if not value.get(f.key)
        ]
        if missing:
            raise serializers.ValidationError(
                f"Required metadata fields missing: {', '.join(missing)}"
            )
        return value

    def create(self, validated_data):
        import hashlib
        import magic as python_magic

        tags     = validated_data.pop("tags", [])
        request  = self.context["request"]
        doc_type = validated_data["document_type"]

        validated_data["reference_number"] = doc_type.next_reference()

        upload = validated_data["file"]
        validated_data["file_name"]   = upload.name
        validated_data["file_size"]   = upload.size
        validated_data["uploaded_by"] = request.user

        # MIME type detection
        try:
            validated_data["file_mime_type"] = python_magic.from_buffer(
                upload.read(2048), mime=True
            )
            upload.seek(0)
        except Exception:
            validated_data["file_mime_type"] = "application/octet-stream"

        # SHA-256 checksum
        sha256 = hashlib.sha256()
        for chunk in upload.chunks():
            sha256.update(chunk)
        upload.seek(0)
        validated_data["checksum"] = sha256.hexdigest()

        doc = super().create(validated_data)
        doc.tags.set(tags)

        # Initial version (v1) — always created regardless of upload type
        DocumentVersion.objects.create(
            document       = doc,
            version_number = 1,
            file           = doc.file,
            file_name      = doc.file_name,
            file_size      = doc.file_size,
            checksum       = doc.checksum,
            change_summary = "Initial upload",
            created_by     = request.user,
        )

        # Background tasks — run for all uploads (owner can search their own docs)
        try:
            from apps.documents.tasks import extract_text
            extract_text.delay(str(doc.id))
        except Exception:
            pass
        try:
            from apps.search.tasks import index_document
            index_document.delay(str(doc.id))
        except Exception:
            pass

        return doc


class DocumentBulkActionSerializer(serializers.Serializer):
    """
    Used for POST /documents/bulk_action/
    """
    document_ids = serializers.ListField(
        child=serializers.UUIDField(),
        min_length=1,
        max_length=100,
    )
    action  = serializers.ChoiceField(choices=["approve", "reject", "archive", "void"])
    comment = serializers.CharField(required=False, allow_blank=True, default="")

    def validate(self, attrs):
        if attrs["action"] == "reject" and not attrs.get("comment", "").strip():
            raise serializers.ValidationError(
                {"comment": "A comment is required when rejecting documents."}
            )
        return attrs