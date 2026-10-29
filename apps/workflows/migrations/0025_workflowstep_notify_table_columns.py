from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [
        ("workflows", "0024_workflowstep_notify_table_field"),
    ]

    operations = [
        migrations.AddField(
            model_name="workflowstep",
            name="notify_table_columns",
            field=models.JSONField(blank=True, default=None, help_text="Selected form table column keys to include in the notification email.", null=True),
        ),
    ]
