from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("workflows", "0021_workflowinstance_v2_fields"),
    ]

    operations = [
        migrations.AddField(
            model_name="workflowstep",
            name="allow_return_submitter",
            field=models.BooleanField(
                default=True,
                help_text="Approver can send back to the document submitter for rework",
            ),
        ),
        migrations.AlterField(
            model_name="workflowstep",
            name="allow_return",
            field=models.BooleanField(
                default=True,
                help_text="Approver can send back to the previous approval step for review",
            ),
        ),
    ]
