"""
apps/documents/migrations/0005_document_office_preview.py

Adds two fields to Document:
  - preview_pdf     FileField  — stores the LibreOffice-converted PDF
  - preview_status  CharField  — tracks the conversion pipeline state
"""
from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("documents", "0005_alter_document_is_scanned_and_more"),
    ]

    operations = [
        migrations.AddField(
            model_name="document",
            name="preview_pdf",
            field=models.FileField(
                upload_to="previews/",
                blank=True,
                null=True,
                help_text="LibreOffice-converted PDF for in-browser preview of Office documents.",
            ),
        ),
        migrations.AddField(
            model_name="document",
            name="preview_status",
            field=models.CharField(
                max_length=20,
                blank=True,
                default="",
                db_index=True,
                choices=[
                    ("pending",    "Pending"),
                    ("processing", "Processing"),
                    ("done",       "Done"),
                    ("failed",     "Failed"),
                ],
                help_text="Conversion state for Office → PDF preview pipeline.",
            ),
        ),
    ]
