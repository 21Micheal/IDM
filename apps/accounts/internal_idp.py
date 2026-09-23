"""
Role-only internal API for Keycloak's dms_role live mapper and the financial launcher.

Identity (lookup for login, passwords, user creation) lives in the financial system.
These endpoints must not inherit DRF JWT/session auth — empty authentication_classes.
"""
from __future__ import annotations

from django.conf import settings
from django.db.models import Q
from django.utils.crypto import constant_time_compare
from rest_framework import status
from rest_framework.response import Response
from rest_framework.views import APIView

from .models import GroupAction, GroupPermission, User


class InternalIdpAPIView(APIView):
    authentication_classes = []
    permission_classes = []

    def initial(self, request, *args, **kwargs):
        super().initial(request, *args, **kwargs)
        configured_key = getattr(settings, "DMS_INTERNAL_IDP_API_KEY", "") or ""
        supplied = request.headers.get("Authorization", "")
        prefix = "Bearer "
        token = supplied[len(prefix):].strip() if supplied.startswith(prefix) else ""

        if not configured_key or not token or not constant_time_compare(token, configured_key):
            self.permission_denied(request, message="Invalid internal IdP credentials.")


def _dms_role(user: User) -> str:
    if user.is_superuser or user.is_staff:
        return "platform-admin"
    if user.has_admin_access:
        return "dms-admin"
    return "dms-user"


def _authorization_payload(user: User) -> dict:
    group_names = list(
        user.group_memberships
        .filter(group__is_active=True)
        .select_related("group")
        .values_list("group__name", flat=True)
        .distinct()
    )
    actions = list(
        GroupPermission.objects
        .filter(user._active_group_permissions_q())
        .exclude(action=GroupAction.ADMIN.value)
        .values_list("action", flat=True)
        .distinct()
        .order_by("action")
    )

    return {
        "dms_user_id": str(user.id),
        "dms_role": _dms_role(user),
        "is_platform_admin": bool(user.is_superuser or user.is_staff),
        "is_dms_admin": bool(user.has_admin_access),
        "groups": group_names,
        "permissions": actions,
        "has_admin_access": bool(user.has_admin_access),
        "updated_at": user.updated_at.isoformat() if user.updated_at else None,
    }


def _user_payload(user: User) -> dict:
    return {
        "id": str(user.id),
        "username": user.email,
        "email": user.email,
        "first_name": user.first_name,
        "last_name": user.last_name,
        "enabled": user.is_active,
        "email_verified": True,
    }


class InternalIdpUserLookupView(InternalIdpAPIView):
    def get(self, request):
        email = request.query_params.get("email", "").strip().lower()
        user_id = request.query_params.get("id", "").strip()
        username = request.query_params.get("username", "").strip().lower()

        query = Q()
        if user_id:
            query |= Q(id=user_id)
        if email:
            query |= Q(email=email)
        if username:
            query |= Q(email=username)
        if not query:
            return Response(
                {"detail": "Provide id, email, or username."},
                status=status.HTTP_400_BAD_REQUEST,
            )

        user = User.objects.filter(query).first()
        if not user:
            return Response({"detail": "User not found."}, status=status.HTTP_404_NOT_FOUND)
        return Response(_user_payload(user))


class InternalIdpUserAuthorizationView(InternalIdpAPIView):
    def get(self, request, user_id=None):
        user = None
        if user_id:
            user = (
                User.objects
                .prefetch_related("group_memberships__group")
                .filter(id=user_id)
                .first()
            )
        else:
            email = (request.query_params.get("email") or "").strip().lower()
            if not email:
                return Response(
                    {"detail": "Provide user id or email."},
                    status=status.HTTP_400_BAD_REQUEST,
                )
            user = (
                User.objects
                .prefetch_related("group_memberships__group")
                .filter(email=email)
                .first()
            )

        if not user:
            return Response({"detail": "User not found."}, status=status.HTTP_404_NOT_FOUND)
        return Response(_authorization_payload(user))
