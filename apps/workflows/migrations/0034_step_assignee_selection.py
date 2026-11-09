from django.conf import settings
from django.db import migrations, models
import django.db.models.deletion


class Migration(migrations.Migration):
    dependencies = [
        ("workflows", "0033_alter_workflowtaskaction_action"),
        migrations.swappable_dependency(settings.AUTH_USER_MODEL),
    ]

    operations = [
        migrations.AddField(
            model_name="workflowstep",
            name="allow_assignee_selection",
            field=models.BooleanField(
                default=False,
                help_text="Allow the adjacent approver to choose an active member of this step's group.",
            ),
        ),
        migrations.AddField(
            model_name="workflowtaskaction",
            name="selected_approver",
            field=models.ForeignKey(
                blank=True,
                null=True,
                on_delete=django.db.models.deletion.SET_NULL,
                related_name="selected_workflow_approver_actions",
                to=settings.AUTH_USER_MODEL,
            ),
        ),
        migrations.AddField(
            model_name="workflowtaskaction",
            name="selected_approver_step",
            field=models.ForeignKey(
                blank=True,
                null=True,
                on_delete=django.db.models.deletion.SET_NULL,
                related_name="selected_approver_actions",
                to="workflows.workflowstep",
            ),
        ),
    ]
