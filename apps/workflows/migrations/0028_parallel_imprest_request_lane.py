from django.db import migrations, models


def mark_existing_imprest_approval(apps, schema_editor):
    """Move the existing named Imprest approval out of the main requisition path."""
    WorkflowTemplate = apps.get_model("workflows", "WorkflowTemplate")
    for template in WorkflowTemplate.objects.filter(definition__isnull=False):
        if template.target_type != "document" or not template.document_type_id:
            continue
        if "requisition" not in str(template.document_type.name or "").casefold():
            continue
        definition = template.definition
        if not isinstance(definition, dict) or definition.get("version") != 2:
            continue
        changed = False

        def walk(blocks):
            nonlocal changed
            for block in blocks or []:
                kind = block.get("kind")
                if kind == "approval":
                    step = block.get("step") or {}
                    if str(step.get("name") or "").strip().casefold() == "imprest request":
                        if step.get("parallel_lane") != "imprest_request":
                            step["parallel_lane"] = "imprest_request"
                            block["step"] = step
                            changed = True
                elif kind == "if_else":
                    for branch in block.get("branches") or []:
                        walk(branch.get("blocks"))
                    walk(block.get("else_blocks"))
                elif kind == "switch":
                    for case in block.get("cases") or []:
                        walk(case.get("blocks"))
                    walk(block.get("default_blocks"))

        walk(definition.get("blocks"))
        if changed:
            template.definition = definition
            template.save(update_fields=["definition"])


class Migration(migrations.Migration):

    dependencies = [
        ("workflows", "0027_workflowstep_form_user_assignee"),
    ]

    operations = [
        migrations.AddField(
            model_name="workflowinstance",
            name="imprest_request_status",
            field=models.CharField(blank=True, default="", max_length=20),
        ),
        migrations.AddField(
            model_name="workflowinstance",
            name="imprest_request_current_step_order",
            field=models.PositiveSmallIntegerField(blank=True, null=True),
        ),
        migrations.AddField(
            model_name="workflowinstance",
            name="imprest_request_completed_at",
            field=models.DateTimeField(blank=True, null=True),
        ),
        migrations.AddField(
            model_name="workflowtask",
            name="execution_lane",
            field=models.CharField(db_index=True, default="main", max_length=32),
        ),
        migrations.RunPython(mark_existing_imprest_approval, migrations.RunPython.noop),
    ]
