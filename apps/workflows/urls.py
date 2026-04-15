from rest_framework.routers import DefaultRouter
from .views import (
    WorkflowTemplateViewSet, WorkflowRuleViewSet,
    WorkflowInstanceViewSet, WorkflowTaskViewSet,
)

router = DefaultRouter()
router.register(r"templates", WorkflowTemplateViewSet, basename="workflow-template")
router.register(r"rules",     WorkflowRuleViewSet,     basename="workflow-rule")
router.register(r"instances", WorkflowInstanceViewSet, basename="workflow-instance")
router.register(r"tasks",     WorkflowTaskViewSet,     basename="workflow-task")

urlpatterns = router.urls
