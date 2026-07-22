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
from django.utils.functional import cached_property
from django.db.models import Q
from datetime import timedelta
import uuid
import random
import os


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
    head       = models.ForeignKey(
        "User",
        null=True,
        blank=True,
        on_delete=models.SET_NULL,
        related_name="headed_departments",
    )
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

    def get_group_permissions_for_doctype(
        self,
        document_type_id: str | None = None,
        *,
        stage: str | None = None,
    ) -> set[str]:
        """
        Return all GroupAction values granted to this user by active group
        memberships for a document type.

        Stage semantics:
          - A permission saved at stage "any" ("all stages") is a WILDCARD that
            applies to every lifecycle stage. (Previously these silently never
            applied, so rules set at the "any" stage did nothing.)
          - A specific-stage query (e.g. "creation") returns rows for that stage
            PLUS any "any" wildcards.
          - A stage-agnostic query (None / "any") — used by global single-stage
            mode — returns the org's "all stages" config.
        """
        if document_type_id is None:
            return set()
        qs = GroupPermission.objects.filter(self._active_group_permissions_q())
        # Include this document type's explicit rows PLUS global wildcard rows
        # (document_type IS NULL) — the "fallback" configuration that applies to
        # every document type. The Groups UI keeps these mutually exclusive
        # (either a global fallback or per-type rules), so they don't double up.
        qs = qs.filter(Q(document_type_id=document_type_id) | Q(document_type__isnull=True))
        if stage in (None, AccessStage.ANY.value):
            qs = qs.filter(stage=AccessStage.ANY.value)
        else:
            qs = qs.filter(Q(stage=stage) | Q(stage=AccessStage.ANY.value))
        return set(
            qs.exclude(action=GroupAction.ADMIN.value)
              .values_list("action", flat=True)
              .distinct()
        )

    @property
    def has_admin_access(self) -> bool:
        """
        Application-administration access.

        Granted to Django superusers/staff, and to active (expiry-aware) members
        of the built-in "Administrators" group. Group membership confers
        app-level admin only — it does NOT grant Django-admin (/admin/) access,
        which still requires is_staff/is_superuser.
        """
        if self.is_superuser or self.is_staff:
            return True
        if not hasattr(self, "_admin_group_member_cache"):
            now = timezone.now()
            self._admin_group_member_cache = (
                self.group_memberships.filter(
                    group__is_active=True,
                    group__name=UserGroup.ADMIN_GROUP_NAME,
                )
                .filter(Q(expires_at__isnull=True) | Q(expires_at__gt=now))
                .exists()
            )
        return self._admin_group_member_cache

    @cached_property
    def sees_all_documents(self) -> bool:
        """
        True if the user belongs to any active group flagged `sees_all_documents`.
        Such users are treated as *involved* with every document (full visibility
        and view), while what they can DO is still governed by group permissions.
        Cached per instance to avoid repeated queries during list serialization.
        """
        if self.has_admin_access:
            return True
        now = timezone.now()
        return self.group_memberships.filter(
            group__is_active=True,
            group__sees_all_documents=True,
        ).filter(
            Q(expires_at__isnull=True) | Q(expires_at__gt=now)
        ).exists()

    @cached_property
    def hod_department_ids(self) -> set[str]:
        """
        Department ids this user is Head of Department for (Department.head == self).
        Backs the HOD group's document visibility scope — "their respective
        department" — derived directly from Department.head rather than from
        `self.department` (the department the user is an ordinary member of),
        since a head's own department membership isn't guaranteed to match the
        department(s) they head. This is intentionally independent of HOD group
        membership itself (UserGroup.sync_hod_memberships derives the group FROM
        this FK, not the other way around), so it stays correct even if the
        synced membership is momentarily stale. No admin-facing toggle needed —
        being a department's head is what grants this, not a checkbox.
        """
        return set(str(pk) for pk in self.headed_departments.values_list("id", flat=True))

    # Convenience helpers
    @property
    def is_admin(self):   return self.has_admin_access
    @property
    def is_finance(self): return self.has_admin_access
    @property
    def is_auditor(self): return self.has_admin_access

    def get_all_permissions_for_doctype(
        self,
        document_type_id: str,
        *,
        stage: str | None = None,
        document=None,
    ) -> set[str]:
        """
        Return the set of GroupAction values this user has for `document_type_id`.

        Includes:
          - Explicit permissions tied to this document type
          - Wildcard permissions (document_type IS NULL) that apply to every type

        When `document` is provided, permissions are resolved for its lifecycle
        stage — unless the org runs in global single-stage mode, in which case one
        configuration ("any") applies across the whole lifecycle.
        """
        from apps.documents.access import permission_stage_is_global
        if permission_stage_is_global():
            stage = AccessStage.ANY.value
        elif document is not None:
            from apps.documents.access import resolve_access_stage
            stage = resolve_access_stage(document)
        return self.get_group_permissions_for_doctype(document_type_id, stage=stage)


def signature_upload_path(instance, filename):
    ext = os.path.splitext(filename or "")[1].lower()
    if ext not in {".png", ".jpg", ".jpeg"}:
        ext = ".png"
    return os.path.join("signatures", str(instance.user_id), f"{uuid.uuid4()}{ext}")


class UserSignature(models.Model):
    class Method(models.TextChoices):
        DRAW = "draw", "Drawn"
        TYPE = "type", "Typed"
        UPLOAD = "upload", "Uploaded"

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    user = models.ForeignKey(User, on_delete=models.CASCADE, related_name="signatures")
    image = models.ImageField(upload_to=signature_upload_path)
    method = models.CharField(max_length=20, choices=Method.choices)
    typed_name = models.CharField(max_length=160, blank=True)
    is_active = models.BooleanField(default=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["-created_at"]
        indexes = [
            models.Index(fields=["user", "is_active"]),
        ]

    def __str__(self):
        return f"Signature for {self.user.email} ({self.method})"


class UserDelegation(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    delegator = models.ForeignKey(
        User, on_delete=models.CASCADE, related_name="delegations_outgoing"
    )
    delegate = models.ForeignKey(
        User, on_delete=models.CASCADE, related_name="delegations_incoming"
    )
    starts_at = models.DateTimeField()
    ends_at = models.DateTimeField()
    is_active = models.BooleanField(default=True)
    comment = models.TextField(blank=True, default="")
    document_type = models.ForeignKey(
        "documents.DocumentType",
        null=True,
        blank=True,
        on_delete=models.SET_NULL,
        related_name="delegations",
        help_text="If null, delegates all tasks. If set, delegates only tasks for this document type."
    )
    created_by = models.ForeignKey(
        User, null=True, blank=True, on_delete=models.SET_NULL, related_name="created_delegations"
    )
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)
    dismissed_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        ordering = ["-starts_at"]
        indexes = [
            models.Index(fields=["delegator", "starts_at", "ends_at"]),
            models.Index(fields=["delegate", "starts_at", "ends_at"]),
            models.Index(fields=["is_active"]),
        ]

    def __str__(self):
        return f"{self.delegator.email} -> {self.delegate.email}"

    @property
    def is_current(self):
        now = timezone.now()
        return self.is_active and self.starts_at <= now <= self.ends_at


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
    SUBMIT   = "submit",   "Submit for approval"
    EDIT     = "edit",     "Edit metadata"
    DELETE   = "delete",   "Delete / void documents"
    APPROVE  = "approve",  "Approve in workflow"
    DOWNLOAD = "download", "Download files"
    COMMENT  = "comment",  "Add comments"
    ARCHIVE  = "archive",  "Archive documents"


class AccessStage(models.TextChoices):
    ANY            = "any",             "All stages"
    CREATION       = "creation",        "Creation"
    APPROVAL       = "approval",        "For approval"
    AFTER_APPROVAL = "after_approval",    "After approval"


class UserGroup(models.Model):
    """
    A named group of users, independent of Django's auth.Group.
    Permissions are defined per document type via GroupPermission.
    """
    ADMIN_GROUP_NAME = "Administrators"
    ADMIN_GROUP_DESCRIPTION = "Built-in group with application-wide administrator access."
    HOD_GROUP_NAME = "HOD"
    HOD_GROUP_DESCRIPTION = "Built-in group containing the active heads of department."

    id          = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    name        = models.CharField(max_length=120, unique=True)
    description = models.TextField(blank=True)
    is_active   = models.BooleanField(default=True)
    # Members of a `sees_all_documents` group are treated as involved with every
    # document — full visibility/view across all types (e.g. auditors). What they
    # can DO is still governed by this group's per-type permissions.
    sees_all_documents = models.BooleanField(default=False)
    created_by  = models.ForeignKey(
        User, null=True, on_delete=models.SET_NULL, related_name="created_groups"
    )
    head        = models.ForeignKey(
        User,
        null=True,
        blank=True,
        on_delete=models.SET_NULL,
        related_name="headed_groups",
    )
    created_at  = models.DateTimeField(auto_now_add=True)
    updated_at  = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["name"]

    def __str__(self):
        return self.name

    @property
    def has_admin_access(self) -> bool:
        return False

    @property
    def is_hod_group(self) -> bool:
        return self.name == self.HOD_GROUP_NAME

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

        superusers = User.objects.filter(is_superuser=True, is_active=True)
        for user in superusers:
            UserGroupMembership.objects.get_or_create(
                user=user,
                group=group,
                defaults={"added_by": created_by},
            )

        return group

    @classmethod
    def ensure_hod_group(cls, created_by=None):
        group, _ = cls.objects.get_or_create(
            name=cls.HOD_GROUP_NAME,
            defaults={
                "description": cls.HOD_GROUP_DESCRIPTION,
                "is_active": True,
                "created_by": created_by,
            },
        )

        updates = {}
        if not group.description:
            updates["description"] = cls.HOD_GROUP_DESCRIPTION
        if not group.is_active:
            updates["is_active"] = True
        if created_by is not None and group.created_by_id is None:
            updates["created_by"] = created_by
        if updates:
            cls.objects.filter(pk=group.pk).update(**updates)
            group.refresh_from_db()

        cls.sync_hod_memberships(added_by=created_by, group=group)
        return group

    @classmethod
    def sync_hod_memberships(cls, added_by=None, group=None):
        group = group or cls.ensure_hod_group(created_by=added_by)
        head_ids = set(
            Department.objects
            .filter(head__isnull=False, head__is_active=True)
            .values_list("head_id", flat=True)
        )

        for head_id in head_ids:
            UserGroupMembership.objects.update_or_create(
                user_id=head_id,
                group=group,
                defaults={"added_by": added_by, "expires_at": None},
            )

        group.memberships.exclude(user_id__in=head_ids).delete()
        return group


class GroupPermission(models.Model):
    """
    One row = one (group, document_type, stage, action) tuple.
    The set of rows for a group defines exactly what its members can do
    with each document type at each lifecycle stage.
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
    stage = models.CharField(
        max_length=50,
        choices=AccessStage.choices,
        default=AccessStage.ANY.value,
        db_index=True,
        help_text="Document lifecycle stage this permission applies to. 'any' applies to all stages.",
    )
    action        = models.CharField(max_length=20, choices=GroupAction.choices)

    class Meta:
        unique_together = [("group", "document_type", "stage", "action")]
        ordering        = ["group", "document_type", "stage", "action"]

    def __str__(self):
        dt = self.document_type.name if self.document_type else "*"
        return f"{self.group.name} → {dt} → {self.stage} → {self.action}"


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


class UserPreference(models.Model):
    """
    User display and notification preferences.
    """
    class DateFormat(models.TextChoices):
        DD_MM_YYYY = "DD/MM/YYYY", "DD/MM/YYYY"
        MM_DD_YYYY = "MM/DD/YYYY", "MM/DD/YYYY"
        YYYY_MM_DD = "YYYY-MM-DD", "YYYY-MM-DD"

    class TimeFormat(models.TextChoices):
        HOUR_12 = "12-hour", "12-hour"
        HOUR_24 = "24-hour", "24-hour"

    class DefaultPage(models.TextChoices):
        DASHBOARD = "dashboard", "Dashboard"
        MY_TASKS = "my_tasks", "My Tasks"
        ALL_DOCUMENTS = "all_documents", "All Documents"

    user = models.OneToOneField(
        User, on_delete=models.CASCADE, related_name="preferences", primary_key=True
    )
    date_format = models.CharField(
        max_length=20,
        choices=DateFormat.choices,
        default=DateFormat.DD_MM_YYYY,
    )
    time_format = models.CharField(
        max_length=20,
        choices=TimeFormat.choices,
        default=TimeFormat.HOUR_12,
    )
    default_page = models.CharField(
        max_length=50,
        choices=DefaultPage.choices,
        default=DefaultPage.DASHBOARD,
    )
    # Email notification preferences
    notify_document_approvals = models.BooleanField(default=True)
    notify_document_rejected = models.BooleanField(default=True)
    notify_task_assignments = models.BooleanField(default=True)
    notify_system_announcements = models.BooleanField(default=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        verbose_name = "User Preference"
        verbose_name_plural = "User Preferences"

    def __str__(self):
        return f"Preferences for {self.user.email}"
