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
    One SunSystems journal (Ledger Import) posting for a form document.

    There is **at most one** posting row per document (``OneToOne``) so the
    workflow-completion hook is idempotent: once a document is ``POSTED`` it is
    never posted again, and a ``FAILED`` row can be retried in place. The full
    request/response XML is retained for audit and troubleshooting, and the
    returned ``journal_number`` is the link back to the SunSystems ledger.

    The mapping that produced the journal lives on the template/document, not
    here; this row is the *result log* of applying it.
    """

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)

    document = models.OneToOneField(
        "documents.Document",
        on_delete=models.CASCADE,
        related_name="journal_posting",
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
        ordering = ["-created_at"]
        indexes = [
            models.Index(fields=["status", "created_at"]),
        ]

    def __str__(self):
        return f"JournalPosting {self.document_id} ({self.status})"


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
