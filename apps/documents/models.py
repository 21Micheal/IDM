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
    return os.path.join("documents", instance.document_type.code, str(year), filename)


class DocumentStatus(models.TextChoices):
    DRAFT            = "draft",            "Draft"
    PENDING_REVIEW   = "pending_review",   "Pending Review"
    PENDING_APPROVAL = "pending_approval", "Pending Approval"
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
