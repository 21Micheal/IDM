# Generated for the per-attribute uniqueness feature.

from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('documents', '0028_dmssettings_organization_address_and_more'),
    ]

    operations = [
        migrations.AddField(
            model_name='metadatafield',
            name='is_unique',
            field=models.BooleanField(
                default=False,
                help_text=(
                    'When set, the value entered for this attribute (e.g. a reference '
                    'number) must not match any other document of the same type.'
                ),
            ),
        ),
    ]
