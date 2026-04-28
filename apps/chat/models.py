from django.db import models
from django.conf import settings
from django.contrib.auth import get_user_model
import uuid

User = get_user_model()


class ChatRoom(models.Model):
    """A chat room that can be between two users (direct) or multiple users (group)"""
    ROOM_TYPES = [
        ('direct', 'Direct Message'),
        ('group', 'Group Chat'),
    ]
    
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    name = models.CharField(max_length=255, blank=True, help_text="Optional name for group chats")
    room_type = models.CharField(max_length=10, choices=ROOM_TYPES, default='direct')
    participants = models.ManyToManyField(
        settings.AUTH_USER_MODEL, 
        related_name='chat_rooms',
        through='ChatRoomParticipant'
    )
    created_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, 
        on_delete=models.SET_NULL, 
        null=True,
        related_name='created_rooms'
    )
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)
    is_active = models.BooleanField(default=True)
    
    class Meta:
        ordering = ['-updated_at']
    
    def __str__(self):
        if self.room_type == 'direct':
            participants = self.participants.all()
            if len(participants) == 2:
                return f"DM: {participants[0].get_full_name()} & {participants[1].get_full_name()}"
        return self.name or f"{self.get_room_type_display()}: {self.id}"


class ChatRoomParticipant(models.Model):
    """Through model for managing room participation"""
    room = models.ForeignKey(ChatRoom, on_delete=models.CASCADE)
    user = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE)
    joined_at = models.DateTimeField(auto_now_add=True)
    last_read_at = models.DateTimeField(null=True, blank=True)
    is_active = models.BooleanField(default=True)
    
    class Meta:
        unique_together = ['room', 'user']
        indexes = [
            models.Index(fields=['user', 'room']),
            models.Index(fields=['room', 'user']),
        ]


class ChatMessage(models.Model):
    """Individual messages in a chat room"""
    MESSAGE_TYPES = [
        ('text', 'Text'),
        ('file', 'File'),
        ('system', 'System'),
    ]
    
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    room = models.ForeignKey(ChatRoom, on_delete=models.CASCADE, related_name='messages')
    sender = models.ForeignKey(
        settings.AUTH_USER_MODEL, 
        on_delete=models.CASCADE, 
        related_name='sent_messages'
    )
    content = models.TextField()
    message_type = models.CharField(max_length=10, choices=MESSAGE_TYPES, default='text')
    file_attachment = models.FileField(
        upload_to='chat_attachments/%Y/%m/', 
        null=True, 
        blank=True
    )
    reply_to = models.ForeignKey(
        'self', 
        on_delete=models.SET_NULL, 
        null=True, 
        blank=True,
        related_name='replies'
    )
    is_edited = models.BooleanField(default=False)
    edited_at = models.DateTimeField(null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    
    class Meta:
        ordering = ['created_at']
        indexes = [
            models.Index(fields=['room', 'created_at']),
            models.Index(fields=['sender', 'created_at']),
        ]
    
    def __str__(self):
        return f"{self.sender.get_full_name()}: {self.content[:50]}..."


class UnreadMessage(models.Model):
    """Track unread messages for each user"""
    user = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE)
    message = models.ForeignKey(ChatMessage, on_delete=models.CASCADE)
    room = models.ForeignKey(ChatRoom, on_delete=models.CASCADE)
    created_at = models.DateTimeField(auto_now_add=True)
    
    class Meta:
        unique_together = ['user', 'message']
        indexes = [
            models.Index(fields=['user', 'room']),
            models.Index(fields=['user', 'created_at']),
        ]


class ChatNotification(models.Model):
    """Notifications for chat messages (toast notifications)"""
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    recipient = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name='chat_notifications')
    message = models.ForeignKey(ChatMessage, on_delete=models.CASCADE)
    is_read = models.BooleanField(default=False)
    created_at = models.DateTimeField(auto_now_add=True)
    
    class Meta:
        ordering = ['-created_at']
        indexes = [
            models.Index(fields=['recipient', 'is_read']),
            models.Index(fields=['recipient', 'created_at']),
        ]
