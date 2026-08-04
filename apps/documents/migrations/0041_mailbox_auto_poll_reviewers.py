# Generated manually for mailbox auto-poll + reviewers + Email bot backfill

import django.db.models.deletion
from django.conf import settings
from django.db import migrations, models


EMAIL_BOT_EMAIL = "email-bot@system.local"


def create_email_bot_and_reattribute(apps, schema_editor):
    """Ensure the Email bot user exists and own existing email-ingested docs."""
    import secrets

    User = apps.get_model("accounts", "User")
    Document = apps.get_model("documents", "Document")
    BulkUpload = apps.get_model("documents", "BulkUpload")
    IngestedEmail = apps.get_model("documents", "IngestedEmail")

    bot, created = User.objects.get_or_create(
        email=EMAIL_BOT_EMAIL,
        defaults={
            "first_name": "Email",
            "last_name": "bot",
            "is_active": True,
            "is_staff": False,
            "is_superuser": False,
            "must_change_password": False,
            "mfa_enabled": False,
            # Django unusable-password marker (prefix "!" + random).
            "password": "!" + secrets.token_hex(20),
        },
    )
    if not created and (bot.first_name != "Email" or bot.last_name != "bot"):
        bot.first_name = "Email"
        bot.last_name = "bot"
        bot.save(update_fields=["first_name", "last_name"])

    email_batch_ids = list(
        IngestedEmail.objects.exclude(bulk_upload_id=None)
        .values_list("bulk_upload_id", flat=True)
        .distinct()
    )
    if email_batch_ids:
        BulkUpload.objects.filter(id__in=email_batch_ids).update(uploaded_by=bot)
        Document.objects.filter(bulk_upload_id__in=email_batch_ids).update(uploaded_by=bot)


def noop_reverse(apps, schema_editor):
    pass


class Migration(migrations.Migration):

    dependencies = [
        migrations.swappable_dependency(settings.AUTH_USER_MODEL),
        ("documents", "0040_dmssettings_session_warning_minutes"),
    ]

    operations = [
        migrations.AddField(
            model_name="mailbox",
            name="auto_poll",
            field=models.BooleanField(
                db_index=True,
                default=False,
                help_text=(
                    "When on (and the mailbox is active), Celery beat polls this mailbox "
                    "on ``poll_interval_seconds``. Off = manual poll only."
                ),
            ),
        ),
        migrations.AddField(
            model_name="mailbox",
            name="poll_interval_seconds",
            field=models.PositiveIntegerField(
                default=300,
                help_text=(
                    "How often to auto-poll this mailbox, in seconds. "
                    "Ignored when auto_poll is off."
                ),
            ),
        ),
        migrations.AddField(
            model_name="mailbox",
            name="reviewers",
            field=models.ManyToManyField(
                blank=True,
                help_text=(
                    "Users who see this mailbox's ingested batches in the pending-review "
                    "queue. Empty = mailbox owner and admins."
                ),
                related_name="review_mailboxes",
                to=settings.AUTH_USER_MODEL,
            ),
        ),
        migrations.AlterField(
            model_name="mailbox",
            name="created_by",
            field=models.ForeignKey(
                help_text="Admin who configured the mailbox (fallback reviewer when none are set).",
                null=True,
                on_delete=django.db.models.deletion.SET_NULL,
                related_name="mailboxes",
                to=settings.AUTH_USER_MODEL,
            ),
        ),
        migrations.AlterField(
            model_name="mailbox",
            name="is_active",
            field=models.BooleanField(
                db_index=True,
                default=True,
                help_text="Inactive mailboxes are never polled (manual or scheduled).",
            ),
        ),
        migrations.AddIndex(
            model_name="mailbox",
            index=models.Index(
                fields=["is_active", "auto_poll"],
                name="documents_m_is_acti_auto_po_idx",
            ),
        ),
        migrations.RunPython(create_email_bot_and_reattribute, noop_reverse),
    ]
