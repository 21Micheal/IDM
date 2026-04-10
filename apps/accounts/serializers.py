from rest_framework import serializers
from .models import User, Department

class UserSummarySerializer(serializers.ModelSerializer):
    class Meta:
        model = User
        fields = ["id", "email", "first_name", "last_name", "role"]

class UserSerializer(serializers.ModelSerializer):
    department_name = serializers.CharField(source="department.name", read_only=True)
    class Meta:
        model = User
        fields = [
            "id", "email", "first_name", "last_name", "role",
            "department", "department_name", "mfa_enabled",
            "is_active", "created_at",
        ]
        read_only_fields = ["id", "created_at"]

class DepartmentSerializer(serializers.ModelSerializer):
    class Meta:
        model = Department
        fields = ["id", "name", "code"]
