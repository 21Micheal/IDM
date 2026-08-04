"""
Helpers for the bulk-upload / email pending-review queue.

Email-ingested batches are attributed to the Email bot user, so visibility is
not ``uploaded_by=request.user``. Reviewers configured on the source mailbox
(or, when none are set, the mailbox owner and admins) see those batches.
"""
from __future__ import annotations

from django.db.models import Count, Q, QuerySet

from .models import BulkUpload, BulkUploadStatus, Mailbox


def reviewable_bulk_uploads_for(user) -> QuerySet[BulkUpload]:
    """Batches the user may open in the pending-review queue.

    Includes:
    * batches the user uploaded themselves (bulk scan), and
    * email-ingested batches they are allowed to review.
    """
    if not user or not getattr(user, "is_authenticated", False):
        return BulkUpload.objects.none()

    own = Q(uploaded_by=user)

    # Explicit reviewers on the mailbox.
    as_reviewer = Q(ingested_emails__mailbox__reviewers=user)

    # Mailboxes with no reviewers assigned: owner always.
    unassigned_ids = list(
        Mailbox.objects.annotate(rc=Count("reviewers"))
        .filter(rc=0)
        .values_list("id", flat=True)
    )
    unassigned = Q(ingested_emails__mailbox_id__in=unassigned_ids)
    fallback = unassigned & Q(ingested_emails__mailbox__created_by=user)

    # Admins keep full visibility over all email-ingested batches.
    admin_email_access = Q(ingested_emails__isnull=False) if getattr(user, "has_admin_access", False) else Q()

    return (
        BulkUpload.objects.filter(own | as_reviewer | fallback | admin_email_access)
        .distinct()
        .select_related("document_type")
        .prefetch_related("ingested_emails")
    )


def pending_review_count_for(user) -> int:
    """How many batches still need the user's attention (processing or review)."""
    return (
        reviewable_bulk_uploads_for(user)
        .filter(status__in=[BulkUploadStatus.PROCESSING, BulkUploadStatus.REVIEW])
        .count()
    )
