from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [("templates_engine", "0011_alter_documenttemplate_workflow_type")]

    operations = [
        migrations.AddField(
            model_name="documenttemplate",
            name="print_config",
            field=models.JSONField(blank=True, default=dict, help_text="Print layout settings, including the workflow approval assigned to each signature slot."),
        ),
    ]
