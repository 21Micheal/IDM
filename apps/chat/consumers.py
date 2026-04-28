import json
from channels.generic.websocket import AsyncWebsocketConsumer
from channels.db import database_sync_to_async
from django.contrib.auth import get_user_model
from django.utils import timezone
from .models import ChatRoom, ChatMessage, UnreadMessage, ChatNotification, ChatRoomParticipant

User = get_user_model()


class ChatConsumer(AsyncWebsocketConsumer):
    async def connect(self):
        self.user = self.scope["user"]
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
        # Leave room group
        await self.channel_layer.group_discard(
            self.room_group_name,
            self.channel_name
        )

    async def receive(self, text_data):
        try:
            data = json.loads(text_data)
            message_type = data.get('type', 'text')
            content = data.get('content', '')
            reply_to_id = data.get('reply_to', None)

            if message_type == 'typing':
                # Handle typing indicators
                await self.channel_layer.group_send(
                    self.room_group_name,
                    {
                        'type': 'typing_indicator',
                        'user_id': self.user.id,
                        'username': self.user.get_full_name() or self.user.email,
                        'is_typing': data.get('is_typing', False)
                    }
                )
                return

            if message_type == 'mark_read':
                # Handle marking messages as read
                await self.mark_messages_read(data.get('message_ids', []))
                return

            # Create and save message
            message = await self.create_message(content, message_type, reply_to_id)

            # Send message to room group
            await self.channel_layer.group_send(
                self.room_group_name,
                {
                    'type': 'chat_message',
                    'message': {
                        'id': str(message.id),
                        'content': message.content,
                        'sender': {
                            'id': message.sender.id,
                            'name': message.sender.get_full_name() or message.sender.email,
                            'email': message.sender.email
                        },
                        'message_type': message.message_type,
                        'reply_to': str(message.reply_to.id) if message.reply_to else None,
                        'is_edited': message.is_edited,
                        'created_at': message.created_at.isoformat(),
                        'room_id': str(message.room.id)
                    }
                }
            )

            # Create unread messages for all participants except sender
            await self.create_unread_messages(message)

            # Create chat notifications for real-time toasts
            participants = await self.create_chat_notifications(message)
            await self.send_chat_notifications(message, participants)

        except json.JSONDecodeError:
            await self.send(text_data=json.dumps({
                'type': 'error',
                'message': 'Invalid JSON format'
            }))
        except Exception as e:
            await self.send(text_data=json.dumps({
                'type': 'error',
                'message': str(e)
            }))

    async def chat_message(self, event):
        """Send chat message to WebSocket"""
        message = event['message']
        
        # Don't send the message back to the sender
        if message['sender']['id'] == str(self.user.id):
            return

        await self.send(text_data=json.dumps({
            'type': 'new_message',
            'message': message
        }))

    async def typing_indicator(self, event):
        """Send typing indicator to WebSocket"""
        # Don't send typing indicator back to the same user
        if event['user_id'] == self.user.id:
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
        except:
            return False

    @database_sync_to_async
    def create_message(self, content, message_type, reply_to_id):
        reply_to = None
        if reply_to_id:
            try:
                reply_to = ChatMessage.objects.get(id=reply_to_id)
            except ChatMessage.DoesNotExist:
                pass

        message = ChatMessage.objects.create(
            room_id=self.room_id,
            sender=self.user,
            content=content,
            message_type=message_type,
            reply_to=reply_to
        )
        
        # Update room's updated_at timestamp
        room = message.room
        room.save()
        
        return message

    @database_sync_to_async
    def create_unread_messages(self, message):
        """Create unread message records for all participants except sender"""
        participants = ChatRoomParticipant.objects.filter(
            room=message.room,
            is_active=True
        ).exclude(user=message.sender)
        
        unread_messages = []
        for participant in participants:
            unread_messages.append(
                UnreadMessage(
                    user=participant.user,
                    message=message,
                    room=message.room
                )
            )
        
        UnreadMessage.objects.bulk_create(unread_messages)

    @database_sync_to_async
    def create_chat_notifications(self, message):
        """Create chat notifications for real-time toast notifications"""
        participants = ChatRoomParticipant.objects.filter(
            room=message.room,
            is_active=True
        ).exclude(user=message.sender)
        
        notifications = []
        for participant in participants:
            notifications.append(
                ChatNotification(
                    recipient=participant.user,
                    message=message
                )
            )
        
        ChatNotification.objects.bulk_create(notifications)
        return list(participants)

    async def send_chat_notifications(self, message, participants):
        """Send notifications to user-specific channels"""
        room_name = await self.get_room_name(message.room)
        
        for participant in participants:
            await self.channel_layer.group_send(
                f"user_{participant.user.id}",
                {
                    'type': 'chat_notification',
                    'notification': {
                        'id': str(message.id),
                        'message': message.content,
                        'sender': {
                            'id': message.sender.id,
                            'name': message.sender.get_full_name() or message.sender.email,
                            'email': message.sender.email
                        },
                        'room_id': str(message.room.id),
                        'room_name': room_name,
                        'created_at': message.created_at.isoformat()
                    }
                }
            )

    @database_sync_to_async
    def get_room_name(self, room):
        if room.room_type == 'direct':
            participants = list(room.participants.all())
            if len(participants) == 2:
                other_user = participants[0] if participants[1] == self.user else participants[1]
                return other_user.get_full_name() or other_user.email
        return room.name or f"{room.get_room_type_display()}"

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
            message_id__in=message_ids
        ).delete()
        
        ChatNotification.objects.filter(
            recipient=self.user,
            message_id__in=message_ids
        ).update(is_read=True)


class UserNotificationConsumer(AsyncWebsocketConsumer):
    """Consumer for user-specific notifications (chat toasts, etc.)"""
    
    async def connect(self):
        self.user = self.scope["user"]
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
        # Leave user group
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
