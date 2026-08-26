from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("documents", "0043_rename_documents_m_is_acti_auto_po_idx_documents_m_is_acti_cbc485_idx_and_more"),
    ]

    operations = [
        migrations.AddField(
            model_name="dmssettings",
            name="idp_anthropic_api_key",
            field=models.CharField(
                blank=True,
                default="",
                help_text=(
                    "Per-tenant Anthropic workspace API key (operator-managed). "
                    "When empty, falls back to the ANTHROPIC_API_KEY environment variable."
                ),
                max_length=255,
            ),
        ),
        migrations.AlterField(
            model_name="dmssettings",
            name="idp_page_allowance",
            field=models.PositiveIntegerField(
                default=0,
                help_text=(
                    "Optional reference page target for reporting only — not enforced. "
                    "Hard spend limits are configured in the Anthropic workspace console."
                ),
            ),
        ),
        migrations.AlterField(
            model_name="dmssettings",
            name="idp_pages_used",
            field=models.PositiveIntegerField(
                default=0,
                help_text="Claude pages consumed since last manual reset (reporting metric).",
            ),
        ),
    ]
