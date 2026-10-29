from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [("workflows", "0025_workflowstep_notify_table_columns")]

    operations = [
        migrations.AddField(
            model_name="workflowstep",
            name="post_lpo_after_approval",
            field=models.BooleanField(
                default=False,
                help_text="After this approval, post configured purchase orders and generate their LPO documents before continuing.",
            ),
        ),
    ]
