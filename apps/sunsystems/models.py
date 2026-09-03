from django.conf import settings
from django.db import models
import uuid


class JournalPostingStatus(models.TextChoices):
    """Lifecycle of a single document → SunSystems journal posting."""
    PENDING   = "pending",   "Pending"        # queued, not yet attempted
    POSTING   = "posting",   "Posting"        # in flight
    POSTED    = "posted",    "Posted"         # SunSystems accepted the journal
    FAILED    = "failed",    "Failed"         # attempt(s) failed; retryable
    SKIPPED   = "skipped",   "Skipped"        # mapping disabled / no mapping


class JournalPosting(models.Model):
    """
    One SunSystems posting (Ledger Import or PurchaseOrder) for a form document.

    A document may have **multiple** posting rows — one per stage (e.g. stage 1 =
    advance journal, stage 2 = retirement reconciliation). The ``(document, stage)``
    pair is unique, so the workflow-completion hook is idempotent: once a stage is
    ``POSTED`` it is never re-posted, and a ``FAILED`` row can be retried in place.
    The full request/response XML is retained for audit and troubleshooting.

    The mapping that produced the posting lives on the template/document, not here;
    this row is the *result log* of applying it.
    """

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)

    document = models.ForeignKey(
        "documents.Document",
        on_delete=models.CASCADE,
        related_name="journal_postings",
    )
    stage = models.PositiveSmallIntegerField(
        default=1,
        help_text="Posting stage number (1 = advance / first approval, 2 = retirement, …).",
    )
    stage_label = models.CharField(
        max_length=64, blank=True,
        help_text="Human-readable stage name from the mapping (e.g. 'Advance', 'Retirement').",
    )

    status = models.CharField(
        max_length=20,
        choices=JournalPostingStatus.choices,
        default=JournalPostingStatus.PENDING,
        db_index=True,
    )
    attempts = models.PositiveIntegerField(default=0)

    component = models.CharField(max_length=64, blank=True, default="Journal")
    method = models.CharField(max_length=64, blank=True, default="Import")
    business_unit = models.CharField(max_length=64, blank=True)

    # The result that matters to finance users.
    journal_number = models.CharField(max_length=64, blank=True, db_index=True)
    message = models.TextField(blank=True)
    error = models.TextField(blank=True)

    # Retained for audit / re-send. Request is the <SSC> document we built
    # (token-free); response is the raw SunSystems reply.
    request_xml = models.TextField(blank=True)
    response_xml = models.TextField(blank=True)

    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)
    posted_at = models.DateTimeField(null=True, blank=True)
    posted_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        null=True,
        blank=True,
        on_delete=models.SET_NULL,
        related_name="journal_postings",
    )

    class Meta:
        ordering = ["stage", "-created_at"]
        unique_together = [("document", "stage")]
        indexes = [
            models.Index(fields=["status", "created_at"]),
        ]

    def __str__(self):
        return f"JournalPosting {self.document_id} stage={self.stage} ({self.status})"


class PaymentRunStatus(models.TextChoices):
    """Lifecycle for a SunSystems payment-run batch."""

    PENDING_APPROVAL = "pending_approval", "Pending approval"
    APPROVED = "approved", "Approved"
    PROCESSING = "processing", "Processing"
    PAID = "paid", "Paid"
    FAILED = "failed", "Failed"


class PaymentRun(models.Model):
    """A marked batch of ledger lines awaiting approval and final payment."""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    payment_reference = models.CharField(max_length=32, unique=True, db_index=True)
    reference_prefix = models.CharField(max_length=12, default="PAY")
    run_date = models.DateField(db_index=True)
    daily_sequence = models.PositiveIntegerField()

    business_unit = models.CharField(max_length=64, blank=True)
    budget_code = models.CharField(max_length=64, blank=True)
    status = models.CharField(
        max_length=24,
        choices=PaymentRunStatus.choices,
        default=PaymentRunStatus.PENDING_APPROVAL,
        db_index=True,
    )
    required_approvals = models.PositiveSmallIntegerField(default=2)

    line_count = models.PositiveIntegerField(default=0)
    total_amount = models.DecimalField(max_digits=18, decimal_places=3, default=0)
    currency_codes = models.JSONField(default=list, blank=True)
    lines = models.JSONField(default=list, blank=True)

    component = models.CharField(max_length=64, blank=True, default="PaymentRun")
    method = models.CharField(max_length=64, blank=True, default="Process")
    bank_details_code = models.CharField(max_length=64, blank=True, default="52100")
    discount_account_credit = models.CharField(max_length=64, blank=True, default="999")
    profile_code = models.CharField(max_length=64, blank=True, default="BANK")
    document_format_code = models.CharField(max_length=64, blank=True, default="AGP1")

    request_xml = models.TextField(blank=True)
    response_xml = models.TextField(blank=True)
    error = models.TextField(blank=True)

    submitted_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        null=True,
        blank=True,
        on_delete=models.SET_NULL,
        related_name="payment_runs_submitted",
    )
    processed_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        null=True,
        blank=True,
        on_delete=models.SET_NULL,
        related_name="payment_runs_processed",
    )
    submitted_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)
    processed_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        ordering = ["-submitted_at"]
        unique_together = [("run_date", "daily_sequence", "reference_prefix")]
        indexes = [
            models.Index(fields=["status", "submitted_at"]),
        ]

    @property
    def approval_count(self) -> int:
        return self.approvals.count()

    @property
    def is_fully_approved(self) -> bool:
        return self.approval_count >= self.required_approvals

    def __str__(self):
        return f"PaymentRun {self.payment_reference} ({self.status})"


class PaymentRunApproval(models.Model):
    """One approval action for a payment-run batch."""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    payment_run = models.ForeignKey(
        PaymentRun,
        on_delete=models.CASCADE,
        related_name="approvals",
    )
    stage = models.PositiveSmallIntegerField()
    approved_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        null=True,
        blank=True,
        on_delete=models.SET_NULL,
        related_name="payment_run_approvals",
    )
    approved_at = models.DateTimeField(auto_now_add=True)
    note = models.TextField(blank=True)

    class Meta:
        ordering = ["stage", "approved_at"]
        unique_together = [("payment_run", "approved_by")]

    def __str__(self):
        return f"{self.payment_run_id} approval {self.stage}"


class SunSystemsConnection(models.Model):
    """Singleton holding the admin-configured SunSystems Connect connection.

    Stored as a ``connection`` dict (the friendly-key shape SunSystemsConfig
    understands). Blank fields fall back to the ``SUNSYSTEMS_*`` env defaults, so
    an operator can set just the parts that differ. Use :func:`effective_connection`
    to get the resolved connection (env < this row < per-template override).
    """
    singleton = models.BooleanField(default=True, unique=True)
    connection = models.JSONField(default=dict, blank=True)
    updated_at = models.DateTimeField(auto_now=True)
    updated_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, null=True, blank=True,
        on_delete=models.SET_NULL, related_name="+",
    )

    class Meta:
        verbose_name = "SunSystems connection"

    def __str__(self):
        return "SunSystems connection"

    @classmethod
    def get_solo(cls) -> "SunSystemsConnection":
        obj, _ = cls.objects.get_or_create(singleton=True)
        return obj


def stored_connection() -> dict:
    """The admin-saved connection dict (empty when none configured)."""
    try:
        conn = SunSystemsConnection.get_solo().connection
    except Exception:  # pragma: no cover - DB not ready (e.g. during migrate)
        return {}
    return conn if isinstance(conn, dict) else {}


def effective_connection(override: dict | None = None) -> dict:
    """Resolve the connection used for a call.

    Precedence (low → high): env ``SUNSYSTEMS_*`` defaults → the admin-saved
    singleton → an optional per-template ``override``. Non-empty values win.
    """
    from .client import default_connection_from_settings
    from .crypto import decrypt_connection

    merged = default_connection_from_settings()
    # The admin-saved layer holds encrypted secrets; decrypt for actual use.
    for layer in (decrypt_connection(stored_connection()), override or {}):
        for key, value in layer.items():
            if value not in (None, ""):
                merged[key] = value
    return merged
