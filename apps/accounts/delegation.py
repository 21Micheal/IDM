"""Shared helpers for workflow task delegation."""
from __future__ import annotations

from django.db.models import Q, QuerySet
from django.utils import timezone

from apps.accounts.models import User, UserDelegation
from apps.workflows.models import WorkflowTask

ACTIVE_TASK_STATUSES = ("in_progress", "held")


def active_delegations_qs(
    *,
    delegate: User | None = None,
    delegator: User | None = None,
) -> QuerySet[UserDelegation]:
    now = timezone.now()
    qs = UserDelegation.objects.filter(
        is_active=True,
        starts_at__lte=now,
        ends_at__gte=now,
    ).select_related("delegator", "delegate", "document_type")
    if delegate is not None:
        qs = qs.filter(delegate=delegate)
    if delegator is not None:
        qs = qs.filter(delegator=delegator)
    return qs


def delegation_covers_task(delegation: UserDelegation, task: WorkflowTask) -> bool:
    if task.assigned_to_id != delegation.delegator_id:
        return False
    if task.status not in ACTIVE_TASK_STATUSES:
        return False
    if delegation.document_type_id:
        doc = task.workflow_instance.document
        return doc.document_type_id == delegation.document_type_id
    return True


def delegated_tasks_q(delegate: User) -> Q:
    """OR filter for tasks currently actionable by `delegate` via delegation."""
    clauses: list[Q] = []
    for delegation in active_delegations_qs(delegate=delegate):
        clause = Q(
            assigned_to_id=delegation.delegator_id,
            status__in=ACTIVE_TASK_STATUSES,
        )
        if delegation.document_type_id:
            clause &= Q(
                workflow_instance__document__document_type_id=delegation.document_type_id,
            )
        clauses.append(clause)
    if not clauses:
        return Q(pk__in=[])
    combined = clauses[0]
    for clause in clauses[1:]:
        combined |= clause
    return combined


def tasks_visible_to_user(user: User) -> QuerySet[WorkflowTask]:
    return WorkflowTask.objects.filter(
        Q(assigned_to=user) | delegated_tasks_q(user),
        status__in=ACTIVE_TASK_STATUSES,
    )


def tasks_for_delegation(delegation: UserDelegation) -> QuerySet[WorkflowTask]:
    clause = Q(
        assigned_to_id=delegation.delegator_id,
        status__in=ACTIVE_TASK_STATUSES,
    )
    if delegation.document_type_id:
        clause &= Q(
            workflow_instance__document__document_type_id=delegation.document_type_id,
        )
    return WorkflowTask.objects.filter(clause)


def user_can_action_task_via_delegation(user: User, task: WorkflowTask) -> bool:
    for delegation in active_delegations_qs(delegate=user, delegator=task.assigned_to):
        if delegation_covers_task(delegation, task):
            return True
    return False
