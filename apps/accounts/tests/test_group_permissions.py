from django.test import TestCase
from rest_framework.test import APIClient

from apps.accounts.models import AccessStage, GroupAction, GroupPermission, User, UserGroup
from apps.documents.models import DocumentType


class SetPermissionsStageTests(TestCase):
    def setUp(self):
        self.admin = User.objects.create_superuser(
            email="admin-groups@example.com",
            password="pass",
            first_name="Admin",
            last_name="User",
        )
        self.group = UserGroup.objects.create(name="Test Group")
        self.doc_type = DocumentType.objects.create(
            name="Contract",
            code="CTR",
            reference_prefix="CTR",
        )
        self.client = APIClient()
        self.client.force_authenticate(user=self.admin)

    def test_set_permissions_with_stage(self):
        response = self.client.post(
            f"/api/v1/groups/{self.group.id}/set_permissions/",
            {
                "permissions": [
                    {
                        "document_type_id": str(self.doc_type.id),
                        "stage": AccessStage.CREATION.value,
                        "action": GroupAction.SUBMIT.value,
                    },
                ],
            },
            format="json",
        )
        self.assertEqual(response.status_code, 200)
        perm = GroupPermission.objects.get(group=self.group)
        self.assertEqual(perm.stage, AccessStage.CREATION.value)
        self.assertEqual(perm.action, GroupAction.SUBMIT.value)
