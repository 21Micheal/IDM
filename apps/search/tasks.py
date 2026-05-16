from celery import shared_task
import logging
from elasticsearch.helpers import BulkIndexError
from .utils import summarize_bulk_index_error
from .indexing import document_queryset_for_index

logger = logging.getLogger(__name__)


@shared_task(bind=True, max_retries=3, queue="indexing")
def index_document(self, document_id: str):
    from apps.documents.models import Document

    try:
        doc = document_queryset_for_index().get(id=document_id)
        from .documents import DocumentIndex

        DocumentIndex().update(doc)
    except Document.DoesNotExist:
        logger.warning("index_document: document %s not found", document_id)
        return
    except BulkIndexError as exc:
        logger.error(
            "Indexing failed for %s: %s",
            document_id,
            summarize_bulk_index_error(exc),
        )
        return
    except Exception as exc:
        logger.error("Indexing failed for %s: %s", document_id, exc)
        raise self.retry(exc=exc, countdown=30)


@shared_task(queue="indexing")
def reindex_all():
    from .documents import DocumentIndex

    idx = DocumentIndex()
    qs = document_queryset_for_index().order_by("created_at")
    for doc in qs.iterator(chunk_size=200):
        try:
            idx.update(doc)
        except BulkIndexError as exc:
            logger.warning(
                "Reindex error %s: %s",
                doc.id,
                summarize_bulk_index_error(exc),
            )
        except Exception as exc:
            logger.warning("Reindex error %s: %s", doc.id, exc)
