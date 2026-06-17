"""
Shared analytics plumbing + executive-overview endpoints.

All /analytics/ endpoints accept the same query params:

    months         3 | 6 | 12 (default 12) — reporting window ending now
    department     Department UUID — limits to documents of that department
    document_type  DocumentType UUID — limits to that type

Org analytics deliberately exclude noise: personal/self-upload documents,
trashed documents, and hidden system types (bulk UNCLASS, signature SIGREQ).
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta

from django.db import models
from django.db.models import Avg, Count, Q
from django.utils import timezone
from rest_framework import permissions
from rest_framework.response import Response
from rest_framework.views import APIView

from .models import (
    Document, DocumentStatus,
    SIGNATURE_REQUEST_DOCUMENT_TYPE_CODE,
)

SYSTEM_DOC_TYPE_CODES = ("UNCLASS", SIGNATURE_REQUEST_DOCUMENT_TYPE_CODE)


# ── Access ──────────────────────────────────────────────────────────────────────

class IsAnalyticsViewer(permissions.BasePermission):
    """Admins, plus active members of the built-in HOD group (department heads)."""

    def has_permission(self, request, view):
        user = request.user
        if not user or not user.is_authenticated:
            return False
        if user.has_admin_access:
            return True
        from apps.accounts.models import UserGroup
        now = timezone.now()
        return user.group_memberships.filter(
            group__is_active=True,
            group__name=UserGroup.HOD_GROUP_NAME,
        ).filter(
            Q(expires_at__isnull=True) | Q(expires_at__gt=now)
        ).exists()


# ── Filters ─────────────────────────────────────────────────────────────────────

@dataclass
class AnalyticsFilters:
    months: int
    start: datetime          # start of the current reporting window
    end: datetime            # now
    prev_start: datetime     # start of the equally long previous window
    department_id: str | None
    document_type_id: str | None


def parse_analytics_filters(request) -> AnalyticsFilters:
    try:
        months = int(request.query_params.get("months", 12))
    except (TypeError, ValueError):
        months = 12
    if months not in (3, 6, 12):
        months = 12

    end = timezone.now()
    # Window starts at the 1st of the month, `months` months back (inclusive of
    # the current partial month), so the chart axis is whole months.
    anchor = end.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
    start = _shift_months(anchor, -(months - 1))
    prev_start = _shift_months(start, -months)

    return AnalyticsFilters(
        months=months,
        start=start,
        end=end,
        prev_start=prev_start,
        department_id=request.query_params.get("department") or None,
        document_type_id=request.query_params.get("document_type") or None,
    )


def _shift_months(dt: datetime, delta: int) -> datetime:
    total = dt.year * 12 + (dt.month - 1) + delta
    year, month = divmod(total, 12)
    return dt.replace(year=year, month=month + 1)


def org_documents_qs(filters: AnalyticsFilters):
    """Documents that count for org analytics (no personal/system/trashed)."""
    qs = (
        Document.objects
        .filter(deleted_at__isnull=True, is_self_upload=False)
        .exclude(document_type__code__in=SYSTEM_DOC_TYPE_CODES)
        .exclude(document_type__is_personal_type=True)
    )
    if filters.department_id:
        qs = qs.filter(department_id=filters.department_id)
    if filters.document_type_id:
        qs = qs.filter(document_type_id=filters.document_type_id)
    return qs


def org_tasks_qs(filters: AnalyticsFilters):
    """Completed workflow tasks scoped by the same document filters."""
    from apps.workflows.models import WorkflowTask
    qs = (
        WorkflowTask.objects
        .filter(status__in=["approved", "rejected"], acted_at__isnull=False)
        .filter(workflow_instance__document__deleted_at__isnull=True)
        .exclude(workflow_instance__document__document_type__code__in=SYSTEM_DOC_TYPE_CODES)
    )
    if filters.department_id:
        qs = qs.filter(workflow_instance__document__department_id=filters.department_id)
    if filters.document_type_id:
        qs = qs.filter(workflow_instance__document__document_type_id=filters.document_type_id)
    return qs


# ── Month axis helpers ──────────────────────────────────────────────────────────

def month_key(dt: datetime) -> str:
    """Year-safe month bucket label, e.g. "Jan 2026"."""
    return dt.strftime("%b %Y")


def month_axis(filters: AnalyticsFilters) -> list[str]:
    """Continuous list of month labels from window start to now (zero-fill axis)."""
    labels: list[str] = []
    cursor = filters.start
    while cursor <= filters.end:
        labels.append(month_key(cursor))
        cursor = _shift_months(cursor, 1)
    return labels


def duration_hours_expr():
    return models.ExpressionWrapper(
        (models.F("acted_at") - models.F("created_at")) / timedelta(hours=1),
        output_field=models.FloatField(),
    )


def _delta_pct(current: float, previous: float) -> float | None:
    if not previous:
        return None
    return round((current - previous) / previous * 100, 1)


def _metric(current, previous) -> dict:
    return {"current": current, "previous": previous, "delta_pct": _delta_pct(current or 0, previous or 0)}


# ── Endpoints ───────────────────────────────────────────────────────────────────

class AnalyticsOverviewView(APIView):
    """Executive KPI block with previous-period comparisons."""
    permission_classes = [permissions.IsAuthenticated, IsAnalyticsViewer]

    def get(self, request):
        f = parse_analytics_filters(request)
        docs = org_documents_qs(f)

        cur = docs.filter(created_at__gte=f.start)
        prev = docs.filter(created_at__gte=f.prev_start, created_at__lt=f.start)

        def status_count(qs, status):
            return qs.filter(status=status).count()

        uploads_cur, uploads_prev = cur.count(), prev.count()
        approved_cur = status_count(cur, DocumentStatus.APPROVED)
        approved_prev = status_count(prev, DocumentStatus.APPROVED)
        rejected_cur = status_count(cur, DocumentStatus.REJECTED)
        rejected_prev = status_count(prev, DocumentStatus.REJECTED)

        active_uploaders_cur = cur.values("uploaded_by_id").distinct().count()
        active_uploaders_prev = prev.values("uploaded_by_id").distinct().count()

        # Backlog is a point-in-time figure (no previous comparison).
        pending_now = docs.filter(status=DocumentStatus.PENDING_APPROVAL).count()

        tasks = org_tasks_qs(f).annotate(duration_hours=duration_hours_expr())
        t_cur = tasks.filter(acted_at__gte=f.start)
        t_prev = tasks.filter(acted_at__gte=f.prev_start, acted_at__lt=f.start)

        def turnaround(qs):
            v = qs.aggregate(avg=Avg("duration_hours"))["avg"]
            return round(v, 1) if v is not None else None

        def sla_compliance(qs):
            agg = qs.aggregate(
                total=Count("id"),
                breached=Count("id", filter=Q(duration_hours__gt=models.F("step__sla_hours"))),
            )
            if not agg["total"]:
                return None
            return round((1 - agg["breached"] / agg["total"]) * 100, 1)

        return Response({
            "period": {"months": f.months, "start": f.start.isoformat(), "end": f.end.isoformat()},
            "documents": _metric(uploads_cur, uploads_prev),
            "approved": _metric(approved_cur, approved_prev),
            "rejected": _metric(rejected_cur, rejected_prev),
            "pending_now": pending_now,
            "avg_turnaround_hours": _metric(turnaround(t_cur), turnaround(t_prev)),
            "sla_compliance": _metric(sla_compliance(t_cur), sla_compliance(t_prev)),
            "active_uploaders": _metric(active_uploaders_cur, active_uploaders_prev),
        })


class StatusDistributionView(APIView):
    """Document counts by status for the selected window (donut chart)."""
    permission_classes = [permissions.IsAuthenticated, IsAnalyticsViewer]

    def get(self, request):
        f = parse_analytics_filters(request)
        rows = (
            org_documents_qs(f)
            .filter(created_at__gte=f.start)
            .values("status")
            .annotate(count=Count("id"))
            .order_by("-count")
        )
        labels = dict(DocumentStatus.choices)
        return Response([
            {
                "status": r["status"],
                "label": labels.get(r["status"], (r["status"] or "Unknown").replace("_", " ").title()),
                "count": r["count"],
            }
            for r in rows
        ])


class DepartmentActivityView(APIView):
    """Upload/approval activity per department for the selected window."""
    permission_classes = [permissions.IsAuthenticated, IsAnalyticsViewer]

    def get(self, request):
        f = parse_analytics_filters(request)
        rows = (
            org_documents_qs(f)
            .filter(created_at__gte=f.start)
            .values(dept=models.F("department__name"))
            .annotate(
                uploads=Count("id"),
                approved=Count("id", filter=Q(status=DocumentStatus.APPROVED)),
                pending=Count("id", filter=Q(status=DocumentStatus.PENDING_APPROVAL)),
                rejected=Count("id", filter=Q(status=DocumentStatus.REJECTED)),
            )
            .order_by("-uploads")
        )
        return Response([
            {
                "department": r["dept"] or "Unassigned",
                "uploads": r["uploads"],
                "approved": r["approved"],
                "pending": r["pending"],
                "rejected": r["rejected"],
            }
            for r in rows
        ])
