from rest_framework import serializers
from django.contrib.auth import get_user_model
from django.db import transaction
from django.db.models import Count
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
    client_id = serializers.CharField(required=False, allow_blank=True, write_only=True)
    
    class Meta:
        model = ChatMessage
        fields = ['content', 'message_type', 'file_attachment', 'reply_to', 'client_id']

    def validate_content(self, value):
        value = (value or '').strip()
        if not value:
            raise serializers.ValidationError("Message content cannot be empty")
        if len(value) > 4000:
            raise serializers.ValidationError("Message content cannot exceed 4000 characters")
        return value

    def validate_message_type(self, value):
        if value != 'text':
            raise serializers.ValidationError("Only text messages are currently supported")
        return value
    
    def validate_reply_to(self, value):
        if value:
            try:
                from .models import ChatMessage
                message = ChatMessage.objects.get(id=value)
            except ChatMessage.DoesNotExist:
                raise serializers.ValidationError("Reply message not found")
            room_id = self.context.get('room_id')
            if room_id and str(message.room_id) != str(room_id):
                raise serializers.ValidationError("Reply message must be in the same room")
            return message
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
        value = list(dict.fromkeys(value))
        room_type = self.initial_data.get('room_type') or 'direct'

        if room_type == 'direct' and len(value) != 1:
            raise serializers.ValidationError("Direct message rooms must have exactly one other participant")

        if room_type == 'group' and not value:
            raise serializers.ValidationError("Group chat rooms must include at least one other participant")
        
        # Validate all user IDs exist
        users = User.objects.filter(id__in=value)
        if len(users) != len(value):
            raise serializers.ValidationError("One or more participants not found")
        
        return value
    
    def create(self, validated_data):
        participant_ids = validated_data.pop('participant_ids', [])
        request = self.context.get('request')
        creator = request.user if request else None
        participant_ids = list(dict.fromkeys(participant_ids))
        room_type = validated_data.get('room_type') or 'direct'

        if creator:
            participant_ids = [user_id for user_id in participant_ids if user_id != creator.id]

        with transaction.atomic():
            if creator and room_type == 'direct' and len(participant_ids) == 1:
                other_user_id = participant_ids[0]
                existing = ChatRoom.objects.select_for_update().filter(
                    room_type='direct',
                    is_active=True,
                    chatroomparticipant__user=creator,
                    chatroomparticipant__is_active=True,
                ).filter(
                    chatroomparticipant__user_id=other_user_id,
                    chatroomparticipant__is_active=True,
                ).annotate(participant_count=Count('participants', distinct=True)).filter(
                    participant_count=2,
                ).first()
                if existing:
                    return existing

            room = ChatRoom.objects.create(
                created_by=creator,
                **validated_data
            )

            participants = list(User.objects.filter(id__in=participant_ids))
            if creator:
                participants.insert(0, creator)

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
