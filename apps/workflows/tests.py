"""V2 workflow routing tests.

Covers ``resolve_active_path`` — the helper that makes the flat ``WorkflowStep``
mirror phase/stage aware.  Before it existed the runtime always started at
mirror order 1, so an imported requisition workflow (whose switch cases are
flattened lpo, rfq, requisition) jumped straight into the LPO approval.
"""
from django.core.files.uploadedfile import SimpleUploadedFile
from django.test import TestCase

from apps.accounts.models import User, UserGroup, UserGroupMembership
from apps.documents.models import Document, DocumentStatus, DocumentType
from apps.workflows.engine import flatten_steps, resolve_active_path
from apps.workflows.models import WorkflowInstance, WorkflowStep, WorkflowTemplate
from apps.workflows.services import WorkflowService


def _step(name, step_type="approval"):
    return {
        "name": name,
        "order": 0,
        "sla_hours": 48,
        "step_type": step_type,
        "status_label": f"Pending {name}",
    }


def _procurement_definition():
    """Mirror of the imported Requisition Form Workflow: cases flattened as
    lpo (1), rfq (2-3), requisition (4-6), default rejected."""
    return {
        "version": 2,
        "blocks": [
            {
                "id": "switch_phase",
                "kind": "switch",
                "field_id": "context.phase",
                "cases": [
                    {
                        "id": "case_lpo",
                        "label": "lpo",
                        "values": ["lpo"],
                        "blocks": [{"id": "b_lpo", "kind": "approval", "step": _step("Procurement Approval")}],
                    },
                    {
                        "id": "case_rfq",
                        "label": "rfq",
                        "values": ["rfq"],
                        "blocks": [
                            {"id": "b_rfq", "kind": "approval", "step": _step("Finance Approval")},
                            {"id": "b_rfq_n", "kind": "notification", "step": _step("Send Notification", "notification")},
                        ],
                    },
                    {
                        "id": "case_req",
                        "label": "requisition",
                        "values": ["requisition"],
                        "blocks": [
                            {"id": "b_req1", "kind": "approval", "step": _step("Manager Approval")},
                            {"id": "b_req2", "kind": "approval", "step": _step("Finance Review")},
                            {"id": "b_req3", "kind": "approval", "step": _step("Booking Officer Review")},
                        ],
                    },
                ],
                "default_blocks": [{"id": "b_end", "kind": "end", "outcome": "rejected"}],
            }
        ],
    }


class ResolveActivePathTests(TestCase):
    def setUp(self):
        self.definition = _procurement_definition()

    def test_flatten_keeps_all_cases_in_document_order(self):
        names = [s["name"] for s in flatten_steps(self.definition)]
        self.assertEqual(
            names,
            [
                "Procurement Approval",
                "Finance Approval",
                "Send Notification",
                "Manager Approval",
                "Finance Review",
                "Booking Officer Review",
            ],
        )

    def test_requisition_phase_selects_requisition_steps(self):
        orders, outcome = resolve_active_path(self.definition, {}, {"context.phase": "requisition"})
        self.assertEqual(orders, [4, 5, 6])
        self.assertIsNone(outcome)

    def test_rfq_phase_selects_rfq_steps(self):
        orders, _ = resolve_active_path(self.definition, {}, {"context.phase": "rfq"})
        self.assertEqual(orders, [2, 3])

    def test_lpo_phase_selects_lpo_step(self):
        orders, _ = resolve_active_path(self.definition, {}, {"context.phase": "lpo"})
        self.assertEqual(orders, [1])

    def test_unknown_phase_falls_back_to_default_end(self):
        orders, outcome = resolve_active_path(self.definition, {}, {"context.phase": "bogus"})
        self.assertEqual(orders, [])
        self.assertEqual(outcome, "rejected")

    def test_missing_phase_falls_back_to_default_end(self):
        orders, outcome = resolve_active_path(self.definition, {}, {})
        self.assertEqual(orders, [])
        self.assertEqual(outcome, "rejected")


class V2ActivationTests(TestCase):
    """The runtime must start at the active case, not mirror order 1."""

    def setUp(self):
        self.doc_type = DocumentType.objects.create(
            name="Purchase Requisition", code="REQWF", reference_prefix="REQ"
        )
        self.user = User.objects.create_user(email="wf@example.com", password="pass")
        self.group = UserGroup.objects.create(name="Approvers", created_by=self.user)
        UserGroupMembership.objects.create(user=self.user, group=self.group)
        self.template = WorkflowTemplate.objects.create(
            name="Requisition Form Workflow Test",
            document_type=self.doc_type,
            target_type="document",
            definition=_procurement_definition(),
            created_by=self.user,
        )
        # Flat mirror rows in document order — exactly what _upsert_steps writes.
        for order, step in enumerate(flatten_steps(self.template.definition), start=1):
            step = {key: value for key, value in step.items() if key != "order"}
            WorkflowStep.objects.create(
                template=self.template,
                order=order,
                assignee_type="group_any",
                assignee_group=self.group,
                **step,
            )
        self.document = Document.objects.create(
            file=SimpleUploadedFile("req.pdf", b"pdf", content_type="application/pdf"),
            file_name="req.pdf",
            file_size=3,
            title="Requisition",
            reference_number="REQ-00099",
            document_type=self.doc_type,
            uploaded_by=self.user,
            status=DocumentStatus.DRAFT,
            metadata={
                "form": {
                    "workflow_type": "requisition",
                    "workflow_phase": "requisition",
                    "values": {},
                    "sections": [{"id": "s1", "fields": []}],
                }
            },
        )

    def _instance(self):
        return WorkflowInstance.objects.create(
            document=self.document,
            target_type="document",
            template=self.template,
            started_by=self.user,
            status="in_progress",
            current_step_order=1,
        )

    def test_fresh_requisition_activates_manager_approval_not_lpo(self):
        instance = self._instance()
        WorkflowService._activate_v2_step(instance)
        instance.refresh_from_db()
        self.assertEqual(instance.current_step_order, 4)
        active = instance.tasks.filter(status="in_progress").first()
        self.assertEqual(active.step.order, 4)
        self.assertEqual(active.step.name, "Manager Approval")

    def test_rfq_phase_activates_finance_approval(self):
        self.document.metadata["form"]["workflow_phase"] = "rfq"
        self.document.save(update_fields=["metadata", "updated_at"])
        instance = self._instance()
        WorkflowService._activate_v2_step(instance)
        instance.refresh_from_db()
        self.assertEqual(instance.current_step_order, 2)
        active = instance.tasks.filter(status="in_progress").first()
        self.assertEqual(active.step.name, "Finance Approval")

    def test_lpo_phase_activates_procurement_approval(self):
        self.document.metadata["form"]["workflow_phase"] = "lpo"
        self.document.save(update_fields=["metadata", "updated_at"])
        instance = self._instance()
        WorkflowService._activate_v2_step(instance)
        instance.refresh_from_db()
        self.assertEqual(instance.current_step_order, 1)
        active = instance.tasks.filter(status="in_progress").first()
        self.assertEqual(active.step.name, "Procurement Approval")

    def test_advance_walks_within_active_case(self):
        # Approving Manager Approval (order 4) advances to Finance Review (5),
        # never to the flattened next row (order 2 = Finance Approval).
        instance = self._instance()
        WorkflowService._activate_v2_step(instance)
        task = instance.tasks.filter(status="in_progress").first()
        WorkflowService.approve(task, self.user)
        instance.refresh_from_db()
        self.assertEqual(instance.current_step_order, 5)
        active = instance.tasks.filter(status="in_progress").first()
        self.assertEqual(active.step.name, "Finance Review")

    def test_finishing_last_active_step_completes_instance(self):
        instance = self._instance()
        instance.current_step_order = 6
        instance.save(update_fields=["current_step_order"])
        task = instance.tasks.create(step=self.template.steps.get(order=6), status="in_progress")
        WorkflowService.approve(task, self.user)
        instance.refresh_from_db()
        self.assertEqual(instance.status, "approved")
        self.document.refresh_from_db()
        self.assertEqual(self.document.status, DocumentStatus.APPROVED)
        self.assertEqual(
            self.document.metadata["form"]["completed_workflow_stages"], ["requisition"]
        )
