import json
from channels.generic.websocket import AsyncWebsocketConsumer
from channels.db import database_sync_to_async
from django.contrib.auth import get_user_model
from django.utils import timezone
from .models import ChatRoom, ChatMessage, UnreadMessage, ChatNotification, ChatRoomParticipant
from .services import (
    create_delivery_records,
    create_message_for_room,
    room_display_name_for_user,
    serialize_message,
)

User = get_user_model()


class ChatConsumer(AsyncWebsocketConsumer):
    async def connect(self):
        self.user = self.scope["user"]
        self.room_group_name = None
        if not self.user.is_authenticated:
            await self.close()
            return

        self.room_id = self.scope["url_route"]["kwargs"]["room_id"]
        self.room_group_name = f"chat_{self.room_id}"

        # Check if user is a participant in this room
        if not await self.is_room_participant():
            await self.close()
            return

        # Join room group
        await self.channel_layer.group_add(
            self.room_group_name,
            self.channel_name
        )

        await self.accept()

        # Update user's last read timestamp
        await self.update_last_read()

    async def disconnect(self, close_code):
        # Leave room group if connect() joined one.
        if self.room_group_name:
            await self.channel_layer.group_discard(
                self.room_group_name,
                self.channel_name
            )

    async def receive(self, text_data):
        try:
            data = json.loads(text_data)
            message_type = data.get('type', 'text')
            content = (data.get('content') or '').strip()
            reply_to_id = data.get('reply_to', None)
            client_id = data.get('client_id', None)

            if message_type == 'typing':
                # Handle typing indicators
                await self.channel_layer.group_send(
                    self.room_group_name,
                    {
                        'type': 'typing_indicator',
                        'user_id': str(self.user.id),
                        'username': self.user.get_full_name() or self.user.email,
                        'is_typing': data.get('is_typing', False)
                    }
                )
                return

            if message_type == 'mark_read':
                # Handle marking messages as read
                await self.mark_messages_read(data.get('message_ids', []))
                return

            if message_type != 'text':
                await self.send_error('Only text messages are currently supported')
                return

            if not content:
                await self.send_error('Message content cannot be empty')
                return

            if len(content) > 4000:
                await self.send_error('Message content cannot exceed 4000 characters')
                return

            # Create and save message
            delivery = await self.create_message_delivery(content, message_type, reply_to_id, client_id)

            # Send message to room group
            await self.channel_layer.group_send(
                self.room_group_name,
                {
                    'type': 'chat_message',
                    'message': delivery['message'],
                }
            )

            for notification in delivery['notifications']:
                await self.channel_layer.group_send(
                    f"user_{notification['recipient_id']}",
                    {
                        'type': 'chat_notification',
                        'notification': notification['payload'],
                    }
                )

        except json.JSONDecodeError:
            await self.send_error('Invalid JSON format')
        except Exception:
            await self.send_error('Unable to send message')

    async def send_error(self, message):
        await self.send(text_data=json.dumps({
            'type': 'error',
            'detail': message,
        }))

    async def chat_message(self, event):
        """Send chat message to WebSocket"""
        message = event['message']
        
        await self.send(text_data=json.dumps({
            'type': 'new_message',
            'message': message
        }))

    async def typing_indicator(self, event):
        """Send typing indicator to WebSocket"""
        # Don't send typing indicator back to the same user
        if event['user_id'] == str(self.user.id):
            return

        await self.send(text_data=json.dumps({
            'type': 'typing',
            'user': {
                'id': event['user_id'],
                'name': event['username']
            },
            'is_typing': event['is_typing']
        }))

    @database_sync_to_async
    def is_room_participant(self):
        try:
            return ChatRoomParticipant.objects.filter(
                room_id=self.room_id,
                user=self.user,
                is_active=True
            ).exists()
        except Exception:
            return False

    @database_sync_to_async
    def create_message_delivery(self, content, message_type, reply_to_id, client_id):
        reply_to = None
        if reply_to_id:
            try:
                reply_to = ChatMessage.objects.get(id=reply_to_id, room_id=self.room_id)
            except ChatMessage.DoesNotExist:
                pass

        room = ChatRoom.objects.get(id=self.room_id, is_active=True)
        message = create_message_for_room(
            room=room,
            sender=self.user,
            content=content,
            message_type=message_type,
            reply_to=reply_to
        )
        participants = create_delivery_records(message)
        return {
            'message': serialize_message(message, client_id=client_id),
            'notifications': [
                {
                    'recipient_id': str(participant.user_id),
                    'payload': {
                        'id': str(message.id),
                        'message': message.content,
                        'sender': serialize_message(message)['sender'],
                        'room_id': str(message.room_id),
                        'room_name': room_display_name_for_user(message.room, participant.user),
                        'created_at': message.created_at.isoformat(),
                    },
                }
                for participant in participants
            ],
        }

    @database_sync_to_async
    def update_last_read(self):
        """Update user's last read timestamp for this room"""
        try:
            participant = ChatRoomParticipant.objects.get(
                room_id=self.room_id,
                user=self.user
            )
            participant.last_read_at = timezone.now()
            participant.save()
        except ChatRoomParticipant.DoesNotExist:
            pass

    @database_sync_to_async
    def mark_messages_read(self, message_ids):
        """Mark specific messages as read for this user"""
        UnreadMessage.objects.filter(
            user=self.user,
            room_id=self.room_id,
            message_id__in=message_ids
        ).delete()
        
        ChatNotification.objects.filter(
            recipient=self.user,
            message__room_id=self.room_id,
            message_id__in=message_ids
        ).update(is_read=True)


class UserNotificationConsumer(AsyncWebsocketConsumer):
    """Consumer for user-specific notifications (chat toasts, etc.)"""
    
    async def connect(self):
        self.user = self.scope["user"]
        self.user_group_name = None
        if not self.user.is_authenticated:
            await self.close()
            return

        self.user_group_name = f"user_{self.user.id}"

        # Join user group
        await self.channel_layer.group_add(
            self.user_group_name,
            self.channel_name
        )

        await self.accept()

    async def disconnect(self, close_code):
        # Leave user group if connect() joined one.
        if self.user_group_name:
            await self.channel_layer.group_discard(
                self.user_group_name,
                self.channel_name
            )

    async def chat_notification(self, event):
        """Send chat notification to WebSocket"""
        notification = event['notification']
        
        await self.send(text_data=json.dumps({
            'type': 'chat_notification',
            'notification': notification
        }))
