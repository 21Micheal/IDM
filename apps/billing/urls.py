from django.urls import path

from apps.billing.views import (
    BillingSyncView,
    BillingUsageView,
    ClientDeploymentDetailView,
    ClientDeploymentListCreateView,
    DiscoveredKeysView,
    ImportDiscoveredKeysView,
)

urlpatterns = [
    path("usage/", BillingUsageView.as_view(), name="billing-usage"),
    path("sync/", BillingSyncView.as_view(), name="billing-sync"),
    path("discovered-keys/", DiscoveredKeysView.as_view(), name="billing-discovered-keys"),
    path("import-keys/", ImportDiscoveredKeysView.as_view(), name="billing-import-keys"),
    path("clients/", ClientDeploymentListCreateView.as_view(), name="billing-clients"),
    path(
        "clients/<uuid:pk>/",
        ClientDeploymentDetailView.as_view(),
        name="billing-client-detail",
    ),
]
