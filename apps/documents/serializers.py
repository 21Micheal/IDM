"""
apps/documents/serializers.py

Key fix: DocumentTypeSerializer now handles metadata_fields as a
writable nested list via MetadataFieldWriteSerializer.

On create  → creates all MetadataField rows linked to the new DocumentType.
On update  → replaces all metadata fields atomically:
               deletes existing rows, creates fresh ones from payload.
             This avoids partial-update complexity while keeping the
             API surface simple (the frontend always sends the full list).

The select_options_raw field exists only on the frontend form — it is
never sent to the API (stripped by the frontend before POST/PATCH).
The backend stores options in the JSONField `select_options` as a list.
"""
from django.db import IntegrityError, transaction
from django.utils.text import slugify
from rest_framework import serializers

from .models import (
    Document, DocumentType, MetadataField,
    DocumentVersion, DocumentComment, Tag,
)
from apps.accounts.serializers import UserSummarySerializer


# ── Tags ──────────────────────────────────────────────────────────────────────

class TagSerializer(serializers.ModelSerializer):
    class Meta:
        model  = Tag
        fields = ["id", "name", "color"]


# ── Metadata fields ───────────────────────────────────────────────────────────

class MetadataFieldSerializer(serializers.ModelSerializer):
    """Read serializer — returned in GET responses."""
    field_key = serializers.CharField(source="key", read_only=True)

    class Meta:
        model  = MetadataField
        fields = [
            "id", "label", "field_key", "field_type",
            "is_required", "is_searchable",
            "select_options", "default_value", "help_text", "order",
        ]


class MetadataFieldWriteSerializer(serializers.Serializer):
    """
    Write-only serializer for nested metadata fields.
    Does NOT include `id` — we always delete-and-recreate on update.
    Does NOT include `select_options_raw` — that is a frontend-only
    convenience field that must be stripped before calling the API.
    """
    label          = serializers.CharField(max_length=100)
    field_key      = serializers.SlugField(max_length=100)
    field_type     = serializers.ChoiceField(choices=[
        "text", "number", "date", "currency", "select", "boolean", "textarea"
    ])
    is_required    = serializers.BooleanField(default=False)
    is_searchable  = serializers.BooleanField(default=True)
    select_options = serializers.ListField(
        child=serializers.CharField(), default=list, required=False
    )
    default_value  = serializers.CharField(max_length=255, allow_blank=True, default="")
    help_text      = serializers.CharField(max_length=255, allow_blank=True, default="")
    order          = serializers.IntegerField(default=0)


# ── Document type ─────────────────────────────────────────────────────────────

class DocumentTypeSerializer(serializers.ModelSerializer):
    """
    Read serializer — used for GET /documents/types/ and GET /documents/types/{id}/
    Includes full metadata_fields list and workflow link.
    """
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


class DocumentTypeWriteSerializer(serializers.ModelSerializer):
    """
    Write serializer — used for POST /documents/types/ and PATCH /documents/types/{id}/
    Accepts nested metadata_fields and replaces them atomically.
    """
    metadata_fields = MetadataFieldWriteSerializer(many=True, required=False, default=list)

    class Meta:
        model  = DocumentType
        fields = [
            "name", "code", "reference_prefix", "reference_padding",
            "description", "icon", "is_active",
            "workflow_template",
            "metadata_fields",
        ]
        extra_kwargs = {
            "icon":              {"required": False, "allow_blank": True},
            "description":       {"required": False, "allow_blank": True},
            "workflow_template": {"required": False, "allow_null": True},
        }

    def validate_metadata_fields(self, value):
        """
        Normalize and auto-heal field keys before hitting DB unique constraints.
        - If key is empty, derive it from label.
        - If still empty, generate metadata_field_<n>.
        - If duplicate, add numeric suffix (_2, _3, ...).

        This keeps PATCH resilient for legacy/bad payloads while preserving DB
        uniqueness requirements.
        """
        used_keys = set()

        for idx, field in enumerate(value):
            raw_key = str(field.get("field_key", "")).strip().lower()
            base_key = slugify(raw_key).replace("-", "_")

            if not base_key:
                label_key = slugify(str(field.get("label", "")).strip().lower()).replace("-", "_")
                base_key = label_key or f"metadata_field_{idx + 1}"

            key = base_key
            suffix = 2
            while key in used_keys:
                key = f"{base_key}_{suffix}"
                suffix += 1

            used_keys.add(key)
            field["field_key"] = key

        return value

    def _save_metadata_fields(self, doc_type: DocumentType, fields_data: list) -> None:
        """Delete existing fields and recreate from payload."""
        doc_type.metadata_fields.all().delete()
        try:
            for i, field_data in enumerate(fields_data):
                field_data = dict(field_data)
                # Rename field_key → key to match the model field name
                if "field_key" in field_data:
                    field_data["key"] = field_data.pop("field_key")
                # Ensure order matches position in list if not explicitly set
                if "order" not in field_data or field_data["order"] == 0:
                    field_data["order"] = i
                MetadataField.objects.create(document_type=doc_type, **field_data)
        except IntegrityError:
            raise serializers.ValidationError(
                {
                    "metadata_fields": (
                        "Duplicate metadata field keys are not allowed for a "
                        "document type."
                    )
                }
            )

    @transaction.atomic
    def create(self, validated_data: dict) -> DocumentType:
        fields_data = validated_data.pop("metadata_fields", [])
        doc_type    = DocumentType.objects.create(**validated_data)
        self._save_metadata_fields(doc_type, fields_data)
        return doc_type

    @transaction.atomic
    def update(self, instance: DocumentType, validated_data: dict) -> DocumentType:
        fields_data = validated_data.pop("metadata_fields", None)

        for attr, value in validated_data.items():
            setattr(instance, attr, value)
        instance.save()

        # Only replace fields if the key was present in the request
        if fields_data is not None:
            self._save_metadata_fields(instance, fields_data)

        return instance


# ── Document version / comment ─────────────────────────────────────────────────

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


# ── Document list / detail ────────────────────────────────────────────────────

class DocumentListSerializer(serializers.ModelSerializer):
    document_type_name = serializers.CharField(source="document_type.name", read_only=True)
    uploaded_by        = UserSummarySerializer(read_only=True)
    tags               = TagSerializer(many=True, read_only=True)

    class Meta:
        model  = Document
        fields = [
            "id", "title", "reference_number",
            "document_type", "document_type_name",
            "status", "supplier", "amount", "currency", "document_date",
            "file_name", "file_size", "file_mime_type",
            "uploaded_by", "tags", "current_version", "created_at", "updated_at",
        ]


class DocumentDetailSerializer(serializers.ModelSerializer):
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
    versions = DocumentVersionSerializer(many=True, read_only=True)
    comments = serializers.SerializerMethodField()

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
            "current_version", "versions", "comments",
            "created_at", "updated_at",
        ]
        read_only_fields = [
            "id", "reference_number", "file_name", "file_size",
            "file_mime_type", "checksum", "uploaded_by",
            "current_version", "created_at", "updated_at",
        ]

    def get_comments(self, obj):
        request = self.context.get("request")
        qs      = obj.comments.all()
        if request and not (request.user.is_admin or request.user.is_auditor):
            qs = qs.filter(is_internal=False)
        return DocumentCommentSerializer(qs, many=True, context=self.context).data


class DocumentMetadataEditSerializer(serializers.ModelSerializer):
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
    document_type_id = serializers.PrimaryKeyRelatedField(
        queryset=DocumentType.objects.filter(is_active=True),
        source="document_type",
    )
    file    = serializers.FileField()
    tag_ids = serializers.PrimaryKeyRelatedField(
        queryset=Tag.objects.all(), many=True, source="tags", required=False
    )

    class Meta:
        model  = Document
        fields = [
            "title", "document_type_id", "file",
            "supplier", "amount", "currency",
            "document_date", "due_date",
            "metadata", "tag_ids", "department",
        ]

    def create(self, validated_data):
        import hashlib
        try:
            import magic as python_magic
        except ImportError:
            python_magic = None

        tags     = validated_data.pop("tags", [])
        request  = self.context["request"]
        doc_type = validated_data["document_type"]

        validated_data["reference_number"] = doc_type.next_reference()

        upload = validated_data["file"]
        validated_data["file_name"]   = upload.name
        validated_data["file_size"]   = upload.size
        validated_data["uploaded_by"] = request.user

        try:
            if python_magic:
                validated_data["file_mime_type"] = python_magic.from_buffer(
                    upload.read(2048), mime=True
                )
                upload.seek(0)
            else:
                validated_data["file_mime_type"] = "application/octet-stream"
        except Exception:
            validated_data["file_mime_type"] = "application/octet-stream"

        sha256 = hashlib.sha256()
        for chunk in upload.chunks():
            sha256.update(chunk)
        upload.seek(0)
        validated_data["checksum"] = sha256.hexdigest()

        doc = super().create(validated_data)
        doc.tags.set(tags)

        # Create v1 version record
        from .models import DocumentVersion
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
    document_ids = serializers.ListField(
        child=serializers.UUIDField(), min_length=1, max_length=100,
    )
    action  = serializers.ChoiceField(choices=["approve", "reject", "archive", "void"])
    comment = serializers.CharField(required=False, allow_blank=True, default="")

    def validate(self, attrs):
        if attrs["action"] == "reject" and not attrs.get("comment", "").strip():
            raise serializers.ValidationError(
                {"comment": "A comment is required when rejecting documents."}
            )
        return attrs
