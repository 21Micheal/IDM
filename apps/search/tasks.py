from celery import shared_task
import logging
from elasticsearch.helpers import BulkIndexError
from .utils import summarize_bulk_index_error
from .indexing import document_queryset_for_index

logger = logging.getLogger(__name__)


def _remove_from_index(document_id: str) -> None:
    """Delete a single document from Elasticsearch by id (ignoring 'not found')."""
    from elasticsearch_dsl.connections import connections
    from .documents import DocumentIndex

    try:
        connections.get_connection().delete(
            index=DocumentIndex._index._name,
            id=str(document_id),
        )
    except Exception as exc:  # NotFoundError (already gone) is fine — nothing to do.
        if exc.__class__.__name__ != "NotFoundError":
            logger.warning("deindex: could not remove %s from index: %s", document_id, exc)


@shared_task(queue="indexing")
def deindex_document(document_id: str):
    """Remove a trashed/purged document from the search index."""
    _remove_from_index(document_id)


@shared_task(bind=True, max_retries=3, queue="indexing")
def index_document(self, document_id: str):
    from apps.documents.models import Document

    try:
        doc = document_queryset_for_index().get(id=document_id)
        # A trashed (soft-deleted) document must not live in the index — drop it
        # instead of indexing so it stops surfacing in search.
        if getattr(doc, "deleted_at", None) is not None:
            _remove_from_index(document_id)
            return
        from .documents import DocumentIndex

        DocumentIndex().update(doc)
    except Document.DoesNotExist:
        # The row is gone (purged) — make sure any stale index entry goes too.
        _remove_from_index(document_id)
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
    # Trashed (soft-deleted) documents must never be (re)indexed.
    qs = document_queryset_for_index().filter(deleted_at__isnull=True).order_by("created_at")
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
