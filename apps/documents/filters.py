import django_filters
from .models import Document, DocumentStatus


class DocumentFilter(django_filters.FilterSet):
    status = django_filters.MultipleChoiceFilter(choices=DocumentStatus.choices)
    document_type = django_filters.UUIDFilter(field_name="document_type__id")
    supplier = django_filters.CharFilter(lookup_expr="icontains")
    date_from = django_filters.DateFilter(field_name="document_date", lookup_expr="gte")
    date_to = django_filters.DateFilter(field_name="document_date", lookup_expr="lte")
    amount_min = django_filters.NumberFilter(field_name="amount", lookup_expr="gte")
    amount_max = django_filters.NumberFilter(field_name="amount", lookup_expr="lte")
    tags = django_filters.UUIDFilter(field_name="tags__id")
    department = django_filters.UUIDFilter(field_name="department__id")
    reference = django_filters.CharFilter(field_name="reference_number", lookup_expr="icontains")

    class Meta:
        model = Document
        fields = [
            "status", "document_type", "supplier", "date_from", "date_to",
            "amount_min", "amount_max", "tags", "department", "reference",
        ]
