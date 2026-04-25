"""
apps/accounts/models.py

Changes from previous version:
  1. User.must_change_password  — True on creation, cleared after first change
  2. User.mfa_enabled removed from TOTP, now means email OTP
  3. EmailOTP                   — stores a short-lived 6-digit code
  4. UserGroup                  — custom group independent of Django's auth.Group
  5. GroupPermission            — per-document-type permission rows per group
  6. UserGroupMembership        — user ↔ group M2M with optional expiry
"""
from django.contrib.auth.models import AbstractBaseUser, BaseUserManager, PermissionsMixin
from django.db import models
from django.utils import timezone
from django.db.models import Q
from datetime import timedelta
import uuid
import random


# ── Choices ───────────────────────────────────────────────────────────────────

class Role(models.TextChoices):
    ADMIN   = "admin",   "Administrator"
    FINANCE = "finance", "Finance Staff"
    AUDITOR = "auditor", "Auditor"
    VIEWER  = "viewer",  "Viewer"


class RoleDefinition(models.Model):
    id          = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    code        = models.CharField(max_length=50, unique=True)
    name        = models.CharField(max_length=120)
    description = models.TextField(blank=True)
    is_active   = models.BooleanField(default=True)
    created_at  = models.DateTimeField(auto_now_add=True)
    updated_at  = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["name"]

    def __str__(self):
        return self.name


# ── Department ────────────────────────────────────────────────────────────────

class Department(models.Model):
    id         = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    name       = models.CharField(max_length=120, unique=True)
    code       = models.CharField(max_length=20,  unique=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["name"]

    def __str__(self):
        return self.name


# ── User ──────────────────────────────────────────────────────────────────────

class UserManager(BaseUserManager):
    def create_user(self, email, password=None, **extra):
        if not email:
            raise ValueError("Email is required")
        email = self.normalize_email(email).lower()
        user  = self.model(email=email, **extra)
        user.set_password(password)
        user.save(using=self._db)
        return user

    def create_superuser(self, email, password, **extra):
        extra.setdefault("role", Role.ADMIN)
        extra.setdefault("is_staff", True)
        extra.setdefault("is_superuser", True)
        extra.setdefault("must_change_password", False)   # superuser skips forced change
        user = self.create_user(email, password, **extra)
        UserGroup.ensure_administrators_group(created_by=user)
        return user


class User(AbstractBaseUser, PermissionsMixin):
    id         = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    email      = models.EmailField(unique=True)
    first_name = models.CharField(max_length=100)
    last_name  = models.CharField(max_length=100)
    role       = models.CharField(max_length=50, default=Role.VIEWER)
    # Reuse the legacy ldap_dn column for the free-text job description.
    job_description = models.CharField(max_length=255, blank=True, default="", db_column="ldap_dn")
    department = models.ForeignKey(
        Department, null=True, blank=True,
        on_delete=models.SET_NULL, related_name="users",
    )

    is_active  = models.BooleanField(default=True)
    is_staff   = models.BooleanField(default=False)

    # ── Security flags ────────────────────────────────────────────────────────
    # Set True when admin creates account; cleared when user sets their own pw
    must_change_password = models.BooleanField(default=True)
    # Email OTP enabled (replaces TOTP)
    mfa_enabled          = models.BooleanField(default=True)

    last_login_ip = models.GenericIPAddressField(null=True, blank=True)
    created_at    = models.DateTimeField(auto_now_add=True)
    updated_at    = models.DateTimeField(auto_now=True)

    objects = UserManager()

    USERNAME_FIELD  = "email"
    REQUIRED_FIELDS = ["first_name", "last_name"]

    class Meta:
        ordering = ["email"]

    def __str__(self):
        return f"{self.get_full_name()} <{self.email}>"

    def get_full_name(self):
        return f"{self.first_name} {self.last_name}".strip()

    def _active_group_permissions_q(self):
        now = timezone.now()
        return Q(
            group__memberships__user=self,
            group__is_active=True,
        ) & (
            Q(group__memberships__expires_at__isnull=True)
            | Q(group__memberships__expires_at__gt=now)
        )

    def get_group_permissions_for_doctype(self, document_type_id: str | None = None) -> set[str]:
        """
        Return all GroupAction values granted to this user by active group memberships.
        If `document_type_id` is provided, include both explicit permissions for that
        document type and wildcard permissions that apply to all types.
        """
        qs = GroupPermission.objects.filter(self._active_group_permissions_q())
        if document_type_id is not None:
            qs = qs.filter(Q(document_type_id=document_type_id) | Q(document_type__isnull=True))
        return set(
            qs.exclude(action=GroupAction.ADMIN.value)
              .values_list("action", flat=True)
              .distinct()
        )

    @property
    def has_admin_access(self) -> bool:
        """
        Group-based admin access.

        A user is considered an admin only when one of their active groups has an
        explicit wildcard administrator permission. Superusers retain emergency access.
        """
        if self.is_superuser:
            return True

        return GroupPermission.objects.filter(
            self._active_group_permissions_q(),
            document_type__isnull=True,
            action=GroupAction.ADMIN.value,
        ).exists()

    # Convenience helpers
    @property
    def is_admin(self):   return self.has_admin_access
    @property
    def is_finance(self): return self.has_admin_access
    @property
    def is_auditor(self): return self.has_admin_access

    def get_all_permissions_for_doctype(self, document_type_id: str) -> set[str]:
        """
        Return the set of GroupAction values this user has for `document_type_id`.

        Includes:
          - Explicit permissions tied to this document type
          - Wildcard permissions (document_type IS NULL) that apply to every type

        Both require an active, non-expired group membership.
        """
        return self.get_group_permissions_for_doctype(document_type_id)


# ── Email OTP ─────────────────────────────────────────────────────────────────

class EmailOTP(models.Model):
    """
    A single-use 6-digit OTP sent to the user's email address.
    Expires after 10 minutes. Invalidated after one successful verify.
    """
    OTP_EXPIRY_MINUTES = 10

    id         = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    user       = models.ForeignKey(User, on_delete=models.CASCADE, related_name="email_otps")
    code       = models.CharField(max_length=6)
    purpose    = models.CharField(
        max_length=20,
        choices=[("login", "Login"), ("mfa_setup", "MFA Setup")],
        default="login",
    )
    is_used    = models.BooleanField(default=False)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)
    expires_at = models.DateTimeField()

    class Meta:
        ordering = ["-created_at"]

    def save(self, *args, **kwargs):
        if not self.expires_at:
            self.expires_at = timezone.now() + timedelta(minutes=self.OTP_EXPIRY_MINUTES)
        super().save(*args, **kwargs)

    @classmethod
    def generate(cls, user: User, purpose: str = "login") -> "EmailOTP":
        # Invalidate any existing unused codes for this user + purpose
        cls.objects.filter(user=user, purpose=purpose, is_used=False).update(is_used=True)
        code = f"{random.SystemRandom().randint(0, 999999):06d}"
        return cls.objects.create(user=user, code=code, purpose=purpose)

    @property
    def is_valid(self) -> bool:
        return not self.is_used and timezone.now() < self.expires_at

    def verify(self, code: str) -> bool:
        if self.is_valid and self.code == code.strip():
            self.is_used = True
            self.save(update_fields=["is_used"])
            return True
        return False


# ── Custom Groups ─────────────────────────────────────────────────────────────

class GroupAction(models.TextChoices):
    ADMIN    = "admin",    "Administrator access"
    VIEW     = "view",     "View documents"
    UPLOAD   = "upload",   "Upload documents"
    EDIT     = "edit",     "Edit metadata"
    DELETE   = "delete",   "Delete / void documents"
    APPROVE  = "approve",  "Approve in workflow"
    DOWNLOAD = "download", "Download files"
    COMMENT  = "comment",  "Add comments"
    ARCHIVE  = "archive",  "Archive documents"


class UserGroup(models.Model):
    """
    A named group of users, independent of Django's auth.Group.
    Permissions are defined per document type via GroupPermission.
    """
    ADMIN_GROUP_NAME = "Administrators"
    ADMIN_GROUP_DESCRIPTION = "Built-in group with application-wide administrator access."

    id          = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    name        = models.CharField(max_length=120, unique=True)
    description = models.TextField(blank=True)
    is_active   = models.BooleanField(default=True)
    created_by  = models.ForeignKey(
        User, null=True, on_delete=models.SET_NULL, related_name="created_groups"
    )
    created_at  = models.DateTimeField(auto_now_add=True)
    updated_at  = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["name"]

    def __str__(self):
        return self.name

    @property
    def has_admin_access(self) -> bool:
        return any(
            permission.document_type_id is None and permission.action == GroupAction.ADMIN.value
            for permission in self.permissions.all()
        )

    @classmethod
    def ensure_administrators_group(cls, created_by=None):
        group, _ = cls.objects.get_or_create(
            name=cls.ADMIN_GROUP_NAME,
            defaults={
                "description": cls.ADMIN_GROUP_DESCRIPTION,
                "is_active": True,
                "created_by": created_by,
            },
        )

        updates = {}
        if not group.description:
            updates["description"] = cls.ADMIN_GROUP_DESCRIPTION
        if not group.is_active:
            updates["is_active"] = True
        if created_by is not None and group.created_by_id is None:
            updates["created_by"] = created_by
        if updates:
            cls.objects.filter(pk=group.pk).update(**updates)
            group.refresh_from_db()

        GroupPermission.objects.get_or_create(
            group=group,
            document_type=None,
            action=GroupAction.ADMIN.value,
        )

        superusers = User.objects.filter(is_superuser=True, is_active=True)
        for user in superusers:
            UserGroupMembership.objects.get_or_create(
                user=user,
                group=group,
                defaults={"added_by": created_by},
            )

        return group


class GroupPermission(models.Model):
    """
    One row = one (group, document_type, action) tuple.
    The set of rows for a group defines exactly what its members can do
    with each document type.
    """
    id            = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    group         = models.ForeignKey(
        UserGroup, on_delete=models.CASCADE, related_name="permissions"
    )
    # Null document_type = applies to ALL document types (wildcard)
    document_type = models.ForeignKey(
        "documents.DocumentType",
        null=True, blank=True,
        on_delete=models.CASCADE,
        related_name="group_permissions",
    )
    action        = models.CharField(max_length=20, choices=GroupAction.choices)

    class Meta:
        unique_together = [("group", "document_type", "action")]
        ordering        = ["group", "document_type", "action"]

    def __str__(self):
        dt = self.document_type.name if self.document_type else "*"
        return f"{self.group.name} → {dt} → {self.action}"


class UserGroupMembership(models.Model):
    """
    Many-to-many between User and UserGroup with optional expiry.
    """
    id         = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    user       = models.ForeignKey(User, on_delete=models.CASCADE, related_name="group_memberships")
    group      = models.ForeignKey(UserGroup, on_delete=models.CASCADE, related_name="memberships")
    added_by   = models.ForeignKey(
        User, null=True, on_delete=models.SET_NULL, related_name="added_memberships"
    )
    expires_at = models.DateTimeField(null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        unique_together = [("user", "group")]
        ordering        = ["group__name"]

    def __str__(self):
        return f"{self.user.email} → {self.group.name}"

    @property
    def is_active(self):
        return self.expires_at is None or self.expires_at > timezone.now()
