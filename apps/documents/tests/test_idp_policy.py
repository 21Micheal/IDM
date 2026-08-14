"""Tests for tenant IDP policy routing."""
from unittest.mock import MagicMock, patch

from django.test import SimpleTestCase

from apps.documents.models import DMSSettings, OCRStatus
from apps.documents.ocr.idp_policy import (
    IdpPolicy,
    apply_idp_unavailable_state,
    build_needs_manual_metadata,
    classify_anthropic_error,
    should_promote_suggestions,
)
from apps.documents.ocr.tasks_ocr import run_ocr


class ClassifyAnthropicErrorTests(SimpleTestCase):
    def test_rate_limit(self):
        self.assertEqual(classify_anthropic_error(Exception("429 rate limit")), "rate_limited")

    def test_unreachable(self):
        self.assertEqual(classify_anthropic_error(TimeoutError("connection timed out")), "unreachable")

    def test_auth(self):
        self.assertEqual(classify_anthropic_error(Exception("401 unauthorized")), "auth_error")


class IdpPolicyTests(SimpleTestCase):
    def test_regex_only_when_enabled_and_policy_allows(self):
        policy = IdpPolicy(
            claude_enabled=True,
            fallback_policy=DMSSettings.IdpFallbackPolicy.CLAUDE_THEN_REGEX,
            allow_regex_fallback=True,
            page_allowance=0,
            pages_used=0,
        )
        self.assertTrue(policy.should_use_regex_on_failure("unreachable"))

    def test_claude_only_never_regex(self):
        policy = IdpPolicy(
            claude_enabled=True,
            fallback_policy=DMSSettings.IdpFallbackPolicy.CLAUDE_ONLY,
            allow_regex_fallback=True,
            page_allowance=0,
            pages_used=0,
        )
        self.assertFalse(policy.should_use_regex_on_failure("unreachable"))

    def test_subscription_inactive_regex_only_if_explicit_policy(self):
        policy = IdpPolicy(
            claude_enabled=False,
            fallback_policy=DMSSettings.IdpFallbackPolicy.CLAUDE_THEN_REGEX,
            allow_regex_fallback=True,
            page_allowance=0,
            pages_used=0,
        )
        self.assertTrue(policy.should_use_regex_on_failure("subscription_inactive"))

    def test_page_budget(self):
        policy = IdpPolicy(
            claude_enabled=True,
            fallback_policy=DMSSettings.IdpFallbackPolicy.CLAUDE_ONLY,
            allow_regex_fallback=False,
            page_allowance=10,
            pages_used=10,
        )
        self.assertFalse(policy.has_page_budget(1))


class PromotionTests(SimpleTestCase):
    def test_claude_promotes(self):
        self.assertTrue(should_promote_suggestions({"engine": "claude_text"}))

    def test_regex_does_not_promote(self):
        self.assertFalse(should_promote_suggestions({"engine": "regex"}))

    def test_user_confirmed_promotes(self):
        self.assertTrue(should_promote_suggestions({"engine": "regex", "user_confirmed": True}))


class NeedsManualMetadataTests(SimpleTestCase):
    def test_shape(self):
        meta = build_needs_manual_metadata(reason="quota_exhausted", awaiting_user_choice=True)
        quality = meta["ocr_suggestions"]["quality"]
        self.assertEqual(quality["fallback_reason"], "quota_exhausted")
        self.assertTrue(quality["awaiting_user_choice"])
        self.assertEqual(meta["ocr_suggestions"]["fields"], {})


class ApplyIdpUnavailableStateTests(SimpleTestCase):
    @patch("apps.documents.ocr.idp_policy.IdpPolicy.load")
    def test_applies_needs_manual_for_claude_ask(self, load_mock):
        load_mock.return_value = IdpPolicy(
            claude_enabled=False,
            fallback_policy=DMSSettings.IdpFallbackPolicy.CLAUDE_ASK,
            allow_regex_fallback=False,
            page_allowance=0,
            pages_used=0,
        )
        doc = MagicMock()
        doc.id = "doc-1"
        doc.metadata = {}
        doc.ocr_status = ""

        with patch("apps.documents.models.Document") as document_model:
            document_model.objects.filter.return_value.update = MagicMock()
            applied = apply_idp_unavailable_state(doc)

        self.assertTrue(applied)
        self.assertEqual(doc.ocr_status, OCRStatus.NEEDS_MANUAL)
        quality = doc.metadata["ocr_suggestions"]["quality"]
        self.assertEqual(quality["fallback_reason"], "subscription_inactive")
        self.assertTrue(quality["awaiting_user_choice"])

    @patch("apps.documents.ocr.idp_policy.IdpPolicy.load")
    def test_skips_when_auto_regex_allowed(self, load_mock):
        load_mock.return_value = IdpPolicy(
            claude_enabled=False,
            fallback_policy=DMSSettings.IdpFallbackPolicy.CLAUDE_THEN_REGEX,
            allow_regex_fallback=True,
            page_allowance=0,
            pages_used=0,
        )
        doc = MagicMock()
        doc.id = "doc-1"
        doc.metadata = {}

        applied = apply_idp_unavailable_state(doc)

        self.assertFalse(applied)


class RunOcrPolicyRoutingTests(SimpleTestCase):
    @patch("apps.documents.ocr.tasks_ocr._run_local_pipeline")
    @patch("apps.documents.ocr.idp_policy.IdpPolicy.load")
    @patch("apps.documents.ocr.tasks_ocr._normalise_setting")
    def test_env_regex_respects_disabled_claude_ask(
        self,
        normalise_mock,
        load_mock,
        local_pipeline_mock,
    ):
        load_mock.return_value = IdpPolicy(
            claude_enabled=False,
            fallback_policy=DMSSettings.IdpFallbackPolicy.CLAUDE_ASK,
            allow_regex_fallback=False,
            page_allowance=0,
            pages_used=0,
        )

        def _setting(value):
            return str(value).strip().lower()

        normalise_mock.side_effect = _setting

        doc = MagicMock()
        doc.id = "doc-1"

        with patch("apps.documents.ocr.tasks_ocr._has_anthropic_config", return_value=True):
            with patch("django.conf.settings") as settings_mock:
                settings_mock.OCR_IDP_ENGINE = "regex"
                settings_mock.IDP_PROVIDER = "anthropic"
                result = run_ocr(doc)

        local_pipeline_mock.assert_not_called()
        self.assertEqual(result.ocr_status, OCRStatus.NEEDS_MANUAL)
        self.assertTrue(
            result.metadata_updates["ocr_suggestions"]["quality"]["awaiting_user_choice"]
        )
