from rest_framework import viewsets, status, permissions
from rest_framework.decorators import action
from rest_framework.response import Response
from django.contrib.auth import get_user_model
from django.db.models import Q, Count
from django.utils import timezone
from .models import ChatRoom, ChatMessage, ChatRoomParticipant, UnreadMessage, ChatNotification
from .serializers import (
    ChatRoomSerializer, ChatMessageSerializer, ChatRoomCreateSerializer,
    ChatMessageCreateSerializer, UnreadMessageSerializer, ChatNotificationSerializer,
    UserSerializer
)

User = get_user_model()


class ChatRoomViewSet(viewsets.ModelViewSet):
    serializer_class = ChatRoomSerializer
    permission_classes = [permissions.IsAuthenticated]
    
    def get_queryset(self):
        return ChatRoom.objects.filter(
            participants=self.request.user,
            is_active=True
        ).select_related('created_by').prefetch_related('participants', 'messages')
    
    def get_serializer_class(self):
        if self.action == 'create':
            return ChatRoomCreateSerializer
        return ChatRoomSerializer
    
    def perform_create(self, serializer):
        serializer.save(created_by=self.request.user)
    
    @action(detail=False, methods=['get'])
    def direct_message(self, request):
        """Get or create a direct message room with a specific user"""
        user_id = request.query_params.get('user_id')
        if not user_id:
            return Response(
                {'error': 'user_id parameter is required'},
                status=status.HTTP_400_BAD_REQUEST
            )
        
        try:
            other_user = User.objects.get(id=user_id)
        except User.DoesNotExist:
            return Response(
                {'error': 'User not found'},
                status=status.HTTP_404_NOT_FOUND
            )
        
        # Look for existing direct message room
        room = ChatRoom.objects.filter(
            room_type='direct',
            participants=request.user
        ).filter(participants=other_user).first()
        
        if not room:
            # Create new direct message room
            room = ChatRoom.objects.create(
                room_type='direct',
                created_by=request.user
            )
            room.participants.set([request.user, other_user])
        
        serializer = self.get_serializer(room)
        return Response(serializer.data)
    
    @action(detail=True, methods=['post'])
    def mark_read(self, request, pk=None):
        """Mark all messages in room as read for current user"""
        room = self.get_object()
        
        # Delete unread messages for this user in this room
        UnreadMessage.objects.filter(
            user=request.user,
            room=room
        ).delete()
        
        # Mark chat notifications as read
        ChatNotification.objects.filter(
            recipient=request.user,
            message__room=room
        ).update(is_read=True)
        
        # Update participant's last read timestamp
        try:
            participant = ChatRoomParticipant.objects.get(
                room=room,
                user=request.user
            )
            participant.last_read_at = timezone.now()
            participant.save()
        except ChatRoomParticipant.DoesNotExist:
            pass
        
        return Response({'status': 'messages marked as read'})
    
    @action(detail=True, methods=['get'])
    def messages(self, request, pk=None):
        """Get messages for a specific room"""
        room = self.get_object()
        
        # Check if user is participant
        if not room.participants.filter(id=request.user.id).exists():
            return Response(
                {'error': 'Access denied'},
                status=status.HTTP_403_FORBIDDEN
            )
        
        messages = room.messages.order_by('created_at')
        
        # Pagination
        page = self.paginate_queryset(messages)
        if page is not None:
            serializer = ChatMessageSerializer(page, many=True, context={'request': request})
            return self.get_paginated_response(serializer.data)
        
        serializer = ChatMessageSerializer(messages, many=True, context={'request': request})
        return Response(serializer.data)
    
    @action(detail=True, methods=['post'])
    def leave(self, request, pk=None):
        """Leave a chat room"""
        room = self.get_object()
        
        try:
            participant = ChatRoomParticipant.objects.get(
                room=room,
                user=request.user
            )
            participant.is_active = False
            participant.save()
            
            # If it's a direct message, deactivate the room
            if room.room_type == 'direct':
                room.is_active = False
                room.save()
            
            return Response({'status': 'left room'})
        except ChatRoomParticipant.DoesNotExist:
            return Response(
                {'error': 'Not a participant in this room'},
                status=status.HTTP_400_BAD_REQUEST
            )


class ChatMessageViewSet(viewsets.ModelViewSet):
    serializer_class = ChatMessageSerializer
    permission_classes = [permissions.IsAuthenticated]
    
    def get_queryset(self):
        room_id = self.request.query_params.get('room_id')
        if room_id:
            return ChatMessage.objects.filter(
                room_id=room_id,
                room__participants=self.request.user
            ).select_related('sender', 'reply_to', 'room')
        return ChatMessage.objects.filter(
            room__participants=self.request.user
        ).select_related('sender', 'reply_to', 'room')
    
    def get_serializer_class(self):
        if self.action in ['create', 'update', 'partial_update']:
            return ChatMessageCreateSerializer
        return ChatMessageSerializer
    
    def perform_create(self, serializer):
        room_id = self.request.data.get('room_id')
        if not room_id:
            raise serializers.ValidationError("room_id is required")
        
        try:
            room = ChatRoom.objects.get(
                id=room_id,
                participants=self.request.user,
                is_active=True
            )
        except ChatRoom.DoesNotExist:
            raise serializers.ValidationError("Invalid room or access denied")
        
        serializer.save(sender=self.request.user, room=room)
    
    def create(self, request, *args, **kwargs):
        """Override create to handle room_id and return proper response"""
        serializer = self.get_serializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        
        room_id = request.data.get('room_id')
        try:
            room = ChatRoom.objects.get(
                id=room_id,
                participants=request.user,
                is_active=True
            )
        except ChatRoom.DoesNotExist:
            return Response(
                {'error': 'Invalid room or access denied'},
                status=status.HTTP_400_BAD_REQUEST
            )
        
        message = serializer.save(sender=request.user, room=room)
        
        # Create unread messages for other participants
        participants = ChatRoomParticipant.objects.filter(
            room=room,
            is_active=True
        ).exclude(user=request.user)
        
        unread_messages = []
        for participant in participants:
            unread_messages.append(
                UnreadMessage(
                    user=participant.user,
                    message=message,
                    room=room
                )
            )
        
        UnreadMessage.objects.bulk_create(unread_messages)
        
        # Create chat notifications
        notifications = []
        for participant in participants:
            notifications.append(
                ChatNotification(
                    recipient=participant.user,
                    message=message
                )
            )
        
        ChatNotification.objects.bulk_create(notifications)
        
        # Return the created message
        response_serializer = ChatMessageSerializer(message, context={'request': request})
        return Response(response_serializer.data, status=status.HTTP_201_CREATED)
    
    @action(detail=False, methods=['post'])
    def mark_read(self, request):
        """Mark specific messages as read"""
        message_ids = request.data.get('message_ids', [])
        
        if not message_ids:
            return Response(
                {'error': 'message_ids is required'},
                status=status.HTTP_400_BAD_REQUEST
            )
        
        # Mark messages as read for this user
        UnreadMessage.objects.filter(
            user=request.user,
            message_id__in=message_ids
        ).delete()
        
        ChatNotification.objects.filter(
            recipient=request.user,
            message_id__in=message_ids
        ).update(is_read=True)
        
        return Response({'status': 'messages marked as read'})


class UserViewSet(viewsets.ReadOnlyModelViewSet):
    """ViewSet for listing users that can be messaged"""
    serializer_class = UserSerializer
    permission_classes = [permissions.IsAuthenticated]
    
    def get_queryset(self):
        return User.objects.filter(
            is_active=True
        ).exclude(id=self.request.user.id).order_by('first_name', 'last_name')


class UnreadMessageViewSet(viewsets.ReadOnlyModelViewSet):
    serializer_class = UnreadMessageSerializer
    permission_classes = [permissions.IsAuthenticated]
    
    def get_queryset(self):
        return UnreadMessage.objects.filter(
            user=self.request.user
        ).select_related('message', 'message__sender', 'room')
    
    @action(detail=False, methods=['get'])
    def count(self, request):
        """Get total unread message count"""
        count = UnreadMessage.objects.filter(user=request.user).count()
        return Response({'unread_count': count})


class ChatNotificationViewSet(viewsets.ReadOnlyModelViewSet):
    serializer_class = ChatNotificationSerializer
    permission_classes = [permissions.IsAuthenticated]
    
    def get_queryset(self):
        return ChatNotification.objects.filter(
            recipient=self.request.user
        ).select_related('message', 'message__sender')
    
    @action(detail=False, methods=['post'])
    def mark_all_read(self, request):
        """Mark all chat notifications as read"""
        ChatNotification.objects.filter(
            recipient=request.user
        ).update(is_read=True)
        return Response({'status': 'all notifications marked as read'})
