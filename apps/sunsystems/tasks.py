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
from celery.exceptions import MaxRetriesExceededError

logger = logging.getLogger(__name__)


@shared_task(bind=True, max_retries=0, queue="default")
def post_journal_for_document(self, document_id: str, stage: int = 1, actor_id: str | None = None):
    """Post one document's journal stage to SunSystems (idempotent).

    ``stage`` selects which posting stage to execute (1 = advance/default,
    2 = retirement, etc.). Failures are recorded on the document's JournalPosting
    row; this task does not itself retry.
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

    posting = run(document, stage=stage, actor=actor)
    return {
        "ok": posting.status == "posted",
        "status": posting.status,
        "stage": posting.stage,
        "journal_number": posting.journal_number,
        "document_id": str(document_id),
    }


@shared_task(bind=True, max_retries=12, queue="default")
def process_payment_run(self, payment_run_id: str, actor_id: str | None = None):
    """Post an approved payment run to SunSystems and verify payment.

    The underlying ``process_payment_run`` function sets status=PAID **only**
    when a follow-up Journal/Query confirms that every submitted ledger line
    now carries AllocationMarker=P in SunSystems.  If the PaymentRun/Process
    call succeeds but the verification step finds lines not yet marked P, the
    run stays in PROCESSING and this task retries verification with backoff
    (without re-posting the Process call once a response is stored).
    """
    from apps.sunsystems.models import PaymentRun

    try:
        run = PaymentRun.objects.get(pk=payment_run_id)
    except PaymentRun.DoesNotExist:
        logger.warning("process_payment_run: payment run %s no longer exists", payment_run_id)
        return {"ok": False, "detail": "payment run not found"}

    actor = None
    if actor_id:
        try:
            from django.contrib.auth import get_user_model
            actor = get_user_model().objects.filter(pk=actor_id).first()
        except Exception:  # pragma: no cover - defensive
            actor = None

    from apps.sunsystems.payment_run import process_payment_run as run_process

    try:
        processed = run_process(run, actor=actor)
        return {
            "ok": processed.status == "paid",
            "status": processed.status,
            "payment_reference": processed.payment_reference,
            "payment_run_id": str(payment_run_id),
        }
    except Exception as exc:
        # Re-read the current status so the log accurately reflects whether
        # the run is FAILED (SunSystems rejected it) or PROCESSING (process
        # call succeeded but AllocationMarker=P not yet confirmed).
        try:
            run.refresh_from_db(fields=["status", "error"])
            current_status = run.status
            current_error = run.error
        except Exception:
            current_status = "unknown"
            current_error = str(exc)

        if current_status == "processing":
            logger.warning(
                "Payment run %s processed by SunSystems but not yet confirmed as paid "
                "(attempt %s/%s): %s",
                payment_run_id,
                self.request.retries + 1,
                self.max_retries + 1,
                current_error,
            )
            # Back off while SunSystems settles ledger markers (5s, 10s, … capped at 30s).
            countdown = min(30, 5 + self.request.retries * 5)
            try:
                raise self.retry(exc=exc, countdown=countdown)
            except MaxRetriesExceededError:
                logger.error(
                    "Payment run %s still unconfirmed after %s verification attempts: %s",
                    payment_run_id,
                    self.max_retries + 1,
                    current_error,
                )
                return {
                    "ok": False,
                    "status": current_status,
                    "detail": current_error or str(exc),
                    "payment_run_id": str(payment_run_id),
                }

        logger.exception("Payment run %s failed (status=%s)", payment_run_id, current_status)
        return {
            "ok": False,
            "status": current_status,
            "detail": current_error or str(exc),
            "payment_run_id": str(payment_run_id),
        }
