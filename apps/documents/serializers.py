"""
documents/serializers.py
"""
from rest_framework import serializers
from .models import Document, DocumentType, MetadataField, DocumentVersion, DocumentComment, Tag
from apps.accounts.serializers import UserSummarySerializer


class TagSerializer(serializers.ModelSerializer):
    class Meta:
        model = Tag
        fields = ["id", "name", "color"]


class MetadataFieldSerializer(serializers.ModelSerializer):
    class Meta:
        model = MetadataField
        fields = [
            "id", "label", "key", "field_type", "is_required",
            "is_searchable", "select_options", "default_value", "help_text", "order",
        ]


class DocumentTypeSerializer(serializers.ModelSerializer):
    metadata_fields = MetadataFieldSerializer(many=True, read_only=True)

    class Meta:
        model = DocumentType
        fields = [
            "id", "name", "code", "reference_prefix", "reference_padding",
            "description", "icon", "is_active", "metadata_fields",
        ]


class DocumentVersionSerializer(serializers.ModelSerializer):
    created_by = UserSummarySerializer(read_only=True)

    class Meta:
        model = DocumentVersion
        fields = [
            "id", "version_number", "file_name", "file_size",
            "change_summary", "created_by", "created_at",
        ]


class DocumentCommentSerializer(serializers.ModelSerializer):
    author = UserSummarySerializer(read_only=True)

    class Meta:
        model = DocumentComment
        fields = ["id", "author", "content", "is_internal", "created_at", "updated_at"]
        read_only_fields = ["id", "author", "created_at", "updated_at"]


class DocumentListSerializer(serializers.ModelSerializer):
    """Lightweight serializer for list views."""
    document_type_name = serializers.CharField(source="document_type.name", read_only=True)
    uploaded_by = UserSummarySerializer(read_only=True)
    tags = TagSerializer(many=True, read_only=True)

    class Meta:
        model = Document
        fields = [
            "id", "title", "reference_number", "document_type", "document_type_name",
            "status", "supplier", "amount", "currency", "document_date",
            "file_name", "file_size", "file_mime_type",
            "uploaded_by", "tags", "current_version", "created_at", "updated_at",
        ]


class DocumentDetailSerializer(serializers.ModelSerializer):
    """Full serializer for detail / create / update."""
    document_type = DocumentTypeSerializer(read_only=True)
    document_type_id = serializers.PrimaryKeyRelatedField(
        queryset=DocumentType.objects.filter(is_active=True),
        source="document_type", write_only=True,
    )
    uploaded_by = UserSummarySerializer(read_only=True)
    tags = TagSerializer(many=True, read_only=True)
    tag_ids = serializers.PrimaryKeyRelatedField(
        queryset=Tag.objects.all(), many=True, source="tags", write_only=True, required=False
    )
    versions = DocumentVersionSerializer(many=True, read_only=True)
    comments = serializers.SerializerMethodField()

    class Meta:
        model = Document
        fields = [
            "id", "title", "reference_number", "document_type", "document_type_id",
            "status", "supplier", "amount", "currency",
            "document_date", "due_date",
            "file", "file_name", "file_size", "file_mime_type", "checksum",
            "metadata",
            "tags", "tag_ids",
            "department",
            "uploaded_by",
            "current_version", "versions",
            "comments",
            "created_at", "updated_at",
        ]
        read_only_fields = [
            "id", "reference_number", "file_name", "file_size", "file_mime_type",
            "checksum", "uploaded_by", "current_version", "created_at", "updated_at",
        ]

    def get_comments(self, obj):
        request = self.context.get("request")
        qs = obj.comments.all()
        # Auditors and admins see internal comments; others do not
        if request and not (request.user.is_admin or request.user.is_auditor):
            qs = qs.filter(is_internal=False)
        return DocumentCommentSerializer(qs, many=True, context=self.context).data

    def validate_metadata(self, value):
        """Validate dynamic metadata against the document type's field definitions."""
        doc_type_id = self.initial_data.get("document_type_id")
        if not doc_type_id:
            return value
        try:
            doc_type = DocumentType.objects.get(pk=doc_type_id)
        except DocumentType.DoesNotExist:
            return value
        required_keys = [
            f.key for f in doc_type.metadata_fields.filter(is_required=True)
        ]
        missing = [k for k in required_keys if not value.get(k)]
        if missing:
            raise serializers.ValidationError(
                f"Required metadata fields missing: {', '.join(missing)}"
            )
        return value


class DocumentUploadSerializer(serializers.ModelSerializer):
    """Used exclusively for the initial file upload POST."""
    document_type_id = serializers.PrimaryKeyRelatedField(
        queryset=DocumentType.objects.filter(is_active=True),
        source="document_type",
    )
    file = serializers.FileField()
    tag_ids = serializers.PrimaryKeyRelatedField(
        queryset=Tag.objects.all(), many=True, source="tags", required=False
    )

    class Meta:
        model = Document
        fields = [
            "title", "document_type_id", "file",
            "supplier", "amount", "currency",
            "document_date", "due_date",
            "metadata", "tag_ids", "department",
        ]

    def create(self, validated_data):
        tags = validated_data.pop("tags", [])
        request = self.context["request"]
        doc_type = validated_data["document_type"]

        # Auto-generate reference
        validated_data["reference_number"] = doc_type.next_reference()

        # Capture file metadata
        upload = validated_data["file"]
        validated_data["file_name"] = upload.name
        validated_data["file_size"] = upload.size
        validated_data["uploaded_by"] = request.user

        import magic
        validated_data["file_mime_type"] = magic.from_buffer(upload.read(2048), mime=True)
        upload.seek(0)

        import hashlib
        sha256 = hashlib.sha256()
        for chunk in upload.chunks():
            sha256.update(chunk)
        upload.seek(0)
        validated_data["checksum"] = sha256.hexdigest()

        doc = super().create(validated_data)
        doc.tags.set(tags)

        # Kick off background tasks
        from apps.search.tasks import index_document
        from apps.documents.tasks import extract_text
        extract_text.delay(str(doc.id))
        index_document.delay(str(doc.id))

        return doc
