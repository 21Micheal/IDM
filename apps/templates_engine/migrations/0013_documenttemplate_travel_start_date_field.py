from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [("templates_engine", "0012_documenttemplate_print_config")]

    operations = [
        migrations.AddField(
            model_name="documenttemplate",
            name="travel_start_date_field",
            field=models.CharField(
                blank=True,
                default="",
                help_text="Form field key used as the travel start date for duplicate requisition checks.",
                max_length=200,
            ),
        ),
    ]
