from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("accounts", "0017_usergroup_can_view_system_audit"),
    ]

    operations = [
        migrations.AddField(
            model_name="user",
            name="staff_number",
            field=models.CharField(blank=True, default="", max_length=40),
        ),
        migrations.AddField(
            model_name="user",
            name="grade",
            field=models.CharField(blank=True, default="", max_length=40),
        ),
        migrations.AddField(
            model_name="user",
            name="line_manager",
            field=models.CharField(blank=True, default="", max_length=150),
        ),
        migrations.AddField(
            model_name="user",
            name="dsa",
            field=models.CharField(blank=True, default="", max_length=60),
        ),
    ]
