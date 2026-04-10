from celery import shared_task

@shared_task(queue="notifications")
def notify_task_assigned(task_id: str):
    from apps.workflows.models import WorkflowTask
    from .models import Notification
    try:
        task = WorkflowTask.objects.select_related(
            "assigned_to", "workflow_instance__document"
        ).get(id=task_id)
    except WorkflowTask.DoesNotExist:
        return
    if not task.assigned_to:
        return
    doc = task.workflow_instance.document
    Notification.objects.create(
        recipient=task.assigned_to,
        message=f"Action required: {task.step.name} for {doc.title} ({doc.reference_number})",
        link=f"/documents/{doc.id}",
    )

@shared_task(queue="notifications")
def notify_workflow_complete(instance_id: str, outcome: str):
    from apps.workflows.models import WorkflowInstance
    from .models import Notification
    try:
        instance = WorkflowInstance.objects.select_related(
            "document", "started_by"
        ).get(id=instance_id)
    except WorkflowInstance.DoesNotExist:
        return
    doc = instance.document
    verb = "approved" if outcome == "approved" else "rejected"
    Notification.objects.create(
        recipient=instance.started_by,
        message=f"Your document '{doc.title}' ({doc.reference_number}) has been {verb}.",
        link=f"/documents/{doc.id}",
    )
