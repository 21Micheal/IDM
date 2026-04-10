from rest_framework.routers import DefaultRouter
from .services import WorkflowTemplateViewSet, WorkflowInstanceViewSet, WorkflowTaskViewSet
router = DefaultRouter()
router.register(r"templates", WorkflowTemplateViewSet, basename="workflow-template")
router.register(r"instances", WorkflowInstanceViewSet, basename="workflow-instance")
router.register(r"tasks", WorkflowTaskViewSet, basename="workflow-task")
urlpatterns = router.urls
