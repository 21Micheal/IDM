from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("sunsystems", "0004_paymentrun_paymentrunapproval"),
    ]

    operations = [
        migrations.AlterField(
            model_name="paymentrun",
            name="reference_prefix",
            field=models.CharField(default="PAY", max_length=12),
        ),
    ]
