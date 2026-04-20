"""
apps/documents/migrations/0004_document_ocr_fields.py

Adds two fields to Document:
  - is_scanned:  explicitly marks a document as a scanned/image-based file
  - ocr_status:  tracks async OCR pipeline state
"""
from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("documents", "0003_document_self_upload"),  # adjust to your last migration
    ]

    operations = [
        migrations.AddField(
            model_name="document",
            name="is_scanned",
            field=models.BooleanField(
                default=False,
                db_index=True,
                help_text=(
                    "True when the document is a scanned image or image-based PDF. "
                    "OCR will be run to extract searchable text."
                ),
            ),
        ),
        migrations.AddField(
            model_name="document",
            name="ocr_status",
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
                help_text="Current state of the OCR extraction pipeline.",
            ),
        ),
    ]
