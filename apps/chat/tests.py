from django.test import SimpleTestCase

from apps.chat.serializers import ChatMessageCreateSerializer


class ChatMessageCreateSerializerTests(SimpleTestCase):
    def test_rejects_blank_message_content(self):
        serializer = ChatMessageCreateSerializer(data={
            "content": "   ",
            "message_type": "text",
        })

        self.assertFalse(serializer.is_valid())
        self.assertIn("content", serializer.errors)

    def test_rejects_unsupported_message_type(self):
        serializer = ChatMessageCreateSerializer(data={
            "content": "hello",
            "message_type": "file",
        })

        self.assertFalse(serializer.is_valid())
        self.assertIn("message_type", serializer.errors)

    def test_accepts_text_message_with_client_id(self):
        serializer = ChatMessageCreateSerializer(data={
            "content": " hello ",
            "message_type": "text",
            "client_id": "tmp-1",
        })

        self.assertTrue(serializer.is_valid(), serializer.errors)
        self.assertEqual(serializer.validated_data["content"], "hello")
        self.assertEqual(serializer.validated_data["client_id"], "tmp-1")
