"""
apps/sunsystems/tasks.py

Celery tasks for SunSystems integration. Journal posting is a network write to a
finance system, so it runs out-of-band of the approval transaction and is
retryable. The orchestration itself (idempotency, logging) lives in
:mod:`apps.sunsystems.journal`; this is the thin async wrapper.
"""
from __future__ import annotations

import logging

from celery import shared_task

logger = logging.getLogger(__name__)


@shared_task(bind=True, max_retries=0, queue="default")
def post_journal_for_document(self, document_id: str, actor_id: str | None = None):
    """Post one document's journal to SunSystems (idempotent).

    Failures are recorded on the document's JournalPosting row by the
    orchestration layer, so this task does not itself retry — an operator (or a
    future scheduled sweep) retries via the API. Returns a small status dict.
    """
    from apps.documents.models import Document

    try:
        document = Document.objects.get(pk=document_id)
    except Document.DoesNotExist:
        logger.warning("post_journal_for_document: document %s no longer exists", document_id)
        return {"ok": False, "detail": "document not found"}

    actor = None
    if actor_id:
        try:
            from django.contrib.auth import get_user_model
            actor = get_user_model().objects.filter(pk=actor_id).first()
        except Exception:  # pragma: no cover - defensive
            actor = None

    from apps.sunsystems.journal import post_journal_for_document as run

    posting = run(document, actor=actor)
    return {
        "ok": posting.status == "posted",
        "status": posting.status,
        "journal_number": posting.journal_number,
        "document_id": str(document_id),
    }
