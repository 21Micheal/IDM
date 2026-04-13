from django.contrib.auth.password_validation import validate_password
from django.core.exceptions import ValidationError as DjangoValidationError
from django.utils.crypto import get_random_string
from rest_framework import serializers
from .models import User, Department, Role, UserGroup, GroupPermission, UserGroupMembership


class DepartmentSerializer(serializers.ModelSerializer):
    user_count = serializers.SerializerMethodField()

    class Meta:
        model  = Department
        fields = ["id", "name", "code", "user_count", "created_at"]
        read_only_fields = ["id", "created_at"]

    def get_user_count(self, obj):
        return obj.users.filter(is_active=True).count()

    def validate_code(self, value):
        return value.upper().strip()


class UserSummarySerializer(serializers.ModelSerializer):
    full_name = serializers.SerializerMethodField()

    class Meta:
        model  = User
        fields = ["id", "email", "first_name", "last_name", "full_name", "role"]

    def get_full_name(self, obj):
        return obj.get_full_name()


class UserSerializer(serializers.ModelSerializer):
    department_name  = serializers.CharField(source="department.name", read_only=True, default=None)
    full_name        = serializers.SerializerMethodField()
    role_display     = serializers.CharField(source="get_role_display", read_only=True)
    group_names      = serializers.SerializerMethodField()

    class Meta:
        model  = User
        fields = [
            "id", "email", "first_name", "last_name", "full_name",
            "role", "role_display",
            "department", "department_name",
            "mfa_enabled", "must_change_password",
            "is_active", "last_login_ip", "last_login",
            "group_names", "created_at", "updated_at",
        ]
        read_only_fields = [
            "id", "full_name", "role_display", "department_name",
            "must_change_password", "last_login_ip", "last_login",
            "group_names", "created_at", "updated_at",
        ]

    def get_full_name(self, obj):
        return obj.get_full_name()

    def get_group_names(self, obj):
        return list(
            obj.group_memberships
            .select_related("group")
            .values_list("group__name", flat=True)
        )


class UserCreateSerializer(serializers.ModelSerializer):
    """Admin creates a user. Password is auto-generated and returned clearly."""
    class Meta:
        model  = User
        fields = ["email", "first_name", "last_name", "role", "department", "is_active"]

    def validate_email(self, value):
        value = value.strip().lower()
        if User.objects.filter(email=value).exists():
            raise serializers.ValidationError("A user with this email already exists.")
        return value

    def create(self, validated_data):
        # Generate a strong, readable temporary password
        temp_password = get_random_string(
            length=12,
            allowed_chars="abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789!@#$",
        )

        # Store in context so the view can return it in the response
        self.context["temp_password"] = temp_password

        user = User.objects.create_user(
            password=temp_password,
            must_change_password=True,
            **validated_data,
        )
        return user


class UserUpdateSerializer(serializers.ModelSerializer):
    class Meta:
        model  = User
        fields = ["first_name", "last_name", "role", "department", "is_active", "mfa_enabled"]

    def validate(self, attrs):
        request = self.context.get("request")
        if request and request.user.role != Role.ADMIN:
            allowed = {"first_name", "last_name"}
            for key in attrs:
                if key not in allowed:
                    raise serializers.ValidationError(
                        f"You do not have permission to change '{key}'."
                    )
        return attrs


# ── Group serializers ─────────────────────────────────────────────────────────

class GroupPermissionSerializer(serializers.ModelSerializer):
    document_type_name = serializers.CharField(
        source="document_type.name", read_only=True, default=None
    )

    class Meta:
        model  = GroupPermission
        fields = ["id", "document_type", "document_type_name", "action"]


class UserGroupMembershipSerializer(serializers.ModelSerializer):
    user       = UserSummarySerializer(read_only=True)
    user_id    = serializers.PrimaryKeyRelatedField(
        queryset=User.objects.all(), source="user", write_only=True
    )
    added_by   = UserSummarySerializer(read_only=True)
    group_name = serializers.CharField(source="group.name", read_only=True)
    is_active  = serializers.BooleanField(read_only=True)

    class Meta:
        model  = UserGroupMembership
        fields = [
            "id", "user", "user_id", "group", "group_name",
            "added_by", "expires_at", "is_active", "created_at",
        ]
        read_only_fields = ["id", "added_by", "is_active", "created_at"]


class UserGroupSerializer(serializers.ModelSerializer):
    permissions  = GroupPermissionSerializer(many=True, read_only=True)
    member_count = serializers.SerializerMethodField()
    created_by   = UserSummarySerializer(read_only=True)

    class Meta:
        model  = UserGroup
        fields = [
            "id", "name", "description", "is_active",
            "permissions", "member_count", "created_by", "created_at",
        ]
        read_only_fields = ["id", "created_by", "created_at"]

    def get_member_count(self, obj):
        return obj.memberships.count()
