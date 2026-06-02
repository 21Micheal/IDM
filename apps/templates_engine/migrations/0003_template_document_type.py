import django.db.models.deletion
from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("documents", "0021_documenttype_access_policy_fix_stages"),
        ("templates_engine", "0002_add_category_tags"),
    ]

    operations = [
        migrations.AddField(
            model_name="documenttemplate",
            name="document_type",
            field=models.ForeignKey(
                blank=True,
                help_text="Document type this template can create documents for.",
                null=True,
                on_delete=django.db.models.deletion.PROTECT,
                related_name="document_templates",
                to="documents.documenttype",
            ),
        ),
        migrations.AddIndex(
            model_name="documenttemplate",
            index=models.Index(fields=["document_type", "is_active"], name="tmpl_doctype_active_idx"),
        ),
    ]
