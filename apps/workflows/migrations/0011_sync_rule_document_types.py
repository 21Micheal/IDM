from django.db import migrations


def sync_rule_document_types(apps, schema_editor):
    WorkflowTemplate = apps.get_model("workflows", "WorkflowTemplate")
    WorkflowRule = apps.get_model("workflows", "WorkflowRule")

    for template in WorkflowTemplate.objects.exclude(document_type__isnull=True):
        WorkflowRule.objects.filter(template=template).exclude(
            document_type=template.document_type
        ).update(document_type=template.document_type)


class Migration(migrations.Migration):

    dependencies = [
        ("workflows", "0010_template_document_type_and_rule_ranges"),
    ]

    operations = [
        migrations.RunPython(sync_rule_document_types, migrations.RunPython.noop),
    ]
