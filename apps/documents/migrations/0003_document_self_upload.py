"""
apps/documents/migrations/0003_document_self_upload.py

Adds is_self_upload BooleanField to the Document model.
Default = False so all existing rows are treated as normal workflow docs.
"""
from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("documents", "0002_initial"),   # adjust to your actual last migration name
    ]

    operations = [
        migrations.AddField(
            model_name="document",
            name="is_self_upload",
            field=models.BooleanField(
                default=False,
                db_index=True,
                help_text=(
                    "When True the document is a personal/non-approval upload. "
                    "It is visible only to the uploader and administrators; "
                    "it cannot be submitted into a workflow."
                ),
            ),
        ),
    ]
