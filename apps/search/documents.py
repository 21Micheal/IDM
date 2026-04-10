"""
search/documents.py  — Elasticsearch-DSL index definition
search/tasks.py      — async indexing tasks
search/views.py      — search API endpoint
"""
# ── Index Definition ─────────────────────────────────────────────────────────
from django_elasticsearch_dsl import Document as ESDocument, Index, fields

document_index = Index("dms_documents")
document_index.settings(number_of_shards=1, number_of_replicas=1)


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
