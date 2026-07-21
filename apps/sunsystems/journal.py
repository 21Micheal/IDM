"""
apps/sunsystems/journal.py

Orchestrates posting a form document's journal to SunSystems (Ledger Import or
PurchaseOrder).

The flow, kept deliberately small and idempotent:

  1. Find/create the document's :class:`JournalPosting` row for the given stage.
     If it is already POSTED, do nothing (the workflow hook may fire more than
     once; we never double-post).
  2. Read the journal mapping for this stage + filled values off the document.
     If posting isn't enabled, mark the row SKIPPED.
  3. Compile the ``<SSC>`` document via :mod:`apps.sunsystems.mapping`.
  4. Authenticate + ComponentExecutor.Execute via :class:`SunSystemsClient`.
  5. Parse the reply; persist journal number / messages / raw XML on the row.

A document may have multiple posting stages (e.g. stage 1 = advance journal,
stage 2 = retirement reconciliation). Each stage has its own ``JournalPosting``
row — identified by the ``(document, stage)`` pair — and is fully independent.

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


def post_journal_for_document(
    document,
    *,
    stage: int = 1,
    actor=None,
    client: SunSystemsClient | None = None,
) -> JournalPosting:
    """Post ``document``'s journal for ``stage`` to SunSystems. Idempotent and self-logging.

    Returns the :class:`JournalPosting` row in its final state. Never raises for
    an ordinary SunSystems/mapping failure — the failure is recorded on the row
    (status FAILED) so it can be retried; it only raises for truly unexpected
    programmer errors.
    """
    posting, _ = JournalPosting.objects.get_or_create(document=document, stage=stage)

    if posting.status == JournalPostingStatus.POSTED:
        return posting

    mapping = get_journal_mapping(document, stage=stage)
    if not mapping or not mapping.get("enabled"):
        # Check the parent config's enabled flag (stages inherit it)
        from .config import journal_posting_enabled
        if not journal_posting_enabled(document):
            _mark(posting, JournalPostingStatus.SKIPPED,
                  message="Journal posting is not enabled for this form.")
            return posting
        if not mapping:
            _mark(posting, JournalPostingStatus.SKIPPED,
                  message=f"No mapping defined for posting stage {stage}.")
            return posting

    # Persist the stage label from the mapping (e.g. "Advance", "Retirement").
    stage_label = str(mapping.get("label") or "").strip()
    if stage_label and not posting.stage_label:
        posting.stage_label = stage_label

    values = get_form_values(document)
    conn = effective_connection(get_connection_override(document))
    config = SunSystemsConfig.from_mapping(conn)

    posting.status = JournalPostingStatus.POSTING
    posting.attempts = (posting.attempts or 0) + 1
    posting.business_unit = config.business_unit
    posting.error = ""
    posting.save(update_fields=[
        "status", "attempts", "business_unit", "error", "stage_label", "updated_at",
    ])

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

    # Mapping-level configuration warnings (e.g. a Retirement panel's "issued
    # amount" field left unset, or pointing at a since-renamed/removed field)
    # never fail the build — a malformed retirement config still produces a
    # balanced-looking journal, just with the wrong numbers, so there's no
    # exception to catch. Fold them into the posting's message so they're
    # visible on the posting record regardless of outcome — this is the one
    # thing standing between "silently posted a wrong-but-balanced journal"
    # and someone actually noticing.
    warning_prefix = (
        "⚠ " + " | ".join(build.warnings) if build.warnings else ""
    )

    # 2) Send it.
    own_client = client or SunSystemsClient(config)
    try:
        response_xml = own_client.execute(build.component, build.method, build.ssc_xml)
    except SunSystemsError as exc:
        error_text = str(exc)
        if warning_prefix:
            error_text = f"{warning_prefix} | {error_text}"
        _mark(posting, JournalPostingStatus.FAILED, error=error_text, request_xml=build.ssc_xml)
        return posting

    # 3) Parse the reply.
    result = parse_posting_response(build.component, response_xml)
    posting.response_xml = result.raw
    message_text = result.message
    if warning_prefix:
        message_text = f"{warning_prefix} | {message_text}" if message_text else warning_prefix
    posting.message = message_text
    if result.ok:
        posting.journal_number = result.journal_number or ""
        posting.posted_at = timezone.now()
        posting.posted_by = actor
        _mark(
            posting,
            JournalPostingStatus.POSTED,
            request_xml=build.ssc_xml,
            response_xml=result.raw,
            message=message_text,
        )
        _write_back_to_document(document, posting)
        try:
            from apps.documents.builder_workflow import sync_retirement_variance

            sync_retirement_variance(document)
        except Exception:  # pragma: no cover - display-only, never blocks posting
            logger.exception("Failed to sync retirement variance for document %s", document.pk)
    else:
        error_text = result.message or "SunSystems did not return a journal number."
        if warning_prefix:
            error_text = f"{warning_prefix} | {error_text}"
        _mark(
            posting,
            JournalPostingStatus.FAILED,
            error=error_text,
            request_xml=build.ssc_xml,
            response_xml=result.raw,
            message=message_text,
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
    for extra in ("posted_at", "posted_by", "journal_number", "component", "method",
                  "business_unit", "stage_label"):
        update.add(extra)
    posting.save(update_fields=list(update))


def _write_back_to_document(document, posting: JournalPosting) -> None:
    """Mirror the posting result onto metadata.sunsystems.postings[stage] for the UI."""
    try:
        meta = dict(document.metadata or {})
        ss = dict(meta.get("sunsystems") or {})
        postings = dict(ss.get("postings") or {})
        postings[str(posting.stage)] = {
            "status": posting.status,
            "journal_number": posting.journal_number,
            "message": posting.message,
            "posted_at": posting.posted_at.isoformat() if posting.posted_at else None,
        }
        ss["postings"] = postings
        # Legacy single-posting compat: also write to ss["posting"] for stage 1.
        if posting.stage == 1:
            ss["posting"] = postings["1"]
        meta["sunsystems"] = ss
        document.metadata = meta
        type(document).objects.filter(pk=document.pk).update(metadata=meta)
    except Exception:  # pragma: no cover - best-effort UI mirror
        logger.exception("Failed to mirror journal posting onto document %s", document.pk)