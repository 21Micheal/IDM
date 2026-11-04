from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [
        ("documents", "0048_alter_documentshare_access_level"),
    ]

    operations = [
        migrations.SeparateDatabaseAndState(
            database_operations=[],
            state_operations=[
                migrations.RemoveConstraint(
                    model_name="documentshareaccessrequest",
                    name="unique_pending_doc_share_request",
                ),
            ],
        ),
        migrations.AlterUniqueTogether(
            name="documentshareaccessrequest",
            unique_together={("document", "requester")},
        ),
    ]
