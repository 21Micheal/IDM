# Generated manually for dismissed_at field

from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('accounts', '0013_usergroup_sees_all_documents_and_more'),
    ]

    operations = [
        migrations.AddField(
            model_name='userdelegation',
            name='dismissed_at',
            field=models.DateTimeField(null=True, blank=True),
        ),
    ]
