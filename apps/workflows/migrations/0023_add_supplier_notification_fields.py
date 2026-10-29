# Generated migration for supplier notification fields

from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("workflows", "0022_workflowstep_allow_return_submitter"),
    ]

    operations = [
        migrations.AddField(
            model_name="workflowstep",
            name="notify_emails",
            field=models.JSONField(default=list, blank=True, help_text="List of email addresses for notification steps."),
        ),
        migrations.AddField(
            model_name="workflowstep",
            name="notify_include_items_table",
            field=models.BooleanField(default=False, help_text="Include requisition items table in notification email."),
        ),
        migrations.AddField(
            model_name="workflowstep",
            name="notify_recipient_type",
            field=models.CharField(max_length=20, blank=True, help_text="Recipient type for notification steps."),
        ),
        migrations.AddField(
            model_name="workflowstep",
            name="notify_supplier_field",
            field=models.CharField(
                max_length=255,
                blank=True,
                null=True,
                help_text="Form field key for supplier codes (notification steps only).",
            ),
        ),
    ]
