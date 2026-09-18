from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("billing", "0001_initial"),
    ]

    operations = [
        migrations.AddField(
            model_name="clientdeployment",
            name="last_alert_sent_at",
            field=models.DateTimeField(
                blank=True,
                null=True,
                help_text="Timestamp of the last 90%-cap spend alert email. Used to suppress duplicate alerts within the same calendar month.",
            ),
        ),
    ]
