"""
apps/documents/migrations/0006_document_edit_lock.py

Adds application-level edit lock fields to Document:
  - edit_locked_by   FK to User (null when unlocked)
  - edit_locked_at   DateTimeField (null when unlocked, refreshed on each save)

The lock is separate from the WebDAV protocol-level LOCK verb.
It is visible to all API consumers and enforced by the view layer.
"""
from django.db import migrations, models
import django.db.models.deletion


class Migration(migrations.Migration):

    dependencies = [
        ("documents", "0006_document_office_preview"),
        ("accounts",  "0001_initial"),
    ]

    operations = [
        migrations.AddField(
            model_name="document",
            name="edit_locked_by",
            field=models.ForeignKey(
                to="accounts.User",
                null=True, blank=True,
                on_delete=django.db.models.deletion.SET_NULL,
                related_name="document_locks",
                help_text="User currently editing this document. Null when unlocked.",
            ),
        ),
        migrations.AddField(
            model_name="document",
            name="edit_locked_at",
            field=models.DateTimeField(
                null=True, blank=True,
                help_text="When the edit lock was last refreshed.",
            ),
        ),
    ]
