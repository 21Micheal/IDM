# Generated for stage-based access control

from django.db import migrations, models

DEFAULT_ACCESS_STAGES = [
    {"key": "creation", "name": "Creation", "statuses": ["draft", "pending_review", "returned"]},
    {"key": "approval", "name": "For approval", "statuses": ["pending_approval"]},
    {"key": "after_approval", "name": "After approval", "statuses": ["approved", "rejected", "archived"]},
]


def fix_access_stages(apps, schema_editor):
    DMSSettings = apps.get_model("documents", "DMSSettings")
    settings, _ = DMSSettings.objects.get_or_create(pk=1)
    settings.access_stages = DEFAULT_ACCESS_STAGES
    settings.save(update_fields=["access_stages", "updated_at"])


class Migration(migrations.Migration):

    dependencies = [
        ("documents", "0020_documentrelationshiprule"),
    ]

    operations = [
        migrations.AddField(
            model_name="documenttype",
            name="access_policy",
            field=models.JSONField(
                blank=True,
                default=dict,
                help_text="Lifecycle outcome policies: on_approved, on_rejected, on_archived.",
            ),
        ),
        migrations.RunPython(fix_access_stages, migrations.RunPython.noop),
    ]
