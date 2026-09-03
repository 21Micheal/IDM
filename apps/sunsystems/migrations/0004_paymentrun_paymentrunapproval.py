import uuid

import django.db.models.deletion
from django.conf import settings
from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("sunsystems", "0003_multi_stage_posting"),
        migrations.swappable_dependency(settings.AUTH_USER_MODEL),
    ]

    operations = [
        migrations.CreateModel(
            name="PaymentRun",
            fields=[
                ("id", models.UUIDField(default=uuid.uuid4, editable=False, primary_key=True, serialize=False)),
                ("payment_reference", models.CharField(db_index=True, max_length=32, unique=True)),
                ("reference_prefix", models.CharField(default="MNFN", max_length=12)),
                ("run_date", models.DateField(db_index=True)),
                ("daily_sequence", models.PositiveIntegerField()),
                ("business_unit", models.CharField(blank=True, max_length=64)),
                ("budget_code", models.CharField(blank=True, max_length=64)),
                (
                    "status",
                    models.CharField(
                        choices=[
                            ("pending_approval", "Pending approval"),
                            ("approved", "Approved"),
                            ("processing", "Processing"),
                            ("paid", "Paid"),
                            ("failed", "Failed"),
                        ],
                        db_index=True,
                        default="pending_approval",
                        max_length=24,
                    ),
                ),
                ("required_approvals", models.PositiveSmallIntegerField(default=2)),
                ("line_count", models.PositiveIntegerField(default=0)),
                ("total_amount", models.DecimalField(decimal_places=3, default=0, max_digits=18)),
                ("currency_codes", models.JSONField(blank=True, default=list)),
                ("lines", models.JSONField(blank=True, default=list)),
                ("component", models.CharField(blank=True, default="PaymentRun", max_length=64)),
                ("method", models.CharField(blank=True, default="Process", max_length=64)),
                ("bank_details_code", models.CharField(blank=True, default="52100", max_length=64)),
                ("discount_account_credit", models.CharField(blank=True, default="999", max_length=64)),
                ("profile_code", models.CharField(blank=True, default="BANK", max_length=64)),
                ("document_format_code", models.CharField(blank=True, default="AGP1", max_length=64)),
                ("request_xml", models.TextField(blank=True)),
                ("response_xml", models.TextField(blank=True)),
                ("error", models.TextField(blank=True)),
                ("submitted_at", models.DateTimeField(auto_now_add=True)),
                ("updated_at", models.DateTimeField(auto_now=True)),
                ("processed_at", models.DateTimeField(blank=True, null=True)),
                (
                    "processed_by",
                    models.ForeignKey(
                        blank=True,
                        null=True,
                        on_delete=django.db.models.deletion.SET_NULL,
                        related_name="payment_runs_processed",
                        to=settings.AUTH_USER_MODEL,
                    ),
                ),
                (
                    "submitted_by",
                    models.ForeignKey(
                        blank=True,
                        null=True,
                        on_delete=django.db.models.deletion.SET_NULL,
                        related_name="payment_runs_submitted",
                        to=settings.AUTH_USER_MODEL,
                    ),
                ),
            ],
            options={
                "ordering": ["-submitted_at"],
                "indexes": [
                    models.Index(fields=["status", "submitted_at"], name="sunsystems__status_ee32e3_idx"),
                ],
                "unique_together": {("run_date", "daily_sequence", "reference_prefix")},
            },
        ),
        migrations.CreateModel(
            name="PaymentRunApproval",
            fields=[
                ("id", models.UUIDField(default=uuid.uuid4, editable=False, primary_key=True, serialize=False)),
                ("stage", models.PositiveSmallIntegerField()),
                ("approved_at", models.DateTimeField(auto_now_add=True)),
                ("note", models.TextField(blank=True)),
                (
                    "approved_by",
                    models.ForeignKey(
                        blank=True,
                        null=True,
                        on_delete=django.db.models.deletion.SET_NULL,
                        related_name="payment_run_approvals",
                        to=settings.AUTH_USER_MODEL,
                    ),
                ),
                (
                    "payment_run",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="approvals",
                        to="sunsystems.paymentrun",
                    ),
                ),
            ],
            options={
                "ordering": ["stage", "approved_at"],
                "unique_together": {("payment_run", "approved_by")},
            },
        ),
    ]
