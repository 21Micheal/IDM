from rest_framework.routers import DefaultRouter
from .views import DocumentViewSet, DocumentTypeViewSet

router = DefaultRouter()
# 'types' MUST be registered before the catch-all empty prefix ("").
# If DocumentViewSet is registered first on "", the router treats
# /documents/types/ as a document pk lookup and returns 404/405.
router.register(r"types", DocumentTypeViewSet, basename="document-type")
router.register(r"", DocumentViewSet, basename="document")
# router.register(r"tags", TagViewSet, basename="tag")

urlpatterns = router.urls