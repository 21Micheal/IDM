from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("documents", "0041_mailbox_auto_poll_reviewers"),
    ]

    operations = [
        migrations.AddField(
            model_name="dmssettings",
            name="idp_allow_regex_fallback",
            field=models.BooleanField(
                default=False,
                help_text="Allow the local pattern-matching pipeline as a last resort. Requires claude_then_regex or user opt-in.",
            ),
        ),
        migrations.AddField(
            model_name="dmssettings",
            name="idp_claude_enabled",
            field=models.BooleanField(
                default=True,
                help_text="When off (e.g. subscription ended), Claude is not called and extraction follows the fallback policy.",
            ),
        ),
        migrations.AddField(
            model_name="dmssettings",
            name="idp_fallback_policy",
            field=models.CharField(
                choices=[
                    ("claude_only", "Claude only — leave fields empty when unavailable"),
                    ("claude_ask", "Claude — prompt uploader when unavailable"),
                    ("claude_then_regex", "Claude — allow pattern matching when unavailable"),
                ],
                default="claude_only",
                help_text="What to do when Claude cannot extract fields for this tenant.",
                max_length=32,
            ),
        ),
        migrations.AddField(
            model_name="dmssettings",
            name="idp_page_allowance",
            field=models.PositiveIntegerField(
                default=0,
                help_text="Maximum Claude pages per billing period for this tenant. 0 = unlimited.",
            ),
        ),
        migrations.AddField(
            model_name="dmssettings",
            name="idp_pages_used",
            field=models.PositiveIntegerField(
                default=0,
                help_text="Claude pages consumed in the current billing period.",
            ),
        ),
    ]
