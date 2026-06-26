from django.db import migrations
from django.db.models import OuterRef, Subquery


def backfill_department(apps, schema_editor):
    """Set each existing document's department from its uploader, where it isn't
    already assigned. New documents get this on creation (Document.save)."""
    Document = apps.get_model("documents", "Document")
    User = apps.get_model("accounts", "User")
    uploader_dept = (
        User.objects.filter(pk=OuterRef("uploaded_by_id"))
        .values("department_id")[:1]
    )
    (
        Document.objects
        .filter(department__isnull=True, uploaded_by__department__isnull=False)
        .update(department_id=Subquery(uploader_dept))
    )


class Migration(migrations.Migration):

    dependencies = [
        ("documents", "0033_migrationjob"),
    ]

    operations = [
        # Data-only backfill; reversing simply leaves the values in place.
        migrations.RunPython(backfill_department, migrations.RunPython.noop),
    ]
