# Generated manually — extend audit event vocabulary for document file access.

from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("audit", "0002_alter_auditlog_event"),
    ]

    operations = [
        migrations.AlterField(
            model_name="auditlog",
            name="event",
            field=models.CharField(
                db_index=True,
                max_length=60,
                choices=[
                    ("document.created", "Document Created"),
                    ("document.viewed", "Document Viewed"),
                    ("document.downloaded", "Document Downloaded"),
                    ("document.updated", "Document Updated"),
                    ("document.deleted", "Document Deleted"),
                    ("document.submitted", "Submitted for Approval"),
                    ("workflow.approved", "Workflow Step Approved"),
                    ("workflow.rejected", "Workflow Step Rejected"),
                    ("workflow.returned", "Workflow Step Returned"),
                    ("workflow.held", "Workflow Step Held"),
                    ("workflow.released", "Workflow Step Released"),
                    ("workflow.delegated", "Workflow Tasks Delegated"),
                    ("workflow.reassigned", "Workflow Tasks Reassigned"),
                    ("document.archived", "Document Archived"),
                    ("document.version_uploaded", "New Version Uploaded"),
                    ("document.version_restored", "Version Restored"),
                    ("user.login", "User Login"),
                    ("user.login_failed", "Login Failed"),
                    ("user.mfa_enabled", "MFA Enabled"),
                    ("permission.changed", "Permission Changed"),
                    ("document.previewed", "Document File Previewed (inline)"),
                    ("document.printed", "Document Print Requested"),
                ],
            ),
        ),
    ]
