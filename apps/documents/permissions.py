"""
apps/documents/permissions.py

Fixes applied
─────────────
1. has_permission() fallthrough — previously returned False for every action
   except "list" and "create", blocking retrieve/update/submit/archive/etc.
   before has_object_permission() ever ran.  Fixed: unauthenticated → False,
   admin → True, list/create handled explicitly, everything else → True (defer
   to object-level check which has full context).

2. _get_required_action() DRF action name mapping — the method received
   view.action (e.g. "retrieve", "partial_update", "destroy") but then fell
   through to an HTTP method mapping that never matched those strings.  Fixed:
   DRF action names are mapped first, HTTP methods are the fallback.

3. bulk_action returned None → has_object_permission returned False.
   Fixed: bulk_action returns VIEW (minimum) so the request reaches the view;
   the view itself performs per-item permission checks.

4. Wildcard document-type permissions (document_type=None in GroupPermission)
   were not included in _user_has_any_view_permission or in the queryset for
   get_all_permissions_for_doctype (see User model note below).
   Fixed in _user_has_any_view_permission with an OR filter.

5. DocumentViewSet.get_queryset() had a broken JOIN for group-based visibility.
   The fix is in views.py (see notes there).
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
       Handles unauthenticated, admin shortcut, list (needs any VIEW),
       create (needs UPLOAD on the target doc-type).
       All other actions return True here and are decided at object level.

    2. has_object_permission() — called when a view calls get_object().
       Maps the DRF action name (or HTTP method for standard CRUD) to the
       required GroupAction and checks via get_all_permissions_for_doctype().
    """

    # ── Global check ───────────────────────────────────────────────────────

    def has_permission(self, request, view):
        if not request.user or not request.user.is_authenticated:
            return False

        # Admins pass every check
        if request.user.is_admin:
            return True

        action = getattr(view, "action", None)

        # List: need VIEW permission on at least one document type
        if action == "list":
            return self._user_has_any_view_permission(request.user)

        # Create (upload): need UPLOAD on the declared document type
        if action == "create":
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

        # All other actions (retrieve, update, partial_update, destroy,
        # submit, archive, edit_metadata, comments, upload_version,
        # restore_version, preview_url, audit_trail, bulk_action, …)
        # are deferred to has_object_permission() which has full object context.
        # Returning True here does NOT grant access — it just lets the request
        # proceed to the object-level check.
        return True

    # ── Object-level check ─────────────────────────────────────────────────

    def has_object_permission(self, request, view, obj):
        if not request.user or not request.user.is_authenticated:
            return False

        if request.user.is_admin:
            return True

        document_type_id = str(getattr(obj, "document_type_id", None) or "")
        if not document_type_id:
            return False

        action = getattr(view, "action", None)
        required_action = self._get_required_action(request.method, action)

        # None means "let the view handle it" (e.g. bulk_action, audit_trail)
        if required_action is None:
            return True

        user_perms = request.user.get_all_permissions_for_doctype(document_type_id)
        return required_action in user_perms

    # ── Helpers ────────────────────────────────────────────────────────────

    def _user_has_any_view_permission(self, user) -> bool:
        """
        Return True if the user has VIEW on any document type (or wildcard).
        Wildcard = GroupPermission.document_type is NULL (applies to all types).
        """
        now = timezone.now()
        return GroupPermission.objects.filter(
            group__memberships__user=user,
            group__is_active=True,
            action=GroupAction.VIEW.value,
            # Active membership: no expiry OR expiry in the future
        ).filter(
            Q(group__memberships__expires_at__isnull=True)
            | Q(group__memberships__expires_at__gt=now)
        ).exists()

    def _get_required_action(self, method: str, action: str | None) -> str | None:
        """
        Map a DRF action name (or HTTP method) to a GroupAction value.

        Returns None to indicate "no permission gate — let the view decide"
        (used for actions that do their own fine-grained checks internally).

        Priority: DRF action name first, HTTP method as fallback.
        """
        # ── Custom DRF actions ─────────────────────────────────────────────
        _action_map: dict[str, str | None] = {
            # Read actions
            "retrieve":       GroupAction.VIEW.value,
            "preview_url":    GroupAction.VIEW.value,
            "audit_trail":    GroupAction.VIEW.value,

            # Comment actions — GET reads, POST writes
            "comments":       GroupAction.COMMENT.value if method == "POST"
                              else GroupAction.VIEW.value,

            # Write actions
            "partial_update": GroupAction.EDIT.value,
            "update":         GroupAction.EDIT.value,
            "edit_metadata":  GroupAction.EDIT.value,
            "upload_version": GroupAction.UPLOAD.value,
            "restore_version": GroupAction.UPLOAD.value,

            # Workflow actions
            "submit":         GroupAction.APPROVE.value,
            "archive":        GroupAction.ARCHIVE.value,

            # Destruction
            "destroy":        GroupAction.DELETE.value,

            # Bulk — view handles per-item checks; just require VIEW to enter
            "bulk_action":    GroupAction.VIEW.value,

            # Audit trail readable by anyone with VIEW
            "versions":       GroupAction.VIEW.value,
        }

        if action in _action_map:
            return _action_map[action]

        # ── HTTP method fallback (for any unmapped standard actions) ───────
        _method_map: dict[str, str] = {
            "GET":    GroupAction.VIEW.value,
            "HEAD":   GroupAction.VIEW.value,
            "OPTIONS": GroupAction.VIEW.value,
            "POST":   GroupAction.UPLOAD.value,
            "PATCH":  GroupAction.EDIT.value,
            "PUT":    GroupAction.EDIT.value,
            "DELETE": GroupAction.DELETE.value,
        }
        return _method_map.get(method)