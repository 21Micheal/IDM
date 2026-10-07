from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("templates_engine", "0008_documenttemplate_requisition_type"),
    ]

    operations = [
        migrations.AddField(
            model_name="documenttemplate",
            name="travel_retirement",
            field=models.JSONField(
                blank=True,
                default=dict,
                help_text="Optional travel retirement settings (return-date field and policy deadline).",
            ),
        ),
    ]
