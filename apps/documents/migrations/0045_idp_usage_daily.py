from decimal import Decimal
import uuid

from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("documents", "0044_dmssettings_idp_anthropic_api_key"),
    ]

    operations = [
        migrations.AddField(
            model_name="dmssettings",
            name="idp_monthly_limit_usd",
            field=models.DecimalField(
                decimal_places=2,
                default=Decimal("0"),
                help_text=(
                    "Operator reference monthly Anthropic spend target in USD. "
                    "Not enforced — hard caps live in the Anthropic workspace console. "
                    "Visible only to platform staff."
                ),
                max_digits=10,
            ),
        ),
        migrations.CreateModel(
            name="IdpUsageDaily",
            fields=[
                (
                    "id",
                    models.UUIDField(
                        default=uuid.uuid4,
                        editable=False,
                        primary_key=True,
                        serialize=False,
                    ),
                ),
                ("date", models.DateField(db_index=True, unique=True)),
                ("claude_docs", models.PositiveIntegerField(default=0)),
                ("regex_docs", models.PositiveIntegerField(default=0)),
                ("needs_manual_docs", models.PositiveIntegerField(default=0)),
                ("failed_docs", models.PositiveIntegerField(default=0)),
                ("claude_pages", models.PositiveIntegerField(default=0)),
                ("input_tokens", models.BigIntegerField(default=0)),
                ("output_tokens", models.BigIntegerField(default=0)),
                ("cache_read_tokens", models.BigIntegerField(default=0)),
                ("cache_write_tokens", models.BigIntegerField(default=0)),
                (
                    "estimated_cost_usd",
                    models.DecimalField(
                        decimal_places=6,
                        default=Decimal("0"),
                        max_digits=12,
                    ),
                ),
                ("updated_at", models.DateTimeField(auto_now=True)),
            ],
            options={
                "verbose_name": "IDP usage (daily)",
                "verbose_name_plural": "IDP usage (daily)",
                "ordering": ["-date"],
            },
        ),
    ]
