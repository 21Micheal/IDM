from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("accounts", "0011_grouppermission_stage_submit"),
    ]

    operations = [
        migrations.AddField(
            model_name="usergroup",
            name="head",
            field=models.ForeignKey(
                blank=True,
                null=True,
                on_delete=models.SET_NULL,
                related_name="headed_groups",
                to="accounts.user",
            ),
        ),
    ]
