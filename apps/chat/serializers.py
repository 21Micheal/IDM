from rest_framework import serializers
from django.contrib.auth import get_user_model
from .models import ChatRoom, ChatMessage, ChatRoomParticipant, UnreadMessage, ChatNotification

User = get_user_model()


class UserSerializer(serializers.ModelSerializer):
    name = serializers.SerializerMethodField()
    
    class Meta:
        model = User
        fields = ['id', 'email', 'first_name', 'last_name', 'name']
    
    def get_name(self, obj):
        return obj.get_full_name() or obj.email


class ChatRoomSerializer(serializers.ModelSerializer):
    participants = UserSerializer(many=True, read_only=True)
    last_message = serializers.SerializerMethodField()
    unread_count = serializers.SerializerMethodField()
    created_by = UserSerializer(read_only=True)
    
    class Meta:
        model = ChatRoom
        fields = [
            'id', 'name', 'room_type', 'participants', 'created_by',
            'created_at', 'updated_at', 'is_active', 'last_message', 'unread_count'
        ]
        read_only_fields = ['id', 'created_at', 'updated_at', 'created_by']
    
    def get_last_message(self, obj):
        last_message = obj.messages.order_by('-created_at').first()
        if last_message:
            return {
                'id': str(last_message.id),
                'content': last_message.content,
                'sender': UserSerializer(last_message.sender).data,
                'created_at': last_message.created_at,
                'message_type': last_message.message_type
            }
        return None
    
    def get_unread_count(self, obj):
        request = self.context.get('request')
        if request and request.user.is_authenticated:
            return UnreadMessage.objects.filter(
                user=request.user,
                room=obj
            ).count()
        return 0


class ChatMessageSerializer(serializers.ModelSerializer):
    sender = UserSerializer(read_only=True)
    reply_to = serializers.SerializerMethodField()
    is_read = serializers.SerializerMethodField()
    
    class Meta:
        model = ChatMessage
        fields = [
            'id', 'room', 'sender', 'content', 'message_type', 'file_attachment',
            'reply_to', 'is_edited', 'edited_at', 'created_at', 'is_read'
        ]
        read_only_fields = ['id', 'sender', 'is_edited', 'edited_at', 'created_at']
    
    def get_reply_to(self, obj):
        if obj.reply_to:
            return {
                'id': str(obj.reply_to.id),
                'content': obj.reply_to.content,
                'sender': UserSerializer(obj.reply_to.sender).data
            }
        return None
    
    def get_is_read(self, obj):
        request = self.context.get('request')
        if request and request.user.is_authenticated:
            return not UnreadMessage.objects.filter(
                user=request.user,
                message=obj
            ).exists()
        return False


class ChatMessageCreateSerializer(serializers.ModelSerializer):
    reply_to = serializers.UUIDField(required=False, allow_null=True)
    
    class Meta:
        model = ChatMessage
        fields = ['content', 'message_type', 'file_attachment', 'reply_to']
    
    def validate_reply_to(self, value):
        if value:
            try:
                from .models import ChatMessage
                return ChatMessage.objects.get(id=value)
            except ChatMessage.DoesNotExist:
                raise serializers.ValidationError("Reply message not found")
        return None


class ChatRoomCreateSerializer(serializers.ModelSerializer):
    participant_ids = serializers.ListField(
        child=serializers.UUIDField(),
        write_only=True,
        required=False
    )
    
    class Meta:
        model = ChatRoom
        fields = ['name', 'room_type', 'participant_ids']
    
    def validate_participant_ids(self, value):
        if self.initial_data.get('room_type') == 'direct' and len(value) != 1:
            raise serializers.ValidationError("Direct message rooms must have exactly one other participant")
        
        # Validate all user IDs exist
        users = User.objects.filter(id__in=value)
        if len(users) != len(value):
            raise serializers.ValidationError("One or more participants not found")
        
        return value
    
    def create(self, validated_data):
        participant_ids = validated_data.pop('participant_ids', [])
        request = self.context.get('request')
        
        # Create room
        room = ChatRoom.objects.create(
            created_by=request.user if request else None,
            **validated_data
        )
        
        # Add participants (including creator)
        participants = [request.user] if request else []
        for user_id in participant_ids:
            participants.append(User.objects.get(id=user_id))
        
        room.participants.set(participants)
        
        return room


class UnreadMessageSerializer(serializers.ModelSerializer):
    message = ChatMessageSerializer(read_only=True)
    
    class Meta:
        model = UnreadMessage
        fields = ['id', 'user', 'message', 'room', 'created_at']


class ChatNotificationSerializer(serializers.ModelSerializer):
    message = ChatMessageSerializer(read_only=True)
    
    class Meta:
        model = ChatNotification
        fields = ['id', 'recipient', 'message', 'is_read', 'created_at']
