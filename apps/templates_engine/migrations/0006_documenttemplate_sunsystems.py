from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("templates_engine", "0005_documenttemplate_kind_design"),
    ]

    operations = [
        migrations.AddField(
            model_name="documenttemplate",
            name="sunsystems",
            field=models.JSONField(blank=True, default=dict),
        ),
    ]
