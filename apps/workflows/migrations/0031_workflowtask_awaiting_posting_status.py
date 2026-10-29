from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("workflows", "0030_workflowstep_imprest_posting_checkpoint"),
    ]

    operations = [
        migrations.AlterField(
            model_name="workflowtask",
            name="status",
            field=models.CharField(
                choices=[
                    ("pending", "Pending"),
                    ("in_progress", "In Progress"),
                    ("approved", "Approved"),
                    ("awaiting_posting", "Awaiting SunSystems posting"),
                    ("rejected", "Rejected"),
                    ("returned", "Returned for Review"),
                    ("held", "On Hold"),
                    ("skipped", "Skipped"),
                    ("notified", "Notification Sent"),
                ],
                default="pending",
                max_length=20,
            ),
        ),
    ]
