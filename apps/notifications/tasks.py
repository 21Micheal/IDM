"""
apps/notifications/tasks.py
All notification tasks — in-app + email for every workflow event.
"""
from celery import shared_task
from django.core.mail import send_mail
from django.conf import settings
from django.db import IntegrityError
import logging

logger = logging.getLogger(__name__)


def _email_footer(link: str = "") -> str:
    base = settings.FRONTEND_URL.rstrip("/")
    footer = "\n\n"
    if link:
        footer += f"Open it directly: {base}{link}\n"
    footer += f"Log in to DMS: {base}\n"
    return footer


def _send_email_to_address(email: str, subject: str, body: str, link: str = "") -> None:
    """Send email to a raw address (no User record required)."""
    if not email:
        return
    try:
        send_mail(
            subject=subject,
            message=body + _email_footer(link),
            from_email=settings.DEFAULT_FROM_EMAIL,
            recipient_list=[email],
            fail_silently=False,
        )
    except Exception as exc:
        logger.warning("Email send failed to %s: %s", email, exc)


def _send_email(recipient, subject: str, body: str, link: str = "") -> None:
    """Fire-and-forget email. Logs on failure, never raises.

    Appends a footer pointing at the live system (settings.FRONTEND_URL) so
    recipients can log in from the email. If ``link`` (a relative path such as
    ``/documents/<id>``) is given, a direct deep-link is included too.
    """
    if not recipient or not recipient.email:
        return

    try:
        send_mail(
            subject=subject,
            message=body + _email_footer(link),
            from_email=settings.DEFAULT_FROM_EMAIL,
            recipient_list=[recipient.email],
            fail_silently=False,
        )
    except Exception as exc:
        logger.warning("Email send failed to %s: %s", recipient.email, exc)


def _render_email_template(template: str, **ctx) -> str:
    """Substitute {placeholder} tokens in a custom email subject or body."""
    if not template:
        return template
    try:
        return template.format(**ctx)
    except (KeyError, IndexError, ValueError) as exc:
        logger.warning("Email template render failed: %s", exc)
        return template


def _render_approver_email_template(template: str, **ctx) -> str:
    return _render_email_template(template, **ctx)


def _template_email_parts(workflow_template, key: str) -> tuple[str | None, str | None]:
    """Return (subject, body) overrides for a template event key, or (None, None)."""
    if not workflow_template:
        return None, None
    entry = (getattr(workflow_template, "email_templates", None) or {}).get(key) or {}
    subject = (entry.get("subject") or "").strip() or None
    body = (entry.get("body") or "").strip() or None
    return subject, body


def _resolve_email(
    workflow_template,
    key: str,
    default_subject: str,
    default_body: str,
    **ctx,
) -> tuple[str, str]:
    custom_subject, custom_body = _template_email_parts(workflow_template, key)
    subject = _render_email_template(custom_subject, **ctx) if custom_subject else default_subject
    body = _render_email_template(custom_body, **ctx) if custom_body else default_body
    return subject, body


def _document_url(document_id) -> str:
    return f"{settings.FRONTEND_URL.rstrip('/')}/documents/{document_id}"


def _create_notification(recipient, message: str, link: str = "", notification_type: str = "task_assigned") -> None:
    """Create an in-app Notification row."""
    try:
        from .models import Notification
        Notification.objects.create(
            recipient=recipient,
            type=notification_type,
            message=message,
            link=link,
        )
    except Exception as exc:
        logger.warning("In-app notification failed: %s", exc)


def _create_once(recipient, message: str, link: str = "", notification_type: str = "task_assigned") -> bool:
    """
    Create a notification only if the same exact notice does not already exist.

    This is intentionally conservative: it prevents noisy recurring tasks from
    flooding an inbox while still allowing distinct workflow actions through.
    """
    if not recipient:
        return False
    try:
        from .models import Notification

        _, created = Notification.objects.get_or_create(
            recipient=recipient,
            type=notification_type,
            message=message,
            link=link,
        )
        return created
    except IntegrityError:
        return False
    except Exception as exc:
        logger.warning("In-app notification failed: %s", exc)
        return False


# ── Task assigned ─────────────────────────────────────────────────────────────

def _notify_delegates_of_task(task, *, only_delegation=None) -> None:
    """Alert active delegates who can action this task on the delegator's behalf."""
    from apps.accounts.delegation import active_delegations_qs, delegation_covers_task

    if task.status != "in_progress" or not task.assigned_to_id:
        return

    doc = task.workflow_instance.document
    link = f"/documents/{doc.id}"
    delegator_name = task.assigned_to.get_full_name() or task.assigned_to.email
    message = (
        f"Delegated action required: '{task.step.name}' for "
        f"{doc.title} ({doc.reference_number}) — on behalf of {delegator_name}"
    )
    body = (
        f"A workflow task has been delegated to you by {delegator_name}.\n\n"
        f"  Document: {doc.title}\n"
        f"  Reference: {doc.reference_number}\n"
        f"  Step: {task.step.name}\n"
        f"  Instructions: {task.step.instructions or 'None'}\n"
        + (f"  Due by: {task.due_at.strftime('%d %b %Y %H:%M UTC')}\n" if task.due_at else "")
        + f"\nPlease log in to DMS to action this request.\n"
    )

    if only_delegation is not None:
        delegations = [only_delegation]
    else:
        delegations = active_delegations_qs(delegator=task.assigned_to)

    for delegation in delegations:
        if only_delegation is None and not delegation_covers_task(delegation, task):
            continue
        _create_once(delegation.delegate, message, link, "delegation")
        _send_email(
            delegation.delegate,
            subject=f"DMS — Delegated approval: {doc.reference_number}",
            body=f"Hello {delegation.delegate.first_name},\n\n{body}",
            link=link,
        )


@shared_task(queue="notifications")
def notify_task_assigned(
    task_id: str,
    custom_subject: str | None = None,
    custom_body: str | None = None,
) -> None:
    from apps.workflows.models import WorkflowTask
    try:
        task = WorkflowTask.objects.select_related(
            "assigned_to", "step", "workflow_instance__document"
        ).get(id=task_id)
    except WorkflowTask.DoesNotExist:
        return

    if task.status != "in_progress" or not task.assigned_to:
        return

    doc     = task.workflow_instance.document
    link    = f"/documents/{doc.id}"
    message = (
        f"Action required: '{task.step.name}' for "
        f"{doc.title} ({doc.reference_number})"
    )

    _create_notification(task.assigned_to, message, link, "task_assigned")

    base = settings.FRONTEND_URL.rstrip("/")
    document_url = f"{base}{link}"
    approver_name = task.assigned_to.get_full_name() or task.assigned_to.email
    ctx = dict(
        approver_name=approver_name,
        document_title=doc.title,
        document_ref=doc.reference_number,
        step_name=task.step.name,
        instructions=task.step.instructions or "None",
        document_url=document_url,
    )

    if custom_subject or custom_body:
        subject = _render_approver_email_template(custom_subject or "", **ctx) or (
            f"DMS — Approval required: {doc.reference_number}"
        )
        body = _render_approver_email_template(custom_body or "", **ctx) or (
            f"Hello {task.assigned_to.first_name},\n\n"
            f"A document requires your approval.\n\n"
            f"  Document: {doc.title}\n"
            f"  Reference: {doc.reference_number}\n"
            f"  Step: {task.step.name}\n"
            f"  Instructions: {task.step.instructions or 'None'}\n"
            + (f"  Due by: {task.due_at.strftime('%d %b %Y %H:%M UTC')}\n" if task.due_at else "")
            + f"\nPlease log in to DMS to action this request.\n"
        )
    else:
        subject = f"DMS — Approval required: {doc.reference_number}"
        body = (
            f"Hello {task.assigned_to.first_name},\n\n"
            f"A document requires your approval.\n\n"
            f"  Document: {doc.title}\n"
            f"  Reference: {doc.reference_number}\n"
            f"  Step: {task.step.name}\n"
            f"  Instructions: {task.step.instructions or 'None'}\n"
            + (f"  Due by: {task.due_at.strftime('%d %b %Y %H:%M UTC')}\n" if task.due_at else "")
            + f"\nPlease log in to DMS to action this request.\n"
        )

    _send_email(task.assigned_to, subject=subject, body=body, link=link)
    _notify_delegates_of_task(task)


# ── Delegation ─────────────────────────────────────────────────────────────────

@shared_task(queue="notifications")
def notify_delegation_activated(delegation_id: str) -> None:
    """
    When a delegation becomes active, alert the delegate about each delegable task.
    Safe to call immediately on create (current delegation) or via ETA at starts_at.
    """
    from apps.accounts.delegation import delegation_covers_task, tasks_for_delegation
    from apps.accounts.models import UserDelegation

    try:
        delegation = UserDelegation.objects.select_related(
            "delegator", "delegate", "document_type",
        ).get(id=delegation_id)
    except UserDelegation.DoesNotExist:
        return

    if not delegation.is_active or not delegation.is_current:
        return

    tasks = tasks_for_delegation(delegation).select_related(
        "assigned_to", "step", "workflow_instance__document",
    )
    task_count = tasks.count()
    if task_count == 0:
        return

    delegator_name = delegation.delegator.get_full_name() or delegation.delegator.email
    link = "/workflow"
    summary = (
        f"Workflow tasks delegated from {delegator_name} are now ready for your action."
    )
    _create_once(delegation.delegate, summary, link, "delegation")

    for task in tasks:
        if not delegation_covers_task(delegation, task):
            continue
        doc = task.workflow_instance.document
        task_link = f"/documents/{doc.id}"
        _create_once(
            delegation.delegate,
            f"Delegated action required: '{task.step.name}' for {doc.title} ({doc.reference_number})",
            task_link,
            "delegation"
        )


@shared_task(queue="notifications")
def send_workflow_notification_step_email(
    recipient_user_id: str | None,
    recipient_email: str | None,
    subject: str,
    message: str,
    document_id: str,
    step_name: str = "",
) -> None:
    """
    Send the email configured on a workflow notification step.
    System users also receive an in-app notification; external addresses get email only.
    """
    from django.contrib.auth import get_user_model

    link = f"/documents/{document_id}"
    in_app_message = (
        f"Workflow notification: '{step_name}'"
        if step_name
        else "Workflow notification"
    )

    if recipient_user_id:
        User = get_user_model()
        try:
            recipient = User.objects.get(id=recipient_user_id, is_active=True)
        except User.DoesNotExist:
            logger.warning(
                "Notification step recipient user %s not found", recipient_user_id
            )
            return
        _create_notification(recipient, in_app_message, link, "workflow_action")
        _send_email(recipient, subject=subject, body=message, link=link)
        return

    if recipient_email:
        _send_email_to_address(recipient_email, subject=subject, body=message, link=link)
        return

    logger.warning(
        "Notification step email skipped for document %s: no recipient configured",
        document_id,
    )


# ── Workflow complete ─────────────────────────────────────────────────────────

@shared_task(queue="notifications")
def notify_workflow_complete(instance_id: str, outcome: str) -> None:
    from apps.workflows.models import WorkflowInstance
    try:
        instance = WorkflowInstance.objects.select_related(
            "document", "started_by", "template"
        ).get(id=instance_id)
    except WorkflowInstance.DoesNotExist:
        return

    doc      = instance.document
    verb     = "approved" if outcome == "approved" else "rejected"
    link     = f"/documents/{doc.id}"
    msg      = f"Your document '{doc.title}' ({doc.reference_number}) has been {verb}."
    recipient = instance.started_by
    ctx = dict(
        recipient_name=recipient.first_name,
        document_title=doc.title,
        document_ref=doc.reference_number,
        outcome=verb,
        outcome_label=verb.capitalize(),
        document_url=_document_url(doc.id),
    )
    default_subject = f"DMS — Document {verb}: {doc.reference_number}"
    default_body = (
        f"Hello {recipient.first_name},\n\n"
        f"Your document has been {verb}.\n\n"
        f"  Document: {doc.title}\n"
        f"  Reference: {doc.reference_number}\n"
        f"  Status: {verb.capitalize()}\n\n"
        f"Log in to DMS to view the document.\n"
    )
    subject, body = _resolve_email(
        instance.template, "workflow_complete", default_subject, default_body, **ctx
    )

    _create_notification(recipient, msg, link, "workflow_complete")
    _send_email(recipient, subject=subject, body=body, link=link)


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

    _create_notification(uploader, message, link, "document_returned")
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
        link=link,
    )

    # Also notify the owner if different from uploader
    if doc.owned_by and doc.owned_by != uploader:
        _create_notification(doc.owned_by, message, link, "document_returned")


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

    _create_notification(uploader, message, link, "document_held")
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
        link=link,
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
    _create_notification(uploader, msg_uploader, link, "hold_released")
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
        link=link,
    )

    # Notify approver their task is active again
    if approver:
        msg_approver = (
            f"The hold on '{doc.title}' ({doc.reference_number}) "
            f"has been released. Your approval task is now active."
        )
        _create_notification(approver, msg_approver, link, "hold_released")
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
            link=link,
        )


# ── Hold auto-released by Celery ──────────────────────────────────────────────

@shared_task(queue="notifications")
def notify_hold_ending(task_id: str) -> None:
    """Notify the approver when a scheduled hold is approaching its end."""
    from apps.workflows.models import WorkflowTask
    try:
        task = WorkflowTask.objects.select_related(
            "assigned_to", "step",
            "workflow_instance__document",
            "workflow_instance__template",
        ).get(id=task_id)
    except WorkflowTask.DoesNotExist:
        return

    if task.status != "held" or not task.held_until or not task.assigned_to:
        return

    doc  = task.workflow_instance.document
    link = f"/documents/{doc.id}"
    hold_ends = task.held_until.strftime("%d %b %Y %H:%M UTC")
    msg = (
        f"Hold ending soon: '{doc.title}' ({doc.reference_number}) "
        f"is scheduled to leave hold at {hold_ends}."
    )
    created = _create_once(task.assigned_to, msg, link, "hold_ending")
    if created:
        approver = task.assigned_to
        ctx = dict(
            approver_name=approver.first_name,
            document_title=doc.title,
            document_ref=doc.reference_number,
            step_name=task.step.name,
            hold_ends_at=hold_ends,
            document_url=_document_url(doc.id),
        )
        default_subject = f"DMS — Hold ending soon: {doc.reference_number}"
        default_body = (
            f"Hello {approver.first_name},\n\n"
            f"A hold you scheduled is approaching its end.\n\n"
            f"  Document: {doc.title}\n"
            f"  Reference: {doc.reference_number}\n"
            f"  Step: {task.step.name}\n"
            f"  Hold ends: {hold_ends}\n\n"
            f"Please log in to DMS if you need to action or extend the task.\n"
        )
        subject, body = _resolve_email(
            task.workflow_instance.template, "hold_ending",
            default_subject, default_body, **ctx,
        )
        _send_email(approver, subject=subject, body=body, link=link)


@shared_task(queue="notifications")
def notify_hold_auto_released(task_id: str) -> None:
    """Notify the approver when Celery auto-releases their hold."""
    from apps.workflows.models import WorkflowTask
    try:
        task = WorkflowTask.objects.select_related(
            "assigned_to", "step",
            "workflow_instance__document",
            "workflow_instance__template",
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
    ctx = dict(
        approver_name=approver.first_name,
        document_title=doc.title,
        document_ref=doc.reference_number,
        step_name=task.step.name,
        document_url=_document_url(doc.id),
    )
    default_subject = f"DMS — Hold expired, action required: {doc.reference_number}"
    default_body = (
        f"Hello {approver.first_name},\n\n"
        f"The hold period you set on a document has expired.\n\n"
        f"  Document: {doc.title}\n"
        f"  Reference: {doc.reference_number}\n"
        f"  Step: {task.step.name}\n\n"
        f"Please log in to DMS to action this approval.\n"
    )
    subject, body = _resolve_email(
        task.workflow_instance.template, "hold_expired",
        default_subject, default_body, **ctx,
    )
    _create_notification(approver, msg, link, "hold_expired")
    _send_email(approver, subject=subject, body=body, link=link)


# ── Task overdue (SLA breach) ─────────────────────────────────────────────────

@shared_task(queue="notifications")
def notify_task_sla_warning(task_id: str) -> None:
    """Notify an assignee when their active task is approaching its SLA deadline."""
    from apps.workflows.models import WorkflowTask
    try:
        task = WorkflowTask.objects.select_related(
            "assigned_to", "step",
            "workflow_instance__document",
            "workflow_instance__template",
        ).get(id=task_id)
    except WorkflowTask.DoesNotExist:
        return

    if task.status != "in_progress" or not task.assigned_to or not task.due_at:
        return

    doc  = task.workflow_instance.document
    link = f"/documents/{doc.id}"
    due_at = task.due_at.strftime("%d %b %Y %H:%M UTC")
    msg = (
        f"SLA approaching: Your approval task for '{doc.title}' "
        f"({doc.reference_number}) is due by {due_at}."
    )
    created = _create_once(task.assigned_to, msg, link, "task_sla_warning")
    if created:
        approver = task.assigned_to
        ctx = dict(
            approver_name=approver.first_name,
            document_title=doc.title,
            document_ref=doc.reference_number,
            step_name=task.step.name,
            due_at=due_at,
            document_url=_document_url(doc.id),
        )
        default_subject = f"DMS — SLA approaching: {doc.reference_number}"
        default_body = (
            f"Hello {approver.first_name},\n\n"
            f"An approval task is approaching its SLA deadline.\n\n"
            f"  Document: {doc.title}\n"
            f"  Reference: {doc.reference_number}\n"
            f"  Step: {task.step.name}\n"
            f"  Due by: {due_at}\n\n"
            f"Please log in to DMS to action this request.\n"
        )
        subject, body = _resolve_email(
            task.workflow_instance.template, "sla_warning",
            default_subject, default_body, **ctx,
        )
        _send_email(approver, subject=subject, body=body, link=link)


@shared_task(queue="notifications")
def notify_task_overdue(task_id: str) -> None:
    """Called by Celery Beat for SLA breaches."""
    from apps.workflows.models import WorkflowTask
    try:
        task = WorkflowTask.objects.select_related(
            "assigned_to", "step",
            "workflow_instance__document",
            "workflow_instance__template",
        ).get(id=task_id)
    except WorkflowTask.DoesNotExist:
        return

    # Only an active task can be overdue. A task that has been approved/rejected/
    # returned (or is on hold) must NOT trigger an overdue alert — the ETA-based
    # message scheduled at task creation still fires after the task is actioned,
    # so we re-check the live status here (mirrors notify_task_sla_warning).
    if task.status != "in_progress" or not task.assigned_to:
        return

    doc  = task.workflow_instance.document
    link = f"/documents/{doc.id}"
    due_at = task.due_at.strftime("%d %b %Y %H:%M UTC") if task.due_at else "N/A"

    msg  = (
        f"OVERDUE: Your approval task for '{doc.title}' "
        f"({doc.reference_number}) has passed its SLA deadline."
    )
    created = _create_once(task.assigned_to, msg, link, "task_overdue")
    if created:
        approver = task.assigned_to
        ctx = dict(
            approver_name=approver.first_name,
            document_title=doc.title,
            document_ref=doc.reference_number,
            step_name=task.step.name,
            due_at=due_at,
            document_url=_document_url(doc.id),
        )
        default_subject = f"DMS — SLA overdue: {doc.reference_number}"
        default_body = (
            f"Hello {approver.first_name},\n\n"
            f"An approval task has passed its SLA deadline and requires urgent action.\n\n"
            f"  Document: {doc.title}\n"
            f"  Reference: {doc.reference_number}\n"
            f"  Step: {task.step.name}\n"
            f"  Was due: {due_at}\n\n"
            f"Please log in to DMS immediately.\n"
        )
        subject, body = _resolve_email(
            task.workflow_instance.template, "sla_overdue",
            default_subject, default_body, **ctx,
        )
        _send_email(approver, subject=subject, body=body, link=link)


# ── Clear resolved task notifications ──────────────────────────────────────────

# Actionable task notifications that should disappear once the assignee no longer
# has an open task on the document (it was approved/rejected/returned/skipped).
ACTIONABLE_TASK_NOTIFICATION_TYPES = [
    "task_assigned",
    "task_sla_warning",
    "task_overdue",
    "hold_ending",
    "hold_expired",
    "delegation",
]


def clear_resolved_task_notifications_now(task_id: str) -> int:
    """When a task leaves an assignee's queue, delete their now-stale actionable
    notifications for that document — but only if they have no other open task on
    it — so the notification tray matches reality. Safe to call synchronously
    inside the workflow action transaction. Returns the number deleted."""
    from apps.workflows.models import WorkflowTask
    from apps.notifications.models import Notification
    from apps.accounts.delegation import active_delegations_qs, delegated_tasks_q

    try:
        task = WorkflowTask.objects.select_related("workflow_instance", "assigned_to").get(id=task_id)
    except WorkflowTask.DoesNotExist:
        return 0

    assignee_id = task.assigned_to_id
    if not assignee_id:
        return 0
    document_id = task.workflow_instance.document_id

    # Clear for the original assignee
    still_active = WorkflowTask.objects.filter(
        assigned_to_id=assignee_id,
        workflow_instance__document_id=document_id,
        status__in=["in_progress", "held"],
    ).exists()
    if not still_active:
        deleted, _ = Notification.objects.filter(
            recipient_id=assignee_id,
            type__in=ACTIONABLE_TASK_NOTIFICATION_TYPES,
            link=f"/documents/{document_id}",
        ).delete()
    else:
        deleted = 0

    # Clear for delegates who have no other delegated tasks on this document
    for delegation in active_delegations_qs(delegator=task.assigned_to):
        delegate_id = delegation.delegate_id
        delegated_still_active = WorkflowTask.objects.filter(
            pk__in=delegated_tasks_q(delegation.delegate),
            workflow_instance__document_id=document_id,
            status__in=["in_progress", "held"],
        ).exists()
        if not delegated_still_active:
            delegate_deleted, _ = Notification.objects.filter(
                recipient_id=delegate_id,
                type__in=ACTIONABLE_TASK_NOTIFICATION_TYPES,
                link=f"/documents/{document_id}",
            ).delete()
            deleted += delegate_deleted

    return deleted


@shared_task(queue="notifications")
def clear_resolved_task_notifications(task_id: str) -> None:
    clear_resolved_task_notifications_now(task_id)


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
            "task__workflow_instance__template",
            "actor",
        ).get(id=action_id)
    except WorkflowTaskAction.DoesNotExist:
        return
    
    task = action.task
    doc = task.workflow_instance.document
    uploader = doc.uploaded_by
    if not uploader:
        logger.warning(
            "notify_workflow_action: document %s has no uploader; skipping",
            doc.pk,
        )
        return
    actor = action.actor
    link = f"/documents/{doc.id}"
    workflow_template = task.workflow_instance.template
    actor_name = actor.get_full_name() if actor else "System"
    comment_line = f"  Comment: {action.comment}\n" if action.comment else ""
    reason_line = f"  Reason: {action.comment}\n" if action.comment else ""
    
    # Determine action-specific messaging
    action_type = action.action
    template_key = "action_other"
    
    if action_type == "approved":
        template_key = "action_approved"
        msg_uploader = f"✓ Approved: Your document '{doc.title}' ({doc.reference_number}) has been approved by {actor_name}."
        default_subject = f"DMS — Document approved: {doc.reference_number}"
        default_body = (
            f"Hello {uploader.first_name},\n\n"
            f"Your document has been approved.\n\n"
            f"  Document: {doc.title}\n"
            f"  Reference: {doc.reference_number}\n"
            f"  Approved by: {actor_name}\n"
            f"  Step: {task.step.name}\n"
            + comment_line
            + f"\nLog in to DMS to view the document status.\n"
        )
    
    elif action_type == "rejected":
        template_key = "action_rejected"
        msg_uploader = f"✗ Rejected: Your document '{doc.title}' ({doc.reference_number}) has been rejected by {actor_name}."
        default_subject = f"DMS — Document rejected: {doc.reference_number}"
        default_body = (
            f"Hello {uploader.first_name},\n\n"
            f"Your document has been rejected and requires revision.\n\n"
            f"  Document: {doc.title}\n"
            f"  Reference: {doc.reference_number}\n"
            f"  Rejected by: {actor_name}\n"
            f"  Step: {task.step.name}\n"
            + reason_line
            + f"\nPlease make the required changes and resubmit.\n"
        )
    
    elif action_type == "returned":
        template_key = "action_returned"
        return_destination = {
            "previous_step": "the previous approver",
            "uploader": "you for further review",
            "same_step": "another approver in this step",
        }.get(action.return_to, "for review")
        
        msg_uploader = f"↩ Returned: Your document '{doc.title}' ({doc.reference_number}) has been returned {return_destination}."
        default_subject = f"DMS — Document returned for review: {doc.reference_number}"
        default_body = (
            f"Hello {uploader.first_name},\n\n"
            f"Your document has been returned and requires your attention.\n\n"
            f"  Document: {doc.title}\n"
            f"  Reference: {doc.reference_number}\n"
            f"  Returned by: {actor_name}\n"
            f"  Returned to: {return_destination}\n"
            + reason_line
            + f"\nPlease make the required changes and resubmit for approval.\n"
        )
    
    elif action_type == "held":
        template_key = "action_held"
        hold_duration = f"{action.hold_hours} hour{'s' if action.hold_hours != 1 else ''}" if action.hold_hours else "indefinitely"
        msg_uploader = f"⏸ On Hold: Your document '{doc.title}' ({doc.reference_number}) has been placed on hold for {hold_duration}."
        default_subject = f"DMS — Document on hold: {doc.reference_number}"
        default_body = (
            f"Hello {uploader.first_name},\n\n"
            f"Your document has been placed on hold during the approval process.\n\n"
            f"  Document: {doc.title}\n"
            f"  Reference: {doc.reference_number}\n"
            f"  Held by: {actor_name}\n"
            f"  Duration: {hold_duration}\n"
            + reason_line
            + f"\nThe document will resume processing after the hold period, or when manually released.\n"
        )
    
    elif action_type == "released":
        template_key = "action_released"
        msg_uploader = f"▶ Released: The hold on your document '{doc.title}' ({doc.reference_number}) has been released."
        default_subject = f"DMS — Hold released: {doc.reference_number}"
        default_body = (
            f"Hello {uploader.first_name},\n\n"
            f"The hold on your document has been released.\n\n"
            f"  Document: {doc.title}\n"
            f"  Reference: {doc.reference_number}\n"
            f"  Released by: {actor_name}\n"
            f"  Step: {task.step.name}\n\n"
            f"The document is now back in the approval queue.\n"
        )
    
    else:
        msg_uploader = f"Document '{doc.title}' ({doc.reference_number}): {action.get_action_display()} by {actor_name}."
        default_subject = f"DMS — Document action: {doc.reference_number}"
        default_body = (
            f"Hello {uploader.first_name},\n\n"
            f"An action has been taken on your document.\n\n"
            f"  Document: {doc.title}\n"
            f"  Reference: {doc.reference_number}\n"
            f"  Action: {action.get_action_display()}\n"
            f"  By: {actor_name}\n\n"
            f"Log in to DMS to view the document status.\n"
        )

    return_destination = {
        "previous_step": "the previous approver",
        "uploader": "you for further review",
        "same_step": "another approver in this step",
    }.get(action.return_to, "for review")
    hold_duration = (
        f"{action.hold_hours} hour{'s' if action.hold_hours != 1 else ''}"
        if action.hold_hours else "indefinitely"
    )
    ctx = dict(
        uploader_name=uploader.first_name,
        document_title=doc.title,
        document_ref=doc.reference_number,
        actor_name=actor_name,
        step_name=task.step.name,
        comment=action.comment or "",
        return_destination=return_destination,
        hold_duration=hold_duration,
        document_url=_document_url(doc.id),
    )
    if template_key != "action_other":
        subject_uploader, body_uploader = _resolve_email(
            workflow_template, template_key,
            default_subject, default_body, **ctx,
        )
    else:
        subject_uploader, body_uploader = default_subject, default_body
    
    # Notify the uploader
    _create_notification(uploader, msg_uploader, link, "workflow_action")
    _send_email(uploader, subject_uploader, body_uploader, link=link)
    
    # Also notify other specified users if provided
    if user_ids:
        other_users = User.objects.filter(id__in=user_ids).exclude(id=uploader.id)
        for user in other_users:
            _create_notification(user, msg_uploader, link, "workflow_action")
            _send_email(user, subject_uploader, body_uploader, link=link)


# ── Ad-hoc signature requests ──────────────────────────────────────────────────

def _signature_link(doc_id) -> str:
    return f"/documents/{doc_id}"


@shared_task(queue="notifications")
def notify_signature_requested(signer_id: str, request_id: str) -> None:
    """Tell a signer it's their turn to sign an ad-hoc request."""
    from apps.documents.models import SignatureRequest
    from apps.accounts.models import User
    try:
        req = SignatureRequest.objects.select_related("document", "requested_by").get(id=request_id)
        signer = User.objects.get(id=signer_id)
    except (SignatureRequest.DoesNotExist, User.DoesNotExist):
        return
    if req.status != SignatureRequest.Status.PENDING:
        return

    doc = req.document
    requester = req.requested_by.get_full_name() or req.requested_by.email
    link = _signature_link(doc.id)
    msg = f"{requester} requested your signature on '{doc.title}'."
    _create_once(signer, msg, link, "signature_requested")
    _send_email(
        signer,
        subject=f"DMS — Signature requested: {doc.title}",
        body=(
            f"Hello {signer.first_name},\n\n"
            f"{requester} has requested your signature on a document.\n\n"
            f"  Document: {doc.title}\n"
            + (f"  Note: {req.message}\n" if req.message else "")
            + "\nLog in to DMS to review and sign.\n"
        ),
        link=link,
    )


@shared_task(queue="notifications")
def notify_signature_signed(request_id: str, signer_id: str) -> None:
    """Notify the requester that a signer signed, and prompt the next signer(s)."""
    from apps.documents.models import SignatureRequest, SignatureRequestSigner
    from apps.accounts.models import User
    try:
        req = SignatureRequest.objects.select_related("document", "requested_by").get(id=request_id)
    except SignatureRequest.DoesNotExist:
        return
    doc = req.document
    link = _signature_link(doc.id)

    signed = req.signers.filter(status=SignatureRequestSigner.Status.SIGNED).count()
    total = req.signers.count()
    try:
        who = User.objects.get(id=signer_id)
        who_name = who.get_full_name() or who.email
    except User.DoesNotExist:
        who_name = "A signer"
    _create_notification(
        req.requested_by,
        f"{who_name} signed '{doc.title}' ({signed}/{total} signed).",
        link, "signature_signed",
    )

    # Prompt whoever can sign next (ordered -> the new current signer(s)).
    if req.status == SignatureRequest.Status.PENDING:
        for s in req.current_pending_signers():
            notify_signature_requested.delay(str(s.signer_id), str(req.id))


@shared_task(queue="notifications")
def notify_signature_declined(request_id: str, signer_id: str) -> None:
    from apps.documents.models import SignatureRequest
    from apps.accounts.models import User
    try:
        req = SignatureRequest.objects.select_related("document", "requested_by").get(id=request_id)
        who = User.objects.get(id=signer_id)
    except (SignatureRequest.DoesNotExist, User.DoesNotExist):
        return
    doc = req.document
    signer_row = req.signers.filter(signer=who).first()
    reason = (signer_row.decline_reason if signer_row else "") or "No reason provided."
    who_name = who.get_full_name() or who.email
    link = _signature_link(doc.id)
    _create_notification(
        req.requested_by,
        f"{who_name} declined to sign '{doc.title}': {reason}",
        link, "signature_declined",
    )
    _send_email(
        req.requested_by,
        subject=f"DMS — Signature declined: {doc.title}",
        body=(
            f"Hello {req.requested_by.first_name},\n\n"
            f"{who_name} declined to sign '{doc.title}'.\n\n"
            f"  Reason: {reason}\n\n"
            f"The signature request has been stopped.\n"
        ),
        link=link,
    )


@shared_task(queue="notifications")
def notify_signature_completed(request_id: str) -> None:
    from apps.documents.models import SignatureRequest
    try:
        req = SignatureRequest.objects.select_related("document", "requested_by").get(id=request_id)
    except SignatureRequest.DoesNotExist:
        return
    doc = req.document
    link = _signature_link(doc.id)
    _create_notification(
        req.requested_by,
        f"'{doc.title}' is fully signed and ready.",
        link, "signature_completed",
    )
    _send_email(
        req.requested_by,
        subject=f"DMS — Fully signed: {doc.title}",
        body=(
            f"Hello {req.requested_by.first_name},\n\n"
            f"All requested signatures have been collected on '{doc.title}'.\n"
            f"The signed document is ready in DMS.\n"
        ),
        link=link,
    )


@shared_task(queue="notifications")
def remind_pending_signatures() -> None:
    """Periodic backstop (Celery Beat): remind whoever still needs to sign each
    pending request — ordered: the current signer(s); unordered: every pending."""
    from apps.documents.models import SignatureRequest
    for req in SignatureRequest.objects.filter(status=SignatureRequest.Status.PENDING):
        try:
            for s in req.current_pending_signers():
                notify_signature_requested.delay(str(s.signer_id), str(req.id))
        except Exception as exc:
            logger.warning("remind_pending_signatures: request %s error: %s", req.id, exc)
