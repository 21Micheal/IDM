from django.conf import settings
from django.core.cache import cache
from django.db.models import Count, Sum
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

_CACHE_KEY = "storage_stats_v2"
_CACHE_TTL = 300  # 5 minutes — the figure barely moves between dashboard loads


def _compute_storage_stats() -> dict:
    """Actual document storage, summed from the DB (fast, exact).

    Each Document.file (current file) and DocumentVersion.file (historical
    versions) is a distinct file on disk — different upload paths — so summing
    both file_size columns reflects real usage without double counting.
    Derived/regenerable files (previews) are intentionally excluded.
    """
    from .models import Document, DocumentVersion

    doc_agg = Document.objects.aggregate(bytes=Sum("file_size"), count=Count("id"))
    version_bytes = DocumentVersion.objects.aggregate(bytes=Sum("file_size"))["bytes"] or 0

    document_bytes = doc_agg["bytes"] or 0
    document_count = doc_agg["count"] or 0
    used_bytes = int(document_bytes) + int(version_bytes)

    quota_gb = int(getattr(settings, "STORAGE_QUOTA_GB", 50))
    quota_bytes = quota_gb * (1024 ** 3)
    percentage = round((used_bytes / quota_bytes) * 100, 1) if quota_bytes else 0

    return {
        "used_bytes": used_bytes,
        "document_count": document_count,
        "version_bytes": int(version_bytes),
        "quota_bytes": quota_bytes,
        "percentage": percentage,
        # Convenience units. NOTE: the denominator is the soft quota, not the
        # physical disk — total_* mirror quota_* so existing UI keeps working.
        "used_gb": round(used_bytes / (1024 ** 3), 3),
        "used_mb": round(used_bytes / (1024 ** 2), 1),
        "total_bytes": quota_bytes,
        "total_gb": round(quota_bytes / (1024 ** 3), 1),
        "total_mb": round(quota_bytes / (1024 ** 2), 1),
    }


class StorageStatsView(APIView):
    permission_classes = [IsAuthenticated]

    def get(self, request):
        stats = cache.get(_CACHE_KEY)
        if stats is None:
            stats = _compute_storage_stats()
            cache.set(_CACHE_KEY, stats, _CACHE_TTL)
        return Response(stats)
