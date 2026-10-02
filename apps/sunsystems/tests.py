from unittest.mock import patch

from django.core.files.uploadedfile import SimpleUploadedFile
from django.test import SimpleTestCase, TestCase
from rest_framework.test import APIClient

from apps.accounts.models import User
from apps.documents.models import Document, DocumentStatus, DocumentType
from apps.sunsystems.client import SunSystemsConfig, _build_zeep_clients, _normalize_base_url
from apps.sunsystems.config import get_journal_mapping
from apps.sunsystems.models import JournalPosting, JournalPostingStatus
from apps.workflows.services import WorkflowService


class SunSystemsClientTests(SimpleTestCase):
    def test_normalize_base_url_strips_endpoint_suffixes(self):
        self.assertEqual(
            _normalize_base_url("http://sunsrv02.flaxem.int:81/sunsystems-connect/SecurityProvider?wsdl"),
            "http://sunsrv02.flaxem.int:81/sunsystems-connect",
        )

    def test_build_zeep_clients_disables_proxy_env(self):
        class DummySession:
            def __init__(self):
                self.trust_env = True
                self.auth = None
                self.verify = True

        session = DummySession()
        with patch("apps.sunsystems.client.requests.Session", side_effect=lambda: session), patch(
            "apps.sunsystems.client.ZeepClient"
        ), patch("apps.sunsystems.client.Transport"):
            cfg = SunSystemsConfig.from_mapping(
                {
                    "base_url": "http://sunsrv02.flaxem.int:81/sunsystems-connect/wsdl",
                    "username": "demo",
                    "password": "secret",
                }
            )
            _build_zeep_clients(cfg)

        self.assertFalse(session.trust_env)


class JournalConfigTests(SimpleTestCase):
    def test_get_journal_mapping_inherits_parent_enabled(self):
        document = type(
            "Document",
            (),
            {
                "metadata": {
                    "sunsystems": {
                        "journal": {
                            "enabled": True,
                            "stages": [
                                {
                                    "stage": 1,
                                    "label": "Advance",
                                    "lines": [{"amount": 100, "dc": "D"}],
                                }
                            ],
                        }
                    }
                }
            },
        )()

        mapping = get_journal_mapping(document)

        self.assertIsNotNone(mapping)
        self.assertTrue(mapping.get("enabled"))
        self.assertEqual(mapping.get("stage"), 1)
        self.assertEqual(mapping.get("label"), "Advance")

    def test_get_journal_mapping_preserves_explicit_stage_enabled(self):
        document = type(
            "Document",
            (),
            {
                "metadata": {
                    "sunsystems": {
                        "journal": {
                            "enabled": True,
                            "stages": [
                                {
                                    "stage": 1,
                                    "enabled": False,
                                    "label": "Advance",
                                    "lines": [{"amount": 100, "dc": "D"}],
                                }
                            ],
                        }
                    }
                }
            },
        )()

        mapping = get_journal_mapping(document)

        self.assertIsNotNone(mapping)
        self.assertFalse(mapping.get("enabled"))
        self.assertEqual(mapping.get("stage"), 1)


class JournalPostingQueueTests(TestCase):
    def test_workflow_hook_creates_pending_posting_before_celery_runs(self):
        doc_type = DocumentType.objects.create(
            name="Imprest",
            code="IMP",
            reference_prefix="IMP",
        )
        user = User.objects.create_user(
            email="u@example.com",
            password="pass",
            first_name="Test",
            last_name="User",
        )
        document = Document.objects.create(
            title="Imprest",
            reference_number="IMP-00001",
            document_type=doc_type,
            uploaded_by=user,
            status=DocumentStatus.APPROVED,
            file=SimpleUploadedFile("test.pdf", b"pdf", content_type="application/pdf"),
            file_name="test.pdf",
            file_size=3,
            metadata={
                "form": {"sections": [], "values": {}},
                "sunsystems": {
                    "journal": {
                        "enabled": True,
                        "stages": [
                            {
                                "stage": 1,
                                "label": "Advance",
                                "post_on": "approved",
                                "lines": [{"amount": 100, "dc": "D"}],
                            }
                        ],
                    }
                },
            },
        )

        WorkflowService._maybe_post_sunsystems_journal(document, "approved")

        posting = JournalPosting.objects.get(document=document, stage=1)
        self.assertEqual(posting.status, JournalPostingStatus.PENDING)
        self.assertEqual(posting.stage_label, "Advance")
        self.assertEqual(posting.message, "Queued for SunSystems posting.")


class ItemsQueryViewTests(TestCase):
    def setUp(self):
        self.user = User.objects.create_user(
            email="items@example.com",
            password="pass",
            first_name="Item",
            last_name="Reader",
        )
        self.client = APIClient()
        self.client.force_authenticate(self.user)

    def test_items_query_parses_response_and_uses_item_component(self):
        response_xml = (
            "<SSC><Payload>"
            "<Item>"
            "<ItemCode>ITM001</ItemCode>"
            "<Description>Widget</Description>"
            "<ItemType>STOCK</ItemType>"
            "<BaseItemUnit>EA</BaseItemUnit>"
            "</Item>"
            "<Item><ItemCode>ITM002</ItemCode><Description>Gadget</Description></Item>"
            "</Payload></SSC>"
        )
        with patch("apps.sunsystems.views.SunSystemsClient") as client_cls:
            client_cls.return_value.execute.return_value = response_xml
            response = self.client.get("/api/v1/sunsystems/items/")

        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertTrue(body["ok"])
        self.assertEqual(body["count"], 2)
        self.assertEqual(body["items"][0], {
            "item_code": "ITM001",
            "description": "Widget",
            "item_type": "STOCK",
            "base_item_unit": "EA",
        })

        args = client_cls.return_value.execute.call_args.args
        self.assertEqual(args[0], "Item")
        self.assertEqual(args[1], "Query")
        self.assertIn("<ItemCode>.</ItemCode>", args[2])
        self.assertIn("<BusinessUnit>PK1</BusinessUnit>", args[2])

    def test_items_query_reports_gateway_errors(self):
        from apps.sunsystems.client import SunSystemsError

        with patch("apps.sunsystems.views.SunSystemsClient") as client_cls:
            client_cls.return_value.execute.side_effect = SunSystemsError("boom")
            response = self.client.get("/api/v1/sunsystems/items/")

        self.assertEqual(response.status_code, 502)
        self.assertFalse(response.json()["ok"])


class AnalysisCodesQueryViewTests(TestCase):
    def setUp(self):
        self.user = User.objects.create_user(
            email="analysis@example.com",
            password="pass",
            first_name="Analysis",
            last_name="Reader",
        )
        self.client = APIClient()
        self.client.force_authenticate(self.user)

    def test_requires_a_dimension(self):
        response = self.client.get("/api/v1/sunsystems/analysis-codes/")
        self.assertEqual(response.status_code, 400)
        self.assertFalse(response.json()["ok"])

    def test_substitutes_the_dimension_filter_and_parses_codes(self):
        response_xml = (
            "<SSC><Payload>"
            "<AnalysisCodes>"
            "<AnalysisCode>P001</AnalysisCode>"
            "<AnalysisDimensionId>04</AnalysisDimensionId>"
            "<Name>Project One</Name>"
            "</AnalysisCodes>"
            "<AnalysisCodes><AnalysisCode>P002</AnalysisCode><Name>Project Two</Name></AnalysisCodes>"
            "</Payload></SSC>"
        )
        with patch("apps.sunsystems.views.SunSystemsClient") as client_cls:
            client_cls.return_value.execute.return_value = response_xml
            response = self.client.get("/api/v1/sunsystems/analysis-codes/?dimension=04")

        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertTrue(body["ok"])
        self.assertEqual(body["count"], 2)
        self.assertEqual(body["analysis_codes"][0], {
            "analysis_code": "P001",
            "analysis_dimension_id": "04",
            "name": "Project One",
        })
        # A missing dimension id in the response falls back to the requested one.
        self.assertEqual(body["analysis_codes"][1]["analysis_dimension_id"], "04")

        args = client_cls.return_value.execute.call_args.args
        self.assertEqual(args[0], "AnalysisCodes")
        self.assertEqual(args[1], "Query")
        self.assertIn('value="04"', args[2])
        self.assertIn('/AnalysisCodes/AnalysisDimensionId', args[2])
