# Generated for the "replace trashed duplicate on re-upload" admin option.

from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('documents', '0029_metadatafield_is_unique'),
    ]

    operations = [
        migrations.AddField(
            model_name='dmssettings',
            name='purge_trashed_duplicates_on_reupload',
            field=models.BooleanField(default=False),
        ),
    ]
