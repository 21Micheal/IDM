from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("workflows", "0031_workflowtask_awaiting_posting_status"),
    ]

    operations = [
        migrations.AddField(
            model_name="workflowstep",
            name="approve_button_label",
            field=models.CharField(
                blank=True,
                default="",
                help_text="Optional label for the approval action button. Leave blank to show Approve.",
                max_length=80,
            ),
        ),
    ]
