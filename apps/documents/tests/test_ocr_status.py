"""Tests for OCR status tracking and stale-job healing."""
from datetime import timedelta
from unittest.mock import MagicMock, patch

from django.test import SimpleTestCase
from django.utils import timezone

from apps.documents.models import OCRStatus
from apps.documents.ocr.idp import _fill_admin_metadata_fields
from apps.documents.ocr.status import heal_stale_ocr_status, merge_ocr_queued_metadata


class OcrStatusTrackingTests(SimpleTestCase):
    def test_merge_ocr_queued_metadata_sets_timestamp(self):
        meta = merge_ocr_queued_metadata({"foo": "bar"})
        self.assertIn("ocr_queued_at", meta)
        self.assertNotIn("ocr_processing_at", meta)
        self.assertEqual(meta["foo"], "bar")

    @patch("apps.documents.ocr.status.timezone.now")
    def test_heal_stale_marks_failed(self, now_mock):
        now = timezone.now()
        now_mock.return_value = now
        doc = MagicMock()
        doc.id = "doc-1"
        doc.ocr_status = OCRStatus.PROCESSING
        doc.metadata = {
            "ocr_queued_at": (now - timedelta(seconds=400)).isoformat(),
        }
        doc.updated_at = now

        with patch("apps.documents.models.Document") as document_model:
            document_model.objects.filter.return_value.update = MagicMock()
            healed = heal_stale_ocr_status(doc)

        self.assertTrue(healed)
        self.assertEqual(doc.ocr_status, OCRStatus.FAILED)
        self.assertNotIn("ocr_queued_at", doc.metadata)


class AdminMetadataFillTests(SimpleTestCase):
    def test_grn_custom_field_backfilled_from_reference_number(self):
        doc = MagicMock()
        doc.document_type.metadata_fields.all.return_value.order_by.return_value = [
            MagicMock(
                key="goods_receipt_note_number",
                label="Goods Receipt note number",
                field_type="text",
                is_required=False,
                help_text="",
                select_options=[],
            ),
        ]
        doc.document_type.name = "Goods Receipt Note"
        doc.document_type.code = "GRN"

        filled = _fill_admin_metadata_fields(
            doc,
            {"reference_number": "GRN-8842", "supplier": "Acme Ltd"},
        )

        self.assertEqual(filled["goods_receipt_note_number"], "GRN-8842")
