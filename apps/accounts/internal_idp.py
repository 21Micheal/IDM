"""
Internal DMS identity API for Keycloak federation.

These endpoints are intentionally separate from the public auth API. They are
called by the Keycloak User Storage SPI / protocol mapper with a service bearer
key so DMS remains the source of truth for users, passwords, and authorization.
"""
from __future__ import annotations

from django.conf import settings
from django.contrib.auth import authenticate
from django.db import transaction
from django.db.models import Q
from django.utils.crypto import constant_time_compare
from rest_framework import permissions, status
from rest_framework.response import Response
from rest_framework.views import APIView

from .models import GroupAction, GroupPermission, Role, User


class InternalIdpAPIView(APIView):
    authentication_classes = []
    permission_classes = [permissions.AllowAny]

    def initial(self, request, *args, **kwargs):
        super().initial(request, *args, **kwargs)
        configured_key = getattr(settings, "DMS_INTERNAL_IDP_API_KEY", "")
        supplied = request.headers.get("Authorization", "")
        prefix = "Bearer "
        token = supplied[len(prefix):].strip() if supplied.startswith(prefix) else ""

        if not configured_key or not token or not constant_time_compare(token, configured_key):
            self.permission_denied(request, message="Invalid internal IdP credentials.")


def _user_payload(user: User) -> dict:
    return {
        "id": str(user.id),
        "username": user.email,
        "email": user.email,
        "first_name": user.first_name,
        "last_name": user.last_name,
        "enabled": user.is_active,
        "email_verified": True,
        "created_at": user.created_at.isoformat() if user.created_at else None,
        "updated_at": user.updated_at.isoformat() if user.updated_at else None,
    }


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
        "dms_role": _dms_role(user),
        "is_platform_admin": bool(user.is_superuser or user.is_staff),
        "is_dms_admin": bool(user.has_admin_access),
        "groups": group_names,
        "permissions": actions,
        "has_admin_access": bool(user.has_admin_access),
        "updated_at": user.updated_at.isoformat() if user.updated_at else None,
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
            return Response({"detail": "Provide id, email, or username."}, status=status.HTTP_400_BAD_REQUEST)

        user = User.objects.filter(query).first()
        if not user:
            return Response({"detail": "User not found."}, status=status.HTTP_404_NOT_FOUND)
        return Response(_user_payload(user))


class InternalIdpUserSearchView(InternalIdpAPIView):
    def get(self, request):
        q = request.query_params.get("q", "").strip()
        try:
            first = max(int(request.query_params.get("first", 0)), 0)
            max_results = min(max(int(request.query_params.get("max", 20)), 1), 100)
        except ValueError:
            return Response({"detail": "first and max must be integers."}, status=status.HTTP_400_BAD_REQUEST)

        users = User.objects.all().order_by("email")
        if q:
            users = users.filter(
                Q(email__icontains=q)
                | Q(first_name__icontains=q)
                | Q(last_name__icontains=q)
            )
        count = users.count()
        results = [_user_payload(user) for user in users[first:first + max_results]]
        return Response({"count": count, "results": results})


class InternalIdpValidatePasswordView(InternalIdpAPIView):
    def post(self, request):
        username = request.data.get("username", "").strip().lower()
        password = request.data.get("password", "")
        if not username or not password:
            return Response({"valid": False})

        user = authenticate(request, username=username, password=password)
        if not user or not user.is_active:
            return Response({"valid": False})

        return Response({"valid": True, "user": _user_payload(user)})


class InternalIdpUserCreateView(InternalIdpAPIView):
    def post(self, request):
        email = request.data.get("email", "").strip().lower()
        first_name = request.data.get("first_name", "").strip()
        last_name = request.data.get("last_name", "").strip()
        enabled = bool(request.data.get("enabled", True))

        if not email:
            return Response({"detail": "email is required."}, status=status.HTTP_400_BAD_REQUEST)

        with transaction.atomic():
            user = User.objects.filter(email=email).first()
            created = False
            if user is None:
                user = User.objects.create_user(
                    email=email,
                    password=None,
                    first_name=first_name,
                    last_name=last_name,
                    is_active=enabled,
                    role=Role.VIEWER,
                    must_change_password=True,
                )
                created = True

        payload = _user_payload(user)
        payload.update({
            "default_role": "dms-user",
            "must_change_password": user.must_change_password,
        })
        return Response(payload, status=status.HTTP_201_CREATED if created else status.HTTP_200_OK)


class InternalIdpUserProfileView(InternalIdpAPIView):
    def patch(self, request, user_id):
        user = User.objects.filter(id=user_id).first()
        if not user:
            return Response({"detail": "User not found."}, status=status.HTTP_404_NOT_FOUND)

        update_fields = []
        for field, attr in (
            ("email", "email"),
            ("first_name", "first_name"),
            ("last_name", "last_name"),
            ("enabled", "is_active"),
        ):
            if field not in request.data:
                continue
            value = request.data[field]
            if field == "email":
                value = str(value).strip().lower()
                if not value:
                    return Response({"detail": "email cannot be blank."}, status=status.HTTP_400_BAD_REQUEST)
            elif field == "enabled":
                value = bool(value)
            else:
                value = str(value).strip()
            if getattr(user, attr) != value:
                setattr(user, attr, value)
                update_fields.append(attr)

        if update_fields:
            update_fields.append("updated_at")
            user.save(update_fields=update_fields)
        return Response(_user_payload(user))


class InternalIdpUserPasswordView(InternalIdpAPIView):
    def put(self, request, user_id):
        password = request.data.get("password", "")
        temporary = bool(request.data.get("temporary", False))
        if not password:
            return Response({"detail": "password is required."}, status=status.HTTP_400_BAD_REQUEST)

        user = User.objects.filter(id=user_id).first()
        if not user:
            return Response({"detail": "User not found."}, status=status.HTTP_404_NOT_FOUND)

        user.set_password(password)
        user.must_change_password = temporary
        user.save(update_fields=["password", "must_change_password", "updated_at"])
        return Response({"updated": True, "must_change_password": user.must_change_password})


class InternalIdpUserAuthorizationView(InternalIdpAPIView):
    def get(self, request, user_id):
        user = (
            User.objects
            .prefetch_related("group_memberships__group")
            .filter(id=user_id)
            .first()
        )
        if not user:
            return Response({"detail": "User not found."}, status=status.HTTP_404_NOT_FOUND)
        return Response(_authorization_payload(user))
