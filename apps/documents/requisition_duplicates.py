"""Helpers for identifying requisitions with a repeated activity and date."""

from __future__ import annotations

from datetime import date, datetime
import re
from typing import Any


_DATE_LABEL = re.compile(r"(?:activity\s+start|activity\s+date|date\s+of\s+activity|date\s+of\s+travel|travel\s+date|expected\s+travel\s+date)", re.I)


def _code(value: Any) -> str:
    if isinstance(value, dict):
        value = value.get("code") or value.get("value") or value.get("id") or value.get("10")
    if value is None or isinstance(value, (dict, list)):
        return ""
    result = str(value).strip()
    if not result or result == "#":
        return ""
    return result.upper()


def _date_value(value: Any) -> str:
    if not value or isinstance(value, (dict, list)):
        return ""
    text = str(value).strip()
    if not text:
        return ""
    try:
        return date.fromisoformat(text[:10]).isoformat()
    except ValueError:
        try:
            return datetime.fromisoformat(text.replace("Z", "+00:00")).date().isoformat()
        except ValueError:
            return ""


def _is_activity_field(field: dict[str, Any]) -> bool:
    external = field.get("external") if isinstance(field.get("external"), dict) else {}
    sunsystems = field.get("sunsystems") if isinstance(field.get("sunsystems"), dict) else {}
    label_key = f"{field.get('label', '')} {field.get('key', '')}"
    return (
        str(external.get("dimension") or "") in {"10", "10.0"}
        or str(sunsystems.get("role") or "").lower() in {"analysis_code_10", "activity_code"}
        or bool(re.search(r"activity\s*code", label_key, re.I))
        or field.get("type") in {"budget_line", "budgetline", "budget"}
    )


def _is_activity_date(field: dict[str, Any]) -> bool:
    if field.get("type") not in {"date", "datetime", "date_time"}:
        return False
    return bool(_DATE_LABEL.search(f"{field.get('label', '')} {field.get('key', '')}"))


def activity_date_pairs(document: Any) -> set[tuple[str, str]]:
    """Return (activity code, ISO date) pairs found in a requisition's form."""
    metadata = document.metadata if isinstance(document.metadata, dict) else {}
    form = metadata.get("form") if isinstance(metadata.get("form"), dict) else {}
    values = form.get("values") if isinstance(form.get("values"), dict) else {}
    sections = form.get("sections") if isinstance(form.get("sections"), list) else []
    top_activities: set[str] = set()
    top_dates: set[str] = set()
    rows_without_dates: set[str] = set()
    pairs: set[tuple[str, str]] = set()

    for section in sections:
        fields = section.get("fields") if isinstance(section, dict) else []
        for field in fields if isinstance(fields, list) else []:
            if not isinstance(field, dict):
                continue
            key = field.get("key")
            if not key:
                continue
            value = values.get(key)
            if field.get("type") == "table":
                columns = [column for column in field.get("columns", []) if isinstance(column, dict)]
                activity_columns = [column for column in columns if _is_activity_field(column)]
                date_columns = [column for column in columns if _is_activity_date(column)]
                rows = value if isinstance(value, list) else []
                for row in rows:
                    if not isinstance(row, dict):
                        continue
                    activities = {_code(row.get(column.get("key"))) for column in activity_columns}
                    activities.discard("")
                    if not activities:
                        continue
                    row_dates = {_date_value(row.get(column.get("key"))) for column in date_columns}
                    row_dates.discard("")
                    if row_dates:
                        pairs.update((activity, row_date) for activity in activities for row_date in row_dates)
                    else:
                        rows_without_dates.update(activities)
                continue

            if _is_activity_field(field):
                activity = _code(value)
                if activity:
                    top_activities.add(activity)
            if _is_activity_date(field):
                date_text = _date_value(value)
                if date_text:
                    top_dates.add(date_text)

    # Top-level activity/date fields commonly sit outside the itinerary table.
    if top_activities and top_dates:
        pairs.update((activity, date_text) for activity in top_activities for date_text in top_dates)
    # Some forms keep the activity on the itinerary row but put its date in the
    # top-level Activity Start Date field.
    if rows_without_dates and top_dates:
        pairs.update((activity, date_text) for activity in rows_without_dates for date_text in top_dates)
    return pairs


def duplicate_activity_date_map(documents: list[Any]) -> dict[str, list[dict[str, str]]]:
    """Flag later requisitions sharing at least one activity/date pair."""
    ordered = sorted(documents, key=lambda item: (item.created_at, str(item.id)))
    first_seen: dict[tuple[str, str], Any] = {}
    duplicates: dict[str, list[dict[str, str]]] = {}
    for document in ordered:
        for activity, date_text in activity_date_pairs(document):
            pair = (activity, date_text)
            original = first_seen.get(pair)
            if original is None:
                first_seen[pair] = document
            elif original.id != document.id:
                duplicates.setdefault(str(document.id), []).append({
                    "activity_code": activity,
                    "date": date_text,
                })
    return duplicates


def find_existing_activity_date_duplicates(document: Any) -> list[dict[str, str]]:
    """Find already submitted requisitions sharing this form's activity/date."""
    pairs = activity_date_pairs(document)
    if not pairs:
        return []

    from apps.documents.models import Document

    candidates = (
        Document.objects.filter(
            metadata__form__workflow_type="requisition",
            deleted_at__isnull=True,
        )
        .exclude(id=document.id)
        .exclude(status__in=["draft", "void"])
        .exclude(reference_number="")
        .only("id", "metadata", "created_at", "reference_number")
    )
    matches: list[dict[str, str]] = []
    for candidate in candidates:
        for activity, date_text in activity_date_pairs(candidate) & pairs:
            matches.append({
                "reference_number": candidate.reference_number,
                "activity_code": activity,
                "date": date_text,
            })
    return matches
