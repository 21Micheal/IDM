from rest_framework import serializers

from apps.billing.models import ClientDeployment


class ClientDeploymentSerializer(serializers.ModelSerializer):
    class Meta:
        model = ClientDeployment
        fields = [
            "id",
            "client_name",
            "api_key_id",
            "workspace_id",
            "monthly_limit_usd",
            "alert_email",
            "is_active",
            "notes",
            "created_at",
            "updated_at",
        ]
        read_only_fields = ["id", "created_at", "updated_at"]
