"""
Flaxem ops control plane for Anthropic usage across client keys.

Lives on the Flaxem ops deployment (or any install with ANTHROPIC_ADMIN_KEY).
Client admins never see these models — staff/superuser only.
"""
from __future__ import annotations

import uuid

from django.db import models


class ClientDeployment(models.Model):
    """
    Maps an Anthropic API key (and optional workspace) to a Flaxem client name.

    Does not store the secret key — only Anthropic's public api_key_id used by
    the Admin Usage API for grouping. Per-deployment IDM still holds the
    workspace key used for OCR.
    """

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    client_name = models.CharField(max_length=200)
    api_key_id = models.CharField(
        max_length=100,
        unique=True,
        help_text="Anthropic Console API key id (apikey_…), used to group Usage API rows.",
    )
    workspace_id = models.CharField(
        max_length=100,
        blank=True,
        default="",
        help_text="Optional Anthropic workspace id (wrkspc_…) for Cost API attribution.",
    )
    monthly_limit_usd = models.DecimalField(
        max_digits=10,
        decimal_places=2,
        default=0,
        help_text="Reference monthly spend cap for alerts. Hard stop remains Anthropic workspace limits.",
    )
    alert_email = models.EmailField(
        blank=True,
        default="",
        help_text="Override recipient for 90% spend alerts. Empty → FLAXEM_OPS_ALERT_EMAIL.",
    )
    is_active = models.BooleanField(default=True)
    notes = models.TextField(blank=True, default="")
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["client_name"]

    def __str__(self) -> str:
        return self.client_name


class APIUsageSnapshot(models.Model):
    """Daily Anthropic usage/cost snapshot per client API key (Celery Beat)."""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    api_key_id = models.CharField(max_length=100, db_index=True)
    client_name = models.CharField(max_length=200)
    date = models.DateField(db_index=True)

    input_tokens = models.BigIntegerField(default=0)
    output_tokens = models.BigIntegerField(default=0)
    cache_read_tokens = models.BigIntegerField(default=0)
    cache_write_tokens = models.BigIntegerField(default=0)

    # Official cost from Anthropic Cost API when available; else token estimate.
    cost_usd = models.DecimalField(max_digits=12, decimal_places=6, default=0)
    cost_is_estimated = models.BooleanField(
        default=False,
        help_text="True when cost_usd was estimated from tokens rather than Cost API.",
    )

    fetched_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["-date", "client_name"]
        constraints = [
            models.UniqueConstraint(
                fields=["api_key_id", "date"],
                name="billing_apiusagesnapshot_key_date_uniq",
            ),
        ]

    def __str__(self) -> str:
        return f"{self.client_name} {self.date}"
