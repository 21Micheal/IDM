from django.core.files.uploadedfile import SimpleUploadedFile
from django.test import SimpleTestCase, TestCase

from apps.accounts.models import User
from apps.documents.models import Document, DocumentStatus, DocumentType
from apps.sunsystems.config import get_journal_mapping
from apps.sunsystems.models import JournalPosting, JournalPostingStatus
from apps.workflows.services import WorkflowService


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
