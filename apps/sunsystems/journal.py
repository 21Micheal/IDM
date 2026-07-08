"""
apps/sunsystems/journal.py

Orchestrates posting a form document's journal to SunSystems (Ledger Import).

The flow, kept deliberately small and idempotent:

  1. Find/create the document's single :class:`JournalPosting` row.
     If it is already POSTED, do nothing (the workflow hook may fire more than
     once; we never double-post).
  2. Read the journal mapping + filled values off the document.
     If posting isn't enabled, mark the row SKIPPED.
  3. Compile the ``<SSC>`` document via :mod:`apps.sunsystems.mapping`.
  4. Authenticate + ComponentExecutor.Execute via :class:`SunSystemsClient`.
  5. Parse the reply; persist journal number / messages / raw XML on the row.

Everything that can vary (accounts, analysis, business unit, journal type,
connection) is data in the mapping; this module is pure orchestration.
"""
from __future__ import annotations

import logging

from django.utils import timezone

from .client import SunSystemsClient, SunSystemsConfig, SunSystemsError
from .config import get_connection_override, get_form_values, get_journal_mapping
from .mapping import MappingError, build_sunsystems_ssc, parse_posting_response
from .models import JournalPosting, JournalPostingStatus, effective_connection

logger = logging.getLogger(__name__)


class JournalPostingError(RuntimeError):
    """Raised for an unrecoverable posting failure (after the row is marked failed)."""


def post_journal_for_document(document, *, actor=None, client: SunSystemsClient | None = None) -> JournalPosting:
    """Post ``document``'s journal to SunSystems. Idempotent and self-logging.

    Returns the :class:`JournalPosting` row in its final state. Never raises for
    an ordinary SunSystems/mapping failure — the failure is recorded on the row
    (status FAILED) so it can be retried; it only raises for truly unexpected
    programmer errors.
    """
    posting, _ = JournalPosting.objects.get_or_create(document=document)

    if posting.status == JournalPostingStatus.POSTED:
        return posting

    mapping = get_journal_mapping(document)
    if not mapping or not mapping.get("enabled"):
        _mark(posting, JournalPostingStatus.SKIPPED, message="Journal posting is not enabled for this form.")
        return posting

    values = get_form_values(document)
    conn = effective_connection(get_connection_override(document))
    config = SunSystemsConfig.from_mapping(conn)

    posting.status = JournalPostingStatus.POSTING
    posting.attempts = (posting.attempts or 0) + 1
    posting.business_unit = config.business_unit
    posting.error = ""
    posting.save(update_fields=["status", "attempts", "business_unit", "error", "updated_at"])

    # 1) Build the SSC document.
    try:
        build = build_sunsystems_ssc(
            mapping,
            values,
            business_unit_default=config.business_unit,
            budget_code_default=config.budget_code,
        )
    except MappingError as exc:
        _mark(posting, JournalPostingStatus.FAILED, error=f"Mapping error: {exc}")
        return posting

    posting.component = build.component
    posting.method = build.method
    posting.request_xml = build.ssc_xml

    # 2) Send it.
    own_client = client or SunSystemsClient(config)
    try:
        response_xml = own_client.execute(build.component, build.method, build.ssc_xml)
    except SunSystemsError as exc:
        _mark(posting, JournalPostingStatus.FAILED, error=str(exc), request_xml=build.ssc_xml)
        return posting

    # 3) Parse the reply.
    result = parse_posting_response(build.component, response_xml)
    posting.response_xml = result.raw
    posting.message = result.message
    if result.ok:
        posting.journal_number = result.journal_number or ""
        posting.posted_at = timezone.now()
        posting.posted_by = actor
        _mark(
            posting,
            JournalPostingStatus.POSTED,
            request_xml=build.ssc_xml,
            response_xml=result.raw,
            message=result.message,
        )
        _write_back_to_document(document, posting)
    else:
        _mark(
            posting,
            JournalPostingStatus.FAILED,
            error=result.message or "SunSystems did not return a journal number.",
            request_xml=build.ssc_xml,
            response_xml=result.raw,
            message=result.message,
        )
    return posting


def _mark(posting: JournalPosting, status: str, **fields) -> None:
    posting.status = status
    update = {"status", "updated_at"}
    for key, value in fields.items():
        setattr(posting, key, value)
        update.add(key)
    # posted_at / posted_by / journal_number may have been set on the instance
    # before this call; include them so they persist.
    for extra in ("posted_at", "posted_by", "journal_number", "component", "method", "business_unit"):
        update.add(extra)
    posting.save(update_fields=list(update))


def _write_back_to_document(document, posting: JournalPosting) -> None:
    """Mirror the posting result onto metadata.sunsystems.posting for the UI."""
    try:
        meta = dict(document.metadata or {})
        ss = dict(meta.get("sunsystems") or {})
        ss["posting"] = {
            "status": posting.status,
            "journal_number": posting.journal_number,
            "message": posting.message,
            "posted_at": posting.posted_at.isoformat() if posting.posted_at else None,
        }
        meta["sunsystems"] = ss
        document.metadata = meta
        type(document).objects.filter(pk=document.pk).update(metadata=meta)
    except Exception:  # pragma: no cover - best-effort UI mirror
        logger.exception("Failed to mirror journal posting onto document %s", document.pk)
