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
import logging
from .models import (
    Document, DocumentType, MetadataField,
    DocumentVersion, DocumentComment, Tag, OCRStatus,
    BulkUpload, BulkUploadStatus, DocumentStatus, DocumentShare, DocumentRelationship,
    DocumentRelationshipRule,
    DMSSettings,
)
from apps.accounts.serializers import UserSummarySerializer
from apps.accounts.models import GroupAction
from apps.workflows.models import WorkflowTemplate, WorkflowTask
from apps.workflows.serializers import DocumentSignatureSerializer
from django.db import transaction, IntegrityError
from django.db.models import Q
from django.utils import timezone
from django.utils.text import slugify
import mimetypes
import uuid
from django.core.files.storage import default_storage
from apps.search.utils import summarize_bulk_index_error, SEARCH_INDEX_EXCEPTIONS
from .file_streaming import build_absolute_document_file_url, user_can_download_document

PERSONAL_DOCUMENT_TYPE_CODE = "PERSONAL"
DOCUMENT_COLUMN_METADATA_KEYS = {
    "title", "supplier", "amount", "currency", "document_date", "due_date",
}
logger = logging.getLogger(__name__)


def _check_unique_metadata(doc_type, attrs, *, exclude_pk=None):
    """
    Enforce per-attribute uniqueness for a document type.

    Any metadata field flagged ``is_unique`` (e.g. a reference / invoice number)
    must not repeat a value already used by another document of the same type.
    Column-backed keys (title, supplier, amount, …) are compared against the
    document column; everything else against the ``metadata`` JSON. Trashed
    documents and the document being edited (``exclude_pk``) are ignored.
    """
    if not doc_type:
        return

    unique_fields = list(doc_type.metadata_fields.filter(is_unique=True))
    if not unique_fields:
        return

    metadata = attrs.get("metadata")
    metadata = metadata if isinstance(metadata, dict) else {}
    errors = {}

    for field in unique_fields:
        key = field.key
        if key in DOCUMENT_COLUMN_METADATA_KEYS:
            value = attrs.get(key)
            lookup = {key: value}
        else:
            value = metadata.get(key)
            lookup = {f"metadata__{key}": value}

        if value in (None, "") or (isinstance(value, str) and not value.strip()):
            continue

        clash = (
            Document.objects
            .filter(document_type=doc_type, deleted_at__isnull=True, **lookup)
        )
        if exclude_pk:
            clash = clash.exclude(pk=exclude_pk)

        if clash.exists():
            errors[key] = (
                f"{field.label} must be unique — \"{value}\" is already used by "
                "another document of this type."
            )

    if errors:
        raise serializers.ValidationError(errors)


def _generate_unique_reference(doc_type: DocumentType) -> str:
    if doc_type.code == "UNCLASS":
        while True:
            candidate = f"{doc_type.reference_prefix}-{uuid.uuid4().hex[:12].upper()}"
            if not Document.objects.filter(reference_number=candidate).exists():
                return candidate

    candidate = doc_type.next_reference()
    if not Document.objects.filter(reference_number=candidate).exists():
        return candidate

    while True:
        fallback = f"{doc_type.reference_prefix}-{uuid.uuid4().hex[:8].upper()}"
        if not Document.objects.filter(reference_number=fallback).exists():
            return fallback


def _document_title_stem(file_name: str) -> str:
    """Filename without its extension or any leading path."""
    base = (file_name or "").rsplit("/", 1)[-1].rsplit("\\", 1)[-1]
    if "." in base:
        stem = base.rsplit(".", 1)[0]
        return stem or base
    return base


def _resolve_document_title(doc_type, validated_data: dict, file_name: str) -> str:
    """
    Decide a document's title from its document type's `title_field` policy.

      - "filename" (default): keep the submitted title (the upload form prefills it
        from the file name and lets the user edit it), falling back to the stem.
      - "title": use the user-typed Document Name.
      - any other column/metadata key: auto-name from that field's value when present,
        otherwise fall back to the submitted title, then the file name.
    """
    source = (getattr(doc_type, "title_field", "") or "filename").strip()
    typed = (validated_data.get("title") or "").strip()
    stem = _document_title_stem(file_name)

    if source in ("", "filename", "title"):
        return typed or stem or "Document"

    if source in DOCUMENT_COLUMN_METADATA_KEYS:
        value = validated_data.get(source)
    else:
        metadata = validated_data.get("metadata") or {}
        value = metadata.get(source) if isinstance(metadata, dict) else None

    value = "" if value is None else str(value).strip()
    return value or typed or stem or "Document"

def _find_existing_document_for_checksum(
    checksum: str,
    exclude_document_id=None,
    uploaded_by=None,
):
    if not checksum:
        return None
    # Trashed (soft-deleted) documents must not count as duplicates — a user
    # should be able to re-upload a file they have sent to Trash.
    qs = Document.objects.filter(
        checksum=checksum, deleted_at__isnull=True
    ).exclude(file="")
    if uploaded_by is not None:
        qs = qs.filter(uploaded_by=uploaded_by)
    if exclude_document_id:
        qs = qs.exclude(id=exclude_document_id)
    return qs.order_by("created_at").first()


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


class DocTypeColorSerializer(serializers.ModelSerializer):
    class Meta:
        from .models import DocTypeColor
        model = DocTypeColor
        fields = ["doc_type", "color"]


class DMSSettingsSerializer(serializers.ModelSerializer):
    class Meta:
        model = DMSSettings
        fields = [
            "organization_name",
            "organization_address",
            "watermark_enabled",
            "watermark_text",
            "watermark_opacity",
            "watermark_position",
            "watermark_apply_to_previews",
            "allow_duplicate_uploads",
            "purge_trashed_duplicates_on_reupload",
            "signed_file_urls_enabled",
            "auto_archive_enabled",
            "auto_archive_after_days",
            "trash_auto_empty_enabled",
            "trash_retention_days",
            "rbac_single_stage",
            "require_metadata_on_upload",
            "session_lifetime_minutes",
            "session_idle_timeout_minutes",
            "bulk_scan_submit_for_approval",
            "access_stages",
            "updated_at",
        ]
        read_only_fields = ["updated_at"]

    def validate_trash_retention_days(self, value):
        if value < 1:
            raise serializers.ValidationError("Trash retention must be at least 1 day.")
        return value

    def validate_watermark_opacity(self, value):
        if value < 1 or value > 80:
            raise serializers.ValidationError("Watermark opacity must be between 1 and 80.")
        return value

    def validate_auto_archive_after_days(self, value):
        if value < 1:
            raise serializers.ValidationError("Auto-archive age must be at least 1 day.")
        return value

    def validate_session_lifetime_minutes(self, value):
        if value < 5:
            raise serializers.ValidationError("Session lifetime must be at least 5 minutes.")
        return value

    def validate_session_idle_timeout_minutes(self, value):
        if value < 0:
            raise serializers.ValidationError("Idle timeout cannot be negative.")
        return value

    def validate(self, attrs):
        lifetime = attrs.get(
            "session_lifetime_minutes",
            getattr(self.instance, "session_lifetime_minutes", None),
        )
        idle = attrs.get(
            "session_idle_timeout_minutes",
            getattr(self.instance, "session_idle_timeout_minutes", None),
        )
        if lifetime is not None and idle:
            if idle > lifetime:
                raise serializers.ValidationError(
                    {"session_idle_timeout_minutes": "Idle timeout cannot exceed the session lifetime."}
                )
        return attrs

class MetadataFieldSerializer(serializers.ModelSerializer):
    class Meta:
        model  = MetadataField
        fields = [
            "id", "label", "key", "field_type", "is_required", "is_unique",
            "is_searchable", "select_options", "default_value", "help_text", "order",
        ]

class MetadataFieldWriteSerializer(serializers.ModelSerializer):
    field_key = serializers.CharField(source="key", required=False, allow_blank=True)

    class Meta:
        model  = MetadataField
        fields = [
            "label", "field_key", "field_type", "is_required", "is_unique",
            "is_searchable", "select_options", "default_value", "help_text", "order",
        ]


class DocumentRelationshipRuleSerializer(serializers.ModelSerializer):
    target_document_type_name = serializers.CharField(source="target_document_type.name", read_only=True)
    target_document_type_code = serializers.CharField(source="target_document_type.code", read_only=True)

    class Meta:
        model = DocumentRelationshipRule
        fields = [
            "id", "source_document_type", "target_document_type",
            "target_document_type_name", "target_document_type_code",
            "relation_type", "source_field_key", "target_field_key",
            "match_operator", "description", "is_active", "require_confirmation",
            "created_at", "updated_at",
        ]
        read_only_fields = ["id", "source_document_type", "created_at", "updated_at"]


class DocumentTypeSerializer(serializers.ModelSerializer):
    metadata_fields        = MetadataFieldSerializer(many=True, read_only=True)
    relationship_rules     = DocumentRelationshipRuleSerializer(
        source="outgoing_relationship_rules", many=True, read_only=True
    )
    workflow_template_name = serializers.CharField(
        source="workflow_template.name", read_only=True, default=None
    )

    class Meta:
        model  = DocumentType
        fields = [
            "id", "name", "code", "reference_prefix", "reference_padding",
            "title_field",
            "description", "icon", "is_active",
            "is_personal_type", "metadata_mode", "max_file_size_mb",
            "access_policy",
            "workflow_template", "workflow_template_name",
            "metadata_fields",
            "relationship_rules",
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
        if not obj.file or not request:
            return None
        try:
            doc = obj.document
        except Exception:
            return None
        if not user_can_download_document(request.user, doc):
            return None
        return build_absolute_document_file_url(
            request, doc, version_id=str(obj.id), use_preview=False, disposition="attachment"
        )


class DocumentCommentSerializer(serializers.ModelSerializer):
    author = UserSummarySerializer(read_only=True)

    class Meta:
        model        = DocumentComment
        fields       = ["id", "author", "content", "is_internal", "created_at", "updated_at"]
        read_only_fields = ["id", "author", "created_at", "updated_at"]


class RelatedDocumentSummarySerializer(serializers.ModelSerializer):
    document_type_name = serializers.CharField(source="document_type.name", read_only=True)

    class Meta:
        model = Document
        fields = [
            "id", "title", "reference_number", "status",
            "document_type_name", "file_name", "created_at", "updated_at",
        ]


class DocumentRelationshipSerializer(serializers.ModelSerializer):
    source_document = RelatedDocumentSummarySerializer(read_only=True)
    target_document = RelatedDocumentSummarySerializer(read_only=True)
    related_document = serializers.SerializerMethodField()
    direction = serializers.SerializerMethodField()
    relation_type_label = serializers.CharField(source="get_relation_type_display", read_only=True)
    created_by = UserSummarySerializer(read_only=True)

    class Meta:
        model = DocumentRelationship
        fields = [
            "id", "relation_type", "relation_type_label", "direction",
            "source_document", "target_document", "related_document",
            "note", "created_by", "created_at",
        ]

    def _current_document_id(self):
        return str(self.context.get("document_id") or "")

    def get_direction(self, obj):
        return "outbound" if str(obj.source_document_id) == self._current_document_id() else "inbound"

    def get_related_document(self, obj):
        related = obj.target_document if self.get_direction(obj) == "outbound" else obj.source_document
        return RelatedDocumentSummarySerializer(related, context=self.context).data


class DocumentRelationshipWriteSerializer(serializers.Serializer):
    target_document_id = serializers.UUIDField()
    relation_type = serializers.ChoiceField(choices=DocumentRelationship.RelationType.values)
    note = serializers.CharField(required=False, allow_blank=True, default="", max_length=2000)


class DocumentListSerializer(serializers.ModelSerializer):
    document_type_name = serializers.CharField(source="document_type.name", read_only=True)
    uploaded_by        = UserSummarySerializer(read_only=True)
    department_name    = serializers.CharField(source="department.name", read_only=True, default=None)
    uploaded_by_department_name = serializers.CharField(
        source="uploaded_by.department.name", read_only=True, default=None
    )
    tags               = TagSerializer(many=True, read_only=True)
    personal_tags      = serializers.SerializerMethodField()
    description        = serializers.SerializerMethodField()
    permissions        = serializers.SerializerMethodField()
    preview_pdf        = serializers.SerializerMethodField()
    is_edit_locked     = serializers.SerializerMethodField()
    edit_locked_by_name = serializers.SerializerMethodField()
    available_bulk_actions = serializers.SerializerMethodField()
    shared_with_me = serializers.SerializerMethodField()
    share_access_level = serializers.SerializerMethodField()
    deleted_by_name = serializers.SerializerMethodField()

    class Meta:
        model  = Document
        fields = [
            "id", "title", "reference_number",
            "document_type", "document_type_name",
            "status", "supplier", "amount", "currency", "document_date",
            "description", # Added for personal documents
            "file_name", "file_size", "file_mime_type",
            "uploaded_by", "department_name", "uploaded_by_department_name", "tags", "personal_tags", "permissions",
            "is_self_upload",
            "is_scanned", "ocr_status",
            "preview_pdf", "preview_status",
            "edit_locked_by", "edit_locked_by_name", "edit_locked_at", "is_edit_locked",
            "current_version", "created_at", "updated_at",
            "deleted_at", "deleted_by_name",
            "available_bulk_actions", "shared_with_me", "share_access_level",
        ]

    def get_deleted_by_name(self, obj):
        return obj.deleted_by.get_full_name() if obj.deleted_by else None


    def get_description(self, obj):
        if not isinstance(obj.metadata, dict):
            return ""
        value = obj.metadata.get("description")
        return value.strip() if isinstance(value, str) else ""

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
        share = self._get_active_share(obj, user)
        if share:
            actions = [GroupAction.VIEW.value]
            if share.access_level == DocumentShare.AccessLevel.DOWNLOAD:
                actions.append(GroupAction.DOWNLOAD.value)
            return actions
        from apps.documents.access import effective_permissions_for_user
        return effective_permissions_for_user(user, obj)

    def _get_active_share(self, obj, user):
        return DocumentShare.objects.filter(
            document=obj,
            recipient=user,
            revoked_at__isnull=True,
        ).filter(
            Q(expires_at__isnull=True) | Q(expires_at__gt=timezone.now())
        ).first()

    def get_shared_with_me(self, obj):
        request = self.context.get("request")
        user = getattr(request, "user", None)
        return bool(user and user.is_authenticated and self._get_active_share(obj, user))

    def get_share_access_level(self, obj):
        request = self.context.get("request")
        user = getattr(request, "user", None)
        if not user or not user.is_authenticated:
            return None
        share = self._get_active_share(obj, user)
        return share.access_level if share else None

    def get_preview_pdf(self, obj):
        request = self.context.get("request")
        if not obj.preview_pdf or not request:
            return None
        return build_absolute_document_file_url(
            request, obj, version_id="", use_preview=True, disposition="inline"
        )

    def get_is_edit_locked(self, obj):
        return obj.is_edit_locked

    def get_edit_locked_by_name(self, obj):
        holder = obj.edit_lock_holder
        return holder.get_full_name().strip() if holder else None

    def get_available_bulk_actions(self, obj):
        """Return list of available bulk actions for this document."""
        request = self.context.get("request")
        user = getattr(request, "user", None)
        if not user or not user.is_authenticated:
            return []

        actions = []

        # Check for workflow actions (approve/reject)
        if hasattr(obj, 'workflow_instance') and obj.workflow_instance:
            active_task = (
                obj.workflow_instance.tasks
                .filter(status__in=["in_progress", "held"])
                .select_related("step")
                .first()
            )
            if active_task and (active_task.assigned_to == user or user.has_admin_access):
                step = active_task.step
                if step.allow_approve:
                    actions.append("approve")
                if step.allow_reject:
                    actions.append("reject")

        # Archive action - only for approved documents
        if obj.status == "approved":
            actions.append("archive")

        # Delete to Trash - creation-stage documents the user is allowed to delete.
        trashable = obj.status in {"draft", "returned", "rejected"}
        can_delete = self._user_can_delete(obj, user)
        if trashable and can_delete:
            actions.append("trash")

        # Void - other non-terminal statuses (kept as the admin terminal action).
        # Suppressed where we already offered "trash" so users don't see two
        # delete-like actions for the same document.
        if obj.status not in ["archived", "void"] and not (trashable and can_delete):
            actions.append("void")

        return actions

    def _user_can_delete(self, obj, user) -> bool:
        if user.has_admin_access:
            return True
        if obj.is_self_upload and obj.uploaded_by_id == user.id:
            return True
        from apps.documents.access import effective_permissions_for_user
        return GroupAction.DELETE.value in effective_permissions_for_user(user, obj)


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
    file        = serializers.SerializerMethodField()
    preview_pdf = serializers.SerializerMethodField()
    is_edit_locked = serializers.SerializerMethodField()
    edit_locked_by_name = serializers.SerializerMethodField()
    ocr_suggestions = serializers.SerializerMethodField()
    shared_with_me = serializers.SerializerMethodField()
    share_access_level = serializers.SerializerMethodField()
    signatures = serializers.SerializerMethodField()

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
            "is_scanned", "ocr_status", "ocr_suggestions",
            "preview_pdf", "preview_status",
            "edit_locked_by", "edit_locked_by_name", "edit_locked_at", "is_edit_locked",
            "current_version", "versions", "comments", "permissions",
            "created_at", "updated_at", "shared_with_me", "share_access_level", "signatures",
        ]
        read_only_fields = [
            "id", "reference_number", "file", "file_name", "file_size", "file_mime_type",
            "checksum", "uploaded_by", "is_self_upload",
            "is_scanned", "ocr_status", "ocr_suggestions",
            "preview_pdf", "preview_status",
            "edit_locked_by", "edit_locked_by_name", "edit_locked_at", "is_edit_locked",
            "current_version", "created_at", "updated_at",
        ]

    def to_representation(self, instance):
        data = super().to_representation(instance)
        request = self.context.get("request")
        user = getattr(request, "user", None)
        metadata = data.get("metadata")
        suggestions = metadata.get("relationship_suggestions") if isinstance(metadata, dict) else None
        if (
            user
            and user.is_authenticated
            and not getattr(user, "has_admin_access", False)
            and isinstance(suggestions, list)
        ):
            target_ids = [
                item.get("target_document_id")
                for item in suggestions
                if isinstance(item, dict) and item.get("target_document_id")
            ]
            visible_target_ids = set(
                str(item)
                for item in Document.objects.filter(id__in=target_ids)
                .filter(Q(uploaded_by=user) | Q(owned_by=user))
                .values_list("id", flat=True)
            )
            metadata["relationship_suggestions"] = [
                item for item in suggestions
                if isinstance(item, dict) and str(item.get("target_document_id")) in visible_target_ids
            ]
        return data

    def get_signatures(self, obj):
        return DocumentSignatureSerializer(
            obj.signatures.select_related("signer", "task__step", "signed_version").all(),
            many=True,
            context=self.context,
        ).data

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
        share = self._get_active_share(obj, user)
        if share:
            actions = [GroupAction.VIEW.value]
            if share.access_level == DocumentShare.AccessLevel.DOWNLOAD:
                actions.append(GroupAction.DOWNLOAD.value)
            return actions
        from apps.documents.access import effective_permissions_for_user
        return effective_permissions_for_user(user, obj)

    def _get_active_share(self, obj, user):
        return DocumentShare.objects.filter(
            document=obj,
            recipient=user,
            revoked_at__isnull=True,
        ).filter(
            Q(expires_at__isnull=True) | Q(expires_at__gt=timezone.now())
        ).first()

    def get_shared_with_me(self, obj):
        request = self.context.get("request")
        user = getattr(request, "user", None)
        return bool(user and user.is_authenticated and self._get_active_share(obj, user))

    def get_share_access_level(self, obj):
        request = self.context.get("request")
        user = getattr(request, "user", None)
        if not user or not user.is_authenticated:
            return None
        share = self._get_active_share(obj, user)
        return share.access_level if share else None

    def get_preview_pdf(self, obj):
        request = self.context.get("request")
        if not obj.preview_pdf or not request:
            return None
        return build_absolute_document_file_url(
            request, obj, version_id="", use_preview=True, disposition="inline"
        )

    def get_file(self, obj):
        request = self.context.get("request")
        if not request or not obj.file:
            return None
        return build_absolute_document_file_url(
            request, obj, version_id="", use_preview=False, disposition="inline"
        )

    def get_is_edit_locked(self, obj):
        return obj.is_edit_locked

    def get_edit_locked_by_name(self, obj):
        holder = obj.edit_lock_holder
        return holder.get_full_name().strip() if holder else None

    def get_ocr_suggestions(self, obj):
        if obj.ocr_status != OCRStatus.DONE:
            return None
        meta = obj.metadata or {}
        result = {}
        if suggestions := meta.get("ocr_suggestions"):
            if isinstance(suggestions, dict) and (
                "fields" in suggestions or "quality" in suggestions
            ):
                result["fields"] = suggestions.get("fields")
                if suggestions.get("quality"):
                    result["quality"] = suggestions.get("quality")
            else:
                result["fields"] = suggestions
        if quality := meta.get("ocr_quality"):
            result.setdefault("quality", quality)   # includes low_quality_warning bool
        return result or None


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

    def validate(self, attrs):
        instance = self.instance
        if instance is not None:
            _check_unique_metadata(
                instance.document_type, attrs, exclude_pk=instance.pk
            )
        return attrs

    def update(self, instance, validated_data):

        tags = validated_data.pop("tags", None)
        personal_tags = validated_data.pop("personal_tags", None)
        if personal_tags is not None:
            normalized_tags = _normalize_personal_tags(personal_tags)
            metadata = dict(validated_data.get("metadata") or instance.metadata or {})
            metadata["personal_tags"] = normalized_tags
            validated_data["metadata"] = metadata

        for attr, value in validated_data.items():
            setattr(instance, attr, value)

        try:
            instance.save()
        except SEARCH_INDEX_EXCEPTIONS as exc:
            # The DB save has already succeeded at this point; django-elasticsearch-dsl
            # raised while trying to mirror the row into Elasticsearch in post_save.
            logger.warning(
                "Metadata edit saved for %s but realtime indexing failed: %s",
                instance.id,
                summarize_bulk_index_error(exc),
            )

        if tags is not None:
            try:
                instance.tags.set(tags)
            except SEARCH_INDEX_EXCEPTIONS as exc:
                logger.warning(
                    "Metadata tags saved for %s but realtime indexing failed: %s",
                    instance.id,
                    summarize_bulk_index_error(exc),
                )

        try:
            from apps.search.indexing import schedule_document_search_pipeline

            schedule_document_search_pipeline(
                str(instance.id),
                reextract_content=False,
                index_immediately=True,
            )
        except Exception:
            logger.exception("Failed to queue async reindex for document %s", instance.id)

        try:
            from .relationship_suggestions import refresh_po_relationship_suggestions

            refresh_po_relationship_suggestions(
                instance,
                actor=getattr(self.context.get("request"), "user", None),
                auto_create_same_batch=bool(instance.bulk_upload_id),
            )
        except Exception:
            logger.exception("Failed to refresh relationship suggestions for document %s", instance.id)

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
            value = dict(value)
            value["personal_tags"] = personal_tags
            return value
        if is_scanned:
            return value
        if not DMSSettings.load().require_metadata_on_upload:
            return value
        doc_type_id = self.initial_data.get("document_type_id")
        if not doc_type_id:
            return value
        try:
            doc_type = DocumentType.objects.get(pk=doc_type_id)
        except DocumentType.DoesNotExist:
            return value
        missing = []
        for field in doc_type.metadata_fields.filter(is_required=True):
            if field.key in DOCUMENT_COLUMN_METADATA_KEYS:
                candidate = self.initial_data.get(field.key)
            else:
                candidate = value.get(field.key)
            if candidate in (None, ""):
                missing.append(field.key)
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
        # Uniqueness applies to every workflow upload, including scanned/OCR ones,
        # regardless of whether metadata is otherwise mandatory.
        if not attrs.get("is_self_upload"):
            _check_unique_metadata(attrs.get("document_type"), attrs)
        return attrs

    def create(self, validated_data):
        import hashlib
        import magic as python_magic

        tags          = validated_data.pop("tags", [])
        personal_tags = validated_data.pop("personal_tags", None)
        request    = self.context["request"]
        upload     = validated_data.pop("file")
        if validated_data.get("is_self_upload"):
            validated_data["document_type"] = _get_personal_document_type()
            metadata = dict(validated_data.get("metadata") or {})
            metadata["personal_tags"] = _normalize_personal_tags(
                personal_tags
                if personal_tags is not None
                else metadata.get("personal_tags")
            )
            validated_data["metadata"] = metadata
            tags = []
        doc_type   = validated_data["document_type"]
        is_scanned = validated_data.get("is_scanned", False)

        if upload.size > doc_type.max_file_size_bytes:
            raise serializers.ValidationError({
                "file": f"File is too large. The limit for {doc_type.name} is "
                        f"{doc_type.max_file_size_mb} MB."
            })

        validated_data["reference_number"] = _generate_unique_reference(doc_type)

        validated_data["file_name"]   = upload.name
        validated_data["file_size"]   = upload.size
        validated_data["uploaded_by"] = request.user

        # Name the document per its type's title_field policy (default: filename)
        validated_data["title"] = _resolve_document_title(
            doc_type, validated_data, upload.name
        )

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
        checksum = sha256.hexdigest()
        validated_data["checksum"] = checksum

        dms_settings = DMSSettings.load()

        # Trashed copies never block a re-upload. If the admin opted in, also
        # permanently remove the uploader's trashed copies of this exact file so
        # a re-upload replaces the trashed version instead of leaving a stale one.
        if dms_settings.purge_trashed_duplicates_on_reupload:
            trashed_duplicates = (
                Document.objects
                .filter(checksum=checksum, uploaded_by=request.user, deleted_at__isnull=False)
                .exclude(file="")
            )
            for trashed in trashed_duplicates:
                try:
                    trashed.hard_delete()
                except Exception:
                    logger.exception(
                        "Failed to purge trashed duplicate %s on re-upload", trashed.id
                    )

        same_user_duplicate = None
        if not dms_settings.allow_duplicate_uploads:
            same_user_duplicate = _find_existing_document_for_checksum(
                checksum,
                uploaded_by=request.user,
            )
        if same_user_duplicate:
            raise serializers.ValidationError({
                "file": (
                    "You have already uploaded this document. "
                    "Use the existing document instead."
                ),
                "duplicate_document_id": str(same_user_duplicate.id),
                "duplicate_reference_number": same_user_duplicate.reference_number,
            })

        # Store every user's upload independently. The public file_name remains
        # the original upload name; storage may suffix the internal path to
        # avoid collisions with another user's file.
        validated_data["file"] = upload

        try:
            doc = super().create(validated_data)
        except SEARCH_INDEX_EXCEPTIONS as exc:
            logger.warning(
                "Document saved for reference %s but realtime indexing failed: %s",
                validated_data["reference_number"],
                summarize_bulk_index_error(exc),
            )
            doc = Document.objects.get(
                reference_number=validated_data["reference_number"]
            )

        # Second pass to close races where this user uploads the same checksum
        # between the pre-create lookup and this row insert.
        same_user_duplicate = None
        if not dms_settings.allow_duplicate_uploads:
            same_user_duplicate = _find_existing_document_for_checksum(
                checksum,
                exclude_document_id=doc.id,
                uploaded_by=request.user,
            )
        if same_user_duplicate:
            previous_storage_name = doc.file.name
            doc.delete()
            file_still_referenced = Document.objects.filter(
                file=previous_storage_name
            ).exists()
            if previous_storage_name and not file_still_referenced:
                try:
                    if default_storage.exists(previous_storage_name):
                        default_storage.delete(previous_storage_name)
                except Exception:
                    logger.exception(
                        "Failed to delete rejected duplicate blob %s",
                        previous_storage_name,
                    )
            raise serializers.ValidationError({
                "file": (
                    "You have already uploaded this document. "
                    "Use the existing document instead."
                ),
                "duplicate_document_id": str(same_user_duplicate.id),
                "duplicate_reference_number": same_user_duplicate.reference_number,
            })

        try:
            doc.tags.set(tags)
        except SEARCH_INDEX_EXCEPTIONS as exc:
            logger.warning(
                "Document tags saved for %s but realtime indexing failed: %s",
                doc.id,
                summarize_bulk_index_error(exc),
            )

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

        try:
            from .relationship_suggestions import refresh_po_relationship_suggestions

            refresh_po_relationship_suggestions(doc, actor=request.user)
        except Exception:
            logger.exception("Failed to refresh relationship suggestions for document %s", doc.id)

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
                from apps.audit.models import AuditEvent
                from apps.audit.utils import record_audit_event

                record_audit_event(
                    AuditEvent.DOCUMENT_OCR_QUEUED,
                    actor=request.user,
                    obj=doc,
                    request=request,
                    changes={"source": "upload", "is_scanned": True},
                )
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
            from apps.search.indexing import schedule_document_search_pipeline

            schedule_document_search_pipeline(
                str(doc.id),
                reextract_content=False,
                index_immediately=True,
            )
        except Exception:
            pass

        return doc


class DocumentBulkActionSerializer(serializers.Serializer):
    document_ids = serializers.ListField(
        child=serializers.UUIDField(), min_length=1, max_length=100,
    )
    action  = serializers.ChoiceField(choices=["approve", "reject", "archive", "void", "trash", "restore", "purge"])
    comment = serializers.CharField(required=False, allow_blank=True, default="")

    def validate(self, attrs):
        if attrs["action"] == "reject" and not attrs.get("comment", "").strip():
            raise serializers.ValidationError(
                {"comment": "A comment is required when rejecting documents."}
            )
        return attrs


class DocumentEmailSelectedSerializer(serializers.Serializer):
    document_ids = serializers.ListField(
        child=serializers.UUIDField(), min_length=1, max_length=100,
    )
    recipient_user_ids = serializers.ListField(
        child=serializers.UUIDField(), required=False, allow_empty=True, default=list,
    )
    recipient_emails = serializers.ListField(
        child=serializers.EmailField(), required=False, allow_empty=True, default=list,
    )
    attachment_mode = serializers.ChoiceField(
        choices=["separate", "combined"], default="separate",
    )
    message = serializers.CharField(required=False, allow_blank=True, default="", max_length=2000)

    def validate(self, attrs):
        if not attrs.get("recipient_user_ids") and not attrs.get("recipient_emails"):
            raise serializers.ValidationError("Select at least one recipient.")
        return attrs


class DocumentShareSelectedSerializer(serializers.Serializer):
    document_ids = serializers.ListField(
        child=serializers.UUIDField(), min_length=1, max_length=100,
    )
    recipient_user_ids = serializers.ListField(
        child=serializers.UUIDField(), min_length=1, max_length=100,
    )
    access_level = serializers.ChoiceField(
        choices=DocumentShare.AccessLevel.values,
        default=DocumentShare.AccessLevel.VIEW,
    )
    message = serializers.CharField(required=False, allow_blank=True, default="", max_length=2000)
    expires_at = serializers.DateTimeField(required=False, allow_null=True)
    notify_by_email = serializers.BooleanField(required=False, default=False)

    def validate_recipient_user_ids(self, value):
        if len(set(value)) != len(value):
            raise serializers.ValidationError("Recipient list contains duplicates.")
        return value

    def validate_expires_at(self, value):
        if value is not None and value <= timezone.now():
            raise serializers.ValidationError("Expiry must be in the future.")
        return value

class DocumentTypeWriteSerializer(serializers.ModelSerializer):
    """
    Write serializer — used for POST /documents/types/ and PATCH /documents/types/{id}/
    Accepts nested metadata_fields and replaces them atomically.
    """
    metadata_fields = MetadataFieldWriteSerializer(many=True, required=False, default=list)
    relationship_rules = DocumentRelationshipRuleSerializer(many=True, required=False, default=list)

    class Meta:
        model  = DocumentType
        fields = [
            "name", "code", "reference_prefix", "reference_padding",
            "title_field",
            "description", "icon", "is_active",
            "is_personal_type", "metadata_mode", "max_file_size_mb",
            "access_policy",
            "workflow_template",
            "metadata_fields",
            "relationship_rules",
        ]
        extra_kwargs = {
            "name":              {"validators": []},
            "code":              {"validators": []},
            "icon":              {"required": False, "allow_blank": True},
            "description":       {"required": False, "allow_blank": True},
            "title_field":       {"required": False, "allow_blank": True},
            "is_personal_type":  {"required": False},
            "metadata_mode":     {"required": False},
            "max_file_size_mb":  {"required": False},
            "workflow_template": {"required": False, "allow_null": True},
        }

    def _active_conflicts(self, *, name: str, code: str):
        qs = DocumentType.objects.filter(is_active=True)
        if self.instance:
            qs = qs.exclude(pk=self.instance.pk)
        return qs.filter(Q(name=name) | Q(code=code))

    def _find_restorable_instance(self, *, name: str, code: str):
        matches = list(
            DocumentType.objects
            .filter(is_active=False)
            .filter(Q(name=name) | Q(code=code))
            .order_by("created_at")
        )
        if not matches:
            return None

        exact_matches = [item for item in matches if item.name == name and item.code == code]
        if exact_matches:
            return exact_matches[0]

        if len(matches) == 1:
            return matches[0]

        raise serializers.ValidationError(
            {
                "non_field_errors": [
                    "An inactive document type already uses this name/code combination. "
                    "Please choose a different name or code."
                ]
            }
        )

    def validate(self, attrs):
        attrs = super().validate(attrs)
        name = attrs.get("name", getattr(self.instance, "name", None))
        code = attrs.get("code", getattr(self.instance, "code", None))

        conflicts = self._active_conflicts(name=name, code=code)
        errors = {}
        if conflicts.filter(name=name).exists():
            errors["name"] = "A document type with this name already exists."
        if conflicts.filter(code=code).exists():
            errors["code"] = "A document type with this code already exists."
        if errors:
            raise serializers.ValidationError(errors)

        is_personal_type = attrs.get(
            "is_personal_type",
            getattr(self.instance, "is_personal_type", False),
        )
        if is_personal_type:
            attrs["metadata_mode"] = DocumentType.MetadataMode.USER_DEFINED
            attrs["workflow_template"] = None
        elif "metadata_mode" not in attrs:
            attrs["metadata_mode"] = getattr(
                self.instance,
                "metadata_mode",
                DocumentType.MetadataMode.ADMIN_DEFINED,
        )
        return attrs

    def _apply_validated_data(self, instance: DocumentType, validated_data: dict) -> DocumentType:
        for attr, value in validated_data.items():
            setattr(instance, attr, value)
        instance.save()
        return instance

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

    def validate_relationship_rules(self, value):
        current_doc_type_id = getattr(self.instance, "id", None)
        seen = set()
        for idx, rule in enumerate(value):
            target_type = rule.get("target_document_type")
            source_key = slugify(str(rule.get("source_field_key", "")).strip().lower()).replace("-", "_")
            target_key = slugify(str(rule.get("target_field_key", "")).strip().lower()).replace("-", "_")
            relation_type = rule.get("relation_type")
            if not target_type:
                raise serializers.ValidationError({idx: "Target document type is required."})
            if current_doc_type_id and str(target_type.id) == str(current_doc_type_id):
                raise serializers.ValidationError({idx: "A relationship rule must target a different document type."})
            if not source_key or not target_key:
                raise serializers.ValidationError({idx: "Source and target reference fields are required."})
            key = (str(target_type.id), relation_type, source_key, target_key)
            if key in seen:
                raise serializers.ValidationError({idx: "Duplicate relationship rule."})
            seen.add(key)
            rule["source_field_key"] = source_key
            rule["target_field_key"] = target_key
        return value

    def validate_workflow_template(self, value):
        if value is None:
            return value

        current_doc_type_id = getattr(self.instance, "id", None)
        if value.document_type_id and value.document_type_id != current_doc_type_id:
            raise serializers.ValidationError(
                "This workflow template is already attached to another document type."
            )
        return value

    def _save_metadata_fields(self, doc_type: DocumentType, fields_data: list) -> None:
        """Delete existing fields and recreate from payload."""
        doc_type.metadata_fields.all().delete()
        try:
            for i, field_data in enumerate(fields_data):
                field_data = dict(field_data)
                if "field_key" in field_data:
                    field_data["key"] = field_data.pop("field_key")
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

    def _sync_workflow_template(self, doc_type: DocumentType) -> None:
        if not doc_type.workflow_template_id:
            return
        WorkflowTemplate.objects.filter(pk=doc_type.workflow_template_id).update(
            document_type=doc_type
        )

    def _save_relationship_rules(self, doc_type: DocumentType, rules_data: list) -> None:
        doc_type.outgoing_relationship_rules.all().delete()
        for rule_data in rules_data:
            rule_data = dict(rule_data)
            rule_data.pop("source_document_type", None)
            DocumentRelationshipRule.objects.create(
                source_document_type=doc_type,
                **rule_data,
            )

    @transaction.atomic
    def create(self, validated_data: dict) -> DocumentType:
        fields_data = validated_data.pop("metadata_fields", [])
        rules_data = validated_data.pop("relationship_rules", [])
        if validated_data.get("metadata_mode") == DocumentType.MetadataMode.USER_DEFINED:
            fields_data = []
        restorable = self._find_restorable_instance(
            name=validated_data["name"],
            code=validated_data["code"],
        )
        if restorable:
            validated_data["is_active"] = True
            doc_type = self._apply_validated_data(restorable, validated_data)
        else:
            doc_type = DocumentType.objects.create(**validated_data)
        self._save_metadata_fields(doc_type, fields_data)
        self._save_relationship_rules(doc_type, rules_data)
        self._sync_workflow_template(doc_type)
        return doc_type

    @transaction.atomic
    def update(self, instance: DocumentType, validated_data: dict) -> DocumentType:
        fields_data = validated_data.pop("metadata_fields", None)
        rules_data = validated_data.pop("relationship_rules", None)
        next_metadata_mode = validated_data.get("metadata_mode", instance.metadata_mode)

        self._apply_validated_data(instance, validated_data)
        self._sync_workflow_template(instance)

        if fields_data is not None:
            if next_metadata_mode == DocumentType.MetadataMode.USER_DEFINED:
                self._save_metadata_fields(instance, [])
            else:
                self._save_metadata_fields(instance, fields_data)
        elif next_metadata_mode == DocumentType.MetadataMode.USER_DEFINED:
            self._save_metadata_fields(instance, [])

        if rules_data is not None:
            self._save_relationship_rules(instance, rules_data)

        return instance


class BulkUploadSerializer(serializers.ModelSerializer):
    """
    Serializer for creating a bulk upload batch.
    
    Accepts:
    - document_type_id: The document type for all files in the batch
    - files: List of files to upload
    - common_tag_ids: Optional tags to apply to all documents
    - is_scanned: Whether to treat all files as scanned (trigger OCR)
    """
    document_type_id = serializers.PrimaryKeyRelatedField(
        queryset=DocumentType.objects.filter(is_active=True),
        source="document_type",
        write_only=True,
    )
    document_type = DocumentTypeSerializer(read_only=True)
    uploaded_by = UserSummarySerializer(read_only=True)
    common_tags = TagSerializer(many=True, read_only=True)
    common_tag_ids = serializers.PrimaryKeyRelatedField(
        queryset=Tag.objects.all(),
        many=True,
        source="common_tags",
        write_only=True,
        required=False,
    )
    
    class Meta:
        model = BulkUpload
        fields = [
            "id",
            "document_type",
            "document_type_id",
            "mode",
            "shared_metadata",
            "uploaded_by",
            "status",
            "total_files",
            "successful_uploads",
            "failed_uploads",
            "approved_count",
            "rejected_count",
            "common_tags",
            "common_tag_ids",
            "progress_percentage",
            "created_at",
            "updated_at",
        ]
        read_only_fields = [
            "id",
            "uploaded_by",
            "mode",
            "shared_metadata",
            "status",
            "total_files",
            "successful_uploads",
            "failed_uploads",
            "approved_count",
            "rejected_count",
            "progress_percentage",
            "created_at",
            "updated_at",
        ]


class BulkUploadSummarySerializer(serializers.ModelSerializer):
    """Lightweight batch row for the 'pending review' queue.

    Reports where the batch came from (``email`` ingestion vs a ``scan``/manual
    bulk upload) and, for email, the originating message so the reviewer has
    context before opening it. Relies on ``ingested_emails`` being prefetched.
    """

    document_type = DocumentTypeSerializer(read_only=True)
    source = serializers.SerializerMethodField()
    email = serializers.SerializerMethodField()

    class Meta:
        model = BulkUpload
        fields = [
            "id", "document_type", "mode", "status",
            "total_files", "successful_uploads", "failed_uploads",
            "created_at", "updated_at", "source", "email",
        ]

    def _first_email(self, obj):
        emails = list(obj.ingested_emails.all())
        return emails[0] if emails else None

    def get_source(self, obj) -> str:
        return "email" if self._first_email(obj) else "scan"

    def get_email(self, obj):
        ie = self._first_email(obj)
        if not ie:
            return None
        return {
            "sender": ie.sender,
            "subject": ie.subject,
            "received_at": ie.received_at.isoformat() if ie.received_at else None,
        }


class BulkUploadCreateSerializer(serializers.Serializer):
    """
    Serializer for initiating a bulk upload.
    
    This creates the BulkUpload record and returns document IDs
    for tracking. The actual file uploads happen via the regular
    document upload endpoint, but tagged with the bulk_upload_id.
    """
    document_type_id = serializers.PrimaryKeyRelatedField(
        queryset=DocumentType.objects.filter(is_active=True),
        source="document_type",
        required=False,
    )
    related_set = serializers.BooleanField(default=False)
    shared_metadata = serializers.DictField(required=False)
    files = serializers.ListField(
        child=serializers.FileField(),
        min_length=1,
        max_length=50,
    )
    common_tag_ids = serializers.PrimaryKeyRelatedField(
        queryset=Tag.objects.all(),
        many=True,
        required=False,
    )
    is_scanned = serializers.BooleanField(default=True)

    def validate_is_scanned(self, value):
        if isinstance(value, str):
            return value.lower() in ("true", "1", "yes", "on")
        return bool(value)

    def validate(self, attrs):
        if attrs.get("related_set") and not attrs.get("document_type"):
            return attrs
        document_type = attrs.get("document_type")
        if not document_type:
            raise serializers.ValidationError(
                {"document_type_id": "Document type is required unless this is a related document set."}
            )
        if document_type.is_personal_type:
            raise serializers.ValidationError(
                {"document_type_id": "Bulk upload is not supported for personal document types."}
            )
        return attrs


class BulkUploadDocumentReadSerializer(serializers.Serializer):
    """Read-only document row returned while a batch is processing or in review."""
    document_id = serializers.UUIDField()
    reference_number = serializers.CharField()
    title = serializers.CharField()
    file_name = serializers.CharField()
    document_type = DocumentTypeSerializer()
    ocr_status = serializers.CharField()
    ocr_suggestions = serializers.DictField(required=False, allow_null=True)
    metadata = serializers.DictField(required=False)
    supplier = serializers.CharField(allow_blank=True)
    amount = serializers.CharField(allow_blank=True, required=False)
    currency = serializers.CharField(allow_blank=True)
    document_date = serializers.CharField(allow_blank=True, required=False)
    due_date = serializers.CharField(allow_blank=True, required=False)


class BulkUploadDetailSerializer(BulkUploadSerializer):
    documents = serializers.SerializerMethodField()
    ocr_progress = serializers.SerializerMethodField()

    class Meta(BulkUploadSerializer.Meta):
        fields = BulkUploadSerializer.Meta.fields + ["documents", "ocr_progress"]

    def get_documents(self, obj):
        from .bulk_upload import serialize_bulk_document

        return [
            serialize_bulk_document(doc)
            for doc in obj.documents.order_by("created_at")
        ]

    def get_ocr_progress(self, obj):
        docs = obj.documents.all()
        total = docs.count()
        if total == 0:
            return {"total": 0, "done": 0, "failed": 0, "pending": 0}
        done = docs.filter(ocr_status=OCRStatus.DONE).count()
        failed = docs.filter(ocr_status=OCRStatus.FAILED).count()
        pending = docs.filter(ocr_status__in=[OCRStatus.PENDING, OCRStatus.PROCESSING, ""]).count()
        return {
            "total": total,
            "done": done,
            "failed": failed,
            "pending": pending,
        }


class BulkUploadReviewItemSerializer(serializers.Serializer):
    """One document decision in the bulk review submit payload."""
    document_id = serializers.UUIDField()
    document_type_id = serializers.UUIDField(required=False)
    title = serializers.CharField(required=False, allow_blank=True)
    supplier = serializers.CharField(required=False, allow_blank=True)
    amount = serializers.CharField(required=False, allow_blank=True)
    currency = serializers.CharField(required=False, allow_blank=True)
    document_date = serializers.CharField(required=False, allow_blank=True)
    due_date = serializers.CharField(required=False, allow_blank=True)
    quantity = serializers.CharField(required=False, allow_blank=True)
    description = serializers.CharField(required=False, allow_blank=True)
    uom = serializers.CharField(required=False, allow_blank=True)
    metadata = serializers.DictField(required=False)
    approved = serializers.BooleanField(default=False)
    rejected = serializers.BooleanField(default=False)

    def validate(self, attrs):
        if attrs.get("approved") and attrs.get("rejected"):
            raise serializers.ValidationError(
                "A document cannot be both approved and rejected."
            )
        if not attrs.get("approved") and not attrs.get("rejected"):
            raise serializers.ValidationError(
                "Each document must be approved or rejected."
            )
        return attrs


class BulkUploadReviewSerializer(serializers.Serializer):
    """Submit per-document metadata and approve/reject decisions for a batch."""
    documents = BulkUploadReviewItemSerializer(many=True)

    def validate(self, attrs):
        bulk_upload = self.context["bulk_upload"]
        batch_ids = {
            str(doc_id)
            for doc_id in bulk_upload.documents.values_list("id", flat=True)
        }
        submitted_ids = {str(item["document_id"]) for item in attrs["documents"]}
        if submitted_ids != batch_ids:
            missing = batch_ids - submitted_ids
            extra = submitted_ids - batch_ids
            raise serializers.ValidationError(
                {
                    "documents": (
                        "Review payload must include every document in the batch. "
                        f"Missing: {len(missing)}, unknown: {len(extra)}."
                    )
                }
            )
        return attrs

    @transaction.atomic
    def save(self):
        bulk_upload = self.context["bulk_upload"]
        request = self.context["request"]
        approved_count = 0
        rejected_count = 0

        for item in self.validated_data["documents"]:
            doc = Document.objects.select_for_update().get(
                id=item["document_id"],
                bulk_upload=bulk_upload,
            )

            if item.get("rejected"):
                doc.status = DocumentStatus.VOID
                doc.save(update_fields=["status", "updated_at"])
                rejected_count += 1
                continue

            edit_payload: dict = {}
            reference_changed = False
            if item.get("document_type_id"):
                try:
                    next_doc_type = DocumentType.objects.get(
                        id=item["document_type_id"],
                        is_active=True,
                    )
                except DocumentType.DoesNotExist:
                    raise serializers.ValidationError(
                        {"document_type_id": "Selected document type does not exist."}
                    )
                if next_doc_type.is_personal_type:
                    raise serializers.ValidationError(
                        {"document_type_id": "Personal document types cannot be used in bulk review."}
                    )
                if next_doc_type.code == "UNCLASS":
                    raise serializers.ValidationError(
                        {"document_type_id": "Select the real document type before submitting."}
                    )
                user = request.user
                if not user.has_admin_access:
                    from apps.documents.access import ACCESS_STAGE_CREATION
                    perms = user.get_all_permissions_for_doctype(
                        str(next_doc_type.id),
                        stage=ACCESS_STAGE_CREATION,
                    )
                    if GroupAction.UPLOAD.value not in perms:
                        raise serializers.ValidationError(
                            {"document_type_id": f"You do not have upload permission for {next_doc_type.name}."}
                        )
                previous_doc_type = doc.document_type
                doc.document_type = next_doc_type
                if previous_doc_type.code == "UNCLASS":
                    doc.reference_number = _generate_unique_reference(next_doc_type)
                    reference_changed = True
            elif bulk_upload.mode == BulkUpload.Mode.RELATED_SET:
                raise serializers.ValidationError(
                    {"document_type_id": "Select a document type for each related document."}
                )

            for field in ("title", "supplier", "currency", "document_date", "due_date"):
                if field in item and item[field]:
                    edit_payload[field] = item[field]
            if item.get("amount"):
                edit_payload["amount"] = item["amount"]
            
            # Add new line-item fields to metadata
            metadata = dict(item.get("metadata") or {})
            for field in ("quantity", "description", "uom"):
                if item.get(field):
                    metadata[field] = item[field]
            if metadata:
                edit_payload["metadata"] = metadata

            if edit_payload:
                editor = DocumentMetadataEditSerializer(
                    doc,
                    data=edit_payload,
                    partial=True,
                    context=self.context,
                )
                editor.is_valid(raise_exception=True)
                editor.save()
                doc.refresh_from_db()
            elif item.get("document_type_id"):
                update_fields = ["document_type", "updated_at"]
                if reference_changed:
                    update_fields.append("reference_number")
                doc.save(update_fields=update_fields)
                doc.refresh_from_db()

            try:
                from .relationship_suggestions import refresh_po_relationship_suggestions

                refresh_po_relationship_suggestions(
                    doc,
                    actor=request.user,
                    auto_create_same_batch=False,
                )
            except Exception:
                logger.exception("Failed to refresh bulk relationship suggestions for document %s", doc.id)

            approved_count += 1

        try:
            from .relationship_suggestions import (
                cleanup_duplicate_auto_po_relationships,
                cleanup_unclassified_relationships,
                refresh_po_relationship_suggestions,
            )

            cleanup_unclassified_relationships(bulk_upload_id=bulk_upload.id)
            cleanup_duplicate_auto_po_relationships(bulk_upload_id=bulk_upload.id)

            for doc in bulk_upload.documents.exclude(status=DocumentStatus.VOID):
                refresh_po_relationship_suggestions(
                    doc,
                    actor=request.user,
                    auto_create_same_batch=False,
                )
            cleanup_duplicate_auto_po_relationships(bulk_upload_id=bulk_upload.id)
        except Exception:
            logger.exception("Failed to refresh final bulk relationship suggestions for %s", bulk_upload.id)

        bulk_upload.approved_count = approved_count
        bulk_upload.rejected_count = rejected_count
        bulk_upload.status = BulkUploadStatus.COMPLETED
        bulk_upload.save(
            update_fields=[
                "approved_count",
                "rejected_count",
                "status",
                "updated_at",
            ]
        )

        return bulk_upload
