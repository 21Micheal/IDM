from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("accounts", "0016_clientdeployment"),
    ]

    operations = [
        migrations.AddField(
            model_name="usergroup",
            name="can_view_system_audit",
            field=models.BooleanField(default=False),
        ),
    ]
