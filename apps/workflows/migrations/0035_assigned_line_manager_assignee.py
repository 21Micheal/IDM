from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [
        ("workflows", "0034_step_assignee_selection"),
    ]

    operations = [
        migrations.AlterField(
            model_name="workflowstep",
            name="assignee_type",
            field=models.CharField(
                choices=[
                    ("group_any", "Any member of group"),
                    ("group_all", "All members of group"),
                    ("group_specific", "Specific member of group"),
                    ("form_user", "User selected in form"),
                    ("assigned_line_manager", "Submitter's assigned line manager"),
                ],
                default="group_any",
                max_length=32,
            ),
        ),
    ]
