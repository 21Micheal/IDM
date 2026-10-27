"""Runtime block helpers: on-demand sections, buttons and linked tables.

Ordering here must match ``frontend/src/lib/formBlocks.ts`` (and its vitest
counterpart) exactly.
"""
import io
from types import SimpleNamespace

from django.test import TestCase

from apps.templates_engine.blocks import (
    active_sections,
    added_section_ids,
    effective_sections,
    materialize_sections,
    prune_inactive_values,
)
from apps.templates_engine.conditions import compute_calculated_values
from apps.templates_engine.tasks import generate_built_docx, generate_built_pdf


def _sec(sid, *, on_demand=False, fields=None):
    return {"id": sid, "title": sid, "onDemand": on_demand, "fields": fields or []}


def _add_btn(sid, target, placement, anchor=None):
    button = {"action": "add_block", "targetSectionId": target, "placement": placement}
    if anchor:
        button["anchorSectionId"] = anchor
    return {"id": f"btn_{sid}", "key": f"btn_{sid}", "type": "button", "label": "Add", "button": button}


def _ids(sections, values):
    return [s["id"] for s in active_sections(sections, values)]


class SectionOrderingTests(TestCase):
    def setUp(self):
        self.sections = [
            _sec("s1", fields=[
                _add_btn("end", "od_end", "end_of_form"),
                _add_btn("b1", "od_b1", "below_button"),
                _add_btn("b2", "od_b2", "below_button"),
            ]),
            _sec("s2"),
            _sec("s3", fields=[_add_btn("after", "od_after", "after_section", "s3")]),
            _sec("od_end", on_demand=True),
            _sec("od_b1", on_demand=True),
            _sec("od_b2", on_demand=True),
            _sec("od_after", on_demand=True),
        ]

    def test_no_additions(self):
        self.assertEqual(_ids(self.sections, {}), ["s1", "s2", "s3"])

    def test_end_of_form(self):
        self.assertEqual(_ids(self.sections, {"__sections_added": ["od_end"]}), ["s1", "s2", "s3", "od_end"])

    def test_below_button(self):
        self.assertEqual(_ids(self.sections, {"__sections_added": ["od_b1"]}), ["s1", "od_b1", "s2", "s3"])

    def test_after_section(self):
        self.assertEqual(_ids(self.sections, {"__sections_added": ["od_after"]}), ["s1", "s2", "s3", "od_after"])

    def test_two_blocks_same_anchor_stack_in_click_order(self):
        self.assertEqual(
            _ids(self.sections, {"__sections_added": ["od_b1", "od_b2"]}),
            ["s1", "od_b1", "od_b2", "s2", "s3"],
        )

    def test_unknown_anchor_falls_back_to_end(self):
        sections = [_sec("s1", fields=[_add_btn("x", "od", "after_section", "nope")]), _sec("od", on_demand=True)]
        self.assertEqual(_ids(sections, {"__sections_added": ["od"]}), ["s1", "od"])

    def test_duplicate_ids_are_deduped(self):
        self.assertEqual(_ids(self.sections, {"__sections_added": ["od_end", "od_end"]}), ["s1", "s2", "s3", "od_end"])

    def test_unknown_section_id_ignored(self):
        self.assertEqual(_ids(self.sections, {"__sections_added": ["ghost"]}), ["s1", "s2", "s3"])

    def test_added_section_ids_tolerates_junk(self):
        self.assertEqual(added_section_ids({"__sections_added": "od_end, od_end,, 7"}), ["od_end", "7"])
        self.assertEqual(added_section_ids({"__sections_added": None}), [])
        self.assertEqual(added_section_ids(None), [])
        self.assertEqual(added_section_ids({"__sections_added": [1, "1", " x "]}), ["1", "x"])


class PruneTests(TestCase):
    def setUp(self):
        self.sections = [
            _sec("s1", fields=[{"key": "always", "type": "text"}]),
            _sec("od", on_demand=True, fields=[
                {"key": "opt", "type": "text"},
                {"key": "always", "type": "text"},
            ]),
        ]

    def test_forged_unadded_value_is_pruned(self):
        out = prune_inactive_values(self.sections, {"always": "x", "opt": "y"})
        self.assertNotIn("opt", out)
        self.assertEqual(out["always"], "x")

    def test_added_value_is_kept(self):
        out = prune_inactive_values(self.sections, {"opt": "y", "__sections_added": ["od"]})
        self.assertEqual(out["opt"], "y")
        self.assertEqual(out["__sections_added"], ["od"])

    def test_key_owned_by_a_normal_section_is_never_pruned(self):
        out = prune_inactive_values(self.sections, {"always": "x"})
        self.assertEqual(out.get("always"), "x")

    def test_ids_normalised_to_known_on_demand_sections(self):
        out = prune_inactive_values(self.sections, {"__sections_added": ["od", "ghost", "od"]})
        self.assertEqual(out["__sections_added"], ["od"])
        out2 = prune_inactive_values(self.sections, {"__sections_added": ["ghost"]})
        self.assertNotIn("__sections_added", out2)

    def test_does_not_mutate_input(self):
        original = {"opt": "y", "__sections_added": ["ghost"]}
        snapshot = dict(original)
        prune_inactive_values(self.sections, original)
        self.assertEqual(original, snapshot)


class MaterializeTests(TestCase):
    def test_embed_becomes_table_from_snapshot_without_bindings(self):
        sections = [_sec("s1", fields=[{
            "id": "f1", "key": "linked", "type": "reference", "referenceSource": "table",
            "tableRef": {
                "scope": "this_form", "tableKey": "src", "mode": "embed",
                "snapshot": {"columns": [{"key": "gross", "label": "Gross", "sunsystems": {"role": "amount"}}], "minRows": 2},
            },
        }])]
        out = materialize_sections(sections, row_pickers_as_text=True)
        field = out[0]["fields"][0]
        self.assertEqual(field["type"], "table")
        self.assertEqual(field["columns"][0]["key"], "gross")
        self.assertNotIn("sunsystems", field["columns"][0])
        self.assertEqual(field["minRows"], 2)
        self.assertEqual(field["colSpan"], 12)
        # never mutate the input
        self.assertEqual(sections[0]["fields"][0]["type"], "reference")

    def test_row_picker_becomes_text_only_on_server(self):
        sections = [_sec("s1", fields=[{
            "key": "pick", "type": "reference", "referenceSource": "table",
            "tableRef": {"scope": "this_form", "tableKey": "src", "mode": "row_picker", "displayColumn": "name"},
        }])]
        client = materialize_sections(sections, row_pickers_as_text=False)
        self.assertEqual(client[0]["fields"][0]["type"], "reference")
        server = materialize_sections(sections, row_pickers_as_text=True)
        self.assertEqual(server[0]["fields"][0]["type"], "text")
        self.assertNotIn("referenceSource", server[0]["fields"][0])

    def test_effective_sections_materialises_and_activates(self):
        sections = [
            _sec("s1", fields=[_add_btn("a", "od", "end_of_form")]),
            _sec("od", on_demand=True, fields=[{
                "key": "linked", "type": "reference", "referenceSource": "table",
                "tableRef": {"scope": "this_form", "tableKey": "src", "mode": "embed",
                             "snapshot": {"columns": [{"key": "v"}]}},
            }]),
        ]
        eff = effective_sections(sections, {"__sections_added": ["od"]})
        self.assertEqual([s["id"] for s in eff], ["s1", "od"])
        self.assertEqual(eff[1]["fields"][0]["type"], "table")


class AggregateEdgeTests(TestCase):
    def test_sum_over_an_unadded_table_is_zero(self):
        sections = [_sec("s1", fields=[{
            "key": "total", "type": "calc_number",
            "calc": {"expression": "SUM(general_requisition.gross_value)", "decimals": 2},
        }])]
        out = compute_calculated_values(sections, {})
        self.assertEqual(float(out["total"]), 0.0)

    def test_budget_amount_field_in_unadded_section_resolves_zero(self):
        # amount_field points at a field pruned away -> nothing to read -> 0.
        values = prune_inactive_values(
            [_sec("s1"), _sec("od", on_demand=True, fields=[{"key": "amount_field", "type": "currency"}])],
            {"amount_field": 500},
        )
        self.assertNotIn("amount_field", values)
        self.assertEqual(values.get("amount_field", 0) or 0, 0)


class RendererButtonTests(TestCase):
    def _template_and_sections(self):
        template = SimpleNamespace(name="Blocked form", sections=[], type="built")
        sections = [_sec("s1", fields=[
            {"key": "add_row", "type": "button", "label": "Add expense table"},
            {"key": "note", "type": "text", "label": "Note"},
        ])]
        return template, sections

    def test_docx_skips_buttons_and_includes_other_fields(self):
        template, sections = self._template_and_sections()
        content = generate_built_docx(template, {"note": "Ada"}, sections=sections)
        from docx import Document as DocxDocument

        text = "\n".join(p.text for p in DocxDocument(io.BytesIO(content)).paragraphs)
        self.assertNotIn("Add expense table", text)
        self.assertIn("Ada", text)

    def test_pdf_generation_accepts_effective_sections(self):
        template, sections = self._template_and_sections()
        # Must not raise even though the button has no value.
        content = generate_built_pdf(template, {"note": "Ada"}, sections=sections)
        self.assertTrue(content)


class FillBlockRuntimeTests(TestCase):
    """The create/fill endpoint honours on-demand sections and linked tables."""

    def setUp(self):
        from rest_framework.test import APIClient

        from apps.accounts.models import User
        from apps.documents.models import Document, DocumentType
        from apps.templates_engine.models import DocumentTemplate

        self._Document = Document
        self.client = APIClient()
        self.user = User.objects.create_user(
            email="fill-blocks@example.com", password="pass", first_name="F", last_name="U"
        )
        self.doc_type = DocumentType.objects.create(
            name="Blocked requisition", code="REQBLK", reference_prefix="RB", created_by=self.user
        )
        self.sections = [
            {"id": "s1", "title": "Main", "fields": [
                {"key": "title", "type": "text", "label": "Title", "required": True},
                {"id": "b1", "key": "add", "type": "button", "label": "Add expenses",
                 "button": {"action": "add_block", "targetSectionId": "od", "placement": "end_of_form"}},
                {"key": "total", "type": "calc_number", "label": "Total",
                 "calc": {"expression": "SUM(od_table.amount)", "decimals": 2}},
            ]},
            {"id": "od", "title": "Expenses", "onDemand": True, "removable": True, "fields": [
                {"key": "od_table", "type": "table", "label": "Lines", "columns": [
                    {"key": "item", "label": "Item", "type": "text", "required": True},
                    {"key": "amount", "label": "Amount", "type": "currency"},
                ]},
            ]},
        ]
        self.template = DocumentTemplate.objects.create(
            name="Block form", type="built", kind="form",
            document_type=self.doc_type, created_by=self.user, sections=self.sections,
        )
        self.client.force_authenticate(user=self.user)

    def _fill(self, values):
        return self.client.post(
            f"/api/v1/templates/{self.template.id}/fill/",
            {"values": values, "title": "Doc", "output_format": "pdf",
             "document_type_id": str(self.doc_type.id)},
            format="json",
        )

    def _stored_values(self, response):
        doc = self._Document.objects.get(id=response.data["document_id"])
        return (doc.metadata or {}).get("form", {}).get("values", {})

    def test_required_field_in_unadded_section_does_not_block(self):
        response = self._fill({"title": "Office supplies"})
        self.assertEqual(response.status_code, 200, response.data)

    def test_added_section_required_column_blocks(self):
        response = self._fill({
            "title": "Office supplies",
            "__sections_added": ["od"],
            "od_table": [{"item": "", "amount": "5"}],
        })
        self.assertEqual(response.status_code, 400)
        self.assertIn("Lines", str(response.data))

    def test_forged_values_for_unadded_section_are_pruned(self):
        response = self._fill({
            "title": "Office supplies",
            "od_table": [{"item": "Laptop", "amount": "5"}],
        })
        self.assertEqual(response.status_code, 200, response.data)
        self.assertNotIn("od_table", self._stored_values(response))

    def test_sum_over_unadded_table_is_zero(self):
        response = self._fill({"title": "Office supplies"})
        self.assertEqual(response.status_code, 200, response.data)
        self.assertEqual(float(self._stored_values(response)["total"]), 0.0)

    def test_added_table_sum_is_computed_and_sections_persisted(self):
        response = self._fill({
            "title": "Office supplies",
            "__sections_added": ["od"],
            "od_table": [{"item": "Laptop", "amount": "10"}, {"item": "Dock", "amount": "4"}],
        })
        self.assertEqual(response.status_code, 200, response.data)
        stored = self._stored_values(response)
        self.assertEqual(stored["__sections_added"], ["od"])
        self.assertEqual(float(stored["total"]), 14.0)
