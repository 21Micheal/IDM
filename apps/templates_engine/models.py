from django.db import models
from django.conf import settings
import uuid


class DocumentTemplate(models.Model):
    TYPE_CHOICES = [
        ("built", "Builder-designed"),
        ("uploaded", "Office file with placeholders"),
    ]

    CATEGORY_CHOICES = [
        ("finance", "Finance & Accounting"),
        ("hr", "Human Resources"),
        ("procurement", "Procurement"),
        ("legal", "Legal & Compliance"),
        ("operations", "Operations"),
        ("admin", "Administration"),
        ("other", "Other"),
    ]

    KIND_CHOICES = [
        ("form", "Interactive form (data entry)"),
        ("document", "WYSIWYG document layout"),
    ]

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    name = models.CharField(max_length=200)
    description = models.TextField(blank=True)
    type = models.CharField(max_length=20, choices=TYPE_CHOICES, default="built")
    # Distinguishes the two "built" sub-kinds: "form" uses `sections` (interactive
    # form filled in-app); "document" uses `design` (block layout rendered to an
    # editable file). Ignored for type="uploaded".
    kind = models.CharField(
        max_length=20, choices=KIND_CHOICES, default="form", db_index=True
    )
    document_type = models.ForeignKey(
        "documents.DocumentType",
        on_delete=models.PROTECT,
        related_name="document_templates",
        null=True,
        blank=True,
        help_text="Document type this template can create documents for.",
    )
    category = models.CharField(
        max_length=30, choices=CATEGORY_CHOICES, default="other", db_index=True
    )
    tags = models.JSONField(default=list, blank=True)

    # For type="built": the entire template structure is stored here.
    # Shape: { "sections": [ { "id", "title", "description", "fields": [...] } ] }
    # Each field: { "id", "type", "label", "key", "required", "width",
    #              "options", "columns", "placeholder", "help_text" }
    sections = models.JSONField(default=list, blank=True)

    # For type="built", kind="document": the WYSIWYG designer layout.
    # Shape: { "page", "theme", "header", "footer", "blocks": [...] }
    design = models.JSONField(default=dict, blank=True)

    # For type="uploaded": the original DOCX/XLSX/PPTX file
    file = models.FileField(
        upload_to="templates/source/", null=True, blank=True
    )
    file_name = models.CharField(max_length=255, blank=True)

    # Auto-detected placeholder keys from the uploaded file
    # e.g. ["supplier_name", "invoice_date", "amount"]
    placeholders = models.JSONField(default=list, blank=True)

    # Infor SunSystems integration mapping for "form" templates. Declarative
    # config compiled into an <SSC> journal (and budget inquiry) by
    # apps/sunsystems/mapping.py. Snapshotted onto each created document's
    # metadata.sunsystems at fill time. Shape: { "journal": {...}, "budget": {...},
    # "connection": {...} }. Empty = no SunSystems integration for this template.
    sunsystems = models.JSONField(default=dict, blank=True)

    # How many times this template has been used to create a document
    use_count = models.PositiveIntegerField(default=0)

    is_active = models.BooleanField(default=True)
    created_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.PROTECT,
        related_name="created_templates",
    )
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["-updated_at"]
        indexes = [
            models.Index(fields=["type", "is_active"]),
            models.Index(fields=["category", "is_active"]),
            models.Index(fields=["document_type", "is_active"]),
        ]

    def __str__(self):
        return self.name


class TemplateUsage(models.Model):
    """
    Records every time a template was used to create a document.
    Drives the use_count denorm and provides audit trail.
    """
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    template = models.ForeignKey(
        DocumentTemplate, on_delete=models.CASCADE, related_name="usages"
    )
    document = models.ForeignKey(
        "documents.Document", on_delete=models.CASCADE, related_name="template_usages"
    )
    used_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.PROTECT
    )
    values = models.JSONField(default=dict)  # snapshot of filled values
    output_format = models.CharField(max_length=10, default="pdf")
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["-created_at"]
