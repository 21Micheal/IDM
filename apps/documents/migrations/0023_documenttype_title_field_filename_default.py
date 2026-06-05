from django.db import migrations, models


def title_to_filename(apps, schema_editor):
    """
    title_field was introduced in 0022 with default 'title'. No document type has
    deliberately chosen a title source yet, so re-point those rows to the new
    'filename' default.
    """
    DocumentType = apps.get_model("documents", "DocumentType")
    DocumentType.objects.filter(title_field__in=["title", ""]).update(title_field="filename")


def filename_to_title(apps, schema_editor):
    DocumentType = apps.get_model("documents", "DocumentType")
    DocumentType.objects.filter(title_field="filename").update(title_field="title")


class Migration(migrations.Migration):

    dependencies = [
        ("documents", "0022_documenttype_title_field"),
    ]

    operations = [
        migrations.AlterField(
            model_name="documenttype",
            name="title_field",
            field=models.CharField(
                blank=True,
                default="filename",
                help_text=(
                    "Source whose value names documents of this type. Use 'filename' "
                    "(default) to name documents after the uploaded file, or a field key "
                    "such as title, supplier, or reference_number."
                ),
                max_length=100,
            ),
        ),
        migrations.RunPython(title_to_filename, filename_to_title),
    ]
