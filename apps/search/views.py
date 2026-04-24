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
    permission_classes = [IsAuthenticated]

    def post(self, request):
        from .documents import DocumentIndex

        data = request.data
        search_text = data.get("search", "").strip()
        filters = data.get("filters", {}) or {}
        page = max(1, int(data.get("page", 1)))
        page_size = min(100, int(data.get("page_size", 20)))

        s = DocumentIndex.search()

        # === PARTIAL WORD MATCHING (the fix you asked for) ===
        if search_text:
            s = s.query(
                Q(
                    "bool",
                    should=[
                        # Multi-match with fuzziness for typo tolerance
                        Q(
                            "multi_match",
                            query=search_text,
                            fields=[
                                "title^4",
                                "reference_number^3",
                                "supplier^2",
                                "extracted_text",
                                "metadata.personal_tags^2",
                                "metadata.*",
                            ],
                            fuzziness="AUTO",
                            operator="or",
                        ),
                        # Prefix matching for incomplete words (pepp → pepper)
                        Q("prefix", title=search_text.lower()),
                        Q("prefix", reference_number=search_text.lower()),
                        Q("prefix", supplier=search_text.lower()),
                        Q("prefix", extracted_text=search_text.lower()),
                    ],
                    minimum_should_match=1,
                )
            )

        # === Filters (unchanged but kept clean) ===
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

        if filters.get("amount_min") is not None:
            try:
                s = s.filter("range", amount={"gte": float(filters["amount_min"])})
            except (ValueError, TypeError):
                pass
        if filters.get("amount_max") is not None:
            try:
                s = s.filter("range", amount={"lte": float(filters["amount_max"])})
            except (ValueError, TypeError):
                pass

        if filters.get("tags"):
            tags = filters["tags"]
            if isinstance(tags, str):
                tags = [tags]
            s = s.filter("terms", tags=tags)

        # Pagination
        start = (page - 1) * page_size
        s = s[start : start + page_size]

        # Highlighting
        s = s.highlight("title", "extracted_text", fragment_size=180, number_of_fragments=2)

        response = s.execute()

        hits = []
        for hit in response.hits:
            highlight_dict = {}
            if hasattr(hit.meta, "highlight"):
                try:
                    highlight_dict = {
                        k: " ... ".join(v)
                        for k, v in hit.meta.highlight.to_dict().items()
                    }
                except Exception:
                    highlight_dict = {}

            hits.append({
                "id": hit.meta.id,
                "score": round(getattr(hit.meta, "score", 0), 3),
                "title": getattr(hit, "title", ""),
                "reference_number": getattr(hit, "reference_number", ""),
                "document_type": getattr(hit, "document_type", ""),
                "supplier": getattr(hit, "supplier", ""),
                "amount": getattr(hit, "amount", None),
                "status": getattr(hit, "status", ""),
                "document_date": getattr(hit, "document_date", None),
                "highlights": highlight_dict,
            })

        return Response({
            "total": getattr(response.hits.total, "value", response.hits.total),
            "page": page,
            "page_size": page_size,
            "results": hits,
        })
