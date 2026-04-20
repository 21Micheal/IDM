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
        return self.create_user(email, password, **extra)


class User(AbstractBaseUser, PermissionsMixin):
    id         = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    email      = models.EmailField(unique=True)
    first_name = models.CharField(max_length=100)
    last_name  = models.CharField(max_length=100)
    role       = models.CharField(max_length=50, default=Role.VIEWER)
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
    ldap_dn       = models.CharField(max_length=255, blank=True)
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

    # Convenience helpers
    @property
    def is_admin(self):   return self.role == Role.ADMIN
    @property
    def is_finance(self): return self.role in (Role.ADMIN, Role.FINANCE)
    @property
    def is_auditor(self): return self.role in (Role.ADMIN, Role.AUDITOR)

    def get_all_permissions_for_doctype(self, document_type_id: str) -> set[str]:
        """
        Return the set of GroupAction values this user has for `document_type_id`.

        Includes:
          - Explicit permissions tied to this document type
          - Wildcard permissions (document_type IS NULL) that apply to every type

        Both require an active, non-expired group membership.
        """
        now = timezone.now()

        active_membership_filter = Q(
            group__memberships__user=self,
            group__is_active=True,
        ) & (
            Q(group__memberships__expires_at__isnull=True)
            | Q(group__memberships__expires_at__gt=now)
        )

        from apps.accounts.models import GroupPermission

        actions = (
            GroupPermission.objects
            .filter(active_membership_filter)
            .filter(
                # Explicit match for this document type OR wildcard
                Q(document_type_id=document_type_id)
                | Q(document_type__isnull=True)
            )
            .values_list("action", flat=True)
            .distinct()
        )

        return set(actions)


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
