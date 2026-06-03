from rest_framework.routers import DefaultRouter
from .views import DocumentTemplateViewSet

router = DefaultRouter()
router.register(r"", DocumentTemplateViewSet, basename="template")
urlpatterns = router.urls