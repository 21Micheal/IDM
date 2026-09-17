"""Tests for IDP usage recording and report gating."""
from datetime import timedelta
from decimal import Decimal
from unittest.mock import MagicMock, patch

from django.test import SimpleTestCase, TestCase
from django.utils import timezone
from rest_framework.test import APIRequestFactory, force_authenticate

from apps.documents.models import IdpUsageDaily
from apps.documents.ocr.usage import (
    build_idp_usage_report,
    estimate_token_cost_usd,
    record_idp_usage_event,
    usage_from_anthropic_response,
)
from apps.documents.views import IdpUsageView


class EstimateTokenCostTests(SimpleTestCase):
    def test_haiku_defaults(self):
        cost = estimate_token_cost_usd(input_tokens=1_000_000, output_tokens=1_000_000)
        self.assertEqual(cost, Decimal("4.800000"))


class UsageFromResponseTests(SimpleTestCase):
    def test_extracts_usage(self):
        response = MagicMock()
        response.usage.input_tokens = 100
        response.usage.output_tokens = 40
        response.usage.cache_read_input_tokens = 10
        response.usage.cache_creation = MagicMock(
            ephemeral_5m_input_tokens=5,
            ephemeral_1h_input_tokens=0,
        )
        usage = usage_from_anthropic_response(response)
        self.assertEqual(usage["input_tokens"], 100)
        self.assertEqual(usage["output_tokens"], 40)
        self.assertEqual(usage["cache_read_tokens"], 10)
        self.assertEqual(usage["cache_write_tokens"], 5)


class RecordIdpUsageEventTests(TestCase):
    def test_increments_daily_row(self):
        today = timezone.localdate()
        record_idp_usage_event(
            outcome="claude",
            claude_pages=2,
            input_tokens=1000,
            output_tokens=200,
        )
        record_idp_usage_event(outcome="needs_manual")
        row = IdpUsageDaily.objects.get(date=today)
        self.assertEqual(row.claude_docs, 1)
        self.assertEqual(row.needs_manual_docs, 1)
        self.assertEqual(row.claude_pages, 2)
        self.assertEqual(row.input_tokens, 1000)
        self.assertEqual(row.output_tokens, 200)
        self.assertGreater(row.estimated_cost_usd, 0)


class BuildIdpUsageReportTests(TestCase):
    def setUp(self):
        today = timezone.localdate()
        IdpUsageDaily.objects.create(
            date=today,
            claude_docs=8,
            needs_manual_docs=2,
            failed_docs=0,
            regex_docs=1,
            claude_pages=10,
            input_tokens=5000,
            output_tokens=1000,
            estimated_cost_usd=Decimal("0.012000"),
        )

    def test_summary_without_billing(self):
        report = build_idp_usage_report(days=30, include_billing=False)
        self.assertEqual(report["summary"]["claude_docs"], 8)
        self.assertEqual(report["summary"]["success_rate_pct"], 80.0)
        self.assertNotIn("billing", report)

    def test_summary_with_billing(self):
        report = build_idp_usage_report(days=30, include_billing=True)
        self.assertIn("billing", report)
        self.assertEqual(report["billing"]["input_tokens"], 5000)
        self.assertEqual(report["billing"]["output_tokens"], 1000)


class IdpUsageViewGatingTests(TestCase):
    def setUp(self):
        from apps.accounts.models import User

        self.factory = APIRequestFactory()
        self.client_admin = User.objects.create_user(
            email="client-admin@example.com",
            password="pass",
            is_staff=False,
            is_superuser=False,
        )
        # Grant app-level admin without staff flag.
        from apps.accounts.models import UserGroup, UserGroupMembership

        group, _ = UserGroup.objects.get_or_create(
            name=UserGroup.ADMIN_GROUP_NAME,
            defaults={"is_active": True},
        )
        UserGroupMembership.objects.get_or_create(user=self.client_admin, group=group)

        self.staff = User.objects.create_user(
            email="ops@example.com",
            password="pass",
            is_staff=True,
            is_superuser=False,
        )
        IdpUsageDaily.objects.create(
            date=timezone.localdate(),
            claude_docs=3,
            input_tokens=100,
            output_tokens=20,
            estimated_cost_usd=Decimal("0.001"),
        )

    def test_client_admin_does_not_see_billing(self):
        request = self.factory.get("/documents/settings/idp-usage/")
        force_authenticate(request, user=self.client_admin)
        response = IdpUsageView.as_view()(request)
        self.assertEqual(response.status_code, 200)
        self.assertNotIn("billing", response.data)
        self.assertIn("summary", response.data)

    def test_staff_sees_billing(self):
        request = self.factory.get("/documents/settings/idp-usage/")
        force_authenticate(request, user=self.staff)
        response = IdpUsageView.as_view()(request)
        self.assertEqual(response.status_code, 200)
        self.assertIn("billing", response.data)
        self.assertEqual(response.data["billing"]["input_tokens"], 100)
