from django.urls import path

from .views import (
    AmendMarkerView,
    BudgetCheckView,
    JournalPostingDetailView,
    JournalPostingRetryView,
    JournalPreviewView,
    PaymentRunView,
    SunSystemsConnectionView,
    SunSystemsTestConnectionView,
)

urlpatterns = [
    path("budget-check/", BudgetCheckView.as_view(), name="sunsystems-budget-check"),
    path("journal-preview/", JournalPreviewView.as_view(), name="sunsystems-journal-preview"),
    path("payment-run/", PaymentRunView.as_view(), name="sunsystems-payment-run"),
    path("amend-markers/", AmendMarkerView.as_view(), name="sunsystems-amend-markers"),
    path("connection/", SunSystemsConnectionView.as_view(), name="sunsystems-connection"),
    path("connection/test/", SunSystemsTestConnectionView.as_view(), name="sunsystems-connection-test"),
    path("postings/<uuid:document_id>/", JournalPostingDetailView.as_view(), name="sunsystems-posting-detail"),
    path("postings/<uuid:document_id>/retry/", JournalPostingRetryView.as_view(), name="sunsystems-posting-retry"),
]
