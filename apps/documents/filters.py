"""
apps/documents/filters.py

Changes from previous version
──────────────────────────────
Added is_self_upload BooleanFilter so clients can request only personal
docs (is_self_upload=true) or only workflow docs (is_self_upload=false).
"""
import django_filters
from django.db import models
from .models import Document, DocumentStatus


class DocumentFilter(django_filters.FilterSet):
    status        = django_filters.CharFilter(method="filter_status")
    document_type = django_filters.UUIDFilter(field_name="document_type__id")
    supplier      = django_filters.CharFilter(lookup_expr="icontains")
    date_from     = django_filters.DateFilter(field_name="document_date", lookup_expr="gte")
    date_to       = django_filters.DateFilter(field_name="document_date", lookup_expr="lte")
    created_from  = django_filters.DateFilter(field_name="created_at", lookup_expr="date__gte")
    created_to    = django_filters.DateFilter(field_name="created_at", lookup_expr="date__lte")
    updated_from  = django_filters.DateFilter(field_name="updated_at", lookup_expr="date__gte")
    updated_to    = django_filters.DateFilter(field_name="updated_at", lookup_expr="date__lte")
    approved_from = django_filters.DateFilter(field_name="workflow_instance__completed_at", lookup_expr="date__gte")
    approved_to   = django_filters.DateFilter(field_name="workflow_instance__completed_at", lookup_expr="date__lte")
    amount_min    = django_filters.NumberFilter(field_name="amount", lookup_expr="gte")
    amount_max    = django_filters.NumberFilter(field_name="amount", lookup_expr="lte")
    tags          = django_filters.UUIDFilter(field_name="tags__id")
    department    = django_filters.UUIDFilter(field_name="department__id")
    reference     = django_filters.CharFilter(field_name="reference_number", lookup_expr="icontains")
    is_self_upload = django_filters.BooleanFilter()   # ← new: ?is_self_upload=true/false
    personal_tag  = django_filters.CharFilter(method="filter_personal_tag")

    class Meta:
        model  = Document
        fields = [
            "status", "document_type", "supplier", "date_from", "date_to",
            "created_from", "created_to", "updated_from", "updated_to", "approved_from", "approved_to",
            "amount_min", "amount_max", "tags", "personal_tag", "department", "reference",
            "is_self_upload",
        ]

    def filter_personal_tag(self, queryset, name, value):
        value = (value or "").strip()
        if not value:
            return queryset
        return queryset.filter(is_self_upload=True, metadata__personal_tags__contains=[value])

    def filter_status(self, queryset, name, value):
        values = [item.strip() for item in str(value).split(",") if item.strip()]
        if not values:
            return queryset

        active_task_statuses = ["pending", "in_progress", "held", "returned"]
        combined = models.Q()

        for status in values:
            if status in (DocumentStatus.PENDING_APPROVAL, DocumentStatus.PENDING_REVIEW):
                combined |= models.Q(status=status)
                combined |= models.Q(workflow_instance__tasks__status__in=active_task_statuses)
            else:
                combined |= models.Q(status=status)

        return queryset.filter(combined).distinct()
