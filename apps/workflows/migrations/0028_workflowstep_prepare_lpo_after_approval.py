from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [("workflows", "0027_workflowstep_form_user_assignee")]

    operations = [
        migrations.AlterField(
            model_name="workflowstep",
            name="post_lpo_after_approval",
            field=models.BooleanField(
                default=False,
                help_text="After this approval, post configured purchase orders; successful posting completes the LPO workflow.",
            ),
        ),
        migrations.AddField(
            model_name="workflowstep",
            name="prepare_lpo_after_approval",
            field=models.BooleanField(
                default=False,
                help_text="Generate draft LPO documents after this approval, before their Purchase Orders are posted to SunSystems.",
            ),
        ),
    ]
