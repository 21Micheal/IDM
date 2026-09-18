from django.contrib import admin

from apps.billing.models import APIUsageSnapshot, ClientDeployment


@admin.register(ClientDeployment)
class ClientDeploymentAdmin(admin.ModelAdmin):
    list_display = ("client_name", "api_key_id", "monthly_limit_usd", "is_active", "last_alert_sent_at", "updated_at")
    list_filter = ("is_active",)
    search_fields = ("client_name", "api_key_id", "workspace_id")
    readonly_fields = ("last_alert_sent_at", "created_at", "updated_at")


@admin.register(APIUsageSnapshot)
class APIUsageSnapshotAdmin(admin.ModelAdmin):
    list_display = (
        "date",
        "client_name",
        "input_tokens",
        "output_tokens",
        "cost_usd",
        "cost_is_estimated",
        "fetched_at",
    )
    list_filter = ("cost_is_estimated", "date")
    search_fields = ("client_name", "api_key_id")
