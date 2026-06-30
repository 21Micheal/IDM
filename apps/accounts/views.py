"""
apps/accounts/views.py
"""
import logging

from django.contrib.auth import authenticate
from django.contrib.auth.password_validation import validate_password
from django.core.exceptions import ValidationError as DjangoValidationError
from django.utils.crypto import get_random_string
from django.utils import timezone
from django.db.models import Q
from django.http import FileResponse, Http404

from rest_framework import generics, status, permissions, viewsets, filters, exceptions
from rest_framework.decorators import action
from rest_framework.parsers import MultiPartParser, FormParser
from rest_framework.response import Response
from rest_framework.views import APIView
from rest_framework_simplejwt.tokens import RefreshToken

from .models import User, Department, EmailOTP, UserGroup, GroupAction, GroupPermission, UserGroupMembership, UserDelegation, UserPreference, UserSignature
from .serializers import (
    UserSerializer, UserCreateSerializer, UserUpdateSerializer,
    DepartmentSerializer, UserSummarySerializer,
    UserGroupSerializer, GroupPermissionSerializer, UserGroupMembershipSerializer, UserDelegationSerializer,
    UserPreferenceSerializer, UserSignatureSerializer,
)
from apps.notifications.tasks import _create_notification, _send_email
from .email_otp import send_otp_email
from apps.audit.models import AuditLog, AuditEvent

logger = logging.getLogger(__name__)


# ── Session policy ────────────────────────────────────────────────────────────
# The session lifetime (formerly a hardcoded ~6h) is admin-configurable via the
# DMS settings. We expose the policy to the client at sign-in / refresh so the
# frontend can enforce the absolute lifetime and the inactivity (idle) timeout,
# and we pin each refresh token's expiry to the configured absolute lifetime so
# the backend never trusts a session for longer than the policy allows.

def get_session_policy() -> dict:
    """Current session policy as a plain dict for API responses."""
    from datetime import timedelta
    from apps.documents.models import DMSSettings

    settings = DMSSettings.load()
    return {
        "session_lifetime_minutes": settings.session_lifetime_minutes,
        "session_idle_timeout_minutes": settings.session_idle_timeout_minutes,
        "session_warning_minutes": settings.session_warning_minutes,
    }


def issue_refresh_for_user(user) -> RefreshToken:
    """RefreshToken whose lifetime matches the configured session lifetime."""
    from datetime import timedelta

    refresh = RefreshToken.for_user(user)
    lifetime = get_session_policy()["session_lifetime_minutes"]
    if lifetime:
        refresh.set_exp(lifetime=timedelta(minutes=lifetime))
    return refresh


from rest_framework_simplejwt.views import TokenRefreshView
from rest_framework_simplejwt.serializers import TokenRefreshSerializer
from rest_framework_simplejwt.settings import api_settings as jwt_settings


class SessionTokenRefreshSerializer(TokenRefreshSerializer):
    """Refresh serializer that pins rotated refresh tokens to the configured
    absolute session lifetime instead of the static SIMPLE_JWT setting."""

    def validate(self, attrs):
        from datetime import timedelta

        refresh = self.token_class(attrs["refresh"])
        data = {"access": str(refresh.access_token)}

        if jwt_settings.ROTATE_REFRESH_TOKENS:
            if jwt_settings.BLACKLIST_AFTER_ROTATION:
                try:
                    refresh.blacklist()
                except AttributeError:
                    pass
            refresh.set_jti()
            refresh.set_iat()
            refresh.set_exp()
            lifetime = get_session_policy()["session_lifetime_minutes"]
            if lifetime:
                refresh.set_exp(lifetime=timedelta(minutes=lifetime))
            data["refresh"] = str(refresh)

        return data


class SessionTokenRefreshView(TokenRefreshView):
    serializer_class = SessionTokenRefreshSerializer

    def post(self, request, *args, **kwargs):
        response = super().post(request, *args, **kwargs)
        if response.status_code == 200:
            response.data["session_policy"] = get_session_policy()
        return response


# ── Permission helpers ────────────────────────────────────────────────────────

class IsGroupAdmin(permissions.BasePermission):
    def has_permission(self, request, view):
        return (
            request.user
            and request.user.is_authenticated
            and request.user.has_admin_access
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

        user = authenticate(request, username=email, password=password)

        if not user:
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
            logger.exception("Failed to send login OTP email to %s", user.email)
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

        refresh = issue_refresh_for_user(user)

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
            "user":                 UserSerializer(user).data,
            "session_policy":       get_session_policy(),
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

    def retrieve(self, request, *args, **kwargs):
        # Piggyback the current session policy so the SPA can pick up admin
        # changes to session lifetime / idle timeout without re-authenticating.
        response = super().retrieve(request, *args, **kwargs)
        response.data["session_policy"] = get_session_policy()
        return response


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
            event=AuditEvent.USER_MFA_ENABLED,
            actor=request.user,
            object_type="User",
            object_id=str(request.user.id),
            object_repr=request.user.email,
            changes={"mfa": state},
            ip_address=request.META.get("REMOTE_ADDR"),
        )
        return Response({"detail": f"Email OTP {state}.", "mfa_enabled": request.user.mfa_enabled})


class UserPreferencesView(generics.RetrieveUpdateAPIView):
    """Get or update the authenticated user's preferences."""
    permission_classes = [permissions.IsAuthenticated]
    serializer_class = UserPreferenceSerializer

    def get_object(self):
        preference, _ = UserPreference.objects.get_or_create(
            user=self.request.user,
            defaults={
                "date_format": UserPreference.DateFormat.DD_MM_YYYY,
                "time_format": UserPreference.TimeFormat.HOUR_12,
                "default_page": UserPreference.DefaultPage.DASHBOARD,
            }
        )
        return preference


class UserSignatureView(APIView):
    permission_classes = [permissions.IsAuthenticated]
    parser_classes = [MultiPartParser, FormParser]

    def get(self, request):
        signature = request.user.signatures.filter(is_active=True).order_by("-created_at").first()
        if not signature:
            return Response({"signature": None})
        return Response({
            "signature": UserSignatureSerializer(signature, context={"request": request}).data
        })

    def post(self, request):
        image = request.FILES.get("image")
        method = request.data.get("method", "")
        typed_name = request.data.get("typed_name", "")
        if method not in UserSignature.Method.values:
            return Response({"detail": "Invalid signature method."}, status=400)
        if not image:
            return Response({"detail": "Signature image is required."}, status=400)
        if getattr(image, "content_type", "") not in {"image/png", "image/jpeg", "image/jpg"}:
            return Response({"detail": "Signature must be a PNG or JPG image."}, status=400)
        if image.size > 2 * 1024 * 1024:
            return Response({"detail": "Signature image must be 2 MB or smaller."}, status=400)

        request.user.signatures.filter(is_active=True).update(is_active=False)
        signature = UserSignature.objects.create(
            user=request.user,
            image=image,
            method=method,
            typed_name=typed_name[:160],
            is_active=True,
        )
        AuditLog.objects.create(
            event=AuditEvent.PERMISSION_CHANGED,
            actor=request.user,
            object_type="UserSignature",
            object_id=str(signature.id),
            object_repr=f"Signature for {request.user.email}",
            changes={"method": method},
            ip_address=request.META.get("REMOTE_ADDR"),
            user_agent=request.META.get("HTTP_USER_AGENT", "")[:500],
        )
        return Response(UserSignatureSerializer(signature, context={"request": request}).data, status=201)

    def delete(self, request):
        request.user.signatures.filter(is_active=True).update(is_active=False)
        return Response(status=204)


class UserSignatureImageView(APIView):
    permission_classes = [permissions.IsAuthenticated]

    def get(self, request, signature_id):
        signature = UserSignature.objects.filter(id=signature_id, is_active=True).select_related("user").first()
        if not signature:
            raise Http404

        can_view = signature.user_id == request.user.id
        if not can_view:
            can_view = signature.document_signatures.filter(
                document__workflow_instance__tasks__assigned_to=request.user
            ).exists()
        if not can_view and not request.user.has_admin_access:
            return Response({"detail": "Not found."}, status=404)

        try:
            signature.image.open("rb")
        except Exception:
            raise Http404
        return FileResponse(signature.image, content_type="image/png")


# ── User management ───────────────────────────────────────────────────────────

class UserViewSet(viewsets.ModelViewSet):
    filter_backends = [filters.SearchFilter, filters.OrderingFilter]
    search_fields   = ["email", "first_name", "last_name", "job_description", "department__name"]
    ordering_fields = ["email", "first_name", "created_at"]
    ordering        = ["first_name"]

    def get_permissions(self):
        if self.action in (
            "create", "destroy", "reset_password",
            "toggle_active", "partial_update", "update",
        ):
            return [permissions.IsAuthenticated(), IsGroupAdmin()]
        return [permissions.IsAuthenticated()]

    def get_queryset(self):
        user = self.request.user
        qs   = User.objects.select_related("department").prefetch_related("group_memberships__group")
        if not user.has_admin_access:
            # Non-admins get a read-only directory of active members so they can
            # pick people to share with, request signatures from, etc. Sensitive
            # fields are withheld via UserSummarySerializer (see below).
            return qs.filter(is_active=True)

        department = self.request.query_params.get("department")
        is_active  = self.request.query_params.get("is_active")
        if department: qs = qs.filter(department__id=department)
        if is_active is not None:
            qs = qs.filter(is_active=is_active.lower() == "true")
        return qs

    def get_serializer_class(self):
        if self.action == "create":
            return UserCreateSerializer
        if self.action in ("update", "partial_update"):
            return UserUpdateSerializer
        # Non-admins see only a limited directory summary (no last-login IP,
        # group memberships, etc.).
        if self.action in ("list", "retrieve") and not self.request.user.has_admin_access:
            return UserSummarySerializer
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
            changes={"action": "created", "job_description": user.job_description},
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
                subject="Access Granted: Your FseDMS Account",
                message=f"""Hello {user.first_name},

Your FseDMS account has been created by an administrator.

Credentials:
    Login ID:  {user.email}
    Temporary: {temp_password}

Next Steps:
• You will be required to set a new strong password on your first login.
• Email OTP (MFA) is enabled by default for security.

Login here: {frontend_url}

If you did not expect this account, please contact your administrator immediately.

— FseDMS Administration
""",
                from_email=settings.DEFAULT_FROM_EMAIL,
                recipient_list=[user.email],
                fail_silently=False,   # Changed to False so you notice if email fails
            )
        except Exception:
            logger.exception("Failed to send welcome email to %s", user.email)

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

    @action(detail=True, methods=["post"], url_path="reset-password")
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

        frontend_url = getattr(settings, "FRONTEND_URL", "http://localhost:3000")
        try:
            send_mail(
                subject="FseDMS — your password has been reset",
                message=f"""Hello {user.first_name},

Your password has been reset by an administrator.

Credentials:
    Login ID:           {user.email}
    Temporary password: {temp_password}

Next steps:
1. Go to {frontend_url} and sign in with the Login ID and temporary password above.
2. Check your email for a one-time security code (OTP) and enter it to continue.
3. You will then be prompted to set a new strong password of your own.

For your security, the temporary password works only until you set a new one.
If you did not expect this reset, contact your administrator immediately.

— FseDMS Administration
""",
                from_email=getattr(settings, "DEFAULT_FROM_EMAIL", "noreply@flaxem.local"),
                recipient_list=[user.email],
                fail_silently=False,
            )
        except Exception:
            logger.exception("Failed to send password reset email to %s", user.email)

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

    @action(detail=True, methods=["get"])
    def delegations(self, request, pk=None):
        user = self.get_object()
        outgoing = UserDelegation.objects.filter(delegator=user).select_related("delegator", "delegate")
        return Response(UserDelegationSerializer(outgoing, many=True).data)

    @action(detail=True, methods=["post"], url_path="reassign-active-tasks")
    def reassign_active_tasks(self, request, pk=None):
        user = self.get_object()
        to_user_id = request.data.get("to_user_id")
        if not to_user_id:
            return Response({"detail": "to_user_id is required."}, status=400)
        if str(user.id) == str(to_user_id):
            return Response({"detail": "Cannot reassign tasks to the same user."}, status=400)

        try:
            to_user = User.objects.get(id=to_user_id, is_active=True)
        except User.DoesNotExist:
            return Response({"detail": "Target user not found or inactive."}, status=404)

        from apps.workflows.models import WorkflowTask, WorkflowTaskAction

        tasks = WorkflowTask.objects.filter(
            assigned_to=user,
            status__in=["in_progress", "held"],
        )
        task_ids = list(tasks.values_list("id", flat=True))
        updated = tasks.update(assigned_to=to_user)

        if task_ids:
            WorkflowTaskAction.objects.bulk_create(
                [
                    WorkflowTaskAction(
                        task_id=task_id,
                        actor=request.user,
                        action="reassigned",
                        comment=f"Task reassigned from {user.get_full_name() or user.email} to {to_user.get_full_name() or to_user.email}",
                    )
                    for task_id in task_ids
                ]
            )

        AuditLog.objects.create(
            event=AuditEvent.WORKFLOW_REASSIGNED,
            actor=request.user,
            object_type="User",
            object_id=str(user.id),
            object_repr=user.get_full_name() or user.email,
            changes={"action": "reassign_active_tasks", "count": updated, "to_user_id": str(to_user.id), "to_user_name": to_user.get_full_name() or to_user.email},
            ip_address=request.META.get("REMOTE_ADDR"),
        )
        return Response({"detail": f"Reassigned {updated} active task(s).", "count": updated})


# ── Department ────────────────────────────────────────────────────────────────

class DepartmentViewSet(viewsets.ModelViewSet):
    queryset = Department.objects.select_related("head").all().order_by("name")
    serializer_class = DepartmentSerializer

    def get_permissions(self):
        if self.action in ("create", "update", "partial_update", "destroy"):
            return [permissions.IsAuthenticated(), IsGroupAdmin()]
        return [permissions.IsAuthenticated()]

    def destroy(self, request, *args, **kwargs):
        dept = self.get_object()
        if dept.users.filter(is_active=True).exists():
            return Response(
                {"detail": "Cannot delete a department that has active users. Reassign them first."},
                status=400,
            )
        return super().destroy(request, *args, **kwargs)


# ── Group management ──────────────────────────────────────────────────────────

class UserGroupViewSet(viewsets.ModelViewSet):
    queryset         = UserGroup.objects.prefetch_related("permissions__document_type", "memberships__user").filter(is_active=True)
    serializer_class = UserGroupSerializer

    def get_queryset(self):
        UserGroup.ensure_administrators_group(created_by=getattr(self.request, "user", None))
        UserGroup.ensure_hod_group(created_by=getattr(self.request, "user", None))
        return super().get_queryset()

    def get_permissions(self):
        if self.action in ("create", "update", "partial_update", "destroy",
                           "add_member", "remove_member", "set_permissions", "duplicate"):
            return [permissions.IsAuthenticated(), IsGroupAdmin()]
        return [permissions.IsAuthenticated()]

    def perform_create(self, serializer):
        serializer.save(created_by=self.request.user)

    def destroy(self, request, *args, **kwargs):
        group = self.get_object()
        if group.name in (UserGroup.ADMIN_GROUP_NAME, UserGroup.HOD_GROUP_NAME):
            return Response({"detail": f"The {group.name} group cannot be deleted."}, status=400)
        return super().destroy(request, *args, **kwargs)

    @action(detail=True, methods=["post"])
    def add_member(self, request, pk=None):
        group   = self.get_object()
        if group.name == UserGroup.HOD_GROUP_NAME:
            return Response(
                {"detail": "HOD group membership is managed through department heads."},
                status=400,
            )
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
        if group.name == UserGroup.HOD_GROUP_NAME:
            return Response(
                {"detail": "HOD group membership is managed through department heads."},
                status=400,
            )
        user_id = request.data.get("user_id")
        deleted, _ = UserGroupMembership.objects.filter(user_id=user_id, group=group).delete()
        if not deleted:
            return Response({"detail": "User is not a member of this group."}, status=404)
        return Response({"detail": "Member removed."})

    @action(detail=True, methods=["post"])
    def set_permissions(self, request, pk=None):
        from apps.accounts.models import AccessStage
        from apps.documents.access import ACCESS_STAGE_KEYS
        from apps.documents.models import DocumentType

        group = self.get_object()
        perms = request.data.get("permissions", [])

        valid_actions = {
            c[0] for c in GroupPermission._meta.get_field("action").choices
            if c[0] != GroupAction.ADMIN.value
        }
        # "any" is allowed — it is the global single-stage configuration.
        valid_stages = set(ACCESS_STAGE_KEYS)
        # A null/absent document_type_id is the global fallback ("all document
        # types") wildcard, so it is allowed here.
        valid_doctype_ids = set(
            str(x) for x in DocumentType.objects.values_list("id", flat=True)
        )
        errors = []
        for i, p in enumerate(perms):
            if p.get("action") not in valid_actions:
                errors.append(f"Item {i}: invalid action '{p.get('action')}'")
            dt_id = p.get("document_type_id")
            if dt_id and str(dt_id) not in valid_doctype_ids:
                errors.append(f"Item {i}: unknown document_type_id '{dt_id}'")
            stage = p.get("stage")
            if stage not in valid_stages:
                errors.append(f"Item {i}: invalid stage '{stage}'")
        if errors:
            return Response({"detail": errors}, status=400)

        from django.db import transaction
        with transaction.atomic():
            GroupPermission.objects.filter(group=group).delete()
            created = []
            for p in perms:
                dt_id = p.get("document_type_id")
                stage = p.get("stage")
                obj = GroupPermission.objects.create(
                    group=group,
                    document_type_id=dt_id,
                    stage=stage,
                    action=p["action"],
                )
                created.append(obj)

        return Response(GroupPermissionSerializer(created, many=True).data)

    @action(detail=True, methods=["post"])
    def set_admin_access(self, request, pk=None):
        return Response(
            {"detail": "Administrator access is managed on user accounts, not groups."},
            status=410,
        )

    @action(detail=True, methods=["get"])
    def members(self, request, pk=None):
        group       = self.get_object()
        memberships = group.memberships.select_related("user", "added_by").all()
        return Response(UserGroupMembershipSerializer(memberships, many=True).data)

    @action(detail=True, methods=["post"])
    def duplicate(self, request, pk=None):
        """Deep-clone a group (name, description, permissions). Blocked for system groups."""
        original = self.get_object()
        if original.name in (UserGroup.ADMIN_GROUP_NAME, UserGroup.HOD_GROUP_NAME):
            return Response(
                {"detail": f"The '{original.name}' group cannot be duplicated."},
                status=400,
            )

        new_name = (request.data.get("name") or f"{original.name} (Copy)").strip()
        if not new_name:
            return Response({"detail": "name is required."}, status=400)
        if UserGroup.objects.filter(name=new_name, is_active=True).exists():
            return Response({"detail": f"A group named '{new_name}' already exists."}, status=400)

        from django.db import transaction
        with transaction.atomic():
            copy = UserGroup.objects.create(
                name=new_name,
                description=request.data.get("description", original.description),
                created_by=request.user,
            )
            perms = [
                GroupPermission(
                    group=copy,
                    document_type=p.document_type,
                    stage=p.stage,
                    action=p.action,
                )
                for p in original.permissions.all()
            ]
            GroupPermission.objects.bulk_create(perms)

        AuditLog.objects.create(
            event=AuditEvent.PERMISSION_CHANGED,
            actor=request.user,
            object_type="UserGroup",
            object_id=str(copy.id),
            object_repr=copy.name,
            changes={"action": "duplicated_from", "source_id": str(original.id), "source_name": original.name},
            ip_address=request.META.get("REMOTE_ADDR"),
        )

        return Response(self.get_serializer(copy).data, status=201)


class UserDelegationViewSet(viewsets.ModelViewSet):
    serializer_class = UserDelegationSerializer

    def get_queryset(self):
        user = self.request.user
        qs = UserDelegation.objects.select_related("delegator", "delegate")
        if user.has_admin_access:
            if delegator := self.request.query_params.get("delegator"):
                qs = qs.filter(delegator_id=delegator)
            if delegate := self.request.query_params.get("delegate"):
                qs = qs.filter(delegate_id=delegate)
            return qs
        return qs.filter(Q(delegator=user) | Q(delegate=user))

    def get_permissions(self):
        return [permissions.IsAuthenticated()]

    def perform_create(self, serializer):
        user = self.request.user
        delegator = serializer.validated_data.get("delegator") or user

        if not user.has_admin_access and delegator != user:
            raise exceptions.PermissionDenied("You can only create delegations for yourself.")

        delegation = serializer.save(delegator=delegator, created_by=user)
        self._notify_delegate_of_delegation(delegation)

        AuditLog.objects.create(
            event=AuditEvent.WORKFLOW_DELEGATED,
            actor=user,
            object_type="User",
            object_id=str(delegation.delegate.id),
            object_repr=delegation.delegate.get_full_name() or delegation.delegate.email,
            changes={
                "action": "create_delegation",
                "delegator_id": str(delegator.id),
                "delegator_name": delegator.get_full_name() or delegator.email,
                "starts_at": delegation.starts_at.isoformat(),
                "ends_at": delegation.ends_at.isoformat(),
                "comment": delegation.comment,
            },
            ip_address=self.request.META.get("REMOTE_ADDR"),
        )

    def _notify_delegate_of_delegation(self, delegation: UserDelegation) -> None:
        start = delegation.starts_at.strftime("%d %b %Y %H:%M UTC")
        end = delegation.ends_at.strftime("%d %b %Y %H:%M UTC")
        message = (
            f"You have been delegated workflow tasks by {delegation.delegator.get_full_name()} "
            f"from {start} to {end}. Reason: {delegation.comment.strip()}"
        )
        link = "/profile"

        _create_notification(delegation.delegate, message, link, "delegation")
        _send_email(
            delegation.delegate,
            subject=f"DMS — New delegation from {delegation.delegator.get_full_name()}",
            body=(
                f"Hello {delegation.delegate.first_name},\n\n"
                f"{delegation.delegator.get_full_name()} has delegated workflow tasks to you.\n\n"
                f"  From: {start}\n"
                f"  To:   {end}\n"
                f"  Reason: {delegation.comment.strip()}\n\n"
                f"Please log in to DMS to view your delegated workload.\n"
            ),
        )

    def perform_update(self, serializer):
        instance = self.get_object()
        user = self.request.user
        if not user.has_admin_access and instance.delegator_id != user.id:
            raise exceptions.PermissionDenied("You can only update your own delegations.")
        serializer.save()

    def perform_destroy(self, instance):
        user = self.request.user
        if not user.has_admin_access and instance.delegator_id != user.id:
            raise exceptions.PermissionDenied("You can only remove your own delegations.")
        instance.delete()

    @action(detail=False, methods=["get"])
    def candidates(self, request):
        users = User.objects.filter(is_active=True).exclude(id=request.user.id).order_by("first_name", "last_name")
        return Response(UserSummarySerializer(users, many=True).data)
