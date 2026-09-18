"""Staff/superuser-only Flaxem ops billing endpoints."""
from __future__ import annotations

from rest_framework import permissions, status
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.billing.models import ClientDeployment
from apps.billing.serializers import ClientDeploymentSerializer
from apps.billing.sync import (
    build_ops_usage_report,
    import_discovered_keys,
    list_discovered_keys,
    sync_usage_for_day,
)


def _is_platform_ops(user) -> bool:
    return bool(user and user.is_authenticated and (user.is_staff or user.is_superuser))


class IsPlatformOps(permissions.BasePermission):
    def has_permission(self, request, view):
        return _is_platform_ops(request.user)


class BillingUsageView(APIView):
    """GET all-clients usage rollup for Flaxem ops."""

    permission_classes = [permissions.IsAuthenticated, IsPlatformOps]

    def get(self, request):
        try:
            days = int(request.query_params.get("days") or 30)
        except (TypeError, ValueError):
            days = 30
        return Response(build_ops_usage_report(days=days))


class BillingSyncView(APIView):
    """POST trigger Anthropic Admin sync (yesterday, or ?date=YYYY-MM-DD)."""

    permission_classes = [permissions.IsAuthenticated, IsPlatformOps]

    def post(self, request):
        from datetime import date

        raw = request.data.get("date") or request.query_params.get("date")
        day = None
        if raw:
            try:
                day = date.fromisoformat(str(raw)[:10])
            except ValueError:
                return Response(
                    {"detail": "Invalid date; use YYYY-MM-DD."},
                    status=status.HTTP_400_BAD_REQUEST,
                )
        result = sync_usage_for_day(day)
        code = status.HTTP_200_OK if result.get("ok") else status.HTTP_400_BAD_REQUEST
        return Response(result, status=code)


class ClientDeploymentListCreateView(APIView):
    permission_classes = [permissions.IsAuthenticated, IsPlatformOps]

    def get(self, request):
        qs = ClientDeployment.objects.all().order_by("client_name")
        return Response(ClientDeploymentSerializer(qs, many=True).data)

    def post(self, request):
        serializer = ClientDeploymentSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        serializer.save()
        return Response(serializer.data, status=status.HTTP_201_CREATED)


class ClientDeploymentDetailView(APIView):
    permission_classes = [permissions.IsAuthenticated, IsPlatformOps]

    def get_object(self, pk):
        return ClientDeployment.objects.filter(pk=pk).first()

    def get(self, request, pk):
        obj = self.get_object(pk)
        if not obj:
            return Response({"detail": "Not found."}, status=status.HTTP_404_NOT_FOUND)
        return Response(ClientDeploymentSerializer(obj).data)

    def patch(self, request, pk):
        obj = self.get_object(pk)
        if not obj:
            return Response({"detail": "Not found."}, status=status.HTTP_404_NOT_FOUND)
        serializer = ClientDeploymentSerializer(obj, data=request.data, partial=True)
        serializer.is_valid(raise_exception=True)
        serializer.save()
        return Response(serializer.data)

    def delete(self, request, pk):
        obj = self.get_object(pk)
        if not obj:
            return Response({"detail": "Not found."}, status=status.HTTP_404_NOT_FOUND)
        obj.delete()
        return Response(status=status.HTTP_204_NO_CONTENT)


class DiscoveredKeysView(APIView):
    """GET Anthropic org API keys; annotate which are already registered in IDM."""

    permission_classes = [permissions.IsAuthenticated, IsPlatformOps]

    def get(self, request):
        return Response(list_discovered_keys())


class ImportDiscoveredKeysView(APIView):
    """
    POST import org keys as ClientDeployment rows.

    Body: { "api_key_ids": ["apikey_…", …], "monthly_limit_usd": "30" }
    Omit api_key_ids (or pass []) to import every unregistered active key.
    """

    permission_classes = [permissions.IsAuthenticated, IsPlatformOps]

    def post(self, request):
        from decimal import Decimal, InvalidOperation

        raw_ids = request.data.get("api_key_ids")
        if raw_ids is None:
            ids = None
        elif isinstance(raw_ids, list):
            ids = [str(x) for x in raw_ids]
        else:
            return Response(
                {"detail": "api_key_ids must be a list."},
                status=status.HTTP_400_BAD_REQUEST,
            )

        limit = None
        if "monthly_limit_usd" in request.data and request.data.get("monthly_limit_usd") not in (None, ""):
            try:
                limit = max(Decimal("0"), Decimal(str(request.data.get("monthly_limit_usd"))))
            except (InvalidOperation, TypeError, ValueError):
                return Response(
                    {"monthly_limit_usd": ["Enter a valid USD amount."]},
                    status=status.HTTP_400_BAD_REQUEST,
                )

        result = import_discovered_keys(api_key_ids=ids, monthly_limit_usd=limit)
        code = status.HTTP_200_OK if result.get("ok") else status.HTTP_400_BAD_REQUEST
        return Response(result, status=code)
