"""
apps/documents/email_ingestion.py

Turns inbound IMAP messages (fetched via :mod:`apps.documents.imap_client`)
into fseDMS :class:`~apps.documents.models.Document` drafts.

This is the email sibling of :mod:`apps.documents.migration`. The same shape
applies: a poll pulls messages from an external source and creates DRAFT
documents, deduping so a re-poll never imports the same thing twice, stamping
provenance, and recording per-item outcomes. The orchestration
(:func:`run_mailbox_poll`) owns status/counter bookkeeping and never lets one
bad message abort the batch.

Where it deliberately differs from migration: imported attachments are filed
into a :class:`~apps.documents.models.BulkUpload` so they surface in the
existing bulk-upload **review queue**. A human confirms the document type and
metadata there; only then do the normal amount-threshold workflow rules pick an
approval template. Email metadata is machine-guessed, so nothing here ever
auto-starts a workflow.
"""
from __future__ import annotations

import hashlib
import logging
import mimetypes
import os
from email.message import Message
from email.utils import getaddresses, parsedate_to_datetime

from django.core.files.base import ContentFile
from django.db import transaction
from django.utils import timezone

from .imap_client import (
    IMAPClient,
    IMAPConfig,
    IMAPError,
    merge_connection_with_defaults,
)
from .graph_client import GraphError
from .bulk_upload import (
    UNCLASSIFIED_BULK_DOCUMENT_TYPE_CODE,
    get_unclassified_bulk_document_type,
    sync_bulk_upload_status,
)
from .email_bot import get_email_bot_user
from .models import (
    BulkUpload,
    BulkUploadStatus,
    Document,
    DocumentRelationship,
    DocumentStatus,
    IngestedEmail,
    Mailbox,
    MailboxPollStatus,
    OCRStatus,
    PreviewStatus,
    SIGNATURE_REQUEST_DOCUMENT_TYPE_CODE,
)

logger = logging.getLogger(__name__)

# Inline images below this size are almost always signature logos / tracking
# pixels rather than real documents; drop them unless explicitly attached.
_INLINE_IMAGE_MIN_BYTES = 8 * 1024


# ── message parsing ──────────────────────────────────────────────────────────
def message_sender(message: Message) -> str:
    """The first From: address, lower-cased. Empty when unparseable."""
    addrs = getaddresses(message.get_all("From", []))
    for _name, addr in addrs:
        if addr:
            return addr.strip().lower()
    return ""


def message_identifier(message: Message, uid: int) -> str:
    """A stable dedupe key for the message.

    Prefer the RFC ``Message-ID``; fall back to the IMAP UID so messages that
    lack the header are still deduped per mailbox.
    """
    mid = (message.get("Message-ID") or "").strip()
    return mid or f"uid:{uid}"


def message_received_at(message: Message):
    raw = message.get("Date")
    if not raw:
        return None
    try:
        return parsedate_to_datetime(raw)
    except (TypeError, ValueError):
        return None


def extract_attachments(message: Message) -> list[tuple[str, bytes, str]]:
    """Return ``(filename, content, mime)`` for each document-like attachment.

    Skips the message body parts and tiny inline images (signature logos). A
    part counts as an attachment when it has a filename or an ``attachment``
    Content-Disposition.
    """
    attachments: list[tuple[str, bytes, str]] = []
    for part in message.walk():
        if part.get_content_maintype() == "multipart":
            continue
        filename = part.get_filename()
        disposition = (part.get("Content-Disposition") or "").lower()
        is_attachment = "attachment" in disposition
        if not filename and not is_attachment:
            # Body text/html with no filename — not a document.
            continue
        try:
            content = part.get_payload(decode=True)
        except Exception:  # noqa: BLE001 - malformed MIME part
            logger.warning("extract_attachments: undecodable part %r", filename)
            continue
        if not content:
            continue

        mime = part.get_content_type() or "application/octet-stream"
        if (
            mime.startswith("image/")
            and not is_attachment
            and len(content) < _INLINE_IMAGE_MIN_BYTES
        ):
            continue

        if not filename:
            ext = mimetypes.guess_extension(mime) or ".bin"
            filename = f"attachment-{len(attachments) + 1}{ext}"
        attachments.append((filename, content, mime))
    return attachments


# ── document type selection ──────────────────────────────────────────────────
def resolve_document_type(mailbox: Mailbox, attachments):
    """Decide which document type a message's attachments are filed under.

    Order: the mailbox's ``default_document_type``; otherwise the shared
    ``UNCLASS`` placeholder for the reviewer to classify. ``auto_classify`` is an
    opt-in hook for inferring the type from content — wiring a classifier here
    (e.g. via the existing Claude IDP) is the single place to do it; until then
    it falls back to the default so behaviour is predictable.
    """
    if mailbox.auto_classify:
        inferred = _classify_document_type(mailbox, attachments)
        if inferred is not None:
            return inferred
    if mailbox.default_document_type_id:
        return mailbox.default_document_type
    return get_unclassified_bulk_document_type()


def _classify_document_type(mailbox: Mailbox, attachments):
    """Best-effort content classification via the Claude IDP. Returns the chosen
    ``DocumentType`` or ``None`` to fall back to the default / UNCLASS.

    Tries each scannable attachment until one classifies; Office formats are
    skipped (filled manually). Safe when no model is configured — the IDP helper
    returns ``None`` rather than raising.
    """
    candidates = _classification_candidates()
    if not candidates:
        return None
    for filename, content, mime in attachments:
        chosen = _classify_attachment_document_type(filename, content, mime, candidates)
        if chosen is not None:
            return chosen
    return None


def _classification_candidates() -> list:
    from .models import DocumentType

    return list(
        DocumentType.objects.filter(is_active=True).exclude(
            code__in=["UNCLASS", "PERSONAL", SIGNATURE_REQUEST_DOCUMENT_TYPE_CODE]
        )
    )


def _classify_attachment_document_type(filename: str, content: bytes, mime: str, candidates):
    if not candidates or not _is_scannable(mime):
        return None
    from .ocr.idp import classify_document_type

    return classify_document_type(content, mime, filename, candidates)


# ── single-message import ────────────────────────────────────────────────────
def _is_scannable(mime: str) -> bool:
    """Formats OCR can meaningfully read: PDFs and images.

    Office formats (docx/xlsx/…) and everything else are filled manually, so
    they are never sent through the OCR pipeline.
    """
    return mime == "application/pdf" or mime.startswith("image/")


def _queue_processing(doc: Document, *, do_ocr: bool, user) -> None:
    """Start the right background job for a freshly-created draft.

    * ``do_ocr`` — the document type is known *and* the file is scannable, so run
      the OCR/IDP pipeline to extract metadata against that type's fields.
    * Office documents (never OCR'd) still need a LibreOffice→PDF render so the
      reviewer can preview them while filling metadata by hand.
    * Plain unclassified PDFs/images need nothing: they preview directly and the
      reviewer classifies + fills metadata manually.
    """
    if do_ocr:
        from apps.audit.models import AuditEvent
        from apps.audit.utils import record_audit_event
        from apps.documents.tasks import ocr_document

        Document.objects.filter(id=doc.id).update(ocr_status=OCRStatus.PENDING)
        ocr_document.delay(str(doc.id))
        record_audit_event(
            AuditEvent.DOCUMENT_OCR_QUEUED,
            actor=user,
            obj=doc,
            changes={"source": "email_ingestion", "is_scanned": True},
        )
        return

    if doc.is_office_doc():
        from apps.documents.tasks import generate_document_preview

        updated = Document.objects.filter(
            id=doc.id, preview_status__in=["", PreviewStatus.FAILED]
        ).update(preview_status=PreviewStatus.PENDING)
        if updated:
            generate_document_preview.delay(str(doc.id))


def _create_document(
    *,
    mailbox: Mailbox,
    bulk_upload: BulkUpload,
    document_type,
    filename: str,
    content: bytes,
    mime: str,
    provenance: dict,
    supplier: str,
    user,
) -> Document | None:
    """Create one DRAFT document from an attachment. Returns None on duplicate."""
    from .serializers import _generate_unique_reference

    checksum = hashlib.sha256(content).hexdigest()
    # Idempotency at the binary level: the same attachment re-sent (or forwarded)
    # never creates a second document.
    existing = (
        Document.objects.filter(checksum=checksum, deleted_at__isnull=True)
        .values_list("reference_number", flat=True)
        .first()
    )
    if existing:
        logger.info(
            "email_ingestion: attachment %r already exists as %s — skipping",
            filename, existing,
        )
        return None

    doc_type = document_type
    # OCR only earns its keep when the type is known (so there are fields to
    # populate) AND the file is scannable. Unclassified attachments and
    # non-scannable formats (Office, etc.) become manual drafts instead.
    classified = doc_type.code != UNCLASSIFIED_BULK_DOCUMENT_TYPE_CODE
    do_ocr = classified and _is_scannable(mime)
    title = os.path.splitext(os.path.basename(filename))[0] or "Email attachment"

    metadata = {"_email": provenance}

    with transaction.atomic():
        doc = Document(
            title=title[:255],
            reference_number=_generate_unique_reference(doc_type),
            document_type=doc_type,
            status=DocumentStatus.PENDING_REVIEW,
            supplier=(supplier or "")[:255],
            file_name=filename[:255],
            file_size=len(content),
            file_mime_type=mime[:100],
            checksum=checksum,
            metadata=metadata,
            is_scanned=do_ocr,
            uploaded_by=user,
            bulk_upload=bulk_upload,
        )
        doc.file.save(filename, ContentFile(content), save=False)
        doc.save()

    _queue_processing(doc, do_ocr=do_ocr, user=user)
    return doc


def import_email(mailbox: Mailbox, fetched, *, user) -> dict:
    """Import one fetched message. Never raises — outcome is the returned dict.

    ``fetched`` is an :class:`apps.documents.imap_client.FetchedMessage`.
    """
    message = fetched.message
    msg_id = message_identifier(message, fetched.uid)
    sender = message_sender(message)
    subject = (message.get("Subject") or "").strip()

    # Idempotency: a message already recorded for this mailbox is never re-imported.
    if IngestedEmail.objects.filter(mailbox=mailbox, message_id=msg_id).exists():
        return {"message_id": msg_id, "uid": fetched.uid, "status": "skipped",
                "detail": "Already ingested."}

    # Sender allowlist: drop unwanted senders (newsletters etc.) cheaply, before
    # decoding attachments or storing the raw message. Still recorded so the
    # message is deduped and the decision is auditable.
    if not mailbox.is_sender_allowed(sender):
        IngestedEmail.objects.create(
            mailbox=mailbox,
            message_id=msg_id[:512],
            imap_uid=fetched.uid,
            sender=sender[:320],
            subject=subject[:512],
            received_at=message_received_at(message),
            attachment_count=0,
            status=IngestedEmail.Status.SKIPPED,
            detail="Sender not allowlisted.",
        )
        return {"message_id": msg_id, "uid": fetched.uid, "status": "skipped",
                "detail": "Sender not allowlisted."}

    attachments = extract_attachments(message)
    # Per-mailbox attachment-type filter (e.g. PDFs only) — drop the rest before
    # they become documents.
    if mailbox.allowed_attachment_extensions:
        attachments = [a for a in attachments if mailbox.attachment_allowed(a[0])]

    record = IngestedEmail(
        mailbox=mailbox,
        message_id=msg_id[:512],
        imap_uid=fetched.uid,
        sender=sender[:320],
        subject=subject[:512],
        received_at=message_received_at(message),
        attachment_count=len(attachments),
    )
    # Keep the original message for compliance regardless of outcome.
    try:
        record.raw_email.save(
            f"{fetched.uid}.eml", ContentFile(fetched.raw), save=False
        )
    except Exception:  # noqa: BLE001 - storing the .eml must not abort ingestion
        logger.exception("import_email: could not store raw .eml for %s", msg_id)

    if not attachments:
        record.status = IngestedEmail.Status.SKIPPED
        record.detail = "No document attachments."
        record.save()
        return {"message_id": msg_id, "uid": fetched.uid, "status": "skipped",
                "detail": "No document attachments."}

    doc_type = resolve_document_type(mailbox, attachments)
    # A multi-attachment email is a related set. An unclassified single
    # attachment also uses the related-set review mode so the reviewer gets the
    # per-document type picker to classify it (mirrors the bulk UNCLASS flow);
    # _link_related_set only links when there is more than one document.
    from .bulk_upload import UNCLASSIFIED_BULK_DOCUMENT_TYPE_CODE

    unclassified = doc_type.code == UNCLASSIFIED_BULK_DOCUMENT_TYPE_CODE
    is_related = (mailbox.related_set_attachments and len(attachments) > 1) or unclassified
    supplier = mailbox.supplier_for_sender(sender)
    provenance = {
        "source": mailbox.protocol,
        "mailbox_id": str(mailbox.id),
        "mailbox": mailbox.name,
        "message_id": msg_id,
        "uid": fetched.uid,
        "from": sender,
        "subject": subject,
        "received_at": (record.received_at.isoformat() if record.received_at else None),
        "ingested_at": timezone.now().isoformat(),
    }

    bulk_upload = BulkUpload.objects.create(
        document_type=doc_type,
        uploaded_by=user,
        mode=BulkUpload.Mode.RELATED_SET if is_related else BulkUpload.Mode.SAME_TYPE,
        shared_metadata={"_email": provenance},
        status=BulkUploadStatus.PROCESSING,
        total_files=len(attachments),
    )

    created: list[Document] = []
    failures = 0
    should_classify_attachments = (
        mailbox.auto_classify
        or doc_type.code == UNCLASSIFIED_BULK_DOCUMENT_TYPE_CODE
        or (mailbox.related_set_attachments and len(attachments) > 1 and not mailbox.default_document_type_id)
    )
    classification_candidates = _classification_candidates() if should_classify_attachments else []
    for filename, content, mime in attachments:
        try:
            attachment_doc_type = (
                _classify_attachment_document_type(filename, content, mime, classification_candidates)
                if should_classify_attachments
                else None
            ) or doc_type
            doc = _create_document(
                mailbox=mailbox,
                bulk_upload=bulk_upload,
                document_type=attachment_doc_type,
                filename=filename,
                content=content,
                mime=mime,
                provenance=provenance,
                supplier=supplier,
                user=user,
            )
        except Exception:  # noqa: BLE001 - report per-attachment, keep going
            logger.exception("import_email: failed to import attachment %r", filename)
            doc = None
            failures += 1
        if doc is not None:
            created.append(doc)

    bulk_upload.successful_uploads = len(created)
    bulk_upload.failed_uploads = failures
    bulk_upload.save(update_fields=["successful_uploads", "failed_uploads", "updated_at"])

    if is_related and len(created) > 1:
        _link_related_set(created, user=user)

    if not created:
        # Nothing landed (all duplicates or all failed). Drop the empty batch.
        bulk_upload.delete()
        record.bulk_upload = None
        record.documents_created = 0
        record.status = (
            IngestedEmail.Status.FAILED if failures else IngestedEmail.Status.SKIPPED
        )
        record.detail = (
            "All attachments failed to import." if failures
            else "All attachments were duplicates."
        )
        record.save()
        return {"message_id": msg_id, "uid": fetched.uid, "status": record.status,
                "detail": record.detail}

    sync_bulk_upload_status(bulk_upload)
    record.bulk_upload = bulk_upload
    record.documents_created = len(created)
    record.status = (
        IngestedEmail.Status.PARTIAL if failures else IngestedEmail.Status.IMPORTED
    )
    record.detail = f"{len(created)} document(s) imported." + (
        f" {failures} failed." if failures else ""
    )
    record.save()
    return {"message_id": msg_id, "uid": fetched.uid, "status": record.status,
            "detail": record.detail, "documents_created": len(created),
            "bulk_upload_id": str(bulk_upload.id)}


def _link_related_set(documents: list[Document], *, user) -> None:
    """Link the attachments of one email as a related set (LINKED_TO)."""
    primary = documents[0]
    for other in documents[1:]:
        try:
            DocumentRelationship.objects.get_or_create(
                source_document=primary,
                target_document=other,
                relation_type=DocumentRelationship.RelationType.LINKED_TO,
                defaults={"created_by": user, "note": "Attachments of the same email."},
            )
        except Exception:  # noqa: BLE001 - linking is best-effort
            logger.exception(
                "email_ingestion: could not link %s <-> %s",
                primary.reference_number, other.reference_number,
            )


# ── poll orchestration ───────────────────────────────────────────────────────
def run_mailbox_poll(mailbox_id: str) -> Mailbox:
    """Poll one mailbox end to end, importing each new message.

    Updates the mailbox's last-poll counters, cursor (``last_seen_uid``), and
    status. Safe to call from a Celery task or a management command. Honours
    ``max_messages_per_poll``.
    """
    try:
        mailbox = Mailbox.objects.select_related("default_document_type", "created_by").get(
            pk=mailbox_id
        )
    except Mailbox.DoesNotExist:
        logger.warning("run_mailbox_poll: mailbox %s no longer exists", mailbox_id)
        raise

    mailbox.poll_status = MailboxPollStatus.POLLING
    mailbox.last_error = ""
    mailbox.save(update_fields=["poll_status", "last_error", "updated_at"])

    # Documents are attributed to the Email bot, not the admin who configured
    # the mailbox — so Documents/Dashboard show a clear non-human provenance.
    user = get_email_bot_user()

    # Track progress on the instance so every exit path (success or error)
    # persists the same partial counters and cursor via _finish_poll.
    mailbox.last_imported_count = 0
    mailbox.last_skipped_count = 0
    mailbox.last_failed_count = 0

    try:
        if mailbox.protocol == Mailbox.Protocol.GRAPH:
            _poll_graph(mailbox, user)
        else:
            _poll_imap(mailbox, user)
    except (IMAPError, GraphError) as exc:
        return _finish_poll(mailbox, MailboxPollStatus.ERROR, str(exc))
    except Exception as exc:  # noqa: BLE001
        logger.exception("run_mailbox_poll: mailbox %s crashed", mailbox_id)
        return _finish_poll(mailbox, MailboxPollStatus.ERROR, f"Unexpected error: {exc}")

    return _finish_poll(mailbox, MailboxPollStatus.OK, "")


def _tally(mailbox: Mailbox, outcome) -> None:
    if outcome in (IngestedEmail.Status.IMPORTED, IngestedEmail.Status.PARTIAL):
        mailbox.last_imported_count += 1
    elif outcome in ("skipped", IngestedEmail.Status.SKIPPED):
        mailbox.last_skipped_count += 1
    else:
        mailbox.last_failed_count += 1


def _poll_imap(mailbox: Mailbox, user) -> None:
    """IMAP poll loop: UID-cursor incremental fetch."""
    limit = mailbox.max_messages_per_poll or None
    start_uid = mailbox.last_seen_uid
    with IMAPClient(IMAPConfig.from_mapping(merge_connection_with_defaults(mailbox.connection))) as client:
        # First poll of a mailbox that should not import its backlog: jump the
        # cursor to the current high UID and ingest nothing this round.
        if start_uid == 0 and not mailbox.ingest_history:
            mailbox.last_seen_uid = client.highest_uid()
            Mailbox.objects.filter(id=mailbox.id).update(last_seen_uid=mailbox.last_seen_uid)
            return

        for processed, fetched in enumerate(
            client.iter_messages(since_uid=start_uid, since_date=mailbox.ingest_since)
        ):
            if limit is not None and processed >= limit:
                break
            _tally(mailbox, import_email(mailbox, fetched, user=user).get("status"))
            # Advance the cursor as we go so a mid-poll crash still makes forward
            # progress and we don't re-fetch processed mail.
            mailbox.last_seen_uid = max(mailbox.last_seen_uid, fetched.uid)
            Mailbox.objects.filter(id=mailbox.id).update(last_seen_uid=mailbox.last_seen_uid)


def _poll_graph(mailbox: Mailbox, user) -> None:
    """Microsoft Graph poll loop: receivedDateTime-cursor incremental fetch."""
    from .graph_client import (
        GraphClient,
        GraphConfig,
        merge_connection_with_defaults as graph_merge,
    )

    limit = mailbox.max_messages_per_poll or None
    cursor = mailbox.last_seen_cursor or ""
    with GraphClient(GraphConfig.from_mapping(graph_merge(mailbox.connection))) as client:
        if not cursor and not mailbox.ingest_history:
            # Skip the existing backlog: set the cursor to the newest message's
            # timestamp (or now, if empty) and ingest nothing this round.
            mailbox.last_seen_cursor = client.highest_received() or timezone.now().isoformat()
            Mailbox.objects.filter(id=mailbox.id).update(last_seen_cursor=mailbox.last_seen_cursor)
            return

        since = cursor or (
            f"{mailbox.ingest_since.isoformat()}T00:00:00Z" if mailbox.ingest_since else None
        )
        for processed, fetched in enumerate(client.iter_messages(since_datetime=since)):
            if limit is not None and processed >= limit:
                break
            _tally(mailbox, import_email(mailbox, fetched, user=user).get("status"))
            if fetched.received_at:
                # ISO UTC timestamps compare lexicographically in chronological order.
                mailbox.last_seen_cursor = max(mailbox.last_seen_cursor or "", fetched.received_at)
                Mailbox.objects.filter(id=mailbox.id).update(last_seen_cursor=mailbox.last_seen_cursor)


def _finish_poll(mailbox: Mailbox, status: str, error: str) -> Mailbox:
    mailbox.poll_status = status
    mailbox.last_error = error or ""
    mailbox.last_polled_at = timezone.now()
    # Track consecutive failures so the owner is alerted once per outage (on the
    # first failure after a healthy poll), not on every 5-minute retry.
    if status == MailboxPollStatus.ERROR:
        first_failure = mailbox.consecutive_failures == 0
        mailbox.consecutive_failures += 1
        if first_failure:
            _notify_poll_failure(mailbox, error)
    else:
        mailbox.consecutive_failures = 0
        # Digest: when a poll actually brought in documents, nudge the owner that
        # there's a review queue to clear (one notification per productive poll).
        if mailbox.last_imported_count > 0:
            _notify_ingested(mailbox, mailbox.last_imported_count)
    mailbox.save(update_fields=[
        "poll_status", "last_error", "last_polled_at", "last_seen_uid", "last_seen_cursor",
        "last_imported_count", "last_skipped_count", "last_failed_count",
        "consecutive_failures", "updated_at",
    ])
    return mailbox


def _review_notify_recipients(mailbox: Mailbox) -> list:
    """Who should be told about poll outcomes for this mailbox.

    Prefer configured reviewers; fall back to the mailbox owner (the admin who
    set it up) when the reviewer list is empty.
    """
    reviewers = list(mailbox.reviewers.all())
    if reviewers:
        return reviewers
    if mailbox.created_by_id:
        return [mailbox.created_by]
    return []


def _notify_poll_failure(mailbox: Mailbox, error: str) -> None:
    """Alert reviewers (or the mailbox owner) that polling has started failing."""
    recipients = _review_notify_recipients(mailbox)
    if not recipients:
        return
    try:
        from apps.notifications.models import Notification

        message = f"Mailbox '{mailbox.name}' failed to poll: {error}"[:2000]
        Notification.objects.bulk_create([
            Notification(
                recipient=r,
                type="mailbox_poll_failed",
                message=message,
                link="/admin/mailboxes",
            )
            for r in recipients
        ])
    except Exception:  # noqa: BLE001 - a notification failure must not break polling
        logger.exception("Failed to create poll-failure notification for mailbox %s", mailbox.id)


def _notify_ingested(mailbox: Mailbox, count: int) -> None:
    """Tell reviewers a poll brought in documents to review."""
    recipients = _review_notify_recipients(mailbox)
    if not recipients:
        return
    try:
        from apps.notifications.models import Notification

        message = (
            f"{count} new document email(s) from '{mailbox.name}' are ready for review."
        )
        Notification.objects.bulk_create([
            Notification(
                recipient=r,
                type="mailbox_ingested",
                message=message,
                link="/documents/review",
            )
            for r in recipients
        ])
    except Exception:  # noqa: BLE001 - a notification failure must not break polling
        logger.exception("Failed to create ingestion notification for mailbox %s", mailbox.id)
