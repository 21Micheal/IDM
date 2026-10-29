# Generated migration for v2 workflow fields on WorkflowInstance

from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('workflows', '0020_workflowtemplate_definition'),
    ]

    operations = [
        migrations.AddField(
            model_name='workflowinstance',
            name='definition_version',
            field=models.PositiveSmallIntegerField(
                blank=True,
                help_text='Workflow definition version used for this instance',
                null=True
            ),
        ),
        migrations.AddField(
            model_name='workflowinstance',
            name='current_node_id',
            field=models.CharField(
                blank=True,
                help_text='Current node ID in v2 workflow graph',
                max_length=255,
                null=True
            ),
        ),
    ]
