"""
apps/documents/models.py

Changes from previous version
──────────────────────────────
1. OCRStatus TextChoices — pending / processing / done / failed
2. Document.is_scanned   — user-declared or auto-detected scan flag
3. Document.ocr_status   — pipeline state updated by Celery tasks
4. Composite index on (is_scanned, ocr_status) for admin OCR queue views
5. is_image() helper method
"""
from datetime import timedelta
import os
import uuid

from django.conf import settings
from django.db import models
from django.utils import timezone

OFFICE_MIME_TYPES = {
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    "application/msword",
    "application/vnd.ms-excel",
    "application/vnd.ms-powerpoint",
}

OFFICE_EXTENSIONS = {
    ".doc", ".docx", ".docm", ".dot", ".dotx", ".dotm", ".rtf",
    ".xls", ".xlsx", ".xlsm", ".xlsb", ".xlt", ".xltx", ".xltm",
    ".ppt", ".pptx", ".pptm", ".pps", ".ppsx", ".pot", ".potx", ".potm",
    ".odt", ".ods", ".odp",
}

IMAGE_EXTENSIONS = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".bmp", ".tif", ".tiff"}


class DocumentType(models.Model):
    class MetadataMode(models.TextChoices):
        ADMIN_DEFINED = "admin_defined", "Admin-defined"
        USER_DEFINED = "user_defined", "User-defined"

    id               = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    name             = models.CharField(max_length=120, unique=True)
    code             = models.CharField(max_length=20, unique=True)
    reference_prefix = models.CharField(max_length=10)
    reference_padding = models.PositiveSmallIntegerField(default=5)
    title_field      = models.CharField(
        max_length=100,
        blank=True,
        default="filename",
        help_text=(
            "Source whose value names documents of this type. Use 'filename' (default) "
            "to name documents after the uploaded file, or a field key such as "
            "title, supplier, or reference_number."
        ),
    )
    description      = models.TextField(blank=True)
    icon             = models.CharField(max_length=60, blank=True)

    workflow_template = models.ForeignKey(
        "workflows.WorkflowTemplate",
        null=True, blank=True,
        on_delete=models.SET_NULL,
        related_name="document_types",
        help_text="Primary approval workflow for this document type.",
    )
    is_personal_type = models.BooleanField(default=False)
    max_file_size_mb = models.PositiveSmallIntegerField(
        default=25,
        help_text="Maximum upload size (in MB) for documents of this type, including new versions.",
    )
    metadata_mode    = models.CharField(
        max_length=32,
        choices=MetadataMode.choices,
        default=MetadataMode.ADMIN_DEFINED,
    )
    access_policy = models.JSONField(
        default=dict,
        blank=True,
        help_text="Lifecycle outcome policies: on_approved, on_rejected, on_archived.",
    )

    is_active  = models.BooleanField(default=True)
    created_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, null=True, on_delete=models.SET_NULL,
        related_name="created_document_types",
    )
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["name"]

    def __str__(self):
        return self.name

    @property
    def max_file_size_bytes(self) -> int:
        return (self.max_file_size_mb or 25) * 1024 * 1024

    def next_reference(self):
        from apps.documents.models import Document
        last = (
            Document.objects
            .filter(document_type=self)
            .order_by("-created_at")
            .values_list("reference_number", flat=True)
            .first()
        )
        seq = 1
        if last:
            try:
                seq = int(last.split("-")[-1]) + 1
            except (ValueError, IndexError):
                seq = Document.objects.filter(document_type=self).count() + 1
        return f"{self.reference_prefix}-{str(seq).zfill(self.reference_padding)}"


class MetadataField(models.Model):
    FIELD_TYPES = [
        ("text",     "Text"),
        ("varchar",  "VARCHAR"),
        ("number",   "Number"),
        ("date",     "Date"),
        ("currency", "Currency"),
        ("select",   "Select"),
        ("boolean",  "Boolean"),
        ("textarea", "Long Text"),
    ]

    id            = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    document_type = models.ForeignKey(
        DocumentType, on_delete=models.CASCADE, related_name="metadata_fields"
    )
    label          = models.CharField(max_length=100)
    key            = models.SlugField(max_length=100)
    field_type     = models.CharField(max_length=20, choices=FIELD_TYPES, default="text")
    is_required    = models.BooleanField(default=False)
    is_unique      = models.BooleanField(
        default=False,
        help_text=(
            "When set, the value entered for this attribute (e.g. a reference "
            "number) must not match any other document of the same type."
        ),
    )
    is_searchable  = models.BooleanField(default=True)
    select_options = models.JSONField(default=list, blank=True)
    default_value  = models.CharField(max_length=255, blank=True)
    help_text      = models.CharField(max_length=255, blank=True)
    order          = models.PositiveSmallIntegerField(default=0)

    class Meta:
        ordering        = ["order", "label"]
        unique_together = [("document_type", "key")]

    def __str__(self):
        return f"{self.document_type.code}:{self.key}"


class DocumentRelationshipRule(models.Model):
    class MatchOperator(models.TextChoices):
        EQUALS = "equals", "Equals"

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    source_document_type = models.ForeignKey(
        DocumentType,
        on_delete=models.CASCADE,
        related_name="outgoing_relationship_rules",
    )
    target_document_type = models.ForeignKey(
        DocumentType,
        on_delete=models.CASCADE,
        related_name="incoming_relationship_rules",
    )
    relation_type = models.CharField(
        max_length=30,
        choices=[
            ("supports", "Supports"),
            ("references", "References"),
            ("supersedes", "Supersedes"),
            ("linked-to", "Linked to"),
        ],
        default="references",
    )
    source_field_key = models.CharField(
        max_length=100,
        help_text="Field on the source document, for example po_number or transaction_reference.",
    )
    target_field_key = models.CharField(
        max_length=100,
        help_text="Field on the target document to compare with the source field.",
    )
    match_operator = models.CharField(
        max_length=30,
        choices=MatchOperator.choices,
        default=MatchOperator.EQUALS,
    )
    description = models.CharField(max_length=255, blank=True)
    is_active = models.BooleanField(default=True)
    require_confirmation = models.BooleanField(
        default=True,
        help_text="When true, matches are suggested for user confirmation instead of created automatically.",
    )
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["source_document_type__name", "target_document_type__name", "source_field_key"]
        unique_together = [
            (
                "source_document_type",
                "target_document_type",
                "relation_type",
                "source_field_key",
                "target_field_key",
            )
        ]
        indexes = [
            models.Index(fields=["source_document_type", "is_active"]),
            models.Index(fields=["target_document_type", "is_active"]),
        ]

    def __str__(self):
        return (
            f"{self.source_document_type.code}.{self.source_field_key} "
            f"{self.match_operator} {self.target_document_type.code}.{self.target_field_key}"
        )


class Tag(models.Model):
    id    = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    name  = models.CharField(max_length=60, unique=True)
    color = models.CharField(max_length=7, default="#6366f1")

    def __str__(self):
        return self.name


class DocTypeColor(models.Model):
    """Persisted mapping of document type name -> hex colour for analytics UI.

    A single row per `(doc_type)` is simple and avoids JSON migrations. Admins can
    create/update these via the API.
    """
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    doc_type = models.CharField(max_length=120, db_index=True)
    color = models.CharField(max_length=32)
    created_by = models.ForeignKey(settings.AUTH_USER_MODEL, null=True, on_delete=models.SET_NULL)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        unique_together = ("doc_type",)

    def __str__(self):
        return f"{self.doc_type} -> {self.color}"


class DMSSettings(models.Model):
    class WatermarkPosition(models.TextChoices):
        DIAGONAL = "diagonal", "Diagonal"
        CENTER = "center", "Center"
        FOOTER = "footer", "Footer"

    id = models.PositiveSmallIntegerField(primary_key=True, default=1, editable=False)

    # Organization identity — used to auto-fill {{company_name}} / {{company_address}}
    # merge fields in designer document templates.
    organization_name = models.CharField(max_length=200, blank=True, default="")
    organization_address = models.TextField(blank=True, default="")

    watermark_enabled = models.BooleanField(default=False)
    watermark_text = models.CharField(max_length=120, default="CONFIDENTIAL", blank=True)
    watermark_opacity = models.PositiveSmallIntegerField(default=15)
    watermark_position = models.CharField(
        max_length=20,
        choices=WatermarkPosition.choices,
        default=WatermarkPosition.DIAGONAL,
    )
    watermark_apply_to_previews = models.BooleanField(default=True)

    allow_duplicate_uploads = models.BooleanField(default=False)
    # When duplicates are blocked, a document sitting in Trash never counts as a
    # duplicate. With this on, re-uploading identical content also permanently
    # removes the uploader's trashed copy so no stale duplicate is left behind.
    purge_trashed_duplicates_on_reupload = models.BooleanField(default=False)
    signed_file_urls_enabled = models.BooleanField(
        default=False,
        help_text="Issue short-lived signed file URLs for browser contexts that cannot send Authorization headers.",
    )

    auto_archive_enabled = models.BooleanField(default=False)
    auto_archive_after_days = models.PositiveIntegerField(default=365)

    # Trash: automatically empty (permanently delete) documents that have sat in
    # Trash longer than the retention period.
    trash_auto_empty_enabled = models.BooleanField(default=False)
    trash_retention_days = models.PositiveIntegerField(default=30)

    # RBAC: when True, group permissions use a single global configuration that
    # applies across the whole document lifecycle (stage selection is hidden).
    # When False (default), permissions are configured per lifecycle stage.
    rbac_single_stage = models.BooleanField(default=False)

    require_metadata_on_upload = models.BooleanField(default=True)

    # Session policy — replaces the previously hardcoded ~6h logout. Two
    # independent controls:
    #   * session_lifetime_minutes  — absolute maximum a session may live from
    #     sign-in, regardless of activity. Enforced via the refresh-token
    #     lifetime and the frontend session clock.
    #   * session_idle_timeout_minutes — log a user out after this many minutes
    #     with no interaction. 0 disables the idle timeout (only the absolute
    #     lifetime applies).
    session_lifetime_minutes = models.PositiveIntegerField(
        default=360,
        help_text="Absolute maximum session duration from sign-in, in minutes.",
    )
    session_idle_timeout_minutes = models.PositiveIntegerField(
        default=30,
        help_text="Sign users out after this many minutes of inactivity. 0 disables the idle timeout.",
    )
    #   * session_warning_minutes — show a "session about to expire" warning this
    #     many minutes before sign-out, with an option to extend (idle case). 0
    #     disables the warning.
    session_warning_minutes = models.PositiveIntegerField(
        default=3,
        help_text="Warn users this many minutes before their session ends. 0 disables the warning.",
    )

    bulk_scan_submit_for_approval = models.BooleanField(
        default=False,
        help_text="When enabled, reviewed bulk scan documents are immediately submitted to approval workflows.",
    )
    access_stages = models.JSONField(
        default=list,
        blank=True,
        help_text="Admin-configurable document access stages used by group permissions.",
    )

    updated_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        null=True,
        blank=True,
        on_delete=models.SET_NULL,
        related_name="dms_settings_updates",
    )
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        verbose_name = "DMS settings"
        verbose_name_plural = "DMS settings"

    def save(self, *args, **kwargs):
        self.id = 1
        if self.watermark_opacity > 80:
            self.watermark_opacity = 80
        if self.auto_archive_after_days < 1:
            self.auto_archive_after_days = 1
        if self.trash_retention_days < 1:
            self.trash_retention_days = 1
        # Keep the session policy sane: an absolute lifetime of at least 5
        # minutes, and an idle timeout that never outlives that absolute cap.
        if self.session_lifetime_minutes < 5:
            self.session_lifetime_minutes = 5
        if self.session_idle_timeout_minutes < 0:
            self.session_idle_timeout_minutes = 0
        if self.session_idle_timeout_minutes > self.session_lifetime_minutes:
            self.session_idle_timeout_minutes = self.session_lifetime_minutes
        # The pre-expiry warning must fire within the session window, so cap it
        # at the absolute lifetime (the client further limits it to half the
        # relevant window so short timeouts don't warn the instant they begin).
        if self.session_warning_minutes > self.session_lifetime_minutes:
            self.session_warning_minutes = self.session_lifetime_minutes
        super().save(*args, **kwargs)

    @classmethod
    def load(cls) -> "DMSSettings":
        obj, _ = cls.objects.get_or_create(pk=1)
        return obj

    def __str__(self):
        return "DMS settings"


def document_upload_path(instance, filename):
    from django.utils import timezone
    year = timezone.now().year
    uploader_id = instance.uploaded_by_id or "unassigned"
    return os.path.join(
        "documents",
        instance.document_type.code,
        str(year),
        str(uploader_id),
        filename,
    )


class DocumentStatus(models.TextChoices):
    DRAFT             = "draft",             "Draft"
    PENDING_REVIEW    = "pending_review",    "Pending Review"
    PENDING_APPROVAL  = "pending_approval",  "Pending Approval"
    RETURNED          = "returned",         "Returned for Review"
    APPROVED          = "approved",          "Approved"
    REJECTED          = "rejected",          "Rejected"
    ARCHIVED          = "archived",          "Archived"
    VOID              = "void",              "Void"
    PENDING_SIGNATURE = "pending_signature", "Pending Signature"
    SIGNED            = "signed",            "Signed"


class OCRStatus(models.TextChoices):
    PENDING    = "pending",    "Pending"
    PROCESSING = "processing", "Processing"
    DONE       = "done",       "Done"
    FAILED     = "failed",     "Failed"


class PreviewStatus(models.TextChoices):
    PENDING    = "pending",    "Pending"
    PROCESSING = "processing", "Processing"
    DONE       = "done",       "Done"
    FAILED     = "failed",     "Failed"


class Document(models.Model):
    id               = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    title            = models.CharField(max_length=255)
    reference_number = models.CharField(max_length=60, unique=True, db_index=True)
    document_type    = models.ForeignKey(
        DocumentType, on_delete=models.PROTECT, related_name="documents"
    )
    status           = models.CharField(max_length=80, default=DocumentStatus.DRAFT, db_index=True)
    # Soft delete ("Trash"). A non-null deleted_at means the document is in Trash:
    # hidden from normal lists, restorable, and permanently removed by the
    # empty-trash job after the configured retention period.
    deleted_at       = models.DateTimeField(null=True, blank=True, db_index=True)
    deleted_by       = models.ForeignKey(
        settings.AUTH_USER_MODEL, null=True, blank=True,
        on_delete=models.SET_NULL, related_name="trashed_documents",
    )
    supplier         = models.CharField(max_length=255, blank=True, db_index=True)
    amount           = models.DecimalField(max_digits=18, decimal_places=2, null=True, blank=True)
    currency         = models.CharField(max_length=3, default="USD")
    document_date    = models.DateField(null=True, blank=True)
    due_date         = models.DateField(null=True, blank=True)
    file             = models.FileField(upload_to=document_upload_path)
    file_name        = models.CharField(max_length=255)
    file_size        = models.PositiveBigIntegerField(default=0)
    file_mime_type   = models.CharField(max_length=100, blank=True)
    checksum         = models.CharField(max_length=64, blank=True)
    metadata         = models.JSONField(default=dict, blank=True)
    tags             = models.ManyToManyField(Tag, blank=True, related_name="documents")
    department       = models.ForeignKey(
        "accounts.Department", null=True, blank=True,
        on_delete=models.SET_NULL, related_name="documents",
    )
    current_version  = models.PositiveSmallIntegerField(default=1)
    uploaded_by      = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.PROTECT, related_name="uploaded_documents"
    )
    owned_by         = models.ForeignKey(
        settings.AUTH_USER_MODEL, null=True, blank=True,
        on_delete=models.SET_NULL, related_name="owned_documents",
    )

    # ── Self-upload flag ──────────────────────────────────────────────────────
    is_self_upload = models.BooleanField(
        default=False, db_index=True,
        help_text="Personal/non-approval upload. Visible only to uploader and admins.",
    )

    # ── OCR fields ────────────────────────────────────────────────────────────
    is_scanned = models.BooleanField(
        default=False,
        db_index=True,
        help_text=(
            "True when the document is a scanned image or image-based PDF. "
            "The OCR pipeline runs automatically."
        ),
    )
    ocr_status = models.CharField(
        max_length=20,
        choices=OCRStatus.choices,
        blank=True,
        default="",
        db_index=True,
        help_text="Current state of the OCR text-extraction pipeline.",
    )
    bulk_upload = models.ForeignKey(
        "BulkUpload",
        null=True,
        blank=True,
        on_delete=models.SET_NULL,
        related_name="documents",
    )

    # ── Office preview fields ────────────────────────────────────────────────
    preview_pdf = models.FileField(
        upload_to="previews/",
        blank=True,
        null=True,
        help_text="LibreOffice-converted PDF for in-browser preview of Office documents.",
    )
    preview_status = models.CharField(
        max_length=20,
        choices=PreviewStatus.choices,
        blank=True,
        default="",
        db_index=True,
        help_text="Conversion state for Office → PDF preview pipeline.",
    )

    # ── Application-level edit lock fields ───────────────────────────────────
    edit_locked_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        null=True,
        blank=True,
        on_delete=models.SET_NULL,
        related_name="document_locks",
        help_text="User currently editing this document. Null when unlocked.",
    )
    edit_locked_at = models.DateTimeField(
        null=True,
        blank=True,
        help_text="When the edit lock was last refreshed.",
    )

    created_at     = models.DateTimeField(auto_now_add=True, db_index=True)
    updated_at     = models.DateTimeField(auto_now=True)
    extracted_text = models.TextField(blank=True)

    class Meta:
        ordering = ["-created_at"]
        indexes  = [
            models.Index(fields=["status", "document_type"]),
            models.Index(fields=["supplier", "document_date"]),
            models.Index(fields=["is_self_upload", "uploaded_by"]),
            models.Index(fields=["is_scanned", "ocr_status"]),
        ]

    def __str__(self):
        return f"[{self.reference_number}] {self.title}"

    def save(self, *args, **kwargs):
        # Default the document's department to the uploader's on first creation so
        # "department activity" reflects real org structure. It stays independently
        # re-assignable afterwards — this only fills it when blank at creation.
        if self._state.adding and self.department_id is None and self.uploaded_by_id:
            from apps.accounts.models import User
            self.department_id = (
                User.objects.filter(pk=self.uploaded_by_id)
                .values_list("department_id", flat=True)
                .first()
            )
        super().save(*args, **kwargs)

    def hard_delete(self):
        """Permanently remove the document, its versions, and their stored files."""
        import logging as _logging
        _log = _logging.getLogger(__name__)
        try:
            for version in self.versions.all():
                if version.file:
                    version.file.delete(save=False)
        except Exception:
            _log.exception("hard_delete: failed clearing version files for %s", self.id)
        try:
            if self.file:
                self.file.delete(save=False)
        except Exception:
            _log.exception("hard_delete: failed clearing file for %s", self.id)
        self.delete()

    def get_file_extension(self):
        return os.path.splitext(self.file_name)[1].lower()

    def is_pdf(self):
        return self.file_mime_type == "application/pdf" or self.get_file_extension() == ".pdf"

    def is_image(self):
        return (
            bool(self.file_mime_type) and self.file_mime_type.startswith("image/")
        ) or self.get_file_extension() in IMAGE_EXTENSIONS

    def is_office_doc(self):
        return (
            self.file_mime_type in OFFICE_MIME_TYPES
            or self.get_file_extension() in OFFICE_EXTENSIONS
        )

    @property
    def is_edit_locked(self) -> bool:
        if not self.edit_locked_by_id or not self.edit_locked_at:
            return False
        return self.edit_locked_at >= timezone.now() - timedelta(hours=1)

    @property
    def edit_lock_holder(self):
        if self.is_edit_locked:
            return self.edit_locked_by
        return None

    def acquire_lock(self, user):
        if self.is_edit_locked and self.edit_locked_by_id != user.id:
            return False
        self.edit_locked_by = user
        self.edit_locked_at = timezone.now()
        Document.objects.filter(id=self.id).update(
            edit_locked_by=user,
            edit_locked_at=self.edit_locked_at,
            updated_at=self.edit_locked_at,
        )
        return True

    def refresh_lock(self, user):
        if self.edit_locked_by_id != user.id:
            return False
        self.edit_locked_at = timezone.now()
        Document.objects.filter(id=self.id).update(
            edit_locked_at=self.edit_locked_at,
            updated_at=self.edit_locked_at,
        )
        return True

    def release_lock(self, user=None, force: bool = False):
        if not force and user and self.edit_locked_by_id and self.edit_locked_by_id != user.id:
            return False
        self.edit_locked_by = None
        self.edit_locked_at = None
        Document.objects.filter(id=self.id).update(
            edit_locked_by=None,
            edit_locked_at=None,
            updated_at=timezone.now(),
        )
        return True


class DocumentShare(models.Model):
    class AccessLevel(models.TextChoices):
        VIEW = "view", "View only"
        DOWNLOAD = "download", "View and download"

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    document = models.ForeignKey(Document, on_delete=models.CASCADE, related_name="shares")
    shared_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.PROTECT,
        related_name="document_shares_created",
    )
    recipient = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name="document_shares_received",
    )
    access_level = models.CharField(
        max_length=20,
        choices=AccessLevel.choices,
        default=AccessLevel.VIEW,
    )
    message = models.TextField(blank=True)
    expires_at = models.DateTimeField(null=True, blank=True)
    revoked_at = models.DateTimeField(null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["-created_at"]
        unique_together = [("document", "recipient")]
        indexes = [
            models.Index(fields=["recipient", "revoked_at", "expires_at"]),
            models.Index(fields=["document", "revoked_at"]),
        ]

    @property
    def is_active(self) -> bool:
        if self.revoked_at:
            return False
        return self.expires_at is None or self.expires_at > timezone.now()


class DocumentRelationship(models.Model):
    class RelationType(models.TextChoices):
        SUPPORTS = "supports", "Supports"
        REFERENCES = "references", "References"
        SUPERSEDES = "supersedes", "Supersedes"
        LINKED_TO = "linked-to", "Linked to"

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    source_document = models.ForeignKey(
        Document,
        on_delete=models.CASCADE,
        related_name="outgoing_relationships",
    )
    target_document = models.ForeignKey(
        Document,
        on_delete=models.CASCADE,
        related_name="incoming_relationships",
    )
    relation_type = models.CharField(max_length=30, choices=RelationType.choices)
    note = models.TextField(blank=True)
    created_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.PROTECT,
        related_name="document_relationships_created",
    )
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["relation_type", "-created_at"]
        unique_together = [("source_document", "target_document", "relation_type")]
        indexes = [
            models.Index(fields=["source_document", "relation_type"]),
            models.Index(fields=["target_document", "relation_type"]),
        ]

    def __str__(self):
        return (
            f"{self.source_document.reference_number} "
            f"{self.relation_type} {self.target_document.reference_number}"
        )


class DocumentVersion(models.Model):
    id             = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    document       = models.ForeignKey(Document, on_delete=models.CASCADE, related_name="versions")
    version_number = models.PositiveSmallIntegerField()
    file           = models.FileField(upload_to="versions/")
    file_name      = models.CharField(max_length=255)
    file_size      = models.PositiveBigIntegerField()
    checksum       = models.CharField(max_length=64)
    change_summary = models.TextField(blank=True)
    created_by     = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.PROTECT, related_name="document_versions"
    )
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering        = ["-version_number"]
        unique_together = [("document", "version_number")]

    def __str__(self):
        return f"{self.document.reference_number} v{self.version_number}"

    def get_file_extension(self):
        return os.path.splitext(self.file_name or getattr(self.file, "name", ""))[1].lower()

    def is_pdf(self):
        return self.get_file_extension() == ".pdf"

    def is_image(self):
        return self.get_file_extension() in IMAGE_EXTENSIONS

    def is_office_doc(self):
        return self.get_file_extension() in OFFICE_EXTENSIONS


class DocumentComment(models.Model):
    id          = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    document    = models.ForeignKey(Document, on_delete=models.CASCADE, related_name="comments")
    author      = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT)
    content     = models.TextField()
    is_internal = models.BooleanField(default=False)
    created_at  = models.DateTimeField(auto_now_add=True)
    updated_at  = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["created_at"]

# user-created folder hierarchy and document favourites.

class DocumentFolder(models.Model):
    """
    User-owned folder / subfolder tree for organising documents.
 
    - Folders are always owned by a single user (private by default).
    - Nesting is unlimited but UI enforces max depth of 5 for UX sanity.
    - A document can live in multiple folders (M2M via DocumentFolderItem).
    - `is_favourites` marks the system-created "Favourites" root folder that
      is auto-provisioned for every user on first use.
    """
 
    id         = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    owner      = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name="document_folders",
    )
    parent     = models.ForeignKey(
        "self",
        null=True,
        blank=True,
        on_delete=models.CASCADE,
        related_name="children",
    )
    name       = models.CharField(max_length=120)
    color      = models.CharField(max_length=7, default="#6366f1", blank=True)
    icon       = models.CharField(max_length=40, default="folder", blank=True)
 
    # System folders cannot be deleted or renamed by the user.
    is_favourites = models.BooleanField(
        default=False,
        help_text="True for the auto-created Favourites folder.",
    )
    is_system  = models.BooleanField(
        default=False,
        help_text="True for any system-managed folder (Favourites included).",
    )
 
    position   = models.PositiveSmallIntegerField(
        default=0,
        help_text="Sort order within the parent level.",
    )
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)
 
    class Meta:
        ordering        = ["position", "name"]
        unique_together = [("owner", "parent", "name")]
        indexes         = [
            models.Index(fields=["owner", "parent"]),
            models.Index(fields=["owner", "is_favourites"]),
        ]
 
    def __str__(self):
        return f"{self.owner_id}/{self.name}"
 
    @property
    def depth(self) -> int:
        """0 = root folder. Max UI-allowed depth is 4 (5 levels total)."""
        d, node = 0, self
        while node.parent_id:
            d += 1
            node = node.parent
        return d
 
    @classmethod
    def get_or_create_favourites(cls, user) -> "DocumentFolder":
        folder, _ = cls.objects.get_or_create(
            owner=user,
            is_favourites=True,
            defaults={
                "name": "Favourites",
                "icon": "star",
                "color": "#f59e0b",
                "is_system": True,
                "parent": None,
                "position": 0,
            },
        )
        return folder
 
 
class DocumentFolderItem(models.Model):
    """
    Many-to-many join between a folder and a document.
    Carries an optional per-user sort position.
    """
 
    id         = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    folder     = models.ForeignKey(
        DocumentFolder,
        on_delete=models.CASCADE,
        related_name="items",
    )
    document   = models.ForeignKey(
        "Document",
        on_delete=models.CASCADE,
        related_name="folder_items",
    )
    added_by   = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name="folder_items",
    )
    position   = models.PositiveSmallIntegerField(default=0)
    added_at   = models.DateTimeField(auto_now_add=True)
 
    class Meta:
        ordering        = ["position", "added_at"]
        unique_together = [("folder", "document")]
        indexes         = [
            models.Index(fields=["folder", "position"]),
        ]
 
    def __str__(self):
        return f"{self.folder.name} ← {self.document.reference_number}"
 
 
class DocumentFavourite(models.Model):
    """
    Lightweight shortcut model — a document the user has explicitly starred.
 
    This is separate from DocumentFolderItem so that:
      • starring a document works with a single POST (no folder ID needed)
      • the Favourites folder auto-reflects the starred set
      • future "quick-access" counts / sorting can be stored here
 
    The Favourites folder (DocumentFolder.is_favourites=True) is kept in
    sync via post_save / post_delete signals at the bottom of this file.
    """
 
    id         = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    user       = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name="document_favourites",
    )
    document   = models.ForeignKey(
        "Document",
        on_delete=models.CASCADE,
        related_name="favourited_by",
    )
    access_count = models.PositiveIntegerField(
        default=0,
        help_text="Incremented each time the user opens this document.",
    )
    added_at   = models.DateTimeField(auto_now_add=True)
    last_accessed = models.DateTimeField(null=True, blank=True)
 
    class Meta:
        ordering        = ["-added_at"]
        unique_together = [("user", "document")]
        indexes         = [
            models.Index(fields=["user", "added_at"]),
            models.Index(fields=["user", "access_count"]),
        ]
 
    def __str__(self):
        return f"{self.user_id} ★ {self.document.reference_number}"
 
    def record_access(self):
        """Call whenever the user opens the document to track frequency."""
        from django.utils import timezone as tz
        DocumentFavourite.objects.filter(id=self.id).update(
            access_count=models.F("access_count") + 1,
            last_accessed=tz.now(),
        )
 
 
# ─── Signals — keep Favourites folder in sync with DocumentFavourite ──────────
 
from django.db.models.signals import post_save, post_delete
from django.dispatch import receiver
 
 
@receiver(post_save, sender=DocumentFavourite)
def _sync_favourite_to_folder_on_save(sender, instance, created, **kwargs):
    if not created:
        return
    folder = DocumentFolder.get_or_create_favourites(instance.user)
    DocumentFolderItem.objects.get_or_create(
        folder=folder,
        document=instance.document,
        defaults={"added_by": instance.user},
    )
 
 
class BulkUploadStatus(models.TextChoices):
    PENDING = "pending", "Pending"
    UPLOADING = "uploading", "Uploading"
    PROCESSING = "processing", "Processing"
    REVIEW = "review", "Review"
    COMPLETED = "completed", "Completed"
    FAILED = "failed", "Failed"


class BulkUpload(models.Model):
    class Mode(models.TextChoices):
        SAME_TYPE = "same_type", "Same document type"
        RELATED_SET = "related_set", "Related document set"

    """
    Tracks a batch upload operation for multiple documents.
    
    Allows users to upload multiple files of the same document type,
    process them with OCR, then review and approve/reject before final submission.
    """
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    document_type = models.ForeignKey(
        DocumentType, on_delete=models.PROTECT, related_name="bulk_uploads"
    )
    uploaded_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.PROTECT, related_name="bulk_uploads"
    )
    mode = models.CharField(
        max_length=20,
        choices=Mode.choices,
        default=Mode.SAME_TYPE,
        db_index=True,
    )
    shared_metadata = models.JSONField(default=dict, blank=True)
    status = models.CharField(
        max_length=20,
        choices=BulkUploadStatus.choices,
        default=BulkUploadStatus.PENDING,
        db_index=True,
    )
    total_files = models.PositiveSmallIntegerField(default=0)
    successful_uploads = models.PositiveSmallIntegerField(default=0)
    failed_uploads = models.PositiveSmallIntegerField(default=0)
    approved_count = models.PositiveSmallIntegerField(default=0)
    rejected_count = models.PositiveSmallIntegerField(default=0)
    
    # Optional: common tags to apply to all documents in the batch
    common_tags = models.ManyToManyField(Tag, blank=True, related_name="bulk_uploads")
    
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)
    
    class Meta:
        ordering = ["-created_at"]
        indexes = [
            models.Index(fields=["status", "uploaded_by"]),
        ]
    
    def __str__(self):
        return f"BulkUpload {self.id} - {self.document_type.name} ({self.status})"
    
    @property
    def progress_percentage(self) -> float:
        if self.total_files == 0:
            return 0.0
        return (self.successful_uploads / self.total_files) * 100


@receiver(post_delete, sender=DocumentFavourite)
def _sync_favourite_to_folder_on_delete(sender, instance, **kwargs):
    try:
        folder = DocumentFolder.objects.get(owner=instance.user, is_favourites=True)
        DocumentFolderItem.objects.filter(
            folder=folder, document=instance.document
        ).delete()
    except DocumentFolder.DoesNotExist:
        pass


# ── Ad-hoc signature requests ──────────────────────────────────────────────────

SIGNATURE_REQUEST_DOCUMENT_TYPE_CODE = "SIGREQ"


def get_signature_request_document_type() -> "DocumentType":
    """A hidden system document type for ad-hoc signature-request documents, so
    the uploader never has to pick a type. Mirrors the bulk UNCLASS pattern."""
    doc_type, _ = DocumentType.objects.get_or_create(
        code=SIGNATURE_REQUEST_DOCUMENT_TYPE_CODE,
        defaults={
            "name": "Signature request",
            "reference_prefix": "SIG",
            "reference_padding": 5,
            "description": "System type for ad-hoc 'Request signature' documents.",
            "icon": "file-signature",
            "metadata_mode": DocumentType.MetadataMode.USER_DEFINED,
            "is_active": True,
        },
    )
    return doc_type


class SignatureRequest(models.Model):
    class Status(models.TextChoices):
        PENDING   = "pending",   "Pending signatures"
        COMPLETED = "completed", "Fully signed"
        DECLINED  = "declined",  "Declined"
        CANCELLED = "cancelled", "Cancelled"

    id           = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    document     = models.OneToOneField(
        Document, on_delete=models.CASCADE, related_name="signature_request"
    )
    requested_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="signature_requests"
    )
    ordered      = models.BooleanField(
        default=False,
        help_text="If true, signers sign sequentially by order; otherwise any order.",
    )
    message      = models.TextField(blank=True)
    status       = models.CharField(
        max_length=20, choices=Status.choices, default=Status.PENDING, db_index=True
    )
    created_at   = models.DateTimeField(auto_now_add=True)
    completed_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        ordering = ["-created_at"]

    def __str__(self):
        return f"Signature request for {self.document_id} ({self.status})"

    def current_pending_signers(self):
        """Signers who can sign right now: for ordered requests, only the lowest
        outstanding order; for unordered, every pending signer."""
        pending = self.signers.filter(status=SignatureRequestSigner.Status.PENDING).order_by("order")
        if not self.ordered:
            return list(pending)
        first = pending.first()
        if not first:
            return []
        return list(pending.filter(order=first.order))


class SignatureRequestSigner(models.Model):
    class Status(models.TextChoices):
        PENDING  = "pending",  "Pending"
        SIGNED   = "signed",   "Signed"
        DECLINED = "declined", "Declined"

    id            = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    request       = models.ForeignKey(
        SignatureRequest, on_delete=models.CASCADE, related_name="signers"
    )
    signer        = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="signature_assignments"
    )
    order         = models.PositiveSmallIntegerField(default=0)
    status        = models.CharField(
        max_length=20, choices=Status.choices, default=Status.PENDING, db_index=True
    )
    signed_at     = models.DateTimeField(null=True, blank=True)
    decline_reason = models.TextField(blank=True)
    placement     = models.JSONField(null=True, blank=True)

    class Meta:
        ordering        = ["order", "id"]
        unique_together = [("request", "signer")]
        indexes = [
            # Backs the incoming-signature badge count (signer + status filter),
            # polled by the app shell.
            models.Index(fields=["signer", "status"]),
        ]

    def __str__(self):
        return f"{self.signer_id} → {self.request_id} ({self.status})"


class MigrationJobStatus(models.TextChoices):
    """Lifecycle of an Infor IDM → fseDMS migration run."""
    DRAFT      = "draft",      "Draft"
    QUEUED     = "queued",     "Queued"
    RUNNING    = "running",    "Running"
    COMPLETED  = "completed",  "Completed"
    PARTIAL    = "partial",    "Completed with errors"
    FAILED     = "failed",     "Failed"
    CANCELLED  = "cancelled",  "Cancelled"


class MigrationJob(models.Model):
    """
    A migration of documents from Infor IDM (reached over the ION API) into
    this DMS.

    The job owns three concerns:

    * **connection** – the ION API credentials/endpoints used to reach IDM.
      Stored as JSON so the exact shape can evolve as we learn the real ION
      tenant configuration. Secret values (``client_secret``/``password``/
      ``sask``) are write-only at the API layer and redacted on read.
    * **selection** – ``source_query`` is the IDM query (AQL/OData-style) that
      decides *which* documents are pulled. Empty means "the connector's
      default", which the client may interpret as "everything it can list".
    * **mapping & results** – ``target_document_type`` is the fseDMS type that
      imported documents are filed under (a single fallback type for now;
      per-IDM-type mapping can be layered on later). ``include_attributes``
      controls whether IDM attributes are copied into ``Document.metadata``.
      The running task updates the counters and appends per-item outcomes to
      ``log`` so the UI can show progress and surface failures.

    NB: actual IDM field/attribute mapping is intentionally thin and lives in
    ``apps.documents.migration`` so it can be tuned once the real ION response
    shapes are confirmed.
    """

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    name = models.CharField(max_length=200)

    connection = models.JSONField(
        default=dict,
        blank=True,
        help_text=(
            "ION API connection settings: api_url, tenant, token_url, "
            "client_id, client_secret, saak, sask, scope, etc."
        ),
    )
    source_query = models.TextField(
        blank=True,
        help_text="IDM query selecting which documents to migrate. Empty = connector default.",
    )

    target_document_type = models.ForeignKey(
        DocumentType,
        null=True,
        blank=True,
        on_delete=models.SET_NULL,
        related_name="migration_jobs",
        help_text="fseDMS document type imported documents are filed under.",
    )
    include_attributes = models.BooleanField(
        default=True,
        help_text="Copy IDM attributes/metadata into each imported document's metadata.",
    )
    # Hard cap so an exploratory run can't accidentally pull an entire archive.
    max_documents = models.PositiveIntegerField(
        default=0,
        help_text="Optional ceiling on documents imported in one run. 0 = no limit.",
    )

    status = models.CharField(
        max_length=20,
        choices=MigrationJobStatus.choices,
        default=MigrationJobStatus.DRAFT,
        db_index=True,
    )

    total_items     = models.PositiveIntegerField(default=0)
    processed_items = models.PositiveIntegerField(default=0)
    succeeded_items = models.PositiveIntegerField(default=0)
    failed_items    = models.PositiveIntegerField(default=0)
    skipped_items   = models.PositiveIntegerField(default=0)

    # Append-only list of {ion_id, reference_number?, status, detail} dicts.
    log   = models.JSONField(default=list, blank=True)
    error = models.TextField(blank=True)

    created_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        null=True,
        on_delete=models.SET_NULL,
        related_name="migration_jobs",
    )
    created_at  = models.DateTimeField(auto_now_add=True)
    updated_at  = models.DateTimeField(auto_now=True)
    started_at  = models.DateTimeField(null=True, blank=True)
    finished_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        ordering = ["-created_at"]
        indexes = [
            models.Index(fields=["status", "created_at"]),
        ]

    def __str__(self):
        return f"MigrationJob {self.name} ({self.status})"

    def append_log(self, entry: dict) -> None:
        """Append one per-item outcome. Caller is responsible for saving."""
        log = list(self.log or [])
        log.append(entry)
        self.log = log


# ── Email ingestion ────────────────────────────────────────────────────────────

class MailboxPollStatus(models.TextChoices):
    """Outcome of the most recent poll of a mailbox."""
    IDLE    = "idle",    "Idle"
    POLLING = "polling", "Polling"
    OK      = "ok",      "Last poll succeeded"
    ERROR   = "error",   "Last poll failed"


class Mailbox(models.Model):
    """
    An IMAP mailbox the system watches for inbound documents.

    Email ingestion is the server-side sibling of an upload: a poll connects to
    the mailbox, pulls unseen messages, and turns each message's attachments
    into ``DocumentStatus.DRAFT`` documents that land in the bulk-upload review
    queue. A human confirms the document type and metadata there before the
    normal amount-threshold workflow rules pick an approval template — email
    metadata is machine-guessed, so it never auto-starts a workflow.

    Configuration mirrors :class:`MigrationJob`:

    * **connection** – IMAP settings as JSON so the shape can evolve. The
      ``password`` is write-only at the API layer (accepted on save, redacted on
      read), exactly like the ION ``sask``.
    * **routing** – ``default_document_type`` files every attachment under one
      type (the reliable, zero-ML path: one mailbox per type). When null,
      attachments land under the shared ``UNCLASS`` placeholder for the reviewer
      to classify. ``auto_classify`` is an opt-in hook for inferring the type
      from content; until a classifier is wired it falls back to the default.
    * **enrichment** – ``sender_supplier_map`` pre-fills the supplier from the
      sender address/domain (structured data the OCR can't match as reliably).
    * **related_set_attachments** – when an email carries several attachments
      (e.g. an invoice with its PO and delivery note), import them as one
      related set so the reviewer sees them together.

    Per-message state and idempotency live on :class:`IngestedEmail`; this model
    only carries connection, routing, and last-poll bookkeeping.
    """

    class Protocol(models.TextChoices):
        IMAP  = "imap",  "IMAP"
        GRAPH = "graph", "Microsoft Graph"

    id   = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    name = models.CharField(max_length=200)

    protocol = models.CharField(
        max_length=10,
        choices=Protocol.choices,
        default=Protocol.IMAP,
        db_index=True,
        help_text="Mail backend used to reach this mailbox.",
    )
    connection = models.JSONField(
        default=dict,
        blank=True,
        help_text=(
            "Connection settings. IMAP: host, port, use_ssl, username, password, "
            "folder. Microsoft Graph: tenant_id, client_id, client_secret, "
            "mailbox (user principal name), folder."
        ),
    )

    default_document_type = models.ForeignKey(
        DocumentType,
        null=True,
        blank=True,
        on_delete=models.SET_NULL,
        related_name="mailboxes",
        help_text="Document type imported attachments are filed under. Null = UNCLASS placeholder.",
    )
    auto_classify = models.BooleanField(
        default=False,
        help_text="Attempt to infer the document type from content instead of always using the default.",
    )
    sender_supplier_map = models.JSONField(
        default=dict,
        blank=True,
        help_text="Map of sender email/domain -> supplier name, used to pre-fill the supplier field.",
    )
    sender_allowlist = models.JSONField(
        default=list,
        blank=True,
        help_text=(
            "If non-empty, only emails whose sender address/domain appears here "
            "are ingested; everything else is skipped. Empty = accept all senders."
        ),
    )
    related_set_attachments = models.BooleanField(
        default=True,
        help_text="Import a multi-attachment email as one related document set.",
    )
    allowed_attachment_extensions = models.JSONField(
        default=list,
        blank=True,
        help_text=(
            "If non-empty, only attachments with these file extensions are "
            "imported (e.g. ['pdf', 'png']); others are ignored. Empty = all."
        ),
    )
    ingest_history = models.BooleanField(
        default=False,
        help_text=(
            "Import messages already in the mailbox at the time it is created. "
            "Off (default) ingests only mail that arrives afterwards, so a busy "
            "existing inbox doesn't pull its whole backlog on the first poll."
        ),
    )
    ingest_since = models.DateField(
        null=True,
        blank=True,
        help_text="Only import messages received on or after this date. Blank = no date limit.",
    )
    # Defence against an exploratory poll dragging in a huge backlog at once.
    max_messages_per_poll = models.PositiveIntegerField(
        default=50,
        help_text="Ceiling on messages processed in one poll. 0 = no limit.",
    )

    auto_poll = models.BooleanField(
        default=False,
        db_index=True,
        help_text=(
            "When on (and the mailbox is active), Celery beat polls this mailbox "
            "on ``poll_interval_seconds``. Off = manual poll only."
        ),
    )
    poll_interval_seconds = models.PositiveIntegerField(
        default=300,
        help_text="How often to auto-poll this mailbox, in seconds. Ignored when auto_poll is off.",
    )

    is_active = models.BooleanField(
        default=True,
        db_index=True,
        help_text="Inactive mailboxes are never polled (manual or scheduled).",
    )

    reviewers = models.ManyToManyField(
        settings.AUTH_USER_MODEL,
        blank=True,
        related_name="review_mailboxes",
        help_text=(
            "Users who see this mailbox's ingested batches in the pending-review "
            "queue. Empty = mailbox owner and admins."
        ),
    )

    poll_status   = models.CharField(
        max_length=20,
        choices=MailboxPollStatus.choices,
        default=MailboxPollStatus.IDLE,
        db_index=True,
    )
    last_polled_at = models.DateTimeField(null=True, blank=True)
    last_error     = models.TextField(blank=True)
    # IMAP UID of the highest message seen, so each poll only fetches newer mail.
    last_seen_uid  = models.PositiveBigIntegerField(default=0)
    # Microsoft Graph cursor: ISO receivedDateTime of the last message processed
    # (Graph has no monotonic UID). Empty until the first Graph poll runs.
    last_seen_cursor = models.CharField(max_length=64, blank=True, default="")

    # Aggregate counters for the most recent poll (per-email detail is on IngestedEmail).
    last_imported_count = models.PositiveIntegerField(default=0)
    last_skipped_count  = models.PositiveIntegerField(default=0)
    last_failed_count   = models.PositiveIntegerField(default=0)
    # Number of consecutive failed polls; reset to 0 on any success. Used to
    # alert the owner once per outage rather than on every failed poll.
    consecutive_failures = models.PositiveIntegerField(default=0)

    created_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        null=True,
        on_delete=models.SET_NULL,
        related_name="mailboxes",
        help_text="Admin who configured the mailbox (fallback reviewer when none are set).",
    )
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["name"]
        verbose_name_plural = "mailboxes"
        indexes = [
            models.Index(fields=["is_active", "poll_status"]),
            models.Index(fields=["is_active", "auto_poll"]),
        ]

    def __str__(self):
        return f"Mailbox {self.name}"

    def supplier_for_sender(self, sender: str) -> str:
        """Resolve a supplier name from a sender address via ``sender_supplier_map``.

        Matches the full address first (``billing@acme.com``), then the bare
        domain (``acme.com``). Matching is case-insensitive. Returns "" when no
        rule applies, so the reviewer/OCR fills supplier instead.
        """
        if not sender or not isinstance(self.sender_supplier_map, dict):
            return ""
        addr = sender.strip().lower()
        lookup = {str(k).strip().lower(): v for k, v in self.sender_supplier_map.items()}
        if addr in lookup:
            return str(lookup[addr] or "")
        domain = addr.rsplit("@", 1)[-1] if "@" in addr else addr
        return str(lookup.get(domain, "") or "")

    def attachment_allowed(self, filename: str) -> bool:
        """Whether an attachment's extension passes the per-mailbox filter.

        An empty filter accepts everything (the default). Extensions are matched
        case-insensitively, with or without a leading dot.
        """
        allowed = [
            str(x).strip().lower().lstrip(".")
            for x in (self.allowed_attachment_extensions or [])
            if str(x).strip()
        ]
        if not allowed:
            return True
        ext = os.path.splitext(filename or "")[1].lower().lstrip(".")
        return ext in allowed

    def is_sender_allowed(self, sender: str) -> bool:
        """Whether a sender passes the allowlist.

        An empty allowlist accepts everyone (the default). Otherwise the sender's
        full address (``ap@acme.com``) or bare domain (``acme.com``) must appear
        in the list. Matching is case-insensitive.
        """
        allow = [str(x).strip().lower() for x in (self.sender_allowlist or []) if str(x).strip()]
        if not allow:
            return True
        if not sender:
            return False
        addr = sender.strip().lower()
        domain = addr.rsplit("@", 1)[-1] if "@" in addr else addr
        return addr in allow or domain in allow


class IngestedEmail(models.Model):
    """
    Record of one email processed by a :class:`Mailbox` poll.

    Two jobs:

    * **idempotency** – polls re-see messages, so ``message_id`` is unique per
      mailbox; a message already recorded is never imported twice. (Attachment
      content is additionally deduped by ``Document.checksum`` downstream.)
    * **audit/provenance** – keeps the sender/subject/received metadata and the
      original ``.eml`` for compliance, and links to the ``BulkUpload`` whose
      review queue the resulting drafts landed in.
    """

    class Status(models.TextChoices):
        IMPORTED = "imported", "Imported"
        SKIPPED  = "skipped",  "Skipped"
        PARTIAL  = "partial",  "Imported with errors"
        FAILED   = "failed",   "Failed"

    id      = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    mailbox = models.ForeignKey(
        Mailbox, on_delete=models.CASCADE, related_name="ingested_emails"
    )

    message_id  = models.CharField(max_length=512, db_index=True)
    imap_uid    = models.PositiveBigIntegerField(default=0)
    sender      = models.CharField(max_length=320, blank=True)
    subject     = models.CharField(max_length=512, blank=True)
    received_at = models.DateTimeField(null=True, blank=True)

    raw_email = models.FileField(
        upload_to="ingested_emails/",
        blank=True,
        null=True,
        help_text="Original RFC-822 message stored for compliance/audit.",
    )

    status            = models.CharField(
        max_length=20, choices=Status.choices, default=Status.IMPORTED, db_index=True
    )
    attachment_count  = models.PositiveSmallIntegerField(default=0)
    documents_created = models.PositiveSmallIntegerField(default=0)
    detail            = models.TextField(blank=True)

    bulk_upload = models.ForeignKey(
        "BulkUpload",
        null=True,
        blank=True,
        on_delete=models.SET_NULL,
        related_name="ingested_emails",
    )

    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["-created_at"]
        constraints = [
            models.UniqueConstraint(
                fields=["mailbox", "message_id"],
                name="uniq_mailbox_message_id",
            ),
        ]
        indexes = [
            models.Index(fields=["mailbox", "status"]),
        ]

    def __str__(self):
        return f"IngestedEmail {self.message_id} ({self.status})"
