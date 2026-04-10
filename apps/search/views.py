"""Search tasks and API views."""
from celery import shared_task
import logging

logger = logging.getLogger(__name__)


@shared_task(bind=True, max_retries=3, queue="indexing")
def index_document(self, document_id: str):
    from apps.documents.models import Document
    from .documents import DocumentIndex
    try:
        doc = Document.objects.get(id=document_id)
        DocumentIndex().update(doc)
    except Exception as exc:
        logger.error("Indexing failed for %s: %s", document_id, exc)
        raise self.retry(exc=exc, countdown=30)


@shared_task(queue="indexing")
def reindex_all():
    """Full re-index. Run via Celery Beat on schedule."""
    from apps.documents.models import Document
    from .documents import DocumentIndex
    idx = DocumentIndex()
    qs = Document.objects.all().iterator(chunk_size=500)
    for doc in qs:
        try:
            idx.update(doc)
        except Exception as exc:
            logger.warning("Reindex error for %s: %s", doc.id, exc)


# ── Search API view ──────────────────────────────────────────────────────────
from rest_framework.views import APIView
from rest_framework.response import Response
from rest_framework.permissions import IsAuthenticated
from elasticsearch_dsl import Q


class DocumentSearchView(APIView):
    """
    POST /api/v1/search/
    {
      "query": "acme invoice",
      "filters": {
        "document_type": "Supplier Invoice",
        "status": ["approved", "pending_approval"],
        "date_from": "2024-01-01",
        "date_to": "2024-12-31",
        "amount_min": 1000,
        "amount_max": 50000,
        "tags": ["urgent"]
      },
      "page": 1,
      "page_size": 20
    }
    """
    permission_classes = [IsAuthenticated]

    def post(self, request):
        from .documents import DocumentIndex
        data = request.data
        query_text = data.get("query", "").strip()
        filters = data.get("filters", {})
        page = max(1, int(data.get("page", 1)))
        page_size = min(100, int(data.get("page_size", 20)))

        s = DocumentIndex.search()

        if query_text:
            s = s.query(
                Q("multi_match", query=query_text, fields=[
                    "title^3", "reference_number^3",
                    "supplier^2", "extracted_text", "metadata.*",
                ])
            )

        if filters.get("document_type"):
            s = s.filter("term", document_type=filters["document_type"])

        if filters.get("status"):
            statuses = filters["status"]
            if isinstance(statuses, str):
                statuses = [statuses]
            s = s.filter("terms", status=statuses)

        if filters.get("date_from"):
            s = s.filter("range", document_date={"gte": filters["date_from"]})
        if filters.get("date_to"):
            s = s.filter("range", document_date={"lte": filters["date_to"]})

        if filters.get("amount_min"):
            s = s.filter("range", amount={"gte": float(filters["amount_min"])})
        if filters.get("amount_max"):
            s = s.filter("range", amount={"lte": float(filters["amount_max"])})

        if filters.get("tags"):
            s = s.filter("terms", tags=filters["tags"])

        # Pagination
        start = (page - 1) * page_size
        s = s[start: start + page_size]

        # Highlighting
        s = s.highlight("title", "extracted_text", fragment_size=150)

        response = s.execute()
        hits = [
            {
                "id": hit.meta.id,
                "score": hit.meta.score,
                "title": hit.title,
                "reference_number": hit.reference_number,
                "document_type": hit.document_type,
                "supplier": getattr(hit, "supplier", ""),
                "amount": getattr(hit, "amount", None),
                "status": hit.status,
                "document_date": getattr(hit, "document_date", None),
                "highlights": {
                    k: list(v) for k, v in (hit.meta.highlight or {}).to_dict().items()
                },
            }
            for hit in response.hits
        ]

        return Response({
            "total": response.hits.total.value,
            "page": page,
            "page_size": page_size,
            "results": hits,
        })
