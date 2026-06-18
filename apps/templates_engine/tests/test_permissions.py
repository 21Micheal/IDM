from django.test import TestCase
from rest_framework.test import APIClient

from apps.accounts.models import User, UserGroup, UserGroupMembership
from apps.documents.models import DocumentType
from apps.templates_engine.models import DocumentTemplate


class TemplateAdminGroupPermissionTests(TestCase):
    def setUp(self):
        self.client = APIClient()
        self.user = User.objects.create_user(
            email="template-admin@example.com",
            password="pass",
            first_name="Template",
            last_name="Admin",
        )
        admins_group = UserGroup.ensure_administrators_group(created_by=self.user)
        UserGroupMembership.objects.create(user=self.user, group=admins_group)
        self.doc_type = DocumentType.objects.create(
            name="Template Target",
            code="TMPLTARGET",
            reference_prefix="TMP",
            created_by=self.user,
        )
        self.template = DocumentTemplate.objects.create(
            name="Admin Template",
            type="uploaded",
            category="operations",
            document_type=self.doc_type,
            created_by=self.user,
        )
        self.client.force_authenticate(user=self.user)

    def test_admin_group_member_can_create_uploaded_template(self):
        response = self.client.post(
            "/api/v1/templates/",
            {
                "name": "Uploaded Ops Template",
                "type": "uploaded",
                "category": "operations",
                "document_type": str(self.doc_type.id),
            },
            format="json",
        )
        self.assertEqual(response.status_code, 201)
        self.assertEqual(response.data["name"], "Uploaded Ops Template")

    def test_admin_group_member_can_update_template(self):
        response = self.client.patch(
            f"/api/v1/templates/{self.template.id}/",
            {"description": "Updated by admin group"},
            format="json",
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.data["description"], "Updated by admin group")

    def test_admin_group_member_can_duplicate_template(self):
        response = self.client.post(
            f"/api/v1/templates/{self.template.id}/duplicate/",
            {},
            format="json",
        )
        self.assertEqual(response.status_code, 201)
        self.assertIn("(Copy)", response.data["name"])

    def test_admin_group_member_can_delete_template(self):
        response = self.client.delete(f"/api/v1/templates/{self.template.id}/")
        self.assertEqual(response.status_code, 204)
        self.template.refresh_from_db()
        self.assertFalse(self.template.is_active)


class TemplateRegularUserPermissionTests(TestCase):
    def setUp(self):
        self.client = APIClient()
        self.user = User.objects.create_user(
            email="template-regular@example.com",
            password="pass",
            first_name="Template",
            last_name="Regular",
        )
        self.doc_type = DocumentType.objects.create(
            name="Regular Target",
            code="REGTARGET",
            reference_prefix="REG",
            created_by=self.user,
        )
        self.template = DocumentTemplate.objects.create(
            name="Regular User Template",
            type="uploaded",
            category="operations",
            document_type=self.doc_type,
            created_by=self.user,
        )
        self.client.force_authenticate(user=self.user)

    def test_regular_user_cannot_create_template(self):
        response = self.client.post(
            "/api/v1/templates/",
            {
                "name": "Blocked Template",
                "type": "uploaded",
                "category": "operations",
                "document_type": str(self.doc_type.id),
            },
            format="json",
        )
        self.assertEqual(response.status_code, 403)

    def test_regular_user_cannot_update_template(self):
        response = self.client.patch(
            f"/api/v1/templates/{self.template.id}/",
            {"description": "Should fail"},
            format="json",
        )
        self.assertEqual(response.status_code, 403)

    def test_regular_user_cannot_duplicate_template(self):
        response = self.client.post(
            f"/api/v1/templates/{self.template.id}/duplicate/",
            {},
            format="json",
        )
        self.assertEqual(response.status_code, 403)

    def test_regular_user_cannot_delete_template(self):
        response = self.client.delete(f"/api/v1/templates/{self.template.id}/")
        self.assertEqual(response.status_code, 403)
