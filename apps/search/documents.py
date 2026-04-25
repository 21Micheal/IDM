"""Elasticsearch document definition for indexed documents."""

from __future__ import annotations

from datetime import date, datetime
from decimal import Decimal
from uuid import UUID

from django_elasticsearch_dsl import Document as ESDocument, Index, fields

document_index = Index("dms_documents")
document_index.settings(number_of_shards=1, number_of_replicas=1)


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


def _prepare_metadata_for_index(metadata):
    """
    Normalize document metadata for Elasticsearch.

    OCR suggestions are kept in the database for the UI, but they are not
    needed for search and can be large/nested enough to trip index mapping
    conflicts. Excluding them here keeps document uploads resilient while the
    OCR endpoint still reads the full payload from the database.
    """
    if not isinstance(metadata, dict):
        return {}

    normalized = _normalize_es_value(metadata)
    if isinstance(normalized, dict):
        normalized.pop("ocr_suggestions", None)
    return normalized


@document_index.doc_type
class DocumentIndex(ESDocument):
    title = fields.TextField(analyzer="english")
    reference_number = fields.KeywordField()
    document_type = fields.KeywordField()
    supplier = fields.TextField(fields={"keyword": fields.KeywordField()})
    amount = fields.FloatField()
    currency = fields.KeywordField()
    document_date = fields.DateField()
    status = fields.KeywordField()
    extracted_text = fields.TextField(analyzer="english")
    metadata = fields.ObjectField()
    tags = fields.KeywordField(multi=True)
    uploaded_by = fields.KeywordField()
    created_at = fields.DateField()

    class Django:
        from apps.documents.models import Document as DjangoModel
        model = DjangoModel
        fields = []

    def prepare_document_type(self, instance):
        return instance.document_type.name

    def prepare_tags(self, instance):
        return [t.name for t in instance.tags.all()]

    def prepare_uploaded_by(self, instance):
        return instance.uploaded_by.get_full_name()

    def prepare_metadata(self, instance):
        return _prepare_metadata_for_index(instance.metadata)
