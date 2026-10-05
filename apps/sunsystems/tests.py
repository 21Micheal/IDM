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


class PurchaseOrderMappingTests(SimpleTestCase):
    """The multi-line PurchaseOrder compiler used by LPO posting."""

    BASE = {
        "enabled": True,
        "component": "PurchaseOrder",
        "method": "CreateOrAmend",
        "context": {"business_unit": {"const": "PK1"}},
        "purchase_order": {
            "reference": {"source": "lpo_number"},
            "second_reference": {"field": "reference_7mz7"},
            "supplier_code": {"field": "supplier_wudn"},
            "transaction_type": {"const": "ASSETS"},
            "invoice_address_code": {"const": "0000000000"},
            "date": {"field": "approved_date", "format": "DDMMYYYY"},
            "vlab_base_num": {"const": "7"},
            "vlab_trans_num": {"const": "9"},
            "analysis": {
                str(n): {
                    "category": {"const": dim},
                    "code": {"field": "analysis_codes", "key": str(n)},
                }
                for n, dim in enumerate(
                    ["04", "05", "06", "03", "08", "09", "10", "11", "07", "12"], start=1
                )
            },
            "lines": [
                {
                    "repeat_over": "items",
                    "account_code": {"const": "1-1-05-0060"},
                    "item_code": {"row_field": "item"},
                    "currency": {"row_field": "currency"},
                    "quantity": {"row_field": "qty"},
                    "unit_price": {"row_field": "price"},
                    "amount": {"row_field": "gross"},
                }
            ],
        },
    }

    def _values(self):
        return {
            "__lpo_number": "LPO-00001",
            "reference_7mz7": "RQF-00012",
            "supplier_wudn": ["SPN046"],
            "approved_date": "2024-01-26",
            "analysis_codes": {"1": "PROJ-1", "2": "CC-9", "5": "SI-3"},
            "items": [
                {"item": "ITM29", "currency": "USD", "qty": "2", "price": "100", "gross": "230"},
                {"item": "ITM30", "currency": "USD", "qty": "1", "price": "50", "gross": "59"},
                {"item": "", "currency": "", "qty": "", "price": "", "gross": ""},
            ],
        }

    def test_builds_one_line_per_non_empty_row(self):
        from xml.etree import ElementTree as ET
        from apps.sunsystems.mapping import build_sunsystems_ssc

        build = build_sunsystems_ssc(dict(self.BASE), self._values())
        self.assertEqual(build.line_count, 2)
        self.assertEqual(build.debit_total, 289)

        root = ET.fromstring(build.ssc_xml)
        self.assertEqual(root.findtext(".//BusinessUnit"), "PK1")
        order = root.find(".//PurchaseOrder")
        self.assertEqual(order.findtext("SupplierCode"), "SPN046")
        self.assertEqual(order.findtext("PurchaseOrderReference"), "LPO-00001")
        self.assertEqual(order.findtext("SecondReference"), "RQF-00012")
        lines = order.findall("PurchaseOrderLine")
        self.assertEqual(len(lines), 2)
        self.assertEqual([l.findtext("LineNumber") for l in lines], ["1", "2"])
        self.assertEqual(lines[0].findtext("OrderDate"), "26012024")
        # VLAB 7/9 configuration is honoured.
        self.assertIsNotNone(lines[0].find("VLAB7/Base/VPolVlabEntry_Val"))
        self.assertEqual(lines[0].findtext("VLAB9/Trans/VPolVlabEntry_Val"), "230")
        # Analysis 1/2/5 resolved from the ten-slot panel; 3/4 omitted (empty).
        self.assertEqual(lines[0].findtext("AnalysisQuantity/Analysis1/VPolCatAnalysis_AnlCode"), "PROJ-1")
        self.assertEqual(lines[0].findtext("AnalysisQuantity/Analysis1/VPolCatAnalysis_AnlCatId"), "04")
        self.assertEqual(lines[0].findtext("AnalysisQuantity/Analysis5/VPolCatAnalysis_AnlCode"), "SI-3")
        self.assertIsNone(lines[0].find("AnalysisQuantity/Analysis3"))

    def test_quantity_times_unit_price_when_no_amount_column(self):
        from apps.sunsystems.mapping import build_sunsystems_ssc

        mapping = dict(self.BASE)
        mapping["purchase_order"] = dict(self.BASE["purchase_order"])
        mapping["purchase_order"]["lines"] = [{
            "repeat_over": "items",
            "account_code": {"const": "A"},
            "item_code": {"row_field": "item"},
            "quantity": {"row_field": "qty"},
            "unit_price": {"row_field": "price"},
        }]
        values = self._values()
        build = build_sunsystems_ssc(mapping, values)
        self.assertEqual(build.debit_total, 250)  # 2*100 + 1*50

    def test_missing_supplier_raises(self):
        from apps.sunsystems.mapping import MappingError, build_sunsystems_ssc

        values = self._values()
        values.pop("supplier_wudn")
        with self.assertRaises(MappingError):
            build_sunsystems_ssc(dict(self.BASE), values)

    def test_legacy_single_line_shape_still_works(self):
        from apps.sunsystems.mapping import build_sunsystems_ssc

        legacy = {
            "enabled": True,
            "component": "PurchaseOrder",
            "method": "CreateOrAmend",
            "purchase_order": {
                "reference": {"field": "reference_7mz7"},
                "supplier_code": {"const": "81105"},
                "item_code": {"const": "ITM29"},
                "amount": {"field": "total_gross_copy"},
                "analysis10_category": {"const": "11"},
                "analysis10_code": {"const": "E"},
            },
        }
        values = {"reference_7mz7": "RQF-1", "total_gross_copy": "1005.66"}
        build = build_sunsystems_ssc(legacy, values)
        self.assertEqual(build.line_count, 1)
        self.assertEqual(build.debit_total, __import__("decimal").Decimal("1005.66"))
