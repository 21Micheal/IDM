from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("documents", "0008_alter_metadatafield_field_type"),
    ]

    operations = [
        migrations.AddField(
            model_name="documenttype",
            name="is_personal_type",
            field=models.BooleanField(default=False),
        ),
        migrations.AddField(
            model_name="documenttype",
            name="metadata_mode",
            field=models.CharField(
                choices=[("admin_defined", "Admin-defined"), ("user_defined", "User-defined")],
                default="admin_defined",
                max_length=32,
            ),
        ),
    ]
