from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [("workflows", "0026_workflowstep_post_lpo_after_approval")]

    operations = [
        migrations.AddField(
            model_name="workflowstep",
            name="assignee_user_field",
            field=models.CharField(
                blank=True,
                default="",
                help_text="Form field key whose selected user receives this approval task.",
                max_length=120,
            ),
        ),
        migrations.AlterField(
            model_name="workflowstep",
            name="assignee_type",
            field=models.CharField(
                choices=[
                    ("group_any", "Any member of group"),
                    ("group_all", "All members of group"),
                    ("group_specific", "Specific member of group"),
                    ("form_user", "User selected in form"),
                ],
                default="group_any",
                max_length=20,
            ),
        ),
    ]
