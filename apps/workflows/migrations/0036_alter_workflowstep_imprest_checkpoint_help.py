from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("workflows", "0035_assigned_line_manager_assignee"),
    ]

    operations = [
        migrations.AlterField(
            model_name="workflowstep",
            name="post_imprest_request_after_approval",
            field=models.BooleanField(
                default=False,
                help_text="After this approval in the Request or procurement phases, post the Imprest request before continuing.",
            ),
        ),
    ]
