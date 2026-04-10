from rest_framework.routers import DefaultRouter
from .views import DocumentViewSet, DocumentTypeViewSet, TagViewSet

router = DefaultRouter()
router.register(r"", DocumentViewSet, basename="document")
router.register(r"types", DocumentTypeViewSet, basename="document-type")
router.register(r"tags", TagViewSet, basename="tag")

urlpatterns = router.urls
