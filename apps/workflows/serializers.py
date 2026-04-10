from rest_framework import serializers
from .models import WorkflowTemplate, WorkflowStep, WorkflowInstance, WorkflowTask
from apps.accounts.serializers import UserSummarySerializer

class WorkflowStepSerializer(serializers.ModelSerializer):
    class Meta:
        model = WorkflowStep
        fields = ["id","name","order","approver_type","approver_role","sla_hours","allow_resubmit"]

class WorkflowTemplateSerializer(serializers.ModelSerializer):
    steps = WorkflowStepSerializer(many=True, read_only=True)
    class Meta:
        model = WorkflowTemplate
        fields = ["id","name","description","is_active","steps","created_at"]

class WorkflowTaskSerializer(serializers.ModelSerializer):
    step = WorkflowStepSerializer(read_only=True)
    assigned_to = UserSummarySerializer(read_only=True)
    document_title = serializers.CharField(source="workflow_instance.document.title", read_only=True)
    document_ref = serializers.CharField(source="workflow_instance.document.reference_number", read_only=True)
    document_id = serializers.CharField(source="workflow_instance.document.id", read_only=True)

    class Meta:
        model = WorkflowTask
        fields = ["id","step","assigned_to","status","comment","due_at","acted_at",
                  "document_title","document_ref","document_id"]

class WorkflowInstanceSerializer(serializers.ModelSerializer):
    tasks = WorkflowTaskSerializer(many=True, read_only=True)
    started_by = UserSummarySerializer(read_only=True)
    class Meta:
        model = WorkflowInstance
        fields = ["id","document","template","status","current_step_order",
                  "started_by","started_at","completed_at","tasks"]
