from django.db import migrations, models
import django.db.models.deletion


def backfill_template_document_type(apps, schema_editor):
    DocumentType = apps.get_model("documents", "DocumentType")

    for document_type in DocumentType.objects.exclude(workflow_template__isnull=True):
        template = document_type.workflow_template
        if template and template.document_type_id is None:
            template.document_type_id = document_type.id
            template.save(update_fields=["document_type"])


class Migration(migrations.Migration):

    dependencies = [
        ("documents", "0002_initial"),
        ("workflows", "0009_workflowstep_allow_approve_workflowstep_allow_reject_and_more"),
    ]

    operations = [
        migrations.AddField(
            model_name="workflowtemplate",
            name="document_type",
            field=models.ForeignKey(
                blank=True,
                help_text="Document type this template belongs to.",
                null=True,
                on_delete=django.db.models.deletion.SET_NULL,
                related_name="workflow_templates",
                to="documents.documenttype",
            ),
        ),
        migrations.RunPython(backfill_template_document_type, migrations.RunPython.noop),
        migrations.RenameField(
            model_name="workflowrule",
            old_name="amount_threshold",
            new_name="amount_min",
        ),
        migrations.AddField(
            model_name="workflowrule",
            name="amount_max",
            field=models.DecimalField(blank=True, decimal_places=2, max_digits=18, null=True),
        ),
        migrations.AlterModelOptions(
            name="workflowrule",
            options={"ordering": ["document_type", "amount_min", "amount_max"]},
        ),
    ]
