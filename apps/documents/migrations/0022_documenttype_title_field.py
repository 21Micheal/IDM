from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("documents", "0021_documenttype_access_policy_fix_stages"),
    ]

    operations = [
        migrations.AddField(
            model_name="documenttype",
            name="title_field",
            field=models.CharField(
                blank=True,
                default="title",
                help_text=(
                    "Metadata field key whose value names documents of this type "
                    "(e.g. title, supplier, reference_number)."
                ),
                max_length=100,
            ),
        ),
    ]
