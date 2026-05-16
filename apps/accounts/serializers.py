from django.contrib.auth.password_validation import validate_password
from django.core.exceptions import ValidationError as DjangoValidationError
from django.utils.crypto import get_random_string
from rest_framework import serializers
from django.utils import timezone
from .models import User, Department, UserGroup, GroupPermission, UserGroupMembership, UserDelegation


class DepartmentSerializer(serializers.ModelSerializer):
    user_count = serializers.SerializerMethodField()
    head = serializers.SerializerMethodField()
    head_id = serializers.PrimaryKeyRelatedField(
        queryset=User.objects.filter(is_active=True),
        source="head",
        write_only=True,
        required=False,
        allow_null=True,
    )

    class Meta:
        model  = Department
        fields = ["id", "name", "code", "head", "head_id", "user_count", "created_at"]
        read_only_fields = ["id", "created_at"]

    def get_user_count(self, obj):
        return obj.users.filter(is_active=True).count()

    def get_head(self, obj):
        if not obj.head:
            return None
        return {
            "id": str(obj.head.id),
            "email": obj.head.email,
            "first_name": obj.head.first_name,
            "last_name": obj.head.last_name,
            "full_name": obj.head.get_full_name(),
            "job_description": obj.head.job_description,
            "is_staff": obj.head.is_staff,
        }

    def validate_code(self, value):
        return value.upper().strip()

    def validate(self, attrs):
        head = attrs.get("head")
        if head is None:
            return attrs

        department = self.instance
        if department is None:
            raise serializers.ValidationError({
                "head_id": "Create the department before assigning its head."
            })
        if department and head.department_id != department.id:
            raise serializers.ValidationError({
                "head_id": "The department head must belong to this department."
            })
        return attrs

    def create(self, validated_data):
        department = super().create(validated_data)
        UserGroup.sync_hod_memberships(
            added_by=self.context.get("request").user if self.context.get("request") else None
        )
        return department

    def update(self, instance, validated_data):
        department = super().update(instance, validated_data)
        UserGroup.sync_hod_memberships(
            added_by=self.context.get("request").user if self.context.get("request") else None
        )
        return department


class UserSummarySerializer(serializers.ModelSerializer):
    full_name = serializers.SerializerMethodField()
    department_name  = serializers.CharField(source="department.name", read_only=True, default=None)

    class Meta:
        model  = User
        fields = ["id", "email", "first_name", "last_name", "full_name", "job_description", "is_staff", "department_name"]

    def get_full_name(self, obj):
        return obj.get_full_name()


class UserSerializer(serializers.ModelSerializer):
    department_name  = serializers.CharField(source="department.name", read_only=True, default=None)
    full_name        = serializers.SerializerMethodField()
    group_names      = serializers.SerializerMethodField()
    has_admin_access = serializers.SerializerMethodField()

    class Meta:
        model  = User
        fields = [
            "id", "email", "first_name", "last_name", "full_name",
            "job_description",
            "is_staff",
            "has_admin_access",
            "department", "department_name",
            "mfa_enabled", "must_change_password",
            "is_active", "last_login_ip", "last_login",
            "group_names", "created_at", "updated_at",
        ]
        read_only_fields = [
            "id", "full_name", "department_name",
            "has_admin_access",
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

    def get_has_admin_access(self, obj):
        return obj.has_admin_access


class UserCreateSerializer(serializers.ModelSerializer):
    """Admin creates a user. Password is auto-generated and returned clearly."""
    class Meta:
        model  = User
        fields = ["email", "first_name", "last_name", "job_description", "department", "is_active"]

    def validate_job_description(self, value):
        value = value.strip()
        if not value:
            raise serializers.ValidationError("Job description is required.")
        return value

    COMMON_EMAIL_TYPO_DOMAINS = {
        "gmai.com",
        "gmial.com",
        "gnail.com",
        "hotmal.com",
        "yaho.com",
        "yahho.com",
        "outlook.con",
    }

    def validate_email(self, value):
        value = value.strip().lower()
        if User.objects.filter(email=value).exists():
            raise serializers.ValidationError("A user with this email already exists.")

        domain = value.split("@")[-1]
        if domain in self.COMMON_EMAIL_TYPO_DOMAINS:
            raise serializers.ValidationError(
                "The email domain looks mistyped. Please verify the address and try again."
            )

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
        print(f"DEBUG: Created user {user.email} with password: {temp_password}")
        print(f"DEBUG: User password hash: {user.password[:20]}...")
        return user


class UserUpdateSerializer(serializers.ModelSerializer):
    class Meta:
        model  = User
        fields = ["first_name", "last_name", "job_description", "department", "is_active", "mfa_enabled"]

    def validate_job_description(self, value):
        return value.strip()

    def validate(self, attrs):
        request = self.context.get("request")
        if request and not request.user.has_admin_access:
            allowed = {"first_name", "last_name"}
            for key in attrs:
                if key not in allowed:
                    raise serializers.ValidationError(
                        f"You do not have permission to change '{key}'."
                    )
        if "department" in attrs and self.instance:
            next_department = attrs.get("department")
            mismatched_headed_departments = self.instance.headed_departments.exclude(
                id=getattr(next_department, "id", None)
            )
            if mismatched_headed_departments.exists():
                raise serializers.ValidationError({
                    "department": (
                        "This user is configured as a department head. "
                        "Change the department head before moving them."
                    )
                })
        return attrs

    def update(self, instance, validated_data):
        user = super().update(instance, validated_data)
        UserGroup.sync_hod_memberships(
            added_by=self.context.get("request").user if self.context.get("request") else None
        )
        return user


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
    has_admin_access = serializers.SerializerMethodField()

    class Meta:
        model  = UserGroup
        fields = [
            "id", "name", "description", "is_active",
            "permissions", "has_admin_access", "member_count", "created_by", "created_at",
        ]
        read_only_fields = ["id", "created_by", "created_at"]

    def get_member_count(self, obj):
        return obj.memberships.count()

    def get_has_admin_access(self, obj):
        return obj.has_admin_access

    def validate(self, attrs):
        if self.instance and self.instance.name in (
            UserGroup.ADMIN_GROUP_NAME,
            UserGroup.HOD_GROUP_NAME,
        ):
            if "name" in attrs and attrs["name"] != self.instance.name:
                raise serializers.ValidationError({
                    "name": f"The {self.instance.name} group cannot be renamed."
                })
            if attrs.get("is_active") is False:
                raise serializers.ValidationError({
                    "is_active": f"The {self.instance.name} group cannot be deactivated."
                })
        return attrs


class UserDelegationSerializer(serializers.ModelSerializer):
    delegator = UserSummarySerializer(read_only=True)
    delegate = UserSummarySerializer(read_only=True)
    delegator_id = serializers.PrimaryKeyRelatedField(
        queryset=User.objects.filter(is_active=True),
        source="delegator",
        write_only=True,
        required=False,
    )
    delegate_id = serializers.PrimaryKeyRelatedField(
        queryset=User.objects.filter(is_active=True),
        source="delegate",
        write_only=True,
    )
    comment = serializers.CharField(required=False, allow_blank=False)
    is_current = serializers.BooleanField(read_only=True)

    class Meta:
        model = UserDelegation
        fields = [
            "id",
            "delegator",
            "delegate",
            "delegator_id",
            "delegate_id",
            "starts_at",
            "ends_at",
            "comment",
            "is_active",
            "is_current",
            "created_at",
        ]
        read_only_fields = ["id", "delegator", "delegate", "is_current", "created_at"]

    def validate(self, attrs):
        comment = attrs.get("comment")
        if self.instance is None:
            if comment is None or not str(comment).strip():
                raise serializers.ValidationError({"comment": "Please provide a reason for delegation."})
        elif "comment" in attrs and not str(comment).strip():
            raise serializers.ValidationError({"comment": "Delegation reason cannot be blank."})
        delegator = attrs.get("delegator") or getattr(self.instance, "delegator", None)
        delegate = attrs.get("delegate") or getattr(self.instance, "delegate", None)
        starts_at = attrs.get("starts_at") or getattr(self.instance, "starts_at", None)
        ends_at = attrs.get("ends_at") or getattr(self.instance, "ends_at", None)

        if delegator and delegate and delegator.id == delegate.id:
            raise serializers.ValidationError("You cannot delegate tasks to yourself.")
        if starts_at and ends_at and starts_at >= ends_at:
            raise serializers.ValidationError("Delegation end time must be after start time.")
        if ends_at and ends_at <= timezone.now():
            raise serializers.ValidationError("Delegation end time must be in the future.")

        return attrs
