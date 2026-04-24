from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("documents", "0007_document_edit_lock"),
    ]

    operations = [
        migrations.AlterField(
            model_name="metadatafield",
            name="field_type",
            field=models.CharField(
                choices=[
                    ("text", "Text"),
                    ("varchar", "VARCHAR"),
                    ("number", "Number"),
                    ("date", "Date"),
                    ("currency", "Currency"),
                    ("select", "Select"),
                    ("boolean", "Boolean"),
                    ("textarea", "Long Text"),
                ],
                default="text",
                max_length=20,
            ),
        ),
    ]
