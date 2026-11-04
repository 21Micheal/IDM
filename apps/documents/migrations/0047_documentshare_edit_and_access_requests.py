import uuid
from django.conf import settings
from django.db import migrations, models
import django.db.models.deletion


class Migration(migrations.Migration):
    dependencies = [
        ("documents", "0046_alter_dmssettings_idp_anthropic_api_key"),
        migrations.swappable_dependency(settings.AUTH_USER_MODEL),
    ]

    operations = [
        migrations.AlterField(
            model_name="documentshare",
            name="access_level",
            field=models.CharField(choices=[("view", "View only"), ("download", "View and download"), ("edit", "View, download and edit")], default="view", max_length=20),
        ),
        migrations.CreateModel(
            name="DocumentShareAccessRequest",
            fields=[
                ("id", models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False, serialize=False)),
                ("status", models.CharField(choices=[("pending", "Pending"), ("granted", "Granted"), ("declined", "Declined")], default="pending", max_length=12)),
                ("created_at", models.DateTimeField(auto_now_add=True)),
                ("updated_at", models.DateTimeField(auto_now=True)),
                ("document", models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name="share_access_requests", to="documents.document")),
                ("requester", models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name="document_access_requests", to=settings.AUTH_USER_MODEL)),
            ],
            options={"ordering": ["-created_at"]},
        ),
        migrations.AddConstraint(
            model_name="documentshareaccessrequest",
            constraint=models.UniqueConstraint(condition=models.Q(status="pending"), fields=("document", "requester"), name="unique_pending_doc_share_request"),
        ),
    ]
