"""
apps/notifications/tasks.py
All notification tasks — in-app + email for every workflow event.
"""
from celery import shared_task
from django.core.mail import send_mail
from django.conf import settings
import logging

logger = logging.getLogger(__name__)


def _send_email(recipient, subject: str, body: str) -> None:
    """Fire-and-forget email. Logs on failure, never raises."""
    if not recipient or not recipient.email:
        return
    try:
        send_mail(
            subject=subject,
            message=body,
            from_email=settings.DEFAULT_FROM_EMAIL,
            recipient_list=[recipient.email],
            fail_silently=False,
        )
    except Exception as exc:
        logger.warning("Email send failed to %s: %s", recipient.email, exc)


def _create_notification(recipient, message: str, link: str = "") -> None:
    """Create an in-app Notification row."""
    try:
        from .models import Notification
        Notification.objects.create(
            recipient=recipient,
            message=message,
            link=link,
        )
    except Exception as exc:
        logger.warning("In-app notification failed: %s", exc)


# ── Task assigned ─────────────────────────────────────────────────────────────

@shared_task(queue="notifications")
def notify_task_assigned(task_id: str) -> None:
    from apps.workflows.models import WorkflowTask
    try:
        task = WorkflowTask.objects.select_related(
            "assigned_to", "step", "workflow_instance__document"
        ).get(id=task_id)
    except WorkflowTask.DoesNotExist:
        return

    if not task.assigned_to:
        return

    doc     = task.workflow_instance.document
    link    = f"/documents/{doc.id}"
    message = (
        f"Action required: '{task.step.name}' for "
        f"{doc.title} ({doc.reference_number})"
    )

    _create_notification(task.assigned_to, message, link)
    _send_email(
        task.assigned_to,
        subject=f"DMS — Approval required: {doc.reference_number}",
        body=(
            f"Hello {task.assigned_to.first_name},\n\n"
            f"A document requires your approval.\n\n"
            f"  Document: {doc.title}\n"
            f"  Reference: {doc.reference_number}\n"
            f"  Step: {task.step.name}\n"
            f"  Instructions: {task.step.instructions or 'None'}\n"
            + (f"  Due by: {task.due_at.strftime('%d %b %Y %H:%M UTC')}\n" if task.due_at else "")
            + f"\nPlease log in to DMS to action this request.\n"
        ),
    )


# ── Workflow complete ─────────────────────────────────────────────────────────

@shared_task(queue="notifications")
def notify_workflow_complete(instance_id: str, outcome: str) -> None:
    from apps.workflows.models import WorkflowInstance
    try:
        instance = WorkflowInstance.objects.select_related(
            "document", "started_by"
        ).get(id=instance_id)
    except WorkflowInstance.DoesNotExist:
        return

    doc    = instance.document
    verb   = "approved" if outcome == "approved" else "rejected"
    link   = f"/documents/{doc.id}"
    msg    = f"Your document '{doc.title}' ({doc.reference_number}) has been {verb}."

    _create_notification(instance.started_by, msg, link)
    _send_email(
        instance.started_by,
        subject=f"DMS — Document {verb}: {doc.reference_number}",
        body=(
            f"Hello {instance.started_by.first_name},\n\n"
            f"Your document has been {verb}.\n\n"
            f"  Document: {doc.title}\n"
            f"  Reference: {doc.reference_number}\n"
            f"  Status: {verb.capitalize()}\n\n"
            f"Log in to DMS to view the document.\n"
        ),
    )


# ── Document returned for review ──────────────────────────────────────────────

@shared_task(queue="notifications")
def notify_document_returned(task_id: str, comment: str) -> None:
    """
    Notify the document uploader AND the document owner (if different)
    that the document has been returned for rework.
    """
    from apps.workflows.models import WorkflowTask
    try:
        task = WorkflowTask.objects.select_related(
            "assigned_to", "step",
            "workflow_instance__document__uploaded_by",
            "workflow_instance__document__owned_by",
        ).get(id=task_id)
    except WorkflowTask.DoesNotExist:
        return

    doc      = task.workflow_instance.document
    uploader = doc.uploaded_by
    approver = task.assigned_to
    link     = f"/documents/{doc.id}"

    message = (
        f"Your document '{doc.title}' ({doc.reference_number}) "
        f"has been returned for review by {approver.get_full_name() if approver else 'an approver'}. "
        f"Reason: {comment}"
    )

    _create_notification(uploader, message, link)
    _send_email(
        uploader,
        subject=f"DMS — Document returned for review: {doc.reference_number}",
        body=(
            f"Hello {uploader.first_name},\n\n"
            f"Your document has been returned and requires your attention.\n\n"
            f"  Document: {doc.title}\n"
            f"  Reference: {doc.reference_number}\n"
            f"  Returned by: {approver.get_full_name() if approver else 'Approver'}\n"
            f"  Reason: {comment}\n\n"
            f"Please update the document and resubmit for approval.\n\n"
            f"Log in to DMS to view and resubmit.\n"
        ),
    )

    # Also notify the owner if different from uploader
    if doc.owned_by and doc.owned_by != uploader:
        _create_notification(doc.owned_by, message, link)


# ── Document placed on hold ───────────────────────────────────────────────────

@shared_task(queue="notifications")
def notify_document_held(task_id: str, comment: str, hold_hours: int) -> None:
    """Notify the document uploader that their document has been put on hold."""
    from apps.workflows.models import WorkflowTask
    try:
        task = WorkflowTask.objects.select_related(
            "assigned_to", "step",
            "workflow_instance__document__uploaded_by",
        ).get(id=task_id)
    except WorkflowTask.DoesNotExist:
        return

    doc      = task.workflow_instance.document
    uploader = doc.uploaded_by
    approver = task.assigned_to
    link     = f"/documents/{doc.id}"

    # Human-readable duration
    if hold_hours < 24:
        duration = f"{hold_hours} hour{'s' if hold_hours != 1 else ''}"
    elif hold_hours % 24 == 0:
        days = hold_hours // 24
        duration = f"{days} day{'s' if days != 1 else ''}"
    else:
        duration = f"{hold_hours // 24}d {hold_hours % 24}h"

    message = (
        f"Your document '{doc.title}' ({doc.reference_number}) "
        f"has been placed on hold for {duration}. "
        f"Reason: {comment}"
    )

    _create_notification(uploader, message, link)
    _send_email(
        uploader,
        subject=f"DMS — Document on hold: {doc.reference_number}",
        body=(
            f"Hello {uploader.first_name},\n\n"
            f"Your document has been placed on hold.\n\n"
            f"  Document: {doc.title}\n"
            f"  Reference: {doc.reference_number}\n"
            f"  Held by: {approver.get_full_name() if approver else 'Approver'}\n"
            f"  Duration: {duration}\n"
            f"  Reason: {comment}\n\n"
            f"The document will resume the approval process automatically "
            f"after the hold period ends, or when manually released.\n\n"
            f"Log in to DMS to view the document status.\n"
        ),
    )


# ── Hold released (manual) ────────────────────────────────────────────────────

@shared_task(queue="notifications")
def notify_hold_released(task_id: str) -> None:
    """Notify the approver that the hold has been manually released."""
    from apps.workflows.models import WorkflowTask
    try:
        task = WorkflowTask.objects.select_related(
            "assigned_to", "step",
            "workflow_instance__document__uploaded_by",
        ).get(id=task_id)
    except WorkflowTask.DoesNotExist:
        return

    doc      = task.workflow_instance.document
    uploader = doc.uploaded_by
    approver = task.assigned_to
    link     = f"/documents/{doc.id}"

    # Notify uploader
    msg_uploader = (
        f"The hold on '{doc.title}' ({doc.reference_number}) "
        f"has been released. It is back in the approval queue."
    )
    _create_notification(uploader, msg_uploader, link)
    _send_email(
        uploader,
        subject=f"DMS — Hold released: {doc.reference_number}",
        body=(
            f"Hello {uploader.first_name},\n\n"
            f"The hold on your document has been released.\n\n"
            f"  Document: {doc.title}\n"
            f"  Reference: {doc.reference_number}\n\n"
            f"The document is now back in the approval queue.\n"
        ),
    )

    # Notify approver their task is active again
    if approver:
        msg_approver = (
            f"The hold on '{doc.title}' ({doc.reference_number}) "
            f"has been released. Your approval task is now active."
        )
        _create_notification(approver, msg_approver, link)
        _send_email(
            approver,
            subject=f"DMS — Hold released, action required: {doc.reference_number}",
            body=(
                f"Hello {approver.first_name},\n\n"
                f"The hold you placed on the following document has been released.\n\n"
                f"  Document: {doc.title}\n"
                f"  Reference: {doc.reference_number}\n"
                f"  Step: {task.step.name}\n\n"
                f"Please log in to DMS to continue the approval.\n"
            ),
        )


# ── Hold auto-released by Celery ──────────────────────────────────────────────

@shared_task(queue="notifications")
def notify_hold_auto_released(task_id: str) -> None:
    """Notify the approver when Celery auto-releases their hold."""
    from apps.workflows.models import WorkflowTask
    try:
        task = WorkflowTask.objects.select_related(
            "assigned_to", "step",
            "workflow_instance__document",
        ).get(id=task_id)
    except WorkflowTask.DoesNotExist:
        return

    approver = task.assigned_to
    if not approver:
        return

    doc  = task.workflow_instance.document
    link = f"/documents/{doc.id}"

    msg = (
        f"Your hold on '{doc.title}' ({doc.reference_number}) "
        f"has expired. The document is awaiting your approval."
    )
    _create_notification(approver, msg, link)
    _send_email(
        approver,
        subject=f"DMS — Hold expired, action required: {doc.reference_number}",
        body=(
            f"Hello {approver.first_name},\n\n"
            f"The hold period you set on a document has expired.\n\n"
            f"  Document: {doc.title}\n"
            f"  Reference: {doc.reference_number}\n"
            f"  Step: {task.step.name}\n\n"
            f"Please log in to DMS to action this approval.\n"
        ),
    )


# ── Task overdue (SLA breach) ─────────────────────────────────────────────────

@shared_task(queue="notifications")
def notify_task_overdue(task_id: str) -> None:
    """Called by Celery Beat for SLA breaches."""
    from apps.workflows.models import WorkflowTask
    try:
        task = WorkflowTask.objects.select_related(
            "assigned_to", "step", "workflow_instance__document"
        ).get(id=task_id)
    except WorkflowTask.DoesNotExist:
        return

    if not task.assigned_to:
        return

    doc  = task.workflow_instance.document
    link = f"/documents/{doc.id}"

    msg  = (
        f"OVERDUE: Your approval task for '{doc.title}' "
        f"({doc.reference_number}) has passed its SLA deadline."
    )
    _create_notification(task.assigned_to, msg, link)
    _send_email(
        task.assigned_to,
        subject=f"DMS — SLA overdue: {doc.reference_number}",
        body=(
            f"Hello {task.assigned_to.first_name},\n\n"
            f"An approval task has passed its SLA deadline and requires urgent action.\n\n"
            f"  Document: {doc.title}\n"
            f"  Reference: {doc.reference_number}\n"
            f"  Step: {task.step.name}\n"
            f"  Was due: {task.due_at.strftime('%d %b %Y %H:%M UTC') if task.due_at else 'N/A'}\n\n"
            f"Please log in to DMS immediately.\n"
        ),
    )


# ── Workflow action (approve, reject, held, released, returned) ────────────────

@shared_task(queue="notifications")
def notify_workflow_action(action_id: str, user_ids: list[str] = None) -> None:
    """
    Notify users of any workflow action: approve, reject, hold, release, return.
    Sends both in-app and email notifications with context-specific messages.
    """
    from apps.workflows.models import WorkflowTaskAction, WorkflowTask
    from django.contrib.auth import get_user_model
    
    User = get_user_model()
    
    try:
        action = WorkflowTaskAction.objects.select_related(
            "task__step",
            "task__assigned_to",
            "task__workflow_instance__document__uploaded_by",
            "actor",
        ).get(id=action_id)
    except WorkflowTaskAction.DoesNotExist:
        return
    
    task = action.task
    doc = task.workflow_instance.document
    uploader = doc.uploaded_by
    approver = task.assigned_to
    actor = action.actor
    link = f"/documents/{doc.id}"
    
    # Determine action-specific messaging
    action_type = action.action
    
    if action_type == "approved":
        msg_uploader = f"✓ Approved: Your document '{doc.title}' ({doc.reference_number}) has been approved by {actor.get_full_name()}."
        subject_uploader = f"DMS — Document approved: {doc.reference_number}"
        body_uploader = (
            f"Hello {uploader.first_name},\n\n"
            f"Your document has been approved.\n\n"
            f"  Document: {doc.title}\n"
            f"  Reference: {doc.reference_number}\n"
            f"  Approved by: {actor.get_full_name()}\n"
            f"  Step: {task.step.name}\n"
            + (f"  Comment: {action.comment}\n" if action.comment else "")
            + f"\nLog in to DMS to view the document status.\n"
        )
    
    elif action_type == "rejected":
        msg_uploader = f"✗ Rejected: Your document '{doc.title}' ({doc.reference_number}) has been rejected by {actor.get_full_name()}."
        subject_uploader = f"DMS — Document rejected: {doc.reference_number}"
        body_uploader = (
            f"Hello {uploader.first_name},\n\n"
            f"Your document has been rejected and requires revision.\n\n"
            f"  Document: {doc.title}\n"
            f"  Reference: {doc.reference_number}\n"
            f"  Rejected by: {actor.get_full_name()}\n"
            f"  Step: {task.step.name}\n"
            + (f"  Reason: {action.comment}\n" if action.comment else "")
            + f"\nPlease make the required changes and resubmit.\n"
        )
    
    elif action_type == "returned":
        return_destination = {
            "previous_step": "the previous approver",
            "uploader": "you for further review",
            "same_step": "another approver in this step",
        }.get(action.return_to, "for review")
        
        msg_uploader = f"↩ Returned: Your document '{doc.title}' ({doc.reference_number}) has been returned {return_destination}."
        subject_uploader = f"DMS — Document returned for review: {doc.reference_number}"
        body_uploader = (
            f"Hello {uploader.first_name},\n\n"
            f"Your document has been returned and requires your attention.\n\n"
            f"  Document: {doc.title}\n"
            f"  Reference: {doc.reference_number}\n"
            f"  Returned by: {actor.get_full_name()}\n"
            f"  Returned to: {return_destination}\n"
            + (f"  Reason: {action.comment}\n" if action.comment else "")
            + f"\nPlease make the required changes and resubmit for approval.\n"
        )
    
    elif action_type == "held":
        hold_duration = f"{action.hold_hours} hour{'s' if action.hold_hours != 1 else ''}" if action.hold_hours else "indefinitely"
        msg_uploader = f"⏸ On Hold: Your document '{doc.title}' ({doc.reference_number}) has been placed on hold for {hold_duration}."
        subject_uploader = f"DMS — Document on hold: {doc.reference_number}"
        body_uploader = (
            f"Hello {uploader.first_name},\n\n"
            f"Your document has been placed on hold during the approval process.\n\n"
            f"  Document: {doc.title}\n"
            f"  Reference: {doc.reference_number}\n"
            f"  Held by: {actor.get_full_name()}\n"
            f"  Duration: {hold_duration}\n"
            + (f"  Reason: {action.comment}\n" if action.comment else "")
            + f"\nThe document will resume processing after the hold period, or when manually released.\n"
        )
    
    elif action_type == "released":
        msg_uploader = f"▶ Released: The hold on your document '{doc.title}' ({doc.reference_number}) has been released."
        subject_uploader = f"DMS — Hold released: {doc.reference_number}"
        body_uploader = (
            f"Hello {uploader.first_name},\n\n"
            f"The hold on your document has been released.\n\n"
            f"  Document: {doc.title}\n"
            f"  Reference: {doc.reference_number}\n"
            f"  Released by: {actor.get_full_name()}\n"
            f"  Step: {task.step.name}\n\n"
            f"The document is now back in the approval queue.\n"
        )
    
    else:
        # Generic fallback for unknown action types
        msg_uploader = f"Document '{doc.title}' ({doc.reference_number}): {action.get_action_display()} by {actor.get_full_name()}."
        subject_uploader = f"DMS — Document action: {doc.reference_number}"
        body_uploader = (
            f"Hello {uploader.first_name},\n\n"
            f"An action has been taken on your document.\n\n"
            f"  Document: {doc.title}\n"
            f"  Reference: {doc.reference_number}\n"
            f"  Action: {action.get_action_display()}\n"
            f"  By: {actor.get_full_name()}\n\n"
            f"Log in to DMS to view the document status.\n"
        )
    
    # Notify the uploader
    _create_notification(uploader, msg_uploader, link)
    _send_email(uploader, subject_uploader, body_uploader)
    
    # Also notify other specified users if provided
    if user_ids:
        other_users = User.objects.filter(id__in=user_ids).exclude(id=uploader.id)
        for user in other_users:
            _create_notification(user, msg_uploader, link)
            _send_email(user, subject_uploader, body_uploader)
