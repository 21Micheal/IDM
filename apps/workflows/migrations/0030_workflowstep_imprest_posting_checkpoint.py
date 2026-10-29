from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("workflows", "0029_workflowstep_node_id"),
    ]

    operations = [
        migrations.AddField(
            model_name="workflowstep",
            name="post_imprest_request_after_approval",
            field=models.BooleanField(
                default=False,
                help_text="After this approval in the Request phase, post the Imprest request before continuing.",
            ),
        ),
    ]
