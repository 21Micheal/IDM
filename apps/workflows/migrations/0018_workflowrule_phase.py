from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("workflows", "0017_workflowtask_workflows_w_assigne_1b0e2e_idx"),
    ]

    operations = [
        migrations.AddField(
            model_name="workflowrule",
            name="phase",
            field=models.CharField(blank=True, default="request", max_length=40),
        ),
        migrations.AlterModelOptions(
            name="workflowrule",
            options={"ordering": ["document_type", "phase", "amount_min", "amount_max"]},
        ),
    ]
