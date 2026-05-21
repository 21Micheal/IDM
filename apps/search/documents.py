"""Elasticsearch document definition for indexed documents."""

from __future__ import annotations

from datetime import date, datetime
from decimal import Decimal
from uuid import UUID

from django_elasticsearch_dsl import Document as ESDocument, Index, fields

document_index = Index("dms_documents")
document_index.settings(number_of_shards=1, number_of_replicas=1)

_METADATA_SKIP_KEYS = frozenset({"ocr_suggestions", "ocr_quality"})


def _normalize_es_value(value):
    if value is None:
        return None
    if isinstance(value, str):
        return value
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (int, float)):
        return str(value)
    if isinstance(value, (datetime, date)):
        return value.isoformat()
    if isinstance(value, Decimal):
        return str(value)
    if isinstance(value, UUID):
        return str(value)
    if isinstance(value, dict):
        normalized = {}
        for key, item in value.items():
            normalized_item = _normalize_es_value(item)
            if normalized_item in (None, "", [], {}):
                continue
            normalized[str(key)] = normalized_item
        return normalized
    if isinstance(value, (list, tuple, set)):
        normalized_items = [
            normalized_item
            for item in value
            if (normalized_item := _normalize_es_value(item)) not in (None, "", [], {})
        ]
        return normalized_items
    return str(value)


def _normalize_personal_tags(value) -> list[str]:
    if value in (None, ""):
        return []
    if isinstance(value, list):
        raw_items = value
    else:
        raw_items = str(value).split(",")
    tags: list[str] = []
    for item in raw_items:
        tag = str(item).strip()
        if tag and tag not in tags:
            tags.append(tag)
    return tags


def _prepare_metadata_for_index(metadata):
    """
    Normalize document metadata for Elasticsearch.

    OCR suggestions are kept in the database for the UI, but they are not
    needed for search and can be large/nested enough to trip index mapping
    conflicts.
    """
    if not isinstance(metadata, dict):
        return {}

    normalized = _normalize_es_value(metadata)
    if isinstance(normalized, dict):
        for key in _METADATA_SKIP_KEYS:
            normalized.pop(key, None)
    return normalized if isinstance(normalized, dict) else {}


def _metadata_search_text(metadata: dict) -> str:
    """Flatten scalar metadata values into one searchable string."""
    parts: list[str] = []
    for key, value in (metadata or {}).items():
        if key in _METADATA_SKIP_KEYS or key == "personal_tags":
            continue
        normalized = _normalize_es_value(value)
        if isinstance(normalized, str) and normalized.strip():
            parts.append(normalized.strip())
        elif isinstance(normalized, list):
            parts.extend(str(item).strip() for item in normalized if str(item).strip())
    return " ".join(parts)


@document_index.doc_type
class DocumentIndex(ESDocument):
    title = fields.TextField(analyzer="english")
    reference_number = fields.KeywordField()
    document_type = fields.KeywordField()
    file_name = fields.TextField(
        fields={"keyword": fields.KeywordField()},
    )
    file_mime_type = fields.KeywordField()
    supplier = fields.TextField(fields={"keyword": fields.KeywordField()})
    amount = fields.FloatField()
    currency = fields.KeywordField()
    document_date = fields.DateField()
    due_date = fields.DateField()
    status = fields.KeywordField()
    extracted_text = fields.TextField(analyzer="english")
    metadata = fields.ObjectField()
    metadata_text = fields.TextField(analyzer="english")
    tags = fields.KeywordField(multi=True)
    personal_tags = fields.KeywordField(multi=True)
    is_self_upload = fields.BooleanField()
    current_version = fields.IntegerField()
    department = fields.KeywordField()
    uploaded_by = fields.KeywordField()
    uploaded_by_id = fields.KeywordField()
    owned_by_id = fields.KeywordField()
    accessible_user_ids = fields.KeywordField(multi=True)
    created_at = fields.DateField()

    class Django:
        from apps.documents.models import Document as DjangoModel
        model = DjangoModel
        fields = []

    def prepare_document_type(self, instance):
        return instance.document_type.name

    def prepare_file_name(self, instance):
        return instance.file_name

    def prepare_file_mime_type(self, instance):
        return instance.file_mime_type

    def prepare_tags(self, instance):
        if hasattr(instance, "_prefetched_objects_cache") and "tags" in getattr(
            instance, "_prefetched_objects_cache", {}
        ):
            return [t.name for t in instance.tags.all()]
        return list(instance.tags.values_list("name", flat=True))

    def prepare_personal_tags(self, instance):
        meta = instance.metadata if isinstance(instance.metadata, dict) else {}
        return _normalize_personal_tags(meta.get("personal_tags"))

    def prepare_metadata(self, instance):
        return _prepare_metadata_for_index(instance.metadata)

    def prepare_metadata_text(self, instance):
        meta = _prepare_metadata_for_index(instance.metadata)
        parts = [_metadata_search_text(meta)]
        parts.extend(self.prepare_personal_tags(instance))
        return " ".join(part for part in parts if part)

    def prepare_is_self_upload(self, instance):
        return bool(instance.is_self_upload)

    def prepare_current_version(self, instance):
        return int(instance.current_version or 1)

    def prepare_department(self, instance):
        if instance.department_id and instance.department:
            return instance.department.name
        return ""

    def prepare_uploaded_by(self, instance):
        return instance.uploaded_by.get_full_name() or instance.uploaded_by.email

    def prepare_uploaded_by_id(self, instance):
        return str(instance.uploaded_by_id)

    def prepare_owned_by_id(self, instance):
        return str(instance.owned_by_id) if instance.owned_by_id else ""

    def prepare_accessible_user_ids(self, instance):
        user_ids = {str(instance.uploaded_by_id)}
        if instance.owned_by_id:
            user_ids.add(str(instance.owned_by_id))

        workflow = getattr(instance, "workflow_instance", None)
        tasks = getattr(workflow, "tasks", None)
        if tasks is not None:
            active_statuses = {"pending", "in_progress", "held", "returned"}
            for task in tasks.all():
                if task.status in active_statuses and task.assigned_to_id:
                    user_ids.add(str(task.assigned_to_id))

        return sorted(user_ids)
