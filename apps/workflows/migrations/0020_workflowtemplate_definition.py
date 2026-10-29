# Generated migration for branched workflow definition field

from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('workflows', '0019_alter_workflowrule_options_and_more'),
    ]

    operations = [
        migrations.AddField(
            model_name='workflowtemplate',
            name='definition',
            field=models.JSONField(
                blank=True,
                help_text=(
                    "V2 branched workflow definition. When present, the workflow engine "
                    "follows this definition instead of legacy routing rules. Format: "
                    "{version: 2, blocks: [...]}. See workflowGraph.ts for schema."
                ),
                null=True
            ),
        ),
    ]
