import csv
from datetime import datetime, timezone as dt_timezone
from io import BytesIO, StringIO
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

from django.test import SimpleTestCase
from openpyxl import load_workbook
from rest_framework.test import APIRequestFactory, force_authenticate

from apps.audit.export import (
    AUDIT_EXPORT_COLUMNS,
    EXCEL_MAX_CELL_CHARS,
    build_audit_xlsx,
    sanitize_csv_cell,
    sanitize_excel_text,
    write_audit_csv,
)
from apps.audit.models import AuditEvent
from apps.audit.views import AuditLogExportView


def _make_actor(email="jane@example.com", first_name="Jane", last_name="Doe", job="Auditor"):
    actor = SimpleNamespace(
        email=email,
        first_name=first_name,
        last_name=last_name,
        job_description=job,
    )
    actor.get_full_name = lambda: f"{actor.first_name} {actor.last_name}".strip()
    return actor


def _make_log(**overrides):
    defaults = {
        "id": "00000000-0000-0000-0000-000000000001",
        "event": AuditEvent.WORKFLOW_APPROVED,
        "actor": _make_actor(),
        "object_type": "Document",
        "object_id": "00012345",
        "object_repr": "[REQ-00024] Travel Requisition",
        "changes": {},
        "ip_address": "10.0.0.15",
        "user_agent": "pytest",
        "timestamp": datetime(2026, 11, 25, 8, 30, 45, 123456, tzinfo=dt_timezone.utc),
    }
    defaults.update(overrides)
    return SimpleNamespace(**defaults)


class AuditExportTests(SimpleTestCase):
    def test_sanitize_excel_text_strips_illegal_chars_and_clamps_length(self):
        dirty = "hello\x00world\x07!" + ("x" * (EXCEL_MAX_CELL_CHARS + 50))
        cleaned = sanitize_excel_text(dirty)
        self.assertNotIn("\x00", cleaned)
        self.assertNotIn("\x07", cleaned)
        self.assertEqual(len(cleaned), EXCEL_MAX_CELL_CHARS)
        self.assertTrue(cleaned.endswith("… [truncated]"))

    def test_sanitize_csv_cell_neutralizes_formulas(self):
        for dangerous in ("=CMD()", "+254700000000", "-100", "@SUM(A1)", " =1+1", "\t=1"):
            self.assertTrue(sanitize_csv_cell(dangerous).startswith("'"), dangerous)
        self.assertEqual(sanitize_csv_cell("Normal text"), "Normal text")

    def test_write_audit_csv_is_excel_friendly(self):
        logs = [
            _make_log(
                object_repr="=SUM(A1:A2)\x00",
                changes={"comment": "Approved", "amount": 500},
            ),
            _make_log(
                event=AuditEvent.GROUP_PERMISSION_UPDATED,
                actor=_make_actor(email="ops@example.com", first_name="", last_name=""),
                object_type="UserGroup",
                object_id="99",
                object_repr="Finance",
                changes={
                    "granted_details": [
                        {"action": "view_document", "document_type_name": "Invoice", "stage": "approval"}
                    ],
                    "revoked_details": [],
                },
                ip_address=None,
            ),
            _make_log(actor=None, changes={}),
        ]

        buf = StringIO()
        count = write_audit_csv(logs, buf)
        raw = buf.getvalue()

        self.assertEqual(count, 3)
        self.assertTrue(raw.startswith("\ufeff"))
        self.assertIn("\r\n", raw)

        rows = list(csv.reader(StringIO(raw.lstrip("\ufeff"))))
        self.assertEqual(rows[0], [h for h, _, _ in AUDIT_EXPORT_COLUMNS])

        # Local time in Africa/Nairobi (+03:00): 08:30:45 UTC -> 11:30:45
        self.assertEqual(rows[1][0], "2026-11-25 11:30:45")
        self.assertEqual(rows[1][1], "Workflow Step Approved")
        self.assertEqual(rows[1][2], AuditEvent.WORKFLOW_APPROVED)
        self.assertEqual(rows[1][4], "Jane Doe")
        self.assertEqual(rows[1][9], "'=SUM(A1:A2)")
        self.assertEqual(rows[1][11], "comment: Approved\namount: 500")

        # Actor without first/last name falls back to email
        self.assertEqual(rows[2][4], "ops@example.com")
        self.assertIn("Granted View Document for Invoice in approval stage", rows[2][11])

        # System actor & empty changes
        self.assertEqual(rows[3][4], "System")
        self.assertEqual(rows[3][11], "")

    def test_build_audit_xlsx_is_excel_friendly(self):
        logs = [
            _make_log(
                object_id="00012345",
                object_repr="=1+1",
                changes={"note": "+254700000000\x00"},
            ),
            _make_log(actor=None, changes={}),
        ]

        xlsx_bytes, count = build_audit_xlsx(logs)
        self.assertEqual(count, 2)

        wb = load_workbook(BytesIO(xlsx_bytes), data_only=False)
        self.assertIn("Audit Trail", wb.sheetnames)
        ws = wb["Audit Trail"]

        self.assertEqual(ws.freeze_panes, "A2")
        self.assertEqual(ws.auto_filter.ref, "A1:L3")
        self.assertEqual([cell.value for cell in ws[1]], [h for h, _, _ in AUDIT_EXPORT_COLUMNS])
        self.assertTrue(ws["A1"].font.bold)
        self.assertGreater(ws.column_dimensions["D"].width, 20)

        # Native naive local datetime
        ts_cell = ws["A2"]
        self.assertEqual(ts_cell.value, datetime(2026, 11, 25, 11, 30, 45))
        self.assertEqual(ts_cell.number_format, "yyyy-mm-dd hh:mm:ss")

        # IDs and IPs forced to text so leading zeros aren't stripped
        self.assertEqual(ws["I2"].value, "00012345")
        self.assertEqual(ws["I2"].number_format, "@")
        self.assertEqual(ws["K2"].number_format, "@")

        # Formula-like strings are stored as plain text without mangling value
        self.assertEqual(ws["J2"].value, "=1+1")
        self.assertEqual(ws["J2"].data_type, "s")
        self.assertEqual(ws["L2"].value, "note: +254700000000")
        self.assertEqual(ws["L2"].data_type, "s")
        self.assertTrue(ws["L2"].alignment.wrap_text)

        # Empty changes dict renders blank rather than "{}"
        self.assertIsNone(ws["L3"].value)

    def test_build_audit_xlsx_empty_queryset(self):
        xlsx_bytes, count = build_audit_xlsx([])
        self.assertEqual(count, 0)
        wb = load_workbook(BytesIO(xlsx_bytes))
        ws = wb["Audit Trail"]
        self.assertEqual(ws.auto_filter.ref, "A1:L1")
        self.assertEqual(ws.max_row, 1)

    def test_export_view_permissions_and_headers(self):
        factory = APIRequestFactory()
        view = AuditLogExportView.as_view()

        unauth_user = SimpleNamespace(is_authenticated=True, can_view_system_audit=False)
        req_denied = factory.get("/api/audit/export/?file_format=xlsx")
        force_authenticate(req_denied, user=unauth_user)
        resp_denied = view(req_denied)
        self.assertEqual(resp_denied.status_code, 403)

        admin_user = SimpleNamespace(is_authenticated=True, can_view_system_audit=True)
        req_bad_fmt = factory.get("/api/audit/export/?file_format=pdf")
        force_authenticate(req_bad_fmt, user=admin_user)
        with patch.object(AuditLogExportView, "get_queryset", return_value=[]), patch.object(
            AuditLogExportView, "filter_queryset", return_value=[]
        ):
            resp_bad = view(req_bad_fmt)
        self.assertEqual(resp_bad.status_code, 400)

        mock_qs = MagicMock()
        mock_qs.iterator.return_value = iter([_make_log()])
        req_xlsx = factory.get("/api/audit/export/?file_format=xlsx")
        force_authenticate(req_xlsx, user=admin_user)
        with patch.object(AuditLogExportView, "get_queryset", return_value=mock_qs), patch.object(
            AuditLogExportView, "filter_queryset", return_value=mock_qs
        ), patch("apps.audit.views.AuditLog.objects.create") as mock_create:
            resp_xlsx = view(req_xlsx)

        self.assertEqual(resp_xlsx.status_code, 200)
        self.assertEqual(
            resp_xlsx["Content-Type"],
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        )
        self.assertRegex(
            resp_xlsx["Content-Disposition"],
            r'^attachment; filename="audit-trail-\d{4}-\d{2}-\d{2}\.xlsx"$',
        )
        mock_create.assert_called_once()
        self.assertEqual(mock_create.call_args.kwargs["changes"]["row_count"], 1)

