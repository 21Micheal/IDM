from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("workflows", "0014_step_type_notification"),
    ]

    operations = [
        migrations.AddField(
            model_name="workflowtemplate",
            name="notify_uploader_on_approval",
            field=models.BooleanField(
                default=True,
                help_text=(
                    "When enabled, the document uploader receives an email and in-app "
                    "notification each time an approval step is completed."
                ),
            ),
        ),
        migrations.AddField(
            model_name="workflowtemplate",
            name="email_templates",
            field=models.JSONField(
                blank=True,
                default=dict,
                help_text=(
                    "Optional per-event email overrides. Keys: workflow_complete, "
                    "action_approved, action_rejected, action_returned, action_held, "
                    "action_released, hold_ending, hold_expired, sla_warning, sla_overdue. "
                    "Each value may contain 'subject' and 'body'. Leave blank to use defaults."
                ),
            ),
        ),
    ]
