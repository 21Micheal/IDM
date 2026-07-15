<<<<<<< HEAD
from unittest.mock import patch

from django.test import SimpleTestCase

from apps.sunsystems.client import SunSystemsConfig, _build_zeep_clients, _normalize_base_url
=======
from django.core.files.uploadedfile import SimpleUploadedFile
from django.test import SimpleTestCase, TestCase

from apps.accounts.models import User
from apps.documents.models import Document, DocumentStatus, DocumentType
>>>>>>> temp-branch
from apps.sunsystems.config import get_journal_mapping
from apps.sunsystems.models import JournalPosting, JournalPostingStatus
from apps.workflows.services import WorkflowService


class SunSystemsClientTests(SimpleTestCase):
    def test_normalize_base_url_strips_endpoint_suffixes(self):
        self.assertEqual(
            _normalize_base_url("http://sunsrv02.flaxem.int:81/sunsystems-connect/SecurityProvider?wsdl"),
            "http://sunsrv02.flaxem.int:81/sunsystems-connect",
        )

    def test_build_zeep_clients_disables_proxy_env(self):
        class DummySession:
            def __init__(self):
                self.trust_env = True
                self.auth = None
                self.verify = True

        session = DummySession()
        with patch("apps.sunsystems.client.requests.Session", side_effect=lambda: session), patch(
            "apps.sunsystems.client.ZeepClient"
        ), patch("apps.sunsystems.client.Transport"):
            cfg = SunSystemsConfig.from_mapping(
                {
                    "base_url": "http://sunsrv02.flaxem.int:81/sunsystems-connect/wsdl",
                    "username": "demo",
                    "password": "secret",
                }
            )
            _build_zeep_clients(cfg)

        self.assertFalse(session.trust_env)


class JournalConfigTests(SimpleTestCase):
    def test_get_journal_mapping_inherits_parent_enabled(self):
        document = type(
            "Document",
            (),
            {
                "metadata": {
                    "sunsystems": {
                        "journal": {
                            "enabled": True,
                            "stages": [
                                {
                                    "stage": 1,
                                    "label": "Advance",
                                    "lines": [{"amount": 100, "dc": "D"}],
                                }
                            ],
                        }
                    }
                }
            },
        )()

        mapping = get_journal_mapping(document)

        self.assertIsNotNone(mapping)
        self.assertTrue(mapping.get("enabled"))
        self.assertEqual(mapping.get("stage"), 1)
        self.assertEqual(mapping.get("label"), "Advance")

    def test_get_journal_mapping_preserves_explicit_stage_enabled(self):
        document = type(
            "Document",
            (),
            {
                "metadata": {
                    "sunsystems": {
                        "journal": {
                            "enabled": True,
                            "stages": [
                                {
                                    "stage": 1,
                                    "enabled": False,
                                    "label": "Advance",
                                    "lines": [{"amount": 100, "dc": "D"}],
                                }
                            ],
                        }
                    }
                }
            },
        )()

        mapping = get_journal_mapping(document)

        self.assertIsNotNone(mapping)
        self.assertFalse(mapping.get("enabled"))
        self.assertEqual(mapping.get("stage"), 1)


class JournalPostingQueueTests(TestCase):
    def test_workflow_hook_creates_pending_posting_before_celery_runs(self):
        doc_type = DocumentType.objects.create(
            name="Imprest",
            code="IMP",
            reference_prefix="IMP",
        )
        user = User.objects.create_user(
            email="u@example.com",
            password="pass",
            first_name="Test",
            last_name="User",
        )
        document = Document.objects.create(
            title="Imprest",
            reference_number="IMP-00001",
            document_type=doc_type,
            uploaded_by=user,
            status=DocumentStatus.APPROVED,
            file=SimpleUploadedFile("test.pdf", b"pdf", content_type="application/pdf"),
            file_name="test.pdf",
            file_size=3,
            metadata={
                "form": {"sections": [], "values": {}},
                "sunsystems": {
                    "journal": {
                        "enabled": True,
                        "stages": [
                            {
                                "stage": 1,
                                "label": "Advance",
                                "post_on": "approved",
                                "lines": [{"amount": 100, "dc": "D"}],
                            }
                        ],
                    }
                },
            },
        )

        WorkflowService._maybe_post_sunsystems_journal(document, "approved")

        posting = JournalPosting.objects.get(document=document, stage=1)
        self.assertEqual(posting.status, JournalPostingStatus.PENDING)
        self.assertEqual(posting.stage_label, "Advance")
        self.assertEqual(posting.message, "Queued for SunSystems posting.")
