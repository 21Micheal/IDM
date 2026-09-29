from django.core.files.uploadedfile import SimpleUploadedFile
from django.test import TestCase

from apps.accounts.models import User
from apps.documents.builder_workflow import (
    builder_process_step,
    can_submit_request_workflow,
    can_submit_retirement_workflow,
    can_start_procurement_workflow_stage,
    completed_procurement_stages,
    infer_builder_workflow_phase,
    is_procurement_document,
    record_procurement_stage_completion,
)
from apps.documents.models import Document, DocumentStatus, DocumentType
from apps.workflows.models import WorkflowInstance, WorkflowRule, WorkflowTemplate


def _make_document(**kwargs):
    defaults = {
        "file": SimpleUploadedFile("test.pdf", b"pdf", content_type="application/pdf"),
        "file_name": "test.pdf",
        "file_size": 3,
    }
    defaults.update(kwargs)
    return Document.objects.create(**defaults)


class BuilderWorkflowPhaseTests(TestCase):
    def setUp(self):
        self.doc_type = DocumentType.objects.create(
            name="Imprest",
            code="IMP",
            reference_prefix="IMP",
        )
        self.user = User.objects.create_user(
            email="u@example.com",
            password="pass",
            first_name="Test",
            last_name="User",
        )
        self.document = _make_document(
            title="Imprest claim",
            reference_number="IMP-00001",
            document_type=self.doc_type,
            uploaded_by=self.user,
            status=DocumentStatus.APPROVED,
            metadata={
                "form": {
                    "sections": [{"id": "s1", "fields": [{"key": "amount", "type": "currency"}]}],
                    "values": {},
                }
            },
        )

    def test_infer_request_phase_before_stage_one_posting(self):
        self.assertEqual(infer_builder_workflow_phase(self.document), "request")

    def test_can_submit_retirement_when_stage_one_posted(self):
        from apps.sunsystems.models import JournalPosting, JournalPostingStatus

        JournalPosting.objects.create(
            document=self.document,
            stage=1,
            stage_label="Advance",
            status=JournalPostingStatus.POSTED,
        )
        template = WorkflowTemplate.objects.create(
            name="Configured retirement approval",
            document_type=self.doc_type,
            created_by=self.user,
        )
        WorkflowRule.objects.create(
            document_type=self.doc_type,
            template=template,
            phase="retirement",
        )
        self.document.metadata["form"]["workflow_phase"] = "retirement"
        self.assertTrue(can_submit_retirement_workflow(self.document, user=self.user))

    def test_cannot_submit_request_when_in_retirement_phase(self):
        self.document.metadata["form"]["workflow_phase"] = "retirement"
        self.document.status = DocumentStatus.DRAFT
        self.document.save(update_fields=["metadata", "status", "updated_at"])
        self.assertFalse(can_submit_request_workflow(self.document, user=self.user))

    def test_can_resubmit_returned_retirement_document(self):
        self.document.metadata["form"]["workflow_phase"] = "retirement"
        self.document.status = DocumentStatus.RETURNED
        self.document.save(update_fields=["metadata", "status", "updated_at"])
        self.assertTrue(can_submit_request_workflow(self.document, user=self.user))

    def test_process_step_distinguishes_request_approved_from_fully_approved(self):
        self.document.metadata["form"]["workflow_phase"] = "retirement"
        self.document.save(update_fields=["metadata", "updated_at"])
        self.assertEqual(builder_process_step(self.document), "request_approved")

        template = WorkflowTemplate.objects.create(
            name="Retirement approval",
            document_type=self.doc_type,
            created_by=self.user,
        )
        rule = WorkflowRule.objects.create(
            document_type=self.doc_type,
            template=template,
            phase="retirement",
        )
        WorkflowInstance.objects.create(
            document=self.document,
            template=template,
            rule=rule,
            started_by=self.user,
            status="approved",
        )

        self.assertEqual(builder_process_step(self.document), "fully_approved")


class ProcurementWorkflowStageTests(TestCase):
    def setUp(self):
        self.doc_type = DocumentType.objects.create(
            name="Purchase Requisition",
            code="REQ",
            reference_prefix="REQ",
        )
        self.user = User.objects.create_user(
            email="procurement@example.com",
            password="pass",
        )
        self.document = _make_document(
            title="Office supplies",
            reference_number="REQ-00001",
            document_type=self.doc_type,
            uploaded_by=self.user,
            status=DocumentStatus.DRAFT,
            metadata={
                "form": {
                    "sections": [{"id": "s1", "fields": []}],
                    "values": {},
                }
            },
        )

    def test_procurement_stages_must_run_in_order(self):
        self.assertEqual(infer_builder_workflow_phase(self.document), "requisition")
        self.assertTrue(can_start_procurement_workflow_stage(self.document, "requisition"))
        self.assertFalse(can_start_procurement_workflow_stage(self.document, "rfq"))

        self.document.status = DocumentStatus.APPROVED
        self.document.metadata["form"]["workflow_phase"] = "requisition"
        self.assertTrue(record_procurement_stage_completion(self.document, "approved"))
        self.document.save(update_fields=["metadata", "status", "updated_at"])

        self.assertEqual(completed_procurement_stages(self.document), ["requisition"])
        self.assertTrue(can_start_procurement_workflow_stage(self.document, "rfq"))
        self.assertFalse(can_start_procurement_workflow_stage(self.document, "lpo"))


class ProcurementWorkflowTypeTests(TestCase):
    def test_explicit_template_workflow_type_overrides_document_type_name(self):
        document_type = DocumentType.objects.create(
            name="General procurement form",
            code="GENPROC",
            reference_prefix="GEN",
        )
        user = User.objects.create_user(email="marker@example.com", password="pass")
        document = _make_document(
            title="Configured requisition",
            reference_number="GEN-00001",
            document_type=document_type,
            uploaded_by=user,
            metadata={
                "form": {
                    "workflow_type": "requisition",
                    "sections": [{"id": "s1", "fields": []}],
                    "values": {},
                }
            },
        )

        self.assertTrue(is_procurement_document(document))


class ProcurementProcessStepTests(TestCase):
    def setUp(self):
        self.doc_type = DocumentType.objects.create(
            name="Purchase Requisition",
            code="REQSTEPS",
            reference_prefix="REQ",
        )
        self.user = User.objects.create_user(
            email="stages@example.com",
            password="pass",
        )
        self.document = _make_document(
            title="Procurement stages",
            reference_number="REQ-00002",
            document_type=self.doc_type,
            uploaded_by=self.user,
            status=DocumentStatus.APPROVED,
            metadata={
                "form": {
                    "sections": [{"id": "s1", "fields": []}],
                    "values": {},
                    "workflow_phase": "requisition",
                    "completed_workflow_stages": ["requisition"],
                }
            },
        )

    def test_procurement_process_steps_follow_approved_stage(self):
        self.assertEqual(builder_process_step(self.document), "requisition_approved")

        self.document.metadata["form"]["workflow_phase"] = "rfq"
        self.document.metadata["form"]["completed_workflow_stages"].append("rfq")
        self.document.save(update_fields=["metadata", "updated_at"])
        self.assertEqual(builder_process_step(self.document), "rfq_approved")

        self.document.metadata["form"]["workflow_phase"] = "lpo"
        self.document.metadata["form"]["completed_workflow_stages"].append("lpo")
        self.document.save(update_fields=["metadata", "updated_at"])
        self.assertEqual(builder_process_step(self.document), "fully_approved")
