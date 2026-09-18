from decimal import Decimal
from unittest.mock import patch

from django.contrib.auth import get_user_model
from django.test import TestCase
from rest_framework.test import APIRequestFactory, force_authenticate

from apps.billing.anthropic_admin import estimate_cost_usd
from apps.billing.models import APIUsageSnapshot, ClientDeployment
from apps.billing.sync import build_ops_usage_report, sync_usage_for_day
from apps.billing.views import BillingUsageView, ClientDeploymentListCreateView

User = get_user_model()


class EstimateCostTests(TestCase):
    def test_estimate_positive(self):
        cost = estimate_cost_usd(input_tokens=1_000_000, output_tokens=1_000_000)
        self.assertGreater(cost, Decimal("0"))


class SyncUsageTests(TestCase):
    def setUp(self):
        self.dep = ClientDeployment.objects.create(
            client_name="Acme",
            api_key_id="apikey_acme",
            workspace_id="wrkspc_acme",
            monthly_limit_usd=Decimal("10.00"),
        )

    @patch("apps.billing.sync.admin_api_key", return_value="")
    def test_sync_without_admin_key(self, _mock):
        result = sync_usage_for_day()
        self.assertFalse(result["ok"])
        self.assertEqual(APIUsageSnapshot.objects.count(), 0)

    @patch("apps.billing.sync.check_spend_alerts", return_value=0)
    @patch("apps.billing.sync.fetch_cost_by_workspace", return_value={"wrkspc_acme": Decimal("1.50")})
    @patch(
        "apps.billing.sync.fetch_usage_by_api_key",
        return_value={
            "apikey_acme": {
                "input_tokens": 1000,
                "output_tokens": 200,
                "cache_read_tokens": 0,
                "cache_write_tokens": 0,
            }
        },
    )
    @patch("apps.billing.sync.admin_api_key", return_value="sk-ant-admin01-test")
    def test_sync_writes_snapshot(self, *_mocks):
        from datetime import date

        result = sync_usage_for_day(date(2026, 9, 16))
        self.assertTrue(result["ok"])
        self.assertEqual(result["saved"], 1)
        snap = APIUsageSnapshot.objects.get(api_key_id="apikey_acme", date=date(2026, 9, 16))
        self.assertEqual(snap.input_tokens, 1000)
        self.assertEqual(snap.cost_usd, Decimal("1.500000"))
        self.assertFalse(snap.cost_is_estimated)


class OpsReportTests(TestCase):
    def setUp(self):
        from datetime import date

        ClientDeployment.objects.create(
            client_name="Acme",
            api_key_id="apikey_acme",
            monthly_limit_usd=Decimal("10.00"),
        )
        APIUsageSnapshot.objects.create(
            api_key_id="apikey_acme",
            client_name="Acme",
            date=date.today(),
            input_tokens=500,
            output_tokens=50,
            cost_usd=Decimal("9.50"),
        )

    def test_report_includes_alert_near_cap(self):
        report = build_ops_usage_report(days=30)
        self.assertEqual(report["summary"]["clients"], 1)
        self.assertEqual(len(report["alerts"]), 1)
        self.assertEqual(report["clients"][0]["client_name"], "Acme")


class BillingViewGatingTests(TestCase):
    def setUp(self):
        self.factory = APIRequestFactory()
        self.client_admin = User.objects.create_user(
            email="client-admin@example.com",
            password="x",
            first_name="C",
            last_name="A",
            is_staff=False,
            is_superuser=False,
        )
        from apps.accounts.models import UserGroup

        group = UserGroup.ensure_administrators_group(created_by=self.client_admin)
        group.memberships.create(user=self.client_admin)
        self.staff = User.objects.create_user(
            email="ops@flaxem.example",
            password="x",
            first_name="O",
            last_name="P",
            is_staff=True,
            is_superuser=False,
        )

    def test_client_admin_forbidden(self):
        request = self.factory.get("/api/v1/billing/usage/")
        force_authenticate(request, user=self.client_admin)
        response = BillingUsageView.as_view()(request)
        self.assertEqual(response.status_code, 403)

    def test_staff_can_list_clients(self):
        request = self.factory.get("/api/v1/billing/clients/")
        force_authenticate(request, user=self.staff)
        response = ClientDeploymentListCreateView.as_view()(request)
        self.assertEqual(response.status_code, 200)


class DiscoverImportTests(TestCase):
    @patch(
        "apps.billing.sync.fetch_org_api_keys",
        return_value=[
            {
                "id": "apikey_new",
                "name": "Acme Key",
                "workspace_id": "wrkspc_1",
                "status": "active",
                "partial_key_hint": "sk-ant-…AAA",
            },
            {
                "id": "apikey_existing",
                "name": "Already In",
                "workspace_id": "",
                "status": "active",
                "partial_key_hint": "sk-ant-…BBB",
            },
        ],
    )
    @patch("apps.billing.sync.admin_api_key", return_value="sk-ant-admin01-test")
    def test_import_skips_existing(self, *_mocks):
        from apps.billing.sync import import_discovered_keys

        ClientDeployment.objects.create(
            client_name="Already In",
            api_key_id="apikey_existing",
        )
        result = import_discovered_keys(api_key_ids=None, monthly_limit_usd=Decimal("25"))
        self.assertTrue(result["ok"])
        self.assertEqual(result["imported"], 1)
        self.assertEqual(result["skipped"], 1)
        dep = ClientDeployment.objects.get(api_key_id="apikey_new")
        self.assertEqual(dep.client_name, "Acme Key")
        self.assertEqual(dep.monthly_limit_usd, Decimal("25.00"))
        self.assertEqual(dep.workspace_id, "wrkspc_1")


class SpendAlertTests(TestCase):
    """check_spend_alerts sends at most one email per client per calendar month."""

    def setUp(self):
        self.dep = ClientDeployment.objects.create(
            client_name="AlertCo",
            api_key_id="apikey_alert",
            monthly_limit_usd=Decimal("10.00"),
            alert_email="ops@flaxem.example",
        )
        from django.utils import timezone as tz
        # Record spend that puts client at 95% of cap.
        APIUsageSnapshot.objects.create(
            api_key_id="apikey_alert",
            client_name="AlertCo",
            date=tz.now().date(),
            cost_usd=Decimal("9.50"),
        )

    @patch("apps.billing.sync.send_mail")
    def test_first_alert_is_sent_and_stamped(self, mock_send):
        from apps.billing.sync import check_spend_alerts
        sent = check_spend_alerts()
        self.assertEqual(sent, 1)
        mock_send.assert_called_once()
        self.dep.refresh_from_db()
        self.assertIsNotNone(self.dep.last_alert_sent_at)

    @patch("apps.billing.sync.send_mail")
    def test_second_call_this_month_is_suppressed(self, mock_send):
        from django.utils import timezone as tz
        from apps.billing.sync import check_spend_alerts
        # Simulate a previous alert already sent this month.
        self.dep.last_alert_sent_at = tz.now()
        self.dep.save(update_fields=["last_alert_sent_at"])

        sent = check_spend_alerts()
        self.assertEqual(sent, 0)
        mock_send.assert_not_called()


class SyncCostEstimatedTests(TestCase):
    """sync_usage_for_day marks cost_is_estimated=True when Cost API returns nothing."""

    def setUp(self):
        ClientDeployment.objects.create(
            client_name="EstimateCo",
            api_key_id="apikey_est",
        )

    @patch("apps.billing.sync.check_spend_alerts", return_value=0)
    @patch("apps.billing.sync.fetch_cost_by_workspace", return_value={})  # no Cost API data
    @patch(
        "apps.billing.sync.fetch_usage_by_api_key",
        return_value={
            "apikey_est": {
                "input_tokens": 500,
                "output_tokens": 100,
                "cache_read_tokens": 0,
                "cache_write_tokens": 0,
            }
        },
    )
    @patch("apps.billing.sync.admin_api_key", return_value="sk-ant-admin01-test")
    def test_snapshot_marked_estimated(self, *_mocks):
        from datetime import date
        result = sync_usage_for_day(date(2026, 9, 17))
        self.assertTrue(result["ok"])
        snap = APIUsageSnapshot.objects.get(api_key_id="apikey_est", date=date(2026, 9, 17))
        self.assertTrue(snap.cost_is_estimated)
        self.assertGreater(snap.cost_usd, Decimal("0"))
