"""
Excel-friendly CSV and XLSX export builders for the system audit trail.
"""
from __future__ import annotations

import csv
import json
from io import BytesIO
from typing import Any, Iterable

from django.utils import timezone
from openpyxl import Workbook
from openpyxl.cell import WriteOnlyCell
from openpyxl.cell.cell import ILLEGAL_CHARACTERS_RE
from openpyxl.styles import Alignment, Border, Font, PatternFill, Side
from openpyxl.utils import get_column_letter

from .models import AuditEvent
from .serializers import AuditLogSerializer

EXCEL_MAX_CELL_CHARS = 32767
_TRUNCATED_SUFFIX = "… [truncated]"
_FORMULA_TRIGGER_CHARS = ("=", "+", "-", "@", "\t", "\r")

# (header, column_width, cell_kind)
AUDIT_EXPORT_COLUMNS: tuple[tuple[str, int, str], ...] = (
    ("Timestamp", 20, "datetime"),
    ("Event", 26, "text"),
    ("Event Code", 24, "text"),
    ("Summary", 48, "wrap"),
    ("Actor Name", 24, "text"),
    ("Actor Email", 28, "text"),
    ("Job Description", 24, "text"),
    ("Object Type", 16, "text"),
    ("Object ID", 38, "id"),
    ("Object", 36, "wrap"),
    ("IP Address", 16, "id"),
    ("Changes", 52, "wrap"),
)

_EVENT_LABELS: dict[str, str] = dict(AuditEvent.choices)


def sanitize_excel_text(value: Any) -> str:
    """Strip illegal XML control characters and clamp to Excel's 32,767-char cell limit."""
    if value is None:
        return ""
    text = ILLEGAL_CHARACTERS_RE.sub("", str(value))
    if len(text) > EXCEL_MAX_CELL_CHARS:
        cutoff = EXCEL_MAX_CELL_CHARS - len(_TRUNCATED_SUFFIX)
        text = text[:cutoff] + _TRUNCATED_SUFFIX
    return text


def sanitize_csv_cell(value: Any) -> str:
    """Sanitize text for CSV and neutralize leading characters Excel treats as formulas."""
    text = sanitize_excel_text(value)
    if not text:
        return ""
    stripped = text.lstrip(" ")
    if text[0] in _FORMULA_TRIGGER_CHARS or (stripped and stripped[0] in _FORMULA_TRIGGER_CHARS):
        return f"'{text}"
    return text


def _format_event_label(event: str) -> str:
    if not event:
        return ""
    if event in _EVENT_LABELS:
        return _EVENT_LABELS[event]
    return event.replace(".", " ").replace("_", " ").title()


def _format_group_permission_changes(changes: dict[str, Any]) -> str | None:
    granted = changes.get("granted_details") if isinstance(changes.get("granted_details"), list) else []
    revoked = changes.get("revoked_details") if isinstance(changes.get("revoked_details"), list) else []
    parts: list[str] = []

    for label, items in (("Granted", granted), ("Revoked", revoked)):
        for detail in items:
            if not isinstance(detail, dict):
                continue
            action = str(detail.get("action") or "").replace("_", " ").title()
            doc = f" for {detail['document_type_name']}" if detail.get("document_type_name") else ""
            stage = detail.get("stage")
            stage_text = f" in {stage} stage" if stage and stage != "any" else ""
            parts.append(f"{label} {action}{doc}{stage_text}".strip())

    if parts:
        return "\n".join(parts)

    granted_count = changes.get("granted_count")
    revoked_count = changes.get("revoked_count")
    total = changes.get("total_permissions")
    if isinstance(granted_count, int) or isinstance(revoked_count, int):
        g = granted_count if isinstance(granted_count, int) else 0
        r = revoked_count if isinstance(revoked_count, int) else 0
        t = total if isinstance(total, int) else 0
        return f"{g} granted, {r} revoked ({t} total permissions)"
    return None


def _format_changes(event: str, changes: Any) -> str:
    if not changes:
        return ""
    if isinstance(changes, dict):
        if event == AuditEvent.GROUP_PERMISSION_UPDATED:
            formatted = _format_group_permission_changes(changes)
            if formatted:
                return formatted

        lines: list[str] = []
        for key, val in changes.items():
            if isinstance(val, (dict, list)):
                rendered = json.dumps(val, ensure_ascii=False, default=str)
            else:
                rendered = str(val)
            lines.append(f"{key}: {rendered}")
        return "\n".join(lines)

    return json.dumps(changes, ensure_ascii=False, default=str)


def _local_naive_timestamp(dt):
    if dt is None:
        return None
    if timezone.is_aware(dt):
        dt = timezone.localtime(dt)
    return dt.replace(tzinfo=None, microsecond=0)


def _extract_row_values(log, serializer: AuditLogSerializer) -> list[Any]:
    local_ts = _local_naive_timestamp(log.timestamp)
    actor = log.actor
    actor_name = serializer.get_actor_name(log) or "System"
    actor_email = actor.email if actor else ""
    actor_job = getattr(actor, "job_description", "") or "" if actor else ""

    return [
        local_ts,
        _format_event_label(log.event),
        log.event or "",
        serializer.get_summary(log),
        actor_name,
        actor_email,
        actor_job,
        log.object_type or "",
        log.object_id or "",
        log.object_repr or "",
        log.ip_address or "",
        _format_changes(log.event, log.changes),
    ]


def build_audit_xlsx(logs: Iterable[Any]) -> tuple[bytes, int]:
    """Build a styled, auto-filtered Excel workbook for the given audit log iterable."""
    workbook = Workbook(write_only=True)
    sheet = workbook.create_sheet("Audit Trail")
    sheet.freeze_panes = "A2"

    for col_idx, (_, width, _) in enumerate(AUDIT_EXPORT_COLUMNS, start=1):
        sheet.column_dimensions[get_column_letter(col_idx)].width = width

    header_font = Font(name="Calibri", size=11, bold=True, color="FFFFFF")
    header_fill = PatternFill(fill_type="solid", start_color="287EAD", end_color="287EAD")
    header_border = Border(
        bottom=Side(style="thin", color="1D5F84"),
        right=Side(style="thin", color="4E96BF"),
    )
    header_align = Alignment(horizontal="left", vertical="center")

    body_font = Font(name="Calibri", size=10, color="1F2933")
    zebra_fill = PatternFill(fill_type="solid", start_color="F8FAFB", end_color="F8FAFB")
    body_border = Border(
        bottom=Side(style="thin", color="E5E7EB"),
        right=Side(style="thin", color="EEF1F4"),
    )
    align_top = Alignment(horizontal="left", vertical="top")
    align_wrap = Alignment(horizontal="left", vertical="top", wrap_text=True)

    header_cells: list[WriteOnlyCell] = []
    for header, _, _ in AUDIT_EXPORT_COLUMNS:
        cell = WriteOnlyCell(sheet, header)
        cell.font = header_font
        cell.fill = header_fill
        cell.border = header_border
        cell.alignment = header_align
        header_cells.append(cell)
    sheet.append(header_cells)

    serializer = AuditLogSerializer()
    row_count = 0
    for log in logs:
        row_count += 1
        values = _extract_row_values(log, serializer)
        is_even = row_count % 2 == 0
        row_cells: list[WriteOnlyCell] = []

        for val, (_, _, kind) in zip(values, AUDIT_EXPORT_COLUMNS):
            if kind == "datetime":
                cell = WriteOnlyCell(sheet, val)
                cell.number_format = "yyyy-mm-dd hh:mm:ss"
                cell.alignment = align_top
            else:
                text = sanitize_excel_text(val)
                cell = WriteOnlyCell(sheet, text)
                cell.data_type = "s"
                if kind == "id":
                    cell.number_format = "@"
                cell.alignment = align_wrap if kind == "wrap" else align_top

            cell.font = body_font
            cell.border = body_border
            if is_even:
                cell.fill = zebra_fill
            row_cells.append(cell)

        sheet.append(row_cells)

    last_col = get_column_letter(len(AUDIT_EXPORT_COLUMNS))
    sheet.auto_filter.ref = f"A1:{last_col}{row_count + 1}"

    output = BytesIO()
    workbook.save(output)
    return output.getvalue(), row_count


def write_audit_csv(logs: Iterable[Any], stream: Any) -> int:
    """Write an Excel-compatible UTF-8 BOM CSV of audit logs to ``stream``."""
    stream.write("\ufeff")
    writer = csv.writer(stream)
    writer.writerow([header for header, _, _ in AUDIT_EXPORT_COLUMNS])

    serializer = AuditLogSerializer()
    row_count = 0
    for log in logs:
        row_count += 1
        values = _extract_row_values(log, serializer)
        csv_row: list[str] = []
        for val, (_, _, kind) in zip(values, AUDIT_EXPORT_COLUMNS):
            if kind == "datetime":
                csv_row.append(val.strftime("%Y-%m-%d %H:%M:%S") if val else "")
            else:
                csv_row.append(sanitize_csv_cell(val))
        writer.writerow(csv_row)

    return row_count
