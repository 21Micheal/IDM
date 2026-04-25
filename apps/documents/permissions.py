"""
apps/documents/permissions.py

Changes from previous version
──────────────────────────────
Self-upload access control (new in this revision):

1. has_permission() — "create" branch now checks whether the user supplied
   `is_self_upload=true`.  If so, any authenticated user is allowed to upload
   regardless of group permissions (they are uploading for themselves).

2. has_object_permission() — two new early-exit rules inserted BEFORE the
   group-permission lookup:

   a. SELF-UPLOAD + OWNER  → full access for the uploader on their own doc
      (they can view, edit, comment, replace versions, delete — everything
      except submit, which is blocked in the view layer).

   b. SELF-UPLOAD + NON-OWNER (non-admin) → deny immediately.
      Group memberships are irrelevant; personal docs are private.

All existing logic (admin shortcut, action mapping, wildcard group
permissions) is completely unchanged.
"""
from rest_framework import permissions
from django.db.models import Q
from django.utils import timezone

from apps.accounts.models import GroupPermission, GroupAction


class HasDocumentPermission(permissions.BasePermission):
    """
    Group-based permission class for all document actions.

    Flow
    ────
    1. has_permission()  — called for EVERY request.
    2. has_object_permission() — called when a view calls get_object().
    """

    # ── Global check ───────────────────────────────────────────────────────

    def has_permission(self, request, view):
        if not request.user or not request.user.is_authenticated:
            return False

        if request.user.has_admin_access:
            return True

        action = getattr(view, "action", None)

        if action == "list":
            return True

        if action == "create":
            # Self-upload: any authenticated user may upload their own documents.
            is_self_upload = (
                str(request.data.get("is_self_upload", "")).lower() in ("true", "1", "yes")
            )
            if is_self_upload:
                return True

            # Normal upload: require UPLOAD permission on the target document type.
            document_type_id = (
                request.data.get("document_type")
                or request.data.get("document_type_id")
            )
            if not document_type_id:
                return False
            user_perms = request.user.get_all_permissions_for_doctype(
                str(document_type_id)
            )
            return GroupAction.UPLOAD.value in user_perms

        # All other actions deferred to has_object_permission().
        return True

    # ── Object-level check ─────────────────────────────────────────────────

    def has_object_permission(self, request, view, obj):
        if not request.user or not request.user.is_authenticated:
            return False

        if request.user.has_admin_access:
            return True

        # ── Self-upload isolation ──────────────────────────────────────────
        if getattr(obj, "is_self_upload", False):
            # Only the uploader (or the designated owner) may access their
            # personal documents.  Group memberships are deliberately ignored.
            is_owner = (
                getattr(obj, "uploaded_by_id", None) == request.user.id
                or getattr(obj, "owned_by_id", None) == request.user.id
            )
            return is_owner

        # ── Standard group-permission flow (unchanged) ─────────────────────
        document_type_id = str(getattr(obj, "document_type_id", None) or "")
        if not document_type_id:
            return False

        action = getattr(view, "action", None)
        required_action = self._get_required_action(request.method, action)

        if required_action is None:
            return True

        # Owners get VIEW-level reads without explicit group membership.
        if required_action == GroupAction.VIEW.value and (
            getattr(obj, "uploaded_by_id", None) == request.user.id
            or getattr(obj, "owned_by_id", None) == request.user.id
        ):
            return True

        user_perms = request.user.get_all_permissions_for_doctype(document_type_id)
        return required_action in user_perms

    # ── Helpers ────────────────────────────────────────────────────────────

    def _user_has_any_view_permission(self, user) -> bool:
        """
        Return True if the user has VIEW on any document type (or wildcard).
        """
        now = timezone.now()
        return GroupPermission.objects.filter(
            group__memberships__user=user,
            group__is_active=True,
            action=GroupAction.VIEW.value,
        ).filter(
            Q(group__memberships__expires_at__isnull=True)
            | Q(group__memberships__expires_at__gt=now)
        ).exists()

    def _get_required_action(self, method: str, action: str | None) -> str | None:
        """
        Map a DRF action name (or HTTP method) to a GroupAction value.
        Returns None to indicate "no permission gate — let the view decide".
        """
        _action_map: dict[str, str | None] = {
            "retrieve":        GroupAction.VIEW.value,
            "preview_url":     GroupAction.VIEW.value,
            "audit_trail":     GroupAction.VIEW.value,
            "comments":        GroupAction.COMMENT.value if method == "POST"
                               else GroupAction.VIEW.value,
            "partial_update":  GroupAction.EDIT.value,
            "update":          GroupAction.EDIT.value,
            "edit_metadata":   GroupAction.EDIT.value,
            "upload_version":  GroupAction.UPLOAD.value,
            "restore_version": GroupAction.UPLOAD.value,
            "submit":          GroupAction.APPROVE.value,
            "archive":         GroupAction.ARCHIVE.value,
            "destroy":         GroupAction.DELETE.value,
            "bulk_action":     GroupAction.VIEW.value,
            "versions":        GroupAction.VIEW.value,
        }

        if action in _action_map:
            return _action_map[action]

        _method_map: dict[str, str] = {
            "GET":     GroupAction.VIEW.value,
            "HEAD":    GroupAction.VIEW.value,
            "OPTIONS": GroupAction.VIEW.value,
            "POST":    GroupAction.UPLOAD.value,
            "PATCH":   GroupAction.EDIT.value,
            "PUT":     GroupAction.EDIT.value,
            "DELETE":  GroupAction.DELETE.value,
        }
        return _method_map.get(method)
