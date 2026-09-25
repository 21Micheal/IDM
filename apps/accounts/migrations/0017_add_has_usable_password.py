from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [
        ('accounts', '0016_add_oidc_sub'),
    ]

    operations = [
        migrations.AddField(
            model_name='user',
            name='has_usable_password',
            field=models.BooleanField(default=True),
        ),
    ]
