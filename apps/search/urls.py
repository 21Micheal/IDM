from django.urls import path
from .views import DocumentSearchView
urlpatterns = [path("", DocumentSearchView.as_view(), name="document-search")]
