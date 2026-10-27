"""
apps/workflows/tasks.py
Celery tasks for the workflow engine.
"""
from celery import shared_task
from django.db import models
import logging

logger = logging.getLogger(__name__)


@shared_task(queue="default")
def resume_ready_lpo_gates() -> int:
    """Mark LPO approval gates ready when their posting callback was missed.

    The service rechecks approval, posting, and generated-document state. It
    leaves the assigned approver's task waiting until they explicitly submit
    the generated LPOs to the next step.
    """
    from .models import WorkflowInstance
    from .services import WorkflowService

    candidates = (
        WorkflowInstance.objects
        .filter(
            status="in_progress",
            tasks__status__in=["approved", "awaiting_posting"],
            tasks__actions__action="approved",
        )
        .filter(
            models.Q(tasks__step__post_lpo_after_approval=True)
            | models.Q(tasks__step__post_imprest_request_after_approval=True)
        )
        .select_related("document")
        .distinct()
    )
    resumed = 0
    for instance in candidates.iterator():
        if not instance.document_id:
            continue
        try:
            resumed_imprest = WorkflowService._resume_imprest_request_workflow_if_ready(instance.document)
            resumed_lpo = WorkflowService._resume_lpo_workflow_if_ready(instance.document)
            if resumed_imprest or resumed_lpo:
                resumed += 1
        except Exception:
            logger.exception(
                "Failed to recover ready LPO approval gate for workflow %s",
                instance.pk,
            )
    return resumed


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
        from apps.notifications.tasks import notify_hold_auto_released, notify_task_overdue
        notify_hold_auto_released.delay(task_id)
        if task.due_at and task.due_at <= timezone.now():
            notify_task_overdue.delay(task_id)

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


@shared_task(queue="default")
def notify_sla_warning_tasks() -> None:
    """
    Sends near-SLA notifications for active tasks approaching their due_at time.
    Useful as a periodic backstop in addition to ETA tasks scheduled at creation.
    """
    from .services import WorkflowService
    from apps.notifications.tasks import notify_task_sla_warning

    for task in WorkflowService.get_sla_warning_tasks():
        try:
            notify_task_sla_warning.delay(str(task.id))
        except Exception as exc:
            logger.warning("notify_sla_warning_tasks: task %s error: %s", task.id, exc)


@shared_task(queue="default")
def notify_hold_ending_tasks() -> None:
    """
    Sends notifications for held tasks whose scheduled hold end is approaching.
    Useful as a periodic backstop in addition to ETA tasks scheduled at hold time.
    """
    from .services import WorkflowService
    from apps.notifications.tasks import notify_hold_ending

    for task in WorkflowService.get_hold_ending_tasks():
        try:
            notify_hold_ending.delay(str(task.id))
        except Exception as exc:
            logger.warning("notify_hold_ending_tasks: task %s error: %s", task.id, exc)
