from rest_framework import serializers
from .models import AuditLog

class AuditLogSerializer(serializers.ModelSerializer):
    actor_email = serializers.CharField(source="actor.email", read_only=True, default="")
    actor_name = serializers.SerializerMethodField()
    actor_role = serializers.CharField(source="actor.role", read_only=True)

    class Meta:
        model = AuditLog
        fields = [
            "id", "event", "actor_email", "actor_name", "actor_role",
            "object_type", "object_id", "object_repr", "changes",
            "ip_address", "user_agent", "timestamp"
        ]

    def get_actor_name(self, obj):
        if obj.actor:
            return obj.actor.get_full_name() or obj.actor.email
        return ""