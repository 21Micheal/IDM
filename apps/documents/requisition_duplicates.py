"""Owner-scoped duplicate checks for requisitions with the same travel date."""

from __future__ import annotations

from datetime import date, datetime
import re
from typing import Any


def _date_value(value: Any) -> str:
    if not value or isinstance(value, (dict, list)):
        return ""
    raw = str(value).strip()
    if not raw:
        return ""
    try:
        return date.fromisoformat(raw[:10]).isoformat()
    except ValueError:
        try:
            return datetime.fromisoformat(raw.replace("Z", "+00:00")).date().isoformat()
        except ValueError:
            return ""


def _date_priority(field: dict[str, Any]) -> int:
    """Rank likely trip start date fields ahead of itinerary/date fallbacks."""
    if field.get("type") not in {"date", "datetime", "date_time", "calc_date"}:
        return 0
    label = re.sub(r"[^a-z0-9]+", " ", f"{field.get('label', '')} {field.get('key', '')}".lower()).strip()
    if "expected travel" in label:
        return 0
    if "activity start date" in label or "travel start date" in label or "workshop from" in label:
        return 100
    if re.search(r"\bstart date\b", label):
        return 90
    if "date of travel" in label or re.search(r"\btravel date\b", label):
        return 80
    if "departure date" in label:
        return 70
    return 0


def _configured_start_date(sections: list[Any], values: dict[str, Any], field_key: str) -> str:
    if not field_key:
        return ""
    if "." in field_key:
        table_key, column_key = field_key.split(".", 1)
        rows = values.get(table_key)
        dates = [
            parsed
            for row in (rows if isinstance(rows, list) else [])
            if isinstance(row, dict)
            if (parsed := _date_value(row.get(column_key)))
        ]
        return min(dates) if dates else ""
    for section in sections:
        for field in (section.get("fields", []) if isinstance(section, dict) else []):
            if isinstance(field, dict) and str(field.get("key") or "") == field_key:
                if field.get("type") == "table":
                    return ""
                return _date_value(values.get(field_key))
    return _date_value(values.get(field_key))


def travel_start_date(
    document: Any,
    values_override: dict[str, Any] | None = None,
    *,
    sections_override: list[Any] | None = None,
    start_date_field: str | None = None,
) -> str:
    """Extract the most relevant travel start date from a requisition form."""
    raw_metadata = getattr(document, "metadata", {})
    metadata = raw_metadata if isinstance(raw_metadata, dict) else {}
    form = metadata.get("form") if isinstance(metadata.get("form"), dict) else {}
    values = values_override if isinstance(values_override, dict) else form.get("values", {})
    values = values if isinstance(values, dict) else {}
    sections = sections_override if isinstance(sections_override, list) else form.get("sections")
    sections = sections if isinstance(sections, list) else []
    configured_field = str(
        start_date_field if start_date_field is not None else form.get("travel_start_date_field") or ""
    ).strip()
    if configured_field:
        return _configured_start_date(sections, values, configured_field)
    candidates: list[tuple[int, str]] = []

    for section in sections:
        fields = section.get("fields") if isinstance(section, dict) else []
        for field in fields if isinstance(fields, list) else []:
            if not isinstance(field, dict):
                continue
            key = field.get("key")
            if not key:
                continue
            if field.get("type") == "table":
                columns = [column for column in field.get("columns", []) if isinstance(column, dict)]
                rows = values.get(key)
                for column in columns:
                    priority = _date_priority(column)
                    if not priority:
                        continue
                    column_key = column.get("key")
                    for row in rows if isinstance(rows, list) else []:
                        if isinstance(row, dict):
                            parsed = _date_value(row.get(column_key))
                            if parsed:
                                candidates.append((priority, parsed))
                continue

            priority = _date_priority(field)
            if priority:
                parsed = _date_value(values.get(key))
                if parsed:
                    candidates.append((priority, parsed))

    if not candidates:
        return ""
    best_priority = max(priority for priority, _ in candidates)
    # If the itinerary is the only source and contains multiple dates, its
    # earliest date is the start of travel.
    return min(value for priority, value in candidates if priority == best_priority)


def duplicate_travel_date_map(documents: list[Any]) -> dict[str, list[dict[str, str]]]:
    """Flag later requisitions sharing a travel date with the same owner."""
    ordered = sorted(documents, key=lambda item: (item.created_at, str(item.id)))
    first_seen: dict[tuple[Any, str], Any] = {}
    duplicates: dict[str, list[dict[str, str]]] = {}
    for document in ordered:
        # Rejection ends the requisition's lifecycle. It must not reserve the
        # travel date or be reported as a duplicate for later submissions.
        if str(getattr(document, "status", "")).strip().lower() == "rejected":
            continue
        date_text = travel_start_date(document)
        owner_id = getattr(document, "uploaded_by_id", None)
        if not date_text or owner_id is None:
            continue
        key = (owner_id, date_text)
        original = first_seen.get(key)
        if original is None:
            first_seen[key] = document
        elif original.id != document.id:
            duplicates.setdefault(str(document.id), []).append({
                "date": date_text,
                "reference_number": original.reference_number,
            })
    return duplicates


def find_existing_travel_date_duplicates(
    document: Any,
    values_override: dict[str, Any] | None = None,
) -> list[dict[str, str]]:
    """Find same-owner requisitions that already use this travel start date."""
    date_text = travel_start_date(document, values_override)
    owner_id = getattr(document, "uploaded_by_id", None)
    return find_existing_travel_date_duplicates_for_owner(
        owner_id,
        date_text,
        exclude_document_id=getattr(document, "id", None),
    )


def find_existing_travel_date_duplicates_for_owner(
    owner_id: Any,
    date_text: str,
    *,
    exclude_document_id: Any = None,
) -> list[dict[str, str]]:
    """Find matching requisitions for a known owner and ISO start date."""
    if not date_text or owner_id is None:
        return []

    from apps.documents.models import Document

    candidates = (
        Document.objects.filter(
            uploaded_by_id=owner_id,
            metadata__form__workflow_type="requisition",
            deleted_at__isnull=True,
        )
        .exclude(status__in=["void", "rejected"])
        .order_by("created_at")
        .only("id", "metadata", "created_at", "reference_number", "uploaded_by_id")
    )
    if exclude_document_id:
        candidates = candidates.exclude(id=exclude_document_id)
    matches = []
    for candidate in candidates:
        if travel_start_date(candidate) == date_text:
            matches.append({
                "reference_number": candidate.reference_number,
                "date": date_text,
            })
    return matches
