"""
apps/documents/models.py

Changes from previous version:
  1. Document.is_self_upload — personal/non-approval upload flag.
     When True the document bypasses workflow; visible only to uploader + admins.
     All existing logic is preserved exactly; only the new field is added.
"""
from django.db import models
from django.conf import settings
import uuid
import os


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
        pad = str(seq).zfill(self.reference_padding)
        return f"{self.reference_prefix}-{pad}"


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


class Document(models.Model):
    id               = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    title            = models.CharField(max_length=255)
    reference_number = models.CharField(max_length=60, unique=True, db_index=True)
    document_type    = models.ForeignKey(
        DocumentType, on_delete=models.PROTECT, related_name="documents"
    )
    # status stores both DocumentStatus choices AND free-form step status_labels
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
    # When True: personal/non-approval document.
    #   - Visible only to the uploader and administrators.
    #   - Cannot be submitted into a workflow.
    #   - Text extraction and search indexing still run (owner can search their own docs).
    is_self_upload = models.BooleanField(
        default=False,
        db_index=True,
        help_text=(
            "Personal/non-approval upload. "
            "Visible only to the uploader and administrators; "
            "cannot enter a workflow approval process."
        ),
    )

    created_at     = models.DateTimeField(auto_now_add=True, db_index=True)
    updated_at     = models.DateTimeField(auto_now=True)
    extracted_text = models.TextField(blank=True)

    class Meta:
        ordering = ["-created_at"]
        indexes  = [
            models.Index(fields=["status", "document_type"]),
            models.Index(fields=["supplier", "document_date"]),
            models.Index(fields=["is_self_upload", "uploaded_by"]),  # fast personal-doc lookup
        ]

    def __str__(self):
        return f"[{self.reference_number}] {self.title}"

    def get_file_extension(self):
        return os.path.splitext(self.file_name)[1].lower()

    def is_pdf(self):
        return self.file_mime_type == "application/pdf"

    def is_office_doc(self):
        return self.file_mime_type in (
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            "application/msword",
            "application/vnd.ms-excel",
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