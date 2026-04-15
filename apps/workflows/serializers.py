"""
apps/workflows/serializers.py
One change from uploaded version:
  step_count is now SerializerMethodField so it works whether the
  queryset is annotated OR falling back to the model @property —
  both return the same value, no N+1 when annotated.
Everything else is identical to your uploaded file.
"""
from rest_framework import serializers
from .models import WorkflowTemplate, WorkflowStep, WorkflowRule, WorkflowInstance, WorkflowTask
from apps.accounts.serializers import UserSummarySerializer


class WorkflowStepSerializer(serializers.ModelSerializer):
    assignee_user_name = serializers.SerializerMethodField()

    class Meta:
        model  = WorkflowStep
        fields = [
            "id", "order", "name", "status_label",
            "assignee_type", "assignee_role", "assignee_user", "assignee_user_name",
            "sla_hours", "allow_resubmit", "instructions",
        ]

    def get_assignee_user_name(self, obj):
        if obj.assignee_user:
            return obj.assignee_user.get_full_name() or obj.assignee_user.email
        return None


class WorkflowStepWriteSerializer(serializers.ModelSerializer):
    id = serializers.UUIDField(required=False)

    class Meta:
        model  = WorkflowStep
        fields = [
            "id", "name", "status_label",
            "assignee_type", "assignee_role", "assignee_user",
            "sla_hours", "allow_resubmit", "instructions",
        ]
        extra_kwargs = {
            "assignee_role": {"required": False, "allow_blank": True},
            "assignee_user": {"required": False, "allow_null": True},
            "instructions":  {"required": False, "allow_blank": True},
        }


class WorkflowTemplateSerializer(serializers.ModelSerializer):
    steps      = WorkflowStepSerializer(many=True, read_only=True)
    # SerializerMethodField works whether queryset annotated or not
    step_count = serializers.SerializerMethodField()
    created_by = UserSummarySerializer(read_only=True)

    class Meta:
        model  = WorkflowTemplate
        fields = [
            "id", "name", "description", "is_active",
            "steps", "step_count", "created_by", "created_at", "updated_at",
        ]
        read_only_fields = ["id", "step_count", "created_by", "created_at", "updated_at"]

    def get_step_count(self, obj):
        # Use annotation if available (avoids extra query), fallback to property
        if hasattr(obj, "step_count") and isinstance(obj.step_count, int):
            return obj.step_count
        return obj.steps.count()


class WorkflowTemplateWriteSerializer(serializers.ModelSerializer):
    steps = WorkflowStepWriteSerializer(many=True)

    class Meta:
        model  = WorkflowTemplate
        fields = ["name", "description", "is_active", "steps"]

    def validate_name(self, value):
        qs = WorkflowTemplate.objects.filter(name=value)
        if self.instance:
            qs = qs.exclude(pk=self.instance.pk)
        if qs.exists():
            raise serializers.ValidationError(
                f"A workflow template named '{value}' already exists."
            )
        return value

    def _upsert_steps(self, template, steps_data):
        template.steps.all().delete()
        for order, raw in enumerate(steps_data, start=1):
            step = dict(raw)
            step.pop("id", None)
            step["order"] = order
            WorkflowStep.objects.create(template=template, **step)

    def create(self, validated_data):
        steps_data = validated_data.pop("steps", [])
        template   = WorkflowTemplate.objects.create(**validated_data)
        self._upsert_steps(template, steps_data)
        return template

    def update(self, instance, validated_data):
        steps_data = validated_data.pop("steps", None)
        for attr, value in validated_data.items():
            setattr(instance, attr, value)
        instance.save()
        if steps_data is not None:
            self._upsert_steps(instance, steps_data)
        return instance


class WorkflowRuleSerializer(serializers.ModelSerializer):
    template_name      = serializers.CharField(source="template.name",      read_only=True)
    document_type_name = serializers.CharField(source="document_type.name", read_only=True)

    class Meta:
        model  = WorkflowRule
        fields = [
            "id", "document_type", "document_type_name",
            "template", "template_name",
            "amount_threshold", "currency", "label", "is_active",
        ]
        read_only_fields = ["id", "template_name", "document_type_name"]


class WorkflowTaskSerializer(serializers.ModelSerializer):
    step           = WorkflowStepSerializer(read_only=True)
    assigned_to    = UserSummarySerializer(read_only=True)
    document_id    = serializers.CharField(source="workflow_instance.document.id",                read_only=True)
    document_ref   = serializers.CharField(source="workflow_instance.document.reference_number",  read_only=True)
    document_title = serializers.CharField(source="workflow_instance.document.title",             read_only=True)

    class Meta:
        model  = WorkflowTask
        fields = [
            "id", "step", "assigned_to", "status", "comment",
            "due_at", "acted_at",
            "document_id", "document_ref", "document_title",
        ]


class WorkflowInstanceSerializer(serializers.ModelSerializer):
    tasks      = WorkflowTaskSerializer(many=True, read_only=True)
    started_by = UserSummarySerializer(read_only=True)
    rule_label = serializers.CharField(source="rule.label", read_only=True, default="")

    class Meta:
        model  = WorkflowInstance
        fields = [
            "id", "document", "template", "rule", "rule_label",
            "status", "current_step_order",
            "started_by", "started_at", "completed_at", "tasks",
        ]
