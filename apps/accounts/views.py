"""
apps/accounts/views.py
"""
from django.contrib.auth import authenticate
from django.contrib.auth.password_validation import validate_password
from django.core.exceptions import ValidationError as DjangoValidationError
from django.utils.crypto import get_random_string
from django.utils import timezone

from rest_framework import generics, status, permissions, viewsets, filters, exceptions
from rest_framework.decorators import action
from rest_framework.response import Response
from rest_framework.views import APIView
from rest_framework_simplejwt.tokens import RefreshToken

from .models import User, Department, Role, RoleDefinition, EmailOTP, UserGroup, GroupPermission, UserGroupMembership
from .serializers import (
    UserSerializer, UserCreateSerializer, UserUpdateSerializer,
    DepartmentSerializer, UserSummarySerializer,
    UserGroupSerializer, GroupPermissionSerializer, UserGroupMembershipSerializer,
    RoleDefinitionSerializer,
)
from .email_otp import send_otp_email
from apps.audit.models import AuditLog, AuditEvent


# ── Permission helpers ────────────────────────────────────────────────────────

class IsAdminRole(permissions.BasePermission):
    def has_permission(self, request, view):
        return (
            request.user
            and request.user.is_authenticated
            and request.user.role == Role.ADMIN
        )


# ── Auth ──────────────────────────────────────────────────────────────────────

class LoginView(APIView):
    """
    Step 1 of login.
    - Validates credentials.
    - Always requires MFA (email OTP) since it is now default.
    - Returns {mfa_required: True, user_id}
    """
    permission_classes = [permissions.AllowAny]

    def post(self, request):
        email    = request.data.get("email", "").strip().lower()
        password = request.data.get("password", "").strip()

        print(f"DEBUG: Attempting login for {email} with password length {len(password)}")

        # Check if user exists
        try:
            user_obj = User.objects.get(email=email)
            print(f"DEBUG: User found: {user_obj.email}, active: {user_obj.is_active}, has_password: {bool(user_obj.password)}")
            print(f"DEBUG: Password hash starts with: {user_obj.password[:10] if user_obj.password else 'None'}")
            # Manual password check
            if user_obj.check_password(password):
                print(f"DEBUG: Manual password check PASSED for {email}")
            else:
                print(f"DEBUG: Manual password check FAILED for {email}")
        except User.DoesNotExist:
            print(f"DEBUG: User {email} does not exist")
            user_obj = None

        user = authenticate(request, username=email, password=password)

        if not user:
            print(f"DEBUG: Authentication failed for {email}")
            AuditLog.objects.create(
                event=AuditEvent.USER_LOGIN_FAILED,
                object_type="User",
                object_repr=email,
                ip_address=request.META.get("REMOTE_ADDR"),
                user_agent=request.META.get("HTTP_USER_AGENT", "")[:500],
            )
            return Response({"detail": "Invalid email or password."}, status=401)

        if not user.is_active:
            return Response({"detail": "This account has been deactivated."}, status=403)

        # Update login metadata
        user.last_login_ip = request.META.get("REMOTE_ADDR")
        user.last_login = timezone.now()
        user.save(update_fields=["last_login_ip", "last_login"])

        # Since MFA is now default, always send OTP
        try:
            send_otp_email(user, purpose="login")
        except Exception:
            print(f"ERROR: Failed to send OTP email to {user.email}")
            return Response(
                {"detail": "Could not send OTP email. Contact your administrator."},
                status=503,
            )

        return Response({"mfa_required": True, "user_id": str(user.id)}, status=200)


class VerifyOTPView(APIView):
    """
    Step 2 of login - verifies the emailed OTP and issues JWT tokens.
    """
    permission_classes = [permissions.AllowAny]

    def post(self, request):
        user_id = request.data.get("user_id", "")
        code    = request.data.get("otp", "").strip()

        try:
            user = User.objects.get(id=user_id, is_active=True)
        except (User.DoesNotExist, DjangoValidationError):
            return Response({"detail": "Invalid request parameters."}, status=400)
        except User.DoesNotExist:
            return Response({"detail": "Invalid request."}, status=400)

        otp = (
            EmailOTP.objects
            .filter(user=user, purpose="login", is_used=False)
            .order_by("-created_at")
            .first()
        )

        if not otp or not otp.verify(code):
            return Response(
                {"detail": "Invalid or expired code. Request a new one."},
                status=400,
            )

        # Update last_login again after successful OTP
        user.last_login = timezone.now()
        user.save(update_fields=["last_login"])

        refresh = RefreshToken.for_user(user)

        AuditLog.objects.create(
            event=AuditEvent.USER_LOGIN,
            actor=user,
            object_type="User",
            object_id=str(user.id),
            object_repr=user.email,
            ip_address=request.META.get("REMOTE_ADDR"),
            user_agent=request.META.get("HTTP_USER_AGENT", "")[:500],
        )

        return Response({
            "access":               str(refresh.access_token),
            "refresh":              str(refresh),
            "must_change_password": user.must_change_password,
        })


class ResendOTPView(APIView):
    """Resend OTP without re-authenticating credentials."""
    permission_classes = [permissions.AllowAny]

    def post(self, request):
        user_id = request.data.get("user_id", "")
        try:
            user = User.objects.get(id=user_id, is_active=True)
        except User.DoesNotExist:
            return Response({"detail": "If that account exists, a new code has been sent."})

        try:
            send_otp_email(user, purpose="login")
        except Exception:
            return Response({"detail": "Could not send email."}, status=503)

        return Response({"detail": "A new code has been sent to your email."})


class MeView(generics.RetrieveUpdateAPIView):
    permission_classes = [permissions.IsAuthenticated]

    def get_object(self):
        return self.request.user

    def get_serializer_class(self):
        if self.request.method in ("PUT", "PATCH"):
            return UserUpdateSerializer
        return UserSerializer


class ChangePasswordView(APIView):
    """
    Used both for voluntary password changes AND the forced first-login change.
    Clears must_change_password on success.
    """
    permission_classes = [permissions.IsAuthenticated]

    def post(self, request):
        old_password = request.data.get("old_password", "")
        new_password = request.data.get("new_password", "")

        if not request.user.check_password(old_password):
            return Response({"detail": "Current password is incorrect."}, status=400)

        if old_password == new_password:
            return Response(
                {"detail": "New password must be different from the current password."},
                status=400,
            )

        try:
            validate_password(new_password, user=request.user)
        except DjangoValidationError as e:
            return Response({"detail": list(e.messages)}, status=400)

        request.user.set_password(new_password)
        request.user.must_change_password = False
        request.user.save(update_fields=["password", "must_change_password"])

        return Response({"detail": "Password updated successfully."})


class EnableMFAView(APIView):
    """Toggle email OTP on/off for the authenticated user (kept for admin flexibility)."""
    permission_classes = [permissions.IsAuthenticated]

    def post(self, request):
        enable = request.data.get("enable", True)
        request.user.mfa_enabled = bool(enable)
        request.user.save(update_fields=["mfa_enabled"])

        state = "enabled" if request.user.mfa_enabled else "disabled"
        AuditLog.objects.create(
            event=AuditEvent.USER_MFA_CHANGED,
            actor=request.user,
            object_type="User",
            object_id=str(request.user.id),
            object_repr=request.user.email,
            changes={"mfa": state},
            ip_address=request.META.get("REMOTE_ADDR"),
        )
        return Response({"detail": f"Email OTP {state}.", "mfa_enabled": request.user.mfa_enabled})


# ── User management ───────────────────────────────────────────────────────────

class UserViewSet(viewsets.ModelViewSet):
    filter_backends = [filters.SearchFilter, filters.OrderingFilter]
    search_fields   = ["email", "first_name", "last_name", "department__name"]
    ordering_fields = ["email", "first_name", "created_at", "role"]
    ordering        = ["first_name"]

    def get_permissions(self):
        if self.action in (
            "create", "destroy", "reset_password",
            "toggle_active", "partial_update", "update",
        ):
            return [permissions.IsAuthenticated(), IsAdminRole()]
        return [permissions.IsAuthenticated()]

    def get_queryset(self):
        user = self.request.user
        qs   = User.objects.select_related("department").prefetch_related("group_memberships__group")
        if user.role != Role.ADMIN:
            return qs.filter(id=user.id)

        role       = self.request.query_params.get("role")
        department = self.request.query_params.get("department")
        is_active  = self.request.query_params.get("is_active")
        if role:       qs = qs.filter(role=role)
        if department: qs = qs.filter(department__id=department)
        if is_active is not None:
            qs = qs.filter(is_active=is_active.lower() == "true")
        return qs

    def get_serializer_class(self):
        if self.action == "create":
            return UserCreateSerializer
        if self.action in ("update", "partial_update"):
            return UserUpdateSerializer
        return UserSerializer

    def create(self, request, *args, **kwargs):
        serializer = self.get_serializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        
        user = serializer.save()
        temp_password = serializer.context.get("temp_password")

        # Send welcome email
        if temp_password:
            self._send_welcome_email(user, temp_password)

        # Log the creation
        AuditLog.objects.create(
            event=AuditEvent.PERMISSION_CHANGED,
            actor=request.user,
            object_type="User",
            object_id=str(user.id),
            object_repr=user.email,
            changes={"action": "created", "role": user.role},
            ip_address=request.META.get("REMOTE_ADDR"),
        )

        headers = self.get_success_headers(serializer.data)
        return Response({
            "user": UserSerializer(user).data,
            "temporary_password": temp_password,
            "detail": "User created successfully. A welcome email has been sent."
        }, status=status.HTTP_201_CREATED, headers=headers)

    def _send_welcome_email(self, user, temp_password):
        from django.core.mail import send_mail
        from django.conf import settings

        frontend_url = getattr(settings, 'FRONTEND_URL', 'http://localhost:3000')

        try:
            send_mail(
                subject="Access Granted: Your DocVault Account",
                message=f"""Hello {user.first_name},

Your DocVault account has been created by an administrator.

Credentials:
    Login ID:  {user.email}
    Temporary: {temp_password}

Next Steps:
• You will be required to set a new strong password on your first login.
• Email OTP (MFA) is enabled by default for security.

Login here: {frontend_url}

If you did not expect this account, please contact your administrator immediately.

— DocVault Administration
""",
                from_email=settings.DEFAULT_FROM_EMAIL,
                recipient_list=[user.email],
                fail_silently=False,   # Changed to False so you notice if email fails
            )
        except Exception as e:
            # Log the email failure to server console
            print(f"Failed to send welcome email to {user.email}: {e}")

    def perform_destroy(self, instance):
        if instance == self.request.user:
            raise exceptions.ValidationError("You cannot delete your own account.")

        email = instance.email
        uid = str(instance.id)

        try:
            instance.delete()
            AuditLog.objects.create(
                event=AuditEvent.PERMISSION_CHANGED,
                actor=self.request.user,
                object_type="User",
                object_id=uid,
                object_repr=email,
                changes={"action": "deleted"},
                ip_address=self.request.META.get("REMOTE_ADDR"),
            )
        except Exception:
            raise exceptions.ValidationError(
                "This user cannot be deleted because they are referenced by existing documents or workflows. "
                "Consider deactivating their account instead."
            )

    @action(detail=True, methods=["post"])
    def reset_password(self, request, pk=None):
        user = self.get_object()
        temp_password = get_random_string(
            length=12,
            allowed_chars="abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789!@#$",
        )
        user.set_password(temp_password)
        user.must_change_password = True
        user.save(update_fields=["password", "must_change_password"])

        # Email the new temp password
        from django.core.mail import send_mail
        from django.conf import settings
        try:
            send_mail(
                subject="DocVault — your password has been reset",
                message=f"""Hello {user.first_name},

Your password has been reset by an administrator.

  Temporary password: {temp_password}

You will be required to set a new password when you next log in.

— DocVault Administration
""",
                from_email=getattr(settings, "DEFAULT_FROM_EMAIL", "noreply@docvault.local"),
                recipient_list=[user.email],
                fail_silently=False,
            )
        except Exception as e:
            print(f"Failed to send password reset email to {user.email}: {e}")

        AuditLog.objects.create(
            event=AuditEvent.PERMISSION_CHANGED,
            actor=request.user,
            object_type="User", 
            object_id=str(user.id), 
            object_repr=user.email,
            changes={"action": "password_reset"},
            ip_address=request.META.get("REMOTE_ADDR"),
        )
        return Response({
            "detail": "Password reset. A new temporary password has been emailed to the user.",
            "temporary_password": temp_password,
        })

    @action(detail=True, methods=["post"])
    def toggle_active(self, request, pk=None):
        user = self.get_object()
        if user == request.user:
            return Response({"detail": "You cannot deactivate your own account."}, status=400)
        user.is_active = not user.is_active
        user.save(update_fields=["is_active"])
        AuditLog.objects.create(
            event=AuditEvent.PERMISSION_CHANGED,
            actor=request.user,
            object_type="User", 
            object_id=str(user.id), 
            object_repr=user.email,
            changes={"action": "activated" if user.is_active else "deactivated"},
            ip_address=request.META.get("REMOTE_ADDR"),
        )
        return Response({"detail": f"User {'activated' if user.is_active else 'deactivated'}.", "is_active": user.is_active})

    @action(detail=True, methods=["get"])
    def groups(self, request, pk=None):
        """List all group memberships for a specific user."""
        user = self.get_object()
        memberships = user.group_memberships.select_related("group").all()
        return Response(UserGroupMembershipSerializer(memberships, many=True).data)


# ── Department ────────────────────────────────────────────────────────────────

class DepartmentViewSet(viewsets.ModelViewSet):
    queryset = Department.objects.all().order_by("name")
    serializer_class = DepartmentSerializer

    def get_permissions(self):
        if self.action in ("create", "update", "partial_update", "destroy"):
            return [permissions.IsAuthenticated(), IsAdminRole()]
        return [permissions.IsAuthenticated()]

    def destroy(self, request, *args, **kwargs):
        dept = self.get_object()
        if dept.users.filter(is_active=True).exists():
            return Response(
                {"detail": "Cannot delete a department that has active users. Reassign them first."},
                status=400,
            )
        return super().destroy(request, *args, **kwargs)


class RoleDefinitionViewSet(viewsets.ModelViewSet):
    queryset = RoleDefinition.objects.order_by("name")
    serializer_class = RoleDefinitionSerializer

    def get_permissions(self):
        if self.action in ("create", "update", "partial_update", "destroy"):
            return [permissions.IsAuthenticated(), IsAdminRole()]
        return [permissions.IsAuthenticated()]


# ── Group management ──────────────────────────────────────────────────────────

class UserGroupViewSet(viewsets.ModelViewSet):
    queryset         = UserGroup.objects.prefetch_related("permissions__document_type", "memberships__user").filter(is_active=True)
    serializer_class = UserGroupSerializer

    def get_permissions(self):
        if self.action in ("create", "update", "partial_update", "destroy",
                           "add_member", "remove_member", "set_permissions"):
            return [permissions.IsAuthenticated(), IsAdminRole()]
        return [permissions.IsAuthenticated()]

    def perform_create(self, serializer):
        serializer.save(created_by=self.request.user)

    @action(detail=True, methods=["post"])
    def add_member(self, request, pk=None):
        group   = self.get_object()
        user_id = request.data.get("user_id")
        expires = request.data.get("expires_at")

        try:
            user = User.objects.get(id=user_id)
        except User.DoesNotExist:
            return Response({"detail": "User not found."}, status=404)

        membership, created = UserGroupMembership.objects.update_or_create(
            user=user, group=group,
            defaults={
                "added_by":  request.user,
                "expires_at": expires,
            },
        )
        return Response(
            UserGroupMembershipSerializer(membership).data,
            status=201 if created else 200,
        )

    @action(detail=True, methods=["post"])
    def remove_member(self, request, pk=None):
        group   = self.get_object()
        user_id = request.data.get("user_id")
        deleted, _ = UserGroupMembership.objects.filter(user_id=user_id, group=group).delete()
        if not deleted:
            return Response({"detail": "User is not a member of this group."}, status=404)
        return Response({"detail": "Member removed."})

    @action(detail=True, methods=["post"])
    def set_permissions(self, request, pk=None):
        group = self.get_object()
        perms = request.data.get("permissions", [])

        valid_actions = {c[0] for c in GroupPermission._meta.get_field("action").choices}
        errors = []
        for i, p in enumerate(perms):
            if p.get("action") not in valid_actions:
                errors.append(f"Item {i}: invalid action '{p.get('action')}'")
        if errors:
            return Response({"detail": errors}, status=400)

        from django.db import transaction
        with transaction.atomic():
            GroupPermission.objects.filter(group=group).delete()
            created = []
            for p in perms:
                dt_id = p.get("document_type_id") or None
                obj = GroupPermission.objects.create(
                    group=group,
                    document_type_id=dt_id,
                    action=p["action"],
                )
                created.append(obj)

        return Response(GroupPermissionSerializer(created, many=True).data)

    @action(detail=True, methods=["get"])
    def members(self, request, pk=None):
        group       = self.get_object()
        memberships = group.memberships.select_related("user", "added_by").all()
        return Response(UserGroupMembershipSerializer(memberships, many=True).data)