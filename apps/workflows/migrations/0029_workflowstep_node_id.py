from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("workflows", "0028_parallel_imprest_request_lane"),
    ]

    operations = [
        migrations.AddField(
            model_name="workflowstep",
            name="node_id",
            field=models.CharField(blank=True, db_index=True, max_length=64, null=True),
        ),
    ]
