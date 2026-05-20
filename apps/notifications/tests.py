from django.contrib.auth import get_user_model
from django.test import TestCase
from rest_framework.test import APIClient

from apps.notifications.models import Notification


class NotificationApiTests(TestCase):
    def setUp(self):
        User = get_user_model()
        self.user = User.objects.create_user(
            email="user@example.com",
            password="pass",
            first_name="Test",
            last_name="User",
        )
        self.other_user = User.objects.create_user(
            email="other@example.com",
            password="pass",
            first_name="Other",
            last_name="User",
        )
        self.client = APIClient()
        self.client.force_authenticate(self.user)

    def test_user_only_sees_own_notifications(self):
        own = Notification.objects.create(
            recipient=self.user,
            type="task_assigned",
            message="Action required",
            link="/documents/1",
        )
        Notification.objects.create(
            recipient=self.other_user,
            type="task_assigned",
            message="Private",
            link="/documents/2",
        )

        response = self.client.get("/api/v1/notifications/")

        self.assertEqual(response.status_code, 200)
        payload = response.data["results"] if "results" in response.data else response.data
        self.assertEqual([item["id"] for item in payload], [str(own.id)])

    def test_only_is_read_can_be_patched(self):
        notification = Notification.objects.create(
            recipient=self.user,
            type="task_assigned",
            message="Original",
            link="/documents/1",
        )

        blocked = self.client.patch(
            f"/api/v1/notifications/{notification.id}/",
            {"message": "tampered"},
            format="json",
        )
        allowed = self.client.patch(
            f"/api/v1/notifications/{notification.id}/",
            {"is_read": True},
            format="json",
        )

        notification.refresh_from_db()
        self.assertEqual(blocked.status_code, 400)
        self.assertEqual(allowed.status_code, 200)
        self.assertEqual(notification.message, "Original")
        self.assertTrue(notification.is_read)

    def test_collection_post_is_not_client_creatable(self):
        response = self.client.post(
            "/api/v1/notifications/",
            {"message": "client created", "is_read": False},
            format="json",
        )

        self.assertEqual(response.status_code, 405)
        self.assertEqual(Notification.objects.count(), 0)

    def test_unread_filter_count_and_mark_all_read(self):
        Notification.objects.create(recipient=self.user, message="Unread one")
        Notification.objects.create(recipient=self.user, message="Unread two")
        Notification.objects.create(recipient=self.user, message="Read", is_read=True)

        filtered = self.client.get("/api/v1/notifications/", {"is_read": "false"})
        count = self.client.get("/api/v1/notifications/unread_count/")
        marked = self.client.post("/api/v1/notifications/mark_all_read/")

        payload = filtered.data["results"] if "results" in filtered.data else filtered.data
        self.assertEqual(len(payload), 2)
        self.assertEqual(count.data["unread_count"], 2)
        self.assertEqual(marked.data["updated"], 2)
        self.assertFalse(Notification.objects.filter(recipient=self.user, is_read=False).exists())
