from rest_framework import serializers
from .models import AuditLog

class AuditLogSerializer(serializers.ModelSerializer):
    actor_email = serializers.CharField(source="actor.email", read_only=True, default="")
    actor_name = serializers.SerializerMethodField()

    class Meta:
        model = AuditLog
        fields = ["id","event","actor_email","actor_name","object_type","object_id",
                  "object_repr","changes","ip_address","timestamp"]

    def get_actor_name(self, obj):
        if obj.actor:
            return obj.actor.get_full_name()
        return ""
