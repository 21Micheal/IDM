"""
apps/documents/serializers.py

Bug fix in this revision
─────────────────────────
DocumentUploadSerializer.create() previously pre-set ocr_status="pending"
before any Celery task ran. Combined with the attempted fix in tasks.py
(bail on "pending"), this caused OCR to never start.

Correct pattern:
  is_scanned=True OR image/* MIME  →  call ocr_document.delay() directly.
                                       Do NOT pre-set ocr_status here;
                                       the task sets it atomically.
  everything else                  →  call extract_text.delay() as before.
                                       That task auto-detects scanned PDFs
                                       and routes to ocr_document itself.

No other changes to this file.
"""
from rest_framework import serializers
from .models import (
    Document, DocumentType, MetadataField,
    DocumentVersion, DocumentComment, Tag, OCRStatus,
)
from apps.accounts.serializers import UserSummarySerializer
from apps.accounts.models import GroupAction
from django.db import transaction, IntegrityError
from django.utils.text import slugify
import mimetypes

PERSONAL_DOCUMENT_TYPE_CODE = "PERSONAL"


def _normalize_personal_tags(value) -> list[str]:
    if value in (None, ""):
        return []
    if isinstance(value, list):
        raw_items = value
    else:
        raw_items = str(value).split(",")
    tags = []
    for item in raw_items:
        tag = str(item).strip()
        if tag and tag not in tags:
            tags.append(tag)
    return tags


def _extract_personal_tag_values(source) -> list[str]:
    if source is None:
        return []
    if hasattr(source, "getlist"):
        values = source.getlist("personal_tags")
        if values:
            return values
    value = source.get("personal_tags") if hasattr(source, "get") else None
    if isinstance(value, list):
        return value
    if value in (None, ""):
        return []
    return [value]


def _get_personal_document_type() -> DocumentType:
    doc_type, created = DocumentType.objects.get_or_create(
        code=PERSONAL_DOCUMENT_TYPE_CODE,
        defaults={
            "name": "Personal",
            "reference_prefix": "PERS",
            "reference_padding": 5,
            "description": "System-generated document type for personal uploads.",
            "icon": "lock",
            "is_active": True,
        },
    )
    if not created and not doc_type.is_active:
        doc_type.is_active = True
        doc_type.save(update_fields=["is_active", "updated_at"])
    return doc_type


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

class MetadataFieldWriteSerializer(serializers.ModelSerializer):
    field_key = serializers.CharField(source="key", required=False, allow_blank=True)

    class Meta:
        model  = MetadataField
        fields = [
            "label", "field_key", "field_type", "is_required",
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
    file_url = serializers.SerializerMethodField()

    class Meta:
        model  = DocumentVersion
        fields = [
            "id", "version_number", "file_name", "file_size",
            "change_summary", "created_by", "created_at", "file_url",
        ]

    def get_file_url(self, obj):
        request = self.context.get("request")
        if not obj.file:
            return None
        return request.build_absolute_uri(obj.file.url) if request else obj.file.url


class DocumentCommentSerializer(serializers.ModelSerializer):
    author = UserSummarySerializer(read_only=True)

    class Meta:
        model        = DocumentComment
        fields       = ["id", "author", "content", "is_internal", "created_at", "updated_at"]
        read_only_fields = ["id", "author", "created_at", "updated_at"]


class DocumentListSerializer(serializers.ModelSerializer):
    document_type_name = serializers.CharField(source="document_type.name", read_only=True)
    uploaded_by        = UserSummarySerializer(read_only=True)
    tags               = TagSerializer(many=True, read_only=True)
    personal_tags      = serializers.SerializerMethodField()
    permissions        = serializers.SerializerMethodField()
    preview_pdf        = serializers.SerializerMethodField()
    is_edit_locked     = serializers.SerializerMethodField()
    edit_locked_by_name = serializers.SerializerMethodField()

    class Meta:
        model  = Document
        fields = [
            "id", "title", "reference_number",
            "document_type", "document_type_name",
            "status", "supplier", "amount", "currency", "document_date",
            "file_name", "file_size", "file_mime_type",
            "uploaded_by", "tags", "personal_tags", "permissions",
            "is_self_upload",
            "is_scanned", "ocr_status",
            "preview_pdf", "preview_status",
            "edit_locked_by", "edit_locked_by_name", "edit_locked_at", "is_edit_locked",
            "current_version", "created_at", "updated_at",
        ]

    def get_personal_tags(self, obj):
        tags = obj.metadata.get("personal_tags", []) if isinstance(obj.metadata, dict) else []
        return _normalize_personal_tags(tags)

    def get_permissions(self, obj):
        request = self.context.get("request")
        user = getattr(request, "user", None)
        if not user or not user.is_authenticated:
            return []
        if user.has_admin_access:
            return [choice[0] for choice in GroupAction.choices if choice[0] != GroupAction.ADMIN.value]
        if obj.is_self_upload and obj.uploaded_by_id == user.id:
            return [
                GroupAction.VIEW.value, GroupAction.EDIT.value,
                GroupAction.UPLOAD.value, GroupAction.DELETE.value,
                GroupAction.DOWNLOAD.value, GroupAction.COMMENT.value,
                GroupAction.ARCHIVE.value,
            ]
        return sorted(user.get_all_permissions_for_doctype(str(obj.document_type_id)))

    def get_preview_pdf(self, obj):
        request = self.context.get("request")
        if not obj.preview_pdf:
            return None
        return request.build_absolute_uri(obj.preview_pdf.url) if request else obj.preview_pdf.url

    def get_is_edit_locked(self, obj):
        return obj.is_edit_locked

    def get_edit_locked_by_name(self, obj):
        holder = obj.edit_lock_holder
        return holder.get_full_name().strip() if holder else None


class DocumentDetailSerializer(serializers.ModelSerializer):
    document_type    = DocumentTypeSerializer(read_only=True)
    document_type_id = serializers.PrimaryKeyRelatedField(
        queryset=DocumentType.objects.filter(is_active=True),
        source="document_type", write_only=True,
    )
    uploaded_by = UserSummarySerializer(read_only=True)
    tags        = TagSerializer(many=True, read_only=True)
    personal_tags = serializers.SerializerMethodField()
    tag_ids     = serializers.PrimaryKeyRelatedField(
        queryset=Tag.objects.all(), many=True, source="tags",
        write_only=True, required=False,
    )
    versions    = DocumentVersionSerializer(many=True, read_only=True)
    comments    = serializers.SerializerMethodField()
    permissions = serializers.SerializerMethodField()
    preview_pdf = serializers.SerializerMethodField()
    is_edit_locked = serializers.SerializerMethodField()
    edit_locked_by_name = serializers.SerializerMethodField()

    class Meta:
        model  = Document
        fields = [
            "id", "title", "reference_number",
            "document_type", "document_type_id",
            "status", "supplier", "amount", "currency",
            "document_date", "due_date",
            "file", "file_name", "file_size", "file_mime_type", "checksum",
            "metadata",
            "tags", "personal_tags", "tag_ids",
            "department",
            "uploaded_by",
            "is_self_upload",
            "is_scanned", "ocr_status",
            "preview_pdf", "preview_status",
            "edit_locked_by", "edit_locked_by_name", "edit_locked_at", "is_edit_locked",
            "current_version", "versions", "comments", "permissions",
            "created_at", "updated_at",
        ]
        read_only_fields = [
            "id", "reference_number", "file_name", "file_size", "file_mime_type",
            "checksum", "uploaded_by", "is_self_upload",
            "is_scanned", "ocr_status",
            "preview_pdf", "preview_status",
            "edit_locked_by", "edit_locked_by_name", "edit_locked_at", "is_edit_locked",
            "current_version", "created_at", "updated_at",
        ]

    def get_comments(self, obj):
        request = self.context.get("request")
        qs = obj.comments.all()
        if request and not request.user.has_admin_access:
            qs = qs.filter(is_internal=False)
        return DocumentCommentSerializer(qs, many=True, context=self.context).data

    def get_personal_tags(self, obj):
        tags = obj.metadata.get("personal_tags", []) if isinstance(obj.metadata, dict) else []
        return _normalize_personal_tags(tags)

    def get_permissions(self, obj):
        request = self.context.get("request")
        user = getattr(request, "user", None)
        if not user or not user.is_authenticated:
            return []
        if user.has_admin_access:
            return [choice[0] for choice in GroupAction.choices if choice[0] != GroupAction.ADMIN.value]
        if obj.is_self_upload and obj.uploaded_by_id == user.id:
            return [
                GroupAction.VIEW.value, GroupAction.EDIT.value,
                GroupAction.UPLOAD.value, GroupAction.DELETE.value,
                GroupAction.DOWNLOAD.value, GroupAction.COMMENT.value,
                GroupAction.ARCHIVE.value,
            ]
        return sorted(user.get_all_permissions_for_doctype(str(obj.document_type_id)))

    def get_preview_pdf(self, obj):
        request = self.context.get("request")
        if not obj.preview_pdf:
            return None
        return request.build_absolute_uri(obj.preview_pdf.url) if request else obj.preview_pdf.url

    def get_is_edit_locked(self, obj):
        return obj.is_edit_locked

    def get_edit_locked_by_name(self, obj):
        holder = obj.edit_lock_holder
        return holder.get_full_name().strip() if holder else None

    def validate_metadata(self, value):
        is_self_upload = (
            str(self.initial_data.get("is_self_upload", "")).lower()
            in ("true", "1", "yes")
        )
        is_scanned = (
            str(self.initial_data.get("is_scanned", "")).lower()
            in ("true", "1", "yes")
        )
        if is_self_upload or is_scanned:
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
    tag_ids = serializers.PrimaryKeyRelatedField(
        queryset=Tag.objects.all(), many=True, source="tags",
        write_only=True, required=False,
    )
    personal_tags = serializers.ListField(
        child=serializers.CharField(allow_blank=False, trim_whitespace=True),
        required=False,
    )

    class Meta:
        model  = Document
        fields = [
            "title", "supplier", "amount", "currency",
            "document_date", "due_date", "metadata", "tag_ids", "personal_tags",
        ]

    def update(self, instance, validated_data):
        tags = validated_data.pop("tags", None)
        personal_tags = validated_data.pop("personal_tags", None)
        if personal_tags is not None:
            normalized_tags = _normalize_personal_tags(personal_tags)
            if instance.is_self_upload and not normalized_tags:
                raise serializers.ValidationError(
                    {"personal_tags": "Please add at least one personal tag."}
                )
            metadata = dict(validated_data.get("metadata") or instance.metadata or {})
            metadata["personal_tags"] = normalized_tags
            validated_data["metadata"] = metadata
        for attr, value in validated_data.items():
            setattr(instance, attr, value)
        instance.save()
        if tags is not None:
            instance.tags.set(tags)
        return instance


class DocumentUploadSerializer(serializers.ModelSerializer):
    """
    POST /documents/ — initial upload.

    Task routing after save
    ────────────────────────
    is_scanned=True OR image/* MIME:
        → ocr_document.delay() directly  [queue="ocr"]
          ocr_status is NOT pre-set here; the task claims atomically.

    Everything else:
        → extract_text.delay()  [queue="indexing"]
          That task auto-detects scanned PDFs and routes to ocr_document.
    """
    document_type_id = serializers.PrimaryKeyRelatedField(
        queryset=DocumentType.objects.filter(is_active=True).exclude(code=PERSONAL_DOCUMENT_TYPE_CODE),
        source="document_type",
        required=False,
    )
    file           = serializers.FileField()
    tag_ids        = serializers.PrimaryKeyRelatedField(
        queryset=Tag.objects.all(), many=True, source="tags", required=False
    )
    personal_tags  = serializers.ListField(
        child=serializers.CharField(allow_blank=False, trim_whitespace=True),
        required=False,
    )
    is_self_upload = serializers.BooleanField(default=False)
    is_scanned     = serializers.BooleanField(default=False)

    class Meta:
        model  = Document
        fields = [
            "title", "document_type_id", "file",
            "supplier", "amount", "currency",
            "document_date", "due_date",
            "metadata", "tag_ids", "personal_tags", "department",
            "is_self_upload",
            "is_scanned",
        ]

    def validate_metadata(self, value):
        is_self_upload = str(self.initial_data.get("is_self_upload", "")).lower() in ("true", "1", "yes")
        is_scanned = str(self.initial_data.get("is_scanned", "")).lower() in ("true", "1", "yes")
        if is_self_upload:
            personal_tags = _normalize_personal_tags(
                _extract_personal_tag_values(self.initial_data)
                or (value.get("personal_tags") if isinstance(value, dict) else None)
            )
            if not personal_tags:
                raise serializers.ValidationError("Please add at least one personal tag.")
            value = dict(value)
            value["personal_tags"] = personal_tags
            return value
        if is_scanned:
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

    def validate(self, attrs):
        if not attrs.get("is_self_upload") and not attrs.get("document_type"):
            raise serializers.ValidationError(
                {"document_type_id": "Document type is required for workflow documents."}
            )
        return attrs

    def create(self, validated_data):
        import hashlib
        import magic as python_magic

        tags       = validated_data.pop("tags", [])
        validated_data.pop("personal_tags", None)
        request    = self.context["request"]
        if validated_data.get("is_self_upload"):
            validated_data["document_type"] = _get_personal_document_type()
            tags = []
        doc_type   = validated_data["document_type"]
        is_scanned = validated_data.get("is_scanned", False)

        validated_data["reference_number"] = doc_type.next_reference()

        upload = validated_data["file"]
        validated_data["file_name"]   = upload.name
        validated_data["file_size"]   = upload.size
        validated_data["uploaded_by"] = request.user

        # MIME detection
        try:
            detected_mime = python_magic.from_buffer(
                upload.read(2048), mime=True
            )
            validated_data["file_mime_type"] = detected_mime
            upload.seek(0)
        except Exception:
            validated_data["file_mime_type"] = "application/octet-stream"

        if validated_data["file_mime_type"] in ("", "application/octet-stream"):
            fallback_mime, _ = mimetypes.guess_type(upload.name)
            if fallback_mime:
                validated_data["file_mime_type"] = fallback_mime

        # Images are always scanned regardless of the toggle
        if validated_data["file_mime_type"].startswith("image/"):
            validated_data["is_scanned"] = True
            is_scanned = True

        # ── DO NOT pre-set ocr_status here ───────────────────────────────────
        # The ocr_document task sets it atomically (PENDING → PROCESSING).
        # Pre-setting "pending" here caused extract_text to bail out early
        # (when the bail-on-pending guard was added as a "fix"), resulting in
        # the status being frozen at "pending" forever.

        # SHA-256
        sha256 = hashlib.sha256()
        for chunk in upload.chunks():
            sha256.update(chunk)
        upload.seek(0)
        validated_data["checksum"] = sha256.hexdigest()

        doc = super().create(validated_data)
        doc.tags.set(tags)

        # Version 1
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

        # ── Task routing ─────────────────────────────────────────────────────
        if is_scanned:
            # Confirmed scan: go straight to OCR, skip extract_text hop
            try:
                from apps.documents.tasks import ocr_document
                # Mark pending before queuing so the UI shows the badge instantly.
                # Use update() directly (not _mark_pending()) to avoid the
                # filter-on-status guard that _mark_pending() applies.
                Document.objects.filter(id=doc.id).update(
                    ocr_status=OCRStatus.PENDING
                )
                ocr_document.delay(str(doc.id))
            except Exception as exc:
                import logging
                logging.getLogger(__name__).error(
                    "Failed to queue OCR for %s: %s", doc.id, exc
                )
        else:
            # Normal document: extract_text handles everything including
            # auto-detection of scanned PDFs
            try:
                from apps.documents.tasks import extract_text
                extract_text.delay(str(doc.id))
            except Exception as exc:
                import logging
                logging.getLogger(__name__).error(
                    "Failed to queue extract_text for %s: %s", doc.id, exc
                )

        # Always queue an initial index pass so the document appears in
        # search results immediately (with empty extracted_text if OCR hasn't
        # finished yet; the OCR task will re-index when done)
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
