"""
Tests for IMAP email ingestion (apps.documents.email_ingestion / imap_client).

The IMAP server and the OCR/Celery tasks are stubbed, so these exercise the
ingestion logic itself: attachment extraction, draft creation into a bulk-upload
review batch, dedupe, sender→supplier enrichment, related-set linking, and the
poll orchestration's counters/cursor/error handling.
"""
from email.mime.application import MIMEApplication
from email.mime.image import MIMEImage
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from unittest import mock

from django.test import TestCase

from apps.accounts.models import User
from apps.documents import email_ingestion
from apps.documents.imap_client import FetchedMessage, IMAPConfig
from apps.documents.models import (
    BulkUpload,
    Document,
    DocumentRelationship,
    DocumentStatus,
    DocumentType,
    IngestedEmail,
    Mailbox,
    MailboxPollStatus,
)


def _build_email(
    *,
    message_id="<msg-1@acme.com>",
    sender="Billing <billing@acme.com>",
    subject="Invoice 123",
    attachments=(("invoice.pdf", b"%PDF-1.4 fake invoice", "application", "pdf"),),
    inline_images=(),
):
    msg = MIMEMultipart()
    msg["From"] = sender
    msg["Subject"] = subject
    if message_id:
        msg["Message-ID"] = message_id
    msg["Date"] = "Tue, 01 Jul 2025 10:00:00 +0000"
    msg.attach(MIMEText("Please find the attached document.", "plain"))
    for filename, content, maintype, subtype in attachments:
        part = MIMEApplication(content, _subtype=subtype)
        part.add_header("Content-Disposition", "attachment", filename=filename)
        msg.attach(part)
    for filename, content in inline_images:
        img = MIMEImage(content, "png")
        img.add_header("Content-Disposition", "inline", filename=filename)
        msg.attach(img)
    return msg


def _fetched(msg, uid=10):
    raw = msg.as_bytes()
    import email as _email

    return FetchedMessage(uid=uid, raw=raw, message=_email.message_from_bytes(raw))


class _FakeIMAPClient:
    """Stand-in for IMAPClient used by run_mailbox_poll."""

    def __init__(self, messages, *, raise_on_iter=None):
        self._messages = messages
        self._raise = raise_on_iter

    def __call__(self, *args, **kwargs):  # IMAPClient(config) -> instance
        return self

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def highest_uid(self):
        return max((m.uid for m in self._messages), default=0)

    def iter_messages(self, *, since_uid=0, since_date=None):
        if self._raise:
            raise self._raise
        for m in self._messages:
            if m.uid > since_uid:
                yield m


class IMAPConfigTests(TestCase):
    def test_from_mapping_friendly_and_defaults(self):
        cfg = IMAPConfig.from_mapping(
            {"host": "mail.example.com", "username": "u", "password": "p"}
        )
        self.assertEqual(cfg.host, "mail.example.com")
        self.assertEqual(cfg.port, 993)
        self.assertTrue(cfg.use_ssl)
        self.assertEqual(cfg.folder, "INBOX")
        self.assertEqual(cfg.missing_fields(), [])

    def test_missing_fields_reported(self):
        cfg = IMAPConfig.from_mapping({"host": "mail.example.com"})
        self.assertIn("username", cfg.missing_fields())
        self.assertIn("password", cfg.missing_fields())

    def test_non_ssl_default_port(self):
        cfg = IMAPConfig.from_mapping({"host": "h", "username": "u", "password": "p", "use_ssl": "false"})
        self.assertFalse(cfg.use_ssl)
        self.assertEqual(cfg.port, 143)


class AttachmentExtractionTests(TestCase):
    def test_body_skipped_attachment_kept(self):
        msg = _build_email()
        attachments = email_ingestion.extract_attachments(msg)
        self.assertEqual(len(attachments), 1)
        filename, content, mime = attachments[0]
        self.assertEqual(filename, "invoice.pdf")
        self.assertEqual(mime, "application/pdf")
        self.assertIn(b"fake invoice", content)

    def test_tiny_inline_image_skipped(self):
        msg = _build_email(inline_images=[("logo.png", b"x" * 100)])
        attachments = email_ingestion.extract_attachments(msg)
        self.assertEqual([a[0] for a in attachments], ["invoice.pdf"])

    def test_large_inline_image_kept(self):
        msg = _build_email(attachments=(), inline_images=[("scan.png", b"x" * 9000)])
        attachments = email_ingestion.extract_attachments(msg)
        self.assertEqual([a[0] for a in attachments], ["scan.png"])

    def test_message_helpers(self):
        msg = _build_email()
        self.assertEqual(email_ingestion.message_sender(msg), "billing@acme.com")
        self.assertEqual(email_ingestion.message_identifier(msg, 10), "<msg-1@acme.com>")
        self.assertIsNotNone(email_ingestion.message_received_at(msg))

    def test_identifier_falls_back_to_uid(self):
        msg = _build_email(message_id=None)
        self.assertEqual(email_ingestion.message_identifier(msg, 42), "uid:42")


class IngestionTestBase(TestCase):
    def setUp(self):
        self.user = User.objects.create_user(
            email="owner@example.com", password="pass",
            first_name="Mailbox", last_name="Owner",
        )
        self.doc_type = DocumentType.objects.create(
            name="Supplier Invoice", code="INV", reference_prefix="INV",
        )
        self.mailbox = Mailbox.objects.create(
            name="Invoices",
            connection={"host": "mail", "username": "u", "password": "p"},
            default_document_type=self.doc_type,
            sender_supplier_map={"acme.com": "ACME Ltd"},
            created_by=self.user,
        )
        # Stub the async tasks so no broker is needed.
        self._patches = [
            mock.patch("apps.documents.tasks.extract_text"),
            mock.patch("apps.documents.tasks.ocr_document"),
            mock.patch("apps.documents.tasks.generate_document_preview"),
        ]
        self.mock_extract = self._patches[0].start()
        self.mock_ocr = self._patches[1].start()
        self.mock_preview = self._patches[2].start()

    def tearDown(self):
        for p in self._patches:
            p.stop()


class ImportEmailTests(IngestionTestBase):
    def test_single_attachment_creates_draft_in_bulk_upload(self):
        entry = email_ingestion.import_email(self.mailbox, _fetched(_build_email()), user=self.user)

        self.assertEqual(entry["status"], IngestedEmail.Status.IMPORTED)
        self.assertEqual(entry["documents_created"], 1)

        doc = Document.objects.get()
        self.assertEqual(doc.status, DocumentStatus.DRAFT)
        self.assertEqual(doc.document_type, self.doc_type)
        self.assertEqual(doc.supplier, "ACME Ltd")  # sender→supplier prefill
        self.assertEqual(doc.metadata["_email"]["from"], "billing@acme.com")
        self.assertEqual(doc.metadata["_email"]["message_id"], "<msg-1@acme.com>")
        self.assertIsNotNone(doc.bulk_upload)
        # Classified (INV) + scannable (pdf) → OCR/IDP pipeline, not plain extract.
        self.assertTrue(doc.is_scanned)
        self.mock_ocr.delay.assert_called_once()
        self.mock_extract.delay.assert_not_called()

        record = IngestedEmail.objects.get()
        self.assertEqual(record.documents_created, 1)
        self.assertTrue(record.raw_email.name)

    def test_duplicate_message_skipped(self):
        msg = _build_email()
        email_ingestion.import_email(self.mailbox, _fetched(msg), user=self.user)
        entry = email_ingestion.import_email(self.mailbox, _fetched(msg), user=self.user)
        self.assertEqual(entry["status"], "skipped")
        self.assertEqual(Document.objects.count(), 1)
        self.assertEqual(IngestedEmail.objects.count(), 1)

    def test_no_attachments_skipped(self):
        msg = _build_email(attachments=())
        entry = email_ingestion.import_email(self.mailbox, _fetched(msg), user=self.user)
        self.assertEqual(entry["status"], "skipped")
        self.assertEqual(Document.objects.count(), 0)
        self.assertEqual(IngestedEmail.objects.get().status, IngestedEmail.Status.SKIPPED)

    def test_multiple_attachments_form_related_set(self):
        msg = _build_email(attachments=(
            ("invoice.pdf", b"%PDF inv", "application", "pdf"),
            ("po.pdf", b"%PDF po", "application", "pdf"),
        ))
        entry = email_ingestion.import_email(self.mailbox, _fetched(msg), user=self.user)

        self.assertEqual(entry["documents_created"], 2)
        bulk = BulkUpload.objects.get()
        self.assertEqual(bulk.mode, BulkUpload.Mode.RELATED_SET)
        self.assertEqual(DocumentRelationship.objects.count(), 1)
        rel = DocumentRelationship.objects.get()
        self.assertEqual(rel.relation_type, DocumentRelationship.RelationType.LINKED_TO)

    def test_unclassified_when_no_default_type(self):
        self.mailbox.default_document_type = None
        self.mailbox.save(update_fields=["default_document_type"])
        email_ingestion.import_email(self.mailbox, _fetched(_build_email()), user=self.user)
        doc = Document.objects.get()
        self.assertEqual(doc.document_type.code, "UNCLASS")

    def test_unclassified_attachment_is_not_ocrd(self):
        """No document type → nothing for OCR to map to → manual draft."""
        self.mailbox.default_document_type = None
        self.mailbox.save(update_fields=["default_document_type"])
        email_ingestion.import_email(self.mailbox, _fetched(_build_email()), user=self.user)
        doc = Document.objects.get()
        self.assertFalse(doc.is_scanned)
        self.assertEqual(doc.ocr_status, "")
        self.mock_ocr.delay.assert_not_called()
        self.mock_extract.delay.assert_not_called()

    def test_auto_classify_assigns_inferred_type(self):
        po = DocumentType.objects.create(name="Purchase Order", code="PO", reference_prefix="PO")
        self.mailbox.default_document_type = None
        self.mailbox.auto_classify = True
        self.mailbox.save(update_fields=["default_document_type", "auto_classify"])
        with mock.patch("apps.documents.ocr.idp.classify_document_type", return_value=po):
            email_ingestion.import_email(self.mailbox, _fetched(_build_email()), user=self.user)
        doc = Document.objects.get()
        self.assertEqual(doc.document_type.code, "PO")
        self.assertTrue(doc.is_scanned)  # classified + scannable → OCR'd
        self.mock_ocr.delay.assert_called_once()

    def test_office_attachment_is_manual_with_preview(self):
        """A classified but non-scannable docx is filled manually; we still
        render an Office→PDF preview for the reviewer."""
        msg = _build_email(attachments=(
            ("contract.docx", b"PK\x03\x04 fake docx",
             "application", "vnd.openxmlformats-officedocument.wordprocessingml.document"),
        ))
        email_ingestion.import_email(self.mailbox, _fetched(msg), user=self.user)
        doc = Document.objects.get()
        self.assertFalse(doc.is_scanned)
        self.mock_ocr.delay.assert_not_called()
        self.mock_preview.delay.assert_called_once()

    def test_sender_allowlist_blocks_unlisted(self):
        self.mailbox.sender_allowlist = ["trusted.com"]
        self.mailbox.save(update_fields=["sender_allowlist"])
        # Sender billing@acme.com is not on the allowlist → skipped, no docs.
        entry = email_ingestion.import_email(self.mailbox, _fetched(_build_email()), user=self.user)
        self.assertEqual(entry["status"], "skipped")
        self.assertIn("allowlist", entry["detail"].lower())
        self.assertEqual(Document.objects.count(), 0)
        rec = IngestedEmail.objects.get()
        self.assertEqual(rec.status, IngestedEmail.Status.SKIPPED)
        self.assertFalse(rec.raw_email)  # not stored for filtered senders

    def test_sender_allowlist_admits_listed(self):
        self.mailbox.sender_allowlist = ["acme.com"]
        self.mailbox.save(update_fields=["sender_allowlist"])
        entry = email_ingestion.import_email(self.mailbox, _fetched(_build_email()), user=self.user)
        self.assertEqual(entry["status"], IngestedEmail.Status.IMPORTED)
        self.assertEqual(Document.objects.count(), 1)

    def test_supplier_for_sender_domain_and_address(self):
        self.mailbox.sender_supplier_map = {
            "billing@acme.com": "ACME Billing",
            "globex.com": "Globex Inc",
        }
        self.assertEqual(self.mailbox.supplier_for_sender("billing@acme.com"), "ACME Billing")
        self.assertEqual(self.mailbox.supplier_for_sender("ap@globex.com"), "Globex Inc")
        self.assertEqual(self.mailbox.supplier_for_sender("x@unknown.com"), "")


class RunMailboxPollTests(IngestionTestBase):
    def test_poll_imports_and_advances_cursor(self):
        self.mailbox.ingest_history = True  # import on first poll for this test
        self.mailbox.save(update_fields=["ingest_history"])
        messages = [
            _fetched(_build_email(
                message_id="<a@x>",
                attachments=(("a.pdf", b"%PDF a", "application", "pdf"),),
            ), uid=5),
            _fetched(_build_email(
                message_id="<b@x>",
                attachments=(("b.pdf", b"%PDF b", "application", "pdf"),),
            ), uid=7),
        ]
        with mock.patch.object(email_ingestion, "IMAPClient", _FakeIMAPClient(messages)):
            email_ingestion.run_mailbox_poll(str(self.mailbox.id))

        self.mailbox.refresh_from_db()
        self.assertEqual(self.mailbox.poll_status, MailboxPollStatus.OK)
        self.assertEqual(self.mailbox.last_imported_count, 2)
        self.assertEqual(self.mailbox.last_seen_uid, 7)
        self.assertEqual(Document.objects.count(), 2)

    def test_poll_respects_since_uid(self):
        self.mailbox.last_seen_uid = 6
        self.mailbox.save(update_fields=["last_seen_uid"])
        messages = [_fetched(_build_email(message_id="<a@x>"), uid=5),
                    _fetched(_build_email(message_id="<b@x>"), uid=9)]
        with mock.patch.object(email_ingestion, "IMAPClient", _FakeIMAPClient(messages)):
            email_ingestion.run_mailbox_poll(str(self.mailbox.id))

        self.assertEqual(Document.objects.count(), 1)  # only uid 9 > 6
        self.mailbox.refresh_from_db()
        self.assertEqual(self.mailbox.last_seen_uid, 9)

    def test_first_poll_skips_backlog_by_default(self):
        # ingest_history defaults False → first poll fast-forwards the cursor to
        # the high UID and imports nothing.
        messages = [_fetched(_build_email(message_id="<a@x>"), uid=5),
                    _fetched(_build_email(message_id="<b@x>"), uid=7)]
        with mock.patch.object(email_ingestion, "IMAPClient", _FakeIMAPClient(messages)):
            email_ingestion.run_mailbox_poll(str(self.mailbox.id))
        self.mailbox.refresh_from_db()
        self.assertEqual(self.mailbox.last_seen_uid, 7)
        self.assertEqual(self.mailbox.last_imported_count, 0)
        self.assertEqual(Document.objects.count(), 0)

    def test_first_poll_imports_backlog_when_enabled(self):
        self.mailbox.ingest_history = True
        self.mailbox.save(update_fields=["ingest_history"])
        messages = [
            _fetched(_build_email(message_id="<a@x>",
                                  attachments=(("a.pdf", b"%PDF a", "application", "pdf"),)), uid=5),
            _fetched(_build_email(message_id="<b@x>",
                                  attachments=(("b.pdf", b"%PDF b", "application", "pdf"),)), uid=7),
        ]
        with mock.patch.object(email_ingestion, "IMAPClient", _FakeIMAPClient(messages)):
            email_ingestion.run_mailbox_poll(str(self.mailbox.id))
        self.assertEqual(Document.objects.count(), 2)
        self.mailbox.refresh_from_db()
        self.assertEqual(self.mailbox.last_seen_uid, 7)

    def _make_graph_mailbox(self, ingest_history=True):
        self.mailbox.protocol = "graph"
        self.mailbox.ingest_history = ingest_history
        self.mailbox.connection = {
            "tenant_id": "t", "client_id": "c", "client_secret": "s", "mailbox": "x@y.com",
        }
        self.mailbox.save()

    def test_graph_poll_imports_and_sets_cursor(self):
        import email as _email
        from apps.documents.graph_client import GraphMessage

        self._make_graph_mailbox()
        raw = _build_email(
            message_id="<g1@x>",
            attachments=(("g.pdf", b"%PDF g", "application", "pdf"),),
        ).as_bytes()
        gm = GraphMessage(uid=0, raw=raw, message=_email.message_from_bytes(raw),
                          received_at="2026-06-27T10:00:00Z", graph_id="ABC")

        class FakeGraph:
            def __init__(self, *a, **k): pass
            def __enter__(self): return self
            def __exit__(self, *a): return False
            def highest_received(self): return "2026-06-27T09:00:00Z"
            def iter_messages(self, *, since_datetime=None):
                yield gm

        with mock.patch("apps.documents.graph_client.GraphClient", FakeGraph):
            email_ingestion.run_mailbox_poll(str(self.mailbox.id))

        self.assertEqual(Document.objects.count(), 1)
        self.mailbox.refresh_from_db()
        self.assertEqual(self.mailbox.poll_status, MailboxPollStatus.OK)
        self.assertEqual(self.mailbox.last_seen_cursor, "2026-06-27T10:00:00Z")
        self.assertEqual(Document.objects.get().metadata["_email"]["source"], "graph")

    def test_graph_first_poll_skips_backlog_by_default(self):
        self._make_graph_mailbox(ingest_history=False)

        class FakeGraph:
            def __init__(self, *a, **k): pass
            def __enter__(self): return self
            def __exit__(self, *a): return False
            def highest_received(self): return "2026-06-27T09:00:00Z"
            def iter_messages(self, *, since_datetime=None):
                raise AssertionError("should not iterate on backlog-skip")

        with mock.patch("apps.documents.graph_client.GraphClient", FakeGraph):
            email_ingestion.run_mailbox_poll(str(self.mailbox.id))

        self.assertEqual(Document.objects.count(), 0)
        self.mailbox.refresh_from_db()
        self.assertEqual(self.mailbox.last_seen_cursor, "2026-06-27T09:00:00Z")

    def test_poll_records_error(self):
        from apps.documents.imap_client import IMAPError

        self.mailbox.ingest_history = True  # reach iter_messages (where the error is raised)
        self.mailbox.save(update_fields=["ingest_history"])
        fake = _FakeIMAPClient([], raise_on_iter=IMAPError("login failed"))
        with mock.patch.object(email_ingestion, "IMAPClient", fake):
            email_ingestion.run_mailbox_poll(str(self.mailbox.id))

        self.mailbox.refresh_from_db()
        self.assertEqual(self.mailbox.poll_status, MailboxPollStatus.ERROR)
        self.assertIn("login failed", self.mailbox.last_error)
