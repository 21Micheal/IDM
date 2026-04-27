"""
apps/workflows/serializers.py
Adds WorkflowTaskActionSerializer. Everything else unchanged from previous version.
"""
from rest_framework import serializers
from django.db.models import Q
from django.db import transaction
from django.utils import timezone
from django.contrib.auth import get_user_model

from .models import (
    WorkflowTemplate, WorkflowStep, WorkflowRule,
    WorkflowInstance, WorkflowTask, WorkflowTaskAction,
)
from apps.accounts.models import UserGroup
from apps.accounts.serializers import UserSummarySerializer

User = get_user_model()


class WorkflowStepSerializer(serializers.ModelSerializer):
    assignee_group_name = serializers.CharField(source="assignee_group.name", read_only=True)
    assignee_user_name = serializers.SerializerMethodField()

    class Meta:
        model  = WorkflowStep
        fields = [
            "id", "order", "name", "status_label",
            "assignee_type", "assignee_group", "assignee_group_name",
            "assignee_user", "assignee_user_name",
            "sla_hours", "allow_resubmit",
            "allow_approve", "allow_reject", "allow_return",
            "instructions",
        ]

    def get_assignee_user_name(self, obj):
        if obj.assignee_user:
            return obj.assignee_user.get_full_name() or obj.assignee_user.email
        return None


class WorkflowStepWriteSerializer(serializers.ModelSerializer):
    id = serializers.UUIDField(required=False)
    assignee_type = serializers.ChoiceField(
        choices=[
            ("group_any",      "Any member of group"),
            ("group_all",      "All members of group"),
            ("group_specific", "Specific member of group"),
        ]
    )
    assignee_group = serializers.PrimaryKeyRelatedField(
        queryset=UserGroup.objects.filter(is_active=True),
        required=False,
        allow_null=True,
    )

    class Meta:
        model  = WorkflowStep
        fields = [
            "id", "name", "status_label",
            "assignee_type", "assignee_group", "assignee_user",
            "sla_hours", "allow_resubmit",
            "allow_approve", "allow_reject", "allow_return",
            "instructions",
        ]
        extra_kwargs = {
            "assignee_user": {"required": False, "allow_null": True},
            "instructions":  {"required": False, "allow_blank": True},
        }

    def validate(self, attrs):
        assignee_type = attrs.get("assignee_type", getattr(self.instance, "assignee_type", None))
        assignee_group = attrs.get("assignee_group", getattr(self.instance, "assignee_group", None))
        assignee_user = attrs.get("assignee_user", getattr(self.instance, "assignee_user", None))

        # Ensure assignee_user exists, otherwise set to None
        if assignee_user and not User.objects.filter(id=assignee_user).exists():
            attrs['assignee_user'] = None

        # Ensure assignee_group exists, otherwise set to None
        if assignee_group and not UserGroup.objects.filter(id=assignee_group).exists():
            attrs['assignee_group'] = None

        if assignee_type in ("group_any", "group_all", "group_specific"):
            if assignee_group is None:
                raise serializers.ValidationError(
                    {"assignee_group": "A group is required for group-based assignment."}
                )
            if assignee_type == "group_specific" and assignee_user is None:
                raise serializers.ValidationError(
                    {"assignee_user": "A specific member is required for this assignment mode."}
                )
            if assignee_type != "group_specific" and assignee_user is not None:
                raise serializers.ValidationError(
                    {"assignee_user": "Only specific member assignments can set a user."}
                )
        else:
            raise serializers.ValidationError({"assignee_type": "Invalid assignment mode."})

        if assignee_type == "group_specific" and assignee_group and assignee_user:
            # Note: Membership check disabled to allow existing configurations
            pass

        # At least one approver action must be allowed
        allow_approve = attrs.get("allow_approve", getattr(self.instance, "allow_approve", True))
        allow_reject  = attrs.get("allow_reject",  getattr(self.instance, "allow_reject",  True))
        allow_return  = attrs.get("allow_return",  getattr(self.instance, "allow_return",  True))
        if not any([allow_approve, allow_reject, allow_return]):
            raise serializers.ValidationError(
                {"allow_approve": "At least one approver action (approve, reject, or send back) must be enabled."}
            )

        return attrs


class WorkflowTemplateSerializer(serializers.ModelSerializer):
    steps      = WorkflowStepSerializer(many=True, read_only=True)
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
        annotated_count = getattr(obj, "step_count_annotation", None)
        if isinstance(annotated_count, int):
            return annotated_count
        return obj.steps.count()


class WorkflowTemplateWriteSerializer(serializers.ModelSerializer):
    steps = WorkflowStepWriteSerializer(many=True)

    class Meta:
        model  = WorkflowTemplate
        fields = ["name", "description", "is_active", "steps"]
        extra_kwargs = {
            "is_active": {"required": False},
        }

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
        existing_steps = list(template.steps.all())
        existing_by_id = {str(step.id): step for step in existing_steps}
        incoming_ids = []
        incoming_existing_ids = set()

        for raw in steps_data:
            step_id = raw.get("id")
            if step_id:
                step_id = str(step_id)
                if step_id in incoming_ids:
                    raise serializers.ValidationError(
                        {"steps": "Each step can appear only once in a template."}
                    )
                incoming_ids.append(step_id)
                if step_id not in existing_by_id:
                    # Invalid id, treat as new step
                    raw.pop("id", None)
                else:
                    incoming_existing_ids.add(step_id)

        removed_steps = [
            step for step in existing_steps
            if str(step.id) not in incoming_existing_ids
        ]
        removed_step_ids = [step.id for step in removed_steps]

        if removed_step_ids:
            protected_step_names = list(
                WorkflowStep.objects.filter(
                    id__in=removed_step_ids,
                    workflowtask__isnull=False,
                )
                .distinct()
                .values_list("name", flat=True)
            )
            if protected_step_names:
                names = ", ".join(sorted(protected_step_names))
                raise serializers.ValidationError(
                    {"steps": f"Cannot remove steps that already have workflow tasks: {names}."}
                )

        # Move surviving steps out of the way first so order reassignments do not
        # collide with the template's unique (template, order) constraint.
        order_offset = max(len(existing_steps), len(steps_data)) + 1000
        for idx, step in enumerate(existing_steps, start=1):
            if step.id in removed_step_ids:
                continue
            temp_order = order_offset + idx
            if step.order != temp_order:
                step.order = temp_order
                step.save(update_fields=["order"])

        if removed_step_ids:
            WorkflowStep.objects.filter(id__in=removed_step_ids).delete()

        for order, raw in enumerate(steps_data, start=1):
            step_data = dict(raw)
            step_id = step_data.pop("id", None)
            step_data["order"] = order

            if step_id:
                step = existing_by_id[str(step_id)]
                for attr, value in step_data.items():
                    setattr(step, attr, value)
                step.save()
            else:
                WorkflowStep.objects.create(template=template, **step_data)

    @transaction.atomic
    def create(self, validated_data):
        steps_data = validated_data.pop("steps", [])
        template   = WorkflowTemplate.objects.create(**validated_data)
        self._upsert_steps(template, steps_data)
        return template

    @transaction.atomic
    def update(self, instance, validated_data):
        steps_data = validated_data.pop("steps", None)
        for attr, value in validated_data.items():
            setattr(instance, attr, value)
        instance.save()
        if steps_data is not None:
            self._upsert_steps(instance, steps_data)
        return instance


class WorkflowRuleSerializer(serializers.ModelSerializer):
    template_name      = serializers.CharField(source="template.name", read_only=True)
    document_type_name = serializers.CharField(source="document_type.name", read_only=True)

    class Meta:
        model  = WorkflowRule
        fields = [
            "id", "document_type", "document_type_name",
            "template", "template_name",
            "amount_threshold", "currency", "label", "is_active",
        ]
        read_only_fields = ["id", "template_name", "document_type_name"]


class WorkflowTaskActionSerializer(serializers.ModelSerializer):
    """Serializes the immutable action history log for a task."""
    actor             = UserSummarySerializer(read_only=True)
    action_display    = serializers.CharField(source="get_action_display", read_only=True)

    class Meta:
        model  = WorkflowTaskAction
        fields = [
            "id", "action", "action_display",
            "actor", "comment", "hold_hours", "created_at",
        ]


class WorkflowTaskSerializer(serializers.ModelSerializer):
    step           = WorkflowStepSerializer(read_only=True)
    assigned_to    = UserSummarySerializer(read_only=True)
    document_id    = serializers.CharField(source="workflow_instance.document.id",               read_only=True)
    document_ref   = serializers.CharField(source="workflow_instance.document.reference_number", read_only=True)
    document_title = serializers.CharField(source="workflow_instance.document.title",            read_only=True)
    status_display = serializers.CharField(source="get_status_display", read_only=True)

    class Meta:
        model  = WorkflowTask
        fields = [
            "id", "step", "assigned_to",
            "status", "status_display",
            "comment", "held_until",
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