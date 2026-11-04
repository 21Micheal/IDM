from django.db import migrations, models


def populate_permissions(apps, schema_editor):
    DocumentShare = apps.get_model("documents", "DocumentShare")
    legacy = {
        "view": ["view"],
        "download": ["view", "download"],
        "comment": ["view", "comment"],
        "edit": ["view", "download", "edit"],
        "full": ["view", "download", "comment", "edit"],
    }
    for share in DocumentShare.objects.all().iterator():
        share.permissions = legacy.get(share.access_level, ["view"])
        share.save(update_fields=["permissions"])


class Migration(migrations.Migration):
    dependencies = [("documents", "0049_document_share_request_unique_pair")]

    operations = [
        migrations.AddField(
            model_name="documentshare",
            name="permissions",
            field=models.JSONField(blank=True, default=list),
        ),
        migrations.AlterField(
            model_name="documentshare",
            name="access_level",
            field=models.CharField(
                choices=[
                    ("view", "View only"),
                    ("download", "View and download"),
                    ("comment", "View and comment"),
                    ("edit", "View, download and edit"),
                    ("full", "Full access"),
                    ("custom", "Custom access"),
                ],
                default="view",
                max_length=20,
            ),
        ),
        migrations.RunPython(populate_permissions, migrations.RunPython.noop),
    ]
