from django.core.files.uploadedfile import SimpleUploadedFile
from django.test import TestCase
from rest_framework.test import APIClient

from apps.accounts.models import (
    AccessStage,
    GroupAction,
    GroupPermission,
    User,
    UserGroup,
    UserGroupMembership,
)
from apps.documents.access import (
    ACCESS_STAGE_APPROVAL,
    ACCESS_STAGE_CREATION,
    ACCESS_STAGE_AFTER_APPROVAL,
    document_allows_edit,
    resolve_access_stage,
)
from apps.documents.models import Document, DocumentStatus, DocumentType
from apps.workflows.models import WorkflowInstance, WorkflowTemplate


def _make_document(**kwargs):
    defaults = {
        "file": SimpleUploadedFile("test.pdf", b"pdf", content_type="application/pdf"),
        "file_name": "test.pdf",
        "file_size": 3,
    }
    defaults.update(kwargs)
    return Document.objects.create(**defaults)


class AccessStageResolutionTests(TestCase):
    def setUp(self):
        self.doc_type = DocumentType.objects.create(
            name="Invoice",
            code="INV",
            reference_prefix="INV",
        )
        self.user = User.objects.create_user(
            email="u@example.com",
            password="pass",
            first_name="Test",
            last_name="User",
        )
        self.document = _make_document(
            title="Test",
            reference_number="INV-00001",
            document_type=self.doc_type,
            uploaded_by=self.user,
            status=DocumentStatus.DRAFT,
        )

    def test_draft_resolves_to_creation(self):
        self.assertEqual(resolve_access_stage(self.document), ACCESS_STAGE_CREATION)

    def test_pending_approval_resolves_to_approval(self):
        self.document.status = DocumentStatus.PENDING_APPROVAL
        self.document.save(update_fields=["status"])
        self.assertEqual(resolve_access_stage(self.document), ACCESS_STAGE_APPROVAL)

    def test_active_workflow_forces_approval_stage(self):
        template = WorkflowTemplate.objects.create(
            name="T1",
            document_type=self.doc_type,
            created_by=self.user,
        )
        WorkflowInstance.objects.create(
            document=self.document,
            template=template,
            status="in_progress",
            started_by=self.user,
        )
        self.document.status = "Pending CFO Approval"
        self.document.save(update_fields=["status"])
        self.assertEqual(resolve_access_stage(self.document), ACCESS_STAGE_APPROVAL)

    def test_approved_resolves_to_after_approval(self):
        self.document.status = DocumentStatus.APPROVED
        self.document.save(update_fields=["status"])
        self.assertEqual(resolve_access_stage(self.document), ACCESS_STAGE_AFTER_APPROVAL)


class StagedPermissionTests(TestCase):
    def setUp(self):
        self.doc_type = DocumentType.objects.create(
            name="PO",
            code="PO",
            reference_prefix="PO",
        )
        self.user = User.objects.create_user(
            email="perm@example.com",
            password="pass",
            first_name="Perm",
            last_name="User",
        )
        self.group = UserGroup.objects.create(name="Finance")
        UserGroupMembership.objects.create(user=self.user, group=self.group)
        GroupPermission.objects.create(
            group=self.group,
            document_type=self.doc_type,
            stage=ACCESS_STAGE_CREATION,
            action=GroupAction.EDIT.value,
        )
        self.document = _make_document(
            title="PO Doc",
            reference_number="PO-00001",
            document_type=self.doc_type,
            uploaded_by=self.user,
            status=DocumentStatus.PENDING_APPROVAL,
        )

    def test_edit_only_in_creation_stage(self):
        perms = self.user.get_all_permissions_for_doctype(
            str(self.doc_type.id),
            document=self.document,
        )
        self.assertNotIn(GroupAction.EDIT.value, perms)

    def test_edit_with_any_stage(self):
        GroupPermission.objects.create(
            group=self.group,
            document_type=self.doc_type,
            stage=AccessStage.ANY.value,
            action=GroupAction.EDIT.value,
        )
        perms = self.user.get_all_permissions_for_doctype(
            str(self.doc_type.id),
            document=self.document,
        )
        self.assertIn(GroupAction.EDIT.value, perms)


class DocumentEditPolicyTests(TestCase):
    def setUp(self):
        self.doc_type = DocumentType.objects.create(
            name="Supplier Invoice",
            code="SI",
            reference_prefix="SI",
            access_policy={
                "on_approved": {"set_status": "approved", "allow_edit": False},
                "on_rejected": {"set_status": "rejected", "allow_edit": True},
            },
        )
        self.user = User.objects.create_user(
            email="si@example.com",
            password="pass",
            first_name="SI",
            last_name="User",
        )
        self.document = _make_document(
            title="Invoice",
            reference_number="SI-00001",
            document_type=self.doc_type,
            uploaded_by=self.user,
            status=DocumentStatus.APPROVED,
        )

    def test_approved_not_editable_by_policy(self):
        self.assertFalse(document_allows_edit(self.document))

    def test_rejected_editable_by_policy(self):
        self.document.status = DocumentStatus.REJECTED
        self.document.save(update_fields=["status"])
        self.assertTrue(document_allows_edit(self.document))

    def test_admin_bypasses_edit_policy(self):
        admin = User.objects.create_superuser(
            email="admin@example.com",
            password="pass",
            first_name="Admin",
            last_name="User",
        )
        self.assertTrue(document_allows_edit(self.document, user=admin))


class DocumentAllowsFormEditTests(TestCase):
    def setUp(self):
        self.doc_type = DocumentType.objects.create(
            name="Imprest",
            code="IMP",
            reference_prefix="IMP",
        )
        self.user = User.objects.create_user(
            email="finance@example.com",
            password="pass",
            first_name="Finance",
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
                    "sections": [
                        {
                            "id": "retirement",
                            "title": "Retirement",
                            "editableWhen": {
                                "combinator": "and",
                                "conditions": [
                                    {
                                        "source": "process_step",
                                        "operator": "equals",
                                        "value": DocumentStatus.APPROVED,
                                    }
                                ],
                            },
                            "fields": [{"key": "amount_retired", "type": "currency", "label": "Retired"}],
                        }
                    ],
                    "values": {},
                }
            },
        )

    def test_approved_form_with_editable_section_allows_form_edit(self):
        from apps.documents.access import document_allows_form_edit

        self.assertTrue(document_allows_form_edit(self.document, user=self.user))

    def test_approved_form_without_editable_section_blocks_form_edit(self):
        from apps.documents.access import document_allows_form_edit

        self.document.metadata = {
            "form": {
                "sections": [
                    {
                        "id": "locked",
                        "title": "Locked",
                        "readonly": True,
                        "fields": [{"key": "x", "type": "text", "label": "X"}],
                    }
                ],
                "values": {},
            }
        }
        self.assertFalse(document_allows_form_edit(self.document, user=self.user))


class DocumentTypeAdminGroupPermissionTests(TestCase):
    def setUp(self):
        self.client = APIClient()
        self.user = User.objects.create_user(
            email="group-admin@example.com",
            password="pass",
            first_name="Group",
            last_name="Admin",
        )
        admins_group = UserGroup.ensure_administrators_group(created_by=self.user)
        UserGroupMembership.objects.create(user=self.user, group=admins_group)
        self.client.force_authenticate(user=self.user)
        self.doc_type = DocumentType.objects.create(
            name="Base Type",
            code="BASETYPE",
            reference_prefix="BST",
            created_by=self.user,
        )

    def test_admin_group_member_can_create_document_type(self):
        response = self.client.post(
            "/api/v1/document-types/",
            {
                "name": "Operations Memo",
                "code": "OPMEMO",
                "reference_prefix": "OPM",
            },
            format="json",
        )

        self.assertEqual(response.status_code, 201)
        self.assertEqual(response.data["name"], "Operations Memo")
        self.assertEqual(response.data["code"], "OPMEMO")

    def test_admin_group_member_can_update_document_type(self):
        response = self.client.patch(
            f"/api/v1/document-types/{self.doc_type.id}/",
            {"description": "Updated by group admin"},
            format="json",
        )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.data["description"], "Updated by group admin")

    def test_admin_group_member_can_duplicate_document_type(self):
        response = self.client.post(
            f"/api/v1/document-types/{self.doc_type.id}/duplicate/",
            {"name": "Base Type Copy", "code": "BASETYPECPY"},
            format="json",
        )

        self.assertEqual(response.status_code, 201)
        self.assertEqual(response.data["name"], "Base Type Copy")
        self.assertEqual(response.data["code"], "BASETYPECPY")

    def test_admin_group_member_can_delete_document_type(self):
        response = self.client.delete(f"/api/v1/document-types/{self.doc_type.id}/")
        self.assertEqual(response.status_code, 204)
        self.doc_type.refresh_from_db()
        self.assertFalse(self.doc_type.is_active)


class DocumentTypeRegularUserPermissionTests(TestCase):
    def setUp(self):
        self.client = APIClient()
        self.user = User.objects.create_user(
            email="regular-user@example.com",
            password="pass",
            first_name="Regular",
            last_name="User",
        )
        self.doc_type = DocumentType.objects.create(
            name="Restricted Type",
            code="RSTRTYPE",
            reference_prefix="RST",
            created_by=self.user,
        )
        self.client.force_authenticate(user=self.user)

    def test_regular_user_cannot_create_document_type(self):
        response = self.client.post(
            "/api/v1/document-types/",
            {
                "name": "Unauthorized Create",
                "code": "UNAUTHCRT",
                "reference_prefix": "UCR",
            },
            format="json",
        )
        self.assertEqual(response.status_code, 403)

    def test_regular_user_cannot_update_document_type(self):
        response = self.client.patch(
            f"/api/v1/document-types/{self.doc_type.id}/",
            {"description": "No access"},
            format="json",
        )
        self.assertEqual(response.status_code, 403)

    def test_regular_user_cannot_duplicate_document_type(self):
        response = self.client.post(
            f"/api/v1/document-types/{self.doc_type.id}/duplicate/",
            {"name": "Unauthorized Copy", "code": "UNAUTHCPY"},
            format="json",
        )
        self.assertEqual(response.status_code, 403)

    def test_regular_user_cannot_delete_document_type(self):
        response = self.client.delete(f"/api/v1/document-types/{self.doc_type.id}/")
        self.assertEqual(response.status_code, 403)
