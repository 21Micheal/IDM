from django.db import migrations, models
import django.db.models.deletion


def preserve_legacy_travel_path(apps, schema_editor):
    Template = apps.get_model("templates_engine", "DocumentTemplate")
    GroupPermission = apps.get_model("accounts", "GroupPermission")
    Template.objects.filter(
        workflow_type="requisition",
    ).exclude(requisition_type_field="").update(skip_rfq=True)
    Template.objects.filter(
        workflow_type="requisition",
    ).exclude(requisition_type_field="").update(requisition_category="travel")
    # Keep existing requisition entry available to groups that already had
    # upload/submit rights for the template's document type.
    for template in Template.objects.filter(
        type="built", kind="form", workflow_type="requisition", document_type__isnull=False
    ):
        group_ids = GroupPermission.objects.filter(
            document_type_id=template.document_type_id,
            action__in=["upload", "submit"],
        ).values_list("group_id", flat=True).distinct()
        template.available_to_groups.add(*group_ids)


class Migration(migrations.Migration):

    dependencies = [
        ("accounts", "0015_user_password_reset_token_and_more"),
        ("templates_engine", "0009_documenttemplate_travel_retirement"),
    ]

    operations = [
        migrations.AddField(
            model_name="documenttemplate",
            name="skip_rfq",
            field=models.BooleanField(
                default=False,
                help_text="Skip the RFQ stage for this requisition form and continue directly to LPO.",
            ),
        ),
        migrations.AddField(
            model_name="documenttemplate",
            name="available_to_groups",
            field=models.ManyToManyField(
                blank=True,
                help_text="Groups whose members may start requisitions with this form.",
                related_name="requisition_templates",
                to="accounts.usergroup",
            ),
        ),
        migrations.AddField(
            model_name="documenttemplate",
            name="requisition_category",
            field=models.CharField(
                choices=[("standard", "Standard requisition"), ("travel", "Travel requisition")],
                default="standard",
                help_text="Identifies the requisition lifecycle without asking the requester to choose a type on the form.",
                max_length=20,
            ),
        ),
        migrations.RunPython(preserve_legacy_travel_path, migrations.RunPython.noop),
    ]
