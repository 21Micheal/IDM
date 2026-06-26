"""
apps/documents/migration.py

Turns Infor IDM items (fetched via :mod:`apps.documents.ion_client`) into
fseDMS :class:`~apps.documents.models.Document` rows.

This is the one place that knows how an IDM item maps onto our document model.
It is deliberately defensive and small: IDM attribute names differ per tenant,
so the field mapping is best-effort and easy to extend once a real tenant is
connected. The orchestration (status transitions, counters, logging) lives in
:func:`run_migration_job`, which the Celery task and any management command can
share.
"""
from __future__ import annotations

import hashlib
import logging
import mimetypes
import os

from django.core.files.base import ContentFile
from django.db import transaction
from django.utils import timezone

from .ion_client import (
    IONClient,
    IONConfig,
    IONError,
    merge_connection_with_defaults,
)
from .models import (
    Document,
    DocumentStatus,
    MigrationJob,
    MigrationJobStatus,
)

logger = logging.getLogger(__name__)


# ── IDM item field extraction ────────────────────────────────────────────────
def ion_item_id(item: dict) -> str | None:
    """Pull the IDM item id out of common response shapes."""
    for key in ("id", "pid", "itemId", "documentId", "_id"):
        val = item.get(key)
        if val:
            return str(val)
    return None


def ion_item_filename(item: dict) -> str:
    """Best-effort original filename for an IDM item."""
    for key in ("fileName", "filename", "name", "title", "displayName"):
        val = item.get(key)
        if val:
            return str(val)
    return "imported-document"


def ion_item_attributes(item: dict) -> dict:
    """Flatten an IDM item's attribute bag into a plain ``{name: value}`` dict.

    IDM may present attributes as a list of ``{"name": ..., "value": ...}``
    objects, as a nested ``attrs``/``attributes`` mapping, or inline on the
    item. Handle the common shapes and ignore the binary/system keys.
    """
    attrs: dict = {}

    raw = item.get("attributes") or item.get("attrs")
    if isinstance(raw, list):
        for entry in raw:
            if isinstance(entry, dict):
                name = entry.get("name") or entry.get("key")
                if name:
                    attrs[str(name)] = entry.get("value")
    elif isinstance(raw, dict):
        attrs.update(raw)

    return attrs


# ── single-item import ────────────────────────────────────────────────────────
def import_document(job: MigrationJob, client: IONClient, item: dict, *, user) -> dict:
    """Import one IDM item into the DMS.

    Returns a per-item log entry dict (``{ion_id, status, detail, ...}``).
    Never raises: failures are reported in the returned entry so a single bad
    item does not abort the whole run.
    """
    # Local import avoids a circular import (serializers imports models which is
    # imported here at module load).
    from .serializers import _generate_unique_reference

    ion_id = ion_item_id(item)
    if not ion_id:
        return {"ion_id": None, "status": "failed", "detail": "Item had no identifiable id."}

    try:
        content, content_type = client.download_document(ion_id)
    except IONError as exc:
        return {"ion_id": ion_id, "status": "failed", "detail": str(exc)}

    if not content:
        return {"ion_id": ion_id, "status": "skipped", "detail": "Empty document content."}

    checksum = hashlib.sha256(content).hexdigest()

    # Idempotency: never import the same binary twice (re-runnable migrations).
    existing = (
        Document.objects.filter(checksum=checksum, deleted_at__isnull=True)
        .values_list("reference_number", flat=True)
        .first()
    )
    if existing:
        return {
            "ion_id": ion_id,
            "reference_number": existing,
            "status": "skipped",
            "detail": "A document with identical content already exists.",
        }

    file_name = ion_item_filename(item)
    mime = content_type or mimetypes.guess_type(file_name)[0] or "application/octet-stream"

    doc_type = job.target_document_type
    if doc_type is None:
        return {
            "ion_id": ion_id,
            "status": "failed",
            "detail": "Migration job has no target document type.",
        }

    metadata: dict = {}
    if job.include_attributes:
        metadata.update(ion_item_attributes(item))
    # Always stamp provenance so migrated documents are traceable back to IDM.
    metadata["_migration"] = {
        "source": "infor_idm",
        "ion_id": ion_id,
        "job_id": str(job.id),
        "imported_at": timezone.now().isoformat(),
    }

    title = os.path.splitext(os.path.basename(file_name))[0] or "Imported document"

    try:
        with transaction.atomic():
            doc = Document(
                title=title[:255],
                reference_number=_generate_unique_reference(doc_type),
                document_type=doc_type,
                status=DocumentStatus.DRAFT,
                file_name=file_name[:255],
                file_size=len(content),
                file_mime_type=mime[:100],
                checksum=checksum,
                metadata=metadata,
                uploaded_by=user,
            )
            doc.file.save(file_name, ContentFile(content), save=False)
            doc.save()
    except Exception as exc:  # noqa: BLE001 - report, don't abort the batch
        logger.exception("Migration import failed for IDM item %s", ion_id)
        return {"ion_id": ion_id, "status": "failed", "detail": str(exc)}

    return {
        "ion_id": ion_id,
        "reference_number": doc.reference_number,
        "document_id": str(doc.id),
        "status": "imported",
        "detail": "",
    }


# ── job orchestration ─────────────────────────────────────────────────────────
def run_migration_job(job_id: str) -> MigrationJob:
    """Execute a migration job end to end.

    Pulls matching IDM items and imports each, updating counters and the log as
    it goes. Safe to call from a Celery task or synchronously from a management
    command. Honours ``job.max_documents`` as a ceiling.
    """
    try:
        job = MigrationJob.objects.get(pk=job_id)
    except MigrationJob.DoesNotExist:
        logger.warning("run_migration_job: job %s no longer exists", job_id)
        raise

    job.status = MigrationJobStatus.RUNNING
    job.started_at = timezone.now()
    job.error = ""
    job.log = []
    job.total_items = 0
    job.processed_items = 0
    job.succeeded_items = 0
    job.failed_items = 0
    job.skipped_items = 0
    job.save(update_fields=[
        "status", "started_at", "error", "log", "total_items",
        "processed_items", "succeeded_items", "failed_items", "skipped_items",
        "updated_at",
    ])

    user = job.created_by
    if user is None:
        _finish(job, MigrationJobStatus.FAILED, "Migration job has no owner to attribute imports to.")
        return job
    if job.target_document_type is None:
        _finish(job, MigrationJobStatus.FAILED, "Select a target document type before running.")
        return job

    try:
        client = IONClient(
            IONConfig.from_mapping(merge_connection_with_defaults(job.connection))
        )
        client.test_connection()
    except IONError as exc:
        _finish(job, MigrationJobStatus.FAILED, str(exc))
        return job

    limit = job.max_documents or None
    try:
        for item in client.iter_documents(job.source_query):
            if limit is not None and job.processed_items >= limit:
                break
            entry = import_document(job, client, item, user=user)
            job.append_log(entry)
            job.processed_items += 1
            job.total_items += 1
            outcome = entry.get("status")
            if outcome == "imported":
                job.succeeded_items += 1
            elif outcome == "skipped":
                job.skipped_items += 1
            else:
                job.failed_items += 1
            # Persist incrementally so the UI poll reflects live progress.
            job.save(update_fields=[
                "log", "processed_items", "total_items", "succeeded_items",
                "failed_items", "skipped_items", "updated_at",
            ])
    except IONError as exc:
        _finish(job, MigrationJobStatus.FAILED, str(exc))
        return job
    except Exception as exc:  # noqa: BLE001
        logger.exception("Migration job %s crashed", job_id)
        _finish(job, MigrationJobStatus.FAILED, f"Unexpected error: {exc}")
        return job

    if job.failed_items and job.succeeded_items:
        final = MigrationJobStatus.PARTIAL
    elif job.failed_items and not job.succeeded_items:
        final = MigrationJobStatus.FAILED
    else:
        final = MigrationJobStatus.COMPLETED
    _finish(job, final, "")
    return job


def _finish(job: MigrationJob, status: str, error: str) -> None:
    job.status = status
    job.error = error or ""
    job.finished_at = timezone.now()
    job.save(update_fields=["status", "error", "finished_at", "updated_at"])
