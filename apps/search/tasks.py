from celery import shared_task
import logging
logger = logging.getLogger(__name__)

@shared_task(bind=True, max_retries=3, queue="indexing")
def index_document(self, document_id: str):
    from apps.documents.models import Document
    try:
        doc = Document.objects.get(id=document_id)
        from .documents import DocumentIndex
        DocumentIndex().update(doc)
    except Exception as exc:
        logger.error("Indexing failed for %s: %s", document_id, exc)
        raise self.retry(exc=exc, countdown=30)

@shared_task(queue="indexing")
def reindex_all():
    from apps.documents.models import Document
    from .documents import DocumentIndex
    idx = DocumentIndex()
    for doc in Document.objects.all().iterator(chunk_size=500):
        try:
            idx.update(doc)
        except Exception as exc:
            logger.warning("Reindex error %s: %s", doc.id, exc)
