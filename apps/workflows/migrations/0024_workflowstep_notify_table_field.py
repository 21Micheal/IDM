from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("workflows", "0023_add_supplier_notification_fields"),
    ]

    operations = [
        migrations.AddField(
            model_name="workflowstep",
            name="notify_table_field",
            field=models.CharField(
                blank=True,
                help_text="Form table field key to render as the items table in the email.",
                max_length=255,
                null=True,
            ),
        ),
        migrations.AlterField(
            model_name="workflowstep",
            name="notify_include_items_table",
            field=models.BooleanField(
                default=False,
                help_text="Include a form table (quotation/items) in the notification email.",
            ),
        ),
    ]
