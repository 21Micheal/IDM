"""Tests for tenant IDP policy routing."""
from django.test import SimpleTestCase

from apps.documents.models import DMSSettings
from apps.documents.ocr.idp_policy import (
    IdpPolicy,
    build_needs_manual_metadata,
    classify_anthropic_error,
    should_promote_suggestions,
)


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
