"""OCR status tracking and stale-job healing."""
from __future__ import annotations

from datetime import datetime

from django.utils import timezone
from django.utils.dateparse import parse_datetime


def ocr_tracking_now() -> str:
    return timezone.now().isoformat()


def merge_ocr_queued_metadata(metadata: dict | None) -> dict:
    meta = dict(metadata or {})
    meta["ocr_queued_at"] = ocr_tracking_now()
    meta.pop("ocr_processing_at", None)
    return meta


def merge_ocr_processing_metadata(metadata: dict | None) -> dict:
    meta = dict(metadata or {})
    if "ocr_queued_at" not in meta:
        meta["ocr_queued_at"] = ocr_tracking_now()
    meta["ocr_processing_at"] = ocr_tracking_now()
    return meta


def clear_ocr_tracking_metadata(metadata: dict | None) -> dict:
    meta = dict(metadata or {})
    meta.pop("ocr_queued_at", None)
    meta.pop("ocr_processing_at", None)
    return meta


def _parse_tracking_timestamp(value: object) -> datetime | None:
    if not value:
        return None
    if isinstance(value, datetime):
        parsed = value
    else:
        parsed = parse_datetime(str(value))
    if not parsed:
        return None
    if timezone.is_naive(parsed):
        parsed = timezone.make_aware(parsed, timezone.get_current_timezone())
    return parsed


def ocr_tracking_started_at(document) -> datetime | None:
    meta = document.metadata if isinstance(document.metadata, dict) else {}
    candidates = [
        _parse_tracking_timestamp(meta.get("ocr_processing_at")),
        _parse_tracking_timestamp(meta.get("ocr_queued_at")),
    ]
    started = [dt for dt in candidates if dt is not None]
    if started:
        return min(started)
    updated_at = getattr(document, "updated_at", None)
    return updated_at if isinstance(updated_at, datetime) else None


def heal_stale_ocr_status(document) -> bool:
    """
    Mark stuck pending/processing OCR jobs as failed once they exceed
    OCR_PROCESSING_STALE_SECONDS. Uses OCR tracking timestamps in metadata
    so unrelated document updates do not extend the window indefinitely.

    Returns True when the document status was updated.
    """
    from django.conf import settings as django_settings

    from apps.documents.models import OCRStatus

    if document.ocr_status not in (OCRStatus.PENDING, OCRStatus.PROCESSING):
        return False

    stale_after = int(getattr(django_settings, "OCR_PROCESSING_STALE_SECONDS", 300))
    started_at = ocr_tracking_started_at(document)
    if not started_at:
        return False

    age_seconds = max(0, int((timezone.now() - started_at).total_seconds()))
    if age_seconds < stale_after:
        return False

    meta = clear_ocr_tracking_metadata(document.metadata)
    type(document).objects.filter(
        id=document.id,
        ocr_status__in=[OCRStatus.PENDING, OCRStatus.PROCESSING],
    ).update(ocr_status=OCRStatus.FAILED, metadata=meta, updated_at=timezone.now())
    document.ocr_status = OCRStatus.FAILED
    document.metadata = meta
    document.updated_at = timezone.now()
    return True
