from django.urls import path
from .views import AuditLogListView, MyActivityListView

urlpatterns = [
    path("", AuditLogListView.as_view(), name="audit-log-list"),
    path("my-activity/", MyActivityListView.as_view(), name="my-activity-list"),
]
