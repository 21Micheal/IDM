from unittest import mock

from django.core.files.uploadedfile import SimpleUploadedFile
from django.test import TestCase

from apps.accounts.models import User
from apps.documents.bulk_upload import (
    create_bulk_upload_documents,
    get_unclassified_bulk_document_type,
)
from apps.documents.models import BulkUpload, BulkUploadStatus, Document, DocumentType


class BulkUploadClassificationTests(TestCase):
    def setUp(self):
        self.user = User.objects.create_user(
            email="scanner@example.com",
            password="pass",
        )
        self.request = mock.Mock(user=self.user)
        self.grn_type = DocumentType.objects.create(
            name="Goods Receipt Note",
            code="GRN",
            reference_prefix="GRN",
        )

    @mock.patch("apps.documents.bulk_upload.record_audit_event")
    @mock.patch("apps.audit.utils.record_audit_event")
    @mock.patch("apps.documents.ocr.idp_policy.apply_idp_unavailable_state", return_value=False)
    @mock.patch("apps.documents.tasks.ocr_document.delay")
    @mock.patch("apps.documents.bulk_upload._classify_upload_document_type")
    def test_related_set_classifies_each_document_before_ocr(
        self,
        classify_document,
        _ocr_delay,
        _idp_available,
        _upload_audit,
        _audit,
    ):
        classify_document.return_value = self.grn_type
        bulk_upload = BulkUpload.objects.create(
            document_type=get_unclassified_bulk_document_type(),
            uploaded_by=self.user,
            mode=BulkUpload.Mode.RELATED_SET,
            status=BulkUploadStatus.PENDING,
        )
        upload = SimpleUploadedFile(
            "grn.pdf",
            b"%PDF-1.4 fake grn",
            content_type="application/pdf",
        )

        create_bulk_upload_documents(
            bulk_upload=bulk_upload,
            files=[upload],
            request=self.request,
            is_scanned=True,
            auto_classify=False,
        )

        doc = Document.objects.get(bulk_upload=bulk_upload)
        self.assertEqual(doc.document_type, self.grn_type)
        classify_document.assert_called_once()

    @mock.patch("apps.documents.bulk_upload.record_audit_event")
    @mock.patch("apps.audit.utils.record_audit_event")
    @mock.patch("apps.documents.ocr.idp_policy.apply_idp_unavailable_state", return_value=False)
    @mock.patch("apps.documents.tasks.ocr_document.delay")
    @mock.patch("apps.documents.bulk_upload._classify_upload_document_type")
    def test_same_type_bulk_upload_does_not_classify(
        self,
        classify_document,
        _ocr_delay,
        _idp_available,
        _upload_audit,
        _audit,
    ):
        bulk_upload = BulkUpload.objects.create(
            document_type=self.grn_type,
            uploaded_by=self.user,
            mode=BulkUpload.Mode.SAME_TYPE,
            status=BulkUploadStatus.PENDING,
        )
        upload = SimpleUploadedFile(
            "grn.pdf",
            b"%PDF-1.4 fake grn",
            content_type="application/pdf",
        )

        create_bulk_upload_documents(
            bulk_upload=bulk_upload,
            files=[upload],
            request=self.request,
            is_scanned=True,
            auto_classify=False,
        )

        doc = Document.objects.get(bulk_upload=bulk_upload)
        self.assertEqual(doc.document_type, self.grn_type)
        classify_document.assert_not_called()
