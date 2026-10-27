"""LPO document generation + workflow wiring tests."""
from django.core.files.uploadedfile import SimpleUploadedFile
from django.test import TestCase

from apps.accounts.models import User
from apps.documents.lpo import (
    amount_in_words,
    build_lpo_merge_values,
    generate_lpo_for_document,
)
from apps.documents.models import Document, DocumentRelationship, DocumentStatus, DocumentType
from apps.templates_engine.models import DocumentTemplate


def _v2_design():
    return {
        "schemaVersion": 2,
        "page": {"size": "A4", "orientation": "portrait", "margin": {"top": 20, "right": 18, "bottom": 20, "left": 18}},
        "theme": {"fontFamily": "Calibri", "headingFamily": "Calibri", "baseFontSize": 13, "lineHeight": 1.4, "textColor": "#1F2933", "headingColor": "#0F2A3A", "accentColor": "#287EAD"},
        "header": {"enabled": True, "rows": [{"id": "h1", "gap": 8, "columns": [{"id": "hc", "width": 1, "elements": [{"id": "he", "type": "text", "text": "{{company.name}}"}]}]}]},
        "footer": {"enabled": True, "rows": [{"id": "f1", "gap": 8, "columns": [{"id": "fc", "width": 1, "elements": [{"id": "fe", "type": "text", "text": "Page {{page}} of {{pages}}"}]}]}]},
        "watermark": {"enabled": False, "kind": "text", "value": "", "opacity": 10},
        "pages": [
            {
                "id": "p1",
                "name": "Purchase order",
                "rows": [
                    {"id": "r1", "gap": 8, "columns": [{"id": "c1", "width": 1, "elements": [
                        {"id": "e1", "type": "heading", "text": "Purchase Order", "level": 1},
                        {"id": "e2", "type": "field_group", "fields": [
                            {"id": "fg1", "label": "LPO No:", "value": "{{lpo.number}}"},
                            {"id": "fg2", "label": "Supplier:", "value": "{{supplier.code}}"},
                        ]},
                        {"id": "e3", "type": "data_table", "sourceKey": "line_items", "previewRows": 2, "columns": [
                            {"id": "col1", "key": "item", "label": "Item", "width": 40},
                            {"id": "col2", "key": "quantity", "label": "Qty", "width": 20},
                            {"id": "col3", "key": "gross_value", "label": "Gross Value", "width": 40},
                        ]},
                        {"id": "e4", "type": "text", "text": "Total: {{lpo.grand_total}}"},
                    ]}]},
                ],
            }
        ],
        "requiredFields": ["lpo.number", "line_items"],
    }


def _sections():
    return [
        {"id": "req", "title": "Requisition", "fields": [
            {"id": "t1", "key": "reference_7mz7", "type": "text", "label": "Reference"},
            {"id": "t2", "key": "travel_requisition_cy2v", "type": "table", "label": "Travel Requisition", "columns": [
                {"id": "c1", "key": "trip_purpose_igbw", "type": "text", "label": "Trip Purpose"},
                {"id": "c2", "key": "destination_lsj0", "type": "text", "label": "Destination"},
                {"id": "c3", "key": "currency_poa7", "type": "select", "label": "Currency"},
                {"id": "c4", "key": "estimated_cost_yvqi", "type": "currency", "label": "Estimated Cost"},
            ]},
        ]},
        {"id": "gen", "title": "General Requisition", "onDemand": True, "fields": [
            {"id": "t3", "key": "data_table_dkkl", "type": "table", "label": "Data table", "columns": [
                {"id": "c5", "key": "item_c5tl", "type": "external", "label": "Item"},
                {"id": "c6", "key": "description_pxrq", "type": "text", "label": "Description"},
                {"id": "c7", "key": "uom_ce9l", "type": "text", "label": "UOM"},
                {"id": "c8", "key": "quantity_y482", "type": "number", "label": "Quantity"},
                {"id": "c9", "key": "unit_price_591x", "type": "currency", "label": "Unit Price"},
                {"id": "c10", "key": "net_price_ohc4", "type": "currency", "label": "Net Price"},
                {"id": "c11", "key": "vat_hmoi", "type": "percentage", "label": "%VAT"},
                {"id": "c12", "key": "vat_lvc7", "type": "text", "label": "VAT"},
                {"id": "c13", "key": "gross_value_rlwr", "type": "currency", "label": "Gross Value"},
            ]},
        ]},
    ]


class LpoGenerationTests(TestCase):
    def setUp(self):
        self.user = User.objects.create_user(email="req@example.com", password="pass", first_name="Req", last_name="User")
        self.lpo_type = DocumentType.objects.create(name="LPO", code="LPO", reference_prefix="LPO")
        self.req_type = DocumentType.objects.create(name="Requisition Form", code="REQUISITION_FORM", reference_prefix="RQF")
        self.template = DocumentTemplate.objects.create(
            name="Purchase Order Template",
            type="built",
            kind="document",
            document_type=self.lpo_type,
            design=_v2_design(),
            created_by=self.user,
        )
        self.requisition = Document.objects.create(
            title="Requisition — Travel",
            reference_number="RQF-00042",
            document_type=self.req_type,
            uploaded_by=self.user,
            status=DocumentStatus.APPROVED,
            file=SimpleUploadedFile("req.pdf", b"pdf", content_type="application/pdf"),
            file_name="req.pdf",
            file_size=3,
            metadata={
                "form": {
                    "template_id": "tpl",
                    "workflow_type": "requisition",
                    "workflow_phase": "lpo",
                    "completed_workflow_stages": ["requisition", "lpo"],
                    "sections": _sections(),
                    "values": {
                        "reference_7mz7": "REQ-1",
                        "travel_requisition_cy2v": [
                            {"trip_purpose_igbw": "Conference", "destination_lsj0": "Kigali", "currency_poa7": "USD", "estimated_cost_yvqi": "4000"},
                        ],
                        "data_table_dkkl": [
                            {"item_c5tl": "GB2002", "description_pxrq": "Cabinets", "uom_ce9l": "EA", "quantity_y482": "2", "unit_price_591x": "453", "net_price_ohc4": "906", "vat_hmoi": "11", "vat_lvc7": "99.66", "gross_value_rlwr": "1005.66"},
                        ],
                    },
                }
            },
        )

    def test_build_lpo_merge_values_maps_lines_and_totals(self):
        merge = build_lpo_merge_values(self.requisition, "LPO-00009")
        self.assertEqual(merge["lpo.number"], "LPO-00009")
        self.assertEqual(merge["lpo.grand_total"], "5005.66")
        self.assertEqual(len(merge["line_items"]), 2)
        first, second = merge["line_items"]
        self.assertEqual(first["number"], 1)
        self.assertIn("Conference", first["item"])
        self.assertEqual(first["gross_value"], "4000.00")
        self.assertEqual(second["item"], "Cabinets")
        self.assertEqual(second["quantity"], "2")
        self.assertEqual(second["gross_value"], "1005.66")
        self.assertTrue(merge["lpo.amount_words"].startswith("Five Thousand Five"))

    def test_generate_lpo_document_renders_and_links(self):
        lpo = generate_lpo_for_document(self.requisition, actor=self.user)
        self.assertIsNotNone(lpo)
        self.assertTrue(lpo.reference_number.startswith("LPO-"))
        self.assertEqual(lpo.document_type_id, self.lpo_type.id)
        self.assertTrue(lpo.file.read())
        self.assertEqual(lpo.file_name, f"Purchase Order {lpo.reference_number}.docx")

        self.requisition.refresh_from_db()
        form = self.requisition.metadata["form"]
        self.assertEqual(form["lpo_document_id"], str(lpo.id))
        self.assertEqual(form["values"]["__lpo_number"], lpo.reference_number)
        self.assertEqual(form["values"]["__requisition_number"], "RQF-00042")
        self.assertTrue(
            DocumentRelationship.objects.filter(
                source_document=self.requisition,
                target_document=lpo,
                relation_type=DocumentRelationship.RelationType.REFERENCES,
            ).exists()
        )

    def test_generate_is_idempotent(self):
        first = generate_lpo_for_document(self.requisition, actor=self.user)
        second = generate_lpo_for_document(self.requisition, actor=self.user)
        self.assertEqual(first.id, second.id)

    def test_workflow_hook_generates_only_on_lpo_completion(self):
        from apps.workflows.services import WorkflowService

        lpo = WorkflowService._maybe_generate_lpo_document(self.requisition, outcome="approved", actor=self.user)
        self.assertIsNotNone(lpo)

        other = Document.objects.create(
            title="Requisition — RFQ done",
            reference_number="RQF-00043",
            document_type=self.req_type,
            uploaded_by=self.user,
            status=DocumentStatus.APPROVED,
            file=SimpleUploadedFile("req2.pdf", b"pdf", content_type="application/pdf"),
            file_name="req2.pdf",
            file_size=3,
            metadata={"form": {"workflow_type": "requisition", "workflow_phase": "rfq", "completed_workflow_stages": ["requisition", "rfq"], "sections": [], "values": {}}},
        )
        self.assertIsNone(WorkflowService._maybe_generate_lpo_document(other, outcome="approved", actor=self.user))

    def test_amount_in_words(self):
        self.assertEqual(amount_in_words("0"), "Zero Only")
        self.assertEqual(amount_in_words("1005.66").split(" And ")[0], "One Thousand Five")
