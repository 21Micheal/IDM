# apps/documents/permissions.py
from rest_framework import permissions
from django.db.models import Q
from apps.accounts.models import GroupAction
from apps.accounts.models import GroupPermission
from django.utils import timezone


class HasDocumentPermission(permissions.BasePermission):
    """
    Enforces group-based permissions per document type.
    - Admins always have full access.
    - Uses User.get_all_permissions_for_doctype() which already supports wildcards.
    """

    def has_permission(self, request, view):
        """List and Create checks"""
        if not request.user or not request.user.is_authenticated:
            return False

        if request.user.is_admin:
            return True

        # For LIST: we allow if user has VIEW on ANY document type (or wildcard)
        if request.method == "GET":
            # Check if user has at least VIEW permission somewhere
            has_any_view = GroupPermission.objects.filter(
                group__is_active=True,
                group__memberships__user=request.user,
                action=GroupAction.VIEW.value
            ).filter(
                Q(group__memberships__expires_at__isnull=True) | Q(group__memberships__expires_at__gt=timezone.now())
            ).exists()

            return has_any_view

        # For CREATE (POST)
        if request.method == "POST":
            document_type_id = request.data.get("document_type_id")
            if not document_type_id:
                return False  # Require document_type on upload

            user_perms = request.user.get_all_permissions_for_doctype(str(document_type_id))
            return GroupAction.UPLOAD.value in user_perms

        return False

    def has_object_permission(self, request, view, obj):
        """Detail, Update, Delete, Actions on existing document"""
        if not request.user or not request.user.is_authenticated:
            return False

        if request.user.is_admin:
            return True

        document_type_id = str(getattr(obj, 'document_type_id', None))
        if not document_type_id:
            return False

        required_action = self._get_required_action(request.method)
        if not required_action:
            return False

        user_perms = request.user.get_all_permissions_for_doctype(document_type_id)
        return required_action in user_perms

    def _get_required_action(self, method: str) -> str | None:
        """Map HTTP method to required GroupAction"""
        mapping = {
            "GET":    GroupAction.VIEW.value,
            "POST":   GroupAction.UPLOAD.value,   # for actions like submit, upload_version
            "PATCH":  GroupAction.EDIT.value,
            "PUT":    GroupAction.EDIT.value,
            "DELETE": GroupAction.DELETE.value,
        }
        return mapping.get(method)