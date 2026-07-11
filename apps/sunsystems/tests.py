from django.test import SimpleTestCase

from apps.sunsystems.config import get_journal_mapping


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
