import os
import shutil

from django.conf import settings
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView


def _directory_size_bytes(root_path: str) -> int:
    total = 0
    if not root_path or not os.path.exists(root_path):
        return total

    for current_root, _, files in os.walk(root_path):
        for name in files:
            path = os.path.join(current_root, name)
            try:
                total += os.path.getsize(path)
            except OSError:
                continue
    return total


class StorageStatsView(APIView):
    permission_classes = [IsAuthenticated]

    def get(self, request):
        media_root = str(settings.MEDIA_ROOT)
        used_bytes = _directory_size_bytes(media_root)

        try:
            disk_stats = shutil.disk_usage(media_root)
            total_bytes = disk_stats.total
        except OSError:
            total_bytes = used_bytes

        percentage = round((used_bytes / total_bytes) * 100) if total_bytes else 0

        return Response({
            "used_bytes": used_bytes,
            "total_bytes": total_bytes,
            "used_gb": round(used_bytes / (1024 ** 3), 1),
            "total_gb": round(total_bytes / (1024 ** 3), 1) if total_bytes else 0,
            "percentage": percentage,
        })
