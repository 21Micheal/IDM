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
import xml.etree.ElementTree as ET

from django.utils import timezone

from .client import SunSystemsClient, SunSystemsConfig, SunSystemsError
from .config import get_connection_override, get_form_values, get_journal_mapping
from .mapping import MappingError, build_sunsystems_ssc, parse_posting_response
from .models import JournalPosting, JournalPostingStatus, effective_connection

logger = logging.getLogger(__name__)


class JournalPostingError(RuntimeError):
    """Raised for an unrecoverable posting failure (after the row is marked failed)."""


def _is_duplicate_second_reference(message: str) -> bool:
    normalized = " ".join(str(message or "").lower().replace("_", " ").split())
    return "duplicate second reference" in normalized or "duplicate secondreference" in normalized


def _unique_purchase_order_reference_xml(xml: str, document, stage: int) -> tuple[str, str] | None:
    """Add a stable document/stage suffix to a PO SecondReference.

    Requisition references come from the local database sequence. If that
    database is restored or reset while SunSystems retains old purchase
    orders, a valid new requisition can reuse an old SecondReference. Only
    called after SunSystems reports that exact collision, so ordinary payloads
    continue using the configured reference unchanged.
    """
    try:
        root = ET.fromstring(xml)
    except (ET.ParseError, TypeError):
        return None

    order = next((el for el in root.iter() if el.tag.rsplit("}", 1)[-1].lower() == "purchaseorder"), None)
    if order is None:
        return None
    second_reference = next(
        (el for el in list(order) if el.tag.rsplit("}", 1)[-1].lower() == "secondreference"),
        None,
    )
    current = (second_reference.text or "").strip() if second_reference is not None else ""
    if not current:
        return None

    document_token = str(getattr(document, "pk", "") or "").replace("-", "")[:8].upper()
    if not document_token:
        return None
    suffix = f"-{document_token}-{int(stage)}"
    unique_reference = current[: max(0, 30 - len(suffix))] + suffix
    if unique_reference == current:
        return None
    second_reference.text = unique_reference
    return ET.tostring(root, encoding="unicode"), unique_reference


def _execute_with_duplicate_reference_recovery(client, build, document, stage: int):
    """Execute once normally, retrying a rejected duplicate PO reference once."""
    try:
        response_xml = client.execute(build.component, build.method, build.ssc_xml)
    except SunSystemsError as exc:
        if not _is_duplicate_second_reference(str(exc)):
            raise
        recovered = _unique_purchase_order_reference_xml(build.ssc_xml, document, stage)
        if not recovered:
            raise
        build.ssc_xml, unique_reference = recovered
        return client.execute(build.component, build.method, build.ssc_xml), unique_reference

    result = parse_posting_response(build.component, response_xml)
    if result.ok or not _is_duplicate_second_reference(result.message or result.raw):
        return response_xml, None

    recovered = _unique_purchase_order_reference_xml(build.ssc_xml, document, stage)
    if not recovered:
        return response_xml, None
    build.ssc_xml, unique_reference = recovered
    return client.execute(build.component, build.method, build.ssc_xml), unique_reference


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
        _maybe_generate_lpo_after_posting(document, posting, actor)
        _maybe_generate_payment_voucher_after_posting(document, posting, actor)
        _resume_lpo_workflow_after_posting(document)
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

    values = mapping.get("_posting_values") if isinstance(mapping.get("_posting_values"), dict) else get_form_values(document)
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
        if str(exc) == "Journal mapping produced no ledger lines.":
            _mark(
                posting,
                JournalPostingStatus.SKIPPED,
                message="No form rows matched this posting configuration; nothing was sent to SunSystems.",
            )
            return posting
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
        response_xml, recovered_second_reference = _execute_with_duplicate_reference_recovery(
            own_client, build, document, stage
        )
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
    if recovered_second_reference and result.ok:
        recovery_note = (
            "Duplicate SecondReference was detected; posting succeeded with "
            f"unique reference {recovered_second_reference}."
        )
        message_text = f"{message_text} | {recovery_note}" if message_text else recovery_note
    if warning_prefix:
        message_text = f"{warning_prefix} | {message_text}" if message_text else warning_prefix
    if (
        result.ok
        and str(build.component or "").strip().lower() == "purchaseorder"
        and not result.journal_number
    ):
        missing_reference = "SunSystems accepted the PurchaseOrder but returned no PO reference; the LPO PDF could not be generated."
        message_text = f"{message_text} | {missing_reference}" if message_text else missing_reference
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
        _maybe_generate_lpo_after_posting(document, posting, actor)
        _maybe_generate_payment_voucher_after_posting(document, posting, actor)
        _resume_lpo_workflow_after_posting(document)
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
    _resume_lpo_workflow_after_posting(document)
    return posting


def _resume_lpo_workflow_after_posting(document) -> None:
    """Release procurement approval gates after their required postings finish."""
    try:
        from apps.workflows.services import WorkflowService
        WorkflowService._resume_imprest_request_workflow_if_ready(document)
        WorkflowService._resume_lpo_workflow_if_ready(document)
    except Exception:
        logger.exception("Could not resume the LPO workflow for %s after posting", document.pk)


def _maybe_generate_lpo_after_posting(document, posting, actor=None) -> None:
    """Create the printable LPO only after SSC returns its assigned PO number."""
    if not (1000 <= int(posting.stage) < 20000):
        return
    if str(posting.component or "").strip().lower() != "purchaseorder":
        return
    try:
        from apps.documents.lpo import generate_lpo_for_posting

        generate_lpo_for_posting(document, posting, actor=actor or posting.posted_by)
    except Exception:
        # The external PO is already committed. Keep the posting successful and
        # log PDF generation separately so it can be recovered without reposting.
        logger.exception(
            "SunSystems PO %s was posted, but its LPO PDF could not be generated for %s",
            posting.journal_number,
            document.pk,
        )


def _maybe_generate_payment_voucher_after_posting(document, posting, actor=None) -> None:
    """Queue the appropriate PV once its source posting set completes."""
    stage = int(getattr(posting, "stage", 0) or 0)
    kind = "imprest" if 20000 <= stage < 30000 else "retirement" if stage >= 30000 else None
    if not kind:
        return
    form_meta = (((document.metadata or {}).get("form") or {}) if isinstance(document.metadata, dict) else {})
    voucher_id_key = "imprest_payment_voucher_document_id" if kind == "imprest" else "payment_voucher_document_id"
    voucher_status = form_meta.get(f"{kind}_payment_voucher_status")
    # A status alone is not proof that the voucher can be opened. Older runs
    # may have persisted "generated" (or "failed") without saving its id;
    # invoke the idempotent generator in that case so it can recover an
    # already-linked voucher or retry generation. A queued retry stays in
    # control while pending.
    if form_meta.get(voucher_id_key) or (voucher_status == "pending" and kind != "imprest"):
        return
    try:
        from apps.documents.payment_voucher import _retirement_stages, generate_payment_voucher_for_retirement
        if kind == "imprest":
            from apps.sunsystems.config import get_imprest_request_postings
            from apps.sunsystems.models import JournalPostingStatus
            stages = {int(item["stage"]) for item in get_imprest_request_postings(document)}
            posted = set(JournalPosting.objects.filter(
                document=document, stage__in=stages, status=JournalPostingStatus.POSTED,
            ).values_list("stage", flat=True))
            if not stages or not stages.issubset(posted):
                return
            _queue_imprest_payment_voucher_generation(document, posting, actor=actor or posting.posted_by)
            return
        else:
            stages = _retirement_stages(document)
            if not stages or stage not in stages:
                return
            voucher = generate_payment_voucher_for_retirement(document, posting, actor=actor or posting.posted_by)
        if voucher is None:
            return
    except Exception:
        # The journal has already posted. Keep document generation bounded and
        # separate so a PV problem never repeats the financial posting.
        logger.exception("%s Payment Voucher generation failed for %s", kind, document.pk)
        try:
            metadata = dict(document.metadata or {})
            form = dict(metadata.get("form") or {})
            status_key = f"{kind}_payment_voucher_status"
            if form.get(voucher_id_key) or form.get(status_key) in {"pending", "generated", "failed"}:
                return
            form[status_key] = "pending"
            metadata["form"] = form
            document.metadata = metadata
            document.save(update_fields=["metadata", "updated_at"])
            from apps.sunsystems.tasks import retry_payment_voucher_generation
            retry_payment_voucher_generation.delay(
                str(document.pk), kind, str(posting.pk),
                str(getattr(actor or posting.posted_by, "pk", "") or ""),
            )
        except Exception:
            logger.exception("Could not queue %s Payment Voucher retry for %s", kind, document.pk)
            try:
                metadata = dict(document.metadata or {})
                form = dict(metadata.get("form") or {})
                form[f"{kind}_payment_voucher_status"] = "failed"
                form[f"{kind}_payment_voucher_error"] = "Could not queue the bounded voucher generation retry."
                metadata["form"] = form
                document.metadata = metadata
                document.save(update_fields=["metadata", "updated_at"])
            except Exception:
                logger.exception("Could not record failed %s voucher queue state for %s", kind, document.pk)


def _queue_imprest_payment_voucher_generation(document, posting, actor=None) -> None:
    """Queue PV rendering without delaying LPO workflow completion."""
    from django.db import transaction
    from apps.documents.models import Document
    from apps.sunsystems.tasks import retry_payment_voucher_generation

    with transaction.atomic():
        latest = Document.objects.select_for_update().get(pk=document.pk)
        metadata = dict(latest.metadata or {})
        form = dict(metadata.get("form") or {})
        if form.get("imprest_payment_voucher_document_id"):
            return
        # Re-queue a pending or stale "generated" status when the document id
        # is missing. The generator locks the source form and recovers linked
        # vouchers, so concurrent retries remain idempotent.
        form["imprest_payment_voucher_status"] = "pending"
        form.pop("imprest_payment_voucher_error", None)
        metadata["form"] = form
        latest.metadata = metadata
        latest.save(update_fields=["metadata", "updated_at"])

    try:
        retry_payment_voucher_generation.delay(
            str(document.pk),
            "imprest",
            str(posting.pk),
            str(getattr(actor or posting.posted_by, "pk", "") or ""),
        )
    except Exception as exc:
        logger.exception("Could not queue Imprest Payment Voucher generation for %s", document.pk)
        with transaction.atomic():
            latest = Document.objects.select_for_update().get(pk=document.pk)
            metadata = dict(latest.metadata or {})
            form = dict(metadata.get("form") or {})
            form["imprest_payment_voucher_status"] = "failed"
            form["imprest_payment_voucher_error"] = f"Could not queue voucher generation: {exc}"[:500]
            metadata["form"] = form
            latest.metadata = metadata
            latest.save(update_fields=["metadata", "updated_at"])


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
        from django.db import transaction

        # Posting stages can complete concurrently. Always merge into the latest
        # locked metadata so an SSC status write cannot erase an LPO link (or a
        # different posting stage) written by another worker.
        with transaction.atomic():
            latest = type(document).objects.select_for_update().get(pk=document.pk)
            meta = dict(latest.metadata or {})
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
            latest.metadata = meta
            latest.save(update_fields=["metadata", "updated_at"])
            document.metadata = meta
    except Exception:  # pragma: no cover - best-effort UI mirror
        logger.exception("Failed to mirror journal posting onto document %s", document.pk)
