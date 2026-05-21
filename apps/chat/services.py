from __future__ import annotations

from asgiref.sync import async_to_sync
from channels.layers import get_channel_layer
from django.db import transaction
from django.utils import timezone

from .models import ChatMessage, ChatNotification, ChatRoom, ChatRoomParticipant, UnreadMessage
from .serializers import UserSerializer


def get_room_for_user(user, room_id: str) -> ChatRoom:
    return ChatRoom.objects.get(
        id=room_id,
        chatroomparticipant__user=user,
        chatroomparticipant__is_active=True,
        is_active=True,
    )


def serialize_message(message: ChatMessage, *, client_id: str | None = None) -> dict:
    payload = {
        "id": str(message.id),
        "room": str(message.room_id),
        "room_id": str(message.room_id),
        "content": message.content,
        "sender": UserSerializer(message.sender).data,
        "message_type": message.message_type,
        "reply_to": str(message.reply_to_id) if message.reply_to_id else None,
        "is_edited": message.is_edited,
        "edited_at": message.edited_at.isoformat() if message.edited_at else None,
        "created_at": message.created_at.isoformat(),
        "is_read": True,
    }
    if client_id:
        payload["client_id"] = client_id
    return payload


def create_message_for_room(
    *,
    room: ChatRoom,
    sender,
    content: str,
    message_type: str = "text",
    reply_to: ChatMessage | None = None,
) -> ChatMessage:
    message = ChatMessage.objects.create(
        room=room,
        sender=sender,
        content=content,
        message_type=message_type,
        reply_to=reply_to,
    )
    ChatRoom.objects.filter(id=room.id).update(updated_at=timezone.now())
    return message


def create_delivery_records(message: ChatMessage) -> list[ChatRoomParticipant]:
    participants = list(
        ChatRoomParticipant.objects.filter(
            room=message.room,
            is_active=True,
        )
        .exclude(user=message.sender)
        .select_related("user")
    )

    UnreadMessage.objects.bulk_create(
        [
            UnreadMessage(user=participant.user, message=message, room=message.room)
            for participant in participants
        ],
        ignore_conflicts=True,
    )
    ChatNotification.objects.bulk_create(
        [
            ChatNotification(recipient=participant.user, message=message)
            for participant in participants
        ],
        ignore_conflicts=True,
    )
    return participants


def room_display_name_for_user(room: ChatRoom, user) -> str:
    if room.room_type == "direct":
        participants = list(room.participants.all())
        other = next((participant for participant in participants if participant.id != user.id), None)
        if other:
            return other.get_full_name() or other.email
    return room.name or room.get_room_type_display()


def broadcast_message(message: ChatMessage, *, client_id: str | None = None) -> None:
    channel_layer = get_channel_layer()
    if channel_layer is None:
        return

    payload = serialize_message(message, client_id=client_id)

    def _send() -> None:
        async_to_sync(channel_layer.group_send)(
            f"chat_{message.room_id}",
            {"type": "chat_message", "message": payload},
        )

    transaction.on_commit(_send)


def broadcast_chat_notifications(message: ChatMessage, participants: list[ChatRoomParticipant]) -> None:
    channel_layer = get_channel_layer()
    if channel_layer is None:
        return

    def _send() -> None:
        for participant in participants:
            async_to_sync(channel_layer.group_send)(
                f"user_{participant.user_id}",
                {
                    "type": "chat_notification",
                    "notification": {
                        "id": str(message.id),
                        "message": message.content,
                        "sender": UserSerializer(message.sender).data,
                        "room_id": str(message.room_id),
                        "room_name": room_display_name_for_user(message.room, participant.user),
                        "created_at": message.created_at.isoformat(),
                    },
                },
            )

    transaction.on_commit(_send)
