"""
apps/workflows/migrations/0004_step_type_notification.py

Adds to WorkflowStep:
  - step_type          CharField default="approval"
  - notify_user        FK to User (null)
  - notify_email       EmailField (blank)
  - notification_subject CharField (blank)
  - notification_message TextField (blank)
  - approver_email_subject CharField (blank)
  - approver_email_body    TextField (blank)

Adds to WorkflowTask:
  - status choice "notified"

Adds to WorkflowTaskAction:
  - action choice "notified"
  - makes actor nullable (for system-generated actions)
"""
from django.conf import settings
from django.db import migrations, models
import django.db.models.deletion


class Migration(migrations.Migration):

    dependencies = [
        migrations.swappable_dependency(settings.AUTH_USER_MODEL),
        # Replace with the actual name of your last migration:
        ("workflows", "0013_workflowstep_assignee_user_auto"),
    ]

    operations = [
        # ── step_type ──────────────────────────────────────────────────────
        migrations.AddField(
            model_name="workflowstep",
            name="step_type",
            field=models.CharField(
                choices=[("approval", "Approval"), ("notification", "Notification")],
                default="approval",
                max_length=20,
                help_text=(
                    "'approval' requires a human to act; "
                    "'notification' fires an email and auto-advances immediately."
                ),
            ),
        ),
        # ── Notification-step fields ───────────────────────────────────────
        migrations.AddField(
            model_name="workflowstep",
            name="notify_user",
            field=models.ForeignKey(
                blank=True,
                null=True,
                on_delete=django.db.models.deletion.SET_NULL,
                related_name="notification_steps",
                to=settings.AUTH_USER_MODEL,
                help_text="System user to notify (notification steps only).",
            ),
        ),
        migrations.AddField(
            model_name="workflowstep",
            name="notify_email",
            field=models.EmailField(
                blank=True,
                help_text="External email address to notify (notification steps only).",
            ),
        ),
        migrations.AddField(
            model_name="workflowstep",
            name="notification_subject",
            field=models.CharField(
                blank=True,
                max_length=255,
                help_text="Email subject for notification steps.",
            ),
        ),
        migrations.AddField(
            model_name="workflowstep",
            name="notification_message",
            field=models.TextField(
                blank=True,
                help_text="Email body for notification steps.",
            ),
        ),
        # ── Custom approver email fields (approval steps) ──────────────────
        migrations.AddField(
            model_name="workflowstep",
            name="approver_email_subject",
            field=models.CharField(
                blank=True,
                max_length=255,
                help_text=(
                    "Custom subject for the task-assignment email sent to approvers. "
                    "Leave blank to use the system default."
                ),
            ),
        ),
        migrations.AddField(
            model_name="workflowstep",
            name="approver_email_body",
            field=models.TextField(
                blank=True,
                help_text=(
                    "Custom body for the task-assignment email sent to approvers. "
                    "Supports: {approver_name}, {document_title}, {document_ref}, "
                    "{step_name}, {instructions}, {document_url}. "
                    "Leave blank to use the system default."
                ),
            ),
        ),
        # ── WorkflowTask: add "notified" status choice ─────────────────────
        migrations.AlterField(
            model_name="workflowtask",
            name="status",
            field=models.CharField(
                choices=[
                    ("pending",     "Pending"),
                    ("in_progress", "In Progress"),
                    ("approved",    "Approved"),
                    ("rejected",    "Rejected"),
                    ("returned",    "Returned for Review"),
                    ("held",        "On Hold"),
                    ("skipped",     "Skipped"),
                    ("notified",    "Notification Sent"),
                ],
                default="pending",
                max_length=20,
            ),
        ),
        # ── WorkflowTaskAction: add "notified" action + nullable actor ─────
        migrations.AlterField(
            model_name="workflowtaskaction",
            name="action",
            field=models.CharField(
                choices=[
                    ("approved",   "Approved"),
                    ("rejected",   "Rejected"),
                    ("returned",   "Returned for Review"),
                    ("held",       "Put on Hold"),
                    ("released",   "Hold Released"),
                    ("reassigned", "Reassigned"),
                    ("notified",   "Notification Sent"),
                ],
                max_length=20,
            ),
        ),
        migrations.AlterField(
            model_name="workflowtaskaction",
            name="actor",
            field=models.ForeignKey(
                blank=True,
                null=True,
                on_delete=django.db.models.deletion.PROTECT,
                related_name="task_actions",
                to=settings.AUTH_USER_MODEL,
            ),
        ),
    ]
