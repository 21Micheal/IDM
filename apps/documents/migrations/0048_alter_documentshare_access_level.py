from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [
        ("documents", "0047_documentshare_edit_and_access_requests"),
    ]

    operations = [
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
                ],
                default="view",
                max_length=20,
            ),
        ),
    ]
