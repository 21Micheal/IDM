import uuid

import django.db.models.deletion
from django.conf import settings
from django.db import migrations, models


class Migration(migrations.Migration):

    initial = True

    dependencies = [
        ("documents", "0039_mailbox_allowed_attachment_extensions_and_more"),
        migrations.swappable_dependency(settings.AUTH_USER_MODEL),
    ]

    operations = [
        migrations.CreateModel(
            name="JournalPosting",
            fields=[
                ("id", models.UUIDField(default=uuid.uuid4, editable=False, primary_key=True, serialize=False)),
                (
                    "status",
                    models.CharField(
                        choices=[
                            ("pending", "Pending"),
                            ("posting", "Posting"),
                            ("posted", "Posted"),
                            ("failed", "Failed"),
                            ("skipped", "Skipped"),
                        ],
                        db_index=True,
                        default="pending",
                        max_length=20,
                    ),
                ),
                ("attempts", models.PositiveIntegerField(default=0)),
                ("component", models.CharField(blank=True, default="Journal", max_length=64)),
                ("method", models.CharField(blank=True, default="Import", max_length=64)),
                ("business_unit", models.CharField(blank=True, max_length=64)),
                ("journal_number", models.CharField(blank=True, db_index=True, max_length=64)),
                ("message", models.TextField(blank=True)),
                ("error", models.TextField(blank=True)),
                ("request_xml", models.TextField(blank=True)),
                ("response_xml", models.TextField(blank=True)),
                ("created_at", models.DateTimeField(auto_now_add=True)),
                ("updated_at", models.DateTimeField(auto_now=True)),
                ("posted_at", models.DateTimeField(blank=True, null=True)),
                (
                    "document",
                    models.OneToOneField(
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="journal_posting",
                        to="documents.document",
                    ),
                ),
                (
                    "posted_by",
                    models.ForeignKey(
                        blank=True,
                        null=True,
                        on_delete=django.db.models.deletion.SET_NULL,
                        related_name="journal_postings",
                        to=settings.AUTH_USER_MODEL,
                    ),
                ),
            ],
            options={
                "ordering": ["-created_at"],
                "indexes": [
                    models.Index(fields=["status", "created_at"], name="sunsystems__status_260bd0_idx"),
                ],
            },
        ),
    ]
