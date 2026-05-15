from django.urls import path
from .views import AuditLogExportView, AuditLogListView, MyActivityListView

urlpatterns = [
    path("", AuditLogListView.as_view(), name="audit-log-list"),
    path("export/", AuditLogExportView.as_view(), name="audit-log-export"),
    path("my-activity/", MyActivityListView.as_view(), name="my-activity-list"),
]
