from datetime import date
from types import SimpleNamespace

from django.test import SimpleTestCase

from apps.search.views import (
    _as_list,
    _es_value,
    _parse_bool,
    _parse_positive_int,
    _wildcard_query,
)


class SearchRequestParsingTests(SimpleTestCase):
    def test_parse_positive_int_clamps_invalid_and_limits_maximum(self):
        self.assertEqual(_parse_positive_int("3", 1), 3)
        self.assertEqual(_parse_positive_int("0", 1), 1)
        self.assertEqual(_parse_positive_int("-4", 1), 1)
        self.assertEqual(_parse_positive_int("bad", 7), 7)
        self.assertEqual(_parse_positive_int("250", 20, maximum=100), 100)

    def test_parse_bool_handles_string_values_without_truthiness_leaks(self):
        self.assertIs(_parse_bool(True), True)
        self.assertIs(_parse_bool(False), False)
        self.assertIs(_parse_bool("true"), True)
        self.assertIs(_parse_bool("1"), True)
        self.assertIs(_parse_bool("false"), False)
        self.assertIs(_parse_bool("0"), False)
        self.assertIsNone(_parse_bool("maybe"))

    def test_as_list_normalizes_scalars_and_iterables(self):
        self.assertEqual(_as_list("approved"), ["approved"])
        self.assertEqual(_as_list(["approved", "", None, "draft"]), ["approved", "draft"])
        self.assertEqual(_as_list(None), [])

    def test_wildcard_query_escapes_query_string_operators(self):
        self.assertEqual(_wildcard_query("INV-100 (draft)"), "*inv\\-100* AND *draft*")

    def test_es_value_serializes_dates(self):
        self.assertEqual(_es_value(date(2026, 5, 20)), "2026-05-20")


class DocumentIndexAccessPreparationTests(SimpleTestCase):
    def test_accessible_user_ids_include_uploader_owner_and_active_assignees(self):
        from apps.search.documents import DocumentIndex

        tasks = [
            SimpleNamespace(status="pending", assigned_to_id="user-3"),
            SimpleNamespace(status="approved", assigned_to_id="user-4"),
            SimpleNamespace(status="held", assigned_to_id=None),
        ]
        workflow = SimpleNamespace(tasks=SimpleNamespace(all=lambda: tasks))
        document = SimpleNamespace(
            uploaded_by_id="user-1",
            owned_by_id="user-2",
            workflow_instance=workflow,
        )

        self.assertEqual(
            DocumentIndex().prepare_accessible_user_ids(document),
            ["user-1", "user-2", "user-3"],
        )
