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
    metadata_mode    = models.CharField(
        max_length=32,
        choices=MetadataMode.choices,
        default=MetadataMode.ADMIN_DEFINED,
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


class Tag(models.Model):
    id    = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    name  = models.CharField(max_length=60, unique=True)
    color = models.CharField(max_length=7, default="#6366f1")

    def __str__(self):
        return self.name


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
    DRAFT            = "draft",            "Draft"
    PENDING_REVIEW   = "pending_review",   "Pending Review"
    PENDING_APPROVAL = "pending_approval", "Pending Approval"
    RETURNED         = "returned",        "Returned for Review"
    APPROVED         = "approved",         "Approved"
    REJECTED         = "rejected",         "Rejected"
    ARCHIVED         = "archived",         "Archived"
    VOID             = "void",             "Void"


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
