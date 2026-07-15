"""
Read-only runtime smoke check.

Validates that the live stack actually works against the configured backends —
most useful right after `migrate` on a native-Windows / MS SQL Server install,
where the schema (MySQL-developed) and a few query patterns meet SQL Server for
the first time. Touches: DB connection + vendor, representative ORM queries
(including the cross-DB JSON personal-tag filter and the analytics datetime
arithmetic), a DISTINCT+ORDER BY query, and the cache (Redis/Memurai).

    python manage.py smoke_check

Exits non-zero if any check fails, so it can gate a deploy script.
"""
from django.core.management.base import BaseCommand


class Command(BaseCommand):
    help = "Validate the live stack (DB, key queries, cache). Read-only."

    def handle(self, *args, **options):
        failures = 0

        def check(name, fn):
            nonlocal failures
            try:
                detail = fn()
                self.stdout.write(self.style.SUCCESS(f"[ OK ] {name}: {detail}"))
            except Exception as exc:  # noqa: BLE001 - report every failure, keep going
                failures += 1
                self.stdout.write(self.style.ERROR(f"[FAIL] {name}: {type(exc).__name__}: {exc}"))

        def database():
            from django.db import connection
            connection.ensure_connection()
            return f"connected (vendor={connection.vendor})"

        def model_counts():
            from apps.accounts.models import User
            from apps.documents.models import Document
            return f"users={User.objects.count()} documents={Document.objects.count()}"

        def json_personal_tag_filter():
            # Exercises the cross-DB personal-tag path (JSON containment on
            # MySQL/Postgres; Python membership on SQL Server).
            from apps.documents.models import Document
            from apps.documents.filters import DocumentFilter
            qs = DocumentFilter().filter_personal_tag(
                Document.objects.all(), "personal_tag", "smoke-check-nonexistent"
            )
            return f"matched={qs.count()}"

        def distinct_ordered_query():
            from apps.documents.models import Document
            rows = list(
                Document.objects.filter(deleted_at__isnull=True)
                .order_by("-created_at")
                .distinct()[:5]
            )
            return f"returned {len(rows)} row(s)"

        def analytics_datetime_math():
            # The duration expression does (acted_at - created_at) arithmetic —
            # the most backend-sensitive query in the analytics path.
            from apps.workflows.models import WorkflowTask
            from apps.documents.analytics import duration_hours_expr
            rows = list(
                WorkflowTask.objects.annotate(_d=duration_hours_expr())
                .values_list("_d", flat=True)[:5]
            )
            return f"evaluated {len(rows)} row(s)"

        def cache_roundtrip():
            from django.core.cache import cache
            cache.set("smoke_check_probe", "ok", 10)
            value = cache.get("smoke_check_probe")
            if value != "ok":
                raise RuntimeError(f"unexpected cache value: {value!r}")
            cache.delete("smoke_check_probe")
            return "set/get/delete ok"

        def search_backend():
            from django.conf import settings
            enabled = getattr(settings, "ELASTICSEARCH_ENABLED", True)
            return "elasticsearch" if enabled else "database fallback"

        check("Database connection", database)
        check("Model counts", model_counts)
        check("Personal-tag filter (JSON path)", json_personal_tag_filter)
        check("DISTINCT + ORDER BY", distinct_ordered_query)
        check("Analytics datetime math", analytics_datetime_math)
        check("Cache (Redis/Memurai)", cache_roundtrip)
        check("Search backend", search_backend)

        if failures:
            self.stderr.write(self.style.ERROR(f"\n{failures} check(s) FAILED."))
            raise SystemExit(1)
        self.stdout.write(self.style.SUCCESS("\nAll checks passed."))
