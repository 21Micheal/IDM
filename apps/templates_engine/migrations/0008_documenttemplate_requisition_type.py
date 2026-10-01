# Generated for the procurement requisition-type / RFQ-skip configuration.

from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('templates_engine', '0007_documenttemplate_workflow_type'),
    ]

    operations = [
        migrations.AddField(
            model_name='documenttemplate',
            name='requisition_type_field',
            field=models.CharField(
                blank=True,
                default='',
                help_text='Key of the form dropdown field that holds the requisition type.',
                max_length=100,
            ),
        ),
        migrations.AddField(
            model_name='documenttemplate',
            name='travel_type_value',
            field=models.CharField(
                blank=True,
                default='Travel',
                help_text='Requisition-type value that skips the RFQ stage (Requisition → LPO).',
                max_length=120,
            ),
        ),
    ]
