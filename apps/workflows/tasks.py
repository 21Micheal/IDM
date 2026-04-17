"""
apps/workflows/tasks.py
Celery tasks for the workflow engine.
"""
from celery import shared_task
import logging

logger = logging.getLogger(__name__)


@shared_task(bind=True, max_retries=3, queue="default")
def auto_release_hold(self, task_id: str) -> None:
    """
    Auto-release a held WorkflowTask when its hold_until time has passed.
    Scheduled at hold time by WorkflowService.hold().
    """
    from .models import WorkflowTask
    from .services import WorkflowService, WorkflowError
    from django.utils import timezone

    try:
        task = WorkflowTask.objects.select_related(
            "step", "workflow_instance__document"
        ).get(id=task_id)
    except WorkflowTask.DoesNotExist:
        logger.warning("auto_release_hold: task %s not found", task_id)
        return

    # Guard: only release if still held and past the hold_until time
    if task.status != "held":
        logger.info("auto_release_hold: task %s is no longer held (%s)", task_id, task.status)
        return

    if task.held_until and task.held_until > timezone.now():
        logger.info("auto_release_hold: task %s hold has not expired yet", task_id)
        return

    try:
        WorkflowService.release_hold(task, actor=None, auto=True)
        logger.info("auto_release_hold: task %s released", task_id)

        # Notify the assigned approver that their task is active again
        from apps.notifications.tasks import notify_hold_auto_released
        notify_hold_auto_released.delay(task_id)

    except WorkflowError as exc:
        logger.warning("auto_release_hold: %s", exc)
    except Exception as exc:
        logger.error("auto_release_hold error: %s", exc)
        raise self.retry(exc=exc, countdown=60)


@shared_task(queue="default")
def escalate_overdue_tasks() -> None:
    """
    Called by Celery Beat. Sends escalation notifications for tasks
    that have been in_progress past their SLA due_at time.
    """
    from .services import WorkflowService
    from apps.notifications.tasks import notify_task_overdue

    overdue = WorkflowService.get_overdue_tasks()
    for task in overdue:
        try:
            notify_task_overdue.delay(str(task.id))
        except Exception as exc:
            logger.warning("escalate_overdue: task %s error: %s", task.id, exc)
