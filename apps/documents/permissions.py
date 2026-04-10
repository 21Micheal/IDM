from rest_framework.permissions import BasePermission, SAFE_METHODS
from apps.accounts.models import Role

class DocumentPermission(BasePermission):
    def has_permission(self, request, view):
        if not request.user or not request.user.is_authenticated:
            return False
        if request.method in SAFE_METHODS:
            return True
        return request.user.role in (Role.ADMIN, Role.FINANCE)

    def has_object_permission(self, request, view, obj):
        if request.method in SAFE_METHODS:
            return True
        user = request.user
        if user.role == Role.ADMIN:
            return True
        if user.role == Role.FINANCE:
            return obj.uploaded_by == user or obj.department == user.department
        return False

class IsAdminUser(BasePermission):
    def has_permission(self, request, view):
        return request.user and request.user.role == Role.ADMIN
