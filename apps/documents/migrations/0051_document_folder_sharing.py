import django.db.models.deletion
import uuid
from django.conf import settings
from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [
        ("documents", "0050_documentshare_permissions"),
        migrations.swappable_dependency(settings.AUTH_USER_MODEL),
    ]

    operations = [
        migrations.CreateModel(
            name="DocumentFolderShare",
            fields=[
                ("id", models.UUIDField(default=uuid.uuid4, editable=False, primary_key=True, serialize=False)),
                ("permissions", models.JSONField(blank=True, default=list)),
                ("message", models.TextField(blank=True)),
                ("expires_at", models.DateTimeField(blank=True, null=True)),
                ("revoked_at", models.DateTimeField(blank=True, null=True)),
                ("created_at", models.DateTimeField(auto_now_add=True)),
                ("updated_at", models.DateTimeField(auto_now=True)),
                ("folder", models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name="shares", to="documents.documentfolder")),
                ("recipient", models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name="folder_shares_received", to=settings.AUTH_USER_MODEL)),
                ("shared_by", models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name="folder_shares_created", to=settings.AUTH_USER_MODEL)),
            ],
            options={"ordering": ["-created_at"]},
        ),
        migrations.AddConstraint(
            model_name="documentfoldershare",
            constraint=models.UniqueConstraint(fields=("folder", "recipient"), name="unique_folder_share_recipient"),
        ),
        migrations.AddIndex(
            model_name="documentfoldershare",
            index=models.Index(fields=["recipient", "revoked_at", "expires_at"], name="documents_d_recipie_03d995_idx"),
        ),
        migrations.CreateModel(
            name="DocumentFolderShareAccessRequest",
            fields=[
                ("id", models.UUIDField(default=uuid.uuid4, editable=False, primary_key=True, serialize=False)),
                ("requested_permissions", models.JSONField(blank=True, default=list)),
                ("status", models.CharField(choices=[("pending", "Pending"), ("granted", "Granted"), ("declined", "Declined")], default="pending", max_length=10)),
                ("created_at", models.DateTimeField(auto_now_add=True)),
                ("updated_at", models.DateTimeField(auto_now=True)),
                ("folder", models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name="share_access_requests", to="documents.documentfolder")),
                ("requester", models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name="folder_share_access_requests", to=settings.AUTH_USER_MODEL)),
            ],
            options={"ordering": ["-created_at"]},
        ),
        migrations.AddConstraint(
            model_name="documentfoldershareaccessrequest",
            constraint=models.UniqueConstraint(fields=("folder", "requester"), name="unique_folder_share_access_request"),
        ),
    ]
